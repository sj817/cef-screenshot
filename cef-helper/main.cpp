// cef_screenshot_helper - main.cpp
//
// Headless CEF off-screen rendering process for capturing web page screenshots.
// Supports a POOL of browsers for concurrent capture.
//
// Usage:  cef_screenshot_helper[.exe] [--pool=N]    (default N=3)
//
// IPC (stdin/stdout, tab-delimited lines):
//   Request:  ID\tWIDTH\tHEIGHT\tDELAY_MS\tURL\n
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

} // namespace

// ========================================================
// Request
// ========================================================
struct ScreenshotRequest {
  int id = 0;
  int width = 1920;
  int height = 1080;
  int delay_ms = 500;
  std::string url;
};

// ========================================================
// Browser Slot
// ========================================================
enum class SlotState { CREATING, IDLE, LOADING, RENDERING };

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
    cmd->AppendSwitch("disable-software-rasterizer");
    cmd->AppendSwitch("disable-webgl");

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
                          public CefLifeSpanHandler {
 public:
  CefRefPtr<CefRenderHandler>   GetRenderHandler()   override { return this; }
  CefRefPtr<CefLoadHandler>     GetLoadHandler()     override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }

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
               const RectList& /*dirtyRects*/,
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

    size_t p1 = line.find('\t');
    size_t p2 = (p1 != std::string::npos) ? line.find('\t', p1 + 1) : std::string::npos;
    size_t p3 = (p2 != std::string::npos) ? line.find('\t', p2 + 1) : std::string::npos;
    size_t p4 = (p3 != std::string::npos) ? line.find('\t', p3 + 1) : std::string::npos;

    if (p4 == std::string::npos) continue;

    ScreenshotRequest req;
    try {
      req.id       = std::stoi(line.substr(0, p1));
      req.width    = std::stoi(line.substr(p1 + 1, p2 - p1 - 1));
      req.height   = std::stoi(line.substr(p2 + 1, p3 - p2 - 1));
      req.delay_ms = std::stoi(line.substr(p3 + 1, p4 - p3 - 1));
      req.url      = line.substr(p4 + 1);
    } catch (...) { continue; }

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
        slot.state    = SlotState::RENDERING;
        slot.state_ts = std::chrono::steady_clock::now();
      } else if (sec >= 30) {
        Respond(slot.request.id, false, "timeout waiting for page load");
        if (slot.browser)
          slot.browser->GetMainFrame()->LoadURL("about:blank");
        slot.state = SlotState::IDLE;
      }
      break;
    }

    case SlotState::RENDERING: {
      auto elapsed = std::chrono::steady_clock::now() - slot.state_ts;
      auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();

      if (ms >= slot.request.delay_ms) {
        if (slot.browser)
          slot.browser->GetHost()->Invalidate(PET_VIEW);
        CefDoMessageLoopWork();

        if (slot.pixels.empty() || slot.pixel_w <= 0 || slot.pixel_h <= 0) {
          Respond(slot.request.id, false, "no pixel data captured");
        } else {
#ifdef _WIN32
          std::string png_path = g_temp_dir + "\\ss_" +
                                  std::to_string(slot.request.id) + ".png";
          std::wstring wpng = Utf8ToWide(png_path);
          bool ok = SaveBGRA_AsPNG(wpng, slot.pixels.data(), slot.pixel_w, slot.pixel_h);
#else
          std::string png_path = g_temp_dir + "/ss_" +
                                  std::to_string(slot.request.id) + ".png";
          bool ok = SaveBGRA_AsPNG(png_path, slot.pixels.data(), slot.pixel_w, slot.pixel_h);
#endif
          if (ok)
            Respond(slot.request.id, true, png_path);
          else
            Respond(slot.request.id, false, "failed to encode PNG");
        }
        // 释放像素缓冲区，避免内存驻留
        slot.pixels.clear();
        slot.pixels.shrink_to_fit();

        if (slot.browser)
          slot.browser->GetMainFrame()->LoadURL("about:blank");
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
  browser_settings.background_color = CefColorSetARGB(255, 255, 255, 255);

  g_slots.resize(g_pool_size);
  for (int i = 0; i < g_pool_size; i++) {
    g_slots[i].index = i;
    g_slots[i].state = SlotState::CREATING;

    CefWindowInfo wi;
    wi.SetAsWindowless(0);
    CefBrowserHost::CreateBrowserSync(
        wi, client.get(), "about:blank", browser_settings, nullptr, nullptr);
  }

  // Wait until all browsers are ready
  for (int wait = 0; wait < 200; wait++) {
    bool all_ready = true;
    for (auto& slot : g_slots) {
      if (slot.state == SlotState::CREATING) { all_ready = false; break; }
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
