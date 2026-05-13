use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use rusqlite_migration::{M, Migrations};
use tracing::debug;
use uuid::Uuid;

use crate::{
    DiffLineKind, DiffLineLocation, DiffSide, ReviewComment, ReviewCommentAuthor,
    ReviewCommentFlushMarker, Timestamp,
};

const MAX_COMMENT_BODY_CHARS: usize = 8_000;

const MIGRATION_ARRAY: &[M] = &[
    M::up(
        r#"
    CREATE TABLE review_comments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      repo_root TEXT NOT NULL,
      comparison_key TEXT NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
      body TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT,
      old_path TEXT,
      new_path TEXT NOT NULL,
      hunk TEXT,
      side TEXT NOT NULL CHECK (side IN ('left', 'right')),
      line_kind TEXT NOT NULL CHECK (line_kind IN ('add', 'remove', 'context')),
      old_line INTEGER,
      new_line INTEGER,
      line_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX review_comments_session_idx ON review_comments(session_id);
    CREATE INDEX review_comments_comparison_idx ON review_comments(session_id, comparison_key);
    CREATE INDEX review_comments_file_idx ON review_comments(session_id, comparison_key, new_path);
    "#,
    ),
    M::up("ALTER TABLE review_comments ADD COLUMN flushed_at TEXT;"),
];
const MIGRATIONS: Migrations = Migrations::from_slice(MIGRATION_ARRAY);

#[derive(Debug, Clone)]
pub(crate) struct NewReviewComment {
    pub(crate) session_id: String,
    pub(crate) repo_root: String,
    pub(crate) comparison_key: String,
    pub(crate) author: ReviewCommentAuthor,
    pub(crate) body: String,
    pub(crate) anchor: DiffLineLocation,
    pub(crate) stale: bool,
    pub(crate) stale_reason: Option<String>,
}

pub(crate) fn database_path_from_config(config_path: Option<&Path>) -> PathBuf {
    if let Some(parent) = config_path.and_then(Path::parent) {
        parent.join("fura.db")
    } else {
        std::env::temp_dir().join(format!("fura-{}.db", Uuid::new_v4()))
    }
}

pub(crate) fn initialize_database(path: &Path) -> Result<(), String> {
    debug!(action = "review.comments.db.init", db_path = %path.display());
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!("failed to create review comment database directory: {error}")
        })?;
    }
    let mut conn = open_connection(path)?;
    apply_migrations(&mut conn)?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn validate_migrations() -> Result<(), String> {
    MIGRATIONS
        .validate()
        .map_err(|error| format!("invalid review comment migrations: {error}"))
}

