use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

use anyhow::{Context, anyhow, bail};
use git2::Repository;
use ignore::WalkBuilder;
use lsp_types::{Position, Range as LspRange};
use serde::Serialize;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::code_lsp::{Analyzer, AnalyzerHealth, ResolvedLocation};
use crate::{AppState, CodeWorkspaceSource, ServerMessage};

const MAX_CODE_FILE_BYTES: u64 = 1_000_000;
const MAX_TREE_ENTRIES: usize = 500;
const MAX_FILE_SEARCH_RESULTS: usize = 100;

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "target",
    "node_modules",
    ".next",
    "dist",
    "build",
    "coverage",
];

#[derive(Debug, Default)]
pub(crate) struct CodeWorkspaceRegistry {
    by_id: HashMap<String, CodeWorkspace>,
    by_key: HashMap<String, String>,
    analyzers: HashMap<PathBuf, Arc<Analyzer>>,
}

#[derive(Debug, Clone)]
struct CodeWorkspace {
    workspace_id: String,
    root: PathBuf,
    rust_root: Option<PathBuf>,
    source: CodeWorkspaceSource,
    session_id: Option<String>,
    review_worktree_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeWorkspaceSummary {
    pub(crate) workspace_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) root: String,
    pub(crate) rust_root: Option<String>,
    pub(crate) status: CodeStatus,
    pub(crate) status_message: Option<String>,
    pub(crate) source: CodeWorkspaceSource,
    pub(crate) review_worktree_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CodeStatus {
    FilesOnly,
    Starting,
    Indexing,
    Ready,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CodeTreeEntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeTreeEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) kind: CodeTreeEntryKind,
    pub(crate) size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeFileContent {
    pub(crate) path: String,
    pub(crate) language: String,
    pub(crate) text: String,
    pub(crate) size: u64,
    pub(crate) version: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodePosition {
    pub(crate) line: u32,
    pub(crate) character: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeRange {
    pub(crate) start: CodePosition,
    pub(crate) end: CodePosition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CodeLocationKind {
    Local,
    External,
}

/// A resolved navigation target. `Local` targets carry a workspace-relative
/// path the browser can open; `External` targets (dependencies, stdlib) carry
/// only a label and URI and are not navigable in the read-only browser.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeLocation {
    pub(crate) kind: CodeLocationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    pub(crate) range: CodeRange,
}

pub(crate) async fn handle_code_workspace_open(
    state: &AppState,
    session_id: String,
) -> Vec<ServerMessage> {
    match open_workspace_for_session(state, &session_id).await {
        Ok(summary) => vec![ServerMessage::CodeWorkspaceReady { workspace: summary }],
        Err(message) => vec![ServerMessage::CodeError {
            workspace_id: None,
            path: None,
            message,
        }],
    }
}

pub(crate) async fn handle_code_workspace_open_root(
    state: &AppState,
    root: String,
    source: CodeWorkspaceSource,
    review_worktree_id: Option<String>,
) -> Vec<ServerMessage> {
    match open_workspace_for_root(state, &root, source, None, review_worktree_id).await {
        Ok(summary) => vec![ServerMessage::CodeWorkspaceReady { workspace: summary }],
        Err(message) => vec![ServerMessage::CodeError {
            workspace_id: None,
            path: None,
            message,
        }],
    }
}

pub(crate) async fn handle_code_tree_list(
    state: &AppState,
    workspace_id: String,
    path: Option<String>,
) -> Vec<ServerMessage> {
    let requested_path = path.unwrap_or_default();
    match list_workspace_tree(state, &workspace_id, &requested_path).await {
        Ok(entries) => vec![ServerMessage::CodeTree {
            workspace_id,
            path: normalize_protocol_path(&requested_path).unwrap_or_default(),
            entries,
        }],
        Err(message) => vec![ServerMessage::CodeError {
            workspace_id: Some(workspace_id),
            path: Some(requested_path),
            message,
        }],
    }
}

pub(crate) async fn handle_code_file_open(
    state: &AppState,
    workspace_id: String,
    path: String,
) -> Vec<ServerMessage> {
    match open_workspace_file(state, &workspace_id, &path).await {
        Ok(file) => vec![ServerMessage::CodeFile { workspace_id, file }],
        Err(message) => vec![ServerMessage::CodeError {
            workspace_id: Some(workspace_id),
            path: Some(path),
            message,
        }],
    }
}

pub(crate) async fn handle_code_file_close(
    _workspace_id: String,
    _path: String,
) -> Vec<ServerMessage> {
    Vec::new()
}

pub(crate) async fn handle_code_file_search(
    state: &AppState,
    workspace_id: String,
    base_path: String,
    query: String,
    limit: Option<usize>,
) -> Vec<ServerMessage> {
    match search_workspace_files(
        state,
        &workspace_id,
        &base_path,
        &query,
        limit.unwrap_or(MAX_FILE_SEARCH_RESULTS),
    )
    .await
    {
        Ok(entries) => vec![ServerMessage::CodeFileSearchResults {
            workspace_id,
            base_path,
            query,
            entries,
        }],
        Err(message) => vec![ServerMessage::CodeError {
            workspace_id: Some(workspace_id),
            path: Some(base_path),
            message,
        }],
    }
}

#[derive(Clone, Copy)]
enum NavigationKind {
    Definition,
    References,
}

pub(crate) async fn handle_code_definition(
    state: &AppState,
    workspace_id: String,
    path: String,
    line: u32,
    character: u32,
    request_id: String,
) -> Vec<ServerMessage> {
    start_navigation(
        state,
        workspace_id,
        path,
        line,
        character,
        request_id,
        NavigationKind::Definition,
    )
    .await
}

pub(crate) async fn handle_code_references(
    state: &AppState,
    workspace_id: String,
    path: String,
    line: u32,
    character: u32,
    request_id: String,
) -> Vec<ServerMessage> {
    start_navigation(
        state,
        workspace_id,
        path,
        line,
        character,
        request_id,
        NavigationKind::References,
    )
    .await
}

/// Validate the request synchronously, then run the (possibly slow) analyzer
/// query in the background, broadcasting `code.status` + the result. The result
/// carries `request_id` so a client ignores stale or other-client responses.
async fn start_navigation(
    state: &AppState,
    workspace_id: String,
    path: String,
    line: u32,
    character: u32,
    request_id: String,
    kind: NavigationKind,
) -> Vec<ServerMessage> {
    let workspace = match workspace_by_id(&state.code_workspaces, &workspace_id).await {
        Ok(workspace) => workspace,
        Err(message) => {
            return vec![ServerMessage::CodeError {
                workspace_id: Some(workspace_id),
                path: Some(path),
                message,
            }];
        }
    };
    // Re-discover the Rust root from disk each time: a cached workspace's
    // rust_root can go stale if a Cargo.toml is added/removed during the session
    // (e.g. an agent scaffolding a crate), and it gates navigation availability.
    let Some(rust_root) = discover_rust_root(&workspace.root) else {
        return vec![ServerMessage::CodeStatus {
            workspace_id,
            status: CodeStatus::FilesOnly,
            message: Some(
                "Rust navigation is unavailable: no Cargo.toml was found for this workspace."
                    .to_string(),
            ),
        }];
    };
    let abs_path = match resolve_workspace_path(&workspace.root, &path) {
        Ok(abs_path) => abs_path,
        Err(err) => {
            return vec![ServerMessage::CodeError {
                workspace_id: Some(workspace_id),
                path: Some(path),
                message: err.to_string(),
            }];
        }
    };
    // Read the queried file synchronously so request-scoped failures (binary,
    // non-UTF-8, too large, missing) are reported directly to the requester
    // rather than broadcast as shared analyzer status. read_code_file enforces
    // the same size/binary/UTF-8 guards as the file viewer.
    let text = match read_code_file(&workspace.root, &path) {
        Ok(file) => file.text,
        Err(err) => {
            return vec![ServerMessage::CodeError {
                workspace_id: Some(workspace_id),
                path: Some(path),
                message: err.to_string(),
            }];
        }
    };
    let position = Position { line, character };
    let state = state.clone();
    tokio::spawn(async move {
        run_navigation_query(
            state, workspace, rust_root, path, abs_path, text, position, request_id, kind,
        )
        .await;
    });
    Vec::new()
}

async fn run_navigation_query(
    state: AppState,
    workspace: CodeWorkspace,
    rust_root: PathBuf,
    request_path: String,
    abs_path: PathBuf,
    text: String,
    position: Position,
    request_id: String,
    kind: NavigationKind,
) {
    let workspace_id = workspace.workspace_id.clone();

    let analyzer = match ensure_analyzer(&state, &rust_root).await {
        Ok(analyzer) => analyzer,
        Err(err) => {
            emit_navigation_status(
                &state,
                &workspace_id,
                CodeStatus::Unavailable,
                Some(format!("rust-analyzer is unavailable: {err}")),
            )
            .await;
            return;
        }
    };

    emit_navigation_status(
        &state,
        &workspace_id,
        status_from_health(analyzer.health()),
        None,
    )
    .await;

    let result = match kind {
        NavigationKind::Definition => analyzer.definition(&abs_path, &text, position).await,
        NavigationKind::References => analyzer.references(&abs_path, &text, position).await,
    };

    match result {
        Ok(locations) => {
            let locations = map_locations(&workspace.root, locations);
            let result_message = match kind {
                NavigationKind::Definition => ServerMessage::CodeDefinition {
                    workspace_id: workspace_id.clone(),
                    request_id,
                    path: request_path,
                    locations,
                },
                NavigationKind::References => ServerMessage::CodeReferences {
                    workspace_id: workspace_id.clone(),
                    request_id,
                    path: request_path,
                    locations,
                },
            };
            state
                .events
                .emit_many(
                    &state,
                    vec![
                        ServerMessage::CodeStatus {
                            workspace_id,
                            status: CodeStatus::Ready,
                            message: None,
                        },
                        result_message,
                    ],
                )
                .await;
        }
        Err(err) => {
            if !analyzer.is_alive() {
                drop_analyzer(&state, &rust_root).await;
            }
            emit_navigation_status(
                &state,
                &workspace_id,
                CodeStatus::Error,
                Some(err.to_string()),
            )
            .await;
        }
    }
}

/// Broadcast a per-workspace analyzer status. Status is intentionally not
/// request-correlated: it reflects the shared analyzer's state for the root.
async fn emit_navigation_status(
    state: &AppState,
    workspace_id: &str,
    status: CodeStatus,
    message: Option<String>,
) {
    state
        .events
        .emit(
            state,
            ServerMessage::CodeStatus {
                workspace_id: workspace_id.to_string(),
                status,
                message,
            },
        )
        .await;
}

/// Get the analyzer for `root`, spawning it lazily if needed. Cold-start spawns
/// are serialized per root via `analyzer_spawn_locks` so concurrent misses do
/// not each launch a child, while different roots still spawn in parallel; the
/// registry lock is never held across the spawn await.
async fn ensure_analyzer(state: &AppState, root: &Path) -> anyhow::Result<Arc<Analyzer>> {
    if let Some(analyzer) = state.code_workspaces.read().await.alive_analyzer(root) {
        return Ok(analyzer);
    }
    let gate = {
        let mut locks = state.analyzer_spawn_locks.lock().await;
        locks
            .entry(root.to_path_buf())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _spawn_guard = gate.lock().await;
    // Re-check under the gate: another task may have spawned while we waited.
    if let Some(analyzer) = state.code_workspaces.read().await.alive_analyzer(root) {
        return Ok(analyzer);
    }
    let analyzer = Analyzer::spawn(state.rust_analyzer_bin.as_str(), root).await?;
    state
        .code_workspaces
        .write()
        .await
        .analyzers
        .insert(root.to_path_buf(), analyzer.clone());
    Ok(analyzer)
}

async fn drop_analyzer(state: &AppState, root: &Path) {
    let removed = state.code_workspaces.write().await.analyzers.remove(root);
    if let Some(analyzer) = removed {
        tokio::spawn(async move { analyzer.shutdown().await });
    }
}

fn status_from_health(health: AnalyzerHealth) -> CodeStatus {
    match health {
        AnalyzerHealth::Starting => CodeStatus::Starting,
        AnalyzerHealth::Indexing => CodeStatus::Indexing,
        AnalyzerHealth::Ready => CodeStatus::Ready,
        AnalyzerHealth::Error => CodeStatus::Error,
    }
}

fn map_locations(root: &Path, locations: Vec<ResolvedLocation>) -> Vec<CodeLocation> {
    locations
        .into_iter()
        .map(|location| {
            let range = code_range_from_lsp(location.range);
            let canonical = location.path.canonicalize().unwrap_or(location.path);
            match canonical.strip_prefix(root) {
                Ok(relative) => CodeLocation {
                    kind: CodeLocationKind::Local,
                    path: Some(path_to_protocol(relative)),
                    uri: None,
                    label: None,
                    range,
                },
                Err(_) => {
                    let display = canonical.display().to_string();
                    CodeLocation {
                        kind: CodeLocationKind::External,
                        path: None,
                        uri: Some(format!("file://{display}")),
                        label: Some(display),
                        range,
                    }
                }
            }
        })
        .collect()
}

fn code_range_from_lsp(range: LspRange) -> CodeRange {
    CodeRange {
        start: CodePosition {
            line: range.start.line,
            character: range.start.character,
        },
        end: CodePosition {
            line: range.end.line,
            character: range.end.character,
        },
    }
}

async fn open_workspace_for_session(
    state: &AppState,
    session_id: &str,
) -> Result<CodeWorkspaceSummary, String> {
    let root = {
        let sessions = state.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        let candidate = session
            .worktree
            .as_ref()
            .map(|worktree| worktree.path.as_str())
            .or(session.cwd.as_deref())
            .ok_or_else(|| "session has no cwd to browse".to_string())?;
        canonical_workspace_root(candidate).map_err(|err| err.to_string())?
    };

    let mut registry = state.code_workspaces.write().await;
    let workspace = registry.workspace_for_root(
        root,
        CodeWorkspaceSource::Session,
        Some(session_id.to_string()),
        None,
    );
    Ok(workspace.summary())
}

async fn open_workspace_for_root(
    state: &AppState,
    root: &str,
    source: CodeWorkspaceSource,
    session_id: Option<String>,
    review_worktree_id: Option<String>,
) -> Result<CodeWorkspaceSummary, String> {
    let root = canonical_workspace_root(root).map_err(|err| err.to_string())?;
    let mut registry = state.code_workspaces.write().await;
    let workspace = registry.workspace_for_root(root, source, session_id, review_worktree_id);
    Ok(workspace.summary())
}

async fn list_workspace_tree(
    state: &AppState,
    workspace_id: &str,
    path: &str,
) -> Result<Vec<CodeTreeEntry>, String> {
    let workspace = workspace_by_id(&state.code_workspaces, workspace_id).await?;
    list_tree_entries(&workspace.root, path).map_err(|err| err.to_string())
}

async fn open_workspace_file(
    state: &AppState,
    workspace_id: &str,
    path: &str,
) -> Result<CodeFileContent, String> {
    let workspace = workspace_by_id(&state.code_workspaces, workspace_id).await?;
    read_code_file(&workspace.root, path).map_err(|err| err.to_string())
}

async fn search_workspace_files(
    state: &AppState,
    workspace_id: &str,
    base_path: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<CodeTreeEntry>, String> {
    let workspace = workspace_by_id(&state.code_workspaces, workspace_id).await?;
    find_files(&workspace.root, base_path, query, limit).map_err(|err| err.to_string())
}

async fn workspace_by_id(
    registry: &Arc<RwLock<CodeWorkspaceRegistry>>,
    workspace_id: &str,
) -> Result<CodeWorkspace, String> {
    let registry = registry.read().await;
    registry
        .by_id
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| format!("unknown code workspace: {workspace_id}"))
}

impl CodeWorkspaceRegistry {
    fn workspace_for_root(
        &mut self,
        root: PathBuf,
        source: CodeWorkspaceSource,
        session_id: Option<String>,
        review_worktree_id: Option<String>,
    ) -> CodeWorkspace {
        let key = workspace_key(
            &root,
            source,
            session_id.as_deref(),
            review_worktree_id.as_deref(),
        );
        if let Some(workspace_id) = self.by_key.get(&key) {
            if let Some(workspace) = self.by_id.get(workspace_id) {
                return workspace.clone();
            }
        }

        let workspace_id = Uuid::new_v4().to_string();
        let rust_root = discover_rust_root(&root);
        let workspace = CodeWorkspace {
            workspace_id: workspace_id.clone(),
            root: root.clone(),
            rust_root,
            source,
            session_id,
            review_worktree_id,
        };
        self.by_key.insert(key, workspace_id.clone());
        self.by_id.insert(workspace_id, workspace.clone());
        workspace
    }

    fn alive_analyzer(&self, root: &Path) -> Option<Arc<Analyzer>> {
        self.analyzers
            .get(root)
            .filter(|analyzer| analyzer.is_alive())
            .cloned()
    }
}

fn workspace_key(
    root: &Path,
    source: CodeWorkspaceSource,
    session_id: Option<&str>,
    review_worktree_id: Option<&str>,
) -> String {
    format!(
        "{}|{:?}|{}|{}",
        root.display(),
        source,
        session_id.unwrap_or(""),
        review_worktree_id.unwrap_or("")
    )
}

impl CodeWorkspace {
    fn summary(&self) -> CodeWorkspaceSummary {
        let status_message = match self.rust_root {
            Some(_) => "Files only. Go to definition and find references load on demand.",
            None => "Files only. Cargo.toml was not found.",
        };
        CodeWorkspaceSummary {
            workspace_id: self.workspace_id.clone(),
            session_id: self.session_id.clone(),
            root: self.root.display().to_string(),
            rust_root: self
                .rust_root
                .as_ref()
                .map(|path| path.display().to_string()),
            status: CodeStatus::FilesOnly,
            status_message: Some(status_message.to_string()),
            source: self.source,
            review_worktree_id: self.review_worktree_id.clone(),
        }
    }
}

fn canonical_workspace_root(path: &str) -> anyhow::Result<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        bail!("session cwd is empty");
    }
    let root = PathBuf::from(trimmed)
        .canonicalize()
        .with_context(|| format!("failed to resolve workspace root: {trimmed}"))?;
    if !root.is_dir() {
        bail!("workspace root is not a directory: {}", root.display());
    }
    Ok(root)
}

fn discover_rust_root(root: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    if root.join("Cargo.toml").is_file() {
        return Some(root);
    }

    let mut current = root.as_path();
    while let Some(parent) = current.parent() {
        if parent.join(".git").exists() {
            return parent
                .join("Cargo.toml")
                .is_file()
                .then(|| parent.to_path_buf());
        }
        if parent.join("Cargo.toml").is_file() {
            return Some(parent.to_path_buf());
        }
        current = parent;
    }
    None
}

fn list_tree_entries(root: &Path, requested_path: &str) -> anyhow::Result<Vec<CodeTreeEntry>> {
    let dir = resolve_workspace_path(root, requested_path)?;
    if !dir.is_dir() {
        bail!(
            "path is not a directory: {}",
            display_protocol_path(requested_path)
        );
    }

    let repo = Repository::discover(root).ok();

    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir)
        .with_context(|| format!("failed to read directory: {}", dir.display()))?
    {
        let entry = entry?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy().to_string();
        let metadata = entry.metadata()?;
        let entry_path = entry.path();
        let relative_path = entry_path
            .strip_prefix(root)
            .map_err(|_| anyhow!("directory entry escaped workspace root"))?;
        if should_ignore_entry(root, relative_path, &name, metadata.is_dir(), repo.as_ref()) {
            continue;
        }
        let kind = if metadata.is_dir() {
            CodeTreeEntryKind::Directory
        } else {
            CodeTreeEntryKind::File
        };
        entries.push(CodeTreeEntry {
            name,
            path: path_to_protocol(relative_path),
            kind,
            size: metadata.is_file().then_some(metadata.len()),
        });
        if entries.len() > MAX_TREE_ENTRIES {
            bail!("directory has more than {MAX_TREE_ENTRIES} visible entries");
        }
    }

    entries.sort_by(|left, right| {
        left.kind
            .cmp_sort_key()
            .cmp(&right.kind.cmp_sort_key())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

fn read_code_file(root: &Path, requested_path: &str) -> anyhow::Result<CodeFileContent> {
    let file_path = resolve_workspace_path(root, requested_path)?;
    if !file_path.is_file() {
        bail!(
            "path is not a file: {}",
            display_protocol_path(requested_path)
        );
    }
    let metadata = file_path.metadata()?;
    if metadata.len() > MAX_CODE_FILE_BYTES {
        bail!(
            "file is too large for the code viewer: {} bytes (limit {MAX_CODE_FILE_BYTES})",
            metadata.len()
        );
    }
    let bytes = fs::read(&file_path)?;
    if bytes.contains(&0) {
        bail!("binary file cannot be displayed in the code viewer");
    }
    let text = String::from_utf8(bytes).map_err(|_| anyhow!("file is not valid UTF-8"))?;
    let relative_path = file_path
        .strip_prefix(root)
        .map_err(|_| anyhow!("file escaped workspace root"))?;
    let protocol_path = path_to_protocol(relative_path);
    let language = language_for_path(&protocol_path);
    let version = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(metadata.len());

    Ok(CodeFileContent {
        path: protocol_path,
        language,
        text,
        size: metadata.len(),
        version,
    })
}

fn find_files(
    root: &Path,
    base_path: &str,
    query: &str,
    limit: usize,
) -> anyhow::Result<Vec<CodeTreeEntry>> {
    let base_dir = resolve_search_base_dir(root, base_path)?;
    if !base_dir.is_dir() {
        bail!(
            "base path is not a directory: {}",
            display_protocol_path(base_path)
        );
    }

    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Ok(Vec::new());
    }

    let result_limit = limit.clamp(1, MAX_FILE_SEARCH_RESULTS);
    let mut builder = WalkBuilder::new(&base_dir);
    builder
        .standard_filters(true)
        .follow_links(false)
        .sort_by_file_path(|left, right| left.cmp(right));

    let mut entries_with_score = Vec::new();
    for result in builder.build() {
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Some(file_type) if file_type.is_file() => file_type,
            _ => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        let relative_path = path
            .strip_prefix(root)
            .map_err(|_| anyhow!("search result escaped workspace root"))?;
        let protocol_path = path_to_protocol(relative_path);
        let Some(score) = fuzzy_match_score(&protocol_path, &normalized_query) else {
            continue;
        };
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        entries_with_score.push((
            score,
            CodeTreeEntry {
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| protocol_path.clone()),
                path: protocol_path,
                kind: CodeTreeEntryKind::File,
                size: Some(metadata.len()),
            },
        ));
    }

    entries_with_score.sort_by(|(left_score, left_entry), (right_score, right_entry)| {
        right_score
            .cmp(left_score)
            .then_with(|| {
                left_entry
                    .path
                    .to_lowercase()
                    .cmp(&right_entry.path.to_lowercase())
            })
            .then_with(|| left_entry.path.cmp(&right_entry.path))
    });

    let mut entries = Vec::new();
    for (_, entry) in entries_with_score.into_iter().take(result_limit) {
        entries.push(entry);
    }
    Ok(entries)
}

fn resolve_search_base_dir(root: &Path, base_path: &str) -> anyhow::Result<PathBuf> {
    let trimmed = base_path.trim();
    if trimmed.is_empty() || trimmed == root.display().to_string() {
        return Ok(root.to_path_buf());
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        let resolved = candidate.canonicalize().with_context(|| {
            format!(
                "base path does not exist: {}",
                display_protocol_path(base_path)
            )
        })?;
        if !resolved.starts_with(root) {
            bail!("base path must stay inside the workspace root");
        }
        return Ok(resolved);
    }
    resolve_workspace_path(root, base_path)
}

fn fuzzy_match_score(path: &str, query: &str) -> Option<i64> {
    let path_lower = path.to_lowercase();
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let file_name_lower = file_name.to_lowercase();

    let mut score = if let Some(index) = path_lower.find(query) {
        10_000 - index as i64
    } else {
        subsequence_score(&path_lower, query)?
    };

    if let Some(index) = file_name_lower.find(query) {
        score += 20_000 - index as i64;
    } else if let Some(file_name_score) = subsequence_score(&file_name_lower, query) {
        score += 5_000 + file_name_score;
    }

    Some(score)
}

fn subsequence_score(candidate: &str, query: &str) -> Option<i64> {
    let mut score = 0_i64;
    let mut last_match = None;
    let mut cursor = 0usize;

    for query_char in query.chars() {
        let rest = candidate.get(cursor..)?;
        let mut matched = None;
        for (offset, candidate_char) in rest.char_indices() {
            if candidate_char == query_char {
                matched = Some((cursor + offset, candidate_char.len_utf8()));
                break;
            }
        }
        let (index, width) = matched?;
        score += 10;
        if let Some(previous) = last_match {
            if index == previous + 1 {
                score += 8;
            }
        }
        if index == 0
            || candidate[..index].ends_with('/')
            || candidate[..index].ends_with('_')
            || candidate[..index].ends_with('-')
            || candidate[..index].ends_with('.')
        {
            score += 6;
        }
        last_match = Some(index);
        cursor = index + width;
    }

    score -= candidate.len() as i64;
    Some(score)
}

fn resolve_workspace_path(root: &Path, requested_path: &str) -> anyhow::Result<PathBuf> {
    let relative = normalize_relative_path(requested_path)?;
    let joined = root.join(relative);
    let resolved = joined.canonicalize().with_context(|| {
        format!(
            "path does not exist: {}",
            display_protocol_path(requested_path)
        )
    })?;
    if !resolved.starts_with(root) {
        bail!("path escapes the workspace root");
    }
    Ok(resolved)
}

fn normalize_relative_path(path: &str) -> anyhow::Result<PathBuf> {
    let trimmed = path.trim();
    let mut normalized = PathBuf::new();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(normalized);
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        bail!("absolute paths are not accepted by the code viewer");
    }
    for component in candidate.components() {
        match component {
            Component::Normal(segment) => normalized.push(segment),
            Component::CurDir => {}
            Component::ParentDir => {
                bail!("parent path segments are not accepted by the code viewer")
            }
            Component::RootDir | Component::Prefix(_) => {
                bail!("absolute paths are not accepted by the code viewer")
            }
        }
    }
    Ok(normalized)
}

fn normalize_protocol_path(path: &str) -> anyhow::Result<String> {
    Ok(path_to_protocol(normalize_relative_path(path)?))
}

fn path_to_protocol(path: impl AsRef<Path>) -> String {
    path.as_ref()
        .components()
        .filter_map(|component| match component {
            Component::Normal(segment) => Some(segment.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn display_protocol_path(path: &str) -> String {
    if path.trim().is_empty() {
        ".".to_string()
    } else {
        path.to_string()
    }
}

fn should_ignore_dir(name: &str) -> bool {
    IGNORED_DIRS.iter().any(|ignored| name == *ignored)
}

fn should_ignore_entry(
    root: &Path,
    relative_path: &Path,
    name: &str,
    is_dir: bool,
    repo: Option<&Repository>,
) -> bool {
    if is_dir && should_ignore_dir(name) {
        return true;
    }
    if is_hidden_name(name) {
        return true;
    }
    is_git_ignored(root, relative_path, repo)
}

fn is_git_ignored(root: &Path, relative_path: &Path, repo: Option<&Repository>) -> bool {
    let Some(repo) = repo else {
        return false;
    };
    let Some(workdir) = repo.workdir() else {
        return false;
    };
    let absolute_path = root.join(relative_path);
    let Ok(repo_relative_path) = absolute_path.strip_prefix(workdir) else {
        return false;
    };
    repo.status_should_ignore(repo_relative_path)
        .unwrap_or(false)
}

fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

fn language_for_path(path: &str) -> String {
    let file_name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    if file_name == "dockerfile" || file_name.starts_with("dockerfile.") {
        return "dockerfile".to_string();
    }
    if file_name == "justfile" {
        return "bash".to_string();
    }
    match file_name.rsplit_once('.').map(|(_, extension)| extension) {
        Some("rs") => "rust",
        Some("ts" | "tsx" | "mts" | "cts") => "typescript",
        Some("js" | "jsx" | "mjs" | "cjs") => "javascript",
        Some("py") => "python",
        Some("md" | "mdx") => "markdown",
        Some("json" | "jsonc") => "json",
        Some("yaml" | "yml") => "yaml",
        Some("toml") => "toml",
        Some("html" | "htm") => "xml",
        Some("css" | "scss" | "sass" | "less") => "css",
        Some("sh" | "bash" | "zsh") => "bash",
        Some("go") => "go",
        Some("java") => "java",
        Some("c" | "h") => "c",
        Some("cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx") => "cpp",
        Some("xml") => "xml",
        _ => "text",
    }
    .to_string()
}

impl CodeTreeEntryKind {
    fn cmp_sort_key(self) -> u8 {
        match self {
            Self::Directory => 0,
            Self::File => 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace() -> PathBuf {
        let root = std::env::temp_dir().join(format!("fura-code-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp workspace created");
        root.canonicalize().expect("temp workspace canonicalized")
    }

    #[test]
    fn rejects_parent_path_segments() {
        let root = temp_workspace();
        fs::write(root.join("main.rs"), "fn main() {}\n").expect("file written");

        let error = read_code_file(&root, "../main.rs").expect_err("parent path rejected");

        assert!(error.to_string().contains("parent path segments"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_symlink_escape() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let root = temp_workspace();
            let outside = temp_workspace();
            fs::write(outside.join("secret.rs"), "fn secret() {}\n").expect("outside file written");
            symlink(outside.join("secret.rs"), root.join("secret.rs")).expect("symlink created");

            let error = read_code_file(&root, "secret.rs").expect_err("symlink escape rejected");

            assert!(error.to_string().contains("workspace root"));
            fs::remove_dir_all(root).ok();
            fs::remove_dir_all(outside).ok();
        }
    }

    #[test]
    fn rejects_binary_files() {
        let root = temp_workspace();
        fs::write(root.join("data.bin"), [0_u8, 1, 2, 3]).expect("binary written");

        let error = read_code_file(&root, "data.bin").expect_err("binary rejected");

        assert!(error.to_string().contains("binary file"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn lists_directories_before_files_and_filters_generated_dirs() {
        let root = temp_workspace();
        fs::create_dir_all(root.join("src")).expect("src created");
        fs::create_dir_all(root.join("target")).expect("target created");
        fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\n")
            .expect("manifest written");
        fs::write(root.join("README.md"), "# demo\n").expect("readme written");

        let entries = list_tree_entries(&root, "").expect("tree listed");
        let names = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["src", "Cargo.toml", "README.md"]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn list_tree_uses_rg_like_hidden_and_gitignore_filters() {
        let root = temp_workspace();
        Repository::init(&root).expect("repo initialized");
        fs::write(root.join(".gitignore"), "ignored.log\nignored-dir/\n")
            .expect("gitignore written");
        fs::write(root.join("visible.rs"), "fn visible() {}\n").expect("visible written");
        fs::write(root.join("ignored.log"), "ignored\n").expect("ignored file written");
        fs::write(root.join(".hidden.rs"), "fn hidden() {}\n").expect("hidden file written");
        fs::create_dir_all(root.join("ignored-dir")).expect("ignored dir created");
        fs::write(root.join("ignored-dir/file.rs"), "fn ignored() {}\n")
            .expect("ignored nested file written");

        let entries = list_tree_entries(&root, "").expect("tree listed");
        let names = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["visible.rs"]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn reads_text_file_with_language_and_version() {
        let root = temp_workspace();
        fs::create_dir_all(root.join("src")).expect("src created");
        fs::write(root.join("src/main.rs"), "fn main() {}\n").expect("file written");

        let file = read_code_file(&root, "src/main.rs").expect("file read");

        assert_eq!(file.path, "src/main.rs");
        assert_eq!(file.language, "rust");
        assert_eq!(file.text, "fn main() {}\n");
        assert!(file.version > 0);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn searches_files_from_workspace_root() {
        let root = temp_workspace();
        Repository::init(&root).expect("repo initialized");
        fs::write(root.join(".gitignore"), "ignored.log\n").expect("gitignore written");
        fs::create_dir_all(root.join("src/bin")).expect("src created");
        fs::write(root.join("src/lib.rs"), "pub fn lib() {}\n").expect("lib written");
        fs::write(root.join("src/bin/main.rs"), "fn main() {}\n").expect("main written");
        fs::write(root.join("ignored.log"), "ignored\n").expect("ignored written");

        let entries =
            find_files(&root, &root.display().to_string(), "rs", 20).expect("files searched");
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths.len(), 2);
        assert!(paths.contains(&"src/bin/main.rs"));
        assert!(paths.contains(&"src/lib.rs"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_search_base_outside_workspace() {
        let root = temp_workspace();
        let outside = temp_workspace();

        let error = find_files(&root, &outside.display().to_string(), "rs", 20)
            .expect_err("outside base path rejected");

        assert!(error.to_string().contains("workspace root"));
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn searches_files_from_nested_base_dir() {
        let root = temp_workspace();
        fs::create_dir_all(root.join("src")).expect("src created");
        fs::create_dir_all(root.join("tests")).expect("tests created");
        fs::write(root.join("src/alpha.rs"), "fn alpha() {}\n").expect("alpha written");
        fs::write(root.join("src/beta.rs"), "fn beta() {}\n").expect("beta written");
        fs::write(root.join("tests/alpha.rs"), "fn alpha_test() {}\n").expect("test written");

        let entries = find_files(&root, "src", "alpha", 1).expect("files searched");
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["src/alpha.rs"]);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn discovers_cargo_manifest_at_root() {
        let root = temp_workspace();
        fs::write(root.join("Cargo.toml"), "[workspace]\n").expect("manifest written");

        assert_eq!(discover_rust_root(&root), Some(root.clone()));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn map_locations_classifies_local_and_external_targets() {
        let root = temp_workspace();
        fs::create_dir_all(root.join("src")).expect("src created");
        fs::write(root.join("src/lib.rs"), "pub fn f() {}\n").expect("file written");
        let local = ResolvedLocation {
            path: root.join("src/lib.rs"),
            range: LspRange {
                start: Position {
                    line: 2,
                    character: 4,
                },
                end: Position {
                    line: 2,
                    character: 9,
                },
            },
        };
        let external = ResolvedLocation {
            path: PathBuf::from("/nonexistent-external-dep/src/x.rs"),
            range: LspRange {
                start: Position {
                    line: 0,
                    character: 0,
                },
                end: Position {
                    line: 0,
                    character: 1,
                },
            },
        };

        let mapped = map_locations(&root, vec![local, external]);

        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].kind, CodeLocationKind::Local);
        assert_eq!(mapped[0].path.as_deref(), Some("src/lib.rs"));
        assert_eq!(mapped[0].range.start.line, 2);
        assert_eq!(mapped[0].range.start.character, 4);
        assert_eq!(mapped[1].kind, CodeLocationKind::External);
        assert!(mapped[1].path.is_none());
        assert!(mapped[1].label.as_deref().unwrap().contains("x.rs"));
        fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn definition_without_rust_root_reports_files_only_and_never_spawns() {
        let mut state = crate::tests::test_state(8, None);
        // A bogus binary would error loudly if a spawn were attempted.
        state.rust_analyzer_bin = Arc::new("/nonexistent/rust-analyzer-xyz".to_string());
        let root = temp_workspace();
        fs::write(root.join("main.rs"), "fn main() {}\n").expect("file written");

        let summary = open_workspace_for_root(
            &state,
            &root.display().to_string(),
            CodeWorkspaceSource::Session,
            None,
            None,
        )
        .await
        .expect("workspace opened");
        assert!(summary.rust_root.is_none());

        let messages = handle_code_definition(
            &state,
            summary.workspace_id,
            "main.rs".to_string(),
            0,
            3,
            "req-1".to_string(),
        )
        .await;

        assert_eq!(messages.len(), 1);
        match &messages[0] {
            ServerMessage::CodeStatus { status, .. } => {
                assert_eq!(*status, CodeStatus::FilesOnly)
            }
            other => panic!("expected code.status, got {other:?}"),
        }
        assert!(state.code_workspaces.read().await.analyzers.is_empty());
        fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn definition_rediscovers_rust_root_after_cargo_appears() {
        let mut state = crate::tests::test_state(8, None);
        state.rust_analyzer_bin = Arc::new("/nonexistent/rust-analyzer-xyz".to_string());
        let root = temp_workspace();
        fs::write(root.join("main.rs"), "fn main() {}\n").expect("file written");
        let summary = open_workspace_for_root(
            &state,
            &root.display().to_string(),
            CodeWorkspaceSource::Session,
            None,
            None,
        )
        .await
        .expect("workspace opened");
        assert!(summary.rust_root.is_none());

        // No manifest yet: navigation reports files-only.
        let before = handle_code_definition(
            &state,
            summary.workspace_id.clone(),
            "main.rs".to_string(),
            0,
            3,
            "r1".to_string(),
        )
        .await;
        assert!(matches!(
            before.as_slice(),
            [ServerMessage::CodeStatus {
                status: CodeStatus::FilesOnly,
                ..
            }]
        ));

        // A Cargo.toml appears mid-session; the cached workspace must not freeze
        // the gate — navigation now proceeds (async, returning no direct reply).
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
        )
        .expect("manifest written");
        let after = handle_code_definition(
            &state,
            summary.workspace_id,
            "main.rs".to_string(),
            0,
            3,
            "r2".to_string(),
        )
        .await;
        assert!(
            after.is_empty(),
            "navigation should proceed once a Cargo.toml exists, got {after:?}"
        );
        fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn definition_rejects_binary_file_with_request_scoped_error() {
        let mut state = crate::tests::test_state(8, None);
        state.rust_analyzer_bin = Arc::new("/nonexistent/rust-analyzer-xyz".to_string());
        let root = temp_workspace();
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
        )
        .expect("manifest written");
        fs::write(root.join("data.bin"), [0_u8, 1, 2, 3]).expect("binary written");
        let summary = open_workspace_for_root(
            &state,
            &root.display().to_string(),
            CodeWorkspaceSource::Session,
            None,
            None,
        )
        .await
        .expect("workspace opened");
        assert!(summary.rust_root.is_some());

        // A bad target file is a request error, not shared analyzer status, and
        // must not spawn the analyzer.
        let messages = handle_code_definition(
            &state,
            summary.workspace_id,
            "data.bin".to_string(),
            0,
            0,
            "r1".to_string(),
        )
        .await;
        assert_eq!(messages.len(), 1);
        match &messages[0] {
            ServerMessage::CodeError { path, message, .. } => {
                assert_eq!(path.as_deref(), Some("data.bin"));
                assert!(message.contains("binary"));
            }
            other => panic!("expected code.error, got {other:?}"),
        }
        assert!(state.code_workspaces.read().await.analyzers.is_empty());
        fs::remove_dir_all(root).ok();
    }

    #[cfg(unix)]
    fn python3_available() -> bool {
        [
            "/usr/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
        ]
        .iter()
        .any(|candidate| Path::new(candidate).exists())
    }

    #[cfg(unix)]
    fn write_mock_rust_analyzer(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = r#"#!/usr/bin/env python3
import sys, json, os

def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        line = line.strip()
        if line == b"":
            break
        if b":" in line:
            key, value = line.split(b":", 1)
            headers[key.strip().lower()] = value.strip()
    length = int(headers.get(b"content-length", b"0"))
    return json.loads(sys.stdin.buffer.read(length))

def send(message):
    data = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(data))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

cwd = os.getcwd()
while True:
    message = read_message()
    if message is None:
        break
    method = message.get("method")
    mid = message.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"capabilities": {}}})
    elif method == "textDocument/definition":
        send({"jsonrpc": "2.0", "id": mid, "result": [
            {"uri": "file://" + cwd + "/src/target.rs",
             "range": {"start": {"line": 1, "character": 2}, "end": {"line": 1, "character": 7}}}
        ]})
    elif method == "textDocument/references":
        send({"jsonrpc": "2.0", "id": mid, "result": [
            {"uri": "file://" + cwd + "/src/main.rs",
             "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 3}}},
            {"uri": "file://" + cwd + "/src/target.rs",
             "range": {"start": {"line": 1, "character": 2}, "end": {"line": 1, "character": 7}}}
        ]})
    elif method == "shutdown":
        send({"jsonrpc": "2.0", "id": mid, "result": None})
    elif method == "exit":
        break
"#;
        let path = dir.join("mock-rust-analyzer");
        fs::write(&path, script).expect("mock written");
        let mut perms = fs::metadata(&path).expect("mock metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).expect("mock made executable");
        path
    }

    #[cfg(unix)]
    async fn next_matching(
        rx: &mut tokio::sync::broadcast::Receiver<ServerMessage>,
        predicate: impl Fn(&ServerMessage) -> bool,
    ) -> ServerMessage {
        loop {
            let message = tokio::time::timeout(std::time::Duration::from_secs(20), rx.recv())
                .await
                .expect("analyzer did not respond in time")
                .expect("event channel closed");
            if predicate(&message) {
                return message;
            }
        }
    }

    #[cfg(unix)]
    async fn open_rust_workspace(state: &AppState, workspace: &Path) -> String {
        fs::write(
            workspace.join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("manifest written");
        fs::create_dir_all(workspace.join("src")).expect("src created");
        fs::write(workspace.join("src/main.rs"), "fn main() { target(); }\n")
            .expect("main written");
        fs::write(workspace.join("src/target.rs"), "pub fn target() {}\n").expect("target written");
        open_workspace_for_root(
            state,
            &workspace.display().to_string(),
            CodeWorkspaceSource::Session,
            None,
            None,
        )
        .await
        .expect("workspace opened")
        .workspace_id
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn definition_query_resolves_local_target_via_mock_analyzer() {
        if !python3_available() {
            return;
        }
        let workspace = temp_workspace();
        let mock_dir = temp_workspace();
        let mock = write_mock_rust_analyzer(&mock_dir);
        let mut state = crate::tests::test_state(64, None);
        state.rust_analyzer_bin = Arc::new(mock.display().to_string());
        let workspace_id = open_rust_workspace(&state, &workspace).await;

        let mut rx = state.events.subscribe();
        let immediate = handle_code_definition(
            &state,
            workspace_id,
            "src/main.rs".to_string(),
            0,
            12,
            "req-def".to_string(),
        )
        .await;
        assert!(immediate.is_empty(), "result is delivered asynchronously");

        let message = next_matching(&mut rx, |m| {
            matches!(m, ServerMessage::CodeDefinition { .. })
        })
        .await;
        match message {
            ServerMessage::CodeDefinition {
                locations,
                request_id,
                ..
            } => {
                assert_eq!(request_id, "req-def");
                assert_eq!(locations.len(), 1);
                assert_eq!(locations[0].kind, CodeLocationKind::Local);
                assert_eq!(locations[0].path.as_deref(), Some("src/target.rs"));
                assert_eq!(locations[0].range.start.line, 1);
                assert_eq!(locations[0].range.start.character, 2);
            }
            other => panic!("expected code.definition, got {other:?}"),
        }
        assert_eq!(state.code_workspaces.read().await.analyzers.len(), 1);
        fs::remove_dir_all(workspace).ok();
        fs::remove_dir_all(mock_dir).ok();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn references_query_returns_all_local_locations_via_mock_analyzer() {
        if !python3_available() {
            return;
        }
        let workspace = temp_workspace();
        let mock_dir = temp_workspace();
        let mock = write_mock_rust_analyzer(&mock_dir);
        let mut state = crate::tests::test_state(64, None);
        state.rust_analyzer_bin = Arc::new(mock.display().to_string());
        let workspace_id = open_rust_workspace(&state, &workspace).await;

        let mut rx = state.events.subscribe();
        handle_code_references(
            &state,
            workspace_id,
            "src/main.rs".to_string(),
            0,
            12,
            "req-refs".to_string(),
        )
        .await;

        let message = next_matching(&mut rx, |m| {
            matches!(m, ServerMessage::CodeReferences { .. })
        })
        .await;
        match message {
            ServerMessage::CodeReferences { locations, .. } => {
                assert_eq!(locations.len(), 2);
                assert!(
                    locations
                        .iter()
                        .all(|location| location.kind == CodeLocationKind::Local)
                );
                let paths: Vec<_> = locations
                    .iter()
                    .filter_map(|location| location.path.as_deref())
                    .collect();
                assert!(paths.contains(&"src/main.rs"));
                assert!(paths.contains(&"src/target.rs"));
            }
            other => panic!("expected code.references, got {other:?}"),
        }
        fs::remove_dir_all(workspace).ok();
        fs::remove_dir_all(mock_dir).ok();
    }
}
