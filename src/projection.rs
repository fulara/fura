use std::collections::HashMap;

use serde_json::Value;
use uuid::Uuid;

use crate::{ContentBlock, MessageRole, Timestamp, ToolCard, TranscriptMessage};

pub(crate) fn value_timestamp(value: &Value) -> Option<Timestamp> {
    value.get("timestamp").and_then(Timestamp::from_rpc)
}

pub(crate) fn map_bash_execution_message(value: &Value) -> Option<TranscriptMessage> {
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
        timestamp: value_timestamp(value),
        is_new: false,
    })
}

pub(crate) fn map_python_execution_message(value: &Value) -> Option<TranscriptMessage> {
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
        timestamp: value_timestamp(value),
        is_new: false,
    })
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
        tool_cards.push(ToolCard {
            tool_call_id: tool_call_id.to_string(),
            timestamp: timestamp.or_else(|| value_timestamp(value)),
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
        timestamp: value_timestamp(value),
        is_new: false, // caller sets true for live message_end events
    })
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
