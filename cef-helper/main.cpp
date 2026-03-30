// cef_screenshot_helper - main.cpp
//
// Headless CEF off-screen rendering process for capturing web page screenshots.
// Supports a POOL of browsers for concurrent capture.
//
// Usage:  cef_screenshot_helper[.exe] [--pool=N]    (default N=3)
//
// IPC (stdin/stdout, tab-delimited lines):
//   Request:  ID\tW\tH\tDELAY\tFULL_PAGE\tSELECTOR\tSLICE_H\tOMIT_BG\tTIMEOUT\tCLIP\tURL\n
//   Response: ID\tok\tFILE_PATH\n   or   ID\terror\tMESSAGE\n
//
// On startup, prints "READY\n" to stdout when all browsers are initialized.

// ── Platform-specific includes ──────────────────────────────────────────────
#ifdef _WIN32
#  include <windows.h>
#  include <shlwapi.h>
#  include <gdiplus.h>
#  pragma comment(lib, "gdiplus.lib")
#  pragma comment(lib, "shlwapi.lib")
#else
#  include <unistd.h>
#  include <sys/stat.h>
#  include <limits.h>
#  include <cerrno>
#  ifdef __APPLE__
#    include <mach-o/dyld.h>
#  endif
#  include <png.h>   // libpng — link with -lpng
#endif

#include "include/cef_app.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_render_handler.h"
#include "include/cef_life_span_handler.h"
#include "include/cef_load_handler.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/base/cef_callback.h"

#include <iostream>
#include <string>
#include <thread>
#include <mutex>
#include <vector>
#include <queue>
#include <map>
#include <atomic>
#include <chrono>
#include <cstring>
#include <algorithm>
#include <memory>

// ========================================================
// PNG Encoder — GDI+ (Windows) / libpng (Linux, macOS)
// ========================================================
namespace {

#ifdef _WIN32

ULONG_PTR g_gdiplus_token = 0;

void InitPngEncoder() {
  Gdiplus::GdiplusStartupInput input;
  Gdiplus::GdiplusStartup(&g_gdiplus_token, &input, nullptr);
}

void ShutdownPngEncoder() {
  if (g_gdiplus_token) {
    Gdiplus::GdiplusShutdown(g_gdiplus_token);
    g_gdiplus_token = 0;
  }
}

static bool GetPngEncoderClsid(CLSID* clsid) {
  UINT num = 0, size = 0;
  Gdiplus::GetImageEncodersSize(&num, &size);
  if (size == 0) return false;
  auto buf = std::make_unique<BYTE[]>(size);
  auto* encoders = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.get());
  Gdiplus::GetImageEncoders(num, size, encoders);
  for (UINT i = 0; i < num; i++) {
    if (wcscmp(encoders[i].MimeType, L"image/png") == 0) {
      *clsid = encoders[i].Clsid;
      return true;
    }
  }
  return false;
}

static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return {};
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(len, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], len);
  return w;
}

bool SaveBGRA_AsPNG(const std::wstring& wpath, const void* bgra, int w, int h) {
  CLSID clsid;
  if (!GetPngEncoderClsid(&clsid)) return false;
  Gdiplus::Bitmap bmp(w, h, w * 4, PixelFormat32bppARGB,
                       const_cast<BYTE*>(static_cast<const BYTE*>(bgra)));
  return bmp.Save(wpath.c_str(), &clsid, nullptr) == Gdiplus::Ok;
}

#else  // Linux / macOS — use libpng

void InitPngEncoder()     {}
void ShutdownPngEncoder() {}

bool SaveBGRA_AsPNG(const std::string& path, const void* bgra_data, int w, int h) {
  FILE* fp = fopen(path.c_str(), "wb");
  if (!fp) return false;

  png_structp png = png_create_write_struct(
      PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  if (!png) { fclose(fp); return false; }

  png_infop info = png_create_info_struct(png);
  if (!info) { png_destroy_write_struct(&png, nullptr); fclose(fp); return false; }

  if (setjmp(png_jmpbuf(png))) {
    png_destroy_write_struct(&png, &info);
    fclose(fp);
    return false;
  }

  png_init_io(png, fp);
  png_set_IHDR(png, info, w, h, 8, PNG_COLOR_TYPE_RGBA,
               PNG_INTERLACE_NONE,
               PNG_COMPRESSION_TYPE_DEFAULT,
               PNG_FILTER_TYPE_DEFAULT);
  png_write_info(png, info);

  // CEF provides BGRA; PNG/RGBA expects R,G,B,A — swap channels
  const uint8_t* src = static_cast<const uint8_t*>(bgra_data);
  std::vector<uint8_t> row(w * 4);
  for (int y = 0; y < h; ++y) {
    const uint8_t* in = src + y * w * 4;
    for (int x = 0; x < w; ++x) {
      row[x * 4 + 0] = in[x * 4 + 2]; // R (was B)
      row[x * 4 + 1] = in[x * 4 + 1]; // G
      row[x * 4 + 2] = in[x * 4 + 0]; // B (was R)
      row[x * 4 + 3] = in[x * 4 + 3]; // A
    }
    png_write_row(png, row.data());
  }

  png_write_end(png, nullptr);
  png_destroy_write_struct(&png, &info);
  fclose(fp);
  return true;
}

#endif  // _WIN32

// ── String split helper ─────────────────────────────────────────────────
std::vector<std::string> SplitString(const std::string& s, char delim) {
  std::vector<std::string> parts;
  size_t start = 0;
  for (size_t i = 0; i <= s.size(); i++) {
    if (i == s.size() || s[i] == delim) {
      parts.push_back(s.substr(start, i - start));
      start = i + 1;
    }
  }
  return parts;
}

// ── Slice range computation ─────────────────────────────────────────────
struct SliceRange { int y_start; int y_end; };

std::vector<SliceRange> ComputeSlices(int totalH, int sliceH, int overlap = 100) {
  std::vector<SliceRange> result;
  if (totalH <= sliceH) {
    result.push_back({0, totalH});
    return result;
  }
  int y = 0;
  while (y + sliceH < totalH) {
    result.push_back({y, y + sliceH});
    y += sliceH - overlap;
  }
  // Last slice fills full sliceH height
  result.push_back({std::max(0, totalH - sliceH), totalH});
  return result;
}

// ── Pixel buffer crop helper ────────────────────────────────────────────
void CropPixelBuffer(const std::vector<uint8_t>& src, int srcW, int /*srcH*/,
                     int cropX, int cropY, int cropW, int cropH,
                     std::vector<uint8_t>& dst) {
  dst.resize((size_t)cropW * cropH * 4);
  for (int y = 0; y < cropH; y++) {
    size_t srcOff = ((size_t)(cropY + y) * srcW + cropX) * 4;
    size_t dstOff = (size_t)y * cropW * 4;
    std::memcpy(dst.data() + dstOff, src.data() + srcOff, (size_t)cropW * 4);
  }
}

} // namespace

