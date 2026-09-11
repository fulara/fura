use std::{
    collections::HashSet,
    fs::File,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, anyhow, bail};
use git2::Repository;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;

use crate::{
    protocol::{
        NoticeLevel, ServerMessage, SessionRepoAction, SessionRepoCandidate, SessionRepoSource,
    },
    session::{SessionRecord, ToolCard},
    state::AppState,
};

struct DiscoveryInput {
    cwd: Option<PathBuf>,
    session_file: Option<String>,
    paths: Vec<(PathBuf, SessionRepoSource)>,
}

impl DiscoveryInput {
    fn from_session(session: &SessionRecord) -> Self {
        let cwd = session
            .cwd
            .as_deref()
            .and_then(|path| local_path(path, None));
        let mut paths = Vec::new();
        if let Some(worktree) = &session.worktree
            && let Some(path) = local_path(&worktree.path, cwd.as_deref())
        {
            paths.push((path, SessionRepoSource::Worktree));
        }
        if let Some(cwd) = &cwd {
            paths.push((cwd.clone(), SessionRepoSource::Cwd));
        }
        for card in session.tool_cards.iter().chain(&session.active_tool_calls) {
            paths.extend(
                tool_paths(card, cwd.as_deref())
                    .into_iter()
                    .map(|path| (path, SessionRepoSource::Tool)),
            );
        }
        Self {
            cwd,
            session_file: session.session_file.clone(),
            paths,
        }
    }
}

pub(crate) async fn session_repo_candidates(
    state: &AppState,
    session_id: &str,
) -> anyhow::Result<Vec<SessionRepoCandidate>> {
    let input = {
        let sessions = state.sessions.read().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("session not found: {session_id}"))?;
        DiscoveryInput::from_session(session)
    };
    let db_path = state.review_comment_db_path.clone();
    let session_id = session_id.to_owned();
    tokio::task::spawn_blocking(move || discover(&db_path, &session_id, input)).await?
}

pub(crate) async fn update_session_repo(
    state: &AppState,
    session_id: &str,
    action: SessionRepoAction,
    path: &str,
) -> Vec<ServerMessage> {
    let action_name = match action {
        SessionRepoAction::Add => "add",
        SessionRepoAction::Hide => "hide",
        SessionRepoAction::Default => "default",
    };
    let result = async {
        // Establish the current default before an add can introduce another candidate.
        session_repo_candidates(state, session_id).await?;
        let cwd = {
            let sessions = state.sessions.read().await;
            sessions
                .get(session_id)
                .and_then(|session| session.cwd.clone())
        };
        let cwd = cwd.as_deref().and_then(|path| local_path(path, None));
        let path = local_path(path, cwd.as_deref())
            .ok_or_else(|| anyhow!("expected a local filesystem path"))?;
        let db_path = state.review_comment_db_path.clone();
        let session_id = session_id.to_owned();
        tokio::task::spawn_blocking(move || update(&db_path, &session_id, action, &path)).await?
    }
    .await;
    let (level, text) = match result {
        Ok(root) => (
            NoticeLevel::Info,
            format!("Git repositories updated: {action_name} {root}"),
        ),
        Err(error) => (
            NoticeLevel::Error,
            format!("Git repository update failed: {error:#}"),
        ),
    };
    vec![ServerMessage::SessionNotice {
        session_id: session_id.to_owned(),
        level,
        text,
    }]
}

// Never resolve tool devices, remote URLs, or internal artifact aliases against the session cwd.
fn local_path(path: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    if path.is_empty() || path.contains("://") || path.contains('\0') || path.starts_with('~') {
        return None;
    }
    let path = Path::new(path);
    if path.is_absolute() {
        Some(path.to_owned())
    } else {
        cwd.filter(|cwd| cwd.is_absolute())
            .map(|cwd| cwd.join(path))
    }
}

