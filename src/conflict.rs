use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

use anyhow::{Context, anyhow, bail};
use git2::{IndexConflict, IndexEntry, Oid, Repository};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ServerMessage;

const MAX_CONFLICT_BUFFER_BYTES: usize = 1_000_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictRepositorySummary {
    pub(crate) repo_id: String,
    pub(crate) root: String,
    pub(crate) operation: Option<ConflictOperation>,
    pub(crate) files: Vec<ConflictFileSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConflictOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictFileSummary {
    pub(crate) path: String,
    pub(crate) kind: ConflictFileKind,
    pub(crate) supported: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConflictFileKind {
    BothModified,
    AddAdd,
    DeleteModify,
    RenameModify,
    RenameDelete,
    BothDeleted,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictFileState {
    pub(crate) repo_id: String,
    pub(crate) path: String,
    pub(crate) kind: ConflictFileKind,
    pub(crate) base: Option<ConflictFileBuffer>,
    pub(crate) ours: Option<ConflictFileBuffer>,
    pub(crate) theirs: Option<ConflictFileBuffer>,
    pub(crate) result: Option<ConflictFileBuffer>,
    pub(crate) conflicts: Vec<ConflictRegion>,
    pub(crate) version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictFileBuffer {
    pub(crate) label: String,
    pub(crate) language: String,
    pub(crate) text: String,
    pub(crate) size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictRegion {
    pub(crate) id: String,
    pub(crate) start_line: usize,
    pub(crate) separator_line: Option<usize>,
    pub(crate) end_line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictMagicWandPreview {
    pub(crate) repo_id: String,
    pub(crate) path: String,
    pub(crate) source_version: String,
    pub(crate) content: String,
    pub(crate) resolved_conflict_count: usize,
    pub(crate) remaining_conflict_count: usize,
    pub(crate) summary: String,
    pub(crate) rules: Vec<ConflictMagicWandRuleApplication>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictMagicWandRuleApplication {
    pub(crate) conflict_id: String,
    pub(crate) rule: ConflictMagicWandRule,
    pub(crate) summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConflictMagicWandRule {
    IdenticalSides,
    ImportListUnion,
    LinewiseIndependentEdits,
    SameLineNonOverlappingEdits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConflictAgentMode {
    Explain,
    Propose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConflictAgentScope {
    SelectedConflict,
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConflictAgentRisk {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictAgentResult {
    pub(crate) repo_id: String,
    pub(crate) path: String,
    pub(crate) source_version: String,
    pub(crate) mode: ConflictAgentMode,
    pub(crate) scope: ConflictAgentScope,
    pub(crate) conflict_id: Option<String>,
    pub(crate) risk: ConflictAgentRisk,
    pub(crate) summary: String,
    pub(crate) explanation: String,
    pub(crate) content: Option<String>,
    pub(crate) remaining_conflict_count: Option<usize>,
}

#[derive(Debug, Clone)]
pub(crate) struct ActiveConflictContext {
    pub(crate) transport_session_id: String,
    pub(crate) session_id: String,
    pub(crate) repo_root: String,
    pub(crate) repo_id: String,
    pub(crate) path: String,
    pub(crate) source_version: String,
    pub(crate) mode: ConflictAgentMode,
    pub(crate) scope: ConflictAgentScope,
    pub(crate) conflict_id: Option<String>,
    pub(crate) original_content: String,
    pub(crate) original_conflict_count: usize,
    pub(crate) selected_conflict_byte_start: Option<usize>,
    pub(crate) selected_conflict_byte_end: Option<usize>,
    pub(crate) previous_host_tools: Vec<Value>,
    pub(crate) set_host_tools_command_id: String,
    pub(crate) prompt_command_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedConflictAgentRequest {
    pub(crate) repo_root: String,
    pub(crate) repo_id: String,
    pub(crate) path: String,
    pub(crate) source_version: String,
    pub(crate) mode: ConflictAgentMode,
    pub(crate) scope: ConflictAgentScope,
    pub(crate) conflict_id: Option<String>,
    pub(crate) original_content: String,
    pub(crate) original_conflict_count: usize,
    pub(crate) selected_conflict_byte_start: Option<usize>,
    pub(crate) selected_conflict_byte_end: Option<usize>,
    pub(crate) prompt: String,
}

pub(crate) async fn handle_conflict_scan(root: String) -> Vec<ServerMessage> {
    match scan_conflict_repository(&root) {
        Ok(repo) => vec![ServerMessage::ConflictSnapshot { repos: vec![repo] }],
        Err(message) => vec![ServerMessage::ConflictError {
            repo_id: None,
            path: None,
            message,
        }],
    }
}

pub(crate) async fn handle_conflict_file_open(repo_id: String, path: String) -> Vec<ServerMessage> {
    match open_conflict_file(&repo_id, &path) {
        Ok(file) => vec![ServerMessage::ConflictFile { file }],
        Err(message) => vec![ServerMessage::ConflictError {
            repo_id: Some(repo_id),
            path: Some(path),
            message,
        }],
    }
}

pub(crate) async fn handle_conflict_file_write_result(
    repo_id: String,
    path: String,
    content: String,
    expected_version: String,
) -> Vec<ServerMessage> {
    match write_conflict_result(&repo_id, &path, &content, &expected_version) {
        Ok(file) => vec![ServerMessage::ConflictFile { file }],
        Err(message) => vec![ServerMessage::ConflictError {
            repo_id: Some(repo_id),
            path: Some(path),
            message,
        }],
    }
}

pub(crate) async fn handle_conflict_file_preview_magic_wand(
    repo_id: String,
    path: String,
    expected_version: String,
) -> Vec<ServerMessage> {
    match preview_conflict_magic_wand(&repo_id, &path, &expected_version) {
        Ok(preview) => vec![ServerMessage::ConflictMagicWandPreview { preview }],
        Err(message) => vec![ServerMessage::ConflictError {
            repo_id: Some(repo_id),
            path: Some(path),
            message,
        }],
    }
}

pub(crate) async fn handle_conflict_file_stage_resolved(
    repo_id: String,
    path: String,
    expected_version: String,
) -> Vec<ServerMessage> {
    match stage_resolved_conflict_file(&repo_id, &path, &expected_version) {
        Ok(repo) => vec![
            ServerMessage::ConflictStatus {
                repo_id,
                path: Some(path),
                state: "staged".to_string(),
                message: "File marked resolved and staged.".to_string(),
            },
            ServerMessage::ConflictSnapshot { repos: vec![repo] },
        ],
        Err(message) => vec![ServerMessage::ConflictError {
            repo_id: Some(repo_id),
            path: Some(path),
            message,
        }],
    }
}

fn scan_conflict_repository(root: &str) -> Result<ConflictRepositorySummary, String> {
    let repo = open_repository(root).map_err(|err| err.to_string())?;
    let repo_root = repo_workdir(&repo).map_err(|err| err.to_string())?;
    let repo_id = repo_identifier(&repo_root);
    let operation = detect_conflict_operation(&repo);
    let files = collect_conflict_summaries(&repo).map_err(|err| err.to_string())?;
    Ok(ConflictRepositorySummary {
        repo_id,
        root: repo_root.display().to_string(),
        operation,
        files,
    })
}

fn open_conflict_file(repo_id: &str, requested_path: &str) -> Result<ConflictFileState, String> {
    let repo_root = canonical_repo_root(repo_id).map_err(|err| err.to_string())?;
    let normalized_path = normalize_protocol_path(requested_path).map_err(|err| err.to_string())?;
    let repo =
        open_repository(repo_root.to_string_lossy().as_ref()).map_err(|err| err.to_string())?;
    let conflict =
        find_conflict_for_path(&repo, &normalized_path).map_err(|err| err.to_string())?;
    let kind = conflict_kind(&conflict);
    let labels = conflict_buffer_labels(&repo);
    let base = conflict
        .ancestor
        .as_ref()
        .map(|entry| read_conflict_blob(&repo, entry, labels.base.as_str()))
        .transpose()
        .map_err(|err| err.to_string())?;
    let ours = conflict
        .our
        .as_ref()
        .map(|entry| read_conflict_blob(&repo, entry, labels.ours.as_str()))
        .transpose()
        .map_err(|err| err.to_string())?;
    let theirs = conflict
        .their
        .as_ref()
        .map(|entry| read_conflict_blob(&repo, entry, labels.theirs.as_str()))
        .transpose()
        .map_err(|err| err.to_string())?;
    let result = read_result_buffer(&repo_root, &normalized_path).map_err(|err| err.to_string())?;
    let conflicts = result
        .as_ref()
        .map(|buffer| parse_conflict_regions(&buffer.text))
        .unwrap_or_default();
    let version =
        result_version(&repo_root, &normalized_path).unwrap_or_else(|| "missing".to_string());
    Ok(ConflictFileState {
        repo_id: repo_identifier(&repo_root),
        path: normalized_path,
        kind,
        base,
        ours,
        theirs,
        result,
        conflicts,
        version,
    })
}

fn write_conflict_result(
    repo_id: &str,
    requested_path: &str,
    content: &str,
    expected_version: &str,
) -> Result<ConflictFileState, String> {
    let repo_root = canonical_repo_root(repo_id).map_err(|err| err.to_string())?;
    let normalized_path = normalize_protocol_path(requested_path).map_err(|err| err.to_string())?;
    let repo =
        open_repository(repo_root.to_string_lossy().as_ref()).map_err(|err| err.to_string())?;
    let kind = conflict_kind(
        &find_conflict_for_path(&repo, &normalized_path).map_err(|err| err.to_string())?,
    );
    ensure_supported_conflict_kind(kind).map_err(|err| err.to_string())?;
    verify_expected_version(&repo_root, &normalized_path, expected_version)
        .map_err(|err| err.to_string())?;
    if content.len() > MAX_CONFLICT_BUFFER_BYTES {
        return Err(format!(
            "conflict result is too large to write: {} bytes (limit {MAX_CONFLICT_BUFFER_BYTES})",
            content.len()
        ));
    }
    if content.as_bytes().contains(&0) {
        return Err("conflict result contains NUL bytes and cannot be written".to_string());
    }
    let target =
        resolve_write_target(&repo_root, &normalized_path).map_err(|err| err.to_string())?;
    fs::write(&target, content).map_err(|err| format!("failed to write conflict result: {err}"))?;
    open_conflict_file(repo_id, &normalized_path)
}

fn preview_conflict_magic_wand(
    repo_id: &str,
    requested_path: &str,
    expected_version: &str,
) -> Result<ConflictMagicWandPreview, String> {
    let repo_root = canonical_repo_root(repo_id).map_err(|err| err.to_string())?;
    let normalized_path = normalize_protocol_path(requested_path).map_err(|err| err.to_string())?;
    let repo =
        open_repository(repo_root.to_string_lossy().as_ref()).map_err(|err| err.to_string())?;
    let conflict =
        find_conflict_for_path(&repo, &normalized_path).map_err(|err| err.to_string())?;
    let kind = conflict_kind(&conflict);
    ensure_supported_conflict_kind(kind).map_err(|err| err.to_string())?;
    verify_expected_version(&repo_root, &normalized_path, expected_version)
        .map_err(|err| err.to_string())?;
    let result = read_result_buffer(&repo_root, &normalized_path)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "conflict result file is missing".to_string())?;
    let current_conflicts = parse_conflict_blocks(&result.text);
    if current_conflicts.is_empty() {
        return Err("conflict result no longer contains complete conflict markers".to_string());
    }
    let canonical = render_diff3_conflict_text(&repo, &conflict, &normalized_path)
        .map_err(|err| err.to_string())?;
    let canonical_conflicts = parse_conflict_blocks(&canonical);
    let preview = build_magic_wand_preview(
        repo_identifier(&repo_root),
        normalized_path,
        expected_version.to_string(),
        &result.text,
        &current_conflicts,
        &canonical_conflicts,
        matches!(kind, ConflictFileKind::AddAdd),
    )
    .map_err(|err| err.to_string())?;
    Ok(preview)
}
pub(crate) fn prepare_conflict_agent_request(
    context_id: &str,
    repo_id: &str,
    requested_path: &str,
    expected_version: &str,
    mode: ConflictAgentMode,
    scope: ConflictAgentScope,
    conflict_id: Option<&str>,
    instructions: &str,
) -> Result<PreparedConflictAgentRequest, String> {
    let repo_root = canonical_repo_root(repo_id).map_err(|err| err.to_string())?;
    let normalized_path = normalize_protocol_path(requested_path).map_err(|err| err.to_string())?;
    let repo =
        open_repository(repo_root.to_string_lossy().as_ref()).map_err(|err| err.to_string())?;
    let conflict =
        find_conflict_for_path(&repo, &normalized_path).map_err(|err| err.to_string())?;
    let kind = conflict_kind(&conflict);
    ensure_supported_conflict_kind(kind).map_err(|err| err.to_string())?;
    verify_expected_version(&repo_root, &normalized_path, expected_version)
        .map_err(|err| err.to_string())?;
    let file = open_conflict_file(repo_root.to_string_lossy().as_ref(), &normalized_path)?;
    let result = file
        .result
        .ok_or_else(|| "conflict result file is missing".to_string())?;
    let current_conflicts = parse_conflict_blocks(&result.text);
    if current_conflicts.is_empty() {
        return Err("conflict result no longer contains complete conflict markers".to_string());
    }
    let selected_conflict = match scope {
        ConflictAgentScope::SelectedConflict => Some(
            select_conflict_agent_conflict(&current_conflicts, conflict_id)
                .map_err(|err| err.to_string())?,
        ),
        ConflictAgentScope::File => None,
    };
    let prompt = build_conflict_agent_prompt(
        context_id,
        &repo,
        &conflict,
        &normalized_path,
        kind,
        expected_version,
        file.base.as_ref().map(|buffer| buffer.text.as_str()),
        file.ours.as_ref().map(|buffer| buffer.text.as_str()),
        file.theirs.as_ref().map(|buffer| buffer.text.as_str()),
        &result.text,
        &current_conflicts,
        selected_conflict,
        mode,
        scope,
        instructions,
    )
    .map_err(|err| err.to_string())?;
    Ok(PreparedConflictAgentRequest {
        repo_root: repo_root.display().to_string(),
        repo_id: repo_identifier(&repo_root),
        path: normalized_path,
        source_version: expected_version.to_string(),
        mode,
        scope,
        conflict_id: selected_conflict
            .as_ref()
            .map(|conflict| conflict.id.clone()),
        original_content: result.text,
        original_conflict_count: current_conflicts.len(),
        selected_conflict_byte_start: selected_conflict
            .as_ref()
            .map(|conflict| conflict.byte_start),
        selected_conflict_byte_end: selected_conflict.as_ref().map(|conflict| conflict.byte_end),
        prompt,
    })
}

pub(crate) fn finalize_conflict_agent_result(
    context: &ActiveConflictContext,
    risk: ConflictAgentRisk,
    summary: String,
    explanation: String,
    content: Option<String>,
) -> Result<ConflictAgentResult, String> {
    let summary = summary.trim().to_string();
    if summary.is_empty() {
        return Err("conflict-resolution assistance summary is required".to_string());
    }
    let explanation = explanation.trim().to_string();
    if explanation.is_empty() {
        return Err("conflict-resolution assistance explanation is required".to_string());
    }
    verify_expected_version(
        Path::new(&context.repo_root),
        &context.path,
        &context.source_version,
    )
    .map_err(|err| err.to_string())?;
    let (content, remaining_conflict_count) = match context.mode {
        ConflictAgentMode::Explain => {
            if content.is_some() {
                return Err(
                    "explain-only conflict-resolution assistance must not include proposedContent"
                        .to_string(),
                );
            }
            (None, None)
        }
        ConflictAgentMode::Propose => {
            let proposed = content.ok_or_else(|| {
                "conflict proposal must include proposedContent with the full proposed file text"
                    .to_string()
            })?;
            if proposed.len() > MAX_CONFLICT_BUFFER_BYTES {
                return Err(format!(
                    "conflict proposal is too large: {} bytes (limit {MAX_CONFLICT_BUFFER_BYTES})",
                    proposed.len()
                ));
            }
            if proposed.as_bytes().contains(&0) {
                return Err(
                    "conflict proposal contains NUL bytes and cannot be previewed".to_string(),
                );
            }
            if proposed == context.original_content {
                return Err(
                    "conflict proposal did not change the saved conflict result".to_string()
                );
            }
            if let (Some(start), Some(end)) = (
                context.selected_conflict_byte_start,
                context.selected_conflict_byte_end,
            ) {
                let prefix = &context.original_content[..start];
                let suffix = &context.original_content[end..];
                if !proposed.starts_with(prefix) || !proposed.ends_with(suffix) {
                    return Err(
                        "selected-conflict proposal must keep the saved file identical outside the targeted conflict block"
                            .to_string(),
                    );
                }
            }
            let remaining_conflict_count = parse_conflict_blocks(&proposed).len();
            if matches!(context.scope, ConflictAgentScope::SelectedConflict)
                && remaining_conflict_count >= context.original_conflict_count
            {
                return Err(
                    "selected-conflict proposal must resolve at least one conflict block"
                        .to_string(),
                );
            }
            (Some(proposed), Some(remaining_conflict_count))
        }
    };
    Ok(ConflictAgentResult {
        repo_id: context.repo_id.clone(),
        path: context.path.clone(),
        source_version: context.source_version.clone(),
        mode: context.mode,
        scope: context.scope,
        conflict_id: context.conflict_id.clone(),
        risk,
        summary,
        explanation,
        content,
        remaining_conflict_count,
    })
}

fn select_conflict_agent_conflict<'a>(
    current_conflicts: &'a [ParsedConflictBlock],
    conflict_id: Option<&str>,
) -> anyhow::Result<&'a ParsedConflictBlock> {
    if let Some(conflict_id) = conflict_id {
        return current_conflicts
            .iter()
            .find(|conflict| conflict.id == conflict_id)
            .ok_or_else(|| {
                anyhow!("selected conflict no longer exists in the saved conflict result")
            });
    }
    current_conflicts
        .first()
        .ok_or_else(|| anyhow!("conflict result no longer contains complete conflict markers"))
}

fn build_conflict_agent_prompt(
    context_id: &str,
    repo: &Repository,
    conflict: &IndexConflict,
    path: &str,
    kind: ConflictFileKind,
    source_version: &str,
    base_text: Option<&str>,
    ours_text: Option<&str>,
    theirs_text: Option<&str>,
    result_text: &str,
    current_conflicts: &[ParsedConflictBlock],
    selected_conflict: Option<&ParsedConflictBlock>,
    mode: ConflictAgentMode,
    scope: ConflictAgentScope,
    instructions: &str,
) -> anyhow::Result<String> {
    let operation = detect_conflict_operation(repo)
        .map(format_conflict_operation_label)
        .unwrap_or("Unknown".to_string());
    let instructions = default_conflict_agent_instructions(mode, scope, instructions);
    let mut prompt = format!(
        "You are helping Fura Conflict Resolver with a local Git conflict.\n\
Return your answer by calling fura_submit_conflict_assistance exactly once.\n\
Do not reply with prose in the transcript after the tool call.\n\n\
Conflict context id: {context_id}\n\
Mode: {}\n\
Scope: {}\n\
Repository root: {}\n\
Operation: {operation}\n\
Path: {path}\n\
Conflict kind: {}\n\
Conflict result version: {source_version}\n\
User instructions:\n{}\n\n\
Inspect the repository and nearby code if needed, but keep the resolution narrow and truthful.\n\
Classify risk as low, medium, or high.\n\
Summary should be one sentence. Explanation should call out assumptions and risk.\n",
        format_conflict_agent_mode(mode),
        format_conflict_agent_scope(scope),
        repo_workdir(repo)?.display(),
        format_conflict_kind_label(kind),
        instructions,
    );
    match scope {
        ConflictAgentScope::SelectedConflict => {
            let selected = selected_conflict.ok_or_else(|| {
                anyhow!("selected conflict context is required for conflict-scoped assistance")
            })?;
            let canonical_conflicts =
                parse_conflict_blocks(&render_diff3_conflict_text(repo, conflict, path)?);
            let canonical = canonical_conflict_for_selected_block(
                current_conflicts,
                selected,
                &canonical_conflicts,
            );
            let base = canonical
                .and_then(|conflict| conflict.base.as_deref())
                .or_else(|| matches!(kind, ConflictFileKind::AddAdd).then_some(""))
                .unwrap_or("");
            prompt.push_str(&format!(
                "\nSelected conflict: {} (lines {}-{})\n",
                selected.id, selected.start_line, selected.end_line,
            ));
            prompt.push_str(&render_text_section(
                "Saved conflict result excerpt around the selected conflict",
                &excerpt_lines(result_text, selected.start_line, selected.end_line, 4),
            ));
            prompt.push_str(&render_text_section(
                "Selected current-branch chunk",
                &selected.current,
            ));
            prompt.push_str(&render_text_section("Selected common-ancestor chunk", base));
            prompt.push_str(&render_text_section(
                "Selected incoming chunk",
                &selected.incoming,
            ));
            if matches!(mode, ConflictAgentMode::Propose) {
                prompt.push_str(&render_text_section(
                    "Saved conflict result file (full text)",
                    result_text,
                ));
                prompt.push_str(
                    "Tool-call contract:\n\
- proposedContent is required.\n\
- proposedContent must be the full file text.\n\
- Only the selected conflict block may change; every byte outside that block must remain identical to the saved conflict result above.\n\n",
                );
            } else {
                prompt.push_str(
                    "Tool-call contract:\n\
- proposedContent must be omitted because this is explain-only mode.\n\n",
                );
            }
        }
        ConflictAgentScope::File => {
            prompt.push_str(&render_text_section(
                "Current branch file (full text)",
                ours_text.unwrap_or(""),
            ));
            prompt.push_str(&render_text_section(
                "Common ancestor file (full text)",
                base_text.unwrap_or(""),
            ));
            prompt.push_str(&render_text_section(
                "Incoming change file (full text)",
                theirs_text.unwrap_or(""),
            ));
            prompt.push_str(&render_text_section(
                "Saved conflict result file (full text)",
                result_text,
            ));
            if matches!(mode, ConflictAgentMode::Propose) {
                prompt.push_str(
                    "Tool-call contract:\n\
- proposedContent is required.\n\
- proposedContent must be the full proposed file text.\n\n",
                );
            } else {
                prompt.push_str(
                    "Tool-call contract:\n\
- proposedContent must be omitted because this is explain-only mode.\n\n",
                );
            }
        }
    }
    prompt.push_str(
        "Use the host tool fields exactly:\n\
- conflictContextId: the conflict context id above\n\
- risk: low | medium | high\n\
- summary: one sentence\n\
- explanation: concise but concrete\n\
- proposedContent: only for propose mode\n",
    );
    Ok(prompt)
}

fn canonical_conflict_for_selected_block<'a>(
    current_conflicts: &[ParsedConflictBlock],
    selected_conflict: &ParsedConflictBlock,
    canonical_conflicts: &'a [ParsedConflictBlock],
) -> Option<&'a ParsedConflictBlock> {
    let mut next_canonical_index = 0usize;
    for current in current_conflicts {
        let matched = canonical_conflicts
            .iter()
            .enumerate()
            .skip(next_canonical_index)
            .find(|(_, candidate)| {
                candidate.current == current.current && candidate.incoming == current.incoming
            });
        if current.id == selected_conflict.id {
            return matched.map(|(_, conflict)| conflict);
        }
        if let Some((canonical_index, _)) = matched {
            next_canonical_index = canonical_index + 1;
        }
    }
    None
}

fn default_conflict_agent_instructions(
    mode: ConflictAgentMode,
    scope: ConflictAgentScope,
    instructions: &str,
) -> String {
    let trimmed = instructions.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    match (mode, scope) {
        (ConflictAgentMode::Explain, ConflictAgentScope::SelectedConflict) => {
            "Explain the selected merge conflict, the likely intent on each side, the main ambiguity, and the safest resolution direction."
                .to_string()
        }
        (ConflictAgentMode::Explain, ConflictAgentScope::File) => {
            "Explain the conflicted file, highlight the highest-risk ambiguities, and call out the safest resolution direction."
                .to_string()
        }
        (ConflictAgentMode::Propose, ConflictAgentScope::SelectedConflict) => {
            "Propose a safe resolution for the selected merge conflict. Preserve behavior outside the selected conflict and call out any assumptions."
                .to_string()
        }
        (ConflictAgentMode::Propose, ConflictAgentScope::File) => {
            "Propose a safe resolution for the conflicted file. Prefer the smallest defensible change and call out any assumptions."
                .to_string()
        }
    }
}

fn render_text_section(title: &str, text: &str) -> String {
    let body = if text.is_empty() { "(empty)" } else { text };
    format!("{title}:\n```text\n{body}\n```\n\n")
}

fn excerpt_lines(text: &str, start_line: usize, end_line: usize, radius: usize) -> String {
    let lines = text.split('\n').collect::<Vec<_>>();
    if lines.is_empty() {
        return String::new();
    }
    let start = start_line.saturating_sub(radius + 1);
    let end = usize::min(lines.len(), end_line.saturating_add(radius));
    lines[start..end].join("\n")
}

fn format_conflict_agent_mode(mode: ConflictAgentMode) -> &'static str {
    match mode {
        ConflictAgentMode::Explain => "explain",
        ConflictAgentMode::Propose => "propose",
    }
}

fn format_conflict_agent_scope(scope: ConflictAgentScope) -> &'static str {
    match scope {
        ConflictAgentScope::SelectedConflict => "selectedConflict",
        ConflictAgentScope::File => "file",
    }
}

fn format_conflict_operation_label(operation: ConflictOperation) -> String {
    match operation {
        ConflictOperation::Merge => "Merge".to_string(),
        ConflictOperation::Rebase => "Rebase".to_string(),
        ConflictOperation::CherryPick => "Cherry-pick".to_string(),
        ConflictOperation::Revert => "Revert".to_string(),
    }
}

fn format_conflict_kind_label(kind: ConflictFileKind) -> &'static str {
    match kind {
        ConflictFileKind::BothModified => "bothModified",
        ConflictFileKind::AddAdd => "addAdd",
        ConflictFileKind::DeleteModify => "deleteModify",
        ConflictFileKind::RenameModify => "renameModify",
        ConflictFileKind::RenameDelete => "renameDelete",
        ConflictFileKind::BothDeleted => "bothDeleted",
        ConflictFileKind::Unknown => "unknown",
    }
}
fn stage_resolved_conflict_file(
    repo_id: &str,
    requested_path: &str,
    expected_version: &str,
) -> Result<ConflictRepositorySummary, String> {
    let repo_root = canonical_repo_root(repo_id).map_err(|err| err.to_string())?;
    let normalized_path = normalize_protocol_path(requested_path).map_err(|err| err.to_string())?;
    let repo =
        open_repository(repo_root.to_string_lossy().as_ref()).map_err(|err| err.to_string())?;
    let kind = conflict_kind(
        &find_conflict_for_path(&repo, &normalized_path).map_err(|err| err.to_string())?,
    );
    ensure_supported_conflict_kind(kind).map_err(|err| err.to_string())?;
    verify_expected_version(&repo_root, &normalized_path, expected_version)
        .map_err(|err| err.to_string())?;
    let result = read_result_buffer(&repo_root, &normalized_path)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "conflict result file is missing".to_string())?;
    if contains_conflict_marker_lines(&result.text) {
        return Err("conflict result still contains conflict markers".to_string());
    }
    let mut index = repo
        .index()
        .map_err(|err| format!("failed to read Git index: {err}"))?;
    index
        .add_path(Path::new(&normalized_path))
        .map_err(|err| format!("failed to stage resolved file: {err}"))?;
    index
        .write()
        .map_err(|err| format!("failed to write Git index: {err}"))?;
    scan_conflict_repository(repo_id)
}

fn open_repository(root: &str) -> anyhow::Result<Repository> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        bail!("repository root is empty");
    }
    let path = PathBuf::from(trimmed)
        .canonicalize()
        .with_context(|| format!("failed to resolve repository root: {trimmed}"))?;
    Repository::discover(path).context("failed to discover Git repository")
}

fn canonical_repo_root(root: &str) -> anyhow::Result<PathBuf> {
    let repo = open_repository(root)?;
    repo_workdir(&repo)
}

fn repo_workdir(repo: &Repository) -> anyhow::Result<PathBuf> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| anyhow!("bare repositories are not supported"))?;
    workdir.canonicalize().with_context(|| {
        format!(
            "failed to resolve repository workdir: {}",
            workdir.display()
        )
    })
}

