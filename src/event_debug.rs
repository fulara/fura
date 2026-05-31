use std::ffi::OsStr;
use std::path::Path;

use serde_json::{Map, Value, json};
use tokio::{fs as async_fs, io::AsyncWriteExt};
use tracing::warn;

use crate::{
    AppState, ClientMessage, ContentBlock, ServerMessage, SessionProjection,
    SessionProjectionDelta, Timestamp, TranscriptEntry,
};

/// Number of rotated copies retained per debug log file.
const ROTATED_LOG_RETENTION: usize = 5;

/// Rotate an existing debug log into a sibling `rotated-logs/` directory.
///
/// Called once per file at startup, before the first append, so each Fura run
/// starts a fresh log while the previous run is preserved. Best-effort: every
/// failure is logged via `warn!` and swallowed so it can never abort startup.
/// A missing or empty file is a no-op (we never create empty rotations).
pub(crate) fn rotate_debug_log(path: &Path) {
    match std::fs::metadata(path) {
        // Skip empty files so the very first run does not stash a 0-byte copy.
        Ok(metadata) if metadata.len() == 0 => return,
        Ok(_) => {}
        // No file yet: nothing to rotate, and not an error worth logging.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        // Any other failure (permissions, I/O) must surface, never silently skip.
        Err(error) => {
            warn!(path = %path.display(), %error, "failed to inspect debug log; skipping rotation");
            return;
        }
    }

    let Some(file_name) = path.file_name() else {
        warn!(path = %path.display(), "debug log path has no file name; skipping rotation");
        return;
    };

    let rotated_dir = match path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        Some(parent) => parent.join("rotated-logs"),
        None => std::path::PathBuf::from("rotated-logs"),
    };
    if let Err(error) = std::fs::create_dir_all(&rotated_dir) {
        warn!(dir = %rotated_dir.display(), %error, "failed to create rotated debug log directory");
        return;
    }

    // Zero-pad millis to the full width of u64 so a lexicographic sort over the
    // rotated names matches chronological order, keeping `sort()` pruning correct.
    let mut rotated_name = file_name.to_os_string();
    rotated_name.push(format!(".{:020}", Timestamp::now().millis()));
    let rotated_path = rotated_dir.join(&rotated_name);
    if let Err(error) = move_file(path, &rotated_path) {
        warn!(
            from = %path.display(),
            to = %rotated_path.display(),
            %error,
            "failed to rotate debug log"
        );
        return;
    }

    prune_rotated_logs(&rotated_dir, file_name);
}

/// Move `from` to `to`, falling back to copy+remove when `rename` fails (e.g.
/// the rotated directory lives on a different mount than the original file).
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(from, to)?;
            std::fs::remove_file(from)
        }
    }
}

/// Keep only the `ROTATED_LOG_RETENTION` newest rotations of `file_name`,
/// deleting the oldest. Rotated names are `<file_name>.<zero-padded millis>`, so
/// a plain lexicographic sort yields chronological order.
fn prune_rotated_logs(dir: &Path, file_name: &OsStr) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            warn!(dir = %dir.display(), %error, "failed to list rotated debug logs");
            return;
        }
    };

    let mut rotated: Vec<std::path::PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|entry_path| is_rotation_of(entry_path, file_name))
        .collect();

    if rotated.len() <= ROTATED_LOG_RETENTION {
        return;
    }

    rotated.sort();
    let stale_count = rotated.len() - ROTATED_LOG_RETENTION;
    for stale in rotated.into_iter().take(stale_count) {
        if let Err(error) = std::fs::remove_file(&stale) {
            warn!(path = %stale.display(), %error, "failed to remove stale rotated debug log");
        }
    }
}

/// A rotation of `base` is exactly `<base>.<digits>`: the stem equals the
/// original file name and the extension is the all-digit millisecond suffix this
/// module writes. Matching on this structure (rather than a `<base>.` text
/// prefix) keeps two configured logs whose names share a dotted prefix from
/// colliding, and works for non-UTF-8 file names.
fn is_rotation_of(entry: &Path, base: &OsStr) -> bool {
    entry.file_stem() == Some(base)
        && entry
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                !extension.is_empty() && extension.bytes().all(|byte| byte.is_ascii_digit())
            })
}

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
        TranscriptEntry::Tool(_) | TranscriptEntry::Review(_) => None,
    })
}

