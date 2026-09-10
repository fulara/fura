use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::{Context, anyhow};
use git2::{Branch, BranchType, Repository, Worktree, WorktreeAddOptions, WorktreePruneOptions};
use serde_json::{Map, Value, json};
use tracing::{debug, error, info, warn};

use crate::*;

#[cfg(test)]
pub(crate) async fn handle_client_message(
    state: &AppState,
    message: ClientMessage,
) -> Vec<ServerMessage> {
    handle_client_message_for_connection(state, message, 0).await
}

pub(crate) async fn handle_client_message_for_connection(
    state: &AppState,
    message: ClientMessage,
    owner_connection_id: u64,
) -> Vec<ServerMessage> {
    match message {
        ClientMessage::SessionCreate {
            request_id,
            cwd,
            name,
            args,
            category,
            session_mode,
            worktree,
            proposed_model_id,
        } => {
            create_session(
                state,
                request_id,
                cwd,
                name,
                args,
                category,
                session_mode.unwrap_or_default(),
                worktree,
                proposed_model_id,
            )
            .await
        }
        ClientMessage::SessionSetCategory {
            session_id,
            category,
        } => set_session_category(state, session_id, category).await,
        ClientMessage::ConfigSet {
            show_tools,
            show_edit_diffs,
            thinking_visibility,
            proposed_models,
        } => {
            set_client_config(
                state,
                show_tools,
                show_edit_diffs,
                thinking_visibility,
                proposed_models,
            )
            .await
        }
        ClientMessage::ConfigModelCatalogList { request_id } => {
            handle_model_catalog_list_command(state, request_id).await
        }
        ClientMessage::PresetSave {
            name,
            description,
            body,
            defaults,
        } => handle_preset_save(state, name, description, body, defaults).await,
        ClientMessage::PresetDelete { name } => handle_preset_delete(state, name).await,
        ClientMessage::PresetsRefresh => {
            info!(action = "presets.refresh");
            let presets = presets_dir(state.config_path.as_deref())
                .map(|dir| load_presets(&dir))
                .unwrap_or_default();
            vec![ServerMessage::PresetList { presets }]
        }
        ClientMessage::SessionOpen { session_file } => open_session(state, session_file).await,
        ClientMessage::SessionList => {
            info!(action = "session.list");
            refresh_session_catalog(state).await;
            state.events.emit_sessions_snapshot(state).await;
            Vec::new()
        }
        ClientMessage::SessionAttach { session_id } => {
            info!(action = "session.attach", session_id = %session_id);
            if let Err(message) = refresh_rpc_state_if_ready(state, &session_id).await {
                warn!(session_id = %session_id, %message, "state refresh could not reach RPC child");
            }
            if state
                .events
                .emit_current_session_snapshot(state, &session_id)
                .await
            {
                Vec::new()
            } else {
                vec![unknown_session_error(session_id)]
            }
        }
        ClientMessage::StateRefresh { session_id } => {
            info!(action = "session.refresh", session_id = %session_id);
            if let Err(message) = refresh_rpc_state_if_ready(state, &session_id).await {
                warn!(session_id = %session_id, %message, "state refresh could not reach RPC child");
            }
            // Refresh of a pruned session is expected resync churn, not an error:
            // the authoritative `sessions.snapshot` reconciles the client's stale
            // projections. Emit the snapshot when the session is live, stay silent
            // otherwise so no session-less error lands in the active transcript.
            state
                .events
                .emit_current_session_snapshot(state, &session_id)
                .await;
            Vec::new()
        }
        ClientMessage::SessionDetach { session_id } => {
            info!(action = "session.detach", session_id = %session_id);
            vec![ServerMessage::LogStderr {
                session_id,
                text: "detached frontend client; backend session remains alive".to_string(),
            }]
        }
        ClientMessage::SessionStop { session_id } => stop_session(state, session_id).await,
        ClientMessage::SessionDelete {
            session_id,
            delete_worktree,
        } => delete_session(state, session_id, delete_worktree).await,
        ClientMessage::PromptSend {
            session_id,
            text,
            images,
            behavior,
        } => send_prompt(state, session_id, text, images, behavior).await,
        ClientMessage::SessionRewindList {
            session_id,
            request_id,
        } => handle_session_rewind_list(state, owner_connection_id, session_id, request_id).await,
        ClientMessage::SessionRewindSelect {
            session_id,
            request_id,
            entry_id,
        } => {
            handle_session_rewind_select(
                state,
                owner_connection_id,
                session_id,
                request_id,
                entry_id,
            )
            .await
        }
        ClientMessage::PromptAbort { session_id } => abort_prompt(state, session_id).await,
        ClientMessage::SessionBtwStart {
            client_id,
            session_id,
            request_id,
            question,
        } => {
            start_btw_request(
                state,
                owner_connection_id,
                client_id,
                session_id,
                request_id,
                question,
            )
            .await
        }
        ClientMessage::SessionBtwCancel {
            client_id,
            request_id,
        } => {
            control_btw_request(
                state,
                owner_connection_id,
                client_id,
                request_id,
                PendingBtwCommandKind::Cancel,
            )
            .await
        }
        ClientMessage::SessionBtwRelease {
            client_id,
            request_id,
        } => {
            control_btw_request(
                state,
                owner_connection_id,
                client_id,
                request_id,
                PendingBtwCommandKind::Release,
            )
            .await
        }
        ClientMessage::SessionBtwPromote {
            client_id,
            request_id,
        } => {
            control_btw_request(
                state,
                owner_connection_id,
                client_id,
                request_id,
                PendingBtwCommandKind::Promote,
            )
            .await
        }
        ClientMessage::GoalStart {
            session_id,
            objective,
            token_budget,
        } => handle_goal_start(state, session_id, objective, token_budget).await,
        ClientMessage::GoalControl { session_id, action } => {
            handle_goal_control(state, session_id, action).await
        }
        ClientMessage::GoalSetBudget {
            session_id,
            token_budget,
        } => handle_goal_set_budget(state, session_id, token_budget).await,
        ClientMessage::ControlPrompt {
            client_id,
            conversation_id,
            text,
            ui_snapshot,
        } => handle_control_prompt(state, client_id, conversation_id, text, ui_snapshot).await,
        ClientMessage::ControlAbort {
            client_id,
            conversation_id,
        } => handle_control_abort(state, client_id, conversation_id).await,
        ClientMessage::VoiceStart {
            client_id,
            language,
        } => start_voice_session(state, client_id, language).await,
        ClientMessage::VoiceAudio { client_id, audio } => {
            handle_voice_audio(state, client_id, audio).await
        }
        ClientMessage::VoiceStop { client_id } => stop_voice_session(state, client_id).await,
        ClientMessage::DialogRespond {
            session_id,
            dialog_id,
            response,
        } => {
            info!(action = "dialog.respond", session_id = %session_id, dialog_id = %dialog_id);
            let mut command = match response {
                Value::Object(response) => response,
                _ => {
                    return vec![ServerMessage::Error {
                        request_id: None,
                        message: "dialog response must be a JSON object".to_string(),
                    }];
                }
            };
            // Drop the session ask state as soon as the user answers so the composer
            // unlocks and the card clears even before the agent issues its next step.
            let answered_id = dialog_id.clone();
            let cleared_session_id = session_id.clone();
            state
                .events
                .mutate_session_and_emit(state, &session_id, move |record| {
                    let current_id = record
                        .pending_ask
                        .as_ref()
                        .and_then(|pending| pending.get("id"))
                        .and_then(Value::as_str);
                    if current_id != Some(answered_id.as_str()) {
                        return None;
                    }
                    record.pending_ask = None;
                    Some(ServerMessage::SessionSnapshot {
                        session_id: cleared_session_id,
                        state: record.projection(),
                    })
                })
                .await;
            command.insert("id".to_string(), Value::String(dialog_id));
            command.insert(
                "type".to_string(),
                Value::String("extension_ui_response".to_string()),
            );
            match send_rpc_command(state, &session_id, Value::Object(command)).await {
                Ok(()) => Vec::new(),
                Err(message) => vec![ServerMessage::Error {
                    request_id: None,
                    message,
                }],
            }
        }
        ClientMessage::ModelList { session_id } => {
            handle_model_list_command(state, session_id).await
        }
        ClientMessage::ModelSet {
            session_id,
            provider,
            model_id,
        } => handle_model_set_command(state, session_id, &provider, &model_id).await,
        ClientMessage::SessionChangesRequest {
            client_id,
            diff_id,
            session_id,
            repo_id,
            change_kind,
            detail_mode,
            current_commit_oid,
            selected_file,
            context_lines,
        } => {
            handle_session_changes_request(
                state,
                client_id,
                diff_id,
                session_id,
                repo_id,
                change_kind,
                detail_mode,
                current_commit_oid,
                selected_file,
                context_lines,
            )
            .await
        }
        ClientMessage::GitHistoryRequest {
            client_id,
            request_id,
            session_id,
            repo_id,
            cursor,
        } => {
            handle_git_history_request(
                state,
                owner_connection_id,
                client_id,
                request_id,
                session_id,
                repo_id,
                cursor,
            )
            .await
        }
        ClientMessage::GitFileRequest {
            client_id,
            request_id,
            repo_root,
            commit_oid,
            path,
        } => {
            handle_git_file_request(
                state,
                owner_connection_id,
                client_id,
                request_id,
                repo_root,
                commit_oid,
                path,
            )
            .await
        }
        ClientMessage::GitRangeDiffRequest {
            client_id,
            request_id,
            repo_root,
            base,
            old,
            new,
            ignore_whitespace,
        } => {
            handle_git_range_diff_request(
                state,
                owner_connection_id,
                client_id,
                request_id,
                repo_root,
                base,
                old,
                new,
                ignore_whitespace,
            )
            .await
        }
        ClientMessage::GitRangeDiffCancel { request_id } => {
            cancel_git_range_diff(state, owner_connection_id, Some(&request_id)).await;
            Vec::new()
        }
        ClientMessage::SessionReposUpdate {
            session_id,
            action,
            path,
        } => crate::session_repos::update_session_repo(state, &session_id, action, &path).await,
        ClientMessage::CompareDiffRequest {
            client_id,
            diff_id,
            repo_root,
            base,
            head,
            detail_mode,
            merge_base,
            current_commit_oid,
            selected_file,
            context_lines,
        } => {
            handle_compare_diff_request(
                state,
                client_id,
                diff_id,
                repo_root,
                base,
                head,
                detail_mode,
                merge_base,
                current_commit_oid,
                selected_file,
                context_lines,
            )
            .await
        }
        ClientMessage::DiffContentRequest {
            client_id,
            diff_id,
            scope,
            session_id,
            comparison_key,
            selected_file,
            context_lines,
        } => {
            handle_diff_content_request(
                state,
                client_id,
                diff_id,
                scope,
                session_id,
                comparison_key,
                selected_file,
                context_lines,
            )
            .await
        }
        ClientMessage::DiffCancel {
            client_id,
            diff_id,
            scope,
            reason,
        } => handle_diff_cancel(state, client_id, diff_id, scope, reason).await,
        ClientMessage::DiffReviewWorktreeEnsure {
            source_repo_root,
            target,
        } => handle_diff_review_worktree_ensure(state, source_repo_root, target).await,
        ClientMessage::DiffReviewWorktreeCheckout {
            worktree_id,
            ref_target,
        } => handle_diff_review_worktree_checkout(state, worktree_id, ref_target).await,
        ClientMessage::CodeWorkspaceOpen { session_id } => {
            handle_code_workspace_open(state, session_id).await
        }
        ClientMessage::CodeWorkspaceOpenRoot {
            root,
            source,
            review_worktree_id,
        } => handle_code_workspace_open_root(state, root, source, review_worktree_id).await,
        ClientMessage::CodeTreeList { workspace_id, path } => {
            handle_code_tree_list(state, workspace_id, path).await
        }
        ClientMessage::CodeFileOpen { workspace_id, path } => {
            handle_code_file_open(state, workspace_id, path).await
        }
        ClientMessage::CodeFileClose { workspace_id, path } => {
            handle_code_file_close(workspace_id, path).await
        }
        ClientMessage::CodeFileSearch {
            workspace_id,
            base_path,
            query,
            limit,
        } => handle_code_file_search(state, workspace_id, base_path, query, limit).await,
        ClientMessage::CodeDefinition {
            workspace_id,
            path,
            line,
            character,
            request_id,
        } => handle_code_definition(state, workspace_id, path, line, character, request_id).await,
        ClientMessage::CodeReferences {
            workspace_id,
            path,
            line,
            character,
            request_id,
        } => handle_code_references(state, workspace_id, path, line, character, request_id).await,
        ClientMessage::CodeHover {
            workspace_id,
            path,
            line,
            character,
            request_id,
        } => handle_code_hover(state, workspace_id, path, line, character, request_id).await,
        ClientMessage::PlanApprove {
            session_id,
            plan_file_path,
            final_plan_file_path,
            title,
            content,
            approval_mode,
        } => {
            handle_plan_approve(
                state,
                session_id,
                plan_file_path,
                final_plan_file_path,
                title,
                content,
                approval_mode,
            )
            .await
        }
        ClientMessage::RawRpc {
            session_id,
            mut command,
        } => {
            info!(
                action = "raw.rpc",
                session_id = %session_id,
                command_type = command_type(&command)
            );
            ensure_rpc_id(&mut command);
            match send_rpc_command(state, &session_id, command).await {
                Ok(()) => Vec::new(),
                Err(message) => vec![ServerMessage::Error {
                    request_id: None,
                    message,
                }],
            }
        }
        ClientMessage::ReviewCommentsList {
            session_id,
            comparison_key,
        } => handle_review_comments_list(state, session_id, comparison_key).await,
        ClientMessage::ReviewCommentCreate {
            session_id,
            repo_root,
            comparison_key,
            anchor,
            body,
        } => {
            handle_review_comment_create(state, session_id, repo_root, comparison_key, anchor, body)
                .await
        }
        ClientMessage::ReviewCommentUpdate { id, body } => {
            handle_review_comment_update(state, id, body).await
        }
        ClientMessage::ReviewCommentMarkFlushed { comments } => {
            handle_review_comment_mark_flushed(state, comments).await
        }
        ClientMessage::ReviewCommentDelete { id } => handle_review_comment_delete(state, id).await,
        ClientMessage::ReviewAgentReviewStart {
            session_id,
            state: review_state,
            instructions,
        } => handle_review_agent_review_start(state, session_id, review_state, instructions).await,
        ClientMessage::SessionFork {
            request_id,
            session_id,
        } => handle_session_fork(state, session_id, request_id, owner_connection_id).await,
        ClientMessage::SessionHandoff {
            session_id,
            name,
            custom_instructions,
        } => handle_session_handoff(state, session_id, name, custom_instructions).await,
    }
}
fn session_fork_error(
    target_connection_id: Option<u64>,
    request_id: String,
    source_session_id: String,
    message: impl Into<String>,
) -> ServerMessage {
    ServerMessage::SessionForkError {
        target_connection_id,
        request_id,
        source_session_id,
        message: message.into(),
    }
}

fn session_rewind_error(
    target_connection_id: u64,
    request_id: String,
    source_session_id: String,
    session_id: String,
    message: impl Into<String>,
) -> ServerMessage {
    ServerMessage::SessionRewindError {
        target_connection_id: Some(target_connection_id),
        request_id,
        source_session_id,
        session_id,
        message: message.into(),
    }
}

async fn rewind_transport_for_managed_session(
    state: &AppState,
    session_id: &str,
) -> Result<String, String> {
    let is_managed = state
        .sessions
        .read()
        .await
        .get(session_id)
        .is_some_and(|record| record.kind == SessionKind::Managed);
    if !is_managed {
        return Err("Rollback is only available for a managed session.".to_string());
    }
    let transport_session_id = rpc_transport_session_id(state, session_id)
        .await
        .ok_or_else(|| "This session has no live OMP process.".to_string())?;
    if !state
        .session_runtime
        .contains_transport(&transport_session_id)
        .await
    {
        return Err("This session has no live OMP process.".to_string());
    }
    Ok(transport_session_id)
}

