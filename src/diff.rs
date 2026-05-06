use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader as StdBufReader},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, anyhow, bail};
use git2::Repository;
use serde_json::Value;
use tokio::{io::AsyncReadExt, process::Command, time};
use uuid::Uuid;

use crate::*;

const GIT_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_DIFF_BYTES: usize = 2_000_000;
const MAX_DIFF_FILE_PATCH_BYTES: usize = 1_000_000;
const MAX_GIT_OUTPUT_BYTES: usize = 4_000_000;

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
    detail_mode: DiffDetailMode,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
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
        detail_mode,
        current_commit_oid: current_commit_oid.clone(),
        selected_file: selected_file.clone(),
    };
    if selected_file.is_some()
        && current_diff_id(state, &client_id, DiffScope::SessionChanges)
            .await
            .as_deref()
            == Some(diff_id.as_str())
    {
        start_session_changes_file_patch_job(
            state,
            client_id,
            diff_id,
            session_id,
            selected_file.expect("checked selected file"),
        )
        .await;
        return Vec::new();
    }
    start_session_changes_generation_job(
        state,
        client_id,
        diff_id,
        session_id,
        repo_id,
        detail_mode,
        current_commit_oid,
        selected_file,
        request,
    )
    .await;
    Vec::new()
}

pub(crate) async fn handle_session_changes_snapshot(
    state: &AppState,
    client_id: String,
    diff_id: String,
    session_id: String,
    repo_id: Option<String>,
    label: Option<String>,
    detail_mode: DiffDetailMode,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
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
    let command_id = next_rpc_id();
    let label = label
        .and_then(|label| non_empty_trimmed(&label).map(str::to_string))
        .unwrap_or_else(|| "manual".to_string());
    state.pending_session_change_snapshots.write().await.insert(
        command_id.clone(),
        PendingSessionChangesSnapshot {
            client_id,
            diff_id,
            session_id: session_id.clone(),
            repo_id,
            detail_mode,
            current_commit_oid,
            selected_file,
        },
    );
    let command = serde_json::json!({
        "id": command_id.clone(),
        "type": "repo_diff_snapshot",
        "label": label,
    });
    match send_rpc_command(state, &session_id, command).await {
        Ok(()) => Vec::new(),
        Err(message) => {
            state
                .pending_session_change_snapshots
                .write()
                .await
                .remove(&command_id);
            vec![notice(session_id, NoticeLevel::Error, message)]
        }
    }
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
    };
    if selected_file.is_some()
        && current_diff_id(state, &client_id, DiffScope::CompareDiff)
            .await
            .as_deref()
            == Some(diff_id.as_str())
    {
        start_compare_file_patch_job(
            state,
            client_id,
            diff_id,
            repo_root,
            selected_file.expect("checked selected file"),
        )
        .await;
        return Vec::new();
    }
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
    text == "missing repository for session changes" || text == "missing repository diff snapshot"
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

