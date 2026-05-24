use std::path::Path;

use serde_json::{Map, Value, json};
use tokio::{fs as async_fs, io::AsyncWriteExt};
use tracing::warn;

use crate::{
    AppState, ClientMessage, ContentBlock, ServerMessage, SessionProjection,
    SessionProjectionDelta, Timestamp, TranscriptEntry,
};

const PREVIEW_CHARS: usize = 100;

fn text_preview(text: &str) -> String {
    text.chars().take(PREVIEW_CHARS).collect()
}

fn insert_text_summary(record: &mut Map<String, Value>, prefix: &str, text: &str) {
    record.insert(format!("{prefix}Bytes"), json!(text.len()));
    record.insert(format!("{prefix}Preview"), json!(text_preview(text)));
}

fn insert_session_id(record: &mut Map<String, Value>, session_id: &str) {
    record.insert("sessionId".to_string(), json!(session_id));
}

fn append_string_field(record: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_str) {
        record.insert(key.to_string(), json!(value));
    }
}

fn append_bool_field(record: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_bool) {
        record.insert(key.to_string(), json!(value));
    }
}

fn append_usize_field(record: &mut Map<String, Value>, key: &str, value: usize) {
    record.insert(key.to_string(), json!(value));
}

fn append_plan_mode_summary(record: &mut Map<String, Value>, plan_mode: Option<&Value>) {
    if let Some(plan_mode) = plan_mode.and_then(Value::as_object) {
        append_bool_field(record, "planModeEnabled", plan_mode.get("enabled"));
        append_bool_field(record, "planModeDiscussion", plan_mode.get("discussion"));
        append_string_field(record, "planModeWorkflow", plan_mode.get("workflow"));
    }
}

fn append_pending_plan_summary(record: &mut Map<String, Value>, pending: Option<&Value>) {
    let Some(pending) = pending.and_then(Value::as_object) else {
        return;
    };
    append_string_field(record, "planFilePath", pending.get("planFilePath"));
    append_string_field(
        record,
        "finalPlanFilePath",
        pending.get("finalPlanFilePath"),
    );
    append_string_field(record, "title", pending.get("title"));
    if let Some(content) = pending.get("content").and_then(Value::as_str) {
        insert_text_summary(record, "content", content);
    }
}

fn append_omp_message_summary(record: &mut Map<String, Value>, message: Option<&Value>) {
    let Some(message) = message.and_then(Value::as_object) else {
        return;
    };
    append_string_field(record, "messageId", message.get("id"));
    append_string_field(record, "role", message.get("role"));
    if let Some(content) = message.get("content").and_then(Value::as_str) {
        insert_text_summary(record, "messageText", content);
        return;
    }
    if let Some(content) = message.get("content").and_then(Value::as_array) {
        append_usize_field(record, "contentBlockCount", content.len());
        if let Some(text) = content
            .iter()
            .filter_map(Value::as_object)
            .find_map(|block| block.get("text").and_then(Value::as_str))
        {
            insert_text_summary(record, "messageText", text);
        }
    }
}

fn first_transcript_text(entries: &[TranscriptEntry]) -> Option<&str> {
    entries.iter().find_map(|entry| match entry {
        TranscriptEntry::Message(message) => message.blocks.iter().find_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        }),
        TranscriptEntry::Tool(_) => None,
    })
}

fn append_projection_plan_summary(record: &mut Map<String, Value>, projection: &SessionProjection) {
    if let Some(plan_mode) = projection.plan_mode.as_ref() {
        record.insert("planModeEnabled".to_string(), json!(plan_mode.enabled));
        record.insert(
            "planModeDiscussion".to_string(),
            json!(plan_mode.discussion),
        );
        if let Some(workflow) = plan_mode.workflow.as_ref() {
            record.insert("planModeWorkflow".to_string(), json!(workflow));
        }
    }
    if let Some(pending) = projection.pending_plan_review.as_ref() {
        record.insert("planFilePath".to_string(), json!(pending.plan_file_path));
        record.insert(
            "finalPlanFilePath".to_string(),
            json!(pending.final_plan_file_path),
        );
        if let Some(title) = pending.title.as_ref() {
            record.insert("title".to_string(), json!(title));
        }
        insert_text_summary(record, "content", &pending.content);
    }
}

