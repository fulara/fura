use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use git2::Repository;
use tokio::{io::AsyncReadExt, process::Command, time};
use uuid::Uuid;

use crate::*;

const GIT_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_DIFF_BYTES: usize = 2_000_000;
const MAX_DIFF_FILE_PATCH_BYTES: usize = 1_000_000;
const MAX_GIT_OUTPUT_BYTES: usize = 4_000_000;
const DEFAULT_DIFF_CONTEXT_LINES: u32 = 3;
const MAX_DIFF_CONTEXT_LINES: u32 = 200;

#[derive(Debug, Default)]
pub(crate) struct DiffReviewWorktreeRegistry {
    by_id: HashMap<String, DiffReviewWorktree>,
    by_source_repo: HashMap<PathBuf, String>,
}

pub(crate) async fn handle_session_changes_request(
    state: &AppState,
    client_id: String,
    diff_id: String,
    session_id: String,
    repo_id: Option<String>,
    change_kind: GitChangeKind,
    detail_mode: DiffDetailMode,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    context_lines: Option<u32>,
) -> Vec<ServerMessage> {
    if let Err(error) = validate_diff_id(&diff_id) {
        return vec![diff_error(
            Some(client_id),
            Some(diff_id),
            DiffErrorScope::SessionChanges,
            Some(session_id),
            None,
            error,
        )];
    }
    let request = DiffRequestIdentity::SessionChanges {
        client_id: client_id.clone(),
        diff_id: diff_id.clone(),
        session_id: session_id.clone(),
        repo_id: repo_id.clone(),
        change_kind,
        detail_mode,
        current_commit_oid: current_commit_oid.clone(),
        selected_file: selected_file.clone(),
        context_lines,
    };
    start_session_changes_generation_job(
        state,
        client_id,
        diff_id,
        session_id,
        repo_id,
        change_kind,
        detail_mode,
        current_commit_oid,
        selected_file,
        request,
        context_lines,
    )
    .await;
    Vec::new()
}

pub(crate) async fn handle_compare_diff_request(
    state: &AppState,
    client_id: String,
    diff_id: String,
    repo_root: String,
    base: DiffRefInput,
    head: DiffRefInput,
    detail_mode: DiffDetailMode,
    merge_base: Option<bool>,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    context_lines: Option<u32>,
) -> Vec<ServerMessage> {
    if let Err(error) = validate_diff_id(&diff_id) {
        return vec![diff_error(
            Some(client_id),
            Some(diff_id),
            DiffErrorScope::CompareDiff,
            None,
            Some(repo_root),
            error,
        )];
    }
    let request = DiffRequestIdentity::CompareDiff {
        client_id: client_id.clone(),
        diff_id: diff_id.clone(),
        repo_root: repo_root.clone(),
        base: base.clone(),
        head: head.clone(),
        detail_mode,
        merge_base,
        current_commit_oid: current_commit_oid.clone(),
        selected_file: selected_file.clone(),
        context_lines,
    };
    start_compare_generation_job(
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
        request,
        context_lines,
    )
    .await;
    Vec::new()
}

pub(crate) async fn handle_diff_cancel(
    state: &AppState,
    client_id: String,
    diff_id: String,
    scope: DiffScope,
    reason: Option<String>,
) -> Vec<ServerMessage> {
    let _ = cancel_current_diff(state, &client_id, scope, &diff_id, reason).await;
    Vec::new()
}

fn validate_diff_id(diff_id: &str) -> anyhow::Result<()> {
    Uuid::parse_str(diff_id)
        .map(|_| ())
        .with_context(|| format!("invalid diffId UUID: {diff_id}"))
}

pub(crate) async fn handle_diff_content_request(
    state: &AppState,
    client_id: String,
    diff_id: String,
    scope: DiffScope,
    session_id: Option<String>,
    comparison_key: String,
    selected_file: Option<DiffFileSelector>,
    context_lines: Option<u32>,
) -> Vec<ServerMessage> {
    if let Err(error) = validate_diff_id(&diff_id) {
        return vec![diff_error(
            Some(client_id),
            Some(diff_id),
            match scope {
                DiffScope::SessionChanges => DiffErrorScope::SessionChanges,
                DiffScope::CompareDiff => DiffErrorScope::CompareDiff,
            },
            session_id.clone(),
            None,
            error,
        )];
    }
    let Some(prepared) = current_prepared_diff(state, &client_id, scope, &diff_id).await else {
        return vec![diff_error(
            Some(client_id),
            Some(diff_id),
            match scope {
                DiffScope::SessionChanges => DiffErrorScope::SessionChanges,
                DiffScope::CompareDiff => DiffErrorScope::CompareDiff,
            },
            session_id.clone(),
            None,
            anyhow!("diff summary is not ready for content loading"),
        )];
    };
    if prepared.comparison.comparison_key != comparison_key {
        return vec![diff_error(
            Some(client_id),
            Some(diff_id),
            match scope {
                DiffScope::SessionChanges => DiffErrorScope::SessionChanges,
                DiffScope::CompareDiff => DiffErrorScope::CompareDiff,
            },
            session_id.clone(),
            Some(prepared.repo_root.display().to_string()),
            anyhow!("diff content request does not match the prepared comparison"),
        )];
    }
    start_diff_content_job(
        state,
        client_id,
        diff_id,
        scope,
        session_id,
        prepared,
        selected_file,
        context_lines,
    )
    .await;
    Vec::new()
}

fn normalize_diff_context_lines(context_lines: Option<u32>) -> u32 {
    context_lines
        .unwrap_or(DEFAULT_DIFF_CONTEXT_LINES)
        .clamp(0, MAX_DIFF_CONTEXT_LINES)
}

fn diff_error(
    target_client_id: Option<String>,
    diff_id: Option<String>,
    scope: DiffErrorScope,
    session_id: Option<String>,
    repo_root: Option<String>,
    error: anyhow::Error,
) -> ServerMessage {
    ServerMessage::DiffError {
        target_client_id,
        diff_id,
        scope,
        session_id,
        repo_root,
        message: error.to_string(),
    }
}

pub(crate) async fn handle_diff_review_worktree_ensure(
    state: &AppState,
    source_repo_root: String,
    target: Option<DiffCheckoutTarget>,
) -> Vec<ServerMessage> {
    match ensure_review_worktree(state, &source_repo_root, target).await {
        Ok(worktree) => vec![ServerMessage::DiffReviewWorktreeState { worktree }],
        Err(error) => vec![diff_error(
            None,
            None,
            DiffErrorScope::ReviewWorktree,
            None,
            Some(source_repo_root),
            error,
        )],
    }
}

pub(crate) async fn handle_diff_review_worktree_checkout(
    state: &AppState,
    worktree_id: String,
    ref_target: DiffCheckoutTarget,
) -> Vec<ServerMessage> {
    match checkout_review_worktree(state, &worktree_id, ref_target).await {
        Ok(worktree) => vec![ServerMessage::DiffReviewWorktreeState { worktree }],
        Err(error) => vec![diff_error(
            None,
            None,
            DiffErrorScope::ReviewWorktree,
            None,
            None,
            error,
        )],
    }
}

fn is_expected_missing_session_changes(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    text == "missing repository for session changes"
}

#[derive(Clone)]
pub(crate) struct PreparedDiff {
    repo_root: PathBuf,
    left_tree_or_commit: String,
    right_tree_or_commit: String,
    comparison: DiffComparisonIdentity,
    review: CommitStepState,
    review_worktree: Option<DiffReviewWorktree>,
}

async fn next_diff_job_token(state: &AppState) -> u64 {
    let mut jobs = state.diff_jobs.write().await;
    jobs.next_token = jobs.next_token.saturating_add(1);
    jobs.next_token
}

async fn current_prepared_diff(
    state: &AppState,
    client_id: &str,
    scope: DiffScope,
    diff_id: &str,
) -> Option<Arc<PreparedDiff>> {
    let jobs = state.diff_jobs.read().await;
    jobs.state_generations
        .get(&(client_id.to_string(), scope))
        .filter(|job| job.diff_id == diff_id)
        .and_then(|job| job.prepared.clone())
}

async fn is_current_generation(
    state: &AppState,
    client_id: &str,
    scope: DiffScope,
    diff_id: &str,
    token: u64,
) -> bool {
    let jobs = state.diff_jobs.read().await;
    jobs.state_generations
        .get(&(client_id.to_string(), scope))
        .is_some_and(|job| job.diff_id == diff_id && job.token == token)
}

fn abort_file_patch_jobs_for_diff(
    jobs: &mut DiffJobRegistry,
    client_id: &str,
    scope: DiffScope,
    diff_id: &str,
) {
    let patch_keys: Vec<_> = jobs
        .file_patches
        .keys()
        .filter(|(patch_client, patch_scope, patch_diff_id, _)| {
            patch_client == client_id && *patch_scope == scope && patch_diff_id == diff_id
        })
        .cloned()
        .collect();
    for key in patch_keys {
        if let Some(job) = jobs.file_patches.remove(&key) {
            job.handle.abort();
        }
    }
}

async fn register_generation_job(
    state: &AppState,
    client_id: String,
    scope: DiffScope,
    diff_id: String,
    token: u64,
    handle: tokio::task::JoinHandle<()>,
) {
    let mut cancelled_diff_id = None;
    {
        let mut jobs = state.diff_jobs.write().await;
        let key = (client_id.clone(), scope);
        if let Some(mut previous) = jobs.state_generations.remove(&key) {
            if let Some(previous_handle) = previous.handle.take() {
                previous_handle.abort();
            }
            abort_file_patch_jobs_for_diff(&mut jobs, &client_id, scope, &previous.diff_id);
            if previous.diff_id != diff_id {
                cancelled_diff_id = Some(previous.diff_id.clone());
            }
            jobs.state_generations.insert(
                key,
                DiffStateGenerationJob {
                    token,
                    diff_id: diff_id.clone(),
                    prepared: if previous.diff_id == diff_id {
                        previous.prepared
                    } else {
                        None
                    },
                    handle: Some(handle),
                },
            );
        } else {
            jobs.state_generations.insert(
                key,
                DiffStateGenerationJob {
                    token,
                    diff_id: diff_id.clone(),
                    prepared: None,
                    handle: Some(handle),
                },
            );
        }
    }
    if let Some(cancelled_diff_id) = cancelled_diff_id {
        let _ = state
            .events
            .emit(
                state,
                ServerMessage::DiffCancelled {
                    target_client_id: client_id,
                    diff_id: cancelled_diff_id,
                    scope,
                    reason: Some("replaced".to_string()),
                },
            )
            .await;
    }
}

async fn register_file_patch_job(
    state: &AppState,
    key: (String, DiffScope, String, String),
    token: u64,
    handle: tokio::task::JoinHandle<()>,
) {
    let mut jobs = state.diff_jobs.write().await;
    if let Some(previous) = jobs
        .file_patches
        .insert(key, DiffFilePatchJob { token, handle })
    {
        previous.handle.abort();
    }
}

async fn store_prepared_generation(
    state: &AppState,
    client_id: &str,
    scope: DiffScope,
    diff_id: &str,
    token: u64,
    prepared: Arc<PreparedDiff>,
) -> bool {
    let mut jobs = state.diff_jobs.write().await;
    let Some(current) = jobs
        .state_generations
        .get_mut(&(client_id.to_string(), scope))
    else {
        return false;
    };
    if current.diff_id != diff_id || current.token != token {
        return false;
    }
    current.prepared = Some(prepared);
    true
}

async fn clear_generation_handle(
    state: &AppState,
    client_id: &str,
    scope: DiffScope,
    diff_id: &str,
    token: u64,
) {
    let mut jobs = state.diff_jobs.write().await;
    if let Some(current) = jobs
        .state_generations
        .get_mut(&(client_id.to_string(), scope))
    {
        if current.diff_id == diff_id && current.token == token {
            current.handle = None;
        }
    }
}

async fn finish_file_patch_job(
    state: &AppState,
    key: &(String, DiffScope, String, String),
    token: u64,
) {
    let mut jobs = state.diff_jobs.write().await;
    if jobs
        .file_patches
        .get(key)
        .is_some_and(|current| current.token == token)
    {
        jobs.file_patches.remove(key);
    }
}

async fn cancel_current_diff(
    state: &AppState,
    client_id: &str,
    scope: DiffScope,
    diff_id: &str,
    reason: Option<String>,
) -> bool {
    let cancelled = {
        let mut jobs = state.diff_jobs.write().await;
        let key = (client_id.to_string(), scope);
        let Some(current) = jobs.state_generations.get(&key) else {
            return false;
        };
        if current.diff_id != diff_id {
            return false;
        }
        if let Some(current) = jobs.state_generations.remove(&key) {
            if let Some(handle) = current.handle {
                handle.abort();
            }
        }
        abort_file_patch_jobs_for_diff(&mut jobs, client_id, scope, diff_id);
        true
    };
    if cancelled {
        let _ = state
            .events
            .emit(
                state,
                ServerMessage::DiffCancelled {
                    target_client_id: client_id.to_string(),
                    diff_id: diff_id.to_string(),
                    scope,
                    reason,
                },
            )
            .await;
    }
    cancelled
}

fn file_patch_key(file: &DiffFileSelector) -> String {
    format!(
        "{}\0{}",
        file.old_path.as_deref().unwrap_or(""),
        file.new_path
    )
}

fn diff_content_key(file: Option<&DiffFileSelector>) -> String {
    file.map(file_patch_key)
        .unwrap_or_else(|| "\0aggregate".to_string())
}

pub(crate) async fn start_session_changes_generation_job(
    state: &AppState,
    client_id: String,
    diff_id: String,
    session_id: String,
    repo_id: Option<String>,
    change_kind: GitChangeKind,
    detail_mode: DiffDetailMode,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    request: DiffRequestIdentity,
    context_lines: Option<u32>,
) {
    let generation_token = next_diff_job_token(state).await;
    let job_state = state.clone();
    let job_client_id = client_id.clone();
    let job_diff_id = diff_id.clone();
    let cleanup_client_id = client_id.clone();
    let cleanup_diff_id = diff_id.clone();
    let handle = tokio::spawn(async move {
        let result = build_session_changes_summary(
            &job_state,
            job_client_id.clone(),
            job_diff_id.clone(),
            session_id.clone(),
            repo_id,
            change_kind,
            detail_mode,
            current_commit_oid,
            selected_file.clone(),
            request.clone(),
            context_lines,
        )
        .await;
        match result {
            Ok((message, prepared)) => {
                let prepared = Arc::new(prepared);
                if store_prepared_generation(
                    &job_state,
                    &job_client_id,
                    DiffScope::SessionChanges,
                    &job_diff_id,
                    generation_token,
                    prepared.clone(),
                )
                .await
                {
                    let _ = job_state
                        .events
                        .emit_many(
                            &job_state,
                            vec![
                                message,
                                ServerMessage::DiffComplete {
                                    target_client_id: job_client_id,
                                    diff_id: job_diff_id,
                                    scope: DiffScope::SessionChanges,
                                },
                            ],
                        )
                        .await;
                }
            }
            Err(error) if is_expected_missing_session_changes(&error) => {}
            Err(error) => {
                if is_current_generation(
                    &job_state,
                    &job_client_id,
                    DiffScope::SessionChanges,
                    &job_diff_id,
                    generation_token,
                )
                .await
                {
                    let _ = job_state
                        .events
                        .emit(
                            &job_state,
                            diff_error(
                                Some(job_client_id),
                                Some(job_diff_id),
                                DiffErrorScope::SessionChanges,
                                Some(session_id),
                                None,
                                error,
                            ),
                        )
                        .await;
                }
            }
        }
        clear_generation_handle(
            &job_state,
            &cleanup_client_id,
            DiffScope::SessionChanges,
            &cleanup_diff_id,
            generation_token,
        )
        .await;
    });
    register_generation_job(
        state,
        client_id,
        DiffScope::SessionChanges,
        diff_id,
        generation_token,
        handle,
    )
    .await;
}

async fn start_diff_content_job(
    state: &AppState,
    client_id: String,
    diff_id: String,
    scope: DiffScope,
    session_id: Option<String>,
    prepared: Arc<PreparedDiff>,
    selected_file: Option<DiffFileSelector>,
    context_lines: Option<u32>,
) {
    let key = (
        client_id.clone(),
        scope,
        diff_id.clone(),
        diff_content_key(selected_file.as_ref()),
    );
    let token = next_diff_job_token(state).await;
    let job_state = state.clone();
    let key_for_task = key.clone();
    let handle = tokio::spawn(async move {
        send_diff_content_for_prepared(
            &job_state,
            client_id,
            diff_id,
            scope,
            session_id,
            prepared,
            selected_file,
            context_lines,
        )
        .await;
        finish_file_patch_job(&job_state, &key_for_task, token).await;
    });
    register_file_patch_job(state, key, token, handle).await;
}

async fn start_compare_generation_job(
    state: &AppState,
    client_id: String,
    diff_id: String,
    repo_root: String,
    base: DiffRefInput,
    head: DiffRefInput,
    detail_mode: DiffDetailMode,
    merge_base: Option<bool>,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    request: DiffRequestIdentity,
    context_lines: Option<u32>,
) {
    let generation_token = next_diff_job_token(state).await;
    let job_state = state.clone();
    let job_client_id = client_id.clone();
    let job_diff_id = diff_id.clone();
    let cleanup_client_id = client_id.clone();
    let cleanup_diff_id = diff_id.clone();
    let handle = tokio::spawn(async move {
        let result = build_compare_summary(
            &job_state,
            job_client_id.clone(),
            job_diff_id.clone(),
            repo_root.clone(),
            base,
            head,
            detail_mode,
            merge_base,
            current_commit_oid,
            selected_file.clone(),
            request,
            context_lines,
        )
        .await;
        match result {
            Ok((message, prepared)) => {
                let prepared = Arc::new(prepared);
                if store_prepared_generation(
                    &job_state,
                    &job_client_id,
                    DiffScope::CompareDiff,
                    &job_diff_id,
                    generation_token,
                    prepared.clone(),
                )
                .await
                {
                    let _ = job_state
                        .events
                        .emit_many(
                            &job_state,
                            vec![
                                message,
                                ServerMessage::DiffComplete {
                                    target_client_id: job_client_id,
                                    diff_id: job_diff_id,
                                    scope: DiffScope::CompareDiff,
                                },
                            ],
                        )
                        .await;
                }
            }
            Err(error) => {
                if is_current_generation(
                    &job_state,
                    &job_client_id,
                    DiffScope::CompareDiff,
                    &job_diff_id,
                    generation_token,
                )
                .await
                {
                    let _ = job_state
                        .events
                        .emit(
                            &job_state,
                            diff_error(
                                Some(job_client_id),
                                Some(job_diff_id),
                                DiffErrorScope::CompareDiff,
                                None,
                                Some(repo_root),
                                error,
                            ),
                        )
                        .await;
                }
            }
        }
        clear_generation_handle(
            &job_state,
            &cleanup_client_id,
            DiffScope::CompareDiff,
            &cleanup_diff_id,
            generation_token,
        )
        .await;
    });
    register_generation_job(
        state,
        client_id,
        DiffScope::CompareDiff,
        diff_id,
        generation_token,
        handle,
    )
    .await;
}

fn select_session_repo(
    candidates: &[SessionRepoCandidate],
    selected_repo_id: Option<&str>,
) -> Option<SessionRepoCandidate> {
    if let Some(repo_id) = selected_repo_id {
        return candidates
            .iter()
            .find(|candidate| candidate.id == repo_id)
            .cloned();
    }
    candidates
        .iter()
        .find(|candidate| candidate.is_default)
        .or_else(|| candidates.first())
        .cloned()
}

pub(crate) fn discover_repo_root(path: &str) -> anyhow::Result<PathBuf> {
    let root = PathBuf::from(path)
        .canonicalize()
        .with_context(|| format!("failed to resolve repo path: {path}"))?;
    let repo = Repository::discover(&root)
        .with_context(|| format!("not a git repository: {}", root.display()))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| anyhow!("bare git repositories are not supported"))?
        .canonicalize()
        .context("failed to resolve git repository root")?;
    Ok(workdir)
}

async fn build_session_changes_summary(
    state: &AppState,
    client_id: String,
    diff_id: String,
    session_id: String,
    selected_repo_id: Option<String>,
    change_kind: GitChangeKind,
    detail_mode: DiffDetailMode,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    request: DiffRequestIdentity,
    context_lines: Option<u32>,
) -> anyhow::Result<(ServerMessage, PreparedDiff)> {
    let (repos, selected_repo_id, prepared) = prepare_session_changes_diff(
        state,
        client_id.clone(),
        diff_id.clone(),
        session_id.clone(),
        selected_repo_id,
        change_kind,
        detail_mode,
        current_commit_oid,
        selected_file,
        request.clone(),
        context_lines,
    )
    .await?;
    let summary = build_summary_payload(
        &prepared.repo_root,
        &prepared.left_tree_or_commit,
        &prepared.right_tree_or_commit,
    )
    .await?;
    Ok((
        ServerMessage::SessionChangesSummary {
            state: SessionChangesSummaryState::Ready {
                target_client_id: client_id,
                diff_id,
                request,
                comparison: prepared.comparison.clone(),
                session_id,
                repos,
                selected_repo_id,
                summary,
                review: prepared.review.clone(),
                review_worktree: prepared.review_worktree.clone(),
            },
        },
        prepared,
    ))
}

