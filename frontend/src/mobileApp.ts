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
import { reconcileChildren, setRenderDocument } from "./dom";
import {
  extensionDialogBodyText,
  extensionDialogHttpUrl,
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
import { formatContext, formatCost, formatTokens, shortId, shortPath } from "./format";
import type {
  ClientMessage,
  ControlCandidate,
  ControlStatusProjection,
  ControlSuggestedAction,
  FrontendControlAction,
  FrontendUiSnapshot,
  ServerConfig,
  ModelSummary,
  PlanApprovalMode,
  ProposedModelConfig,
  ServerMessage,
  SessionProjection,
  SessionSummary,
  ThinkingVisibilityMode,
  TodoPhase,
  TranscriptMessage,
} from "./protocol";
import { nextThinkingVisibilityMode, parseThinkingVisibilityMode, parseToolVisibility } from "./uiPreferences";
import { sessionCategories, visibleSessions } from "./sessionList";
import { activateSession as activateSessionState, applySessionDelta, applySessionSnapshot, applySessionsSnapshot, sessionOpenOrAttachMessage } from "./sessionClientState";
import {
  deriveWorktreeCreateView,
  resolveSessionCreateMessage,
  type SessionCreateValidationTarget,
} from "./sessionCreate";
import { deriveSessionDeleteView, sessionDeleteMessage, type SessionDeleteView } from "./sessionDelete";
import { catalogContainsProposedModel, filterCatalogModels, formatCatalogModelLabel, formatProposedModelDetails, normalizeSelectedProposedModelId, proposedModelIdFromName, removeProposedModel, upsertProposedModel, validateProposedModels } from "./proposedModels";
import { createSessionListView, renderSessionCategoryFilter } from "./sessionListView";
import { renderCurrentTodoCard, renderToolCard } from "./toolCards";
import { renderMessage, transcriptMessageRenderCacheKey, updateRenderedMessage } from "./transcriptView";
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

type MobileWindow = Pick<Window, "history" | "localStorage" | "sessionStorage" | "location" | "prompt" | "confirm" | "setTimeout">;
type MobileSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MOBILE_ACTIVE_SESSION_STORAGE_KEY = "fura.mobile.activeSessionId";
const MOBILE_ATTACHED_SESSIONS_STORAGE_KEY = "fura.mobile.attachedSessionIds";
const MAX_TRACKED_MOBILE_SESSION_IDS = 20;
const CONTROL_CLIENT_ID_STORAGE_KEY = "fura.controlClientId";

type MobileWorkspaceView = "controller" | "transcript";

type ControlChatMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  candidates?: ControlCandidate[];
  suggestedActions?: ControlSuggestedAction[];
};

type MobileTranscriptRenderCache = {
  nodes: Map<string, HTMLElement>;
};

