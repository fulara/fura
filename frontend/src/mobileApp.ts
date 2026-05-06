import {
  blobToBase64,
  createPendingMarker as createAttachmentMarker,
  removePendingMarkerFromText,
  renderAttachmentPreviews,
  type PendingImage,
} from "./composerAttachments";
import { createPromptSendMessage, type PromptBehavior } from "./composer";
import { findSlashCommand } from "./slashCommands";
import { clearBootstrapToken, consumeBootstrapToken, storeBootstrapToken } from "./bootstrapAuth";
import type { ConnectionStatus, FuraConnection, WebSocketAuth } from "./connection";
import { setRenderDocument } from "./dom";
import {
  comparisonKey,
  formatDiffRepoLabel,
  parseDiffRows,
  resolvedRefLabel,
  summarizeWireDiffFiles,
  type ParsedDiffRow,
} from "./diffState";
import {
  extensionDialogBodyText,
  formatExtensionDialogNotification,
  parseExtensionDialogRequest,
  type ExtensionDialogRequest,
} from "./extensionDialog";
import {
  busyPromptAttachmentNote as formatBusyPromptAttachmentNote,
  busyPromptDisplayText,
  createBusyPromptDraft,
  createBusyPromptDraftFromServer,
  restoreBusyPromptEditorText,
  type BusyPromptDraft,
} from "./promptBusy";
import {
  annotationsForDiffLocation,
  createDiffReviewAnnotation,
  createReviewCommentCreateMessage,
  diffCommentFlushEditorText,
  diffCommentPreviewStatus,
  formatDiffLineLocation,
  formatReviewCommentLocation,
  isReviewCommentMatched,
  prepareDiffAnnotationPrompt,
  removeSelectedDiffAnnotations,
  reviewCommentsForComparison,
  reviewCommentsForDiffLocation,
  selectedDiffAnnotations,
  type DiffPreviewDraft,
} from "./diffReview";
import { formatContext, formatCost, formatTokens, shortId, shortPath } from "./format";
import type {
  ClientMessage,
  ControlCandidate,
  ControlStatusProjection,
  ControlSuggestedAction,
  FrontendControlAction,
  FrontendUiSnapshot,
  DiffDetailMode,
  DiffReviewAnnotation,
  DiffReviewableState,
  DiffLineLocation,
  SessionChangesSummaryState,
  ServerConfig,
  ModelSummary,
  ProposedModelConfig,
  ServerMessage,
  ReviewComment,
  SessionProjection,
  SessionSummary,
  ThinkingVisibilityMode,
  TodoPhase,
  TranscriptMessage,
} from "./protocol";
import { nextThinkingVisibilityMode, parseThinkingVisibilityMode, parseToolVisibility } from "./uiPreferences";
import { sessionCategories, visibleSessions } from "./sessionList";
import { activateSession as activateSessionState, applySessionSnapshot, applySessionsSnapshot, sessionOpenOrAttachMessage } from "./sessionClientState";
import {
  deriveWorktreeCreateView,
  resolveSessionCreateMessage,
  type SessionCreateValidationTarget,
} from "./sessionCreate";
import { deriveSessionDeleteView, sessionDeleteMessage, type SessionDeleteView } from "./sessionDelete";
import { catalogContainsProposedModel, filterCatalogModels, formatCatalogModelLabel, formatProposedModelDetails, normalizeSelectedProposedModelId, proposedModelIdFromName, removeProposedModel, upsertProposedModel, validateProposedModels } from "./proposedModels";
import { createSessionListView, renderSessionCategoryFilter } from "./sessionListView";
import { renderCurrentTodoCard, renderToolCard } from "./toolCards";
import { renderMessage } from "./transcriptView";
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
  renderPlanReviewCard,
  planReviewTranscriptMessage,
  type PendingPlanReview,
  type VisiblePlanReview,
} from "./planReview";

type MobileWindow = Pick<Window, "history" | "localStorage" | "sessionStorage" | "location" | "prompt" | "setTimeout">;
type MobileSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MOBILE_ACTIVE_SESSION_STORAGE_KEY = "fura.mobile.activeSessionId";
const MOBILE_ATTACHED_SESSIONS_STORAGE_KEY = "fura.mobile.attachedSessionIds";
const MAX_TRACKED_MOBILE_SESSION_IDS = 20;
const CONTROL_CLIENT_ID_STORAGE_KEY = "fura.controlClientId";

type MobileWorkspaceView = "controller" | "transcript" | "diff";

type ControlChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  candidates?: ControlCandidate[];
  suggestedActions?: ControlSuggestedAction[];
};

export type MobileConnectionOptions = {
  auth: WebSocketAuth;
  onStatus(label: string, className: ConnectionStatus): void;
  onOpen?(): void;
  onClose?(): void;
  onAuthFailure?(message: string): void;
  onMessage(message: ServerMessage): void;
  onLog(message: string): void;
};

export type MobileConnectionFactory = (options: MobileConnectionOptions) => FuraConnection;

export type MobileAppOptions = {
  document: Document;
  window: MobileWindow;
  createConnection: MobileConnectionFactory;
};

export type MobileAppHandle = {
  send(message: ClientMessage): boolean;
  connect(token: string): void;
};

