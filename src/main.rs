use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader as StdBufReader},
    net::IpAddr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, anyhow};
use axum::{
    Json, Router,
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    fs as async_fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::Command,
    sync::{RwLock, broadcast, mpsc, oneshot},
};
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::{error, info, warn};
use uuid::Uuid;

const SESSION_CATALOG_POLL_INTERVAL: Duration = Duration::from_secs(3);
const SESSION_CATALOG_PRELOAD_LIMIT: usize = 30;

#[derive(Debug, Parser)]
#[command(
    name = "fura",
    version,
    about = "Local browser bridge for Oh My Pi RPC sessions"
)]
struct Args {
    #[arg(long, default_value = "127.0.0.1")]
    host: IpAddr,

    #[arg(long, default_value_t = 3737)]
    port: u16,

    #[arg(long, env = "FURA_TOKEN")]
    token: Option<String>,

    #[arg(long, env = "FURA_LOG_FRAMES", default_value_t = false)]
    log_frames: bool,

    /// JSONL file that receives every raw RPC stdout frame before Fura maps it.
    #[arg(long, env = "FURA_BRIDGE_DEBUG_FILE")]
    bridge_debug_file: Option<PathBuf>,

    /// Forward raw OMP RPC frames to WebSocket clients. Disabled by default because clients do not render them.
    #[arg(long, env = "FURA_FORWARD_RAW_FRAMES", default_value_t = false)]
    forward_raw_frames: bool,

    #[arg(long, default_value = "frontend/dist")]
    static_dir: PathBuf,

    /// Program used for each managed stdio JSONL RPC child.
    #[arg(long, env = "FURA_RPC_PROGRAM", default_value = "omp")]
    rpc_program: String,

    /// Extra argument for the RPC child. Repeat for multiple args.
    #[arg(long = "rpc-arg", env = "FURA_RPC_ARGS")]
    rpc_args: Vec<String>,

    /// Do not add the default Oh My Pi RPC args (`--mode rpc`).
    #[arg(long, env = "FURA_NO_DEFAULT_RPC_ARGS", default_value_t = false)]
    no_default_rpc_args: bool,

    /// Root directory containing OMP session JSONL files.
    #[arg(long, env = "FURA_SESSION_ROOT")]
    session_root: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    token: Arc<String>,
    sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    rpc_sessions: Arc<RwLock<HashMap<String, RpcSessionHandle>>>,
    rpc_session_targets: Arc<RwLock<HashMap<String, String>>>,
    /// Metadata for a newly spawned RPC child before OMP reports its real session id.
    pending_created_sessions: Arc<RwLock<HashMap<String, PendingCreatedSession>>>,
    /// Name to apply to the next new session spawned by a fork or handoff on this transport.
    pending_new_session_names: Arc<RwLock<HashMap<String, String>>>,
    events: broadcast::Sender<ServerMessage>,
    rpc_config: Arc<RpcConfig>,
    log_frames: bool,
    bridge_debug_file: Option<PathBuf>,
    forward_raw_frames: bool,
    session_root: PathBuf,
    default_cwd: Arc<RwLock<String>>,
    config_path: Option<PathBuf>,
}

struct RpcSessionHandle {
    stdin: mpsc::Sender<Value>,
    stop: oneshot::Sender<()>,
}