export type MobileConnectionOptions = {
  auth: WebSocketAuth;
  clientKind?: "mobile";
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
                <button id="mobileModelTemplatesOpen" class="mobile-option-item" type="button" role="menuitem">Model templates</button>
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
        <div id="mobileController" class="mobile-transcript mobile-controller" role="region" aria-label="Ask Fura" hidden></div>
        <div id="mobileTranscript" class="mobile-transcript"></div>
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
      <section id="mobileProposedModelsOverlay" class="mobile-dialog-overlay" hidden>
        <div class="mobile-dialog mobile-proposed-model-dialog" role="dialog" aria-modal="true" aria-labelledby="mobileProposedModelsTitle">
          <header class="mobile-dialog-header">
            <div>
              <p class="mobile-dialog-kicker">Configuration</p>
              <h2 id="mobileProposedModelsTitle">Model templates</h2>
            </div>
          </header>
          <div class="mobile-dialog-form">
            <div id="mobileProposedModelsList" class="mobile-proposed-models-list"></div>
            <div class="mobile-proposed-model-form">
              <label class="mobile-dialog-field" for="mobileProposedModelName">Template name</label>
              <input id="mobileProposedModelName" autocomplete="off" spellcheck="false" placeholder="Custom name" />
              <label class="mobile-dialog-field" for="mobileProposedModelSearch">Runtime model search</label>
              <input id="mobileProposedModelSearch" autocomplete="off" spellcheck="false" placeholder="Search runtime models" />
              <label class="mobile-dialog-field" for="mobileProposedModelCatalog">Runtime model</label>
              <select id="mobileProposedModelCatalog"></select>
              <label class="mobile-dialog-field" for="mobileProposedModelThinking">Thinking level</label>
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
            <div class="mobile-dialog-actions">
              <button id="mobileProposedModelsClose" type="button">Close</button>
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
          <textarea id="mobileReviewPreviewText" class="mobile-review-preview-text" spellcheck="false"></textarea>
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
  const modelTemplatesOpen = requireElement<HTMLButtonElement>(document, "mobileModelTemplatesOpen");
  const proposedModelsOverlay = requireElement<HTMLElement>(document, "mobileProposedModelsOverlay");
  const proposedModelsList = requireElement<HTMLDivElement>(document, "mobileProposedModelsList");
  const proposedModelName = requireElement<HTMLInputElement>(document, "mobileProposedModelName");
  const proposedModelSearch = requireElement<HTMLInputElement>(document, "mobileProposedModelSearch");
  const proposedModelCatalog = requireElement<HTMLSelectElement>(document, "mobileProposedModelCatalog");
  const proposedModelThinking = requireElement<HTMLSelectElement>(document, "mobileProposedModelThinking");
  const proposedModelAdd = requireElement<HTMLButtonElement>(document, "mobileProposedModelAdd");
  const proposedModelsClose = requireElement<HTMLButtonElement>(document, "mobileProposedModelsClose");
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
  const controllerView = requireElement<HTMLDivElement>(document, "mobileController");
  const transcript = requireElement<HTMLDivElement>(document, "mobileTranscript");
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
  let proposedModelSavePending: ProposedModelConfig[] | null = null;
  let sessions: SessionSummary[] = [];
  let activeSessionId: string | null = readStoredActiveSessionId(window.sessionStorage);
  let projections = new Map<string, SessionProjection>();
  let transcriptRenderCache: MobileTranscriptRenderCache = { nodes: new Map() };
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
  });
  thinkingVisibilityToggle.addEventListener("click", () => {
    const nextMode = nextThinkingVisibilityMode(thinkingVisibilityMode);
    if (!send({ type: "config.set", thinkingVisibility: nextMode })) return;
    applyVisibilityPreferences(showToolBubbles, nextMode);
  });
  modelTemplatesOpen.addEventListener("click", () => openMobileProposedModelsDialog());
  proposedModelsClose.addEventListener("click", () => closeMobileProposedModelsDialog());
  proposedModelsOverlay.addEventListener("click", event => {
    if (event.target === proposedModelsOverlay) closeMobileProposedModelsDialog();
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
    if (event.key !== "Escape") return;
    if (!proposedModelsOverlay.hidden) {
      closeMobileProposedModelsDialog();
    } else if (optionsMenuOpen) {
      setOptionsMenuOpen(false);
    }
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
  dialogCancel.addEventListener("click", dismissOrCancelActiveDialog);
  busyPromptCancel.addEventListener("click", restoreBusyPromptDraft);
  busyPromptSteer.addEventListener("click", () => sendBusyPromptDraft("steer"));
  busyPromptFollowUp.addEventListener("click", () => sendBusyPromptDraft("followUp"));
  categoryFilter.addEventListener("change", () => {
    selectedCategoryFilter = categoryFilter.value;
    renderSessions();
  });
  deleteSessionCancel.addEventListener("click", closeDeleteSessionPicker);
  deleteSessionConfirm.addEventListener("click", submitDeleteSessionPicker);
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
    authGate.hidden = false;
    authSubmit.disabled = true;
    authStatus.textContent = "Connecting…";
    connection?.disconnect();
    connection = createConnection({
      auth: { type: "sessionCookie", token: bridgeToken },
      clientKind: "mobile",
      onStatus: setStatus,
      onOpen: () => {
        pendingRestoreAfterSessionsSnapshot = true;
        hideAuthGate();
        clearConnectionFailureStatus();
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

  function clearConnectionFailureStatus(): void {
    const current = mobileLog.textContent?.trim() ?? "";
    if (current.startsWith("Connection failed:") || current.startsWith("Authentication failed.")) {
      mobileLog.textContent = "";
    }
    if (!authGate.hidden) hideAuthGate();
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
    proposedModelSavePending = models;
    if (!send({ type: "config.set", proposedModels: models })) {
      proposedModelSavePending = null;
      proposedModelStatus.textContent = "Not connected to the Fura bridge.";
    }
  }

  function setOptionsMenuOpen(open: boolean): void {
    optionsMenuOpen = open;
    syncOptionsMenu();
  }

  function openMobileProposedModelsDialog(): void {
    proposedModelsOverlay.hidden = false;
    setOptionsMenuOpen(false);
    requestMobileModelCatalog();
    proposedModelName.focus();
  }

  function closeMobileProposedModelsDialog(): void {
    proposedModelsOverlay.hidden = true;
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

  function approvePendingPlanReview(review: PendingPlanReview, approvalMode: PlanApprovalMode = "execute"): void {
    const accepted = send(createApprovePlanReviewMessage(review, approvalMode));
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

  function dismissOrCancelActiveDialog(): void {
    if (!activeDialog) return;
    if (activeDialog.method === "open_url") {
      showNextMobileDialog();
      return;
    }
    respondToActiveDialog({ cancelled: true });
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
      case "open_url":
        showNextMobileDialog();
        return;
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
      case "open_url":
        renderMobileDialogOpenUrl(activeDialog);
        dialogSubmit.hidden = true;
        dialogCancel.textContent = "Dismiss";
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
      const target = dialogField.querySelector<HTMLElement>("[data-dialog-value]") ?? (dialogSubmit.hidden ? dialogCancel : dialogSubmit);
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

  function renderMobileDialogOpenUrl(request: ExtensionDialogRequest): void {
    const urlText = request.url ?? "";
    const safeUrl = extensionDialogHttpUrl(request);
    const wrapper = dialogField.ownerDocument.createElement("div");
    wrapper.className = "mobile-dialog-open-url";

    const label = dialogField.ownerDocument.createElement("p");
    label.textContent = "URL";
    const code = dialogField.ownerDocument.createElement("code");
    code.textContent = urlText || "No URL provided.";
    wrapper.append(label, code);

    const actions = dialogField.ownerDocument.createElement("div");
    actions.className = "mobile-dialog-open-url-actions";
    if (safeUrl) {
      const link = dialogField.ownerDocument.createElement("a");
      link.href = safeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open link";
      actions.append(link);
    } else {
      const warning = dialogField.ownerDocument.createElement("p");
      warning.className = "mobile-dialog-open-url-warning";
      warning.textContent = "Fura only opens http:// and https:// extension URLs.";
      wrapper.append(warning);
    }

    const copyButton = dialogField.ownerDocument.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy URL";
    copyButton.disabled = !urlText;
    copyButton.addEventListener("click", async () => {
      if (!urlText || !navigator.clipboard?.writeText) {
        dialogStatus.textContent = "Clipboard copy is not available in this browser.";
        return;
      }
      try {
        await navigator.clipboard.writeText(urlText);
        dialogStatus.textContent = "URL copied.";
      } catch {
        dialogStatus.textContent = "Could not copy URL.";
      }
    });
    actions.append(copyButton);
    wrapper.append(actions);
    dialogField.append(wrapper);
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
    activeMobileView = view;
    controllerView.hidden = !willBeController;
    transcript.hidden = willBeController;
    askFuraButton.classList.toggle("active", willBeController);
    askFuraButton.setAttribute("aria-pressed", String(willBeController));
    renderActiveSession();
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
        if (proposedModelSavePending && JSON.stringify(message.config.proposedModels) === JSON.stringify(proposedModelSavePending)) {
          proposedModelSavePending = null;
          proposedModelName.value = "";
          proposedModelEditingId = null;
          proposedModelSearch.value = "";
          proposedModelStatus.textContent = "Saved.";
        }
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
      case "session.delta": {
        rememberTrackedSessionId(message.sessionId);
        const result = applySessionDelta(sessions, projections, message.sessionId, message.state);
        if (!result) {
          send({ type: "state.refresh", sessionId: message.sessionId });
          break;
        }
        ({ sessions, projections } = result);
        const projection = projections.get(message.sessionId);
        if (projection) syncVisiblePlanReviewFromProjection(message.sessionId, projection);
        if (!activeSessionId || activeSessionId === message.sessionId) {
          activateSession(message.sessionId);
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
    activeSessionId = activateSessionState(unreadSessions, sessionId);
    rememberTrackedSessionId(sessionId);
    writeStoredActiveSessionId(window.sessionStorage, sessionId);
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

  function mobileTranscriptReviewRenderKey(sessionId: string, messageId: string): string {
    const comments = reviewCommentsForMessage(sessionId, messageId)
      .map(comment => [comment.id, comment.lineNumber, comment.lineText, comment.text]);
    return JSON.stringify({
      active: transcriptReviewActiveMessages.get(sessionId) === messageId,
      comments,
    });
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
    const promptText = reviewPreviewText.value.trim();
    if (!promptText) {
      reviewPreviewStatus.textContent = "Prompt text is required.";
      reviewPreviewText.focus();
      return;
    }
    closeReviewPreview();
    const accepted = send(createPromptSendMessage(
      draft.sessionId,
      promptText,
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
    renderBusyPromptChoice();
  }


  function renderTranscript(projection: SessionProjection | undefined): void {
    setRenderDocument(transcript.ownerDocument);
    const wasNearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
    const previousScrollTop = transcript.scrollTop;

    if (!projection) {
      const empty = transcript.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "Select a session to load its transcript.";
      transcript.replaceChildren(empty);
      transcriptRenderCache = { nodes: new Map() };
      return;
    }

    const desiredNodes: Node[] = [];
    const nextMessageNodes = new Map<string, HTMLElement>();
    for (let i = 0; i < projection.transcript.length; i++) {
      const entry = projection.transcript[i];
      if (entry.kind === "message") {
        const reviewKey = activeSessionId ? mobileTranscriptReviewRenderKey(activeSessionId, entry.id) : "";
        const renderOptions = {
          thinkingVisibilityMode,
          review: activeSessionId ? transcriptReviewOptions(activeSessionId, entry) : undefined,
        };
        const key = transcriptMessageRenderCacheKey(
          projection.summary.sessionId,
          entry,
          i,
          `${thinkingVisibilityMode}:${reviewKey}`,
        );
        const cachedNode = transcriptRenderCache.nodes.get(key);
        const node = cachedNode?.ownerDocument === transcript.ownerDocument
          ? updateRenderedMessage(cachedNode, entry, renderOptions)
          : renderMessage(entry, renderOptions);
        nextMessageNodes.set(key, node);
        desiredNodes.push(node);
      } else if (showToolBubbles) {
        desiredNodes.push(renderToolCard(entry));
      }
    }

    for (const phaseCard of renderTodoCards(projection.todoPhases ?? [])) {
      desiredNodes.push(phaseCard);
    }

    const visiblePlanReview = visiblePlanReviews.get(projection.summary.sessionId);
    if (visiblePlanReview) {
      desiredNodes.push(renderPlanReviewCard(
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
    if (desiredNodes.length === 0) {
      const empty = transcript.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "Transcript is empty.";
      desiredNodes.push(empty);
    }

    reconcileChildren(transcript, desiredNodes);
    transcriptRenderCache = { nodes: nextMessageNodes };
    if (wasNearBottom) {
      transcript.scrollTop = transcript.scrollHeight;
    } else {
      transcript.scrollTop = previousScrollTop;
    }
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
