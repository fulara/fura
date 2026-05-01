use serde::Deserialize;
use serde_json::{Value, json};
use tracing::{info, warn};
use uuid::Uuid;

use crate::*;

const CONTROLLER_SESSION_TITLE: &str = "Fura Controller";
const FURA_TOOL_NAMES: &[&str] = &[
    "fura_search_sessions",
    "fura_reply",
    "fura_filter_sessions",
    "fura_select_session",
    "fura_set_prompt_draft",
    "fura_show_notice",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchSessionsArgs {
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplyArgs {
    message: String,
    #[serde(default)]
    candidates: Vec<ControlCandidate>,
    #[serde(default)]
    suggested_actions: Vec<ControlSuggestedAction>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilterSessionsArgs {
    query: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectSessionArgs {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPromptDraftArgs {
    session_id: Option<String>,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShowNoticeArgs {
    level: NoticeLevel,
    text: String,
}

pub(crate) async fn handle_control_prompt(
    state: &AppState,
    client_id: String,
    conversation_id: Option<String>,
    text: String,
    ui_snapshot: FrontendUiSnapshot,
) -> Vec<ServerMessage> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return vec![ServerMessage::Error {
            request_id: None,
            message: "control prompt cannot be empty".to_string(),
        }];
    }

    let conversation_id = conversation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let active_session_id = ui_snapshot.active_session_id.clone();
    let prior_candidates = {
        let controller = state.bridge_controller.read().await;
        if let Some(run) = &controller.active_run {
            return vec![ServerMessage::ControlStatus {
                target_client_id: Some(client_id),
                status: ControlStatusProjection {
                    status: "error".to_string(),
                    message: Some(format!(
                        "Ask Fura is already handling a request for conversation {}.",
                        run.conversation_id
                    )),
                },
            }];
        }
        controller
            .conversations
            .get(&conversation_id)
            .map(|conversation| conversation.last_candidates.clone())
            .unwrap_or_default()
    };

    let transport_session_id = match ensure_controller_session(state).await {
        Ok(session_id) => session_id,
        Err(message) => {
            return vec![ServerMessage::ControlStatus {
                target_client_id: Some(client_id),
                status: ControlStatusProjection {
                    status: "error".to_string(),
                    message: Some(message),
                },
            }];
        }
    };

    {
        let mut controller = state.bridge_controller.write().await;
        controller.conversations.insert(
            conversation_id.clone(),
            ControlConversationState {
                last_candidates: prior_candidates.clone(),
                last_ui_snapshot: ui_snapshot.clone(),
            },
        );
        controller.active_run = Some(BridgeControllerRun {
            target_client_id: client_id.clone(),
            conversation_id: conversation_id.clone(),
            active_session_id,
            prompt_started_at: Timestamp::now(),
        });
    }

    let prompt = build_controller_prompt(&text, &ui_snapshot, &prior_candidates);
    if let Err(message) = send_rpc_command(
        state,
        &transport_session_id,
        prompt_command(next_rpc_id(), prompt, None, None),
    )
    .await
    {
        clear_active_run(state).await;
        return vec![ServerMessage::ControlStatus {
            target_client_id: Some(client_id),
            status: ControlStatusProjection {
                status: "error".to_string(),
                message: Some(message),
            },
        }];
    }

    vec![ServerMessage::ControlStatus {
        target_client_id: Some(client_id),
        status: ControlStatusProjection {
            status: "working".to_string(),
            message: Some("Ask Fura is thinking.".to_string()),
        },
    }]
}

pub(crate) async fn handle_control_abort(
    state: &AppState,
    client_id: String,
    conversation_id: Option<String>,
) -> Vec<ServerMessage> {
    let transport_session_id = {
        let controller = state.bridge_controller.read().await;
        let Some(run) = &controller.active_run else {
            return vec![ServerMessage::ControlStatus {
                target_client_id: Some(client_id),
                status: ControlStatusProjection {
                    status: "idle".to_string(),
                    message: Some("Ask Fura is already idle.".to_string()),
                },
            }];
        };
        if run.target_client_id != client_id {
            return vec![ServerMessage::ControlStatus {
                target_client_id: Some(client_id),
                status: ControlStatusProjection {
                    status: "error".to_string(),
                    message: Some("Ask Fura is busy for another browser client.".to_string()),
                },
            }];
        }
        if let Some(conversation_id) = &conversation_id {
            if &run.conversation_id != conversation_id {
                return vec![ServerMessage::ControlStatus {
                    target_client_id: Some(client_id),
                    status: ControlStatusProjection {
                        status: "error".to_string(),
                        message: Some(
                            "Ask Fura is busy with a different conversation.".to_string(),
                        ),
                    },
                }];
            }
        }
        controller.transport_session_id.clone()
    };

    if let Some(transport_session_id) = transport_session_id {
        if let Err(message) =
            send_rpc_command(state, &transport_session_id, abort_command(next_rpc_id())).await
        {
            return vec![ServerMessage::ControlStatus {
                target_client_id: Some(client_id),
                status: ControlStatusProjection {
                    status: "error".to_string(),
                    message: Some(message),
                },
            }];
        }
    }

    clear_active_run(state).await;
    vec![ServerMessage::ControlStatus {
        target_client_id: Some(client_id),
        status: ControlStatusProjection {
            status: "idle".to_string(),
            message: Some("Ask Fura request aborted.".to_string()),
        },
    }]
}

pub(crate) async fn is_controller_transport(state: &AppState, session_id: &str) -> bool {
    state
        .bridge_controller
        .read()
        .await
        .transport_session_id
        .as_deref()
        == Some(session_id)
}

pub(crate) async fn handle_controller_agent_end(state: &AppState) {
    if let Some(run) = clear_active_run(state).await {
        let elapsed_ms = Timestamp::now()
            .millis()
            .saturating_sub(run.prompt_started_at.millis());
        info!(
            action = "control.agent_end",
            target_client_id = %run.target_client_id,
            conversation_id = %run.conversation_id,
            active_session_id = ?run.active_session_id,
            elapsed_ms,
        );
        let _ = state.events.send(ServerMessage::ControlStatus {
            target_client_id: Some(run.target_client_id),
            status: ControlStatusProjection {
                status: "idle".to_string(),
                message: None,
            },
        });
    }
}

pub(crate) async fn handle_controller_rpc_error(state: &AppState, message: String) {
    if let Some(run) = clear_active_run(state).await {
        let _ = state.events.send(ServerMessage::ControlStatus {
            target_client_id: Some(run.target_client_id),
            status: ControlStatusProjection {
                status: "error".to_string(),
                message: Some(message),
            },
        });
    }
}

pub(crate) async fn apply_controller_get_state(
    state: &AppState,
    transport_session_id: &str,
    frame: &Value,
) {
    let rpc_session_id = frame
        .get("data")
        .or_else(|| frame.get("result"))
        .and_then(|data| data.get("sessionId"))
        .and_then(|value| value.as_str())
        .map(str::to_string);

    if let Some(session_id) = rpc_session_id {
        state
            .rpc_session_targets
            .write()
            .await
            .insert(transport_session_id.to_string(), session_id.clone());
        info!(
            action = "control.session_mapped",
            transport_session_id = %transport_session_id,
            session_id = %session_id,
        );
    }
}

pub(crate) async fn handle_controller_host_tool_call(
    state: &AppState,
    frame_id: String,
    tool_call_id: String,
    tool_name: String,
    arguments: Value,
) {
    let result = match dispatch_controller_tool(state, &tool_name, arguments).await {
        Ok(text) => host_tool_result_frame(frame_id, text, false),
        Err(message) => host_tool_result_frame(frame_id, message, true),
    };

    let transport_session_id = {
        state
            .bridge_controller
            .read()
            .await
            .transport_session_id
            .clone()
    };
    let Some(transport_session_id) = transport_session_id else {
        warn!(tool_call_id = %tool_call_id, tool_name = %tool_name, "controller tool result has no transport");
        return;
    };

    if let Err(message) = send_rpc_command(state, &transport_session_id, result).await {
        warn!(tool_call_id = %tool_call_id, tool_name = %tool_name, %message, "failed to send host tool result");
        handle_controller_rpc_error(state, message).await;
    }
}

pub(crate) async fn reset_controller_if_transport_exited(
    state: &AppState,
    session_id: &str,
) -> bool {
    let mut controller = state.bridge_controller.write().await;
    if controller.transport_session_id.as_deref() != Some(session_id) {
        return false;
    }
    let active_run = controller.active_run.take();
    controller.transport_session_id = None;
    controller.tools_registered = false;
    controller.tools_restricted = false;
    drop(controller);

    if let Some(run) = active_run {
        let _ = state.events.send(ServerMessage::ControlStatus {
            target_client_id: Some(run.target_client_id),
            status: ControlStatusProjection {
                status: "error".to_string(),
                message: Some("Fura controller session exited.".to_string()),
            },
        });
    }
    true
}

async fn ensure_controller_session(state: &AppState) -> Result<String, String> {
    if let Some(existing) = state
        .bridge_controller
        .read()
        .await
        .transport_session_id
        .clone()
    {
        if state.rpc_sessions.read().await.contains_key(&existing) {
            return Ok(existing);
        }
    }

    let transport_session_id = Uuid::new_v4().to_string();
    {
        let mut controller = state.bridge_controller.write().await;
        controller.transport_session_id = Some(transport_session_id.clone());
        controller.tools_registered = false;
        controller.tools_restricted = false;
        controller.active_run = None;
    }

    let cwd = state.default_cwd.read().await.clone();
    spawn_rpc_child(
        state.clone(),
        transport_session_id.clone(),
        Some(cwd),
        Vec::new(),
        None,
    )
    .await
    .map_err(|error| format!("failed to start Fura controller: {error}"))?;

    send_rpc_command(
        state,
        &transport_session_id,
        json!({ "id": next_rpc_id(), "type": "set_session_name", "name": CONTROLLER_SESSION_TITLE }),
    )
    .await?;
    send_rpc_command(state, &transport_session_id, set_host_tools_command()).await?;
    send_rpc_command(state, &transport_session_id, set_active_tools_command()).await?;

    {
        let mut controller = state.bridge_controller.write().await;
        controller.tools_registered = true;
        controller.tools_restricted = true;
    }

    Ok(transport_session_id)
}

fn set_host_tools_command() -> Value {
    json!({
        "id": next_rpc_id(),
        "type": "set_host_tools",
        "tools": controller_tool_definitions(),
    })
}

fn set_active_tools_command() -> Value {
    json!({
        "id": next_rpc_id(),
        "type": "set_active_tools",
        "toolNames": FURA_TOOL_NAMES,
    })
}

fn controller_tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "fura_search_sessions",
            "label": "Search Fura sessions",
            "description": "Search Fura session metadata and loaded transcript projection. This does not change the UI.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query." },
                    "limit": { "type": "number", "description": "Maximum candidate count." }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "fura_reply",
            "label": "Reply to user",
            "description": "Send a conversational Ask Fura reply, optionally with structured session candidates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": { "type": "string" },
                    "candidates": { "type": "array", "items": { "type": "object" } },
                    "suggestedActions": { "type": "array", "items": { "type": "object" } }
                },
                "required": ["message"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "fura_filter_sessions",
            "label": "Filter session list",
            "description": "Set the requesting frontend client's session search field. Use only when the user asks to filter the visible sidebar.",
            "parameters": {
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "fura_select_session",
            "label": "Select session",
            "description": "Dispatch a non-destructive frontend action to open/select an existing Fura session after explicit user intent.",
            "parameters": {
                "type": "object",
                "properties": { "sessionId": { "type": "string" } },
                "required": ["sessionId"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "fura_set_prompt_draft",
            "label": "Set prompt draft",
            "description": "Stage text in the active session prompt box. This never sends the prompt.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sessionId": { "type": "string" },
                    "text": { "type": "string" }
                },
                "required": ["text"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "fura_show_notice",
            "label": "Show notice",
            "description": "Show a visible notice in the requesting frontend client.",
            "parameters": {
                "type": "object",
                "properties": {
                    "level": { "type": "string", "enum": ["info", "warning", "error"] },
                    "text": { "type": "string" }
                },
                "required": ["level", "text"],
                "additionalProperties": false
            }
        }),
    ]
}

async fn dispatch_controller_tool(
    state: &AppState,
    tool_name: &str,
    arguments: Value,
) -> Result<String, String> {
    match tool_name {
        "fura_search_sessions" => {
            let args: SearchSessionsArgs = parse_tool_args(arguments)?;
            let candidates =
                search_sessions(state, &args.query, args.limit.unwrap_or(8).clamp(1, 20)).await;
            serde_json::to_string(&json!({ "candidates": candidates }))
                .map_err(|error| format!("failed to encode session candidates: {error}"))
        }
        "fura_reply" => {
            let args: ReplyArgs = parse_tool_args(arguments)?;
            let run = current_run(state).await?;
            let candidates = validate_candidates(state, args.candidates).await;
            {
                let mut controller = state.bridge_controller.write().await;
                let last_ui_snapshot = controller
                    .conversations
                    .get(&run.conversation_id)
                    .map(|conversation| conversation.last_ui_snapshot.clone())
                    .unwrap_or_else(|| FrontendUiSnapshot {
                        active_session_id: run.active_session_id.clone(),
                        focused_area: None,
                        session_search_query: String::new(),
                        visible_session_ids: Vec::new(),
                        prompt_draft: None,
                        panels: None,
                        blocking_ui: None,
                    });
                controller.conversations.insert(
                    run.conversation_id.clone(),
                    ControlConversationState {
                        last_candidates: candidates.clone(),
                        last_ui_snapshot,
                    },
                );
            }
            let _ = state.events.send(ServerMessage::ControlReply {
                target_client_id: run.target_client_id,
                conversation_id: run.conversation_id,
                message: args.message,
                candidates,
                suggested_actions: args.suggested_actions,
            });
            Ok("Dispatched Ask Fura reply to the requesting frontend client.".to_string())
        }
        "fura_filter_sessions" => {
            let args: FilterSessionsArgs = parse_tool_args(arguments)?;
            let run = current_run(state).await?;
            let _ = state.events.send(ServerMessage::FrontendControl {
                target_client_id: run.target_client_id,
                action: FrontendControlAction::SetSessionSearch {
                    query: args.query,
                    focus: Some(true),
                },
            });
            Ok("Dispatched session-search action to the requesting frontend client.".to_string())
        }
        "fura_select_session" => {
            let args: SelectSessionArgs = parse_tool_args(arguments)?;
            if !state.sessions.read().await.contains_key(&args.session_id) {
                return Err(format!("session {} is not available", args.session_id));
            }
            let run = current_run(state).await?;
            let _ = state.events.send(ServerMessage::FrontendControl {
                target_client_id: run.target_client_id,
                action: FrontendControlAction::SelectSession {
                    session_id: args.session_id,
                },
            });
            Ok("Dispatched select-session action to the requesting frontend client.".to_string())
        }
        "fura_set_prompt_draft" => {
            let args: SetPromptDraftArgs = parse_tool_args(arguments)?;
            if let Some(session_id) = &args.session_id {
                if !state.sessions.read().await.contains_key(session_id) {
                    return Err(format!("session {session_id} is not available"));
                }
            }
            let run = current_run(state).await?;
            let _ = state.events.send(ServerMessage::FrontendControl {
                target_client_id: run.target_client_id,
                action: FrontendControlAction::SetPromptDraft {
                    session_id: args.session_id,
                    text: args.text,
                    focus: Some(true),
                },
            });
            Ok("Dispatched prompt-draft action to the requesting frontend client.".to_string())
        }
        "fura_show_notice" => {
            let args: ShowNoticeArgs = parse_tool_args(arguments)?;
            let run = current_run(state).await?;
            let _ = state.events.send(ServerMessage::FrontendControl {
                target_client_id: run.target_client_id,
                action: FrontendControlAction::ShowNotice {
                    level: args.level,
                    text: args.text,
                },
            });
            Ok("Dispatched notice action to the requesting frontend client.".to_string())
        }
        _ => Err(format!("unknown Fura controller tool: {tool_name}")),
    }
}

fn parse_tool_args<T: for<'de> Deserialize<'de>>(arguments: Value) -> Result<T, String> {
    serde_json::from_value(arguments).map_err(|error| format!("invalid tool arguments: {error}"))
}

async fn current_run(state: &AppState) -> Result<BridgeControllerRun, String> {
    state
        .bridge_controller
        .read()
        .await
        .active_run
        .clone()
        .ok_or_else(|| "no active Ask Fura request owns this tool call".to_string())
}

async fn clear_active_run(state: &AppState) -> Option<BridgeControllerRun> {
    state.bridge_controller.write().await.active_run.take()
}

fn build_controller_prompt(
    user_text: &str,
    ui_snapshot: &FrontendUiSnapshot,
    prior_candidates: &[ControlCandidate],
) -> String {
    let snapshot_json = serde_json::to_string(ui_snapshot).unwrap_or_else(|_| "{}".to_string());
    let candidates_json =
        serde_json::to_string(prior_candidates).unwrap_or_else(|_| "[]".to_string());
    format!(
        r#"You are Ask Fura, a conversational assistant for navigating the Fura browser UI.

Fura is a browser UI for Oh My Pi agent sessions. Users ask you to find, discuss, summarize, prepare, or navigate sessions. You are not the coding agent for any user work session, and you must not perform coding work yourself.

You cannot directly change the browser. You can only call the provided fura_* host tools. You may only use those tools. Frontend actions are fire-and-forget; do not claim a frontend action was applied or succeeded. If you mention one, say it was dispatched.

Default behavior:
- If the user asks to find/search/recall a session, call fura_search_sessions and then fura_reply with candidates. Do not open/select a session until the user explicitly asks.
- If the user asks a question about candidate sessions, answer conversationally with fura_reply.
- If the user refers to "the first", "the second", "that one", or "open it", resolve the reference from prior candidates. If ambiguous, ask a short clarification using fura_reply.
- If the user explicitly asks to open/select a session, validate via fura_select_session.
- Use fura_filter_sessions only when the user asks to filter the visible sidebar; filtering the sidebar is not the default response to discovery questions.
- If the user asks to talk to the active coding agent, do not send a coding prompt. Offer to stage a prompt draft with fura_set_prompt_draft instead.
- Use fura_set_prompt_draft to stage text; never send a normal coding prompt.
- Destructive actions are unavailable.

Search truthfulness:
- Search results come from Fura metadata and loaded/preloaded transcript projection.
- Do not claim exhaustive semantic search unless a tool result explicitly says that was performed.

Context rules:
- The frontend snapshot is point-in-time context and may be stale.
- Prior candidates are the last candidates shown in this control conversation.
- Session ids are stable; visible UI ordering may change.

Current frontend snapshot JSON:
{snapshot_json}

Prior candidates for this conversation JSON:
{candidates_json}

User request:
{user_text}
"#
    )
}

async fn search_sessions(state: &AppState, query: &str, limit: usize) -> Vec<ControlCandidate> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Vec::new();
    }

    let sessions = state.sessions.read().await;
    let mut scored = Vec::new();
    for record in sessions.values() {
        let summary = record.summary();
        let mut score = 0_u32;
        let mut reasons = Vec::new();
        let mut snippets = Vec::new();

        for (label, value) in [
            ("title", summary.title.as_deref()),
            ("cwd", summary.cwd.as_deref()),
            ("session id", Some(summary.session_id.as_str())),
            ("timestamp", summary.timestamp.as_deref()),
            ("category", summary.category.as_deref()),
        ] {
            if let Some(value) = value {
                if value.to_lowercase().contains(&normalized_query) {
                    score += if label == "title" { 5 } else { 2 };
                    reasons.push(format!("matched {label}"));
                }
            }
        }

        for message in &record.messages {
            for block in &message.blocks {
                let ContentBlock::Text { text } = block else {
                    continue;
                };
                if text.to_lowercase().contains(&normalized_query) {
                    score += 3;
                    reasons.push("matched loaded transcript".to_string());
                    if snippets.len() < 3 {
                        snippets.push(snippet_for_query(text, &normalized_query));
                    }
                }
            }
        }

        if score > 0 {
            scored.push((
                score,
                summary.updated_at,
                ControlCandidate {
                    candidate_type: "session".to_string(),
                    candidate_id: format!("session-{}", scored.len() + 1),
                    session_id: summary.session_id,
                    title: summary.title,
                    cwd: summary.cwd,
                    timestamp: summary.timestamp,
                    status: format!("{:?}", summary.status).to_lowercase(),
                    kind: format!("{:?}", summary.kind).to_lowercase(),
                    reason: if reasons.is_empty() {
                        "matched session".to_string()
                    } else {
                        dedupe_join(reasons)
                    },
                    snippets,
                },
            ));
        }
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, _, candidate)| candidate)
        .collect()
}