// ========================================================
// Request
// ========================================================
struct ScreenshotRequest {
  int id = 0;
  int width = 1920;
  int height = 1080;
  int delay_ms = 500;
  bool full_page = false;
  std::string selector;
  int slice_height = 0;
  bool omit_background = false;
  int timeout_sec = 30;
  bool has_clip = false;
  int clip_x = 0;
  int clip_y = 0;
  int clip_w = 0;
  int clip_h = 0;
  std::string url;
};

// ========================================================
// Browser Slot
// ========================================================
enum class SlotState { CREATING, IDLE, LOADING, MEASURING, RESIZING, RENDERING };

// Measurement result from JavaScript
struct MeasureResult {
  int scroll_w = 0;
  int scroll_h = 0;
  int elem_x = 0;
  int elem_y = 0;
  int elem_w = 0;
  int elem_h = 0;
  bool has_element = false;
  bool js_executed = false;
  bool done = false;
  std::string error;
};

struct BrowserSlot {
  int                     index = -1;
  CefRefPtr<CefBrowser>   browser;
  SlotState               state = SlotState::CREATING;

  ScreenshotRequest       request;
  std::chrono::steady_clock::time_point state_ts;

  bool                    page_loaded = false;
  bool                    page_error = false;

  std::vector<uint8_t>    pixels;
  int                     pixel_w = 0;
  int                     pixel_h = 0;
  int                     view_w = 1920;
  int                     view_h = 1080;

  MeasureResult           measure;

  // Paint coverage tracking (for long page rendering)
  int                     max_paint_y = 0;
  bool                    bg_injected = false;
};

// ========================================================
// Globals
// ========================================================
constexpr int DEFAULT_POOL_SIZE = 3;
constexpr int MAX_POOL_SIZE     = 10;

int                                g_pool_size = DEFAULT_POOL_SIZE;
std::vector<BrowserSlot>           g_slots;
std::map<int, int>                 g_browser_to_slot;

std::mutex                         g_queue_mutex;
std::queue<ScreenshotRequest>      g_queue;
std::atomic<bool>                  g_running{true};

std::mutex                         g_stdout_mutex;
std::string                        g_temp_dir;

// ========================================================
// Slot lookup (main thread only)
// ========================================================
BrowserSlot* FindSlot(CefRefPtr<CefBrowser> browser) {
  auto it = g_browser_to_slot.find(browser->GetIdentifier());
  if (it != g_browser_to_slot.end() && it->second < (int)g_slots.size())
    return &g_slots[it->second];
  return nullptr;
}

// ========================================================
// Respond (thread-safe)
// ========================================================
void Respond(int id, bool ok, const std::string& data) {
  std::lock_guard<std::mutex> lock(g_stdout_mutex);
  if (ok)
    std::cout << id << "\tok\t" << data << std::endl;
  else
    std::cout << id << "\terror\t" << data << std::endl;
  std::cout.flush();
}

// ========================================================
// CefApp
// ========================================================
class ScreenshotApp : public CefApp, public CefBrowserProcessHandler {
 public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

