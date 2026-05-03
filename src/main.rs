use std::{collections::HashMap, env, sync::Arc, time::Duration};

use anyhow::Context;
use axum::{
    Router,
    routing::{get, post},
};
use clap::Parser;
use tokio::{
    net::TcpListener,
    sync::{RwLock, broadcast},
};
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::{info, warn};
use uuid::Uuid;

mod catalog;
mod code;
mod commands;
mod config;
mod control;
mod omp_rpc;
mod projection;
mod protocol;
mod rpc;
mod session;
mod state;
mod timestamp;
mod voice;
mod web;

use catalog::*;
use code::*;
use commands::*;
use config::*;
use control::*;
use omp_rpc::*;
use projection::*;
use protocol::*;
use rpc::*;
use session::*;
use state::*;
use timestamp::*;
use voice::*;
use web::*;

const SESSION_CATALOG_POLL_INTERVAL: Duration = Duration::from_secs(3);
const SESSION_CATALOG_PRELOAD_LIMIT: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BridgeTokenSource {
    Configured,
    Generated,
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
    let configured_token = args.token.and_then(|token| {
        let trimmed = token.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    });
    let (token, token_source) = match configured_token {
        Some(token) => (token, BridgeTokenSource::Configured),
        None => (generate_token(), BridgeTokenSource::Generated),
    };

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
    let fura_config = load_fura_config(config_path.as_deref());
    let default_cwd = default_cwd_from_config(&fura_config, &startup_cwd);
    let voice_language = fura_config.voice_language.clone();
    let mobile_url = mobile_url(args.mobile_host.as_deref(), args.port);
    let allowed_origins = allowed_origins_from_args(
        args.host,
        args.port,
        args.allowed_origins,
        args.mobile_host.as_deref(),
    );
    let session_categories = fura_config
        .session_categories
        .into_iter()
        .filter_map(|(session_id, category)| {
            normalize_session_category(Some(category))
                .ok()
                .flatten()
                .map(|category| (session_id, category))
        })
        .collect();
    let (events, _) = broadcast::channel(512);
    let state = AppState {
        token: Arc::new(token),
        auth_sessions: Arc::new(RwLock::new(HashMap::new())),
        sessions: Arc::new(RwLock::new(HashMap::new())),
        rpc_sessions: Arc::new(RwLock::new(HashMap::new())),
        rpc_session_targets: Arc::new(RwLock::new(HashMap::new())),
        session_categories: Arc::new(RwLock::new(session_categories)),
        pending_created_sessions: Arc::new(RwLock::new(HashMap::new())),
        pending_new_session_names: Arc::new(RwLock::new(HashMap::new())),
        pending_prompt_drafts: Arc::new(RwLock::new(HashMap::new())),
        code_workspaces: Arc::new(RwLock::new(CodeWorkspaceRegistry::default())),
        bridge_controller: Arc::new(RwLock::new(BridgeControllerState::default())),
        voice_sessions: Arc::new(RwLock::new(HashMap::new())),
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
        voice_language: Arc::new(RwLock::new(voice_language)),
        allowed_origins: Arc::new(allowed_origins),
    };

    start_session_catalog_watcher(state.clone());

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/auth/session", post(auth_session_handler))
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(&args.static_dir).append_index_html_on_directories(true))
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let listener = TcpListener::bind((args.host, args.port))
        .await
        .with_context(|| format!("failed to bind {}:{}", args.host, args.port))?;

    log_server_ready(
        &state,
        args.host,
        args.port,
        mobile_url.as_deref(),
        token_source,
    );

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

fn log_server_ready(
    state: &AppState,
    host: std::net::IpAddr,
    port: u16,
    mobile_url: Option<&str>,
    token_source: BridgeTokenSource,
) {
    info!(
        url = %bridge_listen_url(host, port),
        auth = startup_auth_label(token_source),
        rpc_program = %state.rpc_config.program,
        rpc_arg_count = state.rpc_config.args.len(),
        "fura bridge listening"
    );
    if let Some(mobile_url) = mobile_url {
        info!(url = %mobile_url, "fura mobile URL configured");
    }
    if token_source == BridgeTokenSource::Generated {
        warn!(
            bridge_token = %state.token,
            "generated bridge token; enter it in the Fura auth screen and keep it secret"
        );
    }
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

async fn broadcast_sessions_snapshot(state: &AppState) {
    let sessions = state.sessions.read().await;
    let _ = state.events.send(sessions_snapshot_from_map(&sessions));
}

fn next_rpc_id() -> String {
    Uuid::new_v4().to_string()
}

fn bridge_listen_url(host: std::net::IpAddr, port: u16) -> String {
    format!("http://{host}:{port}/")
}

fn startup_auth_label(token_source: BridgeTokenSource) -> &'static str {
    match token_source {
        BridgeTokenSource::Configured => "configured bridge token",
        BridgeTokenSource::Generated => "generated bridge token",
    }
}

