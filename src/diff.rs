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

pub(crate) async fn handle_diff_open(
    state: &AppState,
    session_id: Option<String>,
    repo_root: Option<String>,
) -> Vec<ServerMessage> {
    match resolve_repo_root(state, session_id.as_deref(), repo_root.as_deref()).await {
        Ok(root) => {
            let base = default_diff_base_ref(state, session_id.as_deref(), &root).await;
            match build_diff_state(
                state,
                session_id.clone(),
                root,
                base,
                DiffRefInput::WorkingTree,
                DiffMode::Stat,
                false,
                DiffReviewMode::Range,
                None,
            )
            .await
            {
                Ok(state_value) => vec![ServerMessage::DiffState {
                    session_id,
                    state: state_value,
                }],
                Err(error) => vec![diff_error(session_id, repo_root, error)],
            }
        }
        Err(error) => vec![diff_error(session_id, repo_root, error)],
    }
}

pub(crate) async fn handle_diff_compare(
    state: &AppState,
    session_id: Option<String>,
    repo_root: String,
    base: DiffRefInput,
    head: DiffRefInput,
    mode: DiffMode,
    merge_base: Option<bool>,
    review_mode: Option<DiffReviewMode>,
    commit_oid: Option<String>,
) -> Vec<ServerMessage> {
    match resolve_repo_root(state, session_id.as_deref(), Some(&repo_root)).await {
        Ok(root) => match build_diff_state(
            state,
            session_id.clone(),
            root,
            base,
            head,
            mode,
            merge_base.unwrap_or(false),
            review_mode.unwrap_or(DiffReviewMode::Range),
            commit_oid,
        )
        .await
        {
            Ok(state_value) => vec![ServerMessage::DiffState {
                session_id,
                state: state_value,
            }],
            Err(error) => vec![diff_error(session_id, Some(repo_root), error)],
        },
        Err(error) => vec![diff_error(session_id, Some(repo_root), error)],
    }
}

pub(crate) async fn handle_diff_review_worktree_ensure(
    state: &AppState,
    source_repo_root: String,
    base: Option<DiffRefInput>,
    head: Option<DiffRefInput>,
) -> Vec<ServerMessage> {
    match ensure_review_worktree(state, &source_repo_root, base, head).await {
        Ok(worktree) => vec![ServerMessage::DiffReviewWorktreeState { worktree }],
        Err(error) => vec![ServerMessage::DiffError {
            session_id: None,
            repo_root: Some(source_repo_root),
            message: error.to_string(),
        }],
    }
}

pub(crate) async fn handle_diff_review_worktree_checkout(
    state: &AppState,
    worktree_id: String,
    ref_target: DiffCheckoutTarget,
) -> Vec<ServerMessage> {
    match checkout_review_worktree(state, &worktree_id, ref_target).await {
        Ok(worktree) => vec![ServerMessage::DiffReviewWorktreeState { worktree }],
        Err(error) => vec![ServerMessage::DiffError {
            session_id: None,
            repo_root: None,
            message: error.to_string(),
        }],
    }
}

fn diff_error(
    session_id: Option<String>,
    repo_root: Option<String>,
    error: anyhow::Error,
) -> ServerMessage {
    ServerMessage::DiffError {
        session_id,
        repo_root,
        message: error.to_string(),
    }
}

async fn resolve_repo_root(
    state: &AppState,
    session_id: Option<&str>,
    repo_root: Option<&str>,
) -> anyhow::Result<PathBuf> {
    if let Some(root) = repo_root.and_then(non_empty_trimmed) {
        return discover_repo_root(root);
    }

    let session_id = session_id.ok_or_else(|| anyhow!("diff requires repoRoot or sessionId"))?;
    let sessions = state.sessions.read().await;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| anyhow!("unknown session: {session_id}"))?;
    let cwd = session
        .worktree
        .as_ref()
        .map(|worktree| worktree.path.as_str())
        .or(session.cwd.as_deref())
        .ok_or_else(|| anyhow!("session has no cwd for diff"))?;
    discover_repo_root(cwd)
}

