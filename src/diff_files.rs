use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{Context, bail};

use crate::{
    diff::parse_diff_rows,
    protocol::{DiffFileEntry, DiffRow, ServerMessage},
};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILE_LINES: usize = 20_000;
const MAX_ENTRIES: usize = 1_000;
const MAX_SCANNED_ENTRIES: usize = 10_000;
const MAX_RENDERED_BYTES: usize = 32 * 1024 * 1024;

pub(crate) async fn list(
    request_id: String,
    path: String,
    default_directory: String,
) -> ServerMessage {
    let result = tokio::task::spawn_blocking(move || {
        list_directory(if path.is_empty() {
            &default_directory
        } else {
            &path
        })
    })
    .await
    .context("Directory listing task failed")
    .and_then(|result| result);
    match result {
        Ok((path, parent_path, entries, truncated)) => ServerMessage::DiffFileListed {
            request_id,
            path,
            parent_path,
            entries,
            truncated,
        },
        Err(error) => ServerMessage::DiffFileError {
            request_id,
            message: format!("{error:#}"),
        },
    }
}

pub(crate) async fn open(request_id: String, path: String) -> ServerMessage {
    let result = tokio::task::spawn_blocking(move || open_file(&path))
        .await
        .context("Diff file read task failed")
        .and_then(|result| result);
    match result {
        Ok((path, rows)) => ServerMessage::DiffFileOpened {
            request_id,
            path,
            rows,
        },
        Err(error) => ServerMessage::DiffFileError {
            request_id,
            message: format!("{error:#}"),
        },
    }
}

fn canonical_path(path: &str) -> anyhow::Result<PathBuf> {
    if path.is_empty() {
        bail!("Enter a server filesystem path");
    }
    fs::canonicalize(path).with_context(|| format!("Cannot resolve server path {path:?}"))
}

fn path_string(path: &Path) -> anyhow::Result<String> {
    path.to_str()
        .map(str::to_owned)
        .context("Server path is not valid UTF-8")
}

fn list_directory(
    path: &str,
) -> anyhow::Result<(String, Option<String>, Vec<DiffFileEntry>, bool)> {
    let root = canonical_path(path)?;
    let directory =
        fs::read_dir(&root).with_context(|| format!("Cannot list {}", root.display()))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for (scanned, entry) in directory.enumerate() {
        if scanned == MAX_SCANNED_ENTRIES || entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        let entry = entry.with_context(|| format!("Cannot read an entry in {}", root.display()))?;
        let entry_path = entry.path();
        let metadata = match fs::metadata(&entry_path) {
            Ok(metadata) => metadata,
            // Broken symlinks and concurrently removed entries are not selectable.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Cannot inspect {}", entry_path.display()));
            }
        };
        let is_directory = metadata.is_dir();
        let is_patch = entry_path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("diff") || extension.eq_ignore_ascii_case("patch")
            });
        if !is_directory && !(metadata.is_file() && is_patch) {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("Directory contains a non-UTF-8 filename"))?;
        let path = fs::canonicalize(&entry_path)
            .with_context(|| format!("Cannot resolve {}", entry_path.display()))?;
        entries.push(DiffFileEntry {
            name,
            path: path_string(&path)?,
            is_directory,
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.cmp(&right.name))
    });
    let parent_path = root.parent().map(path_string).transpose()?;
    Ok((path_string(&root)?, parent_path, entries, truncated))
}

fn open_regular_file(path: &Path) -> anyhow::Result<File> {
    if !fs::metadata(path)
        .with_context(|| format!("Cannot inspect {}", path.display()))?
        .is_file()
    {
        bail!("{} is not a regular file", path.display());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    // Fura's Unix targets: O_NONBLOCK prevents a file-to-FIFO/device race from
    // hanging open(). Check the opened descriptor again before reading it.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        options.custom_flags(0o4000);
        #[cfg(any(
            target_vendor = "apple",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd",
            target_os = "dragonfly"
        ))]
        options.custom_flags(0x0004);
        #[cfg(not(any(
            target_os = "linux",
            target_os = "android",
            target_vendor = "apple",
            target_os = "freebsd",
            target_os = "openbsd",
            target_os = "netbsd",
            target_os = "dragonfly"
        )))]
        bail!("Safe nonblocking diff-file reads are unavailable on this Unix platform");
    }
    let file = options
        .open(path)
        .with_context(|| format!("Cannot open {}", path.display()))?;
    let metadata = file.metadata().context("Cannot inspect opened diff file")?;
    if !metadata.is_file() {
        bail!("{} is not a regular file", path.display());
    }
    if metadata.len() > MAX_FILE_BYTES {
        bail!("Diff file exceeds the 2 MiB size limit");
    }
    Ok(file)
}

