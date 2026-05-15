import "./style.css";
import "highlight.js/styles/github-dark.css";
import { clearBootstrapToken, consumeBootstrapToken, storeBootstrapToken } from "./bootstrapAuth";
import { findSlashCommand, fuzzyMatchCommands, type SlashCommandSpec } from "./slashCommands";
import { formatContext, formatCost, formatTokens, shortId, shortPath } from "./format";
import { nextThinkingVisibilityMode, parseThinkingVisibilityMode, parseToolVisibility, type ThinkingVisibilityMode } from "./uiPreferences";
import { createFuraConnection, type ConnectionStatus, type FuraConnection } from "./connection";
import { mkEl, mkFrag, requireElement, setRenderDocument } from "./dom";
import {
  isCompactReadCard,
  renderCurrentTodoCard,
  renderReadToolCard,
  renderReadToolGroup,
  renderToolCard,
} from "./toolCards";
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
  resolvePromptSubmitAction,
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
import { applySessionSnapshot, applySessionsSnapshot, activateSession as activateSessionState, sessionOpenOrAttachMessage } from "./sessionClientState";
import {
  comparisonKey,
  DEFAULT_SESSION_CHANGES_DETAIL_MODE,
  diffEndpointInputText,
  diffRefInputFromText,
  diffRefInputText,
  formatDiffRepoLabel,
  sessionChangesRefreshOptions,
  resolvedRefLabel,
  summarizeWireDiffFiles,
} from "./diffState";
import {
  annotationsForDiffLocation,
  checkoutTargetForDiffFile,
  createDiffReviewAnnotation,
  createReviewCommentCreateMessage,
  diffCommentFlushEditorText,
  diffCommentPreviewStatus,
  formatDiffLocation,
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
  extensionDialogBodyText,
  extensionDialogHttpUrl,
  formatExtensionDialogNotification,
  parseExtensionDialogRequest,
  type ExtensionDialogRequest,
} from "./extensionDialog";
import { initDesktopDockview, type DesktopDockview } from "./desktopDockview";
import { captureDiffFilterFocus, restoreDiffFilterFocus } from "./diffViewDom";
import { messageText, renderMessage as renderTranscriptMessage } from "./transcriptView";
import {
  buildTranscriptReviewPrompt,
  type TranscriptReviewComment,
  type TranscriptReviewLine,
} from "./transcriptReview";
import {
  buildPlanReviewPrompt,
  createApprovePlanReviewMessage,
  createDiscussPlanReviewMessage,
  pendingPlanReviewFromMessage,
  planReviewRenderKey,
  renderPlanReviewCard,
  planReviewTranscriptMessage,
  type PendingPlanReview,
  type VisiblePlanReview,
} from "./planReview";
import {
  parentCodePath,
  renderCodeViewer,
  type CodeViewerState,
} from "./codeViewer";
import {
  adjacentConflictId,
  conflictSelectionRange,
  containsConflictMarkerLines,
  draftConflictRegions,
  renderConflictResolver,
  resolveDraftConflict,
  type ConflictResolutionMode,
  type ConflictResolverState,
  type DraftSelectionState,
} from "./conflictResolver";
import type {
  ClientMessage,
  CodeFileContent,
  CodeTreeEntry,
  CodeWorkspaceSummary,
  ControlCandidate,
  ControlStatusProjection,
  ControlSuggestedAction,
  CompareDiffSummaryState,
  DiffCheckoutTarget,
  DiffDetailMode,
  DiffLineLocation,
  DiffReviewAnnotation,
  DiffReviewWorktree,
  DiffReviewableState,
  DiffRow,
  FrontendControlAction,
  FrontendUiSnapshot,
  ConflictAgentMode,
  ConflictAgentResult,
  ConflictAgentScope,
  ConflictFileState,
  ConflictMagicWandPreview,
  ConflictRepositorySummary,
  GoalControlAction,
  ModelSummary,
  PlanApprovalMode,
  ProposedModelConfig,
  ProposedThinkingLevel,
  ReviewComment,
  ServerConfig,
  ServerMessage,
  SessionChangesSummaryState,
  SessionMode,
  SessionProjection,
  SessionStatus,
  SessionSummary,
  TodoPhase,
  ToolCard,
  TranscriptEntry,
  TranscriptMessage,
} from "./protocol";

type WorkspaceMode = "session" | "controller";

type PanelRenderItem = {
  key: string;
  render: () => HTMLElement;
};

type CachedPanelRenderState = {
  keys: string[];
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
        <div>
          <h1>Fura</h1>
          <p>Browser bridge for Oh My Pi sessions</p>
        </div>
        <span id="connectionStatus" class="status disconnected">disconnected</span>
      </section>

      <section class="sidebar-actions">
        <button id="createSessionButton" type="button">New</button>
      </section>

      <section class="category-filter-card" aria-label="Session category filter">
        <label for="sessionCategoryFilter">Category</label>
        <select id="sessionCategoryFilter">
          <option value="">All sessions</option>
        </select>
      </section>



      <nav id="sessionsList" class="sessions" aria-label="Sessions"></nav>
    </aside>

    <section class="workspace">
      <header class="workspace-header">
        <div>
          <h2 id="sessionTitle">No session selected</h2>
          <p id="sessionMeta">Create or attach to a session to begin.</p>
        </div>
        <div class="workspace-actions">
          <!-- Ask Fura is intentionally a desktop-only workspace affordance for now; future mobile UI should omit it unless the product direction changes. -->
          <button id="askFuraButton" class="ask-fura-toggle" type="button" aria-pressed="false">Ask Fura</button>
          <div class="workspace-options">
            <button id="workspaceOptionsToggle" class="workspace-options-toggle" type="button" aria-expanded="false" aria-haspopup="menu" aria-controls="workspaceOptionsMenu" title="Display options">⚙</button>
            <div id="workspaceOptionsMenu" class="workspace-options-menu" role="menu" hidden>
              <button id="toolVisibilityToggle" class="workspace-option-item" type="button" role="menuitemcheckbox" aria-checked="true">Tools: on</button>
              <button id="thinkingVisibilityToggle" class="workspace-option-item" type="button" role="menuitem">Thinking: auto</button>
              <button id="proposedModelsOpen" class="workspace-option-item" type="button" role="menuitem">Model templates</button>
            </div>
          </div>
          <button id="abortButton" type="button">Abort</button>
          <button id="stopButton" type="button">Stop</button>
          <div class="category-editor">
            <label for="activeCategoryInput">Category</label>
            <div class="category-combobox">
              <input id="activeCategoryInput" autocomplete="off" spellcheck="false" maxlength="80" placeholder="category" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="activeCategorySuggestions" />
              <div id="activeCategorySuggestions" class="category-suggestions" role="listbox" hidden></div>
            </div>
            <button id="activeCategorySave" type="button">Save</button>
          </div>
          <button id="deleteSessionButton" class="danger-action" type="button">Delete session</button>
        </div>
      </header>

      <div id="goalModeCardHost" class="goal-mode-card-host" hidden></div>

      <div id="workspacePanelHost" class="workspace-panel-stack">
        <div id="normalWorkspacePanelHost" class="workspace-panel-host workspace-panel-host-active"></div>
        <div id="diffReviewWorkspacePanelHost" class="workspace-panel-host"></div>
        <div id="conflictResolverWorkspacePanelHost" class="workspace-panel-host"></div>
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

  <div id="extensionDialogOverlay" class="modal-overlay" hidden>
    <section class="extension-dialog modal-panel" role="dialog" aria-modal="true" aria-labelledby="extensionDialogTitle" aria-describedby="extensionDialogBody">
      <header class="modal-header">
        <div>
          <h2 id="extensionDialogTitle">Extension request</h2>
          <p id="extensionDialogSubtitle">Respond to the active OMP extension request.</p>
        </div>
        <button id="extensionDialogClose" class="modal-close" type="button" aria-label="Cancel extension dialog">×</button>
      </header>
      <div id="extensionDialogBody" class="extension-dialog-body"></div>
      <form id="extensionDialogForm" class="extension-dialog-form">
        <div id="extensionDialogField" class="extension-dialog-field"></div>
        <p id="extensionDialogStatus" class="extension-dialog-status" aria-live="polite"></p>
        <footer class="modal-footer">
          <span id="extensionDialogQueue" class="extension-dialog-queue"></span>
          <div class="modal-actions">
            <button id="extensionDialogCancel" type="button">Cancel</button>
            <button id="extensionDialogSubmit" type="submit">Submit</button>
          </div>
        </footer>
      </form>
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
        <button id="cwdPickerConflictTab" type="button" role="tab" aria-selected="false" aria-controls="cwdPickerConflictBody">Conflict Resolver</button>
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
        <label for="cwdPickerDiffHead">Head ref</label>
        <input id="cwdPickerDiffHead" autocomplete="off" spellcheck="false" placeholder="feature/my-branch" />
        <label for="cwdPickerDiffMode">Diff mode</label>
        <select id="cwdPickerDiffMode">
          <option value="full">Full</option>
          <option value="stat">Stat</option>
        </select>
        <label class="checkbox-row" for="cwdPickerDiffAgentSession">
          <input id="cwdPickerDiffAgentSession" type="checkbox" checked />
          <span>Create/attach agent session for questions</span>
        </label>
        <p class="field-help">Questions from the diff use the normal prompt channel of the backing session.</p>
      </div>
      <div id="cwdPickerConflictBody" class="cwd-picker-body" role="tabpanel" aria-labelledby="cwdPickerConflictTab" hidden>
        <label for="cwdPickerConflictRepo">Repository root</label>
        <input id="cwdPickerConflictRepo" autocomplete="off" spellcheck="false" placeholder="/home/user/project" />
        <p class="field-help">Create a normal OMP session for Conflict Resolver using this conflicted repository root.</p>
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

  <div id="forkPickerOverlay" class="modal-overlay" hidden>
    <section class="fork-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="forkPickerTitle">
      <header class="modal-header">
        <div>
          <h2 id="forkPickerTitle">Fork session</h2>
          <p>Name the forked session before branching.</p>
        </div>
        <button id="forkPickerClose" class="modal-close" type="button" aria-label="Close">×</button>
      </header>
      <div class="cwd-picker-body">
        <label for="forkPickerNameInput">Session name</label>
        <input id="forkPickerNameInput" autocomplete="off" spellcheck="false" placeholder="my-fork" />
      </div>
      <footer class="modal-footer">
        <span></span>
        <div class="modal-actions">
          <button id="forkPickerCancel" type="button">Cancel</button>
          <button id="forkPickerCreate" type="button">Fork session</button>
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

  <div id="snapshotLabelOverlay" class="modal-overlay" hidden>
    <section class="snapshot-label-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="snapshotLabelTitle" aria-describedby="snapshotLabelDescription">
      <header class="modal-header">
        <div>
          <h2 id="snapshotLabelTitle">Create diff snapshot</h2>
          <p id="snapshotLabelDescription">Record a repository diff snapshot, or target a specific Git ref without changing the worktree.</p>
        </div>
        <button id="snapshotLabelClose" class="modal-close" type="button" aria-label="Close snapshot dialog">×</button>
      </header>
      <form id="snapshotForm" class="snapshot-form" novalidate>
        <div class="cwd-picker-body">
          <label for="snapshotLabelInput">Snapshot label</label>
          <input id="snapshotLabelInput" autocomplete="off" spellcheck="false" />
          <label class="snapshot-explicit-toggle" for="snapshotExplicitToggle">
            <input id="snapshotExplicitToggle" type="checkbox" />
            <span>Snapshot an explicit Git ref</span>
          </label>
          <div id="snapshotExplicitFields" class="snapshot-explicit-fields" hidden>
            <label for="snapshotRefInput">Git ref <span class="label-optional">(required)</span></label>
            <input id="snapshotRefInput" autocomplete="off" spellcheck="false" placeholder="HEAD~1, main, v1.2.3, or a commit SHA" />
            <label for="snapshotRepoInput">Repository root <span class="label-optional">(optional)</span></label>
            <input id="snapshotRepoInput" autocomplete="off" spellcheck="false" placeholder="Defaults to the selected diff repository" />
          </div>
          <p id="snapshotFormStatus" class="modal-status" aria-live="polite"></p>
        </div>
        <footer class="modal-footer">
          <span></span>
          <div class="modal-actions">
            <button id="snapshotLabelCancel" type="button">Cancel</button>
            <button id="snapshotLabelCreate" type="submit">Create snapshot</button>
          </div>
        </footer>
      </form>
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
const goalModeCardHost = requireElement<HTMLDivElement>("goalModeCardHost");
const promptForm = requireElement<HTMLFormElement>("promptForm");
const promptInput = requireElement<HTMLTextAreaElement>("promptInput");
const toolVisibilityToggle = requireElement<HTMLButtonElement>("toolVisibilityToggle");
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
const abortButton = requireElement<HTMLButtonElement>("abortButton");
const stopButton = requireElement<HTMLButtonElement>("stopButton");
const deleteSessionButton = requireElement<HTMLButtonElement>("deleteSessionButton");
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
const extensionDialogOverlay = requireElement<HTMLDivElement>("extensionDialogOverlay");
const extensionDialogTitle = requireElement<HTMLHeadingElement>("extensionDialogTitle");
const extensionDialogSubtitle = requireElement<HTMLParagraphElement>("extensionDialogSubtitle");
const extensionDialogClose = requireElement<HTMLButtonElement>("extensionDialogClose");
const extensionDialogBody = requireElement<HTMLDivElement>("extensionDialogBody");
const extensionDialogForm = requireElement<HTMLFormElement>("extensionDialogForm");
const extensionDialogField = requireElement<HTMLDivElement>("extensionDialogField");
const extensionDialogStatus = requireElement<HTMLParagraphElement>("extensionDialogStatus");
const extensionDialogQueue = requireElement<HTMLSpanElement>("extensionDialogQueue");
const extensionDialogCancel = requireElement<HTMLButtonElement>("extensionDialogCancel");
const extensionDialogSubmit = requireElement<HTMLButtonElement>("extensionDialogSubmit");
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
const cwdPickerConflictTab = requireElement<HTMLButtonElement>("cwdPickerConflictTab");
const cwdPickerConflictBody = requireElement<HTMLDivElement>("cwdPickerConflictBody");
const cwdPickerConflictRepo = requireElement<HTMLInputElement>("cwdPickerConflictRepo");
const cwdPickerDiffBody = requireElement<HTMLDivElement>("cwdPickerDiffBody");
const cwdPickerDiffRepo = requireElement<HTMLInputElement>("cwdPickerDiffRepo");
const cwdPickerDiffBase = requireElement<HTMLInputElement>("cwdPickerDiffBase");
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
const forkPickerOverlay = requireElement<HTMLDivElement>("forkPickerOverlay");
const forkPickerClose = requireElement<HTMLButtonElement>("forkPickerClose");
const forkPickerNameInput = requireElement<HTMLInputElement>("forkPickerNameInput");
const forkPickerCancel = requireElement<HTMLButtonElement>("forkPickerCancel");
const forkPickerCreate = requireElement<HTMLButtonElement>("forkPickerCreate");
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
const snapshotLabelOverlay = requireElement<HTMLDivElement>("snapshotLabelOverlay");
const snapshotForm = requireElement<HTMLFormElement>("snapshotForm");
const snapshotLabelClose = requireElement<HTMLButtonElement>("snapshotLabelClose");
const snapshotLabelInput = requireElement<HTMLInputElement>("snapshotLabelInput");
const snapshotExplicitToggle = requireElement<HTMLInputElement>("snapshotExplicitToggle");
const snapshotExplicitFields = requireElement<HTMLDivElement>("snapshotExplicitFields");
const snapshotRefInput = requireElement<HTMLInputElement>("snapshotRefInput");
const snapshotRepoInput = requireElement<HTMLInputElement>("snapshotRepoInput");
const snapshotFormStatus = requireElement<HTMLParagraphElement>("snapshotFormStatus");
const snapshotLabelCancel = requireElement<HTMLButtonElement>("snapshotLabelCancel");

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
};
let pendingImages: PendingImage[] = [];
let pendingSnippets: PendingSnippet[] = [];
let nextPendingAttachmentId = 1;

