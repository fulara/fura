use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use anyhow::anyhow;
use axum::{
    Json,
    extract::{
        Json as JsonBody, Query, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, close_code},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::{
    AppState, AuthSession, ClientMessage, ServerMessage, client_config, handle_client_message,
    refresh_session_catalog, sessions_snapshot_from_map,
};

const AUTH_SESSION_COOKIE: &str = "fura_session";
const AUTH_SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const MAX_CLIENT_TEXT_FRAME_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct WebSocketQuery {
    client: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebSocketUpdateMode {
    Immediate,
    ConflateAndDelta,
}

impl WebSocketUpdateMode {
    fn from_client(client: Option<&str>) -> Self {
        match client {
            Some("mobile") => Self::ConflateAndDelta,
            _ => Self::Immediate,
        }
    }

    fn uses_conflation(self) -> bool {
        matches!(self, Self::ConflateAndDelta)
    }

    fn uses_session_deltas(self) -> bool {
        matches!(self, Self::ConflateAndDelta)
    }
}
#[derive(Debug, Deserialize)]
pub(crate) struct AuthSessionRequest {
    token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebSocketAuth {
    SessionCookie,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OriginError {
    Missing,
    Invalid,
    NotAllowed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AuthError {
    MissingOrInvalidSession,
}

pub(crate) async fn auth_session_handler(
    State(state): State<AppState>,
    JsonBody(payload): JsonBody<AuthSessionRequest>,
) -> Response {
    if payload.token != *state.token.as_ref() {
        return (StatusCode::UNAUTHORIZED, "missing or invalid token").into_response();
    }

    let mut auth_sessions = state.auth_sessions.write().await;
    build_auth_session_response(
        issue_auth_session(&mut auth_sessions, Instant::now()),
        state.secure_auth_cookie,
    )
}

pub(crate) fn authenticate_websocket_origin(
    headers: &HeaderMap,
    allowed_origins: &[String],
) -> Result<(), OriginError> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Err(OriginError::Missing);
    };
    let origin = origin.to_str().map_err(|_| OriginError::Invalid)?;
    if allowed_origins.iter().any(|allowed| allowed == origin) {
        Ok(())
    } else {
        Err(OriginError::NotAllowed)
    }
}

pub(crate) async fn authenticate_websocket_headers(
    headers: &HeaderMap,
    state: &AppState,
    now: Instant,
) -> Result<WebSocketAuth, AuthError> {
    let Some(session_id) = auth_session_cookie(headers) else {
        return Err(AuthError::MissingOrInvalidSession);
    };
    let mut auth_sessions = state.auth_sessions.write().await;
    authenticate_session_id(&mut auth_sessions, &session_id, now)
}

pub(crate) fn issue_auth_session(
    auth_sessions: &mut HashMap<String, AuthSession>,
    now: Instant,
) -> String {
    auth_sessions.retain(|_, session| session.expires_at > now);
    let session_id = uuid::Uuid::new_v4().simple().to_string();
    auth_sessions.insert(
        session_id.clone(),
        AuthSession {
            expires_at: now + AUTH_SESSION_TTL,
        },
    );
    session_id
}

pub(crate) fn build_auth_session_response(session_id: String, secure: bool) -> Response {
    (
        StatusCode::NO_CONTENT,
        [(
            header::SET_COOKIE,
            auth_session_cookie_header(&session_id, secure),
        )],
    )
        .into_response()
}

pub(crate) fn authenticate_session_id(
    auth_sessions: &mut HashMap<String, AuthSession>,
    session_id: &str,
    now: Instant,
) -> Result<WebSocketAuth, AuthError> {
    match auth_sessions.get(session_id) {
        Some(session) if session.expires_at > now => Ok(WebSocketAuth::SessionCookie),
        Some(_) => {
            auth_sessions.remove(session_id);
            Err(AuthError::MissingOrInvalidSession)
        }
        None => Err(AuthError::MissingOrInvalidSession),
    }
}

fn auth_session_cookie(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name == AUTH_SESSION_COOKIE && !value.is_empty()).then(|| value.to_string())
    })
}

fn auth_session_cookie_header(session_id: &str, secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{AUTH_SESSION_COOKIE}={session_id}; HttpOnly{secure_attr}; SameSite=Lax; Path=/; Max-Age={}",
        AUTH_SESSION_TTL.as_secs(),
    )
}