fn tool_paths(card: &ToolCard, cwd: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if card.tool_name == "bash"
        && let Some(path) = card
            .args
            .get("cwd")
            .and_then(Value::as_str)
            .and_then(|path| local_path(path, cwd))
    {
        paths.push(path);
    }
    // An error result can still describe partial edits. It is evidence of association, not authorship.
    for result in card.partial_result.iter().chain(card.result.iter()) {
        let Some(details) = result.get("details") else {
            continue;
        };
        match card.tool_name.as_str() {
            "edit" => {
                edit_paths(details, cwd, &mut paths);
                if let Some(results) = details.get("perFileResults").and_then(Value::as_array) {
                    for result in results {
                        edit_paths(result, cwd, &mut paths);
                    }
                }
            }
            "write" => {
                if let Some(path) = details
                    .get("resolvedPath")
                    .and_then(Value::as_str)
                    .and_then(|path| local_path(path, cwd))
                {
                    paths.push(path);
                }
            }
            "eval" => {
                eval_paths(details.get("statusEvents"), &mut paths);
                if let Some(cells) = details.get("cells").and_then(Value::as_array) {
                    for cell in cells {
                        eval_paths(cell.get("statusEvents"), &mut paths);
                    }
                }
            }
            _ => {}
        }
    }
    paths
}

fn edit_paths(details: &Value, cwd: Option<&Path>, paths: &mut Vec<PathBuf>) {
    for key in ["path", "sourcePath"] {
        if let Some(path) = details
            .get(key)
            .and_then(Value::as_str)
            .and_then(|path| local_path(path, cwd))
        {
            paths.push(path);
        }
    }
}

fn eval_paths(events: Option<&Value>, paths: &mut Vec<PathBuf>) {
    let Some(events) = events.and_then(Value::as_array) else {
        return;
    };
    // A persistent kernel may have changed cwd invisibly. Relative paths need an explicit
    // event cwd or preceding absolute cd/pwd event, never a guess from session cwd/code.
    let mut cwd = None;
    for event in events {
        match event.get("op").and_then(Value::as_str) {
            Some("cd" | "pwd") => {
                cwd = event
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(|path| local_path(path, None));
                paths.extend(cwd.iter().cloned());
            }
            Some("read" | "write" | "writefile") => {
                let explicit_cwd = event
                    .get("cwd")
                    .and_then(Value::as_str)
                    .and_then(|path| local_path(path, None));
                if let Some(path) = event
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(|path| local_path(path, explicit_cwd.as_deref().or(cwd.as_deref())))
                {
                    paths.push(path);
                }
            }
            _ => {}
        }
    }
}

fn additional_directories(path: &str, cwd: Option<&Path>) -> Vec<PathBuf> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    // Preserve the legacy first-header boundary and byte/line limits.
    for line in BufReader::new(file.take(1024 * 1024))
        .lines()
        .take(16)
        .flatten()
    {
        let Ok(header) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if header.get("type").and_then(Value::as_str) != Some("session") {
            continue;
        }
        // These fields were validated by SessionHeader even though only directories
        // were consumed. Keep its required id and optional-string contract.
        if !header.get("id").is_some_and(Value::is_string)
            || ["timestamp", "cwd", "title"].iter().any(|field| {
                header
                    .get(field)
                    .is_some_and(|value| !value.is_null() && !value.is_string())
            })
        {
            return Vec::new();
        }
        return header
            .get("additionalDirectories")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|path| local_path(path, cwd))
            .collect();
    }
    Vec::new()
}

fn repo_root(path: &Path) -> anyhow::Result<PathBuf> {
    // Files, deleted paths and not-yet-created parents all resolve upwards from this exact path.
    let mut ancestor = path;
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| anyhow!("path has no existing ancestor: {}", path.display()))?;
    }
    let ancestor = ancestor.canonicalize()?;
    let directory = if ancestor.is_file() {
        ancestor.parent().unwrap_or(&ancestor)
    } else {
        &ancestor
    };
    let repo = Repository::discover(directory)
        .with_context(|| format!("not a Git working tree: {}", path.display()))?;
    repo.workdir()
        .ok_or_else(|| anyhow!("bare Git repositories are not supported"))?
        .canonicalize()
        .context("failed to resolve Git working tree")
}

