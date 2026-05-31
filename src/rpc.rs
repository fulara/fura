use std::process::Stdio;

use serde_json::Value;
use tokio::{
    fs as async_fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};
use tracing::{debug, info, warn};

use crate::*;

const RECENT_RPC_STDERR_LINE_COUNT: usize = 4;

fn is_synthetic_transcript_message_id(id: &str) -> bool {
    id.starts_with("approved-plan:") || id.starts_with("__pending_prompt:")
}

fn projected_message_ordinal_for_append(record: &SessionRecord) -> usize {
    record
        .messages
        .iter()
        .filter(|message| !is_synthetic_transcript_message_id(&message.id))
        .count()
}

fn projected_message_ordinal_for_pending_prompt(record: &SessionRecord) -> usize {
    record
        .messages
        .iter()
        .rev()
        .skip(1)
        .filter(|message| !is_synthetic_transcript_message_id(&message.id))
        .count()
}
const RECENT_RPC_STDERR_LINE_BYTES: usize = 4096;

pub(crate) async fn refresh_rpc_state(state: &AppState, session_id: &str) -> Result<(), String> {
    send_rpc_command(state, session_id, get_state_command(next_rpc_id())).await?;
    send_rpc_command(state, session_id, get_messages_command(next_rpc_id())).await?;
    send_rpc_command(state, session_id, get_session_stats_command(next_rpc_id())).await
}

async fn is_model_catalog_transport(state: &AppState, session_id: &str) -> bool {
    state
        .model_catalog
        .read()
        .await
        .transport_session_id
        .as_deref()
        == Some(session_id)
}

async fn reset_model_catalog_if_transport_exited(state: &AppState, session_id: &str) -> bool {
    let mut catalog = state.model_catalog.write().await;
    if catalog.transport_session_id.as_deref() != Some(session_id) {
        return false;
    }
    let had_in_flight = catalog.in_flight;
    let request_id = catalog.in_flight_request_id.take();
    catalog.in_flight = false;
    catalog.transport_session_id = None;
    drop(catalog);
    if had_in_flight {
        let _ = state
            .events
            .emit(
                state,
                ServerMessage::Error {
                    request_id,
                    message: "Model catalog RPC child exited before returning models.".to_string(),
                },
            )
            .await;
    }
    true
}

async fn complete_model_catalog_request(state: &AppState, session_id: &str) -> Option<String> {
    let mut catalog = state.model_catalog.write().await;
    if catalog.transport_session_id.as_deref() != Some(session_id) {
        return None;
    }
    catalog.in_flight = false;
    catalog.in_flight_request_id.take()
}

async fn stop_transport(state: &AppState, transport_session_id: &str) {
    if let Some(removed) = state
        .session_runtime
        .remove_transport(transport_session_id)
        .await
    {
        let _ = removed.handle.stop.send(());
    }
}

async fn initialize_pending_created_session(state: &AppState, transport_session_id: &str) -> bool {
    let pending = state
        .session_runtime
        .pending_create(transport_session_id)
        .await;
    let Some(pending) = pending else {
        return false;
    };

    if let Some(name) = pending.title.as_ref() {
        let command = set_session_name_command(next_rpc_id(), name.clone());
        if let Err(message) = send_rpc_command(state, transport_session_id, command).await {
            fail_pending_create_initialization(
                state,
                transport_session_id,
                pending.request_id.clone(),
                message,
            )
            .await;
            return true;
        }
    }

    if let Some(model) = pending.proposed_model.as_ref() {
        let command = set_model_command(
            next_rpc_id(),
            model.provider.clone(),
            model.model_id.clone(),
        );
        if let Err(message) = send_rpc_command(state, transport_session_id, command).await {
            fail_pending_create_initialization(
                state,
                transport_session_id,
                pending.request_id.clone(),
                message,
            )
            .await;
            return true;
        }
        if let Some(level) = model.thinking_level.as_rpc_level() {
            let command = set_thinking_level_command(next_rpc_id(), level.to_string());
            if let Err(message) = send_rpc_command(state, transport_session_id, command).await {
                fail_pending_create_initialization(
                    state,
                    transport_session_id,
                    pending.request_id.clone(),
                    message,
                )
                .await;
                return true;
            }
        }
    }

    if let Err(message) = refresh_rpc_state(state, transport_session_id).await {
        fail_pending_create_initialization(
            state,
            transport_session_id,
            pending.request_id.clone(),
            message,
        )
        .await;
    }
    true
}

async fn fail_pending_create_initialization(
    state: &AppState,
    transport_session_id: &str,
    request_id: Option<String>,
    message: String,
) {
    state
        .session_runtime
        .remove_pending_create(transport_session_id)
        .await;
    let _ = state
        .events
        .emit(
            state,
            ServerMessage::Error {
                request_id,
                message,
            },
        )
        .await;
    stop_transport(state, transport_session_id).await;
}

pub(crate) async fn rpc_session_target_id(state: &AppState, transport_session_id: &str) -> String {
    state
        .session_runtime
        .target_session_id_for_transport(transport_session_id)
        .await
}

pub(crate) async fn rpc_transport_session_id(state: &AppState, session_id: &str) -> Option<String> {
    state
        .session_runtime
        .transport_session_id_for(session_id)
        .await
}

pub(crate) async fn has_live_rpc_child(state: &AppState, session_id: &str) -> bool {
    let Some(transport_session_id) = rpc_transport_session_id(state, session_id).await else {
        return false;
    };
    state
        .session_runtime
        .stdin_for_transport(&transport_session_id)
        .await
        .is_some()
}