fn append_delta_plan_summary(record: &mut Map<String, Value>, delta: &SessionProjectionDelta) {
    if let Some(plan_mode) = delta.plan_mode.as_ref() {
        record.insert("planModeEnabled".to_string(), json!(plan_mode.enabled));
        record.insert(
            "planModeDiscussion".to_string(),
            json!(plan_mode.discussion),
        );
        if let Some(workflow) = plan_mode.workflow.as_ref() {
            record.insert("planModeWorkflow".to_string(), json!(workflow));
        }
    }
    if let Some(pending) = delta.pending_plan_review.as_ref() {
        record.insert("planFilePath".to_string(), json!(pending.plan_file_path));
        record.insert(
            "finalPlanFilePath".to_string(),
            json!(pending.final_plan_file_path),
        );
        if let Some(title) = pending.title.as_ref() {
            record.insert("title".to_string(), json!(title));
        }
        insert_text_summary(record, "content", &pending.content);
    }
}

fn event_record(direction: &str, event_type: &str) -> Map<String, Value> {
    let mut record = Map::new();
    record.insert("timestampMs".to_string(), json!(Timestamp::now().millis()));
    record.insert("direction".to_string(), json!(direction));
    record.insert("type".to_string(), json!(event_type));
    record
}

pub(crate) fn summarize_rpc_event(session_id: &str, raw_line: &str) -> Map<String, Value> {
    let parsed = serde_json::from_str::<Value>(raw_line);
    let event_type = parsed
        .as_ref()
        .ok()
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("invalid_json")
        .to_string();
    let mut record = event_record("rpc_to_bridge", &event_type);
    insert_session_id(&mut record, session_id);
    record.insert("rawBytes".to_string(), json!(raw_line.len()));

    let Ok(value) = parsed else {
        return record;
    };
    let Some(object) = value.as_object() else {
        return record;
    };

    match event_type.as_str() {
        "plan_review" => {
            append_string_field(&mut record, "planFilePath", object.get("planFilePath"));
            append_string_field(
                &mut record,
                "finalPlanFilePath",
                object.get("finalPlanFilePath"),
            );
            append_string_field(&mut record, "title", object.get("title"));
            if let Some(content) = object.get("content").and_then(Value::as_str) {
                insert_text_summary(&mut record, "content", content);
            }
        }
        "message_update" | "message_end" => {
            append_omp_message_summary(&mut record, object.get("message"))
        }
        "agent_end" => {
            if let Some(messages) = object.get("messages").and_then(Value::as_array) {
                append_usize_field(&mut record, "messageCount", messages.len());
            }
        }
        "response" => {
            append_string_field(&mut record, "requestId", object.get("id"));
            if let Some(result) = object.get("result") {
                append_plan_mode_summary(&mut record, result.get("planMode"));
                append_pending_plan_summary(&mut record, result.get("pendingPlanReview"));
                if let Some(messages) = result.get("messages").and_then(Value::as_array) {
                    append_usize_field(&mut record, "messageCount", messages.len());
                }
            }
        }
        "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
            append_string_field(&mut record, "toolCallId", object.get("toolCallId"));
            append_string_field(&mut record, "toolName", object.get("toolName"));
            append_bool_field(&mut record, "isError", object.get("isError"));
        }
        "extension_ui_request" => {
            append_string_field(&mut record, "dialogId", object.get("id"));
            append_string_field(&mut record, "method", object.get("method"));
        }
        _ => {}
    }

    record
}