fn connection(path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    // Own tables only: review_comments owns PRAGMA user_version and its migrations.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_repositories (
            session_id TEXT NOT NULL,
            repo_root TEXT NOT NULL,
            source TEXT NOT NULL,
            hidden INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(session_id, repo_root)
        );
        CREATE TABLE IF NOT EXISTS session_repository_defaults (
            session_id TEXT PRIMARY KEY,
            repo_root TEXT NOT NULL
        );",
    )?;
    Ok(conn)
}

fn discover(
    db_path: &Path,
    session_id: &str,
    mut input: DiscoveryInput,
) -> anyhow::Result<Vec<SessionRepoCandidate>> {
    if let Some(path) = &input.session_file {
        // Place workspace declarations before incidental tool evidence on the first discovery.
        let directories = additional_directories(path, input.cwd.as_deref());
        let index = input
            .paths
            .iter()
            .position(|(_, source)| *source == SessionRepoSource::Tool)
            .unwrap_or(input.paths.len());
        input.paths.splice(
            index..index,
            directories
                .into_iter()
                .map(|path| (path, SessionRepoSource::AdditionalDirectory)),
        );
    }
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for (path, source) in input.paths {
        if let Ok(root) = repo_root(&path)
            && seen.insert(root.clone())
        {
            roots.push((root, source));
        }
    }
    let mut conn = connection(db_path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Retain known associations after tool-card compaction/reload. Validate exact roots;
    // a deleted nested repo must not silently turn into its enclosing repository.
    let stored = {
        let mut statement = tx.prepare("SELECT repo_root, source, hidden FROM session_repositories WHERE session_id = ?1 ORDER BY rowid")?;
        statement
            .query_map([session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (root, source, hidden) in &stored {
        let root = PathBuf::from(root);
        if !hidden && !seen.contains(&root) && valid_root(&root) && seen.insert(root.clone()) {
            roots.push((root, serde_json::from_value(Value::String(source.clone()))?));
        }
    }
    // Git's registered, initialized submodules only. No recursive directory traversal.
    let mut index = 0;
    while index < roots.len() {
        if let Ok(repo) = Repository::open(&roots[index].0)
            && let Ok(submodules) = repo.submodules()
        {
            for submodule in submodules {
                if let Ok(child) = submodule.open()
                    && let Some(root) = child.workdir().and_then(|path| path.canonicalize().ok())
                    && seen.insert(root.clone())
                {
                    roots.push((root, SessionRepoSource::Submodule));
                }
            }
        }
        index += 1;
    }
    for (root, source) in &roots {
        let source = serde_json::to_value(source)?;
        tx.execute(
            "INSERT OR IGNORE INTO session_repositories (session_id, repo_root, source) VALUES (?1, ?2, ?3)",
            params![session_id, root.to_string_lossy(), source.as_str().unwrap()],
        )?;
    }
    let mut candidates = {
        let mut statement = tx.prepare("SELECT repo_root, source FROM session_repositories WHERE session_id = ?1 AND hidden = 0 ORDER BY rowid")?;
        let rows = statement.query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut candidates = Vec::new();
        for row in rows {
            let (root, source) = row?;
            if !seen.contains(Path::new(&root)) {
                continue;
            }
            candidates.push(SessionRepoCandidate {
                id: root.clone(),
                label: Path::new(&root)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                repo_root: root,
                source: serde_json::from_value(Value::String(source))?,
                is_default: false,
            });
        }
        candidates
    };
    let default: Option<String> = tx
        .query_row(
            "SELECT repo_root FROM session_repository_defaults WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?;
    let index = candidates
        .iter()
        .position(|candidate| Some(&candidate.repo_root) == default.as_ref())
        .unwrap_or(0);
    if let Some(candidate) = candidates.get_mut(index) {
        candidate.is_default = true;
        if default.as_deref() != Some(&candidate.repo_root) {
            tx.execute("INSERT INTO session_repository_defaults (session_id, repo_root) VALUES (?1, ?2) ON CONFLICT(session_id) DO UPDATE SET repo_root = excluded.repo_root", params![session_id, candidate.repo_root])?;
        }
    }
    tx.commit()?;
    Ok(candidates)
}

fn valid_root(root: &Path) -> bool {
    root.is_dir() && repo_root(root).is_ok_and(|actual| actual == root)
}

fn update(
    db_path: &Path,
    session_id: &str,
    action: SessionRepoAction,
    path: &Path,
) -> anyhow::Result<String> {
    let path = path
        .canonicalize()
        .with_context(|| format!("path does not exist: {}", path.display()))?;
    let root = repo_root(&path)?.to_string_lossy().into_owned();
    let mut conn = connection(db_path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match action {
        SessionRepoAction::Add => {
            tx.execute("INSERT INTO session_repositories (session_id, repo_root, source) VALUES (?1, ?2, 'manual') ON CONFLICT(session_id, repo_root) DO UPDATE SET hidden = 0, source = 'manual'", params![session_id, root])?;
        }
        SessionRepoAction::Hide => {
            if tx.execute("UPDATE session_repositories SET hidden = 1 WHERE session_id = ?1 AND repo_root = ?2", params![session_id, root])? == 0 {
                bail!("repository is not associated with this session");
            }
        }
        SessionRepoAction::Default => {
            let visible: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_repositories WHERE session_id = ?1 AND repo_root = ?2 AND hidden = 0)", params![session_id, root], |row| row.get(0))?;
            if !visible {
                bail!("default repository must be visible and associated with this session");
            }
            tx.execute("INSERT INTO session_repository_defaults (session_id, repo_root) VALUES (?1, ?2) ON CONFLICT(session_id) DO UPDATE SET repo_root = excluded.repo_root", params![session_id, root])?;
        }
    }
    tx.commit()?;
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, process::Command};
    use tempfile::TempDir;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args([
                "-c",
                "user.name=Fura Test",
                "-c",
                "user.email=fura@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn repo(path: &Path) -> PathBuf {
        fs::create_dir_all(path).unwrap();
        git(path, &["init", "-q"]);
        git(path, &["commit", "--allow-empty", "-qm", "initial"]);
        path.canonicalize().unwrap()
    }

    fn input(paths: &[(PathBuf, SessionRepoSource)]) -> DiscoveryInput {
        DiscoveryInput {
            cwd: None,
            session_file: None,
            paths: paths.to_vec(),
        }
    }

    fn roots(candidates: &[SessionRepoCandidate]) -> Vec<PathBuf> {
        candidates
            .iter()
            .map(|candidate| PathBuf::from(&candidate.repo_root))
            .collect()
    }

    fn card(name: &str, args: Value, details: Value) -> ToolCard {
        ToolCard::new(
            "tool".into(),
            None,
            name.into(),
            None,
            args,
            false,
            true,
            None,
            Some(json!({"details": details, "isError": true})),
            0,
        )
    }

    #[test]
    fn workspace_header_supports_extra_directories_and_legacy_sessions() {
        let temp = TempDir::new().unwrap();
        let cwd = repo(&temp.path().join("cwd"));
        let extra = repo(&temp.path().join("extra"));
        let ignored = repo(&temp.path().join("conversation-only"));
        let file = temp.path().join("session.jsonl");
        fs::write(&file, format!("{}\n{}\n{}\n",
            json!({"type":"title", "v":1, "title":"Named workspace"}),
            json!({"type":"session", "id":"workspace", "cwd":cwd, "additionalDirectories":[extra, "ssh://host/repo", 1]}),
            json!({"type":"message", "additionalDirectories":[ignored]})
        )).unwrap();
        let mut context = input(&[(cwd.clone(), SessionRepoSource::Cwd)]);
        context.cwd = Some(cwd.clone());
        context.session_file = Some(file.to_string_lossy().into_owned());
        let candidates = discover(&temp.path().join("db"), "header", context).unwrap();
        assert_eq!(roots(&candidates), vec![cwd.clone(), extra]);
        assert_eq!(candidates[1].source, SessionRepoSource::AdditionalDirectory);

        fs::write(
            &file,
            format!(
                "{}\n{}\n",
                json!({"type":"session", "id":"legacy", "cwd":cwd}),
                json!({"type":"message", "additionalDirectories":[ignored]})
            ),
        )
        .unwrap();
        let mut legacy = input(&[(cwd.clone(), SessionRepoSource::Cwd)]);
        legacy.session_file = Some(file.to_string_lossy().into_owned());
        assert_eq!(
            roots(&discover(&temp.path().join("db"), "legacy", legacy).unwrap()),
            vec![cwd]
        );
    }

    #[test]
    fn additional_directories_preserve_header_validation_and_first_header_boundary() {
        let temp = TempDir::new().unwrap();
        let file = temp.path().join("session.jsonl");
        let path = file.to_str().unwrap();
        let valid =
            json!({"type":"session","id":"s","additionalDirectories":["extra"],"futureField":true});
        fs::write(
            &file,
            format!(
                "not json\n{}\n{valid}\n",
                json!({"type":"title","title":"Prelude"})
            ),
        )
        .unwrap();
        assert_eq!(
            additional_directories(path, Some(temp.path())),
            vec![temp.path().join("extra")]
        );
        for field in ["timestamp", "cwd", "title"] {
            for value in [Value::Null, json!("valid string")] {
                let mut header = valid.clone();
                header[field] = value;
                fs::write(&file, header.to_string()).unwrap();
                assert_eq!(
                    additional_directories(path, Some(temp.path())),
                    vec![temp.path().join("extra")]
                );
            }
            let mut malformed = valid.clone();
            malformed[field] = json!(12);
            fs::write(&file, format!("{malformed}\n{valid}\n")).unwrap();
            assert!(
                additional_directories(path, Some(temp.path())).is_empty(),
                "{field} must retain string validation, not fall through to another header"
            );
        }
        for id in [Value::Null, json!(12)] {
            let mut malformed = valid.clone();
            malformed["id"] = id;
            fs::write(&file, format!("{malformed}\n{valid}\n")).unwrap();
            assert!(additional_directories(path, Some(temp.path())).is_empty());
        }
        fs::write(
            &file,
            format!(
                "{}\n{valid}",
                json!({"type":"session","additionalDirectories":["extra"]})
            ),
        )
        .unwrap();
        assert!(additional_directories(path, Some(temp.path())).is_empty());
    }

    #[test]
    fn exact_paths_find_nearest_external_nested_and_deleted_file_repositories() {
        let temp = TempDir::new().unwrap();
        let outer = repo(&temp.path().join("outer"));
        let nested = repo(&outer.join("nested"));
        let unmentioned = repo(&outer.join("unmentioned"));
        let external = repo(&temp.path().join("external"));
        fs::create_dir_all(outer.join("src/deep")).unwrap();
        fs::write(nested.join("file"), "nested").unwrap();
        let paths = [
            (outer.join("src/deep"), SessionRepoSource::Cwd),
            (nested.join("file"), SessionRepoSource::Tool),
            (external.join("deleted/child/file"), SessionRepoSource::Tool),
        ];
        let candidates = discover(&temp.path().join("db"), "paths", input(&paths)).unwrap();
        assert_eq!(roots(&candidates), vec![outer, nested, external]);
        assert!(!roots(&candidates).contains(&unmentioned));
    }

    #[test]
    fn structured_tool_paths_include_partial_edits_without_guessing_opaque_code() {
        let temp = TempDir::new().unwrap();
        let cwd = repo(&temp.path().join("cwd"));
        let source = repo(&temp.path().join("source"));
        let destination = repo(&temp.path().join("destination"));
        let opaque = repo(&temp.path().join("opaque"));
        let cards = [
            card(
                "edit",
                json!({}),
                json!({"perFileResults":[
                    {"path": destination.join("new/file"), "sourcePath": source.join("old/file")},
                    {"path":"ssh://host/repo/file"},
                    {"path":"xd://device"}
                ]}),
            ),
            card(
                "write",
                json!({"path":"local://alias"}),
                json!({"resolvedPath":destination.join("file")}),
            ),
            card(
                "bash",
                json!({"cwd":source.join("missing"), "command":format!("cd {} && touch file", opaque.display())}),
                json!({}),
            ),
            card(
                "bash",
                json!({"command":format!("git -C {} status", opaque.display())}),
                json!({"cwd":opaque}),
            ),
            card(
                "eval",
                json!({"code":format!("write('{}', 'text')", opaque.display())}),
                json!({"jsonOutputs":[{"path":opaque}]}),
            ),
            card(
                "task",
                json!({"task":format!("Edit {}", opaque.display())}),
                json!({"path":opaque}),
            ),
        ];
        let paths: Vec<_> = cards
            .iter()
            .flat_map(|card| tool_paths(card, Some(&cwd)))
            .map(|path| (path, SessionRepoSource::Tool))
            .collect();
        let candidates = discover(&temp.path().join("db"), "tools", input(&paths)).unwrap();
        assert_eq!(roots(&candidates), vec![destination, source]);
        assert!(!roots(&candidates).contains(&opaque));
        assert!(!roots(&candidates).contains(&cwd));
    }

    #[test]
    fn eval_relative_paths_require_explicit_working_directory_evidence() {
        let temp = TempDir::new().unwrap();
        let cwd = repo(&temp.path().join("cwd"));
        let observed = repo(&temp.path().join("observed"));
        let nested = repo(&observed.join("nested"));
        let unknown = repo(&cwd.join("unknown"));
        let tool = card(
            "eval",
            json!({}),
            json!({"statusEvents":[
                {"op":"write", "path":"unknown/file"},
                {"op":"run", "cmd":format!("cd {}", unknown.display())},
                {"op":"pwd", "path":observed},
                {"op":"writefile", "path":"nested/file"},
                {"op":"write", "path":"ssh://host/path"},
                {"op":"write", "cwd":unknown, "path":"file"}
            ]}),
        );
        let paths = tool_paths(&tool, Some(&cwd));
        assert_eq!(
            paths,
            vec![
                observed.clone(),
                observed.join("nested/file"),
                unknown.join("file")
            ]
        );
        let candidates = discover(
            &temp.path().join("db"),
            "eval",
            input(
                &paths
                    .into_iter()
                    .map(|path| (path, SessionRepoSource::Tool))
                    .collect::<Vec<_>>(),
            ),
        )
        .unwrap();
        assert_eq!(roots(&candidates), vec![observed, nested, unknown]);
    }

    #[test]
    fn linked_worktrees_and_initialized_submodules_keep_distinct_identity() {
        let temp = TempDir::new().unwrap();
        let root = repo(&temp.path().join("main"));
        let origin = repo(&temp.path().join("sub-origin"));
        let linked = temp.path().join("linked");
        git(
            &root,
            &["worktree", "add", "-qb", "linked", linked.to_str().unwrap()],
        );
        let linked = linked.canonicalize().unwrap();
        git(
            &root,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                origin.to_str().unwrap(),
                "sub",
            ],
        );
        let sub = root.join("sub").canonicalize().unwrap();
        let before = (
            fs::read(root.join(".git/index")).unwrap(),
            git(&root, &["show-ref"]),
            git(&root, &["count-objects", "-v"]),
        );
        let paths = [
            (linked.clone(), SessionRepoSource::Worktree),
            (root.clone(), SessionRepoSource::Cwd),
        ];
        let candidates = discover(&temp.path().join("db"), "worktrees", input(&paths)).unwrap();
        assert_eq!(roots(&candidates), vec![linked, root.clone(), sub.clone()]);
        assert_eq!(candidates[2].source, SessionRepoSource::Submodule);
        assert_eq!(
            before,
            (
                fs::read(root.join(".git/index")).unwrap(),
                git(&root, &["show-ref"]),
                git(&root, &["count-objects", "-v"])
            )
        );
        git(&root, &["submodule", "deinit", "-f", "--", "sub"]);
        let candidates = discover(
            &temp.path().join("db"),
            "uninitialized",
            input(&[(root.clone(), SessionRepoSource::Cwd)]),
        )
        .unwrap();
        assert_eq!(roots(&candidates), vec![root]);
    }

    #[test]
    fn corrections_and_tool_associations_survive_reload_without_default_switches() {
        let temp = TempDir::new().unwrap();
        let db = temp.path().join("db");
        let cwd = repo(&temp.path().join("cwd"));
        let tool = repo(&temp.path().join("tool"));
        let manual = repo(&temp.path().join("manual"));
        fs::write(manual.join("file"), "manual").unwrap();
        let seeds = [
            (cwd.clone(), SessionRepoSource::Cwd),
            (tool.clone(), SessionRepoSource::Tool),
        ];
        let initial = discover(&db, "session", input(&seeds)).unwrap();
        assert!(initial[0].is_default);
        update(&db, "session", SessionRepoAction::Add, &manual.join("file")).unwrap();
        let loaded = discover(&db, "session", input(&[])).unwrap();
        assert_eq!(
            roots(&loaded),
            vec![cwd.clone(), tool.clone(), manual.clone()]
        );
        assert!(loaded[0].is_default);
        assert_eq!(loaded[2].source, SessionRepoSource::Manual);

        update(&db, "session", SessionRepoAction::Default, &tool).unwrap();
        assert!(discover(&db, "session", input(&[])).unwrap()[1].is_default);
        update(&db, "session", SessionRepoAction::Hide, &tool).unwrap();
        assert!(update(&db, "session", SessionRepoAction::Default, &tool).is_err());
        let hidden = discover(&db, "session", input(&seeds)).unwrap();
        assert_eq!(roots(&hidden), vec![cwd.clone(), manual.clone()]);
        assert!(hidden[0].is_default);
        update(&db, "session", SessionRepoAction::Add, &tool).unwrap();
        let restored = discover(&db, "session", input(&seeds)).unwrap();
        assert!(restored[0].is_default);
        assert_eq!(roots(&restored), vec![cwd.clone(), tool, manual]);

        let newer_worktree = repo(&temp.path().join("new-worktree"));
        let loaded = discover(
            &db,
            "session",
            input(&[(newer_worktree.clone(), SessionRepoSource::Worktree)]),
        )
        .unwrap();
        assert_eq!(
            loaded
                .iter()
                .find(|candidate| candidate.is_default)
                .unwrap()
                .repo_root,
            cwd.to_str().unwrap()
        );
        assert!(roots(&loaded).contains(&newer_worktree));
        assert!(
            discover(&db, "unrelated-session", input(&[]))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn missing_nested_repository_is_not_replaced_with_its_parent() {
        let temp = TempDir::new().unwrap();
        let db = temp.path().join("db");
        let outer = repo(&temp.path().join("outer"));
        let nested = repo(&outer.join("nested"));
        discover(
            &db,
            "session",
            input(&[(nested.clone(), SessionRepoSource::Tool)]),
        )
        .unwrap();
        fs::remove_dir_all(nested.join(".git")).unwrap();
        assert!(discover(&db, "session", input(&[])).unwrap().is_empty());
        assert!(update(&db, "session", SessionRepoAction::Default, &outer).is_err());
    }

    #[test]
    fn repository_tables_do_not_claim_review_comment_migration_version() {
        let temp = TempDir::new().unwrap();
        let db = temp.path().join("db");
        crate::review_comments::initialize_database(&db).unwrap();
        let conn = Connection::open(&db).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        discover(&db, "session", input(&[])).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            version
        );
        crate::review_comments::initialize_database(&db).unwrap();
    }
}