  void OnBeforeCommandLineProcessing(
      const CefString& /*process_type*/,
      CefRefPtr<CefCommandLine> cmd) override {

    // ---- GPU / rendering ----
    cmd->AppendSwitch("disable-gpu");
    cmd->AppendSwitch("disable-gpu-shader-disk-cache");
    cmd->AppendSwitch("disable-webgl");

#if !defined(_WIN32) && !defined(__APPLE__)
    // Use headless Ozone platform on Linux — removes dependency on X11/Wayland
    // display server for offscreen rendering.
    cmd->AppendSwitchWithValue("ozone-platform", "headless");
#endif

    // ---- Networking / sync ----
    cmd->AppendSwitch("no-proxy-server");
    cmd->AppendSwitch("disable-background-networking");
    cmd->AppendSwitch("disable-sync");
    cmd->AppendSwitch("disable-component-update");
    cmd->AppendSwitch("disable-domain-reliability");
    cmd->AppendSwitch("disable-client-side-phishing-detection");

    // ---- Extensions / plugins ----
    cmd->AppendSwitch("disable-extensions");
    cmd->AppendSwitch("disable-plugins");
    cmd->AppendSwitch("disable-default-apps");
    cmd->AppendSwitch("disable-component-extensions-with-background-pages");

    // ---- UI / features ----
    cmd->AppendSwitch("disable-spell-checking");
    cmd->AppendSwitch("disable-translate");
    cmd->AppendSwitch("disable-hang-monitor");
    cmd->AppendSwitch("disable-popup-blocking");
    cmd->AppendSwitch("disable-prompt-on-repost");
    cmd->AppendSwitch("disable-print-preview");
    cmd->AppendSwitch("no-first-run");

    // ---- Media / audio ----
    cmd->AppendSwitch("mute-audio");
    cmd->AppendSwitch("disable-speech-api");
    cmd->AppendSwitch("disable-webrtc");

    // ---- Timers / backgrounding ----
    cmd->AppendSwitch("disable-background-timer-throttling");
    cmd->AppendSwitch("disable-backgrounding-occluded-windows");
    cmd->AppendSwitch("disable-renderer-backgrounding");
    cmd->AppendSwitch("disable-ipc-flooding-protection");

    // ---- Process isolation (reduce process count) ----
    cmd->AppendSwitch("disable-site-isolation-trials");

    // ---- Misc ----
    cmd->AppendSwitch("disable-breakpad");
    cmd->AppendSwitch("disable-dev-shm-usage");
    cmd->AppendSwitch("disable-notifications");
    cmd->AppendSwitch("disable-geolocation");
    cmd->AppendSwitchWithValue("autoplay-policy",
                                "no-user-gesture-required");

    // Batch disable Chromium features
    cmd->AppendSwitchWithValue("disable-features",
      "TranslateUI,AudioServiceOutOfProcess,IsolateOrigins,"
      "site-per-process,MediaRouter,CalculateNativeWinOcclusion,"
      "AutofillServerCommunication,WebRtcHideLocalIpsWithMdns,"
      "GlobalMediaControls,ImprovedCookieControls,"
      "LazyFrameLoading,ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes,"
      "SpareRendererForSitePerProcess,EnableHangout");

    cmd->AppendSwitchWithValue("enable-features",
      "NetworkServiceInProcess");
  }

  IMPLEMENT_REFCOUNTING(ScreenshotApp);
};

// ========================================================
// CefClient — routes to correct BrowserSlot
// ========================================================
class ScreenshotClient : public CefClient,
                          public CefRenderHandler,
                          public CefLoadHandler,
                          public CefLifeSpanHandler,
                          public CefDisplayHandler {
 public:
  CefRefPtr<CefRenderHandler>   GetRenderHandler()   override { return this; }
  CefRefPtr<CefLoadHandler>     GetLoadHandler()     override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler>  GetDisplayHandler()  override { return this; }

  // --- CefRenderHandler ---
  void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override {
    auto* slot = FindSlot(browser);
    if (slot)
      rect.Set(0, 0, slot->view_w, slot->view_h);
    else
      rect.Set(0, 0, 1920, 1080);
  }

  bool GetScreenInfo(CefRefPtr<CefBrowser> browser,
                     CefScreenInfo& info) override {
    auto* slot = FindSlot(browser);
    int w = slot ? slot->view_w : 1920;
    int h = slot ? slot->view_h : 1080;
    info.device_scale_factor = 1.0f;
    info.rect = {0, 0, w, h};
    info.available_rect = info.rect;
    info.depth = 32;
    info.depth_per_component = 8;
    info.is_monochrome = 0;
    return true;
  }

  bool GetScreenPoint(CefRefPtr<CefBrowser> /*browser*/,
                      int viewX, int viewY,
                      int& screenX, int& screenY) override {
    screenX = viewX;
    screenY = viewY;
    return true;
  }

  void OnPaint(CefRefPtr<CefBrowser> browser,
               PaintElementType type,
               const RectList& dirtyRects,
               const void* buffer,
               int width, int height) override {
    if (type != PET_VIEW) return;
    auto* slot = FindSlot(browser);
    if (!slot) return;
    size_t sz = (size_t)width * height * 4;
    slot->pixels.resize(sz);
    std::memcpy(slot->pixels.data(), buffer, sz);
    slot->pixel_w = width;
    slot->pixel_h = height;
    // Track paint coverage for long page rendering
    for (const auto& rect : dirtyRects) {
      int bottom = rect.y + rect.height;
      if (bottom > slot->max_paint_y)
        slot->max_paint_y = bottom;
    }
  }

  // --- CefLoadHandler ---
  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int /*httpStatusCode*/) override {
    if (!frame->IsMain()) return;
    auto* slot = FindSlot(browser);
    if (slot) slot->page_loaded = true;
  }

  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode /*errorCode*/,
                   const CefString& /*errorText*/,
                   const CefString& /*failedUrl*/) override {
    if (!frame->IsMain()) return;
    auto* slot = FindSlot(browser);
    if (slot) {
      slot->page_loaded = true;
      slot->page_error  = true;
    }
  }

  // --- CefDisplayHandler ---
  void OnTitleChange(CefRefPtr<CefBrowser> browser,
                     const CefString& title) override {
    auto* slot = FindSlot(browser);
    if (!slot || slot->state != SlotState::MEASURING) return;

    std::string t = title.ToString();
    if (t.size() >= 8 && t.substr(0, 8) == "MEASURE|") {
      auto parts = SplitString(t, '|');
      if (parts.size() >= 3) {
        try {
          slot->measure.scroll_w = std::stoi(parts[1]);
          slot->measure.scroll_h = std::stoi(parts[2]);
          if (parts.size() >= 7) {
            slot->measure.elem_x = std::stoi(parts[3]);
            slot->measure.elem_y = std::stoi(parts[4]);
            slot->measure.elem_w = std::stoi(parts[5]);
            slot->measure.elem_h = std::stoi(parts[6]);
            slot->measure.has_element = true;
          }
          slot->measure.done = true;
        } catch (...) {
          slot->measure.error = "Failed to parse measurement data";
          slot->measure.done = true;
        }
      }
    } else if (t.size() >= 14 && t.substr(0, 14) == "MEASURE_ERROR|") {
      slot->measure.error = t.substr(14);
      slot->measure.done = true;
    }
  }

  // --- CefLifeSpanHandler ---
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    for (auto& slot : g_slots) {
      if (slot.state == SlotState::CREATING && !slot.browser) {
        slot.browser = browser;
        slot.state   = SlotState::IDLE;
        g_browser_to_slot[browser->GetIdentifier()] = slot.index;
        return;
      }
    }
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    auto it = g_browser_to_slot.find(browser->GetIdentifier());
    if (it != g_browser_to_slot.end()) {
      g_slots[it->second].browser = nullptr;
      g_browser_to_slot.erase(it);
    }
  }

  IMPLEMENT_REFCOUNTING(ScreenshotClient);
};

