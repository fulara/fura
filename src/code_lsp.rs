//! Minimal rust-analyzer LSP client used by the read-only Code browser.
//!
//! The bridge owns the rust-analyzer child process and speaks just enough of
//! the Language Server Protocol to answer go-to-definition and find-references
//! point queries. Everything is projected into bridge domain types before it
//! leaves this module; raw LSP shapes never reach the browser.
//!
//! Transport mirrors the JSONL child pattern in `rpc.rs` (piped stdio + a
//! writer task + a reader task + a stop channel) but swaps line framing for LSP
//! `Content-Length` framing and adds request-id correlation.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, anyhow};
use lsp_types::{
    ClientCapabilities, DidChangeTextDocumentParams, DidOpenTextDocumentParams, GotoCapability,
    GotoDefinitionParams, GotoDefinitionResponse, InitializeParams, Location, Position, Range,
    ReferenceClientCapabilities, ReferenceContext, ReferenceParams, TextDocumentClientCapabilities,
    TextDocumentContentChangeEvent, TextDocumentIdentifier, TextDocumentItem,
    TextDocumentPositionParams, Uri, VersionedTextDocumentIdentifier, WindowClientCapabilities,
    WorkspaceFolder,
};
use serde_json::{Value, json};
use std::str::FromStr;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdout, Command},
    sync::{Mutex, mpsc, oneshot, watch},
    time::{sleep, timeout},
};
use tracing::{debug, warn};

/// LSP error code rust-analyzer returns while its index is still building.
const CONTENT_MODIFIED: i64 = -32801;
/// Timeout for the `initialize` handshake.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);
/// Timeout for a single LSP request attempt.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Overall budget for a navigation query including `ContentModified` retries.
const QUERY_DEADLINE: Duration = Duration::from_secs(90);
/// Delay between retries while the index is still building.
const RETRY_DELAY: Duration = Duration::from_millis(400);
/// Bound for the one-shot `--version` startup availability probe.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Reject LSP frames whose advertised `Content-Length` exceeds this, so a
/// corrupt or malicious header cannot drive an unbounded allocation. Navigation
/// responses are small; this is generous headroom.
const MAX_LSP_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

/// Coarse rust-analyzer readiness, projected to `code.status` by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnalyzerHealth {
    Starting,
    Indexing,
    Ready,
    Error,
}

/// A location returned by rust-analyzer, with its `file://` URI decoded to an
/// absolute filesystem path. Out-of-workspace classification happens upstream.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedLocation {
    pub(crate) path: PathBuf,
    pub(crate) range: Range,
}

/// What a request failed with. `Lsp { code: CONTENT_MODIFIED }` drives retries.
#[derive(Debug)]
enum AnalyzerError {
    Lsp { code: i64, message: String },
    Transport(String),
    Timeout,
}

impl AnalyzerError {
    fn into_message(self) -> String {
        match self {
            AnalyzerError::Lsp { code, message } => {
                format!("rust-analyzer error {code}: {message}")
            }
            AnalyzerError::Transport(message) => message,
            AnalyzerError::Timeout => "rust-analyzer request timed out".to_string(),
        }
    }
}

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AnalyzerError>>>>>;

/// Tracks the LSP document state the bridge has pushed for an open file so that
/// re-opening a file whose on-disk content changed sends `didChange` (with a
/// bumped version) instead of leaving rust-analyzer on a stale snapshot.
#[derive(Debug)]
struct OpenDoc {
    version: i32,
    hash: blake3::Hash,
}