pub(crate) async fn send_rpc_command(
    state: &AppState,
    session_id: &str,
    command: Value,
) -> Result<(), String> {
    let transport_session_id = rpc_transport_session_id(state, session_id)
        .await
        .ok_or_else(|| format!("session {session_id} has no live RPC child"))?;
    let stdin = state
        .session_runtime
        .stdin_for_transport(&transport_session_id)
        .await
        .ok_or_else(|| format!("session {session_id} has no live RPC child"))?;

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

pub(crate) async fn spawn_rpc_child(
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
    state
        .session_runtime
        .register_transport(
            session_id.clone(),
            RpcSessionHandle {
                stdin: stdin_tx,
                stop: stop_tx,
            },
        )
        .await;

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
    let stderr_join = tokio::spawn(read_rpc_stderr(
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

        let _ = stderr_join.await;
        let recent_stderr = state
            .session_runtime
            .take_recent_rpc_stderr(&session_id)
            .await;

        let target_session_id = state
            .session_runtime
            .remove_transport(&session_id)
            .await
            .map(|removed| removed.target_session_id)
            .unwrap_or_else(|| session_id.clone());
        let removed_review_contexts =
            remove_review_contexts_for_session(&state, &target_session_id).await;
        if let Some(context) = removed_review_contexts.into_iter().last() {
            remember_session_host_tools(&state, &target_session_id, context.previous_host_tools)
                .await;
        }
        let removed_conflict_contexts =
            remove_conflict_contexts_for_session(&state, &target_session_id).await;
        if let Some(context) = removed_conflict_contexts.iter().last() {
            remember_session_host_tools(
                &state,
                &target_session_id,
                context.previous_host_tools.clone(),
            )
            .await;
        }
        for context in removed_conflict_contexts {
            let _ = state
                .events
                .emit(
                    &state,
                    ServerMessage::ConflictError {
                        repo_id: Some(context.repo_id),
                        path: Some(context.path),
                        message: "Conflict Resolver session exited before returning a result."
                            .to_string(),
                    },
                )
                .await;
        }
        if reset_controller_if_transport_exited(&state, &session_id).await {
            return;
        }
        if reset_model_catalog_if_transport_exited(&state, &session_id).await {
            return;
        }

        let pending_create = state
            .session_runtime
            .remove_pending_create(&session_id)
            .await;
        match status {
            Ok(status) => {
                let code = status.code();
                info!(action = "rpc.exit", session_id = %session_id, target_session_id = %target_session_id, code = ?code);
                if let Some(pending_create) = pending_create {
                    let _ = state
                        .events
                        .emit(
                            &state,
                            ServerMessage::Error {
                                request_id: pending_create.request_id,
                                message: pending_create_exit_message(code, &recent_stderr),
                            },
                        )
                        .await;
                } else {
                    mark_status_and_broadcast(&state, &target_session_id, SessionStatus::Exited)
                        .await;
                    let _ = state
                        .events
                        .emit(
                            &state,
                            ServerMessage::SessionExited {
                                session_id: target_session_id,
                                code,
                                signal: None,
                            },
                        )
                        .await;
                }
            }
            Err(error) => {
                warn!(action = "rpc.exit_error", session_id = %session_id, target_session_id = %target_session_id, %error);
                if let Some(pending_create) = pending_create {
                    let _ = state
                        .events
                        .emit(
                            &state,
                            ServerMessage::Error {
                                request_id: pending_create.request_id,
                                message: pending_create_wait_error_message(&error, &recent_stderr),
                            },
                        )
                        .await;
                } else {
                    mark_status_and_broadcast(&state, &target_session_id, SessionStatus::Error)
                        .await;
                }
            }
        }
    });

    Ok(())
}

pub(crate) async fn read_rpc_stdout<R>(state: AppState, session_id: String, reader: BufReader<R>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        append_bridge_debug_rpc_line(&state, &session_id, &line).await;
        append_event_debug_rpc_line(&state, &session_id, &line).await;
        if state.log_frames {
            info!(direction = "rpc_to_bridge", session_id = %session_id, frame = %line, "rpc frame");
        }

        match serde_json::from_str::<Value>(&line) {
            Ok(frame) => {
                log_rpc_frame(&session_id, &frame);
                apply_rpc_frame(&state, &session_id, &frame).await;
                if state.forward_raw_frames {
                    let raw_session_id = rpc_session_target_id(&state, &session_id).await;
                    let _ = state
                        .events
                        .emit(
                            &state,
                            ServerMessage::RawOmp {
                                session_id: raw_session_id,
                                frame,
                            },
                        )
                        .await;
                }
            }
            Err(error) => {
                warn!(session_id = %session_id, %error, bytes = line.len(), "invalid RPC JSONL frame")
            }
        }
    }
    info!(session_id = %session_id, "RPC stdout closed");
}

pub(crate) async fn read_rpc_stderr<R>(state: AppState, session_id: String, reader: BufReader<R>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let recent_line = truncate_recent_stderr_line(&line);
        state
            .session_runtime
            .remember_rpc_stderr(&session_id, recent_line, RECENT_RPC_STDERR_LINE_COUNT)
            .await;
        warn!(session_id = %session_id, bytes = line.len(), "RPC stderr line");
        let target_session_id = rpc_session_target_id(&state, &session_id).await;
        let _ = state
            .events
            .emit(
                &state,
                ServerMessage::LogStderr {
                    session_id: target_session_id,
                    text: line,
                },
            )
            .await;
    }
}

fn truncate_recent_stderr_line(line: &str) -> String {
    if line.len() <= RECENT_RPC_STDERR_LINE_BYTES {
        return line.to_string();
    }

    let mut end = RECENT_RPC_STDERR_LINE_BYTES;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &line[..end])
}

