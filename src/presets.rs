//! Fura-owned prompt presets: named prompt templates with optional `{param}`
//! placeholders, stored as `<name>.md` files under `~/.fura/presets/`.
//!
//! Presets are pure Fura artifacts. The bridge reads them to project a list to
//! clients; the frontend performs `{param}` substitution and sends the result as
//! a normal prompt. OMP is never involved in preset expansion.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use tracing::warn;

/// Maximum size of a single preset file we will read or write.
const MAX_PRESET_BYTES: usize = 64 * 1024;
/// Maximum number of presets loaded from the directory.
const MAX_PRESETS: usize = 200;
/// Monotonic counter ensuring unique temp filenames for concurrent atomic writes.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
/// Maximum length of a preset name (slug).
const MAX_NAME_LEN: usize = 64;
/// Length at which a fallback description (first body line) is truncated.
const DESCRIPTION_FALLBACK_LEN: usize = 80;

/// A preset projected to clients. `defaults` decorates parameters by name; the
/// authoritative parameter set is derived (frontend-side) from `{param}` tokens
/// in `body`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresetSummary {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) body: String,
    pub(crate) defaults: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct PresetFrontmatterRaw {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    defaults: Option<BTreeMap<String, serde_yaml::Value>>,
}

#[derive(Serialize)]
struct PresetFrontmatterOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    defaults: BTreeMap<String, String>,
}

/// Resolve the presets directory from the Fura config path
/// (`~/.fura/config.yaml` -> `~/.fura/presets`).
pub(crate) fn presets_dir(config_path: Option<&Path>) -> Option<PathBuf> {
    config_path?.parent().map(|parent| parent.join("presets"))
}

/// Load all `*.md` presets from `dir`, sorted by name. Missing directory or
/// unreadable/oversized/malformed files are skipped (never an error).
pub(crate) fn load_presets(dir: &Path) -> Vec<PresetSummary> {
    let mut presets = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                warn!(path = %dir.display(), %error, "failed to read presets directory");
            }
            return presets;
        }
    };

    for entry in entries.flatten() {
        if presets.len() >= MAX_PRESETS {
            warn!(
                max = MAX_PRESETS,
                "preset directory exceeds cap; ignoring extras"
            );
            break;
        }
        let path = entry.path();
        match entry.file_type() {
            Ok(file_type) if file_type.is_file() => {}
            _ => continue,
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if validate_preset_name(stem).is_err() {
            // Only manage slug-named presets; ignore hand-created files whose
            // name could not be edited or deleted through the validated API.
            continue;
        }
        match entry.metadata() {
            Ok(metadata) if metadata.len() > MAX_PRESET_BYTES as u64 => {
                warn!(path = %path.display(), "preset file too large; skipping");
                continue;
            }
            Ok(_) => {}
            Err(error) => {
                warn!(path = %path.display(), %error, "failed to stat preset file");
                continue;
            }
        }
        match fs::read_to_string(&path) {
            Ok(content) => presets.push(parse_preset(stem, &content)),
            Err(error) => warn!(path = %path.display(), %error, "failed to read preset file"),
        }
    }

    presets.sort_by(|a, b| a.name.cmp(&b.name));
    presets
}

/// Parse a preset file into a [`PresetSummary`]. `body` is the canonical source
/// for parameters; frontmatter only supplies an optional description/defaults.
fn parse_preset(name: &str, content: &str) -> PresetSummary {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let (frontmatter, body) = split_frontmatter(&normalized);
    let mut description = String::new();
    let mut defaults = BTreeMap::new();

    if let Some(frontmatter) = frontmatter {
        match serde_yaml::from_str::<PresetFrontmatterRaw>(&frontmatter) {
            Ok(parsed) => {
                if let Some(desc) = parsed.description {
                    description = desc.trim().to_string();
                }
                if let Some(map) = parsed.defaults {
                    for (key, value) in map {
                        if let Some(value) = yaml_value_to_string(&value) {
                            defaults.insert(key, value);
                        }
                    }
                }
            }
            Err(error) => warn!(preset = name, %error, "failed to parse preset frontmatter"),
        }
    }

    let body = body.trim_matches('\n').to_string();
    if description.is_empty() {
        description = first_nonempty_line(&body);
    }

    PresetSummary {
        name: name.to_string(),
        description,
        body,
        defaults,
    }
}

/// Serialize a preset back to its on-disk `.md` representation. Frontmatter is
/// emitted only when a description or defaults are present.
fn serialize_preset(description: &str, defaults: &BTreeMap<String, String>, body: &str) -> String {
    let body = body.trim_matches('\n');
    let description = description.trim();
    let has_frontmatter = !description.is_empty() || !defaults.is_empty();
    if !has_frontmatter {
        return format!("{body}\n");
    }

    let out = PresetFrontmatterOut {
        description: (!description.is_empty()).then(|| description.to_string()),
        defaults: defaults.clone(),
    };
    let frontmatter = serde_yaml::to_string(&out).unwrap_or_default();
    format!("---\n{frontmatter}---\n{body}\n")
}

