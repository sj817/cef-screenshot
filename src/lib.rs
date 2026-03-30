use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};

// ---------------------------------------------------------------------------
// Internal: single helper process state
// ---------------------------------------------------------------------------
struct HelperInner {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u32, oneshot::Sender<std::result::Result<String, String>>>>>,
    next_id: AtomicU32,
    _reader_handle: tokio::task::JoinHandle<()>,
    /// Tracks active in-flight requests for least-busy routing
    active_count: AtomicU32,
}

// ---------------------------------------------------------------------------
// Internal: pool of helper processes (multi-browser support)
// ---------------------------------------------------------------------------
struct HelperPool {
    helpers: Vec<Arc<HelperInner>>,
}

static POOL: std::sync::LazyLock<Mutex<Option<Arc<HelperPool>>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

// ---------------------------------------------------------------------------
// Background stdout reader — dispatches responses by ID
// ---------------------------------------------------------------------------
async fn response_reader(
    mut stdout: BufReader<ChildStdout>,
    pending: Arc<Mutex<HashMap<u32, oneshot::Sender<std::result::Result<String, String>>>>>,
) {
    let mut line = String::new();
    loop {
        line.clear();
        match stdout.read_line(&mut line).await {
            Ok(0) | Err(_) => break, // EOF or error
            Ok(_) => {}
        }
        let trimmed = line.trim();
        let parts: Vec<&str> = trimmed.splitn(3, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let id: u32 = match parts[0].parse() {
            Ok(id) => id,
            Err(_) => continue,
        };
        let result = if parts[1] == "ok" {
            Ok(parts[2].to_string())
        } else {
            Err(parts[2].to_string())
        };
        if let Some(tx) = pending.lock().await.remove(&id) {
            let _ = tx.send(result);
        }
    }
    // Helper exited — wake up all pending callers with error
    let mut map = pending.lock().await;
    for (_, tx) in map.drain() {
        let _ = tx.send(Err("Helper process exited".to_string()));
    }
}

// ---------------------------------------------------------------------------
// Options structs
// ---------------------------------------------------------------------------
#[napi(object)]
pub struct InitOptions {
    /// Path to directory containing cef_screenshot_helper.exe + CEF runtime.
    pub helper_dir: Option<String>,
    /// Number of concurrent browser slots (default 3, max 10).
    /// Kept for backward compatibility — equivalent to browsers=1, tabs=N.
    pub concurrency: Option<u32>,
    /// Number of browser processes to spawn (default 1, max 5).
    /// Each process is an independent CEF instance with its own tabs.
    pub browsers: Option<u32>,
    /// Number of tabs (slots) per browser process (default 3, max 10).
    /// Total concurrency = browsers × tabs.
    pub tabs: Option<u32>,
}

#[napi(object)]
pub struct ClipRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[napi(object)]
pub struct ScreenshotOptions {
    /// Viewport width in pixels (default 1920).
    pub width: Option<u32>,
    /// Viewport height in pixels (default 1080).
    pub height: Option<u32>,
    /// Extra delay in ms after page load before capture (default 500).
    pub delay: Option<u32>,
    /// CSS selector to screenshot a specific element.
    /// If set, captures the full page and crops to element bounds.
    pub selector: Option<String>,
    /// Capture the full scrollable page (default true).
    /// Set to false for viewport-only capture.
    pub full_page: Option<bool>,
    /// Split the screenshot into slices of this height (in pixels).
    /// Adjacent slices overlap by 100px for visual continuity.
    /// When set, screenshot() returns Vec<Buffer>.
    pub slice_height: Option<u32>,
    /// Hide default white background for transparent screenshots.
    pub omit_background: Option<bool>,
    /// Crop region in pixels {x, y, width, height}.
    pub clip: Option<ClipRegion>,
    /// Page load timeout in milliseconds (default 30000).
    pub timeout: Option<u32>,
}

// ---------------------------------------------------------------------------
// Resolve helper directory: cef-runtime/ (npm) > cef-helper/build/Release/ (dev)
// ---------------------------------------------------------------------------
#[cfg(windows)]
const HELPER_EXE_NAME: &str = "cef_screenshot_helper.exe";
#[cfg(not(windows))]
const HELPER_EXE_NAME: &str = "cef_screenshot_helper";

fn resolve_helper_dir(custom: Option<String>) -> PathBuf {
    if let Some(dir) = custom {
        return PathBuf::from(dir);
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // npm install layout
    let npm_path = root.join("cef-runtime");
    if npm_path.join(HELPER_EXE_NAME).exists() {
        return npm_path;
    }
    // development layout
    root.join("cef-helper").join("build").join("Release")
}

// ---------------------------------------------------------------------------
// Spawn a single helper process
// ---------------------------------------------------------------------------
async fn spawn_helper(
    exe: &std::path::Path,
    helper_dir: &std::path::Path,
    tabs: u32,
) -> Result<HelperInner> {
    let mut cmd = Command::new(exe);
    cmd.arg(format!("--pool={tabs}"))
        .current_dir(helper_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // On Linux, ensure the dynamic linker can find libcef.so in the helper
    // directory. RPATH ($ORIGIN) should handle this, but LD_LIBRARY_PATH
    // acts as a safety net for edge cases (e.g. stripped RPATH).
    #[cfg(target_os = "linux")]
    {
        let mut ld_path = helper_dir.as_os_str().to_os_string();
        if let Ok(existing) = std::env::var("LD_LIBRARY_PATH") {
            if !existing.is_empty() {
                ld_path.push(":");
                ld_path.push(existing);
            }
        }
        cmd.env("LD_LIBRARY_PATH", ld_path);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| Error::from_reason(format!("Failed to spawn helper: {e}")))?;

    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());

    // Capture stderr in background for diagnostics
    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let buf = Arc::clone(&stderr_buf);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while let Ok(n) = reader.read_line(&mut line).await {
                if n == 0 {
                    break;
                }
                let mut b = buf.lock().await;
                b.push_str(&line);
                // Keep only the last 4 KB to avoid unbounded growth
                if b.len() > 4096 {
                    let start = b.len() - 4096;
                    *b = b[start..].to_string();
                }
                line.clear();
            }
        });
    }

    // Read READY signal before spawning the response reader
    let mut ready_stdout = stdout;
    let mut line = String::new();
    let ready_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        ready_stdout.read_line(&mut line),
    )
    .await;

    // Handle timeout
    let ready = match ready_result {
        Err(_) => {
            let _ = child.kill().await;
            let stderr_snapshot = stderr_buf.lock().await;
            let stderr_info = if stderr_snapshot.is_empty() {
                String::new()
            } else {
                format!("\nstderr: {}", stderr_snapshot.trim())
            };
            return Err(Error::from_reason(format!(
                "Timeout waiting for helper READY signal (30s){stderr_info}"
            )));
        }
        Ok(r) => r.map_err(|e| Error::from_reason(format!("IO error reading READY: {e}")))?,
    };

    if ready == 0 || !line.trim().starts_with("READY") {
        // Give stderr reader a moment to capture output from the exiting process
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let stdout_info = if line.is_empty() {
            "stdout=(EOF)".to_string()
        } else {
            format!("stdout='{}'", line.trim())
        };
        let exit_info = match child.try_wait() {
            Ok(Some(status)) => format!(", exit={status}"),
            _ => String::new(),
        };
        let stderr_snapshot = stderr_buf.lock().await;
        let stderr_info = if stderr_snapshot.is_empty() {
            String::new()
        } else {
            format!(", stderr: {}", stderr_snapshot.trim())
        };

        let _ = child.kill().await;
        return Err(Error::from_reason(format!(
            "Helper did not send READY signal. {stdout_info}{exit_info}{stderr_info}"
        )));
    }

    // Start background response reader
    let pending: Arc<Mutex<HashMap<u32, oneshot::Sender<std::result::Result<String, String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_clone = Arc::clone(&pending);
    let reader_handle = tokio::spawn(response_reader(ready_stdout, pending_clone));

    Ok(HelperInner {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending,
        next_id: AtomicU32::new(1),
        _reader_handle: reader_handle,
        active_count: AtomicU32::new(0),
    })
}