#[derive(Debug, Clone)]
struct PendingCreatedSession {
    cwd: Option<String>,
    args: Vec<String>,
    title: Option<String>,
    created_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct FuraConfig {
    last_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfig {
    default_cwd: String,
}

#[derive(Debug)]
struct RpcConfig {
    program: String,
    args: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    id: String,
    cwd: Option<String>,
    args: Vec<String>,
    status: SessionStatus,
    created_at: u64,
    updated_at: u64,
    messages: Vec<TranscriptMessage>,
    /// IDs of messages that arrived live via `message_end`; preserved across `get_messages` reconciliation.
    live_message_ids: HashSet<String>,
    /// In-flight partial message from `message_update` deltas; included at the end of projection and cleared on `message_end`.
    #[serde(skip)]
    streaming_message: Option<TranscriptMessage>,
    /// Completed tool-execution cards projected from live events or historical tool results.
    #[serde(skip)]
    tool_cards: Vec<ToolCard>,
    /// Tool-execution cards currently in progress.
    #[serde(skip)]
    active_tool_calls: Vec<ToolCard>,
    kind: SessionKind,
    session_file: Option<String>,
    title: Option<String>,
    timestamp: Option<String>,
    model: Option<String>,
    thinking_level: Option<String>,
    tokens_total: u64,
    cost_usd: f64,
    context_tokens: Option<u64>,
    context_window: Option<u64>,
    context_percent: Option<f64>,
    plan_mode: Option<PlanModeProjection>,
}

impl SessionRecord {
    fn summary(&self) -> SessionSummary {
        SessionSummary {
            session_id: self.id.clone(),
            cwd: self.cwd.clone(),
            status: self.effective_status(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            message_count: self.messages.len(),
            kind: self.kind,
            session_file: self.session_file.clone(),
            title: self.title.clone(),
            timestamp: self.timestamp.clone(),
        }
    }

    fn has_active_work(&self) -> bool {
        self.streaming_message.is_some() || self.active_tool_calls.iter().any(|card| card.is_active)
    }

    fn effective_status(&self) -> SessionStatus {
        match self.status {
            SessionStatus::Exited | SessionStatus::Available | SessionStatus::Error => self.status,
            _ if self.has_active_work() => SessionStatus::Busy,
            status => status,
        }
    }

    fn projection(&self) -> SessionProjection {
        SessionProjection {
            summary: self.summary(),
            transcript: {
                // Collect and sort all cards (completed + active) by their insertion position.
                let mut all_cards: Vec<&ToolCard> = self
                    .tool_cards
                    .iter()
                    .chain(self.active_tool_calls.iter())
                    .collect();
                all_cards.sort_by_key(|c| c.insert_after_count);

                let mut t: Vec<TranscriptEntry> = Vec::new();
                let mut ci = 0_usize;

                // Cards that precede all messages (insert_after_count == 0).
                while ci < all_cards.len() && all_cards[ci].insert_after_count == 0 {
                    t.push(TranscriptEntry::Tool(all_cards[ci].clone()));
                    ci += 1;
                }

                // Interleave messages with any cards that follow them.
                for (mi, msg) in self.messages.iter().enumerate() {
                    t.push(TranscriptEntry::Message(msg.clone()));
                    while ci < all_cards.len() && all_cards[ci].insert_after_count == mi + 1 {
                        t.push(TranscriptEntry::Tool(all_cards[ci].clone()));
                        ci += 1;
                    }
                }

                // Any remaining cards (insert_after_count > messages.len()).
                while ci < all_cards.len() {
                    t.push(TranscriptEntry::Tool(all_cards[ci].clone()));
                    ci += 1;
                }

                // Streaming in-flight message always last.
                if let Some(streaming) = &self.streaming_message {
                    t.push(TranscriptEntry::Message(streaming.clone()));
                }
                t
            },
            is_busy: matches!(
                self.effective_status(),
                SessionStatus::Starting | SessionStatus::Busy
            ),
            model: self.model.clone(),
            thinking_level: self.thinking_level.clone(),
            tokens_total: self.tokens_total,
            cost_usd: self.cost_usd,
            context_tokens: self.context_tokens,
            context_window: self.context_window,
            context_percent: self.context_percent,
            plan_mode: self.plan_mode.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
enum SessionKind {
    Managed,
    Available,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum SessionStatus {
    Starting,
    Idle,
    Busy,
    Exited,
    Available,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    session_id: String,
    cwd: Option<String>,
    status: SessionStatus,
    created_at: u64,
    updated_at: u64,
    message_count: usize,
    kind: SessionKind,
    session_file: Option<String>,
    title: Option<String>,
    timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionProjection {
    summary: SessionSummary,
    transcript: Vec<TranscriptEntry>,
    is_busy: bool,
    model: Option<String>,
    thinking_level: Option<String>,
    tokens_total: u64,
    cost_usd: f64,
    context_tokens: Option<u64>,
    context_window: Option<u64>,
    context_percent: Option<f64>,
    plan_mode: Option<PlanModeProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanModeProjection {
    enabled: bool,
    plan_file_path: String,
    workflow: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptMessage {
    id: String,
    role: MessageRole,
    blocks: Vec<ContentBlock>,
    /// True when this message arrived via a live `message_end` event rather than a historical `get_messages` load.
    is_new: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ContentBlock {
    Text {
        text: String,
    },
    /// Extended thinking content. Signature is intentionally excluded.
    Thinking {
        thinking: String,
    },
    /// Thinking content that the provider has fully encrypted/redacted.
    RedactedThinking,
}

/// A single tool-execution card tracked in the session transcript.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCard {
    tool_call_id: String,
    tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    intent: Option<String>,
    args: Value,
    is_active: bool,
    is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    partial_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    /// messages.len() at the time tool_execution_start fired.
    /// This card appears after record.messages[insert_after_count - 1]
    /// (or before all messages when 0).
    #[serde(skip)]
    insert_after_count: usize,
}

/// A single entry in the unified session transcript.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TranscriptEntry {
    #[serde(rename = "message")]
    Message(TranscriptMessage),
    #[serde(rename = "tool")]
    Tool(ToolCard),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionHeader {
    #[serde(rename = "type")]
    entry_type: String,
    id: String,
    timestamp: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
enum PromptBehavior {
    #[serde(rename = "steer")]
    Steer,
    #[serde(rename = "followUp")]
    FollowUp,
}

impl PromptBehavior {
    fn as_rpc_streaming_behavior(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "followUp",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ClientMessage {
    #[serde(rename = "session.create")]
    SessionCreate {
        cwd: Option<String>,
        name: Option<String>,
        args: Option<Vec<String>>,
    },
    #[serde(rename = "session.attach")]
    SessionAttach { session_id: String },
    #[serde(rename = "session.open")]
    SessionOpen { session_file: String },
    #[serde(rename = "session.detach")]
    SessionDetach { session_id: String },
    #[serde(rename = "session.stop")]
    SessionStop { session_id: String },
    #[serde(rename = "session.delete")]
    SessionDelete { session_id: String },
    #[serde(rename = "session.list")]
    SessionList,
    #[serde(rename = "state.refresh")]
    StateRefresh { session_id: String },
    #[serde(rename = "prompt.send")]
    PromptSend {
        session_id: String,
        text: String,
        images: Option<Vec<Value>>,
        behavior: Option<PromptBehavior>,
    },
    #[serde(rename = "prompt.abort")]
    PromptAbort { session_id: String },
    #[serde(rename = "dialog.respond")]
    DialogRespond {
        session_id: String,
        dialog_id: String,
        response: Value,
    },
    #[serde(rename = "model.list")]
    ModelList { session_id: String },
    #[serde(rename = "model.set")]
    ModelSet {
        session_id: String,
        provider: String,
        model_id: String,
    },
    #[serde(rename = "diff.refresh")]
    DiffRefresh {
        session_id: String,
        selector: Option<String>,
        head_selector: Option<String>,
        stat: Option<bool>,
    },
    #[serde(rename = "diff.snapshot")]
    DiffSnapshot {
        session_id: String,
        label: Option<String>,
    },
    #[serde(rename = "session.fork")]
    SessionFork { session_id: String, name: String },
    #[serde(rename = "session.handoff")]
    SessionHandoff {
        session_id: String,
        name: String,
        custom_instructions: Option<String>,
    },
    #[serde(rename = "raw.rpc")]
    RawRpc { session_id: String, command: Value },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum NoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelSummary {
    provider: String,
    id: String,
    name: Option<String>,
    context_window: Option<u64>,
    thinking: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ServerMessage {
    #[serde(rename = "hello")]
    Hello {
        server_version: &'static str,
        protocol_version: u32,
        config: ClientConfig,
    },
    #[serde(rename = "config.updated")]
    ConfigUpdated { config: ClientConfig },
    #[serde(rename = "sessions.snapshot")]
    SessionsSnapshot { sessions: Vec<SessionSummary> },
    #[serde(rename = "session.snapshot")]
    SessionSnapshot {
        session_id: String,
        state: SessionProjection,
    },
    #[serde(rename = "session.exited")]
    SessionExited {
        session_id: String,
        code: Option<i32>,
        signal: Option<String>,
    },
    #[serde(rename = "log.stderr")]
    LogStderr { session_id: String, text: String },
    #[serde(rename = "session.notice")]
    SessionNotice {
        session_id: String,
        level: NoticeLevel,
        text: String,
    },
    #[serde(rename = "model.list")]
    ModelList {
        session_id: String,
        models: Vec<ModelSummary>,
    },
    #[serde(rename = "model.changed")]
    ModelChanged {
        session_id: String,
        model: ModelSummary,
    },
    #[serde(rename = "plan.review")]
    PlanReview {
        session_id: String,
        plan_file_path: String,
        final_plan_file_path: String,
        title: Option<String>,
        content: String,
    },
    #[serde(rename = "diff.state")]
    DiffState { session_id: String, state: Value },
    #[serde(rename = "raw.omp")]
    RawOmp { session_id: String, frame: Value },
    #[serde(rename = "error")]
    Error {
        request_id: Option<String>,
        message: String,
    },
}

fn default_config_path() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(|home| PathBuf::from(home).join(".fura").join("config.yaml"))
}

fn valid_directory_string(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    match fs::metadata(trimmed) {
        Ok(metadata) if metadata.is_dir() => Some(trimmed.to_string()),
        _ => None,
    }
}

fn load_default_cwd(config_path: Option<&Path>, startup_cwd: &Path) -> String {
    if let Some(path) = config_path {
        match fs::read_to_string(path) {
            Ok(text) => match serde_yaml::from_str::<FuraConfig>(&text) {
                Ok(config) => {
                    if let Some(cwd) = config.last_cwd.as_deref().and_then(valid_directory_string) {
                        return cwd;
                    }
                }
                Err(error) => warn!(path = %path.display(), %error, "failed to parse Fura config"),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => warn!(path = %path.display(), %error, "failed to read Fura config"),
        }
    }

    startup_cwd.to_string_lossy().into_owned()
}

async fn client_config(state: &AppState) -> ClientConfig {
    ClientConfig {
        default_cwd: state.default_cwd.read().await.clone(),
    }
}

async fn broadcast_config(state: &AppState) {
    let config = client_config(state).await;
    let _ = state.events.send(ServerMessage::ConfigUpdated { config });
}

async fn save_default_cwd(state: &AppState, cwd: &str) {
    *state.default_cwd.write().await = cwd.to_string();

    if let Some(path) = state.config_path.as_ref() {
        if let Some(parent) = path.parent() {
            if let Err(error) = async_fs::create_dir_all(parent).await {
                warn!(path = %parent.display(), %error, "failed to create Fura config directory");
                broadcast_config(state).await;
                return;
            }
        }

        let config = FuraConfig {
            last_cwd: Some(cwd.to_string()),
        };
        match serde_yaml::to_string(&config) {
            Ok(text) => {
                if let Err(error) = async_fs::write(path, text).await {
                    warn!(path = %path.display(), %error, "failed to write Fura config");
                }
            }
            Err(error) => warn!(%error, "failed to serialize Fura config"),
        }
    }
    broadcast_config(state).await;
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "fura=info,tower_http=info".into()),
        )
        .init();

    let args = Args::parse();
    let token = args
        .token
        .filter(|token| !token.trim().is_empty())
        .unwrap_or_else(generate_token);

    if !args.host.is_loopback() {
        warn!(
            host = %args.host,
            "binding outside loopback; use only on trusted networks"
        );
    }

    let mut rpc_args = Vec::new();
    if !args.no_default_rpc_args {
        rpc_args.extend(["--mode".to_string(), "rpc".to_string()]);
    }
    rpc_args.extend(args.rpc_args);

    let session_root = args.session_root.unwrap_or_else(default_session_root);
    let startup_cwd = env::current_dir().context("failed to read bridge working directory")?;
    let config_path = default_config_path();
    let default_cwd = load_default_cwd(config_path.as_deref(), &startup_cwd);
    let (events, _) = broadcast::channel(512);
    let state = AppState {
        token: Arc::new(token),
        sessions: Arc::new(RwLock::new(HashMap::new())),
        rpc_sessions: Arc::new(RwLock::new(HashMap::new())),
        rpc_session_targets: Arc::new(RwLock::new(HashMap::new())),
        pending_created_sessions: Arc::new(RwLock::new(HashMap::new())),
        pending_new_session_names: Arc::new(RwLock::new(HashMap::new())),
        events,
        rpc_config: Arc::new(RpcConfig {
            program: args.rpc_program,
            args: rpc_args,
        }),
        log_frames: args.log_frames,
        bridge_debug_file: args.bridge_debug_file,
        forward_raw_frames: args.forward_raw_frames,
        session_root,
        default_cwd: Arc::new(RwLock::new(default_cwd)),
        config_path,
    };

    start_session_catalog_watcher(state.clone());

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(&args.static_dir).append_index_html_on_directories(true))
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let listener = TcpListener::bind((args.host, args.port))
        .await
        .with_context(|| format!("failed to bind {}:{}", args.host, args.port))?;

    log_server_ready(&state, args.host, args.port);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server failed")
}

fn start_session_catalog_watcher(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(SESSION_CATALOG_POLL_INTERVAL).await;
            if refresh_session_catalog(&state).await {
                broadcast_sessions_snapshot(&state).await;
            }
        }
    });
}

fn log_server_ready(state: &AppState, host: std::net::IpAddr, port: u16) {
    info!(
        url = %format!("http://{host}:{port}"),
        token = %state.token,
        rpc_program = %state.rpc_config.program,
        rpc_arg_count = state.rpc_config.args.len(),
        "fura bridge listening"
    );
    if state.log_frames {
        warn!(
            "full frame logging is enabled; logs may include prompts, file contents, command output, and secrets"
        );
    }
    if let Some(path) = state.bridge_debug_file.as_ref() {
        warn!(
            path = %path.display(),
            "bridge debug file is enabled; raw RPC frames may include prompts, file contents, command output, and secrets"
        );
    }
}

async fn healthz() -> Json<Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    match query.get("token") {
        Some(token) if token == state.token.as_ref() => {
            ws.on_upgrade(move |socket| handle_socket(socket, state))
        }
        _ => (StatusCode::UNAUTHORIZED, "missing or invalid token").into_response(),
    }
}

async fn handle_socket(mut socket: WebSocket, state: AppState) {
    info!("websocket client connected");
    let mut event_rx = state.events.subscribe();

    let config = client_config(&state).await;
    if send_json(
        &mut socket,
        &ServerMessage::Hello {
            server_version: env!("CARGO_PKG_VERSION"),
            protocol_version: 1,
            config,
        },
    )
    .await
    .is_err()
    {
        return;
    }

    if send_sessions_snapshot(&mut socket, &state).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            frame = socket.recv() => {
                let Some(frame) = frame else { return; };
                if handle_websocket_frame(&mut socket, &state, frame).await.is_err() {
                    return;
                }
            }
            event = event_rx.recv() => {
                match event {
                    Ok(message) => {
                        if send_json(&mut socket, &message).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "websocket client lagged behind bridge events");
                        if send_sessions_snapshot(&mut socket, &state).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    }
}

async fn handle_websocket_frame(
    socket: &mut WebSocket,
    state: &AppState,
    frame: Result<Message, axum::Error>,
) -> Result<(), axum::Error> {
    let frame = match frame {
        Ok(frame) => frame,
        Err(error) => {
            warn!(%error, "websocket receive failed");
            return Err(error);
        }
    };

    match frame {
        Message::Text(text) => {
            if state.log_frames {
                info!(direction = "client_to_bridge", frame = %text, "websocket frame");
            }

            match serde_json::from_str::<ClientMessage>(&text) {
                Ok(message) => {
                    for response in handle_client_message(state, message).await {
                        send_json(socket, &response).await?;
                    }
                }
                Err(error) => {
                    warn!(%error, "invalid client websocket message");
                    let response = ServerMessage::Error {
                        request_id: None,
                        message: format!("invalid client message: {error}"),
                    };
                    send_json(socket, &response).await?;
                }
            }
        }
        Message::Close(_) => return Err(axum::Error::new(anyhow!("websocket closed"))),
        Message::Ping(_) | Message::Pong(_) => {}
        Message::Binary(_) => {
            let response = ServerMessage::Error {
                request_id: None,
                message: "binary websocket frames are not supported".to_string(),
            };
            send_json(socket, &response).await?;
        }
    }

    Ok(())
}

async fn handle_client_message(state: &AppState, message: ClientMessage) -> Vec<ServerMessage> {
    match message {
        ClientMessage::SessionCreate { cwd, name, args } => {
            create_session(state, cwd, name, args).await
        }
        ClientMessage::SessionOpen { session_file } => open_session(state, session_file).await,
        ClientMessage::SessionList => {
            info!(action = "session.list");
            refresh_session_catalog(state).await;
            let sessions = state.sessions.read().await;
            vec![sessions_snapshot_from_map(&sessions)]
        }
        ClientMessage::SessionAttach { session_id }
        | ClientMessage::StateRefresh { session_id } => {
            info!(action = "session.attach_or_refresh", session_id = %session_id);
            if let Err(message) = refresh_rpc_state(state, &session_id).await {
                warn!(session_id = %session_id, %message, "state refresh could not reach RPC child");
            }
            let sessions = state.sessions.read().await;
            match sessions.get(&session_id) {
                Some(record) => vec![ServerMessage::SessionSnapshot {
                    session_id,
                    state: record.projection(),
                }],
                None => vec![unknown_session_error(session_id)],
            }
        }
        ClientMessage::SessionDetach { session_id } => {
            info!(action = "session.detach", session_id = %session_id);
            vec![ServerMessage::LogStderr {
                session_id,
                text: "detached frontend client; backend session remains alive".to_string(),
            }]
        }
        ClientMessage::SessionStop { session_id } => stop_session(state, session_id).await,
        ClientMessage::SessionDelete { session_id } => delete_session(state, session_id).await,
        ClientMessage::PromptSend {
            session_id,
            text,
            images,
            behavior,
        } => send_prompt(state, session_id, text, images, behavior).await,
        ClientMessage::PromptAbort { session_id } => abort_prompt(state, session_id).await,
        ClientMessage::DialogRespond {
            session_id,
            dialog_id,
            response,
        } => {
            info!(action = "dialog.respond", session_id = %session_id, dialog_id = %dialog_id);
            let command = serde_json::json!({
                "id": next_rpc_id(),
                "type": "extension_ui_response",
                "requestId": dialog_id,
                "response": response,
            });
            match send_rpc_command(state, &session_id, command).await {
                Ok(()) => Vec::new(),
                Err(message) => vec![ServerMessage::Error {
                    request_id: None,
                    message,
                }],
            }
        }
        ClientMessage::ModelList { session_id } => {
            handle_model_list_command(state, session_id).await
        }
        ClientMessage::ModelSet {
            session_id,
            provider,
            model_id,
        } => handle_model_set_command(state, session_id, &provider, &model_id).await,
        ClientMessage::DiffRefresh {
            session_id,
            selector,
            head_selector,
            stat,
        } => {
            handle_diff_refresh(
                state,
                session_id,
                selector,
                head_selector,
                stat.unwrap_or(false),
            )
            .await
        }
        ClientMessage::DiffSnapshot { session_id, label } => {
            handle_diff_snapshot(state, session_id, label).await
        }
        ClientMessage::RawRpc {
            session_id,
            mut command,
        } => {
            info!(
                action = "raw.rpc",
                session_id = %session_id,
                command_type = command_type(&command)
            );
            ensure_rpc_id(&mut command);
            match send_rpc_command(state, &session_id, command).await {
                Ok(()) => Vec::new(),
                Err(message) => vec![ServerMessage::Error {
                    request_id: None,
                    message,
                }],
            }
        }
        ClientMessage::SessionFork { session_id, name } => {
            handle_session_fork(state, session_id, name).await
        }
        ClientMessage::SessionHandoff {
            session_id,
            name,
            custom_instructions,
        } => handle_session_handoff(state, session_id, name, custom_instructions).await,
    }
}

async fn create_session(
    state: &AppState,
    cwd: Option<String>,
    name: Option<String>,
    args: Option<Vec<String>>,
) -> Vec<ServerMessage> {
    let transport_id = Uuid::new_v4().to_string();
    let args = args.unwrap_or_default();
    let created_at = now_epoch_seconds();
    let cwd = match cwd.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    }) {
        Some(cwd) => cwd,
        None => state.default_cwd.read().await.clone(),
    };
    info!(
        action = "session.create",
        transport_session_id = %transport_id,
        cwd = %cwd,
        has_name = name.is_some(),
        arg_count = args.len()
    );

    state.pending_created_sessions.write().await.insert(
        transport_id.clone(),
        PendingCreatedSession {
            cwd: Some(cwd.clone()),
            args: args.clone(),
            title: name.clone(),
            created_at,
        },
    );

    if let Err(error) = spawn_rpc_child(
        state.clone(),
        transport_id.clone(),
        Some(cwd.clone()),
        args,
        None,
    )
    .await
    {
        state
            .pending_created_sessions
            .write()
            .await
            .remove(&transport_id);
        error!(transport_session_id = %transport_id, %error, "failed to start RPC child");
        return vec![ServerMessage::Error {
            request_id: None,
            message: format!("failed to start RPC child: {error}"),
        }];
    }

    save_default_cwd(state, &cwd).await;

    // Persist the name in the OMP session file immediately after spawn. The visible
    // session appears only after OMP reports its real session id via get_state.
    if let Some(ref n) = name {
        let cmd = serde_json::json!({
            "id": next_rpc_id(),
            "type": "set_session_name",
            "name": n,
        });
        if let Err(e) = send_rpc_command(state, &transport_id, cmd).await {
            warn!(transport_session_id = %transport_id, error = %e, "failed to queue initial set_session_name");
        }
    }

    Vec::new()
}

async fn open_session(state: &AppState, session_file: String) -> Vec<ServerMessage> {
    info!(action = "session.open", session_file = %session_file);
    let session_path = PathBuf::from(&session_file);
    let Some(discovered) = read_session_header(&session_path) else {
        return vec![ServerMessage::Error {
            request_id: None,
            message: format!("could not read OMP session header: {session_file}"),
        }];
    };

    let session_id = discovered.id.clone();
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        let rpc_sessions = state.rpc_sessions.read().await;
        if rpc_sessions.contains_key(&transport_session_id) {
            let sessions = state.sessions.read().await;
            return match sessions.get(&session_id) {
                Some(record) => vec![ServerMessage::SessionSnapshot {
                    session_id,
                    state: record.projection(),
                }],
                None => vec![ServerMessage::Error {
                    request_id: None,
                    message: format!(
                        "session {session_id} is marked live but has no catalog entry"
                    ),
                }],
            };
        }
    }

    let record = SessionRecord {
        id: session_id.clone(),
        cwd: discovered.cwd.clone(),
        args: Vec::new(),
        status: SessionStatus::Starting,
        created_at: discovered.created_at,
        updated_at: discovered.updated_at,
        messages: Vec::new(),
        live_message_ids: HashSet::new(),
        streaming_message: None,
        tool_cards: Vec::new(),
        active_tool_calls: Vec::new(),
        session_file: Some(session_file.clone()),
        title: discovered.title.clone(),
        timestamp: discovered.timestamp.clone(),
        kind: SessionKind::Managed,
        model: None,
        thinking_level: None,
        tokens_total: 0,
        cost_usd: 0.0,
        context_tokens: None,
        context_window: None,
        context_percent: None,
        plan_mode: None,
    };
    let projection = record.projection();
    let sessions_snapshot = {
        let mut sessions = state.sessions.write().await;
        sessions.insert(session_id.clone(), record);
        sessions_snapshot_from_map(&sessions)
    };

    let transport_session_id = {
        let rpc_sessions = state.rpc_sessions.read().await;
        if rpc_sessions.contains_key(&session_id) {
            Uuid::new_v4().to_string()
        } else {
            session_id.clone()
        }
    };

    let spawn_result = spawn_rpc_child(
        state.clone(),
        transport_session_id.clone(),
        discovered.cwd,
        Vec::new(),
        Some(session_file.clone()),
    )
    .await;

    if spawn_result.is_ok() {
        state
            .rpc_session_targets
            .write()
            .await
            .insert(transport_session_id, session_id.clone());
    }

    if let Err(error) = spawn_result {
        error!(session_id = %session_id, %error, "failed to open RPC session");
        let mut sessions = state.sessions.write().await;
        if let Some(record) = sessions.get_mut(&session_id) {
            record.status = SessionStatus::Error;
        }
        return vec![
            sessions_snapshot_from_map(&sessions),
            ServerMessage::Error {
                request_id: None,
                message: format!("failed to open session {session_file}: {error}"),
            },
        ];
    }

    vec![
        sessions_snapshot,
        ServerMessage::SessionSnapshot {
            session_id,
            state: projection,
        },
    ]
}

async fn stop_session(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    info!(action = "session.stop", session_id = %session_id);
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        if let Some(handle) = state
            .rpc_sessions
            .write()
            .await
            .remove(&transport_session_id)
        {
            state
                .rpc_session_targets
                .write()
                .await
                .remove(&transport_session_id);
            let _ = handle.stop.send(());
        }
    }

    let mut sessions = state.sessions.write().await;
    match sessions.get_mut(&session_id) {
        Some(record) => {
            record.status = SessionStatus::Exited;
            vec![
                ServerMessage::SessionSnapshot {
                    session_id: session_id.clone(),
                    state: record.projection(),
                },
                ServerMessage::SessionExited {
                    session_id,
                    code: None,
                    signal: Some("stopped".to_string()),
                },
                sessions_snapshot_from_map(&sessions),
            ]
        }
        None => vec![unknown_session_error(session_id)],
    }
}

async fn delete_session(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    info!(action = "session.delete", session_id = %session_id);

    // Stop managed child if running.
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        if let Some(handle) = state
            .rpc_sessions
            .write()
            .await
            .remove(&transport_session_id)
        {
            state
                .rpc_session_targets
                .write()
                .await
                .remove(&transport_session_id);
            let _ = handle.stop.send(());
        }
    }

    // Grab session file path before dropping from catalog.
    let session_file = {
        let sessions = state.sessions.read().await;
        sessions
            .get(&session_id)
            .and_then(|r| r.session_file.clone())
    };

    // Drop from catalog.
    state.sessions.write().await.remove(&session_id);

    // Delete session file and sibling artifacts directory.
    if let Some(ref file) = session_file {
        match fs::remove_file(file) {
            Ok(()) => info!(session_id = %session_id, file = %file, "deleted session file"),
            Err(error) => {
                warn!(session_id = %session_id, file = %file, %error, "failed to delete session file")
            }
        }
        if let Some(artifacts) = file.strip_suffix(".jsonl") {
            match fs::remove_dir_all(artifacts) {
                Ok(()) => {
                    info!(session_id = %session_id, dir = %artifacts, "deleted session artifacts")
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    warn!(session_id = %session_id, dir = %artifacts, %error, "failed to delete artifacts directory")
                }
            }
        }
    }

    broadcast_sessions_snapshot(state).await;
    vec![]
}

async fn handle_slash_command(
    state: &AppState,
    session_id: String,
    text: &str,
) -> Option<Vec<ServerMessage>> {
    let (name, args) = parse_slash_command(text)?;
    let args = args.trim();

    let responses = match name.as_str() {
        "help" | "commands" => vec![notice(
            session_id,
            NoticeLevel::Info,
            "Supported commands: /help, /new, /abort, /plan [prompt], /compact [instructions], /handoff [focus instructions], /rename <title>, /model [list|cycle|provider/model], /thinking [cycle|off|minimal|low|medium|high|inherit], /fork, /session [info], /export [path]. TUI-only commands like /resume are intentionally unsupported in Fura.",
        )],
        "new" => {
            let (cwd, args) = {
                let sessions = state.sessions.read().await;
                sessions
                    .get(&session_id)
                    .map(|record| (record.cwd.clone(), Some(record.args.clone())))
                    .unwrap_or((None, None))
            };
            create_session(state, cwd, None, args).await
        }
        "abort" => abort_prompt(state, session_id).await,
        "compact" => {
            let mut command = serde_json::json!({ "id": next_rpc_id(), "type": "compact" });
            if !args.is_empty() {
                command["customInstructions"] = Value::String(args.to_string());
            }
            send_slash_rpc_command(state, session_id, command, "Requested session compaction.")
                .await
        }
        "handoff" => {
            let mut command = serde_json::json!({ "id": next_rpc_id(), "type": "handoff" });
            if !args.is_empty() {
                command["customInstructions"] = Value::String(args.to_string());
            }
            send_slash_rpc_command(state, session_id, command, "Requested session handoff.").await
        }
        "rename" => {
            if args.is_empty() {
                vec![notice(
                    session_id,
                    NoticeLevel::Error,
                    "Usage: /rename <title>",
                )]
            } else {
                let new_title = args.to_string();
                match send_rpc_command(
                    state,
                    &session_id,
                    serde_json::json!({ "id": next_rpc_id(), "type": "set_session_name", "name": new_title }),
                )
                .await
                {
                    Err(err) => vec![notice(session_id, NoticeLevel::Error, err)],
                    Ok(()) => {
                        // OMP returns only a success ack — it does not echo the name back.
                        // Update our projection directly since we already know the new title.
                        {
                            let mut sessions = state.sessions.write().await;
                            if let Some(record) = sessions.get_mut(&session_id) {
                                record.title = Some(new_title);
                            }
                            if let Some(record) = sessions.get(&session_id) {
                                let _ = state.events.send(ServerMessage::SessionSnapshot {
                                    session_id: session_id.clone(),
                                    state: record.projection(),
                                });
                            }
                        }
                        broadcast_sessions_snapshot(state).await;
                        vec![notice(session_id, NoticeLevel::Info, "Session renamed.")]
                    }
                }
            }
        }
        "plan" => handle_plan_slash_command(state, session_id, args).await,
        "model" | "models" => handle_model_slash_command(state, session_id, args).await,
        "thinking" => handle_thinking_slash_command(state, session_id, args).await,
        "fork" => handle_fork_slash_command(state, session_id).await,
        "session" | "status" | "usage" => {
            send_slash_rpc_command(
                state,
                session_id,
                serde_json::json!({ "id": next_rpc_id(), "type": "get_session_stats" }),
                "Requested session stats.",
            )
            .await
        }
        "export" => {
            let mut command = serde_json::json!({ "id": next_rpc_id(), "type": "export_html" });
            if !args.is_empty() {
                command["outputPath"] = Value::String(args.to_string());
            }
            send_slash_rpc_command(state, session_id, command, "Requested HTML export.").await
        }
        "settings" | "fast" | "browser" | "copy" | "dump" | "share" | "hotkeys" | "tools"
        | "extensions" | "agents" | "branch" | "tree" | "login" | "logout" | "mcp" | "ssh"
        | "resume" | "btw" | "background" | "bg" | "debug" | "memory" | "move" | "exit"
        | "quit" | "marketplace" | "plugins" | "reload-plugins" | "force" => vec![notice(
            session_id,
            NoticeLevel::Warning,
            format!(
                "/{name} is a TUI-only command or needs a dedicated Fura UI before it can be safely supported."
            ),
        )],
        _ => return None,
    };

    Some(responses)
}

async fn handle_session_fork(
    state: &AppState,
    session_id: String,
    name: String,
) -> Vec<ServerMessage> {
    state
        .pending_new_session_names
        .write()
        .await
        .insert(session_id.clone(), name);
    match send_rpc_command(
        state,
        &session_id,
        serde_json::json!({ "id": next_rpc_id(), "type": "fork" }),
    )
    .await
    {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

async fn handle_session_handoff(
    state: &AppState,
    session_id: String,
    name: String,
    custom_instructions: Option<String>,
) -> Vec<ServerMessage> {
    state
        .pending_new_session_names
        .write()
        .await
        .insert(session_id.clone(), name);
    let mut command = serde_json::json!({ "id": next_rpc_id(), "type": "handoff" });
    if let Some(instructions) = custom_instructions {
        command["customInstructions"] = Value::String(instructions);
    }
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

async fn handle_plan_slash_command(
    state: &AppState,
    session_id: String,
    args: &str,
) -> Vec<ServerMessage> {
    let enabled = {
        let sessions = state.sessions.read().await;
        sessions
            .get(&session_id)
            .and_then(|record| record.plan_mode.as_ref())
            .is_some_and(|plan_mode| plan_mode.enabled)
    };

    if enabled {
        let command = serde_json::json!({
            "id": next_rpc_id(),
            "type": "set_plan_mode",
            "enabled": false,
        });
        return send_slash_rpc_command(state, session_id, command, "Requested plan mode exit.")
            .await;
    }

    let command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "set_plan_mode",
        "enabled": true,
        "planFilePath": "local://PLAN.md",
        "workflow": "parallel",
    });
    if let Err(message) = send_rpc_command(state, &session_id, command).await {
        return vec![notice(session_id, NoticeLevel::Error, message)];
    }

    if args.is_empty() {
        return vec![notice(
            session_id,
            NoticeLevel::Info,
            "Requested plan mode. Plan file: local://PLAN.md",
        )];
    }

    let prompt_command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "prompt",
        "message": args,
        "streamingBehavior": "followUp",
    });
    match send_rpc_command(state, &session_id, prompt_command).await {
        Ok(()) => vec![notice(
            session_id,
            NoticeLevel::Info,
            "Requested plan mode and sent the initial planning prompt.",
        )],
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

async fn handle_fork_slash_command(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    match send_rpc_command(
        state,
        &session_id,
        serde_json::json!({ "id": next_rpc_id(), "type": "fork" }),
    )
    .await
    {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

async fn handle_model_slash_command(
    state: &AppState,
    session_id: String,
    args: &str,
) -> Vec<ServerMessage> {
    let arg = args.trim();
    match arg {
        "" | "list" | "ls" => handle_model_list_command(state, session_id).await,
        "cycle" | "next" => {
            send_slash_rpc_command(
                state,
                session_id,
                serde_json::json!({ "id": next_rpc_id(), "type": "cycle_model" }),
                "Requested model cycle.",
            )
            .await
        }
        _ => {
            let Some((provider, model_id)) = arg.split_once('/') else {
                return vec![notice(
                    session_id,
                    NoticeLevel::Error,
                    "Usage: /model [list|cycle|provider/model]",
                )];
            };
            if provider.is_empty() || model_id.is_empty() {
                return vec![notice(
                    session_id,
                    NoticeLevel::Error,
                    "Usage: /model [list|cycle|provider/model]",
                )];
            }
            handle_model_set_command(state, session_id, provider, model_id).await
        }
    }
}

async fn handle_diff_refresh(
    state: &AppState,
    session_id: String,
    selector: Option<String>,
    head_selector: Option<String>,
    stat: bool,
) -> Vec<ServerMessage> {
    let command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "repo_diff_get",
        "selector": selector,
        "headSelector": head_selector,
        "stat": stat,
    });
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

async fn handle_diff_snapshot(
    state: &AppState,
    session_id: String,
    label: Option<String>,
) -> Vec<ServerMessage> {
    let command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "repo_diff_snapshot",
        "label": label,
    });
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

async fn handle_model_list_command(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    match send_rpc_command(
        state,
        &session_id,
        serde_json::json!({ "id": next_rpc_id(), "type": "get_available_models" }),
    )
    .await
    {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

async fn handle_model_set_command(
    state: &AppState,
    session_id: String,
    provider: &str,
    model_id: &str,
) -> Vec<ServerMessage> {
    match send_rpc_command(
        state,
        &session_id,
        serde_json::json!({
            "id": next_rpc_id(),
            "type": "set_model",
            "provider": provider,
            "modelId": model_id,
        }),
    )
    .await
    {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

async fn handle_thinking_slash_command(
    state: &AppState,
    session_id: String,
    args: &str,
) -> Vec<ServerMessage> {
    let arg = args.trim().to_lowercase();
    if arg.is_empty() || arg == "cycle" || arg == "next" {
        return send_slash_rpc_command(
            state,
            session_id,
            serde_json::json!({ "id": next_rpc_id(), "type": "cycle_thinking_level" }),
            "Requested thinking level cycle.",
        )
        .await;
    }

    let level = match arg.as_str() {
        "off" | "minimal" | "low" | "medium" | "high" | "inherit" => arg,
        _ => {
            return vec![notice(
                session_id,
                NoticeLevel::Error,
                "Usage: /thinking [cycle|off|minimal|low|medium|high|inherit]",
            )];
        }
    };

    send_slash_rpc_command(
        state,
        session_id,
        serde_json::json!({ "id": next_rpc_id(), "type": "set_thinking_level", "level": level }),
        "Requested thinking level change.",
    )
    .await
}

async fn send_slash_rpc_command(
    state: &AppState,
    session_id: String,
    command: Value,
    ok_text: &'static str,
) -> Vec<ServerMessage> {
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => vec![notice(session_id, NoticeLevel::Info, ok_text)],
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

fn parse_slash_command(text: &str) -> Option<(String, String)> {
    let body = text.strip_prefix('/')?.trim();
    if body.is_empty() {
        return None;
    }

    let first_whitespace = body.find(char::is_whitespace);
    let first_colon = body.find(':');
    let first_separator = match (first_whitespace, first_colon) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(index), None) | (None, Some(index)) => Some(index),
        (None, None) => None,
    };

    match first_separator {
        Some(index) => Some((
            body[..index].to_lowercase(),
            body[index + 1..].trim().to_string(),
        )),
        None => Some((body.to_lowercase(), String::new())),
    }
}

fn notice(
    session_id: impl Into<String>,
    level: NoticeLevel,
    text: impl Into<String>,
) -> ServerMessage {
    ServerMessage::SessionNotice {
        session_id: session_id.into(),
        level,
        text: text.into(),
    }
}

async fn send_prompt(
    state: &AppState,
    session_id: String,
    text: String,
    images: Option<Vec<Value>>,
    behavior: Option<PromptBehavior>,
) -> Vec<ServerMessage> {
    info!(action = "prompt.send", session_id = %session_id, bytes = text.len(), has_images = images.as_ref().is_some_and(|images| !images.is_empty()), behavior = ?behavior.map(PromptBehavior::as_rpc_streaming_behavior));

    let has_images = images.as_ref().is_some_and(|images| !images.is_empty());
    if behavior.is_none() && !has_images {
        if let Some(responses) = handle_slash_command(state, session_id.clone(), text.trim()).await
        {
            return responses;
        }
    }

    let snapshot = {
        let mut sessions = state.sessions.write().await;
        match sessions.get_mut(&session_id) {
            Some(record) => {
                record.status = SessionStatus::Busy;
                Some(ServerMessage::SessionSnapshot {
                    session_id: session_id.clone(),
                    state: record.projection(),
                })
            }
            None => None,
        }
    };

    let Some(snapshot) = snapshot else {
        return vec![unknown_session_error(session_id)];
    };

    let mut command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "prompt",
        "message": text,
    });
    if let Some(images) = images.filter(|images| !images.is_empty()) {
        command["images"] = Value::Array(images);
    }
    if let Some(behavior) = behavior {
        command["streamingBehavior"] =
            Value::String(behavior.as_rpc_streaming_behavior().to_string());
    }

    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => vec![snapshot],
        Err(message) => vec![
            snapshot,
            ServerMessage::Error {
                request_id: None,
                message,
            },
        ],
    }
}

async fn abort_prompt(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    info!(action = "prompt.abort", session_id = %session_id);
    let command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "abort",
    });
    let send_result = send_rpc_command(state, &session_id, command).await;

    let mut sessions = state.sessions.write().await;
    match sessions.get_mut(&session_id) {
        Some(record) => {
            record.status = SessionStatus::Idle;
            let mut responses = vec![ServerMessage::SessionSnapshot {
                session_id,
                state: record.projection(),
            }];
            if let Err(message) = send_result {
                responses.push(ServerMessage::Error {
                    request_id: None,
                    message,
                });
            }
            responses
        }
        None => vec![unknown_session_error(session_id)],
    }
}

async fn refresh_rpc_state(state: &AppState, session_id: &str) -> Result<(), String> {
    send_rpc_command(
        state,
        session_id,
        serde_json::json!({ "id": next_rpc_id(), "type": "get_state" }),
    )
    .await?;
    send_rpc_command(
        state,
        session_id,
        serde_json::json!({ "id": next_rpc_id(), "type": "get_messages" }),
    )
    .await?;
    send_rpc_command(
        state,
        session_id,
        serde_json::json!({ "id": next_rpc_id(), "type": "get_session_stats" }),
    )
    .await
}

async fn rpc_session_target_id(state: &AppState, transport_session_id: &str) -> String {
    state
        .rpc_session_targets
        .read()
        .await
        .get(transport_session_id)
        .cloned()
        .unwrap_or_else(|| transport_session_id.to_string())
}

async fn rpc_transport_session_id(state: &AppState, session_id: &str) -> Option<String> {
    let targets = state.rpc_session_targets.read().await;
    if let Some((transport_id, _)) = targets
        .iter()
        .find(|(_, target_id)| target_id == &session_id)
    {
        return Some(transport_id.clone());
    }

    if !targets.contains_key(session_id) {
        return Some(session_id.to_string());
    }

    None
}

async fn send_rpc_command(
    state: &AppState,
    session_id: &str,
    command: Value,
) -> Result<(), String> {
    let transport_session_id = rpc_transport_session_id(state, session_id)
        .await
        .ok_or_else(|| format!("session {session_id} has no live RPC child"))?;
    let stdin = {
        let rpc_sessions = state.rpc_sessions.read().await;
        rpc_sessions
            .get(&transport_session_id)
            .map(|handle| handle.stdin.clone())
            .ok_or_else(|| format!("session {session_id} has no live RPC child"))?
    };

    info!(
        direction = "bridge_to_rpc",
        session_id = %session_id,
        transport_session_id = %transport_session_id,
        command_type = command_type(&command),
        command_id = command.get("id").and_then(|value| value.as_str()).unwrap_or("missing")
    );

    stdin
        .send(command)
        .await
        .map_err(|_| format!("session {session_id} RPC stdin is closed"))
}

async fn spawn_rpc_child(
    state: AppState,
    session_id: String,
    cwd: Option<String>,
    session_args: Vec<String>,
    resume_session_file: Option<String>,
) -> anyhow::Result<()> {
    let mut args = state.rpc_config.args.clone();
    args.extend(session_args);
    if let Some(session_file) = resume_session_file {
        args.extend(["--resume".to_string(), session_file]);
    }

    info!(
        action = "rpc.spawn",
        session_id = %session_id,
        program = %state.rpc_config.program,
        arg_count = args.len(),
        has_cwd = cwd.is_some()
    );

    let mut command = Command::new(&state.rpc_config.program);
    command.args(&args);
    if let Some(cwd) = cwd.as_deref() {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to spawn {}", state.rpc_config.program))?;

    let stdin = child
        .stdin
        .take()
        .context("RPC child stdin is unavailable")?;
    let stdout = child
        .stdout
        .take()
        .context("RPC child stdout is unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("RPC child stderr is unavailable")?;

    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Value>(128);
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    state.rpc_sessions.write().await.insert(
        session_id.clone(),
        RpcSessionHandle {
            stdin: stdin_tx,
            stop: stop_tx,
        },
    );
    state
        .rpc_session_targets
        .write()
        .await
        .insert(session_id.clone(), session_id.clone());

    let write_session_id = session_id.clone();
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(command) = stdin_rx.recv().await {
            let command_id = command
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("missing")
                .to_string();
            match serde_json::to_string(&command) {
                Ok(line) => {
                    if stdin.write_all(line.as_bytes()).await.is_err()
                        || stdin.write_all(b"\n").await.is_err()
                        || stdin.flush().await.is_err()
                    {
                        warn!(session_id = %write_session_id, command_id, "failed to write RPC command");
                        break;
                    }
                }
                Err(error) => {
                    warn!(session_id = %write_session_id, %error, "failed to serialize RPC command")
                }
            }
        }
    });

    tokio::spawn(read_rpc_stdout(
        state.clone(),
        session_id.clone(),
        BufReader::new(stdout),
    ));
    tokio::spawn(read_rpc_stderr(
        state.clone(),
        session_id.clone(),
        BufReader::new(stderr),
    ));
    tokio::spawn(async move {
        let mut stop_rx = stop_rx;
        let status = tokio::select! {
            _ = &mut stop_rx => {
                info!(action = "rpc.kill", session_id = %session_id);
                let _ = child.kill().await;
                child.wait().await
            }
            status = child.wait() => status,
        };

        state.rpc_sessions.write().await.remove(&session_id);
        let target_session_id = state
            .rpc_session_targets
            .write()
            .await
            .remove(&session_id)
            .unwrap_or_else(|| session_id.clone());
        let pending_create = state
            .pending_created_sessions
            .write()
            .await
            .remove(&session_id);
        match status {
            Ok(status) => {
                let code = status.code();
                info!(action = "rpc.exit", session_id = %session_id, target_session_id = %target_session_id, code = ?code);
                if pending_create.is_some() {
                    let _ = state.events.send(ServerMessage::Error {
                        request_id: None,
                        message: format!(
                            "RPC child exited before reporting a session id (code {}).",
                            code.map(|value| value.to_string())
                                .unwrap_or_else(|| "unknown".to_string())
                        ),
                    });
                } else {
                    mark_status_and_broadcast(&state, &target_session_id, SessionStatus::Exited)
                        .await;
                    let _ = state.events.send(ServerMessage::SessionExited {
                        session_id: target_session_id,
                        code,
                        signal: None,
                    });
                }
            }
            Err(error) => {
                warn!(action = "rpc.exit_error", session_id = %session_id, target_session_id = %target_session_id, %error);
                if pending_create.is_some() {
                    let _ = state.events.send(ServerMessage::Error {
                        request_id: None,
                        message: format!("RPC child failed before reporting a session id: {error}"),
                    });
                } else {
                    mark_status_and_broadcast(&state, &target_session_id, SessionStatus::Error)
                        .await;
                }
            }
        }
    });

    Ok(())
}

async fn read_rpc_stdout<R>(state: AppState, session_id: String, reader: BufReader<R>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        append_bridge_debug_rpc_line(&state, &session_id, &line).await;
        if state.log_frames {
            info!(direction = "rpc_to_bridge", session_id = %session_id, frame = %line, "rpc frame");
        }

        match serde_json::from_str::<Value>(&line) {
            Ok(frame) => {
                log_rpc_frame(&session_id, &frame);
                apply_rpc_frame(&state, &session_id, &frame).await;
                if state.forward_raw_frames {
                    let raw_session_id = rpc_session_target_id(&state, &session_id).await;
                    let _ = state.events.send(ServerMessage::RawOmp {
                        session_id: raw_session_id,
                        frame,
                    });
                }
            }
            Err(error) => {
                warn!(session_id = %session_id, %error, bytes = line.len(), "invalid RPC JSONL frame")
            }
        }
    }
    info!(session_id = %session_id, "RPC stdout closed");
}

async fn read_rpc_stderr<R>(state: AppState, session_id: String, reader: BufReader<R>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        warn!(session_id = %session_id, bytes = line.len(), "RPC stderr line");
        let target_session_id = rpc_session_target_id(&state, &session_id).await;
        let _ = state.events.send(ServerMessage::LogStderr {
            session_id: target_session_id,
            text: line,
        });
    }
}

async fn apply_rpc_frame(state: &AppState, session_id: &str, frame: &Value) {
    let frame_type = value_str(frame, "type").unwrap_or("unknown");
    let target_session_id = rpc_session_target_id(state, session_id).await;
    match frame_type {
        "ready" => {
            mark_status_and_broadcast(state, &target_session_id, SessionStatus::Idle).await;
            if let Err(message) = refresh_rpc_state(state, session_id).await {
                warn!(session_id = %session_id, %message, "initial RPC refresh failed");
            }
        }
        "agent_start" => {
            mark_status_and_broadcast(state, &target_session_id, SessionStatus::Busy).await
        }
        "agent_end" => {
            mark_status_and_broadcast(state, &target_session_id, SessionStatus::Idle).await;
            if let Err(message) = send_rpc_command(
                state,
                session_id,
                serde_json::json!({ "id": next_rpc_id(), "type": "get_messages" }),
            )
            .await
            {
                warn!(session_id = %session_id, %message, "post-agent transcript refresh failed");
            }
            if let Err(message) = send_rpc_command(
                state,
                session_id,
                serde_json::json!({ "id": next_rpc_id(), "type": "get_session_stats" }),
            )
            .await
            {
                warn!(session_id = %session_id, %message, "post-agent stats refresh failed");
            }
        }
        "message_update" => {
            if let Some(mut message) = frame.get("message").and_then(map_omp_message) {
                message.is_new = true;
                // Use a stable sentinel ID so the frontend always keyed to the same node
                // while streaming; the real ID arrives with message_end.
                if message.id.is_empty() {
                    message.id = "__streaming__".to_string();
                }
                let snapshot = {
                    let mut sessions = state.sessions.write().await;
                    sessions.get_mut(&target_session_id).map(|record| {
                        record.streaming_message = Some(message);
                        ServerMessage::SessionSnapshot {
                            session_id: target_session_id.clone(),
                            state: record.projection(),
                        }
                    })
                };
                if let Some(msg) = snapshot {
                    let _ = state.events.send(msg);
                }
            }
        }
        "message_end" => {
            if let Some(mut message) = frame.get("message").and_then(map_omp_message) {
                message.is_new = true;
                // Clear streaming_message and push the final message atomically in a single
                // lock so no snapshot can fire showing a gap between the two.
                let snapshot = {
                    let mut sessions = state.sessions.write().await;
                    sessions.get_mut(&target_session_id).map(|record| {
                        record.streaming_message = None;
                        record.live_message_ids.insert(message.id.clone());
                        record.messages.push(message);
                        record.updated_at = now_epoch_seconds();
                        ServerMessage::SessionSnapshot {
                            session_id: target_session_id.clone(),
                            state: record.projection(),
                        }
                    })
                };
                if let Some(snapshot) = snapshot {
                    let _ = state.events.send(snapshot);
                    broadcast_sessions_snapshot(state).await;
                }
            }
        }
        "tool_execution_start" => {
            let tool_call_id = value_str(frame, "toolCallId").unwrap_or("").to_string();
            let tool_name = value_str(frame, "toolName").unwrap_or("").to_string();
            let intent = value_str(frame, "intent").map(str::to_string);
            let args = frame.get("args").cloned().unwrap_or(Value::Null);
            let snapshot = {
                let mut sessions = state.sessions.write().await;
                sessions.get_mut(&target_session_id).map(|record| {
                    let insert_after_count = record.messages.len();
                    record.active_tool_calls.push(ToolCard {
                        tool_call_id,
                        tool_name,
                        intent,
                        args,
                        is_active: true,
                        is_error: false,
                        partial_result: None,
                        result: None,
                        insert_after_count,
                    });
                    ServerMessage::SessionSnapshot {
                        session_id: target_session_id.clone(),
                        state: record.projection(),
                    }
                })
            };
            if let Some(snapshot) = snapshot {
                let _ = state.events.send(snapshot);
            }
        }
        "tool_execution_update" => {
            let tool_call_id = value_str(frame, "toolCallId").unwrap_or("");
            let partial_result = frame.get("partialResult").cloned();
            let async_state = partial_result.as_ref().and_then(tool_async_state);
            let is_final_async = matches!(async_state, Some("completed" | "failed"));
            let is_async_error = matches!(async_state, Some("failed"));
            let snapshot = {
                let mut sessions = state.sessions.write().await;
                sessions.get_mut(&target_session_id).and_then(|record| {
                    let pos = record
                        .active_tool_calls
                        .iter()
                        .position(|c| c.tool_call_id == tool_call_id)?;
                    if is_final_async {
                        let mut card = record.active_tool_calls.remove(pos);
                        card.is_active = false;
                        card.is_error = is_async_error;
                        card.result = partial_result;
                        card.partial_result = None;
                        record.tool_cards.push(card);
                    } else {
                        record.active_tool_calls[pos].partial_result = partial_result;
                    }
                    Some(ServerMessage::SessionSnapshot {
                        session_id: target_session_id.clone(),
                        state: record.projection(),
                    })
                })
            };
            if let Some(snapshot) = snapshot {
                let _ = state.events.send(snapshot);
            }
        }
        "tool_execution_end" => {
            let tool_call_id = value_str(frame, "toolCallId").unwrap_or("");
            let tool_name = value_str(frame, "toolName").unwrap_or("");
            let is_error = frame
                .get("isError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result = frame.get("result").cloned();
            let is_background_running =
                matches!(result.as_ref().and_then(tool_async_state), Some("running"));
            let snapshot = {
                let mut sessions = state.sessions.write().await;
                sessions.get_mut(&target_session_id).map(|record| {
                    if let Some(pos) = record
                        .active_tool_calls
                        .iter()
                        .position(|c| c.tool_call_id == tool_call_id)
                    {
                        if is_background_running {
                            let card = &mut record.active_tool_calls[pos];
                            card.is_active = true;
                            card.is_error = false;
                            card.result = result.clone();
                            card.partial_result = None;
                        } else {
                            let mut card = record.active_tool_calls.remove(pos);
                            card.is_active = false;
                            card.is_error = is_error;
                            card.result = result.clone();
                            card.partial_result = None;
                            record.tool_cards.push(card);
                        }
                    }
                    ServerMessage::SessionSnapshot {
                        session_id: target_session_id.clone(),
                        state: record.projection(),
                    }
                })
            };
            if let Some(snapshot) = snapshot {
                let _ = state.events.send(snapshot);
            }
            if tool_name == "exit_plan_mode" && !is_error {
                if let Some(details) = result.as_ref().and_then(|value| value.get("details")) {
                    let mut command = serde_json::json!({
                        "id": next_rpc_id(),
                        "type": "get_plan_mode_preview",
                    });
                    if let Some(plan_file_path) = value_str(details, "planFilePath") {
                        command["planFilePath"] = Value::String(plan_file_path.to_string());
                    }
                    if let Some(final_plan_file_path) = value_str(details, "finalPlanFilePath") {
                        command["finalPlanFilePath"] =
                            Value::String(final_plan_file_path.to_string());
                    }
                    if let Some(title) = value_str(details, "title") {
                        command["title"] = Value::String(title.to_string());
                    }
                    if let Err(message) = send_rpc_command(state, session_id, command).await {
                        let _ = state.events.send(notice(
                            target_session_id.clone(),
                            NoticeLevel::Error,
                            message,
                        ));
                    }
                }
            }
        }
        _ => apply_rpc_response(state, session_id, frame).await,
    }
}

fn map_plan_mode_projection(value: &Value) -> Option<PlanModeProjection> {
    if value.is_null() {
        return None;
    }
    if value.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    Some(PlanModeProjection {
        enabled: true,
        plan_file_path: value_str(value, "planFilePath")
            .unwrap_or("local://PLAN.md")
            .to_string(),
        workflow: value_str(value, "workflow").map(str::to_string),
    })
}

fn apply_rpc_state_to_record(
    record: &mut SessionRecord,
    session_name: Option<String>,
    model: Option<String>,
    thinking_level: Option<String>,
    session_file: Option<String>,
    context_tokens: Option<u64>,
    context_window: Option<u64>,
    context_percent: Option<f64>,
    plan_mode: Option<Option<PlanModeProjection>>,
) {
    record.status = SessionStatus::Idle;
    if let Some(name) = session_name {
        if record.title.is_none() || record.title.as_deref() != Some(&name) {
            record.title = Some(name);
        }
    }
    if let Some(model) = model {
        record.model = Some(model);
    }
    if let Some(thinking_level) = thinking_level {
        record.thinking_level = Some(thinking_level);
    }
    if let Some(session_file) = session_file {
        record.session_file = Some(session_file);
    }
    record.context_tokens = context_tokens;
    record.context_window = context_window;
    record.context_percent = context_percent;
    if let Some(plan_mode) = plan_mode {
        record.plan_mode = plan_mode;
    }
}

async fn apply_model_change_response(
    state: &AppState,
    session_id: &str,
    model_value: Option<&Value>,
    thinking_level: Option<String>,
) {
    let Some(model_value) = model_value else {
        return;
    };
    let Some(model) = model_summary(model_value) else {
        return;
    };
    let display_name = model_display_name(model_value)
        .unwrap_or_else(|| format!("{}/{}", model.provider, model.id));

    let snapshot = {
        let mut sessions = state.sessions.write().await;
        sessions.get_mut(session_id).map(|record| {
            record.model = Some(display_name);
            if let Some(thinking_level) = thinking_level {
                record.thinking_level = Some(thinking_level);
            }
            ServerMessage::SessionSnapshot {
                session_id: session_id.to_string(),
                state: record.projection(),
            }
        })
    };

    if let Some(snapshot) = snapshot {
        let _ = state.events.send(snapshot);
    }
    let _ = state.events.send(ServerMessage::ModelChanged {
        session_id: session_id.to_string(),
        model,
    });
}

async fn apply_rpc_response(state: &AppState, session_id: &str, frame: &Value) {
    let command = value_str(frame, "command").or_else(|| value_str(frame, "requestType"));
    let status = value_str(frame, "status");
    let success = frame.get("success").and_then(|value| value.as_bool());
    let current_session_id = rpc_session_target_id(state, session_id).await;
    if status == Some("error") || success == Some(false) {
        let message = rpc_error_message(frame);
        warn!(session_id = %session_id, command = command.unwrap_or("unknown"), %message, "RPC command returned error");
        if rpc_prompt_error_settles_turn(command, &message) {
            settle_prompt_error_and_broadcast(state, &current_session_id).await;
        }
        let _ = state
            .events
            .send(notice(current_session_id, NoticeLevel::Error, message));
        return;
    }

    match command {
        Some("repo_diff_get") | Some("repo_diff_snapshot") => {
            let state_value = frame
                .get("data")
                .or_else(|| frame.get("result"))
                .cloned()
                .unwrap_or(Value::Null);
            let _ = state.events.send(ServerMessage::DiffState {
                session_id: current_session_id.clone(),
                state: state_value,
            });
        }
        Some("get_available_models") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let models = data
                .and_then(|data| data.get("models"))
                .and_then(|models| models.as_array())
                .map(|models| models.iter().filter_map(model_summary).collect())
                .unwrap_or_default();
            let _ = state.events.send(ServerMessage::ModelList {
                session_id: current_session_id.clone(),
                models,
            });
        }
        Some("get_plan_mode_preview") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let Some(content) = data
                .and_then(|data| data.get("content"))
                .and_then(|value| value.as_str())
            else {
                return;
            };
            let plan_file_path = data
                .and_then(|data| data.get("planFilePath"))
                .and_then(|value| value.as_str())
                .unwrap_or("local://PLAN.md")
                .to_string();
            let final_plan_file_path = data
                .and_then(|data| data.get("finalPlanFilePath"))
                .and_then(|value| value.as_str())
                .unwrap_or(&plan_file_path)
                .to_string();
            let title = data
                .and_then(|data| data.get("title"))
                .and_then(|value| value.as_str())
                .map(str::to_string);
            let _ = state.events.send(ServerMessage::PlanReview {
                session_id: current_session_id.clone(),
                plan_file_path,
                final_plan_file_path,
                title,
                content: content.to_string(),
            });
        }
        Some("approve_plan_mode") => {
            if let Err(message) = refresh_rpc_state(state, session_id).await {
                warn!(session_id = %session_id, %message, "post-plan-approval refresh failed");
            }
        }
        Some("set_plan_mode") => {
            let plan_mode = frame
                .get("data")
                .or_else(|| frame.get("result"))
                .and_then(|data| data.get("planMode"))
                .map(map_plan_mode_projection)
                .unwrap_or(None);
            let snapshot = {
                let mut sessions = state.sessions.write().await;
                sessions.get_mut(&current_session_id).map(|record| {
                    record.plan_mode = plan_mode;
                    ServerMessage::SessionSnapshot {
                        session_id: current_session_id.clone(),
                        state: record.projection(),
                    }
                })
            };
            if let Some(snapshot) = snapshot {
                let _ = state.events.send(snapshot);
            }
        }
        Some("set_model") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            apply_model_change_response(state, &current_session_id, data, None).await;
        }
        Some("cycle_model") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let thinking_level = data
                .and_then(|data| data.get("thinkingLevel"))
                .and_then(|value| value.as_str())
                .map(str::to_string);
            let model_value = data.and_then(|data| data.get("model"));
            apply_model_change_response(state, &current_session_id, model_value, thinking_level)
                .await;
        }
        Some("get_messages") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let projection = data
                .and_then(|data| data.get("messages"))
                .and_then(|messages| messages.as_array())
                .map(|messages| project_omp_transcript(messages));
            if let Some((messages, tool_cards)) = projection {
                replace_messages_and_broadcast(
                    state,
                    &current_session_id,
                    messages,
                    tool_cards,
                    None,
                )
                .await;
            }
        }
        Some("get_state") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let rpc_session_id = data
                .and_then(|d| d.get("sessionId"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let target_session_id = rpc_session_id.unwrap_or_else(|| current_session_id.clone());
            let session_name = data
                .and_then(|d| d.get("sessionName"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let model = data
                .and_then(|d| d.get("model"))
                .and_then(model_display_name);
            let thinking_level = data
                .and_then(|d| d.get("thinkingLevel"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let session_file = data
                .and_then(|d| d.get("sessionFile"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let context_usage = data.and_then(|d| d.get("contextUsage"));
            // tokens/percent can be JSON null when unknown (e.g. right after compaction).
            let context_tokens = context_usage
                .and_then(|cu| cu.get("tokens"))
                .and_then(|v| v.as_u64());
            let context_window = context_usage
                .and_then(|cu| cu.get("contextWindow"))
                .and_then(|v| v.as_u64());
            let context_percent = context_usage
                .and_then(|cu| cu.get("percent"))
                .and_then(|v| v.as_f64());
            let plan_mode = data
                .and_then(|d| d.get("planMode"))
                .map(map_plan_mode_projection);
            let target_changed = target_session_id != current_session_id;
            let pending_create = if target_changed {
                state
                    .pending_created_sessions
                    .write()
                    .await
                    .remove(&current_session_id)
            } else {
                None
            };

            let (previous_snapshot, target_snapshot) = {
                let mut sessions = state.sessions.write().await;

                if target_changed {
                    let source = sessions.get(&current_session_id).cloned();
                    let previous_snapshot = sessions.get_mut(&current_session_id).map(|record| {
                        record.status = SessionStatus::Available;
                        record.kind = SessionKind::Available;
                        record.streaming_message = None;
                        record.live_message_ids.clear();
                        ServerMessage::SessionSnapshot {
                            session_id: current_session_id.clone(),
                            state: record.projection(),
                        }
                    });

                    sessions
                        .entry(target_session_id.clone())
                        .and_modify(|record| {
                            record.status = SessionStatus::Idle;
                            record.kind = SessionKind::Managed;
                            record.streaming_message = None;
                            record.live_message_ids.clear();
                        })
                        .or_insert_with(|| {
                            let now = now_epoch_seconds();
                            let created_at = source
                                .as_ref()
                                .map(|record| record.created_at)
                                .or_else(|| {
                                    pending_create.as_ref().map(|pending| pending.created_at)
                                })
                                .unwrap_or(now);
                            SessionRecord {
                                id: target_session_id.clone(),
                                cwd: source
                                    .as_ref()
                                    .and_then(|record| record.cwd.clone())
                                    .or_else(|| {
                                        pending_create
                                            .as_ref()
                                            .and_then(|pending| pending.cwd.clone())
                                    }),
                                args: source
                                    .as_ref()
                                    .map(|record| record.args.clone())
                                    .or_else(|| {
                                        pending_create.as_ref().map(|pending| pending.args.clone())
                                    })
                                    .unwrap_or_default(),
                                status: SessionStatus::Idle,
                                created_at,
                                updated_at: now,
                                messages: Vec::new(),
                                live_message_ids: HashSet::new(),
                                streaming_message: None,
                                tool_cards: Vec::new(),
                                active_tool_calls: Vec::new(),
                                kind: SessionKind::Managed,
                                session_file: None,
                                title: pending_create
                                    .as_ref()
                                    .and_then(|pending| pending.title.clone()),
                                timestamp: None,
                                model: None,
                                thinking_level: None,
                                tokens_total: 0,
                                cost_usd: 0.0,
                                context_tokens: None,
                                context_window: None,
                                context_percent: None,
                                plan_mode: None,
                            }
                        });

                    if let Some(record) = sessions.get_mut(&target_session_id) {
                        record.updated_at = now_epoch_seconds();
                        apply_rpc_state_to_record(
                            record,
                            session_name,
                            model,
                            thinking_level,
                            session_file,
                            context_tokens,
                            context_window,
                            context_percent,
                            plan_mode.clone(),
                        );
                    }

                    let target_snapshot = sessions.get(&target_session_id).map(|record| {
                        ServerMessage::SessionSnapshot {
                            session_id: target_session_id.clone(),
                            state: record.projection(),
                        }
                    });
                    (previous_snapshot, target_snapshot)
                } else {
                    if let Some(record) = sessions.get_mut(&target_session_id) {
                        apply_rpc_state_to_record(
                            record,
                            session_name,
                            model,
                            thinking_level,
                            session_file,
                            context_tokens,
                            context_window,
                            context_percent,
                            plan_mode,
                        );
                    }
                    let target_snapshot = sessions.get(&target_session_id).map(|record| {
                        ServerMessage::SessionSnapshot {
                            session_id: target_session_id.clone(),
                            state: record.projection(),
                        }
                    });
                    (None, target_snapshot)
                }
            };

            if target_changed {
                state
                    .rpc_session_targets
                    .write()
                    .await
                    .insert(session_id.to_string(), target_session_id);
            }

            if let Some(snapshot) = previous_snapshot {
                let _ = state.events.send(snapshot);
            }
            if let Some(snapshot) = target_snapshot {
                let _ = state.events.send(snapshot);
            }
            broadcast_sessions_snapshot(state).await;
        }
        Some("handoff") => {
            let snapshot = {
                let mut sessions = state.sessions.write().await;
                sessions.get_mut(&current_session_id).map(|record| {
                    record.status = SessionStatus::Idle;
                    record.live_message_ids.clear();
                    ServerMessage::SessionSnapshot {
                        session_id: current_session_id.clone(),
                        state: record.projection(),
                    }
                })
            };
            if let Some(snapshot) = snapshot {
                let _ = state.events.send(snapshot);
                broadcast_sessions_snapshot(state).await;
            }
            // Apply the name before refresh so set_session_name reaches OMP before get_state.
            let pending_name = state
                .pending_new_session_names
                .write()
                .await
                .remove(session_id);
            if let Some(ref name) = pending_name {
                {
                    let mut sessions = state.sessions.write().await;
                    if let Some(record) = sessions.get_mut(&current_session_id) {
                        record.title = Some(name.clone());
                    }
                }
                let cmd = serde_json::json!({
                    "id": next_rpc_id(),
                    "type": "set_session_name",
                    "name": name,
                });
                if let Err(e) = send_rpc_command(state, session_id, cmd).await {
                    warn!(session_id = %session_id, error = %e, "failed to queue set_session_name after handoff");
                }
            }
            if let Err(message) = refresh_rpc_state(state, session_id).await {
                warn!(session_id = %session_id, %message, "post-handoff state refresh failed");
            }
            let _ = state.events.send(notice(
                current_session_id,
                NoticeLevel::Info,
                "Handoff complete. New session context loaded.",
            ));
        }
        Some("fork") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let cancelled = data
                .and_then(|data| data.get("cancelled"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if cancelled {
                state
                    .pending_new_session_names
                    .write()
                    .await
                    .remove(session_id);
                let _ = state.events.send(notice(
                    current_session_id,
                    NoticeLevel::Warning,
                    "Fork cancelled or unavailable for this session.",
                ));
            } else {
                // Apply the name before refresh so set_session_name reaches OMP before get_state.
                let pending_name = state
                    .pending_new_session_names
                    .write()
                    .await
                    .remove(session_id);
                if let Some(ref name) = pending_name {
                    {
                        let mut sessions = state.sessions.write().await;
                        if let Some(record) = sessions.get_mut(&current_session_id) {
                            record.title = Some(name.clone());
                        }
                    }
                    let cmd = serde_json::json!({
                        "id": next_rpc_id(),
                        "type": "set_session_name",
                        "name": name,
                    });
                    if let Err(e) = send_rpc_command(state, session_id, cmd).await {
                        warn!(session_id = %session_id, error = %e, "failed to queue set_session_name after fork");
                    }
                }
                if let Err(message) = refresh_rpc_state(state, session_id).await {
                    warn!(session_id = %session_id, %message, "post-fork state refresh failed");
                    let _ = state.events.send(notice(
                        current_session_id,
                        NoticeLevel::Error,
                        format!("Fork completed, but state refresh failed: {message}"),
                    ));
                } else {
                    let _ = state.events.send(notice(
                        current_session_id,
                        NoticeLevel::Info,
                        "Fork complete. New session is active.",
                    ));
                }
            }
        }
        Some("get_session_stats") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let tokens_total = data
                .and_then(|d| d.get("tokens"))
                .and_then(|tokens| tokens.get("total"))
                .and_then(|v| v.as_u64());
            let cost_usd = data.and_then(|d| d.get("cost")).and_then(|v| v.as_f64());
            let snapshot = {
                let mut sessions = state.sessions.write().await;
                sessions.get_mut(&current_session_id).map(|record| {
                    if let Some(total) = tokens_total {
                        record.tokens_total = total;
                    }
                    if let Some(cost) = cost_usd {
                        record.cost_usd = cost;
                    }
                    ServerMessage::SessionSnapshot {
                        session_id: current_session_id.clone(),
                        state: record.projection(),
                    }
                })
            };
            if let Some(snapshot) = snapshot {
                let _ = state.events.send(snapshot);
            }
        }
        Some("prompt") | Some("abort") => {}
        _ => {}
    }
}

fn rpc_prompt_error_settles_turn(command: Option<&str>, message: &str) -> bool {
    matches!(
        command,
        Some("prompt" | "abort_and_prompt" | "steer" | "follow_up")
    ) && !message.contains("Agent is already processing")
}

async fn settle_prompt_error_and_broadcast(state: &AppState, session_id: &str) {
    let snapshot = {
        let mut sessions = state.sessions.write().await;
        sessions.get_mut(session_id).map(|record| {
            record.status = SessionStatus::Idle;
            record.streaming_message = None;
            ServerMessage::SessionSnapshot {
                session_id: session_id.to_string(),
                state: record.projection(),
            }
        })
    };
    if let Some(snapshot) = snapshot {
        let _ = state.events.send(snapshot);
        broadcast_sessions_snapshot(state).await;
    }
}

async fn mark_status_and_broadcast(state: &AppState, session_id: &str, status: SessionStatus) {
    let snapshot = {
        let mut sessions = state.sessions.write().await;
        sessions.get_mut(session_id).map(|record| {
            record.status = status;
            ServerMessage::SessionSnapshot {
                session_id: session_id.to_string(),
                state: record.projection(),
            }
        })
    };
    if let Some(snapshot) = snapshot {
        let _ = state.events.send(snapshot);
        broadcast_sessions_snapshot(state).await;
    }
}

fn replace_record_transcript(
    record: &mut SessionRecord,
    messages: Vec<TranscriptMessage>,
    tool_cards: Vec<ToolCard>,
) -> bool {
    if messages.len() < record.messages.len() {
        return false;
    }
    // Preserve is_new for messages that arrived live during this session.
    let reconciled = messages
        .into_iter()
        .map(|mut msg| {
            if record.live_message_ids.contains(&msg.id) {
                msg.is_new = true;
            }
            msg
        })
        .collect();
    record.messages = reconciled;
    record.tool_cards = tool_cards;
    true
}

#[cfg(test)]
fn replace_record_messages(record: &mut SessionRecord, messages: Vec<TranscriptMessage>) -> bool {
    replace_record_transcript(record, messages, Vec::new())
}

async fn replace_messages_and_broadcast(
    state: &AppState,
    session_id: &str,
    messages: Vec<TranscriptMessage>,
    tool_cards: Vec<ToolCard>,
    status: Option<SessionStatus>,
) {
    let snapshot = {
        let mut sessions = state.sessions.write().await;
        sessions.get_mut(session_id).map(|record| {
            if let Some(status) = status {
                record.status = status;
            }
            let incoming_count = messages.len();
            if !replace_record_transcript(record, messages, tool_cards) {
                warn!(
                    session_id = %session_id,
                    current_count = record.messages.len(),
                    incoming_count,
                    "ignored older get_messages projection"
                );
            }
            ServerMessage::SessionSnapshot {
                session_id: session_id.to_string(),
                state: record.projection(),
            }
        })
    };
    if let Some(snapshot) = snapshot {
        let _ = state.events.send(snapshot);
        broadcast_sessions_snapshot(state).await;
    }
}

async fn broadcast_sessions_snapshot(state: &AppState) {
    let sessions = state.sessions.read().await;
    let _ = state.events.send(sessions_snapshot_from_map(&sessions));
}

async fn send_sessions_snapshot(
    socket: &mut WebSocket,
    state: &AppState,
) -> Result<(), axum::Error> {
    refresh_session_catalog(state).await;
    let sessions = state.sessions.read().await;
    send_json(socket, &sessions_snapshot_from_map(&sessions)).await
}

#[derive(Debug)]
struct DiscoveredSession {
    id: String,
    preload_index: usize,
    cwd: Option<String>,
    title: Option<String>,
    timestamp: Option<String>,
    created_at: u64,
    updated_at: u64,
    session_file: String,
    messages: Vec<TranscriptMessage>,
    tool_cards: Vec<ToolCard>,
    messages_loaded: bool,
}

async fn refresh_session_catalog(state: &AppState) -> bool {
    let discovered = discover_sessions(&state.session_root);
    let mut discovered_ids = HashSet::new();
    let mut sessions = state.sessions.write().await;
    let before = session_summaries_from_map(&sessions);

    for mut session in discovered {
        discovered_ids.insert(session.id.clone());
        if should_preload_discovered_session_messages(&sessions, &session) {
            let path = Path::new(&session.session_file);
            let (messages, tool_cards) = read_session_file_messages(path);
            session.messages = messages;
            session.tool_cards = tool_cards;
            session.messages_loaded = true;
        }
        match sessions.get_mut(&session.id) {
            Some(record) if record.kind == SessionKind::Available => {
                let should_reload_messages = session.messages_loaded
                    && (record.updated_at != session.updated_at || record.messages.is_empty());
                record.cwd = session.cwd;
                record.created_at = session.created_at;
                record.updated_at = session.updated_at;
                record.session_file = Some(session.session_file);
                record.title = session.title;
                record.timestamp = session.timestamp;
                if should_reload_messages {
                    record.messages = session.messages.clone();
                    record.tool_cards = session.tool_cards.clone();
                }
            }
            Some(record) => {
                if record.session_file.is_none() {
                    record.session_file = Some(session.session_file);
                }
                if record.title.is_none() {
                    record.title = session.title;
                }
                if record.timestamp.is_none() {
                    record.timestamp = session.timestamp;
                }
            }
            None => {
                sessions.insert(
                    session.id.clone(),
                    SessionRecord {
                        id: session.id,
                        cwd: session.cwd,
                        args: Vec::new(),
                        status: SessionStatus::Available,
                        created_at: session.created_at,
                        updated_at: session.updated_at,
                        messages: session.messages.clone(),
                        live_message_ids: HashSet::new(),
                        streaming_message: None,
                        tool_cards: session.tool_cards.clone(),
                        active_tool_calls: Vec::new(),
                        kind: SessionKind::Available,
                        session_file: Some(session.session_file),
                        title: session.title,
                        timestamp: session.timestamp,
                        model: None,
                        thinking_level: None,
                        tokens_total: 0,
                        cost_usd: 0.0,
                        context_tokens: None,
                        context_window: None,
                        context_percent: None,
                        plan_mode: None,
                    },
                );
            }
        }
    }

    sessions.retain(|_, record| {
        record.kind != SessionKind::Available || discovered_ids.contains(&record.id)
    });

    before != session_summaries_from_map(&sessions)
}

fn discover_sessions(root: &Path) -> Vec<DiscoveredSession> {
    let mut sessions = Vec::new();
    collect_session_files(root, &mut sessions);
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    for (index, session) in sessions.iter_mut().enumerate() {
        session.preload_index = index;
    }
    sessions
}

fn should_preload_discovered_session_messages(
    existing_sessions: &HashMap<String, SessionRecord>,
    discovered: &DiscoveredSession,
) -> bool {
    if discovered.preload_index >= SESSION_CATALOG_PRELOAD_LIMIT {
        return false;
    }

    match existing_sessions.get(&discovered.id) {
        Some(record) if record.kind == SessionKind::Available => {
            record.updated_at != discovered.updated_at || record.messages.is_empty()
        }
        Some(_) => false,
        None => true,
    }
}

fn collect_session_files(path: &Path, sessions: &mut Vec<DiscoveredSession>) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_session_files(&path, sessions);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            if let Some(session) = read_session_header(&path) {
                sessions.push(session);
            }
        }
    }
}

fn read_session_header(path: &Path) -> Option<DiscoveredSession> {
    let file = fs::File::open(path).ok()?;
    let mut lines = StdBufReader::new(file).lines();
    let header_line = lines.next()?.ok()?;
    let header = serde_json::from_str::<SessionHeader>(&header_line).ok()?;
    if header.entry_type != "session" {
        return None;
    }
    let metadata = fs::metadata(path).ok();
    let updated_at = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or_else(now_epoch_seconds);
    let created_at = header
        .timestamp
        .as_deref()
        .and_then(parse_timestamp_seconds)
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
        })
        .unwrap_or_else(now_epoch_seconds);

    Some(DiscoveredSession {
        preload_index: usize::MAX,
        id: header.id,
        cwd: header.cwd,
        title: header.title,
        timestamp: header.timestamp,
        created_at,
        updated_at,
        session_file: path.to_string_lossy().to_string(),
        messages: Vec::new(),
        tool_cards: Vec::new(),
        messages_loaded: false,
    })
}

