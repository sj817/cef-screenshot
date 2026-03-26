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
// Internal: shared helper process state
// ---------------------------------------------------------------------------
struct HelperInner {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u32, oneshot::Sender<std::result::Result<String, String>>>>>,
    next_id: AtomicU32,
    _reader_handle: tokio::task::JoinHandle<()>,
}

static HELPER: std::sync::LazyLock<Mutex<Option<Arc<HelperInner>>>> =
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
    pub concurrency: Option<u32>,
}

#[napi(object)]
pub struct ScreenshotOptions {
    /// Viewport width in pixels (default 1920).
    pub width: Option<u32>,
    /// Viewport height in pixels (default 1080).
    pub height: Option<u32>,
    /// Extra delay in ms after page load before capture (default 500).
    pub delay: Option<u32>,
}

// ---------------------------------------------------------------------------
// Resolve helper directory: cef-runtime/ (npm) > cef-helper/build/Release/ (dev)
// ---------------------------------------------------------------------------
fn resolve_helper_dir(custom: Option<String>) -> PathBuf {
    if let Some(dir) = custom {
        return PathBuf::from(dir);
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // npm install layout
    let npm_path = root.join("cef-runtime");
    if npm_path.join("cef_screenshot_helper.exe").exists() {
        return npm_path;
    }
    // development layout
    root.join("cef-helper").join("build").join("Release")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

#[napi]
pub async fn init(options: Option<InitOptions>) -> Result<()> {
    let mut guard = HELPER.lock().await;
    if guard.is_some() {
        return Err(Error::from_reason(
            "Already initialized. Call shutdown() first.",
        ));
    }

    let concurrency = options
        .as_ref()
        .and_then(|o| o.concurrency)
        .unwrap_or(3)
        .max(1)
        .min(10);

    let helper_dir = resolve_helper_dir(options.and_then(|o| o.helper_dir));
    let exe = helper_dir.join("cef_screenshot_helper.exe");
    if !exe.exists() {
        return Err(Error::from_reason(format!(
            "Helper not found: {}  (run `npm run setup` or `node scripts/postinstall.js`)",
            exe.display()
        )));
    }

    let mut child = Command::new(&exe)
        .arg(format!("--pool={concurrency}"))
        .current_dir(&helper_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| Error::from_reason(format!("Failed to spawn helper: {e}")))?;

    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());

    // Read READY signal before spawning the reader
    let mut ready_stdout = stdout;
    let mut line = String::new();
    let ready = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        ready_stdout.read_line(&mut line),
    )
    .await
    .map_err(|_| Error::from_reason("Timeout waiting for helper READY signal"))?
    .map_err(|e| Error::from_reason(format!("IO error reading READY: {e}")))?;

    if ready == 0 || !line.trim().starts_with("READY") {
        let _ = child.kill().await;
        return Err(Error::from_reason("Helper did not send READY signal"));
    }

    // Start background response reader
    let pending: Arc<Mutex<HashMap<u32, oneshot::Sender<std::result::Result<String, String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_clone = Arc::clone(&pending);
    let reader_handle = tokio::spawn(response_reader(ready_stdout, pending_clone));

    *guard = Some(Arc::new(HelperInner {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending,
        next_id: AtomicU32::new(1),
        _reader_handle: reader_handle,
    }));

    Ok(())
}

#[napi]
pub async fn screenshot(url: String, options: Option<ScreenshotOptions>) -> Result<Buffer> {
    // Clone Arc and release global lock immediately to allow concurrency
    let inner = {
        let guard = HELPER.lock().await;
        Arc::clone(
            guard
                .as_ref()
                .ok_or_else(|| Error::from_reason("Not initialized - call init() first"))?,
        )
    };

    let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let width = options.as_ref().and_then(|o| o.width).unwrap_or(1920);
    let height = options.as_ref().and_then(|o| o.height).unwrap_or(1080);
    let delay = options.as_ref().and_then(|o| o.delay).unwrap_or(500);

    // Register response channel
    let (tx, rx) = oneshot::channel();
    inner.pending.lock().await.insert(id, tx);

    // Send request (serialized by stdin mutex)
    {
        let mut stdin = inner.stdin.lock().await;
        let req = format!("{id}\t{width}\t{height}\t{delay}\t{url}\n");
        if let Err(e) = stdin.write_all(req.as_bytes()).await {
            inner.pending.lock().await.remove(&id);
            return Err(Error::from_reason(format!("Write to helper failed: {e}")));
        }
        if let Err(e) = stdin.flush().await {
            inner.pending.lock().await.remove(&id);
            return Err(Error::from_reason(format!("Flush failed: {e}")));
        }
    }

    // Wait for response (no locks held — true concurrency!)
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), rx)
        .await
        .map_err(|_| {
            // Clean up on timeout
            let pending = Arc::clone(&inner.pending);
            tokio::spawn(async move { pending.lock().await.remove(&id); });
            Error::from_reason("Timeout waiting for screenshot response")
        })?
        .map_err(|_| Error::from_reason("Helper process closed unexpectedly"))?;

    match result {
        Ok(png_path) => {
            let data = tokio::fs::read(&png_path)
                .await
                .map_err(|e| Error::from_reason(format!("Failed to read PNG {png_path}: {e}")))?;
            let _ = tokio::fs::remove_file(&png_path).await;
            Ok(Buffer::from(data))
        }
        Err(msg) => Err(Error::from_reason(format!("Screenshot failed: {msg}"))),
    }
}

#[napi]
pub async fn shutdown() -> Result<()> {
    let mut guard = HELPER.lock().await;
    if let Some(inner) = guard.take() {
        // Close stdin → helper detects EOF → exits
        drop(inner.stdin.lock().await);
        let mut child = inner.child.lock().await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
        let _ = child.kill().await;
    }
    Ok(())
}
