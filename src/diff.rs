use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader as StdBufReader},
    path::{Path, PathBuf},
    process::Stdio,
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
const MAX_GIT_OUTPUT_BYTES: usize = 4_000_000;

#[derive(Debug, Default)]
pub(crate) struct DiffReviewWorktreeRegistry {
    by_id: HashMap<String, DiffReviewWorktree>,
    by_source_repo: HashMap<PathBuf, String>,
}

pub(crate) async fn handle_session_changes_open(
    state: &AppState,
    session_id: String,
) -> Vec<ServerMessage> {
    build_session_changes_response(state, session_id, None, DiffPayloadKind::StatOnly, None).await
}

pub(crate) async fn handle_session_changes_select_repo(
    state: &AppState,
    session_id: String,
    repo_id: String,
    payload_kind: DiffPayloadKind,
    current_commit_oid: Option<String>,
) -> Vec<ServerMessage> {
    build_session_changes_response(
        state,
        session_id,
        Some(repo_id),
        payload_kind,
        current_commit_oid,
    )
    .await
}

pub(crate) async fn handle_session_changes_refresh(
    state: &AppState,
    session_id: String,
    repo_id: Option<String>,
    payload_kind: Option<DiffPayloadKind>,
    current_commit_oid: Option<String>,
) -> Vec<ServerMessage> {
    build_session_changes_response(
        state,
        session_id,
        repo_id,
        payload_kind.unwrap_or(DiffPayloadKind::StatOnly),
        current_commit_oid,
    )
    .await
}