async fn validate_candidates(
    state: &AppState,
    candidates: Vec<ControlCandidate>,
) -> Vec<ControlCandidate> {
    let sessions = state.sessions.read().await;
    candidates
        .into_iter()
        .filter(|candidate| {
            candidate.candidate_type == "session" && sessions.contains_key(&candidate.session_id)
        })
        .collect()
}

fn snippet_for_query(text: &str, normalized_query: &str) -> String {
    let lower = text.to_lowercase();
    let Some(byte_index) = lower.find(normalized_query) else {
        return text.chars().take(180).collect();
    };
    let match_index = byte_index.min(text.len());
    let mut start = match_index.saturating_sub(240);
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = match_index
        .saturating_add(normalized_query.len())
        .saturating_add(360)
        .min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    let prefix = if start > 0 { "..." } else { "" };
    let suffix = if end < text.len() { "..." } else { "" };
    format!("{prefix}{}{suffix}", text[start..end].trim())
}

fn dedupe_join(values: Vec<String>) -> String {
    let mut deduped = Vec::new();
    for value in values {
        if !deduped.contains(&value) {
            deduped.push(value);
        }
    }
    deduped.join(", ")
}

fn host_tool_result_frame(id: String, text: String, is_error: bool) -> Value {
    json!({
        "id": id,
        "type": "host_tool_result",
        "result": {
            "content": [
                { "type": "text", "text": text }
            ]
        },
        "isError": is_error,
    })
}