/// Owns a rust-analyzer child process and its LSP transport. Shared via `Arc`
/// across all code workspaces that resolve to the same Rust root.
#[derive(Debug)]
pub(crate) struct Analyzer {
    outbound: mpsc::Sender<Vec<u8>>,
    pending: PendingMap,
    health: watch::Receiver<AnalyzerHealth>,
    alive: Arc<AtomicBool>,
    next_id: AtomicI64,
    open_files: Mutex<HashMap<PathBuf, OpenDoc>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl Analyzer {
    /// Spawn rust-analyzer for `root` and complete the `initialize` handshake.
    /// Returns once the server has acknowledged `initialize` (before indexing
    /// finishes); the first query absorbs indexing via `ContentModified` retry.
    pub(crate) async fn spawn(bin: &str, root: &Path) -> anyhow::Result<Arc<Analyzer>> {
        let mut command = Command::new(bin);
        command.current_dir(root);
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.kill_on_drop(true);

        let mut child = command
            .spawn()
            .with_context(|| format!("failed to spawn rust-analyzer ({bin})"))?;

        let stdin = child
            .stdin
            .take()
            .context("rust-analyzer stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("rust-analyzer stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("rust-analyzer stderr unavailable")?;

        let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(256);
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let (health_tx, health_rx) = watch::channel(AnalyzerHealth::Starting);
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));

        // Writer task: drain framed messages onto rust-analyzer stdin.
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(bytes) = outbound_rx.recv().await {
                if stdin.write_all(&bytes).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        // Stderr drain: keep the pipe from filling, surface trouble in logs.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end();
                        if !trimmed.is_empty() {
                            debug!(target: "code_lsp", stderr = %trimmed, "rust-analyzer stderr");
                        }
                    }
                }
            }
        });

        // Reader task: route responses to pending requests, answer server->client
        // requests, and track readiness from `experimental/serverStatus`.
        tokio::spawn(read_lsp_stdout(
            BufReader::new(stdout),
            pending.clone(),
            outbound_tx.clone(),
            health_tx.clone(),
            alive.clone(),
        ));

        // Child supervisor: kill on stop, flip liveness on exit.
        let supervisor_alive = alive.clone();
        let supervisor_health = health_tx;
        tokio::spawn(async move {
            let mut stop_rx = stop_rx;
            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
                _ = child.wait() => {}
            }
            supervisor_alive.store(false, Ordering::SeqCst);
            let _ = supervisor_health.send(AnalyzerHealth::Error);
        });

        let analyzer = Arc::new(Analyzer {
            outbound: outbound_tx,
            pending,
            health: health_rx,
            alive,
            next_id: AtomicI64::new(1),
            open_files: Mutex::new(HashMap::new()),
            stop: Mutex::new(Some(stop_tx)),
        });

        analyzer.initialize(root).await?;
        Ok(analyzer)
    }

    /// Current readiness snapshot.
    pub(crate) fn health(&self) -> AnalyzerHealth {
        *self.health.borrow()
    }

    /// Whether the child process is still running.
    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Resolve definitions for the symbol at `position` in `path`.
    pub(crate) async fn definition(
        &self,
        path: &Path,
        text: &str,
        position: Position,
    ) -> anyhow::Result<Vec<ResolvedLocation>> {
        self.ensure_open(path, text).await?;
        let params = GotoDefinitionParams {
            text_document_position_params: self.text_position(path, position)?,
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        let value = self
            .request_with_retry("textDocument/definition", serde_json::to_value(params)?)
            .await
            .map_err(|err| anyhow!(err.into_message()))?;
        let response: Option<GotoDefinitionResponse> = serde_json::from_value(value)?;
        Ok(locations_from_goto(response))
    }

    /// Resolve references (incl. the declaration) for the symbol at `position`.
    pub(crate) async fn references(
        &self,
        path: &Path,
        text: &str,
        position: Position,
    ) -> anyhow::Result<Vec<ResolvedLocation>> {
        self.ensure_open(path, text).await?;
        let params = ReferenceParams {
            text_document_position: self.text_position(path, position)?,
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
            context: ReferenceContext {
                include_declaration: true,
            },
        };
        let value = self
            .request_with_retry("textDocument/references", serde_json::to_value(params)?)
            .await
            .map_err(|err| anyhow!(err.into_message()))?;
        let response: Option<Vec<Location>> = serde_json::from_value(value)?;
        Ok(response
            .unwrap_or_default()
            .into_iter()
            .filter_map(resolve_location)
            .collect())
    }

    /// Best-effort graceful shutdown: `shutdown` + `exit`, then force-kill.
    pub(crate) async fn shutdown(&self) {
        let _ = self
            .request("shutdown", Value::Null)
            .await
            .map_err(AnalyzerError::into_message);
        let _ = self.notify("exit", Value::Null).await;
        if let Some(stop) = self.stop.lock().await.take() {
            let _ = stop.send(());
        }
    }

    fn text_position(
        &self,
        path: &Path,
        position: Position,
    ) -> anyhow::Result<TextDocumentPositionParams> {
        Ok(TextDocumentPositionParams {
            text_document: TextDocumentIdentifier {
                uri: file_uri_from_path(path)?,
            },
            position,
        })
    }

    /// Ensure rust-analyzer has the current content for `path`. Sends `didOpen`
    /// the first time and `didChange` (full content, bumped version) whenever the
    /// content has changed since we last pushed it.
    ///
    /// The `open_files` lock is held across the notification send so the recorded
    /// version/hash and the matching didOpen/didChange are published atomically.
    /// Otherwise a concurrent query could observe the new version and issue its
    /// request before the notification was queued (answering against a stale
    /// snapshot), or a didChange could be queued ahead of the initial didOpen.
    async fn ensure_open(&self, path: &Path, text: &str) -> anyhow::Result<()> {
        let hash = blake3::hash(text.as_bytes());
        let uri = file_uri_from_path(path)?;
        let mut open = self.open_files.lock().await;
        let notification: Option<(&'static str, Value)> = match open.get_mut(path) {
            None => {
                open.insert(path.to_path_buf(), OpenDoc { version: 1, hash });
                let params = DidOpenTextDocumentParams {
                    text_document: TextDocumentItem {
                        uri,
                        language_id: "rust".to_string(),
                        version: 1,
                        text: text.to_string(),
                    },
                };
                Some(("textDocument/didOpen", serde_json::to_value(params)?))
            }
            Some(doc) if doc.hash != hash => {
                doc.version += 1;
                doc.hash = hash;
                let params = DidChangeTextDocumentParams {
                    text_document: VersionedTextDocumentIdentifier {
                        uri,
                        version: doc.version,
                    },
                    content_changes: vec![TextDocumentContentChangeEvent {
                        range: None,
                        range_length: None,
                        text: text.to_string(),
                    }],
                };
                Some(("textDocument/didChange", serde_json::to_value(params)?))
            }
            Some(_) => None,
        };
        if let Some((method, params)) = notification {
            self.notify(method, params).await?;
        }
        Ok(())
    }

    async fn initialize(&self, root: &Path) -> anyhow::Result<()> {
        let root_uri = file_uri_from_path(root)?;
        let folder_name = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "workspace".to_string());
        #[allow(deprecated)]
        let params = InitializeParams {
            process_id: Some(std::process::id()),
            root_uri: Some(root_uri.clone()),
            initialization_options: Some(initialization_options()),
            capabilities: client_capabilities(),
            workspace_folders: Some(vec![WorkspaceFolder {
                uri: root_uri,
                name: folder_name,
            }]),
            ..Default::default()
        };
        let result = timeout(
            INITIALIZE_TIMEOUT,
            self.request("initialize", serde_json::to_value(params)?),
        )
        .await;
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => return Err(anyhow!(err.into_message())),
            Err(_) => return Err(anyhow!("rust-analyzer initialize timed out")),
        }
        self.notify("initialized", json!({})).await?;
        Ok(())
    }

    async fn request_with_retry(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, AnalyzerError> {
        let deadline = tokio::time::Instant::now() + QUERY_DEADLINE;
        loop {
            let outcome = self.request(method, params.clone()).await;
            let content_modified = matches!(
                &outcome,
                Err(AnalyzerError::Lsp { code, .. }) if *code == CONTENT_MODIFIED
            );
            if !content_modified {
                return outcome;
            }
            // Retry only if the backoff plus another full request attempt still
            // fits the budget, so total time stays under QUERY_DEADLINE.
            if tokio::time::Instant::now() + RETRY_DELAY + REQUEST_TIMEOUT >= deadline {
                return outcome;
            }
            sleep(RETRY_DELAY).await;
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, AnalyzerError> {
        if !self.is_alive() {
            return Err(AnalyzerError::Transport(
                "rust-analyzer is not running".to_string(),
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if self.outbound.send(frame(&message)).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err(AnalyzerError::Transport(
                "rust-analyzer transport closed".to_string(),
            ));
        }
        match timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AnalyzerError::Transport(
                "rust-analyzer closed before responding".to_string(),
            )),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(AnalyzerError::Timeout)
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> anyhow::Result<()> {
        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.outbound
            .send(frame(&message))
            .await
            .map_err(|_| anyhow!("rust-analyzer transport closed"))
    }
}

async fn read_lsp_stdout(
    mut reader: BufReader<ChildStdout>,
    pending: PendingMap,
    outbound: mpsc::Sender<Vec<u8>>,
    health: watch::Sender<AnalyzerHealth>,
    alive: Arc<AtomicBool>,
) {
    loop {
        match read_lsp_message(&mut reader).await {
            Ok(Some(message)) => {
                handle_incoming(message, &pending, &outbound, &health).await;
            }
            Ok(None) => break,
            Err(error) => {
                warn!(target: "code_lsp", %error, "failed to read rust-analyzer message");
                break;
            }
        }
    }
    alive.store(false, Ordering::SeqCst);
    let _ = health.send(AnalyzerHealth::Error);
    // Wake every awaiting request so callers fail instead of hanging.
    let mut pending = pending.lock().await;
    pending.clear();
}

async fn handle_incoming(
    message: Value,
    pending: &PendingMap,
    outbound: &mpsc::Sender<Vec<u8>>,
    health: &watch::Sender<AnalyzerHealth>,
) {
    if let Some(method) = message.get("method").and_then(Value::as_str) {
        if let Some(id) = message.get("id") {
            // Server -> client request: must reply or rust-analyzer blocks.
            let result = if method == "workspace/configuration" {
                let count = message
                    .pointer("/params/items")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                Value::Array(vec![Value::Null; count])
            } else {
                Value::Null
            };
            let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result });
            let _ = outbound.send(frame(&reply)).await;
        } else if method == "experimental/serverStatus" {
            // rust-analyzer reports `health` ("ok"|"warning"|"error") and
            // `quiescent`. A fatal `error` (e.g. failed to load the workspace)
            // must surface as Error even when quiescent, rather than Ready.
            let params = message.pointer("/params");
            let health_error = params
                .and_then(|params| params.get("health"))
                .and_then(Value::as_str)
                == Some("error");
            let quiescent = params
                .and_then(|params| params.get("quiescent"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let next = if health_error {
                AnalyzerHealth::Error
            } else if quiescent {
                AnalyzerHealth::Ready
            } else {
                AnalyzerHealth::Indexing
            };
            let _ = health.send(next);
        }
        return;
    }

    // Otherwise it is a response to one of our requests.
    let Some(id) = message.get("id").and_then(Value::as_i64) else {
        return;
    };
    let sender = pending.lock().await.remove(&id);
    let Some(sender) = sender else { return };
    if let Some(error) = message.get("error") {
        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let _ = sender.send(Err(AnalyzerError::Lsp {
            code,
            message: text,
        }));
    } else {
        let result = message.get("result").cloned().unwrap_or(Value::Null);
        let _ = sender.send(Ok(result));
    }
}

async fn read_lsp_message<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> anyhow::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    let mut header = Vec::new();
    loop {
        header.clear();
        let read = reader.read_until(b'\n', &mut header).await?;
        if read == 0 {
            return Ok(None);
        }
        let line = header.trim_ascii_end();
        if line.is_empty() {
            break;
        }
        let text = std::str::from_utf8(line).context("non-utf8 LSP header")?;
        if let Some((name, value)) = text.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(
                    value
                        .trim()
                        .parse()
                        .context("invalid Content-Length header")?,
                );
            }
        }
    }
    let length = content_length.context("LSP message missing Content-Length")?;
    if length > MAX_LSP_MESSAGE_BYTES {
        anyhow::bail!("LSP message too large: {length} bytes (limit {MAX_LSP_MESSAGE_BYTES})");
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    let value = serde_json::from_slice(&body).context("invalid LSP message body")?;
    Ok(Some(value))
}

/// One-shot, non-invasive availability probe. Runs `<bin> --version`, which
/// prints a version string and exits immediately — it does NOT start an LSP
/// session or index anything, so it respects lazy startup. On success the output
/// must identify rust-analyzer (so a misconfigured `--rust-analyzer-bin` pointing
/// at some other zero-exit binary is rejected); the probe is bounded by a timeout
/// so a hanging wrapper cannot block startup. Returns the trimmed version on
/// success, or a human-readable error (this also catches the rustup proxy case
/// where `rust-analyzer` is on PATH but the component is missing).
pub(crate) async fn probe_availability(bin: &str) -> Result<String, String> {
    let mut child = Command::new(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| format!("failed to launch {bin}: {err}"))?;
    // `--version` writes a single short line, so waiting before draining the
    // pipes cannot deadlock. On timeout we kill AND reap the child (kill().await
    // waits) so a hanging wrapper does not leave a zombie.
    let status = match timeout(PROBE_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(err)) => return Err(format!("failed to run {bin} --version: {err}")),
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!("{bin} --version timed out"));
        }
    };
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout).await;
    }
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr).await;
        }
        let stderr = stderr.trim();
        return Err(if stderr.is_empty() {
            format!("{bin} exited with {status}")
        } else {
            stderr.to_string()
        });
    }
    let version = stdout.trim().to_string();
    if !version_identifies_rust_analyzer(&version) {
        return Err(format!(
            "{bin} --version did not identify as rust-analyzer (got {version:?})"
        ));
    }
    Ok(version)
}