/// Validate a preset name against `^[a-z0-9]+(?:[-_][a-z0-9]+)*$` (mirrors the
/// frontend `isValidPresetName`). This is also the containment guarantee: a
/// valid name has no path separators or dots.
pub(crate) fn validate_preset_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Preset name cannot be empty".to_string());
    }
    if name.len() > MAX_NAME_LEN {
        return Err(format!(
            "Preset name too long (max {MAX_NAME_LEN} characters)"
        ));
    }

    let is_alnum = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let mut prev_was_separator = true; // forces the first character to be alphanumeric
    for &byte in name.as_bytes() {
        if is_alnum(byte) {
            prev_was_separator = false;
        } else if byte == b'-' || byte == b'_' {
            if prev_was_separator {
                return Err(
                    "Preset name cannot start with or repeat '-'/'_' separators".to_string()
                );
            }
            prev_was_separator = true;
        } else {
            return Err(
                "Preset name may only contain lowercase letters, digits, '-' and '_'".to_string(),
            );
        }
    }
    if prev_was_separator {
        return Err("Preset name cannot end with a '-'/'_' separator".to_string());
    }
    Ok(())
}

fn preset_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    validate_preset_name(name)?;
    let path = dir.join(format!("{name}.md"));
    // Defensive containment check: a validated slug name keeps the file directly
    // inside `dir`, but assert it to guard against future name-rule drift.
    if path.parent() != Some(dir) {
        return Err("Preset path escapes the presets directory".to_string());
    }
    Ok(path)
}

/// Write a preset to `dir/<name>.md`. Creates the directory if needed, enforces
/// the size cap, and writes atomically (temp file + rename within `dir`).
pub(crate) fn save_preset(
    dir: &Path,
    name: &str,
    description: &str,
    body: &str,
    defaults: &BTreeMap<String, String>,
) -> Result<(), String> {
    let path = preset_path(dir, name)?;
    let content = serialize_preset(description, defaults, body);
    if content.len() > MAX_PRESET_BYTES {
        return Err(format!(
            "Preset too large (max {} KiB)",
            MAX_PRESET_BYTES / 1024
        ));
    }

    fs::create_dir_all(dir)
        .map_err(|error| format!("Failed to create presets directory: {error}"))?;

    let tmp_path = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&tmp_path, &content).map_err(|error| format!("Failed to write preset: {error}"))?;
    if let Err(error) = fs::rename(&tmp_path, &path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to save preset: {error}"));
    }
    Ok(())
}

/// Delete `dir/<name>.md`. Missing file is treated as success (idempotent).
pub(crate) fn delete_preset(dir: &Path, name: &str) -> Result<(), String> {
    let path = preset_path(dir, name)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to delete preset: {error}")),
    }
}

/// Split a `---`-delimited YAML frontmatter block from the body. Returns
/// `(Some(frontmatter), body)` only when the file opens with a `---` line and a
/// matching closing `---` line exists; otherwise `(None, whole_content)`.
fn split_frontmatter(content: &str) -> (Option<String>, String) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let lines: Vec<&str> = content.split('\n').collect();
    if lines.first().map(|line| line.trim_end()) != Some("---") {
        return (None, content.to_string());
    }
    for index in 1..lines.len() {
        if lines[index].trim_end() == "---" {
            let frontmatter = lines[1..index].join("\n");
            let body = lines[index + 1..].join("\n");
            return (Some(frontmatter), body);
        }
    }
    (None, content.to_string())
}

