use crate::Timestamp;
use std::{
    collections::HashSet,
    io::{self, Write},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
const MESSAGE_RENDER_HASH_VERSION: &str = "message-render-v1";
const TOOL_CARD_RENDER_HASH_VERSION: &str = "tool-card-render-v1";

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

fn hash_json_field<T: Serialize>(hasher: &mut blake3::Hasher, name: &str, value: &T) {
    hasher.update(name.as_bytes());
    hasher.update(b"=");
    serde_json::to_writer(Blake3Writer(hasher), value)
        .expect("render hash JSON serialization cannot fail");
    hasher.update(b";");
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecord {
    pub(crate) id: String,
    pub(crate) cwd: Option<String>,
    pub(crate) args: Vec<String>,
    pub(crate) status: SessionStatus,
    pub(crate) created_at: Timestamp,
    pub(crate) updated_at: Timestamp,
    pub(crate) session_mode: SessionMode,
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
    pub(crate) goal_mode: Option<GoalModeProjection>,
    pub(crate) pending_plan_review: Option<PendingPlanReviewProjection>,
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
            session_mode: self.session_mode,
            session_file: self.session_file.clone(),
            title: self.title.clone(),
            timestamp: self.timestamp.clone(),
            category: self.category.clone(),
            worktree: self.worktree.clone(),
            goal_mode: self.goal_mode.clone(),
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
            pending_plan_review: self.pending_plan_review.clone(),
            goal_mode: self.goal_mode.clone(),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionMode {
    #[default]
    #[serde(alias = "conflictResolution")]
    Standard,
    DiffReview,
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
    pub(crate) session_mode: SessionMode,
    pub(crate) session_file: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) timestamp: Option<String>,
    pub(crate) category: Option<String>,
    pub(crate) worktree: Option<SessionWorktreeSummary>,
    pub(crate) goal_mode: Option<GoalModeProjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionWorktreeSummary {
    pub(crate) path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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
    pub(crate) pending_plan_review: Option<PendingPlanReviewProjection>,
    pub(crate) goal_mode: Option<GoalModeProjection>,
    pub(crate) todo_phases: Vec<TodoPhaseProjection>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionProjectionDelta {
    pub(crate) summary: SessionSummary,
    pub(crate) transcript_replace_from: usize,
    pub(crate) transcript_append: Vec<TranscriptEntry>,
    pub(crate) is_busy: bool,
    pub(crate) model: Option<String>,
    pub(crate) thinking_level: Option<String>,
    pub(crate) tokens_total: u64,
    pub(crate) cost_usd: f64,
    pub(crate) context_tokens: Option<u64>,
    pub(crate) context_window: Option<u64>,
    pub(crate) context_percent: Option<f64>,
    pub(crate) plan_mode: Option<PlanModeProjection>,
    pub(crate) pending_plan_review: Option<PendingPlanReviewProjection>,
    pub(crate) goal_mode: Option<GoalModeProjection>,
    pub(crate) todo_phases: Vec<TodoPhaseProjection>,
}

impl SessionProjectionDelta {
    pub(crate) fn from_projection_replace_tail(
        transcript_replace_from: usize,
        projection: &SessionProjection,
    ) -> Self {
        Self {
            summary: projection.summary.clone(),
            transcript_replace_from,
            transcript_append: projection.transcript[transcript_replace_from..].to_vec(),
            is_busy: projection.is_busy,
            model: projection.model.clone(),
            thinking_level: projection.thinking_level.clone(),
            tokens_total: projection.tokens_total,
            cost_usd: projection.cost_usd,
            context_tokens: projection.context_tokens,
            context_window: projection.context_window,
            context_percent: projection.context_percent,
            plan_mode: projection.plan_mode.clone(),
            pending_plan_review: projection.pending_plan_review.clone(),
            goal_mode: projection.goal_mode.clone(),
            todo_phases: projection.todo_phases.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanModeProjection {
    pub(crate) enabled: bool,
    pub(crate) plan_file_path: String,
    pub(crate) workflow: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoalModeProjection {
    pub(crate) enabled: bool,
    pub(crate) mode: GoalModeRuntimeMode,
    pub(crate) reason: Option<GoalModeReason>,
    pub(crate) goal: GoalProjection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum GoalModeRuntimeMode {
    Active,
    Exiting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GoalModeReason {
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoalProjection {
    pub(crate) id: String,
    pub(crate) objective: String,
    pub(crate) status: GoalStatusProjection,
    pub(crate) token_budget: Option<u64>,
    pub(crate) tokens_used: u64,
    pub(crate) time_used_seconds: u64,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum GoalStatusProjection {
    Active,
    Paused,
    BudgetLimited,
    Complete,
    Dropped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingPlanReviewProjection {
    pub(crate) plan_file_path: String,
    pub(crate) final_plan_file_path: String,
    pub(crate) title: Option<String>,
    pub(crate) content: String,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
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
    /// Deterministic fingerprint of fields that affect message DOM rendering.
    pub(crate) render_hash: String,
}

impl TranscriptMessage {
    pub(crate) fn new(
        id: String,
        role: MessageRole,
        blocks: Vec<ContentBlock>,
        timestamp: Option<Timestamp>,
        is_new: bool,
    ) -> Self {
        let mut message = Self {
            id,
            role,
            blocks,
            timestamp,
            is_new,
            render_hash: String::new(),
        };
        message.refresh_render_hash();
        message
    }

    pub(crate) fn refresh_render_hash(&mut self) {
        let mut hasher = blake3::Hasher::new();
        hasher.update(MESSAGE_RENDER_HASH_VERSION.as_bytes());
        hasher.update(b";");
        hash_json_field(&mut hasher, "id", &self.id);
        hash_json_field(&mut hasher, "role", &self.role);
        hash_json_field(&mut hasher, "blocks", &self.blocks);
        hash_json_field(&mut hasher, "timestamp", &self.timestamp);
        hash_json_field(&mut hasher, "isNew", &self.is_new);
        self.render_hash = hasher.finalize().to_hex().to_string();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize)]
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
    /// Deterministic fingerprint of fields that affect tool-card DOM rendering.
    pub(crate) render_hash: String,
    /// messages.len() at the time tool_execution_start fired.
    /// This card appears after record.messages[insert_after_count - 1]
    /// (or before all messages when 0).
    #[serde(skip)]
    pub(crate) insert_after_count: usize,
}

impl ToolCard {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        tool_call_id: String,
        timestamp: Option<Timestamp>,
        tool_name: String,
        intent: Option<String>,
        args: Value,
        is_active: bool,
        is_error: bool,
        partial_result: Option<Value>,
        result: Option<Value>,
        insert_after_count: usize,
    ) -> Self {
        let mut card = Self {
            tool_call_id,
            timestamp,
            tool_name,
            intent,
            args,
            is_active,
            is_error,
            partial_result,
            result,
            render_hash: String::new(),
            insert_after_count,
        };
        card.refresh_render_hash();
        card
    }

    pub(crate) fn refresh_render_hash(&mut self) {
        let mut hasher = blake3::Hasher::new();
        hasher.update(TOOL_CARD_RENDER_HASH_VERSION.as_bytes());
        hasher.update(b";");
        hash_json_field(&mut hasher, "toolCallId", &self.tool_call_id);
        hash_json_field(&mut hasher, "timestamp", &self.timestamp);
        hash_json_field(&mut hasher, "toolName", &self.tool_name);
        hash_json_field(&mut hasher, "intent", &self.intent);
        hash_json_field(&mut hasher, "args", &self.args);
        hash_json_field(&mut hasher, "isActive", &self.is_active);
        hash_json_field(&mut hasher, "isError", &self.is_error);
        hash_json_field(&mut hasher, "partialResult", &self.partial_result);
        hash_json_field(&mut hasher, "result", &self.result);
        self.render_hash = hasher.finalize().to_hex().to_string();
    }
}

/// A single entry in the unified session transcript.
#[derive(Debug, Clone, PartialEq, Serialize)]
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_message(id: &str) -> TranscriptEntry {
        TranscriptEntry::Message(TranscriptMessage::new(
            id.to_string(),
            MessageRole::Assistant,
            vec![ContentBlock::Text {
                text: id.to_string(),
            }],
            None,
            true,
        ))
    }

    fn test_summary(message_count: usize) -> SessionSummary {
        SessionSummary {
            session_id: "s1".to_string(),
            cwd: None,
            status: SessionStatus::Idle,
            created_at: Timestamp::now(),
            updated_at: Timestamp::now(),
            message_count,
            kind: SessionKind::Managed,
            session_mode: SessionMode::Standard,
            session_file: None,
            title: None,
            timestamp: None,
            category: None,
            worktree: None,
            goal_mode: None,
        }
    }

    #[test]
    fn projection_delta_replaces_transcript_tail_from_index() {
        let projection = SessionProjection {
            summary: test_summary(3),
            transcript: vec![
                test_message("stable"),
                test_message("old"),
                test_message("new"),
            ],
            is_busy: true,
            model: Some("mock/model".to_string()),
            thinking_level: Some("high".to_string()),
            tokens_total: 42,
            cost_usd: 0.5,
            context_tokens: Some(10),
            context_window: Some(100),
            context_percent: Some(10.0),
            plan_mode: None,
            goal_mode: None,
            pending_plan_review: None,
            todo_phases: Vec::new(),
        };

        let delta = SessionProjectionDelta::from_projection_replace_tail(1, &projection);

        assert_eq!(delta.transcript_replace_from, 1);
        assert_eq!(delta.transcript_append, projection.transcript[1..]);
        assert_eq!(delta.summary.session_id, "s1");
        assert!(delta.is_busy);
        assert_eq!(delta.tokens_total, 42);
    }

    #[test]
    fn message_render_hash_changes_only_when_rendered_fields_change() {
        let mut message = TranscriptMessage::new(
            "m1".to_string(),
            MessageRole::Assistant,
            vec![ContentBlock::Text {
                text: "hello".to_string(),
            }],
            None,
            false,
        );
        let initial = message.render_hash.clone();

        message.refresh_render_hash();
        assert_eq!(message.render_hash, initial);

        message.blocks = vec![ContentBlock::Text {
            text: "hello again".to_string(),
        }];
        message.refresh_render_hash();
        assert_ne!(message.render_hash, initial);
    }

    #[test]
    fn tool_card_render_hash_ignores_insert_position() {
        let mut card = ToolCard::new(
            "tool-1".to_string(),
            None,
            "bash".to_string(),
            Some("running tests".to_string()),
            serde_json::json!({ "command": "cargo test" }),
            true,
            false,
            Some(serde_json::json!({ "text": "running" })),
            None,
            1,
        );
        let initial = card.render_hash.clone();

        card.insert_after_count = 99;
        card.refresh_render_hash();
        assert_eq!(card.render_hash, initial);

        card.partial_result = Some(serde_json::json!({ "text": "done" }));
        card.refresh_render_hash();
        assert_ne!(card.render_hash, initial);
    }
}