/// Whether a `--version` line came from rust-analyzer. Used to reject a
/// misconfigured binary that merely exits 0.
fn version_identifies_rust_analyzer(version: &str) -> bool {
    version.to_ascii_lowercase().contains("rust-analyzer")
}

fn frame(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).unwrap_or_default();
    let mut framed = Vec::with_capacity(body.len() + 40);
    framed.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
    framed.extend_from_slice(&body);
    framed
}

fn client_capabilities() -> ClientCapabilities {
    ClientCapabilities {
        text_document: Some(TextDocumentClientCapabilities {
            definition: Some(GotoCapability {
                dynamic_registration: Some(false),
                // Force `Location[]` responses instead of `LocationLink[]`.
                link_support: Some(false),
            }),
            references: Some(ReferenceClientCapabilities {
                dynamic_registration: Some(false),
            }),
            ..Default::default()
        }),
        window: Some(WindowClientCapabilities {
            work_done_progress: Some(true),
            ..Default::default()
        }),
        experimental: Some(json!({ "serverStatusNotification": true })),
        ..Default::default()
    }
}

fn initialization_options() -> Value {
    // Keep rust-analyzer light: definitions/references come from its semantic
    // index, not from flycheck, proc-macro expansion, or build scripts.
    json!({
        "cargo": { "buildScripts": { "enable": false } },
        "procMacro": { "enable": false },
        "checkOnSave": false,
        "check": { "enable": false },
    })
}