// ========================================================
// stdin reader thread
// ========================================================
void StdinReaderThread() {
  std::string line;
  while (g_running.load() && std::getline(std::cin, line)) {
    if (line.empty()) continue;
    if (!line.empty() && line.back() == '\r') line.pop_back();

    // Parse: ID\tW\tH\tDELAY\tFULL_PAGE\tSELECTOR\tSLICE_H\tOMIT_BG\tTIMEOUT\tCLIP\tURL
    size_t p1 = line.find('\t');
    size_t p2 = (p1 != std::string::npos) ? line.find('\t', p1 + 1) : std::string::npos;
    size_t p3 = (p2 != std::string::npos) ? line.find('\t', p2 + 1) : std::string::npos;
    size_t p4 = (p3 != std::string::npos) ? line.find('\t', p3 + 1) : std::string::npos;
    size_t p5 = (p4 != std::string::npos) ? line.find('\t', p4 + 1) : std::string::npos;
    size_t p6 = (p5 != std::string::npos) ? line.find('\t', p5 + 1) : std::string::npos;
    size_t p7 = (p6 != std::string::npos) ? line.find('\t', p6 + 1) : std::string::npos;
    size_t p8 = (p7 != std::string::npos) ? line.find('\t', p7 + 1) : std::string::npos;
    size_t p9 = (p8 != std::string::npos) ? line.find('\t', p8 + 1) : std::string::npos;
    size_t p10 = (p9 != std::string::npos) ? line.find('\t', p9 + 1) : std::string::npos;

    if (p10 == std::string::npos) continue;

    ScreenshotRequest req;
    try {
      req.id           = std::stoi(line.substr(0, p1));
      req.width        = std::stoi(line.substr(p1 + 1, p2 - p1 - 1));
      req.height       = std::stoi(line.substr(p2 + 1, p3 - p2 - 1));
      req.delay_ms     = std::stoi(line.substr(p3 + 1, p4 - p3 - 1));
      req.full_page    = line.substr(p4 + 1, p5 - p4 - 1) == "1";
      req.selector     = line.substr(p5 + 1, p6 - p5 - 1);
      req.slice_height = std::stoi(line.substr(p6 + 1, p7 - p6 - 1));
      req.omit_background = line.substr(p7 + 1, p8 - p7 - 1) == "1";
      int timeout_val  = std::stoi(line.substr(p8 + 1, p9 - p8 - 1));
      req.timeout_sec  = (timeout_val > 0) ? timeout_val : 30;

      // Parse clip: "-" or "X,Y,W,H"
      std::string clip_str = line.substr(p9 + 1, p10 - p9 - 1);
      if (clip_str != "-" && !clip_str.empty()) {
        auto clip_parts = SplitString(clip_str, ',');
        if (clip_parts.size() >= 4) {
          req.clip_x = std::stoi(clip_parts[0]);
          req.clip_y = std::stoi(clip_parts[1]);
          req.clip_w = std::stoi(clip_parts[2]);
          req.clip_h = std::stoi(clip_parts[3]);
          req.has_clip = true;
        }
      }

      req.url = line.substr(p10 + 1);
    } catch (...) { continue; }

    if (req.selector == "-") req.selector.clear();
    if (req.width  < 1) req.width  = 1920;
    if (req.height < 1) req.height = 1080;
    if (req.delay_ms < 0) req.delay_ms = 0;

    {
      std::lock_guard<std::mutex> lock(g_queue_mutex);
      g_queue.push(std::move(req));
    }
  }
  g_running.store(false);
}