// ---------------------------------------------------------------------------
// Internal: send a screenshot request and read file(s) from response
// ---------------------------------------------------------------------------
async fn do_screenshot_internal(
    inner: &HelperInner,
    url: &str,
    options: Option<&ScreenshotOptions>,
) -> Result<Vec<Buffer>> {
    let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let width = options.and_then(|o| o.width).unwrap_or(1920);
    let height = options.and_then(|o| o.height).unwrap_or(1080);
    let delay = options.and_then(|o| o.delay).unwrap_or(500);

    // Full page: default true, but false if explicitly set
    let has_selector = options.and_then(|o| o.selector.as_ref()).map_or(false, |s| !s.is_empty());
    let full_page: u32 = if has_selector {
        1 // selector implies full page
    } else if options.and_then(|o| o.full_page).unwrap_or(true) {
        1
    } else {
        0
    };
    let selector_str = options
        .and_then(|o| o.selector.as_ref())
        .filter(|s| !s.is_empty())
        .map(|s| s.as_str())
        .unwrap_or("-");
    let slice_height = options.and_then(|o| o.slice_height).unwrap_or(0);

    // New IPC fields
    let omit_bg: u32 = if options.and_then(|o| o.omit_background).unwrap_or(false) { 1 } else { 0 };
    let timeout_sec = options
        .and_then(|o| o.timeout)
        .map(|t| t / 1000)
        .unwrap_or(0); // 0 = use C++ default (30s)
    let clip_str = options
        .and_then(|o| o.clip.as_ref())
        .map(|c| format!("{},{},{},{}", c.x as i32, c.y as i32, c.width as i32, c.height as i32))
        .unwrap_or_else(|| "-".to_string());

    // Register response channel
    let (tx, rx) = oneshot::channel();
    inner.pending.lock().await.insert(id, tx);

    // Send request: ID\tW\tH\tDELAY\tFULL_PAGE\tSELECTOR\tSLICE_H\tOMIT_BG\tTIMEOUT\tCLIP\tURL\n
    {
        let mut stdin = inner.stdin.lock().await;
        let req = format!("{id}\t{width}\t{height}\t{delay}\t{full_page}\t{selector_str}\t{slice_height}\t{omit_bg}\t{timeout_sec}\t{clip_str}\t{url}\n");
        if let Err(e) = stdin.write_all(req.as_bytes()).await {
            inner.pending.lock().await.remove(&id);
            return Err(Error::from_reason(format!("Write to helper failed: {e}")));
        }
        if let Err(e) = stdin.flush().await {
            inner.pending.lock().await.remove(&id);
            return Err(Error::from_reason(format!("Flush failed: {e}")));
        }
    }

    // Wait for response — adjust timeout based on user-configured page load timeout
    let overall_timeout_secs = options
        .and_then(|o| o.timeout)
        .map(|t| (t as u64 / 1000).max(30) + 90)
        .unwrap_or(120);
    let result = tokio::time::timeout(std::time::Duration::from_secs(overall_timeout_secs), rx)
        .await
        .map_err(|_| {
            let pending = Arc::clone(&inner.pending);
            tokio::spawn(async move { pending.lock().await.remove(&id); });
            Error::from_reason("Timeout waiting for screenshot response")
        })?
        .map_err(|_| Error::from_reason("Helper process closed unexpectedly"))?;

    match result {
        Ok(paths_str) => {
            // paths_str may contain | separated paths for sliced screenshots
            let paths: Vec<&str> = paths_str.split('|').collect();
            let mut buffers = Vec::with_capacity(paths.len());
            for path in &paths {
                let data = tokio::fs::read(path)
                    .await
                    .map_err(|e| Error::from_reason(format!("Failed to read PNG {path}: {e}")))?;
                let _ = tokio::fs::remove_file(path).await;
                buffers.push(Buffer::from(data));
            }
            Ok(buffers)
        }
        Err(msg) => Err(Error::from_reason(format!("Screenshot failed: {msg}"))),
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

#[napi]
pub async fn init(options: Option<InitOptions>) -> Result<()> {
    let mut guard = POOL.lock().await;
    if guard.is_some() {
        return Err(Error::from_reason(
            "Already initialized. Call shutdown() first.",
        ));
    }

    // Resolve browsers & tabs configuration
    let (browsers, tabs) = match &options {
        // New multi-browser API takes priority
        Some(opts) if opts.browsers.is_some() || opts.tabs.is_some() => {
            let b = opts.browsers.unwrap_or(1).max(1).min(5);
            let t = opts.tabs.unwrap_or(3).max(1).min(10);
            (b, t)
        }
        // Backward compat: concurrency → 1 browser with N tabs
        Some(opts) => {
            let c = opts.concurrency.unwrap_or(3).max(1).min(10);
            (1u32, c)
        }
        None => (1u32, 3u32),
    };

    let helper_dir = resolve_helper_dir(options.and_then(|o| o.helper_dir));
    let exe = helper_dir.join(HELPER_EXE_NAME);
    if !exe.exists() {
        return Err(Error::from_reason(format!(
            "Helper not found: {}  (run `npm run setup` or `node scripts/postinstall.js`)",
            exe.display()
        )));
    }

    let mut helpers = Vec::with_capacity(browsers as usize);
    for _ in 0..browsers {
        let inner = spawn_helper(&exe, &helper_dir, tabs).await?;
        helpers.push(Arc::new(inner));
    }

    *guard = Some(Arc::new(HelperPool { helpers }));

    Ok(())
}

#[napi]
pub async fn screenshot(url: String, options: Option<ScreenshotOptions>) -> Result<Buffer> {
    // Clone Arc and release global lock immediately to allow concurrency
    let pool = {
        let guard = POOL.lock().await;
        Arc::clone(
            guard
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not initialized - call init() first"))?,
        )
    };

    // Least-busy routing: pick the helper with fewest active requests
    let inner = pool
        .helpers
        .iter()
        .min_by_key(|h| h.active_count.load(Ordering::Relaxed))
        .map(Arc::clone)
        .ok_or_else(|| Error::from_reason("No helpers available"))?;

    // Force slice_height to 0 for single-buffer return
    let opts = options.map(|mut o| { o.slice_height = None; o });

    inner.active_count.fetch_add(1, Ordering::Relaxed);
    let result = do_screenshot_internal(&inner, &url, opts.as_ref()).await;
    inner.active_count.fetch_sub(1, Ordering::Relaxed);

    result.and_then(|bufs| {
        bufs.into_iter()
            .next()
            .ok_or_else(|| Error::from_reason("No screenshot data returned"))
    })
}

#[napi]
pub async fn screenshot_sliced(url: String, options: Option<ScreenshotOptions>) -> Result<Vec<Buffer>> {
    let pool = {
        let guard = POOL.lock().await;
        Arc::clone(
            guard
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not initialized - call init() first"))?,
        )
    };

    let inner = pool
        .helpers
        .iter()
        .min_by_key(|h| h.active_count.load(Ordering::Relaxed))
        .map(Arc::clone)
        .ok_or_else(|| Error::from_reason("No helpers available"))?;

    inner.active_count.fetch_add(1, Ordering::Relaxed);
    let result = do_screenshot_internal(&inner, &url, options.as_ref()).await;
    inner.active_count.fetch_sub(1, Ordering::Relaxed);

    result
}

#[napi]
pub async fn shutdown() -> Result<()> {
    let mut guard = POOL.lock().await;
    if let Some(pool) = guard.take() {
        for helper in &pool.helpers {
            // Close stdin → helper detects EOF → exits
            drop(helper.stdin.lock().await);
            let mut child = helper.child.lock().await;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
            let _ = child.kill().await;
        }
    }
    Ok(())
}