async fn default_diff_base_ref(
    state: &AppState,
    session_id: Option<&str>,
    repo_root: &Path,
) -> DiffRefInput {
    let session_file = match session_id {
        Some(id) => session_file_for_diff(state, id).await,
        None => None,
    };
    if let Some(session_file) = session_file {
        for snapshot in read_session_diff_snapshots(Path::new(&session_file), repo_root)
            .into_iter()
            .rev()
        {
            if resolve_git_ref(repo_root, &snapshot.ref_name).await.is_ok() {
                return DiffRefInput::GitRef {
                    value: snapshot.ref_name,
                };
            }
        }
    }

    DiffRefInput::GitRef {
        value: "HEAD".to_string(),
    }
}

async fn session_file_for_diff(state: &AppState, session_id: &str) -> Option<String> {
    let sessions = state.sessions.read().await;
    sessions.get(session_id)?.session_file.clone()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionDiffSnapshot {
    ref_name: String,
}

fn read_session_diff_snapshots(path: &Path, repo_root: &Path) -> Vec<SessionDiffSnapshot> {
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
        let Some(snapshot_repo) = data.get("repoRoot").and_then(Value::as_str) else {
            continue;
        };
        if !snapshot_repo_matches(snapshot_repo, repo_root) {
            continue;
        }
        let Some(ref_name) = data.get("ref").and_then(Value::as_str) else {
            continue;
        };
        snapshots.push(SessionDiffSnapshot {
            ref_name: ref_name.to_string(),
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

async fn build_diff_state(
    state: &AppState,
    _session_id: Option<String>,
    repo_root: PathBuf,
    base: DiffRefInput,
    head: DiffRefInput,
    mode: DiffMode,
    merge_base: bool,
    review_mode: DiffReviewMode,
    commit_oid: Option<String>,
) -> anyhow::Result<RepoDiffState> {
    let refs = list_refs(&repo_root).await?;
    let base_resolved = resolve_diff_ref(&repo_root, &base).await?;
    let head_resolved = resolve_diff_ref(&repo_root, &head).await?;
    let range_base_oid = if merge_base {
        match (&base_resolved, &head_resolved) {
            (
                ResolvedDiffRef::GitRef { oid: base_oid, .. },
                ResolvedDiffRef::GitRef { oid: head_oid, .. },
            ) => Some(
                git_stdout(
                    &repo_root,
                    &["merge-base", base_oid, head_oid],
                    MAX_GIT_OUTPUT_BYTES,
                )
                .await?
                .trim()
                .to_string(),
            ),
            _ => None,
        }
    } else {
        None
    };

    let commits = match (&base_resolved, &head_resolved) {
        (
            ResolvedDiffRef::GitRef { oid: base_oid, .. },
            ResolvedDiffRef::GitRef { oid: head_oid, .. },
        ) => {
            let effective_base = range_base_oid.as_deref().unwrap_or(base_oid);
            list_commits(&repo_root, effective_base, head_oid).await?
        }
        (ResolvedDiffRef::GitRef { oid: base_oid, .. }, ResolvedDiffRef::WorkingTree) => {
            match resolve_git_ref(&repo_root, "HEAD").await {
                Ok(ResolvedDiffRef::GitRef { oid: head_oid, .. }) => {
                    let effective_base = range_base_oid.as_deref().unwrap_or(base_oid);
                    list_commits(&repo_root, effective_base, &head_oid).await?
                }
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    };

    let (left, right, selected_commit_index, previous_commit_oid) = match review_mode {
        DiffReviewMode::Range => (base_resolved.clone(), head_resolved.clone(), None, None),
        DiffReviewMode::Commit => {
            let commit_oid = commit_oid
                .clone()
                .ok_or_else(|| anyhow!("commit mode requires commitOid"))?;
            let index = commits
                .iter()
                .position(|commit| commit.oid == commit_oid)
                .ok_or_else(|| anyhow!("commit is not in the selected range: {commit_oid}"))?;
            let selected = &commits[index];
            let previous = if selected.is_merge {
                selected.parent_oids.first().cloned()
            } else if index == 0 {
                match &base_resolved {
                    ResolvedDiffRef::GitRef { oid, .. } => {
                        Some(range_base_oid.clone().unwrap_or_else(|| oid.clone()))
                    }
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
            (left_ref, right_ref, Some(index), Some(previous))
        }
    };

    let (diff, truncated) = generate_diff(&repo_root, &left, &right, mode).await?;
    let files = summarize_files(&repo_root, &left, &right)
        .await
        .unwrap_or_default();
    let review_worktree = current_review_worktree(state, &repo_root).await;

    Ok(RepoDiffState {
        repo_root: repo_root.display().to_string(),
        refs,
        comparison: DiffComparison {
            repo_root: repo_root.display().to_string(),
            base: left,
            head: right,
            mode,
            merge_base: merge_base.then_some(true),
        },
        diff,
        files,
        truncated,
        generated_at: Timestamp::now().millis().to_string(),
        review_progress: DiffReviewProgress {
            mode: review_mode,
            commits,
            selected_commit_oid: commit_oid,
            selected_commit_index,
            previous_commit_oid,
        },
        review_worktree,
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
    mode: DiffMode,
) -> anyhow::Result<(String, bool)> {
    let mut args = vec!["diff", "--find-renames"];
    if mode == DiffMode::Stat {
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
    let mut args = vec!["diff", "--find-renames", "--numstat", "--name-status"];
    let base_oid = oid_for_diff(base)?;
    match head {
        ResolvedDiffRef::WorkingTree => {
            let worktree_tree = current_worktree_tree(repo_root).await?;
            args.push(base_oid);
            args.push(&worktree_tree);
            let output = git_stdout(repo_root, &args, MAX_GIT_OUTPUT_BYTES).await?;
            Ok(parse_numstat_name_status(&output))
        }
        ResolvedDiffRef::GitRef { oid: head_oid, .. } => {
            args.push(base_oid);
            args.push(head_oid);
            let output = git_stdout(repo_root, &args, MAX_GIT_OUTPUT_BYTES).await?;
            Ok(parse_numstat_name_status(&output))
        }
    }
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
    _base: Option<DiffRefInput>,
    head: Option<DiffRefInput>,
) -> anyhow::Result<DiffReviewWorktree> {
    let source = discover_repo_root(source_repo_root)?;
    if let Some(existing) = current_review_worktree(state, &source).await {
        return Ok(refresh_worktree_dirty(existing).await);
    }

    let target_ref = match head.unwrap_or(DiffRefInput::GitRef {
        value: "HEAD".to_string(),
    }) {
        DiffRefInput::WorkingTree => DiffRefInput::GitRef {
            value: "HEAD".to_string(),
        },
        input => input,
    };
    let resolved = resolve_diff_ref(&source, &target_ref).await?;
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
        let (patch, truncated) = generate_diff(&repo, &base_ref, &head_ref, DiffMode::Full)
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
            DiffMode::Stat,
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
    async fn opens_session_diff_from_latest_snapshot_to_full_worktree() {
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

        let responses = handle_diff_open(&state, Some("s1".into()), None).await;
        let ServerMessage::DiffState { state, .. } = &responses[0] else {
            panic!("expected diff state: {:?}", responses);
        };
        assert!(matches!(
            state.comparison.head,
            ResolvedDiffRef::WorkingTree
        ));
        assert!(
            matches!(&state.comparison.base, ResolvedDiffRef::GitRef { input, .. } if input == snapshot_ref)
        );
        assert!(state.diff.contains("src/lib.rs"), "{}", state.diff);
        assert!(state.diff.contains("src/new.rs"), "{}", state.diff);
        assert!(state.diff.contains("untracked.txt"), "{}", state.diff);
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
            None,
            Some(DiffRefInput::GitRef {
                value: head.clone(),
            }),
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
