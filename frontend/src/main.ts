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
  diffEndpointInputText,
  diffPayloadFiles,
  diffPayloadText,
  diffPayloadTruncated,
  diffRefInputFromText,
  diffRefInputText,
  formatDiffRepoLabel,
  isFullPatchPayload,
  parseDiffRows,
  resolvedRefLabel,
  summarizeDiffFiles,
  summarizeWireDiffFiles,
} from "./diffState";
import {
  annotationsForDiffLocation,
  buildDiffCommentPrompt,
  buildDiffQuestionPrompt,
  checkoutTargetForDiffLocation,
  createDiffReviewAnnotation,
  diffCommentFlushEditorText,
  diffCommentPreviewStatus,
  formatDiffLineLocation,
  formatDiffLocation,
  pathForDiffLocation,
  removeSelectedDiffComments,
  selectedDiffAnnotations,
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
import { deriveSessionDeleteView, sessionDeleteMessage, type SessionDeleteView } from "./sessionDelete";
import { createSessionListView, renderSessionCategoryFilter } from "./sessionListView";
import {
  createCategoryCombobox,
  handleCategoryComboboxKeydown,
  hideCategoryCombobox,
  type CategoryCombobox,
} from "./categoryCombobox";
import {
  extensionDialogBodyText,
  formatExtensionDialogNotification,
  parseExtensionDialogRequest,
  type ExtensionDialogRequest,
} from "./extensionDialog";
import { initDesktopDockview, type DesktopDockview } from "./desktopDockview";
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
import type {
  ClientMessage,
  CodeFileContent,
  CodeTreeEntry,
  CodeWorkspaceSummary,
  ControlCandidate,
  ControlStatusProjection,
  ControlSuggestedAction,
  CompareDiffState,
  DiffCheckoutTarget,
  DiffPayloadKind,
  DiffReviewAnnotation,
  DiffLineLocation,
  DiffReviewWorktree,
  DiffReviewableState,
  FrontendControlAction,
  FrontendUiSnapshot,
  ModelSummary,
  ServerConfig,
  ServerMessage,
  SessionChangesState,
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
        <button id="createSessionButton" type="button">New session</button>
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

      <div id="workspacePanelHost" class="workspace-panel-host"></div>

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

  <div id="cwdPickerOverlay" class="modal-overlay" hidden>
    <section class="cwd-picker modal-panel" role="dialog" aria-modal="true" aria-labelledby="cwdPickerTitle">
      <header class="modal-header">
        <div>
          <h2 id="cwdPickerTitle">New session</h2>
          <p>Choose the working directory for the new OMP session. Optionally create a git worktree first.</p>
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
const thinkingVisibilityToggle = requireElement<HTMLButtonElement>("thinkingVisibilityToggle");
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
const cwdPickerNameInput = requireElement<HTMLInputElement>("cwdPickerNameInput");
const cwdPickerCategoryInput = requireElement<HTMLInputElement>("cwdPickerCategoryInput");
const cwdPickerCategorySuggestions = requireElement<HTMLDivElement>("cwdPickerCategorySuggestions");
const cwdPickerInput = requireElement<HTMLInputElement>("cwdPickerInput");
const cwdPickerSessionBody = requireElement<HTMLDivElement>("cwdPickerSessionBody");
const cwdPickerInputLabel = requireElement<HTMLLabelElement>("cwdPickerInputLabel");
const cwdPickerInputHelp = requireElement<HTMLParagraphElement>("cwdPickerInputHelp");
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
let cwdPickerMode: "session" | "diff" = "session";
let pendingDiffCreate: { repoRoot: string; base: string; head: string; payloadKind: DiffPayloadKind } | null = null;
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
let projections = new Map<string, SessionProjection>();
const sessionChangesStates = new Map<string, SessionChangesState>();
const sessionChangesPayloadKinds = new Map<string, DiffPayloadKind>();
let compareDiffState: CompareDiffState | null = null;
let compareRepoRoot = "";
let compareBaseRef = "HEAD";
let compareHeadRef = "WORKTREE";
let comparePayloadKind: DiffPayloadKind = "fullPatch";
let diffProductView: "sessionChanges" | "compare" = "sessionChanges";
let sessionChangesSubview: "diff" | "transcript" = "diff";
const diffAnnotations = new Map<string, DiffReviewAnnotation[]>();
const diffReviewWorktrees = new Map<string, DiffReviewWorktree>();
const diffErrors = new Map<string, string>();
const diffLoadingSessions = new Set<string>();
let diffPanelDirty = true;
let lastDiffsRenderedSessionId: string | null = null;
let lastDiffsRenderedProjectionPresent = false;
const sessionNotices = new Map<string, SessionNotice[]>();
let busyPromptDraft: BusyPromptDraft | null = null;
let diffPreviewDraft: DiffPreviewDraft | null = null;
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

type CodeOpenRequest =
  | { source: "sessionWorktree"; sessionId: string; path: string }
  | { source: "reviewCommit"; repoRoot: string; reviewWorktreeId?: string | null; target: DiffCheckoutTarget; path: string };

// --- Desktop workspace state ---

let desktopDockview: DesktopDockview | null = null;
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
  setWorkspaceOptionsOpen(false);
});
thinkingVisibilityToggle.addEventListener("click", () => {
  const nextMode = nextThinkingVisibilityMode(thinkingVisibilityMode);
  if (!send({ type: "config.set", thinkingVisibility: nextMode })) return;
  applyVisibilityPreferences(showToolBubbles, nextMode);
  setWorkspaceOptionsOpen(false);
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
  if (workspaceOptionsOpen && event.key === "Escape") {
    setWorkspaceOptionsOpen(false);
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
extensionDialogClose.addEventListener("click", () => respondToActiveExtensionDialog({ cancelled: true }));
extensionDialogCancel.addEventListener("click", () => respondToActiveExtensionDialog({ cancelled: true }));
extensionDialogOverlay.addEventListener("mousedown", event => {
  if (event.target === extensionDialogOverlay) respondToActiveExtensionDialog({ cancelled: true });
});
extensionDialogOverlay.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); respondToActiveExtensionDialog({ cancelled: true }); }
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

function activateSession(sessionId: string): void {
  const previousMode = workspaceMode;
  const sessionChanged = activeSessionId !== sessionId || workspaceMode !== "session";
  if (sessionChanged) {
    if (previousMode === "controller") {
      controllerPromptDraft = promptInput.value;
      promptInput.value = sessionPromptDraft;
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
      break;
    case "config.updated":
      serverConfig = message.config;
      applyVisibilityPreferences(
        parseToolVisibility(message.config.showTools),
        parseThinkingVisibilityMode(message.config.thinkingVisibility),
      );
      break;
    case "sessions.snapshot":
      {
        const previousActiveSessionId = activeSessionId;
        ({ sessions, activeSessionId } = applySessionsSnapshot(message.sessions, activeSessionId));
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
          setCwdPickerCreatePending(false);
          closeCwdPicker();
          if (pendingDiffCreate) {
            const diff = pendingDiffCreate;
            pendingDiffCreate = null;
            compareRepoRoot = diff.repoRoot;
            compareBaseRef = diff.base;
            compareHeadRef = diff.head;
            comparePayloadKind = diff.payloadKind;
            desktopDockview?.activatePanel("diffs");
            requestCompareDiff({ repoRoot: diff.repoRoot, base: diff.base, head: diff.head, payloadKind: diff.payloadKind, currentCommitOid: null });
          }
        }
      } else {
        unreadSessions.add(message.sessionId);
        renderSessions();
      }
      break;
    }
    case "sessionChanges.state": {
      const state = message.state;
      diffLoadingSessions.delete(state.sessionId);
      diffErrors.delete(state.sessionId);
      sessionChangesStates.set(state.sessionId, state);
      if (state.status === "ready") {
        sessionChangesPayloadKinds.set(state.sessionId, state.range.payload.kind);
        if (state.reviewWorktree) diffReviewWorktrees.set(state.reviewWorktree.sourceRepoRoot, state.reviewWorktree);
      }
      markDiffsViewDirty();
      if (state.sessionId === activeSessionId && desktopDockview?.isPanelActive("diffs")) {
        desktopDockview.withPanel("diffs", container => renderDiffsView(container, projections.get(state.sessionId)));
      }
      break;
    }
    case "compareDiff.state": {
      compareDiffState = message.state;
      diffErrors.delete("compareDiff");
      if (message.state.reviewWorktree) diffReviewWorktrees.set(message.state.reviewWorktree.sourceRepoRoot, message.state.reviewWorktree);
      markDiffsViewDirty();
      renderDiffsViewIfActive(activeSessionId ?? "");
      break;
    }
    case "diff.error": {
      const errorKey = message.scope === "compareDiff" ? "compareDiff" : message.sessionId ?? activeSessionId;
      if (message.sessionId) diffLoadingSessions.delete(message.sessionId);
      if (errorKey) {
        diffErrors.set(errorKey, message.message);
        markDiffsViewDirty();
        if (message.scope === "compareDiff" || message.sessionId === activeSessionId) renderDiffsViewIfActive(activeSessionId ?? "");
      } else {
        appendLog(`diff error: ${message.message}`);
      }
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
    case "plan.review": {
      const preview = message.content.length > 6000 ? `${message.content.slice(0, 6000)}\n\n… truncated …` : message.content;
      const approved = window.confirm(
        `Plan ready${message.title ? `: ${message.title}` : ""}\n\n${preview}\n\nApprove and execute this plan? Press Cancel to stay in plan mode.`,
      );
      if (approved) {
        send({
          type: "raw.rpc",
          sessionId: message.sessionId,
          command: {
            type: "approve_plan_mode",
            planFilePath: message.planFilePath,
            finalPlanFilePath: message.finalPlanFilePath,
          },
        });
      } else {
        appendSessionNotice(message.sessionId, {
          level: "info",
          text: "Stayed in plan mode. Type a refinement prompt to continue planning.",
        });
        render();
      }
      break;
    }
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

function approvePendingPlanReview(review: PendingPlanReview): void {
  const accepted = send(createApprovePlanReviewMessage(review));
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
    const target = extensionDialogField.querySelector<HTMLElement>("[data-dialog-value]") ?? extensionDialogSubmit;
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

function visibleSessions(): SessionSummary[] {
  return filterVisibleSessions(sessions, selectedCategoryFilter);
}

function currentSessionSummary(sessionId: string): SessionSummary | undefined {
  return sessions.find(session => session.sessionId === sessionId);
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
    renderBusyPromptChoice();
    renderActiveDockviewPanel(undefined);
    return;
  }

  const projection = activeSessionId ? projections.get(activeSessionId) : undefined;
  const hasBusyDraft = busyPromptDraft?.sessionId === activeSessionId;

  abortButton.disabled = !activeSessionId;
  stopButton.disabled = !activeSessionId;
  deleteSessionButton.disabled = !activeSessionId;
  syncActiveCategoryEditor(projection);
  promptInput.disabled = !activeSessionId || hasBusyDraft;
  sendButton.disabled = !activeSessionId || hasBusyDraft;

  if (!activeSessionId || !projection) {
    sessionTitle.textContent = "No session selected";
    sessionMeta.textContent = "Create or attach to a session to begin.";
    promptInput.placeholder = "Select a session first";
  } else {
    sessionTitle.textContent = projection.summary.title || `Session ${shortId(activeSessionId)}`;
    const category = normalizedCategory(projection.summary.category);
    const categoryPart = category ? ` · ${category}` : "";
    sessionMeta.textContent = `${sessionKindLabel(projection.summary.kind)} · ${sessionStatusLabel(projection.summary)}${categoryPart} · ${projection.summary.cwd ?? "no dir"}`;
    promptInput.placeholder = "Send a prompt… (type / for commands)";
  }

  renderStatusBar(projection);
  renderBusyPromptChoice();
  renderActiveDockviewPanel(projection);
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

function ensureActiveCodeWorkspace(): void {
  if (!desktopDockview?.isPanelActive("code")) return;
  const sessionId = workspaceMode === "session" ? activeSessionId : null;
  if (codeSessionId !== sessionId) resetCodeViewForSession(sessionId);
  if (!sessionId || codeWorkspace || codeLoadingWorkspace) return;
  codeLoadingWorkspace = true;
  codeError = null;
  markCodeViewDirty();
  send({ type: "code.workspace.open", sessionId });
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

function sendCodeComments(sessionId: string, file: CodeFileContent, comments: CodeFileComment[]): void {
  if (comments.length === 0) return;
  const clearFlushedComments = () => {
    const commentsByFile = sessionCodeComments(sessionId);
    commentsByFile.set(file.path, removeSelectedCodeComments(commentsByFile.get(file.path) ?? [], file.path));
    markCodeViewDirty();
    renderCodePanelIfNeeded(true);
  };
  sendPromptWithBusyHandling({
    sessionId,
    text: buildCodeCommentPrompt(file, comments),
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
  diffPreviewTitle.textContent = "Preview code comments";
  diffPreviewSubtitle.textContent = "Review the prompt that will be sent to OMP.";
  diffPreviewSend.textContent = "Send comments";
  diffPreviewText.value = buildCodeCommentPrompt(file, comments);
  diffPreviewStatus.textContent = codeCommentPreviewStatus(comments.length);
  diffPreviewOverlay.hidden = false;
  diffPreviewText.scrollTop = 0;
  diffPreviewSend.focus();
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
      ensureActiveCodeWorkspace();
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
  const worktree = diffReviewWorktrees.get(state.range.repoRoot) ?? state.reviewWorktree ?? null;
  if (!worktree) {
    send({ type: "diff.reviewWorktree.ensure", sourceRepoRoot: state.range.repoRoot, target });
    return;
  }
  send({ type: "diff.reviewWorktree.checkout", worktreeId: worktree.id, ref: target });
}

function openDiffLocationInCode(state: DiffReviewableState, location: DiffLineLocation): void {
  const target = checkoutTargetForDiffLocation(state, location);
  const path = pathForDiffLocation(location);
  if (target.kind === "workingTree") {
    const sessionId = workspaceMode === "session" ? activeSessionId : null;
    if (!sessionId) return;
    openCodeRequest({ source: "sessionWorktree", sessionId, path });
    return;
  }
  openCodeRequest({ source: "reviewCommit", repoRoot: state.range.repoRoot, target, path });
}


function renderActiveDockviewPanel(projection: SessionProjection | undefined): void {
  renderTranscriptPanelIfNeeded(projection);
  renderToolsPanelIfNeeded(projection);
  if (desktopDockview?.isPanelActive("diffs") && shouldRenderDiffsView(projection)) {
    desktopDockview.withPanel("diffs", container => renderDiffsView(container, projection));
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

function firstChangedPanelItemIndex(previousKeys: string[], items: PanelRenderItem[]): number {
  const sharedLength = Math.min(previousKeys.length, items.length);
  for (let i = 0; i < sharedLength; i++) {
    if (previousKeys[i] !== items[i]?.key) return i;
  }
  return previousKeys.length === items.length ? items.length : sharedLength;
}

function firstPanelItemRenderIndex(cache: CachedPanelRenderState, items: PanelRenderItem[], revision: number): number {
  if (cache.revision !== revision || cache.keys.length === 0) return 0;
  const firstChangedIndex = firstChangedPanelItemIndex(cache.keys, items);
  if (firstChangedIndex === items.length && cache.keys.length === items.length) {
    return Math.max(0, items.length - 1);
  }
  return Math.max(0, Math.min(firstChangedIndex, cache.keys.length - 1));
}

function renderCachedPanelItems(
  container: HTMLElement,
  cache: CachedPanelRenderState,
  items: PanelRenderItem[],
  revision: number,
  trailingNodes: Node[] = [],
): void {
  const renderFromIndex = firstPanelItemRenderIndex(cache, items, revision);
  const fragment = mkFrag();
  const nextNodes = new Map<string, HTMLElement>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cachedNode = i < renderFromIndex ? cache.nodes.get(item.key) : undefined;
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

function buildTranscriptRenderItems(projection: SessionProjection): PanelRenderItem[] {
  const items: PanelRenderItem[] = [];
  for (let i = 0; i < projection.transcript.length; i++) {
    const entry = projection.transcript[i];
    const startIndex = i;

    if (entry.kind === "message") {
      items.push({
        key: `message:${entry.id}:${startIndex}`,
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
    items.push({
      key: `plan-review:${planReviewRenderKey(visiblePlanReview.review, visiblePlanReview.mode)}`,
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
  diffErrors.delete(sessionId);
  diffLoadingSessions.add(sessionId);
  markDiffsViewDirty();
  send({ type: "sessionChanges.open", sessionId });
  renderDiffsViewIfActive(sessionId);
}

function requestSessionChangesRefresh(
  sessionId: string,
  options: { repoId?: string | null; payloadKind?: DiffPayloadKind | null; currentCommitOid?: string | null } = {},
): void {
  if (diffLoadingSessions.has(sessionId)) return;
  diffErrors.delete(sessionId);
  diffLoadingSessions.add(sessionId);
  markDiffsViewDirty();
  send({
    type: "sessionChanges.refresh",
    sessionId,
    repoId: options.repoId ?? null,
    payloadKind: options.payloadKind ?? sessionChangesPayloadKinds.get(sessionId) ?? "statOnly",
    currentCommitOid: options.currentCommitOid ?? null,
  });
  renderDiffsViewIfActive(sessionId);
}

function requestSessionChangesRepo(sessionId: string, repoId: string, payloadKind: DiffPayloadKind, currentCommitOid: string | null = null): void {
  if (diffLoadingSessions.has(sessionId)) return;
  diffErrors.delete(sessionId);
  diffLoadingSessions.add(sessionId);
  sessionChangesPayloadKinds.set(sessionId, payloadKind);
  markDiffsViewDirty();
  send({ type: "sessionChanges.selectRepo", sessionId, repoId, payloadKind, currentCommitOid });
  renderDiffsViewIfActive(sessionId);
}

function requestCompareDiff(overrides: { repoRoot?: string; base?: string; head?: string; payloadKind?: DiffPayloadKind; currentCommitOid?: string | null } = {}): void {
  const repoRoot = overrides.repoRoot?.trim() || compareRepoRoot.trim();
  if (!repoRoot) {
    diffErrors.set("compareDiff", "Compare diff requires a repository root.");
    markDiffsViewDirty();
    renderDiffsViewIfActive(activeSessionId ?? "");
    return;
  }
  compareRepoRoot = repoRoot;
  compareBaseRef = overrides.base ?? compareBaseRef;
  compareHeadRef = overrides.head ?? compareHeadRef;
  comparePayloadKind = overrides.payloadKind ?? comparePayloadKind;
  const base = diffRefInputFromText(compareBaseRef, { kind: "gitRef", value: "HEAD" });
  const head = diffRefInputFromText(compareHeadRef, { kind: "workingTree" });
  diffErrors.delete("compareDiff");
  markDiffsViewDirty();
  send({
    type: "compareDiff.run",
    requestId: `compare-${Date.now()}`,
    repoRoot,
    base,
    head,
    payloadKind: comparePayloadKind,
    currentCommitOid: overrides.currentCommitOid ?? null,
  });
  renderDiffsViewIfActive(activeSessionId ?? "");
}

function renderDiffsViewIfActive(sessionId: string): void {
  if (desktopDockview?.isPanelActive("diffs")) {
    desktopDockview.withPanel("diffs", container => renderDiffsView(container, sessionId ? projections.get(sessionId) : undefined));
  }
}

function markDiffsViewDirty(): void {
  diffPanelDirty = true;
}

function shouldRenderDiffsView(projection: SessionProjection | undefined): boolean {
  return (
    diffPanelDirty ||
    activeSessionId !== lastDiffsRenderedSessionId ||
    Boolean(projection) !== lastDiffsRenderedProjectionPresent
  );
}

function isDiffsPanelActive(): boolean {
  return desktopDockview?.isPanelActive("diffs") ?? false;
}

function requestActiveDiffState(): void {
  if (!activeSessionId || !isDiffsPanelActive()) return;
  if (!projections.has(activeSessionId) || diffLoadingSessions.has(activeSessionId)) return;
  if (!sessionChangesStates.has(activeSessionId)) requestSessionChanges(activeSessionId);
}

function rerenderDiffsViewPreservingScroll(sessionId: string): void {
  if (!desktopDockview?.isPanelActive("diffs")) return;
  desktopDockview.withPanel("diffs", container => {
    const mainBody = container.querySelector<HTMLElement>(".diffs-main-body");
    const sidebarScroll = container.querySelector<HTMLElement>(".diffs-sidebar-scroll");
    const mainScrollTop = mainBody?.scrollTop ?? 0;
    const sidebarScrollTop = sidebarScroll?.scrollTop ?? 0;

    renderDiffsView(container, projections.get(sessionId));

    const nextMainBody = container.querySelector<HTMLElement>(".diffs-main-body");
    const nextSidebarScroll = container.querySelector<HTMLElement>(".diffs-sidebar-scroll");
    if (nextMainBody) nextMainBody.scrollTop = mainScrollTop;
    if (nextSidebarScroll) nextSidebarScroll.scrollTop = sidebarScrollTop;
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
  markTranscriptViewDirty({ resetCache: true });
  render();
}

function cancelTranscriptReview(sessionId: string, message: TranscriptMessage): void {
  transcriptReviewActiveMessages.delete(sessionId);
  transcriptReviewComments.set(
    sessionId,
    (transcriptReviewComments.get(sessionId) ?? []).filter(comment => comment.messageId !== message.id),
  );
  markTranscriptViewDirty({ resetCache: true });
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
  markTranscriptViewDirty({ resetCache: true });
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
  markTranscriptViewDirty({ resetCache: true });
  render();
}

function deleteTranscriptReviewComment(sessionId: string, comment: TranscriptReviewComment): void {
  transcriptReviewComments.set(
    sessionId,
    (transcriptReviewComments.get(sessionId) ?? []).filter(existing => existing.id !== comment.id),
  );
  markTranscriptViewDirty({ resetCache: true });
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
  diffPreviewStatus.textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"} ready to send`;
  diffPreviewSend.textContent = "Send comments";
  diffPreviewOverlay.hidden = false;
  diffPreviewText.scrollTop = 0;
  diffPreviewSend.focus();
}

function sendTranscriptReviewComments(
  sessionId: string,
  message: TranscriptMessage,
  comments: TranscriptReviewComment[],
): void {
  if (comments.length === 0) return;
  const clearFlushedComments = () => {
    transcriptReviewComments.set(
      sessionId,
      (transcriptReviewComments.get(sessionId) ?? []).filter(comment => comment.messageId !== message.id),
    );
    transcriptReviewActiveMessages.delete(sessionId);
    markTranscriptViewDirty({ resetCache: true });
    render();
  };
  sendPromptWithBusyHandling({
    sessionId,
    text: buildTranscriptReviewPrompt(message, comments),
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
  diffPreviewStatus.textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"} ready to send`;
  diffPreviewSend.textContent = "Send refinement";
  diffPreviewOverlay.hidden = false;
  diffPreviewText.scrollTop = 0;
  diffPreviewSend.focus();
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
function addDiffComment(
  sessionId: string,
  state: DiffReviewableState,
  location: DiffLineLocation,
): void {
  const comment = window.prompt("Comment on this diff line");
  if (!comment?.trim()) return;
  const annotations = diffAnnotations.get(sessionId) ?? [];
  annotations.push(createDiffReviewAnnotation({
    id: `${Date.now()}-${annotations.length}`,
    kind: "comment",
    state,
    location,
    text: comment,
  }));
  diffAnnotations.set(sessionId, annotations);
  markDiffsViewDirty();
  rerenderDiffsViewPreservingScroll(sessionId);
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
    status: "sent",
  });
  annotations.push(annotation);
  diffAnnotations.set(sessionId, annotations);
  sendPromptWithBusyHandling({
    sessionId,
    text: buildDiffQuestionPrompt(state, annotation),
    editorText: `Question about ${formatDiffLineLocation(location)}`,
    images: [],
    onSend: () => {
      markDiffsViewDirty();
      rerenderDiffsViewPreservingScroll(sessionId);
    },
  });
}

function sendDiffComments(
  sessionId: string,
  state: DiffReviewableState,
  comments: DiffReviewAnnotation[],
): void {
  if (comments.length === 0) return;
  const key = comparisonKey(state);
  const clearFlushedComments = () => {
    diffAnnotations.set(sessionId, removeSelectedDiffComments(diffAnnotations.get(sessionId) ?? [], key));
    markDiffsViewDirty();
    rerenderDiffsViewPreservingScroll(sessionId);
  };
  sendPromptWithBusyHandling({
    sessionId,
    text: buildDiffCommentPrompt(state, comments),
    editorText: diffCommentFlushEditorText(comments.length),
    images: [],
    onSend: clearFlushedComments,
  });
}

function previewDiffComments(
  sessionId: string,
  state: DiffReviewableState,
): void {
  const key = comparisonKey(state);
  const comments = selectedDiffAnnotations(diffAnnotations.get(sessionId) ?? [], key, "comment");
  if (comments.length === 0) return;
  diffPreviewDraft = { sessionId, state, comparisonKey: key, comments };
  transcriptPreviewDraft = null;
  diffPreviewTitle.textContent = "Preview diff comments";
  diffPreviewSubtitle.textContent = "Review the prompt that will be sent to OMP.";
  diffPreviewSend.textContent = "Send comments";
  diffPreviewText.value = buildDiffCommentPrompt(state, comments);
  diffPreviewStatus.textContent = diffCommentPreviewStatus(comments.length);
  diffPreviewOverlay.hidden = false;
  diffPreviewText.scrollTop = 0;
  diffPreviewSend.focus();
}

function closeDiffPreview(): void {
  diffPreviewOverlay.hidden = true;
  diffPreviewText.value = "";
  diffPreviewStatus.textContent = "";
  diffPreviewTitle.textContent = "Preview diff comments";
  diffPreviewSubtitle.textContent = "Review the prompt that will be sent to OMP.";
  diffPreviewSend.textContent = "Send comments";
  diffPreviewDraft = null;
  transcriptPreviewDraft = null;
}

function sendPromptPreviewDraft(): void {
  const diffDraft = diffPreviewDraft;
  const transcriptDraft = transcriptPreviewDraft;
  closeDiffPreview();
  if (diffDraft) {
    sendDiffComments(diffDraft.sessionId, diffDraft.state, diffDraft.comments);
    return;
  }
  if (transcriptDraft) {
    sendTranscriptReviewComments(transcriptDraft.sessionId, transcriptDraft.message, transcriptDraft.comments);
  }
}

function flushDiffComments(
  sessionId: string,
  state: DiffReviewableState,
): void {
  previewDiffComments(sessionId, state);
}

function diffTargetOffsetTop(container: HTMLElement, target: HTMLElement): number {
  let offset = target.offsetTop;
  let parent = target.offsetParent as HTMLElement | null;
  while (parent && parent !== container) {
    offset += parent.offsetTop;
    parent = parent.offsetParent as HTMLElement | null;
  }
  return offset;
}

function scrollDiffsToFile(container: HTMLElement, filePath: string): void {
  const mainBody = container.querySelector<HTMLElement>(".diffs-main-body");
  if (!mainBody) return;
  const targets = [...container.querySelectorAll<HTMLElement>("[data-diff-file-path]")];
  const target = targets.find(element => element.dataset.diffFilePath === filePath);
  if (!target) return;

  const scrollTop = Math.max(0, diffTargetOffsetTop(mainBody, target));
  mainBody.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    mainBody.scrollTop = scrollTop;
  });
  target.classList.add("diff-line-target");
  window.setTimeout(() => target.classList.remove("diff-line-target"), 1200);
}

function renderDiffsView(container: HTMLElement, projection: SessionProjection | undefined): void {
  setRenderDocument(container.ownerDocument);
  lastDiffsRenderedSessionId = activeSessionId;
  lastDiffsRenderedProjectionPresent = Boolean(projection);
  diffPanelDirty = false;
  container.replaceChildren();

  const root = mkEl("div");
  root.className = "diffs-view diff-products-view";
  const sidebar = mkEl("aside");
  sidebar.className = "diffs-sidebar";
  const sidebarScroll = mkEl("div");
  sidebarScroll.className = "diffs-sidebar-scroll";
  const productTabs = mkEl("div");
  productTabs.className = "diff-product-tabs";
  for (const [product, label] of [["sessionChanges", "Session changes"], ["compare", "Compare"]] as const) {
    const button = mkEl("button");
    button.type = "button";
    button.className = product === diffProductView ? "active" : "";
    button.textContent = label;
    button.addEventListener("click", () => {
      diffProductView = product;
      markDiffsViewDirty();
      renderDiffsView(container, projection);
      if (product === "sessionChanges" && activeSessionId && !sessionChangesStates.has(activeSessionId)) requestSessionChanges(activeSessionId);
    });
    productTabs.append(button);
  }
  sidebarScroll.append(productTabs);
  sidebar.append(sidebarScroll);

  const main = mkEl("section");
  main.className = "diffs-main";
  root.append(sidebar, main);
  container.append(root);

  if (diffProductView === "compare") {
    renderCompareDiffView(sidebarScroll, main);
    return;
  }
  if (!activeSessionId || !projection) {
    renderDiffMessage(main, "No session selected.", false);
    return;
  }
  renderSessionChangesView(activeSessionId, projection, sidebarScroll, main, container);
}

function renderSessionChangesView(sessionId: string, projection: SessionProjection, sidebar: HTMLElement, main: HTMLElement, container: HTMLElement): void {
  const state = sessionChangesStates.get(sessionId);
  const error = diffErrors.get(sessionId);
  const subviews = mkEl("div");
  subviews.className = "diff-subview-tabs";
  for (const [view, label] of [["diff", "Diff"], ["transcript", "Transcript"]] as const) {
    const button = mkEl("button");
    button.type = "button";
    button.className = view === sessionChangesSubview ? "active" : "";
    button.textContent = label;
    button.addEventListener("click", () => {
      sessionChangesSubview = view;
      markDiffsViewDirty();
      renderDiffsViewIfActive(sessionId);
    });
    subviews.append(button);
  }
  sidebar.append(subviews);

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
  refresh.addEventListener("click", () => requestSessionChangesRefresh(sessionId));
  actions.append(refresh);
  header.append(title, actions);
  main.append(header);

  if (sessionChangesSubview === "transcript") {
    const transcript = mkEl("div");
    transcript.className = "diffs-main-body session-changes-transcript";
    const items = buildTranscriptRenderItems(projection);
    if (items.length === 0) {
      const empty = mkEl("p");
      empty.className = "empty";
      empty.textContent = "Transcript is empty.";
      transcript.append(empty);
    } else {
      for (const item of items) transcript.append(item.render());
    }
    main.append(transcript);
    return;
  }

  if (!state) {
    renderDiffMessage(main, diffLoadingSessions.has(sessionId) ? "Loading session changes…" : "Session changes have not been loaded.", false);
    if (!diffLoadingSessions.has(sessionId)) requestSessionChanges(sessionId);
    return;
  }
  renderSessionRepoControls(sessionId, state, sidebar);
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
  renderReviewableDiff(sessionId, state, sidebar, main, container, true);
}

function renderSessionRepoControls(sessionId: string, state: SessionChangesState, sidebar: HTMLElement): void {
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
  const payload = mkEl("select");
  payload.className = "diff-payload-select";
  const currentPayload = state.status === "ready" ? state.range.payload.kind : sessionChangesPayloadKinds.get(sessionId) ?? "statOnly";
  for (const [value, text] of [["statOnly", "Stat"], ["fullPatch", "Full patch"]] as const) {
    const option = mkEl("option");
    option.value = value;
    option.textContent = text;
    option.selected = currentPayload === value;
    payload.append(option);
  }
  select.addEventListener("change", () => requestSessionChangesRepo(sessionId, select.value, payload.value as DiffPayloadKind));
  payload.addEventListener("change", () => {
    sessionChangesPayloadKinds.set(sessionId, payload.value as DiffPayloadKind);
    if (select.value) requestSessionChangesRepo(sessionId, select.value, payload.value as DiffPayloadKind);
  });
  section.append(label, select, payload);
  sidebar.append(section);
}

function renderCompareDiffView(sidebar: HTMLElement, main: HTMLElement): void {
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
  for (const [value, text] of [["fullPatch", "Full patch"], ["statOnly", "Stat"]] as const) {
    const option = mkEl("option");
    option.value = value;
    option.textContent = text;
    option.selected = comparePayloadKind === value;
    payload.append(option);
  }
  const run = mkEl("button");
  run.type = "button";
  run.textContent = "Compare";
  run.addEventListener("click", () => requestCompareDiff({ repoRoot: repoInput.value, base: baseInput.value, head: headInput.value, payloadKind: payload.value as DiffPayloadKind }));
  form.append(repoInput, baseInput, headInput, payload, run);
  sidebar.append(form);

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
    renderDiffMessage(main, "Run an explicit repository/ref comparison.", false);
    return;
  }
  renderReviewableDiff("compareDiff", compareDiffState, sidebar, main, null, false);
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

function renderReviewableDiff(
  annotationKey: string,
  state: DiffReviewableState,
  sidebar: HTMLElement,
  main: HTMLElement,
  jumpContainer: HTMLElement | null,
  allowPromptActions: boolean,
): void {
  const key = comparisonKey(state);
  const annotations = diffAnnotations.get(annotationKey) ?? [];
  const payload = state.range.payload;
  const parsedRows = payload.kind === "fullPatch" ? parseDiffRows(payload.patch) : [];
  const fileSummaries = payload.kind === "fullPatch" ? summarizeDiffFiles(parsedRows, annotations, key) : summarizeWireDiffFiles(diffPayloadFiles(payload), annotations, key);
  renderDesktopModifiedFiles(sidebar, fileSummaries, jumpContainer);
  const summary = mkEl("section");
  summary.className = "diffs-summary";
  const comparison = mkEl("p");
  comparison.textContent = `${resolvedRefLabel(state.range.base)} → ${resolvedRefLabel(state.range.head)}`;
  const commits = mkEl("p");
  commits.textContent = state.review.currentCommitOid ? `Commit ${(state.review.currentCommitIndex ?? 0) + 1}/${state.review.commits.length}` : `Range · ${state.review.commits.length} commit${state.review.commits.length === 1 ? "" : "s"}`;
  summary.append(comparison, commits);
  main.append(summary);

  const toolbar = mkEl("div");
  toolbar.className = "diffs-actions diff-step-actions";
  const payloadToggle = mkEl("button");
  payloadToggle.type = "button";
  payloadToggle.textContent = payload.kind === "fullPatch" ? "Show stat" : "Show full patch";
  payloadToggle.addEventListener("click", () => {
    const nextPayload: DiffPayloadKind = payload.kind === "fullPatch" ? "statOnly" : "fullPatch";
    if (annotationKey === "compareDiff") requestCompareDiff({ payloadKind: nextPayload, currentCommitOid: state.review.currentCommitOid ?? null });
    else requestSessionChangesRefresh(annotationKey, { payloadKind: nextPayload, currentCommitOid: state.review.currentCommitOid ?? null });
  });
  toolbar.append(payloadToggle);
  const firstCommit = state.review.commits[0]?.oid ?? null;
  const stepBtn = mkEl("button");
  stepBtn.type = "button";
  stepBtn.textContent = state.review.currentCommitOid ? "Show range" : "Step commits";
  stepBtn.disabled = state.review.commits.length === 0;
  stepBtn.addEventListener("click", () => {
    const selected = state.review.currentCommitOid ? null : firstCommit;
    if (annotationKey === "compareDiff") requestCompareDiff({ currentCommitOid: selected });
    else requestSessionChangesRefresh(annotationKey, { currentCommitOid: selected });
  });
  const index = state.review.currentCommitIndex ?? null;
  const prev = mkEl("button");
  prev.type = "button";
  prev.textContent = "Previous commit";
  prev.disabled = index === null || index <= 0;
  prev.addEventListener("click", () => {
    if (index === null) return;
    const oid = state.review.commits[index - 1]?.oid ?? null;
    if (annotationKey === "compareDiff") requestCompareDiff({ currentCommitOid: oid });
    else requestSessionChangesRefresh(annotationKey, { currentCommitOid: oid });
  });
  const next = mkEl("button");
  next.type = "button";
  next.textContent = "Next commit";
  next.disabled = index === null || index >= state.review.commits.length - 1;
  next.addEventListener("click", () => {
    if (index === null) return;
    const oid = state.review.commits[index + 1]?.oid ?? null;
    if (annotationKey === "compareDiff") requestCompareDiff({ currentCommitOid: oid });
    else requestSessionChangesRefresh(annotationKey, { currentCommitOid: oid });
  });
  toolbar.append(stepBtn, prev, next);
  if (state.review.currentCommitOid) {
    const checkout = mkEl("button");
    checkout.type = "button";
    checkout.textContent = "Checkout commit";
    checkout.addEventListener("click", () => ensureReviewWorktreeThenCheckout(state, { kind: "commit", oid: state.review.currentCommitOid! }));
    toolbar.append(checkout);
  }
  main.append(toolbar);

  const body = mkEl("div");
  body.className = "diffs-main-body";
  if (diffPayloadTruncated(payload)) {
    const warning = mkEl("p");
    warning.className = "diffs-warning";
    warning.textContent = "Diff output is truncated by Fura's safety limit.";
    body.append(warning);
  }
  if (!diffPayloadText(payload).trim()) {
    const empty = mkEl("p");
    empty.className = "empty diffs-empty";
    empty.textContent = "No changes for this comparison.";
    body.append(empty);
  } else if (!isFullPatchPayload(payload)) {
    const note = mkEl("p");
    note.className = "diffs-stat-note";
    note.textContent = "Stat-only payload: line comments, questions, and Code actions require full patch.";
    const pre = mkEl("pre");
    pre.className = "diff-stat-output";
    pre.textContent = diffPayloadText(payload);
    body.append(note, pre);
  } else {
    renderDiffRows(body, annotationKey, state, parsedRows, annotations, key, allowPromptActions);
  }
  main.append(body);
}

function renderDesktopModifiedFiles(
  sidebar: HTMLElement,
  files: ReturnType<typeof summarizeDiffFiles>,
  jumpContainer: HTMLElement | null,
): void {
  if (files.length === 0) return;
  const filesSection = mkEl("section");
  filesSection.className = "diffs-files";
  const filesTitle = mkEl("strong");
  filesTitle.textContent = `Modified files (${files.length})`;
  filesSection.append(filesTitle);
  const filesList = mkEl("div");
  filesList.className = "diffs-file-list";
  for (const file of files) {
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
    if (jumpContainer) {
      const jump = mkEl("button");
      jump.type = "button";
      jump.className = "diffs-file-jump";
      jump.append(name, meta);
      jump.addEventListener("click", () => scrollDiffsToFile(jumpContainer, file.filePath));
      item.append(jump);
    } else {
      item.append(name, meta);
    }
    filesList.append(item);
  }
  filesSection.append(filesList);
  sidebar.append(filesSection);
}

function renderDiffFileList(container: HTMLElement, files: ReturnType<typeof summarizeDiffFiles>): void {
  if (files.length === 0) return;
  const filesSection = mkEl("section");
  filesSection.className = "diffs-files";
  const filesTitle = mkEl("strong");
  filesTitle.textContent = `Modified files (${files.length})`;
  filesSection.append(filesTitle);
  const filesList = mkEl("div");
  filesList.className = "diffs-file-list";
  for (const file of files) {
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
    item.append(name, meta);
    filesList.append(item);
  }
  filesSection.append(filesList);
  container.append(filesSection);
}

function renderDiffRows(container: HTMLElement, annotationKey: string, state: DiffReviewableState, rows: ReturnType<typeof parseDiffRows>, annotations: DiffReviewAnnotation[], key: string, allowPromptActions: boolean): void {
  const diff = mkEl("div");
  diff.className = "diff-lines";
  for (const row of rows) {
    if (row.type === "line") {
      const lineAnnotations = annotationsForDiffLocation(annotations, key, row.location);
      const lineComments = lineAnnotations.filter(annotation => annotation.kind === "comment");
      const lineQuestions = lineAnnotations.filter(annotation => annotation.kind === "question");
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
      commentBtn.addEventListener("click", () => addDiffComment(annotationKey, state, row.location));
      const gutter = mkEl("span");
      gutter.className = "diff-gutter";
      gutter.textContent = row.location.newLine !== undefined ? String(row.location.newLine) : String(row.location.oldLine ?? "");
      const content = mkEl("div");
      content.className = "diff-line-content";
      const text = mkEl("code");
      text.textContent = row.location.text;
      content.append(text);
      const codeBtn = mkEl("button");
      codeBtn.type = "button";
      codeBtn.className = "diff-line-code-btn";
      codeBtn.textContent = "Code";
      codeBtn.addEventListener("click", () => openDiffLocationInCode(state, row.location));
      const questionBtn = mkEl("button");
      questionBtn.type = "button";
      questionBtn.className = `diff-question-btn ${lineQuestions.length > 0 ? "has-questions" : ""}`;
      questionBtn.textContent = lineQuestions.length > 0 ? String(lineQuestions.length) : "?";
      questionBtn.disabled = !allowPromptActions;
      questionBtn.title = allowPromptActions ? "Ask the agent about this diff line" : "Questions require a session changes review";
      questionBtn.addEventListener("click", () => askDiffQuestion(annotationKey, state, row.location));
      line.append(commentBtn, gutter, content, codeBtn, questionBtn);
      lineWrap.append(line);
      if (lineAnnotations.length > 0) {
        const thread = mkEl("div");
        thread.className = "diff-inline-comments";
        for (const annotation of lineAnnotations) thread.append(renderDiffAnnotationItem(annotationKey, annotation));
        lineWrap.append(thread);
      }
      diff.append(lineWrap);
      continue;
    }
    const line = mkEl("div");
    line.className = `diff-line diff-line-${row.type}`;
    if (row.type === "file") line.dataset.diffFilePath = row.filePath;
    const spacer = mkEl("span");
    spacer.className = "diff-comment-spacer";
    const text = mkEl("code");
    text.textContent = row.text;
    line.append(spacer, text);
    diff.append(line);
  }
  container.append(diff);
}

// --- Desktop workspace initialization ---

function initDesktopWorkspace(): void {
  desktopDockview = initDesktopDockview({
    host: requireElement<HTMLDivElement>("workspacePanelHost"),
    onPanelReady: id => {
      if (id === "transcript") markTranscriptViewDirty();
      if (id === "tools") markToolsViewDirty();
      if (id === "diffs") markDiffsViewDirty();
      if (id === "code") markCodeViewDirty();
    },
    onPanelActivated: id => {
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
      if (id === "diffs") {
        desktopDockview?.withPanel("diffs", container => renderDiffsView(container, projection));
        requestActiveDiffState();
      }
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
  renderActiveDockviewPanel(activeSessionId ? projections.get(activeSessionId) : undefined);
  if (isDiffsPanelActive()) requestActiveDiffState();
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
  cwdPickerNameInput.disabled = pending;
  cwdPickerInput.disabled = pending;
  cwdPickerWorktreeEnabled.disabled = pending;
  cwdPickerWorktreeSourceRepo.disabled = pending;
  cwdPickerWorktreeBase.disabled = pending;
  cwdPickerWorktreeBranch.disabled = pending;
  cwdPickerClose.disabled = pending;
  cwdPickerCancel.disabled = pending;
  cwdPickerCreate.disabled = pending;
  cwdPickerCreate.textContent = pending ? (cwdPickerMode === "diff" ? "Opening…" : "Creating…") : (cwdPickerMode === "diff" ? "Open diff" : "Create session");
  cwdPickerCreate.toggleAttribute("aria-busy", pending);
  if (pending) {
    setCwdPickerStatus(cwdPickerMode === "diff" ? "Opening diff…" : "Creating session…", "loading");
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
  cwdPickerSessionTab.classList.toggle("active", sessionMode);
  cwdPickerDiffTab.classList.toggle("active", !sessionMode);
  cwdPickerSessionTab.setAttribute("aria-selected", String(sessionMode));
  cwdPickerDiffTab.setAttribute("aria-selected", String(!sessionMode));
  cwdPickerSessionBody.hidden = !sessionMode;
  cwdPickerDiffBody.hidden = sessionMode;
  if (!cwdPickerCreatePending) cwdPickerCreate.textContent = mode === "diff" ? "Open diff" : "Create session";
}

function syncCwdPickerDiffDefaults(): void {
  const defaultRoot = cwdPickerInput.value.trim() || serverConfig?.defaultCwd || "";
  cwdPickerDiffRepo.value = defaultRoot;
  cwdPickerDiffBase.value = "HEAD";
  cwdPickerDiffHead.value = "HEAD";
  cwdPickerDiffMode.value = "full";
  cwdPickerDiffAgentSession.checked = true;
}

function openCwdPicker(): void {
  const config = requireServerConfig();
  if (!config) return;
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
  syncCwdPickerWorktreeFields();
  syncCwdPickerDiffDefaults();
  setCwdPickerMode("session");
  cwdPickerOverlay.hidden = false;
  window.setTimeout(() => cwdPickerNameInput.focus(), 0);
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
  const payloadKind: DiffPayloadKind = cwdPickerDiffMode.value === "stat" ? "statOnly" : "fullPatch";
  if (!repoRoot) {
    setCwdPickerError("Repository root is required for diff review.");
    cwdPickerDiffRepo.focus();
    return;
  }
  const diff = { repoRoot, base, head, payloadKind };
  if (!cwdPickerDiffAgentSession.checked) {
    closeCwdPicker();
    diffProductView = "compare";
    compareRepoRoot = repoRoot;
    compareBaseRef = base;
    compareHeadRef = head;
    comparePayloadKind = payloadKind;
    desktopDockview?.activatePanel("diffs");
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
  const query = normalizeModelQuery(modelPickerSearch.value);
  if (!query) return modelPickerModels;
  return modelPickerModels.filter(model => normalizeModelQuery(modelSearchText(model)).includes(query));
}

function normalizeModelQuery(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function modelSearchText(model: ModelSummary): string {
  return [model.provider, model.id, model.name ?? ""].join(" ");
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

function formatModelSelector(model: ModelSummary): string {
  return `${model.provider}/${model.id}`;
}

function formatModelContext(model: ModelSummary): string | null {
  if (!model.contextWindow) return null;
  if (model.contextWindow >= 1_000_000) return `${(model.contextWindow / 1_000_000).toFixed(1)}M context`;
  if (model.contextWindow >= 1_000) return `${Math.round(model.contextWindow / 1_000)}K context`;
  return `${model.contextWindow} context`;
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