async fn handle_session_rewind_list(
    state: &AppState,
    owner_connection_id: u64,
    session_id: String,
    request_id: String,
) -> Vec<ServerMessage> {
    let transport_session_id = match rewind_transport_for_managed_session(state, &session_id).await
    {
        Ok(transport_session_id) => transport_session_id,
        Err(message) => {
            return vec![session_rewind_error(
                owner_connection_id,
                request_id,
                session_id.clone(),
                session_id,
                message,
            )];
        }
    };
    let command_id = next_rpc_id();
    let route = RewindRoute {
        target_connection_id: Some(owner_connection_id),
        request_id: request_id.clone(),
        source_session_id: session_id.clone(),
        transport_session_id: transport_session_id.clone(),
    };
    if !state
        .session_runtime
        .insert_pending_rewind_list(command_id.clone(), route)
        .await
    {
        return vec![session_rewind_error(
            owner_connection_id,
            request_id,
            session_id.clone(),
            session_id,
            "A rollback is already in progress for this session.",
        )];
    }
    if let Err(message) = send_rpc_command(
        state,
        &transport_session_id,
        get_branch_messages_command(command_id.clone()),
    )
    .await
        && state
            .session_runtime
            .take_pending_rewind_rpc(&command_id)
            .await
            .is_some()
    {
        return vec![session_rewind_error(
            owner_connection_id,
            request_id,
            session_id.clone(),
            session_id,
            message,
        )];
    }
    Vec::new()
}

async fn handle_session_rewind_select(
    state: &AppState,
    owner_connection_id: u64,
    session_id: String,
    request_id: String,
    entry_id: String,
) -> Vec<ServerMessage> {
    let available = state
        .sessions
        .read()
        .await
        .get(&session_id)
        .is_some_and(|record| {
            record.kind == SessionKind::Managed
                && record.effective_status() == SessionStatus::Idle
                && !record.is_compacting
        });
    if !available {
        return vec![session_rewind_error(
            owner_connection_id,
            request_id,
            session_id.clone(),
            session_id,
            "Rollback requires an idle managed session.",
        )];
    }
    let transport_session_id = match rewind_transport_for_managed_session(state, &session_id).await
    {
        Ok(transport_session_id) => transport_session_id,
        Err(message) => {
            return vec![session_rewind_error(
                owner_connection_id,
                request_id,
                session_id.clone(),
                session_id,
                message,
            )];
        }
    };
    let command_id = next_rpc_id();
    let route = RewindRoute {
        target_connection_id: Some(owner_connection_id),
        request_id: request_id.clone(),
        source_session_id: session_id.clone(),
        transport_session_id: transport_session_id.clone(),
    };
    if !state
        .session_runtime
        .insert_pending_rewind_branch(command_id.clone(), route)
        .await
    {
        return vec![session_rewind_error(
            owner_connection_id,
            request_id,
            session_id.clone(),
            session_id,
            "A rollback is already in progress for this session.",
        )];
    }
    if let Err(message) = send_rpc_command(
        state,
        &transport_session_id,
        branch_command(command_id.clone(), entry_id),
    )
    .await
        && state
            .session_runtime
            .take_pending_rewind_rpc(&command_id)
            .await
            .is_some()
    {
        return vec![session_rewind_error(
            owner_connection_id,
            request_id,
            session_id.clone(),
            session_id,
            message,
        )];
    }
    Vec::new()
}

pub(crate) fn normalize_optional_field(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    })
}

const MAX_SESSION_CATEGORY_LEN: usize = 80;

pub(crate) fn normalize_session_category(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = normalize_optional_field(value) else {
        return Ok(None);
    };
    if value.chars().count() > MAX_SESSION_CATEGORY_LEN {
        return Err(format!(
            "session category must be {MAX_SESSION_CATEGORY_LEN} characters or fewer",
        ));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(
            "session category must be a single line without control characters".to_string(),
        );
    }
    Ok(Some(value))
}

pub(crate) async fn resolve_proposed_model_for_create(
    state: &AppState,
    proposed_model_id: Option<String>,
) -> Result<Option<ProposedModelConfig>, String> {
    let Some(id) = normalize_optional_field(proposed_model_id) else {
        return Ok(None);
    };
    if id == "default" {
        return Ok(None);
    }
    let proposed_models = state.proposed_models.read().await;
    let Some(model) = proposed_models.iter().find(|model| model.id == id).cloned() else {
        return Err(format!("Unknown proposed model: {id}"));
    };
    validate_proposed_models(std::slice::from_ref(&model)).map_err(|error| error.to_string())?;
    Ok(Some(model))
}

pub(crate) fn ensure_worktree_directory_available(path: &Path) -> anyhow::Result<()> {
    match fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() {
                anyhow::bail!("worktree path is not a directory: {}", path.display());
            }
            if fs::read_dir(path)
                .with_context(|| format!("failed to read worktree directory {}", path.display()))?
                .next()
                .is_some()
            {
                anyhow::bail!("worktree directory must be empty: {}", path.display());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .ok_or_else(|| anyhow!("worktree path has no parent: {}", path.display()))?;
            let metadata = fs::metadata(parent)
                .with_context(|| format!("worktree parent does not exist: {}", parent.display()))?;
            if !metadata.is_dir() {
                anyhow::bail!("worktree parent is not a directory: {}", parent.display());
            }
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to inspect worktree path {}", path.display()));
        }
    }
    Ok(())
}

pub(crate) fn prune_valid_worktree(worktree: &Worktree) -> anyhow::Result<()> {
    let mut options = WorktreePruneOptions::new();
    options.valid(true).working_tree(true);
    worktree
        .prune(Some(&mut options))
        .with_context(|| format!("failed to prune worktree {}", worktree.path().display()))
}

pub(crate) fn delete_git_worktree_sync(path: &Path) -> anyhow::Result<()> {
    let worktree_root = fs::canonicalize(path)
        .with_context(|| format!("worktree path does not exist: {}", path.display()))?;
    let metadata = fs::metadata(&worktree_root).with_context(|| {
        format!(
            "failed to inspect worktree path {}",
            worktree_root.display()
        )
    })?;
    if !metadata.is_dir() {
        anyhow::bail!(
            "worktree path is not a directory: {}",
            worktree_root.display()
        );
    }

    let git_entry = worktree_root.join(".git");
    let git_metadata = fs::metadata(&git_entry).with_context(|| {
        format!(
            "session cwd is not a linked git worktree root; missing .git file at {}",
            git_entry.display()
        )
    })?;
    if !git_metadata.is_file() {
        anyhow::bail!(
            "session cwd is not a linked git worktree root; .git is not a file: {}",
            git_entry.display()
        );
    }

    let repo = Repository::open(&worktree_root)
        .with_context(|| format!("failed to open git worktree at {}", worktree_root.display()))?;
    let worktree = Worktree::open_from_repository(&repo).with_context(|| {
        format!(
            "failed to open linked worktree at {}",
            worktree_root.display()
        )
    })?;
    worktree
        .validate()
        .with_context(|| format!("failed to validate worktree {}", worktree_root.display()))?;
    let reported_path = fs::canonicalize(worktree.path()).with_context(|| {
        format!(
            "failed to resolve linked worktree path {}",
            worktree.path().display()
        )
    })?;
    if reported_path != worktree_root {
        anyhow::bail!(
            "git reported a different worktree path: expected {}, got {}",
            worktree_root.display(),
            reported_path.display()
        );
    }

    prune_valid_worktree(&worktree)
}

pub(crate) fn reference_for_worktree<'repo>(
    repo: &'repo Repository,
    base_branch: &str,
    branch_name: Option<&str>,
) -> anyhow::Result<git2::Reference<'repo>> {
    let (base_object, base_reference) = repo
        .revparse_ext(base_branch)
        .with_context(|| format!("base branch or ref not found: {base_branch}"))?;

    if let Some(branch_name) = branch_name {
        if branch_name.starts_with('-') {
            anyhow::bail!("branch name must not start with '-'");
        }
        if !Branch::name_is_valid(branch_name).context("failed to validate branch name")? {
            anyhow::bail!("invalid branch name: {branch_name}");
        }
        if repo.find_branch(branch_name, BranchType::Local).is_ok() {
            anyhow::bail!("branch already exists: {branch_name}");
        }
        let commit = base_object
            .peel_to_commit()
            .with_context(|| format!("base branch does not resolve to a commit: {base_branch}"))?;
        return repo
            .branch(branch_name, &commit, false)
            .map(Branch::into_reference)
            .with_context(|| format!("failed to create branch {branch_name}"));
    }

    base_reference.ok_or_else(|| {
        anyhow!(
            "base branch must resolve to a named ref when no branch name is provided: {base_branch}"
        )
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CreatedWorktree {
    pub(crate) source_repo_root: PathBuf,
    pub(crate) worktree_root: PathBuf,
    pub(crate) session_cwd: PathBuf,
}

pub(crate) fn create_git_worktree_sync(
    request: &WorktreeCreateRequest,
) -> anyhow::Result<CreatedWorktree> {
    let source_repo = request.source_repo.trim();
    if source_repo.is_empty() {
        anyhow::bail!("worktree source repo root is required");
    }
    if source_repo.contains('\0') {
        anyhow::bail!("worktree source repo root contains an invalid NUL character");
    }

    let directory = request.directory.trim();
    if directory.is_empty() {
        anyhow::bail!("worktree directory is required");
    }
    if directory.contains('\0') {
        anyhow::bail!("worktree directory contains an invalid NUL character");
    }

    let base_branch = request.base_branch.trim();
    if base_branch.is_empty() {
        anyhow::bail!("base branch is required");
    }
    if base_branch.starts_with('-') {
        anyhow::bail!("base branch must not start with '-'");
    }

    let source_repo_path = PathBuf::from(source_repo);
    let source_repo_path = if source_repo_path.is_absolute() {
        source_repo_path
    } else {
        std::env::current_dir()
            .context("failed to resolve current directory")?
            .join(source_repo_path)
    };
    let source_repo_root = fs::canonicalize(&source_repo_path)
        .with_context(|| format!("source repo root does not exist: {source_repo}"))?;
    let metadata = fs::metadata(&source_repo_root).with_context(|| {
        format!(
            "failed to inspect source repo root {}",
            source_repo_root.display()
        )
    })?;
    if !metadata.is_dir() {
        anyhow::bail!(
            "worktree source repo root is not a directory: {}",
            source_repo_root.display()
        );
    }
    let git_entry = source_repo_root.join(".git");
    if fs::metadata(&git_entry).is_err() {
        anyhow::bail!(
            "worktree source repo root must contain .git: {}",
            source_repo_root.display()
        );
    }

    let repo = Repository::open(&source_repo_root).with_context(|| {
        format!(
            "failed to open git repository at {}",
            source_repo_root.display()
        )
    })?;
    let repo_workdir = repo
        .workdir()
        .ok_or_else(|| anyhow!("worktree creation requires a non-bare source repository"))?;
    let repo_workdir = fs::canonicalize(repo_workdir).with_context(|| {
        format!(
            "failed to resolve source repository root {}",
            repo_workdir.display()
        )
    })?;
    if repo_workdir != source_repo_root {
        anyhow::bail!(
            "worktree source repo root must be the repository root containing .git: {}",
            source_repo_root.display()
        );
    }

    let target_path = {
        let path = PathBuf::from(directory);
        if path.is_absolute() {
            path
        } else {
            source_repo_root.join(path)
        }
    };
    ensure_worktree_directory_available(&target_path)?;

    let branch_name = request
        .branch_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let worktree_name = target_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("worktree path must end in a valid UTF-8 directory name"))?;

    let worktree_result = {
        let reference = reference_for_worktree(&repo, base_branch, branch_name)?;
        let mut options = WorktreeAddOptions::new();
        options.reference(Some(&reference));
        repo.worktree(worktree_name, &target_path, Some(&options))
    };
    let worktree = match worktree_result {
        Ok(worktree) => worktree,
        Err(error) => {
            if let Some(branch_name) = branch_name {
                if let Ok(mut branch) = repo.find_branch(branch_name, BranchType::Local) {
                    let _ = branch.delete();
                }
            }
            return Err(error).with_context(|| {
                format!("failed to create worktree at {}", target_path.display())
            });
        }
    };
    let worktree_repo = Repository::open_from_worktree(&worktree)
        .with_context(|| format!("failed to open created worktree {}", target_path.display()))?;
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe();
    worktree_repo
        .checkout_head(Some(&mut checkout))
        .with_context(|| format!("failed to checkout worktree {}", target_path.display()))?;

    let session_cwd = target_path.clone();
    let metadata = fs::metadata(&session_cwd).with_context(|| {
        format!(
            "created worktree directory is missing: {}",
            session_cwd.display()
        )
    })?;
    if !metadata.is_dir() {
        anyhow::bail!(
            "created worktree path is not a directory: {}",
            session_cwd.display()
        );
    }

    Ok(CreatedWorktree {
        source_repo_root,
        worktree_root: target_path,
        session_cwd,
    })
}

pub(crate) async fn create_git_worktree(
    request: WorktreeCreateRequest,
) -> anyhow::Result<CreatedWorktree> {
    tokio::task::spawn_blocking(move || create_git_worktree_sync(&request))
        .await
        .context("worktree creation task failed")?
}
pub(crate) async fn create_session(
    state: &AppState,
    request_id: Option<String>,
    cwd: Option<String>,
    name: Option<String>,
    args: Option<Vec<String>>,
    category: Option<String>,
    session_mode: SessionMode,
    worktree: Option<WorktreeCreateRequest>,
    proposed_model_id: Option<String>,
) -> Vec<ServerMessage> {
    let started_at = Instant::now();
    let category = match normalize_session_category(category) {
        Ok(category) => category,
        Err(message) => {
            return vec![ServerMessage::Error {
                request_id: request_id.clone(),
                message,
            }];
        }
    };
    let transport_id = Uuid::new_v4().to_string();
    let args = args.unwrap_or_default();
    let arg_count = args.len();
    let created_at = Timestamp::now();
    let requested_cwd = match normalize_optional_field(cwd) {
        Some(cwd) => cwd,
        None => state.default_cwd.read().await.clone(),
    };
    let mut session_worktree = None;
    let mut session_cwd = requested_cwd.clone();
    let mut default_cwd_to_save = requested_cwd;

    let proposed_model = match resolve_proposed_model_for_create(state, proposed_model_id).await {
        Ok(model) => model,
        Err(message) => {
            return vec![ServerMessage::Error {
                request_id,
                message,
            }];
        }
    };

    if let Some(worktree) = worktree {
        let worktree_started_at = Instant::now();
        default_cwd_to_save = worktree.source_repo.trim().to_string();
        let worktree_result = create_git_worktree(worktree).await;
        let worktree_ms = worktree_started_at.elapsed().as_millis() as u64;
        match worktree_result {
            Ok(created) => {
                info!(
                    action = "worktree.created",
                    transport_session_id = %transport_id,
                    source_repo_root = %created.source_repo_root.display(),
                    worktree_root = %created.worktree_root.display(),
                    session_cwd = %created.session_cwd.display()
                );
                session_cwd = created.session_cwd.to_string_lossy().into_owned();
                session_worktree = Some(SessionWorktreeSummary {
                    path: created.worktree_root.to_string_lossy().into_owned(),
                });
            }
            Err(error) => {
                warn!(transport_session_id = %transport_id, %error, "worktree creation failed");
                append_session_create_timing(
                    state,
                    "worktree_error",
                    &transport_id,
                    started_at,
                    Some(worktree_ms),
                    false,
                    arg_count,
                )
                .await;
                return vec![ServerMessage::Error {
                    request_id,
                    message: format!("worktree creation failed: {error}"),
                }];
            }
        }
    }

    let has_worktree = session_worktree.is_some();
    info!(
        action = "session.create",
        transport_session_id = %transport_id,
        cwd = %session_cwd,
        has_name = name.is_some(),
        has_worktree,
        arg_count,
    );

    state
        .session_runtime
        .register_pending_create(
            transport_id.clone(),
            PendingCreatedSession {
                cwd: Some(session_cwd.clone()),
                args: args.clone(),
                title: name.clone(),
                request_id: request_id.clone(),
                category: category.clone(),
                created_at,
                worktree: session_worktree,
                session_mode,
                proposed_model,
            },
        )
        .await;

    let spawn_started_at = Instant::now();
    if let Err(error) = spawn_rpc_child(
        state.clone(),
        transport_id.clone(),
        Some(session_cwd.clone()),
        args,
        None,
    )
    .await
    {
        append_session_create_timing(
            state,
            "spawn_error",
            &transport_id,
            started_at,
            None,
            has_worktree,
            arg_count,
        )
        .await;
        state
            .session_runtime
            .remove_pending_create(&transport_id)
            .await;
        error!(transport_session_id = %transport_id, %error, "failed to start RPC child");
        return vec![ServerMessage::Error {
            request_id,
            message: format!("failed to start RPC child: {error}"),
        }];
    }
    let spawn_ms = spawn_started_at.elapsed().as_millis() as u64;

    save_default_cwd(state, &default_cwd_to_save).await;
    append_session_create_timing(
        state,
        "spawned",
        &transport_id,
        started_at,
        Some(spawn_ms),
        has_worktree,
        arg_count,
    )
    .await;

    Vec::new()
}

async fn append_session_create_timing(
    state: &AppState,
    stage: &'static str,
    transport_id: &str,
    started_at: Instant,
    stage_ms: Option<u64>,
    has_worktree: bool,
    arg_count: usize,
) {
    let mut fields = Map::new();
    fields.insert("stage".to_string(), Value::String(stage.to_string()));
    fields.insert(
        "transportSessionId".to_string(),
        Value::String(transport_id.to_string()),
    );
    fields.insert(
        "durationMs".to_string(),
        Value::Number((started_at.elapsed().as_millis() as u64).into()),
    );
    if let Some(stage_ms) = stage_ms {
        fields.insert("stageMs".to_string(), Value::Number(stage_ms.into()));
    }
    fields.insert("hasWorktree".to_string(), Value::Bool(has_worktree));
    fields.insert(
        "argCount".to_string(),
        Value::Number((arg_count as u64).into()),
    );
    append_bridge_debug_event(state, "session.create_timing", fields).await;
}

async fn handle_plan_approve(
    state: &AppState,
    session_id: String,
    plan_file_path: String,
    final_plan_file_path: String,
    title: Option<String>,
    content: String,
    approval_mode: Option<PlanApprovalMode>,
) -> Vec<ServerMessage> {
    info!(action = "plan.approve", session_id = %session_id, bytes = content.len());
    let source_title = {
        let sessions = state.sessions.read().await;
        sessions
            .get(&session_id)
            .and_then(|record| record.title.clone())
            .or_else(|| title.clone())
            .unwrap_or_else(|| format!("Session {}", short_session_id(&session_id)))
    };
    let approval_mode = approval_mode.unwrap_or(PlanApprovalMode::Execute);
    let (preserve_context, compact_before_execute) = match approval_mode {
        PlanApprovalMode::Execute => (false, false),
        PlanApprovalMode::Compact => (true, true),
        PlanApprovalMode::Keep => (true, false),
    };
    let execution_title = format!("Execution - {source_title}");
    if !preserve_context {
        state
            .session_runtime
            .set_plan_execution_carryover(
                session_id.clone(),
                PlanExecutionCarryover {
                    execution_title: execution_title.clone(),
                    plan_title: title,
                    plan_file_path: plan_file_path.clone(),
                    final_plan_file_path: final_plan_file_path.clone(),
                    content,
                },
            )
            .await;
        state
            .session_runtime
            .set_pending_session_name(session_id.clone(), execution_title)
            .await;
    }
    let command = approve_plan_mode_command(
        next_rpc_id(),
        plan_file_path,
        final_plan_file_path,
        preserve_context,
        compact_before_execute,
    );
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => {
            state
                .events
                .mutate_session_snapshot(state, &session_id, |record| {
                    record.pending_plan_review = None;
                })
                .await;
            Vec::new()
        }
        Err(message) => vec![ServerMessage::Error {
            request_id: None,
            message,
        }],
    }
}