fn read_session_file_messages(path: &Path) -> (Vec<TranscriptMessage>, Vec<ToolCard>) {
    let Ok(file) = fs::File::open(path) else {
        return (Vec::new(), Vec::new());
    };
    let reader = StdBufReader::new(file);
    let mut message_values: Vec<Value> = Vec::new();
    for (i, line) in reader.lines().enumerate() {
        if i == 0 {
            continue; // skip session header
        }
        let Ok(line) = line else {
            continue;
        };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if entry.get("type").and_then(|v| v.as_str()) == Some("message") {
            if let Some(message) = entry.get("message").cloned() {
                message_values.push(message);
            }
        }
    }
    project_omp_transcript(&message_values)
}

fn parse_timestamp_seconds(timestamp: &str) -> Option<u64> {
    let date_time = timestamp.split_once('T')?.0;
    let mut parts = date_time.split('-');
    let year = parts.next()?.parse::<i32>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    days_from_civil(year, month, day).map(|days| days.saturating_mul(86_400))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<u64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days).ok()
}

fn default_session_root() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".omp")
        .join("agent")
        .join("sessions")
}

fn session_summaries_from_map(sessions: &HashMap<String, SessionRecord>) -> Vec<SessionSummary> {
    let mut summaries = sessions
        .values()
        .map(SessionRecord::summary)
        .collect::<Vec<_>>();
    summaries.sort_by(|a, b| a.kind.cmp(&b.kind).then(b.updated_at.cmp(&a.updated_at)));
    summaries
}