pub(crate) fn create_comment(
    path: &Path,
    input: NewReviewComment,
) -> Result<ReviewComment, String> {
    validate_required("session id", &input.session_id)?;
    validate_required("repo root", &input.repo_root)?;
    validate_required("comparison key", &input.comparison_key)?;
    validate_anchor(&input.anchor)?;
    let body = validate_body(input.body)?;
    let stale_reason = input.stale_reason.map(validate_stale_reason).transpose()?;
    let id = Uuid::new_v4().to_string();
    let now = Timestamp::now().millis().to_string();
    let comment = ReviewComment {
        id,
        session_id: input.session_id,
        repo_root: input.repo_root,
        comparison_key: input.comparison_key,
        author: input.author,
        body,
        stale: input.stale,
        stale_reason,
        anchor: input.anchor,
        created_at: now.clone(),
        updated_at: now,
        flushed_at: None,
    };

    debug!(
        action = "review.comments.db.insert",
        db_path = %path.display(),
        session_id = %comment.session_id,
        comparison_key = %comment.comparison_key,
        comment_id = %comment.id,
        author = %comment.author.as_str(),
        new_path = %comment.anchor.new_path,
        side = %comment.anchor.side.as_str(),
        old_line = ?comment.anchor.old_line,
        new_line = ?comment.anchor.new_line
    );
    let conn = connection(path)?;
    conn.execute(
        r#"
        INSERT INTO review_comments (
            id, session_id, repo_root, comparison_key, author, body, stale, stale_reason,
            old_path, new_path, hunk, side, line_kind, old_line, new_line, line_text,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
        "#,
        params![
            comment.id,
            comment.session_id,
            comment.repo_root,
            comment.comparison_key,
            comment.author.as_str(),
            comment.body,
            if comment.stale { 1_i64 } else { 0_i64 },
            comment.stale_reason,
            comment.anchor.old_path,
            comment.anchor.new_path,
            comment.anchor.hunk,
            comment.anchor.side.as_str(),
            comment.anchor.kind.as_str(),
            comment.anchor.old_line,
            comment.anchor.new_line,
            comment.anchor.text,
            comment.created_at,
            comment.updated_at,
        ],
    )
    .map_err(|error| format!("failed to create review comment: {error}"))?;

    get_comment(path, &comment.id)?
        .ok_or_else(|| "created review comment could not be loaded".to_string())
}

pub(crate) fn list_comments(
    path: &Path,
    session_id: &str,
    comparison_key: Option<&str>,
) -> Result<Vec<ReviewComment>, String> {
    validate_required("session id", session_id)?;
    debug!(
        action = "review.comments.db.list",
        db_path = %path.display(),
        session_id = %session_id,
        comparison_key = ?comparison_key
    );
    let conn = connection(path)?;
    let sql = if comparison_key.is_some() {
        r#"
        SELECT id, session_id, repo_root, comparison_key, author, body, stale, stale_reason,
               old_path, new_path, hunk, side, line_kind, old_line, new_line, line_text,
               created_at, updated_at, flushed_at
        FROM review_comments
        WHERE session_id = ?1 AND comparison_key = ?2
        ORDER BY created_at ASC, id ASC
        "#
    } else {
        r#"
        SELECT id, session_id, repo_root, comparison_key, author, body, stale, stale_reason,
               old_path, new_path, hunk, side, line_kind, old_line, new_line, line_text,
               created_at, updated_at, flushed_at
        FROM review_comments
        WHERE session_id = ?1
        ORDER BY created_at ASC, id ASC
        "#
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|error| format!("failed to prepare review comment list: {error}"))?;
    let mapped = if let Some(comparison_key) = comparison_key {
        stmt.query_map(params![session_id, comparison_key], row_to_comment)
            .map_err(|error| format!("failed to list review comments: {error}"))?
    } else {
        stmt.query_map(params![session_id], row_to_comment)
            .map_err(|error| format!("failed to list review comments: {error}"))?
    };
    mapped
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to load review comments: {error}"))
}

pub(crate) fn update_comment(path: &Path, id: &str, body: String) -> Result<ReviewComment, String> {
    debug!(
        action = "review.comments.db.update",
        db_path = %path.display(),
        comment_id = %id
    );
    validate_required("comment id", id)?;
    let body = validate_body(body)?;
    let updated_at = Timestamp::now().millis().to_string();
    let conn = connection(path)?;
    let changed = conn
        .execute(
            "UPDATE review_comments SET body = ?1, updated_at = ?2, flushed_at = NULL WHERE id = ?3",
            params![body, updated_at, id],
        )
        .map_err(|error| format!("failed to update review comment: {error}"))?;
    if changed == 0 {
        return Err("review comment not found".to_string());
    }
    get_comment(path, id)?.ok_or_else(|| "updated review comment could not be loaded".to_string())
}

pub(crate) fn mark_comments_flushed(
    path: &Path,
    markers: &[ReviewCommentFlushMarker],
) -> Result<Vec<ReviewComment>, String> {
    if markers.is_empty() {
        return Ok(Vec::new());
    }
    let flushed_at = Timestamp::now().millis().to_string();
    let mut conn = connection(path)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("failed to start review comment flush transaction: {error}"))?;
    let mut comments = Vec::with_capacity(markers.len());
    for marker in markers {
        validate_required("comment id", &marker.id)?;
        validate_required("comment updatedAt", &marker.updated_at)?;
        let changed = tx
            .execute(
                "UPDATE review_comments SET flushed_at = ?1 WHERE id = ?2 AND updated_at = ?3",
                params![flushed_at, marker.id, marker.updated_at],
            )
            .map_err(|error| format!("failed to mark review comment flushed: {error}"))?;
        if changed == 0 {
            continue;
        }
        let comment = get_comment_with_connection(&tx, &marker.id)?
            .ok_or_else(|| format!("flushed review comment could not be loaded: {}", marker.id))?;
        comments.push(comment);
    }
    tx.commit()
        .map_err(|error| format!("failed to commit review comment flush: {error}"))?;
    Ok(comments)
}

