use crate::Timestamp;
use std::{
    collections::HashSet,
    io::{self, Write},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
const MESSAGE_RENDER_HASH_VERSION: &str = "message-render-v1";
const TOOL_CARD_RENDER_HASH_VERSION: &str = "tool-card-render-v1";
const REVIEW_CARD_RENDER_HASH_VERSION: &str = "review-card-render-v1";

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
    /// Raw OMP extension UI request awaiting a user response (the agent `ask` flow),
    /// or `None` when the session is not waiting on one. Carried verbatim so the
    /// frontend reuses its single dialog parser.
    pub(crate) pending_ask: Option<Value>,
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
            awaiting_ask: self.awaiting_ask(),
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

    pub(crate) fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            SessionStatus::Exited | SessionStatus::Available | SessionStatus::Error
        )
    }

    /// A pending ask only surfaces while the session can still answer it.
    fn projected_pending_ask(&self) -> Option<Value> {
        if self.is_terminal() {
            return None;
        }
        self.pending_ask.clone()
    }

    /// True when the session is blocked on a user decision (select/confirm/input/editor).
    fn awaiting_ask(&self) -> bool {
        self.projected_pending_ask()
            .as_ref()
            .and_then(ask_method)
            .is_some_and(is_blocking_ask_method)
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
                    push_tool_entry(&mut t, all_cards[ci]);
                    ci += 1;
                }

                // Interleave messages with any cards that follow them.
                for (mi, msg) in self.messages.iter().enumerate() {
                    t.push(TranscriptEntry::Message(msg.clone()));
                    while ci < all_cards.len() && all_cards[ci].insert_after_count == mi + 1 {
                        push_tool_entry(&mut t, all_cards[ci]);
                        ci += 1;
                    }
                }

                // Any remaining cards (insert_after_count > messages.len()).
                while ci < all_cards.len() {
                    push_tool_entry(&mut t, all_cards[ci]);
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
            pending_ask: self.projected_pending_ask(),
        }
    }
}

pub(crate) fn ask_method(pending: &Value) -> Option<&str> {
    pending.get("method").and_then(Value::as_str)
}

/// Blocking ask methods require a user response and lock the composer.
pub(crate) fn is_blocking_ask_method(method: &str) -> bool {
    matches!(method, "select" | "confirm" | "input" | "editor")
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
    pub(crate) awaiting_ask: bool,
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
    pub(crate) pending_ask: Option<Value>,
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
    pub(crate) pending_ask: Option<Value>,
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
            pending_ask: projection.pending_ask.clone(),
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

/// Derive a consolidated [`ReviewCard`] from a reviewer `task` tool card, or
/// `None` when the card is not a review (or carries no findings/verdict yet).
///
/// The reviewer subagents run inside the `task` tool; their `report_finding`
/// and `yield` calls are surfaced on the parent card under
/// `details.results[].extractedToolData` (final) or `details.progress[].extractedToolData`
/// (live). Prefer the live `progress` snapshot while the task is active and the
/// final per-agent `results` once it completes, mirroring the task-card renderer.
pub(crate) fn review_card_from_tool(card: &ToolCard) -> Option<ReviewCard> {
    if card.tool_name != "task" {
        return None;
    }
    let source = card.partial_result.as_ref().or(card.result.as_ref())?;
    let details = source.get("details")?;
    let progress = details
        .get("progress")
        .and_then(Value::as_array)
        .filter(|entries| !entries.is_empty());
    let results = details
        .get("results")
        .and_then(Value::as_array)
        .filter(|entries| !entries.is_empty());
    // The sync task path keeps `results` empty until every reviewer finishes,
    // so while the card is active the live `progress` snapshot is authoritative.
    let entries = if card.is_active {
        progress.or(results)?
    } else {
        results.or(progress)?
    };

    let mut findings: Vec<ReviewFinding> = Vec::new();
    let mut verdicts: Vec<ReviewVerdict> = Vec::new();
    for entry in entries {
        let agent = entry
            .get("agent")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(extracted) = entry.get("extractedToolData") else {
            continue;
        };
        if let Some(reported) = extracted.get("report_finding").and_then(Value::as_array) {
            findings.extend(
                reported
                    .iter()
                    .filter_map(|finding| parse_review_finding(finding, agent.as_deref())),
            );
        }
        if let Some(yielded) = extracted.get("yield").and_then(Value::as_array) {
            verdicts.extend(yielded.iter().filter_map(|item| {
                parse_review_verdict(item.get("data").unwrap_or(item), agent.as_deref())
            }));
        }
    }

    if findings.is_empty() && verdicts.is_empty() {
        return None;
    }

    findings.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.file_path.cmp(&b.file_path))
            .then_with(|| a.line_start.cmp(&b.line_start))
    });

    let mut review = ReviewCard {
        tool_call_id: card.tool_call_id.clone(),
        timestamp: card.timestamp,
        is_active: card.is_active,
        verdicts,
        findings,
        render_hash: String::new(),
    };
    review.refresh_render_hash();
    Some(review)
}