async fn prepare_session_changes_diff(
    state: &AppState,
    client_id: String,
    diff_id: String,
    session_id: String,
    selected_repo_id: Option<String>,
    change_kind: GitChangeKind,
    detail_mode: DiffDetailMode,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    request: DiffRequestIdentity,
    context_lines: Option<u32>,
) -> anyhow::Result<(Vec<SessionRepoCandidate>, String, PreparedDiff)> {
    let candidates = crate::session_repos::session_repo_candidates(state, &session_id).await?;
    if candidates.is_empty() {
        let _ = state
            .events
            .emit(
                state,
                ServerMessage::SessionChangesSummary {
                    state: SessionChangesSummaryState::MissingRepo {
                        target_client_id: client_id,
                        diff_id,
                        request,
                        session_id,
                        repo_root: None,
                        reason: "Fura could not identify a git repository for this session."
                            .to_string(),
                        repos: candidates,
                    },
                },
            )
            .await;
        bail!("missing repository for session changes");
    }
    let selected = select_session_repo(&candidates, selected_repo_id.as_deref())
        .ok_or_else(|| anyhow!("Selected repository is not available for this session."))?;
    let repo_root_text = selected.repo_root.clone();
    let repo_root = discover_repo_root(&repo_root_text)?;
    if let Some(oid) = current_commit_oid {
        let prepared = prepare_commit_review(
            state,
            repo_root,
            &oid,
            detail_mode,
            selected_file,
            context_lines,
        )
        .await?;
        return Ok((candidates, selected.id, prepared));
    }
    let (left, right, base, head) = git_change_range(&repo_root, change_kind).await?;
    let prepared = prepare_git_changes(
        state,
        repo_root,
        left,
        right,
        base,
        head,
        detail_mode,
        selected_file,
        context_lines,
    )
    .await?;
    Ok((candidates, selected.id, prepared))
}

async fn git_change_range(
    repo: &Path,
    kind: GitChangeKind,
) -> anyhow::Result<(String, String, DiffEndpoint, DiffEndpoint)> {
    let (left, mode, base, head) = match kind {
        GitChangeKind::Unstaged => (
            "INDEX".to_string(),
            "unstaged",
            DiffEndpoint::Index,
            DiffEndpoint::WorkingTree,
        ),
        GitChangeKind::Untracked => (
            "EMPTY".to_string(),
            "untracked",
            DiffEndpoint::EmptyTree,
            DiffEndpoint::WorkingTree,
        ),
        GitChangeKind::Staged => {
            let repository = Repository::open(repo)?;
            let unborn = repository
                .head()
                .err()
                .is_some_and(|error| error.code() == git2::ErrorCode::UnbornBranch);
            if unborn {
                (
                    "EMPTY".to_string(),
                    "staged",
                    DiffEndpoint::EmptyTree,
                    DiffEndpoint::Index,
                )
            } else {
                let reference = resolve_git_ref(repo, "HEAD").await?;
                (
                    oid_for_diff(&reference)?.to_string(),
                    "staged",
                    endpoint_from_resolved(&reference),
                    DiffEndpoint::Index,
                )
            }
        }
    };
    let right = mutable_identity(repo, &left, mode).await?;
    Ok((left, right, base, head))
}

async fn prepare_git_changes(
    state: &AppState,
    repo_root: PathBuf,
    left: String,
    right: String,
    base: DiffEndpoint,
    head: DiffEndpoint,
    detail_mode: DiffDetailMode,
    selected_file: Option<DiffFileSelector>,
    context_lines: Option<u32>,
) -> anyhow::Result<PreparedDiff> {
    let comparison = DiffComparisonIdentity {
        repo_root: repo_root.display().to_string(),
        base,
        head,
        left_tree_or_commit: left.clone(),
        right_tree_or_commit: right.clone(),
        detail_mode,
        current_commit_oid: None,
        selected_file,
        context_lines: normalize_diff_context_lines(context_lines),
        generated_at: Timestamp::now().millis().to_string(),
        comparison_key: format!("{}:{left}:{right}:{detail_mode:?}", repo_root.display()),
        displayed_patch_range: None,
    };
    let review_worktree = current_review_worktree(state, &repo_root).await;
    Ok(PreparedDiff {
        repo_root,
        left_tree_or_commit: left,
        right_tree_or_commit: right,
        comparison,
        review: CommitStepState {
            commits: Vec::new(),
            current_commit_oid: None,
            current_commit_index: None,
            previous_commit_oid: None,
        },
        review_worktree,
    })
}

// Mutable endpoints are deliberately not Git refs. Their fingerprint travels with review
// contexts, so lazy reads and agent comment anchoring cannot silently target a newer patch.
fn mutable_kind(right: &str) -> anyhow::Result<Option<&str>> {
    let Some(value) = right.strip_prefix("fura:") else {
        return Ok(None);
    };
    let (kind, hash) = value
        .split_once(':')
        .ok_or_else(|| anyhow!("invalid Git change identity"))?;
    if !matches!(kind, "unstaged" | "staged" | "untracked" | "worktree")
        || hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("invalid Git change identity");
    }
    Ok(Some(kind))
}

fn range_diff_args<'a>(left: &'a str, kind: Option<&str>, right: &'a str) -> Vec<&'a str> {
    let mut args = vec![
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames=50%",
        "--diff-algorithm=myers",
        "--no-indent-heuristic",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--submodule=short",
    ];
    match kind {
        Some("unstaged") => {}
        Some("staged") => {
            args.push("--cached");
            if left != "EMPTY" {
                args.push(left);
            }
        }
        Some("worktree") => args.push(left),
        Some("untracked") => {}
        _ if left == "EMPTY" => {
            args[0] = "diff-tree";
            args.extend(["--root", "--no-commit-id", "-r", right]);
        }
        _ => {
            args.push(left);
            args.push(right);
        }
    }
    args
}

async fn run_range_diff(
    repo: &Path,
    left: &str,
    right: &str,
    options: &[&str],
    paths: &[&str],
    limit: usize,
) -> anyhow::Result<(String, bool)> {
    let kind = mutable_kind(right)?;
    let collisions = if kind == Some("worktree") {
        worktree_restored_paths(repo, left).await?
    } else {
        Vec::new()
    };
    let mut args = range_diff_args(left, kind, right);
    args.extend_from_slice(options);
    args.push("--");
    let pathspecs: Vec<String> = paths
        .iter()
        .map(|path| format!(":(literal){path}"))
        .chain(
            collisions
                .iter()
                .map(|path| format!(":(exclude,literal){path}")),
        )
        .collect();
    if collisions.is_empty() {
        args.extend_from_slice(paths);
    } else {
        args.insert(0, "--no-literal-pathspecs");
        args.extend(pathspecs.iter().map(String::as_str));
    }
    let (mut output, mut truncated) = git_stdout_limited(repo, &args, limit).await?;
    if !truncated {
        for path in collisions {
            if !paths.is_empty() && !paths.contains(&path.as_str()) {
                continue;
            }
            let (net, limited) =
                restored_worktree_diff(repo, left, &path, options, limit - output.len()).await?;
            output.push_str(&net);
            truncated |= limited;
            if truncated {
                break;
            }
        }
    }
    Ok((output, truncated))
}

async fn worktree_restored_paths(repo: &Path, base: &str) -> anyhow::Result<Vec<String>> {
    let untracked = untracked_paths(repo).await?;
    let repository = Repository::open(repo)?;
    let tree = repository.revparse_single(base)?.peel_to_tree()?;
    Ok(untracked
        .into_iter()
        .filter(|path| {
            tree.get_path(Path::new(path))
                .is_ok_and(|entry| entry.kind() == Some(git2::ObjectType::Blob))
        })
        .collect())
}

// Only reconcile paths Git's index-based diff reports as deleted despite their
// presence on disk. libgit2's tree-to-workdir operation explicitly ignores the index;
// its built-in Git normalization applies, but no configured external helper is run.
async fn restored_worktree_diff(
    repo: &Path,
    base: &str,
    path: &str,
    options: &[&str],
    limit: usize,
) -> anyhow::Result<(String, bool)> {
    let full = contained_diff_path(repo, path)?;
    let metadata = fs::symlink_metadata(&full)?;
    let size: u64 = git_stdout(repo, &["cat-file", "-s", &format!("{base}:{path}")], 128)
        .await?
        .trim()
        .parse()?;
    if size > MAX_DIFF_FILE_PATCH_BYTES as u64 || metadata.len() > MAX_DIFF_FILE_PATCH_BYTES as u64
    {
        bail!(
            "Restored untracked path {path:?} exceeds the 1 MB net comparison limit; review an immutable commit or restore tracking"
        );
    }
    let repository = Repository::open(repo)?;
    let tree = repository.revparse_single(base)?.peel_to_tree()?;
    let mut opts = git2::DiffOptions::new();
    opts.disable_pathspec_match(true)
        .pathspec(path)
        .include_typechange(true);
    if let Some(context) = options
        .iter()
        .find_map(|option| option.strip_prefix("--unified="))
    {
        opts.context_lines(context.parse()?);
    }
    let diff = repository.diff_tree_to_workdir(Some(&tree), Some(&mut opts))?;
    let mut output = Vec::new();
    if options.contains(&"--stat") {
        output.extend_from_slice(&diff.stats()?.to_buf(git2::DiffStatsFormat::FULL, 80)?);
    } else if options.contains(&"--numstat") || options.contains(&"--name-status") {
        for (index, delta) in diff.deltas().enumerate() {
            if delta.status() == git2::Delta::Unmodified {
                continue;
            }
            if options.contains(&"--numstat") {
                let patch = git2::Patch::from_diff(&diff, index)?;
                let counts = match patch {
                    Some(patch)
                        if !patch.delta().old_file().is_binary()
                            && !patch.delta().new_file().is_binary() =>
                    {
                        let (_, added, removed) = patch.line_stats()?;
                        format!("{added}\t{removed}")
                    }
                    _ => "-\t-".to_string(),
                };
                output.extend_from_slice(format!("{counts}\t{path}\0").as_bytes());
            } else {
                let status = match delta.status() {
                    git2::Delta::Deleted => "D",
                    git2::Delta::Added => "A",
                    git2::Delta::Typechange => "T",
                    _ => "M",
                };
                output.extend_from_slice(format!("{status}\0{path}\0").as_bytes());
            }
        }
    } else {
        let mut truncated = false;
        let result = diff.print(git2::DiffFormat::Patch, |_, _, line| {
            let prefix = matches!(line.origin(), '+' | '-' | ' ');
            if output.len() + line.content().len() + usize::from(prefix) > limit {
                truncated = true;
                return false;
            }
            if prefix {
                output.push(line.origin() as u8);
            }
            output.extend_from_slice(line.content());
            true
        });
        if !truncated {
            result?;
        }
        return Ok((String::from_utf8_lossy(&output).into_owned(), truncated));
    }
    let truncated = output.len() > limit;
    output.truncate(limit);
    Ok((String::from_utf8_lossy(&output).into_owned(), truncated))
}

async fn untracked_paths(repo: &Path) -> anyhow::Result<Vec<String>> {
    Ok(git_stdout(
        repo,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await?
    .split_terminator('\0')
    .filter(|path| !path.ends_with('/'))
    .map(str::to_string)
    .collect())
}

async fn reject_worktree_filters(repo: &Path, depth: usize) -> anyhow::Result<()> {
    if depth > 16 {
        bail!("Submodule nesting exceeds the safe Git read limit");
    }
    let config = git_stdout(repo, &["config", "--null", "--list"], MAX_GIT_OUTPUT_BYTES).await?;
    let active: Vec<&str> = config
        .split_terminator('\0')
        .filter_map(|entry| {
            let (key, value) = entry.split_once('\n')?;
            if value.is_empty() {
                return None;
            }
            key.strip_prefix("filter.")?
                .strip_suffix(".clean")
                .or_else(|| key.strip_prefix("filter.")?.strip_suffix(".process"))
        })
        .collect();
    if !active.is_empty() {
        let paths = git_stdout(
            repo,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            MAX_GIT_OUTPUT_BYTES,
        )
        .await?;
        let paths: Vec<_> = paths.split_terminator('\0').collect();
        for chunk in paths.chunks(100) {
            let mut args = vec!["check-attr", "-z", "filter", "--"];
            args.extend_from_slice(chunk);
            let attrs = git_stdout(repo, &args, MAX_GIT_OUTPUT_BYTES).await?;
            let fields: Vec<_> = attrs.split_terminator('\0').collect();
            for attr in fields.chunks_exact(3) {
                if active.contains(&attr[2]) {
                    bail!(
                        "Working-tree review refused: {} uses configured clean/process filter {:?} for {:?}. Disable that filter to review working-tree changes, or select an immutable commit in History.",
                        repo.display(),
                        attr[2],
                        attr[0]
                    );
                }
            }
        }
    }
    let index = git_stdout(repo, &["ls-files", "--stage", "-z"], MAX_GIT_OUTPUT_BYTES).await?;
    for entry in index
        .split_terminator('\0')
        .filter(|entry| entry.starts_with("160000 "))
    {
        if let Some((_, path)) = entry.split_once('\t') {
            let sub = contained_diff_path(repo, path)?;
            if sub.join(".git").exists() {
                Box::pin(reject_worktree_filters(&sub, depth + 1)).await?;
            }
        }
    }
    Ok(())
}

async fn mutable_identity(repo: &Path, left: &str, kind: &str) -> anyhow::Result<String> {
    time::timeout(GIT_TIMEOUT, mutable_identity_inner(repo, left, kind))
        .await
        .context("Git change identity timed out; reduce working-tree changes and refresh")?
}

async fn mutable_identity_inner(repo: &Path, left: &str, kind: &str) -> anyhow::Result<String> {
    if kind != "staged" {
        reject_worktree_filters(repo, 0).await?;
    }
    let mut hash = blake3::Hasher::new();
    hash.update(left.as_bytes());
    hash.update(kind.as_bytes());
    // Index entries carry blob OIDs, modes, conflict stages and intent-to-add state.
    let index = git_stdout(repo, &["ls-files", "--stage", "-z"], MAX_GIT_OUTPUT_BYTES).await?;
    hash.update(index.as_bytes());
    let config = git_stdout(repo, &["config", "--null", "--list"], MAX_GIT_OUTPUT_BYTES).await?;
    hash.update(config.as_bytes());
    let mut paths = Vec::new();
    if kind != "untracked" {
        let mut args = range_diff_args(left, Some(kind), "");
        args.extend([
            "--raw",
            "--numstat",
            "--no-abbrev",
            "--no-renames",
            "-z",
            "--",
        ]);
        let raw = git_stdout(repo, &args, MAX_GIT_OUTPUT_BYTES).await?;
        hash.update(raw.as_bytes());
        let mut args = range_diff_args(left, Some(kind), "");
        args.extend(["--name-only", "--no-renames", "-z", "--"]);
        paths.extend(
            git_stdout(repo, &args, MAX_GIT_OUTPUT_BYTES)
                .await?
                .split_terminator('\0')
                .map(str::to_string),
        );
        // Attributes can change hunk headers or binary classification without changing
        // blob bytes (including .git/info/attributes and global attributes).
        for chunk in paths.chunks(100) {
            let mut args = vec!["check-attr", "--all", "-z", "--"];
            args.extend(chunk.iter().map(String::as_str));
            hash.update(
                git_stdout(repo, &args, MAX_GIT_OUTPUT_BYTES)
                    .await?
                    .as_bytes(),
            );
        }
        if kind == "staged" {
            paths.clear();
        }
    }
    if matches!(kind, "untracked" | "worktree") {
        paths.extend(untracked_paths(repo).await?);
    }
    paths.sort();
    paths.dedup();
    // Yield between bounded chunks: cancellation drops this future, not an uncancellable
    // spawn_blocking hasher. Refuse oversized reads rather than minting a partial identity.
    let mut remaining = 64 * 1024 * 1024_u64;
    let mut buffer = vec![0u8; 65536];
    for path in paths {
        tokio::task::yield_now().await;
        hash.update(&(path.len() as u64).to_le_bytes());
        hash.update(path.as_bytes());
        let full = contained_diff_path(repo, &path)?;
        match fs::symlink_metadata(&full) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                hash.update(b"symlink");
                let target = fs::read_link(&full)?;
                let bytes = target.as_os_str().as_encoded_bytes();
                remaining = remaining
                    .checked_sub(bytes.len() as u64)
                    .ok_or_else(|| anyhow!("Git change identity exceeds the 64 MiB read limit"))?;
                hash.update(bytes);
            }
            Ok(metadata) if metadata.is_file() => {
                if metadata.len() > remaining {
                    bail!(
                        "Git change identity exceeds the 64 MiB read limit; reduce working-tree changes or review an immutable commit"
                    );
                }
                hash.update(b"file");
                hash.update(&metadata.len().to_le_bytes());
                hash.update(untracked_file_mode(&metadata).as_bytes());
                let mut file = fs::File::open(&full)?;
                loop {
                    tokio::task::yield_now().await;
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    remaining = remaining.checked_sub(count as u64).ok_or_else(|| {
                        anyhow!("Git change identity exceeds the 64 MiB read limit")
                    })?;
                    hash.update(&buffer[..count]);
                }
            }
            Ok(metadata) if metadata.is_dir() => {
                hash.update(b"directory");
                // Raw Git diff uses a zero workdir OID for dirty gitlinks. The short
                // patch carries the actual checked-out OID and patch-affecting -dirty.
                let mut args = range_diff_args(left, Some(kind), "");
                args.extend(["--no-renames", "--", &path]);
                let patch = git_stdout(repo, &args, MAX_DIFF_FILE_PATCH_BYTES).await?;
                remaining = remaining
                    .checked_sub(patch.len() as u64)
                    .ok_or_else(|| anyhow!("Git change identity exceeds the 64 MiB read limit"))?;
                hash.update(patch.as_bytes());
            }
            Ok(_) => bail!("Unsupported special working-tree file: {path}"),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                hash.update(b"deleted");
            }
            Err(error) => return Err(error.into()),
        }
    }
    let hash = hash.finalize().to_hex().to_string();
    Ok(format!("fura:{kind}:{hash}"))
}

async fn validate_mutable_identity(repo: &Path, left: &str, right: &str) -> anyhow::Result<()> {
    if let Some(kind) = mutable_kind(right)? {
        if mutable_identity(repo, left, kind).await? != right {
            bail!(
                "Git changes changed since this comparison was loaded. Refresh Git changes before loading or commenting on this patch."
            );
        }
    }
    Ok(())
}

fn validate_diff_path(path: &str) -> anyhow::Result<()> {
    if path.is_empty()
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        bail!("invalid repository-relative diff path");
    }
    Ok(())
}

