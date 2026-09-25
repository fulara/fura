use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::*;

const INSIGHT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

pub(crate) fn is_session_insight_response(frame: &Value) -> bool {
    // The reserved ID prefix also covers malformed or expired replies whose
    // command field is absent. Private read results never enter the raw broadcast.
    value_str(frame, "id").is_some_and(|id| id.starts_with("insight-"))
        || matches!(
            value_str(frame, "command").or_else(|| value_str(frame, "requestType")),
            Some("get_activity" | "get_activity_detail" | "get_session_recap")
        )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ActivityKind {
    Job,
    Agent,
    Service,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ActivityStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    Starting,
    Ready,
    Restarting,
    Stopping,
    Exited,
    Aborted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityItem {
    pub(crate) id: String,
    pub(crate) kind: ActivityKind,
    pub(crate) label: String,
    pub(crate) status: ActivityStatus,
    pub(crate) started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) queued: Option<bool>,
    pub(crate) detail_available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ActivitySourceState {
    pub(crate) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ActivitySources {
    pub(crate) jobs: ActivitySourceState,
    pub(crate) agents: ActivitySourceState,
    pub(crate) services: ActivitySourceState,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionActivitySnapshot {
    pub(crate) session_id: String,
    pub(crate) generation: String,
    pub(crate) observed_at: u64,
    pub(crate) items: Vec<ActivityItem>,
    pub(crate) sources: ActivitySources,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionActivityDetail {
    pub(crate) session_id: String,
    pub(crate) generation: String,
    pub(crate) kind: ActivityKind,
    pub(crate) activity_id: String,
    pub(crate) text: String,
    pub(crate) truncated: bool,
    pub(crate) observed_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecap {
    pub(crate) id: u64,
    pub(crate) text: String,
    pub(crate) created_at: u64,
    pub(crate) source_leaf_id: Option<String>,
    pub(crate) stale: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecapSnapshot {
    pub(crate) session_id: String,
    pub(crate) enabled: bool,
    pub(crate) idle_seconds: f64,
    pub(crate) generating: bool,
    pub(crate) recap: Option<SessionRecap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum InsightOperation {
    Activity,
    Detail,
    Recap,
}

#[derive(Clone, Debug)]
pub(crate) enum InsightRequest {
    Activity,
    Detail {
        generation: String,
        kind: ActivityKind,
        activity_id: String,
    },
    Recap,
}

impl InsightRequest {
    fn operation(&self) -> InsightOperation {
        match self {
            Self::Activity => InsightOperation::Activity,
            Self::Detail { .. } => InsightOperation::Detail,
            Self::Recap => InsightOperation::Recap,
        }
    }

    fn command_name(&self) -> &'static str {
        match self {
            Self::Activity => "get_activity",
            Self::Detail { .. } => "get_activity_detail",
            Self::Recap => "get_session_recap",
        }
    }

    fn command(&self, id: String, session_id: String) -> OmpRpcCommand {
        match self {
            Self::Activity => OmpRpcCommand::GetActivity { id, session_id },
            Self::Detail {
                generation,
                kind,
                activity_id,
            } => OmpRpcCommand::GetActivityDetail {
                id,
                session_id,
                generation: generation.clone(),
                kind: *kind,
                activity_id: activity_id.clone(),
            },
            Self::Recap => OmpRpcCommand::GetSessionRecap { id, session_id },
        }
    }
}

#[derive(Clone)]
pub(crate) struct PendingSessionInsight {
    pub(crate) connection_id: u64,
    pub(crate) session_id: String,
    pub(crate) transport_session_id: String,
    request_id: String,
    stdin: mpsc::Sender<Value>,
    request: InsightRequest,
}

impl PendingSessionInsight {
    fn error(&self, message: impl Into<String>) -> ServerMessage {
        ServerMessage::SessionInsightsError {
            target_connection_id: self.connection_id,
            request_id: self.request_id.clone(),
            session_id: self.session_id.clone(),
            operation: self.request.operation(),
            message: message.into(),
        }
    }
}

async fn insight_binding_is_current(state: &AppState, route: &PendingSessionInsight) -> bool {
    rpc_session_target_id(state, &route.transport_session_id).await == route.session_id
        && state
            .session_runtime
            .stdin_for_transport(&route.transport_session_id)
            .await
            .is_some_and(|stdin| !stdin.is_closed() && stdin.same_channel(&route.stdin))
        && state
            .sessions
            .read()
            .await
            .get(&route.session_id)
            .is_some_and(|record| {
                record.kind == SessionKind::Managed
                    && matches!(record.status, SessionStatus::Idle | SessionStatus::Busy)
            })
}

pub(crate) async fn request_session_insight(
    state: &AppState,
    connection_id: u64,
    request_id: String,
    session_id: String,
    request: InsightRequest,
) -> Vec<ServerMessage> {
    let unavailable = || {
        vec![ServerMessage::SessionInsightsError {
            target_connection_id: connection_id,
            request_id: request_id.clone(),
            session_id: session_id.clone(),
            operation: request.operation(),
            message: "Session insights require an initialized live OMP session.".to_string(),
        }]
    };
    let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await else {
        return unavailable();
    };
    let Some(stdin) = state
        .session_runtime
        .stdin_for_transport(&transport_session_id)
        .await
    else {
        return unavailable();
    };
    let route = PendingSessionInsight {
        connection_id,
        request_id,
        session_id,
        transport_session_id,
        stdin,
        request,
    };
    if !insight_binding_is_current(state, &route).await
        || state
            .session_runtime
            .pending_create(&route.session_id)
            .await
            .is_some()
    {
        return vec![route.error("The original OMP session is not ready or has changed.")];
    }
    let id = format!("insight-{}", next_rpc_id());
    let command = route
        .request
        .command(id.clone(), route.session_id.clone())
        .into_value();
    let stdin = route.stdin.clone();
    state
        .session_runtime
        .pending_session_insights
        .write()
        .await
        .insert(id.clone(), route);
    let state = state.clone();
    // Do not block the WebSocket command loop while waiting for an OMP read.
    tokio::spawn(async move {
        let sent = tokio::time::timeout(INSIGHT_TIMEOUT, stdin.send(command)).await;
        if matches!(sent, Ok(Ok(()))) {
            tokio::time::sleep(INSIGHT_TIMEOUT).await;
        }
        let route = state
            .session_runtime
            .pending_session_insights
            .write()
            .await
            .remove(&id);
        if let Some(route) = route {
            let message = if matches!(sent, Ok(Ok(()))) {
                "OMP did not return session insights before the read deadline."
            } else {
                "The original OMP process disconnected before the read was sent."
            };
            let _ = state.events.emit(&state, route.error(message)).await;
        }
    });
    Vec::new()
}

pub(crate) async fn handle_session_insight_response(
    state: &AppState,
    transport: &str,
    frame: &Value,
) -> bool {
    let command = value_str(frame, "command").or_else(|| value_str(frame, "requestType"));
    let known = is_session_insight_response(frame);
    let Some(id) = value_str(frame, "id") else {
        return known;
    };
    let route = {
        let mut pending = state.session_runtime.pending_session_insights.write().await;
        if !pending
            .get(id)
            .is_some_and(|route| route.transport_session_id == transport)
        {
            return known;
        }
        pending
            .remove(id)
            .expect("insight route checked under the same lock")
    };
    let event = if !insight_binding_is_current(state, &route).await {
        route.error("The OMP session changed while reading session insights.")
    } else if command != Some(route.request.command_name()) {
        route.error("OMP returned a response for a different insight operation.")
    } else if value_str(frame, "status") == Some("error")
        || frame.get("success").and_then(Value::as_bool) == Some(false)
    {
        route.error(rpc_error_message(frame))
    } else {
        insight_result(&route, frame)
            .unwrap_or_else(|| route.error("OMP returned invalid or stale session insight data."))
    };
    let _ = state.events.emit(state, event).await;
    true
}

fn insight_result(route: &PendingSessionInsight, frame: &Value) -> Option<ServerMessage> {
    let connection = route.connection_id;
    let request_id = route.request_id.clone();
    let session_id = route.session_id.clone();
    match &route.request {
        InsightRequest::Activity => {
            let activity = rpc_response_data_as::<SessionActivitySnapshot>(frame)?;
            if activity.session_id != session_id {
                return None;
            }
            Some(ServerMessage::SessionActivityResult {
                target_connection_id: connection,
                request_id,
                session_id,
                activity,
            })
        }
        InsightRequest::Detail {
            generation,
            kind,
            activity_id,
        } => {
            let detail = rpc_response_data_as::<SessionActivityDetail>(frame)?;
            if detail.session_id != session_id
                || detail.generation != *generation
                || detail.kind != *kind
                || detail.activity_id != *activity_id
                || detail.text.len() > 65_536
            {
                return None;
            }
            Some(ServerMessage::SessionActivityDetailResult {
                target_connection_id: connection,
                request_id,
                session_id,
                detail,
            })
        }
        InsightRequest::Recap => {
            let recap = rpc_response_data_as::<SessionRecapSnapshot>(frame)?;
            if recap.session_id != session_id {
                return None;
            }
            Some(ServerMessage::SessionRecapResult {
                target_connection_id: connection,
                request_id,
                session_id,
                state: recap,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{register_test_transport, test_record, test_state};
    use serde_json::json;

    async fn fixture() -> (AppState, mpsc::Receiver<Value>) {
        let state = test_state(16, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".into(), test_record());
        let commands = register_test_transport(&state, "transport", "s1", 8).await;
        (state, commands)
    }

    fn activity(session_id: &str) -> Value {
        json!({
            "sessionId": session_id, "generation": "g1", "observedAt": 123,
            "items": [{
                "id": "service-uuid", "kind": "service", "label": "Preview",
                "status": "ready", "startedAt": 100, "detailAvailable": true
            }],
            "sources": {
                "jobs": {"available": true}, "agents": {"available": true},
                "services": {"available": true}
            }
        })
    }

    #[tokio::test]
    async fn ready_service_is_private_to_requester_and_does_not_make_agent_busy() {
        let (state, mut commands) = fixture().await;
        let mut events = state.events.subscribe();
        request_session_insight(
            &state,
            41,
            "request".into(),
            "s1".into(),
            InsightRequest::Activity,
        )
        .await;
        let command = commands.recv().await.unwrap();
        apply_rpc_response(&state, "transport", &json!({
            "id": command["id"], "command": "get_activity", "success": true, "data": activity("s1")
        })).await;
        let event = events.try_recv().unwrap();
        assert!(
            matches!(&event, ServerMessage::SessionActivityResult { activity, .. }
            if activity.items[0].status == ActivityStatus::Ready)
        );
        assert!(server_message_visible_to_connection(&event, 41));
        assert!(!server_message_visible_to_connection(&event, 42));
        let sessions = state.sessions.read().await;
        let record = sessions.get("s1").unwrap();
        assert_eq!(record.effective_status(), SessionStatus::Idle);
        assert!(
            record.messages.is_empty(),
            "observing activity must not append to the conversation"
        );
    }

    #[tokio::test]
    async fn foreign_transport_cannot_consume_read_and_foreign_session_payload_is_rejected() {
        let (state, mut commands) = fixture().await;
        let mut events = state.events.subscribe();
        request_session_insight(
            &state,
            41,
            "request".into(),
            "s1".into(),
            InsightRequest::Activity,
        )
        .await;
        let command = commands.recv().await.unwrap();
        let frame = json!({
            "id": command["id"], "command": "get_activity", "success": true, "data": activity("foreign")
        });
        apply_rpc_response(&state, "other-transport", &frame).await;
        assert!(events.try_recv().is_err());
        assert_eq!(
            state
                .session_runtime
                .pending_session_insights
                .read()
                .await
                .len(),
            1
        );
        apply_rpc_response(&state, "transport", &frame).await;
        let event = events.try_recv().unwrap();
        assert!(matches!(&event, ServerMessage::SessionInsightsError { .. }));
        assert!(!server_message_visible_to_connection(&event, 42));
        assert!(
            state
                .session_runtime
                .pending_session_insights
                .read()
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn replaced_process_and_rebound_conversation_cannot_publish_late_insights() {
        let (state, mut commands) = fixture().await;
        let mut events = state.events.subscribe();
        request_session_insight(
            &state,
            41,
            "old".into(),
            "s1".into(),
            InsightRequest::Activity,
        )
        .await;
        let command = commands.recv().await.unwrap();
        let mut replacement = register_test_transport(&state, "transport", "s1", 8).await;
        apply_rpc_response(&state, "transport", &json!({
            "id": command["id"], "command": "get_activity", "success": true, "data": activity("s1")
        })).await;
        assert!(matches!(
            events.try_recv().unwrap(),
            ServerMessage::SessionInsightsError { .. }
        ));

        request_session_insight(
            &state,
            41,
            "next".into(),
            "s1".into(),
            InsightRequest::Activity,
        )
        .await;
        let command = replacement.recv().await.unwrap();
        state
            .session_runtime
            .map_transport_to_session("transport", "s2".into())
            .await;
        apply_rpc_response(&state, "transport", &json!({
            "id": command["id"], "command": "get_activity", "success": true, "data": activity("s1")
        })).await;
        assert!(events.try_recv().is_err());
        assert!(
            state
                .session_runtime
                .pending_session_insights
                .read()
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn detail_generation_guard_rejects_reused_id_without_exposing_old_log() {
        let (state, mut commands) = fixture().await;
        let mut events = state.events.subscribe();
        request_session_insight(
            &state,
            41,
            "detail".into(),
            "s1".into(),
            InsightRequest::Detail {
                generation: "new-generation".into(),
                kind: ActivityKind::Service,
                activity_id: "service-uuid".into(),
            },
        )
        .await;
        let command = commands.recv().await.unwrap();
        apply_rpc_response(&state, "transport", &json!({
            "id": command["id"], "command": "get_activity_detail", "success": true,
            "data": {"sessionId":"s1","generation":"old-generation","kind":"service",
                "activityId":"service-uuid","text":"other run's log","truncated":false,"observedAt":123}
        })).await;
        let event = events.try_recv().unwrap();
        assert!(matches!(&event, ServerMessage::SessionInsightsError { .. }));
        assert!(
            !serde_json::to_string(&event)
                .unwrap()
                .contains("other run's log")
        );
    }

    #[tokio::test]
    async fn raw_debug_forwarding_never_broadcasts_private_or_expired_insight_payloads() {
        let (mut state, _commands) = fixture().await;
        state.forward_raw_frames = true;
        let mut events = state.events.subscribe();
        let public = json!({"type": "diagnostic", "message": "public diagnostic"});
        let frames = [
            json!({"type":"response","id":"insight-expired","command":"get_session_recap",
                "success":true,"data":{"text":"private recap"}}),
            json!({"type":"response","id":"insight-malformed","data":{"text":"private log"}}),
            public.clone(),
        ];
        let input = frames
            .iter()
            .map(|frame| format!("{frame}\n"))
            .collect::<String>();
        read_rpc_stdout(
            state,
            "transport".into(),
            tokio::io::BufReader::new(input.as_bytes()),
        )
        .await;
        let mut forwarded = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let ServerMessage::RawOmp { frame, .. } = event {
                forwarded.push(frame);
            }
        }
        assert_eq!(forwarded, vec![public]);
    }
}
