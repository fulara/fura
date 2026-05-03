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
use serde::Serialize;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::{AppState, ServerMessage};

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
    by_root: HashMap<PathBuf, String>,
}

#[derive(Debug, Clone)]
struct CodeWorkspace {
    workspace_id: String,
    root: PathBuf,
    rust_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeWorkspaceSummary {
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) root: String,
    pub(crate) rust_root: Option<String>,
    pub(crate) status: CodeStatus,
    pub(crate) status_message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CodeStatus {
    FilesOnly,
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
    let workspace = registry.workspace_for_root(root);
    Ok(workspace.summary(session_id))
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
    fn workspace_for_root(&mut self, root: PathBuf) -> CodeWorkspace {
        if let Some(workspace_id) = self.by_root.get(&root) {
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
        };
        self.by_root.insert(root, workspace_id.clone());
        self.by_id.insert(workspace_id, workspace.clone());
        workspace
    }
}

impl CodeWorkspace {
    fn summary(&self, session_id: &str) -> CodeWorkspaceSummary {
        let status_message = match self.rust_root {
            Some(_) => "Files only. Rust analysis starts in a later milestone.",
            None => "Files only. Cargo.toml was not found.",
        };
        CodeWorkspaceSummary {
            workspace_id: self.workspace_id.clone(),
            session_id: session_id.to_string(),
            root: self.root.display().to_string(),
            rust_root: self
                .rust_root
                .as_ref()
                .map(|path| path.display().to_string()),
            status: CodeStatus::FilesOnly,
            status_message: Some(status_message.to_string()),
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

    let mut entries = Vec::new();
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
        if !protocol_path.to_lowercase().contains(&normalized_query) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        entries.push(CodeTreeEntry {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| protocol_path.clone()),
            path: protocol_path,
            kind: CodeTreeEntryKind::File,
            size: Some(metadata.len()),
        });
        if entries.len() >= result_limit {
            break;
        }
    }

    entries.sort_by(|left, right| {
        left.path
            .to_lowercase()
            .cmp(&right.path.to_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
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

        assert_eq!(paths, vec!["src/bin/main.rs", "src/lib.rs"]);
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

        let entries = find_files(&root, "src", "rs", 1).expect("files searched");
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
}