fn yaml_value_to_string(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::String(value) => Some(value.clone()),
        serde_yaml::Value::Bool(value) => Some(value.to_string()),
        serde_yaml::Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn first_nonempty_line(body: &str) -> String {
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > DESCRIPTION_FALLBACK_LEN {
            let truncated: String = trimmed.chars().take(DESCRIPTION_FALLBACK_LEN).collect();
            return format!("{truncated}...");
        }
        return trimmed.to_string();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn defaults(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn parses_frontmatter_description_and_defaults() {
        let content = "---\ndescription: Update a skill\ndefaults:\n  skill: develop-fura\n  count: 3\n---\nReview {skill} ({count}).";
        let preset = parse_preset("update-skill", content);
        assert_eq!(preset.name, "update-skill");
        assert_eq!(preset.description, "Update a skill");
        assert_eq!(preset.body, "Review {skill} ({count}).");
        assert_eq!(
            preset.defaults,
            defaults(&[("skill", "develop-fura"), ("count", "3")])
        );
    }

    #[test]
    fn falls_back_to_first_line_when_no_frontmatter() {
        let content = "Commit and rebase onto master.\nSecond line.";
        let preset = parse_preset("finish", content);
        assert_eq!(preset.description, "Commit and rebase onto master.");
        assert!(preset.defaults.is_empty());
        assert_eq!(preset.body, "Commit and rebase onto master.\nSecond line.");
    }

    #[test]
    fn round_trip_preserves_fields() {
        let body = "Review {skill}.\nDetails: {zakres}.";
        let defaults = defaults(&[("skill", "develop-fura"), ("zakres", "invariants")]);
        let serialized = serialize_preset("Update a skill", &defaults, body);
        let parsed = parse_preset("update-skill", &serialized);
        assert_eq!(parsed.description, "Update a skill");
        assert_eq!(parsed.defaults, defaults);
        assert_eq!(parsed.body, body);
    }

    #[test]
    fn round_trip_without_metadata_writes_plain_body() {
        let serialized = serialize_preset("", &BTreeMap::new(), "Just a prompt.");
        assert_eq!(serialized, "Just a prompt.\n");
        let parsed = parse_preset("plain", &serialized);
        assert_eq!(parsed.body, "Just a prompt.");
        assert_eq!(parsed.description, "Just a prompt.");
        assert!(parsed.defaults.is_empty());
    }

    #[test]
    fn validates_names() {
        assert!(validate_preset_name("finish").is_ok());
        assert!(validate_preset_name("update-skill").is_ok());
        assert!(validate_preset_name("a_b").is_ok());
        assert!(validate_preset_name("ship2").is_ok());
        assert!(validate_preset_name("").is_err());
        assert!(validate_preset_name(".").is_err());
        assert!(validate_preset_name("../evil").is_err());
        assert!(validate_preset_name("a/b").is_err());
        assert!(validate_preset_name("A B").is_err());
        assert!(validate_preset_name("Upper").is_err());
        assert!(validate_preset_name("-lead").is_err());
        assert!(validate_preset_name("trail-").is_err());
        assert!(validate_preset_name("a--b").is_err());
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets");
        save_preset(
            &path,
            "finish",
            "Wrap up",
            "Commit and rebase.",
            &BTreeMap::new(),
        )
        .unwrap();
        save_preset(
            &path,
            "update-skill",
            "",
            "Review {skill}.",
            &defaults(&[("skill", "develop-fura")]),
        )
        .unwrap();

        let presets = load_presets(&path);
        assert_eq!(presets.len(), 2);
        // sorted by name
        assert_eq!(presets[0].name, "finish");
        assert_eq!(presets[1].name, "update-skill");
        assert_eq!(presets[1].defaults, defaults(&[("skill", "develop-fura")]));
    }

    #[test]
    fn load_ignores_non_md_and_subdirs() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("note.txt"), "ignored").unwrap();
        fs::create_dir_all(path.join("sub")).unwrap();
        save_preset(&path, "keep", "", "body", &BTreeMap::new()).unwrap();

        let presets = load_presets(&path);
        assert_eq!(presets.len(), 1);
        assert_eq!(presets[0].name, "keep");
    }

    #[test]
    fn load_skips_non_slug_filenames() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets");
        fs::create_dir_all(&path).unwrap();
        // Hand-created files whose stem is not a valid slug must be ignored so the
        // UI never shows a preset it cannot edit or delete through the API.
        fs::write(path.join("Upper.md"), "body").unwrap();
        fs::write(path.join("a--b.md"), "body").unwrap();
        save_preset(&path, "keep", "", "body", &BTreeMap::new()).unwrap();

        let presets = load_presets(&path);
        assert_eq!(presets.len(), 1);
        assert_eq!(presets[0].name, "keep");
    }

    #[test]
    fn parse_normalizes_crlf_in_body() {
        let content = "---\r\ndescription: Win\r\n---\r\nLine one.\r\nLine two.\r\n";
        let preset = parse_preset("crlf", content);
        assert_eq!(preset.description, "Win");
        assert_eq!(preset.body, "Line one.\nLine two.");
        assert!(!preset.body.contains('\r'));
    }

    #[test]
    fn save_rejects_name_with_path() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets");
        let result = save_preset(&path, "../evil", "", "body", &BTreeMap::new());
        assert!(result.is_err());
        assert!(!path.join("..").join("evil.md").exists());
    }

    #[test]
    fn delete_is_idempotent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("presets");
        save_preset(&path, "finish", "", "body", &BTreeMap::new()).unwrap();
        assert!(path.join("finish.md").exists());
        delete_preset(&path, "finish").unwrap();
        assert!(!path.join("finish.md").exists());
        // second delete still succeeds
        delete_preset(&path, "finish").unwrap();
    }

    #[test]
    fn presets_dir_is_sibling_of_config() {
        let dir = presets_dir(Some(Path::new("/home/u/.fura/config.yaml")));
        assert_eq!(dir, Some(PathBuf::from("/home/u/.fura/presets")));
        assert_eq!(presets_dir(None), None);
    }
}