fn append_projection_plan_summary(record: &mut Map<String, Value>, projection: &SessionProjection) {
    if let Some(plan_mode) = projection.plan_mode.as_ref() {
        record.insert("planModeEnabled".to_string(), json!(plan_mode.enabled));
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs};
    use uuid::Uuid;

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        let dir = env::temp_dir().join(format!("fura-rotate-{label}-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    #[test]
    fn rotate_debug_log_moves_nonempty_file_into_rotated_logs() {
        let dir = unique_temp_dir("move");
        let log_path = dir.join("bridge-debug.jsonl");
        fs::write(&log_path, b"frame-one\nframe-two\n").expect("log should be written");

        rotate_debug_log(&log_path);

        assert!(!log_path.exists(), "original log should be moved away");

        let rotated: Vec<std::path::PathBuf> = fs::read_dir(dir.join("rotated-logs"))
            .expect("rotated-logs should exist")
            .map(|entry| entry.expect("entry").path())
            .collect();
        assert_eq!(
            rotated.len(),
            1,
            "exactly one rotation expected: {rotated:?}"
        );

        let name = rotated[0]
            .file_name()
            .and_then(|name| name.to_str())
            .expect("rotated name");
        assert!(
            name.starts_with("bridge-debug.jsonl."),
            "rotation should keep the prefix: {name}"
        );
        assert_eq!(
            fs::read(&rotated[0]).expect("rotated content"),
            b"frame-one\nframe-two\n",
            "rotated content should be preserved verbatim"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotate_debug_log_is_noop_for_empty_or_missing_file() {
        let dir = unique_temp_dir("noop");
        let rotated_dir = dir.join("rotated-logs");

        // Empty file: left in place, no rotated-logs directory created.
        let empty_path = dir.join("event-debug.jsonl");
        fs::write(&empty_path, b"").expect("empty log should be written");
        rotate_debug_log(&empty_path);
        assert!(empty_path.exists(), "empty log should be left untouched");
        assert!(
            !rotated_dir.exists(),
            "no rotated-logs directory should be created for an empty file"
        );

        // Missing file: nothing created.
        let missing_path = dir.join("missing.jsonl");
        rotate_debug_log(&missing_path);
        assert!(!missing_path.exists(), "missing log should stay absent");
        assert!(
            !rotated_dir.exists(),
            "no rotated-logs directory should be created for a missing file"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotate_debug_log_retains_only_five_newest_rotations() {
        let dir = unique_temp_dir("retain");
        let rotated_dir = dir.join("rotated-logs");
        fs::create_dir_all(&rotated_dir).expect("rotated-logs dir should be created");

        let file_name = "bridge-debug.jsonl";
        // Seed seven existing rotations with fixed, lexicographically sortable
        // names. Ordering is driven purely by the embedded counter, never sleeps.
        for index in 1..=7u64 {
            fs::write(
                rotated_dir.join(format!("{file_name}.{index:020}")),
                format!("seed-{index}"),
            )
            .expect("seed rotation should be written");
        }

        // A non-empty current log triggers an eighth, newest rotation: its real
        // millis timestamp sorts after every fixed-width seed counter.
        let log_path = dir.join(file_name);
        fs::write(&log_path, b"current-run\n").expect("current log should be written");
        rotate_debug_log(&log_path);

        let prefix = format!("{file_name}.");
        let retained: Vec<String> = fs::read_dir(&rotated_dir)
            .expect("rotated-logs should exist")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.starts_with(&prefix))
            .collect();
        assert_eq!(
            retained.len(),
            ROTATED_LOG_RETENTION,
            "only the five newest rotations should remain: {retained:?}"
        );

        // The three oldest seeds are pruned; seeds 4..=7 survive alongside the
        // freshly rotated current run.
        for index in 1..=3u64 {
            assert!(
                !rotated_dir
                    .join(format!("{file_name}.{index:020}"))
                    .exists(),
                "oldest rotation {index} should be removed"
            );
        }
        for index in 4..=7u64 {
            assert!(
                rotated_dir
                    .join(format!("{file_name}.{index:020}"))
                    .exists(),
                "recent rotation {index} should be retained"
            );
        }
        assert!(!log_path.exists(), "current log should be rotated away");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotate_debug_log_prunes_only_structural_rotations() {
        let dir = unique_temp_dir("match");
        let rotated_dir = dir.join("rotated-logs");
        fs::create_dir_all(&rotated_dir).expect("rotated-logs dir should be created");

        let file_name = "bridge-debug.jsonl";
        // Six real rotations: with the fresh one this exceeds retention by two.
        for index in 1..=6u64 {
            fs::write(rotated_dir.join(format!("{file_name}.{index:020}")), "seed")
                .expect("seed rotation should be written");
        }
        // Unrelated siblings that must never be counted or pruned: a non-digit
        // extension, and another log's rotation whose stem differs.
        let non_digit = rotated_dir.join(format!("{file_name}.bak"));
        let other_log = rotated_dir.join(format!("fura-events.jsonl.{:020}", 1u64));
        fs::write(&non_digit, "keep").expect("sibling should be written");
        fs::write(&other_log, "keep").expect("sibling should be written");

        let log_path = dir.join(file_name);
        fs::write(&log_path, b"current-run\n").expect("current log should be written");
        rotate_debug_log(&log_path);

        // 6 seeds + 1 fresh = 7 matching rotations -> the two oldest are pruned.
        assert!(
            !rotated_dir
                .join(format!("{file_name}.{:020}", 1u64))
                .exists(),
            "oldest matching rotation should be removed"
        );
        assert!(
            !rotated_dir
                .join(format!("{file_name}.{:020}", 2u64))
                .exists(),
            "second oldest matching rotation should be removed"
        );
        assert!(
            non_digit.exists(),
            "non-digit-extension sibling must not be treated as a rotation"
        );
        assert!(
            other_log.exists(),
            "another log's rotation must not be pruned by this file"
        );

        fs::remove_dir_all(&dir).ok();
    }
}