pub(crate) fn delete_comment(path: &Path, id: &str) -> Result<(String, String), String> {
    debug!(
        action = "review.comments.db.delete",
        db_path = %path.display(),
        comment_id = %id
    );
    validate_required("comment id", id)?;
    let conn = connection(path)?;
    let session_and_comparison = conn
        .query_row(
            "SELECT session_id, comparison_key FROM review_comments WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("failed to load review comment before delete: {error}"))?
        .ok_or_else(|| "review comment not found".to_string())?;
    conn.execute("DELETE FROM review_comments WHERE id = ?1", params![id])
        .map_err(|error| format!("failed to delete review comment: {error}"))?;
    Ok(session_and_comparison)
}

fn get_comment(path: &Path, id: &str) -> Result<Option<ReviewComment>, String> {
    let conn = connection(path)?;
    get_comment_with_connection(&conn, id)
}

fn get_comment_with_connection(
    conn: &Connection,
    id: &str,
) -> Result<Option<ReviewComment>, String> {
    conn.query_row(
        r#"
        SELECT id, session_id, repo_root, comparison_key, author, body, stale, stale_reason,
               old_path, new_path, hunk, side, line_kind, old_line, new_line, line_text,
               created_at, updated_at, flushed_at
        FROM review_comments
        WHERE id = ?1
        "#,
        params![id],
        row_to_comment,
    )
    .optional()
    .map_err(|error| format!("failed to load review comment: {error}"))
}

fn connection(path: &Path) -> Result<Connection, String> {
    let mut conn = open_connection(path)?;
    apply_migrations(&mut conn)?;
    Ok(conn)
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path)
        .map_err(|error| format!("failed to open review comment database: {error}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("failed to enable review comment WAL: {error}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("failed to enable review comment foreign keys: {error}"))?;
    Ok(conn)
}

fn apply_migrations(conn: &mut Connection) -> Result<(), String> {
    MIGRATIONS
        .to_latest(conn)
        .map_err(|error| format!("failed to migrate review comment database: {error}"))
}

fn row_to_comment(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewComment> {
    let author =
        ReviewCommentAuthor::from_db(row.get::<_, String>(4)?.as_str()).map_err(|message| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                message.into(),
            )
        })?;
    let side = DiffSide::from_db(row.get::<_, String>(11)?.as_str()).map_err(|message| {
        rusqlite::Error::FromSqlConversionFailure(11, rusqlite::types::Type::Text, message.into())
    })?;
    let kind = DiffLineKind::from_db(row.get::<_, String>(12)?.as_str()).map_err(|message| {
        rusqlite::Error::FromSqlConversionFailure(12, rusqlite::types::Type::Text, message.into())
    })?;
    Ok(ReviewComment {
        id: row.get(0)?,
        session_id: row.get(1)?,
        repo_root: row.get(2)?,
        comparison_key: row.get(3)?,
        author,
        body: row.get(5)?,
        stale: row.get::<_, i64>(6)? != 0,
        stale_reason: row.get(7)?,
        anchor: DiffLineLocation {
            old_path: row.get(8)?,
            new_path: row.get(9)?,
            hunk: row.get(10)?,
            side,
            kind,
            old_line: row.get(13)?,
            new_line: row.get(14)?,
            text: row.get(15)?,
        },
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        flushed_at: row.get(18)?,
    })
}

fn validate_required(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("review comment {label} is required"))
    } else {
        Ok(())
    }
}

fn validate_body(value: String) -> Result<String, String> {
    let body = value.trim().to_string();
    if body.is_empty() {
        return Err("review comment body is required".to_string());
    }
    if body.chars().count() > MAX_COMMENT_BODY_CHARS {
        return Err(format!(
            "review comment body must be {MAX_COMMENT_BODY_CHARS} characters or fewer",
        ));
    }
    if body
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err("review comment body contains unsupported control characters".to_string());
    }
    Ok(body)
}

fn validate_stale_reason(value: String) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err("review comment stale reason cannot be empty".to_string());
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err("review comment stale reason must be a single line".to_string());
    }
    Ok(value)
}