fn json_u32(value: Option<&Value>) -> Option<u32> {
    // Accept only non-negative integers within u32 range. `as_u64` already
    // rejects negatives, fractionals, and floats; reject out-of-range values
    // instead of silently wrapping a bad line number into a plausible-looking one.
    u32::try_from(value?.as_u64()?).ok()
}

fn parse_review_finding(value: &Value, agent: Option<&str>) -> Option<ReviewFinding> {
    let priority = ReviewPriority::from_label(value.get("priority").and_then(Value::as_str)?)?;
    let title = value
        .get("title")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    let file_path = value.get("file_path").and_then(Value::as_str)?.to_string();
    let line_start = json_u32(value.get("line_start"))?;
    let line_end = json_u32(value.get("line_end")).unwrap_or(line_start);
    if title.is_empty() || file_path.is_empty() {
        return None;
    }
    Some(ReviewFinding {
        title,
        body: value
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        priority,
        confidence: value
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        file_path,
        line_start,
        line_end,
        agent: agent.map(str::to_string),
    })
}

fn parse_review_verdict(value: &Value, agent: Option<&str>) -> Option<ReviewVerdict> {
    let overall_correctness = match value.get("overall_correctness").and_then(Value::as_str)? {
        "correct" => ReviewCorrectness::Correct,
        "incorrect" => ReviewCorrectness::Incorrect,
        _ => return None,
    };
    Some(ReviewVerdict {
        agent: agent.map(str::to_string),
        overall_correctness,
        explanation: value
            .get("explanation")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        confidence: value
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    })
}

/// Push a tool card into the transcript, immediately followed by its derived
/// review artifact when the card is a reviewer `task`. Keeping the review entry
/// adjacent to its source card is what lets the live tool-event deltas (which
/// anchor `transcript_replace_from` on the task card's position) resend it.
fn push_tool_entry(transcript: &mut Vec<TranscriptEntry>, card: &ToolCard) {
    transcript.push(TranscriptEntry::Tool(card.clone()));
    if let Some(review) = review_card_from_tool(card) {
        transcript.push(TranscriptEntry::Review(review));
    }
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

/// Severity of a code-review finding, mirroring OMP `report_finding` priorities.
/// Declaration order is most-severe-first so derived `Ord` sorts P0 → P3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub(crate) enum ReviewPriority {
    P0,
    P1,
    P2,
    P3,
}

impl ReviewPriority {
    fn from_label(value: &str) -> Option<Self> {
        match value {
            "P0" => Some(Self::P0),
            "P1" => Some(Self::P1),
            "P2" => Some(Self::P2),
            "P3" => Some(Self::P3),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ReviewCorrectness {
    Correct,
    Incorrect,
}

/// One inline review finding projected from a reviewer subagent's `report_finding`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewFinding {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) priority: ReviewPriority,
    pub(crate) confidence: f64,
    pub(crate) file_path: String,
    pub(crate) line_start: u32,
    pub(crate) line_end: u32,
    /// Reviewer subagent label, set when more than one reviewer ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent: Option<String>,
}

/// A reviewer subagent's overall verdict, projected from its `yield` payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewVerdict {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent: Option<String>,
    pub(crate) overall_correctness: ReviewCorrectness,
    pub(crate) explanation: String,
    pub(crate) confidence: f64,
}

/// A consolidated code-review result derived from a reviewer `task` tool card.
///
/// Emitted as a first-class transcript artifact (not a tool card) so it stays
/// visible regardless of the tool-bubble visibility toggle. The originating
/// `task` card remains the single source of truth; this is a pure projection of
/// its `report_finding` / `yield` extracted tool data.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewCard {
    /// Tool-call id of the originating reviewer `task` card (stable artifact identity).
    pub(crate) tool_call_id: String,
    pub(crate) timestamp: Option<Timestamp>,
    /// True while the originating review task is still running.
    pub(crate) is_active: bool,
    pub(crate) verdicts: Vec<ReviewVerdict>,
    pub(crate) findings: Vec<ReviewFinding>,
    /// Deterministic fingerprint of fields that affect review-card DOM rendering.
    pub(crate) render_hash: String,
}