pub(crate) fn pending_create_exit_message(code: Option<i32>, stderr_lines: &[String]) -> String {
    let mut message = format!(
        "RPC child exited before reporting a session id (code {}).",
        code.map(|value| value.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    );
    if !stderr_lines.is_empty() {
        message.push_str(" Recent stderr: ");
        message.push_str(&stderr_lines.join(" | "));
    }
    message
}

fn pending_create_wait_error_message(error: &std::io::Error, stderr_lines: &[String]) -> String {
    let mut message = format!("RPC child failed before reporting a session id: {error}");
    if !stderr_lines.is_empty() {
        message.push_str(" Recent stderr: ");
        message.push_str(&stderr_lines.join(" | "));
    }
    message
}

pub(crate) async fn apply_rpc_frame(state: &AppState, session_id: &str, frame: &Value) {
    let typed_frame = match OmpRpcFrame::decode(frame.clone()) {
        Ok(frame) => frame,
        Err(error) => {
            warn!(session_id = %session_id, %error, "invalid typed OMP RPC frame");
            return;
        }
    };
    let target_session_id = rpc_session_target_id(state, session_id).await;
    if is_controller_transport(state, session_id).await {
        match typed_frame {
            OmpRpcFrame::Ready => {}
            OmpRpcFrame::AgentStart => {
                let run = state.bridge_controller.read().await.active_run.clone();
                if let Some(run) = run {
                    let _ = state
                        .events
                        .emit(
                            state,
                            ServerMessage::ControlStatus {
                                target_client_id: Some(run.target_client_id),
                                status: ControlStatusProjection {
                                    status: "working".to_string(),
                                    message: Some("Ask Fura is working.".to_string()),
                                },
                            },
                        )
                        .await;
                }
            }
            OmpRpcFrame::AgentEnd { .. } => handle_controller_agent_end(state).await,
            OmpRpcFrame::HostToolCall {
                id,
                tool_call_id,
                tool_name,
                arguments,
            } => {
                handle_controller_host_tool_call(state, id, tool_call_id, tool_name, arguments)
                    .await
            }
            OmpRpcFrame::Response(response) => {
                let _ = response.is_error();
                let _ = response.payload();
                apply_rpc_response(state, session_id, frame).await;
            }
            OmpRpcFrame::HostToolCancel { id, target_id } => {
                handle_controller_host_tool_cancel(state, id, target_id).await
            }
            OmpRpcFrame::ExtensionUiRequest { .. }
            | OmpRpcFrame::MessageUpdate { .. }
            | OmpRpcFrame::MessageEnd { .. }
            | OmpRpcFrame::ToolExecutionStart { .. }
            | OmpRpcFrame::ToolExecutionUpdate { .. }
            | OmpRpcFrame::ToolExecutionEnd { .. }
            | OmpRpcFrame::PlanReview { .. }
            | OmpRpcFrame::GoalUpdated { .. }
            | OmpRpcFrame::HostToolResult { .. }
            | OmpRpcFrame::HostToolUpdate { .. }
            | OmpRpcFrame::HostUriRequest { .. }
            | OmpRpcFrame::HostUriCancel { .. }
            | OmpRpcFrame::HostUriResult { .. }
            | OmpRpcFrame::Unknown => {}
        }
        return;
    }
    match typed_frame {
        OmpRpcFrame::Ready => {
            mark_status_and_broadcast(state, &target_session_id, SessionStatus::Idle).await;
            if is_model_catalog_transport(state, session_id).await {
                if let Err(message) = send_rpc_command(
                    state,
                    session_id,
                    get_available_models_command(next_rpc_id()),
                )
                .await
                {
                    let request_id = complete_model_catalog_request(state, session_id).await;
                    let _ = state
                        .events
                        .emit(
                            state,
                            ServerMessage::Error {
                                request_id,
                                message,
                            },
                        )
                        .await;
                }
                return;
            }
            if initialize_pending_created_session(state, session_id).await {
                return;
            }
            if let Err(message) = refresh_rpc_state(state, session_id).await {
                warn!(session_id = %session_id, %message, "initial RPC refresh failed");
            }
        }
        OmpRpcFrame::AgentStart => {
            discard_pending_prompt_drafts_for_session(state, &target_session_id).await;
            mark_status_and_broadcast(state, &target_session_id, SessionStatus::Busy).await
        }
        OmpRpcFrame::AgentEnd { .. } => {
            clear_review_contexts_for_session(state, &target_session_id).await;
            clear_conflict_contexts_for_session(
                state,
                &target_session_id,
                Some("Conflict Resolver agent run finished without submitting an explanation or proposal."),
            )
            .await;
            mark_status_and_broadcast(state, &target_session_id, SessionStatus::Idle).await;
            if let Err(message) = refresh_rpc_state(state, &target_session_id).await {
                warn!(session_id = %target_session_id, %message, "post-agent state refresh failed");
            }
        }
        OmpRpcFrame::PlanReview {
            plan_file_path,
            final_plan_file_path,
            title,
            content,
        } => {
            let persisted = PendingPlanReviewProjection {
                plan_file_path: plan_file_path.clone(),
                final_plan_file_path: final_plan_file_path.clone(),
                title: title.clone(),
                content: content.clone(),
            };
            state
                .events
                .mutate_sessions_and_emit(state, |sessions| {
                    let Some(record) = sessions.get_mut(&target_session_id) else {
                        return Vec::new();
                    };
                    record.pending_plan_review = Some(persisted.clone());
                    vec![
                        ServerMessage::SessionSnapshot {
                            session_id: target_session_id.clone(),
                            state: record.projection(),
                        },
                        ServerMessage::PlanReview {
                            session_id: target_session_id.clone(),
                            plan_file_path,
                            final_plan_file_path,
                            title,
                            content,
                        },
                    ]
                })
                .await;
        }
        OmpRpcFrame::MessageUpdate { message, .. } => {
            let event_timestamp = value_timestamp(frame).unwrap_or_else(Timestamp::now);
            if let Some(mut message) = map_omp_message(&message) {
                message.is_new = true;
                // Use a stable sentinel ID so the frontend always keyed to the same node
                // while streaming; the real ID arrives with message_end.
                if message.id.is_empty() {
                    message.id = "__streaming__".to_string();
                }
                state
                    .events
                    .mutate_session_delta(state, &target_session_id, |record| {
                        if message.timestamp.is_none() {
                            message.timestamp = record
                                .streaming_message
                                .as_ref()
                                .filter(|existing| existing.id == message.id)
                                .and_then(|existing| existing.timestamp)
                                .or(Some(event_timestamp));
                        }
                        message.refresh_render_hash();
                        record.streaming_message = Some(message);
                        let projection = record.projection();
                        let replace_from = projection.transcript.len().saturating_sub(1);
                        Some(SessionProjectionDelta::from_projection_replace_tail(
                            replace_from,
                            &projection,
                        ))
                    })
                    .await;
            }
        }
        OmpRpcFrame::MessageEnd { message } => {
            let event_timestamp = value_timestamp(frame).unwrap_or_else(Timestamp::now);
            let source_message = message.clone();
            if let Some(mut transcript_message) = map_omp_message(&message) {
                if transcript_message.timestamp.is_none() {
                    transcript_message.timestamp = Some(event_timestamp);
                }
                transcript_message.is_new = true;
                // Clear streaming_message and push the final message atomically in a single
                // lock so no snapshot can fire showing a gap between the two.
                let delta_sent = state
                    .events
                    .mutate_session_delta(state, &target_session_id, |record| {
                        record.streaming_message = None;
                        let replaces_pending_prompt =
                            matches!(transcript_message.role, MessageRole::User)
                                && record.messages.last().is_some_and(|existing| {
                                    existing.id.starts_with("__pending_prompt:")
                                });
                        if transcript_message.id.is_empty() {
                            let visible_ordinal = if replaces_pending_prompt {
                                projected_message_ordinal_for_pending_prompt(record)
                            } else {
                                projected_message_ordinal_for_append(record)
                            };
                            assign_projected_message_id(
                                &mut transcript_message,
                                &source_message,
                                visible_ordinal,
                            );
                        }
                        transcript_message.refresh_render_hash();
                        record
                            .live_message_ids
                            .insert(transcript_message.id.clone());
                        if let Some(existing) = record
                            .messages
                            .iter_mut()
                            .find(|existing| existing.id == transcript_message.id)
                        {
                            *existing = transcript_message;
                        } else if replaces_pending_prompt {
                            *record.messages.last_mut().expect("last message exists") =
                                transcript_message;
                        } else {
                            record.messages.push(transcript_message);
                        }
                        record.updated_at = Timestamp::now();
                        let projection = record.projection();
                        let replace_from = projection.transcript.len().saturating_sub(1);
                        Some(SessionProjectionDelta::from_projection_replace_tail(
                            replace_from,
                            &projection,
                        ))
                    })
                    .await;
                if delta_sent {
                    broadcast_sessions_snapshot(state).await;
                }
            }
        }
        OmpRpcFrame::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
            intent,
        } => {
            let event_timestamp = value_timestamp(frame).unwrap_or_else(Timestamp::now);
            state
                .events
                .mutate_session_delta(state, &target_session_id, |record| {
                    let insert_after_count = record.messages.len();
                    record.active_tool_calls.push(ToolCard::new(
                        tool_call_id,
                        Some(event_timestamp),
                        tool_name,
                        intent,
                        args,
                        true,
                        false,
                        None,
                        None,
                        insert_after_count,
                    ));
                    let projection = record.projection();
                    let replace_from = projection.transcript.len().saturating_sub(1);
                    Some(SessionProjectionDelta::from_projection_replace_tail(
                        replace_from,
                        &projection,
                    ))
                })
                .await;
        }
        OmpRpcFrame::ToolExecutionUpdate {
            tool_call_id,
            partial_result,
            ..
        } => {
            let async_state = partial_result.as_ref().and_then(tool_async_state);
            let is_final_async = matches!(async_state, Some("completed" | "failed"));
            let is_async_error = matches!(async_state, Some("failed"));
            state.events
                .mutate_session_delta(state, &target_session_id, |record| {
                    let pos = record
                        .active_tool_calls
                        .iter()
                        .position(|c| c.tool_call_id == tool_call_id)?;
                    if is_final_async {
                        let mut card = record.active_tool_calls.remove(pos);
                        card.is_active = false;
                        card.is_error = is_async_error;
                        let todo_phases = if card.tool_name == "todo_write" && !card.is_error {
                            todo_phases_from_tool_result_value(partial_result.as_ref())
                        } else {
                            None
                        };
                        card.result = partial_result;
                        card.partial_result = None;
                        card.refresh_render_hash();
                        if let Some(todo_phases) = todo_phases {
                            record.todo_phases = Some(todo_phases);
                        }
                        record.tool_cards.push(card);
                    } else {
                        record.active_tool_calls[pos].partial_result = partial_result;
                        record.active_tool_calls[pos].refresh_render_hash();
                    }
                    let projection = record.projection();
                    let replace_from = projection
                        .transcript
                        .iter()
                        .position(|entry| {
                            matches!(entry, TranscriptEntry::Tool(card) if card.tool_call_id == tool_call_id)
                        })
                        .unwrap_or_else(|| projection.transcript.len().saturating_sub(1));
                    Some(SessionProjectionDelta::from_projection_replace_tail(
                        replace_from,
                        &projection,
                    ))
                })
                .await;
        }
        OmpRpcFrame::ToolExecutionEnd {
            tool_call_id,
            tool_name: _,
            result,
            is_error,
        } => {
            let is_error = is_error.unwrap_or(false);
            let is_background_running =
                matches!(result.as_ref().and_then(tool_async_state), Some("running"));
            state.events
                .mutate_session_delta(state, &target_session_id, |record| {
                    if let Some(pos) = record
                        .active_tool_calls
                        .iter()
                        .position(|c| c.tool_call_id == tool_call_id)
                    {
                        if is_background_running {
                            let is_todo_write =
                                record.active_tool_calls[pos].tool_name == "todo_write";
                            if is_todo_write {
                                if let Some(todo_phases) =
                                    todo_phases_from_tool_result_value(result.as_ref())
                                {
                                    record.todo_phases = Some(todo_phases);
                                }
                            }
                            let card = &mut record.active_tool_calls[pos];
                            card.is_active = true;
                            card.is_error = false;
                            card.result = result.clone();
                            card.partial_result = None;
                            card.refresh_render_hash();
                        } else {
                            let mut card = record.active_tool_calls.remove(pos);
                            card.is_active = false;
                            card.is_error = is_error;
                            if card.tool_name == "todo_write" && !card.is_error {
                                if let Some(todo_phases) =
                                    todo_phases_from_tool_result_value(result.as_ref())
                                {
                                    record.todo_phases = Some(todo_phases);
                                }
                            }
                            card.result = result.clone();
                            card.partial_result = None;
                            card.refresh_render_hash();
                            record.tool_cards.push(card);
                        }
                    }
                    let projection = record.projection();
                    let replace_from = projection
                        .transcript
                        .iter()
                        .position(|entry| {
                            matches!(entry, TranscriptEntry::Tool(card) if card.tool_call_id == tool_call_id)
                        })
                        .unwrap_or_else(|| projection.transcript.len().saturating_sub(1));
                    Some(SessionProjectionDelta::from_projection_replace_tail(
                        replace_from,
                        &projection,
                    ))
                })
                .await;
        }
        OmpRpcFrame::GoalUpdated {
            state: goal_state, ..
        } => {
            let goal_mode = goal_state.as_ref().and_then(map_goal_mode_projection);
            state
                .events
                .mutate_session_snapshot(state, &target_session_id, |record| {
                    record.goal_mode = goal_mode;
                })
                .await;
        }
        OmpRpcFrame::Response(response) => {
            let _ = response.is_error();
            let _ = response.payload();
            apply_rpc_response(state, session_id, frame).await
        }
        OmpRpcFrame::ExtensionUiRequest {
            id,
            method,
            payload,
        } => match method.as_str() {
            // Non-blocking status message: surface as a session notice, not an ask.
            "notify" => {
                let body = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .or_else(|| payload.get("title").and_then(Value::as_str))
                    .unwrap_or("");
                let notify_type = payload.get("notifyType").and_then(Value::as_str);
                let level = match notify_type.map(str::to_ascii_lowercase).as_deref() {
                    Some("error") => NoticeLevel::Error,
                    Some("warning") => NoticeLevel::Warning,
                    _ => NoticeLevel::Info,
                };
                let text = match notify_type {
                    Some(kind) => format!("{kind}: {body}"),
                    None => body.to_string(),
                };
                let _ = state
                    .events
                    .emit(state, notice(target_session_id, level, text))
                    .await;
            }
            // The agent withdrew a pending request; clear the ask if it still matches.
            "cancel" => {
                if let Some(target_id) = payload
                    .get("targetId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    let session_id = target_session_id.clone();
                    state
                        .events
                        .mutate_session_and_emit(state, &target_session_id, move |record| {
                            let current_id = record
                                .pending_ask
                                .as_ref()
                                .and_then(|pending| pending.get("id"))
                                .and_then(Value::as_str);
                            if current_id != Some(target_id.as_str()) {
                                return None;
                            }
                            record.pending_ask = None;
                            Some(ServerMessage::SessionSnapshot {
                                session_id,
                                state: record.projection(),
                            })
                        })
                        .await;
                }
            }
            // Blocking request awaiting a user response: the session enters its ask state.
            "select" | "confirm" | "input" | "editor" | "open_url" => {
                let mut dialog = payload;
                dialog.insert("id".to_string(), Value::String(id));
                dialog.insert("method".to_string(), Value::String(method));
                state
                    .events
                    .mutate_session_snapshot(state, &target_session_id, |record| {
                        record.pending_ask = Some(Value::Object(dialog));
                    })
                    .await;
            }
            // TUI chrome updates (setStatus/setWidget/setTitle/set_editor_text) have no Fura
            // surface and await no response; drop them rather than surfacing a dead control.
            other => {
                debug!(
                    session_id = %target_session_id,
                    method = other,
                    "ignored non-ask extension UI request"
                );
            }
        },
        OmpRpcFrame::HostToolCall {
            id,
            tool_call_id,
            tool_name,
            arguments,
        } => {
            handle_session_host_tool_call(state, session_id, id, tool_call_id, tool_name, arguments)
                .await
        }
        OmpRpcFrame::HostToolCancel { id, target_id } => {
            handle_session_host_tool_cancel(state, session_id, id, target_id).await
        }
        OmpRpcFrame::HostToolResult { .. } | OmpRpcFrame::HostToolUpdate { .. } => {
            debug!(transport_session_id = %session_id, "ignored outbound host-tool OMP RPC frame");
        }
        OmpRpcFrame::HostUriRequest { .. }
        | OmpRpcFrame::HostUriCancel { .. }
        | OmpRpcFrame::HostUriResult { .. } => {
            debug!(transport_session_id = %session_id, "ignored host URI OMP RPC frame; Fura does not register host URI schemes");
        }
        OmpRpcFrame::Unknown => {
            debug!(transport_session_id = %session_id, "ignored unknown OMP RPC frame");
        }
    }
}