let connection: FuraConnection | null = null;
let activeSessionId: string | null = null;
let serverConfig: ServerConfig | null = null;
let pendingCreatedSessionBaseline: Set<string> | null = null;
let pendingSessionSelectionId: string | null = null;
let cwdPickerCreatePending = false;
let cwdPickerPendingRequestId: string | null = null;
let cwdPickerMode: "session" | "diff" | "conflict" = "session";
let pendingDiffCreate: { repoRoot: string; base: string; head: string; payloadKind: DiffDetailMode } | null = null;
let pendingConflictResolverCreate = false;
let conflictResolverSessionId: string | null = null;
let deleteSessionTarget: SessionDeleteView | null = null;
let cwdPickerSourceRepoAutofill = true;
let cwdPickerDirectoryAutofill = true;
let cwdPickerBranchAutofill = true;
let cwdPickerBaseBranchAutofill = true;
let lastAutofilledWorktreeDirectory = "";
let lastAutofilledWorktreeBranch = "";
const unreadSessions = new Set<string>();
let activeExtensionDialog: ExtensionDialogRequest | null = null;
const queuedExtensionDialogs: ExtensionDialogRequest[] = [];
let sessions: SessionSummary[] = [];
let workspaceMode: WorkspaceMode = "session";
let sessionPromptDraft = "";
let controllerPromptDraft = "";
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
let projections = new Map<string, SessionProjection>();
const sessionChangesStates = new Map<string, SessionChangesSummaryState>();
const sessionChangesPayloadKinds = new Map<string, DiffDetailMode>();
const sessionChangesDiffIds = new Map<string, string>();
const sessionChangesSelectedFiles = new Map<string, string>();
let currentSessionChangesRequest: { sessionId: string; diffId: string } | null = null;
let compareDiffState: CompareDiffSummaryState | null = null;
let snapshotLabelSessionId: string | null = null;
let compareDiffId: string | null = null;
let compareDiffLoading = false;
let compareRepoRoot = "";
let compareBaseRef = "HEAD";
let compareHeadRef = "WORKTREE";
type PendingDiffFilePatchRequest = { diffId: string; comparisonKey: string; filePath: string | null };
type DiffFilePatchError = { filePath: string | null; message: string };
let comparePayloadKind: DiffDetailMode = "filePatch";
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
const diffReviewWorktrees = new Map<string, DiffReviewWorktree>();
const diffErrors = new Map<string, string>();
const diffLoadingSessions = new Set<string>();
let diffPanelDirty = true;
type CachedDiffPatch = { patch: string; truncated: boolean; rows: DiffRow[]; contextLines: number };
const diffPatchCache = new Map<string, CachedDiffPatch>();
const pendingDiffFilePatches = new Map<string, PendingDiffFilePatchRequest>();
const diffFilePatchErrors = new Map<string, DiffFilePatchError>();
type DiffFileMenuState = { annotationKey: string; filePath: string };
let openDiffFileMenu: DiffFileMenuState | null = null;
const diffClientId = (() => {
  const key = "fura.diff.clientId";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const next = crypto.randomUUID();
  sessionStorage.setItem(key, next);
  return next;
})();

