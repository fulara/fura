use std::collections::HashSet;
use std::process::Stdio;

use serde_json::Value;
use tokio::{
    fs as async_fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
};
use tracing::{info, warn};

use crate::*;

pub(crate) async fn refresh_rpc_state(state: &AppState, session_id: &str) -> Result<(), String> {
    send_rpc_command(state, session_id, get_state_command(next_rpc_id())).await?;
    send_rpc_command(state, session_id, get_messages_command(next_rpc_id())).await?;
    send_rpc_command(state, session_id, get_session_stats_command(next_rpc_id())).await
}

pub(crate) async fn rpc_session_target_id(state: &AppState, transport_session_id: &str) -> String {
    state
        .rpc_session_targets
        .read()
        .await
        .get(transport_session_id)
        .cloned()
        .unwrap_or_else(|| transport_session_id.to_string())
}

pub(crate) async fn rpc_transport_session_id(state: &AppState, session_id: &str) -> Option<String> {
    if state.rpc_sessions.read().await.contains_key(session_id) {
        return Some(session_id.to_string());
    }

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

pub(crate) async fn send_rpc_command(
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
        if reset_controller_if_transport_exited(&state, &session_id).await {
            return;
        }
        let pending_create = state
            .pending_created_sessions
            .write()
            .await
            .remove(&session_id);
        match status {
            Ok(status) => {
                let code = status.code();
                info!(action = "rpc.exit", session_id = %session_id, target_session_id = %target_session_id, code = ?code);
                if let Some(pending_create) = pending_create {
                    let _ = state.events.send(ServerMessage::Error {
                        request_id: pending_create.request_id,
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
                if let Some(pending_create) = pending_create {
                    let _ = state.events.send(ServerMessage::Error {
                        request_id: pending_create.request_id,
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

pub(crate) async fn read_rpc_stderr<R>(state: AppState, session_id: String, reader: BufReader<R>)
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
                    let _ = state.events.send(ServerMessage::ControlStatus {
                        target_client_id: Some(run.target_client_id),
                        status: ControlStatusProjection {
                            status: "working".to_string(),
                            message: Some("Ask Fura is working.".to_string()),
                        },
                    });
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
            OmpRpcFrame::HostToolCancel { .. }
            | OmpRpcFrame::ExtensionUiRequest { .. }
            | OmpRpcFrame::MessageUpdate { .. }
            | OmpRpcFrame::MessageEnd { .. }
            | OmpRpcFrame::ToolExecutionStart { .. }
            | OmpRpcFrame::ToolExecutionUpdate { .. }
            | OmpRpcFrame::ToolExecutionEnd { .. }
            | OmpRpcFrame::PlanReview { .. }
            | OmpRpcFrame::Unknown => {}
        }
        return;
    }
    match typed_frame {
        OmpRpcFrame::Ready => {
            mark_status_and_broadcast(state, &target_session_id, SessionStatus::Idle).await;
            if let Err(message) = refresh_rpc_state(state, session_id).await {
                warn!(session_id = %session_id, %message, "initial RPC refresh failed");
            }
        }
        OmpRpcFrame::AgentStart => {
            discard_pending_prompt_drafts_for_session(state, &target_session_id).await;
            mark_status_and_broadcast(state, &target_session_id, SessionStatus::Busy).await
        }
        OmpRpcFrame::AgentEnd { .. } => {
            mark_status_and_broadcast(state, &target_session_id, SessionStatus::Idle).await;
            if let Err(message) =
                send_rpc_command(state, &target_session_id, get_messages_command(next_rpc_id())).await
            {
                warn!(session_id = %target_session_id, %message, "post-agent transcript refresh failed");
            }
            if let Err(message) =
                send_rpc_command(state, &target_session_id, get_session_stats_command(next_rpc_id())).await
            {
                warn!(session_id = %target_session_id, %message, "post-agent stats refresh failed");
            }
        }
        OmpRpcFrame::PlanReview {
            plan_file_path,
            final_plan_file_path,
            title,
            content,
        } => {
            let _ = state.events.send(ServerMessage::PlanReview {
                session_id: target_session_id.clone(),
                plan_file_path,
                final_plan_file_path,
                title,
                content,
            });
        }
        OmpRpcFrame::MessageUpdate { message, .. } => {
            let event_timestamp = value_timestamp(frame).unwrap_or_else(Timestamp::now);
            if let Some(mut message) = map_omp_message(&message) {
                if message.timestamp.is_none() {
                    message.timestamp = Some(event_timestamp);
                }
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
        OmpRpcFrame::MessageEnd { message } => {
            let event_timestamp = value_timestamp(frame).unwrap_or_else(Timestamp::now);
            if let Some(mut message) = map_omp_message(&message) {
                if message.timestamp.is_none() {
                    message.timestamp = Some(event_timestamp);
                }
                message.is_new = true;
                // Clear streaming_message and push the final message atomically in a single
                // lock so no snapshot can fire showing a gap between the two.
                let snapshot = {
                    let mut sessions = state.sessions.write().await;
                    sessions.get_mut(&target_session_id).map(|record| {
                        record.streaming_message = None;
                        record.live_message_ids.insert(message.id.clone());
                        record.messages.push(message);
                        record.updated_at = Timestamp::now();
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
        OmpRpcFrame::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
            intent,
        } => {
            let event_timestamp = value_timestamp(frame).unwrap_or_else(Timestamp::now);
            let snapshot = {
                let mut sessions = state.sessions.write().await;
                sessions.get_mut(&target_session_id).map(|record| {
                    let insert_after_count = record.messages.len();
                    record.active_tool_calls.push(ToolCard {
                        tool_call_id,
                        timestamp: Some(event_timestamp),
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
        OmpRpcFrame::ToolExecutionUpdate {
            tool_call_id,
            partial_result,
            ..
        } => {
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
                        let todo_phases = if card.tool_name == "todo_write" && !card.is_error {
                            todo_phases_from_tool_result_value(partial_result.as_ref())
                        } else {
                            None
                        };
                        card.result = partial_result;
                        card.partial_result = None;
                        if let Some(todo_phases) = todo_phases {
                            record.todo_phases = Some(todo_phases);
                        }
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
        OmpRpcFrame::ToolExecutionEnd {
            tool_call_id,
            tool_name: _,
            result,
            is_error,
        } => {
            let is_error = is_error.unwrap_or(false);
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
        }
        OmpRpcFrame::Response(response) => {
            let _ = response.is_error();
            let _ = response.payload();
            apply_rpc_response(state, session_id, frame).await
        }
        OmpRpcFrame::ExtensionUiRequest { .. }
        | OmpRpcFrame::HostToolCall { .. }
        | OmpRpcFrame::HostToolCancel { .. }
        | OmpRpcFrame::Unknown => apply_rpc_response(state, session_id, frame).await,
    }
}

pub(crate) fn map_plan_mode_projection(value: &Value) -> Option<PlanModeProjection> {
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

pub(crate) fn apply_rpc_state_to_record(
    record: &mut SessionRecord,
    session_name: Option<String>,
    model: Option<String>,
    thinking_level: Option<String>,
    session_file: Option<String>,
    context_tokens: Option<u64>,
    context_window: Option<u64>,
    context_percent: Option<f64>,
    plan_mode: Option<Option<PlanModeProjection>>,
    todo_phases: Option<Vec<TodoPhaseProjection>>,
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
    if let Some(todo_phases) = todo_phases {
        record.todo_phases = Some(todo_phases);
    }
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
        if rpc_prompt_busy_needs_client_choice(command, &message) {
            if let Some(prompt_busy) = take_pending_prompt_busy_message(state, frame).await {
                let _ = state.events.send(prompt_busy);
                return;
            }
        }
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
            if is_controller {
                apply_controller_get_state(state, session_id, frame).await;
                return;
            }
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
            let todo_phases = data.and_then(|d| d.get("todoPhases")).map(|value| {
                parse_todo_phases_value(value).unwrap_or_else(|error| {
                    warn!(session_id = %current_session_id, %error, "invalid todoPhases in get_state response");
                    Vec::new()
                })
            });
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
            let pending_switch_name = if target_changed {
                state
                    .pending_new_session_names
                    .write()
                    .await
                    .remove(&current_session_id)
            } else {
                None
            };
            let effective_session_name = pending_switch_name.clone().or(session_name);

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
                            let now = Timestamp::now();
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
                                todo_phases: None,
                                kind: SessionKind::Managed,
                                session_file: None,
                                title: pending_create
                                    .as_ref()
                                    .and_then(|pending| pending.title.clone())
                                    .or_else(|| pending_switch_name.clone()),
                                timestamp: None,
                                category: source
                                    .as_ref()
                                    .and_then(|record| record.category.clone())
                                    .or_else(|| {
                                        pending_create
                                            .as_ref()
                                            .and_then(|pending| pending.category.clone())
                                    }),
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
                        record.updated_at = Timestamp::now();
                        apply_rpc_state_to_record(
                            record,
                            effective_session_name,
                            model,
                            thinking_level,
                            session_file,
                            context_tokens,
                            context_window,
                            context_percent,
                            plan_mode.clone(),
                            todo_phases.clone(),
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
                            effective_session_name,
                            model,
                            thinking_level,
                            session_file,
                            context_tokens,
                            context_window,
                            context_percent,
                            plan_mode,
                            todo_phases,
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

            let target_category = if target_changed {
                let sessions = state.sessions.read().await;
                sessions
                    .get(&target_session_id)
                    .and_then(|record| record.category.clone())
            } else {
                None
            };
            if target_changed {
                state
                    .rpc_session_targets
                    .write()
                    .await
                    .insert(session_id.to_string(), target_session_id.clone());
                {
                    let mut categories = state.session_categories.write().await;
                    if let Some(category) = target_category {
                        categories.insert(target_session_id.clone(), category);
                    } else {
                        categories.remove(&target_session_id);
                    }
                }
                save_fura_config(state).await;
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
            // Queue the requested name before refresh so set_session_name reaches OMP before get_state.
            // Keep the pending name until get_state reports the new OMP session id, then apply it to that target.
            let pending_name = state
                .pending_new_session_names
                .read()
                .await
                .get(session_id)
                .cloned();
            if let Some(ref name) = pending_name {
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
                // Queue the requested name before refresh so set_session_name reaches OMP before get_state.
                // Keep the pending name until get_state reports the new OMP session id, then apply it to that target.
                let pending_name = state
                    .pending_new_session_names
                    .read()
                    .await
                    .get(session_id)
                    .cloned();
                if let Some(ref name) = pending_name {
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

pub(crate) async fn mark_status_and_broadcast(
    state: &AppState,
    session_id: &str,
    status: SessionStatus,
) {
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
        "timestampMs": Timestamp::now().millis(),
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