fn sessions_snapshot_from_map(sessions: &HashMap<String, SessionRecord>) -> ServerMessage {
    ServerMessage::SessionsSnapshot {
        sessions: session_summaries_from_map(sessions),
    }
}

async fn send_json(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), axum::Error> {
    log_server_message(message);
    match serde_json::to_string(message) {
        Ok(text) => socket.send(Message::Text(text.into())).await,
        Err(error) => {
            error!(%error, "failed to serialize websocket message");
            socket
                .send(Message::Text(
                    r#"{"type":"error","requestId":null,"message":"internal serialization error"}"#
                        .to_string()
                        .into(),
                ))
                .await
        }
    }
}

fn log_server_message(message: &ServerMessage) {
    match message {
        ServerMessage::Hello { .. } => {
            info!(direction = "bridge_to_client", message_type = "hello")
        }
        ServerMessage::ConfigUpdated { .. } => {
            info!(
                direction = "bridge_to_client",
                message_type = "config.updated"
            )
        }
        ServerMessage::SessionsSnapshot { sessions } => info!(
            direction = "bridge_to_client",
            message_type = "sessions.snapshot",
            session_count = sessions.len()
        ),
        ServerMessage::SessionSnapshot { session_id, state } => info!(
            direction = "bridge_to_client",
            message_type = "session.snapshot",
            session_id = %session_id,
            transcript_len = state.transcript.len(),
            status = ?state.summary.status
        ),
        ServerMessage::SessionExited {
            session_id,
            code,
            signal,
        } => info!(
            direction = "bridge_to_client",
            message_type = "session.exited",
            session_id = %session_id,
            code = ?code,
            signal = ?signal
        ),
        ServerMessage::LogStderr { session_id, text } => info!(
            direction = "bridge_to_client",
            message_type = "log.stderr",
            session_id = %session_id,
            bytes = text.len()
        ),
        ServerMessage::SessionNotice {
            session_id,
            level,
            text,
        } => info!(
            direction = "bridge_to_client",
            message_type = "session.notice",
            session_id = %session_id,
            level = ?level,
            bytes = text.len()
        ),
        ServerMessage::ModelList { session_id, models } => info!(
            direction = "bridge_to_client",
            message_type = "model.list",
            session_id = %session_id,
            model_count = models.len()
        ),
        ServerMessage::ModelChanged { session_id, model } => info!(
            direction = "bridge_to_client",
            message_type = "model.changed",
            session_id = %session_id,
            provider = %model.provider,
            model_id = %model.id
        ),
        ServerMessage::PlanReview {
            session_id,
            content,
            ..
        } => info!(
            direction = "bridge_to_client",
            message_type = "plan.review",
            session_id = %session_id,
            bytes = content.len()
        ),
        ServerMessage::DiffState { session_id, state } => info!(
            direction = "bridge_to_client",
            message_type = "diff.state",
            session_id = %session_id,
            snapshot_count = state
                .get("snapshots")
                .and_then(|value| value.as_array())
                .map(Vec::len)
                .unwrap_or(0),
            diff_bytes = state
                .get("diff")
                .and_then(|value| value.as_str())
                .map(str::len)
                .unwrap_or(0)
        ),
        ServerMessage::RawOmp { session_id, frame } => info!(
            direction = "bridge_to_client",
            message_type = "raw.omp",
            session_id = %session_id,
            frame_type = frame.get("type").and_then(|value| value.as_str()).unwrap_or("unknown")
        ),
        ServerMessage::Error { message, .. } => warn!(
            direction = "bridge_to_client",
            message_type = "error",
            bytes = message.len()
        ),
    }
}