fn short_session_id(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

pub(crate) async fn set_session_category(
    state: &AppState,
    session_id: String,
    category: Option<String>,
) -> Vec<ServerMessage> {
    let category = match normalize_session_category(category) {
        Ok(category) => category,
        Err(message) => {
            return vec![ServerMessage::Error {
                request_id: None,
                message,
            }];
        }
    };

    info!(action = "session.set_category", session_id = %session_id, has_category = category.is_some());

    let category_for_record = category.clone();
    let sent = state
        .events
        .mutate_sessions_and_emit(state, |sessions| {
            let Some(record) = sessions.get_mut(&session_id) else {
                return Vec::new();
            };
            record.category = category_for_record;
            vec![
                ServerMessage::SessionSnapshot {
                    session_id: session_id.clone(),
                    state: record.projection(),
                },
                sessions_snapshot_from_map(sessions),
            ]
        })
        .await;
    if sent == 0 {
        return vec![unknown_session_error(session_id)];
    }

    state
        .session_runtime
        .set_session_category(session_id, category)
        .await;
    if let Err(error) = save_fura_config(state).await {
        warn!(%error, "failed to save session category");
    }

    Vec::new()
}

pub(crate) async fn set_client_config(
    state: &AppState,
    show_tools: Option<bool>,
    show_edit_diffs: Option<bool>,
    thinking_visibility: Option<ThinkingVisibilityPreference>,
    proposed_models: Option<Vec<ProposedModelConfig>>,
) -> Vec<ServerMessage> {
    if show_tools.is_none()
        && show_edit_diffs.is_none()
        && thinking_visibility.is_none()
        && proposed_models.is_none()
    {
        return vec![ServerMessage::Error {
            request_id: None,
            message:
                "config.set requires showTools, showEditDiffs, thinkingVisibility, or proposedModels"
                    .to_string(),
        }];
    }

    let proposed_models = proposed_models.map(normalize_proposed_models);
    if let Some(models) = proposed_models.as_ref() {
        if let Err(error) = validate_proposed_models(models) {
            return vec![ServerMessage::Error {
                request_id: None,
                message: error.to_string(),
            }];
        }
    }

    let previous_show_tools = *state.show_tools.read().await;
    let previous_show_edit_diffs = *state.show_edit_diffs.read().await;
    let previous_thinking_visibility = *state.thinking_visibility.read().await;
    let previous_proposed_models = state.proposed_models.read().await.clone();

    if let Some(value) = show_tools {
        *state.show_tools.write().await = value;
    }
    if let Some(value) = show_edit_diffs {
        *state.show_edit_diffs.write().await = value;
    }
    if let Some(value) = thinking_visibility {
        *state.thinking_visibility.write().await = value;
    }

    info!(
        action = "config.set",
        show_tools = show_tools.is_some(),
        show_edit_diffs = show_edit_diffs.is_some(),
        thinking_visibility = thinking_visibility.is_some(),
        proposed_models = proposed_models.is_some()
    );
    if let Some(models) = proposed_models {
        *state.proposed_models.write().await = models;
    }

    if let Err(error) = save_fura_config(state).await {
        *state.show_tools.write().await = previous_show_tools;
        *state.show_edit_diffs.write().await = previous_show_edit_diffs;
        *state.thinking_visibility.write().await = previous_thinking_visibility;
        *state.proposed_models.write().await = previous_proposed_models;
        return vec![ServerMessage::Error {
            request_id: None,
            message: error.to_string(),
        }];
    }
    broadcast_config(state).await;
    Vec::new()
}

fn preset_error(message: impl Into<String>) -> ServerMessage {
    ServerMessage::Error {
        request_id: None,
        message: message.into(),
    }
}

pub(crate) async fn handle_preset_save(
    state: &AppState,
    name: String,
    description: Option<String>,
    body: String,
    defaults: Option<BTreeMap<String, String>>,
) -> Vec<ServerMessage> {
    let Some(dir) = presets_dir(state.config_path.as_deref()) else {
        return vec![preset_error(
            "Presets directory is unavailable (no Fura config path)",
        )];
    };
    let description = description.unwrap_or_default();
    let defaults = defaults.unwrap_or_default();
    info!(action = "preset.save", name = %name, params = defaults.len());
    if let Err(error) = save_preset(&dir, &name, &description, &body, &defaults) {
        return vec![preset_error(error)];
    }
    broadcast_config(state).await;
    Vec::new()
}

pub(crate) async fn handle_preset_delete(state: &AppState, name: String) -> Vec<ServerMessage> {
    let Some(dir) = presets_dir(state.config_path.as_deref()) else {
        return vec![preset_error(
            "Presets directory is unavailable (no Fura config path)",
        )];
    };
    info!(action = "preset.delete", name = %name);
    if let Err(error) = delete_preset(&dir, &name) {
        return vec![preset_error(error)];
    }
    broadcast_config(state).await;
    Vec::new()
}

pub(crate) async fn handle_model_catalog_list_command(
    state: &AppState,
    request_id: Option<String>,
) -> Vec<ServerMessage> {
    let default_cwd = state.default_cwd.read().await.clone();
    let existing_transport = {
        let mut catalog = state.model_catalog.write().await;
        if catalog.in_flight {
            return vec![ServerMessage::Error {
                request_id,
                message: "Model catalog request already in progress".to_string(),
            }];
        }
        let existing = catalog
            .transport_session_id
            .clone()
            .filter(|transport_id| state.session_runtime.try_contains_transport(transport_id));
        if existing.is_none() {
            catalog.transport_session_id = None;
        }
        catalog.in_flight = true;
        catalog.in_flight_request_id = request_id.clone();
        existing
    };

    if let Some(transport_id) = existing_transport {
        if let Err(message) = send_rpc_command(
            state,
            &transport_id,
            get_available_models_command(next_rpc_id()),
        )
        .await
        {
            let mut catalog = state.model_catalog.write().await;
            catalog.in_flight = false;
            catalog.in_flight_request_id = None;
            catalog.transport_session_id = None;
            return vec![ServerMessage::Error {
                request_id,
                message,
            }];
        }
        return Vec::new();
    }

    let transport_id = Uuid::new_v4().to_string();
    {
        let mut catalog = state.model_catalog.write().await;
        catalog.transport_session_id = Some(transport_id.clone());
    }
    if let Err(error) = spawn_rpc_child(
        state.clone(),
        transport_id.clone(),
        Some(default_cwd),
        Vec::new(),
        None,
    )
    .await
    {
        let mut catalog = state.model_catalog.write().await;
        catalog.transport_session_id = None;
        catalog.in_flight = false;
        catalog.in_flight_request_id = None;
        return vec![ServerMessage::Error {
            request_id,
            message: format!("failed to start model catalog RPC child: {error}"),
        }];
    }
    Vec::new()
}

pub(crate) fn opened_session_record(
    discovered: &DiscoveredSession,
    session_file: String,
    category: Option<String>,
    existing: Option<&SessionRecord>,
) -> SessionRecord {
    SessionRecord {
        id: discovered.id.clone(),
        cwd: discovered.cwd.clone(),
        args: Vec::new(),
        status: SessionStatus::Starting,
        created_at: discovered.created_at,
        updated_at: discovered.updated_at,
        messages: existing
            .map(|record| record.messages.clone())
            .unwrap_or_default(),
        live_message_ids: HashSet::new(),
        streaming_message: None,
        is_compacting: false,
        continuation_pending: false,
        tool_cards: existing
            .map(|record| record.tool_cards.clone())
            .unwrap_or_default(),
        active_tool_calls: Vec::new(),
        todo_phases: existing.and_then(|record| record.todo_phases.clone()),
        session_file: Some(session_file),
        title: discovered
            .title
            .clone()
            .or_else(|| existing.and_then(|record| record.title.clone())),
        timestamp: discovered
            .timestamp
            .clone()
            .or_else(|| existing.and_then(|record| record.timestamp.clone())),
        category: category.or_else(|| existing.and_then(|record| record.category.clone())),
        worktree: existing.and_then(|record| record.worktree.clone()),
        session_mode: existing
            .map(|record| record.session_mode)
            .unwrap_or_default(),
        kind: SessionKind::Managed,
        model: existing.and_then(|record| record.model.clone()),
        thinking_level: existing.and_then(|record| record.thinking_level.clone()),
        tokens_total: existing.map(|record| record.tokens_total).unwrap_or(0),
        cost_usd: existing.map(|record| record.cost_usd).unwrap_or(0.0),
        context_tokens: existing.and_then(|record| record.context_tokens),
        context_window: existing.and_then(|record| record.context_window),
        context_percent: existing.and_then(|record| record.context_percent),
        plan_mode: existing.and_then(|record| record.plan_mode.clone()),
        goal_mode: existing.and_then(|record| record.goal_mode.clone()),
        pending_plan_review: existing.and_then(|record| record.pending_plan_review.clone()),
        pending_ask: None,
        available_commands: Vec::new(),
    }
}

pub(crate) async fn open_session(state: &AppState, session_file: String) -> Vec<ServerMessage> {
    info!(action = "session.open", session_file = %session_file);
    let session_path = PathBuf::from(&session_file);
    let Some(discovered) = read_session_header(&session_path) else {
        return vec![ServerMessage::Error {
            request_id: None,
            message: format!("could not read OMP session header: {session_file}"),
        }];
    };

    let session_id = discovered.id.clone();
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        if state
            .session_runtime
            .contains_transport(&transport_session_id)
            .await
        {
            if state
                .events
                .emit_current_session_snapshot(state, &session_id)
                .await
            {
                return Vec::new();
            }
            return vec![ServerMessage::Error {
                request_id: None,
                message: format!("session {session_id} is marked live but has no catalog entry"),
            }];
        }
    }

    let category = state.session_runtime.session_category(&session_id).await;
    {
        let mut sessions = state.sessions.write().await;
        let record = opened_session_record(
            &discovered,
            session_file.clone(),
            category,
            sessions.get(&session_id),
        );
        sessions.insert(session_id.clone(), record);
    }

    let transport_session_id = {
        if state.session_runtime.contains_transport(&session_id).await {
            Uuid::new_v4().to_string()
        } else {
            session_id.clone()
        }
    };

    let spawn_result = spawn_rpc_child(
        state.clone(),
        transport_session_id.clone(),
        discovered.cwd,
        Vec::new(),
        Some(session_file.clone()),
    )
    .await;

    if spawn_result.is_ok() {
        state
            .session_runtime
            .map_transport_to_session(&transport_session_id, session_id.clone())
            .await;
    }

    if let Err(error) = spawn_result {
        error!(session_id = %session_id, %error, "failed to open RPC session");
        state
            .events
            .mutate_sessions_and_emit(state, |sessions| {
                if let Some(record) = sessions.get_mut(&session_id) {
                    record.status = SessionStatus::Error;
                }
                vec![sessions_snapshot_from_map(sessions)]
            })
            .await;
        return vec![ServerMessage::Error {
            request_id: None,
            message: format!("failed to open session {session_file}: {error}"),
        }];
    }

    state
        .events
        .mutate_sessions_and_emit(state, |sessions| {
            let mut messages = vec![sessions_snapshot_from_map(sessions)];
            if let Some(record) = sessions.get(&session_id) {
                messages.push(ServerMessage::SessionSnapshot {
                    session_id: session_id.clone(),
                    state: record.projection(),
                });
            }
            messages
        })
        .await;
    Vec::new()
}

pub(crate) async fn stop_session(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    info!(action = "session.stop", session_id = %session_id);
    clear_review_contexts_for_session(state, &session_id).await;
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        if let Some(removed) = state
            .session_runtime
            .remove_transport(&transport_session_id)
            .await
        {
            let _ = removed.handle.stop.send(());
            fail_removed_btw_requests(
                state,
                removed.btw_requests,
                "The OMP session was stopped before the BTW request completed.",
            )
            .await;
            fail_removed_rewind_requests(
                state,
                removed.rewind_requests,
                "The OMP session was stopped before the rollback completed.",
            )
            .await;
            fail_removed_session_forks(
                state,
                removed.session_forks,
                "The OMP session was stopped before duplication completed.",
            )
            .await;
        }
    }

    let sent = state
        .events
        .mutate_sessions_and_emit(state, |sessions| {
            let Some(record) = sessions.get_mut(&session_id) else {
                return Vec::new();
            };
            record.status = SessionStatus::Exited;
            vec![
                ServerMessage::SessionSnapshot {
                    session_id: session_id.clone(),
                    state: record.projection(),
                },
                ServerMessage::SessionExited {
                    session_id: session_id.clone(),
                    code: None,
                    signal: Some("stopped".to_string()),
                },
                sessions_snapshot_from_map(sessions),
            ]
        })
        .await;
    if sent == 0 {
        vec![unknown_session_error(session_id)]
    } else {
        Vec::new()
    }
}

