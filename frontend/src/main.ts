import "./style.css";
import "./desktopDensity.css";
import "highlight.js/styles/github-dark.css";
import { clearBootstrapToken, consumeBootstrapToken, storeBootstrapToken } from "./bootstrapAuth";
import { buildCommandsPopupSections, findLiveSlashCommand, findSlashCommand, fuzzyMatchCommands, isLiveSlashCommandRunnableWhileBusy, SUPPORTED_SLASH_COMMANDS, type CommandPopupSection, type SlashCommandSpec } from "./slashCommands";
import { formatContextUsage, formatCost, formatTokens, shortId, shortPath } from "./format";
import { nextThinkingVisibilityMode, parseThinkingVisibilityMode, parseToolVisibility, type ThinkingVisibilityMode } from "./uiPreferences";
import { createFuraConnection, type ConnectionStatus, type FuraConnection } from "./connection";
import { mkEl, reconcileChildren, requireElement, setRenderDocument } from "./dom";
import { createGitDiffHighlighter } from "./gitDiffHighlight";
import { renderRangeDiffOutput } from "./rangeDiff";
import type { DiffHighlighter } from "./diffHighlight";
import {
  isCompactReadCard,
  renderCurrentTodoCard,
  renderReadToolCard,
  renderReadToolGroup,
  shouldRenderToolInTranscript,
  renderToolCard,
} from "./toolCards";
import { renderReviewCard, reviewCardRenderKey } from "./reviewCard";
import {
  blobToBase64,
  createPendingMarker as createAttachmentMarker,
  expandSnippetTokens as expandSnippetAttachmentTokens,
  removePendingMarkerFromText,
  insertTextAtSelection,
  renderAttachmentPreviews,
  type PendingImage,
  type PendingSnippet,
} from "./composerAttachments";
import {
  createPromptSendMessage,
  restorePendingImagesFromDraft,
  resolvePromptSubmitAction,
  SessionComposerDrafts,
  CONTROLLER_DRAFT,
  NO_SESSION_DRAFT,
  type ComposerDraftKey,
  type SessionComposerDraft,
  type PromptBehavior,
} from "./composer";
import {
  busyPromptAttachmentNote as formatBusyPromptAttachmentNote,
  busyPromptDisplayText,
  createBusyPromptDraft,
  createBusyPromptDraftFromServer,
  restoreBusyPromptEditorText,
  type BusyPromptDraft,
} from "./promptBusy";
import {
  fuzzyMatchCategories as fuzzyMatchSessionCategories,
  normalizedCategory,
  sessionCategories as deriveSessionCategories,
  sessionKindLabel,
  sessionStatusLabel,
  visibleSessions as filterVisibleSessions,
} from "./sessionList";
import { applySessionDelta, applySessionSnapshot, applySessionsSnapshot, activateSession as activateSessionState, projectionAddsTranscriptEntries, sessionOpenOrAttachMessage } from "./sessionClientState";
import {
  comparisonKey,
  DEFAULT_SESSION_CHANGES_DETAIL_MODE,
  diffRefInputFromText,
  diffRefInputText,
  formatDiffRepoLabel,
  sessionChangesRefreshOptions,
  resolvedRefLabel,
  summarizeWireDiffFiles,
} from "./diffState";
import { acceptGitHistoryResult, beginGitHistoryRequest, createGitHistoryState, gitHeadLabel, renderGitHistoryBrowser, selectGitHistoryRef, type GitHistoryState, type GitReviewView } from "./gitHistory";
import { openCommittedFileView } from "./gitFileView";
import {
  annotationsForDiffLocation,
  checkoutTargetForDiffFile,
  createDiffReviewAnnotation,
  createReviewCommentCreateMessage,
  diffCommentFlushEditorText,
  diffCommentPreviewStatus,
  formatReviewCommentLocation,
  prepareDiffAnnotationPrompt,
  isReviewCommentMatched,
  isSameDiffLineLocation,
  selectedDiffAnnotations,
  reviewCommentsForComparison,
  reviewCommentsForDiffLocation,
  type DiffAnnotationPromptMode,
  type DiffPreviewDraft,
} from "./diffReview";
import {
  buildCodeCommentPrompt,
  codeCommentFileKey,
  codeCommentFlushEditorText,
  codeCommentPreviewStatus,
  createCodeFileComment,
  removeSelectedCodeComments,
  selectedCodeComments,
  type CodeFileComment,
  type CodePreviewDraft,
} from "./codeComments";
import {
  deriveWorktreeCreateView,
  resolveSessionCreateMessage,
  type SessionCreateValidationTarget,
} from "./sessionCreate";
import {
  catalogContainsProposedModel,
  filterCatalogModels,
  formatCatalogModelLabel,
  formatModelContext,
  formatModelSelector,
  formatProposedModelDetails,
  normalizeSelectedProposedModelId,
  proposedModelIdFromName,
  PROPOSED_THINKING_LEVELS,
  removeProposedModel,
  upsertProposedModel,
  validateProposedModels,
} from "./proposedModels";
import { deriveSessionDeleteView, sessionDeleteMessage, type SessionDeleteView } from "./sessionDelete";
import { goalModeBadgeLabel, renderGoalModeCard } from "./goalMode";
import { createSessionListView, renderSessionCategoryFilter } from "./sessionListView";
import {
  createCategoryCombobox,
  handleCategoryComboboxKeydown,
  hideCategoryCombobox,
  type CategoryCombobox,
} from "./categoryCombobox";
import {
  askCardRenderKey,
  parsePendingAsk,
  renderAskCard,
  type PendingAsk,
} from "./askCard";
import { initDesktopDockview, type DesktopDockview } from "./desktopDockview";
import { captureDiffFilterFocus, restoreDiffFilterFocus } from "./diffViewDom";
import { messageText, renderMarkdown, renderMessage as renderTranscriptMessage, transcriptMessageRenderCacheKey, updateRenderedMessage } from "./transcriptView";
import { setTextileRedmineRootUrl } from "./textileRendering";
import {
  buildTranscriptReviewPrompt,
  type TranscriptReviewComment,
  type TranscriptReviewLine,
} from "./transcriptReview";
import {
  buildPlanReviewPrompt,
  createApprovePlanReviewMessage,
  pendingPlanReviewFromMessage,
  planReviewRenderKey,
  renderPlanReviewCard,
  planReviewTranscriptMessage,
  type PendingPlanReview,
  type VisiblePlanReview,
} from "./planReview";
import {
  parentCodePath,
  renderCodeContextMenu,
  renderCodeViewer,
  renderRevisionCodeViewer,
  type CodeRevisionState,
  type CodeContextMenuViewState,
  type CodeReferencesState,
  type CodeViewerState,
} from "./codeViewer";
import type {
  ClientMessage,
  CodeFileContent,
  CodeLocation,
  CodeStatus,
  CodeTreeEntry,
  CodeWorkspaceSummary,
  ControlCandidate,
  ControlStatusProjection,
  ControlSuggestedAction,
  CompareDiffSummaryState,
  GitRangeDiffResult,
  DiffDetailMode,
  DiffLineLocation,
  DiffReviewAnnotation,
  DiffReviewableState,
  DiffRow,
  FrontendControlAction,
  FrontendUiSnapshot,
  GoalControlAction,
  ModelSummary,
  PlanApprovalMode,
  ProposedModelConfig,
  ProposedThinkingLevel,
  PresetSummary,
  ReviewComment,
  ServerConfig,
  ServerMessage,
  SessionChangesSummaryState,
  GitChangeKind,
  SessionRepoAction,
  SessionProjection,
  SessionSummary,
  SessionRewindPoint,
  TodoPhase,
  ToolCard,
  TranscriptMessage,
} from "./protocol";
import {
  buildPresetSaveMessage,
  isValidPresetName,
  parsePresetParams,
  presetNameFromInput,
  pruneDefaults,
  requiredParamsFilled,
  resolvePresetCommand,
  substitutePresetParams,
} from "./presets";

type WorkspaceMode = "session" | "controller";

type PanelRenderItem = {
  key: string;
  render: () => HTMLElement;
  cacheable?: boolean;
  update?(cachedNode: HTMLElement): HTMLElement;
};


type CachedPanelRenderState = {
  nodes: Map<string, HTMLElement>;
  revision: number;
};


const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("#app missing");
}

app.innerHTML = `
  <main class="shell">
    <aside class="sidebar">
      <section class="brand">
        <h1>Fura</h1>
        <span id="connectionStatus" class="status disconnected">disconnected</span>
      </section>

      <section class="sidebar-actions">
        <button id="createSessionButton" type="button">New</button>
        <select id="sessionCategoryFilter" aria-label="Session category filter">
          <option value="">All sessions</option>
        </select>
      </section>

      <nav id="sessionsList" class="sessions" aria-label="Sessions"></nav>
    </aside>

    <section class="workspace">
      <header class="workspace-header">
        <div class="workspace-title">
          <h2 id="sessionTitle">No session selected</h2>
          <p id="sessionMeta">Create or attach to a session to begin.</p>
        </div>
        <div class="workspace-actions">
          <!-- Ask Fura is intentionally a desktop-only workspace affordance for now; future mobile UI should omit it unless the product direction changes. -->
          <button id="askFuraButton" class="ask-fura-toggle" type="button" aria-pressed="false">Ask Fura</button>
          <button id="abortButton" type="button">Abort</button>
          <button id="stopButton" type="button">Stop</button>
          <div class="workspace-options">
            <button id="workspaceOptionsToggle" class="workspace-options-toggle" type="button" aria-expanded="false" aria-haspopup="menu" aria-controls="workspaceOptionsMenu" title="Session options">⚙</button>
            <div id="workspaceOptionsMenu" class="workspace-options-menu" role="menu" hidden>
              <button id="toolVisibilityToggle" class="workspace-option-item" type="button" role="menuitemcheckbox" aria-checked="true">Tools: on</button>
              <button id="editDiffVisibilityToggle" class="workspace-option-item" type="button" role="menuitemcheckbox" aria-checked="true">Edit diffs: on</button>
              <button id="thinkingVisibilityToggle" class="workspace-option-item" type="button" role="menuitem">Thinking: auto</button>
              <button id="proposedModelsOpen" class="workspace-option-item" type="button" role="menuitem">Model templates</button>
              <div class="workspace-menu-divider" role="separator"></div>
              <div class="category-editor">
                <label for="activeCategoryInput">Category</label>
                <div class="category-combobox">
                  <input id="activeCategoryInput" autocomplete="off" spellcheck="false" maxlength="80" placeholder="category" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="activeCategorySuggestions" />
                  <div id="activeCategorySuggestions" class="category-suggestions" role="listbox" hidden></div>
                </div>
                <button id="activeCategorySave" type="button">Save</button>
              </div>
              <div class="workspace-menu-divider" role="separator"></div>
              <button id="duplicateSessionButton" class="workspace-option-item" type="button" role="menuitem">Duplicate chat</button>
              <button id="rollbackChatButton" class="workspace-option-item" type="button" role="menuitem">Rollback chat…</button>
              <button id="deleteSessionButton" class="workspace-option-item danger-action" type="button" role="menuitem">Delete session</button>
            </div>
          </div>
        </div>
      </header>

      <div id="workspacePanelHost" class="workspace-panel-stack">
        <div id="normalWorkspacePanelHost" class="workspace-panel-host workspace-panel-host-active"></div>
        <div id="diffReviewWorkspacePanelHost" class="workspace-panel-host"></div>
      </div>

      <div id="statusBar" class="status-bar" aria-label="Session status"></div>

      <form id="promptForm" class="prompt-form">
        <div class="prompt-field">
          <div id="commandPalette" class="command-palette" hidden></div>
          <div id="imagePreviews" class="image-previews" hidden></div>
          <textarea id="promptInput" rows="4" placeholder="Send a prompt…"></textarea>
        </div>
        <div class="prompt-actions">
          <button id="voiceButton" class="voice-button" type="button" aria-pressed="false" title="Hold to dictate. Alt+M starts while held.">Hold mic</button>
          <span id="voiceStatus" class="voice-status" aria-live="polite">voice idle</span>
          <button id="sendButton" type="submit">Send</button>
        </div>
      </form>
    </section>

  </main>

  <div id="authGate" class="modal-overlay auth-gate" hidden>
    <section class="modal-panel auth-panel" role="dialog" aria-modal="true" aria-labelledby="authGateTitle" aria-describedby="authGateDescription">
      <header class="modal-header">
        <div>
          <h2 id="authGateTitle">Connect to Fura</h2>
          <p id="authGateDescription">Enter the bridge token from your local Fura startup output. The token is not accepted from URLs.</p>
        </div>
      </header>
      <form id="authForm" class="auth-form">
        <label for="authTokenInput">Bridge token</label>
        <input id="authTokenInput" type="password" autocomplete="current-password" spellcheck="false" required />
        <p id="authStatus" class="auth-status" aria-live="polite"></p>
        <footer class="modal-footer auth-actions">
          <span>Use Tailscale or localhost for private access.</span>
          <button id="authSubmit" type="submit">Connect</button>
        </footer>
      </form>
    </section>
  </div>

  <div id="busyPromptOverlay" class="modal-overlay" hidden>
    <section class="busy-prompt modal-panel" role="dialog" aria-modal="true" aria-labelledby="busyPromptTitle" aria-describedby="busyPromptDescription">
      <header class="modal-header">
        <div>
          <h2 id="busyPromptTitle">Agent is busy</h2>
          <p id="busyPromptDescription">Choose whether to interrupt with steer or queue this as a follow-up.</p>
        </div>
        <button id="busyPromptClose" class="modal-close" type="button" aria-label="Cancel busy prompt">×</button>
      </header>
      <div class="busy-prompt-body">
        <label for="busyPromptText">Prompt to send</label>
        <textarea id="busyPromptText" class="busy-prompt-text" readonly spellcheck="false"></textarea>
        <p id="busyPromptAttachmentNote" class="busy-prompt-attachment-note"></p>
      </div>
      <footer class="modal-footer">
        <span></span>
        <div class="modal-actions">
          <button id="busyPromptCancel" type="button">Cancel</button>
          <button id="busyPromptSteer" type="button">Steer</button>
          <button id="busyPromptFollowUp" type="button">Follow-up</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="modelPickerOverlay" class="modal-overlay" hidden>
    <section class="model-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="modelPickerTitle">
      <header class="modal-header">
        <div>
          <h2 id="modelPickerTitle">Choose model</h2>
          <p id="modelPickerSubtitle">Select a model for the active OMP session.</p>
        </div>
        <button id="modelPickerClose" class="modal-close" type="button" aria-label="Close model picker">×</button>
      </header>
      <input id="modelPickerSearch" class="model-picker-search" autocomplete="off" spellcheck="false" placeholder="Filter by provider, model, or name" />
      <div id="modelPickerList" class="model-picker-list" role="listbox" tabindex="0"></div>
      <footer class="modal-footer">
        <span id="modelPickerStatus" class="model-picker-status"></span>
        <div class="modal-actions">
          <button id="modelPickerCancel" type="button">Cancel</button>
          <button id="modelPickerSelect" type="button">Use selected model</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="rollbackChatOverlay" class="modal-overlay" hidden>
    <section class="rollback-chat modal-panel" role="dialog" aria-modal="true" aria-labelledby="rollbackChatTitle" aria-describedby="rollbackChatDescription">
      <header class="modal-header">
        <div>
          <h2 id="rollbackChatTitle">Rollback chat</h2>
          <p id="rollbackChatDescription">Create a new branch before an earlier prompt and restore that prompt as an unsent draft. The current chat remains in session history. Files and worktree are not rolled back.</p>
        </div>
        <button id="rollbackChatClose" class="modal-close" type="button" aria-label="Close rollback chat">×</button>
      </header>
      <div class="rollback-chat-body">
        <p id="rollbackChatWarning" class="rollback-chat-warning" role="note" hidden>Your current draft and attachments will be replaced after a successful rollback.</p>
        <div class="rollback-chat-feedback">
          <p id="rollbackChatStatus" class="modal-status" aria-live="polite"></p>
          <button id="rollbackChatRetry" type="button" hidden>Retry</button>
        </div>
        <div id="rollbackChatList" class="rollback-chat-list" role="listbox" aria-label="Earlier user prompts" tabindex="0"></div>
      </div>
      <footer class="modal-footer">
        <span></span>
        <div class="modal-actions">
          <button id="rollbackChatCancel" type="button">Cancel</button>
          <button id="rollbackChatRestore" type="button">Restore draft</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="commandsPopupOverlay" class="modal-overlay" hidden>
    <section class="commands-popup modal-panel" role="dialog" aria-modal="true" aria-labelledby="commandsPopupTitle">
      <header class="modal-header">
        <div>
          <h2 id="commandsPopupTitle">Commands</h2>
          <p>Slash commands available in this session. Click to insert.</p>
        </div>
        <button id="commandsPopupClose" class="modal-close" type="button" aria-label="Close commands">×</button>
      </header>
      <input id="commandsPopupSearch" class="model-picker-search" autocomplete="off" spellcheck="false" placeholder="Filter commands and skills" />
      <div id="commandsPopupList" class="model-picker-list" role="listbox" tabindex="0"></div>
    </section>
  </div>

  <div id="proposedModelsOverlay" class="modal-overlay" hidden>
    <section class="proposed-model-dialog modal-panel" role="dialog" aria-modal="true" aria-labelledby="proposedModelsTitle">
      <header class="modal-header">
        <div>
          <h2 id="proposedModelsTitle">Model templates</h2>
          <p>Configure reusable model presets for new sessions.</p>
        </div>
        <button id="proposedModelsClose" class="modal-close" type="button" aria-label="Close model templates">×</button>
      </header>
      <div class="proposed-model-dialog-body">
        <div id="proposedModelsList" class="proposed-models-list"></div>
        <button id="proposedModelAdd" type="button">Add model template</button>
        <div id="proposedModelForm" class="proposed-model-form" hidden>
          <label for="proposedModelNameInput">Template name</label>
          <input id="proposedModelNameInput" autocomplete="off" spellcheck="false" placeholder="Fast review" />
          <label for="proposedModelSearchInput">Runtime model</label>
          <input id="proposedModelSearchInput" autocomplete="off" spellcheck="false" placeholder="Search OMP models" />
          <div id="proposedModelCatalogList" class="proposed-model-catalog" role="listbox"></div>
          <label for="proposedModelThinkingSelect">Thinking</label>
          <select id="proposedModelThinkingSelect"></select>
          <div class="proposed-model-actions">
            <button id="proposedModelSave" type="button">Save</button>
            <button id="proposedModelCancel" type="button">Cancel</button>
          </div>
        </div>
      </div>
      <footer class="modal-footer">
        <span id="proposedModelStatus" class="workspace-option-status" aria-live="polite"></span>
        <div class="modal-actions">
          <button id="proposedModelsDone" type="button">Done</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="presetsOverlay" class="modal-overlay" hidden>
    <section class="presets-dialog modal-panel" role="dialog" aria-modal="true" aria-labelledby="presetsTitle">
      <header class="modal-header">
        <div>
          <h2 id="presetsTitle">Presets</h2>
          <p id="presetsSubtitle">Run a saved prompt preset.</p>
        </div>
        <button id="presetsClose" class="modal-close" type="button" aria-label="Close presets">×</button>
      </header>
      <div id="presetsBody" class="presets-body"></div>
      <footer class="modal-footer">
        <span id="presetsStatus" class="modal-status" aria-live="polite" aria-atomic="true"></span>
        <div id="presetsActions" class="modal-actions"></div>
      </footer>
    </section>
  </div>

  <div id="cwdPickerOverlay" class="modal-overlay" hidden>
    <section class="cwd-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="cwdPickerTitle">
      <header class="modal-header">
        <div>
          <h2 id="cwdPickerTitle">New session</h2>
          <p id="cwdPickerDescription">Choose the working directory for the new OMP session. Optionally create a git worktree first.</p>
        </div>
        <button id="cwdPickerClose" class="modal-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="modal-tabs" role="tablist" aria-label="New session mode">
        <button id="cwdPickerSessionTab" type="button" class="active" role="tab" aria-selected="true" aria-controls="cwdPickerSessionBody">Session</button>
        <button id="cwdPickerDiffTab" type="button" role="tab" aria-selected="false" aria-controls="cwdPickerDiffBody">Diff</button>
      </div>
      <div id="cwdPickerSessionBody" class="cwd-picker-body" role="tabpanel" aria-labelledby="cwdPickerSessionTab">
        <label for="cwdPickerNameInput">Session name</label>
        <input id="cwdPickerNameInput" autocomplete="off" spellcheck="false" placeholder="my-project" />
        <label for="cwdPickerCategoryInput">Category <span class="optional-label">optional</span></label>
        <div class="category-combobox">
          <input id="cwdPickerCategoryInput" autocomplete="off" spellcheck="false" maxlength="80" placeholder="infra, client, research…" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="cwdPickerCategorySuggestions" />
          <div id="cwdPickerCategorySuggestions" class="category-suggestions" role="listbox" hidden></div>
        </div>
        <label id="cwdPickerInputLabel" for="cwdPickerInput">Working directory</label>
        <input id="cwdPickerInput" autocomplete="off" spellcheck="false" placeholder="/home/user/project" />
        <p id="cwdPickerInputHelp" class="field-help">For a normal session, this is the directory where OMP starts.</p>
        <label for="cwdPickerProposedModel">Model</label>
        <select id="cwdPickerProposedModel"></select>
        <label class="checkbox-row" for="cwdPickerWorktreeEnabled">
          <input id="cwdPickerWorktreeEnabled" type="checkbox" />
          <span>Add worktree</span>
        </label>
        <div id="cwdPickerWorktreeFields" class="worktree-fields" hidden>
          <label for="cwdPickerWorktreeSourceRepo">Source repo root</label>
          <input id="cwdPickerWorktreeSourceRepo" autocomplete="off" spellcheck="false" placeholder="/home/user/project" />
          <p class="field-help">Must be the repo root containing .git. Fura runs git worktree add from this repo.</p>
          <label for="cwdPickerWorktreeBase">Base branch/ref</label>
          <input id="cwdPickerWorktreeBase" autocomplete="off" spellcheck="false" placeholder="main" />
          <label for="cwdPickerWorktreeBranch">Branch name <span class="optional-label">optional</span></label>
          <input id="cwdPickerWorktreeBranch" autocomplete="off" spellcheck="false" placeholder="feature/my-work" />
          <p class="field-help">Must be a valid Git branch name. Leave blank to use the selected base ref directly.</p>
          <p id="cwdPickerWorktreeSummary" class="field-help worktree-summary"></p>
        </div>
      </div>
      <div id="cwdPickerDiffBody" class="cwd-picker-body" role="tabpanel" aria-labelledby="cwdPickerDiffTab" hidden>
        <label for="cwdPickerDiffRepo">Repository root</label>
        <input id="cwdPickerDiffRepo" autocomplete="off" spellcheck="false" placeholder="/home/user/project" />
        <label for="cwdPickerDiffBase">Base ref</label>
        <input id="cwdPickerDiffBase" autocomplete="off" spellcheck="false" placeholder="main" />
        <label id="cwdPickerDiffOldLabel" for="cwdPickerDiffOld" hidden>Old</label>
        <input id="cwdPickerDiffOld" autocomplete="off" spellcheck="false" value="@{u}" hidden />
        <label for="cwdPickerDiffHead">Head ref</label>
        <input id="cwdPickerDiffHead" autocomplete="off" spellcheck="false" placeholder="feature/my-branch" />
        <label for="cwdPickerDiffMode">Diff mode</label>
        <select id="cwdPickerDiffMode">
          <option value="full">Full</option>
          <option value="stat">Stat</option>
          <option value="rangeDiff">Range-diff</option>
        </select>
        <label class="checkbox-row" for="cwdPickerDiffAgentSession">
          <input id="cwdPickerDiffAgentSession" type="checkbox" checked />
          <span>Create/attach agent session for questions</span>
        </label>
        <p id="cwdPickerDiffAgentHelp" class="field-help">Questions from the diff use the normal prompt channel of the backing session.</p>
      </div>
      <footer class="modal-footer">
        <span id="cwdPickerStatus" class="modal-status" aria-live="polite" aria-atomic="true"></span>
        <div class="modal-actions">
          <button id="cwdPickerCancel" type="button">Cancel</button>
          <button id="cwdPickerCreate" type="button">Create session</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="deleteSessionOverlay" class="modal-overlay" hidden>
    <section class="delete-session-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="deleteSessionTitle">
      <header class="modal-header">
        <div>
          <h2 id="deleteSessionTitle">Delete session</h2>
          <p id="deleteSessionSubtitle">Stop this session and delete its OMP session file.</p>
        </div>
        <button id="deleteSessionClose" class="modal-close" type="button" aria-label="Close delete session dialog">×</button>
      </header>
      <div class="delete-session-body">
        <p id="deleteSessionMessage"></p>
        <label class="checkbox-row" for="deleteSessionWorktree">
          <input id="deleteSessionWorktree" type="checkbox" />
          <span>Also delete the linked git worktree directory</span>
        </label>
        <p id="deleteSessionWorktreePath" class="field-help"></p>
      </div>
      <footer class="modal-footer">
        <span></span>
        <div class="modal-actions">
          <button id="deleteSessionCancel" type="button">Cancel</button>
          <button id="deleteSessionConfirm" class="danger-action" type="button">Delete session</button>
        </div>
      </footer>
    </section>
  </div>


  <div id="handoffPickerOverlay" class="modal-overlay" hidden>
    <section class="handoff-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="handoffPickerTitle">
      <header class="modal-header">
        <div>
          <h2 id="handoffPickerTitle">Handoff session</h2>
          <p>Name the new session and optionally provide focus instructions.</p>
        </div>
        <button id="handoffPickerClose" class="modal-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="cwd-picker-body">
        <label for="handoffPickerNameInput">Session name</label>
        <input id="handoffPickerNameInput" autocomplete="off" spellcheck="false" placeholder="my-handoff" />
        <label for="handoffPickerInstructions">Focus instructions <span class="label-optional">(optional)</span></label>
        <textarea id="handoffPickerInstructions" rows="3" placeholder="Focus on the authentication module…"></textarea>
      </div>
      <footer class="modal-footer">
        <span></span>
        <div class="modal-actions">
          <button id="handoffPickerCancel" type="button">Cancel</button>
          <button id="handoffPickerCreate" type="button">Handoff</button>
        </div>
      </footer>
    </section>
  </div>

  <div id="diffPreviewOverlay" class="modal-overlay" hidden>
    <section class="diff-preview modal-panel" role="dialog" aria-modal="true" aria-labelledby="diffPreviewTitle">
      <header class="modal-header">
        <div>
          <h2 id="diffPreviewTitle">Preview diff comments</h2>
          <p id="diffPreviewSubtitle">Review the prompt that will be sent to OMP.</p>
        </div>
        <button id="diffPreviewClose" class="modal-close" type="button" aria-label="Close">×</button>
      </header>
      <textarea id="diffPreviewText" class="diff-preview-text" readonly spellcheck="false"></textarea>
      <footer class="modal-footer">
        <span id="diffPreviewStatus" class="diff-preview-status"></span>
        <div class="modal-actions">
          <button id="diffPreviewCancel" type="button">Cancel</button>
          <button id="diffPreviewSend" type="button">Send comments</button>
        </div>
      </footer>
    </section>
  </div>
`;

const authGate = requireElement<HTMLDivElement>("authGate");
const authForm = requireElement<HTMLFormElement>("authForm");
const authTokenInput = requireElement<HTMLInputElement>("authTokenInput");
const authStatus = requireElement<HTMLParagraphElement>("authStatus");
const authSubmit = requireElement<HTMLButtonElement>("authSubmit");
const connectionStatus = requireElement<HTMLSpanElement>("connectionStatus");
const createSessionButton = requireElement<HTMLButtonElement>("createSessionButton");
const sessionsList = requireElement<HTMLElement>("sessionsList");
const sessionCategoryFilter = requireElement<HTMLSelectElement>("sessionCategoryFilter");
const askFuraButton = requireElement<HTMLButtonElement>("askFuraButton");
const workspaceOptionsToggle = requireElement<HTMLButtonElement>("workspaceOptionsToggle");
const workspaceOptionsMenu = requireElement<HTMLDivElement>("workspaceOptionsMenu");
const sessionTitle = requireElement<HTMLHeadingElement>("sessionTitle");
const sessionMeta = requireElement<HTMLParagraphElement>("sessionMeta");
const statusBar = requireElement<HTMLDivElement>("statusBar");
const promptForm = requireElement<HTMLFormElement>("promptForm");
const promptInput = requireElement<HTMLTextAreaElement>("promptInput");
const toolVisibilityToggle = requireElement<HTMLButtonElement>("toolVisibilityToggle");
const editDiffVisibilityToggle = requireElement<HTMLButtonElement>("editDiffVisibilityToggle");
const thinkingVisibilityToggle = requireElement<HTMLButtonElement>("thinkingVisibilityToggle");
const proposedModelsOpen = requireElement<HTMLButtonElement>("proposedModelsOpen");
const proposedModelsOverlay = requireElement<HTMLDivElement>("proposedModelsOverlay");
const proposedModelsClose = requireElement<HTMLButtonElement>("proposedModelsClose");
const proposedModelsDone = requireElement<HTMLButtonElement>("proposedModelsDone");
const proposedModelsList = requireElement<HTMLDivElement>("proposedModelsList");
const proposedModelAdd = requireElement<HTMLButtonElement>("proposedModelAdd");
const proposedModelForm = requireElement<HTMLDivElement>("proposedModelForm");
const proposedModelNameInput = requireElement<HTMLInputElement>("proposedModelNameInput");
const proposedModelSearchInput = requireElement<HTMLInputElement>("proposedModelSearchInput");
const proposedModelCatalogList = requireElement<HTMLDivElement>("proposedModelCatalogList");
const proposedModelThinkingSelect = requireElement<HTMLSelectElement>("proposedModelThinkingSelect");
const proposedModelSave = requireElement<HTMLButtonElement>("proposedModelSave");
const proposedModelCancel = requireElement<HTMLButtonElement>("proposedModelCancel");
const proposedModelStatus = requireElement<HTMLSpanElement>("proposedModelStatus");
const presetsOverlay = requireElement<HTMLDivElement>("presetsOverlay");
const presetsClose = requireElement<HTMLButtonElement>("presetsClose");
const presetsTitle = requireElement<HTMLHeadingElement>("presetsTitle");
const presetsSubtitle = requireElement<HTMLParagraphElement>("presetsSubtitle");
const presetsBody = requireElement<HTMLDivElement>("presetsBody");
const presetsStatus = requireElement<HTMLSpanElement>("presetsStatus");
const presetsActions = requireElement<HTMLDivElement>("presetsActions");
const abortButton = requireElement<HTMLButtonElement>("abortButton");
const stopButton = requireElement<HTMLButtonElement>("stopButton");
const deleteSessionButton = requireElement<HTMLButtonElement>("deleteSessionButton");
const rollbackChatButton = requireElement<HTMLButtonElement>("rollbackChatButton");
const duplicateSessionButton = requireElement<HTMLButtonElement>("duplicateSessionButton");
const rollbackChatOverlay = requireElement<HTMLDivElement>("rollbackChatOverlay");
const rollbackChatClose = requireElement<HTMLButtonElement>("rollbackChatClose");
const rollbackChatWarning = requireElement<HTMLParagraphElement>("rollbackChatWarning");
const rollbackChatStatus = requireElement<HTMLParagraphElement>("rollbackChatStatus");
const rollbackChatRetry = requireElement<HTMLButtonElement>("rollbackChatRetry");
const rollbackChatList = requireElement<HTMLDivElement>("rollbackChatList");
const rollbackChatCancel = requireElement<HTMLButtonElement>("rollbackChatCancel");
const rollbackChatRestore = requireElement<HTMLButtonElement>("rollbackChatRestore");
const activeCategoryInput = requireElement<HTMLInputElement>("activeCategoryInput");
const activeCategorySuggestions = requireElement<HTMLDivElement>("activeCategorySuggestions");
const activeCategorySave = requireElement<HTMLButtonElement>("activeCategorySave");
const commandPalette = requireElement<HTMLDivElement>("commandPalette");
const imagePreviews = requireElement<HTMLDivElement>("imagePreviews");
const busyPromptOverlay = requireElement<HTMLDivElement>("busyPromptOverlay");
const busyPromptClose = requireElement<HTMLButtonElement>("busyPromptClose");
const busyPromptText = requireElement<HTMLTextAreaElement>("busyPromptText");
const busyPromptAttachmentNote = requireElement<HTMLParagraphElement>("busyPromptAttachmentNote");
const busyPromptCancel = requireElement<HTMLButtonElement>("busyPromptCancel");
const busyPromptSteer = requireElement<HTMLButtonElement>("busyPromptSteer");
const busyPromptFollowUp = requireElement<HTMLButtonElement>("busyPromptFollowUp");
const voiceButton = requireElement<HTMLButtonElement>("voiceButton");
const voiceStatus = requireElement<HTMLSpanElement>("voiceStatus");
const sendButton = requireElement<HTMLButtonElement>("sendButton");
const modelPickerOverlay = requireElement<HTMLDivElement>("modelPickerOverlay");
const modelPickerClose = requireElement<HTMLButtonElement>("modelPickerClose");
const modelPickerSearch = requireElement<HTMLInputElement>("modelPickerSearch");
const modelPickerList = requireElement<HTMLDivElement>("modelPickerList");
const modelPickerStatus = requireElement<HTMLSpanElement>("modelPickerStatus");
const modelPickerCancel = requireElement<HTMLButtonElement>("modelPickerCancel");
const modelPickerSelect = requireElement<HTMLButtonElement>("modelPickerSelect");
const commandsPopupOverlay = requireElement<HTMLDivElement>("commandsPopupOverlay");
const commandsPopupClose = requireElement<HTMLButtonElement>("commandsPopupClose");
const commandsPopupSearch = requireElement<HTMLInputElement>("commandsPopupSearch");
const commandsPopupList = requireElement<HTMLDivElement>("commandsPopupList");
const cwdPickerOverlay = requireElement<HTMLDivElement>("cwdPickerOverlay");
const cwdPickerClose = requireElement<HTMLButtonElement>("cwdPickerClose");
const cwdPickerTitle = requireElement<HTMLHeadingElement>("cwdPickerTitle");
const cwdPickerDescription = requireElement<HTMLParagraphElement>("cwdPickerDescription");
const cwdPickerNameInput = requireElement<HTMLInputElement>("cwdPickerNameInput");
const cwdPickerCategoryInput = requireElement<HTMLInputElement>("cwdPickerCategoryInput");
const cwdPickerCategorySuggestions = requireElement<HTMLDivElement>("cwdPickerCategorySuggestions");
const cwdPickerInput = requireElement<HTMLInputElement>("cwdPickerInput");
const cwdPickerSessionBody = requireElement<HTMLDivElement>("cwdPickerSessionBody");
const cwdPickerInputLabel = requireElement<HTMLLabelElement>("cwdPickerInputLabel");
const cwdPickerInputHelp = requireElement<HTMLParagraphElement>("cwdPickerInputHelp");
const cwdPickerProposedModel = requireElement<HTMLSelectElement>("cwdPickerProposedModel");
const cwdPickerCancel = requireElement<HTMLButtonElement>("cwdPickerCancel");
const cwdPickerCreate = requireElement<HTMLButtonElement>("cwdPickerCreate");
const cwdPickerStatus = requireElement<HTMLSpanElement>("cwdPickerStatus");
const cwdPickerWorktreeEnabled = requireElement<HTMLInputElement>("cwdPickerWorktreeEnabled");
const cwdPickerWorktreeFields = requireElement<HTMLDivElement>("cwdPickerWorktreeFields");
const cwdPickerWorktreeSourceRepo = requireElement<HTMLInputElement>("cwdPickerWorktreeSourceRepo");
const cwdPickerWorktreeBase = requireElement<HTMLInputElement>("cwdPickerWorktreeBase");
const cwdPickerWorktreeBranch = requireElement<HTMLInputElement>("cwdPickerWorktreeBranch");
const cwdPickerWorktreeSummary = requireElement<HTMLParagraphElement>("cwdPickerWorktreeSummary");
const cwdPickerSessionTab = requireElement<HTMLButtonElement>("cwdPickerSessionTab");
const cwdPickerDiffTab = requireElement<HTMLButtonElement>("cwdPickerDiffTab");
const cwdPickerDiffBody = requireElement<HTMLDivElement>("cwdPickerDiffBody");
const cwdPickerDiffRepo = requireElement<HTMLInputElement>("cwdPickerDiffRepo");
const cwdPickerDiffBase = requireElement<HTMLInputElement>("cwdPickerDiffBase");
const cwdPickerDiffOld = requireElement<HTMLInputElement>("cwdPickerDiffOld");
const cwdPickerDiffHead = requireElement<HTMLInputElement>("cwdPickerDiffHead");
const cwdPickerDiffMode = requireElement<HTMLSelectElement>("cwdPickerDiffMode");
const cwdPickerDiffAgentSession = requireElement<HTMLInputElement>("cwdPickerDiffAgentSession");
const deleteSessionOverlay = requireElement<HTMLDivElement>("deleteSessionOverlay");
const deleteSessionClose = requireElement<HTMLButtonElement>("deleteSessionClose");
const deleteSessionMessage = requireElement<HTMLParagraphElement>("deleteSessionMessage");
const deleteSessionWorktree = requireElement<HTMLInputElement>("deleteSessionWorktree");
const deleteSessionWorktreePath = requireElement<HTMLParagraphElement>("deleteSessionWorktreePath");
const deleteSessionCancel = requireElement<HTMLButtonElement>("deleteSessionCancel");
const deleteSessionConfirm = requireElement<HTMLButtonElement>("deleteSessionConfirm");
const handoffPickerOverlay = requireElement<HTMLDivElement>("handoffPickerOverlay");
const handoffPickerClose = requireElement<HTMLButtonElement>("handoffPickerClose");
const handoffPickerNameInput = requireElement<HTMLInputElement>("handoffPickerNameInput");
const handoffPickerInstructions = requireElement<HTMLTextAreaElement>("handoffPickerInstructions");
const handoffPickerCancel = requireElement<HTMLButtonElement>("handoffPickerCancel");
const handoffPickerCreate = requireElement<HTMLButtonElement>("handoffPickerCreate");
const diffPreviewOverlay = requireElement<HTMLDivElement>("diffPreviewOverlay");
const diffPreviewClose = requireElement<HTMLButtonElement>("diffPreviewClose");
const diffPreviewTitle = requireElement<HTMLHeadingElement>("diffPreviewTitle");
const diffPreviewSubtitle = requireElement<HTMLParagraphElement>("diffPreviewSubtitle");
const diffPreviewText = requireElement<HTMLTextAreaElement>("diffPreviewText");
const diffPreviewStatus = requireElement<HTMLSpanElement>("diffPreviewStatus");
const diffPreviewCancel = requireElement<HTMLButtonElement>("diffPreviewCancel");
const diffPreviewSend = requireElement<HTMLButtonElement>("diffPreviewSend");

type TranscriptPreviewDraft = {
  sessionId: string;
  message: TranscriptMessage;
  comments: TranscriptReviewComment[];
  promptText?: string;
};
type SessionCodeComments = Map<string, CodeFileComment[]>;
type SessionNotice = { level: string; text: string };
type ControlChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  candidates?: ControlCandidate[];
  suggestedActions?: ControlSuggestedAction[];
};
type VoiceSegmentDraft = {
  target: HTMLInputElement | HTMLTextAreaElement;
  start: number;
  end: number;
  text: string;
  composer?: { key: ComposerDraftKey; draft: SessionComposerDraft };
};
const composerDrafts = new SessionComposerDrafts();
let composerDraftKey: ComposerDraftKey = NO_SESSION_DRAFT;
let composerDraft = composerDrafts.get(composerDraftKey);
let pendingImages = composerDraft.images;
let pendingSnippets = composerDraft.snippets;
const pendingDraftDeletions = new Set<string>();
let voiceComposerDraft: VoiceSegmentDraft["composer"];
let nextPendingAttachmentId = 1;

let connection: FuraConnection | null = null;
let activeSessionId: string | null = null;
let serverConfig: ServerConfig | null = null;
let pendingCreatedSessionBaseline: Set<string> | null = null;
let pendingSessionSelectionId: string | null = null;
let pendingSessionFork: { requestId: string; sourceSessionId: string } | null = null;
let cwdPickerCreatePending = false;
let cwdPickerPendingRequestId: string | null = null;
let cwdPickerMode: "session" | "diff" = "session";
let pendingDiffCreate: { repoRoot: string; base: string; head: string; payloadKind: DiffDetailMode } | null = null;
let deleteSessionTarget: SessionDeleteView | null = null;
let cwdPickerSourceRepoAutofill = true;
let cwdPickerDirectoryAutofill = true;
let cwdPickerBranchAutofill = true;
let cwdPickerBaseBranchAutofill = true;
let lastAutofilledWorktreeDirectory = "";
let lastAutofilledWorktreeBranch = "";
const unreadSessions = new Set<string>();
let sessions: SessionSummary[] = [];
let workspaceMode: WorkspaceMode = "session";
let selectedCategoryFilter = "";
let activeCategoryEditorDirty = false;
let activeCategoryEditorSessionId: string | null = null;
let lastRenderedSessionId: string | null = null;
let transcriptPanelDirty = true;
let toolsPanelDirty = true;
let lastTranscriptRenderedSessionId: string | null = null;
let lastToolsRenderedSessionId: string | null = null;
let transcriptRenderRevision = 0;
const transcriptRenderCaches = new WeakMap<HTMLElement, CachedPanelRenderState>();
const visiblePlanReviews = new Map<string, VisiblePlanReview>();
const toolsRenderCaches = new WeakMap<HTMLElement, CachedPanelRenderState>();
let paletteCommands: SlashCommandSpec[] = [];
let paletteSelectedIndex = -1;
let cwdCategoryCombobox: CategoryCombobox;
let activeCategoryCombobox: CategoryCombobox;
let proposedModelCatalog: ModelSummary[] = [];
let proposedModelCatalogLoading = false;
let proposedModelCatalogRequestId: string | null = null;
let proposedModelCatalogSelectedIndex = 0;
let proposedModelFormOpen = false;
let proposedModelSavePending = false;
let proposedModelEditingId: string | null = null;
let presetsView: "picker" | "run" | "editor" = "picker";
let presetRunTarget: PresetSummary | null = null;
let presetRunFromPicker = false;
let presetRunValues: Record<string, string> = {};
let presetEditorOriginalName: string | null = null;
let presetEditorDefaults: Record<string, string> = {};
let presetPending: { kind: "save" | "delete"; name: string } | null = null;
let pendingPresetCommand: { editorText: string; sessionId: string } | null = null;
let projections = new Map<string, SessionProjection>();
let pendingRestoreAfterSessionsSnapshot = false;
const sessionChangesStates = new Map<string, SessionChangesSummaryState>();
const sessionChangesPayloadKinds = new Map<string, DiffDetailMode>();
const sessionChangesKinds = new Map<string, GitChangeKind>();
const sessionChangesRepoIds = new Map<string, string>();
const sessionChangesDiffIds = new Map<string, string>();
const sessionChangesSelectedFiles = new Map<string, string>();
const staleSessionChanges = new Set<string>();
let currentSessionChangesRequest: { sessionId: string; diffId: string } | null = null;
const gitHistoryStates = new Map<string, GitHistoryState>();
const restoredGitReviewSessions = new Set<string>();
let pendingGitHistory: { sessionId: string; state: GitHistoryState } | null = null;
let pendingGitFile: { requestId: string; repoRoot: string; commitOid: string; path: string; loading: boolean; sent: boolean; view: ReturnType<typeof openCommittedFileView> } | null = null;
let compareDiffState: CompareDiffSummaryState | null = null;
let compareDiffId: string | null = null;
let compareDiffLoading = false;
let compareRepoRoot = "";
let compareBaseRef = "HEAD";
let compareHeadRef = "WORKTREE";
type PendingDiffFilePatchRequest = { diffId: string; comparisonKey: string; filePath: string | null };
type DiffFilePatchError = { filePath: string | null; message: string };
let comparePayloadKind: DiffDetailMode = "filePatch";
let compareMode: "files" | "rangeDiff" = "files";
type RangeDiffInputs = { repoRoot: string; base: string; old: string; new: string; ignoreWhitespace: boolean };
let rangeDiffInputs: RangeDiffInputs = { repoRoot: "", base: "", old: "@{u}", new: "HEAD", ignoreWhitespace: false };
let pendingRangeDiff: { requestId: string; inputs: RangeDiffInputs } | null = null;
let rangeDiffResult: GitRangeDiffResult | null = null;
let rangeDiffError: string | null = null;
let rangeDiffBody: HTMLElement | null = null;
let ordinaryPickerRefs = { base: "HEAD", head: "HEAD" };
let comparePanelDirty = true;
const diffFileFilters = new Map<string, string>();
const diffAnnotations = new Map<string, DiffReviewAnnotation[]>();
const reviewComments = new Map<string, ReviewComment[]>();
const reviewCommentsRequested = new Set<string>();
const reviewCommentsLoadInFlight = new Set<string>();
const reviewCommentsResyncNeeded = new Set<string>();
type ActiveReviewCommentComposer =
  | {
      mode: "create";
      sessionId: string;
      comparisonKey: string;
      anchor: DiffLineLocation;
      body: string;
    }
  | {
      mode: "edit";
      sessionId: string;
      commentId: string;
      body: string;
    };
let activeReviewCommentComposer: ActiveReviewCommentComposer | null = null;
const diffErrors = new Map<string, string>();
const diffLoadingSessions = new Set<string>();
let diffPanelDirty = true;
type CachedDiffPatch = { patch: string; truncated: boolean; rows: DiffRow[]; contextLines: number };
const diffPatchCache = new Map<string, CachedDiffPatch>();
const pendingDiffFilePatches = new Map<string, PendingDiffFilePatchRequest>();
const diffFilePatchErrors = new Map<string, DiffFilePatchError>();
type DiffFileMenuState = { annotationKey: string; filePath: string };
let openDiffFileMenu: DiffFileMenuState | null = null;

function randomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

const diffClientId = (() => {
  const key = "fura.diff.clientId";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const next = randomUuid();
  sessionStorage.setItem(key, next);
  return next;
})();

function newDiffId(): string {
  return randomUuid();
}

function diffPatchCacheKey(comparisonKey: string, filePath: string | null): string {
  return `${comparisonKey}\0${filePath ?? ""}`;
}

function patchCacheComparisonKey(cacheKey: string): string {
  const separator = cacheKey.indexOf("\0");
  return separator === -1 ? cacheKey : cacheKey.slice(0, separator);
}

function currentDiffComparisonKeys(): Set<string> {
  const keys = new Set<string>();
  const sessionState = currentSessionChangesRequest ? sessionChangesStates.get(currentSessionChangesRequest.sessionId) : undefined;
  if (sessionState?.status === "ready") keys.add(sessionState.comparison.comparisonKey);
  if (compareDiffState) keys.add(compareDiffState.comparison.comparisonKey);
  return keys;
}

function pruneDiffPatchCache(keepKeys = currentDiffComparisonKeys()): void {
  for (const cacheKey of [...diffPatchCache.keys()]) {
    if (!keepKeys.has(patchCacheComparisonKey(cacheKey))) diffPatchCache.delete(cacheKey);
  }
}

function clearDiffPatchCacheForComparison(comparisonKey: string | null | undefined): void {
  if (!comparisonKey) return;
  for (const cacheKey of [...diffPatchCache.keys()]) {
    if (patchCacheComparisonKey(cacheKey) === comparisonKey) diffPatchCache.delete(cacheKey);
  }
}

function rememberDiffPatch(key: string, value: CachedDiffPatch): void {
  diffPatchCache.set(key, value);
  let totalBytes = 0;
  for (const entry of diffPatchCache.values()) totalBytes += entry.patch.length;
  while (diffPatchCache.size > 20 || totalBytes > 8 * 1024 * 1024) {
    const oldest = diffPatchCache.keys().next().value;
    if (!oldest) break;
    const removed = diffPatchCache.get(oldest);
    diffPatchCache.delete(oldest);
    totalBytes -= removed?.patch.length ?? 0;
  }
}

function pendingDiffFilePatchMatches(panelKey: string, diffId: string, key: string, filePath: string | null): boolean {
  const pending = pendingDiffFilePatches.get(panelKey);
  return Boolean(pending && pending.diffId === diffId && pending.comparisonKey === key && pending.filePath === filePath);
}

function clearPendingDiffFilePatch(panelKey: string, diffId?: string): void {
  const pending = pendingDiffFilePatches.get(panelKey);
  if (!pending || (diffId && pending.diffId !== diffId)) return;
  pendingDiffFilePatches.delete(panelKey);
}

function selectedDiffFilePatchError(panelKey: string, filePath: string | null): string | null {
  const error = diffFilePatchErrors.get(panelKey);
  return error?.filePath === filePath ? error.message : null;
}
function setCurrentSessionChangesRequest(sessionId: string, diffId: string, reason: "replaced" | "closed" | "sessionChanged" | "repoChanged" | "refsChanged" | "payloadChanged" | "refreshed"): void {
  if (currentSessionChangesRequest && currentSessionChangesRequest.diffId !== diffId) {
    send({ type: "diff.cancel", clientId: diffClientId, diffId: currentSessionChangesRequest.diffId, scope: "sessionChanges", reason });
    diffLoadingSessions.delete(currentSessionChangesRequest.sessionId);
    clearPendingDiffFilePatch(currentSessionChangesRequest.sessionId, currentSessionChangesRequest.diffId);
    diffFilePatchErrors.delete(currentSessionChangesRequest.sessionId);
  }
  currentSessionChangesRequest = { sessionId, diffId };
}

function clearCurrentSessionChangesRequest(reason: "replaced" | "closed" | "sessionChanged" | "repoChanged" | "refsChanged" | "payloadChanged" | "refreshed"): void {
  if (currentSessionChangesRequest) {
    send({ type: "diff.cancel", clientId: diffClientId, diffId: currentSessionChangesRequest.diffId, scope: "sessionChanges", reason });
    diffLoadingSessions.delete(currentSessionChangesRequest.sessionId);
    clearPendingDiffFilePatch(currentSessionChangesRequest.sessionId, currentSessionChangesRequest.diffId);
    diffFilePatchErrors.delete(currentSessionChangesRequest.sessionId);
    currentSessionChangesRequest = null;
    pruneDiffPatchCache();
  }
}

function setCurrentCompareDiff(diffId: string, reason: "replaced" | "closed" | "sessionChanged" | "repoChanged" | "refsChanged" | "payloadChanged" | "refreshed"): void {
  if (compareDiffId && compareDiffId !== diffId) {
    send({ type: "diff.cancel", clientId: diffClientId, diffId: compareDiffId, scope: "compareDiff", reason });
    clearPendingDiffFilePatch("compareDiff", compareDiffId);
    diffFilePatchErrors.delete("compareDiff");
  }
  compareDiffId = diffId;
}

function clearCurrentCompareDiff(reason: "replaced" | "closed" | "sessionChanged" | "repoChanged" | "refsChanged" | "payloadChanged" | "refreshed"): void {
  if (compareDiffId) {
    send({ type: "diff.cancel", clientId: diffClientId, diffId: compareDiffId, scope: "compareDiff", reason });
    clearPendingDiffFilePatch("compareDiff", compareDiffId);
    compareDiffId = null;
  }
  compareDiffState = null;
  compareDiffLoading = false;
  sessionChangesSelectedFiles.delete("compareDiff");
  diffErrors.delete("compareDiff");
  diffFilePatchErrors.delete("compareDiff");
  pruneDiffPatchCache();
}

function selectedDiffFilePath(key: string, state: DiffReviewableState, filePaths: string[]): string | null {
  const requestedPath = state.comparison.selectedFile?.newPath ?? null;
  const rememberedPath = sessionChangesSelectedFiles.get(key) ?? null;
  const nextPath = [requestedPath, rememberedPath].find(
    (candidate): candidate is string => candidate !== null && filePaths.includes(candidate),
  ) ?? null;
  if (nextPath) sessionChangesSelectedFiles.set(key, nextPath);
  else sessionChangesSelectedFiles.delete(key);
  return nextPath;
}
let lastDiffsRenderedSessionId: string | null = null;
let lastDiffsRenderedProjectionPresent = false;
const sessionNotices = new Map<string, SessionNotice[]>();
const busyPromptDrafts = new Map<string, BusyPromptDraft[]>();
type RollbackChatPhase = "loading" | "ready" | "error" | "applying";
type RollbackChatDraft = {
  text: string;
  images: PendingImage[];
  snippets: PendingSnippet[];
};
type RollbackChatState = {
  sourceSessionId: string;
  listRequestId: string;
  selectRequestId: string | null;
  points: SessionRewindPoint[];
  selectedIndex: number;
  phase: RollbackChatPhase;
  error: string | null;
  draft: RollbackChatDraft | null;
};
let rollbackChatState: RollbackChatState | null = null;
let diffPreviewDraft: DiffPreviewDraft | null = null;

let agentReviewDraft: { sessionId: string; state: DiffReviewableState } | null = null;
const codeComments = new Map<string, SessionCodeComments>();
let codePreviewDraft: CodePreviewDraft | null = null;
let transcriptPreviewDraft: TranscriptPreviewDraft | null = null;
const transcriptReviewActiveMessages = new Map<string, string>();
const transcriptReviewComments = new Map<string, TranscriptReviewComment[]>();
const PROMPT_HISTORY_LIMIT = 100;
let modelPickerSessionId: string | null = null;
let commandsPopupSessionId: string | null = null;
let modelPickerModels: ModelSummary[] = [];
let modelPickerSelectedIndex = 0;
let modelPickerLoading = false;
let modelPickerError: string | null = null;
const promptHistories = new Map<string, string[]>();
const promptHistoryMessageIds = new Map<string, Set<string>>();
let promptHistoryIndex = -1;
let voiceAudioContext: AudioContext | null = null;
let voiceProcessor: ScriptProcessorNode | null = null;
let voiceSource: MediaStreamAudioSourceNode | null = null;
let voiceStream: MediaStream | null = null;
let voiceIsRecording = false;
let voiceHotkeyActive = false;
let voiceTarget: HTMLInputElement | HTMLTextAreaElement | null = null;
const voiceSegments = new Map<string, VoiceSegmentDraft>();

function pruneStaleSessionCaches(liveSessionIds: ReadonlySet<string>): void {
  const candidates = new Set<string>([
    ...unreadSessions,
    ...projections.keys(),
    ...visiblePlanReviews.keys(),
    ...sessionChangesStates.keys(),
    ...staleSessionChanges,
    ...sessionNotices.keys(),
    ...codeComments.keys(),
    ...transcriptReviewActiveMessages.keys(),
    ...transcriptReviewComments.keys(),
    ...promptHistories.keys(),
    ...promptHistoryMessageIds.keys(),
  ]);
  for (const sessionId of [
    currentSessionChangesRequest?.sessionId,
    diffPreviewDraft?.sessionId,
    agentReviewDraft?.sessionId,
    codePreviewDraft?.sessionId,
    transcriptPreviewDraft?.sessionId,
    activeReviewCommentComposer?.sessionId,
    pendingPresetCommand?.sessionId,
    modelPickerSessionId,
    commandsPopupSessionId,
    codeSessionId,
  ]) {
    if (sessionId) candidates.add(sessionId);
  }

  for (const sessionId of candidates) {
    if (liveSessionIds.has(sessionId)) continue;

    const changesState = sessionChangesStates.get(sessionId);
    if (changesState?.status === "ready") {
      clearDiffPatchCacheForComparison(changesState.comparison.comparisonKey);
    }
    if (currentSessionChangesRequest?.sessionId === sessionId) {
      clearCurrentSessionChangesRequest("sessionChanged");
    }

    unreadSessions.delete(sessionId);
    projections.delete(sessionId);
    visiblePlanReviews.delete(sessionId);
    sessionChangesStates.delete(sessionId);
    sessionChangesPayloadKinds.delete(sessionId);
    sessionChangesKinds.delete(sessionId);
    sessionChangesRepoIds.delete(sessionId);
    restoredGitReviewSessions.delete(sessionId);
    sessionStorage.removeItem(`fura.gitReview.${sessionId}`);
    for (const key of gitHistoryStates.keys()) {
      if (JSON.parse(key)[0] === sessionId) gitHistoryStates.delete(key);
    }
    if (pendingGitHistory?.sessionId === sessionId) clearPendingGitHistory();
    sessionChangesDiffIds.delete(sessionId);
    sessionChangesSelectedFiles.delete(sessionId);
    staleSessionChanges.delete(sessionId);
    diffFileFilters.delete(sessionId);
    diffAnnotations.delete(sessionId);
    reviewComments.delete(sessionId);
    reviewCommentsRequested.delete(sessionId);
    reviewCommentsLoadInFlight.delete(sessionId);
    reviewCommentsResyncNeeded.delete(sessionId);
    diffErrors.delete(sessionId);
    diffLoadingSessions.delete(sessionId);
    pendingDiffFilePatches.delete(sessionId);
    diffFilePatchErrors.delete(sessionId);
    sessionNotices.delete(sessionId);
    codeComments.delete(sessionId);
    transcriptReviewActiveMessages.delete(sessionId);
    transcriptReviewComments.delete(sessionId);
    promptHistories.delete(sessionId);
    promptHistoryMessageIds.delete(sessionId);

    if (diffPreviewDraft?.sessionId === sessionId) diffPreviewDraft = null;
    if (agentReviewDraft?.sessionId === sessionId) agentReviewDraft = null;
    if (codePreviewDraft?.sessionId === sessionId) codePreviewDraft = null;
    if (transcriptPreviewDraft?.sessionId === sessionId) transcriptPreviewDraft = null;
    if (activeReviewCommentComposer?.sessionId === sessionId) activeReviewCommentComposer = null;
    if (pendingPresetCommand?.sessionId === sessionId) pendingPresetCommand = null;
    if (openDiffFileMenu?.annotationKey === sessionId) openDiffFileMenu = null;
    if (modelPickerSessionId === sessionId) {
      modelPickerSessionId = null;
      modelPickerOverlay.hidden = true;
    }
    if (commandsPopupSessionId === sessionId) {
      commandsPopupSessionId = null;
      commandsPopupOverlay.hidden = true;
    }
    if (deleteSessionTarget?.sessionId === sessionId) {
      deleteSessionTarget = null;
      deleteSessionOverlay.hidden = true;
    }
    if (codeSessionId === sessionId) resetCodeViewForSession(null);
  }

  pruneDiffPatchCache();
}

const CONTROL_CLIENT_ID_STORAGE_KEY = "fura.controlClientId";
const controlClientId = getOrCreateControlClientId();
let controlConversationId: string | null = null;
let controlMessages: ControlChatMessage[] = [];
let controlStatusState: ControlStatusProjection = { status: "idle" };
const initialToken = consumeBootstrapToken(
  window.location.href,
  window.sessionStorage,
  url => window.history.replaceState(null, "", url),
);
let showToolBubbles = true;
let showEditDiffs = true;
let thinkingVisibilityMode: ThinkingVisibilityMode = "auto";
let skipThinkingOpenRestoreOnce = false;
let workspaceOptionsOpen = false;
syncToolVisibilityToggle();
syncEditDiffVisibilityToggle();
syncThinkingVisibilityToggle();
syncWorkspaceOptionsMenu();
for (const level of PROPOSED_THINKING_LEVELS) {
  const option = document.createElement("option");
  option.value = level;
  option.textContent = level === "default" ? "Default" : level[0].toUpperCase() + level.slice(1);
  proposedModelThinkingSelect.append(option);
}

type CodeOpenRequest = { source: "sessionWorktree"; sessionId: string; repoRoot: string; path: string };

// --- Desktop workspace state ---

let desktopDockview: DesktopDockview | null = null;
let normalDesktopDockview: DesktopDockview | null = null;
let diffReviewDesktopDockview: DesktopDockview | null = null;
let activeDesktopDockviewMode: "normal" | "diffReview" | null = null;

let codePanelDirty = true;
let codeSessionId: string | null = null;
let codeWorkspace: CodeWorkspaceSummary | null = null;
let codeTreePath = "";
let codeTreeEntries: CodeTreeEntry[] = [];
let codeFile: CodeFileContent | null = null;
let codeRevision: (CodeRevisionState & { sent: boolean; originKey: string; originComparison: string }) | null = null;
let codeLoadingWorkspace = false;
let codeLoadingTree = false;
let codeLoadingFile = false;
let codeError: string | null = null;
let pendingCodeOpenRequest: CodeOpenRequest | null = null;
let pendingCodeRefresh: { workspace: CodeWorkspaceSummary; sessionId: string | null; treePath: string; filePath: string | null } | null = null;
let codeSearchOpen = false;
let codeSearchBasePath = "";
let codeSearchQuery = "";
let codeSearchResults: CodeTreeEntry[] = [];
let codeSearchLoading = false;
let codeSearchError: string | null = null;
let codeSearchRequestTimer: number | null = null;
// Right-click navigation popup: an LSP position (0-based line, UTF-16 char), its
// anchor point, the in-flight hover request id, and the hover result. Rendered
// as a floating overlay decoupled from the code panel so it never rebuilds the
// (scroll-bearing) lines container.
type CodeContextMenuState = {
  line: number;
  character: number;
  x: number;
  y: number;
  requestId: string;
  hover: { status: "loading" | "ready" | "empty" | "error"; contents: string | null };
};
let codeContextMenu: CodeContextMenuState | null = null;
let codeContextMenuEl: HTMLElement | null = null;
let codeContextMenuListenersAttached = false;
let codeAnalyzerStatus: CodeStatus | null = null;
let codeAnalyzerMessage: string | null = null;
let codeReferences: CodeReferencesState | null = null;
let codePendingScrollLine: number | null = null;
// Newest in-flight navigation request id per kind. Responses with a stale id
// (an earlier/superseded query, or another client's query on a shared
// workspace) are ignored.
let codeDefinitionRequestId: string | null = null;
let codeReferencesRequestId: string | null = null;
let codeHoverRequestId: string | null = null;

const sessionListView = createSessionListView(sessionsList, {
  onSelectSession: handleSessionButtonClick,
  onDeleteSession: handleSessionDeleteClick,
});

cwdCategoryCombobox = createCategoryCombobox({
  input: cwdPickerCategoryInput,
  list: cwdPickerCategorySuggestions,
  matchOptions: query => fuzzyMatchCategories(query),
  accept: value => { cwdPickerCategoryInput.value = value; },
  fallbackEnter: () => { cwdPickerInput.focus(); cwdPickerInput.select(); },
});
activeCategoryCombobox = createCategoryCombobox({
  input: activeCategoryInput,
  list: activeCategorySuggestions,
  matchOptions: query => fuzzyMatchCategories(query),
  accept: value => { activeCategoryInput.value = value; markActiveCategoryDirty(); },
  fallbackEnter: submitActiveCategory,
});


// --- Event wiring ---
authForm.addEventListener("submit", event => {
  event.preventDefault();
  connect(authTokenInput.value);
});
connectionStatus.addEventListener("click", forceReconnectNow);
connectionStatus.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  forceReconnectNow();
});

askFuraButton.addEventListener("click", activateControllerWorkspace);
createSessionButton.addEventListener("click", () => {
  openCwdPicker();
});
sessionCategoryFilter.addEventListener("change", () => {
  selectedCategoryFilter = sessionCategoryFilter.value;
  renderSessions();
});
workspaceOptionsToggle.addEventListener("click", event => {
  event.stopPropagation();
  setWorkspaceOptionsOpen(!workspaceOptionsOpen);
});
workspaceOptionsMenu.addEventListener("click", event => event.stopPropagation());
rollbackChatButton.addEventListener("click", openRollbackChat);
duplicateSessionButton.addEventListener("click", () => {
  if (activeSessionId) duplicateSession(activeSessionId);
});
toolVisibilityToggle.addEventListener("click", () => {
  const nextShowTools = !showToolBubbles;
  if (!send({ type: "config.set", showTools: nextShowTools })) return;
  applyVisibilityPreferences(nextShowTools, showEditDiffs, thinkingVisibilityMode);
});
editDiffVisibilityToggle.addEventListener("click", () => {
  const nextShowEditDiffs = !showEditDiffs;
  if (!send({ type: "config.set", showEditDiffs: nextShowEditDiffs })) return;
  applyVisibilityPreferences(showToolBubbles, nextShowEditDiffs, thinkingVisibilityMode);
});
thinkingVisibilityToggle.addEventListener("click", () => {
  const nextMode = nextThinkingVisibilityMode(thinkingVisibilityMode);
  if (!send({ type: "config.set", thinkingVisibility: nextMode })) return;
  applyVisibilityPreferences(showToolBubbles, showEditDiffs, nextMode);
});
proposedModelsOpen.addEventListener("click", openProposedModelsDialog);
proposedModelAdd.addEventListener("click", () => openProposedModelForm());
proposedModelCancel.addEventListener("click", () => closeProposedModelForm());
proposedModelsClose.addEventListener("click", closeProposedModelsDialog);
proposedModelsDone.addEventListener("click", closeProposedModelsDialog);
proposedModelsOverlay.addEventListener("mousedown", event => {
  if (event.target === proposedModelsOverlay) closeProposedModelsDialog();
});
proposedModelSearchInput.addEventListener("input", () => {
  proposedModelCatalogSelectedIndex = 0;
  renderProposedModelCatalog();
});
proposedModelSave.addEventListener("click", saveProposedModelFromForm);
presetsClose.addEventListener("click", closePresetsOverlay);
presetsOverlay.addEventListener("mousedown", event => {
  if (event.target === presetsOverlay) closePresetsOverlay();
});
document.addEventListener("click", event => {
  if (!workspaceOptionsOpen) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (workspaceOptionsToggle.contains(target) || workspaceOptionsMenu.contains(target)) return;
  setWorkspaceOptionsOpen(false);
});
abortButton.addEventListener("click", () => {
  if (activeSessionId) {
    send({ type: "prompt.abort", sessionId: activeSessionId });
  }
});
stopButton.addEventListener("click", () => {
  if (activeSessionId) {
    send({ type: "session.stop", sessionId: activeSessionId });
  }
});

document.addEventListener("click", event => {
  if (!openDiffFileMenu) return;
  const target = event.target;
  if (target instanceof Element && target.closest(".diffs-file-menu")) return;
  openDiffFileMenu = null;
  markDiffsViewDirty();
  markComparePanelDirty();
  if (activeSessionId) renderDiffsViewIfActive(activeSessionId);
  renderComparePanelIfActive();
});
voiceButton.addEventListener("pointerdown", event => {
  event.preventDefault();
  voiceButton.setPointerCapture(event.pointerId);
  void startVoiceRecording();
});
voiceButton.addEventListener("pointerup", event => {
  event.preventDefault();
  if (voiceButton.hasPointerCapture(event.pointerId)) voiceButton.releasePointerCapture(event.pointerId);
  void stopVoiceRecording();
});
voiceButton.addEventListener("pointercancel", () => { void stopVoiceRecording(); });
voiceButton.addEventListener("lostpointercapture", () => { void stopVoiceRecording(); });
voiceButton.addEventListener("contextmenu", event => event.preventDefault());
window.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && desktopDockview?.isPanelActive("code") && !codeRevision) {
    event.preventDefault();
    openCodeSearch();
    return;
  }
  if (event.key === "Escape") {
    if (!commandsPopupOverlay.hidden) {
      closeCommandsPopup();
      return;
    }
    if (!proposedModelsOverlay.hidden) {
      closeProposedModelsDialog();
      return;
    }
    if (!presetsOverlay.hidden) {
      closePresetsOverlay();
      return;
    }
    if (workspaceOptionsOpen) {
      setWorkspaceOptionsOpen(false);
      return;
    }
  }
  if (event.altKey && event.key.toLowerCase() === "m" && !event.repeat && !voiceHotkeyActive) {
    event.preventDefault();
    voiceHotkeyActive = true;
    void startVoiceRecording();
  }
});
window.addEventListener("keyup", event => {
  if (voiceHotkeyActive && (event.key.toLowerCase() === "m" || event.key === "Alt")) {
    event.preventDefault();
    voiceHotkeyActive = false;
    void stopVoiceRecording();
  }
});
busyPromptClose.addEventListener("click", restoreBusyPromptDraft);
busyPromptCancel.addEventListener("click", restoreBusyPromptDraft);
busyPromptSteer.addEventListener("click", () => sendBusyPromptDraft("steer"));
busyPromptFollowUp.addEventListener("click", () => sendBusyPromptDraft("followUp"));
busyPromptOverlay.addEventListener("mousedown", event => {
  if (event.target === busyPromptOverlay) restoreBusyPromptDraft();
});
busyPromptOverlay.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); restoreBusyPromptDraft(); }
});
rollbackChatClose.addEventListener("click", closeRollbackChat);
rollbackChatCancel.addEventListener("click", closeRollbackChat);
rollbackChatRetry.addEventListener("click", requestRollbackChatPoints);
rollbackChatRestore.addEventListener("click", submitRollbackChat);
rollbackChatOverlay.addEventListener("mousedown", event => {
  if (event.target === rollbackChatOverlay) closeRollbackChat();
});
rollbackChatOverlay.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closeRollbackChat();
});
rollbackChatList.addEventListener("keydown", handleRollbackChatKeydown);
deleteSessionButton.addEventListener("click", () => {
  if (activeSessionId) openDeleteSessionPicker(activeSessionId);
});
activeCategoryInput.addEventListener("input", markActiveCategoryDirty);
activeCategoryInput.addEventListener("keydown", event => {
  handleCategoryComboboxKeydown(activeCategoryCombobox, event);
});
activeCategorySave.addEventListener("click", submitActiveCategory);
modelPickerClose.addEventListener("click", closeModelPicker);
modelPickerCancel.addEventListener("click", closeModelPicker);
modelPickerSelect.addEventListener("click", selectCurrentModel);
modelPickerOverlay.addEventListener("mousedown", event => {
  if (event.target === modelPickerOverlay) closeModelPicker();
});
modelPickerSearch.addEventListener("input", () => {
  modelPickerSelectedIndex = 0;
  renderModelPicker();
});
modelPickerSearch.addEventListener("keydown", handleModelPickerKeydown);
modelPickerList.addEventListener("keydown", handleModelPickerKeydown);
commandsPopupClose.addEventListener("click", closeCommandsPopup);
commandsPopupOverlay.addEventListener("mousedown", event => {
  if (event.target === commandsPopupOverlay) closeCommandsPopup();
});
commandsPopupSearch.addEventListener("input", renderCommandsPopup);
cwdPickerClose.addEventListener("click", closeCwdPicker);
cwdPickerCancel.addEventListener("click", closeCwdPicker);
cwdPickerCreate.addEventListener("click", submitCwdPicker);
cwdPickerSessionTab.addEventListener("click", () => setCwdPickerMode("session"));
cwdPickerDiffTab.addEventListener("click", () => setCwdPickerMode("diff"));
cwdPickerWorktreeEnabled.addEventListener("change", syncCwdPickerWorktreeFields);
cwdPickerNameInput.addEventListener("input", applyCwdPickerAutofill);
cwdPickerInput.addEventListener("input", () => {
  if (cwdPickerWorktreeEnabled.checked && cwdPickerInput.value !== lastAutofilledWorktreeDirectory) {
    cwdPickerDirectoryAutofill = false;
  }
  applyCwdPickerAutofill();
});
cwdPickerWorktreeSourceRepo.addEventListener("input", () => {
  cwdPickerSourceRepoAutofill = false;
  applyCwdPickerAutofill();
});
cwdPickerWorktreeBase.addEventListener("input", () => {
  cwdPickerBaseBranchAutofill = false;
  applyCwdPickerAutofill();
});
cwdPickerWorktreeBranch.addEventListener("input", () => {
  if (cwdPickerWorktreeEnabled.checked && cwdPickerWorktreeBranch.value !== lastAutofilledWorktreeBranch) {
    cwdPickerBranchAutofill = false;
  }
  applyCwdPickerAutofill();
});
cwdPickerDiffMode.addEventListener("change", () => {
  if (cwdPickerDiffMode.value === "rangeDiff") {
    ordinaryPickerRefs = { base: cwdPickerDiffBase.value, head: cwdPickerDiffHead.value };
    cwdPickerDiffBase.value = rangeDiffInputs.base;
    cwdPickerDiffOld.value = rangeDiffInputs.old;
    cwdPickerDiffHead.value = rangeDiffInputs.new;
  } else if (!cwdPickerDiffOld.hidden) {
    cwdPickerDiffBase.value = ordinaryPickerRefs.base;
    cwdPickerDiffHead.value = ordinaryPickerRefs.head;
  }
  syncCwdPickerRangeDiffFields();
});
cwdPickerOverlay.addEventListener("mousedown", event => {
  if (event.target === cwdPickerOverlay) closeCwdPicker();
});
deleteSessionClose.addEventListener("click", closeDeleteSessionPicker);
deleteSessionCancel.addEventListener("click", closeDeleteSessionPicker);
deleteSessionConfirm.addEventListener("click", submitDeleteSessionPicker);
deleteSessionOverlay.addEventListener("mousedown", event => {
  if (event.target === deleteSessionOverlay) closeDeleteSessionPicker();
});
cwdPickerNameInput.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); cwdPickerCategoryInput.focus(); cwdPickerCategoryInput.select(); }
  if (event.key === "Escape") { event.preventDefault(); closeCwdPicker(); }
});
cwdPickerCategoryInput.addEventListener("keydown", event => {
  if (handleCategoryComboboxKeydown(cwdCategoryCombobox, event)) return;
  if (event.key === "Enter") { event.preventDefault(); cwdPickerInput.focus(); cwdPickerInput.select(); }
  if (event.key === "Escape") { event.preventDefault(); closeCwdPicker(); }
});
cwdPickerInput.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); submitCwdPicker(); }
  if (event.key === "Escape") { event.preventDefault(); closeCwdPicker(); }
});
cwdPickerWorktreeSourceRepo.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); cwdPickerWorktreeBase.focus(); cwdPickerWorktreeBase.select(); }
  if (event.key === "Escape") { event.preventDefault(); closeCwdPicker(); }
});
cwdPickerWorktreeBase.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); cwdPickerWorktreeBranch.focus(); cwdPickerWorktreeBranch.select(); }
  if (event.key === "Escape") { event.preventDefault(); closeCwdPicker(); }
});
cwdPickerWorktreeBranch.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); submitCwdPicker(); }
  if (event.key === "Escape") { event.preventDefault(); closeCwdPicker(); }
});
handoffPickerClose.addEventListener("click", closeHandoffPicker);
handoffPickerCancel.addEventListener("click", closeHandoffPicker);
handoffPickerCreate.addEventListener("click", submitHandoffPicker);
handoffPickerOverlay.addEventListener("mousedown", event => {
  if (event.target === handoffPickerOverlay) closeHandoffPicker();
});
handoffPickerNameInput.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); handoffPickerInstructions.focus(); }
  if (event.key === "Escape") { event.preventDefault(); closeHandoffPicker(); }
});
handoffPickerInstructions.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); closeHandoffPicker(); }
});
diffPreviewClose.addEventListener("click", closeDiffPreview);
diffPreviewCancel.addEventListener("click", closeDiffPreview);
diffPreviewSend.addEventListener("click", sendPromptPreviewDraft);
diffPreviewOverlay.addEventListener("mousedown", event => {
  if (event.target === diffPreviewOverlay) closeDiffPreview();
});
promptForm.addEventListener("submit", event => {
  event.preventDefault();
  const editorText = promptInput.value.trim();
  const text = expandSnippetTokens(editorText);
  const knownSlashCommand = findSlashCommand(editorText);
  const action = resolvePromptSubmitAction({
    workspaceMode,
    text,
    imageCount: pendingImages.length,
    activeSessionId,
    isModelPickerCommand: isModelPickerCommand(editorText),
    slashCommandName: knownSlashCommand?.name ?? null,
  });

  if (action.type === "ignore") return;
  hidePalette();

  if (workspaceMode === "session" && knownSlashCommand?.name === "presets" && action.type === "sendPrompt") {
    if (pendingImages.length > 0) {
      appendSessionNotice(action.sessionId, {
        level: "warning",
        text: "Presets do not support image attachments. Remove the image before running a preset.",
      });
      render();
      return;
    }
    handlePresetCommand(editorText, action.sessionId);
    return;
  }

  switch (action.type) {
    case "controller.rejectImages":
      controlMessages.push({ role: "system", text: "Ask Fura does not accept image attachments yet. Remove the image preview before asking Fura." });
      renderControlConversation();
      return;
    case "controller.submit": {
      const accepted = submitControlPromptText(text);
      if (accepted) clearPromptEditor();
      return;
    }
    case "openModelPicker":
      openModelPicker(action.sessionId);
      clearPromptEditor();
      return;
    case "openCommandsPopup":
      openCommandsPopup(action.sessionId);
      clearPromptEditor();
      return;
    case "openCwdPicker":
      clearPromptEditor();
      openCwdPicker();
      return;
    case "duplicateSession":
      clearPromptEditor();
      duplicateSession(action.sessionId);
      return;
    case "openHandoffPicker":
      clearPromptEditor();
      openHandoffPicker();
      return;
    case "sendPrompt": {
      const accepted = sendPromptWithBusyHandling({
        sessionId: action.sessionId,
        text,
        editorText: promptInput.value,
        images: pendingImages,
        snippets: pendingSnippets,
      });
      if (accepted) clearPromptEditor();
      return;
    }
  }
});
promptInput.addEventListener("paste", async event => {
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageItems = items.filter(item => item.type.startsWith("image/"));
  const pastedText = event.clipboardData?.getData("text/plain") ?? "";
  const shouldCaptureSnippet = imageItems.length === 0 && pastedText.length > 500;
  if (imageItems.length === 0 && !shouldCaptureSnippet) return;
  event.preventDefault();
  saveComposerDraft();
  const originKey = composerDraftKey;
  const origin = composerDraft;

  if (shouldCaptureSnippet) {
    const marker = createPendingMarker("Snippet");
    pendingSnippets.push({ type: "snippet", marker, text: pastedText });
    insertTextAtCursor(marker);
  }

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) continue;
    try {
      const base64 = await blobToBase64(file);
      // Decoding can finish after a switch, send or deletion.
      if (!composerDrafts.isCurrent(originKey, origin)) continue;
      if (origin === composerDraft) saveComposerDraft();
      const marker = createPendingMarker("Image");
      origin.images.push({ type: "image", marker, data: base64, mimeType: file.type });
      if (origin === composerDraft) {
        insertTextAtCursor(marker);
      } else {
        origin.editorText = insertTextAtSelection(
          origin.editorText, origin.editorText.length, origin.editorText.length, marker,
        ).value;
      }
    } catch {
      appendLog("Failed to read pasted image.");
    }
  }
  renderImagePreviews();
  updatePalette();
});
promptInput.addEventListener("input", () => {
  saveComposerDraft();
  resetPromptHistoryNavigation();
  updatePalette();
  syncRollbackChatDraftWarning();
});
promptInput.addEventListener("blur", () => {
  window.setTimeout(hidePalette, 120);
});
promptInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    promptForm.requestSubmit();
    return;
  }
  if (commandPalette.hidden) {
    if (workspaceMode === "session" && handlePromptHistoryKey(event)) return;
    if (workspaceMode === "session" && event.key === "Escape" && activeSessionId && projections.get(activeSessionId)?.isBusy) {
      event.preventDefault();
      send({ type: "prompt.abort", sessionId: activeSessionId });
    }
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setPaletteSelected(paletteSelectedIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setPaletteSelected(paletteSelectedIndex - 1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    hidePalette();
  } else if (event.key === "Tab") {
    event.preventDefault();
    const target = paletteSelectedIndex >= 0 ? paletteCommands[paletteSelectedIndex] : paletteCommands[0];
    if (target) selectPaletteCommand(target);
  } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && paletteSelectedIndex >= 0) {
    event.preventDefault();
    selectPaletteCommand(paletteCommands[paletteSelectedIndex]);
  }
});


render();
if (initialToken) {
  connect(initialToken);
} else {
  showAuthGate("Enter the bridge token to connect.");
}
initDesktopWorkspace();

// --- Core session logic ---

function connect(token: string): void {
  const bridgeToken = storeBootstrapToken(token, window.sessionStorage);
  if (!bridgeToken) {
    showAuthGate("Enter the bridge token to connect.");
    return;
  }

  authGate.hidden = false;
  authSubmit.disabled = true;
  authStatus.textContent = "Connecting…";
  connection?.disconnect();
  connection = createFuraConnection({
    auth: { type: "sessionCookie", token: bridgeToken },
    onStatus: setStatus,
    onOpen: () => {
      invalidateRollbackChat();
      hideAuthGate();
      // On (re)connect, defer transcript resync until the fresh `sessions.snapshot`
      // arrives, then refresh only sessions the bridge still knows about. Refreshing
      // every held projection blindly re-requests sessions whose files the bridge has
      // since pruned, producing recurring `unknown session` errors on each reconnect.
      pendingRestoreAfterSessionsSnapshot = true;
      if (activeSessionId) staleSessionChanges.add(activeSessionId);
      send({ type: "session.list" });
    },
    onClose: () => {
      if (pendingRangeDiff) {
        invalidateRangeDiff();
        rangeDiffError = "Connection closed while reading range-diff. Compare again to retry.";
        markComparePanelDirty();
        renderComparePanelIfActive();
      }
      invalidateRollbackChat();
      pendingSessionFork = null;
      if (pendingGitFile?.loading) {
        pendingGitFile.loading = false;
        pendingGitFile.view.show(null, "Connection closed while reading the committed file. Close and reopen it to retry.");
      }
      if (codeRevision?.loading) {
        codeRevision.loading = false;
        codeRevision.error = "Connection closed while reading the revision. Reopen it from the file menu to retry.";
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
      }
      if (pendingGitHistory) pendingGitHistory.state.error = "Connection closed while reading history. Refresh to retry.";
      clearPendingGitHistory();
      for (const sessionId of diffLoadingSessions) staleSessionChanges.add(sessionId);
      clearCurrentSessionChangesRequest("closed");
      markDiffsViewDirty();
      renderActiveSession();
      if (cwdPickerCreatePending && cwdPickerPendingRequestId) {
        handleCwdPickerCreateError(
          cwdPickerPendingRequestId,
          "Connection closed before session creation completed.",
        );
      }
    },
    onAuthFailure: message => {
      clearBootstrapToken(window.sessionStorage);
      showAuthGate(message);
      authTokenInput.select();
    },
    onMessage: handleServerMessage,
    onLog: appendLog,
  });
  connection.connect();
}

function showAuthGate(message: string): void {
  authGate.hidden = false;
  authSubmit.disabled = false;
  authStatus.textContent = message;
}

function hideAuthGate(): void {
  authGate.hidden = true;
  authSubmit.disabled = false;
  authStatus.textContent = "";
  authTokenInput.value = "";
}

function saveComposerDraft(): void {
  composerDraft.editorText = promptInput.value;
  composerDraft.images = pendingImages;
  composerDraft.snippets = pendingSnippets;
}

function showComposerDraft(): void {
  promptInput.value = composerDraft.editorText;
  pendingImages = composerDraft.images;
  pendingSnippets = composerDraft.snippets;
  renderImagePreviews();
}

function switchComposerDraft(key: ComposerDraftKey): void {
  if (composerDraftKey === key) return;
  saveComposerDraft();
  composerDraftKey = key;
  composerDraft = composerDrafts.get(key);
  showComposerDraft();
}

function activeWorkspaceKey(): string | null {
  return workspaceMode === "controller" ? "controller" : activeSessionId;
}

function activateControllerWorkspace(): void {
  invalidateRollbackChat();
  if (workspaceMode !== "controller") {
    pendingGitFile?.view.close();
    clearCodeRevision();
    switchComposerDraft(CONTROLLER_DRAFT);
    workspaceMode = "controller";
    resetPromptHistoryNavigation();
    markTranscriptViewDirty({ resetCache: true });
    markToolsViewDirty();
    updatePalette();
  }
  render();
  promptInput.focus();
}

function activateSession(sessionId: string): void {
  if (
    rollbackChatState &&
    (workspaceMode !== "session" || rollbackChatState.sourceSessionId !== sessionId)
  ) {
    invalidateRollbackChat();
  }
  const previousSessionId = activeSessionId;
  const sessionChanged = activeSessionId !== sessionId || workspaceMode !== "session";
  if (sessionChanged) {
    clearPendingGitHistory();
    pendingGitFile?.view.close();
    clearCodeRevision();
    switchComposerDraft(sessionId);
    if (previousSessionId && previousSessionId !== sessionId && currentSessionChangesRequest?.sessionId === previousSessionId) {
      clearCurrentSessionChangesRequest("sessionChanged");
    }
    workspaceMode = "session";
    resetPromptHistoryNavigation();
    markTranscriptViewDirty();
    markToolsViewDirty();
    updatePalette();
  }
  activeSessionId = activateSessionState(unreadSessions, sessionId);
}

function appendSessionNotice(sessionId: string, notice: SessionNotice): void {
  const notices = sessionNotices.get(sessionId) ?? [];
  notices.push(notice);
  sessionNotices.set(sessionId, notices);
  if (workspaceMode === "session" && sessionId === activeSessionId) markTranscriptViewDirty();
}

function isPendingCreatedSession(sessionId: string): boolean {
  return Boolean(pendingCreatedSessionBaseline && !pendingCreatedSessionBaseline.has(sessionId));
}


function shouldActivateSnapshot(sessionId: string): boolean {
  if (isPendingCreatedSession(sessionId)) {
    pendingCreatedSessionBaseline = null;
    return true;
  }
  return workspaceMode === "session" && (!activeSessionId || activeSessionId === sessionId);
}

function handleServerMessage(message: ServerMessage): void {
  // Working-tree replies belong to the suspended workspace, never to a revision.
  if (codeRevision && message.type.startsWith("code.")) return;
  switch (message.type) {
    case "hello":
      appendLog(`Connected to fura ${message.serverVersion} protocol ${message.protocolVersion}`);
      serverConfig = message.config;
      const helloTextileConfigChanged = setTextileRedmineRootUrl(message.config.textileRedmineRootUrl);
      applyVisibilityPreferences(
        parseToolVisibility(message.config.showTools),
        parseToolVisibility(message.config.showEditDiffs),
        parseThinkingVisibilityMode(message.config.thinkingVisibility),
      );
      syncProposedModelsUi();
      syncPresetsUi();
      if (pendingPresetCommand) resolvePendingPresetCommand();
      reviewCommentsRequested.clear();
      reviewCommentsLoadInFlight.clear();
      reviewCommentsResyncNeeded.clear();
      activeReviewCommentComposer = null;
      markDiffsViewDirty();
      if (activeSessionId) renderDiffsViewIfActive(activeSessionId);
      if (helloTextileConfigChanged) {
        markTranscriptViewDirty({ resetCache: true });
        renderActiveSession();
      }
      break;
    case "config.updated":
      serverConfig = message.config;
      const updatedTextileConfigChanged = setTextileRedmineRootUrl(message.config.textileRedmineRootUrl);
      applyVisibilityPreferences(
        parseToolVisibility(message.config.showTools),
        parseToolVisibility(message.config.showEditDiffs),
        parseThinkingVisibilityMode(message.config.thinkingVisibility),
      );
      if (updatedTextileConfigChanged) {
        markTranscriptViewDirty({ resetCache: true });
        renderActiveSession();
      }
      syncProposedModelsUi();
      if (proposedModelSavePending) {
        proposedModelSavePending = false;
        if (proposedModelFormOpen) {
          closeProposedModelForm({ preserveStatus: true });
          proposedModelStatus.textContent = "Saved.";
        }
      }
      if (presetPending) {
        const pending = presetPending;
        const present = (serverConfig?.presets ?? []).some(p => p.name === pending.name);
        if (pending.kind === "save" ? present : !present) {
          presetPending = null;
          presetsView = "picker";
          presetEditorOriginalName = null;
          presetEditorDefaults = {};
        }
      }
      syncPresetsUi();
      break;
    case "presets.list":
      if (serverConfig) serverConfig.presets = message.presets;
      resolvePendingPresetCommand();
      break;
    case "sessions.snapshot":
      {
        const previousActiveSessionId = activeSessionId;
        ({ sessions, activeSessionId } = applySessionsSnapshot(message.sessions, activeSessionId));
        if (workspaceMode === "session" && !activeSessionId) switchComposerDraft(NO_SESSION_DRAFT);
        const liveSessionIds = new Set(message.sessions.map(session => session.sessionId));
        // Absence alone is not deletion: only retire explicitly deleted sessions.
        for (const sessionId of pendingDraftDeletions) {
          if (liveSessionIds.has(sessionId)) continue;
          composerDrafts.clear(sessionId);
          busyPromptDrafts.delete(sessionId);
          pendingDraftDeletions.delete(sessionId);
        }
        pruneStaleSessionCaches(liveSessionIds);
        if (rollbackChatState && !liveSessionIds.has(rollbackChatState.sourceSessionId)) {
          invalidateRollbackChat();
        }
        if (pendingRestoreAfterSessionsSnapshot) {
          pendingRestoreAfterSessionsSnapshot = false;
          for (const sessionId of projections.keys()) {
            send({ type: "state.refresh", sessionId });
          }
        }
        if (previousActiveSessionId && !activeSessionId) resetPromptHistoryNavigation();
        if (pendingSessionSelectionId) {
          const pendingSession = currentSessionSummary(pendingSessionSelectionId);
          if (pendingSession) {
            requestSessionActivation(pendingSession);
          } else {
            pendingSessionSelectionId = null;
          }
        }
      }
        syncSessionModePanels();
      render();
      break;
    case "session.snapshot": {
      const previousSnapshotProjection = projections.get(message.sessionId);
      ({ sessions, projections } = applySessionSnapshot(sessions, projections, message.sessionId, message.state));
      syncVisiblePlanReviewFromProjection(message.sessionId, message.state);
      syncPromptHistoryFromProjection(message.sessionId, message.state);
      const createdByPendingRequest = isPendingCreatedSession(message.sessionId);
      if (shouldActivateSnapshot(message.sessionId)) {
        activateSession(message.sessionId);
        markTranscriptViewDirty();
        markToolsViewDirty();
        render();
        if (createdByPendingRequest && cwdPickerCreatePending) {
          const activateSessionChanges = Boolean(pendingDiffCreate);
          setCwdPickerCreatePending(false);
          closeCwdPicker();
          if (pendingDiffCreate) {
            pendingDiffCreate = null;
          }
          syncSessionModePanels(activateSessionChanges);
        } else {
          syncSessionModePanels();
        }
      } else {
        if (projectionAddsTranscriptEntries(previousSnapshotProjection, message.state)) {
          unreadSessions.add(message.sessionId);
        }
        renderSessions();
      }
      markSessionChangesStaleAfterAgentSettles(
        message.sessionId,
        previousSnapshotProjection,
        message.state,
      );
      if (!previousSnapshotProjection && message.sessionId === activeSessionId) requestActiveDiffState();
      break;
    }
    case "session.delta": {
      const previousDeltaProjection = projections.get(message.sessionId);
      const result = applySessionDelta(sessions, projections, message.sessionId, message.state);
      if (!result) {
        send({ type: "state.refresh", sessionId: message.sessionId });
        break;
      }
      ({ sessions, projections } = result);
      const projection = projections.get(message.sessionId);
      if (projection) {
        syncVisiblePlanReviewFromProjection(message.sessionId, projection);
        syncPromptHistoryFromProjection(message.sessionId, projection);
      }
      if (workspaceMode === "session" && (!activeSessionId || activeSessionId === message.sessionId)) {
        activateSession(message.sessionId);
        markTranscriptViewDirty();
        markToolsViewDirty();
        syncSessionModePanels();
        render();
      } else {
        if (projection && projectionAddsTranscriptEntries(previousDeltaProjection, projection)) {
          unreadSessions.add(message.sessionId);
        }
        renderSessions();
      }
      if (projection) {
        markSessionChangesStaleAfterAgentSettles(
          message.sessionId,
          previousDeltaProjection,
          projection,
        );
      }
      break;
    }
    case "git.file": {
      if (message.targetClientId !== diffClientId) break;
      const revision = codeRevision;
      if (revision?.loading && revision.sent && revision.requestId === message.requestId) {
        if (message.file && (message.file.repoRoot !== revision.repoRoot || message.file.commitOid !== revision.commitOid || message.file.path !== revision.path)) break;
        revision.file = message.file;
        revision.error = message.error ?? (message.file ? null : "Historical revision is unavailable.");
        revision.loading = false;
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
        dispatchGitFileRead();
        break;
      }
      const pending = pendingGitFile;
      if (!pending || !pending.loading || !pending.sent || pending.requestId !== message.requestId) break;
      if (message.file && (message.file.repoRoot !== pending.repoRoot || message.file.commitOid !== pending.commitOid || message.file.path !== pending.path)) break;
      pending.view.show(message.file, message.error);
      pending.loading = false;
      dispatchGitFileRead();
      break;
    }
    case "git.history": {
      if (message.targetClientId !== diffClientId || pendingGitHistory?.sessionId !== message.sessionId) break;
      const history = pendingGitHistory.state;
      if (!acceptGitHistoryResult(history, message.requestId, message.page, message.error)) break;
      pendingGitHistory = null;
      if (message.page) {
        const oldKey = gitHistoryStateKey(message.sessionId, "");
        if (gitHistoryStates.get(oldKey) === history) gitHistoryStates.delete(oldKey);
        gitHistoryStates.set(gitHistoryStateKey(message.sessionId, history.repoRoot), history);
        sessionChangesRepoIds.set(message.sessionId, history.repoRoot);
        persistGitReviewSelection(message.sessionId, history);
        if (history.view === "history" && !history.selectedOid && history.page?.commits[0]) {
          selectGitCommit(message.sessionId, history.page.commits[0].oid);
          break;
        }
      }
      markDiffsViewDirty();
      if (message.sessionId === activeSessionId) renderDiffsViewIfActive(message.sessionId);
      break;
    }
    case "sessionChanges.summary": {
      const state = message.state;
      const currentRequest = currentSessionChangesRequest;
      if (
        state.targetClientId !== diffClientId ||
        currentRequest?.sessionId !== state.sessionId ||
        currentRequest?.diffId !== state.diffId
      ) {
        break;
      }
      diffLoadingSessions.delete(state.sessionId);
      diffErrors.delete(state.sessionId);
      clearPendingDiffFilePatch(state.sessionId, state.diffId);
      diffFilePatchErrors.delete(state.sessionId);
      sessionChangesStates.set(state.sessionId, state);
      invalidatePendingCodeRevision(state.sessionId, state.status === "ready" ? state : null);
      if (state.status === "ready") {
        const initialHistoryKey = gitHistoryStateKey(state.sessionId, "");
        const initialHistory = gitHistoryStates.get(initialHistoryKey);
        if (initialHistory && !gitHistoryStates.has(gitHistoryStateKey(state.sessionId, state.selectedRepoId))) {
          initialHistory.repoRoot = state.selectedRepoId;
          gitHistoryStates.set(gitHistoryStateKey(state.sessionId, state.selectedRepoId), initialHistory);
          gitHistoryStates.delete(initialHistoryKey);
        }
        sessionChangesRepoIds.set(state.sessionId, state.selectedRepoId);
        if (state.request.scope === "sessionChanges") sessionChangesKinds.set(state.sessionId, state.request.changeKind);
        sessionChangesPayloadKinds.set(state.sessionId, state.comparison.detailMode);
        selectedDiffFilePath(state.sessionId, state, state.summary.files.map(file => file.newPath));
      } else {
        sessionChangesSelectedFiles.delete(state.sessionId);
      }
      pruneDiffPatchCache();
      markDiffsViewDirty();
      if (state.sessionId === activeSessionId) renderDiffsViewIfActive(state.sessionId);
      if (state.sessionId === activeSessionId && staleSessionChanges.has(state.sessionId)) {
        requestActiveDiffState();
      }
      break;
    }
    case "git.rangeDiff": {
      const pending = pendingRangeDiff;
      if (message.targetClientId !== diffClientId || !pending || message.requestId !== pending.requestId) break;
      const result = message.result;
      pendingRangeDiff = null;
      if (result && (result.base.input !== pending.inputs.base || result.old.input !== pending.inputs.old || result.new.input !== pending.inputs.new || (result.ignoreWhitespace ?? false) !== pending.inputs.ignoreWhitespace)) {
        rangeDiffError = "Range-diff response did not match the requested refs or whitespace mode. Compare again.";
        rangeDiffResult = null;
      } else {
        rangeDiffResult = result;
        rangeDiffError = message.error;
      }
      markComparePanelDirty();
      renderComparePanelIfActive();
      break;
    }
    case "compareDiff.summary": {
      const state = message.state;
      if (state.targetClientId !== diffClientId || compareDiffId !== state.diffId) break;
      compareDiffState = state;
      invalidatePendingCodeRevision("compareDiff", state);
      compareDiffLoading = false;
      diffErrors.delete("compareDiff");
      clearPendingDiffFilePatch("compareDiff", state.diffId);
      diffFilePatchErrors.delete("compareDiff");
      selectedDiffFilePath("compareDiff", state, state.summary.files.map(file => file.newPath));
      const activeDiffReviewSessionId = activeSessionId && projections.get(activeSessionId)?.summary.sessionMode === "diffReview"
        ? activeSessionId
        : null;
      if (activeDiffReviewSessionId) {
        selectedDiffFilePath(activeDiffReviewSessionId, state, state.summary.files.map(file => file.newPath));
      }
      pruneDiffPatchCache();
      markComparePanelDirty();
      renderComparePanelIfActive();
      if (activeDiffReviewSessionId) renderDiffsViewIfActive(activeDiffReviewSessionId);
      break;
    }
    case "diff.content": {
      const content = message.content;
      if (content.targetClientId !== diffClientId) break;
      const filePath = content.file?.newPath ?? null;
      if (content.scope === "compareDiff") {
        if (compareDiffId !== content.diffId || compareDiffState?.comparison.comparisonKey !== content.comparisonKey) break;
        rememberDiffPatch(diffPatchCacheKey(content.comparisonKey, filePath), { patch: content.patch, truncated: content.truncated, rows: content.rows, contextLines: content.contextLines });
        clearPendingDiffFilePatch("compareDiff", content.diffId);
        if (diffFilePatchErrors.get("compareDiff")?.filePath === filePath) diffFilePatchErrors.delete("compareDiff");
        const activeDiffReviewSessionId = activeSessionId && projections.get(activeSessionId)?.summary.sessionMode === "diffReview"
          ? activeSessionId
          : null;
        if (activeDiffReviewSessionId) {
          clearPendingDiffFilePatch(activeDiffReviewSessionId, content.diffId);
          if (diffFilePatchErrors.get(activeDiffReviewSessionId)?.filePath === filePath) diffFilePatchErrors.delete(activeDiffReviewSessionId);
        }
        markComparePanelDirty();
        if (!rerenderSelectedDiffFileContentIfActive("compareDiff")) renderComparePanelIfActive();
        if (activeDiffReviewSessionId) {
          markDiffsViewDirty();
          if (!rerenderSelectedDiffFileContentIfActive(activeDiffReviewSessionId)) renderDiffsViewIfActive(activeDiffReviewSessionId);
        }
      } else {
        const sessionId = currentSessionChangesRequest?.sessionId;
        const state = sessionId ? sessionChangesStates.get(sessionId) : undefined;
        if (
          !sessionId ||
          currentSessionChangesRequest?.diffId !== content.diffId ||
          state?.status !== "ready" ||
          state.comparison.comparisonKey !== content.comparisonKey
        ) {
          break;
        }
        rememberDiffPatch(diffPatchCacheKey(content.comparisonKey, filePath), { patch: content.patch, truncated: content.truncated, rows: content.rows, contextLines: content.contextLines });
        clearPendingDiffFilePatch(sessionId, content.diffId);
        if (diffFilePatchErrors.get(sessionId)?.filePath === filePath) diffFilePatchErrors.delete(sessionId);
        markDiffsViewDirty();
        if (!rerenderSelectedDiffFileContentIfActive(sessionId)) renderDiffsViewIfActive(sessionId);
      }
      break;
    }
    case "diff.complete":
    case "diff.cancelled": {
      if (message.targetClientId !== diffClientId) break;
      if (message.scope === "compareDiff") {
        if (compareDiffId !== message.diffId) break;
        compareDiffLoading = false;
        clearPendingDiffFilePatch("compareDiff", message.diffId);
        const activeDiffReviewSessionId = activeSessionId && projections.get(activeSessionId)?.summary.sessionMode === "diffReview"
          ? activeSessionId
          : null;
        if (activeDiffReviewSessionId) clearPendingDiffFilePatch(activeDiffReviewSessionId, message.diffId);
        markComparePanelDirty();
        renderComparePanelIfActive();
        if (activeDiffReviewSessionId) renderDiffsViewIfActive(activeDiffReviewSessionId);
      } else {
        const currentRequest = currentSessionChangesRequest;
        if (currentRequest?.diffId !== message.diffId) break;
        diffLoadingSessions.delete(currentRequest.sessionId);
        clearPendingDiffFilePatch(currentRequest.sessionId, message.diffId);
        markDiffsViewDirty();
        if (currentRequest.sessionId === activeSessionId) renderDiffsViewIfActive(currentRequest.sessionId);
      }
      break;
    }
    case "diff.error": {
      if (message.targetClientId && message.targetClientId !== diffClientId) break;
      if (message.scope === "compareDiff") {
        if (!message.diffId || compareDiffId !== message.diffId) break;
        const activeDiffReviewSessionId = activeSessionId && projections.get(activeSessionId)?.summary.sessionMode === "diffReview"
          ? activeSessionId
          : null;
        const pendingCompare = pendingDiffFilePatches.get("compareDiff");
        const pendingDiffReview = activeDiffReviewSessionId ? pendingDiffFilePatches.get(activeDiffReviewSessionId) : undefined;
        if (pendingCompare && compareDiffState && pendingCompare.diffId === message.diffId && pendingCompare.comparisonKey === compareDiffState.comparison.comparisonKey) {
          pendingDiffFilePatches.delete("compareDiff");
          diffFilePatchErrors.set("compareDiff", { filePath: pendingCompare.filePath, message: message.message });
          compareDiffLoading = false;
          markComparePanelDirty();
          renderComparePanelIfActive();
          if (activeDiffReviewSessionId) renderDiffsViewIfActive(activeDiffReviewSessionId);
          break;
        }
        if (pendingDiffReview && compareDiffState && pendingDiffReview.diffId === message.diffId && pendingDiffReview.comparisonKey === compareDiffState.comparison.comparisonKey) {
          pendingDiffFilePatches.delete(activeDiffReviewSessionId!);
          diffFilePatchErrors.set(activeDiffReviewSessionId!, { filePath: pendingDiffReview.filePath, message: message.message });
          compareDiffLoading = false;
          if (activeDiffReviewSessionId) renderDiffsViewIfActive(activeDiffReviewSessionId);
          break;
        }
        compareDiffLoading = false;
        diffErrors.set("compareDiff", message.message);
        markComparePanelDirty();
        renderComparePanelIfActive();
        if (activeDiffReviewSessionId) renderDiffsViewIfActive(activeDiffReviewSessionId);
        break;
      }
      if (message.scope === "sessionChanges") {
        const pending = message.sessionId ? pendingDiffFilePatches.get(message.sessionId) : undefined;
        const state = message.sessionId ? sessionChangesStates.get(message.sessionId) : undefined;
        if (
          message.sessionId &&
          message.diffId &&
          pending &&
          state?.status === "ready" &&
          pending.diffId === message.diffId &&
          pending.comparisonKey === state.comparison.comparisonKey
        ) {
          pendingDiffFilePatches.delete(message.sessionId);
          diffFilePatchErrors.set(message.sessionId, { filePath: pending.filePath, message: message.message });
          markDiffsViewDirty();
          if (message.sessionId === activeSessionId) renderDiffsViewIfActive(message.sessionId);
          break;
        }
        const currentRequest = currentSessionChangesRequest;
        if (
          !message.sessionId ||
          !message.diffId ||
          currentRequest?.sessionId !== message.sessionId ||
          currentRequest?.diffId !== message.diffId
        ) {
          break;
        }
        diffLoadingSessions.delete(message.sessionId);
        diffErrors.set(message.sessionId, message.message);
        markDiffsViewDirty();
        if (message.sessionId === activeSessionId) renderDiffsViewIfActive(message.sessionId);
        break;
      }
      appendLog(`diff error: ${message.message}`);
      break;
    }
    case "review.comments.snapshot": {
      reviewCommentsLoadInFlight.delete(message.sessionId);
      if (reviewCommentsResyncNeeded.has(message.sessionId)) {
        reviewCommentsResyncNeeded.delete(message.sessionId);
        reviewCommentsRequested.delete(message.sessionId);
        ensureReviewCommentsLoaded(message.sessionId);
        break;
      }
      reviewComments.set(message.sessionId, message.comments);
      reviewCommentsRequested.add(message.sessionId);
      markDiffsViewDirty();
      if (message.sessionId === activeSessionId) renderDiffsViewIfActive(message.sessionId);
      break;
    }
    case "review.comment.upserted": {
      if (reviewCommentsLoadInFlight.has(message.comment.sessionId)) {
        reviewCommentsResyncNeeded.add(message.comment.sessionId);
      }
      const existing = reviewComments.get(message.comment.sessionId) ?? [];
      reviewComments.set(
        message.comment.sessionId,
        [...existing.filter(comment => comment.id !== message.comment.id), message.comment],
      );
      markDiffsViewDirty();
      if (message.comment.sessionId === activeSessionId) renderDiffsViewIfActive(message.comment.sessionId);
      break;
    }
    case "review.comment.deleted": {
      if (reviewCommentsLoadInFlight.has(message.sessionId)) {
        reviewCommentsResyncNeeded.add(message.sessionId);
      }
      if (activeReviewCommentComposer?.mode === "edit" && activeReviewCommentComposer.commentId === message.id) {
        activeReviewCommentComposer = null;
      }
      reviewComments.set(
        message.sessionId,
        (reviewComments.get(message.sessionId) ?? []).filter(comment => comment.id !== message.id),
      );
      markDiffsViewDirty();
      if (message.sessionId === activeSessionId) renderDiffsViewIfActive(message.sessionId);
      break;
    }
    case "code.workspace.ready":
      if (pendingCodeRefresh && (message.workspace.root !== pendingCodeRefresh.workspace.root ||
        message.workspace.source !== pendingCodeRefresh.workspace.source)) break;
      if (pendingCodeOpenRequest?.source === "sessionWorktree" && message.workspace.root !== pendingCodeOpenRequest.repoRoot) break;
      if (!pendingCodeOpenRequest && !pendingCodeRefresh && codeWorkspace &&
        (message.workspace.root !== codeWorkspace.root || message.workspace.source !== codeWorkspace.source)) break;
      codeLoadingWorkspace = false;
      codeWorkspace = message.workspace;
      codeSessionId = pendingCodeRefresh?.sessionId ?? message.workspace.sessionId ?? codeSessionId;
      codeTreePath = "";
      codeTreeEntries = [];
      codeFile = null;
      codeError = null;
      // A new workspace (session switch or review-worktree open) must not inherit
      // the previous workspace's navigation/analyzer UI state.
      closeCodeContextMenu();
      codeReferences = null;
      codeAnalyzerStatus = null;
      codeAnalyzerMessage = null;
      codePendingScrollLine = null;
      codeDefinitionRequestId = null;
      codeReferencesRequestId = null;
      if (codeSearchOpen && !codeSearchBasePath) codeSearchBasePath = message.workspace.root;
      markCodeViewDirty();
      const pending = pendingCodeOpenRequest;
      // Only consume the pending open when THIS ready is the workspace it asked
      // for, so a stale reply for an earlier in-flight open cannot hijack it.
      const pendingMatchesWorkspace = pending != null && message.workspace.source === "session" && message.workspace.root === pending.repoRoot;
      if (pending && pendingMatchesWorkspace) {
        if (pending.source === "sessionWorktree") codeSessionId = pending.sessionId;
        // Honor an explicit "Open in Code" request as soon as its workspace is
        // ready, even before the panel finishes activating (activatePanel races
        // the workspace.ready reply, which used to drop the first open).
        pendingCodeOpenRequest = null;
        requestCodeTree(parentCodePath(pending.path) ?? "");
        requestCodeFile(pending.path);
      } else if (pendingCodeRefresh) {
        const refresh = pendingCodeRefresh;
        pendingCodeRefresh = null;
        requestCodeTree(refresh.treePath);
        if (refresh.filePath) requestCodeFile(refresh.filePath);
      } else if (!pending && desktopDockview?.isPanelActive("code")) {
        requestCodeTree("");
      }
      renderCodePanelIfNeeded(true);
      break;
    case "code.tree":
      if (!codeLoadingWorkspace && codeWorkspace?.workspaceId === message.workspaceId) {
        codeLoadingTree = false;
        codeTreePath = message.path;
        codeTreeEntries = message.entries;
        codeError = null;
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
      }
      break;
    case "code.file":
      if (!codeLoadingWorkspace && codeWorkspace?.workspaceId === message.workspaceId) {
        codeLoadingFile = false;
        codeFile = message.file;
        codeError = null;
        const parent = parentCodePath(message.file.path) ?? "";
        if (parent !== codeTreePath && !codeLoadingTree) requestCodeTree(parent);
        else renderCodePanelIfNeeded(true);
      }
      break;
    case "code.file.searchResults":
      if (codeWorkspace?.workspaceId === message.workspaceId) {
        codeSearchLoading = false;
        codeSearchError = null;
        codeSearchResults = message.entries;
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
      }
      break;
    case "code.error":
      if (!message.workspaceId || codeWorkspace?.workspaceId === message.workspaceId) {
        codeLoadingWorkspace = false;
        pendingCodeRefresh = null;
        codeLoadingTree = false;
        codeLoadingFile = false;
        codeError = message.path ? `${message.path}: ${message.message}` : message.message;
        if (codeSearchOpen && codeSearchLoading) {
          codeSearchLoading = false;
          codeSearchError = codeError;
        }
        // A request-scoped error (unreadable/missing file, unknown workspace)
        // means a pending hover will never arrive; resolve a still-loading popup.
        resolvePendingHover("error");
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
      }
      break;
    case "code.definition":
      if (codeWorkspace?.workspaceId === message.workspaceId && message.requestId === codeDefinitionRequestId) {
        codeDefinitionRequestId = null;
        handleCodeDefinition(message.locations);
      }
      break;
    case "code.references":
      if (codeWorkspace?.workspaceId === message.workspaceId && message.requestId === codeReferencesRequestId) {
        codeReferencesRequestId = null;
        codeReferences = { path: message.path, locations: message.locations };
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
      }
      break;
    case "code.status":
      if (codeWorkspace?.workspaceId === message.workspaceId) {
        codeAnalyzerStatus = message.status;
        codeAnalyzerMessage = message.message ?? null;
        // A failure status means an in-flight hover will never arrive; resolve a
        // still-loading popup instead of spinning forever. resolvePendingHover is
        // a no-op once the popup has already rendered hover content.
        if (message.status === "error" || message.status === "unavailable" || message.status === "filesOnly") {
          resolvePendingHover(message.status === "filesOnly" ? "empty" : "error");
        }
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
      }
      break;
    case "code.hover":
      if (
        codeWorkspace?.workspaceId === message.workspaceId &&
        message.requestId === codeHoverRequestId &&
        codeContextMenu
      ) {
        codeHoverRequestId = null;
        const hoverContents = message.contents ?? null;
        codeContextMenu = {
          ...codeContextMenu,
          hover: { status: hoverContents ? "ready" : "empty", contents: hoverContents },
        };
        renderCodeContextMenuOverlay();
      }
      break;
    case "plan.review":
      handlePlanReview(message);
      break;
    case "session.exited":
      appendLog(`Session ${message.sessionId} exited with code ${message.code ?? "unknown"}.`);
      render();
      break;
    case "log.stderr":
      appendLog(`[${message.sessionId}] ${message.text}`);
      break;
    case "session.notice":
      appendLog(`[${message.sessionId}] ${message.level}: ${message.text}`);
      if (message.level === "info" && message.text.startsWith("Git repositories updated:")) {
        const previous = sessionChangesStates.get(message.sessionId);
        const hiddenSelected = previous?.status === "ready" && message.text === `Git repositories updated: hide ${previous.comparison.repoRoot}`;
        if (hiddenSelected) sessionChangesRepoIds.delete(message.sessionId);
        staleSessionChanges.add(message.sessionId);
        if (message.sessionId === activeSessionId) requestActiveDiffState();
      }
      if (message.level === "error" && diffLoadingSessions.has(message.sessionId)) {
        diffLoadingSessions.delete(message.sessionId);
        diffErrors.set(message.sessionId, message.text);
        markDiffsViewDirty();
      }
      if (message.level === "error" || message.level === "warning") {
        appendSessionNotice(message.sessionId, { level: message.level, text: message.text });
        render();
      }
      if (modelPickerSessionId === message.sessionId && message.level === "error") {
        modelPickerLoading = false;
        modelPickerError = message.text;
        renderModelPicker();
      }
      break;
    case "prompt.busy":
      handlePromptBusy(message);
      break;
    case "session.rewind.points":
      handleRollbackChatPoints(message);
      break;
    case "session.rewind.result":
      handleRollbackChatResult(message);
      break;
    case "session.rewind.error":
      handleRollbackChatError(message);
      break;
    case "session.forked":
      if (
        pendingSessionFork?.requestId !== message.requestId ||
        pendingSessionFork.sourceSessionId !== message.sourceSessionId
      ) break;
      pendingSessionFork = null;
      activateSession(message.sessionId);
      render();
      break;
    case "session.fork.error":
      if (
        pendingSessionFork?.requestId !== message.requestId ||
        pendingSessionFork.sourceSessionId !== message.sourceSessionId
      ) break;
      pendingSessionFork = null;
      appendSessionNotice(message.sourceSessionId, { level: "error", text: message.message });
      appendLog(`[${message.sourceSessionId}] error: ${message.message}`);
      render();
      break;
    case "model.list":
      if (modelPickerSessionId === message.sessionId) {
        modelPickerModels = message.models;
        modelPickerSelectedIndex = 0;
        modelPickerLoading = false;
        modelPickerError = null;
        renderModelPicker();
      }
      break;
    case "config.modelCatalog.list":
      if (!message.requestId || message.requestId === proposedModelCatalogRequestId) {
        proposedModelCatalog = message.models;
        proposedModelCatalogLoading = false;
        proposedModelCatalogRequestId = null;
        proposedModelStatus.textContent = `${message.models.length} runtime model${message.models.length === 1 ? "" : "s"}`;
        renderProposedModelCatalog();
        if (proposedModelEditingId) {
          const editing = serverConfig?.proposedModels.find(model => model.id === proposedModelEditingId);
          if (editing) selectProposedCatalogModel(editing.provider, editing.modelId);
        }
        renderProposedModelsList();
      }
      break;
    case "model.changed":
      if (modelPickerSessionId === message.sessionId) {
        closeModelPicker();
      }
      appendLog(`[${message.sessionId}] model changed: ${formatModelSelector(message.model)}`);
      break;
    case "control.reply":
      if (message.targetClientId === controlClientId) handleControlReply(message);
      break;
    case "control.status":
      if (!message.targetClientId || message.targetClientId === controlClientId) {
        controlStatusState = message.status;
        renderControlConversation();
      }
      break;
    case "frontend.control":
      if (message.targetClientId === controlClientId) handleFrontendControl(message.action);
      break;
    case "voice.status":
      if (message.targetClientId === controlClientId) handleVoiceStatus(message.status, message.message ?? null);
      break;
    case "voice.delta":
      if (message.targetClientId === controlClientId) applyVoiceTranscript(message.itemId, message.text, false);
      break;
    case "voice.final":
      if (message.targetClientId === controlClientId) applyVoiceTranscript(message.itemId, message.text, true);
      break;
    case "voice.error":
      if (message.targetClientId === controlClientId) handleVoiceError(message.message);
      break;
    case "raw.omp":
      appendLog(`[raw ${message.sessionId}] ${JSON.stringify(message.frame)}`);
      break;
    case "error":
      pendingDraftDeletions.clear();
      appendLog(`Error: ${message.message}`);
      if (message.requestId && message.requestId === proposedModelCatalogRequestId) {
        proposedModelCatalogLoading = false;
        proposedModelCatalogRequestId = null;
        proposedModelStatus.textContent = message.message;
        renderProposedModelCatalog();
        break;
      }
      if (proposedModelSavePending) {
        proposedModelSavePending = false;
        proposedModelStatus.textContent = message.message;
        break;
      }
      if (presetPending) {
        presetPending = null;
        presetsStatus.textContent = message.message;
        break;
      }
      if (handleCwdPickerCreateError(message.requestId ?? null, message.message)) {
        break;
      }
      pendingCreatedSessionBaseline = null;
      if (activeSessionId) {
        appendSessionNotice(activeSessionId, { level: "error", text: message.message });
        render();
      }
      break;
  }
}

function submitControlPromptText(text: string): boolean {
  const prompt = text.trim();
  if (!prompt) return false;
  const conversationId = controlConversationId ?? randomUuid();
  const sent = send({
    type: "control.prompt",
    clientId: controlClientId,
    conversationId,
    text: prompt,
    uiSnapshot: captureFrontendUiSnapshot(),
  });
  if (!sent) return false;
  controlConversationId = conversationId;
  controlMessages.push({ role: "user", text: prompt });
  controlStatusState = { status: "working", message: "Ask Fura is thinking." };
  renderControlConversation();
  return sent;
}

function handleControlReply(message: Extract<ServerMessage, { type: "control.reply" }>): void {
  controlConversationId = message.conversationId;
  controlMessages.push({
    role: "assistant",
    text: message.message,
    candidates: message.candidates ?? [],
    suggestedActions: message.suggestedActions ?? [],
  });
  renderControlConversation();
}

function handleFrontendControl(action: FrontendControlAction): void {
  switch (action.type) {
    case "selectSession":
      handleSessionButtonClick(action.sessionId);
      break;
    case "setPromptDraft":
      {
        const targetSessionId = action.sessionId ?? activeSessionId;
        if (targetSessionId && targetSessionId !== activeSessionId) {
          handleSessionButtonClick(targetSessionId);
        } else if (targetSessionId) {
          activateSession(targetSessionId);
          render();
        }
      }
      promptInput.value = action.text;
      updatePalette();
      if (action.focus) promptInput.focus();
      break;
    case "focus":
      focusControlTarget(action.target);
      break;
    case "showNotice":
      controlMessages.push({ role: "system", text: action.text });
      renderControlConversation();
      break;
  }
}

function focusControlTarget(target: "controller" | "prompt"): void {
  activateControllerWorkspace();
  if (target === "prompt" || target === "controller") promptInput.focus();
}

function captureFrontendUiSnapshot(): FrontendUiSnapshot {
  return {
    activeSessionId,
    focusedArea: focusedArea(),
    sessionIds: sessions.map(session => session.sessionId),
    promptDraft: {
      sessionId: activeSessionId,
      hasText: promptInput.value.trim().length > 0,
      textLength: promptInput.value.length,
    },
    panels: {
      transcriptVisible: desktopDockview?.panelMounted("transcript") ?? false,
      toolsVisible: desktopDockview?.panelMounted("tools") ?? false,
    },
    blockingUi: {
      modalOpen: Boolean(document.querySelector(".modal-overlay:not([hidden])")),
      dialogOpen: Boolean(activeSessionId && projections.get(activeSessionId)?.summary.awaitingAsk),
    },
  };
}

function focusedArea(): FrontendUiSnapshot["focusedArea"] {
  const element = document.activeElement;
  if (workspaceMode === "controller" && element === promptInput) return "controller";
  if (element === promptInput) return "prompt";
  if (element && sessionsList.contains(element)) return "sessionList";
  if (element && desktopDockview?.panelContains("transcript", element)) return "transcript";
  if (element && desktopDockview?.panelContains("tools", element)) return "tools";
  return "unknown";
}

function renderControlConversation(): void {
  askFuraButton.className = `ask-fura-toggle ${controlStatusState.status}`;
  askFuraButton.setAttribute("aria-pressed", String(workspaceMode === "controller"));
  askFuraButton.title = controlStatusState.message || `Ask Fura is ${controlStatusState.status}`;
  if (workspaceMode === "controller") {
    markTranscriptViewDirty();
    markToolsViewDirty();
    renderActiveSession();
  }
}

function renderControlCandidate(candidate: ControlCandidate): HTMLElement {
  const card = mkEl("div");
  card.className = "control-candidate";
  const title = mkEl("strong");
  title.textContent = candidate.title || shortId(candidate.sessionId);
  const reason = mkEl("span");
  reason.textContent = candidate.reason;
  const open = mkEl("button");
  open.type = "button";
  open.textContent = "Open";
  open.addEventListener("click", () => handleFrontendControl({ type: "selectSession", sessionId: candidate.sessionId }));
  card.append(title, reason, open);
  for (const snippetText of candidate.snippets ?? []) {
    const snippet = mkEl("p");
    snippet.className = "control-snippet";
    snippet.textContent = snippetText;
    card.append(snippet);
  }
  return card;
}

function getOrCreateControlClientId(): string {
  const existing = window.sessionStorage.getItem(CONTROL_CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const next = randomUuid();
  window.sessionStorage.setItem(CONTROL_CLIENT_ID_STORAGE_KEY, next);
  return next;
}

function handlePromptBusy(message: Extract<ServerMessage, { type: "prompt.busy" }>): void {
  appendLog(`[${message.sessionId}] prompt needs steer or follow-up choice`);
  const drafts = busyPromptDrafts.get(message.sessionId) ?? [];
  drafts.push(createBusyPromptDraftFromServer(message, createPendingMarker));
  busyPromptDrafts.set(message.sessionId, drafts);
  if (message.sessionId === activeSessionId) {
    render();
    promptInput.focus();
  } else {
    unreadSessions.add(message.sessionId);
    renderSessions();
  }
}


function samePendingPlanReview(left: PendingPlanReview, right: PendingPlanReview): boolean {
  return left.sessionId === right.sessionId
    && left.planFilePath === right.planFilePath
    && left.finalPlanFilePath === right.finalPlanFilePath
    && (left.title ?? "") === (right.title ?? "")
    && left.content === right.content;
}

function pendingPlanReviewFromProjection(sessionId: string, projection: SessionProjection): PendingPlanReview | null {
  const pending = projection.pendingPlanReview;
  if (!pending) return null;
  return {
    sessionId,
    planFilePath: pending.planFilePath,
    finalPlanFilePath: pending.finalPlanFilePath,
    title: pending.title ?? undefined,
    content: pending.content,
  };
}

function syncVisiblePlanReviewFromProjection(sessionId: string, projection: SessionProjection): void {
  const pending = pendingPlanReviewFromProjection(sessionId, projection);
  if (!pending) {
    visiblePlanReviews.delete(sessionId);
    return;
  }
  const existing = visiblePlanReviews.get(sessionId);
  const mode: VisiblePlanReview["mode"] = existing && existing.mode === "refining" && samePendingPlanReview(existing.review, pending)
    ? "refining"
    : "pending";
  visiblePlanReviews.set(sessionId, { review: pending, mode });
}


function handlePlanReview(message: Extract<ServerMessage, { type: "plan.review" }>): void {
  visiblePlanReviews.set(message.sessionId, { review: pendingPlanReviewFromMessage(message), mode: "pending" });
  appendLog(`[${message.sessionId}] plan ready for review`);
  if (message.sessionId === activeSessionId && workspaceMode === "session") {
    markTranscriptViewDirty();
    render();
  } else {
    unreadSessions.add(message.sessionId);
    renderSessions();
  }
}

function approvePendingPlanReview(review: PendingPlanReview, approvalMode: PlanApprovalMode = "execute"): void {
  const accepted = send(createApprovePlanReviewMessage(review, approvalMode));
  if (!accepted) return;
  visiblePlanReviews.delete(review.sessionId);
  markTranscriptViewDirty();
  render();
}

function refinePendingPlanReview(review: PendingPlanReview): void {
  visiblePlanReviews.set(review.sessionId, { review, mode: "refining" });
  markTranscriptViewDirty();
  render();
  if (workspaceMode === "session" && activeSessionId === review.sessionId) {
    promptInput.focus();
  }
}


function sendPromptMessage(
  sessionId: string,
  text: string,
  images: PendingImage[],
  behavior?: PromptBehavior,
): boolean {
  if (!send(createPromptSendMessage(sessionId, text, images, behavior))) return false;
  sessionNotices.delete(sessionId);
  addPromptToHistory(sessionId, text);
  return true;
}

function addPromptToHistory(sessionId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const history = promptHistories.get(sessionId) ?? [];
  if (history[0] === trimmed) {
    promptHistoryIndex = -1;
    return;
  }

  history.unshift(trimmed);
  if (history.length > PROMPT_HISTORY_LIMIT) {
    history.pop();
  }
  promptHistories.set(sessionId, history);
  promptHistoryIndex = -1;
}

function syncPromptHistoryFromProjection(sessionId: string, projection: SessionProjection): void {
  let seenIds = promptHistoryMessageIds.get(sessionId);
  if (!seenIds) {
    seenIds = new Set<string>();
    promptHistoryMessageIds.set(sessionId, seenIds);
  }

  for (const entry of projection.transcript) {
    if (entry.kind !== "message" || entry.role !== "user" || seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    addPromptToHistory(sessionId, messageText(entry));
  }
}

function resetPromptHistoryNavigation(): void {
  promptHistoryIndex = -1;
}

function handlePromptHistoryKey(event: KeyboardEvent): boolean {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;

  const sessionId = activeSessionId;
  if (!sessionId) return false;

  const history = promptHistories.get(sessionId) ?? [];
  const direction = event.key === "ArrowUp" ? -1 : 1;
  const canEnterHistory = direction === -1 && promptHistoryIndex === -1 && promptInput.value.trim().length === 0;
  const isBrowsingHistory = promptHistoryIndex !== -1;
  if (history.length === 0 || (!canEnterHistory && !isBrowsingHistory)) return false;

  event.preventDefault();
  navigatePromptHistory(sessionId, direction);
  return true;
}

function navigatePromptHistory(sessionId: string, direction: 1 | -1): void {
  const history = promptHistories.get(sessionId) ?? [];
  if (history.length === 0) return;

  const nextIndex = promptHistoryIndex - direction;
  if (nextIndex < -1 || nextIndex >= history.length) return;

  promptHistoryIndex = nextIndex;
  if (promptHistoryIndex === -1) {
    promptInput.value = "";
    promptInput.selectionStart = 0;
    promptInput.selectionEnd = 0;
  } else {
    promptInput.value = history[promptHistoryIndex] ?? "";
    const cursor = direction === -1 ? 0 : promptInput.value.length;
    promptInput.selectionStart = cursor;
    promptInput.selectionEnd = cursor;
  }

  hidePalette();
}

function clearPromptEditor(): void {
  resetPromptHistoryNavigation();
  composerDrafts.clear(composerDraftKey);
  composerDraft = composerDrafts.get(composerDraftKey);
  showComposerDraft();
  updatePalette();
}

async function startVoiceRecording(): Promise<void> {
  if (voiceIsRecording) return;
  if (!connection?.isOpen()) {
    handleVoiceError("Not connected.");
    return;
  }
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor || !navigator.mediaDevices?.getUserMedia) {
    handleVoiceError("Voice input is not supported by this browser.");
    return;
  }

  voiceTarget = currentVoiceTarget();
  saveComposerDraft();
  voiceComposerDraft = voiceTarget === promptInput ? { key: composerDraftKey, draft: composerDraft } : undefined;
  voiceSegments.clear();
  handleVoiceStatus("connecting", "Requesting microphone.");

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    voiceAudioContext = new AudioContextCtor();
    if (voiceAudioContext.state === "suspended") await voiceAudioContext.resume();
    voiceSource = voiceAudioContext.createMediaStreamSource(voiceStream);
    voiceProcessor = voiceAudioContext.createScriptProcessor(4096, 1, 1);
    voiceProcessor.onaudioprocess = event => {
      if (!voiceIsRecording || !voiceAudioContext) return;
      const input = event.inputBuffer.getChannelData(0);
      const audio = encodePcm16Base64(input, voiceAudioContext.sampleRate, 24000);
      if (audio) send({ type: "voice.audio", clientId: controlClientId, audio });
    };
    voiceSource.connect(voiceProcessor);
    voiceProcessor.connect(voiceAudioContext.destination);

    voiceIsRecording = true;
    voiceButton.setAttribute("aria-pressed", "true");
    voiceButton.classList.add("recording");
    const started = send({
      type: "voice.start",
      clientId: controlClientId,
      language: serverConfig?.voiceLanguage ?? "pl-PL",
    });
    if (!started) {
      await stopVoiceRecording(false);
      return;
    }
    handleVoiceStatus("listening", "Listening.");
  } catch (error) {
    await stopVoiceRecording(false);
    handleVoiceError(error instanceof Error ? error.message : "Failed to start microphone capture.");
  }
}

async function stopVoiceRecording(notifyBridge = true): Promise<void> {
  if (!voiceIsRecording && !voiceAudioContext && !voiceStream) return;
  voiceIsRecording = false;
  voiceButton.setAttribute("aria-pressed", "false");
  voiceButton.classList.remove("recording");

  if (voiceProcessor) {
    voiceProcessor.onaudioprocess = null;
    voiceProcessor.disconnect();
    voiceProcessor = null;
  }
  if (voiceSource) {
    voiceSource.disconnect();
    voiceSource = null;
  }
  if (voiceStream) {
    for (const track of voiceStream.getTracks()) track.stop();
    voiceStream = null;
  }
  if (voiceAudioContext) {
    const context = voiceAudioContext;
    voiceAudioContext = null;
    await context.close().catch(() => undefined);
  }

  if (notifyBridge) {
    send({ type: "voice.stop", clientId: controlClientId });
    handleVoiceStatus("transcribing", "Finishing transcription.");
  } else {
    handleVoiceStatus("idle", "voice idle");
  }
}

function handleVoiceStatus(status: string, message: string | null): void {
  voiceStatus.textContent = message ?? `voice ${status}`;
  voiceStatus.dataset.status = status;
  if (status === "idle") {
    voiceButton.classList.remove("recording");
    voiceButton.setAttribute("aria-pressed", "false");
  }
}

function handleVoiceError(message: string): void {
  void stopVoiceRecording(false).finally(() => {
    voiceStatus.textContent = message;
    voiceStatus.dataset.status = "error";
    voiceButton.classList.remove("recording");
    voiceButton.setAttribute("aria-pressed", "false");
    appendLog(`Voice error: ${message}`);
  });
}

function currentVoiceTarget(): HTMLInputElement | HTMLTextAreaElement {
  const active = document.activeElement;
  if (isEditableTextElement(active)) return active;
  return promptInput;
}

function isEditableTextElement(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (!(element instanceof HTMLInputElement) || element.readOnly || element.disabled) return false;
  const type = element.type.toLowerCase();
  return ["", "text", "search", "email", "url", "tel", "password"].includes(type);
}

function applyVoiceTranscript(itemId: string, text: string, isFinal: boolean): void {
  const target = voiceComposerDraft ? promptInput
    : voiceSegments.get(itemId)?.target ?? (voiceTarget && !voiceTarget.disabled ? voiceTarget : currentVoiceTarget());
  if (voiceComposerDraft && !composerDrafts.isCurrent(voiceComposerDraft.key, voiceComposerDraft.draft)) return;
  if (target === promptInput) saveComposerDraft();
  const existing = voiceSegments.get(itemId);
  const draft = existing ?? createVoiceSegmentDraft(target);
  const nextText = isFinal ? text : draft.text + text;
  replaceVoiceSegmentText(draft, nextText);
  if (isFinal) {
    voiceSegments.delete(itemId);
  } else {
    voiceSegments.set(itemId, draft);
  }
  if (target === promptInput && (!draft.composer || draft.composer.draft === composerDraft)) {
    resetPromptHistoryNavigation();
    updatePalette();
  }
}

function createVoiceSegmentDraft(target: HTMLInputElement | HTMLTextAreaElement): VoiceSegmentDraft {
  const composer = target === promptInput ? voiceComposerDraft : undefined;
  const value = composer?.draft.editorText ?? target.value;
  const inactive = composer && composer.draft !== composerDraft;
  const start = inactive ? value.length : target.selectionStart ?? value.length;
  const end = inactive ? start : target.selectionEnd ?? start;
  const prefix = value.slice(0, start);
  const lead = prefix && !/\s$/.test(prefix) ? " " : "";
  return { target, start, end, text: lead, composer };
}

function replaceVoiceSegmentText(draft: VoiceSegmentDraft, text: string): void {
  const value = draft.composer?.draft.editorText ?? draft.target.value;
  const before = value.slice(0, draft.start);
  const after = value.slice(draft.end);
  const next = `${before}${text}${after}`;
  draft.text = text;
  draft.end = draft.start + text.length;
  if (draft.composer) {
    draft.composer.draft.editorText = next;
    if (draft.composer.draft !== composerDraft) return;
  }
  draft.target.value = next;
  draft.target.selectionStart = draft.end;
  draft.target.selectionEnd = draft.end;
  draft.target.focus();
}

function encodePcm16Base64(input: Float32Array, inputSampleRate: number, outputSampleRate: number): string {
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  if (outputLength <= 0) return "";
  const bytes = new Uint8Array(outputLength * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < outputLength; i += 1) {
    const sample = input[Math.min(input.length - 1, Math.floor(i * ratio))] ?? 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * 2, pcm, true);
  }
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return window.btoa(binary);
}

function sendPromptWithBusyHandling(options: {
  sessionId: string;
  text: string;
  editorText: string;
  images: PendingImage[];
  snippets?: PendingSnippet[];
  onSend?: () => void;
}): boolean {
  const projection = projections.get(options.sessionId);
  const commandText = options.editorText.trim();
  const knownSlashCommand = findSlashCommand(commandText);
  const liveSlashCommand = projection ? findLiveSlashCommand(commandText, projection.availableCommands ?? []) : undefined;
  const isRunnableSlashCommand = knownSlashCommand || isLiveSlashCommandRunnableWhileBusy(liveSlashCommand);
  const isSlashCommandLike = /^\/[^\s:]+/.test(commandText);

  if (projection?.isBusy) {
    if (isRunnableSlashCommand && options.images.length === 0) {
      if (!sendPromptMessage(options.sessionId, options.text, options.images)) return false;
      options.onSend?.();
      return true;
    }
    if (isSlashCommandLike) {
      appendSessionNotice(options.sessionId, {
        level: "warning",
        text: "Slash commands cannot be sent as steer or follow-up prompts while the agent is busy.",
      });
      render();
      return false;
    }
    if (!connection?.isOpen() || busyPromptDrafts.has(options.sessionId)) return false;
    busyPromptDrafts.set(options.sessionId, [createBusyPromptDraft({
      sessionId: options.sessionId,
      text: options.text,
      editorText: options.editorText,
      images: options.images,
      snippets: options.snippets,
      onSend: options.onSend,
    })]);
    renderBusyPromptChoice();
    return true;
  }

  if (!sendPromptMessage(options.sessionId, options.text, options.images)) return false;
  options.onSend?.();
  return true;
}

function renderBusyPromptChoice(): void {
  const draft = activeSessionId ? busyPromptDrafts.get(activeSessionId)?.[0] : undefined;
  const compacting = Boolean(draft && projections.get(draft.sessionId)?.compacting);
  const shouldShow = Boolean(workspaceMode === "session" && draft && draft.sessionId === activeSessionId && !compacting);
  const wasHidden = busyPromptOverlay.hidden;

  if (!draft || !shouldShow) {
    busyPromptOverlay.hidden = true;
    busyPromptText.value = "";
    busyPromptAttachmentNote.textContent = "";
    return;
  }

  const attachmentNote = formatBusyPromptAttachmentNote(draft);
  busyPromptText.value = busyPromptDisplayText(draft);
  busyPromptAttachmentNote.textContent = attachmentNote;
  busyPromptAttachmentNote.hidden = attachmentNote.length === 0;
  busyPromptOverlay.hidden = false;

  if (wasHidden) {
    requestAnimationFrame(() => {
      if (busyPromptOverlay.hidden) return;
      busyPromptText.focus();
      busyPromptText.select();
    });
  }
}

function removeBusyPromptDraft(sessionId: string): void {
  const drafts = busyPromptDrafts.get(sessionId);
  drafts?.shift();
  if (!drafts?.length) busyPromptDrafts.delete(sessionId);
}

function restoreBusyPromptDraft(): void {
  const draft = activeSessionId ? busyPromptDrafts.get(activeSessionId)?.[0] : undefined;
  if (!draft || workspaceMode !== "session") return;
  removeBusyPromptDraft(draft.sessionId);

  resetPromptHistoryNavigation();
  promptInput.value = restoreBusyPromptEditorText(draft, promptInput.value);
  pendingImages = [...draft.images, ...pendingImages];
  pendingSnippets = [...draft.snippets, ...pendingSnippets];
  renderImagePreviews();
  renderBusyPromptChoice();
  render();
  promptInput.focus();
}

function sendBusyPromptDraft(behavior: "steer" | "followUp"): void {
  const draft = activeSessionId ? busyPromptDrafts.get(activeSessionId)?.[0] : undefined;
  if (!draft || workspaceMode !== "session") return;
  // Compaction skips any prompt OMP receives, so never send a steer/follow-up into a compacting session.
  if (projections.get(draft.sessionId)?.compacting) return;
  if (!sendPromptMessage(draft.sessionId, draft.text, draft.images, behavior)) return;
  const onSend = draft.onSend;
  removeBusyPromptDraft(draft.sessionId);
  onSend?.();
  renderBusyPromptChoice();
  render();
}

function rollbackSourceIsReady(sessionId: string): boolean {
  const projection = projections.get(sessionId);
  const summary = projection?.summary ?? currentSessionSummary(sessionId);
  return Boolean(
    connection?.isOpen() &&
    projection &&
    summary?.kind === "managed" &&
    summary.status === "idle" &&
    !projection.isBusy &&
    !projection.compacting
  );
}

function canOpenRollbackChat(): boolean {
  return Boolean(
    workspaceMode === "session" &&
    activeSessionId &&
    !rollbackChatState &&
    rollbackSourceIsReady(activeSessionId)
  );
}

function openRollbackChat(): void {
  if (!canOpenRollbackChat() || !activeSessionId) return;
  setWorkspaceOptionsOpen(false);
  rollbackChatState = {
    sourceSessionId: activeSessionId,
    listRequestId: nextClientRequestId("rewind-list"),
    selectRequestId: null,
    points: [],
    selectedIndex: -1,
    phase: "loading",
    error: null,
    draft: null,
  };
  rollbackChatOverlay.hidden = false;
  syncRollbackChatDraftWarning();
  renderRollbackChat();
  renderActiveSession();
  const state = rollbackChatState;
  if (state && !send({ type: "session.rewind.list", sessionId: state.sourceSessionId, requestId: state.listRequestId })) {
    state.phase = "error";
    state.error = "Not connected to the Fura bridge.";
    renderRollbackChat();
  }
  window.setTimeout(() => rollbackChatList.focus(), 0);
}

function dismissRollbackChat(focusMenu: boolean): void {
  rollbackChatState = null;
  rollbackChatOverlay.hidden = true;
  rollbackChatList.replaceChildren();
  rollbackChatStatus.textContent = "";
  rollbackChatStatus.className = "modal-status";
  rollbackChatWarning.hidden = true;
  rollbackChatRetry.hidden = true;
  rollbackChatRestore.textContent = "Restore draft";
  renderActiveSession();
  if (focusMenu) workspaceOptionsToggle.focus();
}

function closeRollbackChat(): void {
  if (rollbackChatState?.phase === "applying") return;
  dismissRollbackChat(true);
}

function invalidateRollbackChat(): void {
  if (!rollbackChatState) return;
  dismissRollbackChat(false);
}

function requestRollbackChatPoints(): void {
  const state = rollbackChatState;
  if (!state || state.phase === "applying") return;
  if (
    workspaceMode !== "session" ||
    activeSessionId !== state.sourceSessionId ||
    !rollbackSourceIsReady(state.sourceSessionId)
  ) {
    invalidateRollbackChat();
    return;
  }
  state.listRequestId = nextClientRequestId("rewind-list");
  state.selectRequestId = null;
  state.points = [];
  state.selectedIndex = -1;
  state.phase = "loading";
  state.error = null;
  renderRollbackChat();
  if (!send({ type: "session.rewind.list", sessionId: state.sourceSessionId, requestId: state.listRequestId })) {
    state.phase = "error";
    state.error = "Not connected to the Fura bridge.";
    renderRollbackChat();
  }
}

function syncRollbackChatDraftWarning(): void {
  if (!rollbackChatState || rollbackChatOverlay.hidden) return;
  rollbackChatWarning.hidden =
    promptInput.value.length === 0 &&
    pendingImages.length === 0 &&
    pendingSnippets.length === 0;
}

function renderRollbackChat(): void {
  const state = rollbackChatState;
  if (!state) return;
  const applying = state.phase === "applying";
  rollbackChatClose.disabled = applying;
  rollbackChatCancel.disabled = applying;
  rollbackChatRetry.hidden = state.phase !== "error";
  rollbackChatRetry.disabled = applying;
  rollbackChatRestore.disabled =
    applying ||
    state.phase !== "ready" ||
    state.selectedIndex < 0 ||
    state.selectedIndex >= state.points.length;
  rollbackChatRestore.textContent = applying ? "Rolling back…" : "Restore draft";
  rollbackChatStatus.className = `modal-status${state.phase === "error" ? " error" : state.phase === "loading" || applying ? " loading" : ""}`;
  rollbackChatStatus.textContent =
    state.phase === "loading" ? "Loading earlier prompts…" :
    state.phase === "applying" ? "Rolling back…" :
    state.phase === "error" ? (state.error ?? "Rollback failed.") :
    state.points.length === 0 ? "No earlier user prompts are available." :
    `${state.points.length} earlier prompt${state.points.length === 1 ? "" : "s"}. Choose where to roll back.`;
  syncRollbackChatDraftWarning();

  rollbackChatList.replaceChildren();
  rollbackChatList.hidden = state.phase !== "ready" || state.points.length === 0;
  if (rollbackChatList.hidden) return;
  for (let index = 0; index < state.points.length; index++) {
    const point = state.points[index];
    const row = document.createElement("button");
    row.type = "button";
    row.className = `rollback-chat-row${index === state.selectedIndex ? " selected" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === state.selectedIndex));
    row.dataset.entryId = point.entryId;

    const text = document.createElement("span");
    text.className = "rollback-chat-row-text";
    text.textContent = point.text || "Image-only prompt";
    text.title = point.text || "Image-only prompt";
    row.append(text);
    if (point.imageCount > 0) {
      const count = document.createElement("span");
      count.className = "rollback-chat-row-count";
      count.textContent = `${point.imageCount} image${point.imageCount === 1 ? "" : "s"}`;
      row.append(count);
    }
    row.addEventListener("click", () => {
      const current = rollbackChatState;
      if (!current || current.phase !== "ready") return;
      current.selectedIndex = index;
      renderRollbackChat();
      rollbackChatList.querySelectorAll<HTMLButtonElement>(".rollback-chat-row")[index]?.focus();
    });
    rollbackChatList.append(row);
  }
}

function handleRollbackChatKeydown(event: KeyboardEvent): void {
  const state = rollbackChatState;
  if (!state || state.phase !== "ready" || state.points.length === 0) return;
  if (event.key === "Enter") {
    event.preventDefault();
    submitRollbackChat();
    return;
  }
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  const offset = event.key === "ArrowUp" ? -1 : 1;
  state.selectedIndex = (state.selectedIndex + offset + state.points.length) % state.points.length;
  renderRollbackChat();
  rollbackChatList.querySelectorAll<HTMLButtonElement>(".rollback-chat-row")[state.selectedIndex]?.focus();
}

function submitRollbackChat(): void {
  const state = rollbackChatState;
  const point = state?.points[state.selectedIndex];
  if (!state || !point || state.phase !== "ready") return;
  state.draft = {
    text: promptInput.value,
    images: pendingImages.map(image => ({ ...image })),
    snippets: pendingSnippets.map(snippet => ({ ...snippet })),
  };
  state.selectRequestId = nextClientRequestId("rewind-select");
  state.phase = "applying";
  state.error = null;
  renderRollbackChat();
  renderActiveSession();
  if (!send({
    type: "session.rewind.select",
    sessionId: state.sourceSessionId,
    requestId: state.selectRequestId,
    entryId: point.entryId,
  })) {
    state.selectRequestId = null;
    state.phase = "error";
    state.error = "Not connected to the Fura bridge.";
    renderRollbackChat();
    renderActiveSession();
  }
}

function restoreRollbackDraft(draft: RollbackChatDraft): void {
  promptInput.value = draft.text;
  pendingImages = draft.images.map(image => ({ ...image }));
  pendingSnippets = draft.snippets.map(snippet => ({ ...snippet }));
  renderImagePreviews();
  resetPromptHistoryNavigation();
  updatePalette();
}

function handleRollbackChatPoints(message: Extract<ServerMessage, { type: "session.rewind.points" }>): void {
  const state = rollbackChatState;
  if (
    !state ||
    state.phase !== "loading" ||
    message.requestId !== state.listRequestId ||
    message.sessionId !== state.sourceSessionId
  ) return;
  state.points = message.points;
  state.selectedIndex = message.points.length - 1;
  state.phase = "ready";
  state.error = null;
  renderRollbackChat();
  window.setTimeout(() => {
    const rows = rollbackChatList.querySelectorAll<HTMLButtonElement>(".rollback-chat-row");
    rows[state.selectedIndex]?.focus();
  }, 0);
}

function handleRollbackChatResult(message: Extract<ServerMessage, { type: "session.rewind.result" }>): void {
  const state = rollbackChatState;
  if (
    !state ||
    state.phase !== "applying" ||
    message.requestId !== state.selectRequestId ||
    message.sourceSessionId !== state.sourceSessionId
  ) return;
  if (message.cancelled) {
    const sourceSessionId = state.sourceSessionId;
    dismissRollbackChat(false);
    appendSessionNotice(sourceSessionId, { level: "info", text: "Rollback cancelled." });
    render();
    promptInput.focus();
    return;
  }

  rollbackChatState = null;
  rollbackChatOverlay.hidden = true;
  activateSession(message.sessionId);
  promptInput.value = message.text;
  pendingImages = restorePendingImagesFromDraft(message.text, message.images, createPendingMarker);
  pendingSnippets = [];
  renderImagePreviews();
  resetPromptHistoryNavigation();
  updatePalette();
  render();
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  promptInput.focus();
}

function handleRollbackChatError(message: Extract<ServerMessage, { type: "session.rewind.error" }>): void {
  const state = rollbackChatState;
  if (!state || message.sourceSessionId !== state.sourceSessionId) return;
  if (message.requestId === state.listRequestId && state.phase === "loading") {
    state.phase = "error";
    state.error = message.message;
    renderRollbackChat();
    return;
  }
  if (message.requestId !== state.selectRequestId || state.phase !== "applying") return;

  const draft = state.draft;
  if (message.sessionId !== state.sourceSessionId) {
    rollbackChatState = null;
    rollbackChatOverlay.hidden = true;
    activateSession(message.sessionId);
    if (draft) restoreRollbackDraft(draft);
    appendSessionNotice(message.sessionId, { level: "error", text: message.message });
    render();
    promptInput.focus();
    return;
  }
  if (draft) restoreRollbackDraft(draft);
  state.selectRequestId = null;
  state.phase = "error";
  state.error = message.message;
  renderRollbackChat();
  renderActiveSession();
  rollbackChatRetry.focus();
}


function openDeleteSessionPicker(sessionId: string): void {
  const session = currentSessionSummary(sessionId);
  if (!session) return;

  const view = deriveSessionDeleteView(session);
  deleteSessionTarget = view;
  deleteSessionMessage.textContent = view.message;
  deleteSessionWorktree.checked = false;
  deleteSessionWorktree.disabled = !view.canDeleteWorktree;
  deleteSessionWorktree.parentElement?.toggleAttribute("hidden", !view.canDeleteWorktree);
  deleteSessionWorktreePath.textContent = view.worktreeHelp;
  deleteSessionOverlay.hidden = false;
  window.setTimeout(() => deleteSessionCancel.focus(), 0);
}

function closeDeleteSessionPicker(): void {
  deleteSessionOverlay.hidden = true;
  deleteSessionTarget = null;
  promptInput.focus();
}

function submitDeleteSessionPicker(): void {
  const view = deleteSessionTarget;
  if (!view) return;
  if (!send(sessionDeleteMessage(view, deleteSessionWorktree.checked))) return;
  pendingDraftDeletions.add(view.sessionId);
  closeDeleteSessionPicker();
}
// --- Top-level render ---

function render(): void {
  renderSessions();
  renderActiveSession();
  renderControlConversation();
}

function sessionCategories(): string[] {
  return deriveSessionCategories(sessions);
}

function fuzzyMatchCategories(query: string): string[] {
  return fuzzyMatchSessionCategories(sessionCategories(), query);
}


function renderCategoryFilter(): void {
  selectedCategoryFilter = renderSessionCategoryFilter(
    sessionCategoryFilter,
    sessionCategories(),
    selectedCategoryFilter,
  );
}

function goalLabelsForSessions(): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const goalMode = projections.get(session.sessionId)?.goalMode ?? session.goalMode;
    const label = goalModeBadgeLabel(goalMode);
    if (label) labels.set(session.sessionId, label);
  }
  return labels;
}

function visibleSessions(): SessionSummary[] {
  return filterVisibleSessions(sessions, selectedCategoryFilter);
}

function currentSessionSummary(sessionId: string): SessionSummary | undefined {
  return sessions.find(session => session.sessionId === sessionId);
}
function activeSessionSummary(): SessionSummary | undefined {
  return activeSessionId ? (projections.get(activeSessionId)?.summary ?? currentSessionSummary(activeSessionId)) : undefined;
}


function requestSessionActivation(session: SessionSummary): boolean {
  const sent = send(sessionOpenOrAttachMessage(session));
  if (!sent) {
    pendingSessionSelectionId = session.sessionId;
    return false;
  }
  pendingSessionSelectionId = null;
  activateSession(session.sessionId);
  return true;
}

function handleSessionButtonClick(sessionId: string): void {
  const session = currentSessionSummary(sessionId);
  if (!session) return;

  requestSessionActivation(session);
  render();
}

function handleSessionDeleteClick(sessionId: string): void {
  openDeleteSessionPicker(sessionId);
}

function renderSessions(): void {
  renderCategoryFilter();
  sessionListView.render({
    sessions,
    visibleSessions: visibleSessions(),
    selectedCategoryFilter,
    activeSessionId: workspaceMode === "session" ? activeSessionId : null,
    sessionGoalLabels: goalLabelsForSessions(),
    unreadSessionIds: unreadSessions,
  });
}

function syncToolVisibilityToggle(): void {
  toolVisibilityToggle.textContent = showToolBubbles ? "Tools: on" : "Tools: off";
  toolVisibilityToggle.setAttribute("aria-checked", String(showToolBubbles));
  toolVisibilityToggle.title = showToolBubbles
    ? "Hide ordinary tool bubbles while keeping enabled edit diffs in the transcript"
    : "Show all tool bubbles in the transcript";
}

function syncEditDiffVisibilityToggle(): void {
  editDiffVisibilityToggle.textContent = showEditDiffs ? "Edit diffs: on" : "Edit diffs: off";
  editDiffVisibilityToggle.setAttribute("aria-checked", String(showEditDiffs));
  editDiffVisibilityToggle.title = showEditDiffs
    ? "Hide inline diff previews on edit tool cards"
    : "Show inline diff previews on edit tool cards";
}

function syncThinkingVisibilityToggle(): void {
  const labels: Record<ThinkingVisibilityMode, string> = {
    auto: "Thinking: auto",
    shown: "Thinking: shown",
    hidden: "Thinking: hidden",
  };
  const titles: Record<ThinkingVisibilityMode, string> = {
    auto: "Use Fura's default thinking display: live blocks expanded, historical blocks collapsed",
    shown: "Show every thinking block expanded",
    hidden: "Hide thinking blocks in the transcript",
  };
  thinkingVisibilityToggle.textContent = labels[thinkingVisibilityMode];
  thinkingVisibilityToggle.dataset.state = thinkingVisibilityMode;
  thinkingVisibilityToggle.setAttribute("aria-label", `Thinking display: ${thinkingVisibilityMode}`);
  thinkingVisibilityToggle.title = titles[thinkingVisibilityMode];
}

function syncWorkspaceOptionsMenu(): void {
  workspaceOptionsToggle.setAttribute("aria-expanded", String(workspaceOptionsOpen));
  workspaceOptionsMenu.hidden = !workspaceOptionsOpen;
}

function syncProposedModelsUi(): void {
  renderProposedModelsList();
  renderCwdProposedModelOptions();
}

function renderProposedModelsList(): void {
  proposedModelsList.replaceChildren();
  const models = serverConfig?.proposedModels ?? [];
  if (models.length === 0) {
    const empty = document.createElement("p");
    empty.className = "proposed-model-empty";
    empty.textContent = "No proposed models.";
    proposedModelsList.append(empty);
    return;
  }
  for (const model of models) {
    const row = document.createElement("div");
    row.className = "proposed-model-row";
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = model.name;
    const details = document.createElement("span");
    details.textContent = formatProposedModelDetails(model);
    text.append(title, details);
    if (proposedModelCatalog.length > 0 && !catalogContainsProposedModel(proposedModelCatalog, model)) {
      const warning = document.createElement("span");
      warning.className = "proposed-model-warning";
      warning.textContent = "Not in current OMP model catalog";
      text.append(warning);
    }
    const actions = document.createElement("div");
    actions.className = "proposed-model-row-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openProposedModelForm(model));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => saveProposedModels(removeProposedModel(models, model.id)));
    actions.append(edit, remove);
    row.append(text, actions);
    proposedModelsList.append(row);
  }
}

function renderCwdProposedModelOptions(): void {
  const previous = cwdPickerProposedModel.value || "default";
  cwdPickerProposedModel.replaceChildren();
  cwdPickerProposedModel.append(new Option("Default", "default"));
  for (const model of serverConfig?.proposedModels ?? []) {
    cwdPickerProposedModel.append(new Option(model.name, model.id));
  }
  const normalizedSelection = normalizeSelectedProposedModelId(previous, serverConfig?.proposedModels ?? []);
  cwdPickerProposedModel.value = normalizedSelection;
}

function openProposedModelsDialog(): void {
  proposedModelsOverlay.hidden = false;
  setWorkspaceOptionsOpen(false);
  syncProposedModelsUi();
  requestProposedModelCatalog();
  window.setTimeout(() => proposedModelAdd.focus(), 0);
}

function closeProposedModelsDialog(): void {
  if (proposedModelSavePending) return;
  proposedModelsOverlay.hidden = true;
  closeProposedModelForm();
}

function requestProposedModelCatalog(): void {
  if (proposedModelCatalog.length > 0 || proposedModelCatalogLoading) return;
  proposedModelCatalogLoading = true;
  proposedModelCatalogRequestId = nextClientRequestId("model-catalog");
  proposedModelStatus.textContent = "Loading runtime models…";
  if (!send({ type: "config.modelCatalog.list", requestId: proposedModelCatalogRequestId })) {
    proposedModelCatalogLoading = false;
    proposedModelStatus.textContent = "Not connected to the Fura bridge.";
  }
}

function openProposedModelForm(model: ProposedModelConfig | null = null): void {
  proposedModelFormOpen = true;
  proposedModelEditingId = model?.id ?? null;
  proposedModelForm.hidden = false;
  proposedModelNameInput.value = model?.name ?? "";
  proposedModelSearchInput.value = model?.modelName || model?.modelId || "";
  proposedModelThinkingSelect.value = model?.thinkingLevel ?? "default";
  proposedModelCatalogSelectedIndex = 0;
  proposedModelStatus.textContent = "";
  renderProposedModelCatalog();
  if (model && proposedModelCatalog.length > 0) {
    selectProposedCatalogModel(model.provider, model.modelId);
  }
  requestProposedModelCatalog();
  window.setTimeout(() => proposedModelNameInput.focus(), 0);
}

function closeProposedModelForm(options: { preserveStatus?: boolean } = {}): void {
  if (proposedModelSavePending) return;
  proposedModelFormOpen = false;
  proposedModelEditingId = null;
  proposedModelForm.hidden = true;
  if (!options.preserveStatus) proposedModelStatus.textContent = "";
}

function renderProposedModelCatalog(): void {
  proposedModelCatalogList.replaceChildren();
  const models = filterCatalogModels(proposedModelCatalog, proposedModelSearchInput.value);
  if (proposedModelCatalogSelectedIndex >= models.length) {
    proposedModelCatalogSelectedIndex = Math.max(0, models.length - 1);
  }
  if (proposedModelCatalogLoading && proposedModelCatalog.length === 0) {
    proposedModelCatalogList.textContent = "Loading models…";
    return;
  }
  if (models.length === 0) {
    proposedModelCatalogList.textContent = proposedModelSearchInput.value.trim() ? "No matching models." : "No models loaded.";
    return;
  }
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "proposed-model-catalog-row";
    row.classList.toggle("selected", index === proposedModelCatalogSelectedIndex);
    row.textContent = formatCatalogModelLabel(model);
    row.addEventListener("click", () => {
      proposedModelCatalogSelectedIndex = index;
      renderProposedModelCatalog();
    });
    proposedModelCatalogList.append(row);
  }
}

function selectProposedCatalogModel(provider: string, modelId: string): void {
  const models = filterCatalogModels(proposedModelCatalog, proposedModelSearchInput.value);
  const index = models.findIndex(model => model.provider === provider && model.id === modelId);
  if (index >= 0) {
    proposedModelCatalogSelectedIndex = index;
    renderProposedModelCatalog();
  }
}

function saveProposedModelFromForm(): void {
  if (proposedModelSavePending) return;
  const name = proposedModelNameInput.value.trim();
  if (!name) {
    proposedModelStatus.textContent = "Name is required.";
    return;
  }
  const selected = filterCatalogModels(proposedModelCatalog, proposedModelSearchInput.value)[proposedModelCatalogSelectedIndex];
  if (!selected) {
    proposedModelStatus.textContent = "Choose a runtime model.";
    return;
  }
  const existing = serverConfig?.proposedModels ?? [];
  const editingId = proposedModelEditingId;
  const model: ProposedModelConfig = {
    id: editingId ?? proposedModelIdFromName(name, existing.map(item => item.id)),
    name,
    provider: selected.provider,
    modelId: selected.id,
    modelName: selected.name ?? null,
    thinkingLevel: proposedModelThinkingSelect.value as ProposedThinkingLevel,
  };
  const nextModels = upsertProposedModel(existing, model, editingId);
  saveProposedModels(nextModels);
}

function saveProposedModels(models: ProposedModelConfig[]): void {
  const error = validateProposedModels(models);
  if (error) {
    proposedModelStatus.textContent = error;
    return;
  }
  proposedModelSavePending = true;
  proposedModelStatus.textContent = "Saving proposed models…";
  if (!send({ type: "config.set", proposedModels: models })) {
    proposedModelSavePending = false;
    proposedModelStatus.textContent = "Not connected to the Fura bridge.";
  }
}

function showPresetsOverlay(): void {
  presetsOverlay.hidden = false;
  setWorkspaceOptionsOpen(false);
}

function closePresetsOverlay(): void {
  presetPending = null;
  presetsOverlay.hidden = true;
}

function openPresetsPicker(): void {
  presetsView = "picker";
  showPresetsOverlay();
  renderPresets();
}

function openPresetRun(preset: PresetSummary, fromPicker: boolean): void {
  presetRunTarget = preset;
  presetRunFromPicker = fromPicker;
  presetRunValues = {};
  for (const param of parsePresetParams(preset.body)) {
    presetRunValues[param] = Object.prototype.hasOwnProperty.call(preset.defaults, param)
      ? preset.defaults[param]
      : "";
  }
  presetsView = "run";
  showPresetsOverlay();
  renderPresets();
}

function openPresetEditor(preset: PresetSummary | null): void {
  presetEditorOriginalName = preset?.name ?? null;
  presetEditorDefaults = preset ? { ...preset.defaults } : {};
  presetsView = "editor";
  showPresetsOverlay();
  renderPresets();
}

function handlePresetCommand(editorText: string, sessionId: string): void {
  // Reload presets from disk on every invocation so externally-added files (or
  // edits from another client) show up. Resolve once the refreshed list arrives
  // via config.updated; fall back to the cached list when offline.
  clearPromptEditor();
  pendingPresetCommand = { editorText, sessionId };
  if (!send({ type: "presets.refresh" })) resolvePendingPresetCommand();
}

function resolvePendingPresetCommand(): void {
  const command = pendingPresetCommand;
  if (!command) return;
  pendingPresetCommand = null;
  const resolution = resolvePresetCommand(command.editorText, serverConfig?.presets ?? []);
  switch (resolution.kind) {
    case "picker":
      openPresetsPicker();
      break;
    case "unknown": {
      const available = resolution.available.length > 0 ? resolution.available.join(", ") : "none";
      appendSessionNotice(command.sessionId, {
        level: "warning",
        text: `Unknown preset "${resolution.name}". Available: ${available}.`,
      });
      render();
      break;
    }
    case "run":
      runPreset(resolution.preset, {}, "send", command.sessionId);
      break;
    case "params":
      openPresetRun(resolution.preset, false);
      break;
  }
}

function runPreset(
  preset: PresetSummary,
  values: Record<string, string>,
  mode: "send" | "insert",
  sessionId: string | null = activeSessionId,
): void {
  const text = substitutePresetParams(preset.body, values);
  if (mode === "insert") {
    closePresetsOverlay();
    promptInput.value = text;
    promptInput.focus();
    updatePalette();
    return;
  }
  if (!sessionId) {
    presetsStatus.textContent = "No active session.";
    return;
  }
  const accepted = sendPromptWithBusyHandling({ sessionId, text, editorText: text, images: [] });
  if (accepted) closePresetsOverlay();
}

function renderPresets(): void {
  presetsBody.replaceChildren();
  presetsActions.replaceChildren();
  if (presetsView === "picker") renderPresetsPicker();
  else if (presetsView === "run") renderPresetRun();
  else renderPresetEditor();
}

function renderPresetsPicker(): void {
  presetsTitle.textContent = "Presets";
  presetsSubtitle.textContent = "Run a saved prompt preset.";
  presetsStatus.textContent = "";
  const presets = serverConfig?.presets ?? [];
  const list = document.createElement("div");
  list.className = "presets-list";
  if (presets.length === 0) {
    const empty = document.createElement("p");
    empty.className = "presets-empty";
    empty.textContent = "No presets yet. Create one to get started.";
    list.append(empty);
  } else {
    for (const preset of presets) {
      const row = document.createElement("div");
      row.className = "presets-row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "presets-row-open";
      const title = document.createElement("strong");
      title.textContent = preset.name;
      const desc = document.createElement("span");
      desc.textContent = preset.description || "(no description)";
      open.append(title, desc);
      open.addEventListener("click", () => openPresetRun(preset, true));
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "presets-row-edit";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => openPresetEditor(preset));
      row.append(open, edit);
      list.append(row);
    }
  }
  presetsBody.append(list);

  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.className = "presets-primary";
  newButton.textContent = "New preset";
  newButton.addEventListener("click", () => openPresetEditor(null));
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", closePresetsOverlay);
  presetsActions.append(newButton, close);
}

function renderPresetRun(): void {
  const preset = presetRunTarget;
  if (!preset) {
    openPresetsPicker();
    return;
  }
  presetsTitle.textContent = preset.name;
  presetsSubtitle.textContent = preset.description || "Fill in any parameters, then send.";
  presetsStatus.textContent = "";
  const params = parsePresetParams(preset.body);

  const preview = document.createElement("pre");
  preview.className = "presets-preview";
  const sendButton = document.createElement("button");
  sendButton.type = "button";
  sendButton.className = "presets-primary";
  sendButton.textContent = "Send";
  const insertButton = document.createElement("button");
  insertButton.type = "button";
  insertButton.textContent = "Insert into composer";

  const updateDerived = (): void => {
    preview.textContent = substitutePresetParams(preset.body, presetRunValues);
    const ready = requiredParamsFilled(params, preset.defaults, presetRunValues);
    sendButton.disabled = !ready;
    insertButton.disabled = !ready;
  };

  if (params.length > 0) {
    const fields = document.createElement("div");
    fields.className = "presets-fields";
    for (const param of params) {
      const field = document.createElement("label");
      field.className = "presets-field";
      const span = document.createElement("span");
      const required = !Object.prototype.hasOwnProperty.call(preset.defaults, param);
      span.textContent = required ? `${param} (required)` : param;
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.value = presetRunValues[param] ?? "";
      input.addEventListener("input", () => {
        presetRunValues[param] = input.value;
        updateDerived();
      });
      field.append(span, input);
      fields.append(field);
    }
    presetsBody.append(fields);
  }

  const previewLabel = document.createElement("p");
  previewLabel.className = "presets-preview-label";
  previewLabel.textContent = "Preview";
  presetsBody.append(previewLabel, preview);

  sendButton.addEventListener("click", () => runPreset(preset, presetRunValues, "send"));
  insertButton.addEventListener("click", () => runPreset(preset, presetRunValues, "insert"));
  if (presetRunFromPicker) {
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Back";
    back.addEventListener("click", openPresetsPicker);
    presetsActions.append(back);
  }
  presetsActions.append(insertButton, sendButton);

  updateDerived();
  const firstInput = presetsBody.querySelector<HTMLInputElement>(".presets-field input");
  if (firstInput) window.setTimeout(() => firstInput.focus(), 0);
}

function renderPresetEditor(): void {
  const editing = presetEditorOriginalName;
  const existing = editing ? (serverConfig?.presets ?? []).find(p => p.name === editing) : null;
  presetsTitle.textContent = editing ? `Edit preset: ${editing}` : "New preset";
  presetsSubtitle.textContent = "Use {param} placeholders for fields you fill at send time.";
  presetsStatus.textContent = "";

  const nameField = presetLabeledInput("Name", existing?.name ?? "");
  nameField.input.placeholder = "update-skill";
  if (editing) nameField.input.disabled = true;
  const descField = presetLabeledInput("Description (optional)", existing?.description ?? "");
  descField.input.placeholder = "What this preset does";

  const bodyLabel = document.createElement("label");
  bodyLabel.className = "presets-field";
  const bodySpan = document.createElement("span");
  bodySpan.textContent = "Prompt body";
  const bodyInput = document.createElement("textarea");
  bodyInput.rows = 8;
  bodyInput.spellcheck = false;
  bodyInput.value = existing?.body ?? "";
  bodyLabel.append(bodySpan, bodyInput);

  const paramsSection = document.createElement("div");
  paramsSection.className = "presets-detected";
  const renderDetected = (): void => {
    paramsSection.replaceChildren();
    const params = parsePresetParams(bodyInput.value);
    const heading = document.createElement("p");
    heading.className = "presets-detected-label";
    heading.textContent =
      params.length === 0 ? "No parameters detected." : "Parameters (optional defaults):";
    paramsSection.append(heading);
    for (const param of params) {
      const field = document.createElement("label");
      field.className = "presets-field presets-default-field";
      const span = document.createElement("span");
      span.textContent = param;
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "default (optional)";
      input.value = presetEditorDefaults[param] ?? "";
      input.addEventListener("input", () => {
        presetEditorDefaults[param] = input.value;
      });
      field.append(span, input);
      paramsSection.append(field);
    }
  };
  bodyInput.addEventListener("input", renderDetected);
  renderDetected();

  presetsBody.append(nameField.label, descField.label, bodyLabel, paramsSection);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "presets-primary";
  save.textContent = "Save";
  save.addEventListener("click", () =>
    savePresetFromEditor(nameField.input.value, descField.input.value, bodyInput.value),
  );
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", openPresetsPicker);
  if (editing) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "presets-danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => deletePreset(editing));
    presetsActions.append(del);
  }
  presetsActions.append(cancel, save);
}

function presetLabeledInput(
  labelText: string,
  value: string,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.className = "presets-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = value;
  label.append(span, input);
  return { label, input };
}

function savePresetFromEditor(rawName: string, description: string, body: string): void {
  if (presetPending) return;
  const editing = presetEditorOriginalName;
  const name = editing ?? presetNameFromInput(rawName);
  if (!name) {
    presetsStatus.textContent = "Name is required.";
    return;
  }
  if (!isValidPresetName(name)) {
    presetsStatus.textContent = "Name must be lowercase letters, digits, '-' or '_'.";
    return;
  }
  if (!body.trim()) {
    presetsStatus.textContent = "Prompt body is required.";
    return;
  }
  if (!editing && (serverConfig?.presets ?? []).some(p => p.name === name)) {
    presetsStatus.textContent = `A preset named "${name}" already exists.`;
    return;
  }
  const defaults = pruneDefaults(parsePresetParams(body), presetEditorDefaults);
  presetPending = { kind: "save", name };
  presetsStatus.textContent = "Saving…";
  if (!send(buildPresetSaveMessage(name, description, body, defaults))) {
    presetPending = null;
    presetsStatus.textContent = "Not connected to the Fura bridge.";
  }
}

function deletePreset(name: string): void {
  if (presetPending) return;
  presetPending = { kind: "delete", name };
  presetsStatus.textContent = "Deleting…";
  if (!send({ type: "preset.delete", name })) {
    presetPending = null;
    presetsStatus.textContent = "Not connected to the Fura bridge.";
  }
}

function syncPresetsUi(): void {
  if (presetsOverlay.hidden) return;
  if (presetsView === "run" && presetRunTarget) {
    const latest = (serverConfig?.presets ?? []).find(p => p.name === presetRunTarget?.name);
    if (latest) presetRunTarget = latest;
    else {
      presetsView = "picker";
      presetRunTarget = null;
    }
  }
  renderPresets();
}

function setWorkspaceOptionsOpen(open: boolean): void {
  workspaceOptionsOpen = open;
  syncWorkspaceOptionsMenu();
}

function syncDuplicateSessionButton(): void {
  const summary = activeSessionSummary();
  const projection = activeSessionId ? projections.get(activeSessionId) : undefined;
  duplicateSessionButton.textContent = pendingSessionFork ? "Duplicating…" : "Duplicate chat";
  duplicateSessionButton.disabled = !(
    workspaceMode === "session" &&
    activeSessionId &&
    summary?.kind === "managed" &&
    summary.status === "idle" &&
    !projection?.isBusy &&
    !projection?.compacting &&
    !pendingSessionFork
  );
}

function applyVisibilityPreferences(
  showTools: boolean,
  showEditDiffsNext: boolean,
  thinkingMode: ThinkingVisibilityMode,
): void {
  const toolsChanged = showToolBubbles !== showTools;
  const editDiffsChanged = showEditDiffs !== showEditDiffsNext;
  const thinkingChanged = thinkingVisibilityMode !== thinkingMode;
  showToolBubbles = showTools;
  showEditDiffs = showEditDiffsNext;
  thinkingVisibilityMode = thinkingMode;
  syncToolVisibilityToggle();
  syncEditDiffVisibilityToggle();
  syncThinkingVisibilityToggle();
  if (thinkingChanged) {
    skipThinkingOpenRestoreOnce = true;
    markTranscriptViewDirty({ resetCache: true });
  } else if (toolsChanged || editDiffsChanged) {
    // Edit diff visibility is part of the tool-card render key, so a plain
    // re-render re-keys only the tool cards; message DOM stays cached.
    markTranscriptViewDirty();
  }
  if (editDiffsChanged) markToolsViewDirty();
  if (toolsChanged || editDiffsChanged || thinkingChanged) {
    renderActiveSession();
  }
}

function markActiveCategoryDirty(): void {
  activeCategoryEditorDirty = true;
  activeCategoryEditorSessionId = activeSessionId;
  activeCategorySave.disabled = workspaceMode !== "session" || !activeSessionId;
}

function syncActiveCategoryEditor(projection: SessionProjection | undefined): void {
  const canEditCategory = workspaceMode === "session" && Boolean(activeSessionId);
  const category = normalizedCategory(projection?.summary.category);
  const shouldReset = activeCategoryEditorSessionId !== activeSessionId || !activeCategoryEditorDirty;
  activeCategoryInput.disabled = !canEditCategory;
  activeCategorySave.disabled = !canEditCategory || (!activeCategoryEditorDirty && activeCategoryInput.value.trim() === category);
  if (!canEditCategory || shouldReset) {
    activeCategoryInput.value = canEditCategory ? category : "";
    activeCategoryEditorSessionId = activeSessionId;
    activeCategoryEditorDirty = false;
    activeCategorySave.disabled = true;
  }
}

function submitActiveCategory(): void {
  if (workspaceMode !== "session" || !activeSessionId) return;
  const category = normalizedCategory(activeCategoryInput.value);
  send(category
    ? { type: "session.setCategory", sessionId: activeSessionId, category }
    : { type: "session.setCategory", sessionId: activeSessionId });
  activeCategoryEditorDirty = false;
  activeCategoryEditorSessionId = activeSessionId;
  activeCategorySave.disabled = true;
}


// Renders the workspace header, status bar, and busy prompt choice.
// Drives re-render of the active Dockview panel via its stored element reference.
function renderActiveSession(): void {
  const workspaceKey = activeWorkspaceKey();
  const sessionChanged = workspaceKey !== lastRenderedSessionId;
  lastRenderedSessionId = workspaceKey;

  if (sessionChanged) {
    markTranscriptViewDirty();
    markToolsViewDirty();
  }

  if (workspaceMode === "controller") {
    abortButton.disabled = true;
    stopButton.disabled = true;
    deleteSessionButton.disabled = true;
    rollbackChatButton.disabled = true;
    syncActiveCategoryEditor(undefined);
    const isWorking = controlStatusState.status === "working";
    promptInput.disabled = isWorking;
    sendButton.disabled = isWorking;
    syncDuplicateSessionButton();
    sessionTitle.textContent = "Ask Fura";
    sessionMeta.textContent = "Fura controller session · can find, discuss, and open sessions.";
    promptInput.placeholder = isWorking ? "Ask Fura is working…" : "Ask Fura about sessions…";
    renderControllerStatusBar();
    renderBusyPromptChoice();
    renderActiveDockviewPanel(undefined);
    return;
  }
  if (
    rollbackChatState &&
    rollbackChatState.phase !== "applying" &&
    (
      activeSessionId !== rollbackChatState.sourceSessionId ||
      !rollbackSourceIsReady(rollbackChatState.sourceSessionId)
    )
  ) {
    invalidateRollbackChat();
    return;
  }

  const projection = activeSessionId ? projections.get(activeSessionId) : undefined;
  const rollbackApplying = rollbackChatState?.phase === "applying";
  const summary = projection?.summary ?? activeSessionSummary();
  const hasBusyDraft = Boolean(activeSessionId && busyPromptDrafts.has(activeSessionId));
  const awaitingAsk = Boolean(summary?.awaitingAsk);
  const compacting = Boolean(projection?.compacting);

  abortButton.disabled = !activeSessionId;
  stopButton.disabled = !activeSessionId;
  deleteSessionButton.disabled = !activeSessionId;
  rollbackChatButton.disabled = !canOpenRollbackChat();
  syncActiveCategoryEditor(projection);
  promptInput.disabled = !activeSessionId || hasBusyDraft || awaitingAsk || compacting || rollbackApplying;
  sendButton.disabled = !activeSessionId || hasBusyDraft || awaitingAsk || compacting || rollbackApplying;
  syncDuplicateSessionButton();

  if (!activeSessionId || !summary) {
    sessionTitle.textContent = "No session selected";
    sessionMeta.textContent = "Create or attach to a session to begin.";
    promptInput.placeholder = "Select a session first";
  } else {
    sessionTitle.textContent = summary.title || `Session ${shortId(activeSessionId)}`;
    const category = normalizedCategory(summary.category);
    const categoryPart = category ? ` · ${category}` : "";
    sessionMeta.textContent = `${sessionKindLabel(summary.kind)} · ${sessionStatusLabel(summary)}${categoryPart} · ${summary.cwd ?? "no dir"}`;
    promptInput.placeholder = compacting
      ? "Compacting context… please wait"
      : awaitingAsk
        ? "Answer the agent's question above to continue…"
        : "Send a prompt… (type / for commands)";
  }

  renderStatusBar(projection);
  renderBusyPromptChoice();
  renderActiveDockviewPanel(projection);
  if (sessionChanged) requestActiveDiffState();
}

function sendGoalStart(sessionId: string, objective: string, tokenBudget?: number): void {
  send({ type: "goal.start", sessionId, objective, tokenBudget });
}

function sendGoalControl(sessionId: string, action: GoalControlAction): void {
  if (action === "drop" && !window.confirm("Drop goal? This removes the goal record; accumulated usage stays in the session log.")) return;
  send({ type: "goal.control", sessionId, action });
}

function sendGoalBudget(sessionId: string, tokenBudget?: number): void {
  send({ type: "goal.setBudget", sessionId, tokenBudget });
}

function renderGoalModePanel(container: HTMLElement, projection: SessionProjection | undefined): void {
  container.replaceChildren();
  const sessionId = projection?.summary.sessionId;
  const card = renderGoalModeCard(
    container.ownerDocument,
    projection?.goalMode,
    "desktop",
    sessionId
      ? {
          onStart: (objective, tokenBudget) => sendGoalStart(sessionId, objective, tokenBudget),
          onControl: action => sendGoalControl(sessionId, action),
          onSetBudget: tokenBudget => sendGoalBudget(sessionId, tokenBudget),
        }
      : undefined,
  );
  if (card) {
    container.append(card);
    return;
  }
  const empty = mkEl("p");
  empty.className = "empty";
  empty.textContent = "Select a session to view or set a goal.";
  container.append(empty);
}

function markTranscriptViewDirty(options: { resetCache?: boolean } = {}): void {
  transcriptPanelDirty = true;
  if (options.resetCache) transcriptRenderRevision += 1;
}

function markToolsViewDirty(): void {
  toolsPanelDirty = true;
}

function markCodeViewDirty(): void {
  codePanelDirty = true;
}


function resetCodeViewForSession(sessionId: string | null): void {
  clearCodeRevision();
  codeSessionId = sessionId;
  codeWorkspace = null;
  codeTreePath = "";
  codeTreeEntries = [];
  codeFile = null;
  codeLoadingWorkspace = false;
  codeLoadingTree = false;
  codeLoadingFile = false;
  codeError = null;
  pendingCodeOpenRequest = null;
  pendingCodeRefresh = null;
  codeSearchOpen = false;
  codeSearchBasePath = "";
  codeSearchQuery = "";
  codeSearchResults = [];
  codeSearchLoading = false;
  codeSearchError = null;
  closeCodeContextMenu();
  codeAnalyzerStatus = null;
  codeAnalyzerMessage = null;
  codeReferences = null;
  codePendingScrollLine = null;
  codeDefinitionRequestId = null;
  codeReferencesRequestId = null;
  clearPendingCodeSearchRequest();
  markCodeViewDirty();
}

function activeCodeViewState(): CodeViewerState {
  const activeCodeComments =
    workspaceMode === "session" && activeSessionId && codeWorkspace && codeFile
      ? selectedCodeComments(sessionCodeComments(activeSessionId).get(codeCommentFileKey(codeWorkspace.root, codeFile.path)) ?? [], codeWorkspace.root, codeFile)
      : [];
  return {
    activeSessionId: workspaceMode === "session" ? activeSessionId : null,
    workspace: codeWorkspace,
    treePath: codeTreePath,
    entries: codeTreeEntries,
    file: codeFile,
    loadingWorkspace: codeLoadingWorkspace,
    loadingTree: codeLoadingTree,
    loadingFile: codeLoadingFile,
    error: codeError,
    searchOpen: codeSearchOpen,
    searchBasePath: codeSearchBasePath,
    searchQuery: codeSearchQuery,
    searchResults: codeSearchResults,
    searchLoading: codeSearchLoading,
    searchError: codeSearchError,
    fileComments: activeCodeComments,
    analyzerStatus: codeAnalyzerStatus,
    analyzerMessage: codeAnalyzerMessage,
    references: codeReferences,
    pendingScrollLine: codePendingScrollLine,
  };
}

function clearPendingCodeSearchRequest(): void {
  if (codeSearchRequestTimer !== null) {
    window.clearTimeout(codeSearchRequestTimer);
    codeSearchRequestTimer = null;
  }
}

function scheduleCodeSearch(): void {
  clearPendingCodeSearchRequest();
  if (!codeSearchOpen || !codeWorkspace || !codeSearchQuery.trim()) {
    codeSearchLoading = false;
    codeSearchResults = [];
    markCodeViewDirty();
    renderCodePanelIfNeeded(true);
    return;
  }
  codeSearchLoading = true;
  codeSearchError = null;
  codeSearchResults = [];
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
  codeSearchRequestTimer = window.setTimeout(() => {
    codeSearchRequestTimer = null;
    submitCodeSearch();
  }, 120);
}

function requestCodeWorkspaceForSession(sessionId: string): void {
  if (codeSessionId !== sessionId) resetCodeViewForSession(sessionId);
  if (codeWorkspace || codeLoadingWorkspace) return;
  codeLoadingWorkspace = true;
  codeError = null;
  markCodeViewDirty();
  send({ type: "code.workspace.open", sessionId });
}

function ensureActiveCodeWorkspace(): void {
  if (codeRevision) return;
  if (pendingCodeOpenRequest) return;
  if (!desktopDockview?.isPanelActive("code")) return;
  const sessionId = workspaceMode === "session" ? activeSessionId : null;
  if (!sessionId) return;
  requestCodeWorkspaceForSession(sessionId);
}

function refreshCodeWorkspace(): void {
  if (codeRevision) return;
  if (!codeWorkspace) {
    ensureActiveCodeWorkspace();
    renderCodePanelIfNeeded(true);
    return;
  }
  pendingCodeRefresh = {
    workspace: codeWorkspace,
    sessionId: codeSessionId,
    treePath: codeTreePath,
    filePath: codeFile?.path ?? null,
  };
  codeLoadingWorkspace = true;
  codeLoadingFile = codeFile !== null;
  codeError = null;
  closeCodeContextMenu();
  send({
    type: "code.workspace.openRoot",
    root: codeWorkspace.root,
    source: codeWorkspace.source,
    reviewWorktreeId: codeWorkspace.reviewWorktreeId,
  });
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
}

function requestCodeTree(path: string): void {
  if (codeRevision) return;
  if (!codeWorkspace) return;
  codeTreePath = path;
  codeLoadingTree = true;
  codeError = null;
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
  send({ type: "code.tree.list", workspaceId: codeWorkspace.workspaceId, path });
}

function requestCodeFile(path: string): void {
  if (codeRevision) return;
  if (!codeWorkspace) return;
  codeLoadingFile = true;
  closeCodeContextMenu();
  // Opening a (possibly different) file supersedes any in-flight navigation, so
  // a late reply for the previous file must not jump the panel or repopulate it.
  codeDefinitionRequestId = null;
  codeReferencesRequestId = null;
  codeError = null;
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
  send({ type: "code.file.open", workspaceId: codeWorkspace.workspaceId, path });
}

function requestCodeDefinition(line: number, character: number): void {
  if (codeRevision) return;
  if (!codeWorkspace || !codeFile) return;
  codeAnalyzerStatus = "starting";
  codeAnalyzerMessage = null;
  // A fresh attempt clears any prior navigation error (e.g. "No definition found").
  codeError = null;
  const requestId = randomUuid();
  codeDefinitionRequestId = requestId;
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
  send({ type: "code.definition", workspaceId: codeWorkspace.workspaceId, path: codeFile.path, line, character, requestId });
}

function requestCodeReferences(line: number, character: number): void {
  if (codeRevision) return;
  if (!codeWorkspace || !codeFile) return;
  codeAnalyzerStatus = "starting";
  codeAnalyzerMessage = null;
  codeError = null;
  const requestId = randomUuid();
  codeReferencesRequestId = requestId;
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
  send({ type: "code.references", workspaceId: codeWorkspace.workspaceId, path: codeFile.path, line, character, requestId });
}

function requestCodeHover(line: number, character: number): string {
  const requestId = randomUuid();
  codeHoverRequestId = requestId;
  if (codeWorkspace && codeFile) {
    send({ type: "code.hover", workspaceId: codeWorkspace.workspaceId, path: codeFile.path, line, character, requestId });
  }
  return requestId;
}

function openCodeContextMenu(line: number, character: number, x: number, y: number): void {
  if (codeRevision) return;
  if (!codeWorkspace || !codeFile) return;
  const requestId = requestCodeHover(line, character);
  codeContextMenu = { line, character, x, y, requestId, hover: { status: "loading", contents: null } };
  renderCodeContextMenuOverlay();
}

function closeCodeContextMenu(): void {
  codeHoverRequestId = null;
  if (!codeContextMenu && !codeContextMenuEl) return;
  codeContextMenu = null;
  detachCodeContextMenuListeners();
  if (codeContextMenuEl) codeContextMenuEl.remove();
  codeContextMenuEl = null;
}

// Resolve a still-loading right-click popup to a terminal hover state. A no-op
// once hover has rendered (so a shared-workspace failure can't clobber an
// already-shown result) or when no popup is open. The hover request id is left
// intact so a still-correlated `code.hover` can later upgrade the display.
function resolvePendingHover(status: "error" | "empty"): void {
  if (!codeContextMenu || codeContextMenu.hover.status !== "loading") return;
  codeContextMenu = { ...codeContextMenu, hover: { status, contents: null } };
  renderCodeContextMenuOverlay();
}

function ensureCodeContextMenuEl(): HTMLElement {
  if (codeContextMenuEl && codeContextMenuEl.isConnected) return codeContextMenuEl;
  const el = document.createElement("div");
  el.className = "code-context-menu";
  // Keep right-clicks on the popup from opening a nested native menu.
  el.addEventListener("contextmenu", event => event.preventDefault());
  document.body.append(el);
  codeContextMenuEl = el;
  return el;
}

function renderCodeContextMenuOverlay(): void {
  const menu = codeContextMenu;
  if (!menu) {
    closeCodeContextMenu();
    return;
  }
  const el = ensureCodeContextMenuEl();
  renderCodeContextMenu(
    el,
    { line: menu.line, character: menu.character, hover: menu.hover } satisfies CodeContextMenuViewState,
    {
      goToDefinition: (line, character) => {
        requestCodeDefinition(line, character);
        closeCodeContextMenu();
      },
      findReferences: (line, character) => {
        requestCodeReferences(line, character);
        closeCodeContextMenu();
      },
    },
    renderMarkdown,
  );
  positionCodeContextMenu(el, menu.x, menu.y);
  attachCodeContextMenuListeners();
}

function positionCodeContextMenu(el: HTMLElement, x: number, y: number): void {
  // Anchor at the cursor, then clamp into the viewport once the size is known.
  const view = el.ownerDocument.defaultView ?? window;
  const margin = 8;
  const rect = el.getBoundingClientRect();
  const maxX = view.innerWidth - rect.width - margin;
  const maxY = view.innerHeight - rect.height - margin;
  const left = Math.max(margin, Math.min(x, Number.isFinite(maxX) ? maxX : x));
  const top = Math.max(margin, Math.min(y, Number.isFinite(maxY) ? maxY : y));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function handleCodeContextMenuDismissPointer(event: MouseEvent): void {
  if (codeContextMenuEl && event.target instanceof Node && codeContextMenuEl.contains(event.target)) return;
  closeCodeContextMenu();
}

function handleCodeContextMenuKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closeCodeContextMenu();
}

function handleCodeContextMenuWheel(event: WheelEvent): void {
  // Dismiss on a user wheel/trackpad gesture over the page (the cursor anchor is
  // then stale), but not when scrolling the popup's own hover pane. We key off
  // `wheel`, not `scroll`, so the programmatic scroll-position restore that runs
  // on every code-panel re-render never dismisses the popup.
  if (codeContextMenuEl && event.target instanceof Node && codeContextMenuEl.contains(event.target)) return;
  closeCodeContextMenu();
}

function attachCodeContextMenuListeners(): void {
  if (codeContextMenuListenersAttached) return;
  codeContextMenuListenersAttached = true;
  document.addEventListener("mousedown", handleCodeContextMenuDismissPointer, true);
  document.addEventListener("keydown", handleCodeContextMenuKey, true);
  document.addEventListener("wheel", handleCodeContextMenuWheel, true);
  window.addEventListener("resize", closeCodeContextMenu, true);
}

function detachCodeContextMenuListeners(): void {
  if (!codeContextMenuListenersAttached) return;
  codeContextMenuListenersAttached = false;
  document.removeEventListener("mousedown", handleCodeContextMenuDismissPointer, true);
  document.removeEventListener("keydown", handleCodeContextMenuKey, true);
  document.removeEventListener("wheel", handleCodeContextMenuWheel, true);
  window.removeEventListener("resize", closeCodeContextMenu, true);
}

function handleCodeDefinition(locations: CodeLocation[]): void {
  const local = locations.find(location => location.kind === "local" && location.path);
  if (local) {
    openReferenceLocation(local);
    return;
  }
  codeError = locations.length === 0 ? "No definition found." : "Definition is outside this workspace.";
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
}

function openReferenceLocation(location: CodeLocation): void {
  if (location.kind !== "local" || !location.path) return;
  codePendingScrollLine = location.range.start.line + 1;
  if (codeFile && codeFile.path === location.path) {
    markCodeViewDirty();
    renderCodePanelIfNeeded(true);
  } else {
    // requestCodeFile first sets loadingFile=true, which guards the one-shot
    // scroll from being consumed by the intermediate tree render. Request the
    // target's parent tree explicitly so the sidebar follows even when an
    // earlier tree load is still in flight.
    requestCodeFile(location.path);
    requestCodeTree(parentCodePath(location.path) ?? "");
  }
}

function openCodeSearch(): void {
  if (codeRevision) return;
  if (!desktopDockview?.isPanelActive("code")) return;
  if (!codeWorkspace && !codeLoadingWorkspace) ensureActiveCodeWorkspace();
  codeSearchOpen = true;
  codeSearchBasePath = codeSearchBasePath || codeWorkspace?.root || "";
  codeSearchError = null;
  codeSearchResults = [];
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
}

function closeCodeSearch(): void {
  clearPendingCodeSearchRequest();
  codeSearchOpen = false;
  codeSearchLoading = false;
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
}

function submitCodeSearch(): void {
  if (!codeWorkspace || !codeSearchQuery.trim()) return;
  codeSearchLoading = true;
  codeSearchError = null;
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
  send({
    type: "code.file.search",
    workspaceId: codeWorkspace.workspaceId,
    basePath: codeSearchBasePath || codeWorkspace.root,
    query: codeSearchQuery,
    limit: 100,
  });
}

function sessionCodeComments(sessionId: string): SessionCodeComments {
  const existing = codeComments.get(sessionId);
  if (existing) return existing;
  const created: SessionCodeComments = new Map();
  codeComments.set(sessionId, created);
  return created;
}

function addCodeComment(
  sessionId: string,
  root: string,
  file: CodeFileContent,
  lineNumber: number,
  lineText: string,
): void {
  const comment = window.prompt("Comment on this code line");
  if (!comment?.trim()) return;
  const commentsByFile = sessionCodeComments(sessionId);
  const key = codeCommentFileKey(root, file.path);
  const existing = commentsByFile.get(key) ?? [];
  existing.push(createCodeFileComment({
    id: randomUuid(),
    root,
    file,
    lineNumber,
    lineText,
    text: comment,
  }));
  commentsByFile.set(key, existing);
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
}

function editCodeComment(sessionId: string, comment: CodeFileComment): void {
  const next = window.prompt("Edit comment", comment.text);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  const commentsByFile = sessionCodeComments(sessionId);
  const key = codeCommentFileKey(comment.root, comment.path);
  commentsByFile.set(
    key,
    (commentsByFile.get(key) ?? []).map(existing =>
      existing === comment ? { ...existing, text: trimmed } : existing,
    ),
  );
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
}

function deleteCodeComment(sessionId: string, comment: CodeFileComment): void {
  const commentsByFile = sessionCodeComments(sessionId);
  const key = codeCommentFileKey(comment.root, comment.path);
  commentsByFile.set(
    key,
    (commentsByFile.get(key) ?? []).filter(existing => existing !== comment),
  );
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
}


function editablePromptPreviewText(): string | null {
  const text = diffPreviewText.value.trim();
  if (!text) {
    diffPreviewStatus.textContent = "Prompt text is required.";
    diffPreviewText.focus();
    return null;
  }
  return text;
}

function focusPromptPreviewStart(): void {
  diffPreviewText.focus();
  diffPreviewText.setSelectionRange(0, 0);
  diffPreviewText.scrollLeft = 0;
  diffPreviewText.scrollTop = 0;
}

function sendCodeComments(sessionId: string, root: string, file: CodeFileContent, comments: CodeFileComment[], promptText = buildCodeCommentPrompt(root, file, comments)): void {
  if (comments.length === 0) return;
  const clearFlushedComments = () => {
    const commentsByFile = sessionCodeComments(sessionId);
    const key = codeCommentFileKey(root, file.path);
    const remaining = removeSelectedCodeComments(commentsByFile.get(key) ?? [], comments);
    if (remaining.length) commentsByFile.set(key, remaining);
    else commentsByFile.delete(key);
    markCodeViewDirty();
    renderCodePanelIfNeeded(true);
  };
  sendPromptWithBusyHandling({
    sessionId,
    text: promptText,
    editorText: codeCommentFlushEditorText(comments.length),
    images: [],
    onSend: clearFlushedComments,
  });
}

function previewCodeComments(sessionId: string, root: string, file: CodeFileContent): void {
  const comments = selectedCodeComments(sessionCodeComments(sessionId).get(codeCommentFileKey(root, file.path)) ?? [], root, file);
  if (comments.length === 0) return;
  codePreviewDraft = { sessionId, root, file, comments };
  diffPreviewDraft = null;
  transcriptPreviewDraft = null;
  agentReviewDraft = null;
  diffPreviewTitle.textContent = "Preview code comments";
  diffPreviewSubtitle.textContent = "Review the prompt that will be sent to OMP.";
  diffPreviewSend.textContent = "Send comments";
  diffPreviewSend.disabled = false;
  diffPreviewText.readOnly = false;
  diffPreviewText.value = buildCodeCommentPrompt(root, file, comments);
  diffPreviewStatus.textContent = codeCommentPreviewStatus(comments.length);
  diffPreviewOverlay.hidden = false;
  focusPromptPreviewStart();
}

function flushCodeComments(sessionId: string, root: string, file: CodeFileContent): void {
  previewCodeComments(sessionId, root, file);
}
function openSearchResultInCode(path: string): void {
  closeCodeSearch();
  requestCodeTree(parentCodePath(path) ?? "");
  requestCodeFile(path);
}


function openCodeRequest(request: CodeOpenRequest): void {
  clearCodeRevision();
  codeError = null;
  markCodeViewDirty();
  if (codeSessionId !== request.sessionId || codeWorkspace?.root !== request.repoRoot) resetCodeViewForSession(request.sessionId);
  pendingCodeOpenRequest = request;
  if (codeWorkspace && codeSessionId === request.sessionId && codeWorkspace.root === request.repoRoot) {
    pendingCodeOpenRequest = null;
    requestCodeTree(parentCodePath(request.path) ?? "");
    requestCodeFile(request.path);
  } else {
    codeLoadingWorkspace = true;
    send({ type: "code.workspace.openRoot", root: request.repoRoot, source: "session" });
    renderCodePanelIfNeeded(true);
  }
  desktopDockview?.activatePanel("code");
}

function clearCodeRevision(): void {
  if (!codeRevision) return;
  codeRevision = null;
  markCodeViewDirty();
  dispatchGitFileRead();
}

function revisionComparisonIdentity(state: DiffReviewableState): string {
  return JSON.stringify([state.comparison.repoRoot, state.comparison.leftTreeOrCommit, state.comparison.rightTreeOrCommit]);
}

function invalidatePendingCodeRevision(originKey: string, state: DiffReviewableState | null): void {
  if (!codeRevision?.loading || codeRevision.originKey !== originKey) return;
  if (state && codeRevision.originComparison === revisionComparisonIdentity(state)) return;
  codeRevision.loading = false;
  codeRevision.error = "Comparison changed while reading the revision. Reopen it from the file menu.";
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
  dispatchGitFileRead();
}

// The bridge permits one Git blob job per connection. Serialize the two UI
// destinations so opening the modal cannot silently cancel a Code-panel read.
function dispatchGitFileRead(): void {
  if ((pendingGitFile?.loading && pendingGitFile.sent) || (codeRevision?.loading && codeRevision.sent)) return;
  const pending = pendingGitFile?.loading ? pendingGitFile : codeRevision?.loading ? codeRevision : null;
  if (!pending) return;
  pending.sent = true;
  if (send({ type: "git.file.request", clientId: diffClientId, requestId: pending.requestId, repoRoot: pending.repoRoot, commitOid: pending.commitOid, path: pending.path })) return;
  pending.loading = false;
  const error = "Not connected to the Fura bridge.";
  if ("view" in pending) pending.view.show(null, error);
  else {
    pending.error = error;
    markCodeViewDirty();
    renderCodePanelIfNeeded(true);
  }
  dispatchGitFileRead();
}

function openDiffRevisionInCode(state: DiffReviewableState, filePath: string, originKey: string): void {
  const committed = committedFileTarget(state, filePath);
  if (!committed) return;
  closeCodeContextMenu();
  clearPendingCodeSearchRequest();
  codeDefinitionRequestId = codeReferencesRequestId = null;
  codeReferences = null;
  codePendingScrollLine = null;
  codeAnalyzerStatus = null;
  codeAnalyzerMessage = null;
  codeSearchOpen = false;
  pendingCodeOpenRequest = null;
  pendingCodeRefresh = null;
  codeLoadingWorkspace = codeLoadingTree = codeLoadingFile = false;
  codeRevision = {
    requestId: randomUuid(), sessionId: workspaceMode === "session" ? activeSessionId : null,
    repoRoot: state.comparison.repoRoot, ...committed,
    side: state.summary.files.find(file => file.newPath === filePath)?.status === "deleted" ? "base" : "head",
    file: null, loading: true, error: null, sent: false,
    originKey: diffRequestModeForAnnotationKey(originKey) === "compareDiff" ? "compareDiff" : originKey,
    originComparison: revisionComparisonIdentity(state),
  };
  markCodeViewDirty();
  desktopDockview?.activatePanel("code");
  renderCodePanelIfNeeded(true);
  focusCodePanel(".code-revision-back");
  dispatchGitFileRead();
}

function focusCodePanel(selector: string): void {
  const dockview = desktopDockview;
  const sessionId = activeSessionId;
  const revisionId = codeRevision?.requestId;
  dockview?.withPanel("code", container => {
    const focus = () => {
      const target = container.querySelector<HTMLElement>(selector) ?? container;
      if (target === container) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    };
    focus();
    // Dockview can reparent the newly activated panel during layout, dropping
    // native focus to body. Repair that handoff, but never steal a later focus.
    const owner = container.ownerDocument;
    owner.defaultView?.requestAnimationFrame(() => {
      if (!container.isConnected || dockview !== desktopDockview || sessionId !== activeSessionId || revisionId !== codeRevision?.requestId) return;
      if (owner.activeElement === owner.body || owner.activeElement === container) focus();
    });
  });
}

function committedFileTarget(state: DiffReviewableState, filePath: string): { commitOid: string; path: string } | null {
  const file = state.summary.files.find(file => file.newPath === filePath);
  const deleted = file?.status === "deleted";
  const commitOid = deleted ? state.comparison.leftTreeOrCommit : state.comparison.rightTreeOrCommit;
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(commitOid)
    ? { commitOid, path: deleted ? file.oldPath ?? filePath : filePath }
    : null;
}

function openDiffFileInCode(state: DiffReviewableState, filePath: string, owner: Document = document): void {
  const committed = committedFileTarget(state, filePath);
  if (committed) {
    pendingGitFile?.view.close();
    const requestId = randomUuid();
    const repoRoot = state.comparison.repoRoot;
    const view = openCommittedFileView(owner, repoRoot, committed.commitOid, committed.path, () => {
      if (pendingGitFile?.requestId === requestId) {
        pendingGitFile = null;
        dispatchGitFileRead();
      }
    });
    pendingGitFile = { requestId, repoRoot, ...committed, loading: true, sent: false, view };
    dispatchGitFileRead();
    return;
  }
  const target = checkoutTargetForDiffFile(state);
  if (target?.kind !== "workingTree" || state.summary.files.find(file => file.newPath === filePath)?.status === "deleted") return;
  const sessionId = activeSessionId;
  if (sessionId) openCodeRequest({ source: "sessionWorktree", sessionId, repoRoot: state.comparison.repoRoot, path: filePath });
}


function renderActiveDockviewPanel(projection: SessionProjection | undefined): void {
  syncSessionModePanels();
  renderTranscriptPanelIfNeeded(projection);
  renderToolsPanelIfNeeded(projection);
  if (desktopDockview?.isPanelActive("goal")) {
    desktopDockview.withPanel("goal", container => renderGoalModePanel(container, projection));
  }
  if (desktopDockview?.isPanelActive("diffs") && shouldRenderDiffsView(projection)) {
    desktopDockview.withPanel("diffs", container => renderDiffsView(container, projection));
  }
  if (desktopDockview?.isPanelActive("sessionChanges") && shouldRenderDiffsView(projection)) {
    desktopDockview.withPanel("sessionChanges", container => renderDiffsView(container, projection));
  }
  if (desktopDockview?.isPanelActive("compare") && comparePanelDirty) {
    desktopDockview.withPanel("compare", container => renderComparePanel(container));
  }
  if (desktopDockview?.isPanelActive("code")) {
    ensureActiveCodeWorkspace();
    renderCodePanelIfNeeded();
  }
}

function renderTranscriptPanelIfNeeded(projection: SessionProjection | undefined, force = false): void {
  if (!desktopDockview?.panelMounted("transcript")) return;
  const workspaceKey = activeWorkspaceKey();
  const sessionChanged = workspaceKey !== lastTranscriptRenderedSessionId;
  if (!force && !transcriptPanelDirty && !sessionChanged) return;

  const rendered = desktopDockview.withPanel("transcript", container => {
    if (workspaceMode === "controller") renderControllerTranscriptView(container, sessionChanged);
    else renderTranscriptView(container, projection, sessionChanged);
  });
  if (!rendered) return;
  transcriptPanelDirty = false;
  lastTranscriptRenderedSessionId = workspaceKey;
}

function renderToolsPanelIfNeeded(projection: SessionProjection | undefined, force = false): void {
  if (!desktopDockview?.panelMounted("tools")) return;
  const workspaceKey = activeWorkspaceKey();
  const sessionChanged = workspaceKey !== lastToolsRenderedSessionId;
  if (!force && !toolsPanelDirty && !sessionChanged) return;

  const rendered = desktopDockview.withPanel("tools", container => {
    if (workspaceMode === "controller") renderControllerToolsView(container);
    else renderToolsView(container, projection);
  });
  if (!rendered) return;
  toolsPanelDirty = false;
  lastToolsRenderedSessionId = workspaceKey;
}

function renderCodePanelIfNeeded(force = false): void {
  if (!desktopDockview?.panelMounted("code")) return;
  const sessionId = workspaceMode === "session" ? activeSessionId : null;
  if (codeRevision && codeRevision.sessionId !== sessionId) clearCodeRevision();
  if (codeRevision) {
    if (!force && !codePanelDirty) return;
    const revision = codeRevision;
    if (desktopDockview.withPanel("code", container => renderRevisionCodeViewer(container, revision, () => {
      clearCodeRevision();
      ensureActiveCodeWorkspace();
      renderCodePanelIfNeeded(true);
      focusCodePanel(".code-workspace-header button:not(:disabled)");
    }))) codePanelDirty = false;
    return;
  }
  // A review-worktree code workspace is not session-bound (its codeSessionId is
  // null by design), so a session mismatch must not reset it — doing so during a
  // review "Open in Code" would wipe the workspace mid-open.
  const viewingReviewWorktree =
    codeWorkspace?.source === "reviewWorktree";
  const sessionChanged = !viewingReviewWorktree && codeSessionId !== sessionId;
  if (sessionChanged) resetCodeViewForSession(sessionId);
  if (!force && !codePanelDirty && !sessionChanged) return;
  const rendered = desktopDockview.withPanel("code", container => {
    renderCodeViewer(container, activeCodeViewState(), {
      openWorkspace: refreshCodeWorkspace,
      listTree: requestCodeTree,
      refreshTree: () => requestCodeTree(codeTreePath),
      openFile: requestCodeFile,
      openSearch: openCodeSearch,
      closeSearch: closeCodeSearch,
      updateSearchBasePath: path => {
        codeSearchBasePath = path;
        codeSearchError = null;
        scheduleCodeSearch();
      },
      updateSearchQuery: query => {
        codeSearchQuery = query;
        codeSearchError = null;
        scheduleCodeSearch();
      },
      searchFiles: submitCodeSearch,
      openSearchResult: openSearchResultInCode,
      addComment: (lineNumber, lineText) => {
        if (workspaceMode === "session" && activeSessionId && codeWorkspace && codeFile) {
          addCodeComment(activeSessionId, codeWorkspace.root, codeFile, lineNumber, lineText);
        }
      },
      editComment: comment => {
        if (workspaceMode === "session" && activeSessionId) editCodeComment(activeSessionId, comment);
      },
      deleteComment: comment => {
        if (workspaceMode === "session" && activeSessionId) deleteCodeComment(activeSessionId, comment);
      },
      previewComments: () => {
        if (workspaceMode === "session" && activeSessionId && codeWorkspace && codeFile) {
          previewCodeComments(activeSessionId, codeWorkspace.root, codeFile);
        }
      },
      flushComments: () => {
        if (workspaceMode === "session" && activeSessionId && codeWorkspace && codeFile) {
          flushCodeComments(activeSessionId, codeWorkspace.root, codeFile);
        }
      },
      openContextMenu: openCodeContextMenu,
      goToDefinition: requestCodeDefinition,
      findReferences: requestCodeReferences,
      openReference: openReferenceLocation,
      closeReferences: () => {
        codeReferences = null;
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
      },
    });
  });
  if (!rendered) return;
  codePanelDirty = false;
  // The scroll-to-line flash is one-shot: consume it once the target file is rendered.
  if (codeFile && !codeLoadingFile) codePendingScrollLine = null;
}


// --- Panel render functions ---

function getCachedPanelRenderState(
  caches: WeakMap<HTMLElement, CachedPanelRenderState>,
  container: HTMLElement,
  revision: number,
): CachedPanelRenderState {
  let cache = caches.get(container);
  if (!cache) {
    cache = { nodes: new Map<string, HTMLElement>(), revision };
    caches.set(container, cache);
  }
  return cache;
}

function clearCachedPanelRenderState(cache: CachedPanelRenderState): void {
  cache.nodes.clear();
}


function renderCachedPanelItems(
  container: HTMLElement,
  cache: CachedPanelRenderState,
  items: PanelRenderItem[],
  revision: number,
  trailingNodes: Node[] = [],
): void {
  const canReuseCache = cache.revision === revision;

  const nextNodes = new Map<string, HTMLElement>();
  const desiredNodes: Node[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cachedNode = canReuseCache && (item.cacheable ?? i < items.length - 1) ? cache.nodes.get(item.key) : undefined;
    const node = cachedNode?.ownerDocument === container.ownerDocument
      ? item.update?.(cachedNode) ?? cachedNode
      : item.render();
    nextNodes.set(item.key, node);
    desiredNodes.push(node);
  }

  desiredNodes.push(...trailingNodes);
  reconcileChildren(container, desiredNodes);
  cache.nodes = nextNodes;
  cache.revision = revision;
}

function renderSessionNoticeNodes(notices: SessionNotice[]): HTMLElement[] {
  return notices.map(notice => {
    const bar = mkEl("div");
    bar.className = `session-notice notice-${notice.level}`;
    bar.textContent = notice.text;
    return bar;
  });
}

function controlMessageRenderKey(message: ControlChatMessage, index: number): string {
  const candidates = (message.candidates ?? []).map(candidate => candidate.sessionId).join(",");
  const actions = (message.suggestedActions ?? []).map(action => action.label).join(",");
  return `control:${index}:${message.role}:${message.text}:${candidates}:${actions}`;
}

function buildControllerTranscriptRenderItems(): PanelRenderItem[] {
  return controlMessages.map((message, index) => ({
    key: controlMessageRenderKey(message, index),
    render: () => renderControlTranscriptMessage(message, index),
  }));
}

function renderControlTranscriptMessage(message: ControlChatMessage, index: number): HTMLElement {
  const article = renderMessage({
    id: `ask-fura-${index}`,
    role: message.role,
    blocks: [{ kind: "text", text: message.text }],
    timestamp: null,
    isNew: false,
    renderHash: controlMessageRenderKey(message, index),
  });
  const roleLabel = article.querySelector(".message-heading strong");
  if (roleLabel && message.role === "assistant") roleLabel.textContent = "Ask Fura";

  for (const candidate of message.candidates ?? []) {
    article.append(renderControlCandidate(candidate));
  }
  for (const suggestion of message.suggestedActions ?? []) {
    const button = mkEl("button");
    button.type = "button";
    button.className = "control-suggestion";
    button.textContent = suggestion.label;
    button.addEventListener("click", () => handleFrontendControl(suggestion.action));
    article.append(button);
  }
  return article;
}

function renderControllerTranscriptView(container: HTMLElement, sessionChanged: boolean): void {
  setRenderDocument(container.ownerDocument);
  const cache = getCachedPanelRenderState(transcriptRenderCaches, container, transcriptRenderRevision);
  if (sessionChanged) clearCachedPanelRenderState(cache);
  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  const items = buildControllerTranscriptRenderItems();

  if (items.length === 0) {
    clearCachedPanelRenderState(cache);
    const empty = mkEl("p");
    empty.className = "empty transcript-empty";
    empty.textContent = "Ask Fura can find sessions, explain candidates, open a session, or stage a prompt draft.";
    container.replaceChildren(empty);
  } else {
    renderCachedPanelItems(container, cache, items, transcriptRenderRevision);
  }

  if (sessionChanged || wasNearBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

function renderControllerToolsView(container: HTMLElement): void {
  setRenderDocument(container.ownerDocument);
  const cache = getCachedPanelRenderState(toolsRenderCaches, container, 0);
  clearCachedPanelRenderState(cache);
  const empty = mkEl("p");
  empty.className = "empty tools-empty";
  empty.textContent = "Ask Fura uses restricted Fura controller tools. Results appear in the transcript.";
  container.replaceChildren(empty);
}

function restoreOpenThinkingBlocks(container: HTMLElement, openThinking: Set<string>): void {
  container.querySelectorAll<HTMLDetailsElement>("details[data-message-id]").forEach(el => {
    const key = `${el.dataset.messageId}:${el.dataset.blockIndex}`;
    if (openThinking.has(key)) el.open = true;
  });
}

function nonEmptyTodoPhases(phases: TodoPhase[]): TodoPhase[] {
  return phases.filter(phase => phase.tasks.length > 0);
}

function toolCardRenderKey(card: ToolCard): string {
  const renderContentKey = card.renderHash ? `hash:${card.renderHash}` : `legacy:${JSON.stringify([
    card.timestamp ?? null,
    card.toolName,
    card.intent ?? null,
    card.args,
    card.isActive,
    card.isError,
    card.partialResult ?? null,
    card.result ?? null,
  ])}`;
  return `${card.toolCallId.length}:${card.toolCallId}:${renderContentKey}`;
}

function readToolGroupRenderKey(cards: Array<{ kind: "tool" } & ToolCard>): string {
  return JSON.stringify(cards.map(card => toolCardRenderKey(card)));
}

function todoPhasesRenderKey(phases: TodoPhase[]): string {
  return JSON.stringify(phases.map(phase => [
    phase.name,
    phase.tasks.map(task => [task.content, task.status, task.notes ?? []]),
  ]));
}

function transcriptReviewRenderKey(sessionId: string, messageId: string): string {
  const comments = transcriptReviewCommentsForMessage(sessionId, messageId)
    .map(comment => [comment.id, comment.lineNumber, comment.lineText, comment.text]);
  return JSON.stringify({
    active: isTranscriptMessageUnderReview(sessionId, messageId),
    comments,
  });
}

function buildTranscriptRenderItems(projection: SessionProjection): PanelRenderItem[] {
  const items: PanelRenderItem[] = [];
  for (let i = 0; i < projection.transcript.length; i++) {
    const entry = projection.transcript[i];
    const startIndex = i;

    if (entry.kind === "message") {
      items.push({
        key: transcriptMessageRenderCacheKey(
          projection.summary.sessionId,
          entry,
          startIndex,
          transcriptReviewRenderKey(projection.summary.sessionId, entry.id),
        ),
        cacheable: true,
        update: node => updateRenderedMessage(node, entry, {
          thinkingVisibilityMode,
          review: transcriptReviewOptions(projection.summary.sessionId, entry),
        }),
        render: () => renderMessage(entry, projection.summary.sessionId),
      });
      continue;
    }
    if (entry.kind === "review") {
      // Review results are a deliverable, not process noise: always rendered,
      // independent of the tool-bubble visibility toggle.
      items.push({
        key: reviewCardRenderKey(entry),
        cacheable: true,
        render: () => renderReviewCard(entry),
      });
      continue;
    }
    if (!shouldRenderToolInTranscript(entry, showToolBubbles, showEditDiffs)) continue;

    if (isCompactReadCard(entry)) {
      const readCards = [entry];
      while (isCompactReadCard(projection.transcript[i + 1])) {
        readCards.push(projection.transcript[++i] as { kind: "tool" } & ToolCard);
      }
      items.push({
        key: `read-group:${readToolGroupRenderKey(readCards)}`,
        cacheable: true,
        render: () => (readCards.length === 1 ? renderReadToolCard(entry) : renderReadToolGroup(readCards)),
      });
      continue;
    }

    items.push({
      key: `tool:${showEditDiffs ? "d1" : "d0"}:${toolCardRenderKey(entry)}`,
      cacheable: true,
      render: () => renderToolCard(entry, { showEditDiffs, sessionId: projection.summary.sessionId, cwd: projection.summary.worktree?.path ?? projection.summary.cwd }),
    });
  }
  const currentTodos = nonEmptyTodoPhases(projection.todoPhases ?? []);
  if (currentTodos.length > 0) {
    items.push({
      key: `current-todos:${todoPhasesRenderKey(currentTodos)}`,
      render: () => renderCurrentTodoCard(currentTodos),
    });
  }
  const visiblePlanReview = visiblePlanReviews.get(projection.summary.sessionId);
  if (visiblePlanReview) {
    const reviewMessage = planReviewTranscriptMessage(visiblePlanReview.review);
    items.push({
      key: `plan-review:${planReviewRenderKey(visiblePlanReview.review, visiblePlanReview.mode)}:${transcriptReviewRenderKey(projection.summary.sessionId, reviewMessage.id)}`,
      render: () => renderPlanReviewCard(
        visiblePlanReview.review,
        {
          onApprove: approvePendingPlanReview,
          onRefine: refinePendingPlanReview,
        },
        visiblePlanReview.mode,
        visiblePlanReview.mode === "refining" ? planReviewLineOptions(projection.summary.sessionId, visiblePlanReview.review) : undefined,
      ),
    });
  }
  const pendingAsk = parsePendingAsk(projection.summary.sessionId, projection.pendingAsk);
  if (pendingAsk) {
    items.push({
      key: `ask:${askCardRenderKey(pendingAsk)}`,
      render: () => renderAskCard(pendingAsk, { onRespond: response => respondToAsk(pendingAsk, response) }),
    });
  }
  return items;
}

function respondToAsk(ask: PendingAsk, response: Record<string, unknown>): void {
  send({ type: "dialog.respond", sessionId: ask.sessionId, dialogId: ask.id, response });
}

function buildToolsRenderItems(tools: Array<{ kind: "tool" } & ToolCard>, projection: SessionProjection): PanelRenderItem[] {
  const items: PanelRenderItem[] = [];
  for (let i = 0; i < tools.length; i++) {
    const entry = tools[i];

    if (isCompactReadCard(entry)) {
      const readCards = [entry];
      while (i + 1 < tools.length && isCompactReadCard(tools[i + 1])) {
        readCards.push(tools[++i]);
      }
      items.push({
        key: `read-group:${readToolGroupRenderKey(readCards)}`,
        cacheable: true,
        render: () => (readCards.length === 1 ? renderReadToolCard(entry) : renderReadToolGroup(readCards)),
      });
      continue;
    }

    items.push({
      key: `tool:${JSON.stringify([projection.summary.sessionId, showEditDiffs, toolCardRenderKey(entry)])}`,
      cacheable: true,
      render: () => renderToolCard(entry, { showEditDiffs, sessionId: projection.summary.sessionId, cwd: projection.summary.worktree?.path ?? projection.summary.cwd }),
    });
  }
  return items;
}

// Renders the chronological transcript into `container`, including optional inline tool bubbles.
// Sets the render document from container.ownerDocument so all mkEl calls use the correct document
// (required for popout panels which live in a separate window document).
function renderTranscriptView(
  container: HTMLElement,
  projection: SessionProjection | undefined,
  sessionChanged: boolean,
): void {
  setRenderDocument(container.ownerDocument);
  const cache = getCachedPanelRenderState(transcriptRenderCaches, container, transcriptRenderRevision);

  const wasNearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  const previousScrollTop = container.scrollTop;
  const restoreThinkingOpenState = !skipThinkingOpenRestoreOnce && !sessionChanged;
  skipThinkingOpenRestoreOnce = false;
  const openThinking = new Set<string>();
  if (restoreThinkingOpenState) {
    container.querySelectorAll<HTMLDetailsElement>("details[data-message-id]").forEach(el => {
      if (el.open) openThinking.add(`${el.dataset.messageId}:${el.dataset.blockIndex}`);
    });
  }

  if (!projection) {
    clearCachedPanelRenderState(cache);
    const empty = mkEl("p");
    empty.className = "empty transcript-empty";
    empty.textContent = "No session selected.";
    container.replaceChildren(empty);
    return;
  }
  if (sessionChanged) clearCachedPanelRenderState(cache);

  const notices = activeSessionId ? (sessionNotices.get(activeSessionId) ?? []) : [];
  const noticeNodes = renderSessionNoticeNodes(notices);
  const items = buildTranscriptRenderItems(projection);

  if (items.length === 0) {
    clearCachedPanelRenderState(cache);
    const empty = mkEl("p");
    empty.className = "empty transcript-empty";
    empty.textContent = "Transcript is empty.";
    container.replaceChildren(empty, ...noticeNodes);
  } else {
    renderCachedPanelItems(container, cache, items, transcriptRenderRevision, noticeNodes);
    if (restoreThinkingOpenState) restoreOpenThinkingBlocks(container, openThinking);
  }

  if (sessionChanged || wasNearBottom) {
    container.scrollTop = container.scrollHeight;
  } else {
    container.scrollTop = previousScrollTop;
  }
}

// Renders all tool executions from `projection` into `container`, independent of
// transcript order. This is the dedicated Tools panel view.
function renderToolsView(
  container: HTMLElement,
  projection: SessionProjection | undefined,
): void {
  setRenderDocument(container.ownerDocument);
  const cache = getCachedPanelRenderState(toolsRenderCaches, container, 0);

  if (!projection) {
    clearCachedPanelRenderState(cache);
    const empty = mkEl("p");
    empty.className = "empty tools-empty";
    empty.textContent = "No session selected.";
    container.replaceChildren(empty);
    return;
  }

  const tools = projection.transcript.filter(
    (entry): entry is { kind: "tool" } & ToolCard => entry.kind === "tool",
  );

  if (tools.length === 0) {
    clearCachedPanelRenderState(cache);
    const empty = mkEl("p");
    empty.className = "empty tools-empty";
    empty.textContent = "No tool executions yet.";
    container.replaceChildren(empty);
    return;
  }

  renderCachedPanelItems(container, cache, buildToolsRenderItems(tools, projection), 0);
}



function gitHistoryStateKey(sessionId: string, repoRoot: string): string {
  return JSON.stringify([sessionId, repoRoot]);
}

function gitReviewFor(sessionId: string, repoRoot?: string | null): GitHistoryState {
  if (!restoredGitReviewSessions.has(sessionId)) {
    restoredGitReviewSessions.add(sessionId);
    try {
      const saved = JSON.parse(sessionStorage.getItem(`fura.gitReview.${sessionId}`) ?? "null");
      const selections = Array.isArray(saved?.repositories) ? saved.repositories : [saved];
      for (const selection of selections) {
        if (!selection || typeof selection.repoRoot !== "string" || selection.repoRoot.includes("\0") || !["changes", "history"].includes(selection.view)) continue;
        const restored = createGitHistoryState(selection.repoRoot);
        restored.view = selection.view;
        restored.selectedOid = typeof selection.selectedOid === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(selection.selectedOid) ? selection.selectedOid : null;
        restored.historyRef = typeof selection.historyRef === "string" && /^(?:refs\/heads\/|refs\/remotes\/)/u.test(selection.historyRef) && !selection.historyRef.includes("\0") ? selection.historyRef : null;
        gitHistoryStates.set(gitHistoryStateKey(sessionId, restored.repoRoot), restored);
      }
      if (typeof saved?.repoRoot === "string" && gitHistoryStates.has(gitHistoryStateKey(sessionId, saved.repoRoot))) {
        sessionChangesRepoIds.set(sessionId, saved.repoRoot);
      }
    } catch { /* Ignore an obsolete or malformed browser selection. */ }
  }
  const root = repoRoot !== undefined ? repoRoot ?? "" : sessionChangesRepoIds.get(sessionId) ?? "";
  const key = gitHistoryStateKey(sessionId, root);
  let history = gitHistoryStates.get(key);
  if (!history) {
    history = createGitHistoryState(root);
    gitHistoryStates.set(key, history);
  }
  return history;
}

function persistGitReviewSelection(sessionId: string, history: GitHistoryState): void {
  const repositories = [...gitHistoryStates.entries()]
    .filter(([key, value]) => key === gitHistoryStateKey(sessionId, value.repoRoot))
    .map(([, value]) => ({ repoRoot: value.repoRoot, view: value.view, selectedOid: value.selectedOid, historyRef: value.historyRef }));
  sessionStorage.setItem(`fura.gitReview.${sessionId}`, JSON.stringify({
    repoRoot: history.repoRoot, repositories,
  }));
}

function clearPendingGitHistory(): void {
  if (pendingGitHistory) {
    pendingGitHistory.state.requestId = null;
    pendingGitHistory.state.loading = false;
    pendingGitHistory = null;
  }
}

function requestGitHistory(sessionId: string, repoRoot?: string | null, cursor: string | null = null): void {
  const history = gitReviewFor(sessionId, repoRoot);
  clearPendingGitHistory();
  const requestId = randomUuid();
  beginGitHistoryRequest(history, requestId, cursor);
  pendingGitHistory = { sessionId, state: history };
  if (!send({ type: "git.history.request", clientId: diffClientId, requestId, sessionId, repoId: history.repoRoot || null, historyRef: history.historyRef, cursor })) {
    acceptGitHistoryResult(history, requestId, null, "Not connected to the Fura bridge.");
    pendingGitHistory = null;
  }
}

function selectHistoryBranch(sessionId: string, ref: string | null): void {
  const history = gitReviewFor(sessionId);
  if (history.historyRef === ref) return;
  clearPendingGitHistory();
  if (currentSessionChangesRequest?.sessionId === sessionId) clearCurrentSessionChangesRequest("refsChanged");
  selectGitHistoryRef(history, ref);
  sessionChangesSelectedFiles.delete(sessionId);
  persistGitReviewSelection(sessionId, history);
  requestGitHistory(sessionId, history.repoRoot);
  markDiffsViewDirty();
  renderDiffsViewIfActive(sessionId);
}

function selectGitCommit(sessionId: string, oid: string): void {
  const history = gitReviewFor(sessionId);
  history.view = "history";
  history.selectedOid = oid;
  persistGitReviewSelection(sessionId, history);
  sessionChangesSelectedFiles.delete(sessionId);
  requestSessionChangesRefresh(sessionId, { refreshHistory: false });
  desktopDockview?.withPanel("diffs", container => {
    container.querySelector<HTMLElement>(`.git-history-commit[data-commit-oid="${oid}"]`)?.scrollIntoView?.({ block: "nearest" });
  });
}

function selectGitReviewView(sessionId: string, view: GitReviewView): void {
  const history = gitReviewFor(sessionId);
  history.view = view;
  desktopDockview?.setPanelExpanded?.("diffs", view === "history");
  persistGitReviewSelection(sessionId, history);
  sessionChangesSelectedFiles.delete(sessionId);
  if (view === "history" && !history.selectedOid) {
    const first = history.page?.commits[0];
    if (first) {
      selectGitCommit(sessionId, first.oid);
      return;
    }
    if (!history.loading) requestGitHistory(sessionId);
    markDiffsViewDirty();
    renderDiffsViewIfActive(sessionId);
    return;
  }
  requestSessionChangesRefresh(sessionId, { refreshHistory: !history.page });
}

function openAdvancedGitCompare(sessionId: string): void {
  const history = gitReviewFor(sessionId);
  openCwdPicker("diff");
  cwdPickerDiffRepo.value = history.repoRoot;
  const state = sessionChangesStates.get(sessionId);
  const pinned = state?.status === "ready" && state.selectedRepoId === history.repoRoot && state.review.currentCommitOid === history.selectedOid
    ? state.review.commits.find(commit => commit.oid === history.selectedOid)
    : undefined;
  const selected = pinned ?? history.page?.commits.find(commit => commit.oid === history.selectedOid);
  cwdPickerDiffBase.required = history.view === "history";
  cwdPickerDiffBase.value = history.view === "history" ? selected?.parentOids[0] ?? "" : "HEAD";
  cwdPickerDiffHead.value = history.view === "history" && history.selectedOid ? history.selectedOid : "WORKTREE";
  cwdPickerDiffAgentSession.checked = false;
}

function requestSessionChanges(sessionId: string): void {
  requestSessionChangesRefresh(sessionId);
}

function requestSessionChangesRefresh(
  sessionId: string,
  options: { repoId?: string | null; payloadKind?: DiffDetailMode | null; changeKind?: GitChangeKind; refreshHistory?: boolean } = {},
): void {
  gitReviewFor(sessionId);
  const previousState = sessionChangesStates.get(sessionId);
  if (previousState?.status === "ready") clearDiffPatchCacheForComparison(previousState.comparison.comparisonKey);
  const repoId = options.repoId !== undefined
    ? options.repoId
    : sessionChangesRepoIds.get(sessionId) ?? null;
  const detailMode = options.payloadKind
    ?? (previousState?.status === "ready"
      ? previousState.comparison.detailMode
      : sessionChangesPayloadKinds.get(sessionId) ?? DEFAULT_SESSION_CHANGES_DETAIL_MODE);
  const changeKind = options.changeKind ?? sessionChangesKinds.get(sessionId) ?? "unstaged";
  sessionChangesKinds.set(sessionId, changeKind);
  if (repoId) sessionChangesRepoIds.set(sessionId, repoId);
  const history = gitReviewFor(sessionId, repoId);
  if (options.refreshHistory !== false) requestGitHistory(sessionId, repoId);
  staleSessionChanges.delete(sessionId);
  diffErrors.delete(sessionId);
  markDiffsViewDirty();
  const diffId = newDiffId();
  setCurrentSessionChangesRequest(sessionId, diffId, options.repoId !== undefined ? "repoChanged" : options.payloadKind ? "payloadChanged" : "refreshed");
  diffLoadingSessions.add(sessionId);
  sessionChangesDiffIds.set(sessionId, diffId);
  const sent = send({
    type: "sessionChanges.request",
    clientId: diffClientId,
    diffId,
    sessionId,
    repoId,
    detailMode,
    changeKind,
    currentCommitOid: history.view === "history" ? history.selectedOid : null,
    selectedFile: null,
  });
  if (!sent) {
    if (currentSessionChangesRequest?.diffId === diffId) currentSessionChangesRequest = null;
    diffLoadingSessions.delete(sessionId);
    diffErrors.set(sessionId, "Not connected to the Fura bridge.");
  }
  renderDiffsViewIfActive(sessionId);
}

function requestSessionChangesRepo(sessionId: string, repoId: string, payloadKind: DiffDetailMode): void {
  const previous = gitReviewFor(sessionId);
  const exists = gitHistoryStates.has(gitHistoryStateKey(sessionId, repoId));
  const next = gitReviewFor(sessionId, repoId);
  if (!exists) next.view = previous.view;
  sessionChangesRepoIds.set(sessionId, repoId);
  persistGitReviewSelection(sessionId, next);
  sessionChangesSelectedFiles.delete(sessionId);
  requestSessionChangesRefresh(sessionId, { repoId, payloadKind });
}


function requestCompareDiff(overrides: { repoRoot?: string; base?: string; head?: string; payloadKind?: DiffDetailMode; currentCommitOid?: string | null } = {}): void {
  const repoRoot = overrides.repoRoot?.trim() || compareRepoRoot.trim();
  if (!repoRoot) {
    diffErrors.set("compareDiff", "Compare diff requires a repository root.");
    markComparePanelDirty();
    renderComparePanelIfActive();
    return;
  }
  compareRepoRoot = repoRoot;
  compareBaseRef = overrides.base ?? compareBaseRef;
  compareHeadRef = overrides.head ?? compareHeadRef;
  comparePayloadKind = overrides.payloadKind ?? comparePayloadKind;
  const base = diffRefInputFromText(compareBaseRef, { kind: "gitRef", value: "HEAD" });
  const head = diffRefInputFromText(compareHeadRef, { kind: "workingTree" });
  diffErrors.delete("compareDiff");
  clearDiffPatchCacheForComparison(compareDiffState?.comparison.comparisonKey);
  const diffId = newDiffId();
  setCurrentCompareDiff(diffId, overrides.repoRoot ? "repoChanged" : overrides.base || overrides.head || overrides.currentCommitOid ? "refsChanged" : overrides.payloadKind ? "payloadChanged" : "replaced");
  compareDiffState = null;
  compareDiffLoading = true;
  markComparePanelDirty();
  const sent = send({
    type: "compareDiff.request",
    clientId: diffClientId,
    diffId,
    repoRoot,
    base,
    head,
    detailMode: comparePayloadKind,
    currentCommitOid: overrides.currentCommitOid ?? null,
    selectedFile: null,
  });
  if (!sent) {
    if (compareDiffId === diffId) compareDiffId = null;
    compareDiffLoading = false;
    diffErrors.set("compareDiff", "Not connected to the Fura bridge.");
  }
  renderComparePanelIfActive();
}

type DiffReviewRequest = {
  repoRoot: string;
  baseText: string;
  headText: string;
  payloadKind: DiffDetailMode;
};

function diffReviewRequestForSummary(summary: SessionSummary): DiffReviewRequest | null {
  if (summary.sessionMode !== "diffReview") return null;
  const repoRoot = summary.cwd?.trim();
  const title = summary.title?.trim();
  if (!repoRoot || !title?.startsWith("diff:")) return null;
  const spec = title.slice("diff:".length).trim();
  const lastSpace = spec.lastIndexOf(" ");
  const range = lastSpace === -1 ? spec : spec.slice(lastSpace + 1);
  const separator = range.indexOf("..");
  if (separator <= 0) return null;
  const baseText = range.slice(0, separator).trim();
  const headText = range.slice(separator + 2).trim();
  if (!baseText || !headText) return null;
  return { repoRoot, baseText, headText, payloadKind: "filePatch" };
}

function compareStateMatchesDiffReview(request: DiffReviewRequest): boolean {
  return Boolean(
    compareDiffState &&
      compareDiffState.request.scope === "compareDiff" &&
      compareDiffState.request.repoRoot === request.repoRoot &&
      diffRefInputText(compareDiffState.request.base) === request.baseText &&
      diffRefInputText(compareDiffState.request.head) === request.headText,
  );
}

function requestDiffReviewState(
  sessionId: string,
  summary: SessionSummary,
  overrides: { payloadKind?: DiffDetailMode; currentCommitOid?: string | null } = {},
): void {
  const request = diffReviewRequestForSummary(summary);
  if (!request) {
    diffErrors.set(sessionId, "This diff session is missing its repository/ref configuration.");
    markDiffsViewDirty();
    renderDiffsViewIfActive(sessionId);
    return;
  }
  requestCompareDiff({
    repoRoot: request.repoRoot,
    base: request.baseText,
    head: request.headText,
    payloadKind: overrides.payloadKind ?? (compareStateMatchesDiffReview(request) ? compareDiffState?.comparison.detailMode : request.payloadKind),
    currentCommitOid: overrides.currentCommitOid ?? (compareStateMatchesDiffReview(request) ? compareDiffState?.review.currentCommitOid ?? null : null),
  });
}

function renderDiffsViewIfActive(sessionId: string): void {
  if (desktopDockview?.isPanelActive("diffs")) {
    desktopDockview.withPanel("diffs", container => renderDiffsView(container, sessionId ? projections.get(sessionId) : undefined));
  }
  if (desktopDockview?.isPanelActive("sessionChanges")) {
    desktopDockview.withPanel("sessionChanges", container => renderDiffsView(container, sessionId ? projections.get(sessionId) : undefined));
  }
}

function renderComparePanelIfActive(): void {
  if (desktopDockview?.isPanelActive("compare")) {
    desktopDockview.withPanel("compare", container => renderComparePanel(container));
  }
}

function markDiffsViewDirty(): void {
  diffPanelDirty = true;
}

function markComparePanelDirty(): void {
  comparePanelDirty = true;
}

function shouldRenderDiffsView(projection: SessionProjection | undefined): boolean {
  return (
    diffPanelDirty ||
    activeSessionId !== lastDiffsRenderedSessionId ||
    Boolean(projection) !== lastDiffsRenderedProjectionPresent
  );
}

function isSessionChangesPanelActive(): boolean {
  return (desktopDockview?.isPanelActive("diffs") ?? false) || (desktopDockview?.isPanelActive("sessionChanges") ?? false);
}

function markSessionChangesStaleAfterAgentSettles(
  sessionId: string,
  previous: SessionProjection | undefined,
  current: SessionProjection,
): void {
  if (!previous?.isBusy || current.isBusy || current.summary.sessionMode === "diffReview") return;
  staleSessionChanges.add(sessionId);
  if (sessionId === activeSessionId) requestActiveDiffState();
}

function requestActiveDiffState(options: { refreshExisting?: boolean } = {}): void {
  if (!connection?.isOpen()) return;
  if (!activeSessionId || !isSessionChangesPanelActive()) return;
  const projection = projections.get(activeSessionId);
  if (!projection || diffLoadingSessions.has(activeSessionId)) return;
  if (projection.summary.sessionMode === "diffReview") {
    const request = diffReviewRequestForSummary(projection.summary);
    if (!request || compareDiffLoading) return;
    if (!options.refreshExisting && compareStateMatchesDiffReview(request)) return;
    requestDiffReviewState(activeSessionId, projection.summary);
    return;
  }
  const state = sessionChangesStates.get(activeSessionId);
  const history = gitReviewFor(activeSessionId);
  if (!history.page && !history.loading && !history.error) requestGitHistory(activeSessionId);
  const selectedCommit = history.view === "history" ? history.selectedOid : null;
  const selectionChanged = state?.status === "ready" &&
    (state.selectedRepoId !== history.repoRoot || (state.review.currentCommitOid ?? null) !== selectedCommit);
  if (!state) {
    staleSessionChanges.delete(activeSessionId);
    requestSessionChanges(activeSessionId);
    return;
  }
  if (selectionChanged || options.refreshExisting || staleSessionChanges.has(activeSessionId)) {
    requestSessionChangesRefresh(
      activeSessionId,
      { ...sessionChangesRefreshOptions(state, sessionChangesPayloadKinds.get(activeSessionId) ?? DEFAULT_SESSION_CHANGES_DETAIL_MODE), repoId: sessionChangesRepoIds.get(activeSessionId) ?? null },
    );
    return;
  }
  if (currentSessionChangesRequest?.sessionId !== activeSessionId || currentSessionChangesRequest?.diffId !== state.diffId) {
    currentSessionChangesRequest = { sessionId: activeSessionId, diffId: state.diffId };
  }
}

window.addEventListener("focus", () => {
  if (document.visibilityState !== "hidden") requestActiveDiffState({ refreshExisting: true });
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") requestActiveDiffState({ refreshExisting: true });
});

function activeSessionUsesDiffReviewWorkspace(): boolean {
  if (workspaceMode !== "session") return false;
  const summary = (activeSessionId ? projections.get(activeSessionId)?.summary : undefined) ?? (activeSessionId ? currentSessionSummary(activeSessionId) : undefined);
  return summary?.sessionMode === "diffReview";
}

function setActiveDesktopDockviewMode(mode: "normal" | "diffReview"): boolean {
  const nextDockview = mode === "diffReview" ? diffReviewDesktopDockview : normalDesktopDockview;
  if (!nextDockview) return false;
  const normalHost = document.getElementById("normalWorkspacePanelHost");
  const reviewHost = document.getElementById("diffReviewWorkspacePanelHost");
  normalHost?.classList.toggle("workspace-panel-host-active", mode === "normal");
  reviewHost?.classList.toggle("workspace-panel-host-active", mode === "diffReview");
  desktopDockview = nextDockview;
  if (activeDesktopDockviewMode !== mode) {
    activeDesktopDockviewMode = mode;
    lastTranscriptRenderedSessionId = null;
    lastToolsRenderedSessionId = null;
    transcriptPanelDirty = true;
    toolsPanelDirty = true;
    codePanelDirty = true;
    diffPanelDirty = true;
    comparePanelDirty = true;
  }
  return true;
}

function syncSessionModePanels(activateCreatedDiffReview = false): void {
  const isDiffReview = activeSessionUsesDiffReviewWorkspace();
  const nextMode = isDiffReview ? "diffReview" : "normal";
  const modeChanged = activeDesktopDockviewMode !== nextMode;
  if (!setActiveDesktopDockviewMode(nextMode)) return;
  if (isDiffReview) {
    desktopDockview?.ensureSessionChangesPanel();
    if (activateCreatedDiffReview) {
      desktopDockview?.activatePanel("sessionChanges");
    }
    markDiffsViewDirty();
    renderDiffsViewIfActive(activeSessionId ?? "");
    if (modeChanged || activateCreatedDiffReview) requestActiveDiffState({ refreshExisting: true });
  }
}

function restoreScrollTopAcrossDiffRender(element: HTMLElement | null, scrollTop: number): void {
  if (element) element.scrollTop = scrollTop;
}

function rerenderDiffsViewPreservingScroll(sessionId: string): void {
  if (sessionId === "compareDiff") {
    markComparePanelDirty();
    rerenderComparePanelPreservingScroll();
    return;
  }
  const panelId = desktopDockview?.isPanelActive("sessionChanges") ? "sessionChanges" : "diffs";
  if (!desktopDockview?.isPanelActive(panelId)) return;
  desktopDockview.withPanel(panelId, container => {
    const mainBody = container.querySelector<HTMLElement>(".diffs-main-body");
    const sidebarScroll = container.querySelector<HTMLElement>(".diffs-sidebar-scroll");
    const mainScrollTop = mainBody?.scrollTop ?? 0;
    const sidebarScrollTop = sidebarScroll?.scrollTop ?? 0;
    const filterFocus = captureDiffFilterFocus(container);

    renderDiffsView(container, projections.get(sessionId));

    const nextMainBody = container.querySelector<HTMLElement>(".diffs-main-body");
    const nextSidebarScroll = container.querySelector<HTMLElement>(".diffs-sidebar-scroll");
    restoreScrollTopAcrossDiffRender(nextMainBody, mainScrollTop);
    restoreScrollTopAcrossDiffRender(nextSidebarScroll, sidebarScrollTop);
    restoreDiffFilterFocus(container, filterFocus);
  });
}

function rerenderComparePanelPreservingScroll(): void {
  if (!desktopDockview?.isPanelActive("compare")) return;
  desktopDockview.withPanel("compare", container => {
    const mainBody = container.querySelector<HTMLElement>(".diffs-main-body");
    const sidebarScroll = container.querySelector<HTMLElement>(".diffs-sidebar-scroll");
    const mainScrollTop = mainBody?.scrollTop ?? 0;
    const sidebarScrollTop = sidebarScroll?.scrollTop ?? 0;
    const filterFocus = captureDiffFilterFocus(container);

    renderComparePanel(container);

    const nextMainBody = container.querySelector<HTMLElement>(".diffs-main-body");
    const nextSidebarScroll = container.querySelector<HTMLElement>(".diffs-sidebar-scroll");
    restoreScrollTopAcrossDiffRender(nextMainBody, mainScrollTop);
    restoreScrollTopAcrossDiffRender(nextSidebarScroll, sidebarScrollTop);
    restoreDiffFilterFocus(container, filterFocus);
  });
}

function transcriptReviewCommentsForMessage(sessionId: string, messageId: string): TranscriptReviewComment[] {
  return (transcriptReviewComments.get(sessionId) ?? []).filter(comment => comment.messageId === messageId);
}

function isTranscriptMessageUnderReview(sessionId: string, messageId: string): boolean {
  return transcriptReviewActiveMessages.get(sessionId) === messageId;
}

function startTranscriptReview(sessionId: string, message: TranscriptMessage): void {
  transcriptReviewActiveMessages.set(sessionId, message.id);
  markTranscriptViewDirty();
  render();
}

function cancelTranscriptReview(sessionId: string, message: TranscriptMessage): void {
  transcriptReviewActiveMessages.delete(sessionId);
  transcriptReviewComments.set(
    sessionId,
    (transcriptReviewComments.get(sessionId) ?? []).filter(comment => comment.messageId !== message.id),
  );
  markTranscriptViewDirty();
  render();
}

function addTranscriptReviewComment(
  sessionId: string,
  message: TranscriptMessage,
  line: TranscriptReviewLine,
): void {
  const comment = window.prompt("Comment on this transcript line");
  if (!comment?.trim()) return;
  const comments = transcriptReviewComments.get(sessionId) ?? [];
  comments.push({
    id: `${Date.now()}-${comments.length}`,
    messageId: message.id,
    role: message.role,
    lineNumber: line.lineNumber,
    lineText: line.text,
    text: comment.trim(),
  });
  transcriptReviewComments.set(sessionId, comments);
  markTranscriptViewDirty();
  render();
}

function editTranscriptReviewComment(sessionId: string, comment: TranscriptReviewComment): void {
  const next = window.prompt("Edit comment", comment.text);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  transcriptReviewComments.set(
    sessionId,
    (transcriptReviewComments.get(sessionId) ?? []).map(existing =>
      existing.id === comment.id ? { ...existing, text: trimmed } : existing,
    ),
  );
  markTranscriptViewDirty();
  render();
}

function deleteTranscriptReviewComment(sessionId: string, comment: TranscriptReviewComment): void {
  transcriptReviewComments.set(
    sessionId,
    (transcriptReviewComments.get(sessionId) ?? []).filter(existing => existing.id !== comment.id),
  );
  markTranscriptViewDirty();
  render();
}

function flushTranscriptReviewComments(sessionId: string, message: TranscriptMessage): void {
  const comments = transcriptReviewCommentsForMessage(sessionId, message.id);
  if (comments.length === 0) return;
  transcriptPreviewDraft = { sessionId, message, comments };
  diffPreviewDraft = null;
  diffPreviewTitle.textContent = "Preview transcript comments";
  diffPreviewSubtitle.textContent = "Review the prompt that will be sent to OMP.";
  diffPreviewText.value = buildTranscriptReviewPrompt(message, comments);
  diffPreviewText.readOnly = false;
  diffPreviewStatus.textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"} ready to send`;
  diffPreviewSend.textContent = "Send comments";
  diffPreviewSend.disabled = false;
  diffPreviewOverlay.hidden = false;
  focusPromptPreviewStart();
}

function sendTranscriptReviewComments(
  sessionId: string,
  message: TranscriptMessage,
  comments: TranscriptReviewComment[],
  promptText = buildTranscriptReviewPrompt(message, comments),
): void {
  if (comments.length === 0) return;
  const clearFlushedComments = () => {
    transcriptReviewComments.set(
      sessionId,
      (transcriptReviewComments.get(sessionId) ?? []).filter(comment => comment.messageId !== message.id),
    );
    transcriptReviewActiveMessages.delete(sessionId);
    markTranscriptViewDirty();
    render();
  };
  sendPromptWithBusyHandling({
    sessionId,
    text: promptText,
    editorText: `Flush ${comments.length} transcript comment${comments.length === 1 ? "" : "s"}`,
    images: [],
    onSend: clearFlushedComments,
  });
}

function transcriptReviewOptions(sessionId: string, message: TranscriptMessage) {
  return {
    active: isTranscriptMessageUnderReview(sessionId, message.id),
    comments: transcriptReviewCommentsForMessage(sessionId, message.id),
    onStart: (target: TranscriptMessage) => startTranscriptReview(sessionId, target),
    onAddComment: (target: TranscriptMessage, line: TranscriptReviewLine) => addTranscriptReviewComment(sessionId, target, line),
    onEditComment: (_target: TranscriptMessage, comment: TranscriptReviewComment) => editTranscriptReviewComment(sessionId, comment),
    onDeleteComment: (_target: TranscriptMessage, comment: TranscriptReviewComment) => deleteTranscriptReviewComment(sessionId, comment),
    onCancel: (target: TranscriptMessage) => cancelTranscriptReview(sessionId, target),
    onFlush: (target: TranscriptMessage) => flushTranscriptReviewComments(sessionId, target),
  };
}

function flushPlanReviewComments(sessionId: string, review: PendingPlanReview): void {
  const message = planReviewTranscriptMessage(review);
  const comments = transcriptReviewCommentsForMessage(sessionId, message.id);
  if (comments.length === 0) return;
  const promptText = buildPlanReviewPrompt(review, comments);
  transcriptPreviewDraft = { sessionId, message, comments, promptText };
  diffPreviewDraft = null;
  codePreviewDraft = null;
  diffPreviewTitle.textContent = "Preview plan comments";
  diffPreviewSubtitle.textContent = "Review the refinement prompt that will be sent to OMP.";
  diffPreviewText.value = promptText;
  diffPreviewText.readOnly = false;
  diffPreviewStatus.textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"} ready to send`;
  diffPreviewSend.textContent = "Send refinement";
  diffPreviewSend.disabled = false;
  diffPreviewOverlay.hidden = false;
  focusPromptPreviewStart();
}

function planReviewLineOptions(sessionId: string, review: PendingPlanReview) {
  const message = planReviewTranscriptMessage(review);
  return {
    active: isTranscriptMessageUnderReview(sessionId, message.id),
    comments: transcriptReviewCommentsForMessage(sessionId, message.id),
    onStart: (target: TranscriptMessage) => startTranscriptReview(sessionId, target),
    onAddComment: (target: TranscriptMessage, line: TranscriptReviewLine) => addTranscriptReviewComment(sessionId, target, line),
    onEditComment: (_target: TranscriptMessage, comment: TranscriptReviewComment) => editTranscriptReviewComment(sessionId, comment),
    onDeleteComment: (_target: TranscriptMessage, comment: TranscriptReviewComment) => deleteTranscriptReviewComment(sessionId, comment),
    onCancel: (target: TranscriptMessage) => cancelTranscriptReview(sessionId, target),
    onFlush: () => flushPlanReviewComments(sessionId, review),
  };
}

function ensureReviewCommentsLoaded(sessionId: string): void {
  if (!sessionId || reviewCommentsRequested.has(sessionId) || reviewCommentsLoadInFlight.has(sessionId)) return;
  if (send({ type: "review.comments.list", sessionId })) {
    reviewCommentsLoadInFlight.add(sessionId);
  }
}

function markReviewCommentsDirty(sessionId: string): void {
  if (reviewCommentsLoadInFlight.has(sessionId)) {
    reviewCommentsResyncNeeded.add(sessionId);
  }
}

function reviewCommentAsAnnotation(comment: ReviewComment): DiffReviewAnnotation {
  return {
    id: comment.id,
    kind: "comment",
    comparisonKey: comment.comparisonKey,
    anchor: comment.anchor,
    text: comment.body,
    status: "sent",
    createdAt: comment.updatedAt,
  };
}

function flushableReviewCommentAnnotations(comments: ReviewComment[], key: string): DiffReviewAnnotation[] {
  return comments
    .filter(comment => comment.author === "user" && !comment.stale && !comment.flushedAt && comment.comparisonKey === key)
    .map(reviewCommentAsAnnotation);
}


function editDiffAnnotation(sessionId: string, annotation: DiffReviewAnnotation): void {
  const next = window.prompt(annotation.kind === "question" ? "Edit question" : "Edit comment", annotation.text);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  diffAnnotations.set(
    sessionId,
    (diffAnnotations.get(sessionId) ?? []).map(existing =>
      existing.id === annotation.id ? { ...existing, text: trimmed } : existing,
    ),
  );
  markDiffsViewDirty();
  rerenderDiffsViewPreservingScroll(sessionId);
}

function deleteDiffAnnotation(sessionId: string, annotation: DiffReviewAnnotation): void {
  diffAnnotations.set(
    sessionId,
    (diffAnnotations.get(sessionId) ?? []).filter(existing => existing.id !== annotation.id),
  );
  markDiffsViewDirty();
  rerenderDiffsViewPreservingScroll(sessionId);
}

function renderDiffAnnotationItem(sessionId: string, annotation: DiffReviewAnnotation): HTMLElement {
  const item = mkEl("div");
  item.className = `diff-inline-comment diff-inline-${annotation.kind} review-comment-item`;
  const body = mkEl("span");
  body.textContent = `${annotation.kind === "question" ? "Question" : "Comment"}: ${annotation.text}`;
  const controls = mkEl("span");
  controls.className = "review-comment-actions";
  const edit = mkEl("button");
  edit.type = "button";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => editDiffAnnotation(sessionId, annotation));
  const remove = mkEl("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => deleteDiffAnnotation(sessionId, annotation));
  controls.append(edit, remove);
  item.append(body, controls);
  return item;
}

function reviewCommentAuthorLabel(author: ReviewComment["author"]): string {
  return author === "agent" ? "Assistant" : "You";
}

function isReviewCommentCreateComposer(sessionId: string, key: string, location: DiffLineLocation): boolean {
  return activeReviewCommentComposer?.mode === "create"
    && activeReviewCommentComposer.sessionId === sessionId
    && activeReviewCommentComposer.comparisonKey === key
    && isSameDiffLineLocation(activeReviewCommentComposer.anchor, location);
}

function renderReviewCommentComposer(options: {
  mode: "create" | "edit";
  initialBody: string;
  title: string;
  submitLabel: string;
  onInput: (body: string) => void;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}): HTMLFormElement {
  const form = mkEl("form");
  form.className = `review-comment-composer review-comment-composer-${options.mode}`;
  const header = mkEl("div");
  header.className = "review-comment-composer-header";
  const avatar = mkEl("span");
  avatar.className = "review-comment-avatar review-comment-avatar-user";
  avatar.textContent = "Y";
  const title = mkEl("strong");
  title.textContent = options.title;
  header.append(avatar, title);
  const textarea = mkEl("textarea");
  textarea.className = "review-comment-composer-input";
  textarea.rows = 4;
  textarea.placeholder = "Leave a review comment";
  textarea.value = options.initialBody;
  const actions = mkEl("div");
  actions.className = "review-comment-composer-actions";
  const cancel = mkEl("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => options.onCancel());
  const submit = mkEl("button");
  submit.type = "submit";
  submit.textContent = options.submitLabel;
  submit.disabled = textarea.value.trim().length === 0;
  textarea.addEventListener("input", () => {
    options.onInput(textarea.value);
    submit.disabled = textarea.value.trim().length === 0;
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const body = textarea.value.trim();
    if (!body) return;
    options.onSubmit(body);
  });
  actions.append(cancel, submit);
  form.append(header, textarea, actions);
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  return form;
}

function closeReviewCommentComposer(sessionId: string): void {
  activeReviewCommentComposer = null;
  markDiffsViewDirty();
  rerenderDiffsViewPreservingScroll(sessionId);
}

function startReviewCommentEdit(comment: ReviewComment): void {
  activeReviewCommentComposer = {
    mode: "edit",
    sessionId: comment.sessionId,
    commentId: comment.id,
    body: comment.body,
  };
  markDiffsViewDirty();
  rerenderDiffsViewPreservingScroll(comment.sessionId);
}

function submitReviewCommentEdit(comment: ReviewComment, body: string): void {
  if (body === comment.body) {
    closeReviewCommentComposer(comment.sessionId);
    return;
  }
  markReviewCommentsDirty(comment.sessionId);
  if (send({ type: "review.comment.update", id: comment.id, body })) {
    activeReviewCommentComposer = null;
    markDiffsViewDirty();
    rerenderDiffsViewPreservingScroll(comment.sessionId);
  }
}

function deleteReviewComment(comment: ReviewComment): void {
  markReviewCommentsDirty(comment.sessionId);
  send({ type: "review.comment.delete", id: comment.id });
}

function renderReviewCommentItem(comment: ReviewComment, stale: boolean, options: { locationLabel?: string; summary?: boolean } = {}): HTMLElement {
  const item = mkEl("article");
  item.className = [
    "review-comment-card",
    options.summary ? "review-comment-summary-card" : "diff-inline-comment",
    `review-comment-${comment.author}`,
    stale ? "is-stale" : "",
  ].filter(Boolean).join(" ");
  const header = mkEl("header");
  header.className = "review-comment-card-header";
  const identity = mkEl("div");
  identity.className = "review-comment-identity";
  const avatar = mkEl("span");
  avatar.className = `review-comment-avatar review-comment-avatar-${comment.author}`;
  avatar.textContent = comment.author === "agent" ? "A" : "Y";
  const author = mkEl("strong");
  author.textContent = reviewCommentAuthorLabel(comment.author);
  identity.append(avatar, author);
  const meta = mkEl("div");
  meta.className = "review-comment-meta";
  if (options.locationLabel) {
    const location = mkEl("code");
    location.className = "review-comment-location";
    location.textContent = options.locationLabel;
    meta.append(location);
  }
  if (stale) {
    const badge = mkEl("span");
    badge.className = "review-comment-stale-badge";
    badge.textContent = "stale/unmatched";
    meta.append(badge);
  }
  if (comment.flushedAt) {
    const badge = mkEl("span");
    badge.className = "review-comment-flushed-badge";
    badge.textContent = "flushed";
    badge.title = "Already sent to the agent";
    meta.append(badge);
  }
  const controls = mkEl("div");
  controls.className = "review-comment-actions";
  const edit = mkEl("button");
  edit.type = "button";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => startReviewCommentEdit(comment));
  const remove = mkEl("button");
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => deleteReviewComment(comment));
  controls.append(edit, remove);
  header.append(identity, meta, controls);
  item.append(header);
  if (activeReviewCommentComposer?.mode === "edit" && activeReviewCommentComposer.commentId === comment.id) {
    item.append(renderReviewCommentComposer({
      mode: "edit",
      initialBody: activeReviewCommentComposer.body,
      title: "Edit review comment",
      submitLabel: "Save",
      onInput: body => {
        if (activeReviewCommentComposer?.mode === "edit" && activeReviewCommentComposer.commentId === comment.id) {
          activeReviewCommentComposer.body = body;
        }
      },
      onSubmit: body => submitReviewCommentEdit(comment, body),
      onCancel: () => closeReviewCommentComposer(comment.sessionId),
    }));
  } else {
    const body = mkEl("p");
    body.className = "review-comment-body";
    body.textContent = comment.body;
    item.append(body);
  }
  return item;
}

function startDiffCommentComposer(
  sessionId: string,
  state: DiffReviewableState,
  location: DiffLineLocation,
): void {
  const key = comparisonKey(state);
  activeReviewCommentComposer = {
    mode: "create",
    sessionId,
    comparisonKey: key,
    anchor: location,
    body: "",
  };
  markDiffsViewDirty();
  rerenderDiffsViewPreservingScroll(sessionId);
}

function submitDiffComment(
  sessionId: string,
  state: DiffReviewableState,
  location: DiffLineLocation,
  body: string,
): void {
  markReviewCommentsDirty(sessionId);
  if (send(createReviewCommentCreateMessage(sessionId, state, location, body))) {
    activeReviewCommentComposer = null;
    markDiffsViewDirty();
    rerenderDiffsViewPreservingScroll(sessionId);
  }
}

function askDiffQuestion(
  sessionId: string,
  state: DiffReviewableState,
  location: DiffLineLocation,
): void {
  const question = window.prompt("Ask the agent about this diff line");
  if (!question?.trim()) return;
  const annotations = diffAnnotations.get(sessionId) ?? [];
  const annotation = createDiffReviewAnnotation({
    id: `${Date.now()}-${annotations.length}`,
    kind: "question",
    state,
    location,
    text: question,
  });
  annotations.push(annotation);
  diffAnnotations.set(sessionId, annotations);

  markDiffsViewDirty();
  rerenderDiffsViewPreservingScroll(sessionId);
}

function cachedDiffRowsForAnnotation(state: DiffReviewableState, annotation: DiffReviewAnnotation): DiffRow[] | null {
  const key = comparisonKey(state);
  return diffPatchCache.get(diffPatchCacheKey(key, annotation.anchor.newPath))?.rows
    ?? diffPatchCache.get(diffPatchCacheKey(key, null))?.rows
    ?? null;
}

function diffAnnotationFlushEditorText(annotations: DiffReviewAnnotation[]): string {
  const allQuestions = annotations.every(annotation => annotation.kind === "question");
  if (allQuestions) return `Flush ${annotations.length} diff question${annotations.length === 1 ? "" : "s"}`;
  return diffCommentFlushEditorText(annotations.length);
}

function diffAnnotationPreviewStatus(annotations: DiffReviewAnnotation[]): string {
  const allQuestions = annotations.every(annotation => annotation.kind === "question");
  if (allQuestions) return `${annotations.length} question${annotations.length === 1 ? "" : "s"} ready to send`;
  return diffCommentPreviewStatus(annotations.length);
}

function sendDiffAnnotations(
  sessionId: string,
  annotationsToFlush: DiffReviewAnnotation[],
  promptText: string,
): void {
  if (annotationsToFlush.length === 0) return;
  const flushedIds = new Set(annotationsToFlush.map(annotation => annotation.id));
  const flushedPersistedComments = annotationsToFlush
    .filter(annotation => annotation.kind === "comment" && annotation.status === "sent")
    .map(annotation => ({ id: annotation.id, updatedAt: annotation.createdAt }));
  const clearFlushedAnnotations = () => {
    if (flushedPersistedComments.length > 0) {
      const flushedAt = String(Date.now());
      const flushedPersistedIds = new Set(flushedPersistedComments.map(comment => comment.id));
      reviewComments.set(
        sessionId,
        (reviewComments.get(sessionId) ?? []).map(comment =>
          flushedPersistedIds.has(comment.id) ? { ...comment, flushedAt } : comment,
        ),
      );
      send({ type: "review.comment.markFlushed", comments: flushedPersistedComments });
    }
    diffAnnotations.set(
      sessionId,
      (diffAnnotations.get(sessionId) ?? []).filter(annotation => !flushedIds.has(annotation.id)),
    );
    markDiffsViewDirty();
    rerenderDiffsViewPreservingScroll(sessionId);
  };
  closeDiffPreview();
  sendPromptWithBusyHandling({
    sessionId,
    text: promptText,
    editorText: diffAnnotationFlushEditorText(annotationsToFlush),
    images: [],
    onSend: clearFlushedAnnotations,
  });
}

function previewDiffAnnotationList(
  sessionId: string,
  state: DiffReviewableState,
  annotationsToFlush: DiffReviewAnnotation[],
  promptMode: DiffAnnotationPromptMode,
): void {
  const key = comparisonKey(state);
  if (annotationsToFlush.length === 0) return;
  const prompt = prepareDiffAnnotationPrompt(state, annotationsToFlush, annotation => cachedDiffRowsForAnnotation(state, annotation), promptMode);
  const isQuestionPreview = annotationsToFlush.every(annotation => annotation.kind === "question");
  if (prompt.ok) {
    diffPreviewDraft = { sessionId, state, comparisonKey: key, annotations: annotationsToFlush };
    transcriptPreviewDraft = null;
    diffPreviewTitle.textContent = isQuestionPreview ? "Preview diff questions" : "Preview diff notes";
    diffPreviewSubtitle.textContent = "Review the prompt that will be sent to OMP.";
    diffPreviewSend.textContent = isQuestionPreview ? "Send questions" : "Send notes";
    diffPreviewSend.disabled = false;
    diffPreviewText.readOnly = false;
    diffPreviewText.value = prompt.prompt;
    diffPreviewStatus.textContent = diffAnnotationPreviewStatus(annotationsToFlush);
    diffPreviewOverlay.hidden = false;
    focusPromptPreviewStart();
    return;
  }
  diffPreviewDraft = null;
  transcriptPreviewDraft = null;
  diffPreviewTitle.textContent = isQuestionPreview ? "Diff questions blocked" : "Diff notes blocked";
  diffPreviewSubtitle.textContent = "message" in prompt ? prompt.message : "";
  diffPreviewSend.textContent = isQuestionPreview ? "Send questions" : "Send notes";
  diffPreviewSend.disabled = true;
  diffPreviewText.value = "";
  diffPreviewText.readOnly = true;
  diffPreviewStatus.textContent = "message" in prompt ? prompt.message : "";
  diffPreviewOverlay.hidden = false;
  diffPreviewText.scrollTop = 0;
  diffPreviewSend.focus();
}

function previewDiffAnnotations(
  sessionId: string,
  state: DiffReviewableState,
  kind: "comment" | "question" | undefined,
  promptMode: DiffAnnotationPromptMode,
): void {
  const key = comparisonKey(state);
  previewDiffAnnotationList(sessionId, state, selectedDiffAnnotations(diffAnnotations.get(sessionId) ?? [], key, kind), promptMode);
}

function previewAgentDiffReview(sessionId: string, state: DiffReviewableState): void {
  agentReviewDraft = { sessionId, state };
  diffPreviewDraft = null;
  transcriptPreviewDraft = null;
  codePreviewDraft = null;
  diffPreviewTitle.textContent = "Request agent review";
  diffPreviewSubtitle.textContent = "Tell the agent how to review. Agent comments will persist after bridge broadcast.";
  diffPreviewText.value = "Review the full change for correctness, reliability, maintainability, and edge cases.";
  diffPreviewText.readOnly = false;
  diffPreviewStatus.textContent = "Agent review comments will appear after the bridge stores and broadcasts them.";
  diffPreviewSend.textContent = "Start review";
  diffPreviewSend.disabled = false;
  diffPreviewOverlay.hidden = false;
  focusPromptPreviewStart();
}

function closeDiffPreview(): void {
  diffPreviewOverlay.hidden = true;
  diffPreviewText.value = "";
  diffPreviewStatus.textContent = "";
  diffPreviewTitle.textContent = "Preview diff notes";
  diffPreviewSubtitle.textContent = "Review the prompt that will be sent to OMP.";
  diffPreviewSend.textContent = "Send notes";
  diffPreviewSend.disabled = false;
  diffPreviewText.readOnly = true;
  codePreviewDraft = null;
  diffPreviewDraft = null;
  agentReviewDraft = null;
  transcriptPreviewDraft = null;
}

function sendPromptPreviewDraft(): void {
  const diffDraft = diffPreviewDraft;
  const transcriptDraft = transcriptPreviewDraft;
  const codeDraft = codePreviewDraft;
  const agentDraft = agentReviewDraft;
  if (agentDraft) {
    const instructions = diffPreviewText.value.trim();
    closeDiffPreview();
    send({ type: "review.agentReview.start", sessionId: agentDraft.sessionId, state: agentDraft.state, instructions });
    return;
  }
  if (codeDraft) {
    const promptText = editablePromptPreviewText();
    if (!promptText) return;
    closeDiffPreview();
    sendCodeComments(codeDraft.sessionId, codeDraft.root, codeDraft.file, codeDraft.comments, promptText);
    return;
  }
  if (diffDraft) {
    const promptText = editablePromptPreviewText();
    if (!promptText) return;
    sendDiffAnnotations(diffDraft.sessionId, diffDraft.annotations, promptText);
    return;
  }
  if (transcriptDraft) {
    const promptText = editablePromptPreviewText();
    if (!promptText) return;
    closeDiffPreview();
    sendTranscriptReviewComments(transcriptDraft.sessionId, transcriptDraft.message, transcriptDraft.comments, promptText);
  }
}

function flushDiffAnnotations(
  sessionId: string,
  state: DiffReviewableState,
  kind: "comment" | "question" | undefined,
  promptMode: DiffAnnotationPromptMode,
): void {
  previewDiffAnnotations(sessionId, state, kind, promptMode);
}


function renderDiffsView(container: HTMLElement, projection: SessionProjection | undefined): void {
  setRenderDocument(container.ownerDocument);
  const sameSessionRerender = lastDiffsRenderedSessionId === activeSessionId;
  lastDiffsRenderedSessionId = activeSessionId;
  lastDiffsRenderedProjectionPresent = Boolean(projection);
  diffPanelDirty = false;
  // Preserve the file-list scroll across SAME-session re-renders (e.g. opening
  // the right-click file menu rebuilds the sidebar) so the list does not jump to
  // the top; a session switch resets to the top.
  const preservedScroll = sameSessionRerender
    ? (container.querySelector<HTMLElement>(".diffs-sidebar-scroll")?.scrollTop ?? 0)
    : 0;
  const historyScroll = sameSessionRerender ? container.querySelector<HTMLElement>(".git-history-list")?.scrollTop ?? 0 : 0;
  const optionsOpen = sameSessionRerender && Boolean(container.querySelector<HTMLDetailsElement>(".git-review-options")?.open);
  const openCommitKey = sameSessionRerender ? container.querySelector<HTMLElement>(".diff-commit-message[open]")?.dataset.comparisonKey : undefined;
  const restoreOptionsFocus = optionsOpen && Boolean(container.ownerDocument.activeElement?.closest(".git-review-options"));
  const restoreReviewFocus = sameSessionRerender && container.contains(container.ownerDocument.activeElement)
    && !container.ownerDocument.activeElement?.closest("input, textarea, select, [contenteditable]");
  container.replaceChildren();

  const root = mkEl("div");
  root.className = "diffs-view session-changes-view";
  root.tabIndex = 0;
  root.setAttribute("aria-label", "Git review");
  root.addEventListener("pointerdown", event => {
    if (!(event.target as Element).closest("button, a, input, textarea, select, summary, [contenteditable]")) {
      root.focus({ preventScroll: true });
    }
  });
  root.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if ((event.target as Element).closest("input, textarea, select, [contenteditable], [role='textbox'], .git-review-options")) return;
    if (event.key !== "n" && event.key !== "p") return;
    const button = root.querySelector<HTMLButtonElement>(`.git-commit-navigation button[aria-label="${event.key === "n" ? "Older commit" : "Newer commit"}"]`);
    if (!button || button.disabled) return;
    event.preventDefault();
    button.click();
  });
  const sidebar = mkEl("aside");
  sidebar.className = "diffs-sidebar";
  const sidebarTop = mkEl("div");
  sidebarTop.className = "diffs-sidebar-top";
  const sidebarScroll = mkEl("div");
  sidebarScroll.className = "diffs-sidebar-scroll";
  sidebar.append(sidebarTop, sidebarScroll);

  const main = mkEl("section");
  main.className = "diffs-main";
  root.append(sidebar, main);
  container.append(root);

  if (!activeSessionId || !projection) {
    renderDiffMessage(main, "No session selected.", false);
    return;
  }
  renderSessionChangesView(activeSessionId, sidebarTop, sidebarScroll, main);
  if (preservedScroll > 0) sidebarScroll.scrollTop = preservedScroll;
  const historyList = container.querySelector<HTMLElement>(".git-history-list");
  if (historyList && historyScroll > 0) historyList.scrollTop = historyScroll;
  const options = container.querySelector<HTMLDetailsElement>(".git-review-options");
  if (options) options.open = optionsOpen;
  const commit = container.querySelector<HTMLDetailsElement>(".diff-commit-message");
  if (commit && openCommitKey === commit.dataset.comparisonKey) commit.open = true;
  if (restoreReviewFocus) {
    const focusTarget = restoreOptionsFocus ? options?.querySelector<HTMLElement>("summary") : null;
    (focusTarget ?? root).focus({ preventScroll: true });
  }
}

function renderSessionChangesView(sessionId: string, sidebarTop: HTMLElement, sidebar: HTMLElement, main: HTMLElement): void {
  const projection = projections.get(sessionId);
  if (projection?.summary.sessionMode === "diffReview") {
    renderDiffReviewSessionView(sessionId, projection.summary, sidebarTop, sidebar, main);
    return;
  }
  const state = sessionChangesStates.get(sessionId);
  const history = gitReviewFor(sessionId);
  const root = main.parentElement!;
  root.classList.add("git-review-view");
  root.classList.toggle("git-history-mode", history.view === "history");
  const header = mkEl("header");
  header.className = "git-review-header";
  const options = mkEl("details");
  options.className = "git-review-options";
  const optionsSummary = mkEl("summary");
  optionsSummary.textContent = "⋯";
  optionsSummary.setAttribute("aria-label", "Review options");
  optionsSummary.title = "Review options";
  const optionsMenu = mkEl("div");
  optionsMenu.className = "git-review-options-menu";
  optionsMenu.addEventListener("click", event => {
    if ((event.target as Element).closest("button")) options.open = false;
  });
  options.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      options.open = false;
      optionsSummary.focus();
    }
  });
  options.append(optionsSummary, optionsMenu);
  const repository = mkEl("div");
  repository.className = "git-repository-context";
  if (state) renderSessionRepoControls(sessionId, state, repository, optionsMenu);
  else {
    const add = mkEl("button");
    add.type = "button";
    add.textContent = "Add repository";
    add.addEventListener("click", () => {
      const path = window.prompt("Repository path");
      if (path?.trim()) updateSessionRepo(sessionId, "add", path.trim());
    });
    optionsMenu.append(add);
  }
  const identity = mkEl("div");
  identity.className = "git-repository-identity";
  const branch = mkEl("strong");
  branch.className = "git-head-label";
  branch.textContent = history.page ? gitHeadLabel(history.page) : history.loading ? "Reading branch / HEAD…" : "Branch / HEAD unavailable";
  const path = mkEl("code");
  path.className = "git-root-path";
  path.textContent = history.repoRoot || "Select a repository";
  path.title = history.repoRoot;
  identity.append(branch, path);
  repository.append(identity);
  const navigation = mkEl("nav");
  navigation.className = "git-review-navigation";
  navigation.setAttribute("aria-label", "Git review views");
  for (const [view, label] of [["changes", "Current changes"], ["history", "History"]] as const) {
    const button = mkEl("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(history.view === view));
    button.addEventListener("click", () => selectGitReviewView(sessionId, view));
    navigation.append(button);
  }
  const refresh = mkEl("button");
  refresh.type = "button";
  refresh.textContent = "↻";
  refresh.setAttribute("aria-label", "Refresh");
  refresh.title = "Refresh";
  refresh.disabled = diffLoadingSessions.has(sessionId);
  refresh.addEventListener("click", () => requestSessionChangesRefresh(sessionId));
  const compare = mkEl("button");
  compare.type = "button";
  compare.textContent = "Advanced Compare";
  compare.disabled = !history.repoRoot || (history.view === "history" && !history.selectedOid);
  compare.addEventListener("click", () => openAdvancedGitCompare(sessionId));
  const expand = mkEl("button");
  expand.type = "button";
  const expanded = desktopDockview?.isPanelExpanded?.("diffs") ?? false;
  expand.textContent = expanded ? "↙" : "⤢";
  expand.title = expanded ? "Restore layout" : "Expand review";
  expand.setAttribute("aria-label", expand.title);
  expand.addEventListener("click", () => {
    desktopDockview?.setPanelExpanded?.("diffs", !expanded);
    markDiffsViewDirty();
    renderDiffsViewIfActive(sessionId);
  });
  navigation.append(refresh, expand);
  optionsMenu.append(compare);
  header.append(repository, navigation, options);
  root.prepend(header);
  if (history.view === "history") {
    sidebarTop.append(renderGitHistoryBrowser(history, {
      selectBranch: ref => selectHistoryBranch(sessionId, ref),
      select: oid => selectGitCommit(sessionId, oid),
      loadOlder: () => {
        if (!history.page?.nextCursor || history.loading) return;
        requestGitHistory(sessionId, history.repoRoot, history.page.nextCursor);
        markDiffsViewDirty();
        renderDiffsViewIfActive(sessionId);
      },
      refresh: () => {
        requestGitHistory(sessionId, history.repoRoot);
        markDiffsViewDirty();
        renderDiffsViewIfActive(sessionId);
      },
    }));
    const stepping = mkEl("div");
    stepping.className = "diffs-actions git-commit-navigation";
    const index = history.page?.commits.findIndex(commit => commit.oid === history.selectedOid) ?? -1;
    for (const [offset, label] of [[-1, "Newer commit"], [1, "Older commit"]] as const) {
      const button = mkEl("button");
      button.type = "button";
      button.textContent = offset < 0 ? "↑" : "↓";
      button.setAttribute("aria-label", label);
      button.title = `${label} (${offset < 0 ? "p" : "n"})`;
      button.setAttribute("aria-keyshortcuts", offset < 0 ? "p" : "n");
      const target = index >= 0 ? history.page?.commits[index + offset] : undefined;
      button.disabled = !target;
      button.addEventListener("click", () => { if (target) selectGitCommit(sessionId, target.oid); });
      stepping.append(button);
    }
    main.append(stepping);
    if (!history.selectedOid) {
      renderDiffMessage(main, history.loading ? "Loading commit history…" : "Select a commit to review its message, files and hunks.", false);
      return;
    }
  } else {
    const toolbar = mkEl("div");
    toolbar.className = "diffs-toolbar";
    const group = mkEl("select");
    group.className = "diff-group-select";
    group.setAttribute("aria-label", "Git change group");
    for (const kind of ["unstaged", "staged", "untracked"] as const) {
      const option = mkEl("option");
      option.value = kind;
      option.textContent = kind[0].toUpperCase() + kind.slice(1);
      option.selected = kind === (sessionChangesKinds.get(sessionId) ?? "unstaged");
      group.append(option);
    }
    group.addEventListener("change", () => requestSessionChangesRefresh(sessionId, { changeKind: group.value as GitChangeKind, refreshHistory: false }));
    toolbar.append(group);
    main.append(toolbar);
  }
  const error = diffErrors.get(sessionId);
  if (error) {
    renderDiffMessage(main, error, true);
    return;
  }
  if (!state || state.status !== "ready") {
    renderDiffMessage(main, state?.status === "missingRepo" ? state.reason : "Loading Git review…", state?.status === "missingRepo");
    return;
  }
  const expectedCommit = history.view === "history" ? history.selectedOid : null;
  if (state.selectedRepoId !== history.repoRoot || (state.review.currentCommitOid ?? null) !== expectedCommit) {
    renderDiffMessage(main, "Loading selected review…", false);
    return;
  }
  renderReviewableDiff(sessionId, state, sidebarTop, sidebar, main, true, "sessionChanges");
}

function renderDiffReviewSessionView(
  sessionId: string,
  summary: SessionSummary,
  sidebarTop: HTMLElement,
  sidebar: HTMLElement,
  main: HTMLElement,
): void {
  const header = mkEl("div");
  header.className = "diffs-toolbar";
  const title = mkEl("strong");
  title.textContent = "Diff";
  header.append(title);
  main.append(header);
  const request = diffReviewRequestForSummary(summary);
  if (!request) {
    renderDiffMessage(main, "This diff session is missing its repository/ref configuration.", true);
    return;
  }
  const error = diffErrors.get("compareDiff");
  if (error) {
    renderDiffMessage(main, error, true);
    return;
  }
  if (!compareDiffState || !compareStateMatchesDiffReview(request)) {
    renderDiffMessage(main, "Loading diff…", false);
    if (!compareDiffLoading) requestDiffReviewState(sessionId, summary);
    return;
  }
  renderReviewableDiff(sessionId, compareDiffState, sidebarTop, sidebar, main, true, "compareDiff");
}

function renderSessionRepoControls(sessionId: string, state: SessionChangesSummaryState, sidebar: HTMLElement, optionsMenu: HTMLElement): void {
  const section = mkEl("section");
  section.className = "diffs-repo-selector";
  const select = mkEl("select");
  select.className = "diff-repo-select";
  select.setAttribute("aria-label", "Repository");
  select.disabled = state.repos.length === 0;
  for (const repo of state.repos) {
    const option = mkEl("option");
    option.value = repo.id;
    option.textContent = repo.label || formatDiffRepoLabel(repo.repoRoot);
    option.title = `${repo.repoRoot} · ${repo.source}${repo.isDefault ? " · default" : ""}`;
    option.selected = repo.id === (sessionChangesRepoIds.get(sessionId) ?? (state.status === "ready" ? state.selectedRepoId : null));
    select.append(option);
  }
  const currentPayload = state.status === "ready" ? state.comparison.detailMode : sessionChangesPayloadKinds.get(sessionId) ?? DEFAULT_SESSION_CHANGES_DETAIL_MODE;
  select.addEventListener("change", () => requestSessionChangesRepo(sessionId, select.value, currentPayload));
  section.append(select);
  const actions = mkEl("div");
  actions.className = "diffs-actions git-repository-actions";
  const add = mkEl("button");
  add.type = "button";
  add.textContent = "Add";
  add.title = "Add a repository path";
  add.addEventListener("click", () => {
    const path = window.prompt("Repository path");
    if (path?.trim()) updateSessionRepo(sessionId, "add", path.trim());
  });
  const selected = state.repos.find(repo => repo.id === select.value);
  select.title = selected?.repoRoot ?? "Repository";
  for (const [action, text] of [["hide", "Hide selected"], ["default", "Set default"]] as const) {
    const button = mkEl("button");
    button.type = "button";
    button.textContent = text;
    button.disabled = !selected || diffLoadingSessions.has(sessionId) || (action === "default" && selected.isDefault);
    button.addEventListener("click", () => {
      if (selected) updateSessionRepo(sessionId, action, selected.repoRoot);
    });
    actions.append(button);
  }
  actions.prepend(add);
  optionsMenu.append(actions);
  sidebar.append(section);
}

function updateSessionRepo(sessionId: string, action: SessionRepoAction, path: string): void {
  if (!send({ type: "sessionRepos.update", sessionId, action, path })) {
    appendSessionNotice(sessionId, { level: "error", text: "Not connected to the Fura bridge." });
    render();
  }
}

function invalidateRangeDiff(): void {
  if (pendingRangeDiff && connection?.isOpen()) {
    send({ type: "git.rangeDiff.cancel", requestId: pendingRangeDiff.requestId });
  }
  pendingRangeDiff = null;
  rangeDiffResult = null;
  rangeDiffError = null;
}

function requestRangeDiff(values: RangeDiffInputs): void {
  invalidateRangeDiff();
  rangeDiffInputs = {
    repoRoot: values.repoRoot.trim(), base: values.base.trim(),
    old: values.old.trim(), new: values.new.trim(),
    ignoreWhitespace: values.ignoreWhitespace,
  };
  if ([rangeDiffInputs.repoRoot, rangeDiffInputs.base, rangeDiffInputs.old, rangeDiffInputs.new].some(value => !value)) {
    rangeDiffError = "Repository, Base, Old and New are required for range-diff.";
  } else {
    const requestId = nextClientRequestId("range-diff");
    pendingRangeDiff = { requestId, inputs: { ...rangeDiffInputs } };
    if (!send({ type: "git.rangeDiff.request", clientId: diffClientId, requestId, ...rangeDiffInputs })) {
      pendingRangeDiff = null;
      rangeDiffError = "Not connected to the Fura bridge.";
    }
  }
  markComparePanelDirty();
  renderComparePanelIfActive();
}

function compareModeSelector(repoRoot: () => string): HTMLSelectElement {
  const select = mkEl("select");
  select.setAttribute("aria-label", "Compare mode");
  for (const [value, text] of [["files", "File diff"], ["rangeDiff", "Range-diff"]] as const) {
    const option = mkEl("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = compareMode;
  select.addEventListener("change", () => {
    invalidateRangeDiff();
    compareMode = select.value === "rangeDiff" ? "rangeDiff" : "files";
    if (compareMode === "rangeDiff") rangeDiffInputs.repoRoot = repoRoot();
    else {
      const root = repoRoot();
      if (compareRepoRoot !== root) clearCurrentCompareDiff("repoChanged");
      compareRepoRoot = root;
    }
    markComparePanelDirty();
    renderComparePanelIfActive();
  });
  return select;
}

function renderRangeDiffBody(): void {
  const body = rangeDiffBody;
  if (!body) return;
  body.replaceChildren();
  body.setAttribute("aria-busy", String(Boolean(pendingRangeDiff)));
  if (!rangeDiffResult) {
    const status = body.ownerDocument.createElement("p");
    status.className = "empty";
    status.setAttribute("role", rangeDiffError ? "alert" : "status");
    status.textContent = rangeDiffError ?? (pendingRangeDiff ? "Loading range-diff…" : "Compare Base..Old against Base..New.");
    body.append(status);
    return;
  }
  const result = rangeDiffResult;
  const identity = body.ownerDocument.createElement("div");
  identity.className = "range-diff-identity";
  identity.textContent = `Repository: ${result.repoRoot}\nBase: ${result.base.input} (${result.base.oid})\nOld: ${result.old.input} (${result.old.oid})\nNew: ${result.new.input} (${result.new.oid})`;
  const output = body.ownerDocument.createElement("div");
  body.append(identity, output);
  renderRangeDiffOutput(output, result.output, result.truncated);
}

function renderRangeDiffCompare(container: HTMLElement): void {
  const root = mkEl("div");
  root.className = "compare-view range-compare-view";
  const form = mkEl("form");
  form.className = "range-compare-controls";
  form.append(compareModeSelector(() => rangeDiffInputs.repoRoot));
  const fields = {} as Record<"repoRoot" | "base" | "old" | "new", HTMLInputElement>;
  for (const [key, title] of [["repoRoot", "Repository"], ["base", "Base"], ["old", "Old"], ["new", "New"]] as const) {
    const label = mkEl("label");
    label.textContent = title;
    const input = mkEl("input");
    input.setAttribute("aria-label", title);
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 4096;
    input.value = rangeDiffInputs[key];
    input.placeholder = key === "base" ? "e.g. origin/v35" : title;
    input.addEventListener("input", () => {
      rangeDiffInputs[key] = input.value;
      invalidateRangeDiff();
      renderRangeDiffBody();
    });
    fields[key] = input;
    label.append(input);
    form.append(label);
  }
  const whitespaceLabel = mkEl("label");
  whitespaceLabel.className = "checkbox-row";
  whitespaceLabel.title = "Ignore whitespace in patch comparisons; commit matching and statuses stay unchanged.";
  const ignoreWhitespace = mkEl("input");
  ignoreWhitespace.type = "checkbox";
  ignoreWhitespace.checked = rangeDiffInputs.ignoreWhitespace;
  ignoreWhitespace.addEventListener("change", () => {
    requestRangeDiff({ ...rangeDiffInputs, ignoreWhitespace: ignoreWhitespace.checked });
  });
  whitespaceLabel.append(ignoreWhitespace, "Ignore whitespace");
  form.append(whitespaceLabel);
  const run = mkEl("button");
  run.type = "submit";
  run.textContent = "Compare";
  form.append(run);
  form.addEventListener("submit", event => {
    event.preventDefault();
    requestRangeDiff({ repoRoot: fields.repoRoot.value, base: fields.base.value, old: fields.old.value, new: fields.new.value, ignoreWhitespace: ignoreWhitespace.checked });
  });
  rangeDiffBody = mkEl("section");
  rangeDiffBody.className = "range-compare-body";
  root.append(form, rangeDiffBody);
  container.append(root);
  renderRangeDiffBody();
}

function renderComparePanel(container: HTMLElement): void {
  setRenderDocument(container.ownerDocument);
  comparePanelDirty = false;
  container.replaceChildren();
  rangeDiffBody = null;
  if (compareMode === "rangeDiff") {
    renderRangeDiffCompare(container);
    return;
  }

  const root = mkEl("div");
  root.className = "compare-view";
  const sidebarContainer = mkEl("aside");
  sidebarContainer.className = "diffs-sidebar compare-sidebar";
  const sidebarTop = mkEl("div");
  sidebarTop.className = "diffs-sidebar-top";
  const sidebar = mkEl("div");
  sidebar.className = "diffs-sidebar-scroll";
  sidebarContainer.append(sidebarTop, sidebar);
  const main = mkEl("section");
  main.className = "diffs-main compare-main";
  root.append(sidebarContainer, main);
  container.append(root);
  const form = mkEl("section");
  form.className = "diffs-repo-selector compare-diff-controls";
  const repoInput = mkEl("input");
  repoInput.className = "diff-repo-input";
  repoInput.placeholder = "/path/to/repo";
  repoInput.value = compareRepoRoot;
  const baseInput = mkEl("input");
  baseInput.className = "diff-ref-input";
  baseInput.placeholder = "base ref";
  baseInput.value = compareBaseRef;
  const headInput = mkEl("input");
  headInput.className = "diff-ref-input";
  headInput.placeholder = "head ref or WORKTREE";
  headInput.value = compareHeadRef;
  const payload = mkEl("select");
  for (const [value, text] of [["filePatch", "File patch"], ["statOnly", "Stat"]] as const) {
    const option = mkEl("option");
    option.value = value;
    option.textContent = text;
    option.selected = comparePayloadKind === value;
    payload.append(option);
  }
  const run = mkEl("button");
  run.type = "button";
  run.textContent = "Compare";
  run.addEventListener("click", () => requestCompareDiff({ repoRoot: repoInput.value, base: baseInput.value, head: headInput.value, payloadKind: payload.value as DiffDetailMode }));
  repoInput.setAttribute("aria-label", "Repository");
  baseInput.setAttribute("aria-label", "Base");
  headInput.setAttribute("aria-label", "Head");
  form.append(compareModeSelector(() => repoInput.value));
  form.append(repoInput, baseInput, headInput, payload, run);
  sidebarTop.append(form);

  const header = mkEl("div");
  header.className = "diffs-toolbar";
  const title = mkEl("strong");
  title.textContent = "Compare diff";
  header.append(title);
  main.append(header);
  const error = diffErrors.get("compareDiff");
  if (error) {
    renderDiffMessage(main, error, true);
    return;
  }
  if (!compareDiffState) {
    renderDiffMessage(main, compareDiffLoading ? "Loading compare diff…" : "Run an explicit repository/ref comparison.", false);
    return;
  }
  renderReviewableDiff("compareDiff", compareDiffState, sidebarTop, sidebar, main, false, "compareDiff");
}

function renderDiffMessage(main: HTMLElement, message: string, error: boolean): void {
  const body = mkEl("div");
  body.className = "diffs-main-body";
  const text = mkEl("p");
  text.className = `empty diffs-empty ${error ? "diffs-error" : ""}`;
  text.textContent = message;
  body.append(text);
  main.append(body);
}

function requestDiffContent(annotationKey: string, state: DiffReviewableState, filePath: string | null, requestMode: "sessionChanges" | "compareDiff", contextLines?: number): void {
  const file = filePath ? state.summary.files.find(candidate => candidate.newPath === filePath) : null;
  if (filePath && !file) return;
  const key = comparisonKey(state);
  if (requestMode === "compareDiff") {
    if (!compareDiffId || !compareDiffState || pendingDiffFilePatchMatches(annotationKey, compareDiffId, key, filePath)) return;
    pendingDiffFilePatches.set(annotationKey, { diffId: compareDiffId, comparisonKey: key, filePath });
    diffFilePatchErrors.delete(annotationKey);
    const sent = send({
      type: "diff.content.request",
      clientId: diffClientId,
      diffId: compareDiffId,
      scope: "compareDiff",
      sessionId: null,
      comparisonKey: key,
      selectedFile: file ? { oldPath: file.oldPath ?? null, newPath: file.newPath } : null,
      contextLines,
    });
    if (sent) return;
    clearPendingDiffFilePatch(annotationKey, compareDiffId);
    diffFilePatchErrors.set(annotationKey, { filePath, message: "Not connected to the Fura bridge." });
    markComparePanelDirty();
    renderComparePanelIfActive();
    if (annotationKey !== "compareDiff") {
      markDiffsViewDirty();
      renderDiffsViewIfActive(annotationKey);
    }
    return;
  }
  const diffId = sessionChangesDiffIds.get(annotationKey);
  const summary = sessionChangesStates.get(annotationKey);
  if (!diffId || !summary || summary.diffId !== diffId || diffLoadingSessions.has(annotationKey) || pendingDiffFilePatchMatches(annotationKey, diffId, key, filePath)) return;
  pendingDiffFilePatches.set(annotationKey, { diffId, comparisonKey: key, filePath });
  diffFilePatchErrors.delete(annotationKey);
  const sent = send({
    type: "diff.content.request",
    clientId: diffClientId,
    diffId,
    scope: "sessionChanges",
    sessionId: annotationKey,
    comparisonKey: key,
    selectedFile: file ? { oldPath: file.oldPath ?? null, newPath: file.newPath } : null,
    contextLines,
  });
  if (sent) return;
  clearPendingDiffFilePatch(annotationKey, diffId);
  diffFilePatchErrors.set(annotationKey, { filePath, message: "Not connected to the Fura bridge." });
  markDiffsViewDirty();
  renderDiffsViewIfActive(annotationKey);
}

function requestWiderDiffContext(annotationKey: string, state: DiffReviewableState, filePath: string, requestMode: "sessionChanges" | "compareDiff"): void {
  const key = comparisonKey(state);
  const scope = sessionChangesSelectedFiles.get(annotationKey) ? filePath : null;
  const cached = diffPatchCache.get(diffPatchCacheKey(key, scope));
  const currentContext = cached?.contextLines ?? state.comparison.contextLines ?? 3;
  requestDiffContent(annotationKey, state, scope, requestMode, Math.min(currentContext + 10, 200));
}


function renderReviewableDiff(
  annotationKey: string,
  state: DiffReviewableState,
  sidebarTop: HTMLElement,
  sidebar: HTMLElement,
  main: HTMLElement,
  allowPromptActions: boolean,
  requestMode: "sessionChanges" | "compareDiff",
): void {
  const key = comparisonKey(state);
  if (annotationKey !== "compareDiff") ensureReviewCommentsLoaded(annotationKey);
  const annotations = diffAnnotations.get(annotationKey) ?? [];
  const comments = reviewCommentsForComparison(reviewComments.get(annotationKey) ?? [], key);
  const fileSummaries = summarizeWireDiffFiles(state.summary.files, [...annotations, ...comments.map(reviewCommentAsAnnotation)], key);
  const selectedFilePath = selectedDiffFilePath(annotationKey, state, fileSummaries.map(file => file.filePath));
  renderDiffFileFilter(sidebarTop, annotationKey);
  renderDesktopModifiedFiles(sidebar, state, fileSummaries, selectedFilePath, annotationKey);
  renderReviewableDiffMainContent(annotationKey, state, main, allowPromptActions, requestMode);
}

function renderReviewableDiffMainContent(
  annotationKey: string,
  state: DiffReviewableState,
  main: HTMLElement,
  allowPromptActions: boolean,
  requestMode: "sessionChanges" | "compareDiff",
): void {
  const key = comparisonKey(state);
  const annotations = diffAnnotations.get(annotationKey) ?? [];
  const comments = reviewCommentsForComparison(reviewComments.get(annotationKey) ?? [], key);
  const fileSummaries = summarizeWireDiffFiles(state.summary.files, [...annotations, ...comments.map(reviewCommentAsAnnotation)], key);
  const selectedFilePath = selectedDiffFilePath(annotationKey, state, fileSummaries.map(file => file.filePath));
  const cachedPatch = selectedFilePath ? diffPatchCache.get(diffPatchCacheKey(key, selectedFilePath)) : undefined;
  const aggregatePatch = selectedFilePath ? undefined : diffPatchCache.get(diffPatchCacheKey(key, null));
  const detailToolbar = mkEl("div");
  detailToolbar.className = "git-detail-toolbar";
  const navigation = main.querySelector<HTMLElement>(".diffs-toolbar, .git-commit-navigation");
  if (navigation) detailToolbar.append(navigation);
  const selectedCommit = state.review.currentCommitOid
    ? state.review.commits.find(commit => commit.oid === state.review.currentCommitOid) ?? null
    : null;
  const comparison = mkEl("p");
  const displayedRange = state.comparison.displayedPatchRange;
  comparison.textContent = `${resolvedRefLabel(displayedRange?.base ?? state.comparison.base)} → ${resolvedRefLabel(displayedRange?.head ?? state.comparison.head)}`;
  if (selectedCommit) {
    const messageBlock = mkEl("details");
    messageBlock.className = "diff-commit-message";
    messageBlock.dataset.comparisonKey = key;
    const commitSummary = mkEl("summary");
    commitSummary.className = "git-commit-summary";
    commitSummary.title = `${selectedCommit.oid}\n${selectedCommit.message || selectedCommit.subject}`;
    const subject = mkEl("strong");
    subject.textContent = selectedCommit.subject || "(no subject)";
    commitSummary.append(subject);
    if (requestMode === "compareDiff") {
      const position = mkEl("span");
      position.className = "git-commit-position";
      position.textContent = `Commit ${(state.review.currentCommitIndex ?? 0) + 1}/${state.review.commits.length}`;
      commitSummary.append(position);
    }
    if (selectedCommit.isMerge || !selectedCommit.parentOids.length) {
      const basisLabel = mkEl("span");
      basisLabel.className = "git-commit-basis";
      basisLabel.textContent = selectedCommit.isMerge ? "Merge · first parent" : "Initial · empty tree";
      commitSummary.append(basisLabel);
    }
    const metadata = mkEl("p");
    metadata.className = "git-selected-commit-meta";
    metadata.textContent = `${selectedCommit.oid} · ${selectedCommit.authorName || "Unknown author"}${selectedCommit.authorEmail ? ` <${selectedCommit.authorEmail}>` : ""} · ${selectedCommit.committedAt}`;
    const basis = mkEl("p");
    basis.textContent = selectedCommit.isMerge
      ? `Merge commit — diff against first parent ${selectedCommit.parentOids[0]}`
      : selectedCommit.parentOids[0] ? `Diff against parent ${selectedCommit.parentOids[0]}` : "Initial commit — diff against the empty tree";
    const heading = mkEl("strong");
    heading.textContent = "Commit message";
    const messageText = mkEl("pre");
    messageText.textContent = selectedCommit.message || selectedCommit.subject;
    messageBlock.append(commitSummary, metadata, basis, comparison, heading, messageText);
    detailToolbar.append(messageBlock);
  } else {
    const summary = mkEl("section");
    summary.className = "diffs-summary";
    summary.append(comparison);
    if (requestMode === "compareDiff") {
      const commits = mkEl("span");
      commits.textContent = `Range · ${state.review.commits.length} commit${state.review.commits.length === 1 ? "" : "s"}`;
      summary.append(commits);
    }
    detailToolbar.append(summary);
  }

  const toolbar = mkEl("div");
  toolbar.className = "diffs-actions diff-step-actions";
  const payloadToggle = mkEl("button");
  payloadToggle.type = "button";
  payloadToggle.textContent = state.comparison.detailMode === "filePatch" ? "Show stat" : "Show file patch";
  payloadToggle.addEventListener("click", () => {
    const nextPayload: DiffDetailMode = state.comparison.detailMode === "filePatch" ? "statOnly" : "filePatch";
    if (requestMode === "compareDiff") {
      if (annotationKey === "compareDiff") requestCompareDiff({ payloadKind: nextPayload, currentCommitOid: state.review.currentCommitOid ?? null });
      else {
        const summary = projections.get(annotationKey)?.summary;
        if (summary) requestDiffReviewState(annotationKey, summary, { payloadKind: nextPayload, currentCommitOid: state.review.currentCommitOid ?? null });
      }
    } else {
      requestSessionChangesRefresh(annotationKey, { payloadKind: nextPayload });
    }
  });
  toolbar.append(payloadToggle);
  if (requestMode === "compareDiff") {
  const firstCommit = state.review.commits[0]?.oid ?? null;
  const stepBtn = mkEl("button");
  stepBtn.type = "button";
  stepBtn.textContent = state.review.currentCommitOid ? "Show range" : "Step commits";
  stepBtn.disabled = state.review.commits.length === 0;
  stepBtn.addEventListener("click", () => {
    const selected = state.review.currentCommitOid ? null : firstCommit;
    if (requestMode === "compareDiff") {
      if (annotationKey === "compareDiff") requestCompareDiff({ currentCommitOid: selected });
      else {
        const summary = projections.get(annotationKey)?.summary;
        if (summary) requestDiffReviewState(annotationKey, summary, { currentCommitOid: selected });
      }
    }
  });
  toolbar.append(stepBtn);
  if (state.review.commits.length > 0) {
    const commitSelect = mkEl("select");
    commitSelect.className = "diff-commit-select";
    const rangeOption = mkEl("option");
    rangeOption.value = "";
    rangeOption.textContent = "Full range";
    rangeOption.selected = !state.review.currentCommitOid;
    commitSelect.append(rangeOption);
    for (const commit of state.review.commits) {
      const option = mkEl("option");
      option.value = commit.oid;
      option.textContent = `${commit.shortOid} — ${commit.subject}`;
      option.selected = state.review.currentCommitOid === commit.oid;
      commitSelect.append(option);
    }
    commitSelect.addEventListener("change", () => {
      const selected = commitSelect.value || null;
      if (requestMode === "compareDiff") {
        if (annotationKey === "compareDiff") requestCompareDiff({ currentCommitOid: selected });
        else {
          const summary = projections.get(annotationKey)?.summary;
          if (summary) requestDiffReviewState(annotationKey, summary, { currentCommitOid: selected });
        }
      }
    });
    toolbar.append(commitSelect);
  }
  const index = state.review.currentCommitIndex ?? null;
  const prev = mkEl("button");
  prev.type = "button";
  prev.textContent = "Previous commit";
  prev.disabled = index === null || index <= 0;
  prev.addEventListener("click", () => {
    if (index === null) return;
    const oid = state.review.commits[index - 1]?.oid ?? null;
    if (requestMode === "compareDiff") {
      if (annotationKey === "compareDiff") requestCompareDiff({ currentCommitOid: oid });
      else {
        const summary = projections.get(annotationKey)?.summary;
        if (summary) requestDiffReviewState(annotationKey, summary, { currentCommitOid: oid });
      }
    }
  });
  const next = mkEl("button");
  next.type = "button";
  next.textContent = "Next commit";
  next.disabled = index === null || index >= state.review.commits.length - 1;
  next.addEventListener("click", () => {
    if (index === null) return;
    const oid = state.review.commits[index + 1]?.oid ?? null;
    if (requestMode === "compareDiff") {
      if (annotationKey === "compareDiff") requestCompareDiff({ currentCommitOid: oid });
      else {
        const summary = projections.get(annotationKey)?.summary;
        if (summary) requestDiffReviewState(annotationKey, summary, { currentCommitOid: oid });
      }
    }
  });
  toolbar.append(prev, next);
  }
  if (selectedFilePath) {
    const code = mkEl("button");
    code.type = "button";
    const committed = committedFileTarget(state, selectedFilePath);
    code.textContent = committed ? "View committed file" : "Code";
    code.disabled = !committed && (checkoutTargetForDiffFile(state)?.kind !== "workingTree" || state.summary.files.find(file => file.newPath === selectedFilePath)?.status === "deleted");
    code.title = committed ? `Read ${committed.path} at ${committed.commitOid.slice(0, 12)} without a checkout` : code.disabled ? "This version exists only in the diff, not as a working-tree file." : `Open ${selectedFilePath} in Code`;
    code.addEventListener("click", () => openDiffFileInCode(state, selectedFilePath, code.ownerDocument));
    toolbar.append(code);
  }
  if (allowPromptActions) {
    const promptMode: DiffAnnotationPromptMode = state.review.currentCommitOid ? "comparisonReview" : requestMode === "sessionChanges" || annotationKey !== "compareDiff" ? "sessionChanges" : "comparisonReview";
    const queuedDraftComments = selectedDiffAnnotations(annotations, key, "comment");
    const queuedPersistedComments = flushableReviewCommentAnnotations(comments, key);
    const queuedComments = [...queuedDraftComments, ...queuedPersistedComments];
    const queuedQuestions = selectedDiffAnnotations(annotations, key, "question");
    if (queuedComments.length > 0) {
      const flushComments = mkEl("button");
      flushComments.type = "button";
      flushComments.textContent = `Preview comments (${queuedComments.length})`;
      flushComments.addEventListener("click", () => previewDiffAnnotationList(annotationKey, state, queuedComments, promptMode));
      toolbar.append(flushComments);
    }
    const flushQuestions = mkEl("button");
    flushQuestions.type = "button";
    flushQuestions.textContent = `Preview questions (${queuedQuestions.length})`;
    flushQuestions.disabled = queuedQuestions.length === 0;
    flushQuestions.addEventListener("click", () => flushDiffAnnotations(annotationKey, state, "question", promptMode));
    toolbar.append(flushQuestions);
    const review = mkEl("button");
    review.type = "button";
    review.textContent = "Request agent review";
    review.disabled = state.summary.files.length === 0;
    review.title = state.summary.files.length > 0 ? "Ask the agent to review the full diff" : "No changed files to review";
    review.addEventListener("click", () => {
      if (state.summary.files.length === 0) return;
      previewAgentDiffReview(annotationKey, { ...state, patch: null });
    });
    toolbar.append(review);
  }
  detailToolbar.append(toolbar);
  main.append(detailToolbar);

  const body = mkEl("div");
  body.className = "diffs-main-body";
  const totals = mkEl("p");
  totals.className = "git-diff-totals";
  totals.textContent = `${state.summary.files.length} changed file${state.summary.files.length === 1 ? "" : "s"} · +${state.summary.files.reduce((sum, file) => sum + file.added, 0)} −${state.summary.files.reduce((sum, file) => sum + file.removed, 0)}`;
  detailToolbar.insertBefore(totals, toolbar);
  const filePatchError = selectedDiffFilePatchError(annotationKey, selectedFilePath);
  let renderedRows: DiffRow[] = [];
  const activePatch = selectedFilePath ? cachedPatch : aggregatePatch;
  const showTruncationWarning = Boolean(activePatch?.truncated);
  if (showTruncationWarning) {
    const warning = mkEl("p");
    warning.className = "diffs-warning";
    warning.textContent = "Diff output is truncated by Fura's safety limit.";
    body.append(warning);
  }
  if (state.comparison.detailMode !== "filePatch") {
    const note = mkEl("p");
    note.className = "diffs-stat-note";
    note.textContent = "Stat-only payload: select File patch for line comments, questions, and Code actions.";
    const pre = mkEl("pre");
    pre.className = "diff-stat-output";
    pre.textContent = state.summary.stat ?? "";
    body.append(note, pre);
  } else if (!selectedFilePath) {
    if (!aggregatePatch) {
      if (!filePatchError) requestDiffContent(annotationKey, state, null, requestMode);
      const loading = mkEl("p");
      loading.className = `empty diffs-empty ${filePatchError ? "diffs-error" : ""}`;
      loading.textContent = filePatchError
        ? `Failed to load diff patch: ${filePatchError}`
        : "Loading diff patch…";
      body.append(loading);
    } else {
      renderedRows = aggregatePatch.rows;
      const reviewState = { ...state, patch: aggregatePatch.patch, patchRows: aggregatePatch.rows, patchContextLines: aggregatePatch.contextLines };
      if (renderedRows.length === 0) {
        const empty = mkEl("p");
        empty.className = "empty diffs-empty";
        empty.textContent = "No changes for this comparison.";
        body.append(empty);
      } else {
        renderDiffRows(body, annotationKey, reviewState, renderedRows, annotations, comments, key, allowPromptActions, requestMode);
      }
    }
  } else if (!cachedPatch) {
    if (!filePatchError) requestDiffContent(annotationKey, state, selectedFilePath, requestMode);
    const loading = mkEl("p");
    loading.className = `empty diffs-empty ${filePatchError ? "diffs-error" : ""}`;
    loading.textContent = filePatchError
      ? `Failed to load patch for ${selectedFilePath}: ${filePatchError}`
      : `Loading patch for ${selectedFilePath}…`;
    body.append(loading);
  } else {
    renderedRows = cachedPatch.rows;
    const reviewState = { ...state, patch: cachedPatch.patch, patchRows: cachedPatch.rows, patchContextLines: cachedPatch.contextLines };
    renderDiffRows(body, annotationKey, reviewState, renderedRows, annotations, comments, key, allowPromptActions, requestMode);
  }
  renderReviewCommentsSection(
    body,
    comments,
    renderedRows,
    key,
    selectedFilePath,
    new Set(state.summary.files.map(file => file.newPath)),
  );
  main.append(body);
}

function stateForDiffFileFilter(annotationKey: string): DiffReviewableState | null {
  if (annotationKey === "compareDiff") return compareDiffState;
  const projection = projections.get(annotationKey);
  if (projection?.summary.sessionMode === "diffReview") {
    const request = diffReviewRequestForSummary(projection.summary);
    return request && compareDiffState && compareStateMatchesDiffReview(request) ? compareDiffState : null;
  }
  const state = sessionChangesStates.get(annotationKey);
  return state?.status === "ready" ? state : null;
}

function diffRequestModeForAnnotationKey(annotationKey: string): "sessionChanges" | "compareDiff" {
  if (annotationKey === "compareDiff") return "compareDiff";
  return projections.get(annotationKey)?.summary.sessionMode === "diffReview" ? "compareDiff" : "sessionChanges";
}

function updateDesktopModifiedFileSelection(root: HTMLElement, selectedFilePath: string | null): void {
  root.querySelector<HTMLButtonElement>(".diffs-all-files-jump")?.classList.toggle("active", selectedFilePath === null);
  for (const jump of root.querySelectorAll<HTMLButtonElement>(".diffs-file-jump[data-diff-file-path]")) {
    jump.classList.toggle("active", jump.dataset.diffFilePath === selectedFilePath);
  }
}

function rerenderSelectedDiffFileContent(annotationKey: string, root: HTMLElement | null): boolean {
  const state = stateForDiffFileFilter(annotationKey);
  const main = root?.querySelector<HTMLElement>(".diffs-main") ?? null;
  if (!root || !main || !state) return false;
  setRenderDocument(root.ownerDocument);
  const selectedFilePath = sessionChangesSelectedFiles.get(annotationKey) ?? null;
  updateDesktopModifiedFileSelection(root, selectedFilePath);
  const preservedHeader = main.querySelector<HTMLElement>(".diffs-toolbar, .git-commit-navigation");
  const openCommitKey = main.querySelector<HTMLElement>(".diff-commit-message[open]")?.dataset.comparisonKey;
  const restoreReviewFocus = main.contains(root.ownerDocument.activeElement)
    && !root.ownerDocument.activeElement?.closest("input, textarea, select, [contenteditable]");
  main.replaceChildren(...(preservedHeader ? [preservedHeader] : []));
  renderReviewableDiffMainContent(
    annotationKey,
    state,
    main,
    annotationKey !== "compareDiff",
    diffRequestModeForAnnotationKey(annotationKey),
  );
  const commit = main.querySelector<HTMLDetailsElement>(".diff-commit-message");
  if (commit && openCommitKey === commit.dataset.comparisonKey) commit.open = true;
  if (restoreReviewFocus) root.focus({ preventScroll: true });
  if (annotationKey === "compareDiff") comparePanelDirty = false;
  else diffPanelDirty = false;
  return true;
}

function rerenderSelectedDiffFileContentIfActive(annotationKey: string): boolean {
  let rendered = false;
  if (annotationKey === "compareDiff") {
    if (!desktopDockview?.isPanelActive("compare")) return false;
    desktopDockview.withPanel("compare", container => {
      rendered = rerenderSelectedDiffFileContent(annotationKey, container.querySelector<HTMLElement>(".compare-view"));
    });
    return rendered;
  }
  const dockview = desktopDockview;
  const panelId = dockview?.isPanelActive("sessionChanges")
    ? "sessionChanges"
    : dockview?.isPanelActive("diffs") ? "diffs" : null;
  if (!dockview || !panelId) return false;
  dockview.withPanel(panelId, container => {
    rendered = rerenderSelectedDiffFileContent(annotationKey, container.querySelector<HTMLElement>(".diffs-view"));
  });
  return rendered;
}

function rerenderDesktopModifiedFilesOnly(annotationKey: string, sidebarTop: HTMLElement): boolean {
  const root = sidebarTop.closest<HTMLElement>(".diffs-view");
  const sidebar = root?.querySelector<HTMLElement>(".diffs-sidebar-scroll");
  const state = stateForDiffFileFilter(annotationKey);
  if (!root || !sidebar || !state) return false;
  const key = comparisonKey(state);
  const annotations = diffAnnotations.get(annotationKey) ?? [];
  const comments = reviewCommentsForComparison(reviewComments.get(annotationKey) ?? [], key);
  const fileSummaries = summarizeWireDiffFiles(state.summary.files, [...annotations, ...comments.map(reviewCommentAsAnnotation)], key);
  const selectedFilePath = selectedDiffFilePath(annotationKey, state, fileSummaries.map(file => file.filePath));
  sidebar.replaceChildren();
  renderDesktopModifiedFiles(sidebar, state, fileSummaries, selectedFilePath, annotationKey);
  return true;
}

function renderDiffFileFilter(sidebarTop: HTMLElement, annotationKey: string): void {
  const section = mkEl("section");
  section.className = "diffs-file-filter";
  const label = mkEl("label");
  label.className = "diffs-repo-label";
  label.textContent = "Filter files";
  const input = mkEl("input");
  input.className = "diff-filter-input";
  input.type = "search";
  input.placeholder = "Search modified files";
  input.value = diffFileFilters.get(annotationKey) ?? "";
  input.addEventListener("input", () => {
    const nextValue = input.value;
    if (nextValue) diffFileFilters.set(annotationKey, nextValue);
    else diffFileFilters.delete(annotationKey);
    if (!rerenderDesktopModifiedFilesOnly(annotationKey, sidebarTop)) {
      if (annotationKey === "compareDiff") rerenderComparePanelPreservingScroll();
      else rerenderDiffsViewPreservingScroll(annotationKey);
    }
  });
  section.append(label, input);
  sidebarTop.append(section);
}

function renderDesktopModifiedFiles(
  sidebar: HTMLElement,
  state: DiffReviewableState,
  files: ReturnType<typeof summarizeWireDiffFiles>,
  selectedFilePath: string | null,
  annotationKey: string,
): void {
  const filterValue = (diffFileFilters.get(annotationKey) ?? "").trim().toLowerCase();
  const visibleFiles = filterValue
    ? files.filter(file =>
        file.filePath.toLowerCase().includes(filterValue) ||
        file.oldPath?.toLowerCase().includes(filterValue),
      )
    : files;
  const filesSection = mkEl("section");
  filesSection.className = "diffs-files";
  const filesTitle = mkEl("strong");
  filesTitle.textContent = `Modified files (${files.length})`;
  filesSection.append(filesTitle);
  const allFiles = mkEl("button");
  allFiles.type = "button";
  allFiles.className = `diffs-file-jump diffs-all-files-jump${selectedFilePath === null ? " active" : ""}`;
  allFiles.title = "Show all changed files in one patch.";
  const allName = mkEl("code");
  allName.textContent = "All files";
  const allMeta = mkEl("span");
  allMeta.textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
  allFiles.append(allName, allMeta);
  allFiles.addEventListener("click", () => {
    openDiffFileMenu = null;
    sessionChangesSelectedFiles.delete(annotationKey);
    const root = allFiles.closest<HTMLElement>(".diffs-view, .compare-view");
    if (!rerenderSelectedDiffFileContent(annotationKey, root)) {
      markDiffsViewDirty();
      markComparePanelDirty();
      if (annotationKey === "compareDiff") renderComparePanelIfActive();
      else renderDiffsViewIfActive(annotationKey);
    }
  });
  filesSection.append(allFiles);
  if (visibleFiles.length === 0) {
    const empty = mkEl("p");
    empty.className = "diffs-filter-empty";
    empty.textContent = filterValue ? "No files match the current filter." : "No modified files.";
    filesSection.append(empty);
    sidebar.append(filesSection);
    return;
  }
  const filesList = mkEl("div");
  filesList.className = "diffs-file-list";
  for (const file of visibleFiles) {
    const item = mkEl("div");
    item.className = "diffs-file-item";
    const name = mkEl("code");
    name.textContent = file.filePath;
    const meta = mkEl("span");
    const notes = [
      file.commentCount > 0 ? `${file.commentCount} comment${file.commentCount === 1 ? "" : "s"}` : null,
      file.questionCount > 0 ? `${file.questionCount} question${file.questionCount === 1 ? "" : "s"}` : null,
    ].filter(Boolean).join(" · ");
    meta.textContent = `${file.status} · +${file.added} -${file.removed}${notes ? ` · ${notes}` : ""}`;
    const jump = mkEl("button");
    jump.type = "button";
    jump.className = `diffs-file-jump${file.filePath === selectedFilePath ? " active" : ""}`;
    jump.title = "Click to select. Right-click for file actions.";
    jump.dataset.diffFilePath = file.filePath;
    jump.setAttribute("aria-haspopup", "true");
    jump.append(name, meta);
    jump.addEventListener("click", () => {
      openDiffFileMenu = null;
      sessionChangesSelectedFiles.set(annotationKey, file.filePath);
      const root = jump.closest<HTMLElement>(".diffs-view, .compare-view");
      if (!rerenderSelectedDiffFileContent(annotationKey, root)) {
        markDiffsViewDirty();
        markComparePanelDirty();
        if (annotationKey === "compareDiff") renderComparePanelIfActive();
        else renderDiffsViewIfActive(annotationKey);
      }
    });
    jump.addEventListener("contextmenu", event => {
      event.preventDefault();
      sessionChangesSelectedFiles.set(annotationKey, file.filePath);
      openDiffFileMenu = { annotationKey, filePath: file.filePath };
      markDiffsViewDirty();
      markComparePanelDirty();
      if (annotationKey === "compareDiff") renderComparePanelIfActive();
      else renderDiffsViewIfActive(annotationKey);
    });
    jump.addEventListener("keydown", event => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const owner = jump.ownerDocument;
      jump.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      owner.querySelector<HTMLButtonElement>(".diffs-file-menu button")?.focus();
    });
    item.append(jump);
    if (openDiffFileMenu?.annotationKey === annotationKey && openDiffFileMenu.filePath === file.filePath) {
      const menu = mkEl("div");
      menu.className = "diffs-file-menu";
      const openInCode = mkEl("button");
      openInCode.type = "button";
      openInCode.className = "diffs-file-menu-item";
      const committed = committedFileTarget(state, file.filePath);
      openInCode.textContent = committed ? "View committed file" : "Open in Code";
      openInCode.disabled = !committed && (checkoutTargetForDiffFile(state)?.kind !== "workingTree" || file.status === "deleted");
      openInCode.addEventListener("click", event => {
        event.stopPropagation();
        openDiffFileMenu = null;
        openDiffFileInCode(state, file.filePath, openInCode.ownerDocument);
      });
      menu.append(openInCode);
      if (committed) {
        const revision = mkEl("button");
        revision.type = "button";
        revision.className = "diffs-file-menu-item";
        revision.textContent = "View this revision in Code";
        revision.title = `Read ${committed.path} at ${committed.commitOid.slice(0, 12)} in Fura's Code panel`;
        revision.addEventListener("click", event => {
          event.stopPropagation();
          openDiffFileMenu = null;
          menu.remove();
          openDiffRevisionInCode(state, file.filePath, annotationKey);
        });
        menu.append(revision);
      }
      menu.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        openDiffFileMenu = null;
        menu.remove();
        jump.focus();
      });
      item.append(menu);
    }
    filesList.append(item);
  }
  filesSection.append(filesList);
  sidebar.append(filesSection);
}

function renderReviewCommentsSection(
  container: HTMLElement,
  comments: ReviewComment[],
  rows: DiffRow[],
  key: string,
  selectedFilePath: string | null,
  currentFilePaths: Set<string>,
): void {
  const section = mkEl("section");
  section.className = "diff-review-comments-section";
  const header = mkEl("div");
  header.className = "diff-review-comments-header";
  const title = mkEl("h3");
  title.textContent = "Review comments";
  const count = mkEl("span");
  count.className = "diff-review-comments-count";
  count.textContent = String(comments.length);
  header.append(title, count);
  section.append(header);
  if (comments.length === 0) {
    const empty = mkEl("p");
    empty.className = "empty";
    empty.textContent = "No persisted review comments for this comparison.";
    section.append(empty);
    container.append(section);
    return;
  }
  const list = mkEl("div");
  list.className = "diff-review-comments-list";
  for (const comment of comments) {
    const missingFromCurrentDiff = !currentFilePaths.has(comment.anchor.newPath);
    const selectedFileMismatch = selectedFilePath !== null && selectedFilePath !== comment.anchor.newPath;
    const stale = comment.stale
      || missingFromCurrentDiff
      || (!selectedFileMismatch && rows.length > 0 && !isReviewCommentMatched(rows, key, comment));
    list.append(renderReviewCommentItem(comment, stale, {
      locationLabel: formatReviewCommentLocation(comment),
      summary: true,
    }));
  }
  section.append(list);
  container.append(section);
}


function renderDiffRows(container: HTMLElement, annotationKey: string, state: DiffReviewableState, rows: DiffRow[], annotations: DiffReviewAnnotation[], comments: ReviewComment[], key: string, allowPromptActions: boolean, requestMode: "sessionChanges" | "compareDiff"): void {
  const diff = mkEl("div");
  diff.className = "diff-lines";
  const fragment = diff.ownerDocument.createDocumentFragment();
  const highlighter = createGitDiffHighlighter(rows, diff.ownerDocument);
  for (let index = 0; index < rows.length; index++) {
    appendDiffRow(fragment, rows[index], annotationKey, state, annotations, comments, key, allowPromptActions, requestMode, highlighter, index);
  }
  diff.append(fragment);
  container.append(diff);
}

function appendDiffRow(diff: HTMLElement | DocumentFragment, row: DiffRow, annotationKey: string, state: DiffReviewableState, annotations: DiffReviewAnnotation[], comments: ReviewComment[], key: string, allowPromptActions: boolean, requestMode: "sessionChanges" | "compareDiff", highlighter: DiffHighlighter, index: number): void {
  if (row.type === "line") {
    const lineComments = reviewCommentsForDiffLocation(comments, key, row.location);
    const lineQuestions = annotationsForDiffLocation(annotations, key, row.location).filter(annotation => annotation.kind === "question");
    const lineWrap = mkEl("div");
    lineWrap.className = "diff-line-wrap";
    const line = mkEl("div");
    line.className = `diff-line diff-line-${row.location.kind}`;
    const commentBtn = mkEl("button");
    commentBtn.type = "button";
    commentBtn.className = `diff-comment-btn ${lineComments.length > 0 ? "has-comments" : ""}`;
    commentBtn.textContent = lineComments.length > 0 ? String(lineComments.length) : "+";
    commentBtn.disabled = !allowPromptActions;
    commentBtn.title = allowPromptActions ? "Comment on this diff line" : "Comments require a session changes review";
    commentBtn.addEventListener("click", () => startDiffCommentComposer(annotationKey, state, row.location));
    const gutter = mkEl("span");
    gutter.className = "diff-gutter";
    gutter.textContent = String(row.location.newLine ?? row.location.oldLine ?? "");
    const content = mkEl("div");
    content.className = "diff-line-content";
    const text = mkEl("code");
    highlighter.renderLine(index, text);
    content.append(text);
    const questionBtn = mkEl("button");
    questionBtn.type = "button";
    questionBtn.className = `diff-question-btn ${lineQuestions.length > 0 ? "has-questions" : ""}`;
    questionBtn.textContent = lineQuestions.length > 0 ? String(lineQuestions.length) : "?";
    questionBtn.disabled = !allowPromptActions;
    questionBtn.title = allowPromptActions ? "Ask the agent about this diff line" : "Questions require a session changes review";
    questionBtn.addEventListener("click", () => askDiffQuestion(annotationKey, state, row.location));
    line.append(commentBtn, gutter, content, questionBtn);
    lineWrap.append(line);
    const showComposer = isReviewCommentCreateComposer(annotationKey, key, row.location);
    if (lineComments.length > 0 || lineQuestions.length > 0 || showComposer) {
      const thread = mkEl("div");
      thread.className = "diff-inline-comments";
      for (const comment of lineComments) thread.append(renderReviewCommentItem(comment, false));
      for (const annotation of lineQuestions) thread.append(renderDiffAnnotationItem(annotationKey, annotation));
      if (showComposer && activeReviewCommentComposer?.mode === "create") {
        thread.append(renderReviewCommentComposer({
          mode: "create",
          initialBody: activeReviewCommentComposer.body,
          title: "Add review comment",
          submitLabel: "Comment",
          onInput: body => {
            if (isReviewCommentCreateComposer(annotationKey, key, row.location) && activeReviewCommentComposer?.mode === "create") {
              activeReviewCommentComposer.body = body;
            }
          },
          onSubmit: body => submitDiffComment(annotationKey, state, row.location, body),
          onCancel: () => closeReviewCommentComposer(annotationKey),
        }));
      }
      lineWrap.append(thread);
    }
    diff.append(lineWrap);
    return;
  }
  const line = mkEl("div");
  line.className = `diff-line diff-line-${row.type}`;
  if (row.type === "file") line.dataset.diffFilePath = row.filePath;
  const spacer = mkEl("span");
  spacer.className = "diff-comment-spacer";
  const text = mkEl("code");
  text.textContent = row.text;
  if (row.type === "hunk") {
    const more = mkEl("button");
    more.type = "button";
    more.className = "diff-context-more";
    more.textContent = "Show more context";
    more.title = "Reload the visible patch with 10 more lines of context (all files in All files view).";
    more.addEventListener("click", () => requestWiderDiffContext(annotationKey, state, row.filePath, requestMode));
    line.append(spacer, more, text);
  } else {
    line.append(spacer, text);
  }

  diff.append(line);
}

// --- Desktop workspace initialization ---

function initDesktopWorkspace(): void {
  const createDockviewCallbacks = () => ({
    onPanelReady: (id: Parameters<DesktopDockview["withPanel"]>[0]) => {
      if (id === "transcript") markTranscriptViewDirty();
      if (id === "goal") return;
      if (id === "tools") markToolsViewDirty();
      if (id === "diffs") markDiffsViewDirty();
      if (id === "sessionChanges") markDiffsViewDirty();
      if (id === "compare") markComparePanelDirty();
      if (id === "code") markCodeViewDirty();
    },
    onPanelActivated: (id: Parameters<DesktopDockview["withPanel"]>[0]) => {
      const projection = activeSessionId ? projections.get(activeSessionId) : undefined;
      if (id === "transcript") {
        renderTranscriptPanelIfNeeded(projection, true);
        return;
      }
      if (id === "goal") {
        desktopDockview?.withPanel("goal", container => renderGoalModePanel(container, projection));
        return;
      }
      if (id === "tools") {
        renderToolsPanelIfNeeded(projection, true);
        return;
      }
      if (id === "code") {
        ensureActiveCodeWorkspace();
        renderCodePanelIfNeeded(true);
        return;
      }
      if (id === "diffs" || id === "sessionChanges") {
        desktopDockview?.withPanel(id, container => renderDiffsView(container, projection));
        requestActiveDiffState({ refreshExisting: true });
      }
      if (id === "compare") {
        normalDesktopDockview?.withPanel("compare", container => renderComparePanel(container));
      }
    },
    onPanelClosed: (id: Parameters<DesktopDockview["withPanel"]>[0]) => {
      if (id === "sessionChanges") {
        markDiffsViewDirty();
        if (activeSessionUsesDiffReviewWorkspace()) {
          desktopDockview?.ensureSessionChangesPanel();
          desktopDockview?.activatePanel("sessionChanges");
          renderDiffsViewIfActive(activeSessionId ?? "");
        }
        return;
      }
      if (id === "diffs") {
        markDiffsViewDirty();
        return;
      }
      clearCurrentCompareDiff("closed");
      invalidateRangeDiff();
      markComparePanelDirty();
      renderComparePanelIfActive();
    },
    onPopoutBlocked: () => {
      const sid = activeSessionId;
      if (!sid) return;
      appendSessionNotice(sid, {
        level: "warning",
        text: "Popup window was blocked. Allow popups for this site to use the pop-out feature.",
      });
      render();
    },
  });

  normalDesktopDockview = initDesktopDockview({
    host: requireElement<HTMLDivElement>("normalWorkspacePanelHost"),
    layoutMode: "normal",
    storageKey: "fura.dockview.layout",
    ...createDockviewCallbacks(),
  });
  diffReviewDesktopDockview = initDesktopDockview({
    host: requireElement<HTMLDivElement>("diffReviewWorkspacePanelHost"),
    layoutMode: "diffReview",
    storageKey: "fura.dockview.diffReview.layout",
    ...createDockviewCallbacks(),
  });
  syncSessionModePanels();
  renderActiveDockviewPanel(activeSessionId ? projections.get(activeSessionId) : undefined);
  if (isSessionChangesPanelActive()) requestActiveDiffState({ refreshExisting: true });
}

// --- Status bar ---

function renderControllerStatusBar(): void {
  statusBar.replaceChildren();
  statusBar.classList.toggle("busy", controlStatusState.status === "working");
  const piSpan = statusPart("π", "status-pi");
  if (controlStatusState.status === "working") piSpan.classList.add("is-running");
  const parts = [
    piSpan,
    statusPart("Ask Fura", "model"),
    statusPart(controlStatusState.message || controlStatusState.status, controlStatusState.status === "error" ? "error" : "thinking"),
  ];
  statusBar.append(...interleaveStatusParts(parts));
}

function renderStatusBar(projection?: SessionProjection): void {
  statusBar.replaceChildren();
  statusBar.classList.toggle("busy", Boolean(projection?.isBusy));

  const parts: HTMLElement[] = [];
  const piSpan = statusPart("π", "status-pi");
  if (projection?.isBusy) piSpan.classList.add("is-running");
  parts.push(piSpan);
  if (projection?.compacting) {
    parts.push(statusPart("⟳ Compacting context…", "compacting"));
  }

  if (!projection) {
    parts.push(statusPart("No session", "muted"));
    statusBar.append(...interleaveStatusParts(parts));
    return;
  }

  const cwd = projection.summary.cwd ?? "current cwd";
  parts.push(statusPart(projection.model ?? "model unknown", "model"));
  parts.push(statusPart(projection.thinkingLevel ?? "thinking inherit", "thinking"));
  if (projection.planMode?.enabled) parts.push(statusPart("Plan", "mode"));
  if (projection.goalMode?.goal) parts.push(statusPart(goalModeBadgeLabel(projection.goalMode) ?? "Goal", "mode"));
  parts.push(statusPart(`📁 ${shortPath(cwd)}`, "cwd"));
  parts.push(statusPart(formatTokens(projection.tokensTotal), "tokens"));
  parts.push(statusPart(formatCost(projection.costUsd), "cost"));
  const contextUsage = formatContextUsage(projection.contextTokens, projection.contextPercent, projection.contextWindow);
  if (contextUsage != null) {
    parts.push(statusPart(contextUsage, "context"));
  }
  if (projection.isBusy) {
    parts.push(statusInterruptButton());
  }

  statusBar.append(...interleaveStatusParts(parts));
}

function interleaveStatusParts(parts: HTMLElement[]): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) nodes.push(statusPart("›", "separator"));
    nodes.push(parts[i]);
  }
  return nodes;
}

function statusPart(text: string, className: string): HTMLElement {
  const span = document.createElement("span");
  span.className = `status-part ${className}`;
  span.textContent = text;
  return span;
}

function statusInterruptButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "status-part interrupt";
  button.textContent = "esc to interrupt";
  button.addEventListener("click", () => {
    if (activeSessionId) send({ type: "prompt.abort", sessionId: activeSessionId });
  });
  return button;
}



// --- Message rendering ---

function renderMessage(message: TranscriptMessage, sessionId = activeSessionId): HTMLElement {
  return renderTranscriptMessage(message, {
    thinkingVisibilityMode,
    review: sessionId ? transcriptReviewOptions(sessionId, message) : undefined,
  });
}



// --- Image attachments ---


function insertTextAtCursor(text: string): void {
  resetPromptHistoryNavigation();
  const insertion = insertTextAtSelection(
    promptInput.value,
    promptInput.selectionStart ?? promptInput.value.length,
    promptInput.selectionEnd ?? promptInput.value.length,
    text,
  );
  promptInput.value = insertion.value;
  promptInput.selectionStart = insertion.cursor;
  promptInput.selectionEnd = insertion.cursor;
  saveComposerDraft();
}

function createPendingMarker(label: "Image" | "Snippet"): string {
  return createAttachmentMarker(label, nextPendingAttachmentId++);
}

function removePendingMarker(marker: string): void {
  const nextValue = removePendingMarkerFromText(promptInput.value, marker);
  if (nextValue === promptInput.value) return;

  resetPromptHistoryNavigation();
  promptInput.value = nextValue;
  updatePalette();
}

function expandSnippetTokens(text: string): string {
  return expandSnippetAttachmentTokens(text, pendingSnippets);
}

function renderImagePreviews(): void {
  saveComposerDraft();
  renderAttachmentPreviews(imagePreviews, pendingImages, pendingSnippets, {
    onRemoveImage: (index, image) => {
      pendingImages.splice(index, 1);
      removePendingMarker(image.marker);
      renderImagePreviews();
    },
    onRemoveSnippet: (index, snippet) => {
      pendingSnippets.splice(index, 1);
      removePendingMarker(snippet.marker);
      renderImagePreviews();
    },
  });
}

// --- Model picker ---

function isModelPickerCommand(text: string): boolean {
  return /^\/models?(?:\s+(?:list|ls))?\s*$/i.test(text.trim());
}

function requireServerConfig(): ServerConfig | null {
  if (serverConfig) return serverConfig;
  appendLog("Cannot create a session before the bridge sends config; reconnect and try again.");
  return null;
}

function setCwdPickerStatus(message: string | null, state: "idle" | "loading" | "error" = "idle"): void {
  cwdPickerStatus.textContent = message ?? "";
  cwdPickerStatus.classList.toggle("loading", state === "loading");
  cwdPickerStatus.classList.toggle("error", state === "error");
}

function setCwdPickerError(message: string | null): void {
  setCwdPickerStatus(message, message ? "error" : "idle");
}

function setCwdPickerCreatePending(pending: boolean, requestId: string | null = null): void {
  cwdPickerCreatePending = pending;
  cwdPickerPendingRequestId = pending ? requestId : null;
  cwdPickerSessionTab.disabled = pending;
  cwdPickerDiffTab.disabled = pending;
  cwdPickerNameInput.disabled = pending;
  cwdPickerInput.disabled = pending;
  cwdPickerWorktreeEnabled.disabled = pending;
  cwdPickerWorktreeSourceRepo.disabled = pending;
  cwdPickerWorktreeBase.disabled = pending;
  cwdPickerWorktreeBranch.disabled = pending;
  cwdPickerProposedModel.disabled = pending;
  cwdPickerDiffRepo.disabled = pending;
  cwdPickerDiffBase.disabled = pending;
  cwdPickerDiffOld.disabled = pending;
  cwdPickerDiffHead.disabled = pending;
  cwdPickerDiffMode.disabled = pending;
  cwdPickerDiffAgentSession.disabled = pending;
  cwdPickerClose.disabled = pending;
  cwdPickerCancel.disabled = pending;
  cwdPickerCreate.disabled = pending;
  const actionLabel = cwdPickerMode === "diff" ? "Open diff" : "Create session";
  cwdPickerCreate.textContent = pending ? (cwdPickerMode === "diff" ? "Opening…" : "Creating…") : actionLabel;
  cwdPickerCreate.toggleAttribute("aria-busy", pending);
  if (pending) {
    const status = cwdPickerMode === "diff" ? "Opening diff…" : "Creating session…";
    setCwdPickerStatus(status, "loading");
  }
}

function nextClientRequestId(prefix: string): string {
  return `${prefix}-${randomUuid()}`;
}

function handleCwdPickerCreateError(requestId: string | null, message: string): boolean {
  if (!cwdPickerCreatePending || !cwdPickerPendingRequestId || requestId !== cwdPickerPendingRequestId) {
    return false;
  }
  pendingCreatedSessionBaseline = null;
  pendingDiffCreate = null;
  setCwdPickerCreatePending(false);
  setCwdPickerError(message);
  cwdPickerOverlay.hidden = false;
  window.setTimeout(() => cwdPickerCreate.focus(), 0);
  return true;
}

function applyCwdPickerAutofill(): void {
  if (!cwdPickerWorktreeEnabled.checked) {
    cwdPickerWorktreeSummary.textContent = "";
    return;
  }
  const view = deriveWorktreeCreateView({
    enabled: true,
    defaultCwd: serverConfig?.defaultCwd,
    normalCwd: cwdPickerWorktreeSourceRepo.value || serverConfig?.defaultCwd,
    sessionName: cwdPickerNameInput.value,
    sourceRepo: cwdPickerWorktreeSourceRepo.value,
    directory: cwdPickerInput.value,
    baseBranch: cwdPickerWorktreeBase.value,
    branchName: cwdPickerWorktreeBranch.value,
    sourceRepoAutofill: cwdPickerSourceRepoAutofill,
    directoryAutofill: cwdPickerDirectoryAutofill,
    baseBranchAutofill: cwdPickerBaseBranchAutofill,
    branchAutofill: cwdPickerBranchAutofill,
  });
  cwdPickerWorktreeSourceRepo.value = view.sourceRepo;
  lastAutofilledWorktreeDirectory = view.lastAutofilledDirectory;
  if (cwdPickerDirectoryAutofill) cwdPickerInput.value = view.directory;
  if (cwdPickerBaseBranchAutofill) cwdPickerWorktreeBase.value = view.baseBranch;
  lastAutofilledWorktreeBranch = view.lastAutofilledBranch;
  if (cwdPickerBranchAutofill) cwdPickerWorktreeBranch.value = view.branchName;
  cwdPickerWorktreeSummary.textContent = view.summary;
}

function syncCwdPickerWorktreeFields(): void {
  const enabled = cwdPickerWorktreeEnabled.checked;
  cwdPickerWorktreeFields.hidden = !enabled;
  if (enabled) {
    cwdPickerInputLabel.textContent = "Working directory (new worktree path)";
    cwdPickerInput.placeholder = "/home/user/worktrees/project-feature";
    cwdPickerInputHelp.textContent = "This is the new worktree path where OMP will start.";
    const currentWorkingDirectory = cwdPickerInput.value.trim();
    const currentSourceRepo = cwdPickerWorktreeSourceRepo.value.trim();
    if (!currentSourceRepo || currentSourceRepo === serverConfig?.defaultCwd) {
      cwdPickerWorktreeSourceRepo.value = currentWorkingDirectory || serverConfig?.defaultCwd || "";
      cwdPickerSourceRepoAutofill = true;
    }
    cwdPickerDirectoryAutofill = true;
    cwdPickerBranchAutofill = true;
    cwdPickerBaseBranchAutofill = !cwdPickerWorktreeBase.value.trim();
    applyCwdPickerAutofill();
  } else {
    cwdPickerInputLabel.textContent = "Working directory";
    cwdPickerInput.placeholder = "/home/user/project";
    cwdPickerInputHelp.textContent = "For a normal session, this is the directory where OMP starts.";
    if (!cwdPickerInput.value.trim() || cwdPickerInput.value === lastAutofilledWorktreeDirectory) {
      cwdPickerInput.value = cwdPickerWorktreeSourceRepo.value.trim() || serverConfig?.defaultCwd || "";
    }
    lastAutofilledWorktreeDirectory = "";
    lastAutofilledWorktreeBranch = "";
    cwdPickerWorktreeSummary.textContent = "";
  }
}

function setCwdPickerMode(mode: "session" | "diff"): void {
  cwdPickerMode = mode;
  const sessionMode = mode === "session";
  const diffMode = mode === "diff";
  cwdPickerSessionTab.classList.toggle("active", sessionMode);
  cwdPickerDiffTab.classList.toggle("active", diffMode);
  cwdPickerSessionTab.setAttribute("aria-selected", String(sessionMode));
  cwdPickerDiffTab.setAttribute("aria-selected", String(diffMode));
  cwdPickerSessionBody.hidden = !sessionMode;
  cwdPickerDiffBody.hidden = !diffMode;
  if (sessionMode) {
    cwdPickerTitle.textContent = "New session";
    cwdPickerDescription.textContent = "Choose the working directory for the new OMP session. Optionally create a git worktree first.";
  } else {
    cwdPickerTitle.textContent = "Diff";
    cwdPickerDescription.textContent = "Open a repository comparison directly or create a dedicated diff-review session.";
  }
  if (!cwdPickerCreatePending) {
    cwdPickerCreate.textContent = diffMode ? "Open diff" : "Create session";
  }
}

function syncCwdPickerDiffDefaults(): void {
  const defaultRoot = cwdPickerInput.value.trim() || serverConfig?.defaultCwd || "";
  cwdPickerDiffRepo.value = defaultRoot;
  cwdPickerDiffBase.value = "HEAD";
  cwdPickerDiffBase.required = false;
  cwdPickerDiffHead.value = "HEAD";
  cwdPickerDiffMode.value = "full";
  cwdPickerDiffAgentSession.checked = true;
  syncCwdPickerRangeDiffFields();
}


function openCwdPicker(initialMode: "session" | "diff" = "session"): void {
  const config = requireServerConfig();
  if (!config) return;
  pendingDiffCreate = null;
  cwdPickerNameInput.value = "";
  cwdPickerCategoryInput.value = "";
  hideCategoryCombobox(cwdCategoryCombobox);
  cwdPickerInput.value = config.defaultCwd;
  cwdPickerWorktreeEnabled.checked = false;
  cwdPickerWorktreeSourceRepo.value = config.defaultCwd;
  cwdPickerWorktreeBase.value = "HEAD";
  cwdPickerWorktreeBranch.value = "";
  cwdPickerSourceRepoAutofill = true;
  cwdPickerDirectoryAutofill = true;
  cwdPickerBranchAutofill = true;
  cwdPickerBaseBranchAutofill = true;
  lastAutofilledWorktreeDirectory = "";
  lastAutofilledWorktreeBranch = "";
  setCwdPickerCreatePending(false);
  setCwdPickerError(null);
  renderCwdProposedModelOptions();
  syncCwdPickerWorktreeFields();
  syncCwdPickerDiffDefaults();
  setCwdPickerMode(initialMode);
  cwdPickerOverlay.hidden = false;
  window.setTimeout(() => {
    const focusTarget = initialMode === "diff" ? cwdPickerDiffRepo : cwdPickerNameInput;
    focusTarget.focus();
    focusTarget.select();
  }, 0);
}

function closeCwdPicker(): void {
  if (cwdPickerCreatePending) return;
  cwdPickerOverlay.hidden = true;
  setCwdPickerError(null);
  hideCategoryCombobox(cwdCategoryCombobox);
  promptInput.focus();
}

function focusCwdPickerCreateTarget(target: SessionCreateValidationTarget): void {
  const focusTargets: Partial<Record<SessionCreateValidationTarget, HTMLElement>> = {
    name: cwdPickerNameInput,
    cwd: cwdPickerInput,
    worktreeDirectory: cwdPickerInput,
    worktreeSourceRepo: cwdPickerWorktreeSourceRepo,
    worktreeBaseBranch: cwdPickerWorktreeBase,
    worktreeBranchName: cwdPickerWorktreeBranch,
  };
  focusTargets[target]?.focus();
}

function syncCwdPickerRangeDiffFields(): void {
  const range = cwdPickerDiffMode.value === "rangeDiff";
  cwdPickerDiffOld.hidden = !range;
  requireElement<HTMLLabelElement>("cwdPickerDiffOldLabel").hidden = !range;
  document.querySelector<HTMLLabelElement>('label[for="cwdPickerDiffBase"]')!.textContent = range ? "Base" : "Base ref";
  document.querySelector<HTMLLabelElement>('label[for="cwdPickerDiffHead"]')!.textContent = range ? "New" : "Head ref";
  cwdPickerDiffAgentSession.parentElement!.hidden = range;
  requireElement<HTMLParagraphElement>("cwdPickerDiffAgentHelp").hidden = range;
}

function submitCwdPickerDiff(): void {
  if (cwdPickerCreatePending) return;
  const repoRoot = cwdPickerDiffRepo.value.trim();
  if (cwdPickerDiffMode.value === "rangeDiff") {
    const inputs = { repoRoot, base: cwdPickerDiffBase.value.trim(), old: cwdPickerDiffOld.value.trim(), new: cwdPickerDiffHead.value.trim() };
    if (Object.values(inputs).some(value => !value)) {
      setCwdPickerError("Repository, Base, Old and New are required for range-diff.");
      return;
    }
    closeCwdPicker();
    compareMode = "rangeDiff";
    if (activeSessionUsesDiffReviewWorkspace()) activateControllerWorkspace();
    normalDesktopDockview?.ensureComparePanel();
    normalDesktopDockview?.activatePanel("compare");
    requestRangeDiff({ ...inputs, ignoreWhitespace: false });
    return;
  }
  if (cwdPickerDiffBase.required && !cwdPickerDiffBase.value.trim()) {
    setCwdPickerError("This selected commit has no available parent. Choose an explicit Base ref for Advanced Compare.");
    cwdPickerDiffBase.focus();
    return;
  }
  const base = cwdPickerDiffBase.value.trim() || "HEAD";
  const head = cwdPickerDiffHead.value.trim() || "HEAD";
  const payloadKind: DiffDetailMode = cwdPickerDiffMode.value === "stat" ? "statOnly" : "filePatch";
  if (!repoRoot) {
    setCwdPickerError("Repository root is required for diff review.");
    cwdPickerDiffRepo.focus();
    return;
  }
  const diff = { repoRoot, base, head, payloadKind };
  if (!cwdPickerDiffAgentSession.checked) {
    closeCwdPicker();
    invalidateRangeDiff();
    compareMode = "files";
    compareRepoRoot = repoRoot;
    compareBaseRef = base;
    compareHeadRef = head;
    comparePayloadKind = payloadKind;
    normalDesktopDockview?.ensureComparePanel();
    normalDesktopDockview?.activatePanel("compare");
    requestCompareDiff({ repoRoot, base, head, payloadKind });
    return;
  }
  pendingDiffCreate = diff;
  const requestId = nextClientRequestId("diff-session-create");
  const result = resolveSessionCreateMessage({
    requestId,
    name: cwdPickerNameInput.value || `diff: ${repoRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? "repo"} ${base}..${head}`,
    cwd: repoRoot,
    category: normalizedCategory(cwdPickerCategoryInput.value),
    sessionMode: "diffReview",
    proposedModelId: cwdPickerProposedModel.value,
    worktree: { enabled: false, sourceRepo: repoRoot, directory: repoRoot, baseBranch: base, branchName: undefined },
  });
  if (result.type === "invalid") {
    pendingDiffCreate = null;
    setCwdPickerError(result.message);
    return;
  }
  pendingCreatedSessionBaseline = new Set(sessions.map(s => s.sessionId));
  setCwdPickerCreatePending(true, requestId);
  if (!send(result.message)) {
    pendingCreatedSessionBaseline = null;
    pendingDiffCreate = null;
    setCwdPickerCreatePending(false);
    setCwdPickerError("Not connected to the Fura bridge.");
  }
}


function submitCwdPicker(): void {
  if (cwdPickerCreatePending) return;
  if (!requireServerConfig()) return;
  const requestId = nextClientRequestId("session-create");
  if (cwdPickerMode === "diff") {
    submitCwdPickerDiff();
    return;
  }
  const result = resolveSessionCreateMessage({
    requestId,
    name: cwdPickerNameInput.value,
    cwd: cwdPickerInput.value,
    category: normalizedCategory(cwdPickerCategoryInput.value),
    proposedModelId: cwdPickerProposedModel.value,
    worktree: {
      enabled: cwdPickerWorktreeEnabled.checked,
      sourceRepo: cwdPickerWorktreeSourceRepo.value,
      directory: cwdPickerInput.value,
      baseBranch: cwdPickerWorktreeBase.value,
      branchName: cwdPickerWorktreeBranch.value,
    },
  });
  if (result.type === "invalid") {
    setCwdPickerError(result.message);
    focusCwdPickerCreateTarget(result.target);
    return;
  }
  pendingCreatedSessionBaseline = new Set(sessions.map(s => s.sessionId));
  setCwdPickerCreatePending(true, requestId);
  const message = result.message;
  if (!send(message)) {
    pendingCreatedSessionBaseline = null;
    setCwdPickerCreatePending(false);
    setCwdPickerError("Not connected to the Fura bridge.");
  }
}

function duplicateSession(sessionId: string): void {
  if (pendingSessionFork || workspaceMode !== "session" || activeSessionId !== sessionId) return;
  const summary = currentSessionSummary(sessionId);
  const projection = projections.get(sessionId);
  if (
    summary?.kind !== "managed" ||
    summary.status !== "idle" ||
    projection?.isBusy ||
    projection?.compacting
  ) return;
  setWorkspaceOptionsOpen(false);
  const requestId = nextClientRequestId("session-fork");
  pendingSessionFork = { requestId, sourceSessionId: sessionId };
  renderActiveSession();
  if (!send({ type: "session.fork", requestId, sessionId })) {
    pendingSessionFork = null;
    appendSessionNotice(sessionId, {
      level: "error",
      text: "Not connected to the Fura bridge.",
    });
    render();
  }
}

function openHandoffPicker(): void {
  handoffPickerNameInput.value = "";
  handoffPickerInstructions.value = "";
  handoffPickerOverlay.hidden = false;
  window.setTimeout(() => handoffPickerNameInput.focus(), 0);
}

function closeHandoffPicker(): void {
  handoffPickerOverlay.hidden = true;
  promptInput.focus();
}

function submitHandoffPicker(): void {
  if (!activeSessionId) return;
  const name = handoffPickerNameInput.value.trim();
  if (!name) return;
  const customInstructions = handoffPickerInstructions.value.trim() || undefined;
  pendingCreatedSessionBaseline = new Set(sessions.map(s => s.sessionId));
  send({ type: "session.handoff", sessionId: activeSessionId, name, customInstructions });
  closeHandoffPicker();
}

function openModelPicker(sessionId: string): void {
  modelPickerSessionId = sessionId;
  modelPickerModels = [];
  modelPickerSelectedIndex = 0;
  modelPickerLoading = true;
  modelPickerError = null;
  modelPickerSearch.value = "";
  modelPickerOverlay.hidden = false;
  renderModelPicker();
  send({ type: "model.list", sessionId });
  window.setTimeout(() => modelPickerSearch.focus(), 0);
}

function closeModelPicker(): void {
  modelPickerOverlay.hidden = true;
  modelPickerSessionId = null;
  modelPickerModels = [];
  modelPickerSelectedIndex = 0;
  modelPickerLoading = false;
  modelPickerError = null;
  promptInput.focus();
}

function filteredModelPickerModels(): ModelSummary[] {
  return filterCatalogModels(modelPickerModels, modelPickerSearch.value);
}


function handleModelPickerKeydown(event: KeyboardEvent): void {
  if (modelPickerOverlay.hidden) return;
  const models = filteredModelPickerModels();
  if (event.key === "Escape") {
    event.preventDefault();
    closeModelPicker();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (models.length > 0) {
      modelPickerSelectedIndex = Math.min(modelPickerSelectedIndex + 1, models.length - 1);
      renderModelPicker();
    }
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (models.length > 0) {
      modelPickerSelectedIndex = Math.max(modelPickerSelectedIndex - 1, 0);
      renderModelPicker();
    }
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    selectCurrentModel();
  }
}

function selectCurrentModel(): void {
  const sessionId = modelPickerSessionId;
  if (!sessionId || modelPickerLoading) return;
  const model = filteredModelPickerModels()[modelPickerSelectedIndex];
  if (!model) return;
  modelPickerLoading = true;
  modelPickerError = null;
  renderModelPicker();
  send({ type: "model.set", sessionId, provider: model.provider, modelId: model.id });
}

function renderModelPicker(): void {
  const models = filteredModelPickerModels();
  if (modelPickerSelectedIndex >= models.length) {
    modelPickerSelectedIndex = Math.max(0, models.length - 1);
  }

  modelPickerList.replaceChildren();
  modelPickerSelect.disabled = modelPickerLoading || models.length === 0;
  modelPickerSearch.disabled = false;

  if (modelPickerError) {
    modelPickerStatus.textContent = modelPickerError;
    modelPickerStatus.className = "model-picker-status error";
  } else if (modelPickerLoading) {
    modelPickerStatus.textContent = modelPickerModels.length === 0 ? "Loading models…" : "Changing model…";
    modelPickerStatus.className = "model-picker-status";
  } else {
    modelPickerStatus.textContent = `${models.length} model${models.length === 1 ? "" : "s"}`;
    modelPickerStatus.className = "model-picker-status";
  }

  if (!modelPickerLoading && models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "model-picker-empty";
    empty.textContent = modelPickerSearch.value.trim() ? "No matching models." : "No models available for this session.";
    modelPickerList.append(empty);
    return;
  }

  const currentModel = modelPickerSessionId ? projections.get(modelPickerSessionId)?.model : null;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const row = document.createElement("button");
    row.type = "button";
    row.disabled = modelPickerLoading;
    row.className = "model-picker-row";
    row.classList.toggle("selected", i === modelPickerSelectedIndex);
    row.classList.toggle("current", currentModel === model.id || currentModel === model.name || currentModel === formatModelSelector(model));
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === modelPickerSelectedIndex));

    const title = document.createElement("span");
    title.className = "model-picker-row-title";
    title.textContent = formatModelSelector(model);

    const details = document.createElement("span");
    details.className = "model-picker-row-details";
    const detailParts = [model.name, formatModelContext(model), model.thinking ? "thinking" : null].filter(Boolean);
    details.textContent = detailParts.join(" · ");

    row.append(title, details);
    row.addEventListener("click", () => {
      modelPickerSelectedIndex = i;
      renderModelPicker();
    });
    row.addEventListener("dblclick", selectCurrentModel);
    modelPickerList.append(row);
  }
}

function openCommandsPopup(sessionId: string): void {
  commandsPopupSessionId = sessionId;
  commandsPopupSearch.value = "";
  commandsPopupOverlay.hidden = false;
  renderCommandsPopup();
  window.setTimeout(() => commandsPopupSearch.focus(), 0);
}

function closeCommandsPopup(): void {
  commandsPopupOverlay.hidden = true;
  commandsPopupSessionId = null;
  promptInput.focus();
}

function insertCommandFromPopup(insertText: string): void {
  resetPromptHistoryNavigation();
  promptInput.value = insertText;
  closeCommandsPopup();
}

function renderCommandsPopup(): void {
  const live = commandsPopupSessionId ? projections.get(commandsPopupSessionId)?.availableCommands ?? [] : [];
  const query = commandsPopupSearch.value.trim().toLowerCase();
  const sections: CommandPopupSection[] = buildCommandsPopupSections(live);
  commandsPopupList.replaceChildren();
  let anyRows = false;
  for (const section of sections) {
    const rows = query
      ? section.rows.filter(r => r.label.toLowerCase().includes(query) || r.description.toLowerCase().includes(query))
      : section.rows;
    if (rows.length === 0) continue;
    anyRows = true;
    const header = document.createElement("div");
    header.className = "commands-popup-section-title";
    header.textContent = section.title;
    commandsPopupList.append(header);
    for (const row of rows) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "model-picker-row";
      const title = document.createElement("span");
      title.className = "model-picker-row-title";
      title.textContent = row.label;
      const details = document.createElement("span");
      details.className = "model-picker-row-details";
      details.textContent = row.description;
      el.append(title, details);
      el.addEventListener("click", () => insertCommandFromPopup(row.insertText));
      commandsPopupList.append(el);
    }
  }
  if (!anyRows) {
    const empty = document.createElement("div");
    empty.className = "model-picker-empty";
    empty.textContent = "No matching commands.";
    commandsPopupList.append(empty);
  }
}


// --- Command palette ---

function updatePalette(): void {
  if (workspaceMode === "controller") {
    hidePalette();
    return;
  }
  const text = promptInput.value;
  if (!text.startsWith("/") || text.includes(" ")) {
    hidePalette();
    return;
  }
  const query = text.slice(1);
  const matches = fuzzyMatchCommands(query, SUPPORTED_SLASH_COMMANDS);
  if (matches.length === 0) {
    hidePalette();
    return;
  }
  paletteCommands = matches.slice(0, 10);
  paletteSelectedIndex = -1;
  renderPaletteItems();
  commandPalette.hidden = false;
}

function hidePalette(): void {
  commandPalette.hidden = true;
  paletteSelectedIndex = -1;
  paletteCommands = [];
}

function renderPaletteItems(): void {
  commandPalette.replaceChildren();
  for (let i = 0; i < paletteCommands.length; i++) {
    const cmd = paletteCommands[i];
    const item = document.createElement("div");
    item.className = "cmd-item";

    const nameEl = document.createElement("span");
    nameEl.className = "cmd-name";
    nameEl.textContent = `/${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ""}`;

    const descEl = document.createElement("span");
    descEl.className = "cmd-desc";
    descEl.textContent = cmd.description;

    item.append(nameEl, descEl);
    item.addEventListener("mousedown", e => {
      e.preventDefault();
      selectPaletteCommand(cmd);
    });
    commandPalette.append(item);
  }
}

function selectPaletteCommand(cmd: SlashCommandSpec): void {
  resetPromptHistoryNavigation();
  promptInput.value = `/${cmd.name} `;
  hidePalette();
  promptInput.focus();
}

function setPaletteSelected(index: number): void {
  const items = commandPalette.querySelectorAll<HTMLElement>(".cmd-item");
  paletteSelectedIndex = Math.max(-1, Math.min(index, items.length - 1));
  items.forEach((item, i) => item.classList.toggle("selected", i === paletteSelectedIndex));
  if (paletteSelectedIndex >= 0) {
    items[paletteSelectedIndex].scrollIntoView({ block: "nearest" });
  }
}

// --- Utilities ---

function send(message: ClientMessage): boolean {
  if (!connection) {
    appendLog("Not connected.");
    return false;
  }
  return connection.send(message);
}

function setStatus(label: string, className: ConnectionStatus): void {
  connectionStatus.textContent = label;
  connectionStatus.className = `status ${className}`;
  const canForceReconnect = className === "disconnected" || className === "reconnecting";
  connectionStatus.title = canForceReconnect ? "Click to reconnect now." : "";
  connectionStatus.tabIndex = canForceReconnect ? 0 : -1;
}

function forceReconnectNow(): void {
  if (!connection || connection.isOpen()) return;
  appendLog("Reconnecting now.");
  connection.connect();
}

function appendLog(line: string): void {
  console.debug(`[fura] ${line}`);
}