export function mountMobileApp(options: MobileAppOptions): MobileAppHandle {
  const { document, window, createConnection } = options;
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("#app missing");

  app.innerHTML = `
    <main class="mobile-shell">
      <header class="mobile-topbar">
        <div class="mobile-brand-row">
          <div class="mobile-brand">
            <h1>Fura</h1>
            <p>mobile</p>
          </div>
          <span id="mobileConnectionStatus" class="status disconnected">disconnected</span>
        </div>
        <div class="mobile-session-row">
          <div class="mobile-session-heading">
            <h2 id="mobileSessionTitle">No session selected</h2>
            <p id="mobileSessionMeta">Choose a session to view its transcript.</p>
          </div>
          <div class="mobile-header-actions">
            <button id="mobileCreateToggle" class="mobile-create-toggle" type="button" aria-expanded="false" aria-controls="mobileCreateDrawer">New</button>
            <button id="mobileSessionsToggle" class="mobile-sessions-toggle" type="button" aria-expanded="false" aria-controls="mobileSessionsDrawer">Sessions</button>
            <button id="mobileAskFuraButton" class="mobile-ask-fura-button" type="button" aria-pressed="false" aria-controls="mobileController">Ask</button>
            <div class="mobile-options">
              <button id="mobileOptionsToggle" class="mobile-options-toggle" type="button" aria-expanded="false" aria-haspopup="menu" aria-controls="mobileOptionsMenu" title="Display options">⚙</button>
              <div id="mobileOptionsMenu" class="mobile-options-menu" role="menu" hidden>
                <button id="mobileToolVisibilityToggle" class="mobile-option-item" type="button" role="menuitemcheckbox" aria-checked="true">Tools: on</button>
                <button id="mobileThinkingVisibilityToggle" class="mobile-option-item" type="button" role="menuitem">Thinking: auto</button>
                <div class="mobile-options-section">
                  <div class="mobile-options-heading">Proposed models</div>
                  <div id="mobileProposedModelsList" class="mobile-proposed-models-list"></div>
                  <div class="mobile-proposed-model-form">
                    <input id="mobileProposedModelName" autocomplete="off" spellcheck="false" placeholder="Custom name" />
                    <input id="mobileProposedModelSearch" autocomplete="off" spellcheck="false" placeholder="Search runtime models" />
                    <select id="mobileProposedModelCatalog"></select>
                    <select id="mobileProposedModelThinking">
                      <option value="default">Default</option>
                      <option value="off">Off</option>
                      <option value="minimal">Minimal</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                    <button id="mobileProposedModelAdd" type="button">Add proposed model</button>
                  </div>
                  <p id="mobileProposedModelStatus" class="mobile-dialog-status" aria-live="polite"></p>
                </div>
              </div>
            </div>
          </div>
        </div>
        <p id="mobileLog" class="mobile-log" aria-live="polite"></p>
        <section id="mobileSessionsDrawer" class="mobile-session-drawer" hidden>
          <label class="mobile-category-filter" for="mobileSessionCategoryFilter">
            <span>Category</span>
            <select id="mobileSessionCategoryFilter"></select>
          </label>
          <nav id="mobileSessionsList" class="sessions" aria-label="Sessions"></nav>
        </section>
        <section id="mobileCreateDrawer" class="mobile-create-drawer" hidden>
          <form id="mobileCreateForm" class="mobile-create-form">
            <label for="mobileCreateName">Session name <span class="mobile-optional-label">optional</span></label>
            <input id="mobileCreateName" autocomplete="off" spellcheck="false" placeholder="my-session" />
            <label for="mobileCreateCwd">Working directory</label>
            <input id="mobileCreateCwd" autocomplete="off" spellcheck="false" placeholder="/home/user/project" />
            <label for="mobileCreateProposedModel">Model</label>
            <select id="mobileCreateProposedModel"></select>
            <label class="mobile-checkbox-row" for="mobileCreateWorktreeEnabled">
              <input id="mobileCreateWorktreeEnabled" type="checkbox" />
              <span>Create git worktree</span>
            </label>
            <div id="mobileCreateWorktreeFields" class="mobile-create-worktree-fields" hidden>
              <label for="mobileCreateWorktreeSourceRepo">Source repo root</label>
              <input id="mobileCreateWorktreeSourceRepo" autocomplete="off" spellcheck="false" placeholder="/home/user/project" />
              <label for="mobileCreateWorktreeDirectory">Worktree directory</label>
              <input id="mobileCreateWorktreeDirectory" autocomplete="off" spellcheck="false" placeholder="/home/user/project-feature" />
              <label for="mobileCreateWorktreeBase">Base branch/ref</label>
              <input id="mobileCreateWorktreeBase" autocomplete="off" spellcheck="false" placeholder="HEAD" />
              <label for="mobileCreateWorktreeBranch">Branch name <span class="mobile-optional-label">optional</span></label>
              <input id="mobileCreateWorktreeBranch" autocomplete="off" spellcheck="false" placeholder="feature/mobile" />
              <p class="mobile-create-worktree-help">Must be a valid Git branch name. Leave blank to use the selected base ref directly.</p>
              <p id="mobileCreateWorktreeSummary" class="mobile-create-worktree-summary"></p>
            </div>
            <p id="mobileCreateStatus" class="mobile-create-status" aria-live="polite"></p>
            <div class="mobile-create-actions">
              <button id="mobileCreateClose" type="button">Close</button>
              <button id="mobileCreateSubmit" type="submit">Create</button>
            </div>
          </form>
        </section>
      </header>

      <section class="mobile-main" aria-label="Mobile workspace">
        <nav id="mobileSessionWorkspaceTabs" class="mobile-workspace-tabs" role="tablist" aria-label="Session workspace views">
          <button id="mobileTranscriptTab" type="button" class="mobile-workspace-tab active" role="tab" aria-selected="true" aria-controls="mobileTranscript">Transcript</button>
          <button id="mobileDiffTab" type="button" class="mobile-workspace-tab" role="tab" aria-selected="false" aria-controls="mobileDiff">Diff</button>
        </nav>
        <div id="mobileController" class="mobile-transcript mobile-controller" role="region" aria-label="Ask Fura" hidden></div>
        <div id="mobileTranscript" class="mobile-transcript" role="tabpanel" aria-labelledby="mobileTranscriptTab"></div>
        <div id="mobileDiff" class="mobile-diff" role="tabpanel" aria-labelledby="mobileDiffTab" hidden></div>
      </section>

      <form id="mobilePromptForm" class="mobile-composer">
        <div id="mobileStatusBar" class="mobile-status-bar" aria-label="Session status"></div>
        <div id="mobileImagePreviews" class="mobile-image-previews" hidden></div>
        <textarea id="mobilePromptInput" rows="3" placeholder="Select a session first"></textarea>
        <div class="mobile-composer-actions">
          <span id="mobileComposerStatus" class="mobile-composer-status">No active session</span>
          <div class="mobile-composer-buttons">
            <label class="mobile-attach-button" for="mobileImageInput">Attach
              <input id="mobileImageInput" type="file" accept="image/*" capture="environment" multiple />
            </label>
            <button id="mobileSendButton" type="submit">Send</button>
          </div>
        </div>
      </form>
      <section id="mobileAuthGate" class="mobile-dialog-overlay" hidden>
        <div class="mobile-dialog mobile-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="mobileAuthTitle" aria-describedby="mobileAuthDescription">
          <header class="mobile-dialog-header">
            <div>
              <p class="mobile-dialog-kicker">Bridge auth</p>
              <h2 id="mobileAuthTitle">Connect to Fura</h2>
            </div>
          </header>
          <div id="mobileAuthDescription" class="mobile-dialog-body">
            <p>Enter the bridge token from the Fura startup output. URL tokens are ignored and removed.</p>
          </div>
          <form id="mobileAuthForm" class="mobile-dialog-form">
            <label for="mobileAuthToken">Bridge token</label>
            <input id="mobileAuthToken" type="password" autocomplete="current-password" spellcheck="false" required />
            <p id="mobileAuthStatus" class="mobile-dialog-status" aria-live="polite"></p>
            <div class="mobile-dialog-actions">
              <button id="mobileAuthSubmit" type="submit">Connect</button>
            </div>
          </form>
        </div>
      </section>
      <section id="mobileBusyPromptOverlay" class="mobile-dialog-overlay" hidden>
        <div class="mobile-dialog mobile-busy-prompt" role="dialog" aria-modal="true" aria-labelledby="mobileBusyPromptTitle" aria-describedby="mobileBusyPromptDescription">
          <header class="mobile-dialog-header">
            <div>
              <p class="mobile-dialog-kicker">Agent busy</p>
              <h2 id="mobileBusyPromptTitle">Choose prompt behavior</h2>
            </div>
          </header>
          <div id="mobileBusyPromptDescription" class="mobile-dialog-body">
            <p>The agent is already processing. Steer interrupts the active turn; follow-up queues this prompt for after the current turn.</p>
          </div>
          <div class="mobile-dialog-form">
            <label class="mobile-busy-prompt-field" for="mobileBusyPromptText">Prompt to send</label>
            <textarea id="mobileBusyPromptText" class="mobile-busy-prompt-text" readonly spellcheck="false"></textarea>
            <p id="mobileBusyPromptAttachmentNote" class="mobile-dialog-status"></p>
            <div class="mobile-dialog-actions">
              <button id="mobileBusyPromptCancel" type="button">Cancel</button>
              <button id="mobileBusyPromptSteer" type="button">Steer</button>
              <button id="mobileBusyPromptFollowUp" type="button">Follow-up</button>
            </div>
          </div>
        </div>
      </section>
      <section id="mobileDeleteSessionOverlay" class="mobile-dialog-overlay" hidden>
        <div class="mobile-dialog mobile-delete-session" role="dialog" aria-modal="true" aria-labelledby="mobileDeleteSessionTitle" aria-describedby="mobileDeleteSessionMessage">
          <header class="mobile-dialog-header">
            <div>
              <p class="mobile-dialog-kicker">Delete session</p>
              <h2 id="mobileDeleteSessionTitle">Delete session</h2>
            </div>
          </header>
          <div class="mobile-dialog-body">
            <p id="mobileDeleteSessionMessage"></p>
            <label id="mobileDeleteSessionWorktreeRow" class="mobile-checkbox-row" for="mobileDeleteSessionWorktree">
              <input id="mobileDeleteSessionWorktree" type="checkbox" />
              <span>Also delete the linked git worktree directory</span>
            </label>
            <p id="mobileDeleteSessionWorktreePath" class="mobile-create-worktree-help"></p>
          </div>
          <div class="mobile-dialog-actions">
            <button id="mobileDeleteSessionCancel" type="button">Cancel</button>
            <button id="mobileDeleteSessionConfirm" class="danger-action" type="button">Delete session</button>
          </div>
        </div>
      </section>
      <section id="mobileDiffCommentOverlay" class="mobile-dialog-overlay" hidden>
        <div class="mobile-dialog mobile-diff-comment-dialog" role="dialog" aria-modal="true" aria-labelledby="mobileDiffCommentTitle" aria-describedby="mobileDiffCommentBody">
          <header class="mobile-dialog-header">
            <div>
              <p class="mobile-dialog-kicker">Diff comment</p>
              <h2 id="mobileDiffCommentTitle">Comment on diff line</h2>
            </div>
          </header>
          <form id="mobileDiffCommentForm" class="mobile-dialog-form">
            <p id="mobileDiffCommentBody" class="mobile-dialog-body">Add a note to the selected diff line. It stays local until you preview and flush comments to the agent.</p>
            <label class="mobile-dialog-field" for="mobileDiffCommentText">Comment</label>
            <textarea id="mobileDiffCommentText" class="mobile-diff-comment-text" rows="5" spellcheck="true"></textarea>
            <p id="mobileDiffCommentStatus" class="mobile-dialog-status" aria-live="polite"></p>
            <div class="mobile-dialog-actions">
              <button id="mobileDiffCommentCancel" type="button">Cancel</button>
              <button id="mobileDiffCommentSave" type="submit">Save comment</button>
            </div>
          </form>
        </div>
      </section>
      <section id="mobileDiffPreviewOverlay" class="mobile-dialog-overlay" hidden>
        <div class="mobile-dialog mobile-diff-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="mobileDiffPreviewTitle">
          <header class="mobile-dialog-header">
            <div>
              <p class="mobile-dialog-kicker">Diff comments</p>
              <h2 id="mobileDiffPreviewTitle">Preview flush prompt</h2>
            </div>
          </header>
          <div class="mobile-dialog-form">
            <textarea id="mobileDiffPreviewText" class="mobile-diff-preview-text" readonly spellcheck="false"></textarea>
            <p id="mobileDiffPreviewStatus" class="mobile-dialog-status" aria-live="polite"></p>
            <div class="mobile-dialog-actions">
              <button id="mobileDiffPreviewCancel" type="button">Cancel</button>
              <button id="mobileDiffPreviewSend" type="button">Send to agent</button>
            </div>
          </div>
        </div>
      </section>
      <section id="mobileDialogOverlay" class="mobile-dialog-overlay" hidden>
        <div class="mobile-dialog" role="dialog" aria-modal="true" aria-labelledby="mobileDialogTitle" aria-describedby="mobileDialogBody">
          <header class="mobile-dialog-header">
            <div>
              <p id="mobileDialogKicker" class="mobile-dialog-kicker">Extension request</p>
              <h2 id="mobileDialogTitle"></h2>
            </div>
          </header>
          <div id="mobileDialogBody" class="mobile-dialog-body"></div>
          <form id="mobileDialogForm" class="mobile-dialog-form">
            <div id="mobileDialogField" class="mobile-dialog-field"></div>
            <p id="mobileDialogStatus" class="mobile-dialog-status" aria-live="polite"></p>
            <div class="mobile-dialog-actions">
              <button id="mobileDialogCancel" type="button">Cancel</button>
              <button id="mobileDialogSubmit" type="submit">Submit</button>
            </div>
          </form>
        </div>
      </section>
      <section id="mobileReviewPreviewOverlay" class="mobile-dialog-overlay" hidden>
        <div class="mobile-dialog mobile-review-preview" role="dialog" aria-modal="true" aria-labelledby="mobileReviewPreviewTitle">
          <header class="mobile-dialog-header">
            <div>
              <p class="mobile-dialog-kicker">Transcript review</p>
              <h2 id="mobileReviewPreviewTitle">Preview transcript comments</h2>
            </div>
          </header>
          <textarea id="mobileReviewPreviewText" class="mobile-review-preview-text" readonly spellcheck="false"></textarea>
          <p id="mobileReviewPreviewStatus" class="mobile-dialog-status" aria-live="polite"></p>
          <div class="mobile-dialog-actions mobile-review-preview-actions">
            <button id="mobileReviewPreviewCancel" type="button">Cancel</button>
            <button id="mobileReviewPreviewSend" type="button">Send comments</button>
          </div>
        </div>
      </section>
    </main>
  `;

  const connectionStatus = requireElement<HTMLSpanElement>(document, "mobileConnectionStatus");
  const authGate = requireElement<HTMLElement>(document, "mobileAuthGate");
  const authForm = requireElement<HTMLFormElement>(document, "mobileAuthForm");
  const authTokenInput = requireElement<HTMLInputElement>(document, "mobileAuthToken");
  const authStatus = requireElement<HTMLParagraphElement>(document, "mobileAuthStatus");
  const authSubmit = requireElement<HTMLButtonElement>(document, "mobileAuthSubmit");
  const sessionTitle = requireElement<HTMLHeadingElement>(document, "mobileSessionTitle");
  const sessionMeta = requireElement<HTMLParagraphElement>(document, "mobileSessionMeta");
  const createToggle = requireElement<HTMLButtonElement>(document, "mobileCreateToggle");
  const sessionsToggle = requireElement<HTMLButtonElement>(document, "mobileSessionsToggle");
  const optionsToggle = requireElement<HTMLButtonElement>(document, "mobileOptionsToggle");
  const optionsMenu = requireElement<HTMLDivElement>(document, "mobileOptionsMenu");
  const toolVisibilityToggle = requireElement<HTMLButtonElement>(document, "mobileToolVisibilityToggle");
  const thinkingVisibilityToggle = requireElement<HTMLButtonElement>(document, "mobileThinkingVisibilityToggle");
  const proposedModelsList = requireElement<HTMLDivElement>(document, "mobileProposedModelsList");
  const proposedModelName = requireElement<HTMLInputElement>(document, "mobileProposedModelName");
  const proposedModelSearch = requireElement<HTMLInputElement>(document, "mobileProposedModelSearch");
  const proposedModelCatalog = requireElement<HTMLSelectElement>(document, "mobileProposedModelCatalog");
  const proposedModelThinking = requireElement<HTMLSelectElement>(document, "mobileProposedModelThinking");
  const proposedModelAdd = requireElement<HTMLButtonElement>(document, "mobileProposedModelAdd");
  const proposedModelStatus = requireElement<HTMLParagraphElement>(document, "mobileProposedModelStatus");
  const sessionsDrawer = requireElement<HTMLElement>(document, "mobileSessionsDrawer");
  const sessionsList = requireElement<HTMLElement>(document, "mobileSessionsList");
  const createDrawer = requireElement<HTMLElement>(document, "mobileCreateDrawer");
  const createForm = requireElement<HTMLFormElement>(document, "mobileCreateForm");
  const createNameInput = requireElement<HTMLInputElement>(document, "mobileCreateName");
  const createCwdInput = requireElement<HTMLInputElement>(document, "mobileCreateCwd");
  const createProposedModel = requireElement<HTMLSelectElement>(document, "mobileCreateProposedModel");
  const createWorktreeEnabled = requireElement<HTMLInputElement>(document, "mobileCreateWorktreeEnabled");
  const createWorktreeFields = requireElement<HTMLDivElement>(document, "mobileCreateWorktreeFields");
  const createWorktreeSourceRepo = requireElement<HTMLInputElement>(document, "mobileCreateWorktreeSourceRepo");
  const createWorktreeDirectory = requireElement<HTMLInputElement>(document, "mobileCreateWorktreeDirectory");
  const createWorktreeBase = requireElement<HTMLInputElement>(document, "mobileCreateWorktreeBase");
  const createWorktreeBranch = requireElement<HTMLInputElement>(document, "mobileCreateWorktreeBranch");
  const createWorktreeSummary = requireElement<HTMLParagraphElement>(document, "mobileCreateWorktreeSummary");
  const createStatus = requireElement<HTMLParagraphElement>(document, "mobileCreateStatus");
  const createClose = requireElement<HTMLButtonElement>(document, "mobileCreateClose");
  const createSubmit = requireElement<HTMLButtonElement>(document, "mobileCreateSubmit");
  const askFuraButton = requireElement<HTMLButtonElement>(document, "mobileAskFuraButton");
  const sessionWorkspaceTabs = requireElement<HTMLElement>(document, "mobileSessionWorkspaceTabs");
  const transcriptTab = requireElement<HTMLButtonElement>(document, "mobileTranscriptTab");
  const diffTab = requireElement<HTMLButtonElement>(document, "mobileDiffTab");
  const controllerView = requireElement<HTMLDivElement>(document, "mobileController");
  const transcript = requireElement<HTMLDivElement>(document, "mobileTranscript");
  const diffView = requireElement<HTMLDivElement>(document, "mobileDiff");
  const promptForm = requireElement<HTMLFormElement>(document, "mobilePromptForm");
  const promptInput = requireElement<HTMLTextAreaElement>(document, "mobilePromptInput");
  const sendButton = requireElement<HTMLButtonElement>(document, "mobileSendButton");
  const statusBar = requireElement<HTMLDivElement>(document, "mobileStatusBar");
  const imagePreviews = requireElement<HTMLDivElement>(document, "mobileImagePreviews");
  const imageInput = requireElement<HTMLInputElement>(document, "mobileImageInput");
  const composerStatus = requireElement<HTMLSpanElement>(document, "mobileComposerStatus");
  const mobileLog = requireElement<HTMLParagraphElement>(document, "mobileLog");
  const categoryFilter = requireElement<HTMLSelectElement>(document, "mobileSessionCategoryFilter");
  const deleteSessionOverlay = requireElement<HTMLElement>(document, "mobileDeleteSessionOverlay");
  const deleteSessionMessage = requireElement<HTMLParagraphElement>(document, "mobileDeleteSessionMessage");
  const deleteSessionWorktreeRow = requireElement<HTMLLabelElement>(document, "mobileDeleteSessionWorktreeRow");
  const deleteSessionWorktree = requireElement<HTMLInputElement>(document, "mobileDeleteSessionWorktree");
  const deleteSessionWorktreePath = requireElement<HTMLParagraphElement>(document, "mobileDeleteSessionWorktreePath");
  const deleteSessionCancel = requireElement<HTMLButtonElement>(document, "mobileDeleteSessionCancel");
  const deleteSessionConfirm = requireElement<HTMLButtonElement>(document, "mobileDeleteSessionConfirm");
  const busyPromptOverlay = requireElement<HTMLElement>(document, "mobileBusyPromptOverlay");
  const busyPromptText = requireElement<HTMLTextAreaElement>(document, "mobileBusyPromptText");
  const busyPromptAttachmentNote = requireElement<HTMLParagraphElement>(document, "mobileBusyPromptAttachmentNote");
  const busyPromptCancel = requireElement<HTMLButtonElement>(document, "mobileBusyPromptCancel");
  const busyPromptSteer = requireElement<HTMLButtonElement>(document, "mobileBusyPromptSteer");
  const busyPromptFollowUp = requireElement<HTMLButtonElement>(document, "mobileBusyPromptFollowUp");
  const diffCommentOverlay = requireElement<HTMLElement>(document, "mobileDiffCommentOverlay");
  const diffCommentForm = requireElement<HTMLFormElement>(document, "mobileDiffCommentForm");
  const diffCommentText = requireElement<HTMLTextAreaElement>(document, "mobileDiffCommentText");
  const diffCommentStatus = requireElement<HTMLParagraphElement>(document, "mobileDiffCommentStatus");
  const diffCommentCancel = requireElement<HTMLButtonElement>(document, "mobileDiffCommentCancel");
  const diffPreviewOverlay = requireElement<HTMLElement>(document, "mobileDiffPreviewOverlay");
  const diffPreviewText = requireElement<HTMLTextAreaElement>(document, "mobileDiffPreviewText");
  const diffPreviewStatus = requireElement<HTMLParagraphElement>(document, "mobileDiffPreviewStatus");
  const diffPreviewCancel = requireElement<HTMLButtonElement>(document, "mobileDiffPreviewCancel");
  const diffPreviewSend = requireElement<HTMLButtonElement>(document, "mobileDiffPreviewSend");
  const dialogOverlay = requireElement<HTMLElement>(document, "mobileDialogOverlay");
  const dialogTitle = requireElement<HTMLHeadingElement>(document, "mobileDialogTitle");
  const dialogBody = requireElement<HTMLDivElement>(document, "mobileDialogBody");
  const dialogForm = requireElement<HTMLFormElement>(document, "mobileDialogForm");
  const dialogField = requireElement<HTMLDivElement>(document, "mobileDialogField");
  const dialogStatus = requireElement<HTMLParagraphElement>(document, "mobileDialogStatus");
  const dialogCancel = requireElement<HTMLButtonElement>(document, "mobileDialogCancel");
  const dialogSubmit = requireElement<HTMLButtonElement>(document, "mobileDialogSubmit");
  const reviewPreviewOverlay = requireElement<HTMLElement>(document, "mobileReviewPreviewOverlay");
  const reviewPreviewText = requireElement<HTMLTextAreaElement>(document, "mobileReviewPreviewText");
  const reviewPreviewStatus = requireElement<HTMLParagraphElement>(document, "mobileReviewPreviewStatus");
  const reviewPreviewCancel = requireElement<HTMLButtonElement>(document, "mobileReviewPreviewCancel");
  const reviewPreviewSend = requireElement<HTMLButtonElement>(document, "mobileReviewPreviewSend");

  let connection: FuraConnection | null = null;
  const controlClientId = getOrCreateControlClientId(window.sessionStorage);
  let controlConversationId: string | null = null;
  let controlMessages: ControlChatMessage[] = [];
  let controlStatusState: ControlStatusProjection = { status: "idle" };
  let reviewPreviewDraft: { sessionId: string; message: TranscriptMessage; comments: TranscriptReviewComment[]; promptText?: string } | null = null;
  const transcriptReviewActiveMessages = new Map<string, string>();
  const visiblePlanReviews = new Map<string, VisiblePlanReview>();
  const transcriptReviewComments = new Map<string, TranscriptReviewComment[]>();
  let serverConfig: ServerConfig | null = null;
  let showToolBubbles = true;
  let thinkingVisibilityMode: ThinkingVisibilityMode = "auto";
  let optionsMenuOpen = false;
  let proposedModelCatalogModels: ModelSummary[] = [];
  let proposedModelCatalogRequestId: string | null = null;
  let proposedModelEditingId: string | null = null;
  let sessions: SessionSummary[] = [];
  let activeSessionId: string | null = readStoredActiveSessionId(window.sessionStorage);
  let projections = new Map<string, SessionProjection>();
  const trackedSessionIds = readStoredTrackedSessionIds(window.sessionStorage);
  let pendingRestoreAfterSessionsSnapshot = false;
  const unreadSessions = new Set<string>();
  let selectedCategoryFilter = "";
  let deleteSessionTarget: SessionDeleteView | null = null;
  let createCwdDirty = false;
  let createWorktreeSourceDirty = false;
  let createWorktreeBaseDirty = false;
  let createWorktreeDirectoryDirty = false;
  let createWorktreeBranchDirty = false;
  let lastAutofilledWorktreeDirectory = "";
  let lastAutofilledWorktreeBranch = "";
  let pendingImages: PendingImage[] = [];
  let nextPendingImageId = 1;
  let createPendingRequestId: string | null = null;
  let pendingCreatedSessionBaseline: Set<string> | null = null;
  let activeMobileView: MobileWorkspaceView = "transcript";
  let sessionPromptDraft = "";
  let controllerPromptDraft = "";
  let lastSessionMobileView: Exclude<MobileWorkspaceView, "controller"> = "transcript";
  const sessionChangesStates = new Map<string, SessionChangesSummaryState>();
  const diffErrors = new Map<string, string>();
  const diffLoadingSessions = new Set<string>();
  const diffPayloadKinds = new Map<string, DiffDetailMode>();
  const sessionChangesDiffIds = new Map<string, string>();
  const mobileSelectedDiffFiles = new Map<string, string>();
  const mobileDiffPatchCache = new Map<string, { patch: string; truncated: boolean }>();
  type PendingMobileDiffFilePatchRequest = { diffId: string; comparisonKey: string; filePath: string };
  type MobileDiffFilePatchError = { filePath: string; message: string };
  let currentSessionChangesRequest: { sessionId: string; diffId: string } | null = null;
  const pendingMobileDiffFilePatches = new Map<string, PendingMobileDiffFilePatchRequest>();
  const mobileDiffFilePatchErrors = new Map<string, MobileDiffFilePatchError>();
  let mobileDiffRenderRevision = 0;
  const diffClientId = (() => {
    const key = "fura.mobile.diff.clientId";
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.sessionStorage.setItem(key, next);
    return next;
  })();

  function mobilePatchCacheComparisonKey(cacheKey: string): string {
    const separator = cacheKey.indexOf("\0");
    return separator === -1 ? cacheKey : cacheKey.slice(0, separator);
  }

  function pruneMobileDiffPatchCache(currentComparisonKey?: string | null): void {
    const currentState = currentSessionChangesRequest ? sessionChangesStates.get(currentSessionChangesRequest.sessionId) : undefined;
    const keepKey = currentComparisonKey ?? (currentState?.status === "ready" ? currentState.comparison.comparisonKey : null);
    for (const cacheKey of [...mobileDiffPatchCache.keys()]) {
      if (!keepKey || mobilePatchCacheComparisonKey(cacheKey) !== keepKey) mobileDiffPatchCache.delete(cacheKey);
    }
  }

  function rememberMobileDiffPatch(key: string, value: { patch: string; truncated: boolean }): void {
    mobileDiffPatchCache.set(key, value);
    let totalBytes = 0;
    for (const entry of mobileDiffPatchCache.values()) totalBytes += entry.patch.length;
    while (mobileDiffPatchCache.size > 20 || totalBytes > 8 * 1024 * 1024) {
      const oldest = mobileDiffPatchCache.keys().next().value;
      if (!oldest) break;
      const removed = mobileDiffPatchCache.get(oldest);
      mobileDiffPatchCache.delete(oldest);
      totalBytes -= removed?.patch.length ?? 0;
    }
  }

  function pendingMobileDiffFilePatchMatches(sessionId: string, diffId: string, key: string, filePath: string): boolean {
    const pending = pendingMobileDiffFilePatches.get(sessionId);
    return Boolean(pending && pending.diffId === diffId && pending.comparisonKey === key && pending.filePath === filePath);
  }

  function clearPendingMobileDiffFilePatch(sessionId: string, diffId?: string): void {
    const pending = pendingMobileDiffFilePatches.get(sessionId);
    if (!pending || (diffId && pending.diffId !== diffId)) return;
    pendingMobileDiffFilePatches.delete(sessionId);
  }

  function selectedMobileDiffFilePatchError(sessionId: string, filePath: string): string | null {
    const error = mobileDiffFilePatchErrors.get(sessionId);
    return error?.filePath === filePath ? error.message : null;
  }

  function setCurrentSessionChangesRequest(sessionId: string, diffId: string, reason: "replaced" | "closed" | "sessionChanged" | "repoChanged" | "refsChanged" | "payloadChanged" | "refreshed"): void {
    if (currentSessionChangesRequest && currentSessionChangesRequest.diffId !== diffId) {
      send({ type: "diff.cancel", clientId: diffClientId, diffId: currentSessionChangesRequest.diffId, scope: "sessionChanges", reason });
      diffLoadingSessions.delete(currentSessionChangesRequest.sessionId);
      clearPendingMobileDiffFilePatch(currentSessionChangesRequest.sessionId, currentSessionChangesRequest.diffId);
      mobileDiffFilePatchErrors.delete(currentSessionChangesRequest.sessionId);
    }
    currentSessionChangesRequest = { sessionId, diffId };
  }

  function clearCurrentSessionChangesRequest(reason: "replaced" | "closed" | "sessionChanged" | "repoChanged" | "refsChanged" | "payloadChanged" | "refreshed"): void {
    if (!currentSessionChangesRequest) return;
    send({ type: "diff.cancel", clientId: diffClientId, diffId: currentSessionChangesRequest.diffId, scope: "sessionChanges", reason });
    diffLoadingSessions.delete(currentSessionChangesRequest.sessionId);
    clearPendingMobileDiffFilePatch(currentSessionChangesRequest.sessionId, currentSessionChangesRequest.diffId);
    mobileDiffFilePatchErrors.delete(currentSessionChangesRequest.sessionId);
    currentSessionChangesRequest = null;
    pruneMobileDiffPatchCache(null);
  }

  function selectedMobileDiffFilePath(state: DiffReviewableState, sessionId: string, filePaths: string[]): string | null {
    const requestedPath = state.comparison.selectedFile?.newPath ?? null;
    const rememberedPath = mobileSelectedDiffFiles.get(sessionId) ?? null;
    const nextPath = [requestedPath, rememberedPath, filePaths[0] ?? null].find(
      (candidate): candidate is string => candidate !== null && filePaths.includes(candidate),
    ) ?? null;
    if (nextPath) mobileSelectedDiffFiles.set(sessionId, nextPath);
    else mobileSelectedDiffFiles.delete(sessionId);
    return nextPath;
  }
  const diffAnnotations = new Map<string, DiffReviewAnnotation[]>();
  const reviewComments = new Map<string, ReviewComment[]>();
  const reviewCommentsRequested = new Set<string>();
  const reviewCommentsLoadInFlight = new Set<string>();

  const reviewCommentsResyncNeeded = new Set<string>();

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

  function mobileReviewCommentAsAnnotation(comment: ReviewComment): DiffReviewAnnotation {
    return {
      id: comment.id,
      kind: "comment",
      comparisonKey: comment.comparisonKey,
      anchor: comment.anchor,
      text: comment.body,
      status: "sent",
      createdAt: comment.createdAt,
    };
  }
  let pendingDiffComment: {
    sessionId: string;
    state: DiffReviewableState;
    location: DiffLineLocation;
    kind: "comment" | "question";
  } | null = null;
  let diffPreviewDraft: DiffPreviewDraft | null = null;
  let agentReviewDraft: { sessionId: string; state: DiffReviewableState } | null = null;
  let busyPromptDraft: BusyPromptDraft | null = null;
  let activeDialog: ExtensionDialogRequest | null = null;
  const dialogQueue: ExtensionDialogRequest[] = [];

  const sessionListView = createSessionListView(sessionsList, {
    onSelectSession: selectSession,
    onDeleteSession: openDeleteSessionPicker,
  });

  askFuraButton.addEventListener("click", () => {
    setActiveMobileView(activeMobileView === "controller" ? lastSessionMobileView : "controller");
  });
  transcriptTab.addEventListener("click", () => setActiveMobileView("transcript"));
  diffTab.addEventListener("click", () => setActiveMobileView("diff"));

  createToggle.addEventListener("click", () => {
    const open = createDrawer.hidden;
    setCreateDrawerOpen(open);
    setOptionsMenuOpen(false);
    if (open) {
      sessionsDrawer.hidden = true;
      sessionsToggle.setAttribute("aria-expanded", "false");
      window.setTimeout(() => createNameInput.focus(), 0);
    }
  });

  sessionsToggle.addEventListener("click", () => {
    const open = sessionsDrawer.hidden;
    sessionsDrawer.hidden = !open;
    sessionsToggle.setAttribute("aria-expanded", String(open));
    setOptionsMenuOpen(false);
    if (open) setCreateDrawerOpen(false);
  });

  optionsToggle.addEventListener("click", event => {
    event.stopPropagation();
    setOptionsMenuOpen(!optionsMenuOpen);
  });
  optionsMenu.addEventListener("click", event => event.stopPropagation());
  toolVisibilityToggle.addEventListener("click", () => {
    const nextShowTools = !showToolBubbles;
    if (!send({ type: "config.set", showTools: nextShowTools })) return;
    applyVisibilityPreferences(nextShowTools, thinkingVisibilityMode);
    setOptionsMenuOpen(false);
  });
  thinkingVisibilityToggle.addEventListener("click", () => {
    const nextMode = nextThinkingVisibilityMode(thinkingVisibilityMode);
    if (!send({ type: "config.set", thinkingVisibility: nextMode })) return;
    applyVisibilityPreferences(showToolBubbles, nextMode);
    setOptionsMenuOpen(false);
  });
  proposedModelAdd.addEventListener("click", addMobileProposedModel);
  proposedModelSearch.addEventListener("input", syncMobileProposedModelsUi);

  document.addEventListener("click", event => {
    if (!optionsMenuOpen) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (optionsToggle.contains(target) || optionsMenu.contains(target)) return;
    setOptionsMenuOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && optionsMenuOpen) setOptionsMenuOpen(false);
  });

  createClose.addEventListener("click", () => setCreateDrawerOpen(false));
  createCwdInput.addEventListener("input", () => {
    createCwdDirty = true;
    syncCreateWorktreeFields();
    if (!createPendingRequestId) createStatus.textContent = "";
  });
  createNameInput.addEventListener("input", () => {
    syncCreateWorktreeFields();
    if (!createPendingRequestId) createStatus.textContent = "";
  });
  createWorktreeEnabled.addEventListener("change", () => {
    if (createWorktreeEnabled.checked) {
      createWorktreeDirectoryDirty = false;
      createWorktreeBranchDirty = false;
    }
    syncCreateWorktreeFields();
    if (!createPendingRequestId) createStatus.textContent = "";
  });
  createWorktreeSourceRepo.addEventListener("input", () => {
    createWorktreeSourceDirty = true;
    syncCreateWorktreeFields();
    if (!createPendingRequestId) createStatus.textContent = "";
  });
  createWorktreeDirectory.addEventListener("input", () => {
    if (createWorktreeDirectory.value !== lastAutofilledWorktreeDirectory) createWorktreeDirectoryDirty = true;
    syncCreateWorktreeFields();
    if (!createPendingRequestId) createStatus.textContent = "";
  });
  createWorktreeBase.addEventListener("input", () => {
    createWorktreeBaseDirty = true;
    syncCreateWorktreeFields();
    if (!createPendingRequestId) createStatus.textContent = "";
  });
  createWorktreeBranch.addEventListener("input", () => {
    if (createWorktreeBranch.value !== lastAutofilledWorktreeBranch) createWorktreeBranchDirty = true;
    syncCreateWorktreeFields();
    if (!createPendingRequestId) createStatus.textContent = "";
  });

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

  createForm.addEventListener("submit", event => {
    event.preventDefault();
    submitCreateSession();
  });

  imageInput.addEventListener("change", () => {
    void addSelectedImages(imageInput.files);
  });

  promptForm.addEventListener("submit", event => {
    event.preventDefault();
    const editorText = promptInput.value;
    const text = editorText.trim();
    if (activeMobileView === "controller") {
      if (!text) return;
      if (pendingImages.length > 0) {
        controlMessages.push({ role: "system", text: "Ask Fura does not accept image attachments yet. Switch back to a session to send images to the agent." });
        renderControlConversation();
        return;
      }
      if (submitControlPromptText(text)) promptInput.value = "";
      return;
    }
    if ((!text && pendingImages.length === 0) || !activeSessionId) return;
    if (hasPendingPlanReview(activeSessionId)) return;
    sendPromptWithBusyHandling({
      sessionId: activeSessionId,
      text,
      editorText,
      images: pendingImages,
      onSend: clearPromptComposer,
    });
  });

  dialogForm.addEventListener("submit", event => {
    event.preventDefault();
    submitActiveDialog();
  });
  dialogCancel.addEventListener("click", () => respondToActiveDialog({ cancelled: true }));
  busyPromptCancel.addEventListener("click", restoreBusyPromptDraft);
  busyPromptSteer.addEventListener("click", () => sendBusyPromptDraft("steer"));
  busyPromptFollowUp.addEventListener("click", () => sendBusyPromptDraft("followUp"));
  categoryFilter.addEventListener("change", () => {
    selectedCategoryFilter = categoryFilter.value;
    renderSessions();
  });
  deleteSessionCancel.addEventListener("click", closeDeleteSessionPicker);
  deleteSessionConfirm.addEventListener("click", submitDeleteSessionPicker);
  diffCommentForm.addEventListener("submit", event => {
    event.preventDefault();
    savePendingDiffComment();
  });
  diffCommentCancel.addEventListener("click", closeDiffCommentEditor);
  diffPreviewCancel.addEventListener("click", closeDiffPreview);
  diffPreviewSend.addEventListener("click", sendDiffPreviewDraft);
  reviewPreviewCancel.addEventListener("click", closeReviewPreview);
  reviewPreviewSend.addEventListener("click", sendReviewPreviewDraft);
  reviewPreviewOverlay.addEventListener("mousedown", event => {
    if (event.target === reviewPreviewOverlay) closeReviewPreview();
  });

  const initialToken = consumeBootstrapToken(
    window.location.href,
    window.sessionStorage,
    url => window.history.replaceState(null, "", url),
  );
  syncToolVisibilityToggle();
  syncThinkingVisibilityToggle();
  syncOptionsMenu();
  render();
  if (initialToken) connect(initialToken);
  else showAuthGate("Enter the bridge token to connect.");

  function connect(token: string): void {
    const bridgeToken = storeBootstrapToken(token, window.sessionStorage);
    if (!bridgeToken) {
      showAuthGate("Enter the bridge token to connect.");
      return;
    }
    authSubmit.disabled = true;
    authStatus.textContent = "Connecting…";
    connection?.disconnect();
    connection = createConnection({
      auth: { type: "sessionCookie", token: bridgeToken },
      onStatus: setStatus,
      onOpen: () => {
        pendingRestoreAfterSessionsSnapshot = true;
        hideAuthGate();
        send({ type: "session.list" });
      },
      onClose: () => handleConnectionClosed(),
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

  function setStatus(label: string, className: ConnectionStatus): void {
    connectionStatus.textContent = label;
    connectionStatus.className = `status ${className}`;
    const canForceReconnect = className === "disconnected" || className === "reconnecting";
    connectionStatus.title = canForceReconnect ? "Click to reconnect now." : "";
    connectionStatus.tabIndex = canForceReconnect ? 0 : -1;
  }

  function appendLog(message: string): void {
    mobileLog.textContent = message;
    console.debug(`[fura-mobile] ${message}`);
  }

  function syncToolVisibilityToggle(): void {
    toolVisibilityToggle.textContent = showToolBubbles ? "Tools: on" : "Tools: off";
    toolVisibilityToggle.setAttribute("aria-checked", String(showToolBubbles));
    toolVisibilityToggle.title = showToolBubbles ? "Hide tool cards in transcript" : "Show tool cards in transcript";
  }

  function syncThinkingVisibilityToggle(): void {
    const labels: Record<ThinkingVisibilityMode, string> = {
      auto: "Thinking: auto",
      shown: "Thinking: shown",
      hidden: "Thinking: hidden",
    };
    thinkingVisibilityToggle.textContent = labels[thinkingVisibilityMode];
    thinkingVisibilityToggle.dataset.state = thinkingVisibilityMode;
  }

  function syncOptionsMenu(): void {
    optionsToggle.setAttribute("aria-expanded", String(optionsMenuOpen));
    optionsMenu.hidden = !optionsMenuOpen;
  }

  function syncMobileProposedModelsUi(): void {
    createProposedModel.replaceChildren();
    createProposedModel.append(new Option("Default", "default"));
    proposedModelsList.replaceChildren();
    proposedModelCatalog.replaceChildren();
    for (const model of filterCatalogModels(proposedModelCatalogModels, proposedModelSearch.value)) {
      proposedModelCatalog.append(new Option(formatCatalogModelLabel(model), `${model.provider}\u0000${model.id}`));
    }
    const proposed = serverConfig?.proposedModels ?? [];
    if (proposed.length === 0) {
      proposedModelsList.textContent = "No proposed models.";
    }
    for (const model of proposed) {
      createProposedModel.append(new Option(model.name, model.id));
      const row = document.createElement("div");
      row.className = "mobile-proposed-model-row";
      const text = document.createElement("span");
      text.textContent = `${model.name}: ${formatProposedModelDetails(model)}`;
      if (proposedModelCatalogModels.length > 0 && !catalogContainsProposedModel(proposedModelCatalogModels, model)) {
        text.textContent += " · Not in current OMP model catalog";
        text.classList.add("mobile-proposed-model-warning");
      }
      const actions = document.createElement("div");
      actions.className = "mobile-proposed-model-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => editMobileProposedModel(model));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => saveMobileProposedModels(removeProposedModel(proposed, model.id)));
      actions.append(edit, remove);
      row.append(text, actions);
      proposedModelsList.append(row);
    }
    createProposedModel.value = normalizeSelectedProposedModelId(createProposedModel.value, proposed);
  }

  function requestMobileModelCatalog(): void {
    if (proposedModelCatalogRequestId || proposedModelCatalogModels.length > 0) return;
    proposedModelCatalogRequestId = nextClientRequestId("mobile-model-catalog");
    proposedModelStatus.textContent = "Loading runtime models…";
    if (!send({ type: "config.modelCatalog.list", requestId: proposedModelCatalogRequestId })) {
      proposedModelCatalogRequestId = null;
      proposedModelStatus.textContent = "Not connected to the Fura bridge.";
    }
  }

  function addMobileProposedModel(): void {
    const name = proposedModelName.value.trim();
    if (!name) {
      proposedModelStatus.textContent = "Name is required.";
      return;
    }
    const [provider, modelId] = proposedModelCatalog.value.split("\u0000");
    const catalogModel = proposedModelCatalogModels.find(model => model.provider === provider && model.id === modelId);
    if (!catalogModel) {
      proposedModelStatus.textContent = "Choose a runtime model.";
      return;
    }
    const existing = serverConfig?.proposedModels ?? [];
    const editingId = proposedModelEditingId;
    const model: ProposedModelConfig = {
      id: editingId ?? proposedModelIdFromName(name, existing.map(item => item.id)),
      name,
      provider: catalogModel.provider,
      modelId: catalogModel.id,
      modelName: catalogModel.name ?? null,
      thinkingLevel: proposedModelThinking.value as ProposedModelConfig["thinkingLevel"],
    };
    const nextModels = upsertProposedModel(existing, model, editingId);
    saveMobileProposedModels(nextModels);
  }

  function editMobileProposedModel(model: ProposedModelConfig): void {
    proposedModelEditingId = model.id;
    proposedModelName.value = model.name;
    proposedModelSearch.value = model.modelName || model.modelId;
    proposedModelThinking.value = model.thinkingLevel;
    syncMobileProposedModelsUi();
    const value = `${model.provider}\u0000${model.modelId}`;
    if (Array.from(proposedModelCatalog.options).some(option => option.value === value)) {
      proposedModelCatalog.value = value;
    }
  }

  function saveMobileProposedModels(models: ProposedModelConfig[]): void {
    const error = validateProposedModels(models);
    if (error) {
      proposedModelStatus.textContent = error;
      return;
    }
    proposedModelStatus.textContent = "Saving proposed models…";
    if (!send({ type: "config.set", proposedModels: models })) {
      proposedModelStatus.textContent = "Not connected to the Fura bridge.";
    }
  }

  function setOptionsMenuOpen(open: boolean): void {
    optionsMenuOpen = open;
    syncOptionsMenu();
    if (open) requestMobileModelCatalog();
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
    if (toolsChanged || thinkingChanged) renderActiveSession();
  }

  function send(message: ClientMessage): boolean {
    if (!connection) {
      appendLog("Not connected.");
      return false;
    }
    return connection.send(message);
  }

  function sendPromptWithBusyHandling(options: {
    sessionId: string;
    text: string;
    editorText: string;
    images: PendingImage[];
    onSend?: () => void;
  }): boolean {
    const projection = projections.get(options.sessionId);
    const knownSlashCommand = findSlashCommand(options.editorText);
    const isSlashCommandLike = /^\/[^\s:]+/.test(options.editorText);

    if (projection?.isBusy) {
      if (knownSlashCommand && options.images.length === 0) {
        const accepted = send(createPromptSendMessage(options.sessionId, options.text, options.images));
        if (accepted) options.onSend?.();
        return accepted;
      }
      if (isSlashCommandLike) {
        appendLog(`[${options.sessionId}] warning: Slash commands cannot be sent as steer or follow-up prompts while the agent is busy.`);
        return false;
      }
      busyPromptDraft = createBusyPromptDraft({
        sessionId: options.sessionId,
        text: options.text,
        editorText: options.editorText,
        images: options.images,
        onSend: options.onSend,
      });
      renderBusyPromptChoice();
      renderActiveSession();
      return true;
    }

    const accepted = send(createPromptSendMessage(options.sessionId, options.text, options.images));
    if (accepted) options.onSend?.();
    return accepted;
  }

  function forceReconnectNow(): void {
    if (!connection || connection.isOpen()) return;
    appendLog("Reconnecting now.");
    connection.connect();
  }
  function handlePromptBusy(message: Extract<ServerMessage, { type: "prompt.busy" }>): void {
    appendLog(`[${message.sessionId}] prompt needs steer or follow-up choice`);
    busyPromptDraft = createBusyPromptDraftFromServer(message, createPendingImageMarker);
    if (message.sessionId === activeSessionId) {
      renderBusyPromptChoice();
      return;
    }
    unreadSessions.add(message.sessionId);
    renderSessions();
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
    if (message.sessionId === activeSessionId) {
      renderActiveSession();
      return;
    }
    unreadSessions.add(message.sessionId);
    renderSessions();
  }

  function approvePendingPlanReview(review: PendingPlanReview): void {
    const accepted = send(createApprovePlanReviewMessage(review));
    if (!accepted) return;
    visiblePlanReviews.delete(review.sessionId);
    renderActiveSession();
  }

  function refinePendingPlanReview(review: PendingPlanReview): void {
    visiblePlanReviews.set(review.sessionId, { review, mode: "refining" });
    renderActiveSession();
    if (activeSessionId === review.sessionId) promptInput.focus();
  }

  function discussPendingPlanReview(review: PendingPlanReview): void {
    const accepted = send(createDiscussPlanReviewMessage(review));
    if (!accepted) return;
    visiblePlanReviews.set(review.sessionId, { review, mode: "discussing" });
    renderActiveSession();
    if (activeSessionId === review.sessionId) promptInput.focus();
  }
  function renderBusyPromptChoice(): void {
    const draft = busyPromptDraft;
    const shouldShow = Boolean(draft && draft.sessionId === activeSessionId);
    const wasHidden = busyPromptOverlay.hidden;

    if (!draft || !shouldShow) {
      busyPromptOverlay.hidden = true;
      busyPromptText.value = "";
      busyPromptAttachmentNote.textContent = "";
      busyPromptAttachmentNote.hidden = true;
      return;
    }

    const attachmentNote = formatBusyPromptAttachmentNote(draft);
    busyPromptText.value = busyPromptDisplayText(draft);
    busyPromptAttachmentNote.textContent = attachmentNote;
    busyPromptAttachmentNote.hidden = attachmentNote.length === 0;
    busyPromptOverlay.hidden = false;

    if (wasHidden) {
      window.setTimeout(() => {
        if (busyPromptOverlay.hidden) return;
        busyPromptText.focus();
        busyPromptText.select();
      }, 0);
    }
  }

  function restoreBusyPromptDraft(): void {
    const draft = busyPromptDraft;
    if (!draft) return;
    busyPromptDraft = null;
    promptInput.value = restoreBusyPromptEditorText(draft, promptInput.value);
    pendingImages = [...draft.images, ...pendingImages];
    renderMobileImagePreviews();
    renderBusyPromptChoice();
    renderActiveSession();
    promptInput.focus();
  }

  function sendBusyPromptDraft(behavior: PromptBehavior): void {
    const draft = busyPromptDraft;
    if (!draft) return;
    const accepted = send(createPromptSendMessage(draft.sessionId, draft.text, draft.images, behavior));
    if (!accepted) {
      busyPromptAttachmentNote.textContent = "Not connected to the Fura bridge.";
      busyPromptAttachmentNote.hidden = false;
      return;
    }
    const onSend = draft.onSend;
    busyPromptDraft = null;
    onSend?.();
    renderBusyPromptChoice();
    renderActiveSession();
  }

  function openDiffCommentEditor(
    sessionId: string,
    state: DiffReviewableState,
    location: DiffLineLocation,
    kind: "comment" | "question" = "comment",
  ): void {
    pendingDiffComment = { sessionId, state, location, kind };
    diffCommentText.value = "";
    diffCommentStatus.textContent = formatDiffLineLocation(location);
    diffCommentOverlay.hidden = false;
    window.setTimeout(() => diffCommentText.focus(), 0);
  }

  function closeDiffCommentEditor(): void {
    pendingDiffComment = null;
    diffCommentOverlay.hidden = true;
    diffCommentText.value = "";
    diffCommentStatus.textContent = "";
  }

  function savePendingDiffComment(): void {
    const pending = pendingDiffComment;
    if (!pending) return;
    const text = diffCommentText.value.trim();
    if (!text) {
      diffCommentStatus.textContent = pending.kind === "question" ? "Question text is required." : "Comment text is required.";
      diffCommentText.focus();
      return;
    }

    if (pending.kind === "comment") {
      markReviewCommentsDirty(pending.sessionId);
      send(createReviewCommentCreateMessage(pending.sessionId, pending.state, pending.location, text));
      closeDiffCommentEditor();
      return;
    }

    const annotations = diffAnnotations.get(pending.sessionId) ?? [];
    const annotation = createDiffReviewAnnotation({
      id: `${Date.now()}-${annotations.length}`,
      kind: pending.kind,
      state: pending.state,
      location: pending.location,
      text,
      status: "draft",
    });
    annotations.push(annotation);
    diffAnnotations.set(pending.sessionId, annotations);
    closeDiffCommentEditor();
    renderActiveSession();
  }

  function cachedMobileDiffPatchForAnnotation(state: DiffReviewableState, annotation: DiffReviewAnnotation): string | null {
    return mobileDiffPatchCache.get(`${comparisonKey(state)}\0${annotation.anchor.newPath}`)?.patch ?? null;
  }

  function openDiffPreview(
    sessionId: string,
    state: DiffReviewableState,
  ): void {
    const key = comparisonKey(state);
    const annotationsToFlush = selectedDiffAnnotations(diffAnnotations.get(sessionId) ?? [], key);
    if (annotationsToFlush.length === 0) return;
    const prompt = prepareDiffAnnotationPrompt(state, annotationsToFlush, annotation => cachedMobileDiffPatchForAnnotation(state, annotation));
    if (prompt.ok) {
      diffPreviewDraft = { sessionId, state, comparisonKey: key, annotations: annotationsToFlush };
      diffPreviewSend.disabled = false;
      diffPreviewSend.textContent = "Send to agent";
      diffPreviewText.readOnly = true;
      diffPreviewText.value = prompt.prompt;
      diffPreviewStatus.textContent = diffCommentPreviewStatus(annotationsToFlush.length);
      diffPreviewOverlay.hidden = false;
      diffPreviewText.scrollTop = 0;
      window.setTimeout(() => diffPreviewSend.focus(), 0);
      return;
    }
    diffPreviewDraft = null;
    diffPreviewSend.disabled = true;
    diffPreviewSend.textContent = "Send to agent";
    diffPreviewText.readOnly = true;
    diffPreviewText.value = "";
    diffPreviewStatus.textContent = "message" in prompt ? prompt.message : "";
    diffPreviewOverlay.hidden = false;
    diffPreviewText.scrollTop = 0;
    window.setTimeout(() => diffPreviewSend.focus(), 0);
  }

  function closeDiffPreview(): void {
    diffPreviewDraft = null;
    agentReviewDraft = null;
    diffPreviewSend.disabled = false;
    diffPreviewSend.textContent = "Send to agent";
    diffPreviewText.readOnly = true;
    diffPreviewOverlay.hidden = true;
    diffPreviewText.value = "";
    diffPreviewStatus.textContent = "";
  }

  function openAgentDiffReview(sessionId: string, state: DiffReviewableState): void {
    agentReviewDraft = { sessionId, state };
    diffPreviewDraft = null;
    diffPreviewSend.disabled = false;
    diffPreviewSend.textContent = "Start review";
    diffPreviewText.readOnly = false;
    diffPreviewText.value = "Review this diff for correctness, reliability, maintainability, and edge cases.";
    diffPreviewStatus.textContent = "Agent review comments will appear after the bridge stores and broadcasts them.";
    diffPreviewOverlay.hidden = false;
    diffPreviewText.scrollTop = 0;
    window.setTimeout(() => diffPreviewText.focus(), 0);
  }

  function clearFlushedDiffAnnotations(
    sessionId: string,
    key: string,
  ): void {
    diffAnnotations.set(sessionId, removeSelectedDiffAnnotations(diffAnnotations.get(sessionId) ?? [], key));
    renderActiveSession();
  }

  function sendDiffPreviewDraft(): void {
    const agentDraft = agentReviewDraft;
    if (agentDraft) {
      const instructions = diffPreviewText.value.trim();
      closeDiffPreview();
      send({ type: "review.agentReview.start", sessionId: agentDraft.sessionId, state: agentDraft.state, instructions });
      return;
    }
    const draft = diffPreviewDraft;
    if (!draft) return;
    const prompt = prepareDiffAnnotationPrompt(draft.state, draft.annotations, annotation => cachedMobileDiffPatchForAnnotation(draft.state, annotation));
    if (!prompt.ok) {
      diffPreviewStatus.textContent = "message" in prompt ? prompt.message : "";
      return;
    }
    const clearComments = () => clearFlushedDiffAnnotations(draft.sessionId, draft.comparisonKey);
    if (projections.get(draft.sessionId)?.isBusy) {
      busyPromptDraft = createBusyPromptDraft({
        sessionId: draft.sessionId,
        text: prompt.prompt,
        editorText: diffCommentFlushEditorText(draft.annotations.length),
        images: [],
        onSend: clearComments,
      });
      closeDiffPreview();
      renderBusyPromptChoice();
      return;
    }

    const accepted = send(createPromptSendMessage(draft.sessionId, prompt.prompt, []));
    if (!accepted) {
      diffPreviewStatus.textContent = "Not connected to the Fura bridge.";
      return;
    }
    closeDiffPreview();
    clearComments();
  }

  function handleDialogRequest(message: Extract<ServerMessage, { type: "dialog.request" }>): void {
    const request = parseExtensionDialogRequest(message.sessionId, message.dialog);
    if (!request) {
      appendLog(`[${message.sessionId}] ignored malformed dialog request.`);
      return;
    }

    switch (request.method) {
      case "cancel":
        cancelMobileDialog(request.targetId);
        return;
      case "notify":
        appendLog(formatExtensionDialogNotification(request));
        return;
      case "set_editor_text":
        promptInput.value = request.text ?? "";
        return;
      case "setStatus":
      case "setWidget":
        return;
      case "setTitle":
        return;
      default:
        enqueueMobileDialog(request);
    }
  }

  function enqueueMobileDialog(request: ExtensionDialogRequest): void {
    if (activeDialog) {
      dialogQueue.push(request);
      appendLog(`Queued dialog request: ${request.title}`);
      return;
    }
    activeDialog = request;
    renderMobileDialog();
  }

  function cancelMobileDialog(targetId: string | undefined): void {
    if (!targetId) return;
    if (activeDialog?.id === targetId) {
      activeDialog = null;
      showNextMobileDialog();
      return;
    }
    const queuedIndex = dialogQueue.findIndex(request => request.id === targetId);
    if (queuedIndex >= 0) dialogQueue.splice(queuedIndex, 1);
  }

  function showNextMobileDialog(): void {
    activeDialog = dialogQueue.shift() ?? null;
    renderMobileDialog();
  }

  function submitActiveDialog(): void {
    if (!activeDialog) return;
    switch (activeDialog.method) {
      case "confirm":
        respondToActiveDialog({ confirmed: true });
        return;
      case "select": {
        const select = dialogField.querySelector<HTMLSelectElement>("select[data-dialog-value]");
        if (!select || select.selectedIndex < 0) {
          dialogStatus.textContent = "Choose an option or cancel the request.";
          return;
        }
        respondToActiveDialog({ value: select.value });
        return;
      }
      case "input":
      case "editor": {
        const input = dialogField.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-dialog-value]");
        respondToActiveDialog({ value: input?.value ?? "" });
        return;
      }
      default:
        respondToActiveDialog({ cancelled: true });
    }
  }

  function respondToActiveDialog(response: Record<string, unknown>): void {
    if (!activeDialog) return;
    const accepted = send({
      type: "dialog.respond",
      sessionId: activeDialog.sessionId,
      dialogId: activeDialog.id,
      response,
    });
    if (!accepted) {
      dialogStatus.textContent = "Not connected to the Fura bridge.";
      return;
    }
    showNextMobileDialog();
  }

  function renderMobileDialog(): void {
    dialogOverlay.hidden = !activeDialog;
    dialogBody.replaceChildren();
    dialogField.replaceChildren();
    dialogStatus.textContent = "";
    dialogSubmit.hidden = false;
    dialogSubmit.disabled = false;
    dialogCancel.textContent = "Cancel";

    if (!activeDialog) {
      dialogTitle.textContent = "";
      return;
    }

    dialogTitle.textContent = activeDialog.title;
    const bodyText = extensionDialogBodyText(activeDialog);
    if (bodyText) {
      const paragraph = dialogBody.ownerDocument.createElement("p");
      paragraph.textContent = bodyText;
      dialogBody.append(paragraph);
    }

    if (activeDialog.timeoutMs !== undefined) {
      dialogStatus.textContent = `Extension timeout: ${Math.ceil(activeDialog.timeoutMs / 1000)}s.`;
    }

    switch (activeDialog.method) {
      case "confirm":
        dialogSubmit.textContent = "Confirm";
        break;
      case "select":
        renderMobileDialogSelect(activeDialog);
        dialogSubmit.textContent = "Select";
        break;
      case "input":
        renderMobileDialogInput(activeDialog);
        dialogSubmit.textContent = "Submit";
        break;
      case "editor":
        renderMobileDialogEditor(activeDialog);
        dialogSubmit.textContent = "Submit";
        break;
      default:
        dialogSubmit.hidden = true;
        dialogCancel.textContent = "Dismiss";
        if (!bodyText) {
          const paragraph = dialogBody.ownerDocument.createElement("p");
          paragraph.textContent = `Unsupported extension dialog method: ${activeDialog.method}.`;
          dialogBody.append(paragraph);
        }
        break;
    }

    window.setTimeout(() => {
      const target = dialogField.querySelector<HTMLElement>("[data-dialog-value]") ?? dialogSubmit;
      target.focus();
    }, 0);
  }

  function renderMobileDialogSelect(request: ExtensionDialogRequest): void {
    const label = dialogField.ownerDocument.createElement("label");
    label.textContent = "Choice";
    const select = dialogField.ownerDocument.createElement("select");
    select.dataset.dialogValue = "true";
    for (const option of request.options ?? []) {
      const optionElement = dialogField.ownerDocument.createElement("option");
      optionElement.value = option;
      optionElement.textContent = option;
      select.append(optionElement);
    }
    if (!select.options.length) {
      select.disabled = true;
      dialogSubmit.disabled = true;
      dialogStatus.textContent = "No options were provided for this dialog.";
    }
    label.append(select);
    dialogField.append(label);
  }

  function renderMobileDialogInput(request: ExtensionDialogRequest): void {
    const label = dialogField.ownerDocument.createElement("label");
    label.textContent = "Response";
    const input = dialogField.ownerDocument.createElement("input");
    input.dataset.dialogValue = "true";
    input.autocomplete = "off";
    input.spellcheck = false;
    if (request.placeholder) input.placeholder = request.placeholder;
    label.append(input);
    dialogField.append(label);
  }

  function renderMobileDialogEditor(request: ExtensionDialogRequest): void {
    const label = dialogField.ownerDocument.createElement("label");
    label.textContent = "Response";
    const textarea = dialogField.ownerDocument.createElement("textarea");
    textarea.dataset.dialogValue = "true";
    textarea.rows = request.promptStyle ? 6 : 10;
    textarea.value = request.prefill ?? "";
    label.append(textarea);
    dialogField.append(label);
  }


  function openDeleteSessionPicker(sessionId: string): void {
    const session = sessions.find(candidate => candidate.sessionId === sessionId);
    if (!session) return;
    const view = deriveSessionDeleteView(session);
    deleteSessionTarget = view;
    deleteSessionMessage.textContent = view.message;
    deleteSessionWorktree.checked = false;
    deleteSessionWorktree.disabled = !view.canDeleteWorktree;
    deleteSessionWorktreeRow.hidden = !view.canDeleteWorktree;
    deleteSessionWorktreePath.textContent = view.worktreeHelp;
    deleteSessionOverlay.hidden = false;
    window.setTimeout(() => deleteSessionCancel.focus(), 0);
  }

  function closeDeleteSessionPicker(): void {
    deleteSessionOverlay.hidden = true;
    deleteSessionTarget = null;
  }

  function submitDeleteSessionPicker(): void {
    const view = deleteSessionTarget;
    if (!view) return;
    send(sessionDeleteMessage(view, deleteSessionWorktree.checked));
    closeDeleteSessionPicker();
  }

  function createPendingImageMarker(): string {
    return createAttachmentMarker("Image", nextPendingImageId++);
  }

  async function addSelectedImages(fileList: FileList | null): Promise<void> {
    const files = Array.from(fileList ?? []).filter(file => file.type.startsWith("image/"));
    for (const file of files) {
      try {
        pendingImages.push({
          type: "image",
          marker: createPendingImageMarker(),
          data: await blobToBase64(file),
          mimeType: file.type,
        });
      } catch {
        appendLog("Failed to read selected image.");
      }
    }
    renderMobileImagePreviews();
    imageInput.value = "";
  }

  function clearPromptComposer(): void {
    promptInput.value = "";
    pendingImages = [];
    imageInput.value = "";
    renderMobileImagePreviews();
  }

  function removePendingImageMarker(marker: string): void {
    const nextValue = removePendingMarkerFromText(promptInput.value, marker);
    if (nextValue !== promptInput.value) promptInput.value = nextValue;
  }

  function renderMobileImagePreviews(): void {
    renderAttachmentPreviews(imagePreviews, pendingImages, [], {
      onRemoveImage: (index, image) => {
        pendingImages.splice(index, 1);
        removePendingImageMarker(image.marker);
        renderMobileImagePreviews();
      },
      onRemoveSnippet: () => undefined,
    });
    if (activeMobileView === "controller") imagePreviews.hidden = true;
    updateComposerStatus();
  }

  function updateComposerStatus(): void {
    if (activeMobileView === "controller") {
      composerStatus.textContent = controlStatusState.status === "working" ? "Ask Fura thinking" : "Ask Fura";
      return;
    }
    if (!activeSessionId) {
      composerStatus.textContent = "No active session";
      return;
    }
    const projection = projections.get(activeSessionId);
    const summary = sessions.find(session => session.sessionId === activeSessionId);
    const isBusy = projection?.isBusy ?? summary?.status === "busy";
    const hasPendingPlan = hasPendingPlanReview(activeSessionId);
    if (hasPendingPlan) {
      composerStatus.textContent = "Plan review waiting";
    } else if (isBusy) {
      composerStatus.textContent = "Agent busy";
    } else if (pendingImages.length > 0) {
      composerStatus.textContent = `${pendingImages.length} image${pendingImages.length === 1 ? "" : "s"} attached`;
    } else {
      composerStatus.textContent = "";
    }
  }

  function updateMobileStatusBar(projection: SessionProjection | undefined, summary?: SessionSummary): void {
    statusBar.replaceChildren();
    statusBar.classList.toggle("busy", Boolean(projection?.isBusy ?? summary?.status === "busy"));
    const parts: HTMLElement[] = [];
    const pi = mobileStatusPart("π", "status-pi");
    if (projection?.isBusy ?? summary?.status === "busy") pi.classList.add("is-running");
    parts.push(pi);

    if (!projection && !summary) {
      parts.push(mobileStatusPart("No session", "muted"));
      statusBar.append(...interleaveMobileStatusParts(parts));
      return;
    }

    if (projection) {
      parts.push(mobileStatusPart(projection.model ?? "model unknown", "model"));
      parts.push(mobileStatusPart(projection.thinkingLevel ?? "thinking inherit", "thinking"));
      if (projection.planMode?.enabled) parts.push(mobileStatusPart("Plan", "mode"));
    } else {
      parts.push(mobileStatusPart("Loading session", "muted"));
    }

    const cwd = projection?.summary.cwd ?? summary?.cwd;
    if (cwd) parts.push(mobileStatusPart(`📁 ${shortPath(cwd)}`, "cwd"));
    if (projection) {
      parts.push(mobileStatusPart(formatTokens(projection.tokensTotal), "tokens"));
      parts.push(mobileStatusPart(formatCost(projection.costUsd), "cost"));
      if (projection.contextPercent != null && projection.contextWindow != null) {
        parts.push(mobileStatusPart(formatContext(projection.contextPercent, projection.contextWindow), "context"));
      }
    }

    statusBar.append(...interleaveMobileStatusParts(parts));
  }

  function updateMobileControlStatusBar(): void {
    statusBar.replaceChildren();
    const parts = [
      mobileStatusPart("π", "status-pi"),
      mobileStatusPart("Ask Fura", "model"),
      mobileStatusPart(controlStatusState.status, controlStatusState.status === "working" ? "mode" : "muted"),
    ];
    if (controlStatusState.status === "working") parts[0].classList.add("is-running");
    statusBar.classList.toggle("busy", controlStatusState.status === "working");
    statusBar.append(...interleaveMobileStatusParts(parts));
  }

  function interleaveMobileStatusParts(parts: HTMLElement[]): Node[] {
    const nodes: Node[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) nodes.push(mobileStatusPart("›", "separator"));
      nodes.push(parts[i]);
    }
    return nodes;
  }

  function mobileStatusPart(text: string, className: string): HTMLElement {
    const span = statusBar.ownerDocument.createElement("span");
    span.className = `mobile-status-part ${className}`;
    span.textContent = text;
    return span;
  }

  function setCreateDrawerOpen(open: boolean): void {
    createDrawer.hidden = !open;
    createToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      syncCreateCwdDefault();
      syncCreateWorktreeFields();
      syncMobileProposedModelsUi();
    }
  }

  function syncCreateCwdDefault(): void {
    if (!createCwdDirty) createCwdInput.value = serverConfig?.defaultCwd ?? "";
  }

  function syncCreateWorktreeFields(): void {
    const enabled = createWorktreeEnabled.checked;
    createWorktreeFields.hidden = !enabled;
    if (!enabled) {
      createWorktreeSummary.textContent = "";
      return;
    }
    const view = deriveWorktreeCreateView({
      enabled,
      defaultCwd: serverConfig?.defaultCwd,
      normalCwd: createCwdInput.value,
      sessionName: createNameInput.value,
      sourceRepo: createWorktreeSourceRepo.value,
      directory: createWorktreeDirectory.value,
      baseBranch: createWorktreeBase.value,
      branchName: createWorktreeBranch.value,
      sourceRepoAutofill: !createWorktreeSourceDirty,
      directoryAutofill: !createWorktreeDirectoryDirty,
      baseBranchAutofill: !createWorktreeBaseDirty,
      branchAutofill: !createWorktreeBranchDirty,
    });
    createWorktreeSourceRepo.value = view.sourceRepo;
    lastAutofilledWorktreeDirectory = view.lastAutofilledDirectory;
    if (!createWorktreeDirectoryDirty) createWorktreeDirectory.value = view.directory;
    if (!createWorktreeBaseDirty) createWorktreeBase.value = view.baseBranch;
    lastAutofilledWorktreeBranch = view.lastAutofilledBranch;
    if (!createWorktreeBranchDirty) createWorktreeBranch.value = view.branchName;
    createWorktreeSummary.textContent = view.summary;
  }

  function setCreatePending(pending: boolean, requestId: string | null = null): void {
    createPendingRequestId = pending ? requestId : null;
    createNameInput.disabled = pending;
    createCwdInput.disabled = pending;
    createWorktreeEnabled.disabled = pending;
    createWorktreeSourceRepo.disabled = pending;
    createWorktreeDirectory.disabled = pending;
    createWorktreeBase.disabled = pending;
    createWorktreeBranch.disabled = pending;
    createSubmit.disabled = pending;
    createClose.disabled = pending;
    createStatus.textContent = pending ? "Creating session…" : "";
  }

  function focusCreateTarget(target: SessionCreateValidationTarget): void {
    const focusTargets: Partial<Record<SessionCreateValidationTarget, HTMLElement>> = {
      name: createNameInput,
      cwd: createCwdInput,
      worktreeSourceRepo: createWorktreeSourceRepo,
      worktreeDirectory: createWorktreeDirectory,
      worktreeBaseBranch: createWorktreeBase,
      worktreeBranchName: createWorktreeBranch,
    };
    focusTargets[target]?.focus();
  }

  function submitCreateSession(): void {
    const requestId = nextClientRequestId("mobile-session-create");
    const result = resolveSessionCreateMessage({
      requestId,
      cwd: createCwdInput.value,
      name: createNameInput.value,
      proposedModelId: createProposedModel.value,
      worktree: {
        enabled: createWorktreeEnabled.checked,
        sourceRepo: createWorktreeSourceRepo.value,
        directory: createWorktreeDirectory.value,
        baseBranch: createWorktreeBase.value,
        branchName: createWorktreeBranch.value,
      },
    });
    if (result.type === "invalid") {
      createStatus.textContent = result.message;
      focusCreateTarget(result.target);
      return;
    }

    pendingCreatedSessionBaseline = new Set(sessions.map(session => session.sessionId));
    setCreatePending(true, requestId);
    const accepted = send(result.message);
    if (!accepted) {
      pendingCreatedSessionBaseline = null;
      setCreatePending(false);
      createStatus.textContent = "Not connected to the Fura bridge.";
    }
  }

  function isPendingCreatedSession(sessionId: string): boolean {
    return Boolean(pendingCreatedSessionBaseline && !pendingCreatedSessionBaseline.has(sessionId));
  }

  function finishCreateSession(): void {
    pendingCreatedSessionBaseline = null;
    setCreatePending(false);
    createNameInput.value = "";
    createCwdDirty = false;
    createWorktreeSourceDirty = false;
    createWorktreeBaseDirty = false;
    createWorktreeDirectoryDirty = false;
    createWorktreeBranchDirty = false;
    lastAutofilledWorktreeDirectory = "";
    lastAutofilledWorktreeBranch = "";
    createWorktreeEnabled.checked = false;
    createWorktreeDirectory.value = "";
    createWorktreeBranch.value = "";
    syncCreateWorktreeFields();
    syncCreateCwdDefault();
    setCreateDrawerOpen(false);
  }

  function handleCreateError(requestId: string | null, message: string): boolean {
    if (!createPendingRequestId || requestId !== createPendingRequestId) return false;
    pendingCreatedSessionBaseline = null;
    setCreatePending(false);
    setCreateDrawerOpen(true);
    createStatus.textContent = message;
    return true;
  }

  function handleConnectionClosed(): void {
    if (!createPendingRequestId) return;
    const requestId = createPendingRequestId;
    handleCreateError(requestId, "Connection closed before session creation completed.");
  }

  function nextClientRequestId(prefix: string): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function setActiveMobileView(view: MobileWorkspaceView): void {
    const wasController = activeMobileView === "controller";
    const willBeController = view === "controller";
    const leavingDiff = activeMobileView === "diff" && view !== "diff";
    if (view !== "controller") lastSessionMobileView = view;
    if (wasController !== willBeController) {
      if (wasController) {
        controllerPromptDraft = promptInput.value;
        promptInput.value = sessionPromptDraft;
      } else {
        sessionPromptDraft = promptInput.value;
        promptInput.value = controllerPromptDraft;
      }
    }
    if (leavingDiff) clearCurrentSessionChangesRequest("closed");
    activeMobileView = view;
    sessionWorkspaceTabs.hidden = willBeController;
    controllerView.hidden = !willBeController;
    transcript.hidden = view !== "transcript";
    diffView.hidden = view !== "diff";
    askFuraButton.classList.toggle("active", willBeController);
    askFuraButton.setAttribute("aria-pressed", String(willBeController));
    syncMobileWorkspaceTab(transcriptTab, view === "transcript");
    syncMobileWorkspaceTab(diffTab, view === "diff");
    if (view === "diff" && activeSessionId && !sessionChangesStates.has(activeSessionId)) {
      requestMobileSessionChanges(activeSessionId);
    }
    renderActiveSession();
  }

  function syncMobileWorkspaceTab(tab: HTMLButtonElement, active: boolean): void {
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }

  function requestMobileSessionChanges(sessionId: string): void {
    const projection = projections.get(sessionId);
    if (!projection || diffLoadingSessions.has(sessionId)) return;
    const diffId = crypto.randomUUID();
    setCurrentSessionChangesRequest(sessionId, diffId, "replaced");
    sessionChangesDiffIds.set(sessionId, diffId);
    window.sessionStorage.setItem(`fura.mobile.diff.current.${sessionId}`, diffId);
    diffErrors.delete(sessionId);
    diffLoadingSessions.add(sessionId);
    const sent = send({ type: "sessionChanges.request", clientId: diffClientId, diffId, sessionId, repoId: null, detailMode: "statOnly", currentCommitOid: null, selectedFile: null });
    if (!sent) {
      if (currentSessionChangesRequest?.diffId === diffId) currentSessionChangesRequest = null;
      diffLoadingSessions.delete(sessionId);
      diffErrors.set(sessionId, "Not connected to the Fura bridge.");
    }
    renderDiffView(projection);
  }

  function requestMobileSessionChangesRefresh(
    sessionId: string,
    options: { repoId?: string | null; payloadKind?: DiffDetailMode | null; currentCommitOid?: string | null } = {},
  ): void {
    const projection = projections.get(sessionId);
    if (!projection || diffLoadingSessions.has(sessionId)) return;
    const diffId = crypto.randomUUID();
    setCurrentSessionChangesRequest(sessionId, diffId, options.payloadKind ? "payloadChanged" : options.currentCommitOid ? "refsChanged" : "refreshed");
    sessionChangesDiffIds.set(sessionId, diffId);
    window.sessionStorage.setItem(`fura.mobile.diff.current.${sessionId}`, diffId);
    diffErrors.delete(sessionId);
    diffLoadingSessions.add(sessionId);
    const sent = send({
      type: "sessionChanges.request",
      clientId: diffClientId,
      diffId,
      sessionId,
      repoId: options.repoId ?? null,
      detailMode: options.payloadKind ?? diffPayloadKinds.get(sessionId) ?? "statOnly",
      currentCommitOid: options.currentCommitOid ?? null,
      selectedFile: null,
    });
    if (!sent) {
      if (currentSessionChangesRequest?.diffId === diffId) currentSessionChangesRequest = null;
      diffLoadingSessions.delete(sessionId);
      diffErrors.set(sessionId, "Not connected to the Fura bridge.");
    }
    renderDiffView(projection);
  }

  function requestMobileSessionChangesRepo(sessionId: string, repoId: string, payloadKind: DiffDetailMode): void {
    const projection = projections.get(sessionId);
    if (!projection || diffLoadingSessions.has(sessionId)) return;
    diffPayloadKinds.set(sessionId, payloadKind);
    const diffId = crypto.randomUUID();
    setCurrentSessionChangesRequest(sessionId, diffId, "repoChanged");
    sessionChangesDiffIds.set(sessionId, diffId);
    window.sessionStorage.setItem(`fura.mobile.diff.current.${sessionId}`, diffId);
    diffErrors.delete(sessionId);
    diffLoadingSessions.add(sessionId);
    const sent = send({ type: "sessionChanges.request", clientId: diffClientId, diffId, sessionId, repoId, detailMode: payloadKind, currentCommitOid: null, selectedFile: null });
    if (!sent) {
      if (currentSessionChangesRequest?.diffId === diffId) currentSessionChangesRequest = null;
      diffLoadingSessions.delete(sessionId);
      diffErrors.set(sessionId, "Not connected to the Fura bridge.");
    }
    renderDiffView(projection);
  }

  function handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        serverConfig = message.config;
        applyVisibilityPreferences(
          parseToolVisibility(message.config.showTools),
          parseThinkingVisibilityMode(message.config.thinkingVisibility),
        );
        syncCreateCwdDefault();
        syncMobileProposedModelsUi();
        reviewCommentsRequested.clear();
        reviewCommentsLoadInFlight.clear();
        reviewCommentsResyncNeeded.clear();
        if (activeMobileView === "diff" && activeSessionId) renderActiveSession();
        console.debug(`[fura-mobile] Connected to fura ${message.serverVersion}.`);
        break;
      case "config.updated":
        serverConfig = message.config;
        applyVisibilityPreferences(
          parseToolVisibility(message.config.showTools),
          parseThinkingVisibilityMode(message.config.thinkingVisibility),
        );
        syncCreateCwdDefault();
        syncMobileProposedModelsUi();
        proposedModelName.value = "";
        proposedModelEditingId = null;
        proposedModelSearch.value = "";
        proposedModelStatus.textContent = "Saved.";
        break;
      case "sessions.snapshot":
        ({ sessions, activeSessionId } = applySessionsSnapshot(message.sessions, activeSessionId));
        syncTrackedSessionsWithSnapshot();
        pruneVisiblePlanReviewsWithSessionList();
        if (pendingRestoreAfterSessionsSnapshot) {
          pendingRestoreAfterSessionsSnapshot = false;
          restoreTrackedManagedSessions();
        }
        render();
        break;
      case "session.snapshot": {
        rememberTrackedSessionId(message.sessionId);
        const createdByPendingRequest = isPendingCreatedSession(message.sessionId);
        ({ sessions, projections } = applySessionSnapshot(sessions, projections, message.sessionId, message.state));
        syncVisiblePlanReviewFromProjection(message.sessionId, message.state);
        if (createdByPendingRequest || !activeSessionId || activeSessionId === message.sessionId) {
          activateSession(message.sessionId);
          if (createdByPendingRequest) finishCreateSession();
          render();
        } else {
          unreadSessions.add(message.sessionId);
          renderSessions();
        }
        break;
      }
      case "session.exited":
        appendLog(`Session ${message.sessionId} exited with code ${message.code ?? "unknown"}.`);
        render();
        break;
      case "session.notice":
        appendLog(`[${message.sessionId}] ${message.level}: ${message.text}`);
        if (message.level === "error" && diffLoadingSessions.has(message.sessionId)) {
          diffLoadingSessions.delete(message.sessionId);
          diffErrors.set(message.sessionId, message.text);
          if (message.sessionId === activeSessionId) renderActiveSession();
        }
        break;
      case "prompt.busy":
        handlePromptBusy(message);
        break;
      case "log.stderr":
        console.debug(`[fura-mobile] [${message.sessionId}] ${message.text}`);
        break;
      case "config.modelCatalog.list":
        if (!message.requestId || message.requestId === proposedModelCatalogRequestId) {
          proposedModelCatalogModels = message.models;
          proposedModelCatalogRequestId = null;
          proposedModelStatus.textContent = `${message.models.length} runtime model${message.models.length === 1 ? "" : "s"}`;
          syncMobileProposedModelsUi();
        }
        break;
      case "error":
        appendLog(`Error: ${message.message}`);
        if (message.requestId && message.requestId === proposedModelCatalogRequestId) {
          proposedModelCatalogRequestId = null;
          proposedModelStatus.textContent = message.message;
          break;
        }
        if (handleCreateError(message.requestId ?? null, message.message)) break;
        break;
      case "dialog.request":
        handleDialogRequest(message);
        break;
      case "model.list":
      case "model.changed":
        break;
      case "plan.review":
        handlePlanReview(message);
        break;
      case "raw.omp":
        break;
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
        clearPendingMobileDiffFilePatch(state.sessionId, state.diffId);
        mobileDiffFilePatchErrors.delete(state.sessionId);
        sessionChangesStates.set(state.sessionId, state);
        if (state.status === "ready") {
          diffPayloadKinds.set(state.sessionId, state.comparison.detailMode);
          selectedMobileDiffFilePath(state, state.sessionId, state.summary.files.map(file => file.newPath));
          pruneMobileDiffPatchCache(state.comparison.comparisonKey);
        } else {
          mobileSelectedDiffFiles.delete(state.sessionId);
          pruneMobileDiffPatchCache(null);
        }
        if (state.sessionId === activeSessionId && activeMobileView === "diff") renderActiveSession();
        break;
      }
      case "diff.filePatch": {
        const patch = message.patch;
        if (patch.targetClientId !== diffClientId || patch.scope !== "sessionChanges") break;
        const sessionId = currentSessionChangesRequest?.sessionId;
        const state = sessionId ? sessionChangesStates.get(sessionId) : undefined;
        if (
          !sessionId ||
          currentSessionChangesRequest?.diffId !== patch.diffId ||
          state?.status !== "ready" ||
          state.comparison.comparisonKey !== patch.comparisonKey
        ) {
          break;
        }
        rememberMobileDiffPatch(`${patch.comparisonKey}\0${patch.file.newPath}`, { patch: patch.patch, truncated: patch.truncated });
        clearPendingMobileDiffFilePatch(sessionId, patch.diffId);
        if (mobileDiffFilePatchErrors.get(sessionId)?.filePath === patch.file.newPath) mobileDiffFilePatchErrors.delete(sessionId);
        if (sessionId === activeSessionId && activeMobileView === "diff") renderActiveSession();
        break;
      }
      case "diff.complete":
      case "diff.cancelled": {
        const currentRequest = currentSessionChangesRequest;
        if (message.targetClientId !== diffClientId || currentRequest?.diffId !== message.diffId) break;
        diffLoadingSessions.delete(currentRequest.sessionId);
        clearPendingMobileDiffFilePatch(currentRequest.sessionId, message.diffId);
        if (currentRequest.sessionId === activeSessionId && activeMobileView === "diff") renderActiveSession();
        break;
      }
      case "diff.error": {
        if (message.targetClientId && message.targetClientId !== diffClientId) break;
        const pending = message.sessionId ? pendingMobileDiffFilePatches.get(message.sessionId) : undefined;
        const state = message.sessionId ? sessionChangesStates.get(message.sessionId) : undefined;
        if (
          message.scope === "sessionChanges" &&
          message.sessionId &&
          message.diffId &&
          pending &&
          state?.status === "ready" &&
          pending.diffId === message.diffId &&
          pending.comparisonKey === state.comparison.comparisonKey
        ) {
          pendingMobileDiffFilePatches.delete(message.sessionId);
          mobileDiffFilePatchErrors.set(message.sessionId, { filePath: pending.filePath, message: message.message });
          if (message.sessionId === activeSessionId && activeMobileView === "diff") renderActiveSession();
          break;
        }
        const currentRequest = currentSessionChangesRequest;
        if (
          message.scope !== "sessionChanges" ||
          !message.sessionId ||
          !message.diffId ||
          currentRequest?.sessionId !== message.sessionId ||
          currentRequest?.diffId !== message.diffId
        ) {
          break;
        }
        diffLoadingSessions.delete(message.sessionId);
        diffErrors.set(message.sessionId, message.message);
        if (message.sessionId === activeSessionId) renderActiveSession();
        break;
      }
      case "diff.reviewWorktree.state":
        break;
      case "review.comments.snapshot":
        reviewCommentsLoadInFlight.delete(message.sessionId);
        if (reviewCommentsResyncNeeded.has(message.sessionId)) {
          reviewCommentsResyncNeeded.delete(message.sessionId);
          reviewCommentsRequested.delete(message.sessionId);
          ensureReviewCommentsLoaded(message.sessionId);
          break;
        }
        reviewComments.set(message.sessionId, message.comments);
        reviewCommentsRequested.add(message.sessionId);
        if (message.sessionId === activeSessionId && activeMobileView === "diff") renderActiveSession();
        break;
      case "review.comment.upserted": {
        if (reviewCommentsLoadInFlight.has(message.comment.sessionId)) {
          reviewCommentsResyncNeeded.add(message.comment.sessionId);
        }
        const existing = reviewComments.get(message.comment.sessionId) ?? [];
        reviewComments.set(
          message.comment.sessionId,
          [...existing.filter(comment => comment.id !== message.comment.id), message.comment],
        );
        if (message.comment.sessionId === activeSessionId && activeMobileView === "diff") renderActiveSession();
        break;
      }
      case "review.comment.deleted":
        if (reviewCommentsLoadInFlight.has(message.sessionId)) {
          reviewCommentsResyncNeeded.add(message.sessionId);
        }
        reviewComments.set(
          message.sessionId,
          (reviewComments.get(message.sessionId) ?? []).filter(comment => comment.id !== message.id),
        );
        if (message.sessionId === activeSessionId && activeMobileView === "diff") renderActiveSession();
        break;
      case "control.reply":
        if (message.targetClientId === controlClientId) handleControlReply(message);
        break;
      case "control.status":
        if (!message.targetClientId || message.targetClientId === controlClientId) {
          controlStatusState = message.status;
          renderControlConversation();
          updateComposerStatus();
        }
        break;
      case "frontend.control":
        if (message.targetClientId === controlClientId) handleFrontendControl(message.action);
        break;
      case "voice.status":
      case "voice.delta":
      case "voice.final":
      case "voice.error":
        break;
    }
  }

  function submitControlPromptText(text: string): boolean {
    const prompt = text.trim();
    if (!prompt) return false;
    const conversationId = controlConversationId ?? nextClientRequestId("control-conversation");
    const accepted = send({
      type: "control.prompt",
      clientId: controlClientId,
      conversationId,
      text: prompt,
      uiSnapshot: captureFrontendUiSnapshot(),
    });
    if (!accepted) return false;
    controlConversationId = conversationId;
    controlMessages.push({ role: "user", text: prompt });
    controlStatusState = { status: "working", message: "Ask Fura is thinking." };
    renderControlConversation();
    updateComposerStatus();
    return true;
  }

  function captureFrontendUiSnapshot(): FrontendUiSnapshot {
    const modalOpen = Boolean(document.querySelector(".mobile-dialog-overlay:not([hidden])"));
    return {
      activeSessionId,
      focusedArea: mobileFocusedArea(),
      sessionIds: sessions.map(session => session.sessionId),
      promptDraft: {
        sessionId: activeMobileView === "controller" ? null : activeSessionId,
        hasText: promptInput.value.trim().length > 0,
        textLength: promptInput.value.length,
      },
      panels: {
        transcriptVisible: activeMobileView === "transcript" || activeMobileView === "controller",
        toolsVisible: false,
      },
      blockingUi: {
        modalOpen,
        dialogOpen: Boolean(activeDialog),
      },
    };
  }

  function mobileFocusedArea(): FrontendUiSnapshot["focusedArea"] {
    const element = document.activeElement;
    if (activeMobileView === "controller" && element === promptInput) return "controller";
    if (element === promptInput) return "prompt";
    if (element && sessionsList.contains(element)) return "sessionList";
    if (element && controllerView.contains(element)) return "controller";
    if (element && transcript.contains(element)) return "transcript";
    return "unknown";
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
        selectSession(action.sessionId);
        setActiveMobileView("transcript");
        break;
      case "setPromptDraft": {
        const targetSessionId = action.sessionId ?? activeSessionId;
        if (targetSessionId) {
          const target = sessions.find(session => session.sessionId === targetSessionId);
          if (target) {
            activateSession(targetSessionId);
            send(sessionOpenOrAttachMessage(target));
          }
        }
        sessionPromptDraft = action.text;
        setActiveMobileView("transcript");
        promptInput.value = action.text;
        if (action.focus) promptInput.focus();
        renderActiveSession();
        break;
      }
      case "focus":
        if (action.target === "controller") setActiveMobileView("controller");
        else setActiveMobileView("transcript");
        promptInput.focus();
        break;
      case "showNotice":
        controlMessages.push({ role: "system", text: action.text });
        renderControlConversation();
        appendLog(action.text);
        break;
    }
  }

  function renderControlConversation(): void {
    if (activeMobileView === "controller") renderActiveSession();
  }

  function renderControllerView(): void {
    setRenderDocument(controllerView.ownerDocument);
    const wasNearBottom = controllerView.scrollHeight - controllerView.scrollTop - controllerView.clientHeight < 120;
    const fragment = controllerView.ownerDocument.createDocumentFragment();
    for (const [index, message] of controlMessages.entries()) {
      fragment.append(renderControlTranscriptMessage(message, index));
    }
    if (!fragment.hasChildNodes()) {
      const empty = controllerView.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "Ask Fura can find sessions, discuss candidates, open a session, or stage a prompt draft.";
      fragment.append(empty);
    }
    controllerView.replaceChildren(fragment);
    if (wasNearBottom) controllerView.scrollTop = controllerView.scrollHeight;
  }

  function renderControlTranscriptMessage(message: ControlChatMessage, index: number): HTMLElement {
    const article = renderMessage({
      id: `mobile-ask-fura-${index}`,
      role: message.role,
      blocks: [{ kind: "text", text: message.text }],
      timestamp: null,
      isNew: false,
    }, { thinkingVisibilityMode });
    const roleLabel = article.querySelector(".message-heading strong");
    if (roleLabel && message.role === "assistant") roleLabel.textContent = "Ask Fura";
    for (const candidate of message.candidates ?? []) article.append(renderControlCandidate(candidate));
    for (const suggestion of message.suggestedActions ?? []) article.append(renderControlSuggestion(suggestion));
    return article;
  }

  function renderControlCandidate(candidate: ControlCandidate): HTMLElement {
    const card = controllerView.ownerDocument.createElement("div");
    card.className = "control-candidate mobile-control-candidate";
    const title = controllerView.ownerDocument.createElement("strong");
    title.textContent = candidate.title || `Session ${shortId(candidate.sessionId)}`;
    const reason = controllerView.ownerDocument.createElement("span");
    reason.textContent = candidate.reason;
    const open = controllerView.ownerDocument.createElement("button");
    open.type = "button";
    open.textContent = "Open";
    open.addEventListener("click", () => handleFrontendControl({ type: "selectSession", sessionId: candidate.sessionId }));
    card.append(title, reason, open);
    for (const snippetText of candidate.snippets ?? []) {
      const snippet = controllerView.ownerDocument.createElement("p");
      snippet.className = "control-snippet";
      snippet.textContent = snippetText;
      card.append(snippet);
    }
    return card;
  }

  function renderControlSuggestion(suggestion: ControlSuggestedAction): HTMLElement {
    const button = controllerView.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "control-suggestion mobile-control-suggestion";
    button.textContent = suggestion.label;
    button.addEventListener("click", () => handleFrontendControl(suggestion.action));
    return button;
  }

  function selectSession(sessionId: string): void {
    const session = sessions.find(candidate => candidate.sessionId === sessionId);
    if (!session) return;
    activateSession(sessionId);
    sessionsDrawer.hidden = true;
    sessionsToggle.setAttribute("aria-expanded", "false");
    send(sessionOpenOrAttachMessage(session));
    render();
  }

  function activateSession(sessionId: string): void {
    const previousSessionId = activeSessionId;
    activeSessionId = activateSessionState(unreadSessions, sessionId);
    rememberTrackedSessionId(sessionId);
    writeStoredActiveSessionId(window.sessionStorage, sessionId);
    if (previousSessionId && previousSessionId !== sessionId && currentSessionChangesRequest?.sessionId === previousSessionId) {
      clearCurrentSessionChangesRequest("sessionChanged");
    }
    if (activeMobileView === "diff" && projections.has(sessionId) && !sessionChangesStates.has(sessionId)) requestMobileSessionChanges(sessionId);
  }

  function syncTrackedSessionsWithSnapshot(): void {
    const visibleSessionIds = new Set(sessions.map(session => session.sessionId));
    for (const sessionId of [...trackedSessionIds]) {
      if (!visibleSessionIds.has(sessionId)) trackedSessionIds.delete(sessionId);
    }
    if (activeSessionId) writeStoredActiveSessionId(window.sessionStorage, activeSessionId);
    else clearStoredActiveSessionId(window.sessionStorage);
    writeStoredTrackedSessionIds(window.sessionStorage, trackedSessionIds);
  }

  function restoreTrackedManagedSessions(): void {
    const managedSessionIds = new Set(
      sessions
        .filter(session => session.kind === "managed")
        .map(session => session.sessionId),
    );
    const restoreIds = orderedTrackedSessionIds(activeSessionId, trackedSessionIds)
      .filter(sessionId => managedSessionIds.has(sessionId));
    for (const sessionId of restoreIds) {
      send({ type: "state.refresh", sessionId });
    }
  }

  function rememberTrackedSessionId(sessionId: string): void {
    if (trackedSessionIds.has(sessionId)) trackedSessionIds.delete(sessionId);
    trackedSessionIds.add(sessionId);
    while (trackedSessionIds.size > MAX_TRACKED_MOBILE_SESSION_IDS) {
      const oldestSessionId = trackedSessionIds.values().next().value;
      if (!oldestSessionId) break;
      trackedSessionIds.delete(oldestSessionId);
    }
    writeStoredTrackedSessionIds(window.sessionStorage, trackedSessionIds);
  }

  function render(): void {
    renderSessions();
    renderActiveSession();
  }

  function renderSessions(): void {
    const categories = sessionCategories(sessions);
    selectedCategoryFilter = renderSessionCategoryFilter(categoryFilter, categories, selectedCategoryFilter);
    const filteredSessions = visibleSessions(sessions, selectedCategoryFilter);
    sessionListView.render({
      sessions,
      visibleSessions: filteredSessions,
      selectedCategoryFilter,
      activeSessionId,
      unreadSessionIds: unreadSessions,
    });
  }

  function reviewCommentsForMessage(sessionId: string, messageId: string): TranscriptReviewComment[] {
    return (transcriptReviewComments.get(sessionId) ?? []).filter(comment => comment.messageId === messageId);
  }

  function startTranscriptReview(sessionId: string, message: TranscriptMessage): void {
    transcriptReviewActiveMessages.set(sessionId, message.id);
    renderActiveSession();
  }

  function cancelTranscriptReview(sessionId: string, message: TranscriptMessage): void {
    transcriptReviewActiveMessages.delete(sessionId);
    transcriptReviewComments.set(
      sessionId,
      (transcriptReviewComments.get(sessionId) ?? []).filter(comment => comment.messageId !== message.id),
    );
    renderActiveSession();
  }

  function addTranscriptReviewComment(sessionId: string, message: TranscriptMessage, line: TranscriptReviewLine): void {
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
    renderActiveSession();
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
    renderActiveSession();
  }

  function deleteTranscriptReviewComment(sessionId: string, comment: TranscriptReviewComment): void {
    transcriptReviewComments.set(
      sessionId,
      (transcriptReviewComments.get(sessionId) ?? []).filter(existing => existing.id !== comment.id),
    );
    renderActiveSession();
  }

  function flushTranscriptReviewComments(sessionId: string, message: TranscriptMessage): void {
    const comments = reviewCommentsForMessage(sessionId, message.id);
    if (comments.length === 0) return;
    const promptText = buildTranscriptReviewPrompt(message, comments);
    reviewPreviewDraft = { sessionId, message, comments, promptText };
    reviewPreviewText.value = promptText;
    reviewPreviewStatus.textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"} ready to send`;
    reviewPreviewOverlay.hidden = false;
    reviewPreviewText.scrollTop = 0;
    reviewPreviewSend.focus();
  }

  function closeReviewPreview(): void {
    reviewPreviewOverlay.hidden = true;
    reviewPreviewText.value = "";
    reviewPreviewStatus.textContent = "";
    reviewPreviewDraft = null;
  }

  function sendReviewPreviewDraft(): void {
    const draft = reviewPreviewDraft;
    if (!draft) return;
    closeReviewPreview();
    const accepted = send(createPromptSendMessage(
      draft.sessionId,
      draft.promptText ?? buildTranscriptReviewPrompt(draft.message, draft.comments),
      [],
    ));
    if (!accepted) return;
    transcriptReviewComments.set(
      draft.sessionId,
      (transcriptReviewComments.get(draft.sessionId) ?? []).filter(comment => comment.messageId !== draft.message.id),
    );
    transcriptReviewActiveMessages.delete(draft.sessionId);
    renderActiveSession();
  }

  function transcriptReviewOptions(sessionId: string, message: TranscriptMessage) {
    return {
      active: transcriptReviewActiveMessages.get(sessionId) === message.id,
      comments: reviewCommentsForMessage(sessionId, message.id),
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
    const comments = reviewCommentsForMessage(sessionId, message.id);
    if (comments.length === 0) return;
    const promptText = buildPlanReviewPrompt(review, comments);
    reviewPreviewDraft = { sessionId, message, comments, promptText };
    reviewPreviewText.value = promptText;
    reviewPreviewStatus.textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"} ready to send`;
    reviewPreviewOverlay.hidden = false;
    reviewPreviewText.scrollTop = 0;
    reviewPreviewSend.focus();
  }

  function planReviewLineOptions(sessionId: string, review: PendingPlanReview) {
    const message = planReviewTranscriptMessage(review);
    return {
      active: transcriptReviewActiveMessages.get(sessionId) === message.id,
      comments: reviewCommentsForMessage(sessionId, message.id),
      onStart: (target: TranscriptMessage) => startTranscriptReview(sessionId, target),
      onAddComment: (target: TranscriptMessage, line: TranscriptReviewLine) => addTranscriptReviewComment(sessionId, target, line),
      onEditComment: (_target: TranscriptMessage, comment: TranscriptReviewComment) => editTranscriptReviewComment(sessionId, comment),
      onDeleteComment: (_target: TranscriptMessage, comment: TranscriptReviewComment) => deleteTranscriptReviewComment(sessionId, comment),
      onCancel: (target: TranscriptMessage) => cancelTranscriptReview(sessionId, target),
      onFlush: () => flushPlanReviewComments(sessionId, review),
    };
  }
  function renderActiveSession(): void {
    if (activeMobileView === "controller") {
      const isWorking = controlStatusState.status === "working";
      sessionTitle.textContent = "Ask Fura";
      sessionMeta.hidden = false;
      sessionMeta.textContent = "Find, discuss, and open Fura sessions.";
      promptInput.disabled = isWorking;
      sendButton.disabled = isWorking;
      imageInput.disabled = true;
      renderMobileImagePreviews();
      promptInput.placeholder = isWorking ? "Ask Fura is working…" : "Ask Fura about sessions…";
      updateMobileControlStatusBar();
      updateComposerStatus();
      renderControllerView();
      renderBusyPromptChoice();
      return;
    }
    const projection = activeSessionId ? projections.get(activeSessionId) : undefined;
    const summary = projection?.summary ?? sessions.find(session => session.sessionId === activeSessionId);
    if (!activeSessionId || !summary) {
      sessionTitle.textContent = "No session selected";
      sessionMeta.hidden = false;
      sessionMeta.textContent = serverConfig ? "Choose a session." : "Waiting for bridge connection.";
      promptInput.disabled = true;
      sendButton.disabled = true;
      imageInput.disabled = true;
      promptInput.placeholder = "Select a session first";
      composerStatus.textContent = "No active session";
      updateMobileStatusBar(undefined);
      renderMobileImagePreviews();
      closeReviewPreview();
      renderTranscript(undefined);
      renderDiffView(undefined);
      renderBusyPromptChoice();
      return;
    }

    const isBusy = projection?.isBusy ?? summary.status === "busy";
    const hasPendingPlan = hasPendingPlanReview(activeSessionId);
    sessionTitle.textContent = summary.title || `Session ${shortId(summary.sessionId)}`;
    sessionMeta.hidden = true;
    sessionMeta.textContent = "";
    updateMobileStatusBar(projection, summary);
    promptInput.disabled = !projection || hasPendingPlan;
    sendButton.disabled = !projection || hasPendingPlan;
    imageInput.disabled = !projection || hasPendingPlan;
    renderMobileImagePreviews();
    promptInput.placeholder = hasPendingPlan ? "Choose Approve and execute, Refine plan, or Discuss plan first…" : "Send a prompt…";
    updateComposerStatus();
    renderTranscript(projection);
    if (activeMobileView === "diff") renderDiffView(projection);
    renderBusyPromptChoice();
  }

  function renderTranscript(projection: SessionProjection | undefined): void {
    setRenderDocument(transcript.ownerDocument);
    const wasNearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;

    if (!projection) {
      const empty = transcript.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "Select a session to load its transcript.";
      transcript.replaceChildren(empty);
      return;
    }

    const fragment = transcript.ownerDocument.createDocumentFragment();
    for (const entry of projection.transcript) {
      if (entry.kind === "message") {
        fragment.append(renderMessage(entry, {
          thinkingVisibilityMode,
          review: activeSessionId ? transcriptReviewOptions(activeSessionId, entry) : undefined,
        }));
      } else if (showToolBubbles) {
        fragment.append(renderToolCard(entry));
      }
    }

    for (const phaseCard of renderTodoCards(projection.todoPhases ?? [])) {
      fragment.append(phaseCard);
    }

    const visiblePlanReview = visiblePlanReviews.get(projection.summary.sessionId);
    if (visiblePlanReview) {
      fragment.append(renderPlanReviewCard(
        visiblePlanReview.review,
        {
          onApprove: approvePendingPlanReview,
          onRefine: refinePendingPlanReview,
          onDiscuss: discussPendingPlanReview,
        },
        visiblePlanReview.mode,
        visiblePlanReview.mode === "refining" ? planReviewLineOptions(projection.summary.sessionId, visiblePlanReview.review) : undefined,
      ));
    }
    if (!fragment.hasChildNodes()) {
      const empty = transcript.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "Transcript is empty.";
      fragment.append(empty);
    }

    transcript.replaceChildren(fragment);
    if (wasNearBottom) transcript.scrollTop = transcript.scrollHeight;
  }

  function renderDiffView(projection: SessionProjection | undefined): void {
    if (activeMobileView !== "diff") return;
    setRenderDocument(diffView.ownerDocument);
    diffView.replaceChildren();

    if (!activeSessionId || !projection) {
      renderMobileDiffMessage("Select a session to load its diff.");
      return;
    }

    const sessionId = activeSessionId;
    const state = sessionChangesStates.get(sessionId);
    const error = diffErrors.get(sessionId);
    if (error) {
      renderMobileDiffMessage(error);
      return;
    }
    if (!state) {
      renderMobileDiffMessage(diffLoadingSessions.has(sessionId) ? "Loading session changes…" : "No session changes loaded yet.");
      if (!diffLoadingSessions.has(sessionId)) requestMobileSessionChanges(sessionId);
      return;
    }
    if (!diffLoadingSessions.has(sessionId) && (currentSessionChangesRequest?.sessionId !== sessionId || currentSessionChangesRequest?.diffId !== state.diffId)) {
      currentSessionChangesRequest = { sessionId, diffId: state.diffId };
    }
    renderMobileSessionChangesControls(sessionId, state);
    if (state.status === "missingRepo") {
      renderMobileDiffMessage(state.reason);
      return;
    }
    if (state.status === "missingSnapshot") {
      renderMobileDiffMessage(state.reason);
      return;
    }
    renderMobileDiffBody(state, sessionId);
  }

  function renderMobileDiffMessage(text: string): void {
    const message = diffView.ownerDocument.createElement("p");
    message.className = "mobile-empty-state";
    message.textContent = text;
    diffView.append(message);
  }

  function renderMobileSessionChangesControls(sessionId: string, state: SessionChangesSummaryState): void {
    const controls = diffView.ownerDocument.createElement("section");
    controls.className = "mobile-diff-controls";
    const title = diffView.ownerDocument.createElement("h3");
    title.textContent = "Session changes";
    const meta = diffView.ownerDocument.createElement("p");
    meta.className = "mobile-diff-meta";
    meta.textContent = state.status === "ready"
      ? `${resolvedRefLabel(state.comparison.base)} → ${resolvedRefLabel(state.comparison.head)}`
      : "Backend-derived repositories only";
    controls.append(title, meta);

    const fields = diffView.ownerDocument.createElement("div");
    fields.className = "mobile-diff-fields";
    const selectedRepo = state.status === "ready" ? state.selectedRepoId : state.repos[0]?.id ?? "";
    fields.append(renderDiffSelect(
      "Repository",
      state.repos.map(repo => ({ value: repo.id, label: repo.label || formatDiffRepoLabel(repo.repoRoot), title: repo.repoRoot })),
      selectedRepo,
      diffLoadingSessions.has(sessionId),
      repoId => requestMobileSessionChangesRepo(sessionId, repoId, diffPayloadKinds.get(sessionId) ?? "statOnly"),
    ));
    const payloadKind = state.status === "ready" ? state.comparison.detailMode : diffPayloadKinds.get(sessionId) ?? "statOnly";
    fields.append(renderDiffSelect(
      "Payload",
      [{ value: "filePatch", label: "File patch" }, { value: "statOnly", label: "Stat" }],
      payloadKind,
      diffLoadingSessions.has(sessionId),
      value => requestMobileSessionChangesRepo(sessionId, selectedRepo, value as DiffDetailMode),
    ));

    const actions = diffView.ownerDocument.createElement("div");
    actions.className = "mobile-diff-actions";
    const refreshButton = renderDiffAction(
      diffLoadingSessions.has(sessionId) ? "Refreshing…" : "Refresh",
      false,
      diffLoadingSessions.has(sessionId),
      () => requestMobileSessionChangesRefresh(sessionId),
    );
    const queuedAnnotations = state.status === "ready"
      ? selectedDiffAnnotations(diffAnnotations.get(sessionId) ?? [], comparisonKey(state))
      : [];
    const flushButton = renderDiffAction(
      `Preview & flush (${queuedAnnotations.length})`,
      false,
      diffLoadingSessions.has(sessionId) || queuedAnnotations.length === 0,
      () => { if (state.status === "ready") openDiffPreview(sessionId, state); },
    );
    const selectedFilePath = state.status === "ready"
      ? selectedMobileDiffFilePath(state, sessionId, state.summary.files.map(file => file.newPath))
      : null;
    const selectedPatch = state.status === "ready" && selectedFilePath
      ? mobileDiffPatchCache.get(`${comparisonKey(state)}\0${selectedFilePath}`)?.patch ?? (state as { patch?: string | null }).patch ?? null
      : null;
    const reviewState = state.status === "ready" && selectedPatch ? { ...state, patch: selectedPatch } : null;
    const reviewButton = renderDiffAction(
      "Review this diff",
      false,
      diffLoadingSessions.has(sessionId) || !reviewState,
      () => {
        if (reviewState) openAgentDiffReview(sessionId, reviewState);
      },
    );
    reviewButton.title = reviewState?.patch ? "Ask the agent to review this loaded diff patch" : "Load a file patch before starting agent review";
    actions.append(refreshButton, flushButton, reviewButton);
    controls.append(fields, actions);
    diffView.append(controls);
  }

  function renderDiffSelect(
    labelText: string,
    options: { value: string; label: string; title?: string }[],
    selectedValue: string,
    disabled: boolean,
    onChange: (value: string) => void,
  ): HTMLElement {
    const label = diffView.ownerDocument.createElement("label");
    label.className = "mobile-diff-field";
    const labelSpan = diffView.ownerDocument.createElement("span");
    labelSpan.textContent = labelText;
    const select = diffView.ownerDocument.createElement("select");
    select.disabled = disabled;
    for (const optionValue of options) {
      const option = diffView.ownerDocument.createElement("option");
      option.value = optionValue.value;
      option.textContent = optionValue.label;
      if (optionValue.title) option.title = optionValue.title;
      if (optionValue.value === selectedValue) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => onChange(select.value));
    label.append(labelSpan, select);
    return label;
  }

  function renderDiffAction(label: string, active: boolean, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const button = diffView.ownerDocument.createElement("button");
    button.type = "button";
    button.className = active ? "active" : "";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    return button;
  }


  function requestMobileFilePatch(sessionId: string, state: DiffReviewableState, filePath: string): void {
    const diffId = sessionChangesDiffIds.get(sessionId);
    const summary = sessionChangesStates.get(sessionId);
    const file = state.summary.files.find(candidate => candidate.newPath === filePath);
    const key = comparisonKey(state);
    if (!diffId || !summary || !file || pendingMobileDiffFilePatchMatches(sessionId, diffId, key, filePath)) return;
    pendingMobileDiffFilePatches.set(sessionId, { diffId, comparisonKey: key, filePath });
    mobileDiffFilePatchErrors.delete(sessionId);
    const sent = send({
      type: "sessionChanges.request",
      clientId: diffClientId,
      diffId,
      sessionId,
      repoId: summary.status === "ready" ? summary.selectedRepoId : null,
      detailMode: "filePatch",
      currentCommitOid: state.review.currentCommitOid ?? null,
      selectedFile: { oldPath: file.oldPath ?? null, newPath: file.newPath },
    });
    if (sent) return;
    clearPendingMobileDiffFilePatch(sessionId, diffId);
    mobileDiffFilePatchErrors.set(sessionId, { filePath, message: "Not connected to the Fura bridge." });
    renderActiveSession();
  }

  function renderMobileDiffBody(state: DiffReviewableState, sessionId: string): void {
    const key = comparisonKey(state);
    ensureReviewCommentsLoaded(sessionId);
    const annotations = diffAnnotations.get(sessionId) ?? [];
    const comments = reviewCommentsForComparison(reviewComments.get(sessionId) ?? [], key);
    const currentFilePaths = new Set(state.summary.files.map(file => file.newPath));
    const fileSummaries = summarizeWireDiffFiles(state.summary.files, [...annotations, ...comments.map(mobileReviewCommentAsAnnotation)], key);
    if (fileSummaries.length > 0) renderMobileDiffFiles(sessionId, fileSummaries);
    const selectedFilePath = selectedMobileDiffFilePath(state, sessionId, fileSummaries.map(file => file.filePath));
    if (!selectedFilePath) {
      renderMobileDiffMessage("No diff changes.");
      renderMobileDiffComments(comments, [], key, null, currentFilePaths);
      return;
    }
    if (state.comparison.detailMode !== "filePatch") {
      const note = diffView.ownerDocument.createElement("p");
      note.className = "mobile-empty-state";
      note.textContent = "Stat-only payload: line comments and questions require file patch.";
      const pre = diffView.ownerDocument.createElement("pre");
      pre.className = "mobile-diff-pre";
      pre.textContent = state.summary.stat ?? "";
      diffView.append(note, pre);
      renderMobileDiffComments(comments, [], key, null, currentFilePaths);
      return;
    }
    const inlinePatch = (state as { patch?: string | null }).patch ?? null;
    const cached = mobileDiffPatchCache.get(`${key}\0${selectedFilePath}`) ?? (inlinePatch ? { patch: inlinePatch, truncated: false } : undefined);
    const filePatchError = selectedMobileDiffFilePatchError(sessionId, selectedFilePath);
    if (!cached) {
      if (!filePatchError) requestMobileFilePatch(sessionId, state, selectedFilePath);
      renderMobileDiffMessage(filePatchError ? `Failed to load patch for ${selectedFilePath}: ${filePatchError}` : `Loading patch for ${selectedFilePath}…`);
      renderMobileDiffComments(comments, [], key, selectedFilePath, currentFilePaths);
      return;
    }
    if (cached.truncated) renderMobileDiffMessage("Diff output is truncated by Fura's safety limit.");
    const rows = parseDiffRows(cached.patch);
    const reviewState = { ...state, patch: cached.patch };
    const diff = diffView.ownerDocument.createElement("div");
    diff.className = "mobile-diff-lines";
    diffView.append(diff);
    renderMobileDiffRowsChunked(diff, rows, sessionId, reviewState, key, annotations, comments);
    renderMobileDiffComments(comments, rows, key, selectedFilePath, currentFilePaths);
  }

  function renderMobileDiffRowsChunked(
    container: HTMLElement,
    rows: ParsedDiffRow[],
    sessionId: string,
    state: DiffReviewableState,
    key: string,
    annotations: DiffReviewAnnotation[],
    comments: ReviewComment[],
  ): void {
    const revision = ++mobileDiffRenderRevision;
    let index = 0;
    const progress = diffView.ownerDocument.createElement("p");
    progress.className = "mobile-empty-state";
    progress.textContent = rows.length > 150 ? `Rendering ${Math.min(rows.length, 150)}/${rows.length} diff lines…` : "";
    if (progress.textContent) diffView.append(progress);
    const renderBatch = () => {
      if (revision !== mobileDiffRenderRevision) return;
      const fragment = diffView.ownerDocument.createDocumentFragment();
      const started = performance.now();
      let count = 0;
      while (index < rows.length && count < 150 && performance.now() - started < 8) {
        const line = renderMobileDiffRow(rows[index++]!, sessionId, state, key, annotations, comments);
        if (line) fragment.append(line);
        count += 1;
      }
      container.append(fragment);
      if (progress.textContent) {
        progress.textContent = index < rows.length ? `Rendering ${index}/${rows.length} diff lines…` : "";
        if (!progress.textContent) progress.remove();
      }
      if (index < rows.length) {
        requestAnimationFrame(renderBatch);
        return;
      }
    };
    renderBatch();
  }

  function renderMobileDiffFiles(sessionId: string, files: ReturnType<typeof summarizeWireDiffFiles>): void {
    const section = diffView.ownerDocument.createElement("section");
    section.className = "mobile-diff-files";
    const title = diffView.ownerDocument.createElement("strong");
    title.textContent = `Modified files (${files.length})`;
    section.append(title);
    const list = diffView.ownerDocument.createElement("div");
    list.className = "mobile-diff-file-list";
    for (const file of files) {
      const item = diffView.ownerDocument.createElement("div");
      item.className = "mobile-diff-file-item";
      const path = diffView.ownerDocument.createElement("code");
      path.textContent = file.filePath;
      const meta = diffView.ownerDocument.createElement("span");
      meta.textContent = `+${file.added} -${file.removed}${file.commentCount > 0 ? ` · ${file.commentCount} comment${file.commentCount === 1 ? "" : "s"}` : ""}`;
      item.addEventListener("click", () => {
        mobileDiffFilePatchErrors.delete(sessionId);
        mobileSelectedDiffFiles.set(sessionId, file.filePath);
        renderActiveSession();
      });
      item.append(path, meta);
      list.append(item);
    }
    section.append(list);
    diffView.append(section);
  }

  function renderMobileDiffRow(
    row: ParsedDiffRow,
    sessionId: string,
    state: DiffReviewableState,
    key: string,
    annotations: DiffReviewAnnotation[],
    comments: ReviewComment[],
  ): HTMLElement | null {
    if (row.type === "meta" && !row.text.trim()) return null;
    if (row.type !== "line") {
      const line = diffView.ownerDocument.createElement("div");
      line.className = `mobile-diff-line mobile-diff-${row.type}`;
      if (row.type === "file") line.dataset.diffFilePath = row.filePath;
      const spacer = diffView.ownerDocument.createElement("span");
      spacer.className = "mobile-diff-comment-spacer";
      const text = diffView.ownerDocument.createElement("code");
      text.textContent = row.text;
      line.append(spacer, text);
      return line;
    }

    const lineComments = reviewCommentsForDiffLocation(comments, key, row.location);
    const lineQuestions = annotationsForDiffLocation(annotations, key, row.location).filter(annotation => annotation.kind === "question");
    const wrap = diffView.ownerDocument.createElement("div");
    wrap.className = "mobile-diff-line-wrap";
    const line = diffView.ownerDocument.createElement("div");
    line.className = `mobile-diff-line mobile-diff-line-${row.location.kind}`;
    const commentButton = diffView.ownerDocument.createElement("button");
    commentButton.type = "button";
    commentButton.className = `mobile-diff-comment-button${lineComments.length > 0 ? " has-comments" : ""}`;
    commentButton.textContent = lineComments.length > 0 ? String(lineComments.length) : "+";
    commentButton.title = "Comment on this diff line";
    commentButton.addEventListener("click", () => openDiffCommentEditor(sessionId, state, row.location, "comment"));
    const gutter = diffView.ownerDocument.createElement("span");
    gutter.className = "mobile-diff-gutter";
    gutter.textContent = String(row.location.newLine ?? row.location.oldLine ?? "");
    const text = diffView.ownerDocument.createElement("code");
    text.textContent = row.location.text;
    const questionButton = diffView.ownerDocument.createElement("button");
    questionButton.type = "button";
    questionButton.className = `mobile-diff-question-button${lineQuestions.length > 0 ? " has-questions" : ""}`;
    questionButton.textContent = lineQuestions.length > 0 ? String(lineQuestions.length) : "?";
    questionButton.title = "Ask the agent about this diff line";
    questionButton.addEventListener("click", () => openDiffCommentEditor(sessionId, state, row.location, "question"));
    line.append(commentButton, gutter, text, questionButton);
    wrap.append(line);
    if (lineComments.length > 0 || lineQuestions.length > 0) {
      const thread = diffView.ownerDocument.createElement("div");
      thread.className = "mobile-diff-inline-comments";
      for (const comment of lineComments) {
        const item = diffView.ownerDocument.createElement("div");
        item.className = `mobile-diff-inline-comment mobile-diff-inline-${comment.author}`;
        item.textContent = `${comment.author === "agent" ? "Agent" : "You"}: ${comment.body}`;
        thread.append(item);
      }
      for (const annotation of lineQuestions) {
        const item = diffView.ownerDocument.createElement("div");
        item.className = "mobile-diff-inline-comment mobile-diff-inline-question";
        item.textContent = `Question: ${annotation.text}`;
        thread.append(item);
      }
      wrap.append(thread);
    }
    return wrap;
  }

  function renderMobileDiffComments(
    comments: ReviewComment[],
    rows: ParsedDiffRow[],
    key: string,
    selectedFilePath: string | null,
    currentFilePaths: Set<string>,
  ): void {
    const section = diffView.ownerDocument.createElement("section");
    section.className = "mobile-diff-comments";
    const title = diffView.ownerDocument.createElement("strong");
    title.textContent = `Review comments (${comments.length})`;
    section.append(title);
    if (comments.length === 0) {
      const empty = diffView.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "No persisted review comments on this diff yet.";
      section.append(empty);
    } else {
      for (const comment of comments) {
        const missingFromCurrentDiff = !currentFilePaths.has(comment.anchor.newPath);
        const selectedFileMismatch = selectedFilePath !== comment.anchor.newPath;
        const stale = comment.stale
          || missingFromCurrentDiff
          || (!selectedFileMismatch && rows.length > 0 && !isReviewCommentMatched(rows, key, comment));
        const item = diffView.ownerDocument.createElement("article");
        item.className = `mobile-diff-comment mobile-diff-${comment.author}${stale ? " is-stale" : ""}`;
        const location = diffView.ownerDocument.createElement("code");
        location.textContent = `${formatReviewCommentLocation(comment)}${stale ? " · stale/unmatched" : ""}`;
        const body = diffView.ownerDocument.createElement("p");
        body.textContent = `${comment.author === "agent" ? "Agent" : "You"}: ${comment.body}`;
        const actions = diffView.ownerDocument.createElement("div");
        actions.className = "mobile-diff-comment-actions";
        const edit = diffView.ownerDocument.createElement("button");
        edit.type = "button";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => {
          const next = window.prompt("Edit comment", comment.body);
          if (next?.trim()) {
            markReviewCommentsDirty(comment.sessionId);
            send({ type: "review.comment.update", id: comment.id, body: next.trim() });
          }
        });
        const remove = diffView.ownerDocument.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
          markReviewCommentsDirty(comment.sessionId);
          send({ type: "review.comment.delete", id: comment.id });
        });
        actions.append(edit, remove);
        item.append(location, body, actions);
        section.append(item);
      }
    }
    diffView.append(section);
  }

  return { connect, send };
}