pub(crate) async fn delete_session(
    state: &AppState,
    session_id: String,
    delete_worktree: bool,
) -> Vec<ServerMessage> {
    info!(action = "session.delete", session_id = %session_id, delete_worktree);
    clear_review_contexts_for_session(state, &session_id).await;

    // Stop managed child if running.
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        if let Some(removed) = state
            .session_runtime
            .remove_transport(&transport_session_id)
            .await
        {
            let _ = removed.handle.stop.send(());
            fail_removed_btw_requests(
                state,
                removed.btw_requests,
                "The OMP session was deleted before the BTW request completed.",
            )
            .await;
            fail_removed_rewind_requests(
                state,
                removed.rewind_requests,
                "The OMP session was deleted before the rollback completed.",
            )
            .await;
            fail_removed_session_forks(
                state,
                removed.session_forks,
                "The OMP session was deleted before duplication completed.",
            )
            .await;
        }
    }

    // Grab paths before dropping from catalog.
    let (session_file, session_worktree) = {
        let sessions = state.sessions.read().await;
        let Some(record) = sessions.get(&session_id) else {
            return vec![unknown_session_error(session_id)];
        };
        (record.session_file.clone(), record.worktree.clone())
    };

    if delete_worktree && session_worktree.is_none() {
        return vec![ServerMessage::Error {
            request_id: None,
            message: "session delete requested worktree deletion, but this session has no Fura-managed worktree"
                .to_string(),
        }];
    }

    // Drop from catalog.
    state.sessions.write().await.remove(&session_id);

    // Delete session file and sibling artifacts directory.
    if let Some(ref file) = session_file {
        match fs::remove_file(file) {
            Ok(()) => {
                info!(session_id = %session_id, file = %file, "deleted session file");
            }
            Err(error) => {
                warn!(session_id = %session_id, file = %file, %error, "failed to delete session file")
            }
        }
        if let Some(artifacts) = file.strip_suffix(".jsonl") {
            match fs::remove_dir_all(artifacts) {
                Ok(()) => {
                    info!(session_id = %session_id, dir = %artifacts, "deleted session artifacts")
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    warn!(session_id = %session_id, dir = %artifacts, %error, "failed to delete artifacts directory")
                }
            }
        }
    }

    let mut responses = Vec::new();
    if delete_worktree {
        let worktree_path = session_worktree.expect("checked before deletion").path;
        let worktree_path_for_log = worktree_path.clone();
        match tokio::task::spawn_blocking(move || {
            delete_git_worktree_sync(Path::new(&worktree_path))
        })
        .await
        .context("worktree deletion task failed")
        .and_then(|result| result)
        {
            Ok(()) => {
                info!(session_id = %session_id, cwd = %worktree_path_for_log, "deleted session worktree")
            }
            Err(error) => {
                warn!(session_id = %session_id, cwd = %worktree_path_for_log, %error, "failed to delete session worktree");
                responses.push(ServerMessage::Error {
                    request_id: None,
                    message: format!(
                        "session was deleted, but worktree deletion failed for {worktree_path_for_log}: {error}"
                    ),
                });
            }
        }
    }

    broadcast_sessions_snapshot(state).await;
    responses
}

pub(crate) async fn handle_slash_command(
    state: &AppState,
    session_id: String,
    text: &str,
) -> Option<Vec<ServerMessage>> {
    let (name, args) = parse_slash_command(text)?;
    let args = args.trim();

    let responses = match name.as_str() {
        "help" | "commands" => vec![notice(
            session_id,
            NoticeLevel::Info,
            "Supported commands: /help, /new (alias /clear), /abort, /plan [prompt], /compact [instructions], /handoff [focus instructions], /rename <title>, /model [list|cycle|provider/model], /thinking [cycle|off|minimal|low|medium|high|xhigh|max|inherit], /fork, /rebase <branch>, /session [info]. Server-side OMP slash commands like /export, /tools, /fast, /browser, /dump, and /share are forwarded to OMP.",
        )],
        "new" | "clear" => {
            let (cwd, args) = {
                let sessions = state.sessions.read().await;
                sessions
                    .get(&session_id)
                    .map(|record| (record.cwd.clone(), Some(record.args.clone())))
                    .unwrap_or((None, None))
            };
            create_session(
                state,
                None,
                cwd,
                None,
                args,
                None,
                SessionMode::Standard,
                None,
                None,
            )
            .await
        }
        "abort" => abort_prompt(state, session_id).await,
        "handoff" => {
            let mut command = serde_json::json!({ "id": next_rpc_id(), "type": "handoff" });
            if !args.is_empty() {
                command["customInstructions"] = Value::String(args.to_string());
            }
            send_slash_rpc_command(state, session_id, command, "Requested session handoff.").await
        }
        "rename" => {
            if args.is_empty() {
                vec![notice(
                    session_id,
                    NoticeLevel::Error,
                    "Usage: /rename <title>",
                )]
            } else {
                let new_title = args.to_string();
                match send_rpc_command(
                    state,
                    &session_id,
                    set_session_name_command(next_rpc_id(), new_title.clone()),
                )
                .await
                {
                    Err(err) => vec![notice(session_id, NoticeLevel::Error, err)],
                    Ok(()) => {
                        // OMP returns only a success ack — it does not echo the name back.
                        // Update our projection directly since we already know the new title.
                        state
                            .events
                            .mutate_session_snapshot(state, &session_id, |record| {
                                record.title = Some(new_title);
                            })
                            .await;
                        broadcast_sessions_snapshot(state).await;
                        vec![notice(session_id, NoticeLevel::Info, "Session renamed.")]
                    }
                }
            }
        }
        "plan" => handle_plan_slash_command(state, session_id, args).await,
        "goal" => vec![notice(
            session_id,
            NoticeLevel::Warning,
            "Goal Mode is controlled from the Goal card in Fura.",
        )],
        "model" | "models" => handle_model_slash_command(state, session_id, args).await,
        "thinking" => handle_thinking_slash_command(state, session_id, args).await,
        "fork" => handle_fork_slash_command(state, session_id).await,
        "rebase" => handle_rebase_slash_command(state, session_id, args).await,
        "session" | "status" | "usage" => {
            send_slash_rpc_command(
                state,
                session_id,
                get_session_stats_command(next_rpc_id()),
                "Requested session stats.",
            )
            .await
        }
        // Genuinely TUI-only / interactive commands (no server-side `handle` in OMP): a notice.
        // `handle`-bearing builtins (tools, context, jobs, stats, changelog, fast, browser, dump,
        // share, …) intentionally fall through below to OMP, which runs them server-side in the
        // prompt handler and streams the result back as a `command_output` frame.
        "settings" | "copy" | "hotkeys" | "extensions" | "agents" | "branch" | "tree" | "login"
        | "logout" | "mcp" | "ssh" | "resume" | "btw" | "background" | "bg" | "debug"
        | "memory" | "move" | "exit" | "quit" | "q" | "marketplace" | "plugins"
        | "reload-plugins" | "force" | "vibe" | "queue" | "pause" => vec![notice(
            session_id,
            NoticeLevel::Warning,
            format!(
                "/{name} is a TUI-only command or needs a dedicated Fura UI before it can be safely supported."
            ),
        )],
        _ => return None,
    };

    Some(responses)
}

fn copy_name_parts(title: &str) -> (&str, u64) {
    let title = title.trim();
    if let Some((base, suffix)) = title.rsplit_once(" copy ")
        && let Ok(number) = suffix.parse::<u64>()
        && (2..u64::MAX).contains(&number)
        && !base.trim().is_empty()
    {
        return (base.trim(), number + 1);
    }
    (title, 2)
}

async fn next_session_copy_name(state: &AppState, session_id: &str) -> String {
    let sessions = state.sessions.read().await;
    let source_title = sessions
        .get(session_id)
        .and_then(|record| record.title.as_deref())
        .unwrap_or("Untitled session");
    let (base, start) = copy_name_parts(source_title);
    let base = if base.is_empty() {
        "Untitled session"
    } else {
        base
    };
    let existing = sessions
        .values()
        .filter_map(|record| record.title.as_deref())
        .map(|title| title.trim().to_lowercase())
        .collect::<HashSet<_>>();
    let mut number = start;
    loop {
        let candidate = format!("{base} copy {number}");
        if !existing.contains(&candidate.to_lowercase()) {
            return candidate;
        }
        number += 1;
    }
}

pub(crate) async fn handle_session_fork(
    state: &AppState,
    session_id: String,
    request_id: String,
    owner_connection_id: u64,
) -> Vec<ServerMessage> {
    let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await else {
        return vec![session_fork_error(
            Some(owner_connection_id),
            request_id,
            session_id,
            "Session is not attached to an active OMP process.",
        )];
    };
    let name = next_session_copy_name(state, &session_id).await;
    let command_id = next_rpc_id();
    let pending = PendingSessionFork {
        target_connection_id: Some(owner_connection_id),
        request_id: request_id.clone(),
        source_session_id: session_id.clone(),
        transport_session_id: transport_session_id.clone(),
        name,
        awaiting_state: false,
    };
    if !state
        .session_runtime
        .insert_pending_session_fork(command_id.clone(), pending)
        .await
    {
        return vec![session_fork_error(
            Some(owner_connection_id),
            request_id,
            session_id,
            "A duplicate request is already in progress for this session.",
        )];
    }
    match send_rpc_command(
        state,
        &transport_session_id,
        fork_command(command_id.clone()),
    )
    .await
    {
        Ok(()) => Vec::new(),
        Err(message) => {
            state
                .session_runtime
                .take_pending_session_fork(&command_id)
                .await;
            vec![session_fork_error(
                Some(owner_connection_id),
                request_id,
                session_id,
                message,
            )]
        }
    }
}

