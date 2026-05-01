use std::collections::HashMap;

use anyhow::anyhow;
use axum::{
    Json,
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::Value;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::{
    AppState, ClientMessage, ServerMessage, client_config, handle_client_message,
    refresh_session_catalog, sessions_snapshot_from_map,
};

pub(crate) async fn healthz() -> Json<Value> {
    Json(serde_json::json!({ "ok": true }))
}

pub(crate) async fn ws_handler(
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

pub(crate) async fn handle_socket(mut socket: WebSocket, state: AppState) {
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

pub(crate) async fn handle_websocket_frame(
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

pub(crate) async fn send_sessions_snapshot(
    socket: &mut WebSocket,
    state: &AppState,
) -> Result<(), axum::Error> {
    refresh_session_catalog(state).await;
    let sessions = state.sessions.read().await;
    send_json(socket, &sessions_snapshot_from_map(&sessions)).await
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
        ServerMessage::Error { message, .. } => warn!(
            direction = "bridge_to_client",
            message_type = "error",
            bytes = message.len()
        ),
    }
}