fn validate_anchor(anchor: &DiffLineLocation) -> Result<(), String> {
    validate_required("new path", &anchor.new_path)?;
    validate_required("line text", &anchor.text)?;
    match anchor.side {
        DiffSide::Left if anchor.old_line.is_none() => {
            Err("left-side review comments require oldLine".to_string())
        }
        DiffSide::Right if anchor.new_line.is_none() => {
            Err("right-side review comments require newLine".to_string())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn db_path() -> PathBuf {
        tempdir().expect("tempdir").keep().join("fura.db")
    }

    fn anchor() -> DiffLineLocation {
        DiffLineLocation {
            old_path: Some("src/old.ts".to_string()),
            new_path: "src/new.ts".to_string(),
            hunk: Some("@@ -1,1 +1,1 @@".to_string()),
            side: DiffSide::Right,
            kind: DiffLineKind::Add,
            old_line: None,
            new_line: Some(7),
            text: "+const next = true;".to_string(),
        }
    }

    fn new_comment() -> NewReviewComment {
        NewReviewComment {
            session_id: "s1".to_string(),
            repo_root: "/repo".to_string(),
            comparison_key: "cmp".to_string(),
            author: ReviewCommentAuthor::User,
            body: "Looks risky".to_string(),
            anchor: anchor(),
            stale: false,
            stale_reason: None,
        }
    }

    #[test]
    fn migrations_validate_and_apply() {
        validate_migrations().expect("migrations validate");
        initialize_database(&db_path()).expect("db initializes");
    }

    #[test]
    fn create_and_list_comments() {
        let path = db_path();
        initialize_database(&path).expect("db initializes");
        let created = create_comment(&path, new_comment()).expect("comment created");

        let comments = list_comments(&path, "s1", Some("cmp")).expect("comments listed");
        assert_eq!(comments, vec![created]);
    }

    #[test]
    fn update_body_updates_timestamp() {
        let path = db_path();
        initialize_database(&path).expect("db initializes");
        let created = create_comment(&path, new_comment()).expect("comment created");

        let updated =
            update_comment(&path, &created.id, "Updated body".to_string()).expect("updated");

        assert_eq!(updated.body, "Updated body");
        assert!(updated.updated_at >= created.updated_at);
        assert_eq!(updated.anchor, created.anchor);
    }

    #[test]
    fn mark_flushed_persists_and_update_clears_marker() {
        let path = db_path();
        initialize_database(&path).expect("db initializes");
        let created = create_comment(&path, new_comment()).expect("comment created");
        assert!(created.flushed_at.is_none());

        let flushed = mark_comments_flushed(
            &path,
            &[ReviewCommentFlushMarker {
                id: created.id.clone(),
                updated_at: created.updated_at.clone(),
            }],
        )
        .expect("marked flushed");
        assert_eq!(flushed.len(), 1);
        assert!(flushed[0].flushed_at.is_some());
        let stale_marker = mark_comments_flushed(
            &path,
            &[ReviewCommentFlushMarker {
                id: created.id.clone(),
                updated_at: "older-version".to_string(),
            }],
        )
        .expect("stale marker ignored");
        assert!(stale_marker.is_empty());

        let updated =
            update_comment(&path, &created.id, "Edited body".to_string()).expect("updated");
        assert_eq!(updated.body, "Edited body");
        assert!(updated.flushed_at.is_none());
    }

    #[test]
    fn delete_removes_row() {
        let path = db_path();
        initialize_database(&path).expect("db initializes");
        let created = create_comment(&path, new_comment()).expect("comment created");

        let (session_id, comparison_key) = delete_comment(&path, &created.id).expect("deleted");

        assert_eq!(session_id, "s1");
        assert_eq!(comparison_key, "cmp");
        assert!(list_comments(&path, "s1", None).expect("listed").is_empty());
    }

    #[test]
    fn invalid_empty_body_rejected() {
        let path = db_path();
        initialize_database(&path).expect("db initializes");
        let mut input = new_comment();
        input.body = "   ".to_string();

        let error = create_comment(&path, input).expect_err("empty body rejected");
        assert!(error.contains("body is required"));
    }

    #[test]
    fn unsupported_control_character_rejected() {
        let path = db_path();
        initialize_database(&path).expect("db initializes");
        let mut input = new_comment();
        input.body = "bad\u{0007}".to_string();

        let error = create_comment(&path, input).expect_err("control rejected");
        assert!(error.contains("control"));
    }
}