// ========================================================
// Slot state machine tick
// ========================================================
void TickSlot(BrowserSlot& slot) {
  switch (slot.state) {
    case SlotState::CREATING:
    case SlotState::IDLE:
      break;

    case SlotState::LOADING: {
      auto elapsed = std::chrono::steady_clock::now() - slot.state_ts;
      auto sec = std::chrono::duration_cast<std::chrono::seconds>(elapsed).count();

      if (slot.page_loaded) {
        // Decide next state based on full_page / selector
        bool need_measure = slot.request.full_page || !slot.request.selector.empty();
        if (need_measure) {
          slot.measure = MeasureResult{};  // reset
          slot.state    = SlotState::MEASURING;
          slot.state_ts = std::chrono::steady_clock::now();
        } else {
          slot.state    = SlotState::RENDERING;
          slot.state_ts = std::chrono::steady_clock::now();
        }
      } else if (sec >= slot.request.timeout_sec) {
        Respond(slot.request.id, false, "timeout waiting for page load");
        if (slot.browser)
          slot.browser->GetMainFrame()->LoadURL("about:blank");
        slot.state = SlotState::IDLE;
      }
      break;
    }

    case SlotState::MEASURING: {
      if (!slot.measure.js_executed) {
        // Build and execute measurement JavaScript
        std::string js;
        if (slot.request.selector.empty()) {
          // Full page: just measure scroll dimensions
          js = "(function(){"
               "var sh=Math.max(document.documentElement.scrollHeight,"
                 "document.body?document.body.scrollHeight:0,"
                 "document.documentElement.offsetHeight,"
                 "document.body?document.body.offsetHeight:0);"
               "var sw=Math.max(document.documentElement.scrollWidth,"
                 "document.body?document.body.scrollWidth:0);"
               "document.title='MEASURE|'+sw+'|'+sh;"
               "})();";
        } else {
          // Selector: measure scroll dims + element bounds
          // Escape single quotes in selector for safety
          std::string safe_sel = slot.request.selector;
          for (size_t i = 0; i < safe_sel.size(); i++) {
            if (safe_sel[i] == '\'') {
              safe_sel.insert(i, "\\");
              i++;
            }
          }
          js = "(function(){"
               "var sh=Math.max(document.documentElement.scrollHeight,"
                 "document.body?document.body.scrollHeight:0,"
                 "document.documentElement.offsetHeight,"
                 "document.body?document.body.offsetHeight:0);"
               "var sw=Math.max(document.documentElement.scrollWidth,"
                 "document.body?document.body.scrollWidth:0);"
               "var sel='" + safe_sel + "';"
               "var el=null;"
               "try{el=document.querySelector(sel);}catch(e){}"
               "if(!el&&/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(sel)){"
                 "el=document.getElementById(sel);"
                 "if(!el)try{el=document.querySelector('.'+sel);}catch(e){}"
               "}"
               "if(!el){document.title='MEASURE_ERROR|Element not found: " + safe_sel + "';return;}"
               "var r=el.getBoundingClientRect();"
               "var sx=window.scrollX||window.pageXOffset||0;"
               "var sy=window.scrollY||window.pageYOffset||0;"
               "document.title='MEASURE|'+sw+'|'+sh+'|'"
                 "+Math.round(r.left+sx)+'|'+Math.round(r.top+sy)+'|'"
                 "+Math.round(r.width)+'|'+Math.round(r.height);"
               "})();";
        }
        slot.browser->GetMainFrame()->ExecuteJavaScript(js, "about:blank", 0);
        slot.measure.js_executed = true;
      }

      if (slot.measure.done) {
        if (!slot.measure.error.empty()) {
          Respond(slot.request.id, false, slot.measure.error);
          slot.browser->GetMainFrame()->LoadURL("about:blank");
          slot.state = SlotState::IDLE;
          break;
        }

        // Determine target viewport height
        int targetH = slot.measure.scroll_h;
        if (slot.measure.has_element) {
          // For element screenshots, we need at least elem_y + elem_h
          targetH = std::max(targetH, slot.measure.elem_y + slot.measure.elem_h);
        }
        // Cap maximum height to prevent excessive memory usage
        constexpr int MAX_CAPTURE_HEIGHT = 32768;
        targetH = std::min(targetH, MAX_CAPTURE_HEIGHT);
        targetH = std::max(targetH, 1);

        if (targetH != slot.view_h) {
          slot.view_h = targetH;
          slot.browser->GetHost()->WasResized();
          // Scroll to top so full page renders from origin
          slot.browser->GetMainFrame()->ExecuteJavaScript(
              "window.scrollTo(0,0);", "about:blank", 0);
        }

        slot.state    = SlotState::RESIZING;
        slot.state_ts = std::chrono::steady_clock::now();
      } else {
        // Timeout after 10s
        auto elapsed = std::chrono::steady_clock::now() - slot.state_ts;
        if (std::chrono::duration_cast<std::chrono::seconds>(elapsed).count() >= 10) {
          Respond(slot.request.id, false, "timeout measuring page dimensions");
          slot.browser->GetMainFrame()->LoadURL("about:blank");
          slot.state = SlotState::IDLE;
        }
      }
      break;
    }

    case SlotState::RESIZING: {
      auto elapsed = std::chrono::steady_clock::now() - slot.state_ts;
      auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();

      // Aggressively pump rendering to fill viewport after resize
      for (int i = 0; i < 5; i++) {
        if (slot.browser)
          slot.browser->GetHost()->Invalidate(PET_VIEW);
        CefDoMessageLoopWork();
      }

      // Wait until pixel buffer matches target size, or timeout
      bool size_ok = (slot.pixel_w == slot.view_w && slot.pixel_h == slot.view_h);
      if ((size_ok && ms >= 300) || ms >= 2000) {
        slot.state    = SlotState::RENDERING;
        slot.state_ts = std::chrono::steady_clock::now();
      }
      break;
    }

    case SlotState::RENDERING: {
      auto elapsed = std::chrono::steady_clock::now() - slot.state_ts;
      auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();

      // Inject transparent background CSS if requested (once)
      if (!slot.bg_injected && slot.request.omit_background && slot.browser) {
        slot.browser->GetMainFrame()->ExecuteJavaScript(
            "document.documentElement.style.setProperty('background','transparent','important');"
            "if(document.body)document.body.style.setProperty('background','transparent','important');",
            "about:blank", 0);
        slot.bg_injected = true;
      }

      // Pump rendering while waiting for delay
      if (slot.browser)
        slot.browser->GetHost()->Invalidate(PET_VIEW);

      if (ms >= slot.request.delay_ms) {
        // Aggressively pump rendering to ensure all tiles are painted
        // (critical for long pages on Linux)
        for (int i = 0; i < 30; i++) {
          if (slot.browser)
            slot.browser->GetHost()->Invalidate(PET_VIEW);
          CefDoMessageLoopWork();
        }

        if (slot.pixels.empty() || slot.pixel_w <= 0 || slot.pixel_h <= 0) {
          Respond(slot.request.id, false, "no pixel data captured");
        } else {
          // Determine what pixels to save
          std::vector<uint8_t>* save_pixels = &slot.pixels;
          int save_w = slot.pixel_w;
          int save_h = slot.pixel_h;
          std::vector<uint8_t> cropped;

          // Crop to clip region or element bounds
          if (slot.request.has_clip) {
            // Explicit clip region takes priority
            int cx = std::max(0, std::min(slot.request.clip_x, slot.pixel_w));
            int cy = std::max(0, std::min(slot.request.clip_y, slot.pixel_h));
            int cw = std::min(slot.request.clip_w, slot.pixel_w - cx);
            int ch = std::min(slot.request.clip_h, slot.pixel_h - cy);
            if (cw > 0 && ch > 0) {
              CropPixelBuffer(slot.pixels, slot.pixel_w, slot.pixel_h,
                              cx, cy, cw, ch, cropped);
              save_pixels = &cropped;
              save_w = cw;
              save_h = ch;
            }
          } else if (slot.measure.has_element) {
            int cx = std::max(0, std::min(slot.measure.elem_x, slot.pixel_w));
            int cy = std::max(0, std::min(slot.measure.elem_y, slot.pixel_h));
            int cw = std::min(slot.measure.elem_w, slot.pixel_w - cx);
            int ch = std::min(slot.measure.elem_h, slot.pixel_h - cy);
            if (cw > 0 && ch > 0) {
              CropPixelBuffer(slot.pixels, slot.pixel_w, slot.pixel_h,
                              cx, cy, cw, ch, cropped);
              save_pixels = &cropped;
              save_w = cw;
              save_h = ch;
            }
          }

          // Check if slicing is requested
          if (slot.request.slice_height > 0 && save_h > slot.request.slice_height) {
            auto slices = ComputeSlices(save_h, slot.request.slice_height);
            std::string all_paths;
            bool all_ok = true;

            for (size_t i = 0; i < slices.size(); i++) {
              int sy = slices[i].y_start;
              int sh = slices[i].y_end - slices[i].y_start;
              std::vector<uint8_t> slice_buf;
              CropPixelBuffer(*save_pixels, save_w, save_h,
                              0, sy, save_w, sh, slice_buf);

#ifdef _WIN32
              std::string slice_path = g_temp_dir + "\\ss_" +
                  std::to_string(slot.request.id) + "_" + std::to_string(i) + ".png";
              std::wstring wslice = Utf8ToWide(slice_path);
              bool ok = SaveBGRA_AsPNG(wslice, slice_buf.data(), save_w, sh);
#else
              std::string slice_path = g_temp_dir + "/ss_" +
                  std::to_string(slot.request.id) + "_" + std::to_string(i) + ".png";
              bool ok = SaveBGRA_AsPNG(slice_path, slice_buf.data(), save_w, sh);
#endif
              if (!ok) { all_ok = false; break; }
              if (!all_paths.empty()) all_paths += "|";
              all_paths += slice_path;
            }

            if (all_ok)
              Respond(slot.request.id, true, all_paths);
            else
              Respond(slot.request.id, false, "failed to encode sliced PNGs");
          } else {
            // Single image output
#ifdef _WIN32
            std::string png_path = g_temp_dir + "\\ss_" +
                                    std::to_string(slot.request.id) + ".png";
            std::wstring wpng = Utf8ToWide(png_path);
            bool ok = SaveBGRA_AsPNG(wpng, save_pixels->data(), save_w, save_h);
#else
            std::string png_path = g_temp_dir + "/ss_" +
                                    std::to_string(slot.request.id) + ".png";
            bool ok = SaveBGRA_AsPNG(png_path, save_pixels->data(), save_w, save_h);
#endif
            if (ok)
              Respond(slot.request.id, true, png_path);
            else
              Respond(slot.request.id, false, "failed to encode PNG");
          }
        }
        // Release pixel buffer
        slot.pixels.clear();
        slot.pixels.shrink_to_fit();

        // Restore viewport and navigate away
        slot.view_w = slot.request.width;
        slot.view_h = slot.request.height;
        if (slot.browser) {
          slot.browser->GetHost()->WasResized();
          slot.browser->GetMainFrame()->LoadURL("about:blank");
        }
        slot.state = SlotState::IDLE;
      }
      break;
    }
  }
}