fn map_plan_mode_state_projection(value: Option<&OmpPlanModeState>) -> Option<PlanModeProjection> {
    let value = value?;
    if !value.enabled {
        return None;
    }
    Some(PlanModeProjection {
        enabled: true,
        plan_file_path: value
            .plan_file_path
            .clone()
            .unwrap_or_else(|| "local://PLAN.md".to_string()),
        workflow: value.workflow.clone(),
    })
}

fn map_goal_runtime_mode(value: &str) -> Option<GoalModeRuntimeMode> {
    match value {
        "active" => Some(GoalModeRuntimeMode::Active),
        "exiting" => Some(GoalModeRuntimeMode::Exiting),
        _ => None,
    }
}

fn map_goal_reason(value: &str) -> Option<GoalModeReason> {
    match value {
        "completed" => Some(GoalModeReason::Completed),
        _ => None,
    }
}

fn map_goal_status(value: &str) -> Option<GoalStatusProjection> {
    match value {
        "active" => Some(GoalStatusProjection::Active),
        "paused" => Some(GoalStatusProjection::Paused),
        "budget-limited" => Some(GoalStatusProjection::BudgetLimited),
        "complete" => Some(GoalStatusProjection::Complete),
        "dropped" => Some(GoalStatusProjection::Dropped),
        _ => None,
    }
}