pub(crate) async fn handle_session_handoff(
    state: &AppState,
    session_id: String,
    name: String,
    custom_instructions: Option<String>,
) -> Vec<ServerMessage> {
    state
        .session_runtime
        .set_pending_session_name(session_id.clone(), name)
        .await;
    let mut command = serde_json::json!({ "id": next_rpc_id(), "type": "handoff" });
    if let Some(instructions) = custom_instructions {
        command["customInstructions"] = Value::String(instructions);
    }
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

pub(crate) async fn handle_plan_slash_command(
    state: &AppState,
    session_id: String,
    args: &str,
) -> Vec<ServerMessage> {
    let enabled = {
        let sessions = state.sessions.read().await;
        sessions
            .get(&session_id)
            .and_then(|record| record.plan_mode.as_ref())
            .is_some_and(|plan_mode| plan_mode.enabled)
    };

    if enabled {
        let command = set_plan_mode_command(next_rpc_id(), false, None, None);
        return send_slash_rpc_command(state, session_id, command, "Requested plan mode exit.")
            .await;
    }

    let command = set_plan_mode_command(
        next_rpc_id(),
        true,
        Some("local://PLAN.md".to_string()),
        Some("parallel".to_string()),
    );
    if let Err(message) = send_rpc_command(state, &session_id, command).await {
        return vec![notice(session_id, NoticeLevel::Error, message)];
    }

    if args.is_empty() {
        return vec![notice(
            session_id,
            NoticeLevel::Info,
            "Requested plan mode. Plan file: local://PLAN.md",
        )];
    }

    let prompt_command = prompt_command(
        next_rpc_id(),
        args.to_string(),
        None,
        Some(PromptBehavior::FollowUp),
    );
    match send_rpc_command(state, &session_id, prompt_command).await {
        Ok(()) => vec![notice(
            session_id,
            NoticeLevel::Info,
            "Requested plan mode and sent the initial planning prompt.",
        )],
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

pub(crate) async fn handle_fork_slash_command(
    state: &AppState,
    session_id: String,
) -> Vec<ServerMessage> {
    match send_rpc_command(state, &session_id, fork_command(next_rpc_id())).await {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

pub(crate) async fn handle_rebase_slash_command(
    state: &AppState,
    session_id: String,
    args: &str,
) -> Vec<ServerMessage> {
    let mut tokens = args.split_whitespace();
    let branch = tokens.next().unwrap_or("");
    // A destructive command must not silently drop extra arguments (e.g. `/rebase main --onto x`
    // would otherwise rewrite history onto `main` and ignore the rest).
    if branch.is_empty() || tokens.next().is_some() {
        return vec![notice(
            session_id,
            NoticeLevel::Error,
            "Usage: /rebase <branch> (exactly one branch or ref, no extra arguments)",
        )];
    }
    let cwd = {
        let sessions = state.sessions.read().await;
        let Some(record) = sessions.get(&session_id) else {
            return vec![unknown_session_error(session_id)];
        };
        // Busy guard, not a lock: we check status once and run the rebase on the live cwd
        // without quiescing the OMP child. A prompt arriving on another client mid-rebase could
        // edit the worktree, and an abort would then discard those edits. This residual race is
        // accepted (single-operator local tool; sub-second window; conflict required) rather than
        // adding a cross-cutting rebase-in-progress dispatch lock. Revisit if /rebase grows.
        if record.has_active_work_artifacts()
            || matches!(
                record.effective_status(),
                SessionStatus::Busy | SessionStatus::Starting
            )
        {
            return vec![notice(
                session_id,
                NoticeLevel::Error,
                "Session is busy — wait for the agent to finish before rebasing.",
            )];
        }
        match record.cwd.clone() {
            Some(cwd) => cwd,
            None => {
                return vec![notice(
                    session_id,
                    NoticeLevel::Error,
                    "Session has no working directory to rebase.",
                )];
            }
        }
    };
    match crate::diff::rebase_session_repo(&cwd, branch).await {
        Ok(_) => vec![notice(
            session_id,
            NoticeLevel::Info,
            format!("Rebased onto '{branch}'."),
        )],
        Err(error) => vec![notice(
            session_id,
            NoticeLevel::Error,
            format!("Rebase onto '{branch}' failed: {error}"),
        )],
    }
}

pub(crate) async fn handle_model_slash_command(
    state: &AppState,
    session_id: String,
    args: &str,
) -> Vec<ServerMessage> {
    let arg = args.trim();
    match arg {
        "" | "list" | "ls" => handle_model_list_command(state, session_id).await,
        "cycle" | "next" => {
            send_slash_rpc_command(
                state,
                session_id,
                serde_json::json!({ "id": next_rpc_id(), "type": "cycle_model" }),
                "Requested model cycle.",
            )
            .await
        }
        _ => {
            let Some((provider, model_id)) = arg.split_once('/') else {
                return vec![notice(
                    session_id,
                    NoticeLevel::Error,
                    "Usage: /model [list|cycle|provider/model]",
                )];
            };
            if provider.is_empty() || model_id.is_empty() {
                return vec![notice(
                    session_id,
                    NoticeLevel::Error,
                    "Usage: /model [list|cycle|provider/model]",
                )];
            }
            handle_model_set_command(state, session_id, provider, model_id).await
        }
    }
}

pub(crate) async fn handle_goal_start(
    state: &AppState,
    session_id: String,
    objective: String,
    token_budget: Option<u64>,
) -> Vec<ServerMessage> {
    let objective = objective.trim().to_string();
    if objective.is_empty() {
        return vec![notice(
            session_id,
            NoticeLevel::Error,
            "Goal objective cannot be empty.",
        )];
    }
    if token_budget == Some(0) {
        return vec![notice(
            session_id,
            NoticeLevel::Error,
            "Goal budget must be a positive integer.",
        )];
    }
    send_goal_rpc_command(
        state,
        session_id,
        goal_mode_command(next_rpc_id(), "create", Some(objective), token_budget),
    )
    .await
}

pub(crate) async fn handle_goal_control(
    state: &AppState,
    session_id: String,
    action: GoalControlAction,
) -> Vec<ServerMessage> {
    let op = match action {
        GoalControlAction::Pause => "pause",
        GoalControlAction::Resume => "resume",
        GoalControlAction::Drop => "drop",
    };
    send_goal_rpc_command(
        state,
        session_id,
        goal_mode_command(next_rpc_id(), op, None, None),
    )
    .await
}

pub(crate) async fn handle_goal_set_budget(
    state: &AppState,
    session_id: String,
    token_budget: Option<u64>,
) -> Vec<ServerMessage> {
    if token_budget == Some(0) {
        return vec![notice(
            session_id,
            NoticeLevel::Error,
            "Goal budget must be a positive integer.",
        )];
    }
    send_goal_rpc_command(
        state,
        session_id,
        goal_mode_command(next_rpc_id(), "set_budget", None, token_budget),
    )
    .await
}

async fn send_goal_rpc_command(
    state: &AppState,
    session_id: String,
    command: Value,
) -> Vec<ServerMessage> {
    info!(action = "goal.command", session_id = %session_id, command_type = command_type(&command));
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

pub(crate) async fn handle_model_list_command(
    state: &AppState,
    session_id: String,
) -> Vec<ServerMessage> {
    match send_rpc_command(
        state,
        &session_id,
        get_available_models_command(next_rpc_id()),
    )
    .await
    {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

pub(crate) async fn handle_model_set_command(
    state: &AppState,
    session_id: String,
    provider: &str,
    model_id: &str,
) -> Vec<ServerMessage> {
    match send_rpc_command(
        state,
        &session_id,
        set_model_command(next_rpc_id(), provider.to_string(), model_id.to_string()),
    )
    .await
    {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

pub(crate) async fn handle_thinking_slash_command(
    state: &AppState,
    session_id: String,
    args: &str,
) -> Vec<ServerMessage> {
    let arg = args.trim().to_lowercase();
    if arg.is_empty() || arg == "cycle" || arg == "next" {
        return send_slash_rpc_command(
            state,
            session_id,
            serde_json::json!({ "id": next_rpc_id(), "type": "cycle_thinking_level" }),
            "Requested thinking level cycle.",
        )
        .await;
    }

    let level = match arg.as_str() {
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "inherit" => arg,
        _ => {
            return vec![notice(
                session_id,
                NoticeLevel::Error,
                "Usage: /thinking [cycle|off|minimal|low|medium|high|xhigh|max|inherit]",
            )];
        }
    };

    send_slash_rpc_command(
        state,
        session_id,
        set_thinking_level_command(next_rpc_id(), level),
        "Requested thinking level change.",
    )
    .await
}

pub(crate) async fn send_slash_rpc_command(
    state: &AppState,
    session_id: String,
    command: Value,
    ok_text: &'static str,
) -> Vec<ServerMessage> {
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => vec![notice(session_id, NoticeLevel::Info, ok_text)],
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
    }
}

/// Sets the session's transient compaction flag and pushes the updated snapshot to clients
/// (active-session view) plus the session list, so the UI can show a clear "compacting" state.
/// The flag is otherwise reconciled from `get_state.isCompacting`.
pub(crate) async fn set_session_compacting(state: &AppState, session_id: &str, compacting: bool) {
    let snapshot_sent = state
        .events
        .mutate_session_snapshot(state, session_id, |record| {
            record.is_compacting = compacting;
        })
        .await;
    if snapshot_sent {
        broadcast_sessions_snapshot(state).await;
    }
}

pub(crate) fn parse_slash_command(text: &str) -> Option<(String, String)> {
    let body = text.strip_prefix('/')?.trim();
    if body.is_empty() {
        return None;
    }

    let first_whitespace = body.find(char::is_whitespace);
    let first_colon = body.find(':');
    let first_separator = match (first_whitespace, first_colon) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(index), None) | (None, Some(index)) => Some(index),
        (None, None) => None,
    };

    match first_separator {
        Some(index) => Some((
            body[..index].to_lowercase(),
            body[index + 1..].trim().to_string(),
        )),
        None => Some((body.to_lowercase(), String::new())),
    }
}

pub(crate) fn notice(
    session_id: impl Into<String>,
    level: NoticeLevel,
    text: impl Into<String>,
) -> ServerMessage {
    ServerMessage::SessionNotice {
        session_id: session_id.into(),
        level,
        text: text.into(),
    }
}

pub(crate) async fn send_prompt(
    state: &AppState,
    session_id: String,
    text: String,
    images: Option<Vec<PromptImagePayload>>,
    behavior: Option<PromptBehavior>,
) -> Vec<ServerMessage> {
    info!(action = "prompt.send", session_id = %session_id, bytes = text.len(), has_images = images.as_ref().is_some_and(|images| !images.is_empty()), behavior = ?behavior.map(PromptBehavior::as_rpc_streaming_behavior));

    let has_images = images.as_ref().is_some_and(|images| !images.is_empty());
    if behavior.is_none() && !has_images {
        if let Some(responses) = handle_slash_command(state, session_id.clone(), text.trim()).await
        {
            return responses;
        }
    }

    let suppress_optimistic_prompt =
        behavior.is_none() && !has_images && parse_slash_command(text.trim()).is_some();
    let is_compaction_command = behavior.is_none()
        && !has_images
        && parse_slash_command(text.trim()).is_some_and(|(name, _args)| name == "compact");

    if !state.sessions.read().await.contains_key(&session_id) {
        return vec![unknown_session_error(session_id)];
    }

    if !has_live_rpc_child(state, &session_id).await {
        return vec![ServerMessage::Error {
            request_id: None,
            message: format!("session {session_id} has no live RPC child"),
        }];
    }

    let command_id = next_rpc_id();
    let optimistic_message_id = format!("__pending_prompt:{command_id}");
    let command_images = images.filter(|images| !images.is_empty());

    let command_notice_message_id = format!("__command_notice:{command_id}");
    if is_compaction_command {
        set_session_compacting(state, &session_id, true).await;
    }

    if suppress_optimistic_prompt {
        let snapshot_sent = state
            .events
            .mutate_session_snapshot(state, &session_id, |record| {
                record.messages.push(command_notice_message(
                    command_notice_message_id.clone(),
                    text.clone(),
                ));
                record.updated_at = Timestamp::now();
            })
            .await;

        if !snapshot_sent {
            return vec![unknown_session_error(session_id)];
        }
    } else {
        let snapshot_sent = state
            .events
            .mutate_session_snapshot(state, &session_id, |record| {
                record.status = SessionStatus::Busy;
                record.messages.push(optimistic_prompt_message(
                    optimistic_message_id.clone(),
                    text.clone(),
                    command_images.as_ref(),
                ));
                record.updated_at = Timestamp::now();
            })
            .await;

        if !snapshot_sent {
            return vec![unknown_session_error(session_id)];
        }

        if behavior.is_none() {
            state.pending_prompt_drafts.write().await.insert(
                command_id.clone(),
                PendingPromptDraft {
                    session_id: session_id.clone(),
                    text: text.clone(),
                    images: command_images.clone(),
                    optimistic_message_id: optimistic_message_id.clone(),
                },
            );
        }
    }

    if is_compaction_command {
        state
            .session_runtime
            .insert_pending_compaction_command(command_id.clone(), session_id.clone())
            .await;
    }

    let command = prompt_command(command_id.clone(), text, command_images, behavior);

    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => Vec::new(),
        Err(message) => {
            state
                .pending_prompt_drafts
                .write()
                .await
                .remove(&command_id);
            let pending_compaction = state
                .session_runtime
                .take_pending_compaction_command(&command_id)
                .await
                .is_some();
            if suppress_optimistic_prompt {
                remove_optimistic_prompt_message(state, &session_id, &command_notice_message_id)
                    .await;
            } else {
                remove_optimistic_prompt_message(state, &session_id, &optimistic_message_id).await;
            }
            if pending_compaction {
                set_session_compacting(state, &session_id, false).await;
            }
            vec![ServerMessage::Error {
                request_id: None,
                message,
            }]
        }
    }
}

fn command_notice_message(id: String, text: String) -> TranscriptMessage {
    TranscriptMessage::new(
        id,
        MessageRole::System,
        vec![ContentBlock::Text {
            text: format!("Command requested: {}", text.trim()),
        }],
        Some(Timestamp::now()),
        true,
    )
}

fn optimistic_prompt_message(
    id: String,
    text: String,
    images: Option<&Vec<PromptImagePayload>>,
) -> TranscriptMessage {
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(ContentBlock::Text { text });
    }
    if let Some(images) = images {
        for image in images {
            let data = image.data.clone();
            let mime_type = image.mime_type.clone();
            if !data.is_empty() {
                blocks.push(ContentBlock::Image {
                    data,
                    mime_type,
                    alt: None,
                });
            }
        }
    }
    TranscriptMessage::new(id, MessageRole::User, blocks, Some(Timestamp::now()), true)
}

pub(crate) async fn remove_optimistic_prompt_message(
    state: &AppState,
    session_id: &str,
    optimistic_message_id: &str,
) -> bool {
    state
        .events
        .mutate_session_and_emit(state, session_id, |record| {
            let before = record.messages.len();
            record
                .messages
                .retain(|message| message.id != optimistic_message_id);
            if record.messages.len() == before {
                return None;
            }
            Some(ServerMessage::SessionSnapshot {
                session_id: session_id.to_string(),
                state: record.projection(),
            })
        })
        .await
}

pub(crate) async fn handle_review_comments_list(
    state: &AppState,
    session_id: String,
    comparison_key: Option<String>,
) -> Vec<ServerMessage> {
    debug!(
        action = "review.comments.list",
        session_id = %session_id,
        comparison_key = ?comparison_key,
        db_path = %state.review_comment_db_path.display()
    );
    match list_comments(
        &state.review_comment_db_path,
        &session_id,
        comparison_key.as_deref(),
    ) {
        Ok(comments) => {
            debug!(
                action = "review.comments.list.ok",
                session_id = %session_id,
                comparison_key = ?comparison_key,
                comment_count = comments.len()
            );
            vec![ServerMessage::ReviewCommentsSnapshot {
                session_id,
                comments,
            }]
        }
        Err(message) => {
            debug!(
                action = "review.comments.list.err",
                session_id = %session_id,
                comparison_key = ?comparison_key,
                error = %message
            );
            vec![ServerMessage::Error {
                request_id: None,
                message,
            }]
        }
    }
}

async fn create_review_comment_with_author(
    state: &AppState,
    session_id: String,
    repo_root: String,
    comparison_key: String,
    author: ReviewCommentAuthor,
    anchor: DiffLineLocation,
    body: String,
) -> Result<ReviewComment, String> {
    if !state.sessions.read().await.contains_key(&session_id) {
        return Err(format!("unknown session: {session_id}"));
    }
    debug!(
        action = "review.comment.create",
        session_id = %session_id,
        repo_root = %repo_root,
        comparison_key = %comparison_key,
        author = %author.as_str(),
        new_path = %anchor.new_path,
        side = ?anchor.side,
        old_line = ?anchor.old_line,
        new_line = ?anchor.new_line,
        body_chars = body.chars().count(),
        db_path = %state.review_comment_db_path.display()
    );
    let result = create_comment(
        &state.review_comment_db_path,
        NewReviewComment {
            session_id: session_id.clone(),
            repo_root,
            comparison_key: comparison_key.clone(),
            author,
            body,
            anchor,
            stale: false,
            stale_reason: None,
        },
    );
    match result {
        Ok(comment) => {
            debug!(
                action = "review.comment.create.ok",
                session_id = %comment.session_id,
                comment_id = %comment.id,
                comparison_key = %comment.comparison_key,
                author = %comment.author.as_str()
            );
            let _ = state
                .events
                .emit(
                    state,
                    ServerMessage::ReviewCommentUpserted {
                        comment: comment.clone(),
                    },
                )
                .await;
            Ok(comment)
        }
        Err(message) => {
            debug!(
                action = "review.comment.create.err",
                session_id = %session_id,
                comparison_key = %comparison_key,
                author = %author.as_str(),
                error = %message
            );
            Err(message)
        }
    }
}

pub(crate) async fn handle_review_comment_create(
    state: &AppState,
    session_id: String,
    repo_root: String,
    comparison_key: String,
    anchor: DiffLineLocation,
    body: String,
) -> Vec<ServerMessage> {
    match create_review_comment_with_author(
        state,
        session_id,
        repo_root,
        comparison_key,
        ReviewCommentAuthor::User,
        anchor,
        body,
    )
    .await
    {
        Ok(_) => Vec::new(),
        Err(message) => vec![ServerMessage::Error {
            request_id: None,
            message,
        }],
    }
}

pub(crate) async fn handle_review_comment_update(
    state: &AppState,
    id: String,
    body: String,
) -> Vec<ServerMessage> {
    debug!(
        action = "review.comment.update",
        comment_id = %id,
        body_chars = body.chars().count(),
        db_path = %state.review_comment_db_path.display()
    );
    match update_comment(&state.review_comment_db_path, &id, body) {
        Ok(comment) => {
            debug!(
                action = "review.comment.update.ok",
                session_id = %comment.session_id,
                comment_id = %comment.id
            );
            let _ = state
                .events
                .emit(state, ServerMessage::ReviewCommentUpserted { comment })
                .await;
            Vec::new()
        }
        Err(message) => {
            debug!(action = "review.comment.update.err", comment_id = %id, error = %message);
            vec![ServerMessage::Error {
                request_id: None,
                message,
            }]
        }
    }
}

pub(crate) async fn handle_review_comment_mark_flushed(
    state: &AppState,
    comments: Vec<ReviewCommentFlushMarker>,
) -> Vec<ServerMessage> {
    debug!(
        action = "review.comment.mark_flushed",
        count = comments.len(),
        db_path = %state.review_comment_db_path.display()
    );
    match mark_comments_flushed(&state.review_comment_db_path, &comments) {
        Ok(comments) => {
            for comment in comments {
                let _ = state
                    .events
                    .emit(state, ServerMessage::ReviewCommentUpserted { comment })
                    .await;
            }
            Vec::new()
        }
        Err(message) => {
            debug!(action = "review.comment.mark_flushed.err", error = %message);
            vec![ServerMessage::Error {
                request_id: None,
                message,
            }]
        }
    }
}

pub(crate) async fn handle_review_comment_delete(
    state: &AppState,
    id: String,
) -> Vec<ServerMessage> {
    debug!(
        action = "review.comment.delete",
        comment_id = %id,
        db_path = %state.review_comment_db_path.display()
    );
    match delete_comment(&state.review_comment_db_path, &id) {
        Ok((session_id, comparison_key)) => {
            debug!(
                action = "review.comment.delete.ok",
                session_id = %session_id,
                comment_id = %id,
                comparison_key = %comparison_key
            );
            let _ = state
                .events
                .emit(
                    state,
                    ServerMessage::ReviewCommentDeleted {
                        session_id,
                        comparison_key,
                        id,
                    },
                )
                .await;
            Vec::new()
        }
        Err(message) => {
            debug!(action = "review.comment.delete.err", comment_id = %id, error = %message);
            vec![ServerMessage::Error {
                request_id: None,
                message,
            }]
        }
    }
}

pub(crate) async fn handle_review_agent_review_start(
    state: &AppState,
    session_id: String,
    review_state: DiffReviewableState,
    instructions: String,
) -> Vec<ServerMessage> {
    let patch_override = review_state
        .patch
        .clone()
        .filter(|patch| !patch.trim().is_empty());
    {
        let mut sessions = state.sessions.write().await;
        let Some(record) = sessions.get_mut(&session_id) else {
            return vec![unknown_session_error(session_id)];
        };
        if record.has_active_work_artifacts()
            || matches!(
                record.effective_status(),
                SessionStatus::Starting | SessionStatus::Busy
            )
        {
            return vec![ServerMessage::Error {
                request_id: None,
                message: "Cannot start agent diff review while the session is busy.".to_string(),
            }];
        }
        record.status = SessionStatus::Busy;
    }
    let context_id = uuid::Uuid::new_v4().to_string();
    let previous_host_tools = state
        .session_host_tools
        .read()
        .await
        .get(&session_id)
        .cloned()
        .unwrap_or_default();
    let next_host_tools = review_host_tools_with_comment_tool(&previous_host_tools);
    let set_host_tools_command_id = next_rpc_id();
    let prompt_command_id = next_rpc_id();
    let context = ActiveReviewContext {
        id: context_id.clone(),
        session_id: session_id.clone(),
        repo_root: review_state.comparison.repo_root.clone(),
        comparison_key: review_state.comparison.comparison_key.clone(),
        left_tree_or_commit: review_state.comparison.left_tree_or_commit.clone(),
        right_tree_or_commit: review_state.comparison.right_tree_or_commit.clone(),
        patch_override,

        previous_host_tools: previous_host_tools.clone(),
        set_host_tools_command_id: set_host_tools_command_id.clone(),
        prompt_command_id: prompt_command_id.clone(),
    };
    state
        .active_review_contexts
        .write()
        .await
        .insert(context_id.clone(), context);

    let setup_result = async {
        send_rpc_command(
            state,
            &session_id,
            review_set_host_tools_command(set_host_tools_command_id, next_host_tools.clone()),
        )
        .await?;
        send_rpc_command(
            state,
            &session_id,
            prompt_command(
                prompt_command_id,
                review_prompt(&context_id, &review_state, &instructions),
                None,
                None,
            ),
        )
        .await
    }
    .await;

    match setup_result {
        Ok(()) => {
            remember_session_host_tools(state, &session_id, next_host_tools).await;
            Vec::new()
        }
        Err(message) => {
            state
                .active_review_contexts
                .write()
                .await
                .remove(&context_id);
            remember_session_host_tools(state, &session_id, previous_host_tools).await;
            if let Some(record) = state.sessions.write().await.get_mut(&session_id) {
                record.status = SessionStatus::Idle;
            }
            vec![ServerMessage::Error {
                request_id: None,
                message,
            }]
        }
    }
}

pub(crate) async fn remove_review_contexts_for_session(
    state: &AppState,
    session_id: &str,
) -> Vec<ActiveReviewContext> {
    let mut contexts = state.active_review_contexts.write().await;
    let mut removed = Vec::new();
    contexts.retain(|_, context| {
        if context.session_id == session_id {
            removed.push(context.clone());
            false
        } else {
            true
        }
    });
    removed
}

pub(crate) async fn clear_review_contexts_for_session(state: &AppState, session_id: &str) {
    let removed = remove_review_contexts_for_session(state, session_id).await;
    if let Some(context) = removed.into_iter().last() {
        restore_session_host_tools(state, session_id, context.previous_host_tools).await;
    }
}

pub(crate) async fn clear_review_context_for_command(
    state: &AppState,
    session_id: &str,
    command_id: &str,
) -> bool {
    let mut contexts = state.active_review_contexts.write().await;
    let mut restored_tools: Option<Vec<Value>> = None;
    contexts.retain(|_, context| {
        let matches_session = context.session_id == session_id;
        let matches_command = context.set_host_tools_command_id == command_id
            || context.prompt_command_id == command_id;
        if matches_session && matches_command {
            restored_tools = Some(context.previous_host_tools.clone());
            false
        } else {
            true
        }
    });
    drop(contexts);
    if let Some(previous_host_tools) = restored_tools {
        restore_session_host_tools(state, session_id, previous_host_tools).await;
        return true;
    }
    false
}

pub(crate) async fn handle_session_host_tool_call(
    state: &AppState,
    transport_session_id: &str,
    frame_id: String,
    tool_call_id: String,
    tool_name: String,
    arguments: Value,
) {
    let result = match dispatch_session_host_tool(
        state,
        transport_session_id,
        &tool_name,
        arguments,
    )
    .await
    {
        Ok(text) => review_host_tool_result_frame(frame_id, text, false),
        Err(message) => review_host_tool_result_frame(frame_id, message, true),
    };
    if let Err(message) = send_rpc_command(state, transport_session_id, result).await {
        warn!(tool_call_id = %tool_call_id, tool_name = %tool_name, %message, "failed to send session host tool result");
    }
}

pub(crate) async fn handle_session_host_tool_cancel(
    state: &AppState,
    transport_session_id: &str,
    frame_id: String,
    target_id: String,
) {
    let has_review_context = state
        .active_review_contexts
        .read()
        .await
        .values()
        .any(|context| context.session_id == transport_session_id);
    debug!(
        transport_session_id,
        frame_id = %frame_id,
        target_id = %target_id,
        has_review_context,
        "received session host tool cancellation; Fura host tools do not expose cancellable in-flight work yet"
    );
}

async fn dispatch_session_host_tool(
    state: &AppState,
    transport_session_id: &str,
    tool_name: &str,
    arguments: Value,
) -> Result<String, String> {
    match tool_name {
        "fura_add_review_comment" => {
            add_agent_review_comment(state, transport_session_id, arguments).await
        }
        _ => Err(format!("unknown Fura session tool: {tool_name}")),
    }
}

async fn add_agent_review_comment(
    state: &AppState,
    transport_session_id: &str,
    arguments: Value,
) -> Result<String, String> {
    let context_id = required_string(&arguments, "reviewContextId")?;
    let path = required_string(&arguments, "path")?;
    let side = match required_string(&arguments, "side")?.as_str() {
        "left" => DiffSide::Left,
        "right" => DiffSide::Right,
        value => return Err(format!("side must be left or right, got {value}")),
    };
    let line = arguments
        .get("line")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "line must be a positive integer".to_string())?;
    let body = required_string(&arguments, "body")?;

    let context = state
        .active_review_contexts
        .read()
        .await
        .get(&context_id)
        .cloned()
        .ok_or_else(|| "review context is not active".to_string())?;
    let target_session_id = rpc_session_target_id(state, transport_session_id).await;
    if target_session_id != context.session_id {
        return Err(format!(
            "review context belongs to session {}, but host tool call came from session {}",
            context.session_id, target_session_id
        ));
    }
    let selector = DiffFileSelector {
        old_path: if side == DiffSide::Left {
            Some(path.clone())
        } else {
            None
        },
        new_path: path.clone(),
    };
    let anchor = match generate_file_patch(
        Path::new(&context.repo_root),
        &context.left_tree_or_commit,
        &context.right_tree_or_commit,
        &selector,
        3,
    )
    .await
    {
        Ok((patch, truncated)) => {
            if truncated {
                return Err(format!(
                    "review patch for {path} is too large to map comments safely"
                ));
            }
            if patch.trim().is_empty() {
                return Err(format!("{path} is not present in this review diff"));
            }
            find_patch_location(&patch, &path, side, line).ok_or_else(|| {
                format!(
                    "could not map review comment to {path}:{line} on {:?} side",
                    side
                )
            })?
        }
        Err(error) => {
            let fallback_patch = context
                .patch_override
                .clone()
                .ok_or_else(|| format!("could not generate review patch for {path}: {error}"))?;
            find_patch_location(&fallback_patch, &path, side, line).ok_or_else(|| {
                format!(
                    "could not map review comment to {path}:{line} on {:?} side",
                    side
                )
            })?
        }
    };
    let comment = create_review_comment_with_author(
        state,
        context.session_id.clone(),
        context.repo_root.clone(),
        context.comparison_key.clone(),
        ReviewCommentAuthor::Agent,
        anchor.clone(),
        body,
    )
    .await?;
    Ok(format!(
        "Created review comment {} at {}:{} for review context {}.",
        comment.id,
        path_for_anchor(&anchor),
        line,
        context.id
    ))
}

fn required_string(arguments: &Value, key: &str) -> Result<String, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is required"))
}

fn path_for_anchor(anchor: &DiffLineLocation) -> String {
    if anchor.side == DiffSide::Left {
        anchor
            .old_path
            .clone()
            .unwrap_or_else(|| anchor.new_path.clone())
    } else {
        anchor.new_path.clone()
    }
}

fn find_patch_location(
    patch: &str,
    requested_path: &str,
    requested_side: DiffSide,
    requested_line: u32,
) -> Option<DiffLineLocation> {
    if requested_line == 0 {
        return None;
    }
    crate::diff::parse_diff_rows(patch)
        .into_iter()
        .find_map(|row| {
            let DiffRow::Line { mut location, .. } = row else {
                return None;
            };
            let (path, line) = match requested_side {
                DiffSide::Left => (location.old_path.as_deref(), location.old_line),
                DiffSide::Right => (Some(location.new_path.as_str()), location.new_line),
            };
            if location.hunk.is_some()
                && path == Some(requested_path)
                && line == Some(requested_line)
            {
                location.side = requested_side;
                Some(location)
            } else {
                None
            }
        })
}

fn review_set_host_tools_command(id: String, tools: Vec<Value>) -> Value {
    set_host_tools_command(id, tools)
}

pub(crate) async fn remember_session_host_tools(
    state: &AppState,
    session_id: &str,
    tools: Vec<Value>,
) {
    let mut session_host_tools = state.session_host_tools.write().await;
    if tools.is_empty() {
        session_host_tools.remove(session_id);
    } else {
        session_host_tools.insert(session_id.to_string(), tools);
    }
}

async fn restore_session_host_tools(state: &AppState, session_id: &str, tools: Vec<Value>) {
    remember_session_host_tools(state, session_id, tools.clone()).await;
    let _ = send_rpc_command(
        state,
        session_id,
        review_set_host_tools_command(next_rpc_id(), tools),
    )
    .await;
}

fn review_host_tools_with_comment_tool(previous_host_tools: &[Value]) -> Vec<Value> {
    let mut tools = previous_host_tools
        .iter()
        .filter(|tool| tool.get("name").and_then(Value::as_str) != Some("fura_add_review_comment"))
        .cloned()
        .collect::<Vec<_>>();
    tools.push(review_tool_definition());
    tools
}

fn review_tool_definition() -> Value {
    json!({
        "name": "fura_add_review_comment",
        "label": "Add Fura diff review comment",
        "loadMode": "essential",
        "description": "Persist an inline review comment on the explicit Fura diff review currently in progress. Fura resolves the exact diff anchor from the review refs/context.",
        "parameters": {
            "type": "object",
            "properties": {
                "reviewContextId": { "type": "string", "description": "The review context id supplied in the review prompt." },
                "path": { "type": "string", "description": "Repo-relative file path shown in the diff." },
                "side": { "type": "string", "enum": ["left", "right"], "description": "Use right for added/current lines and left for removed/base lines." },
                "line": { "type": "integer", "minimum": 1, "description": "Line number on the selected side." },
                "body": { "type": "string", "description": "Review comment body." },
                "severity": { "type": "string", "description": "Optional severity label." }
            },
            "required": ["reviewContextId", "path", "side", "line", "body"],
            "additionalProperties": false
        }
    })
}

fn review_endpoint_label(endpoint: &DiffEndpoint) -> String {
    match endpoint {
        DiffEndpoint::Index => "index".to_string(),
        DiffEndpoint::EmptyTree => "empty tree".to_string(),
        DiffEndpoint::WorkingTree => "working tree".to_string(),
        DiffEndpoint::GitRef {
            input,
            ref_kind,
            oid,
            display,
        } => format!("{display} ({ref_kind:?}, input {input}, {oid})"),
        DiffEndpoint::Commit {
            oid,
            short_oid,
            subject,
        } => format!(
            "{short_oid} ({oid}){}",
            subject
                .as_ref()
                .map(|value| format!(" — {value}"))
                .unwrap_or_default()
        ),
    }
}

fn review_prompt(context_id: &str, state: &DiffReviewableState, instructions: &str) -> String {
    let instructions = instructions.trim();
    let instructions = if instructions.is_empty() {
        "Review this diff for correctness, reliability, maintainability, and user-visible regressions."
    } else {
        instructions
    };
    let worktree_status = state
        .review_worktree
        .as_ref()
        .map(|worktree| format!("{:?}", worktree.status))
        .unwrap_or_else(|| "none".to_string());
    let inspection = match (&state.comparison.base, &state.comparison.head) {
        (_, DiffEndpoint::Index) => "Inspect staged changes with git diff --cached.",
        (DiffEndpoint::Index, DiffEndpoint::WorkingTree) => {
            "Inspect unstaged changes with git diff."
        }
        (DiffEndpoint::EmptyTree, DiffEndpoint::WorkingTree) => {
            "Inspect the listed nonignored untracked files as additions; do not stage them."
        }
        (DiffEndpoint::EmptyTree, _) => {
            "Inspect the initial commit with git show --root. EMPTY denotes the empty tree, not a Git ref."
        }
        _ => "Inspect the displayed Git refs and their diff.",
    };
    let inspection = format!(
        "{inspection} Use git --no-replace-objects for inspection: Fura reviews stored commit objects, ignoring replacement refs. Disable signature display, external diff and textconv; do not execute configured clean/process filters."
    );
    format!(
        "You are reviewing the full Fura diff comparison, not just the currently selected file. This is repository state, not proof of changes authored by this session.\n\nReview context id: {context_id}\nRepository: {}\nComparison key: {}\nBase: {}\nHead: {}\nLeft version identity: {}\nRight version identity: {}\nFiles in summary: {}\nCurrent commit: {}\nReview worktree status: {}\nReview instructions:\n{}\n\n{inspection} Version identities may be opaque Fura fingerprints, not Git refs. Do not write files or mutate Git state during this review. When you find an issue, call fura_add_review_comment with this reviewContextId, the repo-relative path, side, line, and comment body. Fura will validate the displayed patch version and resolve the exact diff anchor; do not invent line numbers. If the repository changes, refresh the review rather than reusing old anchors.",
        state.comparison.repo_root,
        state.comparison.comparison_key,
        review_endpoint_label(&state.comparison.base),
        review_endpoint_label(&state.comparison.head),
        state.comparison.left_tree_or_commit,
        state.comparison.right_tree_or_commit,
        state.summary.files.len(),
        state.review.current_commit_oid.as_deref().unwrap_or("none"),
        worktree_status,
        instructions,
    )
}

fn review_host_tool_result_frame(id: String, text: String, is_error: bool) -> Value {
    json!({
        "id": id,
        "type": "host_tool_result",
        "result": {
            "content": [
                { "type": "text", "text": text }
            ]
        },
        "isError": is_error,
    })
}

pub(crate) async fn abort_prompt(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    info!(action = "prompt.abort", session_id = %session_id);
    let command = abort_command(next_rpc_id());
    let send_result = send_rpc_command(state, &session_id, command).await;
    clear_review_contexts_for_session(state, &session_id).await;

    let snapshot_sent = state
        .events
        .mutate_session_snapshot(&state, &session_id, |record| {
            record.status = SessionStatus::Idle;
        })
        .await;
    if !snapshot_sent {
        return vec![unknown_session_error(session_id)];
    }
    let mut responses = Vec::new();
    if let Err(message) = send_result {
        responses.push(ServerMessage::Error {
            request_id: None,
            message,
        });
    }
    responses
}

async fn handle_git_history_request(
    state: &AppState,
    connection_id: u64,
    client_id: String,
    request_id: String,
    session_id: String,
    repo_id: Option<String>,
    cursor: Option<String>,
) -> Vec<ServerMessage> {
    let mut jobs = state.diff_jobs.write().await;
    if let Some(previous) = jobs.history_jobs.remove(&connection_id) {
        previous.handle.abort();
    }
    jobs.next_token = jobs.next_token.wrapping_add(1);
    let token = jobs.next_token;
    let task_state = state.clone();
    let handle = tokio::spawn(async move {
        let operation = async {
            let repos =
                crate::session_repos::session_repo_candidates(&task_state, &session_id).await?;
            let selected = match repo_id.as_deref() {
                Some(id) => repos.iter().find(|repo| repo.id == id),
                None => repos
                    .iter()
                    .find(|repo| repo.is_default)
                    .or_else(|| repos.first()),
            }
            .ok_or_else(|| anyhow!("selected repository is not available in this session"))?;
            crate::diff::list_git_history(Path::new(&selected.repo_root), cursor.as_deref()).await
        };
        let result = tokio::time::timeout(Duration::from_secs(15), operation)
            .await
            .unwrap_or_else(|_| {
                Err(anyhow!(
                    "Git history read timed out; try a smaller repository or retry"
                ))
            });
        if task_state
            .diff_jobs
            .read()
            .await
            .history_jobs
            .get(&connection_id)
            .is_none_or(|job| job.token != token)
        {
            return;
        }
        let (page, error) = match result {
            Ok(page) => (Some(page), None),
            Err(error) => (None, Some(error.to_string())),
        };
        task_state
            .events
            .emit(
                &task_state,
                ServerMessage::GitHistory {
                    target_client_id: client_id,
                    request_id,
                    session_id,
                    page,
                    error,
                },
            )
            .await;
        let mut jobs = task_state.diff_jobs.write().await;
        if jobs
            .history_jobs
            .get(&connection_id)
            .is_some_and(|job| job.token == token)
        {
            jobs.history_jobs.remove(&connection_id);
        }
    });
    jobs.history_jobs
        .insert(connection_id, DiffFilePatchJob { token, handle });
    Vec::new()
}

async fn handle_git_file_request(
    state: &AppState,
    connection_id: u64,
    client_id: String,
    request_id: String,
    repo_root: String,
    commit_oid: String,
    path: String,
) -> Vec<ServerMessage> {
    let mut jobs = state.diff_jobs.write().await;
    if let Some(previous) = jobs.git_file_jobs.remove(&connection_id) {
        previous.handle.abort();
    }
    jobs.next_token = jobs.next_token.wrapping_add(1);
    let token = jobs.next_token;
    let task_state = state.clone();
    let handle = tokio::spawn(async move {
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            crate::diff::read_git_file(&repo_root, &commit_oid, &path),
        )
        .await
        .unwrap_or_else(|_| Err(anyhow!("Committed file read timed out")));
        if task_state
            .diff_jobs
            .read()
            .await
            .git_file_jobs
            .get(&connection_id)
            .is_none_or(|job| job.token != token)
        {
            return;
        }
        let (file, error) = match result {
            Ok(file) => (Some(file), None),
            Err(error) => (None, Some(error.to_string())),
        };
        task_state
            .events
            .emit(
                &task_state,
                ServerMessage::GitFile {
                    target_client_id: client_id,
                    request_id,
                    file,
                    error,
                },
            )
            .await;
        let mut jobs = task_state.diff_jobs.write().await;
        if jobs
            .git_file_jobs
            .get(&connection_id)
            .is_some_and(|job| job.token == token)
        {
            jobs.git_file_jobs.remove(&connection_id);
        }
    });
    jobs.git_file_jobs
        .insert(connection_id, DiffFilePatchJob { token, handle });
    Vec::new()
}

async fn handle_git_range_diff_request(
    state: &AppState,
    connection_id: u64,
    client_id: String,
    request_id: String,
    repo_root: String,
    base: String,
    old: String,
    new: String,
    ignore_whitespace: bool,
) -> Vec<ServerMessage> {
    let mut jobs = state.diff_jobs.write().await;
    if let Some(previous) = jobs.range_diff_jobs.remove(&connection_id) {
        previous.handle.abort();
    }
    jobs.next_token = jobs.next_token.wrapping_add(1);
    let token = jobs.next_token;
    let task_state = state.clone();
    let job_request_id = request_id.clone();
    let handle = tokio::spawn(async move {
        let result =
            crate::range_diff::read_range_diff(&repo_root, &base, &old, &new, ignore_whitespace)
                .await;
        // Keep ownership through publication: replacement/cancel cannot slip
        // between a stale-token check and broadcasting this result.
        let mut jobs = task_state.diff_jobs.write().await;
        if jobs
            .range_diff_jobs
            .get(&connection_id)
            .is_none_or(|job| job.token != token)
        {
            return;
        }
        let (result, error) = match result {
            Ok(result) => (Some(result), None),
            Err(error) => (None, Some(format!("{error:#}"))),
        };
        task_state
            .events
            .emit(
                &task_state,
                ServerMessage::GitRangeDiff {
                    target_client_id: client_id,
                    request_id,
                    result,
                    error,
                },
            )
            .await;
        jobs.range_diff_jobs.remove(&connection_id);
    });
    jobs.range_diff_jobs.insert(
        connection_id,
        crate::state::GitRangeDiffJob {
            request_id: job_request_id,
            token,
            handle,
        },
    );
    Vec::new()
}

pub(crate) async fn cancel_git_range_diff(
    state: &AppState,
    connection_id: u64,
    request_id: Option<&str>,
) {
    let mut jobs = state.diff_jobs.write().await;
    if jobs
        .range_diff_jobs
        .get(&connection_id)
        .is_some_and(|job| request_id.is_none_or(|request_id| job.request_id == request_id))
    {
        if let Some(job) = jobs.range_diff_jobs.remove(&connection_id) {
            job.handle.abort();
        }
    }
}

#[cfg(test)]
mod range_diff_tests {
    use super::*;
    use tempfile::TempDir;

    fn repository() -> TempDir {
        let temp = TempDir::new().unwrap();
        let repo = Repository::init(temp.path()).unwrap();
        let tree = repo.treebuilder(None).unwrap().write().unwrap();
        let signature = git2::Signature::now("Range Tester", "range@example.invalid").unwrap();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "base",
            &repo.find_tree(tree).unwrap(),
            &[],
        )
        .unwrap();
        temp
    }

    async fn request(state: &AppState, repo: &Path, owner: u64, id: &str) {
        let message: ClientMessage = serde_json::from_value(json!({
            "type": "git.rangeDiff.request", "clientId": format!("client-{owner}"),
            "requestId": id, "repoRoot": repo.to_string_lossy(),
            "base": "HEAD", "old": "HEAD", "new": "HEAD"
        }))
        .unwrap();
        assert!(
            handle_client_message_for_connection(state, message, owner)
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn whitespace_option_dispatch_matches_native_git_and_preserves_statuses() {
        let state = crate::tests::test_state(16, None);
        let temp = repository();
        let repo = Repository::open(temp.path()).unwrap();
        let commit = |parent: git2::Oid, text: &str| {
            let parent = repo.find_commit(parent).unwrap();
            let mut tree = repo.treebuilder(Some(&parent.tree().unwrap())).unwrap();
            tree.insert("sample.txt", repo.blob(text.as_bytes()).unwrap(), 0o100644)
                .unwrap();
            let tree = repo.find_tree(tree.write().unwrap()).unwrap();
            let signature = git2::Signature::new(
                "Range Tester",
                "range@example.invalid",
                &git2::Time::new(1_700_000_001, 0),
            )
            .unwrap();
            repo.commit(
                None,
                &signature,
                &signature,
                "Change value",
                &tree,
                &[&parent],
            )
            .unwrap()
        };
        let original = (0..80)
            .map(|n| format!("    value_{n} = {n};\n"))
            .collect::<String>();
        let base = commit(repo.head().unwrap().target().unwrap(), &original);
        let old_text = original.replace("value_40 = 40;", "value_40 = 400;");
        let old = commit(base, &old_text);
        let indented = commit(base, &old_text.replace("    value_40", "        value_40"));
        let compact = commit(base, &old_text.replace("value_40 = 400;", "value_40=400;"));
        let substantive = commit(
            base,
            &old_text.replace("value_40 = 400;", "value_40 = 401;"),
        );
        let blank = commit(
            base,
            &old_text.replace("value_40 = 400;\n", "value_40 = 400;\n\n"),
        );
        let mut events = state.events.subscribe();

        for (case, old, new, marker, hidden_body) in [
            ("indentation", old, indented, " ! ", true),
            ("spaces-removed", old, compact, " ! ", true),
            ("substantive", old, substantive, " ! ", false),
            ("blank-line", old, blank, " ! ", false),
            ("identical", old, old, " = ", true),
            ("added", base, old, " > ", false),
            ("removed", old, base, " < ", false),
        ] {
            let mut summaries = None;
            let mut normal_output = None;
            for option in [Some(true), Some(false), None] {
                let ignore = option.unwrap_or(false);
                let mut native = std::process::Command::new("git");
                for (key, _) in std::env::vars_os() {
                    if key.to_string_lossy().starts_with("GIT_") {
                        native.env_remove(key);
                    }
                }
                native.current_dir(temp.path()).args([
                    "--no-pager",
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "log.showSignature=false",
                    "-c",
                    "diff.external=",
                    "range-diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--color=always",
                    "--dual-color",
                ]);
                if ignore {
                    native.arg("--ignore-all-space");
                }
                let native = native
                    .args([
                        base.to_string(),
                        old.to_string(),
                        new.to_string(),
                        "--".into(),
                    ])
                    .output()
                    .unwrap();
                assert!(
                    native.status.success(),
                    "{}",
                    String::from_utf8_lossy(&native.stderr)
                );
                let expected = String::from_utf8(native.stdout).unwrap();
                let id = format!("{case}-{option:?}");
                let mut request = json!({
                    "type": "git.rangeDiff.request", "clientId": "whitespace-client",
                    "requestId": id, "repoRoot": temp.path().to_string_lossy(),
                    "base": base.to_string(), "old": old.to_string(), "new": new.to_string()
                });
                if let Some(option) = option {
                    request["ignoreWhitespace"] = json!(option);
                }
                let message = serde_json::from_value(request).unwrap();
                handle_client_message_for_connection(&state, message, 41).await;
                let event = tokio::time::timeout(Duration::from_secs(20), events.recv())
                    .await
                    .unwrap()
                    .unwrap();
                let wire = serde_json::to_value(&event).unwrap();
                assert_eq!(wire["requestId"], id);
                assert_eq!(wire["targetClientId"], "whitespace-client");
                assert!(wire["error"].is_null(), "{wire}");
                let result = &wire["result"];
                let output = result["output"].as_str().unwrap();
                // Check real output before the new echo field so RED is behavioral.
                assert_eq!(output, expected, "{case}, ignoreWhitespace={option:?}");
                assert_eq!(result["ignoreWhitespace"], json!(ignore));
                assert_eq!(result["truncated"], false);
                if case == "indentation" && ignore {
                    let mut legacy = result.clone();
                    legacy.as_object_mut().unwrap().remove("ignoreWhitespace");
                    let legacy: GitRangeDiffResult = serde_json::from_value(legacy).unwrap();
                    assert_eq!(
                        serde_json::to_value(legacy).unwrap()["ignoreWhitespace"],
                        false
                    );
                }
                if option == Some(false) {
                    normal_output = Some(output.to_owned());
                } else if option.is_none() {
                    assert_eq!(
                        Some(output),
                        normal_output.as_deref(),
                        "{case}: missing defaults off"
                    );
                }
                // Git's forced-color output contains SGR sequences only.
                let plain: String = output
                    .split('\x1b')
                    .enumerate()
                    .map(|(index, part)| {
                        if index == 0 {
                            part
                        } else {
                            part.split_once('m').unwrap().1
                        }
                    })
                    .collect();
                let headers = plain
                    .lines()
                    .filter(|line| !line.starts_with(' '))
                    .collect::<Vec<_>>();
                assert_eq!(headers.len(), 1, "{plain}");
                assert!(headers[0].contains(marker), "{plain}");
                if let Some(summaries) = &summaries {
                    assert_eq!(
                        &headers.join("\n"),
                        summaries,
                        "option changed native pairing/status"
                    );
                } else {
                    summaries = Some(headers.join("\n"));
                }
                if (ignore && hidden_body) || marker != " ! " {
                    assert_eq!(plain.lines().count(), 1, "{case}: {plain}");
                } else {
                    assert!(
                        plain.lines().any(|line| line.starts_with("    @@")),
                        "{case}: {plain}"
                    );
                }
                if case == "substantive" {
                    assert!(plain.contains("value_40 = 401;"), "{plain}");
                }
                if case == "blank-line" {
                    assert!(plain.lines().any(|line| line == "    ++"), "{plain}");
                }
            }
        }
    }

    #[tokio::test]
    async fn replacement_stale_cancel_and_disconnect_are_connection_owned() {
        let state = crate::tests::test_state(16, None);
        let repo = repository();
        let mut events = state.events.subscribe();
        request(&state, repo.path(), 41, "old-request").await;
        request(&state, repo.path(), 41, "replacement").await;
        request(&state, repo.path(), 42, "other-connection").await;
        let stale_cancel: ClientMessage = serde_json::from_value(json!({
            "type": "git.rangeDiff.cancel", "requestId": "old-request"
        }))
        .unwrap();
        handle_client_message_for_connection(&state, stale_cancel, 41).await;
        // A guessed request ID on another connection cannot cancel its owner.
        cancel_git_range_diff(&state, 42, Some("replacement")).await;
        cancel_git_range_diff(&state, 42, None).await;
        let event = tokio::time::timeout(Duration::from_secs(20), events.recv())
            .await
            .unwrap()
            .unwrap();
        let ServerMessage::GitRangeDiff {
            target_client_id,
            request_id,
            result,
            error,
        } = &event
        else {
            panic!("unexpected event: {event:?}");
        };
        assert_eq!(target_client_id, "client-41");
        assert_eq!(request_id, "replacement");
        assert!(error.is_none(), "{error:?}");
        assert_eq!(result.as_ref().unwrap().output, "");
        let wire = serde_json::to_value(&event).unwrap();
        assert_eq!(wire["type"], "git.rangeDiff");
        assert!(wire["result"]["repoRoot"].is_string());
        assert!(wire["result"]["base"]["oid"].is_string());
        assert!(wire["error"].is_null());
        // Completion removes ownership, so disconnect/cancel stays idempotent.
        cancel_git_range_diff(&state, 41, None).await;
        assert!(state.diff_jobs.read().await.range_diff_jobs.is_empty());
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn current_request_cancel_suppresses_result_but_not_other_connection() {
        let state = crate::tests::test_state(16, None);
        let repo = repository();
        let mut events = state.events.subscribe();
        request(&state, repo.path(), 41, "cancelled").await;
        request(&state, repo.path(), 42, "survivor").await;
        let cancel: ClientMessage = serde_json::from_value(json!({
            "type": "git.rangeDiff.cancel", "requestId": "cancelled"
        }))
        .unwrap();
        handle_client_message_for_connection(&state, cancel, 41).await;
        let event = tokio::time::timeout(Duration::from_secs(20), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(event, ServerMessage::GitRangeDiff {
            target_client_id, request_id, result: Some(_), error: None
        } if target_client_id == "client-42" && request_id == "survivor"));
        cancel_git_range_diff(&state, 42, None).await;
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn invalid_ref_returns_correlated_error_without_native_output() {
        let state = crate::tests::test_state(16, None);
        let repo = repository();
        let mut events = state.events.subscribe();
        let message = ClientMessage::GitRangeDiffRequest {
            client_id: "client".into(),
            request_id: "invalid".into(),
            repo_root: repo.path().to_string_lossy().into_owned(),
            base: "HEAD".into(),
            old: "@{u}".into(),
            new: "HEAD".into(),
            ignore_whitespace: false,
        };
        handle_client_message_for_connection(&state, message, 41).await;
        let event = tokio::time::timeout(Duration::from_secs(20), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(event, ServerMessage::GitRangeDiff {
            target_client_id, request_id, result: None, error: Some(error)
        } if target_client_id == "client" && request_id == "invalid" && error.contains("upstream")));
    }

    #[test]
    fn range_diff_debug_summary_never_contains_native_output() {
        let native = "\x1b[31mprivate commit and patch content\x1b[m";
        let reference = GitRangeDiffRef {
            input: "HEAD".into(),
            oid: "a".repeat(40),
        };
        let event = ServerMessage::GitRangeDiff {
            target_client_id: "client".into(),
            request_id: "request".into(),
            error: None,
            result: Some(GitRangeDiffResult {
                repo_root: "/repo".into(),
                base: reference.clone(),
                old: reference.clone(),
                new: reference,
                ignore_whitespace: false,
                output: native.into(),
                truncated: false,
            }),
        };
        let summary =
            serde_json::to_string(&crate::event_debug::summarize_server_event(&event)).unwrap();
        assert!(!summary.contains("private commit"));
        assert!(!summary.contains("patch content"));
    }
}

#[cfg(test)]
mod review_comment_tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn combined_conflicts_do_not_create_agent_comment_anchors() {
        let patch = "diff --cc f\nindex c376d89,45cf141..0000000\n--- a/f\n+++ b/f\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n +right\n++=======\n+ left\n++>>>>>>> left\n";
        assert!(find_patch_location(patch, "f", DiffSide::Right, 1).is_none());
        assert!(find_patch_location(patch, "f", DiffSide::Left, 1).is_none());
    }

    #[test]
    fn agent_context_anchor_keeps_requested_side_and_literal_renamed_path() {
        let patch = "diff --git \"a/old name\" \"b/new name\"\n--- \"a/old name\"\n+++ \"b/new name\"\n@@ -1,2 +1,2 @@\n context\n-before\n+after\n";
        let left = find_patch_location(patch, "old name", DiffSide::Left, 1).expect("left context");
        assert_eq!(left.side, DiffSide::Left);
        assert_eq!(left.old_line, Some(1));
        assert_eq!(left.text, " context");
        assert!(find_patch_location(patch, "old name", DiffSide::Right, 2).is_none());
        let right = find_patch_location(patch, "new name", DiffSide::Right, 2).expect("new line");
        assert_eq!(right.text, "+after");
        assert!(find_patch_location(patch, "new name", DiffSide::Right, 0).is_none());
    }
    fn test_session_record(id: &str) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            cwd: Some("/repo".to_string()),
            args: Vec::new(),
            status: SessionStatus::Idle,
            created_at: Timestamp::now(),
            updated_at: Timestamp::now(),
            session_mode: SessionMode::Standard,
            messages: Vec::new(),
            live_message_ids: HashSet::new(),
            streaming_message: None,
            is_compacting: false,
            continuation_pending: false,
            tool_cards: Vec::new(),
            active_tool_calls: Vec::new(),
            todo_phases: Some(Vec::new()),
            kind: SessionKind::Managed,
            session_file: None,
            title: None,
            timestamp: None,
            category: None,
            worktree: None,
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
            available_commands: Vec::new(),
        }
    }

    fn active_background_tool_card(id: &str) -> ToolCard {
        ToolCard::new(
            id.to_string(),
            None,
            "bash".to_string(),
            Some("running in background".to_string()),
            serde_json::json!({ "command": "long-running-task" }),
            true,
            false,
            None,
            Some(serde_json::json!({
                "details": {
                    "async": {
                        "state": "running"
                    }
                }
            })),
            0,
        )
    }

    fn anchor() -> DiffLineLocation {
        DiffLineLocation {
            old_path: Some("src/old.ts".to_string()),
            new_path: "src/new.ts".to_string(),
            hunk: Some("@@ -1,1 +1,1 @@".to_string()),
            side: DiffSide::Right,
            kind: DiffLineKind::Add,
            old_line: None,
            new_line: Some(1),
            text: "+const next = true;".to_string(),
        }
    }

    fn reviewable_state(patch: &str) -> DiffReviewableState {
        DiffReviewableState {
            comparison: DiffComparisonIdentity {
                repo_root: "/repo".to_string(),
                base: DiffEndpoint::WorkingTree,
                head: DiffEndpoint::WorkingTree,
                left_tree_or_commit: "base".to_string(),
                right_tree_or_commit: "head".to_string(),
                detail_mode: DiffDetailMode::FilePatch,
                current_commit_oid: Some("abc123".to_string()),
                selected_file: Some(DiffFileSelector {
                    old_path: None,
                    new_path: "src/new.ts".to_string(),
                }),
                context_lines: 3,
                generated_at: "2026-05-06T00:00:00Z".to_string(),
                comparison_key: "cmp".to_string(),
                displayed_patch_range: None,
            },
            summary: DiffSummaryPayload {
                files: vec![DiffFileSummary {
                    old_path: None,
                    new_path: "src/new.ts".to_string(),
                    status: DiffFileStatus::Modified,
                    added: 1,
                    removed: 0,
                }],
                stat: None,
                truncated: false,
                file_limit_reached: None,
            },
            review: CommitStepState {
                commits: Vec::new(),
                current_commit_oid: Some("abc123".to_string()),
                current_commit_index: Some(0),
                previous_commit_oid: None,
            },
            patch: Some(patch.to_string()),
            patch_rows: None,
            patch_context_lines: None,
            review_worktree: None,
        }
    }

    #[tokio::test]
    async fn review_comment_create_persists_and_broadcasts_without_direct_success() {
        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_session_record("s1"));
        let mut events = state.events.subscribe();

        let responses = handle_client_message(
            &state,
            ClientMessage::ReviewCommentCreate {
                session_id: "s1".to_string(),
                repo_root: "/repo".to_string(),
                comparison_key: "cmp".to_string(),
                anchor: anchor(),
                body: "Persist this".to_string(),
            },
        )
        .await;

        assert!(responses.is_empty());
        let event = events.recv().await.expect("broadcast event");
        let ServerMessage::ReviewCommentUpserted { comment } = event else {
            panic!("expected upsert broadcast");
        };
        assert_eq!(comment.session_id, "s1");
        assert_eq!(comment.author, ReviewCommentAuthor::User);
        assert_eq!(comment.body, "Persist this");
        let listed = list_comments(&state.review_comment_db_path, "s1", Some("cmp"))
            .expect("comment persisted");
        assert_eq!(listed, vec![comment]);
    }

    #[tokio::test]
    async fn review_comment_list_update_and_delete_round_trip() {
        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_session_record("s1"));
        let created = create_comment(
            &state.review_comment_db_path,
            NewReviewComment {
                session_id: "s1".to_string(),
                repo_root: "/repo".to_string(),
                comparison_key: "cmp".to_string(),
                author: ReviewCommentAuthor::User,
                body: "Original".to_string(),
                anchor: anchor(),
                stale: false,
                stale_reason: None,
            },
        )
        .expect("created");

        let list_response = handle_client_message(
            &state,
            ClientMessage::ReviewCommentsList {
                session_id: "s1".to_string(),
                comparison_key: Some("cmp".to_string()),
            },
        )
        .await;
        let [ServerMessage::ReviewCommentsSnapshot { comments, .. }] = list_response.as_slice()
        else {
            panic!("expected comments snapshot");
        };
        assert_eq!(comments, &vec![created.clone()]);

        let mut events = state.events.subscribe();
        let update_responses = handle_client_message(
            &state,
            ClientMessage::ReviewCommentUpdate {
                id: created.id.clone(),
                body: "Updated".to_string(),
            },
        )
        .await;
        assert!(update_responses.is_empty());
        let ServerMessage::ReviewCommentUpserted { comment: updated } =
            events.recv().await.expect("update broadcast")
        else {
            panic!("expected update broadcast");
        };
        assert_eq!(updated.body, "Updated");

        let delete_responses = handle_client_message(
            &state,
            ClientMessage::ReviewCommentDelete {
                id: created.id.clone(),
            },
        )
        .await;
        assert!(delete_responses.is_empty());
        let ServerMessage::ReviewCommentDeleted {
            session_id,
            comparison_key,
            id,
        } = events.recv().await.expect("delete broadcast")
        else {
            panic!("expected delete broadcast");
        };
        assert_eq!(session_id, "s1");
        assert_eq!(comparison_key, "cmp");
        assert_eq!(id, created.id);
        assert!(
            list_comments(&state.review_comment_db_path, "s1", None)
                .expect("listed")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn rebase_rejects_idle_session_with_active_background_tool() {
        let state = crate::tests::test_state(8, None);
        let mut record = test_session_record("s1");
        record
            .active_tool_calls
            .push(active_background_tool_card("background-1"));
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), record);

        let responses = handle_rebase_slash_command(&state, "s1".to_string(), "main").await;

        let [ServerMessage::SessionNotice { level, text, .. }] = responses.as_slice() else {
            panic!("expected busy notice");
        };
        assert!(matches!(level, NoticeLevel::Error));
        assert!(text.contains("Session is busy"));
    }

    #[tokio::test]
    async fn review_agent_review_start_rejects_active_background_tool() {
        let state = crate::tests::test_state(8, None);
        let mut record = test_session_record("s1");
        record
            .active_tool_calls
            .push(active_background_tool_card("background-1"));
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), record);

        let responses = handle_client_message(
            &state,
            ClientMessage::ReviewAgentReviewStart {
                session_id: "s1".to_string(),
                state: reviewable_state("+change"),
                instructions: "Review while a background tool is active".to_string(),
            },
        )
        .await;

        let [ServerMessage::Error { message, .. }] = responses.as_slice() else {
            panic!("expected busy error");
        };
        assert!(message.contains("session is busy"));
        assert!(state.active_review_contexts.read().await.is_empty());
    }

    #[tokio::test]
    async fn review_agent_review_start_rejects_busy_session_without_enabling_tools() {
        let state = crate::tests::test_state(8, None);
        let mut record = test_session_record("s1");
        record.status = SessionStatus::Busy;
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), record);

        let responses = handle_client_message(
            &state,
            ClientMessage::ReviewAgentReviewStart {
                session_id: "s1".to_string(),
                state: reviewable_state("+change"),
                instructions: "Review while busy".to_string(),
            },
        )
        .await;

        let [ServerMessage::Error { message, .. }] = responses.as_slice() else {
            panic!("expected busy error");
        };
        assert!(message.contains("session is busy"));
        assert!(state.active_review_contexts.read().await.is_empty());
        assert!(
            state
                .sessions
                .read()
                .await
                .get("s1")
                .is_some_and(|record| matches!(record.status, SessionStatus::Busy))
        );
    }

    #[tokio::test]
    async fn review_host_tool_requires_active_context() {
        let state = crate::tests::test_state(8, None);

        let error = dispatch_session_host_tool(
            &state,
            "s1",
            "fura_add_review_comment",
            json!({
                "reviewContextId": "missing",
                "path": "src/new.ts",
                "side": "right",
                "line": 1,
                "body": "Agent comment"
            }),
        )
        .await
        .expect_err("inactive context rejected");

        assert!(error.contains("not active"));
        assert!(
            list_comments(&state.review_comment_db_path, "s1", None)
                .expect("listed")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn review_host_tool_active_context_creates_agent_comment() {
        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_session_record("s1"));
        let patch = "diff --git a/src/new.ts b/src/new.ts\n--- a/src/new.ts\n+++ b/src/new.ts\n@@ -1,1 +1,2 @@\n const old = true;\n+const next = true;\n";
        state.active_review_contexts.write().await.insert(
            "ctx".to_string(),
            ActiveReviewContext {
                id: "ctx".to_string(),
                session_id: "s1".to_string(),
                repo_root: "/repo".to_string(),
                comparison_key: "cmp".to_string(),
                left_tree_or_commit: "base".to_string(),
                right_tree_or_commit: "head".to_string(),
                patch_override: Some(patch.to_string()),
                previous_host_tools: Vec::new(),
                set_host_tools_command_id: "set-host".to_string(),
                prompt_command_id: "prompt".to_string(),
            },
        );
        let mut events = state.events.subscribe();

        let result = dispatch_session_host_tool(
            &state,
            "s1",
            "fura_add_review_comment",
            json!({
                "reviewContextId": "ctx",
                "path": "src/new.ts",
                "side": "right",
                "line": 2,
                "body": "Agent comment"
            }),
        )
        .await
        .expect("comment created");

        assert!(result.contains("Created review comment"));
        let ServerMessage::ReviewCommentUpserted { comment } =
            events.recv().await.expect("agent comment broadcast")
        else {
            panic!("expected agent comment broadcast");
        };
        assert_eq!(comment.author, ReviewCommentAuthor::Agent);
        assert_eq!(comment.anchor.new_line, Some(2));
        assert_eq!(comment.body, "Agent comment");
        let listed = list_comments(&state.review_comment_db_path, "s1", Some("cmp"))
            .expect("comment persisted");
        assert_eq!(listed, vec![comment]);
    }

    #[tokio::test]
    async fn review_host_tool_new_file_comment_uses_null_old_path() {
        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_session_record("s1"));
        let patch = "diff --git a/src/new-file.ts b/src/new-file.ts\n--- /dev/null\n+++ b/src/new-file.ts\n@@ -0,0 +1,1 @@\n+const next = true;\n";
        state.active_review_contexts.write().await.insert(
            "ctx".to_string(),
            ActiveReviewContext {
                id: "ctx".to_string(),
                session_id: "s1".to_string(),
                repo_root: "/repo".to_string(),
                comparison_key: "cmp".to_string(),
                left_tree_or_commit: "base".to_string(),
                right_tree_or_commit: "head".to_string(),
                patch_override: Some(patch.to_string()),
                previous_host_tools: Vec::new(),
                set_host_tools_command_id: "set-host".to_string(),
                prompt_command_id: "prompt".to_string(),
            },
        );
        let mut events = state.events.subscribe();

        let result = dispatch_session_host_tool(
            &state,
            "s1",
            "fura_add_review_comment",
            json!({
                "reviewContextId": "ctx",
                "path": "src/new-file.ts",
                "side": "right",
                "line": 1,
                "body": "New file comment"
            }),
        )
        .await
        .expect("comment created");

        assert!(result.contains("Created review comment"));
        let ServerMessage::ReviewCommentUpserted { comment } =
            events.recv().await.expect("agent comment broadcast")
        else {
            panic!("expected agent comment broadcast");
        };
        assert_eq!(comment.anchor.old_path, None);
        assert_eq!(comment.anchor.new_path, "src/new-file.ts");
    }

    #[tokio::test]
    async fn review_host_tool_rejects_unmapped_path_without_persisting() {
        let state = crate::tests::test_state(8, None);
        let patch = "diff --git a/src/new.ts b/src/new.ts\n--- a/src/new.ts\n+++ b/src/new.ts\n@@ -1,1 +1,2 @@\n const old = true;\n+const next = true;\n";
        state.active_review_contexts.write().await.insert(
            "ctx".to_string(),
            ActiveReviewContext {
                id: "ctx".to_string(),
                session_id: "s1".to_string(),
                repo_root: "/repo".to_string(),
                comparison_key: "cmp".to_string(),
                left_tree_or_commit: "base".to_string(),
                right_tree_or_commit: "head".to_string(),
                patch_override: Some(patch.to_string()),
                previous_host_tools: Vec::new(),
                set_host_tools_command_id: "set-host".to_string(),
                prompt_command_id: "prompt".to_string(),
            },
        );

        let error = dispatch_session_host_tool(
            &state,
            "s1",
            "fura_add_review_comment",
            json!({
                "reviewContextId": "ctx",
                "path": "src/missing.ts",
                "side": "right",
                "line": 2,
                "body": "Agent comment"
            }),
        )
        .await
        .expect_err("unmapped location rejected");

        assert!(error.contains("could not map review comment"));
        assert!(
            list_comments(&state.review_comment_db_path, "s1", None)
                .expect("listed")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn review_host_tool_rejects_mismatched_transport_session() {
        let state = crate::tests::test_state(8, None);
        let patch = "diff --git a/src/new.ts b/src/new.ts\n--- a/src/new.ts\n+++ b/src/new.ts\n@@ -1,1 +1,2 @@\n const old = true;\n+const next = true;\n";
        state.active_review_contexts.write().await.insert(
            "ctx".to_string(),
            ActiveReviewContext {
                id: "ctx".to_string(),
                session_id: "s1".to_string(),
                repo_root: "/repo".to_string(),
                comparison_key: "cmp".to_string(),
                left_tree_or_commit: "base".to_string(),
                right_tree_or_commit: "head".to_string(),
                patch_override: Some(patch.to_string()),
                previous_host_tools: Vec::new(),
                set_host_tools_command_id: "set-host".to_string(),
                prompt_command_id: "prompt".to_string(),
            },
        );
        crate::tests::map_test_transport(&state, "transport-2", "s2").await;

        let error = dispatch_session_host_tool(
            &state,
            "transport-2",
            "fura_add_review_comment",
            json!({
                "reviewContextId": "ctx",
                "path": "src/new.ts",
                "side": "right",
                "line": 2,
                "body": "Agent comment"
            }),
        )
        .await
        .expect_err("mismatched transport rejected");

        assert!(error.contains("review context belongs to session s1"));
        assert!(
            list_comments(&state.review_comment_db_path, "s1", None)
                .expect("listed")
                .is_empty()
        );
    }
}