fn generate_token() -> String {
    Uuid::new_v4().simple().to_string()
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
    use std::{
        collections::HashSet,
        fs,
        path::{Path, PathBuf},
    };

    use git2::{BranchType, Repository};
    use serde_json::Value;
    use tokio::{
        fs as async_fs,
        io::BufReader,
        sync::{mpsc, oneshot},
    };

    fn text_message(id: &str, text: &str) -> TranscriptMessage {
        TranscriptMessage {
            id: id.into(),
            role: MessageRole::Assistant,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            timestamp: Timestamp::from_rpc(&serde_json::json!(0)),
            is_new: false,
        }
    }

    fn test_record() -> SessionRecord {
        SessionRecord {
            id: "s1".into(),
            cwd: None,
            args: Vec::new(),
            status: SessionStatus::Idle,
            created_at: Timestamp::from_rpc(&serde_json::json!(0)).expect("valid test timestamp"),
            updated_at: Timestamp::from_rpc(&serde_json::json!(0)).expect("valid test timestamp"),
            messages: Vec::new(),
            live_message_ids: HashSet::new(),
            streaming_message: None,
            tool_cards: Vec::new(),
            active_tool_calls: Vec::new(),
            todo_phases: None,
            kind: SessionKind::Managed,
            session_file: None,
            title: None,
            timestamp: None,
            category: None,
            worktree: None,
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

    fn discovered_session(id: &str, title: Option<&str>, session_file: &Path) -> DiscoveredSession {
        DiscoveredSession {
            id: id.into(),
            preload_index: 0,
            cwd: Some("/workspace/project".into()),
            title: title.map(str::to_string),
            timestamp: Some("2026-04-29T00:00:00.000Z".into()),
            created_at: Timestamp::from_rpc(&serde_json::json!(0)).expect("valid test timestamp"),
            updated_at: Timestamp::from_rpc(&serde_json::json!(1)).expect("valid test timestamp"),
            session_file: session_file.to_string_lossy().into_owned(),
            messages: Vec::new(),
            tool_cards: Vec::new(),
            messages_loaded: false,
        }
    }

    #[test]
    fn opened_session_record_preserves_cached_available_transcript() {
        let session_path = Path::new("/tmp/s1.jsonl");
        let mut existing = test_record();
        existing.kind = SessionKind::Available;
        existing.status = SessionStatus::Available;
        existing.messages = vec![text_message("m1", "cached history")];
        existing.title = Some("Cached title".into());
        existing.tokens_total = 42;

        let discovered = discovered_session("s1", None, session_path);
        let opened = opened_session_record(
            &discovered,
            session_path.to_string_lossy().into_owned(),
            Some("infra".into()),
            Some(&existing),
        );

        assert_eq!(opened.kind, SessionKind::Managed);
        assert_eq!(opened.status, SessionStatus::Starting);
        assert_eq!(opened.messages.len(), 1);
        assert_eq!(opened.messages[0].id, "m1");
        assert_eq!(opened.title.as_deref(), Some("Cached title"));
        assert_eq!(opened.category.as_deref(), Some("infra"));
        assert_eq!(opened.tokens_total, 42);
        assert!(opened.live_message_ids.is_empty());
        assert!(opened.streaming_message.is_none());
        assert!(opened.active_tool_calls.is_empty());
    }

    #[test]
    fn session_summaries_omit_controller_session() {
        let mut normal = test_record();
        normal.id = "normal".into();
        normal.title = Some("Normal session".into());

        let mut controller = test_record();
        controller.id = "controller".into();
        controller.title = Some(CONTROLLER_SESSION_TITLE.into());

        let mut sessions = HashMap::new();
        sessions.insert(normal.id.clone(), normal);
        sessions.insert(controller.id.clone(), controller);

        let summaries = session_summaries_from_map(&sessions);

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].session_id, "normal");
    }

    #[test]
    fn session_summary_preserves_managed_worktree_path() {
        let mut record = test_record();
        record.worktree = Some(SessionWorktreeSummary {
            path: "/repo-feature".to_string(),
        });

        let summary = record.summary();

        assert_eq!(
            summary
                .worktree
                .as_ref()
                .map(|worktree| worktree.path.as_str()),
            Some("/repo-feature")
        );
    }

    #[test]
    fn bridge_listen_url_never_contains_token() {
        let url = bridge_listen_url("127.0.0.1".parse().expect("ip"), 3737);

        assert_eq!(url, "http://127.0.0.1:3737/");
        assert!(!url.contains("token"));
    }

    #[test]
    fn mobile_url_formats_explicit_mobile_host() {
        assert_eq!(
            mobile_url(Some("desktop.tailnet.ts.net"), 3737).as_deref(),
            Some("http://desktop.tailnet.ts.net:3737/")
        );
    }

    #[test]
    fn startup_auth_label_names_token_source_without_secret() {
        assert_eq!(
            startup_auth_label(BridgeTokenSource::Configured),
            "configured bridge token"
        );
        assert_eq!(
            startup_auth_label(BridgeTokenSource::Generated),
            "generated bridge token"
        );
    }

    fn test_state(channel_capacity: usize, bridge_debug_file: Option<PathBuf>) -> AppState {
        let (events, _) = broadcast::channel(channel_capacity);
        AppState {
            token: Arc::new("test".into()),
            auth_sessions: Arc::new(RwLock::new(HashMap::new())),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            rpc_sessions: Arc::new(RwLock::new(HashMap::new())),
            rpc_session_targets: Arc::new(RwLock::new(HashMap::new())),
            session_categories: Arc::new(RwLock::new(HashMap::new())),
            pending_created_sessions: Arc::new(RwLock::new(HashMap::new())),
            pending_new_session_names: Arc::new(RwLock::new(HashMap::new())),
            pending_prompt_drafts: Arc::new(RwLock::new(HashMap::new())),
            code_workspaces: Arc::new(RwLock::new(CodeWorkspaceRegistry::default())),
            bridge_controller: Arc::new(RwLock::new(BridgeControllerState::default())),
            voice_sessions: Arc::new(RwLock::new(HashMap::new())),
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
            voice_language: Arc::new(RwLock::new(default_voice_language())),
            allowed_origins: Arc::new(default_allowed_origins(
                "127.0.0.1".parse().expect("test ip"),
                3737,
            )),
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

    fn write_test_subagent_session(path: &Path, id: &str, cwd: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("subagent session dir should be created");
        }
        let header = serde_json::json!({
            "type": "session",
            "id": id,
            "timestamp": "2026-04-29T00:00:02.000Z",
            "cwd": cwd,
        });
        let session_init = serde_json::json!({
            "type": "session_init",
            "id": format!("{id}-init"),
            "parentId": null,
            "timestamp": "2026-04-29T00:00:03.000Z",
            "systemPrompt": "subagent system prompt",
            "task": "investigate",
            "tools": ["read"],
        });
        fs::write(path, format!("{header}\n{session_init}\n"))
            .expect("subagent session file should be written");
    }

    #[derive(Debug, serde::Deserialize)]
    struct ContractManifestEntry {
        name: String,
        category: String,
        file: String,
    }

    fn read_contract_fixture(file: &str) -> Value {
        let text = fs::read_to_string(Path::new("fixtures/omp-rpc-contract").join(file))
            .unwrap_or_else(|error| panic!("failed to read contract fixture {file}: {error}"));
        serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("failed to parse contract fixture {file}: {error}"))
    }

    #[test]
    fn omp_contract_fixtures_decode_as_typed_frames() {
        let manifest: Vec<ContractManifestEntry> =
            serde_json::from_value(read_contract_fixture("manifest.json"))
                .expect("contract manifest should decode");

        assert!(
            !manifest.is_empty(),
            "contract fixture manifest must not be empty"
        );
        for entry in manifest {
            let value = read_contract_fixture(&entry.file);
            let frame = OmpRpcFrame::decode(value).unwrap_or_else(|error| {
                panic!(
                    "{} ({}) failed to decode: {error}",
                    entry.name, entry.category
                )
            });

            match frame {
                OmpRpcFrame::Response(response) => match response.command.as_str() {
                    "get_state" => {
                        let data: OmpSessionState = serde_json::from_value(
                            response.payload().expect("get_state payload").clone(),
                        )
                        .expect("get_state data should decode");
                        assert!(!data.session_id.is_empty());
                        assert!(
                            !data.todo_phases.is_empty(),
                            "get_state fixture must cover todoPhases compatibility"
                        );
                    }
                    "get_messages" => {
                        let data: OmpMessagesResponse = serde_json::from_value(
                            response.payload().expect("get_messages payload").clone(),
                        )
                        .expect("get_messages data should decode");
                        assert!(!data.messages.is_empty());
                    }
                    "get_session_stats" => {
                        let data: OmpSessionStats = serde_json::from_value(
                            response
                                .payload()
                                .expect("get_session_stats payload")
                                .clone(),
                        )
                        .expect("get_session_stats data should decode");
                        assert!(data.tokens.total > 0);
                    }
                    "get_available_models" => {
                        let data: OmpAvailableModelsResponse = serde_json::from_value(
                            response
                                .payload()
                                .expect("get_available_models payload")
                                .clone(),
                        )
                        .expect("get_available_models data should decode");
                        assert!(!data.models.is_empty());
                    }
                    _ if response.is_error() => {
                        assert!(
                            response.error.is_some(),
                            "error response should carry an error"
                        );
                    }
                    _ => {}
                },
                OmpRpcFrame::Unknown => panic!("{} decoded as unknown", entry.name),
                _ => {}
            }
        }
    }

    #[test]
    fn typed_omp_commands_serialize_to_canonical_wire_shapes() {
        assert_eq!(
            get_state_command("rpc-1".to_string()),
            serde_json::json!({ "id": "rpc-1", "type": "get_state" })
        );
        assert_eq!(
            prompt_command(
                "rpc-2".to_string(),
                "hello".to_string(),
                None,
                Some(PromptBehavior::FollowUp),
            ),
            serde_json::json!({
                "id": "rpc-2",
                "type": "prompt",
                "message": "hello",
                "streamingBehavior": "followUp"
            })
        );
        assert_eq!(
            set_model_command(
                "rpc-3".to_string(),
                "anthropic".to_string(),
                "claude-sonnet-4-5".to_string(),
            ),
            serde_json::json!({
                "id": "rpc-3",
                "type": "set_model",
                "provider": "anthropic",
                "modelId": "claude-sonnet-4-5"
            })
        );
        assert_eq!(
            repo_diff_get_command(
                "rpc-4".to_string(),
                Some("session-start".to_string()),
                Some("current".to_string()),
                true,
            ),
            serde_json::json!({
                "id": "rpc-4",
                "type": "repo_diff_get",
                "selector": "session-start",
                "headSelector": "current",
                "stat": true
            })
        );
        assert_eq!(
            repo_diff_snapshot_command("rpc-5".to_string(), None),
            serde_json::json!({ "id": "rpc-5", "type": "repo_diff_snapshot" })
        );
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
        state.config_path = Some(root.join("config.yaml"));
        state.session_categories.write().await.extend([
            ("s1".to_string(), "infra".to_string()),
            ("missing-session".to_string(), "stale".to_string()),
        ]);

        assert!(refresh_session_catalog(&state).await);
        let sessions = state.sessions.read().await;
        let record = sessions.get("s1").expect("session should be discovered");
        assert_eq!(record.kind, SessionKind::Available);
        assert_eq!(record.status, SessionStatus::Available);
        assert_eq!(record.title.as_deref(), Some("External session"));
        assert_eq!(record.cwd.as_deref(), Some("/workspace/project"));
        assert_eq!(record.category.as_deref(), Some("infra"));
        assert_eq!(record.messages.len(), 1);
        assert_eq!(
            record.session_file.as_deref(),
            Some(session_path.to_string_lossy().as_ref())
        );
        drop(sessions);
        let categories = state.session_categories.read().await;
        assert_eq!(categories.get("s1").map(String::as_str), Some("infra"));
        assert!(!categories.contains_key("missing-session"));
        drop(categories);
        let saved_config_text = fs::read_to_string(root.join("config.yaml"))
            .expect("category pruning should save Fura config");
        let saved_config: FuraConfig =
            serde_yaml::from_str(&saved_config_text).expect("saved config should parse");
        assert_eq!(
            saved_config
                .session_categories
                .get("s1")
                .map(String::as_str),
            Some("infra"),
        );
        assert!(
            !saved_config
                .session_categories
                .contains_key("missing-session")
        );

        assert!(!refresh_session_catalog(&state).await);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn refresh_session_catalog_does_not_erase_known_title_when_header_lacks_one() {
        let root = env::temp_dir().join(format!(
            "fura-sessions-title-preserve-test-{}",
            Uuid::new_v4().simple()
        ));
        let session_path = root.join("project").join("s1.jsonl");
        fs::create_dir_all(session_path.parent().expect("session parent")).expect("session dir");
        let header = serde_json::json!({
            "type": "session",
            "id": "s1",
            "timestamp": "2026-04-29T00:00:00.000Z",
            "cwd": "/workspace/project",
        });
        fs::write(&session_path, format!("{header}\n")).expect("session file should be written");

        let mut state = test_state(8, None);
        state.session_root = root.clone();
        let mut record = test_record();
        record.id = "s1".into();
        record.kind = SessionKind::Available;
        record.status = SessionStatus::Available;
        record.title = Some("Known live title".into());
        record.session_file = Some(session_path.to_string_lossy().into_owned());
        state.sessions.write().await.insert("s1".into(), record);

        assert!(refresh_session_catalog(&state).await);
        let sessions = state.sessions.read().await;
        let record = sessions.get("s1").expect("session should remain");
        assert_eq!(record.title.as_deref(), Some("Known live title"));
        drop(sessions);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_session_header_falls_back_to_first_user_prompt_title() {
        let root = env::temp_dir().join(format!(
            "fura-sessions-title-fallback-test-{}",
            Uuid::new_v4().simple()
        ));
        let session_path = root.join("project").join("s1.jsonl");
        fs::create_dir_all(session_path.parent().expect("session parent")).expect("session dir");
        let header = serde_json::json!({
            "type": "session",
            "id": "s1",
            "timestamp": "2026-04-29T00:00:00.000Z",
            "cwd": "/workspace/project",
        });
        let message = serde_json::json!({
            "type": "message",
            "message": {
                "id": "m1",
                "role": "user",
                "content": [{ "type": "text", "text": "  First request\nwith details" }]
            }
        });
        fs::write(&session_path, format!("{header}\n{message}\n"))
            .expect("session file should be written");

        let discovered = read_session_header(&session_path).expect("session should be discovered");
        assert_eq!(discovered.title.as_deref(), Some("First request"));

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn refresh_session_catalog_ignores_task_subagent_artifacts() {
        let root = env::temp_dir().join(format!(
            "fura-subagent-sessions-test-{}",
            Uuid::new_v4().simple()
        ));
        let parent_path = root.join("project").join("parent.jsonl");
        let subagent_path = root.join("project").join("parent").join("Explore.jsonl");
        write_test_session(
            &parent_path,
            "parent",
            "Parent session",
            "/workspace/project",
            "plan with subagents",
        );
        write_test_subagent_session(&subagent_path, "subagent", "/workspace/project");
        let mut state = test_state(8, None);
        state.session_root = root.clone();

        assert!(refresh_session_catalog(&state).await);
        let sessions = state.sessions.read().await;
        assert!(sessions.contains_key("parent"));
        assert!(
            !sessions.contains_key("subagent"),
            "task subagent artifact session must not appear in the top-level session catalog"
        );
        assert_eq!(sessions.len(), 1);
        drop(sessions);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_session_header_rejects_subagent_session_init_files() {
        let root = env::temp_dir().join(format!(
            "fura-subagent-header-test-{}",
            Uuid::new_v4().simple()
        ));
        let subagent_path = root.join("Explore.jsonl");
        write_test_subagent_session(&subagent_path, "subagent", "/workspace/project");

        assert!(
            read_session_header(&subagent_path).is_none(),
            "session_init identifies task subagent logs, not resumable top-level sessions"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn session_set_category_updates_record_and_persisted_map() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());

        let responses =
            set_session_category(&state, "s1".to_string(), Some(" infra ".to_string())).await;
        assert_eq!(responses.len(), 2);
        let sessions = state.sessions.read().await;
        assert_eq!(
            sessions
                .get("s1")
                .and_then(|record| record.category.as_deref()),
            Some("infra"),
        );
        drop(sessions);
        assert_eq!(
            state
                .session_categories
                .read()
                .await
                .get("s1")
                .map(String::as_str),
            Some("infra"),
        );

        let responses =
            set_session_category(&state, "s1".to_string(), Some("   ".to_string())).await;
        assert_eq!(responses.len(), 2);
        let sessions = state.sessions.read().await;
        assert_eq!(
            sessions
                .get("s1")
                .and_then(|record| record.category.as_ref()),
            None
        );
        drop(sessions);
        assert!(!state.session_categories.read().await.contains_key("s1"));
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
    async fn plan_review_event_emits_review_message() {
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

        apply_rpc_frame(
            &state,
            "transport-1",
            &serde_json::json!({
                "type": "plan_review",
                "sessionId": "omp-session-id",
                "planFilePath": "local://PLAN.md",
                "finalPlanFilePath": "local://APPROVED.md",
                "title": "APPROVED",
                "content": "# Plan"
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
    async fn extension_ui_request_event_emits_dialog_request() {
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

        apply_rpc_frame(
            &state,
            "transport-1",
            &serde_json::json!({
                "type": "extension_ui_request",
                "id": "dialog-1",
                "method": "confirm",
                "title": "Continue?",
                "message": "Approve the operation?",
                "timeout": 30000
            }),
        )
        .await;

        match events.recv().await.expect("dialog request event") {
            ServerMessage::DialogRequest { session_id, dialog } => {
                assert_eq!(session_id, "s1");
                assert_eq!(dialog["id"], "dialog-1");
                assert_eq!(dialog["method"], "confirm");
                assert_eq!(dialog["title"], "Continue?");
                assert_eq!(dialog["message"], "Approve the operation?");
                assert_eq!(dialog["timeout"], 30000);
                assert!(dialog.get("type").is_none());
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[tokio::test]
    async fn exit_plan_mode_tool_end_does_not_request_preview() {
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
            .insert("transport-1".to_string(), RpcSessionHandle { stdin, stop });
        state
            .rpc_session_targets
            .write()
            .await
            .insert("transport-1".to_string(), "s1".to_string());

        apply_rpc_frame(
            &state,
            "transport-1",
            &serde_json::json!({
                "type": "tool_execution_end",
                "toolCallId": "tool-1",
                "toolName": "exit_plan_mode",
                "isError": false,
                "result": {
                    "details": {
                        "planFilePath": "local://PLAN.md",
                        "finalPlanFilePath": "local://APPROVED.md",
                        "title": "APPROVED"
                    }
                }
            }),
        )
        .await;

        assert!(
            commands.try_recv().is_err(),
            "plan review should arrive as an OMP RPC event, not as a bridge-synthesized preview request"
        );
    }

    #[tokio::test]
    async fn agent_end_refresh_uses_remapped_session_id_after_get_state() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("transport-1".to_string(), test_record());
        let (stdin, mut commands) = mpsc::channel(8);
        let (stop, _stop_rx) = oneshot::channel();
        state
            .rpc_sessions
            .write()
            .await
            .insert("transport-1".to_string(), RpcSessionHandle { stdin, stop });
        state
            .rpc_session_targets
            .write()
            .await
            .insert("transport-1".to_string(), "transport-1".to_string());

        apply_rpc_response(
            &state,
            "transport-1",
            &serde_json::json!({
                "type": "response",
                "command": "get_state",
                "success": true,
                "data": {
                    "sessionId": "real-s1",
                    "sessionName": "Real Session",
                    "messageCount": 0
                }
            }),
        )
        .await;

        apply_rpc_frame(
            &state,
            "transport-1",
            &serde_json::json!({ "type": "agent_end" }),
        )
        .await;

        let first = commands.recv().await.expect("first refresh command");
        let second = commands.recv().await.expect("second refresh command");
        assert_eq!(
            first.get("type").and_then(|value| value.as_str()),
            Some("get_messages")
        );
        assert_eq!(
            second.get("type").and_then(|value| value.as_str()),
            Some("get_session_stats")
        );
        assert_eq!(
            state
                .rpc_session_targets
                .read()
                .await
                .get("transport-1")
                .map(String::as_str),
            Some("real-s1")
        );
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
    async fn rpc_agent_busy_prompt_error_returns_busy_choice_without_notice() {
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
            "queue this safely".to_string(),
            Some(vec![serde_json::json!({
                "type": "image",
                "data": "abc123",
                "mimeType": "image/png"
            })]),
            None,
        )
        .await;

        assert_eq!(responses.len(), 1);
        match &responses[0] {
            ServerMessage::SessionSnapshot { session_id, state } => {
                assert_eq!(session_id, "s1");
                assert!(state.is_busy);
            }
            other => panic!("unexpected response: {other:?}"),
        }
        let command = commands.recv().await.expect("prompt command sent");
        let command_id = command
            .get("id")
            .and_then(|value| value.as_str())
            .expect("prompt command id")
            .to_string();
        assert_eq!(
            command.get("type").and_then(|value| value.as_str()),
            Some("prompt")
        );
        assert!(
            state
                .pending_prompt_drafts
                .read()
                .await
                .contains_key(&command_id),
            "regular prompt draft should be retained until OMP accepts or rejects it"
        );

        let mut events = state.events.subscribe();
        apply_rpc_response(
            &state,
            "s1",
            &serde_json::json!({
                "id": command_id,
                "type": "response",
                "command": "prompt",
                "success": false,
                "error": "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion."
            }),
        )
        .await;

        match events.recv().await.expect("prompt busy event") {
            ServerMessage::PromptBusy {
                session_id,
                text,
                images,
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(text, "queue this safely");
                let images = images.expect("image attachments are preserved");
                assert_eq!(images.len(), 1);
                assert_eq!(
                    images[0].get("mimeType").and_then(|value| value.as_str()),
                    Some("image/png")
                );
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert!(
            events.try_recv().is_err(),
            "busy prompt path should not also surface a generic error notice"
        );
        assert!(
            state.pending_prompt_drafts.read().await.is_empty(),
            "busy prompt draft should be consumed after notifying the client"
        );
        let sessions = state.sessions.read().await;
        assert_eq!(
            sessions.get("s1").expect("record remains").status,
            SessionStatus::Busy,
            "AgentBusyError means OMP is still processing, not that the turn settled"
        );
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
            ClientMessage::SessionCreate {
                cwd,
                name,
                args,
                worktree,
                request_id,
                ..
            } => {
                assert_eq!(cwd.as_deref(), Some("/tmp"));
                assert_eq!(name, None);
                assert_eq!(args, Some(vec!["--debug".to_string()]));
                assert!(worktree.is_none());
                assert_eq!(request_id, None);
            }
            other => panic!("unexpected message: {other:?}"),
        }

        // With name
        let message = serde_json::from_str::<ClientMessage>(
            r#"{"type":"session.create","requestId":"create-1","cwd":"/tmp","name":"my-project","category":"infra","args":[]}"#,
        )
        .expect("message should parse");
        match message {
            ClientMessage::SessionCreate {
                cwd,
                name,
                args,
                category,
                worktree,
                request_id,
                ..
            } => {
                assert_eq!(cwd.as_deref(), Some("/tmp"));
                assert_eq!(name.as_deref(), Some("my-project"));
                assert_eq!(args, Some(vec![] as Vec<String>));
                assert_eq!(category.as_deref(), Some("infra"));
                assert!(worktree.is_none());
                assert_eq!(request_id.as_deref(), Some("create-1"));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn parses_session_set_category_message() {
        let message = serde_json::from_str::<ClientMessage>(
            r#"{"type":"session.setCategory","sessionId":"abc-123","category":"ops"}"#,
        )
        .expect("message should parse");

        match message {
            ClientMessage::SessionSetCategory {
                session_id,
                category,
            } => {
                assert_eq!(session_id, "abc-123");
                assert_eq!(category.as_deref(), Some("ops"));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[test]
    fn parses_session_create_worktree_options() {
        let message = serde_json::from_str::<ClientMessage>(
            r#"{"type":"session.create","name":"feature","worktree":{"sourceRepo":"/repo","directory":"../repo-feature","baseBranch":"main","branchName":"feature/work"}}"#,
        )
        .expect("message should parse");

        match message {
            ClientMessage::SessionCreate { cwd, worktree, .. } => {
                assert_eq!(cwd, None);
                let worktree = worktree.expect("worktree options should parse");
                assert_eq!(worktree.source_repo, "/repo");
                assert_eq!(worktree.directory, "../repo-feature");
                assert_eq!(worktree.base_branch, "main");
                assert_eq!(worktree.branch_name.as_deref(), Some("feature/work"));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }

    #[tokio::test]
    async fn session_create_worktree_error_preserves_request_id() {
        let state = test_state(8, None);
        let missing_repo = env::temp_dir().join(format!(
            "fura-missing-worktree-source-{}",
            Uuid::new_v4().simple()
        ));

        let responses = handle_client_message(
            &state,
            ClientMessage::SessionCreate {
                request_id: Some("create-1".to_string()),
                cwd: None,
                name: Some("feature".to_string()),
                args: None,
                category: None,
                worktree: Some(WorktreeCreateRequest {
                    source_repo: missing_repo.to_string_lossy().into_owned(),
                    directory: env::temp_dir()
                        .join(format!("fura-worktree-target-{}", Uuid::new_v4().simple()))
                        .to_string_lossy()
                        .into_owned(),
                    base_branch: "HEAD".to_string(),
                    branch_name: Some("feature/request-id".to_string()),
                }),
            },
        )
        .await;

        match responses.as_slice() {
            [
                ServerMessage::Error {
                    request_id,
                    message,
                },
            ] => {
                assert_eq!(request_id.as_deref(), Some("create-1"));
                assert!(
                    message.starts_with("worktree creation failed:"),
                    "unexpected message: {message}"
                );
            }
            other => panic!("unexpected responses: {other:?}"),
        }
    }

    #[tokio::test]
    async fn dialog_respond_sends_rpc_extension_ui_response() {
        let state = test_state(8, None);
        let (stdin, mut commands) = mpsc::channel(4);
        let (stop, _stop_rx) = oneshot::channel();
        state
            .rpc_sessions
            .write()
            .await
            .insert("s1".to_string(), RpcSessionHandle { stdin, stop });

        let responses = handle_client_message(
            &state,
            ClientMessage::DialogRespond {
                session_id: "s1".to_string(),
                dialog_id: "dialog-1".to_string(),
                response: serde_json::json!({ "confirmed": true }),
            },
        )
        .await;

        assert!(responses.is_empty());
        let command = commands.recv().await.expect("dialog response command sent");
        assert_eq!(
            command.get("type").and_then(Value::as_str),
            Some("extension_ui_response")
        );
        assert_eq!(command.get("id").and_then(Value::as_str), Some("dialog-1"));
        assert_eq!(
            command.get("confirmed").and_then(Value::as_bool),
            Some(true)
        );
        assert!(command.get("requestId").is_none());
        assert!(command.get("response").is_none());
    }

    #[tokio::test]
    async fn dialog_respond_rejects_non_object_response() {
        let state = test_state(8, None);

        let responses = handle_client_message(
            &state,
            ClientMessage::DialogRespond {
                session_id: "s1".to_string(),
                dialog_id: "dialog-1".to_string(),
                response: Value::String("yes".to_string()),
            },
        )
        .await;

        match responses.as_slice() {
            [ServerMessage::Error { message, .. }] => {
                assert_eq!(message, "dialog response must be a JSON object");
            }
            other => panic!("unexpected responses: {other:?}"),
        }
    }

    #[tokio::test]
    async fn delete_session_rejects_unknown_worktree_deletion() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());

        let responses = delete_session(&state, "s1".to_string(), true).await;

        match responses.as_slice() {
            [ServerMessage::Error { message, .. }] => {
                assert_eq!(
                    message,
                    "session delete requested worktree deletion, but this session has no Fura-managed worktree"
                );
            }
            other => panic!("unexpected responses: {other:?}"),
        }
        assert!(state.sessions.read().await.contains_key("s1"));
    }

    #[test]
    fn creates_git_worktree_from_base_branch() {
        let root = env::temp_dir().join(format!("fura-worktree-test-{}", Uuid::new_v4().simple()));
        let repo_dir = root.join("repo");
        let worktree_dir = root.join("repo-feature");
        fs::create_dir_all(&repo_dir).expect("repo dir should be created");
        let repo = Repository::init(&repo_dir).expect("repo should init");
        fs::write(repo_dir.join("README.md"), "base\n").expect("file should be written");
        let mut index = repo.index().expect("index should open");
        index
            .add_path(Path::new("README.md"))
            .expect("file should be added");
        index.write().expect("index should write");
        let tree_id = index.write_tree().expect("tree should write");
        let tree = repo.find_tree(tree_id).expect("tree should exist");
        let signature = git2::Signature::now("Fura Test", "fura@example.invalid")
            .expect("signature should be valid");
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .expect("initial commit should succeed");
        let base_branch = repo
            .head()
            .expect("head should exist")
            .shorthand()
            .expect("head should have shorthand")
            .to_string();
        drop(tree);
        drop(index);

        let created = create_git_worktree_sync(&WorktreeCreateRequest {
            source_repo: repo_dir.to_string_lossy().into_owned(),
            directory: worktree_dir.to_string_lossy().into_owned(),
            base_branch,
            branch_name: Some("feature/worktree-test".to_string()),
        })
        .expect("worktree should be created");

        assert_eq!(created.source_repo_root, repo_dir);
        assert_eq!(created.worktree_root, worktree_dir);
        assert_eq!(created.session_cwd, worktree_dir);
        assert_eq!(
            fs::read_to_string(created.session_cwd.join("README.md"))
                .expect("worktree file should exist"),
            "base\n"
        );
        repo.find_branch("feature/worktree-test", BranchType::Local)
            .expect("branch should be created");
        drop(repo);
        fs::remove_dir_all(root).expect("temp worktree repo should be removed");
    }

    #[test]
    fn deletes_linked_worktree() {
        let root = env::temp_dir().join(format!(
            "fura-worktree-delete-test-{}",
            Uuid::new_v4().simple()
        ));
        let repo_dir = root.join("repo");
        let worktree_dir = root.join("repo-feature");
        fs::create_dir_all(&repo_dir).expect("repo dir should be created");
        fs::write(repo_dir.join("README.md"), "base\n").expect("file should be written");

        let repo = Repository::init(&repo_dir).expect("repo should init");
        let mut index = repo.index().expect("index should open");
        index
            .add_path(Path::new("README.md"))
            .expect("file should be added");
        index.write().expect("index should write");
        let tree_id = index.write_tree().expect("tree should write");
        let tree = repo.find_tree(tree_id).expect("tree should exist");
        let signature = git2::Signature::now("Fura Test", "fura@example.invalid")
            .expect("signature should be valid");
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .expect("initial commit should succeed");
        let base_branch = repo
            .head()
            .expect("head should exist")
            .shorthand()
            .expect("head should have shorthand")
            .to_string();
        drop(tree);
        drop(index);

        create_git_worktree_sync(&WorktreeCreateRequest {
            source_repo: repo_dir.to_string_lossy().into_owned(),
            directory: worktree_dir.to_string_lossy().into_owned(),
            base_branch,
            branch_name: Some("feature/delete-worktree-test".to_string()),
        })
        .expect("worktree should be created");

        delete_git_worktree_sync(&worktree_dir).expect("linked worktree should be deleted");
        assert!(
            !worktree_dir.exists(),
            "worktree directory should be removed from disk"
        );

        drop(repo);
        fs::remove_dir_all(root).expect("temp worktree repo should be removed");
    }
    #[test]
    fn rejects_worktree_source_that_is_not_repo_root() {
        let root = env::temp_dir().join(format!(
            "fura-worktree-subdir-test-{}",
            Uuid::new_v4().simple()
        ));
        let repo_dir = root.join("repo");
        let source_cwd = repo_dir.join("packages").join("app");
        let worktree_dir = root.join("repo-feature");
        fs::create_dir_all(&source_cwd).expect("source subdir should be created");
        let repo = Repository::init(&repo_dir).expect("repo should init");
        fs::write(source_cwd.join("README.md"), "subdir\n").expect("file should be written");
        let mut index = repo.index().expect("index should open");
        index
            .add_path(Path::new("packages/app/README.md"))
            .expect("file should be added");
        index.write().expect("index should write");
        let tree_id = index.write_tree().expect("tree should write");
        let tree = repo.find_tree(tree_id).expect("tree should exist");
        let signature = git2::Signature::now("Fura Test", "fura@example.invalid")
            .expect("signature should be valid");
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .expect("initial commit should succeed");
        let base_branch = repo
            .head()
            .expect("head should exist")
            .shorthand()
            .expect("head should have shorthand")
            .to_string();
        drop(tree);
        drop(index);

        let error = create_git_worktree_sync(&WorktreeCreateRequest {
            source_repo: source_cwd.to_string_lossy().into_owned(),
            directory: worktree_dir.to_string_lossy().into_owned(),
            base_branch,
            branch_name: Some("feature/subdir-worktree-test".to_string()),
        })
        .expect_err("source must be the repo root containing .git");

        assert!(
            error
                .to_string()
                .contains("worktree source repo root must contain .git"),
            "unexpected error: {error}"
        );
        drop(repo);
        fs::remove_dir_all(root).expect("temp worktree repo should be removed");
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
        match msg {
            ClientMessage::SessionDelete {
                session_id,
                delete_worktree,
            } => {
                assert_eq!(session_id, "abc-123");
                assert!(!delete_worktree);
            }
            other => panic!("unexpected message: {other:?}"),
        }

        let msg: ClientMessage = serde_json::from_str(
            r#"{"type":"session.delete","sessionId":"abc-123","deleteWorktree":true}"#,
        )
        .expect("parse failed");
        match msg {
            ClientMessage::SessionDelete {
                session_id,
                delete_worktree,
            } => {
                assert_eq!(session_id, "abc-123");
                assert!(delete_worktree);
            }
            other => panic!("unexpected message: {other:?}"),
        }
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
                }],
                "timestamp": 1770000003000_u64
            }),
            serde_json::json!({
                "id": "tr1",
                "role": "toolResult",
                "toolCallId": "task-call",
                "toolName": "task",
                "content": [{ "type": "text", "text": "<task-summary>raw summary</task-summary>" }],
                "timestamp": 1770000004000_u64,
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
        assert_eq!(card.timestamp.map(Timestamp::millis), Some(1770000003000));
        assert_eq!(
            card.result.as_ref().unwrap()["details"]["results"][0]["id"],
            "0-Review"
        );
    }

    #[test]
    fn projects_current_todos_from_historical_todo_write_card() {
        let raw_messages = vec![
            serde_json::json!({
                "id": "a1",
                "role": "assistant",
                "content": [{
                    "type": "toolCall",
                    "id": "todo-call",
                    "name": "todo_write",
                    "arguments": { "ops": [{ "op": "done", "task": "Check UI" }] }
                }]
            }),
            serde_json::json!({
                "id": "tr1",
                "role": "toolResult",
                "toolCallId": "todo-call",
                "toolName": "todo_write",
                "content": [{ "type": "text", "text": "Remaining items: none." }],
                "details": {
                    "phases": [{
                        "name": "Investigation",
                        "tasks": [
                            { "content": "Check UI", "status": "completed" },
                            { "content": "Run smoke", "status": "in_progress", "notes": ["Use mock RPC"] }
                        ]
                    }],
                    "storage": "session"
                },
                "isError": false
            }),
        ];

        let (_messages, tool_cards) = project_omp_transcript(&raw_messages);
        let mut record = test_record();
        record.tool_cards = tool_cards;
        let projection = record.projection();

        assert_eq!(projection.todo_phases.len(), 1);
        assert_eq!(projection.todo_phases[0].name, "Investigation");
        assert_eq!(
            projection.todo_phases[0].tasks[0].status,
            TodoStatusProjection::Completed
        );
        assert_eq!(
            projection.todo_phases[0].tasks[1].status,
            TodoStatusProjection::InProgress
        );
        assert_eq!(
            projection.todo_phases[0].tasks[1].notes,
            vec!["Use mock RPC".to_string()]
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
                voice_language: default_voice_language(),
                session_categories: HashMap::new(),
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
                voice_language: default_voice_language(),
                session_categories: HashMap::new(),
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
                assert_eq!(config.voice_language, "pl-PL");
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
                voice_language: "pl-PL".to_string(),
            },
        })
        .expect("hello should serialize");

        assert_eq!(json["type"], "hello");
        assert_eq!(json["serverVersion"], "0.1.0");
        assert_eq!(json["protocolVersion"], 1);
        assert_eq!(json["config"]["defaultCwd"], "/workspace");
        assert_eq!(json["config"]["voiceLanguage"], "pl-PL");
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
    fn maps_image_content_block_without_exposing_base64_as_text() {
        let message = map_omp_message(&serde_json::json!({
            "id": "img1",
            "role": "assistant",
            "content": [
                { "type": "text", "text": "Generated image:" },
                { "type": "image", "data": "aW1hZ2UtYnl0ZXM=", "mimeType": "image/png", "alt": "Generated chart" }
            ]
        }))
        .expect("message should map");

        assert_eq!(message.blocks.len(), 2);
        match &message.blocks[1] {
            ContentBlock::Image {
                data,
                mime_type,
                alt,
            } => {
                assert_eq!(data, "aW1hZ2UtYnl0ZXM=");
                assert_eq!(mime_type, "image/png");
                assert_eq!(alt.as_deref(), Some("Generated chart"));
            }
            other => panic!("expected image block, got {other:?}"),
        }

        let text = content_to_text(&serde_json::json!([
            { "type": "image", "data": "aW1hZ2UtYnl0ZXM=", "mimeType": "image/png" }
        ]));
        assert_eq!(text, "[Image: image/png]");
    }

    #[test]
    fn maps_user_image_content_for_transcript_roundtrip() {
        let message = map_omp_message(&serde_json::json!({
            "id": "user-img",
            "role": "user",
            "content": [
                { "type": "text", "text": "Please inspect this." },
                { "type": "image", "data": "c2NyZWVuc2hvdA==", "mimeType": "image/jpeg" }
            ],
            "timestamp": 1234
        }))
        .expect("user image message should map");

        assert!(matches!(message.role, MessageRole::User));
        assert_eq!(message.blocks.len(), 2);
        match &message.blocks[1] {
            ContentBlock::Image {
                data,
                mime_type,
                alt,
            } => {
                assert_eq!(data, "c2NyZWVuc2hvdA==");
                assert_eq!(mime_type, "image/jpeg");
                assert!(alt.is_none());
            }
            other => panic!("expected image block, got {other:?}"),
        }
    }

    #[test]
    fn project_omp_transcript_preserves_user_image_blocks() {
        let raw_messages = vec![serde_json::json!({
            "id": "user-img",
            "role": "user",
            "content": [{ "type": "image", "data": "abc123", "mimeType": "image/png" }]
        })];

        let (messages, tool_cards) = project_omp_transcript(&raw_messages);

        assert!(tool_cards.is_empty());
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "user-img");
        assert!(matches!(messages[0].role, MessageRole::User));
        assert!(matches!(messages[0].blocks[0], ContentBlock::Image { .. }));
    }

    #[test]
    fn ignores_incomplete_image_content_blocks() {
        let result = map_omp_message(&serde_json::json!({
            "id": "img2",
            "role": "assistant",
            "content": [
                { "type": "image", "data": "aW1hZ2UtYnl0ZXM=" },
                { "type": "image", "mimeType": "image/png" }
            ]
        }));

        assert!(
            result.is_none(),
            "incomplete image-only content should be suppressed"
        );
    }
    #[test]
    fn maps_omp_message_timestamp() {
        let message = map_omp_message(&serde_json::json!({
            "id": "timed",
            "role": "assistant",
            "content": [{ "type": "text", "text": "timed" }],
            "timestamp": 1770000001234_u64
        }))
        .expect("message should map");

        assert_eq!(
            message.timestamp.map(Timestamp::millis),
            Some(1770000001234)
        );
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
    async fn message_end_uses_top_level_event_timestamp() {
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
                "type": "message_end",
                "timestamp": 1770000005000_u64,
                "message": {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "done" }]
                }
            }),
        )
        .await;

        let sessions = state.sessions.read().await;
        let record = sessions.get("s1").expect("record remains");
        assert_eq!(
            record.messages[0].timestamp.map(Timestamp::millis),
            Some(1770000005000)
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
            timestamp: Timestamp::from_rpc(&serde_json::json!(0)),
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
    async fn get_state_updates_current_todo_projection() {
        let state = test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_record());

        apply_rpc_response(
            &state,
            "s1",
            &serde_json::json!({
                "type": "response",
                "command": "get_state",
                "success": true,
                "data": {
                    "sessionId": "s1",
                    "todoPhases": [{
                        "name": "Verification",
                        "tasks": [
                            { "content": "Run frontend build", "status": "completed" },
                            { "content": "Smoke current todos", "status": "pending" }
                        ]
                    }]
                }
            }),
        )
        .await;

        let sessions = state.sessions.read().await;
        let projection = sessions.get("s1").expect("session exists").projection();
        assert_eq!(projection.todo_phases.len(), 1);
        assert_eq!(
            projection.todo_phases[0].tasks[0].status,
            TodoStatusProjection::Completed
        );
        assert_eq!(
            projection.todo_phases[0].tasks[1].content,
            "Smoke current todos"
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
                request_id: Some("create-1".to_string()),
                category: Some("infra".to_string()),
                worktree: None,
                created_at: Timestamp::from_rpc(&serde_json::json!(123_000))
                    .expect("valid test timestamp"),
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
            assert_eq!(next.created_at.millis(), 123_000);
            assert_eq!(next.session_file.as_deref(), Some("omp-session.jsonl"));
            assert_eq!(next.title.as_deref(), Some("diffs2"));
            assert_eq!(next.category.as_deref(), Some("infra"));
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
        assert_eq!(
            state
                .session_categories
                .read()
                .await
                .get("omp-session")
                .map(String::as_str),
            Some("infra"),
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
                assert_eq!(state.summary.category.as_deref(), Some("infra"));
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
    async fn rpc_transport_session_id_accepts_live_transport_id() {
        let state = test_state(8, None);
        let (stdin, _commands) = mpsc::channel(1);
        let (stop, _stop_rx) = oneshot::channel();
        state.rpc_sessions.write().await.insert(
            "transport-live".to_string(),
            RpcSessionHandle { stdin, stop },
        );
        state
            .rpc_session_targets
            .write()
            .await
            .insert("transport-live".to_string(), "real-session".to_string());

        assert_eq!(
            rpc_transport_session_id(&state, "transport-live")
                .await
                .as_deref(),
            Some("transport-live")
        );
        assert_eq!(
            rpc_transport_session_id(&state, "real-session")
                .await
                .as_deref(),
            Some("transport-live")
        );
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
        state.pending_new_session_names.write().await.insert(
            "old-session".to_string(),
            "Requested handoff name".to_string(),
        );

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
                    "sessionName": "Model generated fallback"
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
            assert_eq!(next.title.as_deref(), Some("Requested handoff name"));
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
            state
                .pending_new_session_names
                .read()
                .await
                .get("old-session")
                .is_none(),
            "pending handoff name should be consumed once the new session id is known"
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