async fn current_diff_id(state: &AppState, client_id: &str, scope: DiffScope) -> Option<String> {
    let jobs = state.diff_jobs.read().await;
    jobs.state_generations
        .get(&(client_id.to_string(), scope))
        .map(|job| job.diff_id.clone())
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
        let _ = state.events.send(ServerMessage::DiffCancelled {
            target_client_id: client_id,
            diff_id: cancelled_diff_id,
            scope,
            reason: Some("replaced".to_string()),
        });
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
        let _ = state.events.send(ServerMessage::DiffCancelled {
            target_client_id: client_id.to_string(),
            diff_id: diff_id.to_string(),
            scope,
            reason,
        });
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

pub(crate) async fn start_session_changes_generation_job(
    state: &AppState,
    client_id: String,
    diff_id: String,
    session_id: String,
    repo_id: Option<String>,
    detail_mode: DiffDetailMode,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    request: DiffRequestIdentity,
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
            detail_mode,
            current_commit_oid,
            selected_file.clone(),
            request.clone(),
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
                    let _ = job_state.events.send(message);
                    if detail_mode == DiffDetailMode::FilePatch {
                        if let Some(file) = selected_file {
                            send_file_patch_for_prepared(
                                &job_state,
                                job_client_id.clone(),
                                job_diff_id.clone(),
                                DiffScope::SessionChanges,
                                prepared,
                                file,
                            )
                            .await;
                        }
                    }
                    let _ = job_state.events.send(ServerMessage::DiffComplete {
                        target_client_id: job_client_id,
                        diff_id: job_diff_id,
                        scope: DiffScope::SessionChanges,
                    });
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
                    let _ = job_state.events.send(diff_error(
                        Some(job_client_id),
                        Some(job_diff_id),
                        DiffErrorScope::SessionChanges,
                        Some(session_id),
                        None,
                        error,
                    ));
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

async fn start_session_changes_file_patch_job(
    state: &AppState,
    client_id: String,
    diff_id: String,
    session_id: String,
    selected_file: DiffFileSelector,
) {
    let Some(prepared) =
        current_prepared_diff(state, &client_id, DiffScope::SessionChanges, &diff_id).await
    else {
        let _ = state.events.send(diff_error(
            Some(client_id),
            Some(diff_id),
            DiffErrorScope::SessionChanges,
            Some(session_id),
            None,
            anyhow!("diff summary is not ready for the selected file"),
        ));
        return;
    };
    let key = (
        client_id.clone(),
        DiffScope::SessionChanges,
        diff_id.clone(),
        file_patch_key(&selected_file),
    );
    let token = next_diff_job_token(state).await;
    let job_state = state.clone();
    let key_for_task = key.clone();
    let handle = tokio::spawn(async move {
        send_file_patch_for_prepared(
            &job_state,
            client_id,
            diff_id,
            DiffScope::SessionChanges,
            prepared,
            selected_file,
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
                    let _ = job_state.events.send(message);
                    if detail_mode == DiffDetailMode::FilePatch {
                        if let Some(file) = selected_file {
                            send_file_patch_for_prepared(
                                &job_state,
                                job_client_id.clone(),
                                job_diff_id.clone(),
                                DiffScope::CompareDiff,
                                prepared,
                                file,
                            )
                            .await;
                        }
                    }
                    let _ = job_state.events.send(ServerMessage::DiffComplete {
                        target_client_id: job_client_id,
                        diff_id: job_diff_id,
                        scope: DiffScope::CompareDiff,
                    });
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
                    let _ = job_state.events.send(diff_error(
                        Some(job_client_id),
                        Some(job_diff_id),
                        DiffErrorScope::CompareDiff,
                        None,
                        Some(repo_root),
                        error,
                    ));
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

async fn start_compare_file_patch_job(
    state: &AppState,
    client_id: String,
    diff_id: String,
    repo_root: String,
    selected_file: DiffFileSelector,
) {
    let Some(prepared) =
        current_prepared_diff(state, &client_id, DiffScope::CompareDiff, &diff_id).await
    else {
        let _ = state.events.send(diff_error(
            Some(client_id),
            Some(diff_id),
            DiffErrorScope::CompareDiff,
            None,
            Some(repo_root),
            anyhow!("diff summary is not ready for the selected file"),
        ));
        return;
    };
    let key = (
        client_id.clone(),
        DiffScope::CompareDiff,
        diff_id.clone(),
        file_patch_key(&selected_file),
    );
    let token = next_diff_job_token(state).await;
    let job_state = state.clone();
    let key_for_task = key.clone();
    let handle = tokio::spawn(async move {
        send_file_patch_for_prepared(
            &job_state,
            client_id,
            diff_id,
            DiffScope::CompareDiff,
            prepared,
            selected_file,
        )
        .await;
        finish_file_patch_job(&job_state, &key_for_task, token).await;
    });
    register_file_patch_job(state, key, token, handle).await;
}

fn select_session_repo(
    candidates: &[SessionRepoCandidate],
    selected_repo_id: Option<&str>,
) -> Option<SessionRepoCandidate> {
    if let Some(repo_id) = selected_repo_id {
        if let Some(candidate) = candidates.iter().find(|candidate| candidate.id == repo_id) {
            return Some(candidate.clone());
        }
    }
    candidates
        .iter()
        .find(|candidate| {
            candidate.source != SessionRepoSource::Snapshot && candidate.has_session_start_snapshot
        })
        .or_else(|| {
            candidates
                .iter()
                .find(|candidate| candidate.source == SessionRepoSource::Snapshot)
        })
        .or_else(|| {
            candidates
                .iter()
                .find(|candidate| candidate.session_start_snapshot.is_some())
        })
        .or_else(|| candidates.first())
        .cloned()
}

async fn session_repo_candidates(
    state: &AppState,
    session_id: &str,
) -> anyhow::Result<Vec<SessionRepoCandidate>> {
    let (cwd, worktree, session_file) = {
        let sessions = state.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
        (
            session.cwd.clone(),
            session
                .worktree
                .as_ref()
                .map(|worktree| worktree.path.clone()),
            session.session_file.clone(),
        )
    };

    let snapshots = session_file
        .as_deref()
        .map(|path| read_session_diff_snapshots(Path::new(path)))
        .unwrap_or_default();
    let mut candidates = Vec::<SessionRepoCandidate>::new();

    if let Some(path) = worktree.as_deref() {
        add_path_candidate(
            &mut candidates,
            path,
            SessionRepoSource::Worktree,
            &snapshots,
        );
    }
    if let Some(path) = cwd.as_deref() {
        add_path_candidate(&mut candidates, path, SessionRepoSource::Cwd, &snapshots);
    }
    for snapshot in snapshots.iter() {
        add_snapshot_candidate(&mut candidates, snapshot);
    }
    hide_path_candidates_shadowed_by_snapshot_candidates(&mut candidates);

    Ok(candidates)
}

fn add_path_candidate(
    candidates: &mut Vec<SessionRepoCandidate>,
    path: &str,
    source: SessionRepoSource,
    snapshots: &[SessionDiffSnapshot],
) {
    let Ok(root) = discover_repo_root(path) else {
        return;
    };
    let repo_root = root.display().to_string();
    let snapshot = latest_session_start_snapshot_for_repo(snapshots, &root);
    upsert_candidate(candidates, repo_root, source, snapshot);
}

fn add_snapshot_candidate(
    candidates: &mut Vec<SessionRepoCandidate>,
    snapshot: &SessionDiffSnapshot,
) {
    let Ok(root) = discover_repo_root(&snapshot.repo_root) else {
        return;
    };
    let repo_root = root.display().to_string();
    candidates.push(SessionRepoCandidate {
        id: snapshot_candidate_id(&snapshot.entry_id),
        repo_root: repo_root.clone(),
        label: format_diff_snapshot_label(&repo_root, snapshot),
        source: SessionRepoSource::Snapshot,
        has_session_start_snapshot: snapshot.kind == "session-start",
        session_start_snapshot: Some(snapshot.summary()),
    });
}

fn hide_path_candidates_shadowed_by_snapshot_candidates(
    candidates: &mut Vec<SessionRepoCandidate>,
) {
    let snapshot_entry_ids: Vec<String> = candidates
        .iter()
        .filter(|candidate| candidate.source == SessionRepoSource::Snapshot)
        .filter_map(|candidate| {
            candidate
                .session_start_snapshot
                .as_ref()
                .map(|snapshot| snapshot.entry_id.clone())
        })
        .collect();
    candidates.retain(|candidate| {
        if candidate.source == SessionRepoSource::Snapshot {
            return true;
        }
        let Some(snapshot) = candidate.session_start_snapshot.as_ref() else {
            return true;
        };
        !snapshot_entry_ids
            .iter()
            .any(|entry_id| entry_id == &snapshot.entry_id)
    });
}

fn upsert_candidate(
    candidates: &mut Vec<SessionRepoCandidate>,
    repo_root: String,
    source: SessionRepoSource,
    snapshot: Option<SessionDiffSnapshotSummary>,
) {
    if let Some(existing) = candidates
        .iter_mut()
        .find(|candidate| candidate.id == repo_root)
    {
        if existing.session_start_snapshot.is_none() {
            existing.session_start_snapshot = snapshot;
            existing.has_session_start_snapshot = existing.session_start_snapshot.is_some();
        }
        return;
    }
    let label = format_diff_repo_label(&repo_root, source);
    candidates.push(SessionRepoCandidate {
        id: repo_root.clone(),
        repo_root,
        label,
        source,
        has_session_start_snapshot: snapshot.is_some(),
        session_start_snapshot: snapshot,
    });
}

fn format_diff_repo_label(repo_root: &str, source: SessionRepoSource) -> String {
    let source_label = match source {
        SessionRepoSource::Worktree => "worktree",
        SessionRepoSource::Cwd => "cwd",
        SessionRepoSource::Snapshot => "snapshot",
    };
    let name = Path::new(repo_root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(repo_root);
    format!("{name} · {source_label}")
}

fn format_diff_snapshot_label(repo_root: &str, snapshot: &SessionDiffSnapshot) -> String {
    let name = Path::new(repo_root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(repo_root);
    format!("{name} · {} snapshot · {}", snapshot.kind, snapshot.label)
}

fn snapshot_candidate_id(entry_id: &str) -> String {
    format!("snapshot:{entry_id}")
}

fn latest_session_start_snapshot_for_repo(
    snapshots: &[SessionDiffSnapshot],
    repo_root: &Path,
) -> Option<SessionDiffSnapshotSummary> {
    snapshots
        .iter()
        .filter(|snapshot| snapshot.kind == "session-start")
        .filter(|snapshot| snapshot_repo_matches(&snapshot.repo_root, repo_root))
        .last()
        .map(SessionDiffSnapshot::summary)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionDiffSnapshot {
    entry_id: String,
    kind: String,
    label: String,
    repo_root: String,
    tree: String,
    ref_name: String,
    commit: String,
    created_at: String,
}

impl SessionDiffSnapshot {
    fn summary(&self) -> SessionDiffSnapshotSummary {
        SessionDiffSnapshotSummary {
            entry_id: self.entry_id.clone(),
            label: self.label.clone(),
            created_at: self.created_at.clone(),
            ref_name: self.ref_name.clone(),
            tree: self.tree.clone(),
            commit: self.commit.clone(),
        }
    }
}

fn read_session_diff_snapshots(path: &Path) -> Vec<SessionDiffSnapshot> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let reader = StdBufReader::new(file);
    let mut snapshots = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) != Some("custom")
            || entry.get("customType").and_then(Value::as_str) != Some("repo-diff-snapshot")
        {
            continue;
        }
        let Some(data) = entry.get("data") else {
            continue;
        };
        if data.get("version").and_then(Value::as_u64) != Some(1) {
            continue;
        }
        let Some(repo_root) = data.get("repoRoot").and_then(Value::as_str) else {
            continue;
        };
        let Some(ref_name) = data.get("ref").and_then(Value::as_str) else {
            continue;
        };
        let Some(kind) = data.get("kind").and_then(Value::as_str) else {
            continue;
        };
        snapshots.push(SessionDiffSnapshot {
            entry_id: entry
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(ref_name)
                .to_string(),
            kind: kind.to_string(),
            label: data
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(kind)
                .to_string(),
            repo_root: repo_root.to_string(),
            tree: data
                .get("tree")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            ref_name: ref_name.to_string(),
            commit: data
                .get("commit")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            created_at: data
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        });
    }
    snapshots
}

fn snapshot_repo_matches(snapshot_repo: &str, repo_root: &Path) -> bool {
    match PathBuf::from(snapshot_repo).canonicalize() {
        Ok(canonical) => canonical == repo_root,
        Err(_) => Path::new(snapshot_repo) == repo_root,
    }
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn discover_repo_root(path: &str) -> anyhow::Result<PathBuf> {
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
    detail_mode: DiffDetailMode,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    request: DiffRequestIdentity,
) -> anyhow::Result<(ServerMessage, PreparedDiff)> {
    let (repos, selected_repo_id, prepared) = prepare_session_changes_diff(
        state,
        client_id.clone(),
        diff_id.clone(),
        session_id.clone(),
        selected_repo_id,
        detail_mode,
        current_commit_oid,
        selected_file,
        request.clone(),
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
    detail_mode: DiffDetailMode,
    current_commit_oid: Option<String>,
    selected_file: Option<DiffFileSelector>,
    request: DiffRequestIdentity,
) -> anyhow::Result<(Vec<SessionRepoCandidate>, String, PreparedDiff)> {
    let candidates = session_repo_candidates(state, &session_id).await?;
    if candidates.is_empty() {
        let _ = state.events.send(ServerMessage::SessionChangesSummary {
            state: SessionChangesSummaryState::MissingRepo {
                target_client_id: client_id,
                diff_id,
                request,
                session_id,
                repo_root: None,
                reason: "Fura could not identify a git repository for this session.".to_string(),
                repos: candidates,
            },
        });
        bail!("missing repository for session changes");
    }
    let selected = select_session_repo(&candidates, selected_repo_id.as_deref())
        .ok_or_else(|| anyhow!("Selected repository is not available for this session."))?;
    let repo_root_text = selected.repo_root.clone();
    let Some(snapshot) = selected.session_start_snapshot.clone() else {
        let _ = state.events.send(ServerMessage::SessionChangesSummary {
            state: SessionChangesSummaryState::MissingSnapshot {
                target_client_id: client_id,
                diff_id,
                request,
                session_id,
                repo_root: Some(repo_root_text),
                reason: "This session has no repository diff snapshot for the selected repository."
                    .to_string(),
                repos: candidates,
            },
        });
        bail!("missing repository diff snapshot");
    };
    let repo_root = discover_repo_root(&repo_root_text)?;
    let base_resolved = resolve_git_ref(&repo_root, &snapshot.ref_name).await?;
    let head_resolved = ResolvedDiffRef::WorkingTree;
    let base_endpoint = DiffEndpoint::SessionStartSnapshot {
        snapshot: snapshot.clone(),
    };
    let head_endpoint = DiffEndpoint::WorkingTree;
    let prepared = prepare_diff_range(
        state,
        repo_root,
        base_endpoint,
        head_endpoint,
        base_resolved,
        head_resolved,
        detail_mode,
        false,
        current_commit_oid,
        selected_file,
    )
    .await?;
    Ok((candidates, selected.id, prepared))
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
    let commit_patch = match current_commit_oid.as_deref() {
        Some(oid) => Some(selected_commit_patch_refs(
            oid,
            &commits,
            &base_resolved,
            range_base_oid.as_deref(),
        )?),
        None => None,
    };
    let (display_left, display_right, current_commit_index, previous_commit_oid) =
        if let Some((left, right, index, previous_oid, _displayed_range)) = commit_patch {
            (left, right, Some(index), Some(previous_oid))
        } else {
            (base_resolved.clone(), head_resolved.clone(), None, None)
        };
    let left_tree_or_commit = oid_for_diff(&display_left)?.to_string();
    let right_tree_or_commit = match &display_right {
        ResolvedDiffRef::WorkingTree => current_worktree_tree(&repo_root).await?,
        ResolvedDiffRef::GitRef { oid, .. } => oid.clone(),
    };
    let generated_at = Timestamp::now().millis().to_string();
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
        generated_at,
        comparison_key,
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
    base_resolved: &ResolvedDiffRef,
    range_base_oid: Option<&str>,
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
    let previous = if selected.is_merge {
        selected.parent_oids.first().cloned()
    } else if index == 0 {
        match base_resolved {
            ResolvedDiffRef::GitRef { oid, .. } => Some(
                range_base_oid
                    .map(str::to_string)
                    .unwrap_or_else(|| oid.clone()),
            ),
            ResolvedDiffRef::WorkingTree => None,
        }
    } else {
        Some(commits[index - 1].oid.clone())
    }
    .ok_or_else(|| anyhow!("selected commit has no comparable parent/base"))?;
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
    let (stat, truncated) = git_stdout_limited(
        repo_root,
        &[
            "diff",
            "--find-renames",
            "--stat",
            left_tree_or_commit,
            right_tree_or_commit,
        ],
        MAX_DIFF_BYTES,
    )
    .await?;
    let (files, file_limit_reached) =
        summarize_files_between(repo_root, left_tree_or_commit, right_tree_or_commit).await?;
    Ok(DiffSummaryPayload {
        files,
        stat: Some(stat),
        truncated,
        file_limit_reached: Some(file_limit_reached),
    })
}

async fn send_file_patch_for_prepared(
    state: &AppState,
    client_id: String,
    diff_id: String,
    scope: DiffScope,
    prepared: Arc<PreparedDiff>,
    file: DiffFileSelector,
) {
    let result = generate_file_patch(
        &prepared.repo_root,
        &prepared.left_tree_or_commit,
        &prepared.right_tree_or_commit,
        &file,
    )
    .await;
    match result {
        Ok((patch, truncated)) => {
            let _ = state.events.send(ServerMessage::DiffFilePatch {
                patch: DiffFilePatchState {
                    target_client_id: client_id,
                    diff_id,
                    scope,
                    comparison_key: prepared.comparison.comparison_key.clone(),
                    file,
                    patch,
                    truncated,
                    generated_at: Timestamp::now().millis().to_string(),
                },
            });
        }
        Err(error) => {
            let _ = state.events.send(diff_error(
                Some(client_id),
                Some(diff_id),
                match scope {
                    DiffScope::SessionChanges => DiffErrorScope::SessionChanges,
                    DiffScope::CompareDiff => DiffErrorScope::CompareDiff,
                },
                None,
                Some(prepared.repo_root.display().to_string()),
                error,
            ));
        }
    }
}

pub(crate) async fn generate_file_patch(
    repo_root: &Path,
    left_tree_or_commit: &str,
    right_tree_or_commit: &str,
    file: &DiffFileSelector,
) -> anyhow::Result<(String, bool)> {
    if let Some(old_path) = file.old_path.as_deref() {
        let combined = [
            "diff",
            "--find-renames",
            left_tree_or_commit,
            right_tree_or_commit,
            "--",
            old_path,
            file.new_path.as_str(),
        ];
        let (patch, truncated) =
            git_stdout_limited(repo_root, &combined, MAX_DIFF_FILE_PATCH_BYTES).await?;
        if !patch.trim().is_empty() {
            return Ok((patch, truncated));
        }
    }

    let primary = file.new_path.as_str();
    let args = [
        "diff",
        "--find-renames",
        left_tree_or_commit,
        right_tree_or_commit,
        "--",
        primary,
    ];
    let (patch, truncated) =
        git_stdout_limited(repo_root, &args, MAX_DIFF_FILE_PATCH_BYTES).await?;
    if !patch.trim().is_empty() || file.old_path.as_deref().is_none() {
        return Ok((patch, truncated));
    }
    let old_path = file.old_path.as_deref().expect("checked old path");
    let fallback = [
        "diff",
        "--find-renames",
        left_tree_or_commit,
        right_tree_or_commit,
        "--",
        old_path,
    ];
    git_stdout_limited(repo_root, &fallback, MAX_DIFF_FILE_PATCH_BYTES).await
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
    let input = non_empty_trimmed(value).ok_or_else(|| anyhow!("git ref is empty"))?;
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
        let format = "%H%x00%h%x00%s%x00%an%x00%ae%x00%cI%x00%P";
        let output = git_stdout(
            repo_root,
            &["show", "--no-patch", &format!("--format={format}"), oid],
            MAX_GIT_OUTPUT_BYTES,
        )
        .await?;
        let mut parts = output.trim_end().split('\0');
        let full = parts.next().unwrap_or(oid).to_string();
        let short = parts.next().unwrap_or(oid).to_string();
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
        commits.push(DiffCommitSummary {
            oid: full,
            short_oid: short,
            subject,
            author_name,
            author_email,
            committed_at,
            is_merge: parent_oids.len() > 1,
            parent_oids,
        });
    }
    Ok(commits)
}

struct TempGitIndex {
    dir: PathBuf,
    index_path: PathBuf,
}

impl TempGitIndex {
    fn new() -> anyhow::Result<Self> {
        let dir = std::env::temp_dir().join(format!("fura-git-index-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create temp git index dir: {}", dir.display()))?;
        let index_path = dir.join("index");
        Ok(Self { dir, index_path })
    }
}

impl Drop for TempGitIndex {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

async fn current_worktree_tree(repo_root: &Path) -> anyhow::Result<String> {
    let temp_index = TempGitIndex::new()?;
    let index_path = temp_index.index_path.to_string_lossy().to_string();
    let env = [("GIT_INDEX_FILE", index_path.as_str())];
    let head = git_stdout_with_env(
        repo_root,
        &["rev-parse", "--verify", "HEAD"],
        MAX_GIT_OUTPUT_BYTES,
        &[],
    )
    .await
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());
    match head.as_deref() {
        Some(head) => {
            git_stdout_with_env(repo_root, &["read-tree", head], MAX_GIT_OUTPUT_BYTES, &env)
                .await?;
        }
        None => {
            git_stdout_with_env(
                repo_root,
                &["read-tree", "--empty"],
                MAX_GIT_OUTPUT_BYTES,
                &env,
            )
            .await?;
        }
    }
    git_stdout_with_env(
        repo_root,
        &["add", "-A", "--", "."],
        MAX_GIT_OUTPUT_BYTES,
        &env,
    )
    .await?;
    let tree = git_stdout_with_env(repo_root, &["write-tree"], MAX_GIT_OUTPUT_BYTES, &env).await?;
    Ok(tree.trim().to_string())
}

#[cfg(test)]
async fn generate_diff(
    repo_root: &Path,
    base: &ResolvedDiffRef,
    head: &ResolvedDiffRef,
    payload_kind: DiffDetailMode,
) -> anyhow::Result<(String, bool)> {
    let mut args = vec!["diff", "--find-renames"];
    if payload_kind == DiffDetailMode::StatOnly {
        args.push("--stat");
    }
    let base_oid = oid_for_diff(base)?;
    match head {
        ResolvedDiffRef::WorkingTree => {
            let worktree_tree = current_worktree_tree(repo_root).await?;
            args.push(base_oid);
            args.push(&worktree_tree);
            git_stdout_limited(repo_root, &args, MAX_DIFF_BYTES).await
        }
        ResolvedDiffRef::GitRef { oid: head_oid, .. } => {
            args.push(base_oid);
            args.push(head_oid);
            git_stdout_limited(repo_root, &args, MAX_DIFF_BYTES).await
        }
    }
}

async fn summarize_files_between(
    repo_root: &Path,
    base_oid: &str,
    right: &str,
) -> anyhow::Result<(Vec<DiffFileSummary>, bool)> {
    let (numstat, numstat_truncated) = git_stdout_limited(
        repo_root,
        &["diff", "--find-renames", "--numstat", base_oid, right],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await?;
    let (name_status, name_status_truncated) = git_stdout_limited(
        repo_root,
        &["diff", "--find-renames", "--name-status", base_oid, right],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await?;
    Ok((
        parse_numstat_name_status(&numstat, &name_status),
        numstat_truncated || name_status_truncated,
    ))
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
    let mut summaries = parse_numstat_summaries(numstat);
    let statuses = parse_name_status_entries(name_status);
    if summaries.len() == statuses.len() {
        for (summary, status) in summaries.iter_mut().zip(statuses) {
            summary.status = status.status;
            if let Some(old_path) = status.old_path {
                summary.old_path = Some(old_path);
            }
            summary.new_path = status.new_path;
        }
        return summaries;
    }

    for status in statuses {
        if let Some(summary) = summaries.iter_mut().find(|summary| {
            summary.new_path == status.new_path
                || summary.old_path.as_deref() == status.old_path.as_deref()
                || status
                    .old_path
                    .as_deref()
                    .is_some_and(|old_path| summary.new_path == old_path)
        }) {
            summary.status = status.status;
            if let Some(old_path) = status.old_path {
                summary.old_path = Some(old_path);
            }
            summary.new_path = status.new_path;
        }
    }
    summaries
}

fn parse_numstat_summaries(numstat: &str) -> Vec<DiffFileSummary> {
    let mut summaries = Vec::new();
    for line in numstat.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 || !(parts[0] == "-" || parts[0].chars().all(|ch| ch.is_ascii_digit())) {
            continue;
        }
        let binary = parts[0] == "-" || parts[1] == "-";
        let added = parts[0].parse::<u64>().unwrap_or(0);
        let removed = parts[1].parse::<u64>().unwrap_or(0);
        let (old_path, new_path) = if parts.len() >= 4 {
            (Some(parts[2].to_string()), parts[3].to_string())
        } else {
            (None, parts[2].to_string())
        };
        summaries.push(DiffFileSummary {
            old_path,
            new_path,
            status: if binary {
                DiffFileStatus::Binary
            } else {
                DiffFileStatus::Unknown
            },
            added,
            removed,
        });
    }
    summaries
}

struct ParsedNameStatusEntry {
    status: DiffFileStatus,
    old_path: Option<String>,
    new_path: String,
}

fn parse_name_status_entries(name_status: &str) -> Vec<ParsedNameStatusEntry> {
    let mut entries = Vec::new();
    for line in name_status.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        let status = status_from_name_status(parts.first().copied().unwrap_or(""));
        match status {
            DiffFileStatus::Renamed | DiffFileStatus::Copied if parts.len() >= 3 => {
                entries.push(ParsedNameStatusEntry {
                    status,
                    old_path: Some(parts[1].to_string()),
                    new_path: parts[2].to_string(),
                });
            }
            _ if parts.len() >= 2 => {
                entries.push(ParsedNameStatusEntry {
                    status,
                    old_path: None,
                    new_path: parts[1].to_string(),
                });
            }
            _ => {}
        }
    }
    entries
}

fn status_from_name_status(status: &str) -> DiffFileStatus {
    match status.chars().next() {
        Some('A') => DiffFileStatus::Added,
        Some('M') => DiffFileStatus::Modified,
        Some('D') => DiffFileStatus::Deleted,
        Some('R') => DiffFileStatus::Renamed,
        Some('C') => DiffFileStatus::Copied,
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
    let status = git_stdout(path, &["status", "--porcelain"], MAX_GIT_OUTPUT_BYTES).await?;
    Ok(!status.trim().is_empty())
}

async fn git_stdout(repo_root: &Path, args: &[&str], limit: usize) -> anyhow::Result<String> {
    let (output, truncated) = git_stdout_limited(repo_root, args, limit).await?;
    if truncated {
        bail!("git output exceeded {limit} bytes");
    }
    Ok(output)
}

async fn git_stdout_with_env(
    repo_root: &Path,
    args: &[&str],
    limit: usize,
    env: &[(&str, &str)],
) -> anyhow::Result<String> {
    let (output, truncated) = git_stdout_limited_with_env(repo_root, args, limit, env).await?;
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
    git_stdout_limited_with_env(repo_root, args, limit, &[]).await
}

async fn git_stdout_limited_with_env(
    repo_root: &Path,
    args: &[&str],
    limit: usize,
    env: &[(&str, &str)],
) -> anyhow::Result<(String, bool)> {
    let mut command = Command::new("git");
    command
        .current_dir(repo_root)
        .arg("--no-optional-locks")
        .args(args)
        .envs(env.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
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
    let stdout_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 8192];
        let mut truncated = false;
        loop {
            let read = stdout.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            if buffer.len() < limit {
                let remaining = limit - buffer.len();
                buffer.extend_from_slice(&chunk[..read.min(remaining)]);
            }
            if read > 0 && buffer.len() >= limit {
                truncated = true;
            }
        }
        Ok::<_, std::io::Error>((buffer, truncated))
    });
    let stderr_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        stderr.read_to_end(&mut buffer).await?;
        Ok::<_, std::io::Error>(buffer)
    });

    let status = match time::timeout(GIT_TIMEOUT, child.wait()).await {
        Ok(status) => status?,
        Err(_) => {
            let _ = child.kill().await;
            bail!("git command timed out: git {}", args.join(" "));
        }
    };
    let (stdout, truncated) = stdout_task.await??;
    let stderr = stderr_task.await??;
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
    let mut text = String::from_utf8_lossy(&stdout).into_owned();
    if truncated {
        text.push_str("\n... diff output truncated by Fura ...\n");
    }
    Ok((text, truncated))
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
            messages: Vec::new(),
            live_message_ids: HashSet::new(),
            streaming_message: None,
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
            pending_plan_review: None,
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
            DiffDetailMode::StatOnly,
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
    async fn opens_session_changes_from_session_start_snapshot_to_worktree() {
        let (_temp, repo, base, _head) = test_repo();
        let snapshot_ref = "refs/omp/diff-snapshots/test-session-start";
        git(&repo, &["update-ref", snapshot_ref, &base]);
        write_file(&repo, "untracked.txt", "new file\n");

        let session_file = repo.join("session.jsonl");
        let tree = git_output(&repo, &["rev-parse", &format!("{base}^{{tree}}")]);
        let header = serde_json::json!({
            "type": "session",
            "id": "s1",
            "cwd": repo,
            "timestamp": "2026-05-04T00:00:00.000Z",
            "title": "diff test"
        });
        let snapshot = serde_json::json!({
            "type": "custom",
            "customType": "repo-diff-snapshot",
            "data": {
                "version": 1,
                "commit": base,
                "createdAt": "2026-05-04T00:00:00.000Z",
                "headCommit": base,
                "kind": "session-start",
                "label": "session-start",
                "ref": snapshot_ref,
                "repoRoot": repo,
                "tree": tree
            },
            "id": "snapshot-entry",
            "parentId": null,
            "timestamp": "2026-05-04T00:00:00.000Z"
        });
        fs::write(&session_file, format!("{}\n{}\n", header, snapshot)).expect("session file");

        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".into(), diff_test_record("s1", &repo, &session_file));

        let response = session_changes_response(&state, "s1").await;
        let ServerMessage::SessionChangesSummary { state } = &response else {
            panic!("expected session changes summary: {:?}", response);
        };
        let SessionChangesSummaryState::Ready {
            comparison,
            review,
            repos,
            summary,
            ..
        } = state
        else {
            panic!("expected ready session changes state: {:?}", state);
        };
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].source, SessionRepoSource::Snapshot);
        assert_eq!(repos[0].id, snapshot_candidate_id("snapshot-entry"));
        assert_eq!(
            repos[0].repo_root,
            repo.canonicalize().unwrap().display().to_string()
        );
        assert!(repos[0].has_session_start_snapshot);
        assert!(matches!(comparison.head, DiffEndpoint::WorkingTree));
        assert!(
            matches!(&comparison.base, DiffEndpoint::SessionStartSnapshot { snapshot } if snapshot.ref_name == snapshot_ref)
        );
        assert_eq!(review.current_commit_oid, None);
        let stat = summary.stat.as_deref().unwrap_or("");
        assert!(stat.contains("src/lib.rs"), "{}", stat);
        assert!(stat.contains("src/new.rs"), "{}", stat);
        assert!(stat.contains("untracked.txt"), "{}", stat);
        assert!(
            summary
                .files
                .iter()
                .any(|file| file.new_path == "untracked.txt")
        );
    }

    #[tokio::test]
    async fn session_changes_requires_session_start_snapshot() {
        let temp = TempDir::new().expect("temp dir");
        let repo = temp.path().join("not-a-repo");
        fs::create_dir_all(&repo).expect("non repo dir");
        let session_file = temp.path().join("missing-repo-session.jsonl");
        fs::write(&session_file, "").expect("session file");

        let state = crate::tests::test_state(8, None);
        state.sessions.write().await.insert(
            "missing-repo".into(),
            diff_test_record("missing-repo", &repo, &session_file),
        );
        let missing_repo = session_changes_response(&state, "missing-repo").await;
        let ServerMessage::SessionChangesSummary { state } = &missing_repo else {
            panic!("expected session changes state: {:?}", missing_repo);
        };
        assert!(matches!(
            state,
            SessionChangesSummaryState::MissingRepo { .. }
        ));

        let (_repo_temp, repo, _base, _head) = test_repo();
        let session_file = repo.join("no-snapshot-session.jsonl");
        fs::write(&session_file, "").expect("session file");
        let app_state = crate::tests::test_state(8, None);
        app_state.sessions.write().await.insert(
            "missing-snapshot".into(),
            diff_test_record("missing-snapshot", &repo, &session_file),
        );
        let missing_snapshot = session_changes_response(&app_state, "missing-snapshot").await;
        let ServerMessage::SessionChangesSummary { state } = &missing_snapshot else {
            panic!("expected session changes state: {:?}", missing_snapshot);
        };
        assert!(matches!(
            state,
            SessionChangesSummaryState::MissingSnapshot { .. }
        ));

        let stale_snapshot = serde_json::json!({
            "type": "custom",
            "customType": "repo-diff-snapshot",
            "data": {
                "version": 1,
                "commit": "missing",
                "createdAt": "2026-05-04T00:00:00.000Z",
                "kind": "session-start",
                "label": "session-start",
                "ref": "refs/omp/diff-snapshots/stale",
                "repoRoot": repo.join("deleted"),
                "tree": "missing"
            },
            "id": "stale-snapshot-entry"
        });
        fs::write(&session_file, format!("{}\n", stale_snapshot)).expect("stale session file");
        let stale_snapshot_response =
            session_changes_response(&app_state, "missing-snapshot").await;
        let ServerMessage::SessionChangesSummary { state } = &stale_snapshot_response else {
            panic!(
                "expected session changes state: {:?}",
                stale_snapshot_response
            );
        };
        let SessionChangesSummaryState::MissingSnapshot { repos, .. } = state else {
            panic!("expected missing snapshot state: {:?}", state);
        };
        assert_eq!(repos.len(), 1);
        assert_ne!(repos[0].source, SessionRepoSource::Snapshot);
    }

    #[tokio::test]
    async fn session_changes_does_not_use_latest_manual_snapshot() {
        let (_temp, repo, base, head) = test_repo();
        let session_start_ref = "refs/omp/diff-snapshots/session-start-only";
        let manual_ref = "refs/omp/diff-snapshots/manual-later";
        git(&repo, &["update-ref", session_start_ref, &base]);
        git(&repo, &["update-ref", manual_ref, &head]);
        let base_tree = git_output(&repo, &["rev-parse", &format!("{base}^{{tree}}")]);
        let head_tree = git_output(&repo, &["rev-parse", &format!("{head}^{{tree}}")]);
        let session_file = repo.join("manual-session.jsonl");
        let session_start = serde_json::json!({
            "type": "custom",
            "customType": "repo-diff-snapshot",
            "data": {
                "version": 1,
                "commit": base,
                "createdAt": "2026-05-04T00:00:00.000Z",
                "headCommit": base,
                "kind": "session-start",
                "label": "session-start",
                "ref": session_start_ref,
                "repoRoot": repo,
                "tree": base_tree
            },
            "id": "session-start-entry"
        });
        let manual = serde_json::json!({
            "type": "custom",
            "customType": "repo-diff-snapshot",
            "data": {
                "version": 1,
                "commit": head,
                "createdAt": "2026-05-04T00:01:00.000Z",
                "headCommit": head,
                "kind": "manual",
                "label": "manual",
                "ref": manual_ref,
                "repoRoot": repo,
                "tree": head_tree
            },
            "id": "manual-entry"
        });
        fs::write(&session_file, format!("{}\n{}\n", session_start, manual)).expect("session file");

        let app_state = crate::tests::test_state(8, None);
        app_state.sessions.write().await.insert(
            "manual".into(),
            diff_test_record("manual", &repo, &session_file),
        );
        let response = session_changes_response(&app_state, "manual").await;
        let ServerMessage::SessionChangesSummary { state } = &response else {
            panic!("expected session changes state: {:?}", response);
        };
        let SessionChangesSummaryState::Ready {
            comparison, repos, ..
        } = state
        else {
            panic!("expected ready state: {:?}", state);
        };
        assert!(
            matches!(&comparison.base, DiffEndpoint::SessionStartSnapshot { snapshot } if snapshot.ref_name == session_start_ref)
        );
        assert!(repos.iter().any(|repo| {
            repo.id == snapshot_candidate_id("manual-entry")
                && repo.source == SessionRepoSource::Snapshot
                && repo.label.contains("manual snapshot · manual")
        }));

        let mut events = app_state.events.subscribe();
        let responses = handle_session_changes_request(
            &app_state,
            "test-client".into(),
            test_diff_id(),
            "manual".into(),
            Some(snapshot_candidate_id("manual-entry")),
            DiffDetailMode::StatOnly,
            None,
            None,
        )
        .await;
        assert!(
            responses.is_empty(),
            "unexpected direct responses: {responses:?}"
        );
        let selected_response = events.recv().await.expect("manual snapshot response");
        let ServerMessage::SessionChangesSummary {
            state: selected_state,
        } = &selected_response
        else {
            panic!("expected manual snapshot state: {:?}", selected_response);
        };
        let SessionChangesSummaryState::Ready {
            comparison,
            selected_repo_id,
            ..
        } = selected_state
        else {
            panic!(
                "expected selected manual snapshot state: {:?}",
                selected_state
            );
        };
        assert_eq!(selected_repo_id.as_str(), "snapshot:manual-entry");
        assert!(
            matches!(&comparison.base, DiffEndpoint::SessionStartSnapshot { snapshot } if snapshot.ref_name == manual_ref)
        );
    }

    #[tokio::test]
    async fn session_changes_snapshot_queues_repo_diff_snapshot_rpc() {
        let (_temp, repo, _base, _head) = test_repo();
        let session_file = repo.join("snapshot-session.jsonl");
        fs::write(&session_file, "").expect("session file");
        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".into(), diff_test_record("s1", &repo, &session_file));
        let mut commands = crate::tests::register_test_transport(&state, "s1", "s1", 4).await;

        let responses = handle_session_changes_snapshot(
            &state,
            "client-1".into(),
            test_diff_id(),
            "s1".into(),
            Some(repo.display().to_string()),
            Some(" now ".into()),
            DiffDetailMode::FilePatch,
            Some("commit-1".into()),
            None,
        )
        .await;

        assert!(responses.is_empty());
        let command = commands.recv().await.expect("snapshot rpc command");
        assert_eq!(
            command.get("type").and_then(Value::as_str),
            Some("repo_diff_snapshot")
        );
        assert_eq!(command.get("label").and_then(Value::as_str), Some("now"));
        let command_id = command
            .get("id")
            .and_then(Value::as_str)
            .expect("command id");
        let pending = state.pending_session_change_snapshots.read().await;
        let pending = pending.get(command_id).expect("pending snapshot context");
        assert_eq!(pending.session_id, "s1");
        assert_eq!(pending.detail_mode, DiffDetailMode::FilePatch);
        assert_eq!(pending.current_commit_oid.as_deref(), Some("commit-1"));
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
        )
        .await
        .unwrap();
        assert!(patch.contains("+pub fn value() -> i32 { 4 }"), "{}", patch);
    }

    #[test]
    fn parse_name_status_rewrites_preserve_loadable_selectors() {
        let summaries = parse_numstat_name_status(
            "0\t0\tsrc/{old.rs => new.rs}\n0\t0\tsrc/{base.rs => copy.rs}\n",
            "R100\tsrc/old.rs\tsrc/new.rs\nC100\tsrc/base.rs\tsrc/copy.rs\n",
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
            let _ = state.events.send(diff_error(
                Some("client-1".into()),
                Some("diff-old".into()),
                DiffErrorScope::CompareDiff,
                None,
                Some("repo".into()),
                anyhow!("stale error"),
            ));
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
    async fn lazy_session_changes_patch_reuses_prepared_generation_identity() {
        let (_temp, repo, base, _head) = test_repo();
        let snapshot_ref = "refs/omp/diff-snapshots/session-start";
        git(&repo, &["update-ref", snapshot_ref, &base]);
        let tree = git_output(&repo, &["rev-parse", &format!("{base}^{{tree}}")]);
        let session_file = repo.join("prepared-session.jsonl");
        let header = serde_json::json!({
            "cwd": repo,
            "id": "s1",
            "timestamp": "2026-05-04T00:00:00.000Z",
            "title": "prepared generation"
        });
        let snapshot = serde_json::json!({
            "type": "custom",
            "customType": "repo-diff-snapshot",
            "data": {
                "version": 1,
                "commit": base,
                "createdAt": "2026-05-04T00:00:00.000Z",
                "headCommit": base,
                "kind": "session-start",
                "label": "session-start",
                "ref": snapshot_ref,
                "repoRoot": repo,
                "tree": tree
            },
            "id": "snapshot-entry",
            "parentId": null,
            "timestamp": "2026-05-04T00:00:00.000Z"
        });
        fs::write(&session_file, format!("{}\n{}\n", header, snapshot)).expect("session file");
        let state = crate::tests::test_state(8, None);
        state
            .sessions
            .write()
            .await
            .insert("s1".into(), diff_test_record("s1", &repo, &session_file));
        write_file(&repo, "src/lib.rs", "pub fn value() -> i32 { 3 }\n");
        let diff_id = test_diff_id();
        let mut events = state.events.subscribe();
        let responses = handle_session_changes_request(
            &state,
            "test-client".into(),
            diff_id.clone(),
            "s1".into(),
            None,
            DiffDetailMode::FilePatch,
            None,
            None,
        )
        .await;
        assert!(
            responses.is_empty(),
            "unexpected direct responses: {responses:?}"
        );
        loop {
            let message = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
                .await
                .expect("summary timeout")
                .expect("summary event");
            if matches!(
                message,
                ServerMessage::DiffComplete {
                    ref diff_id,
                    scope: DiffScope::SessionChanges,
                    ..
                } if diff_id == &test_diff_id()
            ) {
                break;
            }
        }
        write_file(&repo, "src/lib.rs", "pub fn value() -> i32 { 4 }\n");
        let responses = handle_session_changes_request(
            &state,
            "test-client".into(),
            diff_id,
            "s1".into(),
            None,
            DiffDetailMode::FilePatch,
            None,
            Some(DiffFileSelector {
                old_path: None,
                new_path: "src/lib.rs".into(),
            }),
        )
        .await;
        assert!(
            responses.is_empty(),
            "unexpected direct responses: {responses:?}"
        );
        loop {
            let message = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
                .await
                .expect("patch timeout")
                .expect("patch event");
            if let ServerMessage::DiffFilePatch { patch } = message {
                assert!(
                    patch.patch.contains("+pub fn value() -> i32 { 3 }"),
                    "{}",
                    patch.patch
                );
                assert!(
                    !patch.patch.contains("+pub fn value() -> i32 { 4 }"),
                    "{}",
                    patch.patch
                );
                break;
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
}