// ========================================================
// Parse --pool=N from command line
// ========================================================
#ifdef _WIN32
int ParsePoolSize(const wchar_t* cmdLine) {
  std::wstring cmd(cmdLine ? cmdLine : L"");
  auto pos = cmd.find(L"--pool=");
  if (pos != std::wstring::npos) {
    try {
      int n = std::stoi(cmd.substr(pos + 7));
      if (n >= 1 && n <= MAX_POOL_SIZE) return n;
    } catch (...) {}
  }
  return DEFAULT_POOL_SIZE;
}
#else
int ParsePoolSize(int argc, char** argv) {
  for (int i = 1; i < argc; i++) {
    std::string arg(argv[i]);
    if (arg.size() > 7 && arg.substr(0, 7) == "--pool=") {
      try {
        int n = std::stoi(arg.substr(7));
        if (n >= 1 && n <= MAX_POOL_SIZE) return n;
      } catch (...) {}
    }
  }
  return DEFAULT_POOL_SIZE;
}
#endif

// ========================================================
// Platform-specific helpers: temp dir, exe dir
// ========================================================
static std::string GetTempDir() {
#ifdef _WIN32
  char tmp[MAX_PATH];
  GetTempPathA(MAX_PATH, tmp);
  std::string dir = std::string(tmp) + "cef_screenshot";
  CreateDirectoryA(dir.c_str(), nullptr);
  return dir;
#else
  std::string dir = "/tmp/cef_screenshot";
  mkdir(dir.c_str(), 0755);
  return dir;
#endif
}

