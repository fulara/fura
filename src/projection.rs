use std::{
    collections::HashMap,
    io::{self, Write},
};

use serde::Serialize;
use serde_json::Value;

use crate::{ContentBlock, MessageRole, Timestamp, ToolCard, TranscriptMessage};

struct Blake3Writer<'a>(&'a mut blake3::Hasher);

impl Write for Blake3Writer<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.update(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn hash_json<T: Serialize>(hasher: &mut blake3::Hasher, value: &T) {
    serde_json::to_writer(Blake3Writer(hasher), value)
        .expect("projected message id JSON serialization cannot fail");
}

fn upstream_message_id(value: &Value) -> String {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn projected_message_kind(value: &Value) -> &'static str {
    match value.get("role").and_then(Value::as_str) {
        Some("bashExecution") => "bashExecution",
        Some("pythonExecution") => "pythonExecution",
        _ => "message",
    }
}

fn projected_message_id_from_message(
    kind: &str,
    visible_ordinal: usize,
    message: &TranscriptMessage,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"projected-message-id-v2;");
    hasher.update(kind.as_bytes());
    hasher.update(b";ordinal=");
    hasher.update(&(visible_ordinal as u64).to_le_bytes());
    hasher.update(b";role=");
    hash_json(&mut hasher, &message.role);
    // Do not include timestamp: live handling may synthesize one for display when the
    // persisted frame has none, while historical replay cannot reconstruct that value.
    hasher.update(b";blocks=");
    hash_json(&mut hasher, &message.blocks);
    format!("__projected:{kind}:{}", hasher.finalize().to_hex())
}

pub(crate) fn assign_projected_message_id(
    message: &mut TranscriptMessage,
    value: &Value,
    visible_ordinal: usize,
) {
    if !message.id.is_empty() {
        return;
    }
    let kind = projected_message_kind(value);
    message.id = projected_message_id_from_message(kind, visible_ordinal, message);
}
pub(crate) fn value_timestamp(value: &Value) -> Option<Timestamp> {
    value.get("timestamp").and_then(Timestamp::from_rpc)
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

    Some(TranscriptMessage::new(
        upstream_message_id(value),
        MessageRole::System,
        vec![ContentBlock::Text {
            text: format!("```bash\n{body}\n```"),
        }],
        value_timestamp(value),
        false,
    ))
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

    Some(TranscriptMessage::new(
        upstream_message_id(value),
        MessageRole::System,
        vec![ContentBlock::Text { text }],
        value_timestamp(value),
        false,
    ))
}

pub(crate) fn project_omp_transcript(values: &[Value]) -> (Vec<TranscriptMessage>, Vec<ToolCard>) {
    let mut messages = Vec::new();
    let mut tool_cards = Vec::new();
    let mut pending_tool_calls: HashMap<
        String,
        (String, Option<String>, Value, usize, Option<Timestamp>),
    > = HashMap::new();
    let mut visible_message_count = 0_usize;

    for value in values {
        if let Some(mut message) = map_omp_message(value) {
            assign_projected_message_id(&mut message, value, visible_message_count);
            message.is_new = false;
            message.refresh_render_hash();
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
                    (
                        tool_name,
                        intent,
                        args,
                        visible_message_count,
                        value_timestamp(value),
                    ),
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
                    .map(|(tool_name, _, _, _, _)| tool_name.clone())
            })
            .unwrap_or_default();
        let (intent, args, insert_after_count, timestamp) = pending
            .map(|(_, intent, args, insert_after_count, timestamp)| {
                (intent, args, insert_after_count, timestamp)
            })
            .unwrap_or_else(|| (None, serde_json::json!({}), visible_message_count, None));
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
        tool_cards.push(ToolCard::new(
            tool_call_id.to_string(),
            timestamp.or_else(|| value_timestamp(value)),
            tool_name,
            intent,
            args,
            false,
            is_error,
            None,
            Some(Value::Object(result)),
            insert_after_count,
        ));
    }

    (messages, tool_cards)
}