fn locations_from_goto(response: Option<GotoDefinitionResponse>) -> Vec<ResolvedLocation> {
    match response {
        None => Vec::new(),
        Some(GotoDefinitionResponse::Scalar(location)) => {
            resolve_location(location).into_iter().collect()
        }
        Some(GotoDefinitionResponse::Array(locations)) => {
            locations.into_iter().filter_map(resolve_location).collect()
        }
        Some(GotoDefinitionResponse::Link(links)) => links
            .into_iter()
            .filter_map(|link| {
                resolve_uri(&link.target_uri).map(|path| ResolvedLocation {
                    path,
                    range: link.target_selection_range,
                })
            })
            .collect(),
    }
}

fn resolve_location(location: Location) -> Option<ResolvedLocation> {
    resolve_uri(&location.uri).map(|path| ResolvedLocation {
        path,
        range: location.range,
    })
}

fn resolve_uri(uri: &Uri) -> Option<PathBuf> {
    path_from_file_uri(uri.as_str())
}

/// Build a `file://` URI from an absolute path, percent-encoding as needed.
fn file_uri_from_path(path: &Path) -> anyhow::Result<Uri> {
    let raw = path
        .to_str()
        .ok_or_else(|| anyhow!("path is not valid UTF-8: {}", path.display()))?;
    let encoded = percent_encode_path(raw);
    let uri_str = format!("file://{encoded}");
    Uri::from_str(&uri_str).map_err(|err| anyhow!("invalid file URI for {raw}: {err}"))
}