static std::string GetExeDir() {
#ifdef _WIN32
  wchar_t buf[MAX_PATH];
  GetModuleFileNameW(nullptr, buf, MAX_PATH);
  PathRemoveFileSpecW(buf);
  // Convert wide to narrow UTF-8
  int len = WideCharToMultiByte(CP_UTF8, 0, buf, -1, nullptr, 0, nullptr, nullptr);
  std::string out(len - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, buf, -1, &out[0], len, nullptr, nullptr);
  return out;
#elif defined(__APPLE__)
  char buf[PATH_MAX];
  uint32_t size = sizeof(buf);
  if (_NSGetExecutablePath(buf, &size) == 0) {
    std::string path(buf);
    auto pos = path.rfind('/');
    return (pos != std::string::npos) ? path.substr(0, pos) : path;
  }
  return ".";
#else  // Linux
  char buf[PATH_MAX];
  ssize_t len = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (len > 0) {
    buf[len] = '\0';
    std::string path(buf);
    auto pos = path.rfind('/');
    return (pos != std::string::npos) ? path.substr(0, pos) : path;
  }
  return ".";
#endif
}

static std::string GetExePath() {
#ifdef _WIN32
  wchar_t buf[MAX_PATH];
  GetModuleFileNameW(nullptr, buf, MAX_PATH);
  int len = WideCharToMultiByte(CP_UTF8, 0, buf, -1, nullptr, 0, nullptr, nullptr);
  std::string out(len - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, buf, -1, &out[0], len, nullptr, nullptr);
  return out;
#elif defined(__APPLE__)
  char buf[PATH_MAX];
  uint32_t size = sizeof(buf);
  if (_NSGetExecutablePath(buf, &size) == 0) return std::string(buf);
  return "";
#else
  char buf[PATH_MAX];
  ssize_t len = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (len > 0) { buf[len] = '\0'; return std::string(buf); }
  return "";
#endif
}

static void MakeDir(const std::string& path) {
#ifdef _WIN32
  CreateDirectoryA(path.c_str(), nullptr);
#else
  mkdir(path.c_str(), 0755);
#endif
}

