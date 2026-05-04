use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, anyhow};
use git2::{Branch, BranchType, Repository, Worktree, WorktreeAddOptions, WorktreePruneOptions};
use serde_json::Value;
use tracing::{error, info, warn};

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
            worktree,
        } => create_session(state, request_id, cwd, name, args, category, worktree).await,
        ClientMessage::SessionSetCategory {
            session_id,
            category,
        } => set_session_category(state, session_id, category).await,
        ClientMessage::SessionOpen { session_file } => open_session(state, session_file).await,
        ClientMessage::SessionList => {
            info!(action = "session.list");
            refresh_session_catalog(state).await;
            let sessions = state.sessions.read().await;
            vec![sessions_snapshot_from_map(&sessions)]
        }
        ClientMessage::SessionAttach { session_id }
        | ClientMessage::StateRefresh { session_id } => {
            info!(action = "session.attach_or_refresh", session_id = %session_id);
            if let Err(message) = refresh_rpc_state(state, &session_id).await {
                warn!(session_id = %session_id, %message, "state refresh could not reach RPC child");
            }
            let sessions = state.sessions.read().await;
            match sessions.get(&session_id) {
                Some(record) => vec![ServerMessage::SessionSnapshot {
                    session_id,
                    state: record.projection(),
                }],
                None => vec![unknown_session_error(session_id)],
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
        ClientMessage::DiffOpen {
            session_id,
            repo_root,
        } => handle_diff_open(state, session_id, repo_root).await,
        ClientMessage::DiffCompare {
            session_id,
            repo_root,
            base,
            head,
            mode,
            merge_base,
            review_mode,
            commit_oid,
        } => {
            handle_diff_compare(
                state,
                session_id,
                repo_root,
                base,
                head,
                mode,
                merge_base,
                review_mode,
                commit_oid,
            )
            .await
        }
        ClientMessage::DiffReviewWorktreeEnsure {
            source_repo_root,
            base,
            head,
        } => handle_diff_review_worktree_ensure(state, source_repo_root, base, head).await,
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
        ClientMessage::PlanApprove {
            session_id,
            plan_file_path,
            final_plan_file_path,
            title,
            content,
        } => {
            handle_plan_approve(
                state,
                session_id,
                plan_file_path,
                final_plan_file_path,
                title,
                content,
            )
            .await
        }
        ClientMessage::PlanDiscuss { session_id } => handle_plan_discuss(state, session_id).await,
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
    worktree: Option<WorktreeCreateRequest>,
) -> Vec<ServerMessage> {
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
    let created_at = Timestamp::now();
    let requested_cwd = match normalize_optional_field(cwd) {
        Some(cwd) => cwd,
        None => state.default_cwd.read().await.clone(),
    };
    let mut session_worktree = None;
    let mut session_cwd = requested_cwd.clone();
    let mut default_cwd_to_save = requested_cwd;

    if let Some(worktree) = worktree {
        default_cwd_to_save = worktree.source_repo.trim().to_string();
        match create_git_worktree(worktree).await {
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
        arg_count = args.len(),
    );

    state.pending_created_sessions.write().await.insert(
        transport_id.clone(),
        PendingCreatedSession {
            cwd: Some(session_cwd.clone()),
            args: args.clone(),
            title: name.clone(),
            request_id: request_id.clone(),
            category: category.clone(),
            created_at,
            worktree: session_worktree,
        },
    );

    if let Err(error) = spawn_rpc_child(
        state.clone(),
        transport_id.clone(),
        Some(session_cwd.clone()),
        args,
        None,
    )
    .await
    {
        state
            .pending_created_sessions
            .write()
            .await
            .remove(&transport_id);
        error!(transport_session_id = %transport_id, %error, "failed to start RPC child");
        return vec![ServerMessage::Error {
            request_id,
            message: format!("failed to start RPC child: {error}"),
        }];
    }

    save_default_cwd(state, &default_cwd_to_save).await;

    // Persist the name in the OMP session file immediately after spawn. The visible
    // session appears only after OMP reports its real session id via get_state.
    if let Some(ref n) = name {
        let cmd = serde_json::json!({
            "id": next_rpc_id(),
            "type": "set_session_name",
            "name": n,
        });
        if let Err(e) = send_rpc_command(state, &transport_id, cmd).await {
            warn!(transport_session_id = %transport_id, error = %e, "failed to queue initial set_session_name");
        }
    }

    Vec::new()
}

async fn handle_plan_approve(
    state: &AppState,
    session_id: String,
    plan_file_path: String,
    final_plan_file_path: String,
    title: Option<String>,
    content: String,
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
    let execution_title = format!("Execution - {source_title}");
    state.plan_execution_carryovers.write().await.insert(
        session_id.clone(),
        PlanExecutionCarryover {
            execution_title: execution_title.clone(),
            plan_title: title,
            plan_file_path: plan_file_path.clone(),
            final_plan_file_path: final_plan_file_path.clone(),
            content,
        },
    );
    state
        .pending_new_session_names
        .write()
        .await
        .insert(session_id.clone(), execution_title);
    let command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "approve_plan_mode",
        "planFilePath": plan_file_path,
        "finalPlanFilePath": final_plan_file_path,
    });
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => {
            let snapshot = {
                let mut sessions = state.sessions.write().await;
                sessions.get_mut(&session_id).map(|record| {
                    record.pending_plan_review = None;
                    ServerMessage::SessionSnapshot {
                        session_id: session_id.clone(),
                        state: record.projection(),
                    }
                })
            };
            if let Some(snapshot) = snapshot {
                let _ = state.events.send(snapshot);
            }
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

async fn handle_plan_discuss(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    info!(action = "plan.discuss", session_id = %session_id);
    let command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "discuss_plan_mode",
    });
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => Vec::new(),
        Err(message) => vec![ServerMessage::Error {
            request_id: None,
            message,
        }],
    }
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

    let (snapshot, sessions_snapshot) = {
        let mut sessions = state.sessions.write().await;
        let Some(record) = sessions.get_mut(&session_id) else {
            return vec![unknown_session_error(session_id)];
        };
        record.category = category.clone();
        (
            ServerMessage::SessionSnapshot {
                session_id: session_id.clone(),
                state: record.projection(),
            },
            sessions_snapshot_from_map(&sessions),
        )
    };

    {
        let mut categories = state.session_categories.write().await;
        if let Some(category) = category {
            categories.insert(session_id, category);
        } else {
            categories.remove(&session_id);
        }
    }
    save_fura_config(state).await;

    vec![snapshot, sessions_snapshot]
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
        kind: SessionKind::Managed,
        model: existing.and_then(|record| record.model.clone()),
        thinking_level: existing.and_then(|record| record.thinking_level.clone()),
        tokens_total: existing.map(|record| record.tokens_total).unwrap_or(0),
        cost_usd: existing.map(|record| record.cost_usd).unwrap_or(0.0),
        context_tokens: existing.and_then(|record| record.context_tokens),
        context_window: existing.and_then(|record| record.context_window),
        context_percent: existing.and_then(|record| record.context_percent),
        plan_mode: existing.and_then(|record| record.plan_mode.clone()),
        pending_plan_review: existing.and_then(|record| record.pending_plan_review.clone()),
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
        let rpc_sessions = state.rpc_sessions.read().await;
        if rpc_sessions.contains_key(&transport_session_id) {
            let sessions = state.sessions.read().await;
            return match sessions.get(&session_id) {
                Some(record) => vec![ServerMessage::SessionSnapshot {
                    session_id,
                    state: record.projection(),
                }],
                None => vec![ServerMessage::Error {
                    request_id: None,
                    message: format!(
                        "session {session_id} is marked live but has no catalog entry"
                    ),
                }],
            };
        }
    }

    let category = state
        .session_categories
        .read()
        .await
        .get(&session_id)
        .cloned();
    let (projection, sessions_snapshot) = {
        let mut sessions = state.sessions.write().await;
        let record = opened_session_record(
            &discovered,
            session_file.clone(),
            category,
            sessions.get(&session_id),
        );
        let projection = record.projection();
        sessions.insert(session_id.clone(), record);
        (projection, sessions_snapshot_from_map(&sessions))
    };

    let transport_session_id = {
        let rpc_sessions = state.rpc_sessions.read().await;
        if rpc_sessions.contains_key(&session_id) {
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
            .rpc_session_targets
            .write()
            .await
            .insert(transport_session_id, session_id.clone());
    }

    if let Err(error) = spawn_result {
        error!(session_id = %session_id, %error, "failed to open RPC session");
        let mut sessions = state.sessions.write().await;
        if let Some(record) = sessions.get_mut(&session_id) {
            record.status = SessionStatus::Error;
        }
        return vec![
            sessions_snapshot_from_map(&sessions),
            ServerMessage::Error {
                request_id: None,
                message: format!("failed to open session {session_file}: {error}"),
            },
        ];
    }

    vec![
        sessions_snapshot,
        ServerMessage::SessionSnapshot {
            session_id,
            state: projection,
        },
    ]
}

