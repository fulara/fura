#![allow(dead_code)]
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{PromptBehavior, TodoPhaseProjection};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum OmpRpcFrame {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "response")]
    Response(OmpRpcResponseFrame),
    #[serde(rename = "agent_start")]
    AgentStart,
    #[serde(rename = "agent_end")]
    AgentEnd { messages: Option<Vec<Value>> },
    #[serde(rename = "plan_review")]
    PlanReview {
        #[serde(rename = "planFilePath")]
        plan_file_path: String,
        #[serde(rename = "finalPlanFilePath")]
        final_plan_file_path: String,
        title: Option<String>,
        content: String,
    },
    #[serde(rename = "message_update")]
    MessageUpdate {
        message: Value,
        #[serde(rename = "assistantMessageEvent")]
        assistant_message_event: Option<Value>,
    },
    #[serde(rename = "message_end")]
    MessageEnd { message: Value },
    #[serde(rename = "tool_execution_start")]
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
        intent: Option<String>,
    },
    #[serde(rename = "tool_execution_update")]
    ToolExecutionUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(default)]
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Option<Value>,
        #[serde(rename = "partialResult")]
        partial_result: Option<Value>,
    },
    #[serde(rename = "tool_execution_end")]
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(default)]
        #[serde(rename = "toolName")]
        tool_name: String,
        result: Option<Value>,
        #[serde(rename = "isError")]
        is_error: Option<bool>,
    },
    #[serde(rename = "goal_updated")]
    GoalUpdated {
        goal: Option<Value>,
        state: Option<Value>,
    },
    #[serde(rename = "extension_ui_request")]
    ExtensionUiRequest {
        id: String,
        method: String,
        #[serde(flatten)]
        payload: serde_json::Map<String, Value>,
    },
    #[serde(rename = "host_tool_call")]
    HostToolCall {
        id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        arguments: Value,
    },
    #[serde(rename = "host_tool_cancel")]
    HostToolCancel {
        id: String,
        #[serde(rename = "targetId")]
        target_id: String,
    },
    #[serde(rename = "host_tool_result")]
    HostToolResult {
        id: String,
        result: Option<Value>,
        #[serde(rename = "isError")]
        is_error: Option<bool>,
        error: Option<String>,
    },
    #[serde(rename = "host_tool_update")]
    HostToolUpdate {
        id: String,
        #[serde(rename = "partialResult")]
        partial_result: Option<Value>,
    },
    #[serde(rename = "host_uri_request")]
    HostUriRequest {
        id: String,
        operation: String,
        url: String,
        content: Option<String>,
    },
    #[serde(rename = "host_uri_cancel")]
    HostUriCancel {
        id: String,
        #[serde(rename = "targetId")]
        target_id: String,
    },
    #[serde(rename = "host_uri_result")]
    HostUriResult {
        id: String,
        content: Option<String>,
        #[serde(rename = "contentType")]
        content_type: Option<String>,
        notes: Option<Vec<String>>,
        immutable: Option<bool>,
        #[serde(rename = "isError")]
        is_error: Option<bool>,
        error: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

impl OmpRpcFrame {
    pub(crate) fn decode(value: Value) -> serde_json::Result<Self> {
        serde_json::from_value(value)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpRpcResponseFrame {
    pub(crate) id: Option<String>,
    pub(crate) command: String,
    pub(crate) success: Option<bool>,
    pub(crate) status: Option<String>,
    pub(crate) data: Option<Value>,
    pub(crate) result: Option<Value>,
    pub(crate) error: Option<Value>,
}

impl OmpRpcResponseFrame {
    pub(crate) fn is_error(&self) -> bool {
        self.status.as_deref() == Some("error") || self.success == Some(false)
    }

    pub(crate) fn payload(&self) -> Option<&Value> {
        self.data.as_ref().or(self.result.as_ref())
    }

    pub(crate) fn data_as<T>(&self) -> Option<T>
    where
        T: DeserializeOwned,
    {
        self.payload()
            .cloned()
            .and_then(|payload| serde_json::from_value(payload).ok())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpSessionState {
    pub(crate) model: Option<Value>,
    pub(crate) thinking_level: Option<String>,
    #[serde(default)]
    pub(crate) is_streaming: bool,
    #[serde(default)]
    pub(crate) is_compacting: bool,
    pub(crate) session_file: Option<String>,
    pub(crate) session_id: String,
    pub(crate) session_name: Option<String>,
    #[serde(default)]
    pub(crate) message_count: usize,
    #[serde(default)]
    pub(crate) queued_message_count: usize,
    pub(crate) plan_mode: Option<OmpPlanModeState>,
    pub(crate) goal_mode: Option<OmpGoalModeState>,
    #[serde(default)]
    pub(crate) todo_phases: Vec<TodoPhaseProjection>,
    pub(crate) context_usage: Option<OmpContextUsage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpPlanModeState {
    pub(crate) enabled: bool,
    pub(crate) plan_file_path: Option<String>,
    pub(crate) workflow: Option<String>,
    pub(crate) reentry: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpGoalModeState {
    pub(crate) enabled: bool,
    pub(crate) mode: String,
    pub(crate) reason: Option<String>,
    pub(crate) goal: Option<OmpGoal>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpGoal {
    pub(crate) id: String,
    pub(crate) objective: String,
    pub(crate) status: String,
    pub(crate) token_budget: Option<u64>,
    pub(crate) tokens_used: u64,
    pub(crate) time_used_seconds: u64,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpContextUsage {
    pub(crate) tokens: Option<u64>,
    pub(crate) context_window: Option<u64>,
    pub(crate) percent: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpPlanModeResponse {
    pub(crate) plan_mode: Option<OmpPlanModeState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpApprovePlanModeResponse {
    pub(crate) final_plan_file_path: Option<String>,
    pub(crate) context_preserved: Option<bool>,
    pub(crate) compaction_outcome: Option<String>,
    pub(crate) execution_dispatched: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpGoalModeResponse {
    pub(crate) goal_mode: Option<OmpGoalModeState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpSetActiveToolsResponse {
    pub(crate) tool_names: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpRepoDiffSnapshot {
    pub(crate) entry_id: String,
    pub(crate) label: Option<String>,
    pub(crate) commit: Option<String>,
    pub(crate) kind: Option<String>,
    pub(crate) created_at: Option<String>,
    pub(crate) head_commit: Option<String>,
    pub(crate) repo_root: Option<String>,
    #[serde(rename = "ref")]
    pub(crate) ref_name: Option<String>,
    pub(crate) source_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpRepoDiffResult {
    pub(crate) snapshots: Vec<OmpRepoDiffSnapshot>,
    pub(crate) selected_snapshot: Option<OmpRepoDiffSnapshot>,
    pub(crate) head_snapshot: Option<OmpRepoDiffSnapshot>,
    pub(crate) diff: Option<String>,
    pub(crate) stat: Option<bool>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpMessagesResponse {
    pub(crate) messages: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpSessionStats {
    pub(crate) session_file: Option<String>,
    pub(crate) session_id: String,
    pub(crate) tokens: OmpTokenStats,
    pub(crate) cost: f64,
    pub(crate) premium_requests: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpTokenStats {
    pub(crate) input: u64,
    pub(crate) output: u64,
    pub(crate) cache_read: u64,
    pub(crate) cache_write: u64,
    pub(crate) total: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpAvailableModelsResponse {
    pub(crate) models: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub(crate) enum OmpRpcCommand {
    #[serde(rename = "get_state")]
    GetState { id: String },
    #[serde(rename = "get_messages")]
    GetMessages { id: String },
    #[serde(rename = "get_session_stats")]
    GetSessionStats { id: String },
    #[serde(rename = "get_available_models")]
    GetAvailableModels { id: String },
    #[serde(rename = "fork")]
    Fork { id: String },
    #[serde(rename = "set_model")]
    SetModel {
        id: String,
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    #[serde(rename = "set_thinking_level")]
    SetThinkingLevel { id: String, level: String },
    #[serde(rename = "set_session_name")]
    SetSessionName { id: String, name: String },
    #[serde(rename = "prompt")]
    Prompt {
        id: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<Value>>,
        #[serde(rename = "streamingBehavior", skip_serializing_if = "Option::is_none")]
        streaming_behavior: Option<String>,
    },
    #[serde(rename = "abort")]
    Abort { id: String },
    #[serde(rename = "set_host_tools")]
    SetHostTools { id: String, tools: Vec<Value> },
    #[serde(rename = "set_active_tools")]
    SetActiveTools {
        id: String,
        #[serde(rename = "toolNames")]
        tool_names: Vec<String>,
    },
    #[serde(rename = "set_plan_mode")]
    SetPlanMode {
        id: String,
        enabled: bool,
        #[serde(rename = "planFilePath", skip_serializing_if = "Option::is_none")]
        plan_file_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workflow: Option<String>,
    },
    #[serde(rename = "approve_plan_mode")]
    ApprovePlanMode {
        id: String,
        #[serde(rename = "planFilePath")]
        plan_file_path: String,
        #[serde(rename = "finalPlanFilePath")]
        final_plan_file_path: String,
        #[serde(rename = "preserveContext")]
        preserve_context: bool,
        #[serde(rename = "compactBeforeExecute")]
        compact_before_execute: bool,
    },
    #[serde(rename = "set_host_uri_schemes")]
    SetHostUriSchemes { id: String, schemes: Vec<Value> },
    #[serde(rename = "goal_mode")]
    GoalMode {
        id: String,
        op: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        objective: Option<String>,
        #[serde(rename = "tokenBudget", skip_serializing_if = "Option::is_none")]
        token_budget: Option<u64>,
    },
    #[serde(rename = "repo_diff_get")]
    RepoDiffGet {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(rename = "headSelector", skip_serializing_if = "Option::is_none")]
        head_selector: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stat: Option<bool>,
    },
    #[serde(rename = "repo_diff_snapshot")]
    RepoDiffSnapshot {
        id: String,
        label: String,
        #[serde(rename = "repoRoot", skip_serializing_if = "Option::is_none")]
        repo_root: Option<String>,
        #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
        ref_name: Option<String>,
    },
}

impl OmpRpcCommand {
    pub(crate) fn into_value(self) -> Value {
        serde_json::to_value(self).expect("OMP RPC command serialization cannot fail")
    }

    pub(crate) fn decode(value: Value) -> serde_json::Result<Self> {
        serde_json::from_value(value)
    }
}

pub(crate) fn get_state_command(id: String) -> Value {
    OmpRpcCommand::GetState { id }.into_value()
}

pub(crate) fn get_messages_command(id: String) -> Value {
    OmpRpcCommand::GetMessages { id }.into_value()
}

pub(crate) fn get_session_stats_command(id: String) -> Value {
    OmpRpcCommand::GetSessionStats { id }.into_value()
}

pub(crate) fn get_available_models_command(id: String) -> Value {
    OmpRpcCommand::GetAvailableModels { id }.into_value()
}

pub(crate) fn set_model_command(id: String, provider: String, model_id: String) -> Value {
    OmpRpcCommand::SetModel {
        id,
        provider,
        model_id,
    }
    .into_value()
}

pub(crate) fn set_thinking_level_command(id: String, level: String) -> Value {
    OmpRpcCommand::SetThinkingLevel { id, level }.into_value()
}

pub(crate) fn prompt_command(
    id: String,
    message: String,
    images: Option<Vec<Value>>,
    behavior: Option<PromptBehavior>,
) -> Value {
    OmpRpcCommand::Prompt {
        id,
        message,
        images,
        streaming_behavior: behavior
            .map(|behavior| behavior.as_rpc_streaming_behavior().to_string()),
    }
    .into_value()
}

pub(crate) fn goal_mode_command(
    id: String,
    op: &'static str,
    objective: Option<String>,
    token_budget: Option<u64>,
) -> Value {
    OmpRpcCommand::GoalMode {
        id,
        op: op.to_string(),
        objective,
        token_budget,
    }
    .into_value()
}

pub(crate) fn abort_command(id: String) -> Value {
    OmpRpcCommand::Abort { id }.into_value()
}

pub(crate) fn fork_command(id: String) -> Value {
    OmpRpcCommand::Fork { id }.into_value()
}

pub(crate) fn set_session_name_command(id: String, name: String) -> Value {
    OmpRpcCommand::SetSessionName { id, name }.into_value()
}

pub(crate) fn set_host_tools_command(id: String, tools: Vec<Value>) -> Value {
    OmpRpcCommand::SetHostTools { id, tools }.into_value()
}

pub(crate) fn set_active_tools_command(id: String, tool_names: Vec<String>) -> Value {
    OmpRpcCommand::SetActiveTools { id, tool_names }.into_value()
}

pub(crate) fn set_plan_mode_command(
    id: String,
    enabled: bool,
    plan_file_path: Option<String>,
    workflow: Option<String>,
) -> Value {
    OmpRpcCommand::SetPlanMode {
        id,
        enabled,
        plan_file_path,
        workflow,
    }
    .into_value()
}

pub(crate) fn approve_plan_mode_command(
    id: String,
    plan_file_path: String,
    final_plan_file_path: String,
    preserve_context: bool,
    compact_before_execute: bool,
) -> Value {
    OmpRpcCommand::ApprovePlanMode {
        id,
        plan_file_path,
        final_plan_file_path,
        preserve_context,
        compact_before_execute,
    }
    .into_value()
}

pub(crate) fn repo_diff_get_command(
    id: String,
    selector: Option<String>,
    head_selector: Option<String>,
    stat: Option<bool>,
) -> Value {
    OmpRpcCommand::RepoDiffGet {
        id,
        selector,
        head_selector,
        stat,
    }
    .into_value()
}

pub(crate) fn repo_diff_snapshot_command(
    id: String,
    label: String,
    repo_root: Option<String>,
    ref_name: Option<String>,
) -> Value {
    OmpRpcCommand::RepoDiffSnapshot {
        id,
        label,
        repo_root,
        ref_name,
    }
    .into_value()
}