fn repo_identifier(root: &Path) -> String {
    root.display().to_string()
}

fn detect_conflict_operation(repo: &Repository) -> Option<ConflictOperation> {
    let git_dir = repo.path();
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return Some(ConflictOperation::Rebase);
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some(ConflictOperation::CherryPick);
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Some(ConflictOperation::Revert);
    }
    if git_dir.join("MERGE_HEAD").exists() {
        return Some(ConflictOperation::Merge);
    }
    None
}

struct ConflictBufferLabels {
    base: String,
    ours: String,
    theirs: String,
}

fn conflict_buffer_labels(repo: &Repository) -> ConflictBufferLabels {
    let current = current_branch_label(repo).unwrap_or_else(|| "current branch".to_string());
    let incoming = incoming_change_label(repo).unwrap_or_else(|| "incoming change".to_string());
    ConflictBufferLabels {
        base: "Common ancestor".to_string(),
        ours: format!("Current branch ({current})"),
        theirs: format!("Incoming change ({incoming})"),
    }
}

fn current_branch_label(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        return head.shorthand().map(|name| name.to_string());
    }
    head.target()
        .map(|oid| oid.to_string().chars().take(12).collect::<String>())
        .map(|short| format!("detached {short}"))
}

fn incoming_change_label(repo: &Repository) -> Option<String> {
    conflict_msg_label(repo)
        .or_else(|| pseudo_ref_label(repo, "CHERRY_PICK_HEAD", "cherry-pick"))
        .or_else(|| pseudo_ref_label(repo, "REVERT_HEAD", "revert"))
        .or_else(|| pseudo_ref_label(repo, "MERGE_HEAD", "merge"))
}