/// Decode a `file://` URI string into a filesystem path. Returns `None` for
/// non-file URIs (e.g. `untitled:`), which are not browsable.
fn path_from_file_uri(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    // Drop an optional authority component (`file://host/path`); rust-analyzer
    // emits an empty authority so `rest` already starts with `/`.
    let path_start = rest.find('/').unwrap_or(0);
    let path = &rest[path_start..];
    // Strip any query/fragment (not expected for file URIs).
    let path = path.split(['?', '#']).next().unwrap_or(path);
    Some(PathBuf::from(percent_decode(path)))
}

fn percent_encode_path(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        if is_unreserved(byte) || byte == b'/' {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(hex_digit(byte >> 4));
            out.push(hex_digit(byte & 0x0f));
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                out.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'A' + (value - 10)) as char,
    }
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_message_with_content_length() {
        let framed = frame(&json!({ "id": 1 }));
        let text = String::from_utf8(framed).unwrap();
        assert!(text.starts_with("Content-Length: 8\r\n\r\n"));
        assert!(text.ends_with("{\"id\":1}"));
    }

    #[tokio::test]
    async fn reads_framed_message_split_across_reads() {
        // Header and body arrive in separate writes; the reader must reassemble.
        let (mut writer, reader) = tokio::io::duplex(64);
        let mut buffered = BufReader::new(reader);
        tokio::spawn(async move {
            writer.write_all(b"Content-Length: 13\r\n").await.unwrap();
            tokio::time::sleep(Duration::from_millis(5)).await;
            writer.write_all(b"\r\n{\"method\":42}").await.unwrap();
        });
        let message = read_lsp_message(&mut buffered).await.unwrap().unwrap();
        assert_eq!(message.get("method").and_then(Value::as_i64), Some(42));
    }

    #[tokio::test]
    async fn reads_two_back_to_back_messages() {
        let (mut writer, reader) = tokio::io::duplex(128);
        let mut buffered = BufReader::new(reader);
        tokio::spawn(async move {
            writer.write_all(&frame(&json!({ "id": 1 }))).await.unwrap();
            writer.write_all(&frame(&json!({ "id": 2 }))).await.unwrap();
        });
        let first = read_lsp_message(&mut buffered).await.unwrap().unwrap();
        let second = read_lsp_message(&mut buffered).await.unwrap().unwrap();
        assert_eq!(first.get("id").and_then(Value::as_i64), Some(1));
        assert_eq!(second.get("id").and_then(Value::as_i64), Some(2));
    }

    #[tokio::test]
    async fn returns_none_on_clean_eof() {
        let (writer, reader) = tokio::io::duplex(8);
        drop(writer);
        let mut buffered = BufReader::new(reader);
        assert!(read_lsp_message(&mut buffered).await.unwrap().is_none());
    }

    #[test]
    fn round_trips_file_uri_with_spaces() {
        let path = PathBuf::from("/Users/me/My Project/src/lib.rs");
        let uri = file_uri_from_path(&path).unwrap();
        assert_eq!(uri.as_str(), "file:///Users/me/My%20Project/src/lib.rs");
        let decoded = path_from_file_uri(uri.as_str()).unwrap();
        assert_eq!(decoded, path);
    }

    #[test]
    fn decodes_plain_file_uri() {
        let decoded = path_from_file_uri("file:///home/dev/repo/src/main.rs").unwrap();
        assert_eq!(decoded, PathBuf::from("/home/dev/repo/src/main.rs"));
    }

    #[test]
    fn rejects_non_file_uri() {
        assert!(path_from_file_uri("untitled:Untitled-1").is_none());
    }

    #[test]
    fn percent_decodes_unicode_bytes() {
        // "café" -> 'é' is 0xC3 0xA9 in UTF-8.
        assert_eq!(percent_decode("caf%C3%A9"), "café");
    }

    #[test]
    fn goto_response_scalar_and_array_resolve_paths() {
        let scalar = json!({
            "uri": "file:///repo/src/a.rs",
            "range": { "start": { "line": 1, "character": 2 }, "end": { "line": 1, "character": 5 } }
        });
        let response: Option<GotoDefinitionResponse> = serde_json::from_value(scalar).unwrap();
        let locations = locations_from_goto(response);
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].path, PathBuf::from("/repo/src/a.rs"));
        assert_eq!(locations[0].range.start.line, 1);

        let array = json!([
            { "uri": "file:///repo/src/a.rs", "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } } },
            { "uri": "untitled:scratch", "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } } }
        ]);
        let response: Option<GotoDefinitionResponse> = serde_json::from_value(array).unwrap();
        // The non-file URI is dropped.
        assert_eq!(locations_from_goto(response).len(), 1);
    }

    #[test]
    fn null_goto_response_is_empty() {
        let response: Option<GotoDefinitionResponse> = serde_json::from_value(Value::Null).unwrap();
        assert!(locations_from_goto(response).is_empty());
    }

    #[test]
    fn client_capabilities_force_plain_locations_and_status() {
        let value = serde_json::to_value(client_capabilities()).unwrap();
        assert_eq!(
            value.pointer("/textDocument/definition/linkSupport"),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            value.pointer("/experimental/serverStatusNotification"),
            Some(&Value::Bool(true))
        );
    }

    #[tokio::test]
    async fn probe_reports_unavailable_for_missing_binary() {
        let result = probe_availability("/nonexistent/rust-analyzer-xyz").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("failed to launch"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_rejects_non_rust_analyzer_zero_exit() {
        // `true` exits 0 but its output does not identify rust-analyzer.
        let error = probe_availability("true").await.expect_err("must reject");
        assert!(error.contains("did not identify as rust-analyzer"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probe_reports_error_for_nonzero_exit() {
        // `false` exits non-zero, which classifies as unavailable.
        assert!(probe_availability("false").await.is_err());
    }

    #[test]
    fn version_identity_accepts_rust_analyzer_and_rejects_others() {
        assert!(version_identifies_rust_analyzer(
            "rust-analyzer 1.95.0 (59807616 2026-04-14)"
        ));
        assert!(version_identifies_rust_analyzer("RUST-ANALYZER 1.0"));
        assert!(!version_identifies_rust_analyzer("--version"));
        assert!(!version_identifies_rust_analyzer("some-other-lsp 2.0"));
    }
}