pub(crate) fn summarize_client_event(message: &ClientMessage) -> Map<String, Value> {
    let record = match message {
        ClientMessage::PlanDiscuss { session_id } => {
            let mut record = event_record("client_to_bridge", "plan.discuss");
            insert_session_id(&mut record, session_id);
            record
        }
        ClientMessage::PlanApprove {
            session_id,
            plan_file_path,
            final_plan_file_path,
            title,
            content,
            approval_mode,
        } => {
            let mut record = event_record("client_to_bridge", "plan.approve");
            insert_session_id(&mut record, session_id);
            record.insert("planFilePath".to_string(), json!(plan_file_path));
            record.insert("finalPlanFilePath".to_string(), json!(final_plan_file_path));
            if let Some(title) = title.as_ref() {
                record.insert("title".to_string(), json!(title));
            }
            if let Some(approval_mode) = approval_mode.as_ref() {
                record.insert(
                    "approvalMode".to_string(),
                    json!(format!("{approval_mode:?}")),
                );
            }
            insert_text_summary(&mut record, "content", content);
            record
        }
        ClientMessage::PromptSend {
            session_id,
            text,
            images,
            behavior,
        } => {
            let mut record = event_record("client_to_bridge", "prompt.send");
            insert_session_id(&mut record, session_id);
            insert_text_summary(&mut record, "text", text);
            record.insert(
                "imageCount".to_string(),
                json!(images.as_ref().map(Vec::len).unwrap_or(0)),
            );
            if let Some(behavior) = behavior.as_ref() {
                record.insert(
                    "behavior".to_string(),
                    json!(behavior.as_rpc_streaming_behavior()),
                );
            }
            record
        }
        ClientMessage::StateRefresh { session_id } => {
            let mut record = event_record("client_to_bridge", "state.refresh");
            insert_session_id(&mut record, session_id);
            record
        }
        ClientMessage::RawRpc {
            session_id,
            command,
        } => {
            let mut record = event_record("client_to_bridge", "raw.rpc");
            insert_session_id(&mut record, session_id);
            if let Some(command_type) = command.get("type").and_then(Value::as_str) {
                record.insert("commandType".to_string(), json!(command_type));
            }
            record.insert("commandBytes".to_string(), json!(command.to_string().len()));
            record
        }
        ClientMessage::SessionAttach { session_id } => {
            let mut record = event_record("client_to_bridge", "session.attach");
            insert_session_id(&mut record, session_id);
            record
        }
        ClientMessage::SessionDetach { session_id } => {
            let mut record = event_record("client_to_bridge", "session.detach");
            insert_session_id(&mut record, session_id);
            record
        }
        ClientMessage::SessionStop { session_id } => {
            let mut record = event_record("client_to_bridge", "session.stop");
            insert_session_id(&mut record, session_id);
            record
        }
        _ => event_record("client_to_bridge", "other"),
    };
    record
}