fn conflict_msg_label(repo: &Repository) -> Option<String> {
    let text = fs::read_to_string(repo.path().join("MERGE_MSG")).ok()?;
    let first = text.lines().next()?.trim();
    if first.is_empty() {
        return None;
    }
    Some(first.trim_start_matches("Merge ").to_string())
}

fn pseudo_ref_label(repo: &Repository, name: &str, prefix: &str) -> Option<String> {
    let text = fs::read_to_string(repo.path().join(name)).ok()?;
    let oid = text.split_whitespace().next()?;
    Some(format!(
        "{prefix} {}",
        oid.chars().take(12).collect::<String>()
    ))
}

fn collect_conflict_summaries(repo: &Repository) -> anyhow::Result<Vec<ConflictFileSummary>> {
    let index = repo.index().context("failed to read Git index")?;
    let conflicts = index
        .conflicts()
        .context("failed to read Git index conflicts")?;
    let mut files = Vec::new();
    for conflict in conflicts {
        let conflict = conflict.context("failed to read Git conflict entry")?;
        let path = conflict_path(&conflict)?;
        let kind = conflict_kind(&conflict);
        let supported = matches!(
            kind,
            ConflictFileKind::BothModified | ConflictFileKind::AddAdd
        );
        files.push(ConflictFileSummary {
            path,
            kind,
            supported,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn find_conflict_for_path(repo: &Repository, path: &str) -> anyhow::Result<IndexConflict> {
    let index = repo.index().context("failed to read Git index")?;
    let conflicts = index
        .conflicts()
        .context("failed to read Git index conflicts")?;
    for conflict in conflicts {
        let conflict = conflict.context("failed to read Git conflict entry")?;
        if conflict_path(&conflict)? == path {
            return Ok(conflict);
        }
    }
    bail!("path is not currently conflicted: {path}")
}

fn conflict_path(conflict: &IndexConflict) -> anyhow::Result<String> {
    conflict
        .our
        .as_ref()
        .or(conflict.their.as_ref())
        .or(conflict.ancestor.as_ref())
        .map(|entry| entry_path(entry))
        .transpose()?
        .ok_or_else(|| anyhow!("conflict entry has no path"))
}

fn entry_path(entry: &IndexEntry) -> anyhow::Result<String> {
    let raw = String::from_utf8(entry.path.clone()).context("conflict path is not valid UTF-8")?;
    normalize_protocol_path(&raw)
}

fn conflict_kind(conflict: &IndexConflict) -> ConflictFileKind {
    match (
        conflict.ancestor.is_some(),
        conflict.our.is_some(),
        conflict.their.is_some(),
    ) {
        (true, true, true) => ConflictFileKind::BothModified,
        (false, true, true) => ConflictFileKind::AddAdd,
        (true, false, true) | (true, true, false) => ConflictFileKind::DeleteModify,
        (true, false, false) => ConflictFileKind::BothDeleted,
        _ => ConflictFileKind::Unknown,
    }
}

fn read_conflict_blob(
    repo: &Repository,
    entry: &IndexEntry,
    label: &str,
) -> anyhow::Result<ConflictFileBuffer> {
    let path = entry_path(entry)?;
    let blob = repo
        .find_blob(entry.id)
        .with_context(|| format!("failed to read {label} blob for {path}"))?;
    let content = blob.content();
    if content.len() > MAX_CONFLICT_BUFFER_BYTES {
        bail!(
            "{label} buffer is too large to display: {} bytes",
            content.len()
        );
    }
    if content.contains(&0) {
        bail!("{label} buffer is binary and cannot be displayed");
    }
    let text = String::from_utf8(content.to_vec())
        .with_context(|| format!("{label} buffer is not valid UTF-8"))?;
    Ok(ConflictFileBuffer {
        label: label.to_string(),
        language: language_for_path(&path),
        size: content.len() as u64,
        text,
    })
}

fn read_result_buffer(root: &Path, path: &str) -> anyhow::Result<Option<ConflictFileBuffer>> {
    let file_path = resolve_existing_file(root, path)?;
    let Some(file_path) = file_path else {
        return Ok(None);
    };
    let metadata = file_path.metadata()?;
    if metadata.len() > MAX_CONFLICT_BUFFER_BYTES as u64 {
        bail!(
            "result buffer is too large to display: {} bytes (limit {MAX_CONFLICT_BUFFER_BYTES})",
            metadata.len()
        );
    }
    let bytes = fs::read(&file_path)?;
    if bytes.contains(&0) {
        bail!("result buffer is binary and cannot be displayed");
    }
    let text = String::from_utf8(bytes).map_err(|_| anyhow!("result buffer is not valid UTF-8"))?;
    Ok(Some(ConflictFileBuffer {
        label: "Result".to_string(),
        language: language_for_path(path),
        size: metadata.len(),
        text,
    }))
}

fn result_version(root: &Path, path: &str) -> Option<String> {
    let file_path = resolve_existing_file(root, path).ok()??;
    let bytes = fs::read(file_path).ok()?;
    Some(format!("{}:{}", bytes.len(), blake3::hash(&bytes).to_hex()))
}

fn verify_expected_version(root: &Path, path: &str, expected_version: &str) -> anyhow::Result<()> {
    let current = result_version(root, path).unwrap_or_else(|| "missing".to_string());
    if current != expected_version {
        bail!(
            "conflict result changed on disk; refresh before applying edits (expected {expected_version}, current {current})"
        );
    }
    Ok(())
}

fn ensure_supported_conflict_kind(kind: ConflictFileKind) -> anyhow::Result<()> {
    if matches!(
        kind,
        ConflictFileKind::BothModified | ConflictFileKind::AddAdd
    ) {
        return Ok(());
    }
    bail!("manual resolution is not yet supported for this conflict type")
}

fn resolve_write_target(root: &Path, requested_path: &str) -> anyhow::Result<PathBuf> {
    let relative = normalize_relative_path(requested_path)?;
    let joined = root.join(&relative);
    if joined.exists() {
        let resolved = joined
            .canonicalize()
            .with_context(|| format!("failed to resolve conflict result path: {requested_path}"))?;
        if !resolved.starts_with(root) {
            bail!("path escapes the repository root");
        }
        if !resolved.is_file() {
            bail!("path is not a file: {requested_path}");
        }
        return Ok(resolved);
    }

    let parent = joined
        .parent()
        .ok_or_else(|| anyhow!("conflict result path has no parent"))?;
    let resolved_parent = parent.canonicalize().with_context(|| {
        format!(
            "failed to resolve conflict result parent directory: {}",
            parent.display()
        )
    })?;
    if !resolved_parent.starts_with(root) {
        bail!("path escapes the repository root");
    }
    Ok(joined)
}

fn contains_conflict_marker_lines(text: &str) -> bool {
    text.lines().any(|line| {
        line.starts_with("<<<<<<<")
            || line.starts_with("|||||||")
            || line.starts_with("=======")
            || line.starts_with(">>>>>>>")
    })
}

fn resolve_existing_file(root: &Path, requested_path: &str) -> anyhow::Result<Option<PathBuf>> {
    let relative = normalize_relative_path(requested_path)?;
    let joined = root.join(relative);
    if !joined.exists() {
        return Ok(None);
    }
    let resolved = joined
        .canonicalize()
        .with_context(|| format!("path does not exist: {requested_path}"))?;
    if !resolved.starts_with(root) {
        bail!("path escapes the repository root");
    }
    if !resolved.is_file() {
        bail!("path is not a file: {requested_path}");
    }
    Ok(Some(resolved))
}

#[derive(Debug, Clone)]
struct ParsedConflictBlock {
    id: String,
    start_line: usize,
    separator_line: Option<usize>,
    end_line: usize,
    byte_start: usize,
    byte_end: usize,
    current: String,
    base: Option<String>,
    incoming: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParsedConflictSection {
    Current,
    Base,
    Incoming,
}

#[derive(Debug, Clone)]
struct ResolvedMagicWandBlock {
    rule: ConflictMagicWandRule,
    summary: String,
    content: String,
}

#[derive(Debug, Clone)]
struct CharEdit {
    start: usize,
    end: usize,
    replacement: String,
}

fn render_diff3_conflict_text(
    repo: &Repository,
    conflict: &IndexConflict,
    path: &str,
) -> anyhow::Result<String> {
    let repo_root = repo_workdir(repo)?;
    let ours = conflict
        .our
        .as_ref()
        .ok_or_else(|| anyhow!("current side is unavailable for {path}"))?;
    let theirs = conflict
        .their
        .as_ref()
        .ok_or_else(|| anyhow!("incoming side is unavailable for {path}"))?;
    let ancestor = match conflict.ancestor.as_ref() {
        Some(entry) => entry.id,
        None => empty_blob_oid(repo)?,
    };
    let output = Command::new("git")
        .current_dir(&repo_root)
        .args([
            "merge-file",
            "-p",
            "--object-id",
            "--diff3",
            &ours.id.to_string(),
            &ancestor.to_string(),
            &theirs.id.to_string(),
        ])
        .output()
        .with_context(|| format!("failed to run git merge-file for {path}"))?;
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| anyhow!("git merge-file returned non-UTF-8 output for {path}"))?;
    if !stdout.is_empty() && (output.status.success() || output.status.code().unwrap_or(-1) > 0) {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    bail!(
        "failed to build diff3 conflict preview for {path}: {}",
        if detail.is_empty() {
            "git merge-file returned no preview output"
        } else {
            detail
        }
    )
}

fn empty_blob_oid(repo: &Repository) -> anyhow::Result<Oid> {
    repo.blob(&[])
        .context("failed to create empty blob for add/add merge preview")
}
fn build_magic_wand_preview(
    repo_id: String,
    path: String,
    source_version: String,
    current_text: &str,
    current_conflicts: &[ParsedConflictBlock],
    canonical_conflicts: &[ParsedConflictBlock],
    allow_empty_base_fallback: bool,
) -> anyhow::Result<ConflictMagicWandPreview> {
    let mut next_canonical_index = 0usize;
    let mut resolved = Vec::new();
    for current in current_conflicts {
        let resolved_block = if let Some((canonical_index, canonical)) = canonical_conflicts
            .iter()
            .enumerate()
            .skip(next_canonical_index)
            .find(|(_, candidate)| {
                candidate.current == current.current && candidate.incoming == current.incoming
            }) {
            next_canonical_index = canonical_index + 1;
            canonical.base.as_deref().and_then(|base| {
                resolve_magic_wand_block(base, &current.current, &current.incoming)
            })
        } else if allow_empty_base_fallback {
            resolve_magic_wand_block("", &current.current, &current.incoming)
        } else {
            None
        };
        let Some(applied) = resolved_block else {
            continue;
        };
        resolved.push((current, applied));
    }
    if resolved.is_empty() {
        bail!(
            "Magic wand found no safe deterministic resolution for the remaining conflict blocks."
        );
    }
    let mut content = String::with_capacity(current_text.len());
    let mut cursor = 0usize;
    let mut rules = Vec::with_capacity(resolved.len());
    for (conflict, applied) in &resolved {
        content.push_str(&current_text[cursor..conflict.byte_start]);
        content.push_str(&applied.content);
        cursor = conflict.byte_end;
        rules.push(ConflictMagicWandRuleApplication {
            conflict_id: conflict.id.clone(),
            rule: applied.rule,
            summary: applied.summary.clone(),
        });
    }
    content.push_str(&current_text[cursor..]);
    let remaining_conflict_count = parse_conflict_blocks(&content).len();
    let resolved_conflict_count = rules.len();
    let summary = format!(
        "Resolved {resolved_conflict_count} conflict block{} with the magic wand. {remaining_conflict_count} conflict block{} remain.",
        if resolved_conflict_count == 1 {
            ""
        } else {
            "s"
        },
        if remaining_conflict_count == 1 {
            ""
        } else {
            "s"
        },
    );
    Ok(ConflictMagicWandPreview {
        repo_id,
        path,
        source_version,
        content,
        resolved_conflict_count,
        remaining_conflict_count,
        summary,
        rules,
    })
}

fn resolve_magic_wand_block(
    base: &str,
    current: &str,
    incoming: &str,
) -> Option<ResolvedMagicWandBlock> {
    if current == incoming {
        return Some(ResolvedMagicWandBlock {
            rule: ConflictMagicWandRule::IdenticalSides,
            summary: "Both sides already contain the same text; kept a single copy.".to_string(),
            content: current.to_string(),
        });
    }
    if let Some(content) = resolve_import_list_block(base, current, incoming) {
        return Some(ResolvedMagicWandBlock {
            rule: ConflictMagicWandRule::ImportListUnion,
            summary: "Merged import-style lines and removed exact duplicates.".to_string(),
            content,
        });
    }
    if let Some(content) = resolve_linewise_independent_block(base, current, incoming) {
        return Some(ResolvedMagicWandBlock {
            rule: ConflictMagicWandRule::LinewiseIndependentEdits,
            summary: "Accepted per-line edits where the opposite side still matched base."
                .to_string(),
            content,
        });
    }
    resolve_same_line_non_overlapping_block(base, current, incoming).map(|content| {
        ResolvedMagicWandBlock {
            rule: ConflictMagicWandRule::SameLineNonOverlappingEdits,
            summary: "Combined non-overlapping same-line edits from both sides.".to_string(),
            content,
        }
    })
}

fn resolve_import_list_block(base: &str, current: &str, incoming: &str) -> Option<String> {
    if !base.trim().is_empty() {
        return None;
    }
    let current_lines = split_preserved_lines(current);
    let incoming_lines = split_preserved_lines(incoming);
    if current_lines.is_empty() || incoming_lines.is_empty() {
        return None;
    }
    if !looks_like_import_lines(&current_lines) || !looks_like_import_lines(&incoming_lines) {
        return None;
    }
    let mut seen = HashSet::new();
    let mut merged = String::new();
    let mut added = 0usize;
    for line in current_lines.into_iter().chain(incoming_lines) {
        let key = line.trim();
        if key.is_empty() || !seen.insert(key.to_string()) {
            continue;
        }
        merged.push_str(line);
        added += 1;
    }
    let current_unique = split_preserved_lines(current)
        .into_iter()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<HashSet<_>>()
        .len();
    let incoming_unique = split_preserved_lines(incoming)
        .into_iter()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<HashSet<_>>()
        .len();
    if added == 0 || (added == current_unique && added == incoming_unique) {
        return None;
    }
    Some(merged)
}

fn resolve_linewise_independent_block(base: &str, current: &str, incoming: &str) -> Option<String> {
    let base_lines = split_preserved_lines(base);
    let current_lines = split_preserved_lines(current);
    let incoming_lines = split_preserved_lines(incoming);
    if base_lines.is_empty()
        || base_lines.len() != current_lines.len()
        || base_lines.len() != incoming_lines.len()
    {
        return None;
    }
    let mut merged = String::new();
    let mut used_both_sides = false;
    for index in 0..base_lines.len() {
        let base_line = base_lines[index];
        let current_line = current_lines[index];
        let incoming_line = incoming_lines[index];
        if current_line == incoming_line {
            merged.push_str(current_line);
            continue;
        }
        if current_line == base_line {
            merged.push_str(incoming_line);
            used_both_sides = true;
            continue;
        }
        if incoming_line == base_line {
            merged.push_str(current_line);
            used_both_sides = true;
            continue;
        }
        return None;
    }
    used_both_sides.then_some(merged)
}

fn resolve_same_line_non_overlapping_block(
    base: &str,
    current: &str,
    incoming: &str,
) -> Option<String> {
    let (base_line, base_newline) = single_line_text(base)?;
    let (current_line, current_newline) = single_line_text(current)?;
    let (incoming_line, incoming_newline) = single_line_text(incoming)?;
    let base_chars: Vec<char> = base_line.chars().collect();
    let current_edit = char_edit_from_base(&base_chars, &current_line.chars().collect::<Vec<_>>());
    let incoming_edit =
        char_edit_from_base(&base_chars, &incoming_line.chars().collect::<Vec<_>>());
    if edits_overlap(&current_edit, &incoming_edit) {
        return None;
    }
    let mut merged = base_chars;
    let mut edits = [current_edit, incoming_edit];
    edits.sort_by(|left, right| right.start.cmp(&left.start).then(right.end.cmp(&left.end)));
    for edit in edits {
        merged.splice(edit.start..edit.end, edit.replacement.chars());
    }
    let mut text = merged.into_iter().collect::<String>();
    if base_newline || current_newline || incoming_newline {
        text.push('\n');
    }
    Some(text)
}

fn split_preserved_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.split_inclusive('\n').collect()
}

fn looks_like_import_lines(lines: &[&str]) -> bool {
    lines.iter().all(|line| {
        let trimmed = line.trim();
        trimmed.is_empty()
            || trimmed.starts_with("import ")
            || trimmed.starts_with("export ")
            || trimmed.starts_with("use ")
            || trimmed.starts_with("pub use ")
    })
}

fn single_line_text(text: &str) -> Option<(String, bool)> {
    let lines = split_preserved_lines(text);
    if lines.len() != 1 {
        return None;
    }
    let line = lines[0];
    let has_newline = line.ends_with('\n');
    let raw = if has_newline {
        &line[..line.len() - 1]
    } else {
        line
    };
    Some((raw.to_string(), has_newline))
}

fn char_edit_from_base(base: &[char], variant: &[char]) -> CharEdit {
    let mut prefix = 0usize;
    while prefix < base.len() && prefix < variant.len() && base[prefix] == variant[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < base.len().saturating_sub(prefix)
        && suffix < variant.len().saturating_sub(prefix)
        && base[base.len() - 1 - suffix] == variant[variant.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let end = base.len() - suffix;
    let replacement_end = variant.len() - suffix;
    CharEdit {
        start: prefix,
        end,
        replacement: variant[prefix..replacement_end].iter().collect(),
    }
}

fn edits_overlap(left: &CharEdit, right: &CharEdit) -> bool {
    if left.start == left.end && right.start == right.end && left.start == right.start {
        return true;
    }
    !(left.end <= right.start || right.end <= left.start)
}

fn parse_conflict_blocks(text: &str) -> Vec<ParsedConflictBlock> {
    let mut blocks = Vec::new();
    let mut byte_offset = 0usize;
    let mut start_line: Option<usize> = None;
    let mut start_byte = 0usize;
    let mut separator_line: Option<usize> = None;
    let mut section = ParsedConflictSection::Current;
    let mut current = String::new();
    let mut base = String::new();
    let mut incoming = String::new();
    for (index, line) in text.split_inclusive('\n').enumerate() {
        let line_number = index + 1;
        let line_start = byte_offset;
        byte_offset += line.len();
        if line.starts_with("<<<<<<<") && start_line.is_none() {
            start_line = Some(line_number);
            start_byte = line_start;
            separator_line = None;
            section = ParsedConflictSection::Current;
            current.clear();
            base.clear();
            incoming.clear();
            continue;
        }
        let Some(block_start_line) = start_line else {
            continue;
        };
        if line.starts_with("|||||||") && section == ParsedConflictSection::Current {
            section = ParsedConflictSection::Base;
            continue;
        }
        if line.starts_with("=======") && section != ParsedConflictSection::Incoming {
            separator_line = Some(line_number);
            section = ParsedConflictSection::Incoming;
            continue;
        }
        if line.starts_with(">>>>>>>") {
            blocks.push(ParsedConflictBlock {
                id: format!("conflict-{}", blocks.len() + 1),
                start_line: block_start_line,
                separator_line,
                end_line: line_number,
                byte_start: start_byte,
                byte_end: byte_offset,
                current: current.clone(),
                base: separator_line.map(|_| base.clone()),
                incoming: incoming.clone(),
            });
            start_line = None;
            separator_line = None;
            section = ParsedConflictSection::Current;
            current.clear();
            base.clear();
            incoming.clear();
            continue;
        }
        match section {
            ParsedConflictSection::Current => current.push_str(line),
            ParsedConflictSection::Base => base.push_str(line),
            ParsedConflictSection::Incoming => incoming.push_str(line),
        }
    }
    blocks
}

fn parse_conflict_regions(text: &str) -> Vec<ConflictRegion> {
    parse_conflict_blocks(text)
        .into_iter()
        .map(|block| ConflictRegion {
            id: block.id,
            start_line: block.start_line,
            separator_line: block.separator_line,
            end_line: block.end_line,
        })
        .collect()
}

fn normalize_relative_path(path: &str) -> anyhow::Result<PathBuf> {
    let trimmed = path.trim();
    let mut normalized = PathBuf::new();
    if trimmed.is_empty() || trimmed == "." {
        bail!("file path is required");
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        bail!("absolute paths are not accepted by Conflict Resolver");
    }
    for component in candidate.components() {
        match component {
            Component::Normal(segment) => normalized.push(segment),
            Component::CurDir => {}
            Component::ParentDir => {
                bail!("parent path segments are not accepted by Conflict Resolver")
            }
            Component::RootDir | Component::Prefix(_) => {
                bail!("absolute paths are not accepted by Conflict Resolver")
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        bail!("file path is required");
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn run_git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("git command runs");
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn create_conflicted_repo() -> TempDir {
        let temp = TempDir::new().expect("temp repo created");
        let root = temp.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "fura@example.invalid"]);
        run_git(root, &["config", "user.name", "Fura Test"]);
        fs::write(root.join("demo.txt"), "one\nbase\nthree\n").expect("base file written");
        run_git(root, &["add", "demo.txt"]);
        run_git(root, &["commit", "-m", "base"]);
        run_git(root, &["checkout", "-b", "ours"]);
        fs::write(root.join("demo.txt"), "one\nours\nthree\n").expect("ours file written");
        run_git(root, &["commit", "-am", "ours"]);
        run_git(root, &["checkout", "-b", "theirs", "HEAD~1"]);
        fs::write(root.join("demo.txt"), "one\ntheirs\nthree\n").expect("theirs file written");
        run_git(root, &["commit", "-am", "theirs"]);
        run_git(root, &["checkout", "ours"]);
        let output = Command::new("git")
            .current_dir(root)
            .args(["merge", "theirs"])
            .output()
            .expect("git merge runs");
        assert!(!output.status.success(), "merge should conflict");
        temp
    }

    fn write_repo_file(root: &Path, path: &str, content: &str) {
        let target = root.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).expect("parent dir created");
        }
        fs::write(target, content).expect("repo file written");
    }

    fn create_conflicted_repo_from_contents(
        path: &str,
        base: &str,
        ours: &str,
        theirs: &str,
    ) -> TempDir {
        let temp = TempDir::new().expect("temp repo created");
        let root = temp.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "fura@example.invalid"]);
        run_git(root, &["config", "user.name", "Fura Test"]);
        write_repo_file(root, path, base);
        run_git(root, &["add", path]);
        run_git(root, &["commit", "-m", "base"]);
        run_git(root, &["checkout", "-b", "ours"]);
        write_repo_file(root, path, ours);
        run_git(root, &["commit", "-am", "ours"]);
        run_git(root, &["checkout", "-b", "theirs", "HEAD~1"]);
        write_repo_file(root, path, theirs);
        run_git(root, &["commit", "-am", "theirs"]);
        run_git(root, &["checkout", "ours"]);
        let output = Command::new("git")
            .current_dir(root)
            .args(["merge", "theirs"])
            .output()
            .expect("git merge runs");
        assert!(!output.status.success(), "merge should conflict");
        temp
    }

    fn create_add_add_conflicted_repo(path: &str, ours: &str, theirs: &str) -> TempDir {
        let temp = TempDir::new().expect("temp repo created");
        let root = temp.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "fura@example.invalid"]);
        run_git(root, &["config", "user.name", "Fura Test"]);
        run_git(root, &["commit", "--allow-empty", "-m", "base"]);
        run_git(root, &["checkout", "-b", "ours"]);
        write_repo_file(root, path, ours);
        run_git(root, &["add", path]);
        run_git(root, &["commit", "-m", "ours"]);
        run_git(root, &["checkout", "-b", "theirs", "HEAD~1"]);
        write_repo_file(root, path, theirs);
        run_git(root, &["add", path]);
        run_git(root, &["commit", "-m", "theirs"]);
        run_git(root, &["checkout", "ours"]);
        let output = Command::new("git")
            .current_dir(root)
            .args(["merge", "theirs"])
            .output()
            .expect("git merge runs");
        assert!(!output.status.success(), "merge should conflict");
        temp
    }
    #[test]
    fn scans_conflicted_repository() {
        let temp = create_conflicted_repo();
        let summary = scan_conflict_repository(temp.path().to_string_lossy().as_ref())
            .expect("conflict repo scanned");

        assert_eq!(summary.operation, Some(ConflictOperation::Merge));
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "demo.txt");
        assert_eq!(summary.files[0].kind, ConflictFileKind::BothModified);
        assert!(summary.files[0].supported);
    }

    #[test]
    fn opens_conflicted_file_buffers() {
        let temp = create_conflicted_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let file = open_conflict_file(root.to_string_lossy().as_ref(), "demo.txt")
            .expect("conflict file opened");

        assert_eq!(file.path, "demo.txt");
        assert!(
            file.base
                .as_ref()
                .map(|buffer| buffer.label.as_str())
                .unwrap_or("")
                .contains("Common ancestor")
        );
        assert!(
            file.ours
                .as_ref()
                .map(|buffer| buffer.label.as_str())
                .unwrap_or("")
                .contains("ours")
        );
        assert!(
            file.theirs
                .as_ref()
                .map(|buffer| buffer.label.as_str())
                .unwrap_or("")
                .contains("theirs")
        );
        assert_eq!(
            file.base.as_ref().map(|buffer| buffer.text.as_str()),
            Some("one\nbase\nthree\n")
        );
        assert_eq!(
            file.ours.as_ref().map(|buffer| buffer.text.as_str()),
            Some("one\nours\nthree\n")
        );
        assert_eq!(
            file.theirs.as_ref().map(|buffer| buffer.text.as_str()),
            Some("one\ntheirs\nthree\n")
        );
        let result = file.result.expect("result buffer present");
        assert!(result.text.contains("<<<<<<<"));
        assert_eq!(file.conflicts.len(), 1);
    }

    #[test]
    fn writes_conflict_result_with_version_guard() {
        let temp = create_conflicted_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let file = open_conflict_file(root.to_string_lossy().as_ref(), "demo.txt")
            .expect("conflict file opened");

        let written = write_conflict_result(
            root.to_string_lossy().as_ref(),
            "demo.txt",
            "one\nresolved\nthree\n",
            &file.version,
        )
        .expect("conflict result written");

        assert_eq!(
            written.result.as_ref().map(|buffer| buffer.text.as_str()),
            Some("one\nresolved\nthree\n")
        );
        assert!(written.conflicts.is_empty());
    }

    #[test]
    fn rejects_stale_conflict_result_write() {
        let temp = create_conflicted_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");

        let error = write_conflict_result(
            root.to_string_lossy().as_ref(),
            "demo.txt",
            "one\nresolved\nthree\n",
            "stale-version",
        )
        .expect_err("stale write rejected");

        assert!(error.contains("changed on disk"));
    }

    #[test]
    fn rejects_same_size_stale_conflict_result_write() {
        let temp = create_conflicted_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let file = open_conflict_file(root.to_string_lossy().as_ref(), "demo.txt")
            .expect("conflict file opened");
        fs::write(root.join("demo.txt"), "one\nmanual!!\nthree\n").expect("same-size edit written");

        let error = write_conflict_result(
            root.to_string_lossy().as_ref(),
            "demo.txt",
            "one\nresolved\nthree\n",
            &file.version,
        )
        .expect_err("same-size stale write rejected");

        assert!(error.contains("changed on disk"));
    }

    #[test]
    fn stages_resolved_conflict_file() {
        let temp = create_conflicted_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let file = open_conflict_file(root.to_string_lossy().as_ref(), "demo.txt")
            .expect("conflict file opened");
        let written = write_conflict_result(
            root.to_string_lossy().as_ref(),
            "demo.txt",
            "one\nresolved\nthree\n",
            &file.version,
        )
        .expect("conflict result written");

        let summary = stage_resolved_conflict_file(
            root.to_string_lossy().as_ref(),
            "demo.txt",
            &written.version,
        )
        .expect("resolved file staged");

        assert!(summary.files.is_empty());
        assert!(open_conflict_file(root.to_string_lossy().as_ref(), "demo.txt").is_err());
    }

    #[test]
    fn rejects_stage_when_any_conflict_marker_line_remains() {
        let temp = create_conflicted_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let file = open_conflict_file(root.to_string_lossy().as_ref(), "demo.txt")
            .expect("conflict file opened");
        let written = write_conflict_result(
            root.to_string_lossy().as_ref(),
            "demo.txt",
            "one\n<<<<<<< HEAD\nunfinished\nthree\n",
            &file.version,
        )
        .expect("conflict result written");

        let error = stage_resolved_conflict_file(
            root.to_string_lossy().as_ref(),
            "demo.txt",
            &written.version,
        )
        .expect_err("stage rejected");

        assert!(error.contains("conflict markers"));
    }

    #[test]
    fn rejects_parent_path_segments() {
        let temp = create_conflicted_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let error = open_conflict_file(root.to_string_lossy().as_ref(), "../demo.txt")
            .expect_err("parent path rejected");

        assert!(error.contains("parent path segments"));
    }
    #[test]
    fn resolves_linewise_independent_magic_wand_block() {
        let resolved = resolve_magic_wand_block(
            "alpha = 1;\nbeta = 2;\n",
            "alpha = 10;\nbeta = 2;\n",
            "alpha = 1;\nbeta = 20;\n",
        )
        .expect("linewise block resolves");

        assert_eq!(
            resolved.rule,
            ConflictMagicWandRule::LinewiseIndependentEdits
        );
        assert_eq!(resolved.content, "alpha = 10;\nbeta = 20;\n");
    }

    #[test]
    fn resolves_same_line_non_overlapping_magic_wand_block() {
        let resolved = resolve_magic_wand_block(
            "let value = call(foo, bar);\n",
            "let value = call(foo, baz);\n",
            "let value = invoke(foo, bar);\n",
        )
        .expect("same-line block resolves");

        assert_eq!(
            resolved.rule,
            ConflictMagicWandRule::SameLineNonOverlappingEdits
        );
        assert_eq!(resolved.content, "let value = invoke(foo, baz);\n");
    }

    #[test]
    fn previews_magic_wand_for_add_add_import_conflict() {
        let temp = create_add_add_conflicted_repo(
            "src/demo.ts",
            "import { alpha } from \"./alpha\";\nimport { shared } from \"./shared\";\n",
            "import { beta } from \"./beta\";\nimport { shared } from \"./shared\";\n",
        );
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let file = open_conflict_file(root.to_string_lossy().as_ref(), "src/demo.ts")
            .expect("conflict file opened");

        let preview = preview_conflict_magic_wand(
            root.to_string_lossy().as_ref(),
            "src/demo.ts",
            &file.version,
        )
        .expect("preview created");

        assert_eq!(preview.resolved_conflict_count, 1);
        assert_eq!(preview.remaining_conflict_count, 0);
        assert!(
            preview
                .content
                .contains("import { alpha } from \"./alpha\";\n")
        );
        assert!(
            preview
                .content
                .contains("import { beta } from \"./beta\";\n")
        );
        assert_eq!(
            preview
                .content
                .matches("import { shared } from \"./shared\";\n")
                .count(),
            1
        );
        assert_eq!(
            preview.rules[0].rule,
            ConflictMagicWandRule::ImportListUnion
        );
    }

    #[test]
    fn prepares_selected_conflict_conflict_agent_request() {
        let temp = create_conflicted_repo_from_contents(
            "src/demo.ts",
            "const value = base();\n",
            "const value = ours();\n",
            "const value = theirs();\n",
        );
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let file = open_conflict_file(root.to_string_lossy().as_ref(), "src/demo.ts")
            .expect("conflict file opened");

        let prepared = prepare_conflict_agent_request(
            "ctx",
            root.to_string_lossy().as_ref(),
            "src/demo.ts",
            &file.version,
            ConflictAgentMode::Propose,
            ConflictAgentScope::SelectedConflict,
            Some("conflict-1"),
            "",
        )
        .expect("conflict resolver agent request prepared");

        assert_eq!(prepared.conflict_id.as_deref(), Some("conflict-1"));
        assert!(prepared.prompt.contains("Conflict context id: ctx"));
        assert!(prepared.prompt.contains("Selected conflict: conflict-1"));
        assert!(
            prepared
                .prompt
                .contains("Only the selected conflict block may change")
        );
    }

    #[test]
    fn rejects_selected_conflict_conflict_agent_result_that_changes_outside_scope() {
        let temp = create_conflicted_repo_from_contents(
            "src/demo.ts",
            "one\nbase\nthree\n",
            "one\nours\nthree\n",
            "one\ntheirs\nthree\n",
        );
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let file = open_conflict_file(root.to_string_lossy().as_ref(), "src/demo.ts")
            .expect("conflict file opened");
        let prepared = prepare_conflict_agent_request(
            "ctx",
            root.to_string_lossy().as_ref(),
            "src/demo.ts",
            &file.version,
            ConflictAgentMode::Propose,
            ConflictAgentScope::SelectedConflict,
            Some("conflict-1"),
            "Keep the rest unchanged.",
        )
        .expect("conflict resolver agent request prepared");
        let context = ActiveConflictContext {
            transport_session_id: "conflict-transport".to_string(),
            session_id: "conflict-session".to_string(),
            repo_root: prepared.repo_root,
            repo_id: prepared.repo_id,
            path: prepared.path,
            source_version: prepared.source_version,
            mode: prepared.mode,
            scope: prepared.scope,
            conflict_id: prepared.conflict_id,
            original_content: prepared.original_content,
            original_conflict_count: prepared.original_conflict_count,
            selected_conflict_byte_start: prepared.selected_conflict_byte_start,
            selected_conflict_byte_end: prepared.selected_conflict_byte_end,
            previous_host_tools: Vec::new(),
            set_host_tools_command_id: "set-host".to_string(),
            prompt_command_id: "prompt".to_string(),
        };

        let error = finalize_conflict_agent_result(
            &context,
            ConflictAgentRisk::Medium,
            "Merged the selected conflict.".to_string(),
            "This should only touch the selected block.".to_string(),
            Some(format!("changed outside\n{}", context.original_content)),
        )
        .expect_err("proposal rejected");

        assert!(error.contains("outside the targeted conflict block"));
    }

    #[test]
    fn rejects_magic_wand_when_no_safe_rule_applies() {
        let temp = create_conflicted_repo();
        let root = temp.path().canonicalize().expect("repo root canonicalized");
        let file = open_conflict_file(root.to_string_lossy().as_ref(), "demo.txt")
            .expect("conflict file opened");

        let error =
            preview_conflict_magic_wand(root.to_string_lossy().as_ref(), "demo.txt", &file.version)
                .expect_err("preview rejected");

        assert!(error.contains("no safe deterministic resolution"));
    }
}