// ========================================================
// Main
// ========================================================
#ifdef _WIN32
int APIENTRY wWinMain(HINSTANCE hInstance, HINSTANCE, LPWSTR lpCmdLine, int) {
  CefMainArgs main_args(hInstance);
  int exit_code = CefExecuteProcess(main_args, nullptr, nullptr);
  if (exit_code >= 0) return exit_code;

  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  InitPngEncoder();

  g_pool_size = ParsePoolSize(lpCmdLine);

#else  // Linux / macOS
int main(int argc, char** argv) {
  CefMainArgs main_args(argc, argv);
  int exit_code = CefExecuteProcess(main_args, nullptr, nullptr);
  if (exit_code >= 0) return exit_code;

  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  InitPngEncoder();

  g_pool_size = ParsePoolSize(argc, argv);

#endif  // _WIN32

  g_temp_dir = GetTempDir();
  std::string exe_dir  = GetExeDir();
  std::string exe_path = GetExePath();

  // ---- CEF settings ----
  CefSettings settings;
  settings.no_sandbox                    = true;
  settings.windowless_rendering_enabled  = true;
  settings.multi_threaded_message_loop   = false;
  settings.log_severity                  = LOGSEVERITY_DISABLE;
  settings.persist_session_cookies       = false;

  std::string cache_path = g_temp_dir +
#ifdef _WIN32
      "\\cache";
#else
      "/cache";
#endif
  MakeDir(cache_path);
  CefString(&settings.cache_path).FromString(cache_path);
  CefString(&settings.browser_subprocess_path).FromString(exe_path);
  CefString(&settings.resources_dir_path).FromString(exe_dir);

  std::string locales = exe_dir +
#ifdef _WIN32
      "\\locales";
#else
      "/locales";
#endif
  CefString(&settings.locales_dir_path).FromString(locales);

  CefRefPtr<ScreenshotApp> app(new ScreenshotApp());
  if (!CefInitialize(main_args, settings, app.get(), nullptr)) {
    fprintf(stderr, "CefInitialize failed\n");
    return 1;
  }

  // ---- Create browser pool ----
  CefRefPtr<ScreenshotClient> client(new ScreenshotClient());

  CefBrowserSettings browser_settings;
  browser_settings.windowless_frame_rate = 30;
  // Use transparent background so omitBackground option works correctly.
  // Pages with default CSS (background: canvas) still render white.
  browser_settings.background_color = CefColorSetARGB(0, 0, 0, 0);

  g_slots.resize(g_pool_size);
  for (int i = 0; i < g_pool_size; i++) {
    g_slots[i].index = i;
    g_slots[i].state = SlotState::CREATING;

    CefWindowInfo wi;
    wi.SetAsWindowless(0);
    CefBrowserHost::CreateBrowserSync(
        wi, client.get(), "about:blank", browser_settings, nullptr, nullptr);
  }

  // Wait until all browsers are ready and initial about:blank is loaded.
  // We must drain about:blank's OnLoadEnd here to prevent it from firing
  // during the first real request, which would prematurely set page_loaded.
  for (int wait = 0; wait < 200; wait++) {
    bool all_ready = true;
    for (auto& slot : g_slots) {
      if (slot.state == SlotState::CREATING || !slot.page_loaded) {
        all_ready = false;
        break;
      }
    }
    if (all_ready) break;
    CefDoMessageLoopWork();
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }

  // Start stdin reader
  std::thread reader(StdinReaderThread);
  reader.detach();

  {
    std::lock_guard<std::mutex> lock(g_stdout_mutex);
    std::cout << "READY" << std::endl;
    std::cout.flush();
  }

  // ---- Main loop ----
  while (g_running.load()) {
    CefDoMessageLoopWork();

    // Assign queued requests to idle slots
    {
      std::lock_guard<std::mutex> lock(g_queue_mutex);
      while (!g_queue.empty()) {
        BrowserSlot* idle = nullptr;
        for (auto& slot : g_slots) {
          if (slot.state == SlotState::IDLE && slot.browser) {
            idle = &slot;
            break;
          }
        }
        if (!idle) break;

        auto req = std::move(g_queue.front());
        g_queue.pop();

        idle->request      = std::move(req);
        idle->page_loaded  = false;
        idle->page_error   = false;
        idle->measure      = MeasureResult{};
        idle->max_paint_y  = 0;
        idle->bg_injected  = false;
        idle->view_w       = idle->request.width;
        idle->view_h       = idle->request.height;

        idle->browser->GetHost()->WasResized();
        idle->browser->GetMainFrame()->LoadURL(idle->request.url);
        idle->state    = SlotState::LOADING;
        idle->state_ts = std::chrono::steady_clock::now();
      }
    }

    // Tick all slots
    for (auto& slot : g_slots)
      TickSlot(slot);

    // Adaptive sleep
    bool any_active = false;
    for (auto& slot : g_slots) {
      if (slot.state != SlotState::IDLE && slot.state != SlotState::CREATING) {
        any_active = true;
        break;
      }
    }
    std::this_thread::sleep_for(any_active
        ? std::chrono::milliseconds(5)
        : std::chrono::milliseconds(50));
  }

  // ---- Cleanup ----
  for (auto& slot : g_slots) {
    if (slot.browser)
      slot.browser->GetHost()->CloseBrowser(true);
  }
  for (int i = 0; i < 100; i++) {
    bool any = false;
    for (auto& slot : g_slots)
      if (slot.browser) { any = true; break; }
    if (!any) break;
    CefDoMessageLoopWork();
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }

  CefShutdown();
  ShutdownPngEncoder();
  return 0;
}

#ifdef _WIN32
int main(int argc, char** argv) {
  (void)argc; (void)argv;
  return wWinMain(GetModuleHandle(nullptr), nullptr, GetCommandLineW(), SW_HIDE);
}
#endif
