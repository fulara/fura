#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::PromptBehavior;

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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpSessionState {
    pub(crate) model: Option<Value>,
    pub(crate) thinking_level: Option<String>,
    pub(crate) is_streaming: bool,
    pub(crate) is_compacting: bool,
    pub(crate) session_file: Option<String>,
    pub(crate) session_id: String,
    pub(crate) session_name: Option<String>,
    pub(crate) message_count: usize,
    pub(crate) queued_message_count: usize,
    pub(crate) plan_mode: Option<OmpPlanModeState>,
    pub(crate) context_usage: Option<OmpContextUsage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OmpPlanModeState {
    pub(crate) enabled: bool,
    pub(crate) plan_file_path: String,
    pub(crate) workflow: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
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
    #[serde(rename = "set_model")]
    SetModel {
        id: String,
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    #[serde(rename = "prompt")]
    Prompt {
        id: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<Value>>,
        #[serde(rename = "streamingBehavior", skip_serializing_if = "Option::is_none")]
        streaming_behavior: Option<&'static str>,
    },
    #[serde(rename = "abort")]
    Abort { id: String },
    #[serde(rename = "repo_diff_get")]
    RepoDiffGet {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
        #[serde(rename = "headSelector", skip_serializing_if = "Option::is_none")]
        head_selector: Option<String>,
        stat: bool,
    },
    #[serde(rename = "repo_diff_snapshot")]
    RepoDiffSnapshot {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

impl OmpRpcCommand {
    pub(crate) fn into_value(self) -> Value {
        serde_json::to_value(self).expect("OMP RPC command serialization cannot fail")
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
        streaming_behavior: behavior.map(PromptBehavior::as_rpc_streaming_behavior),
    }
    .into_value()
}

pub(crate) fn abort_command(id: String) -> Value {
    OmpRpcCommand::Abort { id }.into_value()
}

pub(crate) fn repo_diff_get_command(
    id: String,
    selector: Option<String>,
    head_selector: Option<String>,
    stat: bool,
) -> Value {
    OmpRpcCommand::RepoDiffGet {
        id,
        selector,
        head_selector,
        stat,
    }
    .into_value()
}

pub(crate) fn repo_diff_snapshot_command(id: String, label: Option<String>) -> Value {
    OmpRpcCommand::RepoDiffSnapshot { id, label }.into_value()
}