function newDiffId(): string {
  return crypto.randomUUID();
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
let busyPromptDraft: BusyPromptDraft | null = null;
let diffPreviewDraft: DiffPreviewDraft | null = null;

let agentReviewDraft: { sessionId: string; state: DiffReviewableState } | null = null;
const codeComments = new Map<string, SessionCodeComments>();
let codePreviewDraft: CodePreviewDraft | null = null;
let transcriptPreviewDraft: TranscriptPreviewDraft | null = null;
const transcriptReviewActiveMessages = new Map<string, string>();
const transcriptReviewComments = new Map<string, TranscriptReviewComment[]>();
const PROMPT_HISTORY_LIMIT = 100;
let modelPickerSessionId: string | null = null;
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
let thinkingVisibilityMode: ThinkingVisibilityMode = "auto";
let skipThinkingOpenRestoreOnce = false;
let workspaceOptionsOpen = false;
syncToolVisibilityToggle();
syncThinkingVisibilityToggle();
syncWorkspaceOptionsMenu();
for (const level of PROPOSED_THINKING_LEVELS) {
  const option = document.createElement("option");
  option.value = level;
  option.textContent = level === "default" ? "Default" : level[0].toUpperCase() + level.slice(1);
  proposedModelThinkingSelect.append(option);
}

type CodeOpenRequest =
  | { source: "sessionWorktree"; sessionId: string; path: string }
  | { source: "reviewCommit"; repoRoot: string; reviewWorktreeId?: string | null; target: DiffCheckoutTarget; path: string };

// --- Desktop workspace state ---

let desktopDockview: DesktopDockview | null = null;
let normalDesktopDockview: DesktopDockview | null = null;
let diffReviewDesktopDockview: DesktopDockview | null = null;
let conflictDesktopDockview: DesktopDockview | null = null;
let activeDesktopDockviewMode: "normal" | "diffReview" | "conflictResolver" | null = null;
let codePanelDirty = true;
let codeSessionId: string | null = null;
let codeWorkspace: CodeWorkspaceSummary | null = null;
let codeTreePath = "";
let codeTreeEntries: CodeTreeEntry[] = [];
let codeFile: CodeFileContent | null = null;
let codeLoadingWorkspace = false;
let codeLoadingTree = false;
let codeLoadingFile = false;
let codeError: string | null = null;
let pendingCodeOpenRequest: CodeOpenRequest | null = null;
let codeSearchOpen = false;
let codeSearchBasePath = "";
let codeSearchQuery = "";
let codeSearchResults: CodeTreeEntry[] = [];
let codeSearchLoading = false;
let codeSearchError: string | null = null;
let codeSearchRequestTimer: number | null = null;
let conflictRepos: ConflictRepositorySummary[] = [];
let conflictRoot: string | null = null;
let conflictSelectedRepoId: string | null = null;
let conflictSelectedPath: string | null = null;
let conflictFile: ConflictFileState | null = null;
let conflictLoadingScan = false;
let conflictLoadingFile = false;
let conflictError: string | null = null;
let conflictPanelDirty = true;
let conflictResultDraft = "";
let conflictSelectedConflictId: string | null = null;
let conflictSaving = false;
let conflictStaging = false;
let conflictPreviewingMagicWand = false;
let conflictMagicWandPreview: ConflictMagicWandPreview | null = null;
let conflictRequestingAgentAssistance = false;
let conflictAgentInstructions = "";
let conflictAgentResult: ConflictAgentResult | null = null;
let conflictStatus: string | null = null;
let conflictEditorSelection: DraftSelectionState | null = null;

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
toolVisibilityToggle.addEventListener("click", () => {
  const nextShowTools = !showToolBubbles;
  if (!send({ type: "config.set", showTools: nextShowTools })) return;
  applyVisibilityPreferences(nextShowTools, thinkingVisibilityMode);
});
thinkingVisibilityToggle.addEventListener("click", () => {
  const nextMode = nextThinkingVisibilityMode(thinkingVisibilityMode);
  if (!send({ type: "config.set", thinkingVisibility: nextMode })) return;
  applyVisibilityPreferences(showToolBubbles, nextMode);
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
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && desktopDockview?.isPanelActive("code")) {
    event.preventDefault();
    openCodeSearch();
    return;
  }
  if (event.key === "Escape") {
    if (!proposedModelsOverlay.hidden) {
      closeProposedModelsDialog();
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
extensionDialogForm.addEventListener("submit", event => {
  event.preventDefault();
  submitActiveExtensionDialog();
});
extensionDialogClose.addEventListener("click", dismissOrCancelActiveExtensionDialog);
extensionDialogCancel.addEventListener("click", dismissOrCancelActiveExtensionDialog);
extensionDialogOverlay.addEventListener("mousedown", event => {
  if (event.target === extensionDialogOverlay) dismissOrCancelActiveExtensionDialog();
});
extensionDialogOverlay.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); dismissOrCancelActiveExtensionDialog(); }
});
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
cwdPickerClose.addEventListener("click", closeCwdPicker);
cwdPickerCancel.addEventListener("click", closeCwdPicker);
cwdPickerCreate.addEventListener("click", submitCwdPicker);
cwdPickerSessionTab.addEventListener("click", () => setCwdPickerMode("session"));
cwdPickerDiffTab.addEventListener("click", () => setCwdPickerMode("diff"));
cwdPickerConflictTab.addEventListener("click", () => setCwdPickerMode("conflict"));
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
forkPickerClose.addEventListener("click", closeForkPicker);
forkPickerCancel.addEventListener("click", closeForkPicker);
forkPickerCreate.addEventListener("click", submitForkPicker);
forkPickerOverlay.addEventListener("mousedown", event => {
  if (event.target === forkPickerOverlay) closeForkPicker();
});
forkPickerNameInput.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); submitForkPicker(); }
  if (event.key === "Escape") { event.preventDefault(); closeForkPicker(); }
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
snapshotLabelClose.addEventListener("click", closeSnapshotLabelPicker);
snapshotLabelCancel.addEventListener("click", closeSnapshotLabelPicker);
snapshotForm.addEventListener("submit", event => {
  event.preventDefault();
  submitSnapshotLabelPicker();
});
snapshotLabelOverlay.addEventListener("mousedown", event => {
  if (event.target === snapshotLabelOverlay) closeSnapshotLabelPicker();
});
snapshotExplicitToggle.addEventListener("change", updateSnapshotExplicitFields);
snapshotForm.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); closeSnapshotLabelPicker(); }
});
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
    case "openCwdPicker":
      clearPromptEditor();
      openCwdPicker();
      return;
    case "openForkPicker":
      clearPromptEditor();
      openForkPicker();
      return;
    case "openHandoffPicker":
      clearPromptEditor();
      openHandoffPicker();
      return;
    case "sendPrompt": {
      const accepted = sendPromptWithBusyHandling({
        sessionId: action.sessionId,
        text,
        editorText,
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
      const marker = createPendingMarker("Image");
      pendingImages.push({ type: "image", marker, data: base64, mimeType: file.type });
      insertTextAtCursor(marker);
    } catch {
      appendLog("Failed to read pasted image.");
    }
  }
  renderImagePreviews();
  updatePalette();
});
promptInput.addEventListener("input", () => {
  resetPromptHistoryNavigation();
  updatePalette();
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

  authSubmit.disabled = true;
  authStatus.textContent = "Connecting…";
  connection?.disconnect();
  connection = createFuraConnection({
    auth: { type: "sessionCookie", token: bridgeToken },
    onStatus: setStatus,
    onOpen: () => {
      hideAuthGate();
      send({ type: "session.list" });
    },
    onClose: () => {
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

function activeWorkspaceKey(): string | null {
  return workspaceMode === "controller" ? "controller" : activeSessionId;
}

function activateControllerWorkspace(): void {
  if (activeDesktopDockviewMode === "conflictResolver") {
    if (!confirmDiscardConflictDraft("switching to Ask Fura")) return;
    activeDesktopDockviewMode = null;
  }
  if (workspaceMode !== "controller") {
    sessionPromptDraft = promptInput.value;
    promptInput.value = controllerPromptDraft;
    workspaceMode = "controller";
    resetPromptHistoryNavigation();
    markTranscriptViewDirty({ resetCache: true });
    markToolsViewDirty();
    updatePalette();
  }
  render();
  promptInput.focus();
}

function activateSession(sessionId: string, options: { skipConflictDiscardPrompt?: boolean } = {}): void {
  const previousMode = workspaceMode;
  const previousSessionId = activeSessionId;
  const sessionChanged = activeSessionId !== sessionId || workspaceMode !== "session";
  if (sessionChanged) {
    if (activeDesktopDockviewMode === "conflictResolver") {
      if (!options.skipConflictDiscardPrompt && !confirmDiscardConflictDraft("switching sessions")) return;
      activeDesktopDockviewMode = null;
    }
    if (previousMode === "controller") {
      controllerPromptDraft = promptInput.value;
      promptInput.value = sessionPromptDraft;
    }
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
  switch (message.type) {
    case "hello":
      appendLog(`Connected to fura ${message.serverVersion} protocol ${message.protocolVersion}`);
      serverConfig = message.config;
      applyVisibilityPreferences(
        parseToolVisibility(message.config.showTools),
        parseThinkingVisibilityMode(message.config.thinkingVisibility),
      );
      syncProposedModelsUi();
      reviewCommentsRequested.clear();
      reviewCommentsLoadInFlight.clear();
      reviewCommentsResyncNeeded.clear();
      activeReviewCommentComposer = null;
      markDiffsViewDirty();
      if (activeSessionId) renderDiffsViewIfActive(activeSessionId);
      break;
    case "config.updated":
      serverConfig = message.config;
      applyVisibilityPreferences(
        parseToolVisibility(message.config.showTools),
        parseThinkingVisibilityMode(message.config.thinkingVisibility),
      );
      syncProposedModelsUi();
      if (proposedModelSavePending) {
        proposedModelSavePending = false;
        if (proposedModelFormOpen) {
          closeProposedModelForm({ preserveStatus: true });
          proposedModelStatus.textContent = "Saved.";
        }
      }
      break;
    case "sessions.snapshot":
      {
        const previousActiveSessionId = activeSessionId;
        ({ sessions, activeSessionId } = applySessionsSnapshot(message.sessions, activeSessionId));
        if (conflictResolverSessionId && !message.sessions.some(session => session.sessionId === conflictResolverSessionId)) {
          conflictResolverSessionId = null;
        }
        pruneVisiblePlanReviewsWithSessionList();
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
          const activateConflictResolver = pendingConflictResolverCreate;
          if (activateConflictResolver) {
            conflictResolverSessionId = message.sessionId;
          }
          setCwdPickerCreatePending(false);
          closeCwdPicker();
          if (pendingDiffCreate) {
            pendingDiffCreate = null;
          }
          pendingConflictResolverCreate = false;
          syncSessionModePanels(activateSessionChanges);
          if (activateConflictResolver) {
            openConflictResolver();
          }
        } else {
          syncSessionModePanels();
        }
      } else {
        unreadSessions.add(message.sessionId);
        renderSessions();
      }
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
      if (state.status === "ready") {
        sessionChangesPayloadKinds.set(state.sessionId, state.comparison.detailMode);
        if (state.reviewWorktree) diffReviewWorktrees.set(state.reviewWorktree.sourceRepoRoot, state.reviewWorktree);
        selectedDiffFilePath(state.sessionId, state, state.summary.files.map(file => file.newPath));
      } else {
        sessionChangesSelectedFiles.delete(state.sessionId);
      }
      pruneDiffPatchCache();
      markDiffsViewDirty();
      if (state.sessionId === activeSessionId) renderDiffsViewIfActive(state.sessionId);
      break;
    }
    case "compareDiff.summary": {
      const state = message.state;
      if (state.targetClientId !== diffClientId || compareDiffId !== state.diffId) break;
      compareDiffState = state;
      compareDiffLoading = false;
      diffErrors.delete("compareDiff");
      clearPendingDiffFilePatch("compareDiff", state.diffId);
      diffFilePatchErrors.delete("compareDiff");
      if (state.reviewWorktree) diffReviewWorktrees.set(state.reviewWorktree.sourceRepoRoot, state.reviewWorktree);
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
    case "diff.reviewWorktree.state": {
      diffReviewWorktrees.set(message.worktree.sourceRepoRoot, message.worktree);
      if (pendingCodeOpenRequest?.source === "reviewCommit" && pendingCodeOpenRequest.repoRoot === message.worktree.sourceRepoRoot) {
        pendingCodeOpenRequest = { ...pendingCodeOpenRequest, reviewWorktreeId: message.worktree.id };
        codeSessionId = null;
        codeWorkspace = null;
        codeLoadingWorkspace = true;
        desktopDockview?.activatePanel("code");
        send({ type: "code.workspace.openRoot", root: message.worktree.path, source: "reviewWorktree", reviewWorktreeId: message.worktree.id });
      }
      const sessionId = activeSessionId;
      if (sessionId) {
        markDiffsViewDirty();
        renderDiffsViewIfActive(sessionId);
      }
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
      codeLoadingWorkspace = false;
      codeWorkspace = message.workspace;
      codeSessionId = message.workspace.sessionId ?? null;
      codeTreePath = "";
      codeTreeEntries = [];
      codeFile = null;
      codeError = null;
      if (codeSearchOpen && !codeSearchBasePath) codeSearchBasePath = message.workspace.root;
      markCodeViewDirty();
      if (desktopDockview?.isPanelActive("code")) {
        renderCodePanelIfNeeded(true);
        const pending = pendingCodeOpenRequest;
        if (pending) {
          pendingCodeOpenRequest = null;
          requestCodeTree(parentCodePath(pending.path) ?? "");
          requestCodeFile(pending.path);
        } else {
          requestCodeTree("");
        }
      }
      break;
    case "code.tree":
      if (codeWorkspace?.workspaceId === message.workspaceId) {
        codeLoadingTree = false;
        codeTreePath = message.path;
        codeTreeEntries = message.entries;
        codeError = null;
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
      }
      break;
    case "code.file":
      if (codeWorkspace?.workspaceId === message.workspaceId) {
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
    case "conflict.snapshot": {
      if (!shouldAcceptConflictSnapshot(message.repos)) break;
      conflictLoadingScan = false;
      clearConflictMagicWandPreview();
      clearConflictAgentResult();
      conflictRepos = message.repos;
      conflictError = null;
      const selectedRepo = conflictRepos.find(repo => repo.repoId === conflictSelectedRepoId) ?? conflictRepos[0] ?? null;
      conflictSelectedRepoId = selectedRepo?.repoId ?? null;
      if (selectedRepo) conflictRoot = selectedRepo.root;
      if (selectedRepo && selectedRepo.files.length > 0) {
        const selectedFile = selectedRepo.files.find(file => file.path === conflictSelectedPath) ?? selectedRepo.files[0];
        conflictSelectedPath = selectedFile.path;
        requestConflictFile(selectedRepo.repoId, selectedFile.path);
      } else {
        conflictSelectedPath = null;
        resetConflictDraftState();
      }
      markConflictViewDirty();
      renderConflictPanelIfNeeded(true);
      break;
    }
    case "conflict.file":
      if (!isSelectedConflictFile(message.file.repoId, message.file.path)) break;
      conflictLoadingFile = false;
      conflictFile = message.file;
      conflictSelectedRepoId = message.file.repoId;
      conflictSelectedPath = message.file.path;
      conflictError = null;
      conflictSaving = false;
      conflictStaging = false;
      clearConflictMagicWandPreview();
      clearConflictAgentResult();
      conflictResultDraft = message.file.result?.text ?? "";
      conflictSelectedConflictId = message.file.conflicts[0]?.id ?? null;
      conflictStatus = "Conflict file refreshed from disk.";
      conflictEditorSelection = null;
      markConflictViewDirty();
      renderConflictPanelIfNeeded(true);
      break;
    case "conflict.magicWandPreview":
      if (!isSelectedConflictFile(message.preview.repoId, message.preview.path)) break;
      if (conflictFile?.version !== message.preview.sourceVersion) break;
      conflictPreviewingMagicWand = false;
      conflictMagicWandPreview = message.preview;
      conflictError = null;
      conflictStatus = message.preview.summary;
      markConflictViewDirty();
      renderConflictPanelIfNeeded(true);
      break;
    case "conflict.agentResult":
      if (!isSelectedConflictFile(message.result.repoId, message.result.path)) break;
      if (conflictFile?.version !== message.result.sourceVersion) break;
      conflictRequestingAgentAssistance = false;
      conflictAgentResult = message.result;
      conflictError = null;
      conflictStatus = message.result.summary;
      markConflictViewDirty();
      renderConflictPanelIfNeeded(true);
      break;
    case "conflict.status":
      if (!message.path || !isSelectedConflictFile(message.repoId, message.path)) break;
      conflictSaving = false;
      conflictStaging = false;
      clearConflictMagicWandPreview();
      clearConflictAgentResult();
      conflictStatus = message.message;
      markConflictViewDirty();
      renderConflictPanelIfNeeded(true);
      break;
    case "conflict.error":
      if (message.path && message.repoId && !isSelectedConflictFile(message.repoId, message.path)) break;
      if (!message.path && activeDesktopDockviewMode !== "conflictResolver") break;
      conflictLoadingScan = false;
      conflictLoadingFile = false;
      conflictSaving = false;
      conflictStaging = false;
      clearConflictMagicWandPreview();
      clearConflictAgentResult();
      conflictError = message.path ? `${message.path}: ${message.message}` : message.message;
      markConflictViewDirty();
      renderConflictPanelIfNeeded(true);
      break;
    case "code.error":
      if (!message.workspaceId || codeWorkspace?.workspaceId === message.workspaceId) {
        codeLoadingWorkspace = false;
        codeLoadingTree = false;
        codeLoadingFile = false;
        codeError = message.path ? `${message.path}: ${message.message}` : message.message;
        if (codeSearchOpen && codeSearchLoading) {
          codeSearchLoading = false;
          codeSearchError = codeError;
        }
        markCodeViewDirty();
        renderCodePanelIfNeeded(true);
      }
      break;
    case "plan.review":
      handlePlanReview(message);
      break;
    case "session.exited":
      appendLog(`Session ${message.sessionId} exited with code ${message.code ?? "unknown"}.`);
      render();
      break;
    case "dialog.request":
      handleExtensionDialogRequest(message);
      break;
    case "log.stderr":
      appendLog(`[${message.sessionId}] ${message.text}`);
      break;
    case "session.notice":
      appendLog(`[${message.sessionId}] ${message.level}: ${message.text}`);
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
  const conversationId = controlConversationId ?? crypto.randomUUID();
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
      dialogOpen: false,
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
  const next = crypto.randomUUID();
  window.sessionStorage.setItem(CONTROL_CLIENT_ID_STORAGE_KEY, next);
  return next;
}

function handlePromptBusy(message: Extract<ServerMessage, { type: "prompt.busy" }>): void {
  appendLog(`[${message.sessionId}] prompt needs steer or follow-up choice`);
  busyPromptDraft = createBusyPromptDraftFromServer(message, createPendingMarker);
  if (message.sessionId === activeSessionId) {
    render();
    promptInput.focus();
  } else {
    unreadSessions.add(message.sessionId);
    renderSessions();
  }
}

function hasPendingPlanReview(sessionId: string): boolean {
  return visiblePlanReviews.get(sessionId)?.mode === "pending";
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
  const mode: VisiblePlanReview["mode"] = projection.planMode?.discussion
    ? "discussing"
    : existing && existing.mode === "refining" && samePendingPlanReview(existing.review, pending)
      ? "refining"
      : "pending";
  visiblePlanReviews.set(sessionId, { review: pending, mode });
}

function pruneVisiblePlanReviewsWithSessionList(): void {
  const visibleSessionIds = new Set(sessions.map(session => session.sessionId));
  for (const sessionId of visiblePlanReviews.keys()) {
    if (!visibleSessionIds.has(sessionId)) visiblePlanReviews.delete(sessionId);
  }
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

function discussPendingPlanReview(review: PendingPlanReview): void {
  const accepted = send(createDiscussPlanReviewMessage(review));
  if (!accepted) return;
  visiblePlanReviews.set(review.sessionId, { review, mode: "discussing" });
  markTranscriptViewDirty();
  render();
  if (workspaceMode === "session" && activeSessionId === review.sessionId) {
    promptInput.focus();
  }
}
function persistPromptDraftForWorkspace(): void {
  if (workspaceMode === "controller") controllerPromptDraft = promptInput.value;
  else sessionPromptDraft = promptInput.value;
  resetPromptHistoryNavigation();
  updatePalette();
}


function handleExtensionDialogRequest(message: Extract<ServerMessage, { type: "dialog.request" }>): void {
  const request = parseExtensionDialogRequest(message.sessionId, message.dialog);
  if (!request) {
    appendLog(`[${message.sessionId}] ignored malformed dialog request.`);
    return;
  }

  switch (request.method) {
    case "cancel":
      cancelExtensionDialog(request.targetId);
      return;
    case "notify":
      appendLog(formatExtensionDialogNotification(request));
      return;
    case "set_editor_text":
      promptInput.value = request.text ?? "";
      persistPromptDraftForWorkspace();
      appendLog("Extension updated the prompt draft.");
      return;
    case "setStatus":
      if (request.statusText) appendLog(`[${message.sessionId}] ${request.statusText}`);
      return;
    case "setWidget":
      appendLog("Extension widget update received. Desktop Fura does not display extension widgets yet.");
      return;
    case "setTitle":
      return;
    default:
      enqueueExtensionDialog(request);
  }
}

function enqueueExtensionDialog(request: ExtensionDialogRequest): void {
  if (activeExtensionDialog) {
    queuedExtensionDialogs.push(request);
    appendLog(`Queued dialog request: ${request.title}`);
    renderExtensionDialog();
    return;
  }
  activeExtensionDialog = request;
  renderExtensionDialog();
}

function cancelExtensionDialog(targetId: string | undefined): void {
  if (!targetId) return;
  if (activeExtensionDialog?.id === targetId) {
    activeExtensionDialog = null;
    showNextExtensionDialog();
    return;
  }
  const queuedIndex = queuedExtensionDialogs.findIndex(request => request.id === targetId);
  if (queuedIndex >= 0) {
    queuedExtensionDialogs.splice(queuedIndex, 1);
    renderExtensionDialog();
  }
}

function showNextExtensionDialog(): void {
  activeExtensionDialog = queuedExtensionDialogs.shift() ?? null;
  renderExtensionDialog();
}

function dismissOrCancelActiveExtensionDialog(): void {
  if (!activeExtensionDialog) return;
  if (activeExtensionDialog.method === "open_url") {
    showNextExtensionDialog();
    return;
  }
  respondToActiveExtensionDialog({ cancelled: true });
}

function submitActiveExtensionDialog(): void {
  if (!activeExtensionDialog) return;
  switch (activeExtensionDialog.method) {
    case "confirm":
      respondToActiveExtensionDialog({ confirmed: true });
      return;
    case "select": {
      const select = extensionDialogField.querySelector<HTMLSelectElement>("select[data-dialog-value]");
      if (!select || select.selectedIndex < 0) {
        extensionDialogStatus.textContent = "Choose an option or cancel the request.";
        return;
      }
      respondToActiveExtensionDialog({ value: select.value });
      return;
    }
    case "input":
    case "editor": {
      const input = extensionDialogField.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-dialog-value]");
      respondToActiveExtensionDialog({ value: input?.value ?? "" });
      return;
    }
    case "open_url":
      showNextExtensionDialog();
      return;
    default:
      respondToActiveExtensionDialog({ cancelled: true });
  }
}

function respondToActiveExtensionDialog(response: Record<string, unknown>): void {
  if (!activeExtensionDialog) return;
  const accepted = send({
    type: "dialog.respond",
    sessionId: activeExtensionDialog.sessionId,
    dialogId: activeExtensionDialog.id,
    response,
  });
  if (!accepted) {
    extensionDialogStatus.textContent = "Not connected to the Fura bridge.";
    return;
  }
  showNextExtensionDialog();
}

function renderExtensionDialog(): void {
  extensionDialogOverlay.hidden = !activeExtensionDialog;
  extensionDialogBody.replaceChildren();
  extensionDialogField.replaceChildren();
  extensionDialogStatus.textContent = "";
  extensionDialogSubmit.hidden = false;
  extensionDialogSubmit.disabled = false;
  extensionDialogSubmit.textContent = "Submit";
  extensionDialogCancel.textContent = "Cancel";
  extensionDialogSubtitle.textContent = "Respond to the active OMP extension request.";
  extensionDialogQueue.textContent = queuedExtensionDialogs.length > 0
    ? `${queuedExtensionDialogs.length} queued`
    : "";

  if (!activeExtensionDialog) {
    extensionDialogTitle.textContent = "Extension request";
    return;
  }

  extensionDialogTitle.textContent = activeExtensionDialog.title;
  const bodyText = extensionDialogBodyText(activeExtensionDialog);
  if (bodyText) {
    const paragraph = mkEl("p");
    paragraph.textContent = bodyText;
    extensionDialogBody.append(paragraph);
  }

  if (activeExtensionDialog.timeoutMs !== undefined) {
    extensionDialogStatus.textContent = `Extension timeout: ${Math.ceil(activeExtensionDialog.timeoutMs / 1000)}s.`;
  }

  switch (activeExtensionDialog.method) {
    case "confirm":
      extensionDialogSubmit.textContent = "Confirm";
      break;
    case "select":
      renderExtensionDialogSelect(activeExtensionDialog);
      extensionDialogSubmit.textContent = "Select";
      break;
    case "input":
      renderExtensionDialogInput(activeExtensionDialog);
      break;
    case "editor":
      renderExtensionDialogEditor(activeExtensionDialog);
      break;
    case "open_url":
      renderExtensionDialogOpenUrl(activeExtensionDialog);
      extensionDialogSubmit.hidden = true;
      extensionDialogCancel.textContent = "Dismiss";
      extensionDialogSubtitle.textContent = "Open the link requested by the OMP extension.";
      break;
    default:
      extensionDialogSubmit.hidden = true;
      extensionDialogCancel.textContent = "Dismiss";
      if (!bodyText) {
        const paragraph = mkEl("p");
        paragraph.textContent = `Unsupported extension dialog method: ${activeExtensionDialog.method}.`;
        extensionDialogBody.append(paragraph);
      }
      break;
  }

  window.setTimeout(() => {
    const target = extensionDialogField.querySelector<HTMLElement>("[data-dialog-value]") ?? (extensionDialogSubmit.hidden ? extensionDialogCancel : extensionDialogSubmit);
    target.focus();
  }, 0);
}

function renderExtensionDialogSelect(request: ExtensionDialogRequest): void {
  const label = mkEl("label");
  label.textContent = "Choice";
  const select = document.createElement("select");
  select.dataset.dialogValue = "true";
  for (const option of request.options ?? []) {
    const optionElement = document.createElement("option");
    optionElement.value = option;
    optionElement.textContent = option;
    select.append(optionElement);
  }
  if (!select.options.length) {
    select.disabled = true;
    extensionDialogSubmit.disabled = true;
    extensionDialogStatus.textContent = "No options were provided for this dialog.";
  }
  label.append(select);
  extensionDialogField.append(label);
}

function renderExtensionDialogInput(request: ExtensionDialogRequest): void {
  const label = mkEl("label");
  label.textContent = "Response";
  const input = document.createElement("input");
  input.dataset.dialogValue = "true";
  input.autocomplete = "off";
  input.spellcheck = false;
  if (request.placeholder) input.placeholder = request.placeholder;
  label.append(input);
  extensionDialogField.append(label);
}

function renderExtensionDialogEditor(request: ExtensionDialogRequest): void {
  const label = mkEl("label");
  label.textContent = "Response";
  const textarea = document.createElement("textarea");
  textarea.dataset.dialogValue = "true";
  textarea.rows = request.promptStyle ? 6 : 12;
  textarea.value = request.prefill ?? "";
  label.append(textarea);
  extensionDialogField.append(label);
}

function renderExtensionDialogOpenUrl(request: ExtensionDialogRequest): void {
  const urlText = request.url ?? "";
  const safeUrl = extensionDialogHttpUrl(request);
  const wrapper = document.createElement("div");
  wrapper.className = "extension-dialog-open-url";
  const label = document.createElement("p");
  label.textContent = "URL";
  const code = document.createElement("code");
  code.textContent = urlText || "No URL provided.";
  wrapper.append(label, code);

  const actions = document.createElement("div");
  actions.className = "extension-dialog-open-url-actions";
  if (safeUrl) {
    const link = document.createElement("a");
    link.href = safeUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open link";
    actions.append(link);
  } else {
    const warning = document.createElement("p");
    warning.className = "extension-dialog-open-url-warning";
    warning.textContent = "Fura only opens http:// and https:// extension URLs.";
    wrapper.append(warning);
  }

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy URL";
  copyButton.disabled = !urlText;
  copyButton.addEventListener("click", async () => {
    if (!urlText || !navigator.clipboard?.writeText) {
      extensionDialogStatus.textContent = "Clipboard copy is not available in this browser.";
      return;
    }
    try {
      await navigator.clipboard.writeText(urlText);
      extensionDialogStatus.textContent = "URL copied.";
    } catch {
      extensionDialogStatus.textContent = "Could not copy URL.";
    }
  });
  actions.append(copyButton);
  wrapper.append(actions);
  extensionDialogField.append(wrapper);
}


function sendPromptMessage(
  sessionId: string,
  text: string,
  images: PendingImage[],
  behavior?: PromptBehavior,
): void {
  sessionNotices.delete(sessionId);
  addPromptToHistory(sessionId, text);
  send(createPromptSendMessage(sessionId, text, images, behavior));
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
  pendingImages = [];
  pendingSnippets = [];
  renderImagePreviews();
  promptInput.value = "";
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
  const target = voiceSegments.get(itemId)?.target ?? (voiceTarget && !voiceTarget.disabled ? voiceTarget : currentVoiceTarget());
  const existing = voiceSegments.get(itemId);
  const draft = existing ?? createVoiceSegmentDraft(target);
  const nextText = isFinal ? text : draft.text + text;
  replaceVoiceSegmentText(draft, nextText);
  if (isFinal) {
    voiceSegments.delete(itemId);
  } else {
    voiceSegments.set(itemId, draft);
  }
  if (target === promptInput) {
    resetPromptHistoryNavigation();
    updatePalette();
  }
}

function createVoiceSegmentDraft(target: HTMLInputElement | HTMLTextAreaElement): VoiceSegmentDraft {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  const prefix = target.value.slice(0, start);
  const lead = prefix && !/\s$/.test(prefix) ? " " : "";
  return { target, start, end, text: lead };
}

function replaceVoiceSegmentText(draft: VoiceSegmentDraft, text: string): void {
  const before = draft.target.value.slice(0, draft.start);
  const after = draft.target.value.slice(draft.end);
  draft.target.value = `${before}${text}${after}`;
  draft.text = text;
  draft.end = draft.start + text.length;
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
  const knownSlashCommand = findSlashCommand(options.editorText);
  const isSlashCommandLike = /^\/[^\s:]+/.test(options.editorText);

  if (projection?.isBusy) {
    if (knownSlashCommand && options.images.length === 0) {
      sendPromptMessage(options.sessionId, options.text, options.images);
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
    busyPromptDraft = createBusyPromptDraft({
      sessionId: options.sessionId,
      text: options.text,
      editorText: options.editorText,
      images: options.images,
      snippets: options.snippets,
      onSend: options.onSend,
    });
    renderBusyPromptChoice();
    return true;
  }

  sendPromptMessage(options.sessionId, options.text, options.images);
  options.onSend?.();
  return true;
}

function renderBusyPromptChoice(): void {
  const draft = busyPromptDraft;
  const shouldShow = Boolean(workspaceMode === "session" && draft && draft.sessionId === activeSessionId);
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

function restoreBusyPromptDraft(): void {
  const draft = busyPromptDraft;
  if (!draft) return;
  busyPromptDraft = null;

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
  const draft = busyPromptDraft;
  if (!draft) return;
  sendPromptMessage(draft.sessionId, draft.text, draft.images, behavior);
  const onSend = draft.onSend;
  busyPromptDraft = null;
  onSend?.();
  renderBusyPromptChoice();
  render();
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
  send(sessionDeleteMessage(view, deleteSessionWorktree.checked));
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

function activeConflictResolverSessionId(): string | null {
  return workspaceMode === "session" && activeSessionId === conflictResolverSessionId ? activeSessionId : null;
}

function requestSessionActivation(session: SessionSummary): boolean {
  if (
    activeDesktopDockviewMode === "conflictResolver"
    && (activeSessionId !== session.sessionId || workspaceMode !== "session")
    && !confirmDiscardConflictDraft("switching sessions")
  ) {
    return false;
  }
  const sent = send(sessionOpenOrAttachMessage(session));
  if (!sent) {
    pendingSessionSelectionId = session.sessionId;
    return false;
  }
  pendingSessionSelectionId = null;
  activateSession(session.sessionId, { skipConflictDiscardPrompt: true });
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
  toolVisibilityToggle.title = showToolBubbles ? "Hide tool bubbles in the transcript" : "Show tool bubbles in the transcript";
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

function setWorkspaceOptionsOpen(open: boolean): void {
  workspaceOptionsOpen = open;
  syncWorkspaceOptionsMenu();
}

function applyVisibilityPreferences(
  showTools: boolean,
  thinkingMode: ThinkingVisibilityMode,
): void {
  const toolsChanged = showToolBubbles !== showTools;
  const thinkingChanged = thinkingVisibilityMode !== thinkingMode;
  showToolBubbles = showTools;
  thinkingVisibilityMode = thinkingMode;
  syncToolVisibilityToggle();
  syncThinkingVisibilityToggle();
  if (thinkingChanged) {
    skipThinkingOpenRestoreOnce = true;
    markTranscriptViewDirty({ resetCache: true });
  } else if (toolsChanged) {
    markTranscriptViewDirty();
  }
  if (toolsChanged || thinkingChanged) {
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
    syncActiveCategoryEditor(undefined);
    const isWorking = controlStatusState.status === "working";
    promptInput.disabled = isWorking;
    sendButton.disabled = isWorking;
    sessionTitle.textContent = "Ask Fura";
    sessionMeta.textContent = "Fura controller session · can find, discuss, and open sessions.";
    promptInput.placeholder = isWorking ? "Ask Fura is working…" : "Ask Fura about sessions…";
    renderControllerStatusBar();
    renderGoalModeStatus(undefined);
    renderBusyPromptChoice();
    renderActiveDockviewPanel(undefined);
    return;
  }

  const projection = activeSessionId ? projections.get(activeSessionId) : undefined;
  const summary = projection?.summary ?? activeSessionSummary();
  const hasBusyDraft = busyPromptDraft?.sessionId === activeSessionId;

  abortButton.disabled = !activeSessionId;
  stopButton.disabled = !activeSessionId;
  deleteSessionButton.disabled = !activeSessionId;
  syncActiveCategoryEditor(projection);
  promptInput.disabled = !activeSessionId || hasBusyDraft;
  sendButton.disabled = !activeSessionId || hasBusyDraft;

  if (!activeSessionId || !summary) {
    sessionTitle.textContent = "No session selected";
    sessionMeta.textContent = "Create or attach to a session to begin.";
    promptInput.placeholder = "Select a session first";
  } else {
    sessionTitle.textContent = summary.title || `Session ${shortId(activeSessionId)}`;
    const category = normalizedCategory(summary.category);
    const categoryPart = category ? ` · ${category}` : "";
    sessionMeta.textContent = `${sessionKindLabel(summary.kind)} · ${sessionStatusLabel(summary)}${categoryPart} · ${summary.cwd ?? "no dir"}`;
    promptInput.placeholder = "Send a prompt… (type / for commands)";
  }

  renderStatusBar(projection);
  renderGoalModeStatus(projection);
  renderBusyPromptChoice();
  renderActiveDockviewPanel(projection);
}

function sendGoalStart(sessionId: string, objective: string, tokenBudget?: number): void {
  send({ type: "goal.start", sessionId, objective, tokenBudget });
}

function sendGoalControl(sessionId: string, action: GoalControlAction): void {
  send({ type: "goal.control", sessionId, action });
}

function sendGoalBudget(sessionId: string, tokenBudget?: number): void {
  send({ type: "goal.setBudget", sessionId, tokenBudget });
}

function renderGoalModeStatus(projection: SessionProjection | undefined): void {
  goalModeCardHost.replaceChildren();
  const sessionId = projection?.summary.sessionId;
  const card = renderGoalModeCard(
    goalModeCardHost.ownerDocument,
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
  goalModeCardHost.hidden = !card;
  if (card) goalModeCardHost.append(card);
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

function markConflictViewDirty(): void {
  conflictPanelDirty = true;
}

function activeConflictResolverRoot(): string | null {
  const sessionId = activeConflictResolverSessionId();
  if (!sessionId) return null;
  const summary = projections.get(sessionId)?.summary ?? currentSessionSummary(sessionId);
  return summary?.worktree?.path || summary?.cwd || null;
}

function activeConflictResolverState(): ConflictResolverState {
  return {
    root: conflictRoot,
    repos: conflictRepos,
    selectedRepoId: conflictSelectedRepoId,
    selectedPath: conflictSelectedPath,
    file: conflictFile,
    draftResult: conflictResultDraft,
    selectedConflictId: conflictSelectedConflictId,
    draftDirty: conflictDraftDirty(),
    saving: conflictSaving,
    staging: conflictStaging,
    previewingMagicWand: conflictPreviewingMagicWand,
    wandPreview: conflictMagicWandPreview,
    requestingAgentAssistance: conflictRequestingAgentAssistance,
    agentInstructions: conflictAgentInstructions,
    agentResult: conflictAgentResult,
    status: conflictStatus,
    loadingScan: conflictLoadingScan,
    loadingFile: conflictLoadingFile,
    error: conflictError,
  };
}

function conflictDraftDirty(): boolean {
  return Boolean(conflictFile && conflictResultDraft !== (conflictFile.result?.text ?? ""));
}

function clearConflictMagicWandPreview(): void {
  conflictPreviewingMagicWand = false;
  conflictMagicWandPreview = null;
}

function clearConflictAgentResult(): void {
  conflictRequestingAgentAssistance = false;
  conflictAgentResult = null;
}


function resetConflictDraftState(): void {
  conflictFile = null;
  conflictResultDraft = "";
  conflictSelectedConflictId = null;
  conflictSaving = false;
  conflictStaging = false;
  clearConflictMagicWandPreview();
  clearConflictAgentResult();
  conflictStatus = null;
  conflictEditorSelection = null;
}


function shouldAcceptConflictSnapshot(repos: ConflictRepositorySummary[]): boolean {
  if (activeDesktopDockviewMode !== "conflictResolver") return false;
  if (!conflictRoot) return false;
  const requestedRoot = conflictRoot;
  return repos.length === 0 || repos.some(repo => conflictRootMatchesRepo(requestedRoot, repo.root));
}

function conflictRootMatchesRepo(requestedRoot: string, repoRoot: string): boolean {
  const normalizedRequested = requestedRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedRepo = repoRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalizedRequested === normalizedRepo
    || normalizedRequested.startsWith(`${normalizedRepo}/`);
}

function isSelectedConflictFile(repoId: string, path: string): boolean {
  return activeDesktopDockviewMode === "conflictResolver"
    && conflictSelectedRepoId === repoId
    && conflictSelectedPath === path;
}

function confirmDiscardConflictDraft(reason: string): boolean {
  if (!conflictDraftDirty()) return true;
  return window.confirm(`Discard unsaved conflict result before ${reason}?`);
}

function openConflictResolver(): void {
  const root = activeConflictResolverRoot();
  setActiveDesktopDockviewMode("conflictResolver");
  desktopDockview?.activatePanel("conflictResolver");
  if (!root) {
    conflictRoot = null;
    conflictRepos = [];
    conflictSelectedRepoId = null;
    conflictSelectedPath = null;
    resetConflictDraftState();
    conflictLoadingScan = false;
    conflictLoadingFile = false;
    conflictError = "Open the session created for Conflict Resolver before opening this tool.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  beginConflictResolverScan(root);
}

function leaveConflictResolver(): void {
  if (!confirmDiscardConflictDraft("leaving Conflict Resolver")) return;
  if (activeDesktopDockviewMode === "conflictResolver") {
    activeDesktopDockviewMode = null;
  }
  conflictRoot = null;
  syncSessionModePanels();
  renderActiveDockviewPanel(activeSessionId ? projections.get(activeSessionId) : undefined);
}
function beginConflictResolverScan(root: string): void {
  conflictRoot = root;
  conflictRepos = [];
  conflictSelectedRepoId = null;
  conflictSelectedPath = null;
  conflictLoadingScan = true;
  conflictLoadingFile = false;
  conflictError = null;
  resetConflictDraftState();
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
  send({ type: "conflict.scan", root });
}


function requestConflictScan(): void {
  if (!confirmDiscardConflictDraft("refreshing conflict scan")) return;
  const root = activeConflictResolverRoot() ?? conflictRoot?.trim() ?? "";
  if (!root) {
    conflictError = "Open the session created for Conflict Resolver before refreshing this tool.";
    conflictLoadingScan = false;
    resetConflictDraftState();
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  beginConflictResolverScan(root);
}

function requestConflictFile(repoId: string, path: string): void {
  const switchingFile = conflictSelectedRepoId !== repoId || conflictSelectedPath !== path;
  if (switchingFile && !confirmDiscardConflictDraft("opening another conflicted file")) return;
  conflictSelectedRepoId = repoId;
  conflictSelectedPath = path;
  conflictLoadingFile = true;
  conflictError = null;
  clearConflictMagicWandPreview();
  clearConflictAgentResult();
  conflictStatus = null;
  conflictEditorSelection = null;
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
  send({ type: "conflict.file.open", repoId, path });
}

function updateConflictResultDraft(text: string, selection: DraftSelectionState): void {
  conflictResultDraft = text;
  conflictEditorSelection = selection;
  clearConflictMagicWandPreview();
  clearConflictAgentResult();
  conflictStatus = null;
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
}

function updateConflictAgentInstructions(text: string): void {
  conflictAgentInstructions = text;
}


function selectConflictBlock(conflictId: string): void {
  conflictSelectedConflictId = conflictId;
  const range = conflictSelectionRange(conflictResultDraft, conflictId);
  conflictEditorSelection = range
    ? {
        selectionStart: range.start,
        selectionEnd: range.end,
        scrollTop: conflictEditorSelection?.scrollTop ?? 0,
        focused: true,
      }
    : conflictEditorSelection;
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
}

function shiftConflictBlock(offset: -1 | 1): void {
  const nextId = adjacentConflictId(conflictResultDraft, conflictSelectedConflictId, offset);
  if (!nextId) return;
  selectConflictBlock(nextId);
}

function resolveSelectedConflictBlock(mode: ConflictResolutionMode): void {
  const resolved = resolveDraftConflict(conflictResultDraft, conflictSelectedConflictId, mode);
  if (!resolved.resolved) {
    conflictStatus = "No resolvable conflict marker is selected.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  conflictResultDraft = resolved.text;
  clearConflictMagicWandPreview();
  clearConflictAgentResult();
  const remainingRange = conflictSelectionRange(conflictResultDraft, conflictSelectedConflictId);
  conflictEditorSelection = remainingRange
    ? {
        selectionStart: remainingRange.start,
        selectionEnd: remainingRange.end,
        scrollTop: conflictEditorSelection?.scrollTop ?? 0,
        focused: true,
      }
    : conflictEditorSelection;
  conflictStatus = "Conflict block updated in draft. Save result to write it to disk.";
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
}

function previewConflictMagicWand(): void {
  if (!conflictFile) return;
  if (conflictDraftDirty()) {
    conflictStatus = "Save or discard draft edits before previewing the magic wand.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  if (!containsConflictMarkerLines(conflictResultDraft)) {
    conflictStatus = "No conflict markers remain in the saved conflict result.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  conflictPreviewingMagicWand = true;
  conflictMagicWandPreview = null;
  conflictError = null;
  conflictStatus = "Building magic wand preview…";
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
  send({
    type: "conflict.file.previewMagicWand",
    repoId: conflictFile.repoId,
    path: conflictFile.path,
    expectedVersion: conflictFile.version,
  });
}

function applyConflictMagicWandPreview(): void {
  if (!conflictFile || !conflictMagicWandPreview) return;
  if (conflictMagicWandPreview.sourceVersion !== conflictFile.version) {
    conflictStatus = "Magic wand preview is stale. Refresh the file and preview again.";
    clearConflictMagicWandPreview();
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  conflictResultDraft = conflictMagicWandPreview.content;
  conflictSelectedConflictId = draftConflictRegions(conflictResultDraft)[0]?.id ?? null;
  const range = conflictSelectionRange(conflictResultDraft, conflictSelectedConflictId);
  conflictEditorSelection = range
    ? {
        selectionStart: range.start,
        selectionEnd: range.end,
        scrollTop: conflictEditorSelection?.scrollTop ?? 0,
        focused: true,
      }
    : null;
  clearConflictMagicWandPreview();
  clearConflictAgentResult();
  conflictStatus = "Magic wand preview applied to the draft. Save result to write it to disk.";
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
}

function discardConflictMagicWandPreview(): void {
  if (!conflictMagicWandPreview && !conflictPreviewingMagicWand) return;
  clearConflictMagicWandPreview();
  conflictStatus = "Magic wand preview discarded.";
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
}

function requestConflictAgentAssistance(mode: ConflictAgentMode, scope: ConflictAgentScope): void {
  if (!conflictFile) return;
  const sessionId = activeConflictResolverSessionId();
  if (!sessionId) {
    conflictStatus = "Conflict Resolver agent assistance requires the session opened from this tool.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  if (conflictDraftDirty()) {
    conflictStatus = "Save or discard draft edits before asking the agent.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  if (!containsConflictMarkerLines(conflictResultDraft)) {
    conflictStatus = "No conflict markers remain in the saved conflict result.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  const selectedConflictId = scope === "selectedConflict"
    ? (conflictSelectedConflictId ?? draftConflictRegions(conflictResultDraft)[0]?.id ?? null)
    : null;
  if (scope === "selectedConflict" && !selectedConflictId) {
    conflictStatus = "Select a complete conflict block before asking the agent about it.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  conflictRequestingAgentAssistance = true;
  conflictAgentResult = null;
  conflictError = null;
  conflictStatus = mode === "explain"
    ? "Requesting agent explanation…"
    : "Requesting agent proposal preview…";
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
  send({
    type: "conflict.agent.run",
    sessionId: sessionId,
    repoId: conflictFile.repoId,
    path: conflictFile.path,
    expectedVersion: conflictFile.version,
    mode,
    scope,
    conflictId: selectedConflictId,
    instructions: conflictAgentInstructions,
  });
}

function applyConflictAgentResult(): void {
  if (!conflictFile || !conflictAgentResult?.content) return;
  if (conflictAgentResult.sourceVersion !== conflictFile.version) {
    conflictStatus = "Agent result is stale. Refresh the file and ask again.";
    clearConflictAgentResult();
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  conflictResultDraft = conflictAgentResult.content;
  conflictSelectedConflictId = draftConflictRegions(conflictResultDraft)[0]?.id ?? null;
  const range = conflictSelectionRange(conflictResultDraft, conflictSelectedConflictId);
  conflictEditorSelection = range
    ? {
        selectionStart: range.start,
        selectionEnd: range.end,
        scrollTop: conflictEditorSelection?.scrollTop ?? 0,
        focused: true,
      }
    : null;
  clearConflictAgentResult();
  conflictStatus = "Agent result applied to the draft. Save result to write it to disk.";
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
}

function discardConflictAgentResult(): void {
  if (!conflictAgentResult && !conflictRequestingAgentAssistance) return;
  clearConflictAgentResult();
  conflictStatus = "Agent result discarded.";
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
}


function saveConflictResult(): void {
  if (!conflictFile || !conflictDraftDirty()) return;
  conflictSaving = true;
  clearConflictMagicWandPreview();
  clearConflictAgentResult();
  conflictStatus = "Saving conflict result…";
  conflictError = null;
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
  send({
    type: "conflict.file.writeResult",
    repoId: conflictFile.repoId,
    path: conflictFile.path,
    content: conflictResultDraft,
    expectedVersion: conflictFile.version,
  });
}

function stageResolvedConflictFile(): void {
  if (!conflictFile) return;
  if (containsConflictMarkerLines(conflictResultDraft)) {
    conflictStatus = "Remove all conflict markers before marking the file resolved.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  if (conflictDraftDirty()) {
    conflictStatus = "Save the current conflict result before marking the file resolved.";
    markConflictViewDirty();
    renderConflictPanelIfNeeded(true);
    return;
  }
  conflictStaging = true;
  clearConflictMagicWandPreview();
  clearConflictAgentResult();
  conflictStatus = "Marking file resolved…";
  conflictError = null;
  markConflictViewDirty();
  renderConflictPanelIfNeeded(true);
  send({
    type: "conflict.file.stageResolved",
    repoId: conflictFile.repoId,
    path: conflictFile.path,
    expectedVersion: conflictFile.version,
  });
}

function resetCodeViewForSession(sessionId: string | null): void {
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
  codeSearchOpen = false;
  codeSearchBasePath = "";
  codeSearchQuery = "";
  codeSearchResults = [];
  codeSearchLoading = false;
  codeSearchError = null;
  clearPendingCodeSearchRequest();
  markCodeViewDirty();
}

function activeCodeViewState(): CodeViewerState {
  const activeCodeComments =
    workspaceMode === "session" && activeSessionId && codeFile
      ? selectedCodeComments(sessionCodeComments(activeSessionId).get(codeFile.path) ?? [], codeFile.path)
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
  if (!desktopDockview?.isPanelActive("code")) return;
  const sessionId = workspaceMode === "session" ? activeSessionId : null;
  if (!sessionId) return;
  requestCodeWorkspaceForSession(sessionId);
}

function requestCodeTree(path: string): void {
  if (!codeWorkspace) return;
  codeTreePath = path;
  codeLoadingTree = true;
  codeError = null;
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
  send({ type: "code.tree.list", workspaceId: codeWorkspace.workspaceId, path });
}

function requestCodeFile(path: string): void {
  if (!codeWorkspace) return;
  codeLoadingFile = true;
  codeError = null;
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
  send({ type: "code.file.open", workspaceId: codeWorkspace.workspaceId, path });
}

function openCodeSearch(): void {
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
  file: CodeFileContent,
  lineNumber: number,
  lineText: string,
): void {
  const comment = window.prompt("Comment on this code line");
  if (!comment?.trim()) return;
  const commentsByFile = sessionCodeComments(sessionId);
  const existing = commentsByFile.get(file.path) ?? [];
  existing.push(createCodeFileComment({
    id: `${Date.now()}-${existing.length}`,
    file,
    lineNumber,
    lineText,
    text: comment,
  }));
  commentsByFile.set(file.path, existing);
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
}

function editCodeComment(sessionId: string, comment: CodeFileComment): void {
  const next = window.prompt("Edit comment", comment.text);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  const commentsByFile = sessionCodeComments(sessionId);
  commentsByFile.set(
    comment.path,
    (commentsByFile.get(comment.path) ?? []).map(existing =>
      existing.id === comment.id ? { ...existing, text: trimmed } : existing,
    ),
  );
  markCodeViewDirty();
  renderCodePanelIfNeeded(true);
}

function deleteCodeComment(sessionId: string, comment: CodeFileComment): void {
  const commentsByFile = sessionCodeComments(sessionId);
  commentsByFile.set(
    comment.path,
    (commentsByFile.get(comment.path) ?? []).filter(existing => existing.id !== comment.id),
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

function sendCodeComments(sessionId: string, file: CodeFileContent, comments: CodeFileComment[], promptText = buildCodeCommentPrompt(file, comments)): void {
  if (comments.length === 0) return;
  const clearFlushedComments = () => {
    const commentsByFile = sessionCodeComments(sessionId);
    commentsByFile.set(file.path, removeSelectedCodeComments(commentsByFile.get(file.path) ?? [], file.path));
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

function previewCodeComments(sessionId: string, file: CodeFileContent): void {
  const comments = selectedCodeComments(sessionCodeComments(sessionId).get(file.path) ?? [], file.path);
  if (comments.length === 0) return;
  codePreviewDraft = { sessionId, file, comments };
  diffPreviewDraft = null;
  transcriptPreviewDraft = null;
  agentReviewDraft = null;
  diffPreviewTitle.textContent = "Preview code comments";
  diffPreviewSubtitle.textContent = "Review the prompt that will be sent to OMP.";
  diffPreviewSend.textContent = "Send comments";
  diffPreviewSend.disabled = false;
  diffPreviewText.readOnly = false;
  diffPreviewText.value = buildCodeCommentPrompt(file, comments);
  diffPreviewStatus.textContent = codeCommentPreviewStatus(comments.length);
  diffPreviewOverlay.hidden = false;
  diffPreviewText.scrollTop = 0;
  diffPreviewText.focus();
}

function flushCodeComments(sessionId: string, file: CodeFileContent): void {
  previewCodeComments(sessionId, file);
}
function openSearchResultInCode(path: string): void {
  closeCodeSearch();
  requestCodeTree(parentCodePath(path) ?? "");
  requestCodeFile(path);
}

function openPathInCode(path: string): void {
  const sessionId = workspaceMode === "session" ? activeSessionId : null;
  if (!sessionId) return;
  openCodeRequest({ source: "sessionWorktree", sessionId, path });
}

function openCodeRequest(request: CodeOpenRequest): void {
  pendingCodeOpenRequest = request;
  codeError = null;
  markCodeViewDirty();
  desktopDockview?.activatePanel("code");
  if (request.source === "sessionWorktree") {
    if (codeSessionId !== request.sessionId) resetCodeViewForSession(request.sessionId);
    if (codeWorkspace && codeSessionId === request.sessionId) {
      pendingCodeOpenRequest = null;
      requestCodeTree(parentCodePath(request.path) ?? "");
      requestCodeFile(request.path);
    } else {
      requestCodeWorkspaceForSession(request.sessionId);
      renderCodePanelIfNeeded(true);
    }
    return;
  }

  const worktree = diffReviewWorktrees.get(request.repoRoot) ?? null;
  if (!worktree) {
    send({ type: "diff.reviewWorktree.ensure", sourceRepoRoot: request.repoRoot, target: request.target });
    return;
  }
  send({ type: "diff.reviewWorktree.checkout", worktreeId: worktree.id, ref: request.target });
  codeSessionId = null;
  codeWorkspace = null;
  codeLoadingWorkspace = true;
  send({ type: "code.workspace.openRoot", root: worktree.path, source: "reviewWorktree", reviewWorktreeId: worktree.id });
  renderCodePanelIfNeeded(true);
}

function ensureReviewWorktreeThenCheckout(state: DiffReviewableState, target: DiffCheckoutTarget): void {
  const worktree = diffReviewWorktrees.get(state.comparison.repoRoot) ?? state.reviewWorktree ?? null;
  if (!worktree) {
    send({ type: "diff.reviewWorktree.ensure", sourceRepoRoot: state.comparison.repoRoot, target });
    return;
  }
  send({ type: "diff.reviewWorktree.checkout", worktreeId: worktree.id, ref: target });
}

function openDiffFileInCode(state: DiffReviewableState, filePath: string): void {
  const target = checkoutTargetForDiffFile(state);
  if (target.kind === "workingTree") {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    openCodeRequest({ source: "sessionWorktree", sessionId, path: filePath });
    return;
  }
  openCodeRequest({ source: "reviewCommit", repoRoot: state.comparison.repoRoot, target, path: filePath });
}


function renderActiveDockviewPanel(projection: SessionProjection | undefined): void {
  syncSessionModePanels();
  if (activeDesktopDockviewMode === "conflictResolver") {
    renderConflictPanelIfNeeded();
    return;
  }
  renderTranscriptPanelIfNeeded(projection);
  renderToolsPanelIfNeeded(projection);
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
  const sessionChanged = codeSessionId !== sessionId;
  if (sessionChanged) resetCodeViewForSession(sessionId);
  if (!force && !codePanelDirty && !sessionChanged) return;
  const rendered = desktopDockview.withPanel("code", container => {
    renderCodeViewer(container, activeCodeViewState(), {
      openWorkspace: () => {
        resetCodeViewForSession(workspaceMode === "session" ? activeSessionId : null);
        ensureActiveCodeWorkspace();
        renderCodePanelIfNeeded(true);
      },
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
        if (workspaceMode === "session" && activeSessionId && codeFile) {
          addCodeComment(activeSessionId, codeFile, lineNumber, lineText);
        }
      },
      editComment: comment => {
        if (workspaceMode === "session" && activeSessionId) editCodeComment(activeSessionId, comment);
      },
      deleteComment: comment => {
        if (workspaceMode === "session" && activeSessionId) deleteCodeComment(activeSessionId, comment);
      },
      previewComments: () => {
        if (workspaceMode === "session" && activeSessionId && codeFile) {
          previewCodeComments(activeSessionId, codeFile);
        }
      },
      flushComments: () => {
        if (workspaceMode === "session" && activeSessionId && codeFile) {
          flushCodeComments(activeSessionId, codeFile);
        }
      },
    });
  });
  if (!rendered) return;
  codePanelDirty = false;
}

function renderConflictPanelIfNeeded(force = false): void {
  if (!conflictDesktopDockview?.panelMounted("conflictResolver")) return;
  if (!force && !conflictPanelDirty) return;
  const rendered = conflictDesktopDockview.withPanel("conflictResolver", container => {
    renderConflictResolver(container, activeConflictResolverState(), {
      refresh: requestConflictScan,
      selectFile: requestConflictFile,
      leave: leaveConflictResolver,
      updateResult: updateConflictResultDraft,
      selectConflict: selectConflictBlock,
      shiftConflict: shiftConflictBlock,
      resolveConflict: resolveSelectedConflictBlock,
      previewMagicWand: previewConflictMagicWand,
      applyMagicWandPreview: applyConflictMagicWandPreview,
      discardMagicWandPreview: discardConflictMagicWandPreview,
      updateAgentInstructions: updateConflictAgentInstructions,
      requestAgentExplain: () => requestConflictAgentAssistance("explain", "selectedConflict"),
      requestAgentProposeConflict: () => requestConflictAgentAssistance("propose", "selectedConflict"),
      requestAgentProposeFile: () => requestConflictAgentAssistance("propose", "file"),
      applyAgentResult: applyConflictAgentResult,
      discardAgentResult: discardConflictAgentResult,
      saveResult: saveConflictResult,
      stageResolved: stageResolvedConflictFile,
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(".conflict-result-editor");
    if (textarea && conflictEditorSelection) {
      textarea.scrollTop = conflictEditorSelection.scrollTop;
      if (conflictEditorSelection.focused && !textarea.disabled) {
        textarea.focus();
        textarea.setSelectionRange(
          conflictEditorSelection.selectionStart,
          conflictEditorSelection.selectionEnd,
        );
      }
    }
  });
  if (!rendered) return;
  conflictPanelDirty = false;
}

// --- Panel render functions ---

function getCachedPanelRenderState(
  caches: WeakMap<HTMLElement, CachedPanelRenderState>,
  container: HTMLElement,
  revision: number,
): CachedPanelRenderState {
  let cache = caches.get(container);
  if (!cache) {
    cache = { keys: [], nodes: new Map<string, HTMLElement>(), revision };
    caches.set(container, cache);
  }
  return cache;
}

function clearCachedPanelRenderState(cache: CachedPanelRenderState): void {
  cache.keys = [];
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

  const fragment = mkFrag();
  const nextNodes = new Map<string, HTMLElement>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cachedNode = canReuseCache && i < items.length - 1 ? cache.nodes.get(item.key) : undefined;
    const node = cachedNode?.ownerDocument === container.ownerDocument ? cachedNode : item.render();
    nextNodes.set(item.key, node);
    fragment.append(node);
  }

  for (const node of trailingNodes) fragment.append(node);

  container.replaceChildren(fragment);
  cache.keys = items.map(item => item.key);
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
        key: `message:${entry.id}:${startIndex}:${transcriptReviewRenderKey(projection.summary.sessionId, entry.id)}`,
        render: () => renderMessage(entry, projection.summary.sessionId),
      });
      continue;
    }

    if (!showToolBubbles) continue;

    if (entry.toolName === "read" && !entry.isError) {
      const readCards = [entry];
      while (isCompactReadCard(projection.transcript[i + 1])) {
        readCards.push(projection.transcript[++i] as { kind: "tool" } & ToolCard);
      }
      items.push({
        key: `read-group:${startIndex}:${readCards.map(card => card.toolCallId).join("|")}`,
        render: () => (readCards.length === 1 ? renderReadToolCard(entry) : renderReadToolGroup(readCards)),
      });
      continue;
    }

    items.push({
      key: `tool:${entry.toolCallId}:${startIndex}`,
      render: () => renderToolCard(entry),
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
          onDiscuss: discussPendingPlanReview,
        },
        visiblePlanReview.mode,
        visiblePlanReview.mode === "refining" ? planReviewLineOptions(projection.summary.sessionId, visiblePlanReview.review) : undefined,
      ),
    });
  }
  return items;
}

function buildToolsRenderItems(tools: Array<{ kind: "tool" } & ToolCard>): PanelRenderItem[] {
  const items: PanelRenderItem[] = [];
  for (let i = 0; i < tools.length; i++) {
    const entry = tools[i];
    const startIndex = i;

    if (entry.toolName === "read" && !entry.isError) {
      const readCards = [entry];
      while (i + 1 < tools.length && isCompactReadCard(tools[i + 1])) {
        readCards.push(tools[++i]);
      }
      items.push({
        key: `read-group:${startIndex}:${readCards.map(card => card.toolCallId).join("|")}`,
        render: () => (readCards.length === 1 ? renderReadToolCard(entry) : renderReadToolGroup(readCards)),
      });
      continue;
    }

    items.push({
      key: `tool:${entry.toolCallId}:${startIndex}`,
      render: () => renderToolCard(entry),
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
  const restoreThinkingOpenState = !skipThinkingOpenRestoreOnce;
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

  renderCachedPanelItems(container, cache, buildToolsRenderItems(tools), 0);
}



function requestSessionChanges(sessionId: string): void {
  if (diffLoadingSessions.has(sessionId)) return;
  const diffId = newDiffId();
  setCurrentSessionChangesRequest(sessionId, diffId, "replaced");
  sessionChangesDiffIds.set(sessionId, diffId);
  diffErrors.delete(sessionId);
  diffLoadingSessions.add(sessionId);
  markDiffsViewDirty();
  const sent = send({ type: "sessionChanges.request", clientId: diffClientId, diffId, sessionId, repoId: null, detailMode: DEFAULT_SESSION_CHANGES_DETAIL_MODE, currentCommitOid: null, selectedFile: null });
  if (!sent) {
    if (currentSessionChangesRequest?.diffId === diffId) currentSessionChangesRequest = null;
    diffLoadingSessions.delete(sessionId);
    diffErrors.set(sessionId, "Not connected to the Fura bridge.");
  }
  renderDiffsViewIfActive(sessionId);
}

function requestSessionChangesRefresh(
  sessionId: string,
  options: { repoId?: string | null; payloadKind?: DiffDetailMode | null; currentCommitOid?: string | null } = {},
): void {
  if (diffLoadingSessions.has(sessionId)) return;
  const previousState = sessionChangesStates.get(sessionId);
  if (previousState?.status === "ready") clearDiffPatchCacheForComparison(previousState.comparison.comparisonKey);
  const repoId = options.repoId !== undefined
    ? options.repoId
    : previousState?.status === "ready"
      ? previousState.selectedRepoId
      : null;
  const detailMode = options.payloadKind
    ?? (previousState?.status === "ready"
      ? previousState.comparison.detailMode
      : sessionChangesPayloadKinds.get(sessionId) ?? DEFAULT_SESSION_CHANGES_DETAIL_MODE);
  const currentCommitOid = options.currentCommitOid !== undefined
    ? options.currentCommitOid
    : previousState?.status === "ready"
      ? previousState.review.currentCommitOid ?? null
      : null;
  diffErrors.delete(sessionId);
  diffLoadingSessions.add(sessionId);
  markDiffsViewDirty();
  const diffId = newDiffId();
  setCurrentSessionChangesRequest(sessionId, diffId, options.payloadKind ? "payloadChanged" : options.currentCommitOid !== undefined ? "refsChanged" : "refreshed");
  sessionChangesDiffIds.set(sessionId, diffId);
  const sent = send({
    type: "sessionChanges.request",
    clientId: diffClientId,
    diffId,
    sessionId,
    repoId,
    detailMode,
    currentCommitOid,
    selectedFile: null,
  });
  if (!sent) {
    if (currentSessionChangesRequest?.diffId === diffId) currentSessionChangesRequest = null;
    diffLoadingSessions.delete(sessionId);
    diffErrors.set(sessionId, "Not connected to the Fura bridge.");
  }
  renderDiffsViewIfActive(sessionId);
}

function requestSessionChangesRepo(sessionId: string, repoId: string, payloadKind: DiffDetailMode, currentCommitOid: string | null = null): void {
  if (diffLoadingSessions.has(sessionId)) return;
  diffErrors.delete(sessionId);
  diffLoadingSessions.add(sessionId);
  sessionChangesPayloadKinds.set(sessionId, payloadKind);
  markDiffsViewDirty();
  const diffId = newDiffId();
  setCurrentSessionChangesRequest(sessionId, diffId, "repoChanged");
  sessionChangesDiffIds.set(sessionId, diffId);
  const sent = send({ type: "sessionChanges.request", clientId: diffClientId, diffId, sessionId, repoId, detailMode: payloadKind, currentCommitOid, selectedFile: null });
  if (!sent) {
    if (currentSessionChangesRequest?.diffId === diffId) currentSessionChangesRequest = null;
    diffLoadingSessions.delete(sessionId);
    diffErrors.set(sessionId, "Not connected to the Fura bridge.");
  }
  renderDiffsViewIfActive(sessionId);
}

function defaultSnapshotLabel(now = new Date()): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(now);
}

type SnapshotRequestOptions = {
  repoRoot?: string;
  ref?: string;
};

function selectedSnapshotRepoRoot(sessionId: string): string {
  const state = sessionChangesStates.get(sessionId);
  if (state?.status !== "ready") return "";
  const selectedRepo = state.repos.find(repo => repo.id === state.selectedRepoId);
  return selectedRepo?.repoRoot || state.comparison.repoRoot || "";
}

function setSnapshotFormStatus(message: string, kind: "error" | "idle" = "idle"): void {
  snapshotFormStatus.textContent = message;
  snapshotFormStatus.classList.toggle("error", kind === "error");
}

function updateSnapshotExplicitFields(): void {
  const enabled = snapshotExplicitToggle.checked;
  snapshotExplicitFields.hidden = !enabled;
  snapshotRefInput.disabled = !enabled;
  snapshotRepoInput.disabled = !enabled;
  snapshotRefInput.required = enabled;
  if (enabled) {
    setSnapshotFormStatus("Git ref snapshots are resolved by OMP without checkout or worktree mutation.");
  } else {
    setSnapshotFormStatus("");
  }
}

function openSnapshotLabelPicker(sessionId: string): void {
  if (diffLoadingSessions.has(sessionId)) return;
  snapshotLabelSessionId = sessionId;
  snapshotLabelInput.value = defaultSnapshotLabel();
  snapshotExplicitToggle.checked = false;
  snapshotRefInput.value = "";
  snapshotRepoInput.value = selectedSnapshotRepoRoot(sessionId);
  updateSnapshotExplicitFields();
  snapshotLabelOverlay.hidden = false;
  window.setTimeout(() => {
    snapshotLabelInput.focus();
    snapshotLabelInput.select();
  }, 0);
}

function closeSnapshotLabelPicker(): void {
  snapshotLabelSessionId = null;
  snapshotLabelOverlay.hidden = true;
  promptInput.focus();
}

function submitSnapshotLabelPicker(): void {
  const sessionId = snapshotLabelSessionId;
  if (!sessionId) return;
  const label = snapshotLabelInput.value.trim() || defaultSnapshotLabel();
  const options: SnapshotRequestOptions = {};
  if (snapshotExplicitToggle.checked) {
    const ref = snapshotRefInput.value.trim();
    if (!ref) {
      setSnapshotFormStatus("Git ref is required for an explicit snapshot.", "error");
      snapshotRefInput.focus();
      return;
    }
    options.ref = ref;
    const repoRoot = snapshotRepoInput.value.trim();
    if (repoRoot) options.repoRoot = repoRoot;
  }
  snapshotLabelSessionId = null;
  snapshotLabelOverlay.hidden = true;
  requestSessionChangesSnapshot(sessionId, label, options);
}

function requestSessionChangesSnapshot(sessionId: string, label: string, options: SnapshotRequestOptions = {}): void {
  if (diffLoadingSessions.has(sessionId)) return;
  const state = sessionChangesStates.get(sessionId);
  const repoId = state?.status === "ready" ? state.selectedRepoId : null;
  const payloadKind = state?.status === "ready" ? state.comparison.detailMode : sessionChangesPayloadKinds.get(sessionId) ?? DEFAULT_SESSION_CHANGES_DETAIL_MODE;
  const currentCommitOid = state?.status === "ready" ? state.review.currentCommitOid ?? null : null;
  diffErrors.delete(sessionId);
  diffLoadingSessions.add(sessionId);
  markDiffsViewDirty();
  const diffId = newDiffId();
  sessionChangesDiffIds.set(sessionId, diffId);
  setCurrentSessionChangesRequest(sessionId, diffId, "refreshed");
  const sent = send({ type: "sessionChanges.snapshot", clientId: diffClientId, diffId, sessionId, repoId, label, repoRoot: options.repoRoot ?? null, ref: options.ref ?? null, detailMode: payloadKind, currentCommitOid, selectedFile: null });
  if (!sent) {
    diffLoadingSessions.delete(sessionId);
    diffErrors.set(sessionId, "Not connected to the Fura bridge.");
  }
  renderDiffsViewIfActive(sessionId);
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

function requestActiveDiffState(options: { refreshExisting?: boolean } = {}): void {
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
  if (!state) {
    requestSessionChanges(activeSessionId);
    return;
  }
  if (options.refreshExisting) {
    requestSessionChangesRefresh(
      activeSessionId,
      sessionChangesRefreshOptions(
        state,
        sessionChangesPayloadKinds.get(activeSessionId) ?? DEFAULT_SESSION_CHANGES_DETAIL_MODE,
      ),
    );
    return;
  }
  if (currentSessionChangesRequest?.sessionId !== activeSessionId || currentSessionChangesRequest?.diffId !== state.diffId) {
    currentSessionChangesRequest = { sessionId: activeSessionId, diffId: state.diffId };
  }
}

function activeSessionUsesDiffReviewWorkspace(): boolean {
  if (workspaceMode !== "session") return false;
  const summary = (activeSessionId ? projections.get(activeSessionId)?.summary : undefined) ?? (activeSessionId ? currentSessionSummary(activeSessionId) : undefined);
  return summary?.sessionMode === "diffReview";
}

function setActiveDesktopDockviewMode(mode: "normal" | "diffReview" | "conflictResolver"): boolean {
  const nextDockview = mode === "conflictResolver"
    ? conflictDesktopDockview
    : mode === "diffReview" ? diffReviewDesktopDockview : normalDesktopDockview;
  if (!nextDockview) return false;
  const normalHost = document.getElementById("normalWorkspacePanelHost");
  const reviewHost = document.getElementById("diffReviewWorkspacePanelHost");
  const conflictHost = document.getElementById("conflictResolverWorkspacePanelHost");
  normalHost?.classList.toggle("workspace-panel-host-active", mode === "normal");
  reviewHost?.classList.toggle("workspace-panel-host-active", mode === "diffReview");
  conflictHost?.classList.toggle("workspace-panel-host-active", mode === "conflictResolver");
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
    conflictPanelDirty = true;
  }
  return true;
}

function syncSessionModePanels(activateCreatedDiffReview = false): void {
  if (activeDesktopDockviewMode === "conflictResolver" && workspaceMode === "session") return;
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
  diffPreviewText.scrollTop = 0;
  diffPreviewText.focus();
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
  diffPreviewText.scrollTop = 0;
  diffPreviewText.focus();
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
    diffPreviewText.scrollTop = 0;
    diffPreviewText.focus();
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
  diffPreviewText.scrollTop = 0;
  diffPreviewText.focus();
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
    sendCodeComments(codeDraft.sessionId, codeDraft.file, codeDraft.comments, promptText);
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
  lastDiffsRenderedSessionId = activeSessionId;
  lastDiffsRenderedProjectionPresent = Boolean(projection);
  diffPanelDirty = false;
  container.replaceChildren();

  const root = mkEl("div");
  root.className = "diffs-view session-changes-view";
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
  renderSessionChangesView(activeSessionId, sidebarTop, sidebarScroll, main, container);
}

function renderSessionChangesView(sessionId: string, sidebarTop: HTMLElement, sidebar: HTMLElement, main: HTMLElement, container: HTMLElement): void {
  const projection = projections.get(sessionId);
  if (projection?.summary.sessionMode === "diffReview") {
    renderDiffReviewSessionView(sessionId, projection.summary, sidebarTop, sidebar, main, container);
    return;
  }
  const state = sessionChangesStates.get(sessionId);
  const error = diffErrors.get(sessionId);

  const header = mkEl("div");
  header.className = "diffs-toolbar";
  const title = mkEl("strong");
  title.textContent = "Session changes";
  const actions = mkEl("div");
  actions.className = "diffs-actions";
  const refresh = mkEl("button");
  refresh.type = "button";
  refresh.textContent = diffLoadingSessions.has(sessionId) ? "Loading…" : "Refresh";
  refresh.disabled = diffLoadingSessions.has(sessionId);
  refresh.addEventListener("click", () => requestSessionChangesRefresh(sessionId, sessionChangesRefreshOptions(state, sessionChangesPayloadKinds.get(sessionId) ?? DEFAULT_SESSION_CHANGES_DETAIL_MODE)));
  actions.append(refresh);
  const snapshot = mkEl("button");
  snapshot.type = "button";
  snapshot.textContent = "Snapshot now";
  snapshot.disabled = diffLoadingSessions.has(sessionId);
  snapshot.addEventListener("click", () => openSnapshotLabelPicker(sessionId));
  actions.append(snapshot);
  header.append(title, actions);
  main.append(header);

  if (!state) {
    renderDiffMessage(main, diffLoadingSessions.has(sessionId) ? "Loading session changes…" : "Session changes have not been loaded.", false);
    if (!diffLoadingSessions.has(sessionId)) requestSessionChanges(sessionId);
    return;
  }
  renderSessionRepoControls(sessionId, state, sidebarTop);
  if (error) {
    renderDiffMessage(main, error, true);
    return;
  }
  if (state.status === "missingRepo") {
    renderDiffMessage(main, state.reason, true);
    return;
  }
  if (state.status === "missingSnapshot") {
    renderDiffMessage(main, state.reason, true);
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
  container: HTMLElement,
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

function renderSessionRepoControls(sessionId: string, state: SessionChangesSummaryState, sidebar: HTMLElement): void {
  const section = mkEl("section");
  section.className = "diffs-repo-selector";
  const label = mkEl("label");
  label.className = "diffs-repo-label";
  label.textContent = "Repository";
  const select = mkEl("select");
  select.className = "diff-repo-select";
  for (const repo of state.repos) {
    const option = mkEl("option");
    option.value = repo.id;
    option.textContent = repo.label || formatDiffRepoLabel(repo.repoRoot);
    option.selected = state.status === "ready" ? repo.id === state.selectedRepoId : repo.repoRoot === (state.status === "missingSnapshot" ? state.repoRoot : "");
    select.append(option);
  }
  const currentPayload = state.status === "ready" ? state.comparison.detailMode : sessionChangesPayloadKinds.get(sessionId) ?? DEFAULT_SESSION_CHANGES_DETAIL_MODE;
  select.addEventListener("change", () => requestSessionChangesRepo(sessionId, select.value, currentPayload));
  section.append(label, select);
  sidebar.append(section);
}

function renderComparePanel(container: HTMLElement): void {
  setRenderDocument(container.ownerDocument);
  comparePanelDirty = false;
  container.replaceChildren();

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
  if (!diffId || !summary || pendingDiffFilePatchMatches(annotationKey, diffId, key, filePath)) return;
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
  const cached = diffPatchCache.get(diffPatchCacheKey(key, filePath));
  const currentContext = cached?.contextLines ?? state.comparison.contextLines ?? 3;
  requestDiffContent(annotationKey, state, filePath, requestMode, Math.min(currentContext + 10, 200));
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
  const summary = mkEl("section");
  summary.className = "diffs-summary";
  const comparison = mkEl("p");
  comparison.textContent = `${resolvedRefLabel(state.comparison.base)} → ${resolvedRefLabel(state.comparison.head)}`;
  const commits = mkEl("p");
  commits.textContent = state.review.currentCommitOid ? `Commit ${(state.review.currentCommitIndex ?? 0) + 1}/${state.review.commits.length}` : `Range · ${state.review.commits.length} commit${state.review.commits.length === 1 ? "" : "s"}`;
  summary.append(comparison, commits);
  main.append(summary);
  const selectedCommit = selectedFilePath === null && state.review.currentCommitOid
    ? state.review.commits.find(commit => commit.oid === state.review.currentCommitOid) ?? null
    : null;

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
      requestSessionChangesRefresh(annotationKey, { payloadKind: nextPayload, currentCommitOid: state.review.currentCommitOid ?? null });
    }
  });
  toolbar.append(payloadToggle);
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
    } else {
      requestSessionChangesRefresh(annotationKey, { currentCommitOid: selected });
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
      } else {
        requestSessionChangesRefresh(annotationKey, { currentCommitOid: selected });
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
    } else {
      requestSessionChangesRefresh(annotationKey, { currentCommitOid: oid });
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
    } else {
      requestSessionChangesRefresh(annotationKey, { currentCommitOid: oid });
    }
  });
  toolbar.append(prev, next);
  if (state.review.currentCommitOid) {
    const checkout = mkEl("button");
    checkout.type = "button";
    checkout.textContent = "Checkout commit";
    checkout.addEventListener("click", () => ensureReviewWorktreeThenCheckout(state, { kind: "commit", oid: state.review.currentCommitOid! }));
    toolbar.append(checkout);
  }
  if (selectedFilePath) {
    const code = mkEl("button");
    code.type = "button";
    code.textContent = "Code";
    code.title = `Open ${selectedFilePath} in Code`;
    code.addEventListener("click", () => openDiffFileInCode(state, selectedFilePath));
    toolbar.append(code);
  }
  if (allowPromptActions) {
    const promptMode: DiffAnnotationPromptMode = requestMode === "sessionChanges" || annotationKey !== "compareDiff" ? "sessionChanges" : "comparisonReview";
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
  main.append(toolbar);

  const body = mkEl("div");
  body.className = "diffs-main-body";
  if (selectedCommit) {
    const messageBlock = mkEl("section");
    messageBlock.className = "diff-commit-message";
    const heading = mkEl("strong");
    heading.textContent = "Commit message";
    const messageText = mkEl("pre");
    messageText.textContent = selectedCommit.message || selectedCommit.subject;
    messageBlock.append(heading, messageText);
    body.append(messageBlock);
  }
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
  const preservedHeader = [...main.children].find((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("diffs-toolbar")) ?? null;
  main.replaceChildren(...(preservedHeader ? [preservedHeader] : []));
  renderReviewableDiffMainContent(
    annotationKey,
    state,
    main,
    annotationKey !== "compareDiff",
    diffRequestModeForAnnotationKey(annotationKey),
  );
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
    meta.textContent = `+${file.added} -${file.removed}${notes ? ` · ${notes}` : ""}`;
    const jump = mkEl("button");
    jump.type = "button";
    jump.className = `diffs-file-jump${file.filePath === selectedFilePath ? " active" : ""}`;
    jump.title = "Click to select. Right-click for file actions.";
    jump.dataset.diffFilePath = file.filePath;
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
    item.append(jump);
    if (openDiffFileMenu?.annotationKey === annotationKey && openDiffFileMenu.filePath === file.filePath) {
      const menu = mkEl("div");
      menu.className = "diffs-file-menu";
      const openInCode = mkEl("button");
      openInCode.type = "button";
      openInCode.className = "diffs-file-menu-item";
      openInCode.textContent = "Open in Code";
      openInCode.addEventListener("click", event => {
        event.stopPropagation();
        openDiffFileMenu = null;
        openDiffFileInCode(state, file.filePath);
      });
      menu.append(openInCode);
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
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    appendDiffRow(fragment, row, annotationKey, state, annotations, comments, key, allowPromptActions, requestMode);
  }
  diff.append(fragment);
  container.append(diff);
}

function appendDiffRow(diff: HTMLElement | DocumentFragment, row: DiffRow, annotationKey: string, state: DiffReviewableState, annotations: DiffReviewAnnotation[], comments: ReviewComment[], key: string, allowPromptActions: boolean, requestMode: "sessionChanges" | "compareDiff"): void {
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
    gutter.textContent = row.location.newLine !== undefined ? String(row.location.newLine) : String(row.location.oldLine ?? "");
    const content = mkEl("div");
    content.className = "diff-line-content";
    const text = mkEl("code");
    text.textContent = row.location.text;
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
    more.title = "Ask Fura to reload this file with wider git diff context.";
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
      if (id === "tools") markToolsViewDirty();
      if (id === "diffs") markDiffsViewDirty();
      if (id === "sessionChanges") markDiffsViewDirty();
      if (id === "compare") markComparePanelDirty();
      if (id === "code") markCodeViewDirty();
      if (id === "conflictResolver") markConflictViewDirty();
    },
    onPanelActivated: (id: Parameters<DesktopDockview["withPanel"]>[0]) => {
      const projection = activeSessionId ? projections.get(activeSessionId) : undefined;
      if (id === "transcript") {
        renderTranscriptPanelIfNeeded(projection, true);
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
      if (id === "conflictResolver") {
        renderConflictPanelIfNeeded(true);
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
    onPanelClosed: (id: "sessionChanges" | "diffs" | "compare") => {
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
  conflictDesktopDockview = initDesktopDockview({
    host: requireElement<HTMLDivElement>("conflictResolverWorkspacePanelHost"),
    layoutMode: "conflictResolver",
    storageKey: "fura.dockview.conflictResolver.layout",
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
  if (projection.contextPercent != null && projection.contextWindow != null) {
    parts.push(statusPart(formatContext(projection.contextPercent, projection.contextWindow), "context"));
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
  cwdPickerConflictTab.disabled = pending;
  cwdPickerNameInput.disabled = pending;
  cwdPickerInput.disabled = pending;
  cwdPickerWorktreeEnabled.disabled = pending;
  cwdPickerWorktreeSourceRepo.disabled = pending;
  cwdPickerWorktreeBase.disabled = pending;
  cwdPickerWorktreeBranch.disabled = pending;
  cwdPickerProposedModel.disabled = pending;
  cwdPickerDiffRepo.disabled = pending;
  cwdPickerDiffBase.disabled = pending;
  cwdPickerDiffHead.disabled = pending;
  cwdPickerDiffMode.disabled = pending;
  cwdPickerDiffAgentSession.disabled = pending;
  cwdPickerConflictRepo.disabled = pending;
  cwdPickerClose.disabled = pending;
  cwdPickerCancel.disabled = pending;
  cwdPickerCreate.disabled = pending;
  const actionLabel = cwdPickerMode === "diff" ? "Open diff" : cwdPickerMode === "conflict" ? "Create session for Conflict Resolver" : "Create session";
  cwdPickerCreate.textContent = pending ? (cwdPickerMode === "diff" ? "Opening…" : "Creating…") : actionLabel;
  cwdPickerCreate.toggleAttribute("aria-busy", pending);
  if (pending) {
    const status = cwdPickerMode === "diff"
      ? "Opening diff…"
      : cwdPickerMode === "conflict"
        ? "Creating session for Conflict Resolver…"
        : "Creating session…";
    setCwdPickerStatus(status, "loading");
  }
}

function nextClientRequestId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function handleCwdPickerCreateError(requestId: string | null, message: string): boolean {
  if (!cwdPickerCreatePending || !cwdPickerPendingRequestId || requestId !== cwdPickerPendingRequestId) {
    return false;
  }
  pendingCreatedSessionBaseline = null;
  pendingDiffCreate = null;
  pendingConflictResolverCreate = false;
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

function setCwdPickerMode(mode: "session" | "diff" | "conflict"): void {
  cwdPickerMode = mode;
  const sessionMode = mode === "session";
  const diffMode = mode === "diff";
  const conflictMode = mode === "conflict";
  cwdPickerSessionTab.classList.toggle("active", sessionMode);
  cwdPickerDiffTab.classList.toggle("active", diffMode);
  cwdPickerConflictTab.classList.toggle("active", conflictMode);
  cwdPickerSessionTab.setAttribute("aria-selected", String(sessionMode));
  cwdPickerDiffTab.setAttribute("aria-selected", String(diffMode));
  cwdPickerConflictTab.setAttribute("aria-selected", String(conflictMode));
  cwdPickerSessionBody.hidden = !sessionMode;
  cwdPickerDiffBody.hidden = !diffMode;
  cwdPickerConflictBody.hidden = !conflictMode;
  if (sessionMode) {
    cwdPickerTitle.textContent = "New session";
    cwdPickerDescription.textContent = "Choose the working directory for the new OMP session. Optionally create a git worktree first.";
  } else if (diffMode) {
    cwdPickerTitle.textContent = "Diff";
    cwdPickerDescription.textContent = "Open a repository comparison directly or create a dedicated diff-review session.";
  } else {
    cwdPickerTitle.textContent = "Conflict Resolver";
    cwdPickerDescription.textContent = "Create a normal OMP session for resolving conflicts in a specific repository.";
  }
  if (!cwdPickerCreatePending) {
    cwdPickerCreate.textContent = diffMode
      ? "Open diff"
      : conflictMode
        ? "Create session for Conflict Resolver"
        : "Create session";
  }
}

function syncCwdPickerDiffDefaults(): void {
  const defaultRoot = cwdPickerInput.value.trim() || serverConfig?.defaultCwd || "";
  cwdPickerDiffRepo.value = defaultRoot;
  cwdPickerDiffBase.value = "HEAD";
  cwdPickerDiffHead.value = "HEAD";
  cwdPickerDiffMode.value = "full";
  cwdPickerDiffAgentSession.checked = true;
}

function syncCwdPickerConflictDefaults(): void {
  cwdPickerConflictRepo.value = serverConfig?.defaultCwd ?? "";
}

function openCwdPicker(initialMode: "session" | "diff" | "conflict" = "session"): void {
  const config = requireServerConfig();
  if (!config) return;
  pendingDiffCreate = null;
  pendingConflictResolverCreate = false;
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
  syncCwdPickerConflictDefaults();
  setCwdPickerMode(initialMode);
  cwdPickerOverlay.hidden = false;
  window.setTimeout(() => {
    const focusTarget = initialMode === "diff"
      ? cwdPickerDiffRepo
      : initialMode === "conflict"
        ? cwdPickerConflictRepo
        : cwdPickerNameInput;
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

function submitCwdPickerDiff(): void {
  if (cwdPickerCreatePending) return;
  const repoRoot = cwdPickerDiffRepo.value.trim();
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

function submitCwdPickerConflict(requestId: string): void {
  if (cwdPickerCreatePending) return;
  const repoRoot = cwdPickerConflictRepo.value.trim();
  if (!repoRoot) {
    setCwdPickerError("Repository root is required for Conflict Resolver.");
    cwdPickerConflictRepo.focus();
    return;
  }
  const result = resolveSessionCreateMessage({
    requestId,
    name: `conflicts: ${repoRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? "repo"}`,
    cwd: repoRoot,
    worktree: { enabled: false, sourceRepo: repoRoot, directory: repoRoot, baseBranch: "", branchName: undefined },
  });
  if (result.type === "invalid") {
    setCwdPickerError(result.message);
    cwdPickerConflictRepo.focus();
    return;
  }
  pendingConflictResolverCreate = true;
  conflictResolverSessionId = null;
  pendingCreatedSessionBaseline = new Set(sessions.map(s => s.sessionId));
  setCwdPickerCreatePending(true, requestId);
  if (!send(result.message)) {
    pendingCreatedSessionBaseline = null;
    pendingConflictResolverCreate = false;
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
  if (cwdPickerMode === "conflict") {
    submitCwdPickerConflict(requestId);
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
  pendingConflictResolverCreate = false;
  pendingCreatedSessionBaseline = new Set(sessions.map(s => s.sessionId));
  setCwdPickerCreatePending(true, requestId);
  const message = result.message;
  if (!send(message)) {
    pendingCreatedSessionBaseline = null;
    setCwdPickerCreatePending(false);
    setCwdPickerError("Not connected to the Fura bridge.");
  }
}

function openForkPicker(): void {
  forkPickerNameInput.value = "";
  forkPickerOverlay.hidden = false;
  window.setTimeout(() => forkPickerNameInput.focus(), 0);
}

function closeForkPicker(): void {
  forkPickerOverlay.hidden = true;
  promptInput.focus();
}

function submitForkPicker(): void {
  if (!activeSessionId) return;
  const name = forkPickerNameInput.value.trim();
  if (!name) return;
  pendingCreatedSessionBaseline = new Set(sessions.map(s => s.sessionId));
  send({ type: "session.fork", sessionId: activeSessionId, name });
  closeForkPicker();
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
  const matches = fuzzyMatchCommands(query).filter(cmd => cmd.support === "supported");
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
