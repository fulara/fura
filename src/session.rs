use crate::Timestamp;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecord {
    pub(crate) id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) args: Vec<String>,
    pub(crate) status: SessionStatus,
    pub(crate) created_at: Timestamp,
    pub(crate) updated_at: Timestamp,
    pub(crate) messages: Vec<TranscriptMessage>,
    /// IDs of messages that arrived live via `message_end`; preserved across `get_messages` reconciliation.
    pub(crate) live_message_ids: HashSet<String>,
    /// In-flight partial message from `message_update` deltas; included at the end of projection and cleared on `message_end`.
    #[serde(skip)]
    pub(crate) streaming_message: Option<TranscriptMessage>,
    /// Completed tool-execution cards projected from live events or historical tool results.
    #[serde(skip)]
    pub(crate) tool_cards: Vec<ToolCard>,
    /// Tool-execution cards currently in progress.
    #[serde(skip)]
    pub(crate) active_tool_calls: Vec<ToolCard>,
    /// Current OMP todo state. `None` means not loaded yet; `Some([])` means explicitly empty.
    #[serde(skip)]
    pub(crate) todo_phases: Option<Vec<TodoPhaseProjection>>,
    pub(crate) kind: SessionKind,
    pub(crate) session_file: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) timestamp: Option<String>,
    pub(crate) category: Option<String>,
    pub(crate) worktree: Option<SessionWorktreeSummary>,
    pub(crate) model: Option<String>,
    pub(crate) thinking_level: Option<String>,
    pub(crate) tokens_total: u64,
    pub(crate) cost_usd: f64,
    pub(crate) context_tokens: Option<u64>,
    pub(crate) context_window: Option<u64>,
    pub(crate) context_percent: Option<f64>,
    pub(crate) plan_mode: Option<PlanModeProjection>,
}