function getOrCreateControlClientId(storage: MobileSessionStorage): string {
  const existing = storage.getItem(CONTROL_CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;
  const next = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `mobile-control-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  storage.setItem(CONTROL_CLIENT_ID_STORAGE_KEY, next);
  return next;
}

function readStoredActiveSessionId(storage: MobileSessionStorage): string | null {
  const sessionId = storage.getItem(MOBILE_ACTIVE_SESSION_STORAGE_KEY)?.trim();
  return sessionId || null;
}

function writeStoredActiveSessionId(storage: MobileSessionStorage, sessionId: string): void {
  storage.setItem(MOBILE_ACTIVE_SESSION_STORAGE_KEY, sessionId);
}

function clearStoredActiveSessionId(storage: MobileSessionStorage): void {
  storage.removeItem(MOBILE_ACTIVE_SESSION_STORAGE_KEY);
}

function readStoredTrackedSessionIds(storage: MobileSessionStorage): Set<string> {
  const raw = storage.getItem(MOBILE_ATTACHED_SESSIONS_STORAGE_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId.trim().length > 0)
        .map(sessionId => sessionId.trim())
        .slice(-MAX_TRACKED_MOBILE_SESSION_IDS),
    );
  } catch {
    return new Set();
  }
}

function writeStoredTrackedSessionIds(storage: MobileSessionStorage, sessionIds: ReadonlySet<string>): void {
  const serialized = orderedTrackedSessionIds(null, sessionIds).slice(-MAX_TRACKED_MOBILE_SESSION_IDS);
  if (serialized.length === 0) {
    storage.removeItem(MOBILE_ATTACHED_SESSIONS_STORAGE_KEY);
    return;
  }
  storage.setItem(MOBILE_ATTACHED_SESSIONS_STORAGE_KEY, JSON.stringify(serialized));
}

function orderedTrackedSessionIds(activeSessionId: string | null, sessionIds: ReadonlySet<string>): string[] {
  const ordered = [...sessionIds];
  if (!activeSessionId) return ordered;
  return [activeSessionId, ...ordered.filter(sessionId => sessionId !== activeSessionId)];
}

function requireElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} missing`);
  return element as T;
}

function renderTodoCards(phases: TodoPhase[]): HTMLElement[] {
  const nonEmpty = phases.filter(phase => phase.tasks.length > 0);
  return nonEmpty.length > 0 ? [renderCurrentTodoCard(nonEmpty)] : [];
}