pub(crate) async fn stop_session(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    info!(action = "session.stop", session_id = %session_id);
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        if let Some(handle) = state
            .rpc_sessions
            .write()
            .await
            .remove(&transport_session_id)
        {
            state
                .rpc_session_targets
                .write()
                .await
                .remove(&transport_session_id);
            let _ = handle.stop.send(());
        }
    }

    let mut sessions = state.sessions.write().await;
    match sessions.get_mut(&session_id) {
        Some(record) => {
            record.status = SessionStatus::Exited;
            vec![
                ServerMessage::SessionSnapshot {
                    session_id: session_id.clone(),
                    state: record.projection(),
                },
                ServerMessage::SessionExited {
                    session_id,
                    code: None,
                    signal: Some("stopped".to_string()),
                },
                sessions_snapshot_from_map(&sessions),
            ]
        }
        None => vec![unknown_session_error(session_id)],
    }
}

pub(crate) async fn delete_session(
    state: &AppState,
    session_id: String,
    delete_worktree: bool,
) -> Vec<ServerMessage> {
    info!(action = "session.delete", session_id = %session_id, delete_worktree);

    // Stop managed child if running.
    if let Some(transport_session_id) = rpc_transport_session_id(state, &session_id).await {
        if let Some(handle) = state
            .rpc_sessions
            .write()
            .await
            .remove(&transport_session_id)
        {
            state
                .rpc_session_targets
                .write()
                .await
                .remove(&transport_session_id);
            let _ = handle.stop.send(());
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
            "Supported commands: /help, /new, /abort, /plan [prompt], /compact [instructions], /handoff [focus instructions], /rename <title>, /model [list|cycle|provider/model], /thinking [cycle|off|minimal|low|medium|high|inherit], /fork, /session [info], /export [path]. TUI-only commands like /resume are intentionally unsupported in Fura.",
        )],
        "new" => {
            let (cwd, args) = {
                let sessions = state.sessions.read().await;
                sessions
                    .get(&session_id)
                    .map(|record| (record.cwd.clone(), Some(record.args.clone())))
                    .unwrap_or((None, None))
            };
            create_session(state, None, cwd, None, args, None, None).await
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
                    serde_json::json!({ "id": next_rpc_id(), "type": "set_session_name", "name": new_title }),
                )
                .await
                {
                    Err(err) => vec![notice(session_id, NoticeLevel::Error, err)],
                    Ok(()) => {
                        // OMP returns only a success ack — it does not echo the name back.
                        // Update our projection directly since we already know the new title.
                        {
                            let mut sessions = state.sessions.write().await;
                            if let Some(record) = sessions.get_mut(&session_id) {
                                record.title = Some(new_title);
                            }
                            if let Some(record) = sessions.get(&session_id) {
                                let _ = state.events.send(ServerMessage::SessionSnapshot {
                                    session_id: session_id.clone(),
                                    state: record.projection(),
                                });
                            }
                        }
                        broadcast_sessions_snapshot(state).await;
                        vec![notice(session_id, NoticeLevel::Info, "Session renamed.")]
                    }
                }
            }
        }
        "plan" => handle_plan_slash_command(state, session_id, args).await,
        "model" | "models" => handle_model_slash_command(state, session_id, args).await,
        "thinking" => handle_thinking_slash_command(state, session_id, args).await,
        "fork" => handle_fork_slash_command(state, session_id).await,
        "session" | "status" | "usage" => {
            send_slash_rpc_command(
                state,
                session_id,
                serde_json::json!({ "id": next_rpc_id(), "type": "get_session_stats" }),
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
        .pending_new_session_names
        .write()
        .await
        .insert(session_id.clone(), name);
    match send_rpc_command(
        state,
        &session_id,
        serde_json::json!({ "id": next_rpc_id(), "type": "fork" }),
    )
    .await
    {
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
        .pending_new_session_names
        .write()
        .await
        .insert(session_id.clone(), name);
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
        let command = serde_json::json!({
            "id": next_rpc_id(),
            "type": "set_plan_mode",
            "enabled": false,
        });
        return send_slash_rpc_command(state, session_id, command, "Requested plan mode exit.")
            .await;
    }

    let command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "set_plan_mode",
        "enabled": true,
        "planFilePath": "local://PLAN.md",
        "workflow": "parallel",
    });
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

    let prompt_command = serde_json::json!({
        "id": next_rpc_id(),
        "type": "prompt",
        "message": args,
        "streamingBehavior": "followUp",
    });
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
    match send_rpc_command(
        state,
        &session_id,
        serde_json::json!({ "id": next_rpc_id(), "type": "fork" }),
    )
    .await
    {
        Ok(()) => Vec::new(),
        Err(message) => vec![notice(session_id, NoticeLevel::Error, message)],
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
        serde_json::json!({ "id": next_rpc_id(), "type": "set_thinking_level", "level": level }),
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

    let snapshot = {
        let mut sessions = state.sessions.write().await;
        match sessions.get_mut(&session_id) {
            Some(record) => {
                record.status = SessionStatus::Busy;
                Some(ServerMessage::SessionSnapshot {
                    session_id: session_id.clone(),
                    state: record.projection(),
                })
            }
            None => None,
        }
    };

    let Some(snapshot) = snapshot else {
        return vec![unknown_session_error(session_id)];
    };

    let command_id = next_rpc_id();
    let command_images = images.filter(|images| !images.is_empty());
    if behavior.is_none() {
        state.pending_prompt_drafts.write().await.insert(
            command_id.clone(),
            PendingPromptDraft {
                session_id: session_id.clone(),
                text: text.clone(),
                images: command_images.clone(),
            },
        );
    }

    let command = prompt_command(command_id.clone(), text, command_images, behavior);

    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => vec![snapshot],
        Err(message) => {
            state
                .pending_prompt_drafts
                .write()
                .await
                .remove(&command_id);
            vec![
                snapshot,
                ServerMessage::Error {
                    request_id: None,
                    message,
                },
            ]
        }
    }
}

pub(crate) async fn abort_prompt(state: &AppState, session_id: String) -> Vec<ServerMessage> {
    info!(action = "prompt.abort", session_id = %session_id);
    let command = abort_command(next_rpc_id());
    let send_result = send_rpc_command(state, &session_id, command).await;

    let mut sessions = state.sessions.write().await;
    match sessions.get_mut(&session_id) {
        Some(record) => {
            record.status = SessionStatus::Idle;
            let mut responses = vec![ServerMessage::SessionSnapshot {
                session_id,
                state: record.projection(),
            }];
            if let Err(message) = send_result {
                responses.push(ServerMessage::Error {
                    request_id: None,
                    message,
                });
            }
            responses
        }
        None => vec![unknown_session_error(session_id)],
    }
}