pub(crate) fn summarize_server_event(message: &ServerMessage) -> Map<String, Value> {
    match message {
        ServerMessage::PlanReview {
            session_id,
            plan_file_path,
            final_plan_file_path,
            title,
            content,
        } => {
            let mut record = event_record("bridge_to_client", "plan.review");
            insert_session_id(&mut record, session_id);
            record.insert("planFilePath".to_string(), json!(plan_file_path));
            record.insert("finalPlanFilePath".to_string(), json!(final_plan_file_path));
            if let Some(title) = title.as_ref() {
                record.insert("title".to_string(), json!(title));
            }
            insert_text_summary(&mut record, "content", content);
            record
        }
        ServerMessage::SessionSnapshot { session_id, state } => {
            let mut record = event_record("bridge_to_client", "session.snapshot");
            insert_session_id(&mut record, session_id);
            record.insert("transcriptLen".to_string(), json!(state.transcript.len()));
            record.insert(
                "status".to_string(),
                json!(format!("{:?}", state.summary.status)),
            );
            if let Some(text) = first_transcript_text(&state.transcript) {
                insert_text_summary(&mut record, "transcriptText", text);
            }
            append_projection_plan_summary(&mut record, state);
            record
        }
        ServerMessage::SessionDelta { session_id, state } => {
            let mut record = event_record("bridge_to_client", "session.delta");
            insert_session_id(&mut record, session_id);
            record.insert(
                "transcriptReplaceFrom".to_string(),
                json!(state.transcript_replace_from),
            );
            record.insert(
                "transcriptAppendLen".to_string(),
                json!(state.transcript_append.len()),
            );
            record.insert(
                "status".to_string(),
                json!(format!("{:?}", state.summary.status)),
            );
            if let Some(text) = first_transcript_text(&state.transcript_append) {
                insert_text_summary(&mut record, "transcriptText", text);
            }
            append_delta_plan_summary(&mut record, state);
            record
        }
        ServerMessage::PromptBusy {
            session_id,
            text,
            images,
        } => {
            let mut record = event_record("bridge_to_client", "prompt.busy");
            insert_session_id(&mut record, session_id);
            insert_text_summary(&mut record, "text", text);
            record.insert(
                "imageCount".to_string(),
                json!(images.as_ref().map(Vec::len).unwrap_or(0)),
            );
            record
        }
        ServerMessage::Error {
            request_id,
            message,
        } => {
            let mut record = event_record("bridge_to_client", "error");
            if let Some(request_id) = request_id.as_ref() {
                record.insert("requestId".to_string(), json!(request_id));
            }
            insert_text_summary(&mut record, "message", message);
            record
        }
        ServerMessage::Hello { .. } => event_record("bridge_to_client", "hello"),
        ServerMessage::SessionsSnapshot { sessions } => {
            let mut record = event_record("bridge_to_client", "sessions.snapshot");
            record.insert("sessionCount".to_string(), json!(sessions.len()));
            record
        }
        ServerMessage::SessionExited {
            session_id,
            code,
            signal,
        } => {
            let mut record = event_record("bridge_to_client", "session.exited");
            insert_session_id(&mut record, session_id);
            record.insert("code".to_string(), json!(code));
            record.insert("signal".to_string(), json!(signal));
            record
        }
        ServerMessage::RawOmp { session_id, frame } => {
            let mut record = event_record("bridge_to_client", "raw.omp");
            insert_session_id(&mut record, session_id);
            if let Some(frame_type) = frame.get("type").and_then(Value::as_str) {
                record.insert("frameType".to_string(), json!(frame_type));
            }
            record.insert("frameBytes".to_string(), json!(frame.to_string().len()));
            record
        }
        _ => event_record("bridge_to_client", "other"),
    }
}

async fn append_jsonl(path: &Path, record: &Map<String, Value>) {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        if let Err(error) = async_fs::create_dir_all(parent).await {
            warn!(path = %path.display(), %error, "failed to create event debug file directory");
            return;
        }
    }

    let Ok(mut encoded) = serde_json::to_string(record) else {
        warn!("failed to serialize event debug record");
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
                warn!(path = %path.display(), %error, "failed to write event debug record");
            }
        }
        Err(error) => warn!(path = %path.display(), %error, "failed to open event debug file"),
    }
}

pub(crate) async fn append_event_debug_rpc_line(
    state: &AppState,
    session_id: &str,
    raw_line: &str,
) {
    let Some(path) = state.event_debug_file.as_ref() else {
        return;
    };
    let record = summarize_rpc_event(session_id, raw_line);
    append_jsonl(path, &record).await;
}

pub(crate) async fn append_event_debug_client_message(state: &AppState, message: &ClientMessage) {
    let Some(path) = state.event_debug_file.as_ref() else {
        return;
    };
    let record = summarize_client_event(message);
    append_jsonl(path, &record).await;
}

pub(crate) async fn append_event_debug_server_message(state: &AppState, message: &ServerMessage) {
    let Some(path) = state.event_debug_file.as_ref() else {
        return;
    };
    let record = summarize_server_event(message);
    append_jsonl(path, &record).await;
}
