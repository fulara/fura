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

pub(crate) async fn handle_client_message(
    state: &AppState,
    message: ClientMessage,
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
            thinking_visibility,
            proposed_models,
        } => set_client_config(state, show_tools, thinking_visibility, proposed_models).await,
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
        ClientMessage::SessionOpen { session_file } => open_session(state, session_file).await,
        ClientMessage::SessionList => {
            info!(action = "session.list");
            refresh_session_catalog(state).await;
            state.events.emit_sessions_snapshot(state).await;
            Vec::new()
        }
        ClientMessage::SessionAttach { session_id }
        | ClientMessage::StateRefresh { session_id } => {
            info!(action = "session.attach_or_refresh", session_id = %session_id);
            if let Err(message) = refresh_rpc_state(state, &session_id).await {
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
        ClientMessage::PromptAbort { session_id } => abort_prompt(state, session_id).await,
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
                detail_mode,
                current_commit_oid,
                selected_file,
                context_lines,
            )
            .await
        }
        ClientMessage::SessionChangesSnapshot {
            client_id,
            diff_id,
            session_id,
            repo_id,
            label,
            repo_root,
            ref_name,
            detail_mode,
            current_commit_oid,
            selected_file,
            context_lines,
        } => {
            handle_session_changes_snapshot(
                state,
                client_id,
                diff_id,
                session_id,
                repo_id,
                label,
                repo_root,
                ref_name,
                detail_mode.unwrap_or(DiffDetailMode::StatOnly),
                current_commit_oid,
                selected_file,
                context_lines,
            )
            .await
        }
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
        ClientMessage::ConflictScan { root } => handle_conflict_scan(root).await,
        ClientMessage::ConflictFileOpen { repo_id, path } => {
            handle_conflict_file_open(repo_id, path).await
        }
        ClientMessage::ConflictFilePreviewMagicWand {
            repo_id,
            path,
            expected_version,
        } => handle_conflict_file_preview_magic_wand(repo_id, path, expected_version).await,
        ClientMessage::ConflictFileWriteResult {
            repo_id,
            path,
            content,
            expected_version,
        } => handle_conflict_file_write_result(repo_id, path, content, expected_version).await,
        ClientMessage::ConflictFileStageResolved {
            repo_id,
            path,
            expected_version,
        } => handle_conflict_file_stage_resolved(repo_id, path, expected_version).await,
        ClientMessage::ConflictAgentRun {
            session_id,
            repo_id,
            path,
            expected_version,
            mode,
            scope,
            conflict_id,
            instructions,
        } => {
            handle_conflict_agent_run(
                state,
                session_id,
                repo_id,
                path,
                expected_version,
                mode,
                scope,
                conflict_id,
                instructions,
            )
            .await
        }
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
        ClientMessage::SessionFork { session_id, name } => {
            handle_session_fork(state, session_id, name).await
        }
        ClientMessage::SessionHandoff {
            session_id,
            name,
            custom_instructions,
        } => handle_session_handoff(state, session_id, name, custom_instructions).await,
    }
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
    thinking_visibility: Option<ThinkingVisibilityPreference>,
    proposed_models: Option<Vec<ProposedModelConfig>>,
) -> Vec<ServerMessage> {
    if show_tools.is_none() && thinking_visibility.is_none() && proposed_models.is_none() {
        return vec![ServerMessage::Error {
            request_id: None,
            message: "config.set requires showTools, thinkingVisibility, or proposedModels"
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
    let previous_thinking_visibility = *state.thinking_visibility.read().await;
    let previous_proposed_models = state.proposed_models.read().await.clone();

    if let Some(value) = show_tools {
        *state.show_tools.write().await = value;
    }
    if let Some(value) = thinking_visibility {
        *state.thinking_visibility.write().await = value;
    }

    info!(
        action = "config.set",
        show_tools = show_tools.is_some(),
        thinking_visibility = thinking_visibility.is_some(),
        proposed_models = proposed_models.is_some()
    );
    if let Some(models) = proposed_models {
        *state.proposed_models.write().await = models;
    }

    if let Err(error) = save_fura_config(state).await {
        *state.show_tools.write().await = previous_show_tools;
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
    refresh_and_broadcast_presets(state).await;
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
    refresh_and_broadcast_presets(state).await;
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
    clear_conflict_contexts_for_session(state, &session_id, None).await;
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        if let Some(removed) = state
            .session_runtime
            .remove_transport(&transport_session_id)
            .await
        {
            let _ = removed.handle.stop.send(());
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
    clear_conflict_contexts_for_session(state, &session_id, None).await;

    // Stop managed child if running.
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        if let Some(removed) = state
            .session_runtime
            .remove_transport(&transport_session_id)
            .await
        {
            let _ = removed.handle.stop.send(());
        }
    }

    // Grab paths before dropping from catalog.
    let (session_file, session_worktree) = {
        let sessions = state.sessions.read().await;
        match sessions.get(&session_id) {
            Some(record) => (record.session_file.clone(), record.worktree.clone()),
            None => return vec![unknown_session_error(session_id)],
        }
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
            Ok(()) => info!(session_id = %session_id, file = %file, "deleted session file"),
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
            "Supported commands: /help, /new, /abort, /plan [prompt], /compact [instructions], /handoff [focus instructions], /rename <title>, /model [list|cycle|provider/model], /thinking [cycle|off|minimal|low|medium|high|inherit], /fork, /rebase <branch>, /session [info], /export [path]. TUI-only commands like /resume are intentionally unsupported in Fura.",
        )],
        "new" => {
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
        "compact" => {
            let mut command = serde_json::json!({ "id": next_rpc_id(), "type": "compact" });
            if !args.is_empty() {
                command["customInstructions"] = Value::String(args.to_string());
            }
            send_slash_rpc_command(state, session_id, command, "Requested session compaction.")
                .await
        }
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
        "export" => {
            let mut command = serde_json::json!({ "id": next_rpc_id(), "type": "export_html" });
            if !args.is_empty() {
                command["outputPath"] = Value::String(args.to_string());
            }
            send_slash_rpc_command(state, session_id, command, "Requested HTML export.").await
        }
        "settings" | "fast" | "browser" | "copy" | "dump" | "share" | "hotkeys" | "tools"
        | "extensions" | "agents" | "branch" | "tree" | "login" | "logout" | "mcp" | "ssh"
        | "resume" | "btw" | "background" | "bg" | "debug" | "memory" | "move" | "exit"
        | "quit" | "marketplace" | "plugins" | "reload-plugins" | "force" => vec![notice(
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

pub(crate) async fn handle_session_fork(
    state: &AppState,
    session_id: String,
    name: String,
) -> Vec<ServerMessage> {
    state
        .session_runtime
        .set_pending_session_name(session_id.clone(), name)
        .await;
    match send_rpc_command(state, &session_id, fork_command(next_rpc_id())).await {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
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
        if matches!(
            record.effective_status(),
            SessionStatus::Busy | SessionStatus::Starting
        ) {
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
    let repo_root = match crate::diff::rebase_session_repo(&cwd, branch).await {
        Ok(repo_root) => repo_root,
        Err(error) => {
            return vec![notice(
                session_id,
                NoticeLevel::Error,
                format!("Rebase onto '{branch}' failed: {error}"),
            )];
        }
    };
    // Re-baseline: a snapshot pinned at the branch tip becomes the newest snapshot, so the
    // Diffs view measures the rebased work against `<branch>` without anyone re-selecting a base.
    let snapshot_command = repo_diff_snapshot_command(
        next_rpc_id(),
        format!("rebase onto {branch}"),
        Some(repo_root.display().to_string()),
        Some(branch.to_string()),
    );
    match send_rpc_command(state, &session_id, snapshot_command).await {
        Ok(()) => vec![notice(
            session_id,
            NoticeLevel::Info,
            // The rebase is done (HEAD moved); the snapshot is fire-and-forget over RPC, so we
            // only claim it was *requested*, not that the base is already in place.
            format!("Rebased onto '{branch}'. Requested a new diff base snapshot at '{branch}'."),
        )],
        Err(error) => vec![notice(
            session_id,
            NoticeLevel::Warning,
            format!("Rebased onto '{branch}', but creating the diff snapshot failed: {error}"),
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
        "off" | "minimal" | "low" | "medium" | "high" | "inherit" => arg,
        _ => {
            return vec![notice(
                session_id,
                NoticeLevel::Error,
                "Usage: /thinking [cycle|off|minimal|low|medium|high|inherit]",
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
    images: Option<Vec<Value>>,
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

    let command = prompt_command(command_id.clone(), text, command_images, behavior);

    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => Vec::new(),
        Err(message) => {
            state
                .pending_prompt_drafts
                .write()
                .await
                .remove(&command_id);
            if suppress_optimistic_prompt {
                remove_optimistic_prompt_message(state, &session_id, &command_notice_message_id)
                    .await;
            } else {
                remove_optimistic_prompt_message(state, &session_id, &optimistic_message_id).await;
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
    images: Option<&Vec<Value>>,
) -> TranscriptMessage {
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(ContentBlock::Text { text });
    }
    if let Some(images) = images {
        for image in images {
            let data = image
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mime_type = image
                .get("mimeType")
                .or_else(|| image.get("mime_type"))
                .and_then(Value::as_str)
                .unwrap_or("image/png")
                .to_string();
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
        if matches!(
            record.effective_status(),
            SessionStatus::Starting | SessionStatus::Busy
        ) {
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
fn conflict_root_matches_repo(requested_root: &str, repo_root: &str) -> bool {
    let normalized_requested = requested_root
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let normalized_repo = repo_root
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    normalized_requested == normalized_repo
        || normalized_requested.starts_with(&format!("{normalized_repo}/"))
}

pub(crate) async fn handle_conflict_agent_run(
    state: &AppState,
    session_id: String,
    repo_id: String,
    path: String,
    expected_version: String,
    mode: ConflictAgentMode,
    scope: ConflictAgentScope,
    conflict_id: Option<String>,
    instructions: String,
) -> Vec<ServerMessage> {
    let context_id = uuid::Uuid::new_v4().to_string();
    let prepared = match prepare_conflict_agent_request(
        &context_id,
        &repo_id,
        &path,
        &expected_version,
        mode,
        scope,
        conflict_id.as_deref(),
        &instructions,
    ) {
        Ok(prepared) => prepared,
        Err(message) => {
            return vec![ServerMessage::ConflictError {
                repo_id: Some(repo_id),
                path: Some(path),
                message,
            }];
        }
    };
    let session = {
        let sessions = state.sessions.read().await;
        sessions.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return vec![unknown_session_error(session_id)];
    };

    let session_root = session
        .worktree
        .as_ref()
        .map(|worktree| worktree.path.as_str())
        .or(session.cwd.as_deref());
    let Some(session_root) = session_root else {
        return vec![ServerMessage::ConflictError {
            repo_id: Some(prepared.repo_id),
            path: Some(prepared.path),
            message: "The session opened from Conflict Resolver has no repository root."
                .to_string(),
        }];
    };
    if !conflict_root_matches_repo(session_root, &prepared.repo_root) {
        return vec![ServerMessage::ConflictError {
            repo_id: Some(prepared.repo_id),
            path: Some(prepared.path),
            message:
                "The session opened from Conflict Resolver does not match the requested conflicted repository."
                    .to_string(),
        }];
    }
    if !state.active_conflict_contexts.read().await.is_empty() {
        return vec![ServerMessage::ConflictError {
            repo_id: Some(prepared.repo_id),
            path: Some(prepared.path),
            message: "Conflict Resolver agent assistance is already in progress.".to_string(),
        }];
    }
    let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await else {
        return vec![ServerMessage::ConflictError {
            repo_id: Some(prepared.repo_id),
            path: Some(prepared.path),
            message: format!("session {session_id} has no live RPC child"),
        }];
    };
    let previous_host_tools = state
        .session_host_tools
        .read()
        .await
        .get(&transport_session_id)
        .cloned()
        .unwrap_or_default();
    let next_host_tools = conflict_host_tools_with_submission_tool(&previous_host_tools);
    let set_host_tools_command_id = next_rpc_id();
    let prompt_command_id = next_rpc_id();
    let context = ActiveConflictContext {
        transport_session_id: transport_session_id.clone(),
        session_id: session_id.clone(),
        repo_root: prepared.repo_root,
        repo_id: prepared.repo_id.clone(),
        path: prepared.path.clone(),
        source_version: prepared.source_version,
        mode: prepared.mode,
        scope: prepared.scope,
        conflict_id: prepared.conflict_id,
        original_content: prepared.original_content,
        original_conflict_count: prepared.original_conflict_count,
        selected_conflict_byte_start: prepared.selected_conflict_byte_start,
        selected_conflict_byte_end: prepared.selected_conflict_byte_end,
        previous_host_tools: previous_host_tools.clone(),
        set_host_tools_command_id: set_host_tools_command_id.clone(),
        prompt_command_id: prompt_command_id.clone(),
    };
    state
        .active_conflict_contexts
        .write()
        .await
        .insert(context_id.clone(), context);

    let setup_result = async {
        send_rpc_command(
            state,
            &transport_session_id,
            review_set_host_tools_command(set_host_tools_command_id, next_host_tools.clone()),
        )
        .await?;
        send_rpc_command(
            state,
            &transport_session_id,
            prompt_command(prompt_command_id, prepared.prompt, None, None),
        )
        .await
    }
    .await;

    match setup_result {
        Ok(()) => {
            remember_session_host_tools(state, &transport_session_id, next_host_tools).await;
            Vec::new()
        }
        Err(message) => {
            state
                .active_conflict_contexts
                .write()
                .await
                .remove(&context_id);
            remember_session_host_tools(state, &transport_session_id, previous_host_tools).await;
            vec![ServerMessage::ConflictError {
                repo_id: Some(prepared.repo_id),
                path: Some(prepared.path),
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

pub(crate) async fn remove_conflict_contexts_for_session(
    state: &AppState,
    session_id: &str,
) -> Vec<ActiveConflictContext> {
    let mut contexts = state.active_conflict_contexts.write().await;
    let mut removed = Vec::new();
    contexts.retain(|_, context| {
        if context.transport_session_id == session_id || context.session_id == session_id {
            removed.push(context.clone());
            false
        } else {
            true
        }
    });
    removed
}

pub(crate) async fn clear_conflict_contexts_for_session(
    state: &AppState,
    session_id: &str,
    message: Option<&str>,
) {
    let removed = remove_conflict_contexts_for_session(state, session_id).await;
    if let Some(context) = removed.iter().last() {
        restore_session_host_tools(
            state,
            &context.transport_session_id,
            context.previous_host_tools.clone(),
        )
        .await;
    }
    if let Some(message) = message {
        for context in removed {
            let _ = state
                .events
                .emit(
                    state,
                    ServerMessage::ConflictError {
                        repo_id: Some(context.repo_id),
                        path: Some(context.path),
                        message: message.to_string(),
                    },
                )
                .await;
        }
    }
}

pub(crate) async fn clear_conflict_context_for_command(
    state: &AppState,
    session_id: &str,
    command_id: &str,
) -> bool {
    let mut contexts = state.active_conflict_contexts.write().await;
    let mut restored_tools: Option<Vec<Value>> = None;
    contexts.retain(|_, context| {
        let matches_session = context.transport_session_id == session_id;
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

async fn take_conflict_context_by_id(
    state: &AppState,
    context_id: &str,
) -> Option<ActiveConflictContext> {
    state
        .active_conflict_contexts
        .write()
        .await
        .remove(context_id)
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
    let has_conflict_context =
        state
            .active_conflict_contexts
            .read()
            .await
            .values()
            .any(|context| {
                context.transport_session_id == transport_session_id
                    || context.session_id == transport_session_id
            });
    debug!(
        transport_session_id,
        frame_id = %frame_id,
        target_id = %target_id,
        has_review_context,
        has_conflict_context,
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
        "fura_submit_conflict_assistance" => {
            add_conflict_agent_result(state, transport_session_id, arguments).await
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

async fn add_conflict_agent_result(
    state: &AppState,
    transport_session_id: &str,
    arguments: Value,
) -> Result<String, String> {
    let context_id = required_string(&arguments, "conflictContextId")?;
    let risk = match required_string(&arguments, "risk")?.as_str() {
        "low" => ConflictAgentRisk::Low,
        "medium" => ConflictAgentRisk::Medium,
        "high" => ConflictAgentRisk::High,
        value => return Err(format!("risk must be low, medium, or high, got {value}")),
    };
    let summary = required_string(&arguments, "summary")?;
    let explanation = required_string(&arguments, "explanation")?;
    let proposed_content = match arguments.get("proposedContent") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Null) | None => None,
        Some(_) => return Err("proposedContent must be a string when provided".to_string()),
    };

    let context = state
        .active_conflict_contexts
        .read()
        .await
        .get(&context_id)
        .cloned()
        .ok_or_else(|| "conflict context is not active".to_string())?;
    let target_session_id = rpc_session_target_id(state, transport_session_id).await;
    if target_session_id != context.session_id {
        return Err(format!(
            "conflict context belongs to session {}, but host tool call came from session {}",
            context.session_id, target_session_id
        ));
    }
    let result =
        finalize_conflict_agent_result(&context, risk, summary, explanation, proposed_content)?;
    let Some(removed_context) = take_conflict_context_by_id(state, &context_id).await else {
        return Err("conflict context is no longer active".to_string());
    };
    restore_session_host_tools(
        state,
        &removed_context.transport_session_id,
        removed_context.previous_host_tools.clone(),
    )
    .await;
    let _ = state
        .events
        .emit(
            state,
            ServerMessage::ConflictAgentResult {
                result: result.clone(),
            },
        )
        .await;
    Ok(match result.mode {
        ConflictAgentMode::Explain => format!(
            "Stored conflict explanation for {} ({:?}).",
            result.path, result.scope
        ),
        ConflictAgentMode::Propose => format!(
            "Stored conflict proposal preview for {} ({:?}).",
            result.path, result.scope
        ),
    })
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
    let mut old_path: Option<String> = None;
    let mut new_path = String::new();
    let mut hunk: Option<String> = None;
    let mut old_line = 0_u32;
    let mut new_line = 0_u32;
    let mut pending_rename_from: Option<String> = None;

    for text in patch.lines() {
        if let Some(rest) = text.strip_prefix("diff --git ") {
            let (parsed_old, parsed_new) = parse_diff_git_paths(rest);
            old_path = parsed_old;
            new_path = parsed_new.unwrap_or_default();
            hunk = None;
            pending_rename_from = None;
            continue;
        }
        if let Some(path) = text.strip_prefix("rename from ") {
            pending_rename_from = Some(path.to_string());
            continue;
        }
        if let Some(path) = text.strip_prefix("rename to ") {
            old_path = pending_rename_from.clone();
            new_path = path.to_string();
            continue;
        }
        if let Some(path) = text.strip_prefix("--- a/") {
            old_path = Some(path.to_string());
            continue;
        }
        if let Some(path) = text.strip_prefix("+++ b/") {
            new_path = path.to_string();
            continue;
        }
        if text == "--- /dev/null" {
            old_path = None;
            continue;
        }
        if text == "+++ /dev/null" {
            continue;
        }
        if let Some((old_start, new_start)) = parse_hunk_header(text) {
            old_line = old_start;
            new_line = new_start;
            hunk = Some(text.to_string());
            continue;
        }
        if text.starts_with('+') && !text.starts_with("+++") {
            let location = DiffLineLocation {
                old_path: old_path.clone(),
                new_path: new_path.clone(),
                hunk: hunk.clone(),
                side: DiffSide::Right,
                kind: DiffLineKind::Add,
                old_line: None,
                new_line: Some(new_line),
                text: text.to_string(),
            };
            if requested_side == DiffSide::Right
                && requested_line == new_line
                && path_matches(&location, requested_path)
            {
                return Some(location);
            }
            new_line = new_line.saturating_add(1);
            continue;
        }
        if text.starts_with('-') && !text.starts_with("---") {
            let location = DiffLineLocation {
                old_path: old_path.clone(),
                new_path: new_path.clone(),
                hunk: hunk.clone(),
                side: DiffSide::Left,
                kind: DiffLineKind::Remove,
                old_line: Some(old_line),
                new_line: None,
                text: text.to_string(),
            };
            if requested_side == DiffSide::Left
                && requested_line == old_line
                && path_matches(&location, requested_path)
            {
                return Some(location);
            }
            old_line = old_line.saturating_add(1);
            continue;
        }
        if text.starts_with(' ') {
            let location = DiffLineLocation {
                old_path: old_path.clone(),
                new_path: new_path.clone(),
                hunk: hunk.clone(),
                side: DiffSide::Right,
                kind: DiffLineKind::Context,
                old_line: Some(old_line),
                new_line: Some(new_line),
                text: text.to_string(),
            };
            let line_matches = match requested_side {
                DiffSide::Left => requested_line == old_line,
                DiffSide::Right => requested_line == new_line,
            };
            if line_matches && path_matches(&location, requested_path) {
                return Some(location);
            }
            old_line = old_line.saturating_add(1);
            new_line = new_line.saturating_add(1);
        }
    }
    None
}

fn path_matches(location: &DiffLineLocation, requested_path: &str) -> bool {
    location.new_path == requested_path || location.old_path.as_deref() == Some(requested_path)
}

fn parse_diff_git_paths(rest: &str) -> (Option<String>, Option<String>) {
    let mut parts = rest.split_whitespace();
    let old_path = parts.next().and_then(|value| value.strip_prefix("a/"));
    let new_path = parts.next().and_then(|value| value.strip_prefix("b/"));
    (old_path.map(str::to_string), new_path.map(str::to_string))
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old_part, rest) = rest.split_once(" +")?;
    let (new_part, _) = rest.split_once(" @@")?;
    Some((parse_hunk_start(old_part)?, parse_hunk_start(new_part)?))
}

fn parse_hunk_start(part: &str) -> Option<u32> {
    part.split(',').next()?.parse().ok()
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

fn conflict_host_tools_with_submission_tool(previous_host_tools: &[Value]) -> Vec<Value> {
    let mut tools = previous_host_tools
        .iter()
        .filter(|tool| {
            tool.get("name").and_then(Value::as_str) != Some("fura_submit_conflict_assistance")
        })
        .cloned()
        .collect::<Vec<_>>();
    tools.push(conflict_tool_definition());
    tools
}

fn conflict_tool_definition() -> Value {
    json!({
        "name": "fura_submit_conflict_assistance",
        "label": "Submit Fura conflict assistance",
        "description": "Submit the explanation or proposal for the active Fura Conflict Resolver request. Fura validates scope, risk label, and preview content before showing it to the user.",
        "parameters": {
            "type": "object",
            "properties": {
                "conflictContextId": { "type": "string", "description": "The conflict context id supplied in the conflict prompt." },
                "risk": { "type": "string", "enum": ["low", "medium", "high"], "description": "Risk label for this explanation or proposal." },
                "summary": { "type": "string", "description": "One-sentence summary shown in Conflict Resolver." },
                "explanation": { "type": "string", "description": "Concise explanation, assumptions, and risks." },
                "proposedContent": { "type": "string", "description": "Full proposed file text. Required only for propose mode." }
            },
            "required": ["conflictContextId", "risk", "summary", "explanation"],
            "additionalProperties": false
        }
    })
}

fn review_endpoint_label(endpoint: &DiffEndpoint) -> String {
    match endpoint {
        DiffEndpoint::SessionStartSnapshot { snapshot } => {
            format!(
                "session snapshot {} ({})",
                snapshot.ref_name, snapshot.commit
            )
        }
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
    format!(
        "You are reviewing the full Fura diff comparison, not just the currently selected file.\n\nReview context id: {context_id}\nRepository: {}\nComparison key: {}\nBase ref: {}\nHead ref: {}\nLeft tree/commit: {}\nRight tree/commit: {}\nFiles in summary: {}\nCurrent commit: {}\nReview worktree status: {}\nReview instructions:\n{}\n\nInspect the repository and compare the supplied refs/trees yourself before commenting. When you find an issue, call fura_add_review_comment with this reviewContextId, the repo-relative path, side, line, and comment body. Fura will resolve the exact diff anchor from the refs; do not invent line numbers.",
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
    clear_conflict_contexts_for_session(
        state,
        &session_id,
        Some("Conflict Resolver agent run was aborted."),
    )
    .await;

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

#[cfg(test)]
mod review_comment_tests {
    use super::*;
    use std::{collections::HashSet, fs, path::Path, process::Command};
    use tempfile::TempDir;
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
        }
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

    fn run_git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("git command runs");
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn create_conflict_agent_test_repo() -> TempDir {
        let temp = TempDir::new().expect("temp repo created");
        let root = temp.path();
        run_git(root, &["init", "-b", "master"]);
        run_git(root, &["config", "user.email", "fura@example.invalid"]);
        run_git(root, &["config", "user.name", "Fura Test"]);
        fs::write(root.join("demo.txt"), "one\nbase\nthree\n").expect("base file written");
        run_git(root, &["add", "demo.txt"]);
        run_git(root, &["commit", "-m", "base"]);
        run_git(root, &["checkout", "-b", "ours"]);
        fs::write(root.join("demo.txt"), "one\nours\nthree\n").expect("ours file written");
        run_git(root, &["commit", "-am", "ours"]);
        run_git(root, &["checkout", "-b", "theirs", "HEAD~1"]);
        fs::write(root.join("demo.txt"), "one\ntheirs\nthree\n").expect("theirs file written");
        run_git(root, &["commit", "-am", "theirs"]);
        run_git(root, &["checkout", "ours"]);
        let output = Command::new("git")
            .current_dir(root)
            .args(["merge", "theirs"])
            .output()
            .expect("git merge runs");
        assert!(!output.status.success(), "merge should conflict");
        temp
    }

    fn conflict_result_version(root: &Path, path: &str) -> String {
        let bytes = fs::read(root.join(path)).expect("conflict result read");
        format!("{}:{}", bytes.len(), blake3::hash(&bytes).to_hex())
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
    async fn review_agent_review_start_sets_tools_and_prompts_with_patch() {
        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".to_string(), test_session_record("s1"));
        let mut stdin_rx = crate::tests::register_test_transport(&state, "s1", "s1", 8).await;
        let patch = "diff --git a/src/new.ts b/src/new.ts\n--- a/src/new.ts\n+++ b/src/new.ts\n@@ -1,1 +1,2 @@\n const old = true;\n+const next = true;\n";

        let responses = handle_client_message(
            &state,
            ClientMessage::ReviewAgentReviewStart {
                session_id: "s1".to_string(),
                state: reviewable_state(patch),
                instructions: "Review this diff carefully.".to_string(),
            },
        )
        .await;

        assert!(responses.is_empty());
        let set_host_tools = stdin_rx.recv().await.expect("set_host_tools command");
        assert_eq!(set_host_tools["type"], "set_host_tools");
        assert_eq!(
            set_host_tools["tools"][0]["name"],
            "fura_add_review_comment"
        );
        let prompt = stdin_rx.recv().await.expect("prompt command");
        assert_eq!(prompt["type"], "prompt");
        let text = prompt["message"].as_str().expect("prompt text");
        assert!(text.contains("full Fura diff comparison, not just the currently selected file"));
        assert!(text.contains("Base ref: working tree"));
        assert!(text.contains("Left tree/commit: base"));
        assert!(text.contains("Right tree/commit: head"));
        assert!(
            text.contains("Inspect the repository and compare the supplied refs/trees yourself")
        );
        assert!(!text.contains("Reviewable full diff patch:"));
        assert!(!text.contains(patch));
        assert!(text.contains("Review this diff carefully."));
        assert_eq!(state.active_review_contexts.read().await.len(), 1);
        let second = handle_client_message(
            &state,
            ClientMessage::ReviewAgentReviewStart {
                session_id: "s1".to_string(),
                state: reviewable_state(patch),
                instructions: "Start a second review".to_string(),
            },
        )
        .await;
        let [ServerMessage::Error { message, .. }] = second.as_slice() else {
            panic!("expected busy rejection for second review");
        };
        assert!(message.contains("session is busy"));
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
    async fn conflict_agent_run_sets_tools_and_prompts_selected_conflict() {
        let temp = create_conflict_agent_test_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let root_str = root.to_string_lossy().to_string();
        let expected_version = conflict_result_version(&root, "demo.txt");
        let state = crate::tests::test_state(8, None);
        let session_id = "conflict-session";
        let mut session = test_session_record(session_id);
        session.cwd = Some(root_str.clone());
        state
            .sessions
            .write()
            .await
            .insert(session_id.to_string(), session);
        let conflict_transport = "conflict-transport";
        let mut stdin_rx =
            crate::tests::register_test_transport(&state, conflict_transport, session_id, 8).await;

        let responses = handle_client_message(
            &state,
            ClientMessage::ConflictAgentRun {
                session_id: session_id.to_string(),
                repo_id: root_str,
                path: "demo.txt".to_string(),
                expected_version,
                mode: ConflictAgentMode::Propose,
                scope: ConflictAgentScope::SelectedConflict,
                conflict_id: Some("conflict-1".to_string()),
                instructions: "Prefer both branch-specific changes when safe.".to_string(),
            },
        )
        .await;

        assert!(responses.is_empty());
        let set_host_tools = stdin_rx.recv().await.expect("set_host_tools command");
        assert_eq!(set_host_tools["type"], "set_host_tools");
        assert_eq!(
            set_host_tools["tools"][0]["name"],
            "fura_submit_conflict_assistance"
        );
        let prompt = stdin_rx.recv().await.expect("prompt command");
        assert_eq!(prompt["type"], "prompt");
        let text = prompt["message"].as_str().expect("prompt text");
        assert!(text.contains("Conflict context id:"));
        assert!(text.contains("Selected conflict: conflict-1"));
        assert!(text.contains("Only the selected conflict block may change"));
        assert!(text.contains("Prefer both branch-specific changes when safe."));
        assert_eq!(state.active_conflict_contexts.read().await.len(), 1);
    }

    #[tokio::test]
    async fn conflict_host_tool_broadcasts_agent_result() {
        let temp = create_conflict_agent_test_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let root_str = root.to_string_lossy().to_string();
        let expected_version = conflict_result_version(&root, "demo.txt");
        let prepared = prepare_conflict_agent_request(
            "ctx",
            &root_str,
            "demo.txt",
            &expected_version,
            ConflictAgentMode::Propose,
            ConflictAgentScope::SelectedConflict,
            Some("conflict-1"),
            "Keep the rest untouched.",
        )
        .expect("conflict request prepared");
        let state = crate::tests::test_state(8, None);
        crate::tests::map_test_transport(&state, "transport-1", "transport-1").await;
        state.active_conflict_contexts.write().await.insert(
            "ctx".to_string(),
            ActiveConflictContext {
                transport_session_id: "transport-1".to_string(),
                session_id: "transport-1".to_string(),
                repo_root: prepared.repo_root,
                repo_id: prepared.repo_id,
                path: prepared.path,
                source_version: prepared.source_version,
                mode: prepared.mode,
                scope: prepared.scope,
                conflict_id: prepared.conflict_id,
                original_content: prepared.original_content,
                original_conflict_count: prepared.original_conflict_count,
                selected_conflict_byte_start: prepared.selected_conflict_byte_start,
                selected_conflict_byte_end: prepared.selected_conflict_byte_end,
                previous_host_tools: Vec::new(),
                set_host_tools_command_id: "set-host".to_string(),
                prompt_command_id: "prompt".to_string(),
            },
        );
        let mut events = state.events.subscribe();

        let result = dispatch_session_host_tool(
            &state,
            "transport-1",
            "fura_submit_conflict_assistance",
            json!({
                "conflictContextId": "ctx",
                "risk": "medium",
                "summary": "Merged the selected conflict and kept the rest untouched.",
                "explanation": "This resolves the selected conflict block while preserving the rest of the saved file.",
                "proposedContent": "one\nresolved\nthree\n"
            }),
        )
        .await
        .expect("conflict result stored");

        assert!(result.contains("Stored conflict proposal preview"));
        let ServerMessage::ConflictAgentResult { result } =
            events.recv().await.expect("conflict result broadcast")
        else {
            panic!("expected conflict result broadcast");
        };
        assert_eq!(result.risk, ConflictAgentRisk::Medium);
        assert_eq!(result.conflict_id.as_deref(), Some("conflict-1"));
        assert_eq!(result.content.as_deref(), Some("one\nresolved\nthree\n"));
        assert!(state.active_conflict_contexts.read().await.is_empty());
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