fn map_async_result_message(value: &Value) -> TranscriptMessage {
    fn summary_line(job: Option<&Value>) -> String {
        let job_id = job
            .and_then(|job| job.get("jobId"))
            .and_then(Value::as_str)
            .filter(|job_id| !job_id.is_empty())
            .unwrap_or("unknown");
        let kind = job
            .and_then(|job| job.get("type"))
            .and_then(Value::as_str)
            .filter(|kind| !kind.is_empty())
            .unwrap_or("job");
        format!("Background job completed [{kind}] {job_id}")
    }

    let details = value.get("details");
    let mut lines = details
        .and_then(|details| details.get("jobs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|job| summary_line(Some(job)))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        lines.push(summary_line(details));
    }

    TranscriptMessage::new(
        upstream_message_id(value),
        MessageRole::System,
        vec![ContentBlock::Text {
            text: lines.join("\n"),
        }],
        value_timestamp(value),
        false,
    )
}

fn map_irc_message(value: &Value, custom_type: &str) -> Option<TranscriptMessage> {
    let details = value.get("details");
    let detail = |key: &str| {
        details
            .and_then(|details| details.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };

    let (mut text, body_key) = match custom_type {
        "irc:incoming" => (
            format!("IRC ← {}", detail("from").unwrap_or("?")),
            "message",
        ),
        "irc:autoreply" => (
            format!("IRC → {} (auto)", detail("to").unwrap_or("?")),
            "body",
        ),
        "irc:relay" => (
            format!(
                "IRC {} → {}",
                detail("from").unwrap_or("?"),
                detail("to").unwrap_or("?")
            ),
            "body",
        ),
        _ => return None,
    };
    if let Some(body) = detail(body_key) {
        text.push_str("\n\n");
        text.push_str(body);
    }

    Some(TranscriptMessage::new(
        upstream_message_id(value),
        MessageRole::System,
        vec![ContentBlock::Text { text }],
        value_timestamp(value),
        false,
    ))
}

fn contains_model_only_system_notice(value: &Value) -> bool {
    value
        .get("content")
        .and_then(Value::as_str)
        .is_some_and(|content| content.trim_start().starts_with("<system-notice"))
}

pub(crate) fn map_omp_message(value: &Value) -> Option<TranscriptMessage> {
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
            if value.get("customType").and_then(Value::as_str) == Some("async-result") {
                return Some(map_async_result_message(value));
            }
            if let Some(custom_type @ ("irc:incoming" | "irc:autoreply" | "irc:relay")) =
                value.get("customType").and_then(Value::as_str)
            {
                return map_irc_message(value, custom_type);
            }
            // OMP uses <system-notice> as a model-only envelope and provides
            // dedicated TUI components for the visible projection. Never expose the
            // internal envelope when Fura has no corresponding projection.
            if contains_model_only_system_notice(value) {
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
        if text.trim().is_empty() {
            vec![]
        } else {
            vec![ContentBlock::Text {
                text: text.to_string(),
            }]
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

    Some(TranscriptMessage::new(
        upstream_message_id(value),
        role,
        blocks,
        value_timestamp(value),
        false, // caller sets true for live message_end events
    ))
}

pub(crate) fn parse_role(role: &str) -> MessageRole {
    match role {
        "user" | "developer" => MessageRole::User,
        "system" => MessageRole::System,
        // tool/toolResult are suppressed before reaching here, but keep for completeness.
        "tool" | "toolResult" => MessageRole::Tool,
        _ => MessageRole::Assistant,
    }
}

pub(crate) fn content_to_blocks(value: &Value) -> Vec<ContentBlock> {
    match value {
        Value::String(text) => {
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![ContentBlock::Text { text: text.clone() }]
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
                            .unwrap_or("");
                        if !text.trim().is_empty() {
                            blocks.push(ContentBlock::Text {
                                text: text.to_string(),
                            });
                        }
                    }
                    Some("image") => {
                        let data = item
                            .get("data")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        let mime_type = item
                            .get("mimeType")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if !data.is_empty() && !mime_type.is_empty() {
                            let alt = item
                                .get("alt")
                                .and_then(|value| value.as_str())
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                                .map(str::to_string);
                            blocks.push(ContentBlock::Image {
                                data,
                                mime_type,
                                alt,
                            });
                        }
                    }
                    // toolCall blocks arrive as separate messages/events in the RPC
                    // event stream; other unknown item types are not rendered by Fura.
                    _ => {}
                }
            }
            blocks
        }
        _ => Vec::new(),
    }
}

#[allow(dead_code)]
pub(crate) fn content_to_text(value: &Value) -> String {
    content_to_blocks(value)
        .into_iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text),
            ContentBlock::Image { mime_type, .. } => Some(format!("[Image: {mime_type}]")),
            ContentBlock::Thinking { thinking } => Some(thinking),
            ContentBlock::RedactedThinking => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_omp_message_preserves_missing_id_for_live_streaming() {
        let value = serde_json::json!({
            "role": "assistant",
            "content": "streaming"
        });

        let message = map_omp_message(&value).expect("message should map");

        assert_eq!(message.id, "");
    }

    #[test]
    fn projected_messages_without_upstream_ids_get_stable_distinct_ids() {
        let values = vec![
            serde_json::json!({
                "role": "assistant",
                "content": "first"
            }),
            serde_json::json!({
                "role": "assistant",
                "content": "second"
            }),
        ];

        let (messages, _) = project_omp_transcript(&values);
        let (messages_again, _) = project_omp_transcript(&values);

        assert_eq!(messages.len(), 2);
        assert!(messages[0].id.starts_with("__projected:message:"));
        assert!(messages[1].id.starts_with("__projected:message:"));
        assert_ne!(messages[0].id, messages[1].id);
        assert_eq!(messages[0].id, messages_again[0].id);
        assert_eq!(messages[1].id, messages_again[1].id);
    }

    #[test]
    fn suppressed_events_do_not_perturb_projected_fallback_ids() {
        let visible_before = serde_json::json!({
            "role": "assistant",
            "content": "before"
        });
        let visible_after = serde_json::json!({
            "role": "assistant",
            "content": "after"
        });
        let values_without_suppressed = vec![visible_before.clone(), visible_after.clone()];
        let values_with_suppressed = vec![
            visible_before,
            serde_json::json!({
                "role": "hookMessage",
                "content": "hidden hook"
            }),
            serde_json::json!({
                "role": "developer",
                "attribution": "agent",
                "content": "hidden agent note"
            }),
            visible_after,
        ];

        let (messages_without, _) = project_omp_transcript(&values_without_suppressed);
        let (messages_with, _) = project_omp_transcript(&values_with_suppressed);

        assert_eq!(messages_without.len(), 2);
        assert_eq!(messages_with.len(), 2);
        assert_eq!(messages_without[1].id, messages_with[1].id);
    }

    #[test]
    fn visible_async_result_projects_summary_not_model_envelope() {
        let message = map_omp_message(&serde_json::json!({
            "role": "custom",
            "customType": "async-result",
            "content": "<system-notice>\nBackground job finished with private model context.\n</system-notice>",
            "display": true,
            "attribution": "agent",
            "details": {
                "jobs": [{
                    "jobId": "TextileRenderingTests",
                    "type": "task",
                    "label": "TextileRenderingTests",
                    "durationMs": 177693
                }]
            }
        }))
        .expect("async result should remain visible");

        assert_eq!(message.role, MessageRole::System);
        assert_eq!(
            message.blocks,
            vec![ContentBlock::Text {
                text: "Background job completed [task] TextileRenderingTests".to_string()
            }]
        );
    }

    #[test]
    fn irc_messages_project_structured_details_not_model_envelopes() {
        let cases = [
            (
                serde_json::json!({
                    "id": "irc-incoming",
                    "role": "custom",
                    "customType": "irc:incoming",
                    "content": "<irc>\nIncoming IRC message from agent `Reviewer`:\n\nCheck the status fix.\n</irc>",
                    "display": true,
                    "details": {
                        "from": "Reviewer",
                        "message": "Check the status fix."
                    }
                }),
                "IRC ← Reviewer\n\nCheck the status fix.",
            ),
            (
                serde_json::json!({
                    "id": "irc-autoreply",
                    "role": "custom",
                    "customType": "irc:autoreply",
                    "content": "[IRC you → `Reviewer` (auto)]\n\nStill working.",
                    "display": true,
                    "details": {
                        "to": "Reviewer",
                        "body": "Still working.",
                        "replyTo": "irc-incoming"
                    }
                }),
                "IRC → Reviewer (auto)\n\nStill working.",
            ),
            (
                serde_json::json!({
                    "id": "irc-relay",
                    "role": "custom",
                    "customType": "irc:relay",
                    "content": "[IRC `Reviewer` → `Worker`]\n\nPlease verify.",
                    "display": true,
                    "details": {
                        "from": "Reviewer",
                        "to": "Worker",
                        "body": "Please verify."
                    }
                }),
                "IRC Reviewer → Worker\n\nPlease verify.",
            ),
        ];

        for (value, expected) in cases {
            let message = map_omp_message(&value).expect("IRC message should remain visible");
            assert_eq!(message.role, MessageRole::System);
            assert_eq!(
                message.blocks,
                vec![ContentBlock::Text {
                    text: expected.to_string()
                }]
            );
        }
    }

    #[test]
    fn hidden_xdev_system_notice_is_suppressed() {
        let message = map_omp_message(&serde_json::json!({
            "role": "custom",
            "customType": "xdev-mount-notice",
            "content": "<system-notice>\nThe xd:// device inventory changed.\n</system-notice>",
            "display": false,
            "attribution": "agent"
        }));

        assert!(message.is_none());
    }

    #[test]
    fn unknown_visible_system_notice_is_suppressed() {
        let message = map_omp_message(&serde_json::json!({
            "role": "custom",
            "customType": "future-internal-notice",
            "content": "<system-notice>\nInternal model instructions.\n</system-notice>",
            "display": true,
            "attribution": "agent"
        }));

        assert!(message.is_none());
    }
}