fn map_goal_mode_state_projection(value: Option<&OmpGoalModeState>) -> Option<GoalModeProjection> {
    let value = value?;
    let goal = value.goal.as_ref()?;
    Some(GoalModeProjection {
        enabled: value.enabled,
        mode: map_goal_runtime_mode(&value.mode).unwrap_or(GoalModeRuntimeMode::Active),
        reason: value.reason.as_deref().and_then(map_goal_reason),
        goal: GoalProjection {
            id: goal.id.clone(),
            objective: goal.objective.clone(),
            status: map_goal_status(&goal.status)?,
            token_budget: goal.token_budget,
            tokens_used: goal.tokens_used,
            time_used_seconds: goal.time_used_seconds,
            created_at: goal.created_at,
            updated_at: goal.updated_at,
        },
    })
}

pub(crate) fn map_goal_mode_projection(value: &Value) -> Option<GoalModeProjection> {
    if value.is_null() {
        return None;
    }
    let goal = value.get("goal")?;
    Some(GoalModeProjection {
        enabled: value
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        mode: value_str(value, "mode")
            .and_then(map_goal_runtime_mode)
            .unwrap_or(GoalModeRuntimeMode::Active),
        reason: value_str(value, "reason").and_then(map_goal_reason),
        goal: GoalProjection {
            id: value_str(goal, "id")?.to_string(),
            objective: value_str(goal, "objective")?.to_string(),
            status: value_str(goal, "status").and_then(map_goal_status)?,
            token_budget: goal.get("tokenBudget").and_then(|v| v.as_u64()),
            tokens_used: goal.get("tokensUsed").and_then(|v| v.as_u64())?,
            time_used_seconds: goal.get("timeUsedSeconds").and_then(|v| v.as_u64())?,
            created_at: goal.get("createdAt").and_then(|v| v.as_u64())?,
            updated_at: goal.get("updatedAt").and_then(|v| v.as_u64())?,
        },
    })
}

async fn prepend_plan_execution_carryover(
    state: &AppState,
    session_id: &str,
    messages: &mut Vec<TranscriptMessage>,
) {
    let Some(carryover) = state
        .session_runtime
        .plan_execution_carryover(session_id)
        .await
    else {
        return;
    };
    let id = format!(
        "approved-plan:{}:{}",
        session_id, carryover.final_plan_file_path
    );
    if messages.iter().any(|message| message.id == id) {
        return;
    }
    let title = carryover
        .plan_title
        .as_deref()
        .map(|title| format!("Approved plan: {title}"))
        .unwrap_or_else(|| "Approved plan".to_string());
    let text = format!(
        "# {title}\n\nSource plan: `{}`\nApproved artifact: `{}`\nExecution session: `{}`\n\n{}",
        carryover.plan_file_path,
        carryover.final_plan_file_path,
        carryover.execution_title,
        carryover.content,
    );
    messages.insert(
        0,
        TranscriptMessage::new(
            id,
            MessageRole::System,
            vec![ContentBlock::Text { text }],
            None,
            false,
        ),
    );
}