fn log_rpc_frame(session_id: &str, frame: &Value) {
    info!(
        direction = "rpc_to_bridge",
        session_id = %session_id,
        frame_type = frame.get("type").and_then(|value| value.as_str()).unwrap_or("unknown"),
        command = frame.get("command").and_then(|value| value.as_str()).unwrap_or("none"),
        status = frame.get("status").and_then(|value| value.as_str()).unwrap_or("none")
    );
}

fn map_bash_execution_message(value: &Value) -> Option<TranscriptMessage> {
    let command = value.get("command").and_then(|v| v.as_str())?;
    // Commands marked excludeFromContext are internal ops (e.g. injected context reads).
    if value.get("excludeFromContext").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    let output = value.get("output").and_then(|v| v.as_str()).unwrap_or("");
    let output = output.trim();
    let exit_code = value.get("exitCode").and_then(|v| v.as_i64());
    let cancelled = value
        .get("cancelled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    const PREVIEW: usize = 5;
    let lines: Vec<&str> = if output.is_empty() {
        vec![]
    } else {
        output.lines().collect()
    };
    let shown = lines.len().min(PREVIEW);

    let mut body = format!("$ {command}");
    if shown > 0 {
        body.push('\n');
        body.push_str(&lines[..shown].join("\n"));
        if lines.len() > PREVIEW {
            body.push_str(&format!(
                "\n\u{2026} ({} more lines)",
                lines.len() - PREVIEW
            ));
        }
    }
    if cancelled {
        body.push_str("\n[cancelled]");
    } else if let Some(code) = exit_code {
        if code != 0 {
            body.push_str(&format!("\n[exit {code}]"));
        }
    }

    Some(TranscriptMessage {
        id: value
            .get("id")
            .and_then(|id| id.as_str())
            .map(ToString::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        role: MessageRole::System,
        blocks: vec![ContentBlock::Text {
            text: format!("```bash\n{body}\n```"),
        }],
        is_new: false,
    })
}

fn map_python_execution_message(value: &Value) -> Option<TranscriptMessage> {
    let code = value.get("code").and_then(|v| v.as_str())?;
    if value.get("excludeFromContext").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    let output = value.get("output").and_then(|v| v.as_str()).unwrap_or("");
    let output = output.trim();
    let exit_code = value.get("exitCode").and_then(|v| v.as_i64());
    let cancelled = value
        .get("cancelled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    const CODE_PREVIEW: usize = 3;
    const OUT_PREVIEW: usize = 5;
    let code_lines: Vec<&str> = code.lines().collect();
    let shown_code = code_lines.len().min(CODE_PREVIEW);
    let mut body = code_lines[..shown_code].join("\n");
    if code_lines.len() > CODE_PREVIEW {
        body.push_str(&format!(
            "\n\u{2026} ({} more lines)",
            code_lines.len() - CODE_PREVIEW
        ));
    }

    let mut text = format!("```python\n{body}\n```");

    let out_lines: Vec<&str> = if output.is_empty() {
        vec![]
    } else {
        output.lines().collect()
    };
    let shown_out = out_lines.len().min(OUT_PREVIEW);
    if shown_out > 0 {
        let mut out = out_lines[..shown_out].join("\n");
        if out_lines.len() > OUT_PREVIEW {
            out.push_str(&format!(
                "\n\u{2026} ({} more lines)",
                out_lines.len() - OUT_PREVIEW
            ));
        }
        text.push_str(&format!("\n```\n{out}\n```"));
    }
    if cancelled {
        text.push_str("\n[cancelled]");
    } else if let Some(code) = exit_code {
        if code != 0 {
            text.push_str(&format!("\n[exit {code}]"));
        }
    }

    Some(TranscriptMessage {
        id: value
            .get("id")
            .and_then(|id| id.as_str())
            .map(ToString::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        role: MessageRole::System,
        blocks: vec![ContentBlock::Text { text }],
        is_new: false,
    })
}

fn project_omp_transcript(values: &[Value]) -> (Vec<TranscriptMessage>, Vec<ToolCard>) {
    let mut messages = Vec::new();
    let mut tool_cards = Vec::new();
    let mut pending_tool_calls: HashMap<String, (String, Option<String>, Value, usize)> =
        HashMap::new();
    let mut visible_message_count = 0_usize;

    for value in values {
        if let Some(mut message) = map_omp_message(value) {
            message.is_new = false;
            messages.push(message);
            visible_message_count += 1;
        }

        if let Some(content) = value.get("content").and_then(|content| content.as_array()) {
            for item in content {
                if item.get("type").and_then(|value| value.as_str()) != Some("toolCall") {
                    continue;
                }
                let Some(tool_call_id) = item.get("id").and_then(|value| value.as_str()) else {
                    continue;
                };
                let tool_name = item
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string();
                let intent = item
                    .get("intent")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
                let args = item
                    .get("arguments")
                    .or_else(|| item.get("args"))
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                pending_tool_calls.insert(
                    tool_call_id.to_string(),
                    (tool_name, intent, args, visible_message_count),
                );
            }
        }

        let role = value.get("role").and_then(|role| role.as_str());
        if !matches!(role, Some("toolResult" | "tool")) {
            continue;
        }
        let Some(tool_call_id) = value.get("toolCallId").and_then(|value| value.as_str()) else {
            continue;
        };
        let pending = pending_tool_calls.remove(tool_call_id);
        let tool_name = value
            .get("toolName")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .or_else(|| {
                pending
                    .as_ref()
                    .map(|(tool_name, _, _, _)| tool_name.clone())
            })
            .unwrap_or_default();
        let (intent, args, insert_after_count) = pending
            .map(|(_, intent, args, insert_after_count)| (intent, args, insert_after_count))
            .unwrap_or_else(|| (None, serde_json::json!({}), visible_message_count));
        let mut result = serde_json::Map::new();
        if let Some(content) = value.get("content").cloned() {
            result.insert("content".to_string(), content);
        }
        if let Some(details) = value.get("details").cloned() {
            result.insert("details".to_string(), details);
        }
        if let Some(is_error) = value.get("isError").cloned() {
            result.insert("isError".to_string(), is_error);
        }
        let is_error = value
            .get("isError")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        tool_cards.push(ToolCard {
            tool_call_id: tool_call_id.to_string(),
            tool_name,
            intent,
            args,
            is_active: false,
            is_error,
            partial_result: None,
            result: Some(Value::Object(result)),
            insert_after_count,
        });
    }

    (messages, tool_cards)
}

fn map_omp_message(value: &Value) -> Option<TranscriptMessage> {
    let role_str = value
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or("assistant");

    // Role-specific dispatch before generic content extraction.
    match role_str {
        // Tool results are rendered inline with their call component in the TUI.
        // Fura has no tool execution component yet — suppress to avoid JSON blobs.
        "toolResult" | "tool" => return None,
        // Execution records: compact command summary in System role.
        "bashExecution" => return map_bash_execution_message(value),
        "pythonExecution" => return map_python_execution_message(value),
        // One-liners or deferred items in the TUI; suppress until we have rich renderers.
        "fileMention" | "compactionSummary" | "branchSummary" => return None,
        // Extension/hook messages: show only when explicitly flagged for display.
        "custom" | "hookMessage" => {
            if value.get("display").and_then(|v| v.as_bool()) != Some(true) {
                return None;
            }
            // Fall through to normal text extraction.
        }
        _ => {}
    }

    if role_str == "developer" && value.get("attribution").and_then(|v| v.as_str()) == Some("agent")
    {
        return None;
    }

    let role = parse_role(role_str);

    let blocks = if let Some(content) = value.get("content") {
        content_to_blocks(content)
    } else if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            vec![]
        } else {
            vec![ContentBlock::Text { text: trimmed }]
        }
    } else {
        // No recognizable content field — skip rather than dumping raw JSON.
        return None;
    };

    let blocks = if blocks.is_empty() {
        // If the message stopped with an error, synthesize a visible error notice block.
        if let Some(err) = value.get("errorMessage").and_then(|v| v.as_str()) {
            if !err.is_empty() {
                vec![ContentBlock::Text {
                    text: format!("Error: {err}"),
                }]
            } else {
                return None;
            }
        } else {
            return None;
        }
    } else {
        blocks
    };

    Some(TranscriptMessage {
        id: value
            .get("id")
            .and_then(|id| id.as_str())
            .map(ToString::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        role,
        blocks,
        is_new: false, // caller sets true for live message_end events
    })
}

fn parse_role(role: &str) -> MessageRole {
    match role {
        "user" | "developer" => MessageRole::User,
        "system" => MessageRole::System,
        // tool/toolResult are suppressed before reaching here, but keep for completeness.
        "tool" | "toolResult" => MessageRole::Tool,
        _ => MessageRole::Assistant,
    }
}

fn content_to_blocks(value: &Value) -> Vec<ContentBlock> {
    match value {
        Value::String(text) => {
            let text = text.trim().to_string();
            if text.is_empty() {
                Vec::new()
            } else {
                vec![ContentBlock::Text { text }]
            }
        }
        Value::Array(items) => {
            let mut blocks = Vec::new();
            for item in items {
                let item_type = item.get("type").and_then(|value| value.as_str());
                match item_type {
                    Some("thinking") => {
                        let thinking = item
                            .get("thinking")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        // signature is intentionally excluded here; it ends up in raw.omp
                        if !thinking.is_empty() {
                            blocks.push(ContentBlock::Thinking { thinking });
                        }
                    }
                    Some("redactedThinking") => {
                        blocks.push(ContentBlock::RedactedThinking);
                    }
                    Some("text") | None => {
                        let text = item
                            .get("text")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if !text.is_empty() {
                            blocks.push(ContentBlock::Text { text });
                        }
                    }
                    // toolCall blocks are separate messages/events in the RPC event stream
                    _ => {}
                }
            }
            blocks
        }
        _ => Vec::new(),
    }
}

#[allow(dead_code)]
fn content_to_text(value: &Value) -> String {
    content_to_blocks(value)
        .into_iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text),
            ContentBlock::Thinking { thinking } => Some(thinking),
            ContentBlock::RedactedThinking => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn unknown_session_error(session_id: String) -> ServerMessage {
    ServerMessage::Error {
        request_id: None,
        message: format!("unknown session: {session_id}"),
    }
}

fn rpc_error_message(frame: &Value) -> String {
    let error = frame.get("error");
    error
        .and_then(|value| {
            value
                .as_str()
                .or_else(|| value.get("message").and_then(|message| message.as_str()))
        })
        .unwrap_or("RPC command returned error")
        .to_string()
}

fn command_type(command: &Value) -> &str {
    value_str(command, "type").unwrap_or("unknown")
}

fn model_summary(value: &Value) -> Option<ModelSummary> {
    let object = value.as_object()?;
    let provider = object.get("provider")?.as_str()?.to_string();
    let id = object.get("id")?.as_str()?.to_string();
    let name = object
        .get("name")
        .and_then(|value| value.as_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let context_window = object.get("contextWindow").and_then(|value| value.as_u64());
    let thinking = object
        .get("thinking")
        .is_some_and(|value| !value.is_null() && value.as_bool() != Some(false));

    Some(ModelSummary {
        provider,
        id,
        name,
        context_window,
        thinking,
    })
}

fn model_display_name(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let object = value.as_object()?;
    for key in ["name", "id", "displayName", "displayModelId"] {
        if let Some(text) = object.get(key).and_then(|value| value.as_str()) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn value_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|value| value.as_str())
}

fn tool_async_state(result: &Value) -> Option<&str> {
    result.get("details")?.get("async")?.get("state")?.as_str()
}

fn ensure_rpc_id(command: &mut Value) {
    let Some(object) = command.as_object_mut() else {
        return;
    };
    object
        .entry("id".to_string())
        .or_insert_with(|| Value::String(next_rpc_id()));
}

async fn append_bridge_debug_rpc_line(state: &AppState, session_id: &str, line: &str) {
    let Some(path) = state.bridge_debug_file.as_ref() else {
        return;
    };

    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        if let Err(error) = async_fs::create_dir_all(parent).await {
            warn!(path = %path.display(), %error, "failed to create bridge debug file directory");
            return;
        }
    }

    let record = serde_json::json!({
        "timestampMs": now_epoch_millis(),
        "sessionId": session_id,
        "direction": "rpc_to_bridge",
        "rawLine": line,
    });

    let Ok(mut encoded) = serde_json::to_string(&record) else {
        warn!(session_id = %session_id, "failed to serialize bridge debug RPC frame");
        return;
    };
    encoded.push('\n');

    match async_fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
    {
        Ok(mut file) => {
            if let Err(error) = file.write_all(encoded.as_bytes()).await {
                warn!(path = %path.display(), %error, "failed to write bridge debug RPC frame");
            }
        }
        Err(error) => {
            warn!(path = %path.display(), %error, "failed to open bridge debug file");
        }
    }
}

fn now_epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before unix epoch")
        .as_millis()
}

fn next_rpc_id() -> String {
    Uuid::new_v4().to_string()
}

fn generate_token() -> String {
    Uuid::new_v4().simple().to_string()
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before unix epoch")
        .as_secs()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install ctrl-c handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_message(id: &str, text: &str) -> TranscriptMessage {
        TranscriptMessage {
            id: id.into(),
            role: MessageRole::Assistant,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            is_new: false,
        }
    }

    fn test_record() -> SessionRecord {
        SessionRecord {
            id: "s1".into(),
            cwd: None,
            args: Vec::new(),
            status: SessionStatus::Idle,
            created_at: 0,
            updated_at: 0,
            messages: Vec::new(),
            live_message_ids: HashSet::new(),
            streaming_message: None,
            tool_cards: Vec::new(),
            active_tool_calls: Vec::new(),
            kind: SessionKind::Managed,
            session_file: None,
            title: None,
            timestamp: None,
            model: None,
            thinking_level: None,
            tokens_total: 0,
            cost_usd: 0.0,
            context_tokens: None,
            context_window: None,
            context_percent: None,
            plan_mode: None,
        }
    }

    fn test_state(channel_capacity: usize, bridge_debug_file: Option<PathBuf>) -> AppState {
        let (events, _) = broadcast::channel(channel_capacity);
        AppState {
            token: Arc::new("test".into()),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            rpc_sessions: Arc::new(RwLock::new(HashMap::new())),
            rpc_session_targets: Arc::new(RwLock::new(HashMap::new())),
            pending_created_sessions: Arc::new(RwLock::new(HashMap::new())),
            pending_new_session_names: Arc::new(RwLock::new(HashMap::new())),
            events,
            rpc_config: Arc::new(RpcConfig {
                program: "omp".into(),
                args: Vec::new(),
            }),
            log_frames: false,
            bridge_debug_file,
            forward_raw_frames: false,
            session_root: env::temp_dir(),
            default_cwd: Arc::new(RwLock::new(env::temp_dir().to_string_lossy().into_owned())),
            config_path: None,
        }
    }

    fn write_test_session(path: &Path, id: &str, title: &str, cwd: &str, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("session dir should be created");
        }
        let header = serde_json::json!({
            "type": "session",
            "id": id,
            "title": title,
            "timestamp": "2026-04-29T00:00:00.000Z",
            "cwd": cwd,
        });
        let message = serde_json::json!({
            "type": "message",
            "id": format!("{id}-entry"),
            "parentId": null,
            "timestamp": "2026-04-29T00:00:01.000Z",
            "message": {
                "id": format!("{id}-message"),
                "role": "user",
                "content": [{ "type": "text", "text": text }],
            },
        });
        fs::write(path, format!("{header}\n{message}\n")).expect("session file should be written");
    }

    #[tokio::test]
    async fn refresh_session_catalog_discovers_external_session_files() {
        let root = env::temp_dir().join(format!("fura-sessions-test-{}", Uuid::new_v4().simple()));
        let session_path = root.join("project").join("s1.jsonl");
        write_test_session(
            &session_path,
            "s1",
            "External session",
            "/workspace/project",
            "hello",
        );
        let mut state = test_state(8, None);
        state.session_root = root.clone();

        assert!(refresh_session_catalog(&state).await);
        let sessions = state.sessions.read().await;
        let record = sessions.get("s1").expect("session should be discovered");
        assert_eq!(record.kind, SessionKind::Available);
        assert_eq!(record.status, SessionStatus::Available);
        assert_eq!(record.title.as_deref(), Some("External session"));
        assert_eq!(record.cwd.as_deref(), Some("/workspace/project"));
        assert_eq!(record.messages.len(), 1);
        assert_eq!(
            record.session_file.as_deref(),
            Some(session_path.to_string_lossy().as_ref())
        );
        drop(sessions);

        assert!(!refresh_session_catalog(&state).await);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn slash_fork_sends_rpc_fork_command() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());
        let (stdin, mut commands) = mpsc::channel(4);
        let (stop, _stop_rx) = oneshot::channel();
        state
            .rpc_sessions
            .write()
            .await
            .insert("s1".to_string(), RpcSessionHandle { stdin, stop });
        state
            .rpc_session_targets
            .write()
            .await
            .insert("s1".to_string(), "s1".to_string());

        let responses =
            send_prompt(&state, "s1".to_string(), "/fork".to_string(), None, None).await;

        assert!(
            responses.is_empty(),
            "slash fork should be handled by RPC, not sent as prompt"
        );
        let command = commands.recv().await.expect("fork command sent");
        assert_eq!(
            command.get("type").and_then(|value| value.as_str()),
            Some("fork")
        );
    }

    #[tokio::test]
    async fn slash_plan_enters_plan_mode_and_sends_initial_prompt() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());
        let (stdin, mut commands) = mpsc::channel(4);
        let (stop, _stop_rx) = oneshot::channel();
        state
            .rpc_sessions
            .write()
            .await
            .insert("s1".to_string(), RpcSessionHandle { stdin, stop });
        state
            .rpc_session_targets
            .write()
            .await
            .insert("s1".to_string(), "s1".to_string());

        let responses = send_prompt(
            &state,
            "s1".to_string(),
            "/plan investigate safely".to_string(),
            None,
            None,
        )
        .await;

        assert_eq!(responses.len(), 1);
        let command = commands.recv().await.expect("plan mode command sent");
        assert_eq!(
            command.get("type").and_then(|value| value.as_str()),
            Some("set_plan_mode")
        );
        assert_eq!(
            command.get("enabled").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            command.get("planFilePath").and_then(|value| value.as_str()),
            Some("local://PLAN.md")
        );
        assert_eq!(
            command.get("workflow").and_then(|value| value.as_str()),
            Some("parallel")
        );

        let prompt = commands.recv().await.expect("initial planning prompt sent");
        assert_eq!(
            prompt.get("type").and_then(|value| value.as_str()),
            Some("prompt")
        );
        assert_eq!(
            prompt.get("message").and_then(|value| value.as_str()),
            Some("investigate safely")
        );
        assert_eq!(
            prompt
                .get("streamingBehavior")
                .and_then(|value| value.as_str()),
            Some("followUp")
        );
    }

    #[tokio::test]
    async fn slash_plan_exits_when_projection_is_in_plan_mode() {
        let state = test_state(8, None);
        let mut record = test_record();
        record.plan_mode = Some(PlanModeProjection {
            enabled: true,
            plan_file_path: "local://PLAN.md".to_string(),
            workflow: Some("parallel".to_string()),
        });
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), record);
        let (stdin, mut commands) = mpsc::channel(4);
        let (stop, _stop_rx) = oneshot::channel();
        state
            .rpc_sessions
            .write()
            .await
            .insert("s1".to_string(), RpcSessionHandle { stdin, stop });
        state
            .rpc_session_targets
            .write()
            .await
            .insert("s1".to_string(), "s1".to_string());

        let responses =
            send_prompt(&state, "s1".to_string(), "/plan".to_string(), None, None).await;

        assert_eq!(responses.len(), 1);
        let command = commands.recv().await.expect("plan mode exit command sent");
        assert_eq!(
            command.get("type").and_then(|value| value.as_str()),
            Some("set_plan_mode")
        );
        assert_eq!(
            command.get("enabled").and_then(|value| value.as_bool()),
            Some(false)
        );
        assert!(
            commands.try_recv().is_err(),
            "exit should not send an initial prompt"
        );
    }

    #[tokio::test]
    async fn plan_preview_response_emits_review_message() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());
        state
            .rpc_session_targets
            .write()
            .await
            .insert("transport-1".to_string(), "s1".to_string());
        let mut events = state.events.subscribe();

        apply_rpc_response(
            &state,
            "transport-1",
            &serde_json::json!({
                "type": "response",
                "command": "get_plan_mode_preview",
                "success": true,
                "data": {
                    "planFilePath": "local://PLAN.md",
                    "finalPlanFilePath": "local://APPROVED.md",
                    "title": "APPROVED",
                    "content": "# Plan"
                }
            }),
        )
        .await;

        match events.recv().await.expect("plan review event") {
            ServerMessage::PlanReview {
                session_id,
                plan_file_path,
                final_plan_file_path,
                title,
                content,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(plan_file_path, "local://PLAN.md");
                assert_eq!(final_plan_file_path, "local://APPROVED.md");
                assert_eq!(title.as_deref(), Some("APPROVED"));
                assert_eq!(content, "# Plan");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn rpc_prompt_error_targets_real_session_and_clears_busy_state() {
        let state = test_state(8, None);
        let mut record = test_record();
        record.status = SessionStatus::Busy;
        record.streaming_message = Some(text_message("streaming", "partial"));
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), record);
        state
            .rpc_session_targets
            .write()
            .await
            .insert("transport-1".to_string(), "s1".to_string());
        let mut events = state.events.subscribe();

        apply_rpc_response(
            &state,
            "transport-1",
            &serde_json::json!({
                "type": "response",
                "command": "prompt",
                "success": false,
                "error": "rate limit exceeded"
            }),
        )
        .await;

        match events.recv().await.expect("idle snapshot event") {
            ServerMessage::SessionSnapshot { session_id, state } => {
                assert_eq!(session_id, "s1");
                assert!(!state.is_busy);
                assert_eq!(state.transcript.len(), 0);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        match events.recv().await.expect("sessions snapshot event") {
            ServerMessage::SessionsSnapshot { sessions } => {
                assert_eq!(sessions[0].session_id, "s1");
                assert_eq!(sessions[0].status, SessionStatus::Idle);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        match events.recv().await.expect("error notice event") {
            ServerMessage::SessionNotice {
                session_id,
                level,
                text,
            } => {
                assert_eq!(session_id, "s1");
                assert!(matches!(level, NoticeLevel::Error));
                assert_eq!(text, "rate limit exceeded");
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let sessions = state.sessions.read().await;
        let record = sessions.get("s1").expect("record remains");
        assert_eq!(record.status, SessionStatus::Idle);
        assert!(record.streaming_message.is_none());
    }

    #[tokio::test]
    async fn rpc_model_list_response_emits_model_list() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());
        let mut events = state.events.subscribe();

        apply_rpc_response(
            &state,
            "s1",
            &serde_json::json!({
                "type": "response",
                "command": "get_available_models",
                "success": true,
                "data": {
                    "models": [{
                        "provider": "mock",
                        "id": "mock-model",
                        "name": "Mock Model",
                        "contextWindow": 200000,
                        "thinking": null
                    }]
                }
            }),
        )
        .await;

        match events.recv().await.expect("model list event") {
            ServerMessage::ModelList { session_id, models } => {
                assert_eq!(session_id, "s1");
                assert_eq!(models.len(), 1);
                assert_eq!(models[0].provider, "mock");
                assert_eq!(models[0].id, "mock-model");
                assert_eq!(models[0].context_window, Some(200000));
                assert!(!models[0].thinking);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn rpc_set_model_response_updates_projection_and_emits_change() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());
        let mut events = state.events.subscribe();

        apply_rpc_response(
            &state,
            "s1",
            &serde_json::json!({
                "type": "response",
                "command": "set_model",
                "success": true,
                "data": {
                    "provider": "mock",
                    "id": "mock-reasoner",
                    "name": "Mock Reasoner",
                    "contextWindow": 1000000,
                    "thinking": { "efforts": ["low", "medium", "high"] }
                }
            }),
        )
        .await;

        {
            let sessions = state.sessions.read().await;
            let record = sessions.get("s1").expect("record remains");
            assert_eq!(record.model.as_deref(), Some("Mock Reasoner"));
        }

        match events.recv().await.expect("snapshot event") {
            ServerMessage::SessionSnapshot { session_id, state } => {
                assert_eq!(session_id, "s1");
                assert_eq!(state.model.as_deref(), Some("Mock Reasoner"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
        match events.recv().await.expect("model change event") {
            ServerMessage::ModelChanged { session_id, model } => {
                assert_eq!(session_id, "s1");
                assert_eq!(model.provider, "mock");
                assert_eq!(model.id, "mock-reasoner");
                assert!(model.thinking);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn rpc_stdout_does_not_forward_raw_frames_by_default() {
        let state = test_state(8, None);
        let mut events = state.events.subscribe();
        let input = b"{\"type\":\"ready\"}\n";

        read_rpc_stdout(state, "transport-1".to_string(), BufReader::new(&input[..])).await;

        let mut saw_raw_frame = false;
        while let Ok(event) = events.try_recv() {
            if matches!(event, ServerMessage::RawOmp { .. }) {
                saw_raw_frame = true;
            }
        }

        assert!(!saw_raw_frame, "raw frames should be opt-in");
    }

    #[tokio::test]
    async fn rpc_stdout_forwards_raw_frames_when_enabled() {
        let mut state = test_state(8, None);
        state.forward_raw_frames = true;
        let mut events = state.events.subscribe();
        let input = b"{\"type\":\"ready\"}\n";

        read_rpc_stdout(state, "transport-1".to_string(), BufReader::new(&input[..])).await;

        let mut raw_frame_type = None;
        while let Ok(event) = events.try_recv() {
            if let ServerMessage::RawOmp { frame, .. } = event {
                raw_frame_type = frame
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }

        assert_eq!(raw_frame_type.as_deref(), Some("ready"));
    }

    #[tokio::test]
    async fn append_bridge_debug_rpc_line_writes_exact_raw_line() {
        let path = env::temp_dir().join(format!(
            "fura-bridge-debug-{}.jsonl",
            Uuid::new_v4().simple()
        ));
        let state = test_state(1, Some(path.clone()));
        let raw_line = r#"{"type":"message_end","content":[{"type":"text","text":"<critical>"}]}"#;

        append_bridge_debug_rpc_line(&state, "session-a", raw_line).await;

        let written = async_fs::read_to_string(&path)
            .await
            .expect("debug file should be written");
        let record: Value = serde_json::from_str(written.trim_end()).expect("debug file is JSONL");

        assert_eq!(record["sessionId"], "session-a");
        assert_eq!(record["direction"], "rpc_to_bridge");
        assert_eq!(record["rawLine"], raw_line);

        let _ = async_fs::remove_file(path).await;
    }

    #[test]
    fn parses_session_create_message() {
        // Without name
        let message = serde_json::from_str::<ClientMessage>(
            r#"{"type":"session.create","cwd":"/tmp","args":["--debug"]}"#,
        )
        .expect("message should parse");
        match message {
            ClientMessage::SessionCreate { cwd, name, args } => {
                assert_eq!(cwd.as_deref(), Some("/tmp"));
                assert_eq!(name, None);
                assert_eq!(args, Some(vec!["--debug".to_string()]));
            }
            other => panic!("unexpected message: {other:?}"),
        }

        // With name
        let message = serde_json::from_str::<ClientMessage>(
            r#"{"type":"session.create","cwd":"/tmp","name":"my-project","args":[]}"#,
        )
        .expect("message should parse");
        match message {
            ClientMessage::SessionCreate { cwd, name, args } => {
                assert_eq!(cwd.as_deref(), Some("/tmp"));
                assert_eq!(name.as_deref(), Some("my-project"));
                assert_eq!(args, Some(vec![] as Vec<String>));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn parses_prompt_send_behavior() {
        let message = serde_json::from_str::<ClientMessage>(
            r#"{"type":"prompt.send","sessionId":"abc-123","text":"keep going","behavior":"followUp"}"#,
        )
        .expect("message should parse");

        match message {
            ClientMessage::PromptSend {
                session_id,
                text,
                behavior,
                ..
            } => {
                assert_eq!(session_id, "abc-123");
                assert_eq!(text, "keep going");
                assert_eq!(
                    behavior.map(PromptBehavior::as_rpc_streaming_behavior),
                    Some("followUp")
                );
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn parses_session_delete_message() {
        let msg: ClientMessage =
            serde_json::from_str(r#"{"type":"session.delete","sessionId":"abc-123"}"#)
                .expect("parse failed");
        assert!(
            matches!(msg, ClientMessage::SessionDelete { ref session_id } if session_id == "abc-123")
        );
    }

    #[tokio::test]
    async fn rpc_repo_diff_response_emits_diff_state() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());
        let mut events = state.events.subscribe();

        apply_rpc_response(
            &state,
            "s1",
            &serde_json::json!({
                "type": "response",
                "command": "repo_diff_get",
                "success": true,
                "data": {
                    "snapshots": [{
                        "entryId": "entry-1",
                        "label": "session-start",
                        "kind": "session-start",
                        "createdAt": "2026-04-29T00:00:00.000Z",
                        "repoRoot": "/repo"
                    }],
                    "selectedSnapshot": {
                        "entryId": "entry-1",
                        "label": "session-start",
                        "kind": "session-start",
                        "createdAt": "2026-04-29T00:00:00.000Z",
                        "repoRoot": "/repo"
                    },
                    "headSnapshot": null,
                    "diff": "diff --git a/a b/a\n",
                    "stat": false
                }
            }),
        )
        .await;

        match events.recv().await.expect("diff state event") {
            ServerMessage::DiffState { session_id, state } => {
                assert_eq!(session_id, "s1");
                assert_eq!(state["selectedSnapshot"]["entryId"], "entry-1");
                assert_eq!(state["headSnapshot"], Value::Null);
                assert_eq!(state["diff"], "diff --git a/a b/a\n");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn parses_diff_refresh_message() {
        let msg: ClientMessage = serde_json::from_str(
            r#"{"type":"diff.refresh","sessionId":"abc-123","selector":"session-start","headSelector":"manual-2","stat":true}"#,
        )
        .expect("parse failed");
        assert!(matches!(
            msg,
            ClientMessage::DiffRefresh {
                ref session_id,
                ref selector,
                ref head_selector,
                stat: Some(true)
            } if session_id == "abc-123"
                && selector.as_deref() == Some("session-start")
                && head_selector.as_deref() == Some("manual-2")
        ));
    }

    #[test]
    fn suppresses_tool_result_messages() {
        // toolResult and tool roles produce no transcript entry.
        for role in ["toolResult", "tool"] {
            let result = map_omp_message(&serde_json::json!({
                "id": "t1",
                "role": role,
                "content": [{ "type": "text", "text": "some result" }]
            }));
            assert!(result.is_none(), "{role} should be suppressed");
        }
    }

    #[test]
    fn projects_historical_task_results_as_tool_cards() {
        let raw_messages = vec![
            serde_json::json!({
                "id": "u1",
                "role": "user",
                "content": [{ "type": "text", "text": "review this" }]
            }),
            serde_json::json!({
                "id": "a1",
                "role": "assistant",
                "content": [{
                    "type": "toolCall",
                    "id": "task-call",
                    "name": "task",
                    "intent": "launching review",
                    "arguments": { "agent": "reviewer" }
                }]
            }),
            serde_json::json!({
                "id": "tr1",
                "role": "toolResult",
                "toolCallId": "task-call",
                "toolName": "task",
                "content": [{ "type": "text", "text": "<task-summary>raw summary</task-summary>" }],
                "details": {
                    "results": [{
                        "index": 0,
                        "id": "0-Review",
                        "agent": "reviewer",
                        "task": "review",
                        "exitCode": 0,
                        "durationMs": 12,
                        "tokens": 34,
                        "output": "ok"
                    }],
                    "totalDurationMs": 12
                },
                "isError": false
            }),
        ];

        let (messages, tool_cards) = project_omp_transcript(&raw_messages);

        assert_eq!(
            messages.len(),
            1,
            "tool-only assistant and toolResult messages stay out of normal transcript"
        );
        assert_eq!(tool_cards.len(), 1);
        let card = &tool_cards[0];
        assert_eq!(card.tool_call_id, "task-call");
        assert_eq!(card.tool_name, "task");
        assert_eq!(card.intent.as_deref(), Some("launching review"));
        assert_eq!(card.args["agent"], "reviewer");
        assert!(!card.is_active);
        assert!(!card.is_error);
        assert_eq!(card.insert_after_count, 1);
        assert_eq!(
            card.result.as_ref().unwrap()["details"]["results"][0]["id"],
            "0-Review"
        );
    }

    #[test]
    fn suppresses_file_mention_and_compaction() {
        for role in ["fileMention", "compactionSummary", "branchSummary"] {
            let result = map_omp_message(&serde_json::json!({ "role": role }));
            assert!(result.is_none(), "{role} should be suppressed");
        }
    }

    #[test]
    fn suppresses_agent_attributed_developer_messages() {
        let result = map_omp_message(&serde_json::json!({
            "id": "handoff-prompt",
            "role": "developer",
            "attribution": "agent",
            "content": [{ "type": "text", "text": "<critical>\nWrite a comprehensive handoff document" }]
        }));

        assert!(
            result.is_none(),
            "agent-attributed developer prompts are internal OMP instructions, not transcript UI"
        );
    }

    #[test]
    fn maps_user_attributed_developer_messages() {
        let result = map_omp_message(&serde_json::json!({
            "id": "synthetic-user-visible",
            "role": "developer",
            "attribution": "user",
            "content": [{ "type": "text", "text": "visible synthetic message" }]
        }))
        .expect("user-attributed developer message should remain visible");

        assert!(matches!(result.role, MessageRole::User));
    }

    #[test]
    fn maps_bash_execution_to_system_role() {
        let result = map_omp_message(&serde_json::json!({
            "id": "b1",
            "role": "bashExecution",
            "command": "ls -la",
            "output": "total 8\ndrwxr-xr-x 2 user user 4096 Jan 1 00:00 .",
            "exitCode": 0
        }))
        .expect("bashExecution should produce a message");
        assert!(matches!(result.role, MessageRole::System));
        match &result.blocks[0] {
            ContentBlock::Text { text } => {
                assert!(text.contains("$ ls -la"), "should contain command");
                assert!(text.contains("total 8"), "should contain output preview");
            }
            other => panic!("unexpected block: {other:?}"),
        }
    }

    #[test]
    fn suppresses_bash_execution_excluded_from_context() {
        let result = map_omp_message(&serde_json::json!({
            "role": "bashExecution",
            "command": "internal-op",
            "excludeFromContext": true
        }));
        assert!(
            result.is_none(),
            "excluded bashExecution should be suppressed"
        );
    }

    #[test]
    fn no_pretty_json_fallback_for_unknown_shape() {
        // Previously, messages without content/text fell through to pretty_json.
        // Now they are suppressed.
        let result = map_omp_message(&serde_json::json!({
            "role": "assistant",
            "someUnknownField": "value"
        }));
        assert!(
            result.is_none(),
            "unknown shape should be suppressed, not JSON-dumped"
        );
    }

    #[test]
    fn suppresses_hook_message_when_display_false() {
        let result = map_omp_message(&serde_json::json!({
            "role": "hookMessage",
            "display": false,
            "text": "internal hook output"
        }));
        assert!(result.is_none());
    }

    #[test]
    fn shows_hook_message_when_display_true() {
        let result = map_omp_message(&serde_json::json!({
            "role": "hookMessage",
            "display": true,
            "text": "visible hook output"
        }))
        .expect("display:true hookMessage should produce a message");
        assert!(matches!(result.role, MessageRole::Assistant));
    }

    #[test]
    fn load_default_cwd_prefers_valid_config_last_cwd() {
        let root = env::temp_dir().join(format!("fura-config-test-{}", Uuid::new_v4().simple()));
        let last_cwd = root.join("last");
        let startup_cwd = root.join("startup");
        fs::create_dir_all(&last_cwd).expect("last cwd dir should be created");
        fs::create_dir_all(&startup_cwd).expect("startup cwd dir should be created");
        let config_path = root.join("config.yaml");
        fs::write(
            &config_path,
            serde_yaml::to_string(&FuraConfig {
                last_cwd: Some(last_cwd.to_string_lossy().into_owned()),
            })
            .expect("config should serialize"),
        )
        .expect("config should be written");

        let loaded = load_default_cwd(Some(&config_path), &startup_cwd);

        assert_eq!(loaded, last_cwd.to_string_lossy());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_default_cwd_falls_back_to_startup_for_missing_last_cwd() {
        let root = env::temp_dir().join(format!("fura-config-test-{}", Uuid::new_v4().simple()));
        let startup_cwd = root.join("startup");
        fs::create_dir_all(&startup_cwd).expect("startup cwd dir should be created");
        let config_path = root.join("config.yaml");
        fs::write(
            &config_path,
            serde_yaml::to_string(&FuraConfig {
                last_cwd: Some(root.join("missing").to_string_lossy().into_owned()),
            })
            .expect("config should serialize"),
        )
        .expect("config should be written");

        let loaded = load_default_cwd(Some(&config_path), &startup_cwd);

        assert_eq!(loaded, startup_cwd.to_string_lossy());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn save_default_cwd_broadcasts_full_client_config() {
        let state = test_state(8, None);
        let mut events = state.events.subscribe();

        save_default_cwd(&state, "/workspace/next").await;

        assert_eq!(
            state.default_cwd.read().await.as_str(),
            "/workspace/next",
            "in-memory default cwd should update immediately"
        );
        match events.recv().await.expect("config update event") {
            ServerMessage::ConfigUpdated { config } => {
                assert_eq!(config.default_cwd, "/workspace/next");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn serializes_hello_message() {
        let json = serde_json::to_value(ServerMessage::Hello {
            server_version: "0.1.0",
            protocol_version: 1,
            config: ClientConfig {
                default_cwd: "/workspace".to_string(),
            },
        })
        .expect("hello should serialize");

        assert_eq!(json["type"], "hello");
        assert_eq!(json["serverVersion"], "0.1.0");
        assert_eq!(json["protocolVersion"], 1);
        assert_eq!(json["config"]["defaultCwd"], "/workspace");
    }

    #[test]
    fn maps_basic_omp_message() {
        let message = map_omp_message(&serde_json::json!({
            "id": "m1",
            "role": "user",
            "content": [{ "type": "text", "text": "hello" }]
        }))
        .expect("message should map");

        assert_eq!(message.id, "m1");
        assert!(matches!(message.role, MessageRole::User));
        match &message.blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "hello"),
            other => panic!("unexpected block: {other:?}"),
        }
    }
    #[test]
    fn maps_thinking_block() {
        let message = map_omp_message(&serde_json::json!({
            "id": "t1",
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "let me reason about this", "thinkingSignature": "should-not-appear" },
                { "type": "text", "text": "final answer" }
            ]
        }))
        .expect("message should map");

        assert_eq!(message.blocks.len(), 2);
        match &message.blocks[0] {
            ContentBlock::Thinking { thinking } => assert_eq!(thinking, "let me reason about this"),
            other => panic!("expected thinking block, got {other:?}"),
        }
        match &message.blocks[1] {
            ContentBlock::Text { text } => assert_eq!(text, "final answer"),
            other => panic!("expected text block, got {other:?}"),
        }
    }

    #[test]
    fn maps_redacted_thinking_block() {
        let message = map_omp_message(&serde_json::json!({
            "id": "r1",
            "role": "assistant",
            "content": [
                { "type": "redactedThinking", "data": "encrypted-payload-never-shown" },
                { "type": "text", "text": "visible response" }
            ]
        }))
        .expect("message should map");

        assert_eq!(message.blocks.len(), 2);
        assert!(matches!(message.blocks[0], ContentBlock::RedactedThinking));
        match &message.blocks[1] {
            ContentBlock::Text { text } => assert_eq!(text, "visible response"),
            other => panic!("expected text block, got {other:?}"),
        }
    }

    #[test]
    fn thinking_only_message_is_none_when_empty() {
        let result = map_omp_message(&serde_json::json!({
            "id": "e1",
            "role": "assistant",
            "content": []
        }));
        assert!(result.is_none(), "empty content should produce None");
    }

    #[test]
    fn map_omp_message_sets_is_new_false() {
        let msg = map_omp_message(&serde_json::json!({
            "id": "hist1",
            "role": "assistant",
            "content": [{ "type": "text", "text": "historical" }]
        }))
        .expect("should map");
        assert!(!msg.is_new, "map_omp_message must set is_new=false");
    }

    #[test]
    fn replace_messages_preserves_is_new_for_live_ids() {
        let mut record = test_record();
        record.live_message_ids.insert("live1".to_string());

        let incoming = vec![text_message("live1", "live"), text_message("hist1", "hist")];

        assert!(replace_record_messages(&mut record, incoming));

        assert!(
            record.messages[0].is_new,
            "live1 must stay is_new=true after reconciliation"
        );
        assert!(!record.messages[1].is_new, "hist1 must remain is_new=false");
    }

    #[test]
    fn replace_messages_rejects_stale_shorter_projection() {
        let mut record = test_record();
        record.messages = vec![text_message("old1", "old"), text_message("old2", "old")];

        let accepted = replace_record_messages(&mut record, vec![text_message("new1", "new")]);

        assert!(
            !accepted,
            "shorter projection should be treated as stale by default"
        );
        assert_eq!(
            record.messages.len(),
            2,
            "existing transcript should remain intact"
        );
    }

    #[tokio::test]
    async fn message_end_keeps_session_busy_until_agent_end() {
        let state = test_state(8, None);
        let mut record = test_record();
        record.status = SessionStatus::Busy;
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), record);

        apply_rpc_frame(
            &state,
            "s1",
            &serde_json::json!({
                "type": "message_end",
                "message": {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "done" }]
                }
            }),
        )
        .await;

        {
            let sessions = state.sessions.read().await;
            let record = sessions.get("s1").expect("record remains");
            assert!(matches!(record.status, SessionStatus::Busy));
            assert!(record.projection().is_busy);
            assert!(matches!(record.summary().status, SessionStatus::Busy));
        }

        apply_rpc_frame(&state, "s1", &serde_json::json!({ "type": "agent_end" })).await;

        let sessions = state.sessions.read().await;
        let record = sessions.get("s1").expect("record remains");
        assert!(matches!(record.status, SessionStatus::Idle));
        assert!(!record.projection().is_busy);
    }

    #[test]
    fn active_tool_work_keeps_projection_busy() {
        let mut record = test_record();
        record.status = SessionStatus::Idle;
        record.active_tool_calls.push(ToolCard {
            tool_call_id: "tool-1".to_string(),
            tool_name: "task".to_string(),
            intent: None,
            args: Value::Null,
            is_active: true,
            is_error: false,
            partial_result: None,
            result: None,
            insert_after_count: 0,
        });

        assert!(record.projection().is_busy);
        assert!(matches!(record.summary().status, SessionStatus::Busy));
    }

    #[tokio::test]
    async fn async_task_card_stays_active_until_final_update() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());

        apply_rpc_frame(
            &state,
            "s1",
            &serde_json::json!({
                "type": "tool_execution_start",
                "toolCallId": "task-call",
                "toolName": "task",
                "args": { "agent": "task" }
            }),
        )
        .await;
        apply_rpc_frame(
            &state,
            "s1",
            &serde_json::json!({
                "type": "tool_execution_end",
                "toolCallId": "task-call",
                "isError": false,
                "result": {
                    "content": [{ "type": "text", "text": "Started background task job." }],
                    "details": {
                        "progress": [{
                            "index": 0,
                            "id": "CheckUi",
                            "agent": "task",
                            "status": "running",
                            "task": "Check UI",
                            "toolCount": 1,
                            "tokens": 0,
                            "durationMs": 0
                        }],
                        "async": { "state": "running", "jobId": "job-1", "type": "task" }
                    }
                }
            }),
        )
        .await;

        {
            let sessions = state.sessions.read().await;
            let record = sessions.get("s1").expect("record remains");
            assert_eq!(record.active_tool_calls.len(), 1);
            assert!(record.tool_cards.is_empty());
            assert!(record.active_tool_calls[0].is_active);
            assert_eq!(
                record.active_tool_calls[0].result.as_ref().unwrap()["details"]["async"]["state"],
                "running"
            );
        }

        apply_rpc_frame(
            &state,
            "s1",
            &serde_json::json!({
                "type": "tool_execution_update",
                "toolCallId": "task-call",
                "partialResult": {
                    "content": [{ "type": "text", "text": "Background task batch complete." }],
                    "details": {
                        "progress": [{
                            "index": 0,
                            "id": "CheckUi",
                            "agent": "task",
                            "status": "completed",
                            "task": "Check UI",
                            "toolCount": 2,
                            "tokens": 42,
                            "durationMs": 1234
                        }],
                        "async": { "state": "completed", "jobId": "job-1", "type": "task" }
                    }
                }
            }),
        )
        .await;

        let sessions = state.sessions.read().await;
        let record = sessions.get("s1").expect("record remains");
        assert!(record.active_tool_calls.is_empty());
        assert_eq!(record.tool_cards.len(), 1);
        assert!(!record.tool_cards[0].is_active);
        assert!(!record.tool_cards[0].is_error);
        assert!(record.tool_cards[0].partial_result.is_none());
        assert_eq!(
            record.tool_cards[0].result.as_ref().unwrap()["details"]["async"]["state"],
            "completed"
        );
        assert_eq!(
            record.tool_cards[0].result.as_ref().unwrap()["details"]["progress"][0]["status"],
            "completed"
        );
    }

    #[tokio::test]
    async fn pending_created_session_becomes_visible_only_after_rpc_state() {
        let state = test_state(8, None);
        state.pending_created_sessions.write().await.insert(
            "transport-session".to_string(),
            PendingCreatedSession {
                cwd: Some("/workspace/project".to_string()),
                args: vec!["--debug".to_string()],
                title: Some("diffs2".to_string()),
                created_at: 123,
            },
        );
        state.rpc_session_targets.write().await.insert(
            "transport-session".to_string(),
            "transport-session".to_string(),
        );
        let mut events = state.events.subscribe();

        apply_rpc_response(
            &state,
            "transport-session",
            &serde_json::json!({
                "type": "response",
                "command": "get_state",
                "success": true,
                "data": {
                    "sessionId": "omp-session",
                    "sessionFile": "omp-session.jsonl",
                    "sessionName": "diffs2"
                }
            }),
        )
        .await;

        {
            let sessions = state.sessions.read().await;
            assert!(
                !sessions.contains_key("transport-session"),
                "internal transport id must not become a visible session"
            );
            let next = sessions.get("omp-session").expect("OMP session is visible");
            assert!(matches!(next.kind, SessionKind::Managed));
            assert!(matches!(next.status, SessionStatus::Idle));
            assert_eq!(next.cwd.as_deref(), Some("/workspace/project"));
            assert_eq!(next.args, vec!["--debug".to_string()]);
            assert_eq!(next.created_at, 123);
            assert_eq!(next.session_file.as_deref(), Some("omp-session.jsonl"));
            assert_eq!(next.title.as_deref(), Some("diffs2"));
        }

        assert!(
            state
                .pending_created_sessions
                .read()
                .await
                .get("transport-session")
                .is_none(),
            "pending create metadata should be consumed once OMP reports the real session id"
        );
        assert_eq!(
            rpc_transport_session_id(&state, "omp-session")
                .await
                .as_deref(),
            Some("transport-session")
        );
        assert!(
            rpc_transport_session_id(&state, "transport-session")
                .await
                .is_none(),
            "frontend actions must use the real OMP session id, not the transport id"
        );

        match events.recv().await.expect("target snapshot event") {
            ServerMessage::SessionSnapshot { session_id, state } => {
                assert_eq!(session_id, "omp-session");
                assert_eq!(state.summary.title.as_deref(), Some("diffs2"));
            }
            other => panic!("unexpected first event: {other:?}"),
        }

        match events.recv().await.expect("session list refresh event") {
            ServerMessage::SessionsSnapshot { sessions } => {
                assert!(
                    sessions
                        .iter()
                        .all(|session| session.session_id != "transport-session"),
                    "session list must not include the internal transport id"
                );
                assert!(
                    sessions
                        .iter()
                        .any(|session| session.session_id == "omp-session"),
                    "session list should include the resolved OMP session"
                );
            }
            other => panic!("unexpected second event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn rpc_session_switch_creates_new_record_and_preserves_previous_transcript() {
        let state = test_state(8, None);

        let mut previous = test_record();
        previous.id = "old-session".to_string();
        previous.kind = SessionKind::Managed;
        previous.status = SessionStatus::Busy;
        previous.session_file = Some("old-session.jsonl".to_string());
        previous.messages = vec![
            text_message("old-user", "original question"),
            text_message("old-assistant", "original answer"),
        ];
        state
            .sessions
            .write()
            .await
            .insert("old-session".to_string(), previous);
        state
            .rpc_session_targets
            .write()
            .await
            .insert("old-session".to_string(), "old-session".to_string());

        apply_rpc_response(
            &state,
            "old-session",
            &serde_json::json!({
                "type": "response",
                "command": "get_state",
                "success": true,
                "data": {
                    "sessionId": "new-session",
                    "sessionFile": "new-session.jsonl",
                    "sessionName": "Handoff continuation"
                }
            }),
        )
        .await;

        {
            let sessions = state.sessions.read().await;
            let previous = sessions
                .get("old-session")
                .expect("previous record remains");
            assert!(matches!(previous.kind, SessionKind::Available));
            assert!(matches!(previous.status, SessionStatus::Available));
            assert_eq!(previous.session_file.as_deref(), Some("old-session.jsonl"));
            assert_eq!(
                previous.messages.len(),
                2,
                "previous transcript must not be replaced by handoff context"
            );

            let next = sessions.get("new-session").expect("new record is visible");
            assert!(matches!(next.kind, SessionKind::Managed));
            assert!(matches!(next.status, SessionStatus::Idle));
            assert_eq!(next.session_file.as_deref(), Some("new-session.jsonl"));
            assert_eq!(next.title.as_deref(), Some("Handoff continuation"));
            assert!(next.messages.is_empty());
        }

        assert_eq!(
            state
                .rpc_session_targets
                .read()
                .await
                .get("old-session")
                .map(String::as_str),
            Some("new-session")
        );
        assert_eq!(
            rpc_transport_session_id(&state, "new-session")
                .await
                .as_deref(),
            Some("old-session")
        );
        assert!(
            rpc_transport_session_id(&state, "old-session")
                .await
                .is_none(),
            "previous session must not send prompts to the handoff transport"
        );

        apply_rpc_frame(
            &state,
            "old-session",
            &serde_json::json!({
                "type": "tool_execution_start",
                "toolCallId": "tool-1",
                "toolName": "read",
                "intent": "reading file",
                "args": { "path": "src/main.rs" }
            }),
        )
        .await;
        apply_rpc_frame(
            &state,
            "old-session",
            &serde_json::json!({
                "type": "tool_execution_update",
                "toolCallId": "tool-1",
                "partialResult": { "content": [{ "type": "text", "text": "line 1" }] }
            }),
        )
        .await;
        apply_rpc_frame(
            &state,
            "old-session",
            &serde_json::json!({
                "type": "tool_execution_end",
                "toolCallId": "tool-1",
                "isError": false,
                "result": { "content": [{ "type": "text", "text": "line 1" }] }
            }),
        )
        .await;

        {
            let sessions = state.sessions.read().await;
            let previous = sessions
                .get("old-session")
                .expect("previous record remains");
            assert!(
                previous.active_tool_calls.is_empty() && previous.tool_cards.is_empty(),
                "tool progress from the post-handoff transport must not attach to the previous session",
            );

            let next = sessions.get("new-session").expect("new record remains");
            assert!(next.active_tool_calls.is_empty());
            assert_eq!(next.tool_cards.len(), 1);
            assert_eq!(next.tool_cards[0].tool_call_id, "tool-1");
            assert_eq!(next.tool_cards[0].tool_name, "read");
            assert!(next.tool_cards[0].result.is_some());
        }

        apply_rpc_response(
            &state,
            "old-session",
            &serde_json::json!({
                "type": "response",
                "command": "get_messages",
                "success": true,
                "data": {
                    "messages": [{
                        "id": "handoff-context",
                        "role": "custom",
                        "display": true,
                        "customType": "handoff",
                        "content": [{ "type": "text", "text": "handoff context" }]
                    }]
                }
            }),
        )
        .await;

        let sessions = state.sessions.read().await;
        let previous = sessions
            .get("old-session")
            .expect("previous record remains");
        assert_eq!(previous.messages.len(), 2);
        assert_eq!(previous.messages[0].id, "old-user");

        let next = sessions.get("new-session").expect("new record remains");
        assert_eq!(next.messages.len(), 1);
        assert_eq!(next.messages[0].id, "handoff-context");
    }
}