impl ReviewCard {
    pub(crate) fn refresh_render_hash(&mut self) {
        let mut hasher = blake3::Hasher::new();
        hasher.update(REVIEW_CARD_RENDER_HASH_VERSION.as_bytes());
        hasher.update(b";");
        hash_json_field(&mut hasher, "toolCallId", &self.tool_call_id);
        hash_json_field(&mut hasher, "timestamp", &self.timestamp);
        hash_json_field(&mut hasher, "isActive", &self.is_active);
        hash_json_field(&mut hasher, "verdicts", &self.verdicts);
        hash_json_field(&mut hasher, "findings", &self.findings);
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
    #[serde(rename = "review")]
    Review(ReviewCard),
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
            awaiting_ask: false,
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
            pending_ask: None,
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

    fn reviewer_task_card(result: Value, is_active: bool) -> ToolCard {
        ToolCard::new(
            "task-1".to_string(),
            None,
            "task".to_string(),
            Some("review the diff".to_string()),
            serde_json::json!({ "agent": "reviewer" }),
            is_active,
            false,
            None,
            Some(result),
            1,
        )
    }

    fn two_finding_review_result() -> Value {
        serde_json::json!({
            "details": {
                "results": [{
                    "agent": "reviewer",
                    "extractedToolData": {
                        "report_finding": [
                            {
                                "title": "Fix late buffer bound",
                                "body": "Overflow when payload exceeds cap.",
                                "priority": "P2",
                                "confidence": 0.7,
                                "file_path": "src/b.rs",
                                "line_start": 12,
                                "line_end": 14
                            },
                            {
                                "title": "Auth bypass on empty token",
                                "body": "Empty token authenticates.",
                                "priority": "P0",
                                "confidence": 0.95,
                                "file_path": "src/a.rs",
                                "line_start": 4,
                                "line_end": 4
                            }
                        ],
                        "yield": [{
                            "data": {
                                "overall_correctness": "incorrect",
                                "explanation": "One blocking auth bug.",
                                "confidence": 0.9
                            }
                        }]
                    }
                }]
            }
        })
    }

    #[test]
    fn review_card_from_tool_extracts_sorted_findings_and_verdict() {
        let card = reviewer_task_card(two_finding_review_result(), false);
        let review = review_card_from_tool(&card).expect("reviewer task yields a review card");

        assert_eq!(review.tool_call_id, "task-1");
        assert!(!review.is_active);
        // Sorted most-severe-first regardless of report order.
        assert_eq!(review.findings.len(), 2);
        assert_eq!(review.findings[0].priority, ReviewPriority::P0);
        assert_eq!(review.findings[0].file_path, "src/a.rs");
        assert_eq!(review.findings[0].line_start, 4);
        assert_eq!(review.findings[1].priority, ReviewPriority::P2);
        assert_eq!(review.findings[1].line_end, 14);
        assert_eq!(review.verdicts.len(), 1);
        assert_eq!(
            review.verdicts[0].overall_correctness,
            ReviewCorrectness::Incorrect
        );
        assert_eq!(review.verdicts[0].explanation, "One blocking auth bug.");
    }

    #[test]
    fn review_card_from_tool_reads_live_progress_when_results_absent() {
        let live = serde_json::json!({
            "details": {
                "results": [],
                "progress": [{
                    "agent": "reviewer",
                    "status": "running",
                    "extractedToolData": {
                        "report_finding": [{
                            "title": "Off-by-one in loop bound",
                            "body": "Skips last element.",
                            "priority": "P1",
                            "confidence": 0.6,
                            "file_path": "src/c.rs",
                            "line_start": 9,
                            "line_end": 9
                        }]
                    }
                }]
            }
        });
        let mut card = reviewer_task_card(serde_json::json!({}), true);
        card.result = None;
        card.partial_result = Some(live);

        let review = review_card_from_tool(&card).expect("live progress yields a review card");
        assert!(review.is_active);
        assert_eq!(review.findings.len(), 1);
        assert_eq!(review.findings[0].priority, ReviewPriority::P1);
        assert!(review.verdicts.is_empty());
    }

    #[test]
    fn review_card_from_tool_drops_findings_with_out_of_range_line() {
        // A line number that overflows u32 must drop the finding rather than wrap
        // to a plausible-looking line; the well-formed finding still survives.
        let result = serde_json::json!({
            "details": {
                "results": [{
                    "agent": "reviewer",
                    "extractedToolData": {
                        "report_finding": [
                            {
                                "title": "Bogus line",
                                "body": "overflows",
                                "priority": "P1",
                                "confidence": 0.5,
                                "file_path": "src/x.rs",
                                "line_start": 4_294_967_300_u64,
                                "line_end": 4_294_967_300_u64
                            },
                            {
                                "title": "Real finding",
                                "body": "ok",
                                "priority": "P0",
                                "confidence": 0.9,
                                "file_path": "src/y.rs",
                                "line_start": 10,
                                "line_end": 12
                            }
                        ]
                    }
                }]
            }
        });
        let review = review_card_from_tool(&reviewer_task_card(result, false))
            .expect("the valid finding still yields a review card");
        assert_eq!(review.findings.len(), 1);
        assert_eq!(review.findings[0].title, "Real finding");
        assert_eq!(review.findings[0].line_start, 10);
    }

    #[test]
    fn review_card_from_tool_ignores_non_review_tools_and_empty_tasks() {
        let bash = ToolCard::new(
            "b1".to_string(),
            None,
            "bash".to_string(),
            None,
            serde_json::json!({}),
            false,
            false,
            None,
            Some(serde_json::json!({ "details": { "results": [] } })),
            1,
        );
        assert!(review_card_from_tool(&bash).is_none());

        let explore = reviewer_task_card(
            serde_json::json!({
                "details": { "results": [{ "agent": "explore", "output": "notes" }] }
            }),
            false,
        );
        assert!(review_card_from_tool(&explore).is_none());
    }

    #[test]
    fn push_tool_entry_appends_review_only_for_reviewer_tasks() {
        let mut transcript = Vec::new();
        push_tool_entry(
            &mut transcript,
            &reviewer_task_card(two_finding_review_result(), false),
        );
        assert!(matches!(
            transcript.as_slice(),
            [TranscriptEntry::Tool(_), TranscriptEntry::Review(_)]
        ));

        let mut other = Vec::new();
        let bash = ToolCard::new(
            "b1".to_string(),
            None,
            "bash".to_string(),
            None,
            serde_json::json!({}),
            false,
            false,
            None,
            Some(serde_json::json!({ "content": [] })),
            1,
        );
        push_tool_entry(&mut other, &bash);
        assert!(matches!(other.as_slice(), [TranscriptEntry::Tool(_)]));
    }

    #[test]
    fn delta_anchored_at_task_card_resends_adjacent_review_entry() {
        // Mirrors the rpc.rs tool-event path: replace_from is the task card's
        // transcript index, so the derived review entry that follows it is resent.
        let tool = reviewer_task_card(two_finding_review_result(), false);
        let review = review_card_from_tool(&tool).expect("review card");
        let projection = SessionProjection {
            summary: test_summary(1),
            transcript: vec![
                test_message("m1"),
                TranscriptEntry::Tool(tool),
                TranscriptEntry::Review(review),
            ],
            is_busy: false,
            model: None,
            thinking_level: None,
            tokens_total: 0,
            cost_usd: 0.0,
            context_tokens: None,
            context_window: None,
            context_percent: None,
            plan_mode: None,
            goal_mode: None,
            pending_plan_review: None,
            pending_ask: None,
            todo_phases: Vec::new(),
        };

        let delta = SessionProjectionDelta::from_projection_replace_tail(1, &projection);
        assert_eq!(delta.transcript_append.len(), 2);
        assert!(matches!(
            delta.transcript_append[0],
            TranscriptEntry::Tool(_)
        ));
        assert!(matches!(
            delta.transcript_append[1],
            TranscriptEntry::Review(_)
        ));
    }
}