pub(crate) async fn apply_model_change_response(
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

    state
        .events
        .mutate_session_snapshot(state, session_id, |record| {
            record.model = Some(display_name);
            if let Some(thinking_level) = thinking_level {
                record.thinking_level = Some(thinking_level);
            }
        })
        .await;
    let _ = state
        .events
        .emit(
            state,
            ServerMessage::ModelChanged {
                session_id: session_id.to_string(),
                model,
            },
        )
        .await;
}

pub(crate) async fn apply_thinking_level_response(
    state: &AppState,
    session_id: &str,
    thinking_level: Option<String>,
) {
    let Some(thinking_level) = thinking_level else {
        return;
    };
    state
        .events
        .mutate_session_snapshot(state, session_id, |record| {
            record.thinking_level = Some(thinking_level);
        })
        .await;
}

pub(crate) async fn apply_rpc_response(state: &AppState, session_id: &str, frame: &Value) {
    let command = value_str(frame, "command").or_else(|| value_str(frame, "requestType"));
    let status = value_str(frame, "status");
    let success = frame.get("success").and_then(|value| value.as_bool());
    let current_session_id = rpc_session_target_id(state, session_id).await;
    let is_controller = is_controller_transport(state, session_id).await;
    if status == Some("error") || success == Some(false) {
        let message = rpc_error_message(frame);
        warn!(session_id = %session_id, command = command.unwrap_or("unknown"), %message, "RPC command returned error");
        if is_controller {
            handle_controller_rpc_error(state, message).await;
            return;
        }
        if is_model_catalog_transport(state, session_id).await {
            let request_id = complete_model_catalog_request(state, session_id).await;
            let _ = state
                .events
                .emit(
                    state,
                    ServerMessage::Error {
                        request_id,
                        message,
                    },
                )
                .await;
            return;
        }
        let pending_create = state.session_runtime.pending_create(session_id).await;
        if let Some(pending) = pending_create {
            let label = pending
                .proposed_model
                .as_ref()
                .map(|model| model.name.clone())
                .unwrap_or_else(|| "session".to_string());
            let create_message = match command {
                Some("set_model") => {
                    format!("Failed to apply proposed model \"{label}\": {message}")
                }
                Some("set_thinking_level") => {
                    format!("Failed to apply thinking level for \"{label}\": {message}")
                }
                _ => message,
            };
            fail_pending_create_initialization(
                state,
                session_id,
                pending.request_id,
                create_message,
            )
            .await;
            return;
        }
        if rpc_prompt_busy_needs_client_choice(command, &message) {
            if let Some(prompt_busy) = take_pending_prompt_busy_message(state, frame).await {
                let _ = state.events.emit(state, prompt_busy).await;
                return;
            }
            if command == Some("prompt") {
                if let Some(command_id) = value_str(frame, "id") {
                    let cleared_review =
                        clear_review_context_for_command(state, &current_session_id, command_id)
                            .await;
                    let cleared_conflict =
                        clear_conflict_context_for_command(state, &current_session_id, command_id)
                            .await;
                    if cleared_review || cleared_conflict {
                        let _ = refresh_rpc_state(state, &current_session_id).await;
                    }
                }
            }
        }
        if matches!(command, Some("prompt" | "set_host_tools")) {
            if let Some(command_id) = value_str(frame, "id") {
                let cleared_review =
                    clear_review_context_for_command(state, &current_session_id, command_id).await;
                let cleared_conflict =
                    clear_conflict_context_for_command(state, &current_session_id, command_id)
                        .await;
                if (cleared_review || cleared_conflict) && command == Some("set_host_tools") {
                    settle_prompt_error_and_broadcast(state, &current_session_id).await;
                }
            }
        }
        if command == Some("repo_diff_snapshot") {
            if let Some(command_id) = value_str(frame, "id") {
                state
                    .pending_session_change_snapshots
                    .write()
                    .await
                    .remove(command_id);
            }
        }
        if rpc_prompt_error_settles_turn(command, &message) {
            settle_prompt_error_and_broadcast(state, &current_session_id).await;
        }
        let _ = state
            .events
            .emit(
                state,
                notice(current_session_id, NoticeLevel::Error, message),
            )
            .await;
        return;
    }

    match command {
        Some("repo_diff_snapshot") => {
            let pending = if let Some(command_id) = value_str(frame, "id") {
                state
                    .pending_session_change_snapshots
                    .write()
                    .await
                    .remove(command_id)
            } else {
                None
            };
            if let Some(mut pending) = pending {
                if pending.select_created_snapshot {
                    if let Some(entry_id) = selected_repo_diff_snapshot_entry_id(frame) {
                        pending.repo_id = Some(crate::diff::snapshot_candidate_id(&entry_id));
                    }
                }
                let request = DiffRequestIdentity::SessionChanges {
                    client_id: pending.client_id.clone(),
                    diff_id: pending.diff_id.clone(),
                    session_id: pending.session_id.clone(),
                    repo_id: pending.repo_id.clone(),
                    detail_mode: pending.detail_mode,
                    current_commit_oid: pending.current_commit_oid.clone(),
                    selected_file: pending.selected_file.clone(),
                    context_lines: pending.context_lines,
                };
                start_session_changes_generation_job(
                    state,
                    pending.client_id.clone(),
                    pending.diff_id.clone(),
                    pending.session_id.clone(),
                    pending.repo_id,
                    pending.detail_mode,
                    pending.current_commit_oid,
                    pending.selected_file,
                    request,
                    pending.context_lines,
                )
                .await;
                let _ = state
                    .events
                    .emit(
                        state,
                        notice(
                            pending.session_id,
                            NoticeLevel::Info,
                            "Diff snapshot created.",
                        ),
                    )
                    .await;
            } else {
                let _ = state
                    .events
                    .emit(
                        state,
                        notice(
                            current_session_id.clone(),
                            NoticeLevel::Info,
                            "Diff snapshot created.",
                        ),
                    )
                    .await;
            }
        }
        Some("get_available_models") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let models = data
                .and_then(|data| data.get("models"))
                .and_then(|models| models.as_array())
                .map(|models| models.iter().filter_map(model_summary).collect())
                .unwrap_or_default();
            if is_model_catalog_transport(state, session_id).await {
                let request_id = complete_model_catalog_request(state, session_id).await;
                let _ = state
                    .events
                    .emit(
                        state,
                        ServerMessage::ConfigModelCatalogList { request_id, models },
                    )
                    .await;
            } else {
                let _ = state
                    .events
                    .emit(
                        state,
                        ServerMessage::ModelList {
                            session_id: current_session_id.clone(),
                            models,
                        },
                    )
                    .await;
            }
        }
        Some("approve_plan_mode") => {
            let pending_name = state
                .session_runtime
                .pending_session_name(&current_session_id)
                .await;
            if let Some(ref name) = pending_name {
                let cmd = set_session_name_command(next_rpc_id(), name.clone());
                if let Err(e) = send_rpc_command(state, session_id, cmd).await {
                    warn!(session_id = %session_id, error = %e, "failed to queue set_session_name after plan approval");
                }
            }
            if let Err(message) = refresh_rpc_state(state, session_id).await {
                warn!(session_id = %session_id, %message, "post-plan-approval refresh failed");
            }
        }

        Some("set_plan_mode") => {
            let plan_mode = rpc_response_data_as::<OmpPlanModeResponse>(frame)
                .and_then(|data| map_plan_mode_state_projection(data.plan_mode.as_ref()));
            state
                .events
                .mutate_session_snapshot(state, &current_session_id, |record| {
                    record.plan_mode = plan_mode;
                })
                .await;
        }
        Some("goal_mode") => {
            let goal_mode = rpc_response_data_as::<OmpGoalModeResponse>(frame)
                .and_then(|data| map_goal_mode_state_projection(data.goal_mode.as_ref()));
            let snapshot_sent = state
                .events
                .mutate_session_snapshot(state, &current_session_id, |record| {
                    record.goal_mode = goal_mode;
                })
                .await;
            if snapshot_sent {
                broadcast_sessions_snapshot(state).await;
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
        Some("set_thinking_level") => {
            if state
                .session_runtime
                .pending_create(session_id)
                .await
                .is_none()
            {
                if let Err(message) =
                    send_rpc_command(state, session_id, get_state_command(next_rpc_id())).await
                {
                    warn!(session_id = %current_session_id, %message, "post-thinking-change state refresh failed");
                }
            }
        }
        Some("cycle_thinking_level") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let thinking_level = data
                .and_then(|data| data.get("level"))
                .and_then(|value| value.as_str())
                .map(str::to_string);
            apply_thinking_level_response(state, &current_session_id, thinking_level).await;
        }
        Some("get_messages") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let projection = data
                .and_then(|data| data.get("messages"))
                .and_then(|messages| messages.as_array())
                .map(|messages| project_omp_transcript(messages));
            if let Some((mut messages, tool_cards)) = projection {
                prepend_plan_execution_carryover(state, &current_session_id, &mut messages).await;
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
            if is_controller {
                apply_controller_get_state(state, session_id, frame).await;
                return;
            }
            let Some(data) = rpc_response_data_as::<OmpSessionState>(frame) else {
                warn!(session_id = %current_session_id, "get_state response did not match the typed OMP RPC contract");
                return;
            };
            let target_session_id = data.session_id.clone();
            let session_name = data.session_name.clone();
            let model = data.model.as_ref().and_then(model_display_name);
            let thinking_level = data.thinking_level.clone();
            let session_file = data.session_file.clone();
            let context_tokens = data.context_usage.as_ref().and_then(|usage| usage.tokens);
            let context_window = data
                .context_usage
                .as_ref()
                .and_then(|usage| usage.context_window);
            let context_percent = data.context_usage.as_ref().and_then(|usage| usage.percent);
            let plan_mode = Some(map_plan_mode_state_projection(data.plan_mode.as_ref()));
            let goal_mode = Some(map_goal_mode_state_projection(data.goal_mode.as_ref()));
            let todo_phases = Some(data.todo_phases);
            let outcome = apply_get_state_update(
                state,
                session_id,
                RpcStateUpdate {
                    current_session_id: current_session_id.clone(),
                    target_session_id: target_session_id.clone(),
                    session_name,
                    model,
                    thinking_level,
                    session_file,
                    context_tokens,
                    context_window,
                    context_percent,
                    plan_mode,
                    goal_mode,
                    todo_phases,
                },
            )
            .await;

            let _ = outcome;
            broadcast_sessions_snapshot(state).await;
        }
        Some("handoff") => {
            let snapshot_sent = state
                .events
                .mutate_session_snapshot(state, &current_session_id, |record| {
                    record.status = SessionStatus::Idle;
                    record.live_message_ids.clear();
                })
                .await;
            if snapshot_sent {
                broadcast_sessions_snapshot(state).await;
            }
            // Queue the requested name before refresh so set_session_name reaches OMP before get_state.
            // Keep the pending name until get_state reports the new OMP session id, then apply it to that target.
            let pending_name = state.session_runtime.pending_session_name(session_id).await;
            if let Some(ref name) = pending_name {
                let cmd = set_session_name_command(next_rpc_id(), name.clone());
                if let Err(e) = send_rpc_command(state, session_id, cmd).await {
                    warn!(session_id = %session_id, error = %e, "failed to queue set_session_name after handoff");
                }
            }
            if let Err(message) = refresh_rpc_state(state, session_id).await {
                warn!(session_id = %session_id, %message, "post-handoff state refresh failed");
            }
            let _ = state
                .events
                .emit(
                    state,
                    notice(
                        current_session_id,
                        NoticeLevel::Info,
                        "Handoff complete. New session context loaded.",
                    ),
                )
                .await;
        }
        Some("fork") => {
            let data = frame.get("data").or_else(|| frame.get("result"));
            let cancelled = data
                .and_then(|data| data.get("cancelled"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            if cancelled {
                state
                    .session_runtime
                    .remove_pending_session_name(session_id)
                    .await;
                let _ = state
                    .events
                    .emit(
                        state,
                        notice(
                            current_session_id,
                            NoticeLevel::Warning,
                            "Fork cancelled or unavailable for this session.",
                        ),
                    )
                    .await;
            } else {
                // Queue the requested name before refresh so set_session_name reaches OMP before get_state.
                // Keep the pending name until get_state reports the new OMP session id, then apply it to that target.
                let pending_name = state.session_runtime.pending_session_name(session_id).await;
                if let Some(ref name) = pending_name {
                    let cmd = set_session_name_command(next_rpc_id(), name.clone());
                    if let Err(e) = send_rpc_command(state, session_id, cmd).await {
                        warn!(session_id = %session_id, error = %e, "failed to queue set_session_name after fork");
                    }
                }
                if let Err(message) = refresh_rpc_state(state, session_id).await {
                    warn!(session_id = %session_id, %message, "post-fork state refresh failed");
                    let _ = state
                        .events
                        .emit(
                            state,
                            notice(
                                current_session_id,
                                NoticeLevel::Error,
                                format!("Fork completed, but state refresh failed: {message}"),
                            ),
                        )
                        .await;
                } else {
                    let _ = state
                        .events
                        .emit(
                            state,
                            notice(
                                current_session_id,
                                NoticeLevel::Info,
                                "Fork complete. New session is active.",
                            ),
                        )
                        .await;
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
            state
                .events
                .mutate_session_snapshot(state, &current_session_id, |record| {
                    if let Some(total) = tokens_total {
                        record.tokens_total = total;
                    }
                    if let Some(cost) = cost_usd {
                        record.cost_usd = cost;
                    }
                })
                .await;
        }
        Some("prompt") | Some("abort") => {}
        _ => {}
    }
}

pub(crate) fn rpc_prompt_busy_needs_client_choice(command: Option<&str>, message: &str) -> bool {
    matches!(command, Some("prompt")) && message.contains("Agent is already processing")
}

pub(crate) async fn take_pending_prompt_busy_message(
    state: &AppState,
    frame: &Value,
) -> Option<ServerMessage> {
    let command_id = value_str(frame, "id")?;
    let draft = state
        .pending_prompt_drafts
        .write()
        .await
        .remove(command_id)?;
    remove_optimistic_prompt_message(state, &draft.session_id, &draft.optimistic_message_id).await;
    Some(ServerMessage::PromptBusy {
        session_id: draft.session_id,
        text: draft.text,
        images: draft.images,
    })
}

pub(crate) async fn discard_pending_prompt_drafts_for_session(state: &AppState, session_id: &str) {
    state
        .pending_prompt_drafts
        .write()
        .await
        .retain(|_, draft| draft.session_id != session_id);
}

pub(crate) fn rpc_prompt_error_settles_turn(command: Option<&str>, message: &str) -> bool {
    matches!(
        command,
        Some("prompt" | "abort_and_prompt" | "steer" | "follow_up")
    ) && !message.contains("Agent is already processing")
}

pub(crate) async fn settle_prompt_error_and_broadcast(state: &AppState, session_id: &str) {
    let snapshot_sent = state
        .events
        .mutate_session_snapshot(state, session_id, |record| {
            record.status = SessionStatus::Idle;
            record.streaming_message = None;
        })
        .await;
    if snapshot_sent {
        broadcast_sessions_snapshot(state).await;
    }
}

pub(crate) async fn mark_status_and_broadcast(
    state: &AppState,
    session_id: &str,
    status: SessionStatus,
) {
    let snapshot_sent = state
        .events
        .mutate_session_snapshot(state, session_id, |record| {
            record.status = status;
        })
        .await;
    if snapshot_sent {
        broadcast_sessions_snapshot(state).await;
    }
}

pub(crate) fn replace_record_transcript(
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
                msg.refresh_render_hash();
            }
            msg
        })
        .collect();
    record.messages = reconciled;
    record.tool_cards = tool_cards;
    true
}

#[cfg(test)]
pub(crate) fn replace_record_messages(
    record: &mut SessionRecord,
    messages: Vec<TranscriptMessage>,
) -> bool {
    replace_record_transcript(record, messages, Vec::new())
}

pub(crate) async fn replace_messages_and_broadcast(
    state: &AppState,
    session_id: &str,
    messages: Vec<TranscriptMessage>,
    tool_cards: Vec<ToolCard>,
    status: Option<SessionStatus>,
) {
    let snapshot_sent = state
        .events
        .mutate_session_snapshot(state, session_id, |record| {
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
        })
        .await;
    if snapshot_sent {
        broadcast_sessions_snapshot(state).await;
    }
}

pub(crate) fn log_rpc_frame(session_id: &str, frame: &Value) {
    info!(
        direction = "rpc_to_bridge",
        session_id = %session_id,
        frame_type = frame.get("type").and_then(|value| value.as_str()).unwrap_or("unknown"),
        command = frame.get("command").and_then(|value| value.as_str()).unwrap_or("none"),
        status = frame.get("status").and_then(|value| value.as_str()).unwrap_or("none")
    );
}

pub(crate) fn unknown_session_error(session_id: String) -> ServerMessage {
    ServerMessage::Error {
        request_id: None,
        message: format!("unknown session: {session_id}"),
    }
}

pub(crate) fn rpc_error_message(frame: &Value) -> String {
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

pub(crate) fn command_type(command: &Value) -> &str {
    value_str(command, "type").unwrap_or("unknown")
}

pub(crate) fn model_summary(value: &Value) -> Option<ModelSummary> {
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

pub(crate) fn model_display_name(value: &Value) -> Option<String> {
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

pub(crate) fn value_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|value| value.as_str())
}

fn rpc_response_data_as<T>(frame: &Value) -> Option<T>
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_value::<OmpRpcResponseFrame>(frame.clone())
        .ok()
        .and_then(|response| response.data_as())
}

fn selected_repo_diff_snapshot_entry_id(frame: &Value) -> Option<String> {
    Some(
        rpc_response_data_as::<OmpRepoDiffResult>(frame)?
            .selected_snapshot?
            .entry_id,
    )
}

pub(crate) fn tool_async_state(result: &Value) -> Option<&str> {
    result.get("details")?.get("async")?.get("state")?.as_str()
}

pub(crate) fn ensure_rpc_id(command: &mut Value) {
    let Some(object) = command.as_object_mut() else {
        return;
    };
    object
        .entry("id".to_string())
        .or_insert_with(|| Value::String(next_rpc_id()));
}

pub(crate) async fn append_bridge_debug_rpc_line(state: &AppState, session_id: &str, line: &str) {
    let record = serde_json::json!({
        "timestampMs": Timestamp::now().millis(),
        "sessionId": session_id,
        "direction": "rpc_to_bridge",
        "rawLine": line,
    });
    append_bridge_debug_record(state, record, "RPC frame").await;
}

pub(crate) async fn append_bridge_debug_event(
    state: &AppState,
    event_type: &'static str,
    mut fields: serde_json::Map<String, Value>,
) {
    fields.insert(
        "timestampMs".to_string(),
        Value::Number(Timestamp::now().millis().into()),
    );
    fields.insert("type".to_string(), Value::String(event_type.to_string()));
    append_bridge_debug_record(state, Value::Object(fields), event_type).await;
}

async fn append_bridge_debug_record(state: &AppState, record: Value, label: &str) {
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

    let Ok(mut encoded) = serde_json::to_string(&record) else {
        warn!(event = label, "failed to serialize bridge debug event");
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
                warn!(path = %path.display(), %error, event = label, "failed to write bridge debug event");
            }
        }
        Err(error) => {
            warn!(path = %path.display(), %error, "failed to open bridge debug file");
        }
    }
}