fn open_file(path: &str) -> anyhow::Result<(String, Vec<DiffRow>)> {
    let path = canonical_path(path)?;
    let file = open_regular_file(&path)?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("Cannot read {}", path.display()))?;
    if bytes.len() > MAX_FILE_BYTES as usize {
        bail!("Diff file exceeds the 2 MiB size limit");
    }
    if bytes.contains(&0) {
        bail!("Binary files are not supported; choose a UTF-8 unified diff or Git patch");
    }
    let text = std::str::from_utf8(&bytes).context("Diff file is not valid UTF-8")?;
    check_render_bounds(text)?;
    let rows = parse_diff_rows(text);
    let has_file = rows.iter().any(|row| matches!(row, DiffRow::File { .. }));
    let has_diff = rows.iter().any(|row| match row {
        DiffRow::Hunk { .. } => true,
        DiffRow::Meta { text } => [
            "new file mode ",
            "deleted file mode ",
            "old mode ",
            "new mode ",
            "rename from ",
            "rename to ",
            "copy from ",
            "copy to ",
            "Binary files ",
            "GIT binary patch",
            "@@@ ",
        ]
        .iter()
        .any(|prefix| text.starts_with(prefix)),
        _ => false,
    });
    if !has_file || !has_diff {
        bail!(
            "File contains no supported unified diff or Git patch (it may be empty, malformed, or plain text)"
        );
    }
    Ok((path_string(&path)?, rows))
}

fn check_render_bounds(text: &str) -> anyhow::Result<()> {
    let mut lines = 0;
    let mut max_path = 0;
    let mut max_hunk = 0;
    for line in text.trim_start_matches('\u{feff}').lines() {
        lines += 1;
        if lines > MAX_FILE_LINES {
            bail!("Diff file exceeds the 20,000-line limit");
        }
        if [
            "diff --",
            "--- ",
            "+++ ",
            "rename from ",
            "rename to ",
            "copy from ",
            "copy to ",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix))
        {
            max_path = max_path.max(line.len());
        }
        if line.starts_with("@@ ") {
            max_hunk = max_hunk.max(line.len());
        }
    }
    // Rows repeat file paths and hunk headers. Bound this amplification before
    // allocating rows, including worst-case JSON escaping and per-row fields.
    let estimated_bytes = text
        .len()
        .saturating_mul(6)
        .saturating_add(lines.saturating_mul(512 + 6 * (3 * max_path + 2 * max_hunk)));
    if estimated_bytes > MAX_RENDERED_BYTES {
        bail!(
            "Diff metadata exceeds the 32 MiB rendered-size safety limit; split the patch into smaller files"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_files_require_text_diffs_and_complete_bounded_input() {
        let root = tempfile::tempdir().unwrap();
        let patch = root.path().join("anything.txt");
        fs::write(
            &patch,
            "--- before\t2026-01-01\n+++ after\t2026-01-02\n@@ -1 +1 @@\n-old\n+new\n",
        )
        .unwrap();
        let (path, rows) = open_file(patch.to_str().unwrap()).unwrap();
        assert_eq!(
            path,
            path_string(&fs::canonicalize(&patch).unwrap()).unwrap()
        );
        assert!(rows.iter().any(|row| matches!(row, DiffRow::Line { location, .. } if location.new_path == "after" && location.new_line == Some(1))));
        fs::write(&patch, b"not a patch\0").unwrap();
        assert!(open_file(patch.to_str().unwrap()).is_err());
        fs::write(&patch, b"ordinary text\n+not an added line\n").unwrap();
        assert!(open_file(patch.to_str().unwrap()).is_err());
        fs::write(&patch, vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert!(open_file(patch.to_str().unwrap()).is_err());
        assert!(open_file(root.path().to_str().unwrap()).is_err());
        assert!(check_render_bounds(&"\n".repeat(MAX_FILE_LINES + 1)).is_err());
        assert!(
            check_render_bounds(&format!(
                "\u{feff}diff --git a/{} b/x\n{}",
                "a".repeat(10_000),
                "+x\n".repeat(1_000)
            ))
            .is_err()
        );
    }

    #[test]
    fn listing_filters_files_follows_directories_and_reports_limits() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("folder")).unwrap();
        fs::write(root.path().join("change.PATCH"), "").unwrap();
        fs::write(root.path().join("ignored.txt"), "").unwrap();
        let (_, _, entries, truncated) = list_directory(root.path().to_str().unwrap()).unwrap();
        assert!(!truncated);
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["folder", "change.PATCH"]
        );
        for index in 0..MAX_ENTRIES {
            fs::write(root.path().join(format!("{index}.diff")), "").unwrap();
        }
        let (_, _, entries, truncated) = list_directory(root.path().to_str().unwrap()).unwrap();
        assert!(truncated);
        assert_eq!(entries.len(), MAX_ENTRIES);
    }

    #[cfg(unix)]
    #[test]
    fn special_files_are_rejected_without_reading() {
        assert!(open_regular_file(Path::new("/dev/zero")).is_err());
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("socket.patch");
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        assert!(open_regular_file(&socket).is_err());
    }
}