pub(crate) async fn handle_session_changes_snapshot(
    state: &AppState,
    session_id: String,
    repo_id: Option<String>,
    label: Option<String>,
    payload_kind: DiffPayloadKind,
    current_commit_oid: Option<String>,
) -> Vec<ServerMessage> {
    let command_id = next_rpc_id();
    let label = label
        .and_then(|label| non_empty_trimmed(&label).map(str::to_string))
        .unwrap_or_else(|| "manual".to_string());
    state.pending_session_change_snapshots.write().await.insert(
        command_id.clone(),
        PendingSessionChangesSnapshot {
            session_id: session_id.clone(),
            repo_id,
            payload_kind,
            current_commit_oid,
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

pub(crate) async fn handle_compare_diff_run(
    state: &AppState,
    request_id: Option<String>,
    repo_root: String,
    base: DiffRefInput,
    head: DiffRefInput,
    payload_kind: DiffPayloadKind,
    merge_base: Option<bool>,
    current_commit_oid: Option<String>,
) -> Vec<ServerMessage> {
    match discover_repo_root(&repo_root) {
        Ok(root) => match build_compare_diff_state(
            state,
            request_id.clone(),
            root,
            base,
            head,
            payload_kind,
            merge_base.unwrap_or(false),
            current_commit_oid,
        )
        .await
        {
            Ok(state_value) => vec![ServerMessage::CompareDiffState { state: state_value }],
            Err(error) => vec![diff_error(
                DiffErrorScope::CompareDiff,
                None,
                Some(repo_root),
                error,
            )],
        },
        Err(error) => vec![diff_error(
            DiffErrorScope::CompareDiff,
            None,
            Some(repo_root),
            error,
        )],
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
            DiffErrorScope::ReviewWorktree,
            None,
            None,
            error,
        )],
    }
}

fn diff_error(
    scope: DiffErrorScope,
    session_id: Option<String>,
    repo_root: Option<String>,
    error: anyhow::Error,
) -> ServerMessage {
    ServerMessage::DiffError {
        scope,
        session_id,
        repo_root,
        message: error.to_string(),
    }
}

pub(crate) async fn build_session_changes_response(
    state: &AppState,
    session_id: String,
    selected_repo_id: Option<String>,
    payload_kind: DiffPayloadKind,
    current_commit_oid: Option<String>,
) -> Vec<ServerMessage> {
    let (repos, selected) = match session_repo_candidates(state, &session_id).await {
        Ok(candidates) => {
            if candidates.is_empty() {
                let session_state = SessionChangesState::MissingRepo {
                    session_id,
                    reason: "Fura could not identify a git repository for this session."
                        .to_string(),
                    repos: candidates,
                };
                return vec![ServerMessage::SessionChangesState {
                    state: session_state,
                }];
            }
            let selected = select_session_repo(&candidates, selected_repo_id.as_deref());
            (candidates, selected)
        }
        Err(error) => {
            return vec![diff_error(
                DiffErrorScope::SessionChanges,
                Some(session_id),
                None,
                error,
            )];
        }
    };

    let Some(candidate) = selected else {
        let session_state = SessionChangesState::MissingRepo {
            session_id,
            reason: "Selected repository is not available for this session.".to_string(),
            repos,
        };
        return vec![ServerMessage::SessionChangesState {
            state: session_state,
        }];
    };

    let repo_root_text = candidate.repo_root.clone();
    let Some(snapshot) = candidate.session_start_snapshot.clone() else {
        let session_state = SessionChangesState::MissingSnapshot {
            session_id,
            repo_root: repo_root_text,
            reason: "This session has no session-start diff snapshot for the selected repository."
                .to_string(),
            repos,
        };
        return vec![ServerMessage::SessionChangesState {
            state: session_state,
        }];
    };

    let repo_root = match discover_repo_root(&repo_root_text) {
        Ok(root) => root,
        Err(error) => {
            return vec![diff_error(
                DiffErrorScope::SessionChanges,
                Some(session_id),
                Some(repo_root_text),
                error,
            )];
        }
    };

    match build_session_changes_state(
        state,
        session_id.clone(),
        repos,
        candidate.id.clone(),
        repo_root,
        snapshot,
        payload_kind,
        current_commit_oid,
    )
    .await
    {
        Ok(session_state) => vec![ServerMessage::SessionChangesState {
            state: session_state,
        }],
        Err(error) => vec![diff_error(
            DiffErrorScope::SessionChanges,
            Some(session_id),
            Some(repo_root_text),
            error,
        )],
    }
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
        .find(|candidate| candidate.has_session_start_snapshot)
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
    for snapshot in snapshots
        .iter()
        .filter(|snapshot| snapshot.kind == "session-start")
    {
        add_snapshot_candidate(&mut candidates, snapshot);
    }

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
    upsert_candidate(
        candidates,
        repo_root,
        SessionRepoSource::Snapshot,
        Some(snapshot.summary()),
    );
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

async fn build_session_changes_state(
    state: &AppState,
    session_id: String,
    repos: Vec<SessionRepoCandidate>,
    selected_repo_id: String,
    repo_root: PathBuf,
    snapshot: SessionDiffSnapshotSummary,
    payload_kind: DiffPayloadKind,
    current_commit_oid: Option<String>,
) -> anyhow::Result<SessionChangesState> {
    let base_resolved = resolve_git_ref(&repo_root, &snapshot.ref_name).await?;
    let head_resolved = ResolvedDiffRef::WorkingTree;
    let base_endpoint = DiffEndpoint::SessionStartSnapshot {
        snapshot: snapshot.clone(),
    };
    let head_endpoint = DiffEndpoint::WorkingTree;
    let (range, review) = build_diff_range_state(
        &repo_root,
        base_endpoint,
        head_endpoint,
        base_resolved,
        head_resolved,
        payload_kind,
        false,
        current_commit_oid,
    )
    .await?;
    let review_worktree = current_review_worktree(state, &repo_root).await;
    Ok(SessionChangesState::Ready {
        session_id,
        repos,
        selected_repo_id,
        range,
        review,
        review_worktree,
    })
}

async fn build_compare_diff_state(
    state: &AppState,
    request_id: Option<String>,
    repo_root: PathBuf,
    base: DiffRefInput,
    head: DiffRefInput,
    payload_kind: DiffPayloadKind,
    merge_base: bool,
    current_commit_oid: Option<String>,
) -> anyhow::Result<CompareDiffState> {
    let refs = list_refs(&repo_root).await?;
    let base_resolved = resolve_diff_ref(&repo_root, &base).await?;
    let head_resolved = resolve_diff_ref(&repo_root, &head).await?;
    let base_endpoint = endpoint_from_resolved(&base_resolved);
    let head_endpoint = endpoint_from_resolved(&head_resolved);
    let (range, review) = build_diff_range_state(
        &repo_root,
        base_endpoint,
        head_endpoint,
        base_resolved,
        head_resolved,
        payload_kind,
        merge_base,
        current_commit_oid,
    )
    .await?;
    let review_worktree = current_review_worktree(state, &repo_root).await;
    Ok(CompareDiffState {
        request_id,
        refs,
        range,
        review,
        review_worktree,
    })
}

async fn build_diff_range_state(
    repo_root: &Path,
    range_base_endpoint: DiffEndpoint,
    range_head_endpoint: DiffEndpoint,
    base_resolved: ResolvedDiffRef,
    head_resolved: ResolvedDiffRef,
    payload_kind: DiffPayloadKind,
    merge_base: bool,
    current_commit_oid: Option<String>,
) -> anyhow::Result<(DiffRangeState, CommitStepState)> {
    let range_base_oid =
        effective_merge_base_oid(repo_root, &base_resolved, &head_resolved, merge_base).await?;
    let commits = commits_for_range(
        repo_root,
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
    let payload = build_payload(repo_root, &display_left, &display_right, payload_kind).await?;
    let range = DiffRangeState {
        repo_root: repo_root.display().to_string(),
        base: range_base_endpoint,
        head: range_head_endpoint,
        payload,
        generated_at: Timestamp::now().millis().to_string(),
        displayed_patch_range,
    };
    let review = CommitStepState {
        commits,
        current_commit_oid,
        current_commit_index,
        previous_commit_oid,
    };
    Ok((range, review))
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

async fn build_payload(
    repo_root: &Path,
    left: &ResolvedDiffRef,
    right: &ResolvedDiffRef,
    payload_kind: DiffPayloadKind,
) -> anyhow::Result<DiffPayload> {
    let (text, truncated) = generate_diff(repo_root, left, right, payload_kind).await?;
    let files = summarize_files(repo_root, left, right)
        .await
        .unwrap_or_default();
    Ok(match payload_kind {
        DiffPayloadKind::StatOnly => DiffPayload::StatOnly {
            files,
            stat: text,
            truncated,
        },
        DiffPayloadKind::FullPatch => DiffPayload::FullPatch {
            files,
            patch: text,
            truncated,
        },
    })
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

async fn generate_diff(
    repo_root: &Path,
    base: &ResolvedDiffRef,
    head: &ResolvedDiffRef,
    payload_kind: DiffPayloadKind,
) -> anyhow::Result<(String, bool)> {
    let mut args = vec!["diff", "--find-renames"];
    if payload_kind == DiffPayloadKind::StatOnly {
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

async fn summarize_files(
    repo_root: &Path,
    base: &ResolvedDiffRef,
    head: &ResolvedDiffRef,
) -> anyhow::Result<Vec<DiffFileSummary>> {
    let base_oid = oid_for_diff(base)?;
    let head_oid;
    let right = match head {
        ResolvedDiffRef::WorkingTree => {
            head_oid = current_worktree_tree(repo_root).await?;
            head_oid.as_str()
        }
        ResolvedDiffRef::GitRef { oid, .. } => oid.as_str(),
    };
    let numstat = git_stdout(
        repo_root,
        &["diff", "--find-renames", "--numstat", base_oid, right],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await?;
    let name_status = git_stdout(
        repo_root,
        &["diff", "--find-renames", "--name-status", base_oid, right],
        MAX_GIT_OUTPUT_BYTES,
    )
    .await?;
    Ok(parse_numstat_name_status(&format!(
        "{numstat}\n{name_status}"
    )))
}

fn oid_for_diff(reference: &ResolvedDiffRef) -> anyhow::Result<&str> {
    match reference {
        ResolvedDiffRef::WorkingTree => {
            bail!("working tree cannot be used as the left side of a git diff")
        }
        ResolvedDiffRef::GitRef { oid, .. } => Ok(oid),
    }
}

fn parse_numstat_name_status(output: &str) -> Vec<DiffFileSummary> {
    let mut summaries: Vec<DiffFileSummary> = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 && (parts[0] == "-" || parts[0].chars().all(|ch| ch.is_ascii_digit())) {
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
        } else if let Some(summary) = summaries.iter_mut().find(|summary| {
            parts.last().is_some_and(|path| {
                *path == summary.new_path || summary.old_path.as_deref() == Some(*path)
            })
        }) {
            summary.status = status_from_name_status(parts.first().copied().unwrap_or(""));
        }
    }
    summaries
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
        .stderr(Stdio::piped());
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
            generate_diff(&repo, &base_ref, &head_ref, DiffPayloadKind::FullPatch)
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
            DiffPayloadKind::StatOnly,
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

        let responses = handle_session_changes_open(&state, "s1".into()).await;
        let ServerMessage::SessionChangesState { state } = &responses[0] else {
            panic!("expected session changes state: {:?}", responses);
        };
        let SessionChangesState::Ready {
            range,
            review,
            repos,
            ..
        } = state
        else {
            panic!("expected ready session changes state: {:?}", state);
        };
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].source, SessionRepoSource::Cwd);
        assert_eq!(
            repos[0].repo_root,
            repo.canonicalize().unwrap().display().to_string()
        );
        assert!(repos[0].has_session_start_snapshot);
        assert!(matches!(range.head, DiffEndpoint::WorkingTree));
        assert!(
            matches!(&range.base, DiffEndpoint::SessionStartSnapshot { snapshot } if snapshot.ref_name == snapshot_ref)
        );
        assert_eq!(review.current_commit_oid, None);
        let DiffPayload::StatOnly { stat, files, .. } = &range.payload else {
            panic!("expected stat payload: {:?}", range.payload);
        };
        assert!(stat.contains("src/lib.rs"), "{}", stat);
        assert!(stat.contains("src/new.rs"), "{}", stat);
        assert!(stat.contains("untracked.txt"), "{}", stat);
        assert!(files.iter().any(|file| file.new_path == "untracked.txt"));
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
        let missing_repo = handle_session_changes_open(&state, "missing-repo".into()).await;
        let ServerMessage::SessionChangesState { state } = &missing_repo[0] else {
            panic!("expected session changes state: {:?}", missing_repo);
        };
        assert!(matches!(state, SessionChangesState::MissingRepo { .. }));

        let (_repo_temp, repo, _base, _head) = test_repo();
        let session_file = repo.join("no-snapshot-session.jsonl");
        fs::write(&session_file, "").expect("session file");
        let app_state = crate::tests::test_state(8, None);
        app_state.sessions.write().await.insert(
            "missing-snapshot".into(),
            diff_test_record("missing-snapshot", &repo, &session_file),
        );
        let missing_snapshot =
            handle_session_changes_open(&app_state, "missing-snapshot".into()).await;
        let ServerMessage::SessionChangesState { state } = &missing_snapshot[0] else {
            panic!("expected session changes state: {:?}", missing_snapshot);
        };
        assert!(matches!(state, SessionChangesState::MissingSnapshot { .. }));

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
            handle_session_changes_open(&app_state, "missing-snapshot".into()).await;
        let ServerMessage::SessionChangesState { state } = &stale_snapshot_response[0] else {
            panic!(
                "expected session changes state: {:?}",
                stale_snapshot_response
            );
        };
        let SessionChangesState::MissingSnapshot { repos, .. } = state else {
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

        let state = crate::tests::test_state(8, None);
        state.sessions.write().await.insert(
            "manual".into(),
            diff_test_record("manual", &repo, &session_file),
        );
        let responses = handle_session_changes_open(&state, "manual".into()).await;
        let ServerMessage::SessionChangesState { state } = &responses[0] else {
            panic!("expected session changes state: {:?}", responses);
        };
        let SessionChangesState::Ready { range, .. } = state else {
            panic!("expected ready state: {:?}", state);
        };
        assert!(
            matches!(&range.base, DiffEndpoint::SessionStartSnapshot { snapshot } if snapshot.ref_name == session_start_ref)
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
        let (stdin, mut commands) = tokio::sync::mpsc::channel(4);
        let (stop, _stop_rx) = tokio::sync::oneshot::channel();
        state
            .rpc_sessions
            .write()
            .await
            .insert("s1".to_string(), RpcSessionHandle { stdin, stop });
        state
            .rpc_session_targets
            .write()
            .await
            .insert("s1".to_string(), "s1".to_string());

        let responses = handle_session_changes_snapshot(
            &state,
            "s1".into(),
            Some(repo.display().to_string()),
            Some(" now ".into()),
            DiffPayloadKind::FullPatch,
            Some("commit-1".into()),
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
        assert_eq!(pending.payload_kind, DiffPayloadKind::FullPatch);
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
        let full = build_compare_diff_state(
            &state,
            Some("req".into()),
            repo.clone(),
            DiffRefInput::GitRef {
                value: base.clone(),
            },
            DiffRefInput::GitRef {
                value: third.clone(),
            },
            DiffPayloadKind::FullPatch,
            false,
            Some(third.clone()),
        )
        .await
        .unwrap();

        assert_eq!(
            full.review.current_commit_oid.as_deref(),
            Some(third.as_str())
        );
        assert_eq!(full.review.current_commit_index, Some(1));
        assert!(matches!(&full.range.base, DiffEndpoint::GitRef { oid, .. } if oid == &base));
        assert!(matches!(&full.range.head, DiffEndpoint::GitRef { oid, .. } if oid == &third));
        let displayed = full
            .range
            .displayed_patch_range
            .as_ref()
            .expect("displayed patch range");
        assert!(matches!(&displayed.base, DiffEndpoint::Commit { oid, .. } if oid == &second));
        assert!(matches!(&displayed.head, DiffEndpoint::Commit { oid, .. } if oid == &third));
        let DiffPayload::FullPatch { patch, .. } = &full.range.payload else {
            panic!("expected full patch payload: {:?}", full.range.payload);
        };
        assert!(patch.contains("+pub fn value() -> i32 { 4 }"), "{}", patch);
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