fn contained_diff_path(repo: &Path, path: &str) -> anyhow::Result<PathBuf> {
    validate_diff_path(path)?;
    let full = repo.join(path);
    let root = repo.canonicalize()?;
    let mut parent = full.parent();
    while let Some(directory) = parent {
        match directory.canonicalize() {
            Ok(canonical) => {
                if !canonical.starts_with(&root) {
                    bail!("diff path escapes repository");
                }
                break;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                parent = directory.parent()
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(full)
}

fn untracked_file_mode(metadata: &fs::Metadata) -> &'static str {
    if metadata.file_type().is_symlink() {
        return "120000";
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return "100755";
        }
    }
    "100644"
}

fn read_untracked_preview(
    repo: &Path,
    path: &str,
) -> anyhow::Result<(Vec<u8>, bool, &'static str)> {
    let full = contained_diff_path(repo, path)?;
    let metadata = fs::symlink_metadata(&full)?;
    let symlink = metadata.file_type().is_symlink();
    let mut bytes = Vec::new();
    if symlink {
        bytes.extend_from_slice(fs::read_link(&full)?.as_os_str().as_encoded_bytes());
    } else if metadata.is_file() {
        fs::File::open(&full)?
            .take((MAX_DIFF_FILE_PATCH_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
    } else {
        // Untracked nested repositories are directories, not additions of their contents.
        bail!("untracked diff path is not a regular file: {path}");
    }
    let truncated = bytes.len() > MAX_DIFF_FILE_PATCH_BYTES;
    bytes.truncate(MAX_DIFF_FILE_PATCH_BYTES);
    Ok((bytes, truncated, untracked_file_mode(&metadata)))
}

fn line_count(bytes: &[u8]) -> u64 {
    bytes.iter().filter(|&&byte| byte == b'\n').count() as u64
        + u64::from(!bytes.is_empty() && !bytes.ends_with(b"\n"))
}

fn untracked_patch(repo: &Path, path: &str) -> anyhow::Result<(String, bool)> {
    let (bytes, truncated, mode) = read_untracked_preview(repo, path)?;
    let quote = |prefix: &str| {
        let value = format!("{prefix}{path}");
        if value
            .bytes()
            .any(|byte| byte < 32 || matches!(byte, b'"' | b'\\'))
        {
            serde_json::to_string(&value).expect("path string")
        } else {
            value
        }
    };
    let old = quote("a/");
    let new = quote("b/");
    let mut patch = format!("diff --git {old} {new}\nnew file mode {mode}\n");
    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
        patch.push_str(&format!("Binary files /dev/null and {new} differ\n"));
    } else if truncated {
        patch.push_str("... file exceeds the diff preview size limit ...\n");
    } else if !bytes.is_empty() {
        patch.push_str(&format!(
            "--- /dev/null\n+++ {new}\n@@ -0,0 +1,{} @@\n",
            line_count(&bytes)
        ));
        for line in std::str::from_utf8(&bytes)?.split_inclusive('\n') {
            patch.push('+');
            patch.push_str(line);
            if !line.ends_with('\n') {
                patch.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
    Ok((patch, truncated))
}

async fn generate_patch(
    repo: &Path,
    left: &str,
    right: &str,
    file: Option<&DiffFileSelector>,
    context_lines: u32,
    limit: usize,
) -> anyhow::Result<(String, bool)> {
    validate_mutable_identity(repo, left, right).await?;
    let kind = mutable_kind(right)?;
    let paths: Vec<&str> = file
        .map(|file| {
            file.old_path
                .as_deref()
                .into_iter()
                .chain(std::iter::once(file.new_path.as_str()))
                .collect()
        })
        .unwrap_or_default();
    for path in &paths {
        if kind.is_some() {
            contained_diff_path(repo, path)?;
        } else {
            // Historical trees do not depend on today's directory/symlink layout.
            validate_diff_path(path)?;
        }
    }
    let context = format!(
        "--unified={}",
        normalize_diff_context_lines(Some(context_lines))
    );
    let (mut patch, mut truncated) = if kind == Some("untracked") {
        (String::new(), false)
    } else {
        run_range_diff(repo, left, right, &[&context], &paths, limit).await?
    };
    if matches!(kind, Some("untracked" | "worktree")) && !truncated {
        let restored = if kind == Some("worktree") {
            worktree_restored_paths(repo, left).await?
        } else {
            Vec::new()
        };
        for path in untracked_paths(repo).await? {
            if restored.contains(&path) {
                continue;
            }
            if file.is_some_and(|file| file.new_path != path) {
                continue;
            }
            let (addition, limited) = untracked_patch(repo, &path)?;
            truncated |= limited;
            if patch.len() + addition.len() > limit {
                truncated = true;
                patch.push_str("\n... diff output truncated by Fura ...\n");
                break;
            }
            patch.push_str(&addition);
        }
    }
    if let Some(file) = file {
        retain_selected_file_patch(&mut patch, file);
    }
    validate_mutable_identity(repo, left, right).await?;
    Ok((patch, truncated))
}

// Git pathspecs also match descendants when a file replaces a directory.
// A lazy file request must return exact file deltas, not that whole subtree.
fn retain_selected_file_patch(patch: &mut String, file: &DiffFileSelector) {
    let old_path = file.old_path.as_deref().unwrap_or(&file.new_path);
    let mut skipped = Vec::new();
    let mut section_start = 0;
    let mut offset = 0;
    let mut keep = false;
    for line in patch.split_inclusive('\n') {
        let text = line.trim_end_matches('\n');
        if text.starts_with("diff --git ")
            || text.starts_with("diff --cc ")
            || text.starts_with("diff --combined ")
        {
            if !keep && section_start < offset {
                skipped.push(section_start..offset);
            }
            section_start = offset;
            keep = if let Some(header) = text.strip_prefix("diff --git ") {
                // Raw filenames may themselves contain " b/"; the known selector
                // disambiguates the separator without inventing a second path parser.
                let literal = header
                    .strip_prefix("a/")
                    .and_then(|rest| rest.strip_prefix(old_path))
                    .and_then(|rest| rest.strip_prefix(" b/"))
                    == Some(file.new_path.as_str());
                literal
                    || (header.contains('"')
                        && parse_diff_git_line(text)
                            .is_some_and(|(old, new)| old == old_path && new == file.new_path))
            } else {
                text.strip_prefix("diff --cc ")
                    .or_else(|| text.strip_prefix("diff --combined "))
                    .and_then(decode_diff_path)
                    .is_some_and(|path| path == file.new_path)
            };
        }
        offset += line.len();
    }
    if !keep && section_start < offset {
        skipped.push(section_start..offset);
    }
    if skipped.is_empty() {
        return;
    }
    let removed: usize = skipped.iter().map(|range| range.len()).sum();
    let mut filtered = String::with_capacity(patch.len() - removed);
    let mut start = 0;
    for range in skipped {
        filtered.push_str(&patch[start..range.start]);
        start = range.end;
    }
    filtered.push_str(&patch[start..]);
    *patch = filtered;
}

async fn build_compare_summary(
    state: &AppState,
    client_id: String,
    diff_id: String,
    repo_root: String,
    base: DiffRefInput,
    head: DiffRefInput,
    detail_mode: DiffDetailMode,
    merge_base: Option<bool>,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    request: DiffRequestIdentity,
    context_lines: Option<u32>,
) -> anyhow::Result<(ServerMessage, PreparedDiff)> {
    let (refs, prepared) = prepare_compare_diff(
        state,
        client_id.clone(),
        diff_id.clone(),
        repo_root,
        base,
        head,
        detail_mode,
        merge_base,
        current_commit_oid,
        selected_file,
        request.clone(),
        context_lines,
    )
    .await?;
    let summary = build_summary_payload(
        &prepared.repo_root,
        &prepared.left_tree_or_commit,
        &prepared.right_tree_or_commit,
    )
    .await?;
    Ok((
        ServerMessage::CompareDiffSummary {
            state: CompareDiffSummaryState {
                target_client_id: client_id,
                diff_id,
                request,
                comparison: prepared.comparison.clone(),
                refs,
                summary,
                review: prepared.review.clone(),
                review_worktree: prepared.review_worktree.clone(),
            },
        },
        prepared,
    ))
}

async fn prepare_compare_diff(
    state: &AppState,
    _client_id: String,
    _diff_id: String,
    repo_root: String,
    base: DiffRefInput,
    head: DiffRefInput,
    detail_mode: DiffDetailMode,
    merge_base: Option<bool>,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    _request: DiffRequestIdentity,
    context_lines: Option<u32>,
) -> anyhow::Result<(Vec<GitRefSummary>, PreparedDiff)> {
    let repo_root = discover_repo_root(&repo_root)?;
    let refs = list_refs(&repo_root).await?;
    let base_resolved = resolve_diff_ref(&repo_root, &base).await?;
    let head_resolved = resolve_diff_ref(&repo_root, &head).await?;
    let base_endpoint = endpoint_from_resolved(&base_resolved);
    let head_endpoint = endpoint_from_resolved(&head_resolved);
    let prepared = prepare_diff_range(
        state,
        repo_root,
        base_endpoint,
        head_endpoint,
        base_resolved,
        head_resolved,
        detail_mode,
        merge_base.unwrap_or(false),
        current_commit_oid,
        selected_file,
        context_lines,
    )
    .await?;
    Ok((refs, prepared))
}

async fn prepare_diff_range(
    state: &AppState,
    repo_root: PathBuf,
    range_base_endpoint: DiffEndpoint,
    range_head_endpoint: DiffEndpoint,
    base_resolved: ResolvedDiffRef,
    head_resolved: ResolvedDiffRef,
    detail_mode: DiffDetailMode,
    merge_base: bool,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    context_lines: Option<u32>,
) -> anyhow::Result<PreparedDiff> {
    let range_base_oid =
        effective_merge_base_oid(&repo_root, &base_resolved, &head_resolved, merge_base).await?;
    let commits = commits_for_range(
        &repo_root,
        &base_resolved,
        &head_resolved,
        range_base_oid.as_deref(),
    )
    .await?;
    let current_commit_oid =
        current_commit_oid.filter(|oid| commits.iter().any(|commit| commit.oid == *oid));
    let commit_patch = match current_commit_oid.as_deref() {
        Some(oid) => Some(selected_commit_patch_refs(oid, &commits)?),
        None => None,
    };
    let (
        display_left,
        display_right,
        current_commit_index,
        previous_commit_oid,
        displayed_patch_range,
    ) = if let Some((left, right, index, previous_oid, displayed_range)) = commit_patch {
        (
            left,
            right,
            Some(index),
            Some(previous_oid),
            Some(displayed_range),
        )
    } else {
        (
            base_resolved.clone(),
            head_resolved.clone(),
            None,
            None,
            None,
        )
    };
    let left_tree_or_commit = if displayed_patch_range.is_none() {
        range_base_oid.unwrap_or(oid_for_diff(&display_left)?.to_string())
    } else {
        oid_for_diff(&display_left)?.to_string()
    };
    let right_tree_or_commit = match &display_right {
        ResolvedDiffRef::WorkingTree => {
            mutable_identity(&repo_root, &left_tree_or_commit, "worktree").await?
        }
        ResolvedDiffRef::GitRef { oid, .. } => oid.clone(),
    };
    let generated_at = Timestamp::now().millis().to_string();
    let context_lines = normalize_diff_context_lines(context_lines);
    let comparison_key = format!(
        "{}:{}:{}:{:?}",
        repo_root.display(),
        left_tree_or_commit,
        right_tree_or_commit,
        detail_mode
    );
    let comparison = DiffComparisonIdentity {
        repo_root: repo_root.display().to_string(),
        base: range_base_endpoint,
        head: range_head_endpoint,
        left_tree_or_commit: left_tree_or_commit.clone(),
        right_tree_or_commit: right_tree_or_commit.clone(),
        detail_mode,
        current_commit_oid: current_commit_oid.clone(),
        selected_file,
        context_lines,
        generated_at,
        comparison_key,
        displayed_patch_range,
    };
    let review = CommitStepState {
        commits,
        current_commit_oid,
        current_commit_index,
        previous_commit_oid,
    };
    let review_worktree = current_review_worktree(state, &repo_root).await;
    Ok(PreparedDiff {
        repo_root,
        left_tree_or_commit,
        right_tree_or_commit,
        comparison,
        review,
        review_worktree,
    })
}
async fn effective_merge_base_oid(
    repo_root: &Path,
    base_resolved: &ResolvedDiffRef,
    head_resolved: &ResolvedDiffRef,
    merge_base: bool,
) -> anyhow::Result<Option<String>> {
    if !merge_base {
        return Ok(None);
    }
    match (base_resolved, head_resolved) {
        (
            ResolvedDiffRef::GitRef { oid: base_oid, .. },
            ResolvedDiffRef::GitRef { oid: head_oid, .. },
        ) => Ok(Some(
            git_stdout(
                repo_root,
                &["merge-base", base_oid, head_oid],
                MAX_GIT_OUTPUT_BYTES,
            )
            .await?
            .trim()
            .to_string(),
        )),
        _ => Ok(None),
    }
}

async fn commits_for_range(
    repo_root: &Path,
    base_resolved: &ResolvedDiffRef,
    head_resolved: &ResolvedDiffRef,
    range_base_oid: Option<&str>,
) -> anyhow::Result<Vec<DiffCommitSummary>> {
    match (base_resolved, head_resolved) {
        (
            ResolvedDiffRef::GitRef { oid: base_oid, .. },
            ResolvedDiffRef::GitRef { oid: head_oid, .. },
        ) => {
            let effective_base = range_base_oid.unwrap_or(base_oid);
            list_commits(repo_root, effective_base, head_oid).await
        }
        (ResolvedDiffRef::GitRef { oid: base_oid, .. }, ResolvedDiffRef::WorkingTree) => {
            match resolve_git_ref(repo_root, "HEAD").await {
                Ok(ResolvedDiffRef::GitRef { oid: head_oid, .. }) => {
                    let effective_base = range_base_oid.unwrap_or(base_oid);
                    list_commits(repo_root, effective_base, &head_oid).await
                }
                _ => Ok(Vec::new()),
            }
        }
        _ => Ok(Vec::new()),
    }
}

fn selected_commit_patch_refs(
    commit_oid: &str,
    commits: &[DiffCommitSummary],
) -> anyhow::Result<(
    ResolvedDiffRef,
    ResolvedDiffRef,
    usize,
    String,
    DisplayedPatchRange,
)> {
    let index = commits
        .iter()
        .position(|commit| commit.oid == commit_oid)
        .ok_or_else(|| anyhow!("commit is not in the selected range: {commit_oid}"))?;
    let selected = &commits[index];
    let previous = selected
        .parent_oids
        .first()
        .cloned()
        .ok_or_else(|| anyhow!("selected commit has no comparable parent"))?;
    let left_ref = ResolvedDiffRef::GitRef {
        input: previous.clone(),
        ref_kind: DiffRefKind::Commit,
        oid: previous.clone(),
        display: format!(
            "{}{}",
            &previous[..previous.len().min(12)],
            if selected.is_merge {
                " (first parent)"
            } else {
                ""
            }
        ),
    };
    let right_ref = ResolvedDiffRef::GitRef {
        input: selected.oid.clone(),
        ref_kind: DiffRefKind::Commit,
        oid: selected.oid.clone(),
        display: selected.short_oid.clone(),
    };
    let displayed_range = DisplayedPatchRange {
        base: DiffEndpoint::Commit {
            oid: previous.clone(),
            short_oid: previous[..previous.len().min(12)].to_string(),
            subject: None,
        },
        head: commit_endpoint(selected),
    };
    Ok((left_ref, right_ref, index, previous, displayed_range))
}

fn commit_endpoint(commit: &DiffCommitSummary) -> DiffEndpoint {
    DiffEndpoint::Commit {
        oid: commit.oid.clone(),
        short_oid: commit.short_oid.clone(),
        subject: Some(commit.subject.clone()),
    }
}

fn endpoint_from_resolved(reference: &ResolvedDiffRef) -> DiffEndpoint {
    match reference {
        ResolvedDiffRef::WorkingTree => DiffEndpoint::WorkingTree,
        ResolvedDiffRef::GitRef {
            input,
            ref_kind,
            oid,
            display,
        } => DiffEndpoint::GitRef {
            input: input.clone(),
            ref_kind: *ref_kind,
            oid: oid.clone(),
            display: display.clone(),
        },
    }
}

async fn build_summary_payload(
    repo_root: &Path,
    left_tree_or_commit: &str,
    right_tree_or_commit: &str,
) -> anyhow::Result<DiffSummaryPayload> {
    validate_mutable_identity(repo_root, left_tree_or_commit, right_tree_or_commit).await?;
    let net_worktree = matches!(
        mutable_kind(right_tree_or_commit)?,
        Some("untracked" | "worktree")
    );
    let (mut stat, mut truncated) = if net_worktree {
        (String::new(), false)
    } else {
        run_range_diff(
            repo_root,
            left_tree_or_commit,
            right_tree_or_commit,
            &["--stat"],
            &[],
            MAX_DIFF_BYTES,
        )
        .await?
    };
    let (files, file_limit_reached) =
        summarize_files_between(repo_root, left_tree_or_commit, right_tree_or_commit).await?;
    if net_worktree {
        for file in &files {
            let counts = if matches!(file.status, DiffFileStatus::Binary) {
                "Bin".to_string()
            } else {
                format!("+{} -{}", file.added, file.removed)
            };
            let line = format!(" {} | {counts}\n", serde_json::to_string(&file.new_path)?);
            if stat.len() + line.len() > MAX_DIFF_BYTES - 256 {
                truncated = true;
                break;
            }
            stat.push_str(&line);
        }
        if !files.is_empty() {
            stat.push_str(&format!(
                " {} files changed, {} insertions(+), {} deletions(-)\n",
                files.len(),
                files.iter().map(|file| file.added).sum::<u64>(),
                files.iter().map(|file| file.removed).sum::<u64>()
            ));
        }
    }
    validate_mutable_identity(repo_root, left_tree_or_commit, right_tree_or_commit).await?;
    Ok(DiffSummaryPayload {
        files,
        stat: Some(stat),
        truncated: truncated || file_limit_reached,
        file_limit_reached: Some(file_limit_reached),
    })
}

async fn generate_aggregate_patch(
    repo_root: &Path,
    left_tree_or_commit: &str,
    right_tree_or_commit: &str,
    context_lines: u32,
) -> anyhow::Result<(String, bool)> {
    generate_patch(
        repo_root,
        left_tree_or_commit,
        right_tree_or_commit,
        None,
        context_lines,
        MAX_DIFF_BYTES,
    )
    .await
}

async fn send_diff_content_for_prepared(
    state: &AppState,
    client_id: String,
    diff_id: String,
    scope: DiffScope,
    session_id: Option<String>,
    prepared: Arc<PreparedDiff>,
    file: Option<DiffFileSelector>,
    context_lines: Option<u32>,
) {
    let context_lines =
        normalize_diff_context_lines(context_lines).max(prepared.comparison.context_lines);
    let result = match file.as_ref() {
        Some(file) => {
            generate_file_patch(
                &prepared.repo_root,
                &prepared.left_tree_or_commit,
                &prepared.right_tree_or_commit,
                file,
                context_lines,
            )
            .await
        }
        None => {
            generate_aggregate_patch(
                &prepared.repo_root,
                &prepared.left_tree_or_commit,
                &prepared.right_tree_or_commit,
                context_lines,
            )
            .await
        }
    };
    match result {
        Ok((patch, truncated)) => {
            let rows = parse_diff_rows(&patch);
            let _ = state
                .events
                .emit(
                    state,
                    ServerMessage::DiffContent {
                        content: DiffContentState {
                            target_client_id: client_id,
                            diff_id,
                            scope,
                            comparison_key: prepared.comparison.comparison_key.clone(),
                            file,
                            patch,
                            truncated,
                            rows,
                            context_lines,
                            generated_at: Timestamp::now().millis().to_string(),
                        },
                    },
                )
                .await;
        }
        Err(error) => {
            let _ = state
                .events
                .emit(
                    state,
                    diff_error(
                        Some(client_id),
                        Some(diff_id),
                        match scope {
                            DiffScope::SessionChanges => DiffErrorScope::SessionChanges,
                            DiffScope::CompareDiff => DiffErrorScope::CompareDiff,
                        },
                        session_id,
                        Some(prepared.repo_root.display().to_string()),
                        error,
                    ),
                )
                .await;
        }
    }
}

pub(crate) async fn generate_file_patch(
    repo_root: &Path,
    left_tree_or_commit: &str,
    right_tree_or_commit: &str,
    file: &DiffFileSelector,
    context_lines: u32,
) -> anyhow::Result<(String, bool)> {
    generate_patch(
        repo_root,
        left_tree_or_commit,
        right_tree_or_commit,
        Some(file),
        context_lines,
        MAX_DIFF_FILE_PATCH_BYTES,
    )
    .await
}

pub(crate) fn parse_diff_rows(diff_text: &str) -> Vec<DiffRow> {
    let mut rows = Vec::new();
    let mut old_path: Option<String> = None;
    let mut new_path = String::new();
    let mut hunk: Option<String> = None;
    let mut old_line = 0_u32;
    let mut new_line = 0_u32;
    let mut combined = false;

    for text in diff_text.split('\n') {
        if let Some(path) = text
            .strip_prefix("diff --cc ")
            .or_else(|| text.strip_prefix("diff --combined "))
        {
            let path = decode_diff_path(path).unwrap_or_else(|| path.to_string());
            rows.push(DiffRow::File {
                text: text.to_string(),
                old_path: Some(path.clone()),
                new_path: path.clone(),
                file_path: path,
            });
            combined = true;
            continue;
        }
        if let Some((old, new)) = parse_diff_git_line(text) {
            combined = false;
            old_path = Some(old);
            new_path = new;
            hunk = None;
            rows.push(DiffRow::File {
                text: text.to_string(),
                old_path: old_path.clone(),
                new_path: new_path.clone(),
                file_path: new_path.clone(),
            });
            continue;
        }
        if combined {
            rows.push(DiffRow::Meta {
                text: text.to_string(),
            });
            continue;
        }

        if let Some(rename_from) = text.strip_prefix("rename from ") {
            old_path =
                Some(decode_diff_path(rename_from).unwrap_or_else(|| rename_from.to_string()));
            if let Some(DiffRow::File {
                old_path: row_old_path,
                ..
            }) = rows.last_mut()
            {
                *row_old_path = old_path.clone();
            }
            rows.push(DiffRow::Meta {
                text: text.to_string(),
            });
            continue;
        }

        if let Some(rename_to) = text.strip_prefix("rename to ") {
            new_path = decode_diff_path(rename_to).unwrap_or_else(|| rename_to.to_string());
            if let Some(DiffRow::File {
                new_path: row_new_path,
                file_path,
                ..
            }) = rows.last_mut()
            {
                *row_new_path = new_path.clone();
                *file_path = new_path.clone();
            }
            rows.push(DiffRow::Meta {
                text: text.to_string(),
            });
            continue;
        }

        if text.starts_with("Binary files ") {
            rows.push(DiffRow::Meta {
                text: text.to_string(),
            });
            continue;
        }

        if let Some(path) = text.strip_prefix("--- ") {
            old_path = parse_diff_header_path(path, "a/");
            rows.push(DiffRow::Meta {
                text: text.to_string(),
            });
            continue;
        }

        if let Some(path) = text.strip_prefix("+++ ") {
            if let Some(path) = parse_diff_header_path(path, "b/") {
                new_path = path;
            }
            rows.push(DiffRow::Meta {
                text: text.to_string(),
            });
            continue;
        }

        if let Some((old_start, new_start)) = parse_hunk_header(text) {
            old_line = old_start;
            new_line = new_start;
            hunk = Some(text.to_string());
            rows.push(DiffRow::Hunk {
                text: text.to_string(),
                old_path: old_path.clone(),
                new_path: new_path.clone(),
                file_path: new_path.clone(),
                hunk: text.to_string(),
            });
            continue;
        }

        if text.starts_with('+') && !text.starts_with("+++") {
            rows.push(DiffRow::Line {
                prefix: "+".to_string(),
                location: DiffLineLocation {
                    old_path: old_path.clone(),
                    new_path: new_path.clone(),
                    hunk: hunk.clone(),
                    side: DiffSide::Right,
                    kind: DiffLineKind::Add,
                    old_line: None,
                    new_line: Some(new_line),
                    text: text.to_string(),
                },
            });
            new_line = new_line.saturating_add(1);
            continue;
        }

        if text.starts_with('-') && !text.starts_with("---") {
            rows.push(DiffRow::Line {
                prefix: "-".to_string(),
                location: DiffLineLocation {
                    old_path: old_path.clone(),
                    new_path: new_path.clone(),
                    hunk: hunk.clone(),
                    side: DiffSide::Left,
                    kind: DiffLineKind::Remove,
                    old_line: Some(old_line),
                    new_line: None,
                    text: text.to_string(),
                },
            });
            old_line = old_line.saturating_add(1);
            continue;
        }

        if text.starts_with(' ') {
            rows.push(DiffRow::Line {
                prefix: " ".to_string(),
                location: DiffLineLocation {
                    old_path: old_path.clone(),
                    new_path: new_path.clone(),
                    hunk: hunk.clone(),
                    side: DiffSide::Right,
                    kind: DiffLineKind::Context,
                    old_line: Some(old_line),
                    new_line: Some(new_line),
                    text: text.to_string(),
                },
            });
            old_line = old_line.saturating_add(1);
            new_line = new_line.saturating_add(1);
            continue;
        }

        rows.push(DiffRow::Meta {
            text: text.to_string(),
        });
    }

    rows
}

fn parse_diff_git_line(text: &str) -> Option<(String, String)> {
    let rest = text.strip_prefix("diff --git ")?;
    let (old, new) = if rest.starts_with('"') {
        let mut escaped = false;
        let end = rest.char_indices().skip(1).find_map(|(index, ch)| {
            if escaped {
                escaped = false;
                return None;
            }
            if ch == '\\' {
                escaped = true;
                return None;
            }
            (ch == '"').then_some(index)
        })?;
        (&rest[..=end], rest.get(end + 2..)?)
    } else if let Some(pair) = rest.split_once(" \"b/") {
        (pair.0, &rest[pair.0.len() + 1..])
    } else {
        let (old, _) = rest.split_once(" b/")?;
        (old, &rest[old.len() + 1..])
    };
    Some((
        parse_diff_header_path(old, "a/")?,
        parse_diff_header_path(new, "b/")?,
    ))
}

fn decode_diff_path(text: &str) -> Option<String> {
    if !text.starts_with('"') {
        return Some(text.to_string());
    }
    if let Ok(value) = serde_json::from_str::<String>(text) {
        return Some(value);
    }
    let quoted = text.strip_prefix('"')?.strip_suffix('"')?;
    let mut bytes = quoted.bytes().peekable();
    let mut result = Vec::new();
    while let Some(byte) = bytes.next() {
        if byte != b'\\' {
            result.push(byte);
            continue;
        }
        let escaped = bytes.next()?;
        result.push(match escaped {
            b'0'..=b'7' => {
                let mut value = u16::from(escaped - b'0');
                for _ in 0..2 {
                    if !bytes.peek().is_some_and(|byte| matches!(byte, b'0'..=b'7')) {
                        break;
                    }
                    value = value * 8 + u16::from(bytes.next()? - b'0');
                }
                u8::try_from(value).ok()?
            }
            b'a' => 7,
            b'b' => 8,
            b't' => b'\t',
            b'n' => b'\n',
            b'v' => 11,
            b'f' => 12,
            b'r' => b'\r',
            b'\\' => b'\\',
            b'"' => b'"',
            _ => return None,
        });
    }
    String::from_utf8(result).ok()
}

fn parse_diff_header_path(text: &str, prefix: &str) -> Option<String> {
    let path = decode_diff_path(text.trim_end_matches('\t'))?;
    path.strip_prefix(prefix).map(str::to_string)
}

fn parse_hunk_header(text: &str) -> Option<(u32, u32)> {
    let rest = text.strip_prefix("@@ -")?;
    let (old_part, rest) = rest.split_once(" +")?;
    let (new_part, _) = rest.split_once(" @@")?;
    let old_start = old_part.split(',').next()?.parse().ok()?;
    let new_start = new_part.split(',').next()?.parse().ok()?;
    Some((old_start, new_start))
}

async fn current_review_worktree(state: &AppState, repo_root: &Path) -> Option<DiffReviewWorktree> {
    let registry = state.review_worktrees.read().await;
    let id = registry.by_source_repo.get(repo_root)?;
    registry.by_id.get(id).cloned()
}

async fn list_refs(repo_root: &Path) -> anyhow::Result<Vec<GitRefSummary>> {
    let output = git_stdout(
        repo_root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
            "refs/omp/diff-snapshots",
        ],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await?;
    let mut refs = Vec::new();
    for line in output.lines() {
        let Some((name, _object)) = line.split_once('\0') else {
            continue;
        };
        if name.ends_with("/HEAD") {
            continue;
        }
        if let Ok(resolved) = resolve_ref_to_oid(repo_root, name).await {
            refs.push(GitRefSummary {
                name: name.to_string(),
                short_name: short_ref_name(name),
                ref_kind: ref_kind_for_name(name),
                oid: resolved,
            });
        }
    }
    refs.sort_by(|left, right| left.short_name.cmp(&right.short_name));
    Ok(refs)
}

async fn resolve_diff_ref(
    repo_root: &Path,
    input: &DiffRefInput,
) -> anyhow::Result<ResolvedDiffRef> {
    match input {
        DiffRefInput::WorkingTree => Ok(ResolvedDiffRef::WorkingTree),
        DiffRefInput::GitRef { value } => resolve_git_ref(repo_root, value).await,
    }
}

async fn resolve_checkout_target(
    repo_root: &Path,
    target: &DiffCheckoutTarget,
) -> anyhow::Result<ResolvedDiffRef> {
    match target {
        DiffCheckoutTarget::WorkingTree => Ok(ResolvedDiffRef::WorkingTree),
        DiffCheckoutTarget::GitRef { value } => resolve_git_ref(repo_root, value).await,
        DiffCheckoutTarget::Commit { oid } => {
            let resolved = resolve_ref_to_oid(repo_root, oid).await?;
            Ok(ResolvedDiffRef::GitRef {
                input: oid.clone(),
                ref_kind: DiffRefKind::Commit,
                oid: resolved.clone(),
                display: resolved[..resolved.len().min(12)].to_string(),
            })
        }
    }
}

async fn resolve_git_ref(repo_root: &Path, value: &str) -> anyhow::Result<ResolvedDiffRef> {
    let input = value.trim();
    if input.is_empty() {
        bail!("git ref is empty");
    }
    let oid = resolve_ref_to_oid(repo_root, input).await?;
    Ok(ResolvedDiffRef::GitRef {
        input: input.to_string(),
        ref_kind: classify_ref_input(repo_root, input)
            .await
            .unwrap_or(DiffRefKind::Other),
        oid,
        display: display_ref(input),
    })
}

async fn resolve_ref_to_oid(repo_root: &Path, input: &str) -> anyhow::Result<String> {
    let rev = format!("{input}^{{commit}}");
    let oid = git_stdout(
        repo_root,
        &["rev-parse", "--verify", "--end-of-options", &rev],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await
    .with_context(|| format!("failed to resolve git ref: {input}"))?;
    Ok(oid.trim().to_string())
}

async fn classify_ref_input(repo_root: &Path, input: &str) -> anyhow::Result<DiffRefKind> {
    for (candidate, kind) in [
        (format!("refs/heads/{input}"), DiffRefKind::Branch),
        (format!("refs/remotes/{input}"), DiffRefKind::Remote),
        (format!("refs/tags/{input}"), DiffRefKind::Tag),
        (input.to_string(), ref_kind_for_name(input)),
    ] {
        if kind != DiffRefKind::Other
            && git_stdout(
                repo_root,
                &["show-ref", "--verify", "--quiet", &candidate],
                MAX_GIT_OUTPUT_BYTES,
            )
            .await
            .is_ok()
        {
            return Ok(kind);
        }
    }
    if input.len() >= 7 && input.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Ok(DiffRefKind::Commit)
    } else {
        Ok(DiffRefKind::Other)
    }
}

fn ref_kind_for_name(name: &str) -> DiffRefKind {
    if name.starts_with("refs/heads/") {
        DiffRefKind::Branch
    } else if name.starts_with("refs/remotes/") {
        DiffRefKind::Remote
    } else if name.starts_with("refs/tags/") {
        DiffRefKind::Tag
    } else {
        DiffRefKind::Other
    }
}

fn short_ref_name(name: &str) -> String {
    if let Some(short) = name.strip_prefix("refs/heads/") {
        return short.to_string();
    }
    if let Some(short) = name.strip_prefix("refs/remotes/") {
        return short.to_string();
    }
    if let Some(short) = name.strip_prefix("refs/tags/") {
        return short.to_string();
    }
    if let Some(id) = name.strip_prefix("refs/omp/diff-snapshots/") {
        return format!("snapshot/{id}");
    }
    name.to_string()
}

fn display_ref(input: &str) -> String {
    short_ref_name(input)
}

async fn list_commits(
    repo_root: &Path,
    base_oid: &str,
    head_oid: &str,
) -> anyhow::Result<Vec<DiffCommitSummary>> {
    let range = format!("{base_oid}..{head_oid}");
    let revs = git_stdout(
        repo_root,
        &["rev-list", "--reverse", "--topo-order", &range],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await?;
    let mut commits = Vec::new();
    for oid in revs.lines().filter(|line| !line.trim().is_empty()) {
        commits.push(read_commit_summary(repo_root, oid).await?);
    }
    Ok(commits)
}

fn validate_commit_oid(oid: &str) -> anyhow::Result<()> {
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("Expected a full commit object ID");
    }
    Ok(())
}

async fn read_commit_summary(repo: &Path, oid: &str) -> anyhow::Result<DiffCommitSummary> {
    validate_commit_oid(oid)?;
    let output = git_stdout(
        repo,
        &[
            "show",
            "--no-patch",
            "--no-show-signature",
            "--no-ext-diff",
            "--no-textconv",
            "--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%cI%x00%P%x00%B",
            oid,
            "--",
        ],
        65_536,
    )
    .await?;
    let mut parts = output.trim_end_matches('\n').splitn(8, '\0');
    let full = parts.next().unwrap_or(oid).to_string();
    let short_oid = parts.next().unwrap_or(oid).to_string();
    let subject = parts.next().unwrap_or("").to_string();
    let author_name = parts
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let author_email = parts
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let committed_at = parts.next().unwrap_or("").to_string();
    let parent_oids: Vec<String> = parts
        .next()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let message = parts
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(&subject)
        .to_string();
    if !full.eq_ignore_ascii_case(oid) || output.splitn(8, '\0').count() != 8 {
        bail!("Object is not a commit: {oid}");
    }
    Ok(DiffCommitSummary {
        oid: full,
        short_oid,
        subject,
        message,
        author_name,
        author_email,
        committed_at,
        is_merge: parent_oids.len() > 1,
        parent_oids,
    })
}

fn validate_history_ref(history_ref: &str) -> anyhow::Result<()> {
    if history_ref.len() > 1024
        || !git2::Reference::is_valid_name(history_ref)
        || !(history_ref.starts_with("refs/heads/") || history_ref.starts_with("refs/remotes/"))
    {
        bail!("History requires a fully qualified local or remote branch ref");
    }
    Ok(())
}

async fn list_history_branches(repo_root: &Path) -> anyhow::Result<(Vec<GitRefSummary>, bool)> {
    let output = git_stdout(
        repo_root,
        &[
            "for-each-ref",
            "--count=1001",
            "--sort=refname",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            "refs/heads/",
            "refs/remotes/",
        ],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await?;
    let mut branches = Vec::new();
    let mut lines = output.lines();
    for line in lines.by_ref().take(1000) {
        let mut fields = line.split('\0');
        let (Some(name), Some(oid), Some(symbolic)) = (fields.next(), fields.next(), fields.next())
        else {
            bail!("Invalid Git branch listing");
        };
        if !symbolic.is_empty() || validate_history_ref(name).is_err() {
            continue;
        }
        validate_commit_oid(oid)?;
        branches.push(GitRefSummary {
            name: name.to_string(),
            short_name: short_ref_name(name),
            ref_kind: ref_kind_for_name(name),
            oid: oid.to_string(),
        });
    }
    Ok((branches, lines.next().is_some()))
}

pub(crate) async fn list_git_history(
    repo: &Path,
    history_ref: Option<&str>,
    cursor: Option<&str>,
) -> anyhow::Result<GitHistoryPage> {
    time::timeout(GIT_TIMEOUT, async {
        if let Some(history_ref) = history_ref {
            validate_history_ref(history_ref)?;
        }
        let repo_root = discover_repo_root(&repo.display().to_string())?;
        let root = repo_root.display().to_string();
        let (history_head_oid, offset) = if let Some(cursor) = cursor {
            let invalid = || anyhow!("Invalid or mismatched Git history cursor; refresh history");
            if cursor.len() > 32_768 {
                return Err(invalid());
            }
            let encoded = cursor.strip_prefix("v2:").ok_or_else(invalid)?;
            let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
            let (cursor_root, cursor_ref, head, offset): (String, Option<String>, String, usize) =
                serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if cursor_root != root
                || cursor_ref.as_deref() != history_ref
                || validate_commit_oid(&head).is_err()
                || offset == 0
                || offset > usize::MAX - 30
                || !offset.is_multiple_of(30)
            {
                return Err(invalid());
            }
            (Some(head), offset)
        } else {
            (None, 0)
        };
        let (branch, head_oid, history_tip_oid) = {
            let repository = Repository::open(&repo_root)?;
            let branch = repository
                .find_reference("HEAD")?
                .symbolic_target()
                .map(|name| name.strip_prefix("refs/heads/").unwrap_or(name).to_string());
            let head = match repository.head() {
                Ok(head) => Some(head.peel_to_commit()?.id().to_string()),
                Err(error) if error.code() == git2::ErrorCode::UnbornBranch => None,
                Err(error) => return Err(error.into()),
            };
            let tip = if let Some(name) = history_ref {
                match repository.find_reference(name) {
                    Ok(reference) => Some(
                        reference
                            .target()
                            .ok_or_else(|| {
                                anyhow!("Symbolic branch aliases cannot select history")
                            })?
                            .to_string(),
                    ),
                    Err(error) if error.code() == git2::ErrorCode::NotFound && cursor.is_some() => {
                        None
                    }
                    Err(error) => {
                        return Err(anyhow!("History branch is unavailable: {name}: {error}"));
                    }
                }
            } else {
                head.clone()
            };
            (branch, head, tip)
        };
        let history_head_oid = if cursor.is_some() {
            history_head_oid
        } else {
            history_tip_oid.clone()
        };
        let mut commits = Vec::new();
        let mut next_cursor = None;
        if let Some(head) = &history_head_oid {
            // A cursor retains its stored commit even after the selected ref moves or disappears.
            read_commit_summary(&repo_root, head)
                .await
                .context("History commit is unavailable; refresh history")?;
            let revs = git_stdout(
                &repo_root,
                &[
                    "rev-list",
                    "--topo-order",
                    "--max-count=31",
                    &format!("--skip={offset}"),
                    head,
                    "--",
                ],
                4096,
            )
            .await?;
            let oids: Vec<_> = revs.lines().collect();
            for oid in oids.iter().take(30) {
                commits.push(read_commit_summary(&repo_root, oid).await?);
            }
            if oids.len() > 30 {
                let bytes = serde_json::to_vec(&(&root, history_ref, head, offset + 30))?;
                next_cursor = Some(format!("v2:{}", URL_SAFE_NO_PAD.encode(bytes)));
            }
        }
        let (branches, branches_truncated) = if cursor.is_none() {
            let (branches, truncated) = list_history_branches(&repo_root).await?;
            (Some(branches), truncated)
        } else {
            (None, false)
        };
        Ok(GitHistoryPage {
            repo_root: root,
            branch,
            head_oid,
            history_head_oid,
            history_ref: history_ref.map(str::to_string),
            history_tip_oid,
            branches,
            branches_truncated,
            commits,
            next_cursor,
        })
    })
    .await
    .context("Git history request timed out; retry or use a smaller repository")?
}

async fn prepare_commit_review(
    state: &AppState,
    repo_root: PathBuf,
    oid: &str,
    detail_mode: DiffDetailMode,
    selected_file: Option<DiffFileSelector>,
    context_lines: Option<u32>,
) -> anyhow::Result<PreparedDiff> {
    let commit = read_commit_summary(&repo_root, oid).await?;
    let parent = commit.parent_oids.first().cloned();
    let base = parent
        .as_ref()
        .map_or(DiffEndpoint::EmptyTree, |oid| DiffEndpoint::Commit {
            oid: oid.clone(),
            short_oid: oid[..oid.len().min(12)].to_string(),
            subject: None,
        });
    let head = commit_endpoint(&commit);
    let mut prepared = prepare_git_changes(
        state,
        repo_root,
        parent.clone().unwrap_or_else(|| "EMPTY".to_string()),
        commit.oid.clone(),
        base.clone(),
        head.clone(),
        detail_mode,
        selected_file,
        context_lines,
    )
    .await?;
    prepared.comparison.current_commit_oid = Some(commit.oid.clone());
    prepared.comparison.displayed_patch_range = Some(DisplayedPatchRange { base, head });
    prepared.review = CommitStepState {
        current_commit_oid: Some(commit.oid.clone()),
        current_commit_index: Some(0),
        previous_commit_oid: parent,
        commits: vec![commit],
    };
    Ok(prepared)
}

#[cfg(test)]
async fn generate_diff(
    repo_root: &Path,
    base: &ResolvedDiffRef,
    head: &ResolvedDiffRef,
    payload_kind: DiffDetailMode,
) -> anyhow::Result<(String, bool)> {
    let left = oid_for_diff(base)?;
    let right = match head {
        ResolvedDiffRef::WorkingTree => mutable_identity(repo_root, left, "worktree").await?,
        ResolvedDiffRef::GitRef { oid, .. } => oid.clone(),
    };
    if payload_kind == DiffDetailMode::StatOnly {
        let summary = build_summary_payload(repo_root, left, &right).await?;
        Ok((summary.stat.unwrap_or_default(), summary.truncated))
    } else {
        generate_aggregate_patch(repo_root, left, &right, DEFAULT_DIFF_CONTEXT_LINES).await
    }
}

async fn summarize_files_between(
    repo_root: &Path,
    base_oid: &str,
    right: &str,
) -> anyhow::Result<(Vec<DiffFileSummary>, bool)> {
    validate_mutable_identity(repo_root, base_oid, right).await?;
    let kind = mutable_kind(right)?;
    let (mut files, mut truncated) = if kind == Some("untracked") {
        (Vec::new(), false)
    } else {
        let (numstat, numstat_truncated) = run_range_diff(
            repo_root,
            base_oid,
            right,
            &["--numstat", "-z"],
            &[],
            MAX_GIT_OUTPUT_BYTES,
        )
        .await?;
        let (name_status, status_truncated) = run_range_diff(
            repo_root,
            base_oid,
            right,
            &["--name-status", "-z"],
            &[],
            MAX_GIT_OUTPUT_BYTES,
        )
        .await?;
        (
            parse_numstat_name_status(&numstat, &name_status),
            numstat_truncated || status_truncated,
        )
    };
    if matches!(kind, Some("untracked" | "worktree")) {
        let restored = if kind == Some("worktree") {
            worktree_restored_paths(repo_root, base_oid).await?
        } else {
            Vec::new()
        };
        for path in untracked_paths(repo_root).await? {
            if restored.contains(&path) {
                continue;
            }
            let (bytes, limited, _) = read_untracked_preview(repo_root, &path)?;
            let binary = bytes.contains(&0) || (!limited && std::str::from_utf8(&bytes).is_err());
            files.push(DiffFileSummary {
                old_path: None,
                new_path: path,
                status: if binary {
                    DiffFileStatus::Binary
                } else {
                    DiffFileStatus::Added
                },
                added: if binary || limited {
                    0
                } else {
                    line_count(&bytes)
                },
                removed: 0,
            });
            truncated |= limited;
        }
    }
    validate_mutable_identity(repo_root, base_oid, right).await?;
    Ok((files, truncated))
}

fn oid_for_diff(reference: &ResolvedDiffRef) -> anyhow::Result<&str> {
    match reference {
        ResolvedDiffRef::WorkingTree => {
            bail!("working tree cannot be used as the left side of a git diff")
        }
        ResolvedDiffRef::GitRef { oid, .. } => Ok(oid),
    }
}

fn parse_numstat_name_status(numstat: &str, name_status: &str) -> Vec<DiffFileSummary> {
    let mut counts = HashMap::new();
    let mut parts = numstat.split_terminator('\0');
    while let Some(record) = parts.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = parts.next();
            let Some(new) = parts.next() else { break };
            new
        } else {
            path
        };
        counts.insert(
            path,
            (
                added.parse::<u64>().unwrap_or(0),
                removed.parse::<u64>().unwrap_or(0),
                added == "-" || removed == "-",
            ),
        );
    }
    let mut files = Vec::new();
    let mut parts = name_status.split_terminator('\0');
    while let Some(status_text) = parts.next() {
        let status = status_from_name_status(status_text);
        let Some(path) = parts.next() else { break };
        let (old_path, new_path) =
            if matches!(status, DiffFileStatus::Renamed | DiffFileStatus::Copied) {
                let Some(new) = parts.next() else { break };
                (Some(path.to_string()), new)
            } else {
                (None, path)
            };
        let (added, removed, binary) = counts.get(new_path).copied().unwrap_or_default();
        if files
            .iter()
            .any(|file: &DiffFileSummary| file.new_path == new_path)
        {
            continue;
        }
        files.push(DiffFileSummary {
            old_path,
            new_path: new_path.to_string(),
            status: if binary {
                DiffFileStatus::Binary
            } else {
                status
            },
            added,
            removed,
        });
    }
    files
}

fn status_from_name_status(status: &str) -> DiffFileStatus {
    match status.chars().next() {
        Some('A') => DiffFileStatus::Added,
        Some('M') => DiffFileStatus::Modified,
        Some('D') => DiffFileStatus::Deleted,
        Some('R') => DiffFileStatus::Renamed,
        Some('C') => DiffFileStatus::Copied,
        Some('U') => DiffFileStatus::Conflicted,
        _ => DiffFileStatus::Unknown,
    }
}

async fn ensure_review_worktree(
    state: &AppState,
    source_repo_root: &str,
    target: Option<DiffCheckoutTarget>,
) -> anyhow::Result<DiffReviewWorktree> {
    let source = discover_repo_root(source_repo_root)?;
    if let Some(existing) = current_review_worktree(state, &source).await {
        return Ok(refresh_worktree_dirty(existing).await);
    }

    let target_ref = target.unwrap_or(DiffCheckoutTarget::GitRef {
        value: "HEAD".to_string(),
    });
    let resolved = match target_ref {
        DiffCheckoutTarget::WorkingTree => resolve_git_ref(&source, "HEAD").await?,
        target => resolve_checkout_target(&source, &target).await?,
    };
    let oid = match &resolved {
        ResolvedDiffRef::GitRef { oid, .. } => oid.clone(),
        ResolvedDiffRef::WorkingTree => {
            bail!("review worktree cannot checkout the working tree pseudo-ref")
        }
    };
    let id = Uuid::new_v4().to_string();
    let worktree_base = source.join(".fura").join("review-worktrees");
    tokio::fs::create_dir_all(&worktree_base)
        .await
        .with_context(|| {
            format!(
                "failed to create review worktree directory: {}",
                worktree_base.display()
            )
        })?;
    let path = worktree_base.join(&id);

    git_stdout(
        &source,
        &[
            "worktree",
            "add",
            "--detach",
            path.to_string_lossy().as_ref(),
            &oid,
        ],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await?;
    let worktree = DiffReviewWorktree {
        id: id.clone(),
        source_repo_root: source.display().to_string(),
        path: path.display().to_string(),
        checked_out_ref: Some(resolved),
        checked_out_oid: Some(oid),
        dirty: worktree_dirty(&path).await.unwrap_or(false),
        status: DiffReviewWorktreeStatus::Ready,
        status_message: Some("Review worktree is ready.".to_string()),
    };
    let mut registry = state.review_worktrees.write().await;
    registry.by_source_repo.insert(source, id.clone());
    registry.by_id.insert(id, worktree.clone());
    Ok(worktree)
}

async fn checkout_review_worktree(
    state: &AppState,
    worktree_id: &str,
    ref_target: DiffCheckoutTarget,
) -> anyhow::Result<DiffReviewWorktree> {
    let existing = {
        let registry = state.review_worktrees.read().await;
        registry
            .by_id
            .get(worktree_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown review worktree: {worktree_id}"))?
    };
    let path = PathBuf::from(&existing.path);
    if worktree_dirty(&path).await? {
        bail!(
            "review worktree has local changes; checkout is blocked to avoid losing work: {}",
            path.display()
        );
    }
    let source = PathBuf::from(&existing.source_repo_root);
    let resolved = resolve_checkout_target(&source, &ref_target).await?;
    let oid = match &resolved {
        ResolvedDiffRef::GitRef { oid, .. } => oid.clone(),
        ResolvedDiffRef::WorkingTree => {
            bail!("cannot checkout working tree pseudo-ref into review worktree")
        }
    };
    git_stdout(&path, &["checkout", "--detach", &oid], MAX_GIT_OUTPUT_BYTES).await?;
    let mut updated = existing;
    updated.checked_out_ref = Some(resolved);
    updated.checked_out_oid = Some(oid);
    updated.dirty = worktree_dirty(&path).await.unwrap_or(false);
    updated.status = DiffReviewWorktreeStatus::Ready;
    updated.status_message = Some("Review worktree checkout completed.".to_string());
    let mut registry = state.review_worktrees.write().await;
    registry
        .by_id
        .insert(worktree_id.to_string(), updated.clone());
    Ok(updated)
}

async fn refresh_worktree_dirty(mut worktree: DiffReviewWorktree) -> DiffReviewWorktree {
    worktree.dirty = worktree_dirty(Path::new(&worktree.path))
        .await
        .unwrap_or(true);
    worktree.status = if Path::new(&worktree.path).is_dir() {
        DiffReviewWorktreeStatus::Ready
    } else {
        DiffReviewWorktreeStatus::Missing
    };
    worktree
}

async fn worktree_dirty(path: &Path) -> anyhow::Result<bool> {
    reject_worktree_filters(path, 0).await?;
    let status = git_stdout(path, &["status", "--porcelain"], MAX_GIT_OUTPUT_BYTES).await?;
    Ok(!status.trim().is_empty())
}

/// Run `git rebase <branch>` in the repository containing `cwd`, with no agent involvement.
///
/// Refuses up front — without touching the repository — when `cwd` is not a Git repository,
/// the working tree is dirty, or `branch` does not resolve. If the rebase fails for any reason
/// (conflicts included), the in-progress rebase is aborted so the repository is left on its
/// original HEAD. Returns the resolved repository root on success.
pub(crate) async fn rebase_session_repo(cwd: &str, branch: &str) -> anyhow::Result<PathBuf> {
    let repo_root = discover_repo_root(cwd)?;
    if worktree_dirty(&repo_root).await? {
        bail!("working tree has uncommitted changes — commit or stash before rebasing");
    }
    resolve_ref_to_oid(&repo_root, branch)
        .await
        .with_context(|| format!("cannot resolve branch or ref '{branch}'"))?;
    if let Err(error) = git_stdout(&repo_root, &["rebase", branch], MAX_GIT_OUTPUT_BYTES).await {
        // Restore the original HEAD. `--abort` can legitimately fail when no rebase actually
        // started (the original error already describes a clean no-op), so only escalate when a
        // rebase is genuinely left in progress — otherwise the user gets a false recovery alarm.
        let _ = git_stdout(&repo_root, &["rebase", "--abort"], MAX_GIT_OUTPUT_BYTES).await;
        if rebase_in_progress(&repo_root).await {
            return Err(error.context(
                "could not abort the failed rebase; the repository is still mid-rebase and needs manual recovery with `git rebase --abort`",
            ));
        }
        return Err(error);
    }
    Ok(repo_root)
}

/// Whether `repo_root` is currently mid-rebase (interactive/merge or apply-based), resolved via
/// `git rev-parse --git-path` so linked worktrees and custom git dirs are handled correctly.
async fn rebase_in_progress(repo_root: &Path) -> bool {
    for state in ["rebase-merge", "rebase-apply"] {
        if let Ok(path) = git_stdout(
            repo_root,
            &["rev-parse", "--git-path", state],
            MAX_GIT_OUTPUT_BYTES,
        )
        .await
        {
            if repo_root.join(path.trim()).exists() {
                return true;
            }
        }
    }
    false
}

async fn git_stdout(repo_root: &Path, args: &[&str], limit: usize) -> anyhow::Result<String> {
    let (output, truncated) = git_stdout_limited(repo_root, args, limit).await?;
    if truncated {
        bail!("git output exceeded {limit} bytes");
    }
    Ok(output)
}

async fn git_stdout_limited(
    repo_root: &Path,
    args: &[&str],
    limit: usize,
) -> anyhow::Result<(String, bool)> {
    let mut command = Command::new("git");
    command
        .current_dir(repo_root)
        .arg("--no-optional-locks")
        .arg("--literal-pathspecs")
        .args(["-c", "core.fsmonitor=false", "-c", "core.pager=cat"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let subcommand = args
        .iter()
        .find(|arg| !matches!(**arg, "--no-literal-pathspecs" | "--no-replace-objects"))
        .copied()
        .unwrap_or_default();
    if !matches!(subcommand, "rebase" | "checkout" | "worktree") {
        // Match immutable libgit2 reads: only local stored objects in the selected repository.
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        command
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_ALLOW_PROTOCOL", "")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(["--no-lazy-fetch", "-c", "protocol.allow=never"])
            .stdin(Stdio::null());
    }
    let diff_index = if matches!(args.first(), Some(&"diff" | &"diff-tree")) {
        Some(0)
    } else if args.first() == Some(&"--no-literal-pathspecs")
        && matches!(args.get(1), Some(&"diff" | &"diff-tree"))
    {
        Some(1)
    } else {
        None
    };
    if let Some(index) = diff_index {
        command
            .args(&args[..=index])
            .args(["--no-ext-diff", "--no-textconv"])
            .args(&args[index + 1..]);
    } else {
        command.args(args);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to run git {}", args.join(" ")))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("failed to capture git stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("failed to capture git stderr"))?;
    let read_stdout = async {
        let mut buffer = Vec::new();
        let mut chunk = vec![0_u8; 8192];
        let mut truncated = false;
        loop {
            let read = stdout.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            let remaining = limit.saturating_sub(buffer.len());
            buffer.extend_from_slice(&chunk[..read.min(remaining)]);
            truncated |= read > remaining;
        }
        Ok::<_, std::io::Error>((buffer, truncated))
    };
    let read_stderr = async {
        let mut buffer = Vec::new();
        let mut chunk = vec![0_u8; 8192];
        loop {
            let count = stderr.read(&mut chunk).await?;
            if count == 0 {
                break;
            }
            let remaining = 65_536_usize.saturating_sub(buffer.len());
            buffer.extend_from_slice(&chunk[..count.min(remaining)]);
        }
        Ok::<_, std::io::Error>(buffer)
    };
    let (status, (stdout, truncated), stderr) = match time::timeout(GIT_TIMEOUT, async {
        tokio::try_join!(child.wait(), read_stdout, read_stderr)
    })
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            let _ = child.kill().await;
            bail!("git command timed out: git {}", args.join(" "));
        }
    };
    if !status.success() {
        let message = String::from_utf8_lossy(&stderr).trim().to_string();
        bail!(
            "git {} failed: {}",
            args.join(" "),
            if message.is_empty() {
                status.to_string()
            } else {
                message
            }
        );
    }
    if args.contains(&"-z") && std::str::from_utf8(&stdout).is_err() {
        bail!("Git paths are not valid UTF-8; this diff cannot be represented safely");
    }
    let mut text = String::from_utf8_lossy(&stdout).into_owned();
    if truncated {
        text.push_str("\n... diff output truncated by Fura ...\n");
    }
    Ok((text, truncated))
}

pub(crate) async fn read_git_file(
    repo_root: &str,
    commit_oid: &str,
    path: &str,
) -> anyhow::Result<crate::protocol::GitFileContent> {
    validate_commit_oid(commit_oid)?;
    validate_diff_path(path)?;
    let root = discover_repo_root(repo_root)?;
    let oid = git2::Oid::from_str(commit_oid)?;
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let repository = Repository::open(&root)?;
        let commit = repository.find_commit(oid)?;
        let tree = commit.tree()?;
        let entry = tree.get_path(Path::new(&path))?;
        let blob_oid = entry.id();
        let (size, kind) = repository.odb()?.read_header(blob_oid)?;
        if kind != git2::ObjectType::Blob {
            bail!("This committed path is not a file blob (directories and submodules have no text file view)");
        }
        if size > MAX_DIFF_FILE_PATCH_BYTES {
            bail!("Committed file exceeds the 1 MB text preview limit");
        }
        let blob = repository.find_blob(blob_oid)?;
        if blob.content().contains(&0) {
            bail!("Committed file is binary; review its metadata in the diff");
        }
        let text = std::str::from_utf8(blob.content()).context("Committed file is not UTF-8 text")?.to_owned();
        Ok(crate::protocol::GitFileContent {
            repo_root: root.to_string_lossy().into_owned(),
            commit_oid: oid.to_string(),
            blob_oid: blob_oid.to_string(),
            path,
            text,
        })
    }).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, fs, process::Command as StdCommand};
    use tempfile::TempDir;

    fn git(repo: &Path, args: &[&str]) {
        let output = StdCommand::new("git")
            .current_dir(repo)
            .args(args)
            .output()
            .expect("git should run");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output(repo: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .current_dir(repo)
            .args(args)
            .output()
            .expect("git should run");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn diff_test_record(id: &str, repo: &Path, session_file: &Path) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            cwd: Some(repo.to_string_lossy().into_owned()),
            args: Vec::new(),
            status: SessionStatus::Idle,
            created_at: Timestamp::from_rpc(&serde_json::json!(0)).expect("valid timestamp"),
            updated_at: Timestamp::from_rpc(&serde_json::json!(0)).expect("valid timestamp"),
            last_message_at: None,
            persisted_message_at: None,
            file_stamp: None,
            messages: Vec::new(),
            live_message_ids: HashSet::new(),
            streaming_message: None,
            is_compacting: false,
            continuation_pending: false,
            tool_cards: Vec::new(),
            active_tool_calls: Vec::new(),
            todo_phases: None,
            kind: SessionKind::Managed,
            session_file: Some(session_file.to_string_lossy().into_owned()),
            title: Some(id.into()),
            timestamp: None,
            category: None,
            worktree: None,
            model: None,
            thinking_level: None,
            tokens_total: 0,
            cost_usd: 0.0,
            session_mode: SessionMode::Standard,
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

    fn test_diff_id() -> String {
        "550e8400-e29b-41d4-a716-446655440000".to_string()
    }

    async fn session_changes_response(state: &AppState, session_id: &str) -> ServerMessage {
        let diff_id = test_diff_id();
        let mut events = state.events.subscribe();
        let responses = handle_session_changes_request(
            state,
            "test-client".into(),
            diff_id,
            session_id.into(),
            None,
            GitChangeKind::Unstaged,
            DiffDetailMode::StatOnly,
            None,
            None,
            None,
        )
        .await;
        assert!(
            responses.is_empty(),
            "unexpected direct responses: {responses:?}"
        );
        events.recv().await.expect("session changes event")
    }

    fn write_file(repo: &Path, path: &str, text: &str) {
        let target = repo.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).expect("parent dir");
        }
        fs::write(target, text).expect("file write");
    }

    fn test_repo() -> (TempDir, PathBuf, String, String) {
        let temp = TempDir::new().expect("temp repo");
        let repo = temp.path().to_path_buf();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Test User"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        write_file(&repo, "src/lib.rs", "pub fn value() -> i32 { 1 }\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "initial"]);
        let base = StdCommand::new("git")
            .current_dir(&repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let base_oid = String::from_utf8_lossy(&base.stdout).trim().to_string();
        write_file(&repo, "src/lib.rs", "pub fn value() -> i32 { 2 }\n");
        write_file(&repo, "src/new.rs", "pub fn new_value() -> i32 { 3 }\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "change value"]);
        git(&repo, &["tag", "v-change"]);
        let head = StdCommand::new("git")
            .current_dir(&repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let head_oid = String::from_utf8_lossy(&head.stdout).trim().to_string();
        (temp, repo, base_oid, head_oid)
    }

    #[tokio::test]
    async fn resolves_refs_and_generates_full_and_stat_diff() {
        let (_temp, repo, base, head) = test_repo();
        let base_ref = resolve_diff_ref(
            &repo,
            &DiffRefInput::GitRef {
                value: base.clone(),
            },
        )
        .await
        .unwrap();
        let head_ref = resolve_diff_ref(
            &repo,
            &DiffRefInput::GitRef {
                value: "v-change".to_string(),
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            head_ref,
            ResolvedDiffRef::GitRef {
                ref_kind: DiffRefKind::Tag,
                ..
            }
        ));
        let (patch, truncated) =
            generate_diff(&repo, &base_ref, &head_ref, DiffDetailMode::FilePatch)
                .await
                .unwrap();
        assert!(!truncated);
        assert!(patch.contains("+pub fn value() -> i32 { 2 }"));
        let (stat, _) = generate_diff(
            &repo,
            &base_ref,
            &ResolvedDiffRef::GitRef {
                input: head.clone(),
                ref_kind: DiffRefKind::Commit,
                oid: head,
                display: "head".into(),
            },
            DiffDetailMode::StatOnly,
        )
        .await
        .unwrap();
        assert!(stat.contains("src/lib.rs"));
    }

    #[tokio::test]
    async fn compare_summary_includes_aggregate_patch_only_for_all_files_file_patch_mode() {
        let (_temp, repo, base, head) = test_repo();
        let app_state = crate::tests::test_state(8, None);
        let file_patch_request = DiffRequestIdentity::CompareDiff {
            client_id: "client-1".into(),
            diff_id: test_diff_id(),
            repo_root: repo.display().to_string(),
            base: DiffRefInput::GitRef {
                value: base.clone(),
            },
            head: DiffRefInput::GitRef {
                value: head.clone(),
            },
            detail_mode: DiffDetailMode::FilePatch,
            merge_base: Some(false),
            current_commit_oid: None,
            selected_file: None,
            context_lines: Some(3),
        };
        let (message, prepared) = build_compare_summary(
            &app_state,
            "client-1".into(),
            test_diff_id(),
            repo.display().to_string(),
            DiffRefInput::GitRef {
                value: base.clone(),
            },
            DiffRefInput::GitRef {
                value: head.clone(),
            },
            DiffDetailMode::FilePatch,
            Some(false),
            None,
            None,
            file_patch_request,
            Some(3),
        )
        .await
        .unwrap();
        let ServerMessage::CompareDiffSummary {
            state: summary_state,
        } = message
        else {
            panic!("expected compare diff summary");
        };
        assert_eq!(
            summary_state.comparison.detail_mode,
            DiffDetailMode::FilePatch
        );
        let (patch, truncated) = generate_aggregate_patch(
            &prepared.repo_root,
            &prepared.left_tree_or_commit,
            &prepared.right_tree_or_commit,
            prepared.comparison.context_lines,
        )
        .await
        .unwrap();
        assert!(!truncated);
        assert!(
            patch.contains("diff --git a/src/lib.rs b/src/lib.rs"),
            "{patch}"
        );
        assert!(
            patch.contains("diff --git a/src/new.rs b/src/new.rs"),
            "{patch}"
        );

        let stat_request = DiffRequestIdentity::CompareDiff {
            client_id: "client-1".into(),
            diff_id: test_diff_id(),
            repo_root: repo.display().to_string(),
            base: DiffRefInput::GitRef {
                value: base.clone(),
            },
            head: DiffRefInput::GitRef {
                value: head.clone(),
            },
            detail_mode: DiffDetailMode::StatOnly,
            merge_base: Some(false),
            current_commit_oid: None,
            selected_file: None,
            context_lines: Some(3),
        };
        let (message, _prepared) = build_compare_summary(
            &app_state,
            "client-1".into(),
            test_diff_id(),
            repo.display().to_string(),
            DiffRefInput::GitRef { value: base },
            DiffRefInput::GitRef { value: head },
            DiffDetailMode::StatOnly,
            Some(false),
            None,
            None,
            stat_request,
            Some(3),
        )
        .await
        .unwrap();
        let ServerMessage::CompareDiffSummary {
            state: summary_state,
        } = message
        else {
            panic!("expected compare diff summary");
        };
        assert_eq!(
            summary_state.comparison.detail_mode,
            DiffDetailMode::StatOnly
        );
    }

    #[tokio::test]
    async fn listed_commit_message_includes_subject_and_body() {
        let (_temp, repo, _base, head) = test_repo();
        write_file(
            &repo,
            "src/body.rs",
            "pub fn body() -> &'static str { \"body\" }\n",
        );
        git(&repo, &["add", "."]);
        git(
            &repo,
            &["commit", "-m", "body subject", "-m", "Detailed body line"],
        );
        let body_commit = git_output(&repo, &["rev-parse", "HEAD"]);

        let commits = list_commits(&repo, &head, &body_commit).await.unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "body subject");
        assert!(
            commits[0].message.contains("body subject"),
            "{:?}",
            commits[0].message
        );
        assert!(
            commits[0].message.contains("Detailed body line"),
            "{:?}",
            commits[0].message
        );
    }

    #[tokio::test]
    async fn reports_missing_ref_and_truncates_large_diff() {
        let (_temp, repo, base, head) = test_repo();
        assert!(
            resolve_diff_ref(
                &repo,
                &DiffRefInput::GitRef {
                    value: "missing-ref".to_string()
                }
            )
            .await
            .is_err()
        );
        let base_ref = ResolvedDiffRef::GitRef {
            input: base.clone(),
            ref_kind: DiffRefKind::Commit,
            oid: base,
            display: "base".into(),
        };
        let head_ref = ResolvedDiffRef::GitRef {
            input: head.clone(),
            ref_kind: DiffRefKind::Commit,
            oid: head,
            display: "head".into(),
        };
        let args = [
            "diff",
            oid_for_diff(&base_ref).unwrap(),
            oid_for_diff(&head_ref).unwrap(),
        ];
        let (_text, truncated) = git_stdout_limited(&repo, &args, 20).await.unwrap();
        assert!(truncated);
    }

    #[tokio::test]
    async fn rebase_session_repo_clean_rebase_moves_head() {
        let (_temp, repo, base, _head) = test_repo();
        git(&repo, &["checkout", "-b", "upstream", &base]);
        write_file(&repo, "UPSTREAM.md", "upstream\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "upstream change"]);
        git(&repo, &["checkout", "main"]);
        let before = git_output(&repo, &["rev-parse", "HEAD"]);

        let repo_root = rebase_session_repo(repo.to_str().unwrap(), "upstream")
            .await
            .expect("clean rebase succeeds");

        assert_eq!(repo_root, repo.canonicalize().unwrap());
        assert_ne!(before, git_output(&repo, &["rev-parse", "HEAD"]));
        assert!(repo.join("UPSTREAM.md").exists());
    }

    #[tokio::test]
    async fn rebase_session_repo_aborts_on_conflict() {
        let (_temp, repo, base, _head) = test_repo();
        git(&repo, &["checkout", "-b", "upstream", &base]);
        write_file(&repo, "src/lib.rs", "pub fn value() -> i32 { 99 }\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "conflicting upstream"]);
        git(&repo, &["checkout", "main"]);
        let before = git_output(&repo, &["rev-parse", "HEAD"]);

        let error = rebase_session_repo(repo.to_str().unwrap(), "upstream")
            .await
            .expect_err("conflicting rebase fails");
        assert!(!error.to_string().is_empty());
        // Aborted: HEAD restored and no rebase left in progress.
        assert_eq!(before, git_output(&repo, &["rev-parse", "HEAD"]));
        assert!(!repo.join(".git/rebase-merge").exists());
        assert!(!repo.join(".git/rebase-apply").exists());
    }

    #[tokio::test]
    async fn rebase_session_repo_refuses_dirty_and_unknown_inputs() {
        let (_temp, repo, _base, _head) = test_repo();
        write_file(&repo, "src/lib.rs", "uncommitted edit\n");
        let dirty = rebase_session_repo(repo.to_str().unwrap(), "main")
            .await
            .expect_err("dirty tree refused");
        assert!(dirty.to_string().contains("uncommitted"));

        git(&repo, &["checkout", "--", "."]);
        let missing = rebase_session_repo(repo.to_str().unwrap(), "no-such-branch")
            .await
            .expect_err("missing branch refused");
        assert!(missing.to_string().contains("no-such-branch"));

        let temp = TempDir::new().expect("temp dir");
        let plain = temp.path().join("plain");
        fs::create_dir_all(&plain).expect("plain dir");
        let not_repo = rebase_session_repo(plain.to_str().unwrap(), "main")
            .await
            .expect_err("non-repo refused");
        assert!(!not_repo.to_string().is_empty());
    }

    #[tokio::test]
    async fn rebase_slash_command_does_not_request_a_snapshot() {
        let (_temp, repo, base, _head) = test_repo();
        git(&repo, &["checkout", "-b", "upstream", &base]);
        write_file(&repo, "UPSTREAM.md", "upstream\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "upstream change"]);
        git(&repo, &["checkout", "main"]);

        // Keep the session file out of the repo so the rebase sees a clean working tree.
        let session_dir = TempDir::new().expect("session dir");
        let session_file = session_dir.path().join("rebase-session.jsonl");
        fs::write(&session_file, "").expect("session file");
        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".into(), diff_test_record("s1", &repo, &session_file));
        let mut commands = crate::tests::register_test_transport(&state, "s1", "s1", 4).await;

        let responses =
            crate::commands::handle_rebase_slash_command(&state, "s1".into(), "upstream").await;
        assert!(
            responses.iter().any(|message| matches!(
                message,
                ServerMessage::SessionNotice { level, .. } if matches!(level, NoticeLevel::Info)
            )),
            "expected success notice: {responses:?}"
        );

        assert!(
            commands.try_recv().is_err(),
            "rebase must not send a snapshot RPC"
        );
        assert!(repo.join("UPSTREAM.md").exists());
    }

    #[tokio::test]
    async fn rebase_slash_command_refuses_when_busy() {
        let (_temp, repo, _base, _head) = test_repo();
        let session_file = repo.join("busy-session.jsonl");
        fs::write(&session_file, "").expect("session file");
        let state = crate::tests::test_state(8, None);
        let mut record = diff_test_record("s1", &repo, &session_file);
        record.status = SessionStatus::Busy;
        state.sessions.write().await.insert("s1".into(), record);

        let responses =
            crate::commands::handle_rebase_slash_command(&state, "s1".into(), "main").await;
        assert!(responses.iter().any(|message| matches!(
            message,
            ServerMessage::SessionNotice { level, .. } if matches!(level, NoticeLevel::Error)
        )));
    }

    #[tokio::test]
    async fn rebase_slash_command_rejects_empty_or_extra_args() {
        let state = crate::tests::test_state(8, None);
        // The usage guard runs before any session lookup, so no record is needed.
        for args in ["", "main extra", "main --onto other"] {
            let responses =
                crate::commands::handle_rebase_slash_command(&state, "s1".into(), args).await;
            assert!(
                responses.iter().any(|message| matches!(
                    message,
                    ServerMessage::SessionNotice { level, text, .. }
                        if matches!(level, NoticeLevel::Error) && text.contains("Usage")
                )),
                "expected usage error for args {args:?}: {responses:?}"
            );
        }
    }

    #[tokio::test]
    async fn full_patch_payload_and_commit_stepping_preserve_requested_range() {
        let (_temp, repo, base, second) = test_repo();
        write_file(&repo, "src/lib.rs", "pub fn value() -> i32 { 4 }\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "second change"]);
        let third = git_output(&repo, &["rev-parse", "HEAD"]);

        let state = crate::tests::test_state(8, None);
        let selector = DiffFileSelector {
            old_path: None,
            new_path: "src/lib.rs".into(),
        };
        let request = DiffRequestIdentity::CompareDiff {
            client_id: "client-1".into(),
            diff_id: test_diff_id(),
            repo_root: repo.display().to_string(),
            base: DiffRefInput::GitRef {
                value: base.clone(),
            },
            head: DiffRefInput::GitRef {
                value: third.clone(),
            },
            detail_mode: DiffDetailMode::FilePatch,
            merge_base: Some(false),
            current_commit_oid: Some(third.clone()),
            selected_file: Some(selector.clone()),
            context_lines: Some(3),
        };
        let (_refs, prepared) = prepare_compare_diff(
            &state,
            "client-1".into(),
            test_diff_id(),
            repo.display().to_string(),
            DiffRefInput::GitRef {
                value: base.clone(),
            },
            DiffRefInput::GitRef {
                value: third.clone(),
            },
            DiffDetailMode::FilePatch,
            Some(false),
            Some(third.clone()),
            Some(selector.clone()),
            request,
            Some(3),
        )
        .await
        .unwrap();

        assert_eq!(
            prepared.review.current_commit_oid.as_deref(),
            Some(third.as_str())
        );
        assert_eq!(prepared.review.current_commit_index, Some(1));
        assert!(
            matches!(&prepared.comparison.base, DiffEndpoint::GitRef { oid, .. } if oid == &base)
        );
        assert!(
            matches!(&prepared.comparison.head, DiffEndpoint::GitRef { oid, .. } if oid == &third)
        );
        assert_eq!(prepared.left_tree_or_commit, second);
        assert_eq!(prepared.right_tree_or_commit, third);
        let (patch, _truncated) = generate_file_patch(
            &prepared.repo_root,
            &prepared.left_tree_or_commit,
            &prepared.right_tree_or_commit,
            &selector,
            3,
        )
        .await
        .unwrap();
        assert!(patch.contains("+pub fn value() -> i32 { 4 }"), "{}", patch);
    }

    #[tokio::test]
    async fn stale_selected_commit_falls_back_to_full_range() {
        let (_temp, repo, base, head) = test_repo();
        let state = crate::tests::test_state(8, None);
        let stale_commit = "a20553a8d05573dc81c4b41f69d0a6abcaefd811".to_string();
        let request = DiffRequestIdentity::CompareDiff {
            client_id: "client-1".into(),
            diff_id: test_diff_id(),
            repo_root: repo.display().to_string(),
            base: DiffRefInput::GitRef {
                value: base.clone(),
            },
            head: DiffRefInput::GitRef {
                value: head.clone(),
            },
            detail_mode: DiffDetailMode::FilePatch,
            merge_base: Some(false),
            current_commit_oid: Some(stale_commit.clone()),
            selected_file: None,
            context_lines: Some(3),
        };

        let (_refs, prepared) = prepare_compare_diff(
            &state,
            "client-1".into(),
            test_diff_id(),
            repo.display().to_string(),
            DiffRefInput::GitRef {
                value: base.clone(),
            },
            DiffRefInput::GitRef {
                value: head.clone(),
            },
            DiffDetailMode::FilePatch,
            Some(false),
            Some(stale_commit),
            None,
            request,
            Some(3),
        )
        .await
        .unwrap();

        assert_eq!(prepared.review.current_commit_oid, None);
        assert_eq!(prepared.review.current_commit_index, None);
        assert_eq!(prepared.review.previous_commit_oid, None);
        assert_eq!(prepared.left_tree_or_commit, base);
        assert_eq!(prepared.right_tree_or_commit, head);
    }

    #[test]
    fn parse_name_status_rewrites_preserve_loadable_selectors() {
        let summaries = parse_numstat_name_status(
            concat!(
                "0\t0\t\0src/old.rs\0src/new.rs\0",
                "0\t0\t\0src/base.rs\0src/copy.rs\0"
            ),
            "R100\0src/old.rs\0src/new.rs\0C100\0src/base.rs\0src/copy.rs\0",
        );
        assert_eq!(summaries.len(), 2);
        assert!(matches!(summaries[0].status, DiffFileStatus::Renamed));
        assert_eq!(summaries[0].old_path.as_deref(), Some("src/old.rs"));
        assert_eq!(summaries[0].new_path, "src/new.rs");
        assert!(matches!(summaries[1].status, DiffFileStatus::Copied));
        assert_eq!(summaries[1].old_path.as_deref(), Some("src/base.rs"));
        assert_eq!(summaries[1].new_path, "src/copy.rs");
    }

    #[tokio::test]
    async fn renamed_file_summary_selector_loads_lazy_patch() {
        let (_temp, repo, _base, before_rename) = test_repo();
        git(&repo, &["mv", "src/lib.rs", "src/renamed.rs"]);
        git(&repo, &["commit", "-am", "rename file"]);
        let after_rename = git_output(&repo, &["rev-parse", "HEAD"]);

        let (files, truncated) = summarize_files_between(&repo, &before_rename, &after_rename)
            .await
            .unwrap();
        assert!(!truncated);
        let summary = files
            .iter()
            .find(|summary| matches!(summary.status, DiffFileStatus::Renamed))
            .expect("rename summary");
        assert_eq!(summary.old_path.as_deref(), Some("src/lib.rs"));
        assert_eq!(summary.new_path, "src/renamed.rs");

        let (patch, patch_truncated) = generate_file_patch(
            &repo,
            &before_rename,
            &after_rename,
            &DiffFileSelector {
                old_path: summary.old_path.clone(),
                new_path: summary.new_path.clone(),
            },
            3,
        )
        .await
        .unwrap();
        assert!(!patch_truncated);
        assert!(patch.contains("rename from src/lib.rs"), "{patch}");
        assert!(patch.contains("rename to src/renamed.rs"), "{patch}");
    }

    #[tokio::test]
    async fn superseded_generation_errors_are_suppressed() {
        let state = crate::tests::test_state(8, None);
        let mut events = state.events.subscribe();
        let old_handle = tokio::spawn(async {});
        register_generation_job(
            &state,
            "client-1".into(),
            DiffScope::CompareDiff,
            "diff-old".into(),
            1,
            old_handle,
        )
        .await;
        let new_handle = tokio::spawn(async {});
        register_generation_job(
            &state,
            "client-1".into(),
            DiffScope::CompareDiff,
            "diff-new".into(),
            2,
            new_handle,
        )
        .await;

        assert!(
            !is_current_generation(&state, "client-1", DiffScope::CompareDiff, "diff-old", 1).await
        );
        if is_current_generation(&state, "client-1", DiffScope::CompareDiff, "diff-old", 1).await {
            let _ = state
                .events
                .emit(
                    &state,
                    diff_error(
                        Some("client-1".into()),
                        Some("diff-old".into()),
                        DiffErrorScope::CompareDiff,
                        None,
                        Some("repo".into()),
                        anyhow!("stale error"),
                    ),
                )
                .await;
        }
        loop {
            match tokio::time::timeout(std::time::Duration::from_millis(50), events.recv()).await {
                Ok(Ok(ServerMessage::DiffCancelled { .. })) => continue,
                Ok(Ok(ServerMessage::DiffError { .. })) => panic!("stale diff error emitted"),
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
    }

    #[tokio::test]
    async fn lists_commits_and_creates_safe_review_worktree() {
        let (_temp, repo, base, head) = test_repo();
        let commits = list_commits(&repo, &base, &head).await.unwrap();
        assert_eq!(commits.len(), 1);
        assert!(!commits[0].is_merge);

        let mut state = crate::tests::test_state(8, None);
        state.session_root = repo.join("sessions");
        let worktree = ensure_review_worktree(
            &state,
            repo.to_str().unwrap(),
            Some(DiffCheckoutTarget::Commit { oid: head.clone() }),
        )
        .await
        .unwrap();
        assert!(Path::new(&worktree.path).is_dir());
        let source_head = git_stdout(&repo, &["rev-parse", "HEAD"], MAX_GIT_OUTPUT_BYTES)
            .await
            .unwrap();
        assert_eq!(source_head.trim(), head);

        write_file(Path::new(&worktree.path), "dirty.txt", "dirty\n");
        let blocked = checkout_review_worktree(
            &state,
            &worktree.id,
            DiffCheckoutTarget::Commit { oid: base },
        )
        .await;
        assert!(blocked.is_err());
    }
    #[tokio::test]
    async fn staged_and_unstaged_keep_distinct_versions_and_reject_stale_lazy_reads() {
        let (_temp, repo, _, _) = test_repo();
        write_file(&repo, "src/lib.rs", "staged content\n");
        git(&repo, &["add", "src/lib.rs"]);
        write_file(&repo, "src/lib.rs", "working content\n");
        let (staged_left, staged_right, _, _) = git_change_range(&repo, GitChangeKind::Staged)
            .await
            .unwrap();
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        let file = DiffFileSelector {
            old_path: None,
            new_path: "src/lib.rs".into(),
        };
        let (staged, _) = generate_file_patch(&repo, &staged_left, &staged_right, &file, 3)
            .await
            .unwrap();
        let (unstaged, _) = generate_file_patch(&repo, &left, &right, &file, 3)
            .await
            .unwrap();
        assert!(staged.contains("+staged content") && !staged.contains("working content"));
        assert!(unstaged.contains("-staged content") && unstaged.contains("+working content"));
        assert_ne!(staged_right, right);
        let summary = build_summary_payload(&repo, &left, &right).await.unwrap();
        assert_eq!(summary.files[0].new_path, "src/lib.rs");
        write_file(&repo, "src/lib.rs", "another content\n");
        assert!(
            generate_file_patch(&repo, &left, &right, &file, 3)
                .await
                .is_err()
        );
        assert!(
            generate_aggregate_patch(&repo, &left, &right, 3)
                .await
                .is_err()
        );
        let (_, changed, _, _) = git_change_range(&repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        assert_ne!(right, changed);
        // An unrelated disk edit does not invalidate a HEAD-to-index patch.
        assert!(
            generate_file_patch(&repo, &staged_left, &staged_right, &file, 3)
                .await
                .unwrap()
                .0
                .contains("+staged content")
        );
        git(&repo, &["add", "src/lib.rs"]);
        assert!(
            generate_file_patch(&repo, &staged_left, &staged_right, &file, 3)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn untracked_excludes_ignored_and_preserves_literal_paths_and_empty_files() {
        let (_temp, repo, _, _) = test_repo();
        write_file(&repo, ".git/info/exclude", "ignored.txt\n");
        write_file(&repo, "ignored.txt", "secret ignored content\n");
        let name = "tab\tand\nnewline.txt";
        write_file(&repo, name, "new content\n");
        write_file(&repo, "empty.txt", "");
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Untracked)
            .await
            .unwrap();
        let summary = build_summary_payload(&repo, &left, &right).await.unwrap();
        assert_eq!(
            summary
                .files
                .iter()
                .map(|file| file.new_path.as_str())
                .collect::<Vec<_>>(),
            vec!["empty.txt", name]
        );
        let selector = DiffFileSelector {
            old_path: None,
            new_path: name.into(),
        };
        let (patch, _) = generate_file_patch(&repo, &left, &right, &selector, 3)
            .await
            .unwrap();
        assert!(patch.contains("+new content"));
        assert!(parse_diff_rows(&patch).iter().any(|row| matches!(row, DiffRow::Line { location, .. } if location.new_path == name && location.new_line == Some(1))));
        let (patch, _) = generate_aggregate_patch(&repo, &left, &right, 3)
            .await
            .unwrap();
        assert!(patch.contains("empty.txt") && !patch.contains("secret ignored content"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn untracked_symlinks_show_link_targets_not_external_contents() {
        let (_temp, repo, _, _) = test_repo();
        let outside = TempDir::new().unwrap();
        write_file(outside.path(), "secret", "MUST NOT READ THIS CONTENT\n");
        std::os::unix::fs::symlink(outside.path().join("secret"), repo.join("link")).unwrap();
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Untracked)
            .await
            .unwrap();
        let (patch, _) = generate_aggregate_patch(&repo, &left, &right, 3)
            .await
            .unwrap();
        assert!(patch.contains("new file mode 120000"));
        assert!(patch.contains(outside.path().to_str().unwrap()));
        assert!(!patch.contains("MUST NOT READ THIS CONTENT"));
        std::os::unix::fs::symlink(outside.path(), repo.join("escape")).unwrap();
        assert!(read_untracked_preview(&repo, "escape/secret").is_err());
    }

    #[tokio::test]
    async fn unborn_repository_has_independent_staged_unstaged_and_untracked_additions() {
        let temp = TempDir::new().unwrap();
        let repo = temp.path();
        git(repo, &["init", "-b", "main"]);
        write_file(repo, "file", "index\n");
        git(repo, &["add", "file"]);
        write_file(repo, "file", "disk\n");
        write_file(repo, "new", "untracked\n");
        let (left, right, base, head) =
            git_change_range(repo, GitChangeKind::Staged).await.unwrap();
        assert!(matches!(
            (base, head),
            (DiffEndpoint::EmptyTree, DiffEndpoint::Index)
        ));
        assert!(
            generate_aggregate_patch(repo, &left, &right, 3)
                .await
                .unwrap()
                .0
                .contains("+index")
        );
        let (left, right, _, _) = git_change_range(repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        let (patch, _) = generate_aggregate_patch(repo, &left, &right, 3)
            .await
            .unwrap();
        assert!(patch.contains("-index") && patch.contains("+disk"));
        let (left, right, _, _) = git_change_range(repo, GitChangeKind::Untracked)
            .await
            .unwrap();
        assert_eq!(
            build_summary_payload(repo, &left, &right)
                .await
                .unwrap()
                .files[0]
                .new_path,
            "new"
        );
    }

    #[tokio::test]
    async fn git_groups_preserve_renames_deletions_binary_and_large_file_limits() {
        let (_temp, repo, _, _) = test_repo();
        git(&repo, &["mv", "src/lib.rs", "src/renamed.rs"]);
        git(&repo, &["rm", "src/new.rs"]);
        fs::write(repo.join("binary"), [0, 1, 2]).unwrap();
        git(&repo, &["add", "binary"]);
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Staged)
            .await
            .unwrap();
        let summary = build_summary_payload(&repo, &left, &right).await.unwrap();
        assert!(
            summary
                .files
                .iter()
                .any(|file| file.status == DiffFileStatus::Renamed
                    && file.old_path.as_deref() == Some("src/lib.rs"))
        );
        assert!(summary.files.iter().any(|file| file.status == DiffFileStatus::Deleted && file.new_path == "src/new.rs"));
        assert!(
            summary
                .files
                .iter()
                .any(|file| file.status == DiffFileStatus::Binary && file.new_path == "binary")
        );
        let selector = DiffFileSelector {
            old_path: Some("src/lib.rs".into()),
            new_path: "src/renamed.rs".into(),
        };
        assert!(
            generate_file_patch(&repo, &left, &right, &selector, 3)
                .await
                .unwrap()
                .0
                .contains("rename to src/renamed.rs")
        );
        fs::write(
            repo.join("huge"),
            "large line\n".repeat(MAX_DIFF_FILE_PATCH_BYTES / 5),
        )
        .unwrap();
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Untracked)
            .await
            .unwrap();
        let (patch, limited) = generate_aggregate_patch(&repo, &left, &right, 3)
            .await
            .unwrap();
        assert!(limited && patch.contains("size limit"));
        git(&repo, &["add", "huge"]);
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Staged)
            .await
            .unwrap();
        let (_, limited) = generate_file_patch(
            &repo,
            &left,
            &right,
            &DiffFileSelector {
                old_path: None,
                new_path: "huge".into(),
            },
            3,
        )
        .await
        .unwrap();
        assert!(limited);
    }

    #[tokio::test]
    async fn conflicts_are_visible_without_fabricated_two_sided_comment_anchors() {
        let (_temp, repo, base, _) = test_repo();
        git(&repo, &["checkout", "-b", "other", &base]);
        write_file(&repo, "src/lib.rs", "conflicting branch\n");
        git(&repo, &["commit", "-am", "conflict"]);
        git(&repo, &["checkout", "main"]);
        assert!(
            !StdCommand::new("git")
                .current_dir(&repo)
                .args(["merge", "other"])
                .output()
                .unwrap()
                .status
                .success()
        );
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        let summary = build_summary_payload(&repo, &left, &right).await.unwrap();
        assert!(
            summary
                .files
                .iter()
                .any(|file| file.new_path == "src/lib.rs"
                    && file.status == DiffFileStatus::Conflicted)
        );
        let (patch, _) = generate_aggregate_patch(&repo, &left, &right, 3)
            .await
            .unwrap();
        assert!(patch.contains("<<<<<<<") && patch.contains(">>>>>>>"));
        assert!(
            !parse_diff_rows(&patch)
                .iter()
                .any(|row| matches!(row, DiffRow::Line { .. }))
        );
    }

    #[tokio::test]
    async fn old_snapshot_entries_do_not_change_git_changes_or_require_snapshot_refs() {
        let (_temp, repo, base, _) = test_repo();
        let session_dir = TempDir::new().unwrap();
        let session_file = session_dir.path().join("old.jsonl");
        let snapshot = serde_json::json!({
            "type": "custom", "customType": "repo-diff-snapshot", "id": "obsolete",
            "data": { "version": 1, "kind": "session-start", "repoRoot": repo,
                "ref": "refs/omp/diff-snapshots/missing", "commit": base, "tree": "missing" }
        });
        fs::write(&session_file, format!("{snapshot}\n")).unwrap();
        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("old".into(), diff_test_record("old", &repo, &session_file));
        let response = session_changes_response(&state, "old").await;
        let ServerMessage::SessionChangesSummary {
            state:
                SessionChangesSummaryState::Ready {
                    summary,
                    comparison,
                    ..
                },
        } = response
        else {
            panic!("Git changes should load without snapshot refs")
        };
        assert!(summary.files.is_empty());
        assert!(matches!(comparison.base, DiffEndpoint::Index));
        assert_eq!(
            fs::read_to_string(&session_file).unwrap(),
            format!("{snapshot}\n")
        );
    }

    fn repository_bytes(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
        fn visit(
            root: &Path,
            path: &Path,
            files: &mut std::collections::BTreeMap<PathBuf, Vec<u8>>,
        ) {
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if entry.file_type().unwrap().is_dir() {
                    visit(root, &path, files);
                } else {
                    files.insert(
                        path.strip_prefix(root).unwrap().to_path_buf(),
                        if entry.file_type().unwrap().is_symlink() {
                            fs::read_link(&path)
                                .unwrap()
                                .as_os_str()
                                .as_encoded_bytes()
                                .to_vec()
                        } else {
                            fs::read(path).unwrap()
                        },
                    );
                }
            }
        }
        let mut files = std::collections::BTreeMap::new();
        visit(root, root, &mut files);
        files
    }

    #[tokio::test]
    async fn reading_every_git_group_and_worktree_compare_changes_no_repository_bytes() {
        let (_temp, repo, base, _) = test_repo();
        git(
            &repo,
            &["update-ref", "refs/omp/diff-snapshots/existing", &base],
        );
        write_file(&repo, "src/lib.rs", "staged\n");
        git(&repo, &["add", "src/lib.rs"]);
        write_file(&repo, "src/lib.rs", "disk\n");
        write_file(&repo, "new.txt", "new\n");
        let before = repository_bytes(&repo);
        for kind in [
            GitChangeKind::Staged,
            GitChangeKind::Unstaged,
            GitChangeKind::Untracked,
        ] {
            let (left, right, _, _) = git_change_range(&repo, kind).await.unwrap();
            let summary = build_summary_payload(&repo, &left, &right).await.unwrap();
            generate_aggregate_patch(&repo, &left, &right, 3)
                .await
                .unwrap();
            for file in summary.files {
                generate_file_patch(
                    &repo,
                    &left,
                    &right,
                    &DiffFileSelector {
                        old_path: file.old_path,
                        new_path: file.new_path,
                    },
                    3,
                )
                .await
                .unwrap();
            }
        }
        let right = mutable_identity(&repo, &base, "worktree").await.unwrap();
        let (patch, _) = generate_aggregate_patch(&repo, &base, &right, 3)
            .await
            .unwrap();
        assert!(patch.contains("+disk") && patch.contains("+new"));
        build_summary_payload(&repo, &base, &right).await.unwrap();
        assert_eq!(
            before,
            repository_bytes(&repo),
            "index, HEAD, files, refs, logs and complete object inventory must remain byte-identical"
        );
        write_file(&repo, "new.txt", "changed\n");
        assert!(
            generate_aggregate_patch(&repo, &base, &right, 3)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn merge_base_compare_uses_the_common_ancestor_for_the_patch() {
        let (_temp, repo, base, head) = test_repo();
        git(&repo, &["checkout", "-b", "other-base", &base]);
        write_file(&repo, "other-only", "other branch\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "other branch"]);
        let other = git_output(&repo, &["rev-parse", "HEAD"]);
        let state = crate::tests::test_state(8, None);
        let base_ref = resolve_git_ref(&repo, &other).await.unwrap();
        let head_ref = resolve_git_ref(&repo, &head).await.unwrap();
        let prepared = prepare_diff_range(
            &state,
            repo.clone(),
            endpoint_from_resolved(&base_ref),
            endpoint_from_resolved(&head_ref),
            base_ref,
            head_ref,
            DiffDetailMode::FilePatch,
            true,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let (patch, _) = generate_aggregate_patch(
            &repo,
            &prepared.left_tree_or_commit,
            &prepared.right_tree_or_commit,
            3,
        )
        .await
        .unwrap();
        assert!(patch.contains("+pub fn value() -> i32 { 2 }"));
        assert!(!patch.contains("other-only"));
    }
    #[tokio::test]
    async fn git_reads_disable_external_diff_and_textconv_and_version_attributes() {
        let (_temp, repo, _, _) = test_repo();
        git(&repo, &["config", "diff.external", "false"]);
        git(&repo, &["config", "diff.test.textconv", "false"]);
        write_file(&repo, ".git/info/attributes", "src/lib.rs diff=test\n");
        write_file(&repo, "src/lib.rs", "safe native diff\n");
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        let (patch, _) = generate_aggregate_patch(&repo, &left, &right, 3)
            .await
            .unwrap();
        assert!(patch.contains("+safe native diff"));
        write_file(&repo, ".git/info/attributes", "src/lib.rs -diff\n");
        assert!(
            generate_aggregate_patch(&repo, &left, &right, 3)
                .await
                .is_err()
        );
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        assert!(
            generate_aggregate_patch(&repo, &left, &right, 3)
                .await
                .unwrap()
                .0
                .contains("Binary files")
        );
    }

    #[tokio::test]
    async fn submodule_checkout_and_dirty_state_invalidate_old_patch_identity() {
        let (_source_temp, source, first, second) = test_repo();
        write_file(&source, "src/lib.rs", "third\n");
        git(&source, &["commit", "-am", "third"]);
        let third = git_output(&source, &["rev-parse", "HEAD"]);
        let (_temp, repo, _, _) = test_repo();
        git(
            &repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.to_str().unwrap(),
                "sub",
            ],
        );
        git(&repo.join("sub"), &["checkout", "--detach", &first]);
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "pin first"]);
        git(&repo.join("sub"), &["checkout", "--detach", &second]);
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        let file = DiffFileSelector {
            old_path: None,
            new_path: "sub".into(),
        };
        let before = generate_file_patch(&repo, &left, &right, &file, 3)
            .await
            .unwrap()
            .0;
        assert!(before.contains(&format!("+Subproject commit {second}")));
        git(&repo.join("sub"), &["checkout", "--detach", &third]);
        assert!(
            generate_file_patch(&repo, &left, &right, &file, 3)
                .await
                .is_err()
        );
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        write_file(&repo.join("sub"), "src/lib.rs", "dirty\n");
        assert!(
            generate_file_patch(&repo, &left, &right, &file, 3)
                .await
                .is_err()
        );
        let (left, right, _, _) = git_change_range(&repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        assert!(
            generate_file_patch(&repo, &left, &right, &file, 3)
                .await
                .unwrap()
                .0
                .contains(&format!("{third}-dirty"))
        );
    }

    #[tokio::test]
    async fn worktree_compare_reconciles_removed_index_paths_in_patch_summary_and_stat() {
        let (_temp, repo, _, _) = test_repo();
        let paths = ["same.txt", "-leading", "line\nname", "quote\"name"];
        for path in paths {
            write_file(&repo, path, "base\n");
        }
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "literal files"]);
        let base = git_output(&repo, &["rev-parse", "HEAD"]);
        for path in paths {
            git(&repo, &["rm", "--cached", "--", path]);
        }
        let before = repository_bytes(&repo);
        let right = mutable_identity(&repo, &base, "worktree").await.unwrap();
        assert!(
            generate_aggregate_patch(&repo, &base, &right, 3)
                .await
                .unwrap()
                .0
                .trim()
                .is_empty()
        );
        let summary = build_summary_payload(&repo, &base, &right).await.unwrap();
        assert!(summary.files.is_empty());
        assert!(summary.stat.unwrap().trim().is_empty());
        assert_eq!(before, repository_bytes(&repo));
        for path in paths {
            write_file(&repo, path, "changed\n");
        }
        let before = repository_bytes(&repo);
        let right = mutable_identity(&repo, &base, "worktree").await.unwrap();
        let summary = build_summary_payload(&repo, &base, &right).await.unwrap();
        assert_eq!(summary.files.len(), paths.len());
        for path in paths {
            let file = summary
                .files
                .iter()
                .find(|file| file.new_path == path)
                .unwrap();
            assert_eq!(file.status, DiffFileStatus::Modified);
            assert_eq!((file.added, file.removed), (1, 1));
            let patch = generate_file_patch(
                &repo,
                &base,
                &right,
                &DiffFileSelector {
                    old_path: file.old_path.clone(),
                    new_path: path.to_string(),
                },
                3,
            )
            .await
            .unwrap()
            .0;
            assert_eq!(patch.matches("diff --git ").count(), 1);
            assert!(patch.contains("-base\n") && patch.contains("+changed\n"));
            assert!(!patch.contains("deleted file mode") && !patch.contains("new file mode"));
            assert!(parse_diff_rows(&patch).iter().any(|row| matches!(
                row, DiffRow::Line { location, .. } if location.new_path == path
            )));
        }
        let stat = summary.stat.unwrap();
        assert!(stat.contains("4 insertions(+)") && stat.contains("4 deletions(-)"));
        assert_eq!(before, repository_bytes(&repo));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn worktree_restored_paths_preserve_symlinks_binary_and_file_modes() {
        use std::os::unix::{fs::PermissionsExt, fs::symlink};
        let (_temp, repo, _, _) = test_repo();
        symlink("old-target", repo.join("link")).unwrap();
        fs::write(repo.join("binary"), b"old\0data").unwrap();
        write_file(&repo, "mode", "unchanged\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "special files"]);
        let base = git_output(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["rm", "--cached", "link", "binary", "mode"]);
        let right = mutable_identity(&repo, &base, "worktree").await.unwrap();
        assert!(
            build_summary_payload(&repo, &base, &right)
                .await
                .unwrap()
                .files
                .is_empty()
        );
        fs::remove_file(repo.join("link")).unwrap();
        symlink("new-target", repo.join("link")).unwrap();
        fs::write(repo.join("binary"), b"new\0data").unwrap();
        fs::set_permissions(repo.join("mode"), fs::Permissions::from_mode(0o755)).unwrap();
        let before = repository_bytes(&repo);
        let right = mutable_identity(&repo, &base, "worktree").await.unwrap();
        let summary = build_summary_payload(&repo, &base, &right).await.unwrap();
        assert_eq!(summary.files.len(), 3);
        assert_eq!(
            summary
                .files
                .iter()
                .find(|file| file.new_path == "binary")
                .unwrap()
                .status,
            DiffFileStatus::Binary
        );
        let patch = generate_aggregate_patch(&repo, &base, &right, 3)
            .await
            .unwrap()
            .0;
        assert!(patch.contains("-old-target") && patch.contains("+new-target"));
        assert!(patch.contains("old mode 100644") && patch.contains("new mode 100755"));
        assert!(patch.contains("Binary files"));
        assert_eq!(before, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn selected_root_and_merge_commits_review_without_prior_range_or_repository_writes() {
        let (_temp, repo, root, first_parent) = test_repo();
        git(&repo, &["checkout", "-b", "side", &root]);
        write_file(&repo, "side-file", "side\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "side commit"]);
        let second_parent = git_output(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "main"]);
        git(
            &repo,
            &[
                "merge",
                "--no-ff",
                "side",
                "-m",
                "merge subject\n\nMerge body",
            ],
        );
        let merge = git_output(&repo, &["rev-parse", "HEAD"]);
        let before = repository_bytes(&repo);
        let state = crate::tests::test_state(8, None);
        let prepared = prepare_commit_review(
            &state,
            repo.clone(),
            &root,
            DiffDetailMode::FilePatch,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(prepared.left_tree_or_commit, "EMPTY");
        assert!(matches!(prepared.comparison.base, DiffEndpoint::EmptyTree));
        assert_eq!(prepared.review.commits[0].oid, root);
        assert!(prepared.review.previous_commit_oid.is_none());
        let summary = build_summary_payload(
            &repo,
            &prepared.left_tree_or_commit,
            &prepared.right_tree_or_commit,
        )
        .await
        .unwrap();
        assert_eq!(summary.files[0].status, DiffFileStatus::Added);
        let patch = generate_file_patch(
            &repo,
            &prepared.left_tree_or_commit,
            &prepared.right_tree_or_commit,
            &DiffFileSelector {
                old_path: None,
                new_path: "src/lib.rs".into(),
            },
            3,
        )
        .await
        .unwrap()
        .0;
        assert!(patch.contains("+pub fn value() -> i32 { 1 }"));
        let prepared = prepare_commit_review(
            &state,
            repo.clone(),
            &merge,
            DiffDetailMode::FilePatch,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(prepared.left_tree_or_commit, first_parent);
        assert_eq!(
            prepared.review.commits[0].parent_oids,
            [first_parent, second_parent]
        );
        assert!(prepared.review.commits[0].is_merge);
        assert!(prepared.review.commits[0].message.contains("Merge body"));
        let summary = build_summary_payload(
            &repo,
            &prepared.left_tree_or_commit,
            &prepared.right_tree_or_commit,
        )
        .await
        .unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].new_path, "side-file");
        assert_eq!(before, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn history_ref_json_dispatch_reads_topic_not_checked_out_main() {
        let (temp, repo, root, head) = test_repo();
        git(&repo, &["branch", "topic", &root]);
        let before = repository_bytes(&repo);
        let state = crate::tests::test_state(16, None);
        state.sessions.write().await.insert(
            "history-topic".into(),
            diff_test_record("history-topic", &repo, &temp.path().join("session.jsonl")),
        );
        let mut events = state.events.subscribe();
        for (selected, expected) in [
            (Some(serde_json::json!("refs/heads/topic")), &root),
            (None, &head),
            (Some(serde_json::Value::Null), &head),
        ] {
            let mut request = serde_json::json!({
                "type": "git.history.request",
                "clientId": "history-client",
                "requestId": "topic-request",
                "sessionId": "history-topic"
            });
            if let Some(selected) = selected {
                request["historyRef"] = selected;
            }
            let message: ClientMessage = serde_json::from_value(request).unwrap();
            assert!(
                crate::commands::handle_client_message_for_connection(&state, message, 91)
                    .await
                    .is_empty()
            );
            let event = time::timeout(Duration::from_secs(20), async {
                loop {
                    let event = events.recv().await.unwrap();
                    if matches!(event, ServerMessage::GitHistory { .. }) {
                        break event;
                    }
                }
            })
            .await
            .unwrap();
            let ServerMessage::GitHistory { page, error, .. } = event else {
                unreachable!();
            };
            assert!(error.is_none(), "{error:?}");
            let page = page.unwrap();
            assert_eq!(
                &page.commits[0].oid, expected,
                "historyRef must select topic, not HEAD"
            );
            assert_eq!(page.head_oid.as_deref(), Some(head.as_str()));
            assert_eq!(page.branch.as_deref(), Some("main"));
        }
        assert_eq!(before, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn history_ref_pins_local_remote_and_deleted_branches_without_checkout() {
        let (_temp, repo, root, head) = test_repo();
        let topic = {
            let repository = Repository::open(&repo).unwrap();
            let signature =
                git2::Signature::now("History Tester", "history@example.invalid").unwrap();
            let mut tip = git2::Oid::from_str(&root).unwrap();
            for index in 0..34 {
                let parent = repository.find_commit(tip).unwrap();
                tip = repository
                    .commit(
                        None,
                        &signature,
                        &signature,
                        &format!("topic {index}"),
                        &parent.tree().unwrap(),
                        &[&parent],
                    )
                    .unwrap();
            }
            repository
                .reference("refs/heads/topic", tip, false, "fixture")
                .unwrap();
            repository
                .reference("refs/remotes/origin/topic", tip, false, "fixture")
                .unwrap();
            repository
                .reference_symbolic("refs/heads/alias", "refs/heads/topic", false, "fixture")
                .unwrap();
            repository
                .reference_symbolic(
                    "refs/remotes/origin/HEAD",
                    "refs/remotes/origin/topic",
                    false,
                    "fixture",
                )
                .unwrap();
            tip.to_string()
        };
        git(&repo, &["tag", "topic", &head]);
        write_file(&repo, "src/lib.rs", "staged fixture\n");
        git(&repo, &["add", "src/lib.rs"]);
        write_file(&repo, "src/lib.rs", "unstaged fixture\n");
        write_file(&repo, "untracked", "keep\n");
        let before = repository_bytes(&repo);
        let expected: Vec<String> =
            git_output(&repo, &["rev-list", "--topo-order", "refs/heads/topic"])
                .lines()
                .map(str::to_string)
                .collect();
        let first = list_git_history(&repo.join("src"), Some("refs/heads/topic"), None)
            .await
            .unwrap();
        assert_eq!(first.commits[0].oid, topic);
        assert_eq!(first.history_ref.as_deref(), Some("refs/heads/topic"));
        assert_eq!(first.history_head_oid.as_deref(), Some(topic.as_str()));
        assert_eq!(first.history_tip_oid.as_deref(), Some(topic.as_str()));
        assert_eq!(first.head_oid.as_deref(), Some(head.as_str()));
        assert_eq!(first.branch.as_deref(), Some("main"));
        let branches = first.branches.as_ref().unwrap();
        assert_eq!(
            branches
                .iter()
                .map(|branch| branch.name.as_str())
                .collect::<Vec<_>>(),
            [
                "refs/heads/main",
                "refs/heads/topic",
                "refs/remotes/origin/topic"
            ]
        );
        assert_eq!(branches[1].oid, topic);
        assert_eq!(branches[2].ref_kind, DiffRefKind::Remote);
        let remote = list_git_history(&repo, Some("refs/remotes/origin/topic"), None)
            .await
            .unwrap();
        assert_eq!(remote.commits[0].oid, topic);
        for name in [
            "",
            "HEAD",
            "topic",
            "--all",
            "refs/tags/topic",
            "refs/heads/topic~1",
            "refs/heads/topic^{commit}",
            "refs/heads/topic:src/lib.rs",
            "refs/heads/../topic",
            "refs/heads/topic@{0}",
            "refs/heads/topic\n",
            "refs/heads/alias",
            "refs/remotes/origin/HEAD",
            "refs/heads/missing",
        ] {
            assert!(
                list_git_history(&repo, Some(name), None).await.is_err(),
                "{name:?}"
            );
        }
        let cursor = first.next_cursor.as_deref().unwrap();
        for selected in [
            None,
            Some("refs/heads/main"),
            Some("refs/remotes/origin/topic"),
        ] {
            assert!(
                list_git_history(&repo, selected, Some(cursor))
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("refresh")
            );
        }
        let foreign = TempDir::new().unwrap();
        Repository::init(foreign.path()).unwrap();
        assert!(
            list_git_history(foreign.path(), Some("refs/heads/topic"), Some(cursor))
                .await
                .unwrap_err()
                .to_string()
                .contains("refresh")
        );
        assert_eq!(before, repository_bytes(&repo));

        git(&repo, &["update-ref", "refs/heads/topic", &root]);
        let before = repository_bytes(&repo);
        let moved = list_git_history(&repo, Some("refs/heads/topic"), Some(cursor))
            .await
            .unwrap();
        assert_eq!(moved.history_head_oid.as_deref(), Some(topic.as_str()));
        assert_eq!(moved.history_tip_oid.as_deref(), Some(root.as_str()));
        assert!(moved.branches.is_none());
        let actual: Vec<_> = first
            .commits
            .iter()
            .chain(&moved.commits)
            .map(|commit| commit.oid.clone())
            .collect();
        assert_eq!(actual, expected);
        let latest = list_git_history(&repo, Some("refs/heads/topic"), None)
            .await
            .unwrap();
        assert_eq!(latest.commits[0].oid, root);
        assert_eq!(latest.history_head_oid.as_deref(), Some(root.as_str()));
        assert_eq!(before, repository_bytes(&repo));

        git(&repo, &["update-ref", "-d", "refs/heads/topic"]);
        let before = repository_bytes(&repo);
        let deleted = list_git_history(&repo, Some("refs/heads/topic"), Some(cursor))
            .await
            .unwrap();
        assert!(deleted.history_tip_oid.is_none());
        assert_eq!(deleted.history_head_oid.as_deref(), Some(topic.as_str()));
        assert_eq!(
            deleted
                .commits
                .iter()
                .map(|commit| &commit.oid)
                .collect::<Vec<_>>(),
            moved
                .commits
                .iter()
                .map(|commit| &commit.oid)
                .collect::<Vec<_>>()
        );
        assert!(
            list_git_history(&repo, Some("refs/heads/topic"), None)
                .await
                .is_err()
        );
        assert_eq!(before, repository_bytes(&repo));

        let repository = Repository::open(&repo).unwrap();
        repository
            .set_head_detached(git2::Oid::from_str(&head).unwrap())
            .unwrap();
        drop(repository);
        let before = repository_bytes(&repo);
        let detached = list_git_history(&repo, Some("refs/remotes/origin/topic"), None)
            .await
            .unwrap();
        assert!(detached.branch.is_none());
        assert_eq!(detached.head_oid.as_deref(), Some(head.as_str()));
        assert_eq!(detached.commits[0].oid, topic);
        assert_eq!(before, repository_bytes(&repo));
        Repository::open(&repo)
            .unwrap()
            .set_head("refs/heads/unborn")
            .unwrap();
        let before = repository_bytes(&repo);
        let unborn = list_git_history(&repo, None, None).await.unwrap();
        assert!(unborn.head_oid.is_none() && unborn.history_tip_oid.is_none());
        assert!(unborn.commits.is_empty());
        let selected = list_git_history(&repo, Some("refs/remotes/origin/topic"), None)
            .await
            .unwrap();
        assert_eq!(selected.branch.as_deref(), Some("unborn"));
        assert!(selected.head_oid.is_none());
        assert_eq!(selected.commits[0].oid, topic);
        assert!(
            list_git_history(&repo, Some("refs/heads/unborn"), None)
                .await
                .is_err()
        );
        assert_eq!(before, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn history_ref_bounds_listing_and_rejects_malformed_v2_cursors() {
        let (_temp, repo, _root, head) = test_repo();
        {
            let repository = Repository::open(&repo).unwrap();
            let oid = git2::Oid::from_str(&head).unwrap();
            for index in 0..1005 {
                repository
                    .reference(
                        &format!("refs/heads/branch-{index:04}"),
                        oid,
                        false,
                        "fixture",
                    )
                    .unwrap();
            }
        }
        let before = repository_bytes(&repo);
        let page = list_git_history(&repo, None, None).await.unwrap();
        assert_eq!(
            serde_json::to_value(&page).unwrap()["branchesTruncated"],
            true
        );
        assert_eq!(page.branches.unwrap().len(), 1000);
        let selected = list_git_history(&repo, Some("refs/heads/main"), None)
            .await
            .unwrap();
        assert_eq!(
            selected.commits[0].oid, head,
            "a branch beyond the listing cap remains selectable"
        );
        let canonical = repo.canonicalize().unwrap().display().to_string();
        let encode = |value: serde_json::Value| {
            format!(
                "v2:{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
            )
        };
        let tree = git_output(&repo, &["rev-parse", "HEAD^{tree}"]);
        assert_eq!(before, repository_bytes(&repo));
        git(
            &repo,
            &["tag", "-a", "annotated-history", "-m", "tag", &head],
        );
        let tag = git_output(&repo, &["rev-parse", "refs/tags/annotated-history"]);
        let after_tag = repository_bytes(&repo);
        for cursor in [
            format!("v1:{head}:30"),
            "v2:invalid".into(),
            encode(serde_json::json!([canonical, null, head, 0])),
            encode(serde_json::json!([canonical, null, head, 1])),
            encode(serde_json::json!([canonical, null, head, u64::MAX])),
            encode(serde_json::json!([canonical, null, "HEAD", 30])),
            encode(serde_json::json!([canonical, null, head, 30, "extra"])),
            encode(serde_json::json!([canonical, null, tree, 30])),
            encode(serde_json::json!([canonical, null, tag, 30])),
            encode(serde_json::json!([canonical, null, "0".repeat(40), 30])),
        ] {
            assert!(
                list_git_history(&repo, None, Some(&cursor))
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("refresh"),
                "{cursor}"
            );
        }
        assert_eq!(after_tag, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn history_pages_pin_merge_traversal_across_refresh_and_detached_head() {
        let (_temp, repo, root, _) = test_repo();
        git(&repo, &["checkout", "-b", "side", &root]);
        git(&repo, &["commit", "--allow-empty", "-m", "side"]);
        let side = git_output(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "main"]);
        for index in 0..34 {
            git(
                &repo,
                &["commit", "--allow-empty", "-m", &format!("commit {index}")],
            );
        }
        git(&repo, &["merge", "--no-ff", "side", "-m", "merge"]);
        let head = git_output(&repo, &["rev-parse", "HEAD"]);
        let expected: Vec<String> = git_output(&repo, &["rev-list", "--topo-order", "HEAD"])
            .lines()
            .map(str::to_string)
            .collect();
        let before = repository_bytes(&repo);
        let first = list_git_history(&repo.join("src"), None, None)
            .await
            .unwrap();
        assert_eq!(
            first.repo_root,
            repo.canonicalize().unwrap().display().to_string()
        );
        assert_eq!(first.branch.as_deref(), Some("main"));
        assert_eq!(first.head_oid.as_deref(), Some(head.as_str()));
        assert_eq!(first.commits.len(), 30);
        assert!(first.commits[0].is_merge);
        assert_eq!(before, repository_bytes(&repo));
        git(&repo, &["commit", "--allow-empty", "-m", "new live head"]);
        let live = git_output(&repo, &["rev-parse", "HEAD"]);
        let next = list_git_history(&repo, None, first.next_cursor.as_deref())
            .await
            .unwrap();
        assert_eq!(next.head_oid.as_deref(), Some(live.as_str()));
        assert_eq!(next.history_head_oid.as_deref(), Some(head.as_str()));
        assert!(next.next_cursor.is_none());
        let actual: Vec<_> = first
            .commits
            .iter()
            .chain(&next.commits)
            .map(|commit| commit.oid.clone())
            .collect();
        assert_eq!(actual, expected);
        assert!(actual.contains(&side));
        assert_eq!(
            list_git_history(&repo, None, None).await.unwrap().commits[0].oid,
            live
        );
        git(&repo, &["checkout", "--detach", &root]);
        let detached = list_git_history(&repo, None, None).await.unwrap();
        assert!(detached.branch.is_none());
        assert_eq!(detached.commits[0].oid, root);
        let pinned = list_git_history(&repo, None, first.next_cursor.as_deref())
            .await
            .unwrap();
        assert_eq!(
            pinned
                .commits
                .iter()
                .map(|commit| &commit.oid)
                .collect::<Vec<_>>(),
            next.commits
                .iter()
                .map(|commit| &commit.oid)
                .collect::<Vec<_>>()
        );
        for cursor in [
            "",
            "v1:HEAD:30",
            "v2:bad:30",
            &format!("v1:{head}:1"),
            &format!("v1:{head}:18446744073709551615"),
        ] {
            assert!(list_git_history(&repo, None, Some(cursor)).await.is_err());
        }
    }

    #[tokio::test]
    async fn history_handles_unborn_and_rejects_non_commit_selections() {
        let temp = TempDir::new().unwrap();
        git(temp.path(), &["init", "-b", "main"]);
        let page = list_git_history(temp.path(), None, None).await.unwrap();
        assert_eq!(page.branch.as_deref(), Some("main"));
        assert!(page.head_oid.is_none() && page.history_head_oid.is_none());
        assert!(page.commits.is_empty() && page.next_cursor.is_none());
        let (_temp, repo, _, head) = test_repo();
        let tree = git_output(&repo, &["rev-parse", "HEAD^{tree}"]);
        let state = crate::tests::test_state(8, None);
        for oid in ["HEAD", "--all", &tree] {
            assert!(
                prepare_commit_review(
                    &state,
                    repo.clone(),
                    oid,
                    DiffDetailMode::FilePatch,
                    None,
                    None
                )
                .await
                .is_err()
            );
        }
        git(&repo, &["tag", "-a", "annotated", "-m", "tag", &head]);
        let tag = git_output(&repo, &["rev-parse", "annotated"]);
        assert!(
            list_git_history(&repo, None, Some(&format!("v1:{tag}:30")))
                .await
                .is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn history_ref_missing_promisor_objects_never_fetch_or_mutate() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, repo, base, head) = test_repo();
        let blob = git_output(&repo, &["rev-parse", "HEAD:src/lib.rs"]);
        fs::remove_file(repo.join(".git/objects").join(&blob[..2]).join(&blob[2..])).unwrap();
        let probes = TempDir::new().unwrap();
        let marker = probes.path().join("fetched");
        let helper = probes.path().join("transport");
        fs::write(
            &helper,
            format!(
                "#!/bin/sh\nprintf fetched > '{}'\nexit 1\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
        git(
            &repo,
            &[
                "config",
                "remote.origin.url",
                &format!("ext::{}", helper.display()),
            ],
        );
        git(&repo, &["config", "remote.origin.promisor", "true"]);
        git(
            &repo,
            &["config", "remote.origin.partialclonefilter", "blob:none"],
        );
        git(&repo, &["config", "extensions.partialClone", "origin"]);
        git(&repo, &["config", "protocol.ext.allow", "always"]);
        // The only possible transport is this disposable marker script, never a network remote.
        let mut control = StdCommand::new("git");
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                control.env_remove(key);
            }
        }
        let output = control
            .current_dir(&repo)
            .args(["show", &format!("{head}:src/lib.rs")])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            marker.exists(),
            "the unhardened fixture must attempt lazy fetch"
        );
        fs::remove_file(&marker).unwrap();
        let before = repository_bytes(&repo);
        let page = list_git_history(&repo, Some("refs/heads/main"), None)
            .await
            .unwrap();
        assert_eq!(page.commits[0].oid, head);
        assert!(
            generate_file_patch(
                &repo,
                &base,
                &head,
                &DiffFileSelector {
                    old_path: None,
                    new_path: "src/lib.rs".into(),
                },
                3
            )
            .await
            .is_err()
        );
        assert!(
            read_git_file(repo.to_str().unwrap(), &head, "src/lib.rs")
                .await
                .is_err()
        );
        assert!(!marker.exists());
        assert_eq!(before, repository_bytes(&repo));
        let missing_tip = {
            let repository = Repository::open(&repo).unwrap();
            let parent = repository
                .find_commit(git2::Oid::from_str(&head).unwrap())
                .unwrap();
            let signature =
                git2::Signature::now("History Tester", "history@example.invalid").unwrap();
            let tip = repository
                .commit(
                    Some("refs/heads/missing-tip"),
                    &signature,
                    &signature,
                    "promised commit",
                    &parent.tree().unwrap(),
                    &[&parent],
                )
                .unwrap()
                .to_string();
            fs::remove_file(repo.join(".git/objects").join(&tip[..2]).join(&tip[2..])).unwrap();
            tip
        };
        let before = repository_bytes(&repo);
        assert!(
            list_git_history(&repo, Some("refs/heads/missing-tip"), None)
                .await
                .is_err()
        );
        assert!(read_commit_summary(&repo, &missing_tip).await.is_err());
        assert!(!marker.exists());
        assert_eq!(before, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn history_ref_ignores_inherited_git_redirections() {
        const CHILD: &str = "FURA_HISTORY_ENV_TEST_REPO";
        if let Some(path) = std::env::var_os(CHILD) {
            let repo = PathBuf::from(path);
            let expected = std::env::var("FURA_HISTORY_ENV_TEST_HEAD").unwrap();
            let before = repository_bytes(&repo);
            let page = list_git_history(&repo, Some("refs/heads/main"), None)
                .await
                .unwrap();
            assert_eq!(
                page.repo_root,
                repo.canonicalize().unwrap().display().to_string()
            );
            assert_eq!(page.commits[0].oid, expected);
            let parent = &page.commits[0].parent_oids[0];
            let patch = generate_file_patch(
                &repo,
                parent,
                &expected,
                &DiffFileSelector {
                    old_path: None,
                    new_path: "src/lib.rs".into(),
                },
                3,
            )
            .await
            .unwrap()
            .0;
            assert!(patch.contains("+pub fn value() -> i32 { 2 }"));
            assert_eq!(
                read_git_file(repo.to_str().unwrap(), &expected, "src/lib.rs")
                    .await
                    .unwrap()
                    .text,
                "pub fn value() -> i32 { 2 }\n"
            );
            assert_eq!(before, repository_bytes(&repo));
            return;
        }
        let (_temp, repo, _, head) = test_repo();
        let (_other_temp, other, _, _) = test_repo();
        write_file(&other, "src/lib.rs", "foreign repository\n");
        git(&other, &["commit", "-am", "foreign"]);
        let before = repository_bytes(&repo);
        let other_before = repository_bytes(&other);
        let output = StdCommand::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "diff::tests::history_ref_ignores_inherited_git_redirections",
                "--nocapture",
            ])
            .env(CHILD, &repo)
            .env("FURA_HISTORY_ENV_TEST_HEAD", &head)
            .env("GIT_DIR", other.join(".git"))
            .env("GIT_COMMON_DIR", other.join(".git"))
            .env("GIT_WORK_TREE", &other)
            .env("GIT_INDEX_FILE", other.join(".git/index"))
            .env("GIT_OBJECT_DIRECTORY", other.join(".git/objects"))
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "core.fsmonitor")
            .env("GIT_CONFIG_VALUE_0", "false")
            .env("GIT_EXEC_PATH", "/nonexistent-git-exec-path")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(before, repository_bytes(&repo));
        assert_eq!(other_before, repository_bytes(&other));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn git_read_safety_refuses_filters_without_running_helpers_and_keeps_history_usable() {
        use std::os::unix::fs::PermissionsExt;
        let (_temp, repo, _, head) = test_repo();
        let helpers = TempDir::new().unwrap();
        let marker = helpers.path().join("ran");
        let script = helpers.path().join("probe");
        fs::write(
            &script,
            format!("#!/bin/sh\nprintf ran > '{}'\ncat\n", marker.display()),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        git(
            &repo,
            &["config", "core.fsmonitor", script.to_str().unwrap()],
        );
        write_file(&repo, "src/lib.rs", "working\n");
        git_change_range(&repo, GitChangeKind::Unstaged)
            .await
            .unwrap();
        assert!(!marker.exists());
        write_file(&repo, ".git/info/attributes", "src/lib.rs filter=probe\n");
        git(
            &repo,
            &["config", "filter.probe.clean", script.to_str().unwrap()],
        );
        git(
            &repo,
            &["config", "filter.probe.process", script.to_str().unwrap()],
        );
        let before = repository_bytes(&repo);
        assert!(
            git_change_range(&repo, GitChangeKind::Unstaged)
                .await
                .is_err()
        );
        assert!(mutable_identity(&repo, &head, "worktree").await.is_err());
        let page = list_git_history(&repo, None, None).await.unwrap();
        assert_eq!(page.commits[0].oid, head);
        let state = crate::tests::test_state(8, None);
        let prepared = prepare_commit_review(
            &state,
            repo.clone(),
            &head,
            DiffDetailMode::FilePatch,
            None,
            None,
        )
        .await
        .unwrap();
        generate_aggregate_patch(
            &repo,
            &prepared.left_tree_or_commit,
            &prepared.right_tree_or_commit,
            3,
        )
        .await
        .unwrap();
        assert!(!marker.exists());
        assert_eq!(before, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn mutable_identity_refuses_oversized_total_reads_without_partial_version() {
        let (_temp, repo, _, head) = test_repo();
        let file = fs::File::create(repo.join("huge")).unwrap();
        file.set_len(65 * 1024 * 1024).unwrap();
        assert!(
            git_change_range(&repo, GitChangeKind::Untracked)
                .await
                .is_err()
        );
        assert!(mutable_identity(&repo, &head, "worktree").await.is_err());
    }

    #[tokio::test]
    async fn committed_file_reads_exact_blob_even_when_working_file_is_deleted() {
        let (_temp, repo, base, head) = test_repo();
        fs::remove_file(repo.join("src/lib.rs")).unwrap();
        let before = repository_bytes(&repo);
        let file = read_git_file(repo.to_str().unwrap(), &base, "src/lib.rs")
            .await
            .unwrap();
        assert_eq!(file.text, "pub fn value() -> i32 { 1 }\n");
        assert_eq!(file.commit_oid, base);
        assert_eq!(
            file.blob_oid,
            git_output(&repo, &["rev-parse", &format!("{base}:src/lib.rs")])
        );
        let newer = read_git_file(repo.to_str().unwrap(), &head, "src/lib.rs")
            .await
            .unwrap();
        assert_eq!(newer.text, "pub fn value() -> i32 { 2 }\n");
        assert!(
            read_git_file(repo.to_str().unwrap(), &head, "../config")
                .await
                .is_err()
        );
        assert!(
            read_git_file(repo.to_str().unwrap(), &head, "src")
                .await
                .is_err()
        );
        assert_eq!(before, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn committed_file_refuses_binary_invalid_utf8_and_oversized_blobs() {
        let (_temp, repo, _, _) = test_repo();
        fs::write(repo.join("binary"), [0, 1, 2]).unwrap();
        fs::write(repo.join("invalid"), [255, 254]).unwrap();
        fs::write(
            repo.join("large"),
            vec![b'x'; MAX_DIFF_FILE_PATCH_BYTES + 1],
        )
        .unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "blob boundaries"]);
        let head = git_output(&repo, &["rev-parse", "HEAD"]);
        let before = repository_bytes(&repo);
        for path in ["binary", "invalid", "large"] {
            assert!(
                read_git_file(repo.to_str().unwrap(), &head, path)
                    .await
                    .is_err(),
                "{path}"
            );
        }
        assert_eq!(before, repository_bytes(&repo));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn review_issue_signed_history_does_not_execute_verifier() {
        use std::os::unix::fs::PermissionsExt;
        let (temp, repo, _, head) = test_repo();
        let verifier = temp.path().join("verifier.py");
        let marker = temp.path().join("signature-marker");
        fs::write(&verifier, "#!/usr/bin/env python3\nfrom pathlib import Path\nPath(__file__).with_name('signature-marker').write_text('ran')\nraise SystemExit(1)\n").unwrap();
        fs::set_permissions(&verifier, fs::Permissions::from_mode(0o755)).unwrap();
        let tree = git_output(&repo, &["rev-parse", "HEAD^{tree}"]);
        let signed = format!(
            "tree {tree}\nparent {head}\nauthor Review <review@example.invalid> 1700000000 +0000\ncommitter Review <review@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nSigned review fixture\n"
        );
        let mut process = StdCommand::new("git")
            .current_dir(&repo)
            .args(["hash-object", "-t", "commit", "-w", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(process.stdin.as_mut().unwrap(), signed.as_bytes()).unwrap();
        let output = process.wait_with_output().unwrap();
        assert!(output.status.success());
        let oid = String::from_utf8(output.stdout).unwrap();
        git(&repo, &["update-ref", "refs/heads/main", oid.trim()]);
        git(&repo, &["config", "log.showSignature", "true"]);
        git(
            &repo,
            &["config", "gpg.program", verifier.to_str().unwrap()],
        );
        let result = list_git_history(&repo, None, None).await;
        assert!(!marker.exists(), "history ran configured gpg.program");
        assert_eq!(result.unwrap().commits[0].subject, "Signed review fixture");
    }

    #[tokio::test]
    async fn review_issue_replace_refs_cannot_change_commit_identity_between_views() {
        let (_temp, repo, base, head) = test_repo();
        git(&repo, &["checkout", "--detach", &base]);
        write_file(&repo, "src/lib.rs", "pub fn value() -> i32 { 99 }\n");
        git(&repo, &["commit", "-am", "Replacement contents"]);
        let replacement = git_output(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["checkout", "main"]);
        git(&repo, &["replace", &head, &replacement]);
        let before = repository_bytes(&repo);
        let history = list_git_history(&repo, None, None).await.unwrap();
        assert_eq!(history.commits[0].subject, "change value");
        let patch = generate_file_patch(
            &repo,
            &base,
            &head,
            &DiffFileSelector {
                old_path: None,
                new_path: "src/lib.rs".into(),
            },
            3,
        )
        .await
        .unwrap()
        .0;
        let file = read_git_file(repo.to_str().unwrap(), &head, "src/lib.rs")
            .await
            .unwrap();
        assert!(patch.contains("+pub fn value() -> i32 { 2 }"));
        assert_eq!(file.text, "pub fn value() -> i32 { 2 }\n");
        assert_eq!(before, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn review_issue_removed_index_directory_replaced_by_file_has_exact_paths() {
        let (_temp, repo, _, _) = test_repo();
        write_file(&repo, "d/f", "old\n");
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "directory"]);
        let base = git_output(&repo, &["rev-parse", "HEAD"]);
        git(&repo, &["rm", "-r", "--cached", "d"]);
        fs::remove_file(repo.join("d/f")).unwrap();
        fs::remove_dir(repo.join("d")).unwrap();
        write_file(&repo, "d", "replacement\n");
        let before = repository_bytes(&repo);
        let right = mutable_identity(&repo, &base, "worktree").await.unwrap();
        let (files, _) = summarize_files_between(&repo, &base, &right).await.unwrap();
        assert_eq!(
            files
                .iter()
                .map(|file| file.new_path.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["d", "d/f"])
        );
        assert_eq!(files.len(), 2);
        let patch = generate_file_patch(
            &repo,
            &base,
            &right,
            &DiffFileSelector {
                old_path: None,
                new_path: "d".into(),
            },
            3,
        )
        .await
        .unwrap()
        .0;
        assert!(patch.contains("+replacement"));
        assert!(
            !patch.contains("-old"),
            "selected file must not include another path's deletion"
        );
        assert_eq!(before, repository_bytes(&repo));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn review_issue_historical_patch_does_not_require_live_parent_containment() {
        let (_temp, repo, base, head) = test_repo();
        fs::remove_dir_all(repo.join("src")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), repo.join("src")).unwrap();
        let before = repository_bytes(&repo);
        let patch = generate_file_patch(
            &repo,
            &base,
            &head,
            &DiffFileSelector {
                old_path: None,
                new_path: "src/lib.rs".into(),
            },
            3,
        )
        .await
        .unwrap()
        .0;
        assert!(patch.contains("+pub fn value() -> i32 { 2 }"));
        assert_eq!(before, repository_bytes(&repo));
    }

    #[tokio::test]
    async fn review_issue_literal_b_prefix_path_keeps_exact_lazy_patch() {
        let (_temp, repo, _, _) = test_repo();
        fs::create_dir(repo.join("x b")).unwrap();
        fs::write(repo.join("x b/y"), "before\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "literal path base"]);
        let base = git_output(&repo, &["rev-parse", "HEAD"]);
        fs::write(repo.join("x b/y"), "after\n").unwrap();
        git(&repo, &["commit", "-am", "literal path change"]);
        let head = git_output(&repo, &["rev-parse", "HEAD"]);
        let before = repository_bytes(&repo);
        let patch = generate_file_patch(
            &repo,
            &base,
            &head,
            &DiffFileSelector {
                old_path: None,
                new_path: "x b/y".to_owned(),
            },
            3,
        )
        .await
        .unwrap()
        .0;
        assert!(
            patch.contains("-before\n+after\n"),
            "the selected literal filename must retain its changed lines"
        );
        assert_eq!(before, repository_bytes(&repo));
    }
}