impl SessionRecord {
    pub(crate) fn summary(&self) -> SessionSummary {
        SessionSummary {
            session_id: self.id.clone(),
            cwd: self.cwd.clone(),
            status: self.effective_status(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            message_count: self.messages.len(),
            kind: self.kind,
            session_file: self.session_file.clone(),
            title: self.title.clone(),
            timestamp: self.timestamp.clone(),
            category: self.category.clone(),
            worktree: self.worktree.clone(),
        }
    }

    pub(crate) fn has_active_work(&self) -> bool {
        self.streaming_message.is_some() || self.active_tool_calls.iter().any(|card| card.is_active)
    }

    pub(crate) fn effective_status(&self) -> SessionStatus {
        match self.status {
            SessionStatus::Exited | SessionStatus::Available | SessionStatus::Error => self.status,
            _ if self.has_active_work() => SessionStatus::Busy,
            status => status,
        }
    }

    fn effective_todo_phases(&self) -> Vec<TodoPhaseProjection> {
        self.todo_phases
            .clone()
            .or_else(|| latest_todo_phases_from_tool_cards(&self.tool_cards))
            .unwrap_or_default()
    }

    pub(crate) fn projection(&self) -> SessionProjection {
        SessionProjection {
            summary: self.summary(),
            transcript: {
                // Collect and sort all cards (completed + active) by their insertion position.
                let mut all_cards: Vec<&ToolCard> = self
                    .tool_cards
                    .iter()
                    .chain(self.active_tool_calls.iter())
                    .collect();
                all_cards.sort_by_key(|c| c.insert_after_count);

                let mut t: Vec<TranscriptEntry> = Vec::new();
                let mut ci = 0_usize;

                // Cards that precede all messages (insert_after_count == 0).
                while ci < all_cards.len() && all_cards[ci].insert_after_count == 0 {
                    t.push(TranscriptEntry::Tool(all_cards[ci].clone()));
                    ci += 1;
                }

                // Interleave messages with any cards that follow them.
                for (mi, msg) in self.messages.iter().enumerate() {
                    t.push(TranscriptEntry::Message(msg.clone()));
                    while ci < all_cards.len() && all_cards[ci].insert_after_count == mi + 1 {
                        t.push(TranscriptEntry::Tool(all_cards[ci].clone()));
                        ci += 1;
                    }
                }

                // Any remaining cards (insert_after_count > messages.len()).
                while ci < all_cards.len() {
                    t.push(TranscriptEntry::Tool(all_cards[ci].clone()));
                    ci += 1;
                }

                // Streaming in-flight message always last.
                if let Some(streaming) = &self.streaming_message {
                    t.push(TranscriptEntry::Message(streaming.clone()));
                }
                t
            },
            is_busy: matches!(
                self.effective_status(),
                SessionStatus::Starting | SessionStatus::Busy
            ),
            model: self.model.clone(),
            thinking_level: self.thinking_level.clone(),
            tokens_total: self.tokens_total,
            cost_usd: self.cost_usd,
            context_tokens: self.context_tokens,
            context_window: self.context_window,
            context_percent: self.context_percent,
            plan_mode: self.plan_mode.clone(),
            todo_phases: self.effective_todo_phases(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SessionKind {
    Managed,
    Available,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SessionStatus {
    Starting,
    Idle,
    Busy,
    Exited,
    Available,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSummary {
    pub(crate) session_id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) status: SessionStatus,
    pub(crate) created_at: Timestamp,
    pub(crate) updated_at: Timestamp,
    pub(crate) message_count: usize,
    pub(crate) kind: SessionKind,
    pub(crate) session_file: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) timestamp: Option<String>,
    pub(crate) category: Option<String>,
    pub(crate) worktree: Option<SessionWorktreeSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionWorktreeSummary {
    pub(crate) path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionProjection {
    pub(crate) summary: SessionSummary,
    pub(crate) transcript: Vec<TranscriptEntry>,
    pub(crate) is_busy: bool,
    pub(crate) model: Option<String>,
    pub(crate) thinking_level: Option<String>,
    pub(crate) tokens_total: u64,
    pub(crate) cost_usd: f64,
    pub(crate) context_tokens: Option<u64>,
    pub(crate) context_window: Option<u64>,
    pub(crate) context_percent: Option<f64>,
    pub(crate) plan_mode: Option<PlanModeProjection>,
    pub(crate) todo_phases: Vec<TodoPhaseProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanModeProjection {
    pub(crate) enabled: bool,
    pub(crate) plan_file_path: String,
    pub(crate) workflow: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodoPhaseProjection {
    pub(crate) name: String,
    pub(crate) tasks: Vec<TodoItemProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TodoItemProjection {
    pub(crate) content: String,
    pub(crate) status: TodoStatusProjection,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TodoStatusProjection {
    Pending,
    InProgress,
    Completed,
    Abandoned,
}

pub(crate) fn parse_todo_phases_value(
    value: &Value,
) -> serde_json::Result<Vec<TodoPhaseProjection>> {
    serde_json::from_value(value.clone())
}

pub(crate) fn todo_phases_from_tool_result_value(
    value: Option<&Value>,
) -> Option<Vec<TodoPhaseProjection>> {
    let phases = value?.get("details")?.get("phases")?;
    parse_todo_phases_value(phases).ok()
}

fn latest_todo_phases_from_tool_cards(cards: &[ToolCard]) -> Option<Vec<TodoPhaseProjection>> {
    cards
        .iter()
        .rev()
        .filter(|card| card.tool_name == "todo_write" && !card.is_error)
        .find_map(|card| todo_phases_from_tool_result_value(card.result.as_ref()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptMessage {
    pub(crate) id: String,
    pub(crate) role: MessageRole,
    pub(crate) blocks: Vec<ContentBlock>,
    /// Event timestamp. `None` means the upstream persisted record did not preserve
    /// a precise event time.
    pub(crate) timestamp: Option<Timestamp>,
    /// True when this message arrived via a live `message_end` event rather than a historical `get_messages` load.
    pub(crate) is_new: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        alt: Option<String>,
    },
    /// Extended thinking content. Signature is intentionally excluded.
    Thinking {
        thinking: String,
    },
    /// Thinking content that the provider has fully encrypted/redacted.
    RedactedThinking,
}

/// A single tool-execution card tracked in the session transcript.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCard {
    pub(crate) tool_call_id: String,
    /// Event timestamp for the tool start event.
    pub(crate) timestamp: Option<Timestamp>,
    pub(crate) tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) intent: Option<String>,
    pub(crate) args: Value,
    pub(crate) is_active: bool,
    pub(crate) is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) partial_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<Value>,
    /// messages.len() at the time tool_execution_start fired.
    /// This card appears after record.messages[insert_after_count - 1]
    /// (or before all messages when 0).
    #[serde(skip)]
    pub(crate) insert_after_count: usize,
}

/// A single entry in the unified session transcript.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum TranscriptEntry {
    #[serde(rename = "message")]
    Message(TranscriptMessage),
    #[serde(rename = "tool")]
    Tool(ToolCard),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionHeader {
    #[serde(rename = "type")]
    pub(crate) entry_type: String,
    pub(crate) id: String,
    pub(crate) timestamp: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) title: Option<String>,
}