pub(crate) async fn healthz() -> Json<Value> {
    Json(serde_json::json!({ "ok": true }))
}

pub(crate) async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WebSocketQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Some(allowed_origins) = state.allowed_origins.as_deref() {
        match authenticate_websocket_origin(&headers, allowed_origins) {
            Ok(()) => {}
            Err(error) => {
                warn!(
                    ?error,
                    "rejected websocket connection with disallowed origin"
                );
                return (StatusCode::FORBIDDEN, "missing or disallowed origin").into_response();
            }
        }
    }

    match authenticate_websocket_headers(&headers, &state, Instant::now()).await {
        Ok(WebSocketAuth::SessionCookie) => {
            let update_mode = WebSocketUpdateMode::from_client(query.client.as_deref());
            ws.on_upgrade(move |socket| handle_socket(socket, state, update_mode))
        }
        Err(AuthError::MissingOrInvalidSession) => {
            (StatusCode::UNAUTHORIZED, "missing or invalid session").into_response()
        }
    }
}

pub(crate) async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    update_mode: WebSocketUpdateMode,
) {
    info!(?update_mode, "websocket client connected");
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
                match handle_websocket_frame(
                    &mut socket,
                    &state,
                    frame,
                    update_mode,
                ).await {
                    Ok(FrameOutcome::Continue) => {}
                    Ok(FrameOutcome::Resynced) => {
                        event_rx = state.events.subscribe();
                    }
                    Err(_) => return,
                }
            }
            event = event_rx.recv() => {
                match event {
                    Ok(message) => {
                        let messages = match collect_outbound_events(message, &mut event_rx, update_mode) {
                            Ok(messages) => messages,
                            Err(OutboundCollectError::Lagged(skipped)) => {
                                warn!(skipped, "websocket client lagged behind bridge events");
                                return;
                            }
                            Err(OutboundCollectError::Closed) => return,
                        };
                        for message in messages {
                            if send_client_message(
                                &mut socket,
                                &state,
                                message,
                                update_mode,
                            ).await.is_err() {
                                return;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "websocket client lagged behind bridge events");
                        return;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    }
}

fn client_text_frame_too_large(text: &str) -> bool {
    text.len() > MAX_CLIENT_TEXT_FRAME_BYTES
}

async fn close_for_text_frame_too_large(
    socket: &mut WebSocket,
    bytes: usize,
) -> Result<(), axum::Error> {
    warn!(
        bytes,
        limit = MAX_CLIENT_TEXT_FRAME_BYTES,
        "websocket text frame too large"
    );
    socket
        .send(Message::Close(Some(CloseFrame {
            code: close_code::SIZE,
            reason: "message too large".into(),
        })))
        .await?;
    Err(axum::Error::new(anyhow!("websocket text frame too large")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameOutcome {
    Continue,
    Resynced,
}

pub(crate) async fn handle_websocket_frame(
    socket: &mut WebSocket,
    state: &AppState,
    frame: Result<Message, axum::Error>,
    update_mode: WebSocketUpdateMode,
) -> Result<FrameOutcome, axum::Error> {
    let frame = match frame {
        Ok(frame) => frame,
        Err(error) => {
            warn!(%error, "websocket receive failed");
            return Err(error);
        }
    };

    match frame {
        Message::Text(text) => {
            if client_text_frame_too_large(&text) {
                close_for_text_frame_too_large(socket, text.len()).await?;
                return Ok(FrameOutcome::Continue);
            }

            if state.log_frames {
                info!(direction = "client_to_bridge", frame = %text, "websocket frame");
            }

            match serde_json::from_str::<ClientMessage>(&text) {
                Ok(message) => {
                    let outcome = if client_message_resyncs_stream(&message, update_mode) {
                        FrameOutcome::Resynced
                    } else {
                        FrameOutcome::Continue
                    };
                    for response in handle_client_message(state, message).await {
                        send_client_message(
                            socket,
                            state,
                            response,
                            WebSocketUpdateMode::Immediate,
                        )
                        .await?;
                    }
                    return Ok(outcome);
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

    Ok(FrameOutcome::Continue)
}

fn client_message_resyncs_stream(
    message: &ClientMessage,
    update_mode: WebSocketUpdateMode,
) -> bool {
    update_mode.uses_session_deltas() && matches!(message, ClientMessage::StateRefresh { .. })
}

pub(crate) async fn send_sessions_snapshot(
    socket: &mut WebSocket,
    state: &AppState,
) -> Result<(), axum::Error> {
    refresh_session_catalog(state).await;
    let sessions = state.sessions.read().await;
    send_json(socket, &sessions_snapshot_from_map(&sessions)).await
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ConflationKey {
    SessionsSnapshot,
    SessionSnapshot(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OutboundCollectError {
    Lagged(u64),
    Closed,
}

fn collect_outbound_events(
    first: ServerMessage,
    event_rx: &mut broadcast::Receiver<ServerMessage>,
    update_mode: WebSocketUpdateMode,
) -> Result<Vec<ServerMessage>, OutboundCollectError> {
    if !update_mode.uses_conflation() {
        return Ok(vec![first]);
    }

    let mut messages = vec![first];
    loop {
        match event_rx.try_recv() {
            Ok(message) => messages.push(message),
            Err(broadcast::error::TryRecvError::Empty) => {
                return Ok(conflate_server_messages(messages));
            }
            Err(broadcast::error::TryRecvError::Lagged(skipped)) => {
                return Err(OutboundCollectError::Lagged(skipped));
            }
            Err(broadcast::error::TryRecvError::Closed) => {
                return Err(OutboundCollectError::Closed);
            }
        }
    }
}

fn conflate_server_messages(messages: Vec<ServerMessage>) -> Vec<ServerMessage> {
    let mut conflated: HashMap<ConflationKey, (usize, ServerMessage)> = HashMap::new();
    let mut passthrough: Vec<(usize, ServerMessage)> = Vec::new();

    for (index, message) in messages.into_iter().enumerate() {
        match &message {
            ServerMessage::SessionsSnapshot { .. } => {
                conflated.insert(ConflationKey::SessionsSnapshot, (index, message));
            }
            ServerMessage::SessionSnapshot { session_id, .. } => {
                conflated.insert(
                    ConflationKey::SessionSnapshot(session_id.clone()),
                    (index, message),
                );
            }
            _ => passthrough.push((index, message)),
        }
    }

    let mut indexed: Vec<(usize, ServerMessage)> = conflated.into_values().collect();
    indexed.extend(passthrough);
    indexed.sort_by_key(|(index, _)| *index);
    indexed.into_iter().map(|(_, message)| message).collect()
}

async fn send_client_message(
    socket: &mut WebSocket,
    state: &AppState,
    message: ServerMessage,
    update_mode: WebSocketUpdateMode,
) -> Result<(), axum::Error> {
    let message = prepare_client_message(state, message, update_mode).await;
    send_json(socket, &message).await
}

async fn prepare_client_message(
    state: &AppState,
    message: ServerMessage,
    update_mode: WebSocketUpdateMode,
) -> ServerMessage {
    match message {
        ServerMessage::SessionDelta {
            session_id,
            state: delta,
        } => {
            if update_mode.uses_session_deltas() {
                ServerMessage::SessionDelta {
                    session_id,
                    state: delta,
                }
            } else {
                let sessions = state.sessions.read().await;
                sessions
                    .get(&session_id)
                    .map(|record| ServerMessage::SessionSnapshot {
                        session_id: session_id.clone(),
                        state: record.projection(),
                    })
                    .unwrap_or(ServerMessage::SessionDelta {
                        session_id,
                        state: delta,
                    })
            }
        }
        message => message,
    }
}

pub(crate) async fn send_json(
    socket: &mut WebSocket,
    message: &ServerMessage,
) -> Result<(), axum::Error> {
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

pub(crate) fn log_server_message(message: &ServerMessage) {
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
        ServerMessage::SessionDelta { session_id, state } => info!(
            direction = "bridge_to_client",
            message_type = "session.delta",
            session_id = %session_id,
            transcript_replace_from = state.transcript_replace_from,
            transcript_append_len = state.transcript_append.len(),
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
        ServerMessage::DialogRequest { session_id, dialog } => info!(
            direction = "bridge_to_client",
            message_type = "dialog.request",
            session_id = %session_id,
            dialog_id = dialog.get("id").and_then(|value| value.as_str()).unwrap_or("unknown"),
            method = dialog.get("method").and_then(|value| value.as_str()).unwrap_or("unknown")
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
        ServerMessage::PromptBusy {
            session_id,
            text,
            images,
        } => info!(
            direction = "bridge_to_client",
            message_type = "prompt.busy",
            session_id = %session_id,
            bytes = text.len(),
            image_count = images.as_ref().map(Vec::len).unwrap_or(0)
        ),
        ServerMessage::ModelList { session_id, models } => info!(
            direction = "bridge_to_client",
            message_type = "model.list",
            session_id = %session_id,
            model_count = models.len()
        ),
        ServerMessage::ConfigModelCatalogList { request_id, models } => info!(
            direction = "bridge_to_client",
            message_type = "config.modelCatalog.list",
            request_id = ?request_id,
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
        ServerMessage::SessionChangesSummary { state } => info!(
            direction = "bridge_to_client",
            message_type = "sessionChanges.summary",
            status = ?state
        ),
        ServerMessage::CompareDiffSummary { state } => info!(
            direction = "bridge_to_client",
            message_type = "compareDiff.summary",
            target_client_id = %state.target_client_id,
            diff_id = %state.diff_id,
            repo_root = %state.comparison.repo_root,
            file_count = state.summary.files.len()
        ),
        ServerMessage::DiffFilePatch { patch } => info!(
            direction = "bridge_to_client",
            message_type = "diff.filePatch",
            target_client_id = %patch.target_client_id,
            diff_id = %patch.diff_id,
            scope = ?patch.scope,
            file = %patch.file.new_path,
            patch_bytes = patch.patch.len()
        ),
        ServerMessage::DiffComplete {
            target_client_id,
            diff_id,
            scope,
        } => info!(
            direction = "bridge_to_client",
            message_type = "diff.complete",
            target_client_id = %target_client_id,
            diff_id = %diff_id,
            scope = ?scope
        ),
        ServerMessage::DiffCancelled {
            target_client_id,
            diff_id,
            scope,
            reason,
        } => info!(
            direction = "bridge_to_client",
            message_type = "diff.cancelled",
            target_client_id = %target_client_id,
            diff_id = %diff_id,
            scope = ?scope,
            reason = reason.as_deref().unwrap_or("")
        ),
        ServerMessage::DiffError {
            target_client_id,
            diff_id,
            scope,
            session_id,
            repo_root,
            message,
        } => info!(
            direction = "bridge_to_client",
            message_type = "diff.error",
            target_client_id = target_client_id.as_deref().unwrap_or(""),
            diff_id = diff_id.as_deref().unwrap_or(""),
            scope = ?scope,
            session_id = session_id.as_deref().unwrap_or(""),
            repo_root = repo_root.as_deref().unwrap_or(""),
            error = %message
        ),
        ServerMessage::DiffReviewWorktreeState { worktree } => info!(
            direction = "bridge_to_client",
            message_type = "diff.reviewWorktree.state",
            worktree_id = %worktree.id,
            path = %worktree.path,
            dirty = worktree.dirty
        ),
        ServerMessage::ControlReply {
            target_client_id,
            message,
            candidates,
            ..
        } => info!(
            direction = "bridge_to_client",
            message_type = "control.reply",
            target_client_id = %target_client_id,
            bytes = message.len(),
            candidate_count = candidates.len()
        ),
        ServerMessage::ControlStatus {
            target_client_id,
            status,
        } => info!(
            direction = "bridge_to_client",
            message_type = "control.status",
            target_client_id = ?target_client_id,
            status = %status.status
        ),
        ServerMessage::FrontendControl {
            target_client_id,
            action: _,
        } => info!(
            direction = "bridge_to_client",
            message_type = "frontend.control",
            target_client_id = %target_client_id
        ),
        ServerMessage::CodeWorkspaceReady { workspace } => info!(
            direction = "bridge_to_client",
            message_type = "code.workspace.ready",
            workspace_id = %workspace.workspace_id,
            session_id = workspace.session_id.as_deref().unwrap_or(""),
            root = %workspace.root
        ),
        ServerMessage::CodeTree {
            workspace_id,
            path,
            entries,
        } => info!(
            direction = "bridge_to_client",
            message_type = "code.tree",
            workspace_id = %workspace_id,
            path = %path,
            entry_count = entries.len()
        ),
        ServerMessage::CodeFile { workspace_id, file } => info!(
            direction = "bridge_to_client",
            message_type = "code.file",
            workspace_id = %workspace_id,
            path = %file.path,
            bytes = file.text.len()
        ),
        ServerMessage::CodeFileSearchResults {
            workspace_id,
            base_path,
            query,
            entries,
        } => info!(
            direction = "bridge_to_client",
            message_type = "code.file.searchResults",
            workspace_id = %workspace_id,
            base_path = %base_path,
            query_len = query.len(),
            entry_count = entries.len()
        ),
        ServerMessage::CodeError {
            workspace_id,
            path,
            message,
        } => warn!(
            direction = "bridge_to_client",
            message_type = "code.error",
            workspace_id = ?workspace_id,
            path = ?path,
            bytes = message.len()
        ),
        ServerMessage::ConflictSnapshot { repos } => info!(
            direction = "bridge_to_client",
            message_type = "conflict.snapshot",
            repo_count = repos.len()
        ),
        ServerMessage::ConflictFile { file } => info!(
            direction = "bridge_to_client",
            message_type = "conflict.file",
            repo_id = %file.repo_id,
            path = %file.path,
            conflict_count = file.conflicts.len()
        ),
        ServerMessage::ConflictMagicWandPreview { preview } => info!(
            direction = "bridge_to_client",
            message_type = "conflict.magicWandPreview",
            repo_id = %preview.repo_id,
            path = %preview.path,
            source_version = %preview.source_version,
            resolved_conflict_count = preview.resolved_conflict_count,
            remaining_conflict_count = preview.remaining_conflict_count
        ),
        ServerMessage::ConflictAgentResult { result } => info!(
            direction = "bridge_to_client",
            message_type = "conflict.agentResult",
            repo_id = %result.repo_id,
            path = %result.path,
            mode = ?result.mode,
            scope = ?result.scope,
            risk = ?result.risk,
            has_content = result.content.is_some()
        ),
        ServerMessage::ConflictStatus {
            repo_id,
            path,
            state,
            message,
        } => info!(
            direction = "bridge_to_client",
            message_type = "conflict.status",
            repo_id = %repo_id,
            path = path.as_deref().unwrap_or(""),
            state = %state,
            bytes = message.len()
        ),
        ServerMessage::ConflictError {
            repo_id,
            path,
            message,
        } => info!(
            direction = "bridge_to_client",
            message_type = "conflict.error",
            repo_id = repo_id.as_deref().unwrap_or(""),
            path = path.as_deref().unwrap_or(""),
            bytes = message.len()
        ),
        ServerMessage::RawOmp { session_id, frame } => info!(
            direction = "bridge_to_client",
            message_type = "raw.omp",
            session_id = %session_id,
            frame_type = frame.get("type").and_then(|value| value.as_str()).unwrap_or("unknown")
        ),
        ServerMessage::VoiceStatus {
            target_client_id,
            status,
            ..
        } => info!(
            direction = "bridge_to_client",
            message_type = "voice.status",
            target_client_id = %target_client_id,
            status = %status
        ),
        ServerMessage::VoiceDelta {
            target_client_id,
            item_id,
            text,
        } => info!(
            direction = "bridge_to_client",
            message_type = "voice.delta",
            target_client_id = %target_client_id,
            item_id = %item_id,
            bytes = text.len()
        ),
        ServerMessage::VoiceFinal {
            target_client_id,
            item_id,
            text,
        } => info!(
            direction = "bridge_to_client",
            message_type = "voice.final",
            target_client_id = %target_client_id,
            item_id = %item_id,
            bytes = text.len()
        ),
        ServerMessage::VoiceError {
            target_client_id,
            message,
        } => warn!(
            direction = "bridge_to_client",
            message_type = "voice.error",
            target_client_id = %target_client_id,
            bytes = message.len()
        ),
        ServerMessage::ReviewCommentsSnapshot {
            session_id,
            comments,
        } => info!(
            direction = "bridge_to_client",
            message_type = "review.comments.snapshot",
            session_id = %session_id,
            comment_count = comments.len()
        ),
        ServerMessage::ReviewCommentUpserted { comment } => info!(
            direction = "bridge_to_client",
            message_type = "review.comment.upserted",
            session_id = %comment.session_id,
            comment_id = %comment.id,
            author = ?comment.author
        ),
        ServerMessage::ReviewCommentDeleted { session_id, id, .. } => info!(
            direction = "bridge_to_client",
            message_type = "review.comment.deleted",
            session_id = %session_id,
            comment_id = %id
        ),
        ServerMessage::Error { message, .. } => warn!(
            direction = "bridge_to_client",
            message_type = "error",
            bytes = message.len()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ContentBlock, MessageRole, SessionKind, SessionMode, SessionProjection,
        SessionProjectionDelta, SessionStatus, SessionSummary, Timestamp, TranscriptEntry,
        TranscriptMessage,
    };

    fn test_summary(session_id: &str, message_count: usize) -> SessionSummary {
        SessionSummary {
            session_id: session_id.to_string(),
            cwd: Some("/repo".to_string()),
            status: SessionStatus::Idle,
            created_at: Timestamp::now(),
            updated_at: Timestamp::now(),
            message_count,
            kind: SessionKind::Managed,
            session_mode: SessionMode::Standard,
            session_file: None,
            title: Some(session_id.to_string()),
            timestamp: None,
            category: None,
            worktree: None,
        }
    }

    fn test_message(id: &str, text: &str) -> TranscriptEntry {
        TranscriptEntry::Message(TranscriptMessage {
            id: id.to_string(),
            role: MessageRole::Assistant,
            blocks: vec![ContentBlock::Text {
                text: text.to_string(),
            }],
            timestamp: None,
            is_new: true,
        })
    }

    fn test_projection(session_id: &str, entries: Vec<TranscriptEntry>) -> SessionProjection {
        SessionProjection {
            summary: test_summary(session_id, entries.len()),
            transcript: entries,
            is_busy: false,
            model: None,
            thinking_level: None,
            tokens_total: 0,
            cost_usd: 0.0,
            context_tokens: None,
            context_window: None,
            context_percent: None,
            plan_mode: None,
            pending_plan_review: None,
            todo_phases: Vec::new(),
        }
    }

    #[test]
    fn build_auth_session_response_sets_http_only_cookie() {
        let response = build_auth_session_response("session-1".to_string(), false);

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .expect("set-cookie header");
        assert!(cookie.contains("fura_session=session-1"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(cookie.contains("Path=/"));
        assert!(cookie.contains("Max-Age=43200"));
        assert!(!cookie.contains("Secure"));
    }

    #[test]
    fn build_auth_session_response_adds_secure_cookie_when_requested() {
        let response = build_auth_session_response("session-1".to_string(), true);

        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .expect("set-cookie header");
        assert!(cookie.contains("Secure"));
    }

    #[test]
    fn issue_auth_session_removes_expired_sessions() {
        let now = Instant::now();
        let mut sessions = HashMap::from([(
            "expired".to_string(),
            AuthSession {
                expires_at: now - Duration::from_secs(1),
            },
        )]);

        let issued = issue_auth_session(&mut sessions, now);

        assert!(!sessions.contains_key("expired"));
        assert!(sessions.contains_key(&issued));
    }

    #[test]
    fn authenticate_websocket_origin_accepts_exact_allowed_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            axum::http::HeaderValue::from_static("http://127.0.0.1:3737"),
        );
        let allowed = vec!["http://127.0.0.1:3737".to_string()];

        assert_eq!(authenticate_websocket_origin(&headers, &allowed), Ok(()));
    }

    #[test]
    fn authenticate_websocket_origin_rejects_disallowed_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            axum::http::HeaderValue::from_static("http://evil.example"),
        );
        let allowed = vec!["http://127.0.0.1:3737".to_string()];

        assert_eq!(
            authenticate_websocket_origin(&headers, &allowed),
            Err(OriginError::NotAllowed),
        );
    }

    #[test]
    fn authenticate_websocket_origin_rejects_missing_origin() {
        let headers = HeaderMap::new();
        let allowed = vec!["http://127.0.0.1:3737".to_string()];

        assert_eq!(
            authenticate_websocket_origin(&headers, &allowed),
            Err(OriginError::Missing),
        );
    }

    #[test]
    fn mobile_state_refresh_resets_event_cursor_after_snapshot_resync() {
        assert!(client_message_resyncs_stream(
            &ClientMessage::StateRefresh {
                session_id: "s1".to_string(),
            },
            WebSocketUpdateMode::ConflateAndDelta,
        ));
        assert!(!client_message_resyncs_stream(
            &ClientMessage::StateRefresh {
                session_id: "s1".to_string(),
            },
            WebSocketUpdateMode::Immediate,
        ));
        assert!(!client_message_resyncs_stream(
            &ClientMessage::SessionList,
            WebSocketUpdateMode::ConflateAndDelta,
        ));
    }

    #[test]
    fn client_text_frame_size_limit_is_explicit() {
        assert!(!client_text_frame_too_large(
            &"a".repeat(MAX_CLIENT_TEXT_FRAME_BYTES)
        ));
        assert!(client_text_frame_too_large(
            &"a".repeat(MAX_CLIENT_TEXT_FRAME_BYTES + 1)
        ));
    }

    #[test]
    fn conflate_server_messages_keeps_only_latest_snapshots() {
        let first = test_projection("s1", vec![test_message("m1", "first")]);
        let latest = test_projection(
            "s1",
            vec![test_message("m1", "first"), test_message("m2", "second")],
        );

        let messages = conflate_server_messages(vec![
            ServerMessage::SessionSnapshot {
                session_id: "s1".to_string(),
                state: first,
            },
            ServerMessage::Error {
                request_id: None,
                message: "keep me".to_string(),
            },
            ServerMessage::SessionSnapshot {
                session_id: "s1".to_string(),
                state: latest,
            },
            ServerMessage::SessionsSnapshot {
                sessions: vec![test_summary("s1", 2)],
            },
            ServerMessage::SessionsSnapshot {
                sessions: vec![test_summary("s1", 2), test_summary("s2", 0)],
            },
        ]);

        assert_eq!(messages.len(), 3);
        assert!(matches!(messages[0], ServerMessage::Error { .. }));
        match &messages[1] {
            ServerMessage::SessionSnapshot { state, .. } => assert_eq!(state.transcript.len(), 2),
            other => panic!("expected session snapshot, got {other:?}"),
        }
        match &messages[2] {
            ServerMessage::SessionsSnapshot { sessions } => assert_eq!(sessions.len(), 2),
            other => panic!("expected sessions snapshot, got {other:?}"),
        }
    }

    #[test]
    fn conflate_server_messages_preserves_ordered_deltas() {
        let projection = test_projection("s1", vec![test_message("m1", "first")]);
        let delta = ServerMessage::SessionDelta {
            session_id: "s1".to_string(),
            state: SessionProjectionDelta::from_projection_replace_tail(0, &projection),
        };

        let messages = conflate_server_messages(vec![
            delta.clone(),
            ServerMessage::SessionsSnapshot {
                sessions: vec![test_summary("s1", 1)],
            },
            ServerMessage::SessionsSnapshot {
                sessions: vec![test_summary("s1", 1), test_summary("s2", 0)],
            },
            delta.clone(),
        ]);

        assert_eq!(messages.len(), 3);
        assert!(matches!(messages[0], ServerMessage::SessionDelta { .. }));
        match &messages[1] {
            ServerMessage::SessionsSnapshot { sessions } => assert_eq!(sessions.len(), 2),
            other => panic!("expected sessions snapshot, got {other:?}"),
        }
        assert!(matches!(messages[2], ServerMessage::SessionDelta { .. }));
    }

    #[test]
    fn authenticate_session_id_accepts_unexpired_session() {
        let now = Instant::now();
        let mut sessions = HashMap::from([(
            "session-1".to_string(),
            AuthSession {
                expires_at: now + Duration::from_secs(60),
            },
        )]);

        assert_eq!(
            authenticate_session_id(&mut sessions, "session-1", now),
            Ok(WebSocketAuth::SessionCookie),
        );
    }

    #[test]
    fn authenticate_session_id_rejects_missing_session() {
        let mut sessions = HashMap::new();

        assert_eq!(
            authenticate_session_id(&mut sessions, "missing", Instant::now()),
            Err(AuthError::MissingOrInvalidSession),
        );
    }

    #[test]
    fn authenticate_session_id_rejects_and_removes_expired_session() {
        let now = Instant::now();
        let mut sessions = HashMap::from([(
            "expired".to_string(),
            AuthSession {
                expires_at: now - Duration::from_secs(1),
            },
        )]);

        assert_eq!(
            authenticate_session_id(&mut sessions, "expired", now),
            Err(AuthError::MissingOrInvalidSession),
        );
        assert!(!sessions.contains_key("expired"));
    }
}
