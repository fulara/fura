import {
  blobToBase64,
  createPendingMarker as createAttachmentMarker,
  removePendingMarkerFromText,
  renderAttachmentPreviews,
  type PendingImage,
} from "./composerAttachments";
import { createPromptSendMessage, type PromptBehavior } from "./composer";
import { clearBootstrapToken, consumeBootstrapToken, storeBootstrapToken } from "./bootstrapAuth";
import type { ConnectionStatus, FuraConnection, WebSocketAuth } from "./connection";
import { setRenderDocument } from "./dom";
import {
  comparisonKey,
  diffRepoRoots,
  formatDiffRepoLabel,
  inferDiffRepoRootFromCwd,
  parseDiffRows,
  summarizeDiffFiles,
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
  buildDiffCommentPrompt,
  buildDiffQuestionPrompt,
  createDiffReviewAnnotation,
  diffCommentFlushEditorText,
  diffCommentPreviewStatus,
  formatDiffLineLocation,
  formatDiffLocation,
  removeSelectedDiffComments,
  selectedDiffAnnotations,
  type DiffPreviewDraft,
} from "./diffReview";
import { formatContext, formatCost, formatTokens, shortId, shortPath } from "./format";
import type {
  ClientMessage,
  DiffReviewAnnotation,
  DiffLineLocation,
  RepoDiffState,
  ServerConfig,
  ServerMessage,
  SessionProjection,
  SessionSummary,
  TodoPhase,
  TranscriptMessage,
} from "./protocol";
import { sessionCategories, visibleSessions } from "./sessionList";
import { activateSession as activateSessionState, applySessionSnapshot, applySessionsSnapshot, sessionOpenOrAttachMessage } from "./sessionClientState";
import {
  deriveWorktreeCreateView,
  resolveSessionCreateMessage,
  type SessionCreateValidationTarget,
} from "./sessionCreate";
import { deriveSessionDeleteView, sessionDeleteMessage, type SessionDeleteView } from "./sessionDelete";
import { createSessionListView, renderSessionCategoryFilter } from "./sessionListView";
import { renderCurrentTodoCard, renderToolCard } from "./toolCards";
import { renderMessage } from "./transcriptView";
import {
  buildTranscriptReviewPrompt,
  type TranscriptReviewComment,
  type TranscriptReviewLine,
} from "./transcriptReview";

type MobileWindow = Pick<Window, "history" | "localStorage" | "sessionStorage" | "location" | "prompt" | "setTimeout">;
type MobileSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MOBILE_ACTIVE_SESSION_STORAGE_KEY = "fura.mobile.activeSessionId";
const MOBILE_ATTACHED_SESSIONS_STORAGE_KEY = "fura.mobile.attachedSessionIds";
const MAX_TRACKED_MOBILE_SESSION_IDS = 20;

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

      <section class="mobile-main" aria-label="Active session workspace">
        <nav class="mobile-workspace-tabs" aria-label="Mobile workspace views">
          <button id="mobileTranscriptTab" type="button" class="mobile-workspace-tab active" aria-pressed="true">Transcript</button>
          <button id="mobileDiffTab" type="button" class="mobile-workspace-tab" aria-pressed="false">Diff</button>
        </nav>
        <div id="mobileTranscript" class="mobile-transcript"></div>
        <div id="mobileDiff" class="mobile-diff" hidden></div>
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
  const sessionsDrawer = requireElement<HTMLElement>(document, "mobileSessionsDrawer");
  const sessionsList = requireElement<HTMLElement>(document, "mobileSessionsList");
  const createDrawer = requireElement<HTMLElement>(document, "mobileCreateDrawer");
  const createForm = requireElement<HTMLFormElement>(document, "mobileCreateForm");
  const createNameInput = requireElement<HTMLInputElement>(document, "mobileCreateName");
  const createCwdInput = requireElement<HTMLInputElement>(document, "mobileCreateCwd");
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
  const transcriptTab = requireElement<HTMLButtonElement>(document, "mobileTranscriptTab");
  const diffTab = requireElement<HTMLButtonElement>(document, "mobileDiffTab");
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
  let reviewPreviewDraft: { sessionId: string; message: TranscriptMessage; comments: TranscriptReviewComment[] } | null = null;
  const transcriptReviewActiveMessages = new Map<string, string>();
  const transcriptReviewComments = new Map<string, TranscriptReviewComment[]>();
  let serverConfig: ServerConfig | null = null;
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
  let activeMobileView: "transcript" | "diff" = "transcript";
  const diffStates = new Map<string, RepoDiffState>();
  const diffErrors = new Map<string, string>();
  const diffLoadingSessions = new Set<string>();
  const diffSelectedRepos = new Map<string, string>();
  const diffBaseRefs = new Map<string, string>();
  const diffHeadRefs = new Map<string, string>();
  const diffStatModes = new Map<string, boolean>();
  const diffAnnotations = new Map<string, DiffReviewAnnotation[]>();
  let pendingDiffComment: {
    sessionId: string;
    state: RepoDiffState;
    location: DiffLineLocation;
    kind: "comment" | "question";
  } | null = null;
  let diffPreviewDraft: DiffPreviewDraft | null = null;
  let busyPromptDraft: BusyPromptDraft | null = null;
  let activeDialog: ExtensionDialogRequest | null = null;
  const dialogQueue: ExtensionDialogRequest[] = [];

  const sessionListView = createSessionListView(sessionsList, {
    onSelectSession: selectSession,
    onDeleteSession: openDeleteSessionPicker,
  });

  transcriptTab.addEventListener("click", () => setActiveMobileView("transcript"));
  diffTab.addEventListener("click", () => setActiveMobileView("diff"));

  createToggle.addEventListener("click", () => {
    const open = createDrawer.hidden;
    setCreateDrawerOpen(open);
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
    if (open) setCreateDrawerOpen(false);
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
    const text = promptInput.value.trim();
    if ((!text && pendingImages.length === 0) || !activeSessionId) return;
    const accepted = send(createPromptSendMessage(activeSessionId, text, pendingImages));
    if (accepted) clearPromptComposer();
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

  function send(message: ClientMessage): boolean {
    if (!connection) {
      appendLog("Not connected.");
      return false;
    }
    return connection.send(message);
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
    state: RepoDiffState,
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

    const annotations = diffAnnotations.get(pending.sessionId) ?? [];
    const annotation = createDiffReviewAnnotation({
      id: `${Date.now()}-${annotations.length}`,
      kind: pending.kind,
      state: pending.state,
      location: pending.location,
      text,
      status: pending.kind === "question" ? "sent" : "draft",
    });
    annotations.push(annotation);
    diffAnnotations.set(pending.sessionId, annotations);
    closeDiffCommentEditor();
    if (pending.kind === "question") {
      const promptText = buildDiffQuestionPrompt(pending.state, annotation);
      if (projections.get(pending.sessionId)?.isBusy) {
        busyPromptDraft = createBusyPromptDraft({
          sessionId: pending.sessionId,
          text: promptText,
          editorText: `Question about ${formatDiffLineLocation(pending.location)}`,
          images: [],
          onSend: renderActiveSession,
        });
        renderBusyPromptChoice();
      } else {
        send(createPromptSendMessage(pending.sessionId, promptText, []));
      }
    }
    renderActiveSession();
  }

  function openDiffPreview(
    sessionId: string,
    state: RepoDiffState,
  ): void {
    const key = comparisonKey(state);
    const comments = selectedDiffAnnotations(diffAnnotations.get(sessionId) ?? [], key, "comment");
    if (comments.length === 0) return;
    diffPreviewDraft = { sessionId, state, comparisonKey: key, comments };
    diffPreviewText.value = buildDiffCommentPrompt(state, comments);
    diffPreviewStatus.textContent = diffCommentPreviewStatus(comments.length);
    diffPreviewOverlay.hidden = false;
    diffPreviewText.scrollTop = 0;
    window.setTimeout(() => diffPreviewSend.focus(), 0);
  }

  function closeDiffPreview(): void {
    diffPreviewDraft = null;
    diffPreviewOverlay.hidden = true;
    diffPreviewText.value = "";
    diffPreviewStatus.textContent = "";
  }

  function clearFlushedDiffComments(
    sessionId: string,
    key: string,
  ): void {
    diffAnnotations.set(sessionId, removeSelectedDiffComments(diffAnnotations.get(sessionId) ?? [], key));
    renderActiveSession();
  }

  function sendDiffPreviewDraft(): void {
    const draft = diffPreviewDraft;
    if (!draft) return;
    const text = buildDiffCommentPrompt(draft.state, draft.comments);
    const clearComments = () => clearFlushedDiffComments(draft.sessionId, draft.comparisonKey);
    if (projections.get(draft.sessionId)?.isBusy) {
      busyPromptDraft = createBusyPromptDraft({
        sessionId: draft.sessionId,
        text,
        editorText: diffCommentFlushEditorText(draft.comments.length),
        images: [],
        onSend: clearComments,
      });
      closeDiffPreview();
      renderBusyPromptChoice();
      return;
    }

    const accepted = send(createPromptSendMessage(draft.sessionId, text, []));
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
    updateComposerStatus();
  }

  function updateComposerStatus(): void {
    if (!activeSessionId) {
      composerStatus.textContent = "No active session";
      return;
    }
    const projection = projections.get(activeSessionId);
    const summary = sessions.find(session => session.sessionId === activeSessionId);
    const isBusy = projection?.isBusy ?? summary?.status === "busy";
    if (isBusy) {
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

  function setActiveMobileView(view: "transcript" | "diff"): void {
    activeMobileView = view;
    transcript.hidden = view !== "transcript";
    diffView.hidden = view !== "diff";
    transcriptTab.classList.toggle("active", view === "transcript");
    diffTab.classList.toggle("active", view === "diff");
    transcriptTab.setAttribute("aria-pressed", String(view === "transcript"));
    diffTab.setAttribute("aria-pressed", String(view === "diff"));
    if (view === "diff" && activeSessionId) requestMobileDiffState(activeSessionId);
    renderActiveSession();
  }

  type MobileDiffSelection = {
    repoRoot: string | null;
    base: string;
    head: string;
    stat: boolean;
  };

  function resolveMobileDiffRepoRoot(
    sessionId: string,
    projection: SessionProjection | undefined,
    state: RepoDiffState | undefined,
  ): string | null {
    const explicit = diffSelectedRepos.get(sessionId);
    if (explicit) return explicit;
    const repoRoots = diffRepoRoots(state);
    const inferred = inferDiffRepoRootFromCwd(projection?.summary.cwd ?? undefined, repoRoots);
    const fallback = inferred ?? state?.repoRoot ?? projection?.summary.worktree?.path ?? projection?.summary.cwd ?? serverConfig?.defaultCwd ?? null;
    if (fallback) diffSelectedRepos.set(sessionId, fallback);
    return fallback;
  }

  function resolveMobileDiffSelection(
    sessionId: string,
    projection: SessionProjection | undefined,
    state: RepoDiffState | undefined,
  ): MobileDiffSelection {
    const repoRoot = resolveMobileDiffRepoRoot(sessionId, projection, state);
    return {
      repoRoot,
      base: diffBaseRefs.get(sessionId) ?? (state?.comparison.base.kind === "gitRef" ? state.comparison.base.input : "HEAD"),
      head: diffHeadRefs.get(sessionId) ?? (state?.comparison.head.kind === "gitRef" ? state.comparison.head.input : "HEAD"),
      stat: diffStatModes.get(sessionId) ?? (state?.comparison.mode === "stat"),
    };
  }

  function requestMobileDiffState(
    sessionId: string,
    overrides: { repoRoot?: string; base?: string; head?: string; stat?: boolean } = {},
  ): void {
    const projection = projections.get(sessionId);
    if (!projection || diffLoadingSessions.has(sessionId)) return;
    const state = diffStates.get(sessionId);
    const selection = resolveMobileDiffSelection(sessionId, projection, state);
    const repoRoot = overrides.repoRoot?.trim() || selection.repoRoot;
    if (!repoRoot) {
      diffErrors.set(sessionId, "Diff requires a repository root.");
      renderDiffView(projection);
      return;
    }
    const base = overrides.base ?? selection.base;
    const head = overrides.head ?? selection.head;
    const stat = overrides.stat ?? selection.stat;
    diffSelectedRepos.set(sessionId, repoRoot);
    diffBaseRefs.set(sessionId, base);
    diffHeadRefs.set(sessionId, head);
    diffStatModes.set(sessionId, stat);
    diffErrors.delete(sessionId);
    diffLoadingSessions.add(sessionId);
    const message: ClientMessage = {
      type: "diff.compare",
      sessionId,
      repoRoot,
      base: { kind: "gitRef", value: base || "HEAD" },
      head: { kind: "gitRef", value: head || "HEAD" },
      mode: stat ? "stat" : "full",
      reviewMode: "range",
    };
    send(message);
    renderDiffView(projection);
  }

  function handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        serverConfig = message.config;
        syncCreateCwdDefault();
        console.debug(`[fura-mobile] Connected to fura ${message.serverVersion}.`);
        break;
      case "config.updated":
        serverConfig = message.config;
        syncCreateCwdDefault();
        break;
      case "sessions.snapshot":
        ({ sessions, activeSessionId } = applySessionsSnapshot(message.sessions, activeSessionId));
        syncTrackedSessionsWithSnapshot();
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
      case "error":
        appendLog(`Error: ${message.message}`);
        if (handleCreateError(message.requestId ?? null, message.message)) break;
        break;
      case "dialog.request":
        handleDialogRequest(message);
        break;
      case "model.list":
      case "model.changed":
      case "plan.review":
      case "raw.omp":
        break;
      case "diff.state": {
        const sessionId = message.sessionId ?? activeSessionId;
        if (!sessionId) break;
        diffLoadingSessions.delete(sessionId);
        diffErrors.delete(sessionId);
        diffStates.set(sessionId, message.state);
        diffSelectedRepos.set(sessionId, message.state.repoRoot);
        if (message.state.comparison.base.kind === "gitRef") diffBaseRefs.set(sessionId, message.state.comparison.base.input);
        if (message.state.comparison.head.kind === "gitRef") diffHeadRefs.set(sessionId, message.state.comparison.head.input);
        diffStatModes.set(sessionId, message.state.comparison.mode === "stat");
        if (sessionId === activeSessionId) renderActiveSession();
        break;
      }
      case "diff.error": {
        const sessionId = message.sessionId ?? activeSessionId;
        if (sessionId) {
          diffLoadingSessions.delete(sessionId);
          diffErrors.set(sessionId, message.message);
          if (sessionId === activeSessionId) renderActiveSession();
        }
        break;
      }
      case "diff.reviewWorktree.state":
        break;
      case "control.reply":
      case "control.status":
      case "frontend.control":
      case "voice.status":
      case "voice.delta":
      case "voice.final":
      case "voice.error":
        break;
    }
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
    if (activeMobileView === "diff" && projections.has(sessionId)) requestMobileDiffState(sessionId);
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

  function flushTranscriptReviewComments(sessionId: string, message: TranscriptMessage): void {
    const comments = reviewCommentsForMessage(sessionId, message.id);
    if (comments.length === 0) return;
    reviewPreviewDraft = { sessionId, message, comments };
    reviewPreviewText.value = buildTranscriptReviewPrompt(message, comments);
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
      buildTranscriptReviewPrompt(draft.message, draft.comments),
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
      onCancel: (target: TranscriptMessage) => cancelTranscriptReview(sessionId, target),
      onFlush: (target: TranscriptMessage) => flushTranscriptReviewComments(sessionId, target),
    };
  }

  function renderActiveSession(): void {
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
      closeReviewPreview();
      renderTranscript(undefined);
      renderDiffView(undefined);
      renderBusyPromptChoice();
      return;
    }

    const isBusy = projection?.isBusy ?? summary.status === "busy";
    sessionTitle.textContent = summary.title || `Session ${shortId(summary.sessionId)}`;
    sessionMeta.hidden = true;
    sessionMeta.textContent = "";
    updateMobileStatusBar(projection, summary);
    promptInput.disabled = !projection || isBusy;
    sendButton.disabled = !projection || isBusy;
    imageInput.disabled = !projection || isBusy;
    promptInput.placeholder = isBusy ? "Agent is busy…" : "Send a prompt…";
    updateComposerStatus();
    renderTranscript(projection);
    renderDiffView(projection);
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
          thinkingVisibilityMode: "auto",
          review: activeSessionId ? transcriptReviewOptions(activeSessionId, entry) : undefined,
        }));
      } else {
        fragment.append(renderToolCard(entry));
      }
    }

    for (const phaseCard of renderTodoCards(projection.todoPhases ?? [])) {
      fragment.append(phaseCard);
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
    setRenderDocument(diffView.ownerDocument);
    diffView.replaceChildren();

    if (!activeSessionId || !projection) {
      const empty = diffView.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "Select a session to load its diff.";
      diffView.append(empty);
      return;
    }

    const sessionId = activeSessionId;
    const state = diffStates.get(sessionId);
    const error = diffErrors.get(sessionId);
    if (state) renderDiffControls(sessionId, projection, state);

    if (error) {
      const message = diffView.ownerDocument.createElement("p");
      message.className = "mobile-empty-state";
      message.textContent = error;
      diffView.append(message);
      return;
    }

    if (diffLoadingSessions.has(sessionId) && !state) {
      const loading = diffView.ownerDocument.createElement("p");
      loading.className = "mobile-empty-state";
      loading.textContent = "Loading diff…";
      diffView.append(loading);
      return;
    }

    if (!state) {
      const empty = diffView.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "No diff loaded yet.";
      diffView.append(empty);
      return;
    }

    if (!state.diff.trim()) {
      const empty = diffView.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = diffLoadingSessions.has(sessionId) ? "Loading diff…" : "No diff changes.";
      diffView.append(empty);
      return;
    }

    renderMobileDiffBody(state, sessionId, projection);
  }

  function renderDiffControls(sessionId: string, projection: SessionProjection, state: RepoDiffState): void {
    const selection = resolveMobileDiffSelection(sessionId, projection, state);
    const key = comparisonKey(state);
    const currentAnnotations = diffAnnotations.get(sessionId) ?? [];
    const selectedComments = selectedDiffAnnotations(currentAnnotations, key, "comment");
    const controls = diffView.ownerDocument.createElement("section");
    controls.className = "mobile-diff-controls";

    const title = diffView.ownerDocument.createElement("h3");
    title.textContent = selection.repoRoot ? formatDiffRepoLabel(selection.repoRoot) : "Diff";
    const meta = diffView.ownerDocument.createElement("p");
    meta.className = "mobile-diff-meta";
    meta.textContent = [
      `Base: ${selection.base}`,
      `Head: ${selection.head}`,
      selection.stat ? "Stat" : "Full diff",
    ].join(" · ");
    controls.append(title, meta);

    const fields = diffView.ownerDocument.createElement("div");
    fields.className = "mobile-diff-fields";
    fields.append(renderDiffInput("Repository", selection.repoRoot ?? "", diffLoadingSessions.has(sessionId), value => requestMobileDiffState(sessionId, { repoRoot: value })));
    fields.append(renderDiffInput("Base", selection.base, diffLoadingSessions.has(sessionId), value => requestMobileDiffState(sessionId, { base: value })));
    fields.append(renderDiffInput("Head", selection.head, diffLoadingSessions.has(sessionId), value => requestMobileDiffState(sessionId, { head: value })));

    const actions = diffView.ownerDocument.createElement("div");
    actions.className = "mobile-diff-actions";
    const statButton = renderDiffAction("Stat", selection.stat, diffLoadingSessions.has(sessionId), () => {
      requestMobileDiffState(sessionId, { stat: true });
    });
    const fullButton = renderDiffAction("Full", !selection.stat, diffLoadingSessions.has(sessionId), () => {
      requestMobileDiffState(sessionId, { stat: false });
    });
    const refreshButton = renderDiffAction(
      diffLoadingSessions.has(sessionId) ? "Refreshing…" : "Refresh",
      false,
      diffLoadingSessions.has(sessionId),
      () => requestMobileDiffState(sessionId),
    );
    const previewButton = renderDiffAction(
      "Preview comments",
      false,
      diffLoadingSessions.has(sessionId) || selectedComments.length === 0,
      () => openDiffPreview(sessionId, state),
    );
    const flushButton = renderDiffAction(
      `Preview & flush (${selectedComments.length})`,
      false,
      diffLoadingSessions.has(sessionId) || selectedComments.length === 0,
      () => openDiffPreview(sessionId, state),
    );
    actions.append(statButton, fullButton, refreshButton, previewButton, flushButton);

    controls.append(fields, actions);
    diffView.append(controls);
  }

  function renderDiffInput(
    labelText: string,
    value: string,
    disabled: boolean,
    onCommit: (value: string) => void,
  ): HTMLElement {
    const label = diffView.ownerDocument.createElement("label");
    label.className = "mobile-diff-field";
    const labelSpan = diffView.ownerDocument.createElement("span");
    labelSpan.textContent = labelText;
    const input = diffView.ownerDocument.createElement("input");
    input.value = value;
    input.disabled = disabled;
    input.addEventListener("change", () => onCommit(input.value));
    label.append(labelSpan, input);
    return label;
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

  function renderMobileDiffBody(state: RepoDiffState, sessionId: string, _projection: SessionProjection): void {
    const key = comparisonKey(state);
    const annotations = diffAnnotations.get(sessionId) ?? [];
    const selectedAnnotations = selectedDiffAnnotations(annotations, key);
    const rows = parseDiffRows(state.diff);
    const fileSummaries = summarizeDiffFiles(rows, annotations, key);
    if (fileSummaries.length > 0) renderMobileDiffFiles(fileSummaries);
    if (!rows.some(row => row.type === "file" || row.type === "hunk" || (row.type === "line" && row.location.newPath))) {
      const pre = diffView.ownerDocument.createElement("pre");
      pre.className = "mobile-diff-pre";
      pre.textContent = state.diff;
      diffView.append(pre);
      renderMobileDiffComments(selectedAnnotations);
      return;
    }

    const diff = diffView.ownerDocument.createElement("div");
    diff.className = "mobile-diff-lines";
    for (const row of rows) {
      const line = renderMobileDiffRow(row, sessionId, state, key, annotations);
      if (line) diff.append(line);
    }
    diffView.append(diff);
    renderMobileDiffComments(selectedAnnotations);
  }

  function renderMobileDiffFiles(files: ReturnType<typeof summarizeDiffFiles>): void {
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
      item.append(path, meta);
      list.append(item);
    }
    section.append(list);
    diffView.append(section);
  }

  function renderMobileDiffRow(
    row: ParsedDiffRow,
    sessionId: string,
    state: RepoDiffState,
    key: string,
    annotations: DiffReviewAnnotation[],
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

    const lineAnnotations = annotationsForDiffLocation(annotations, key, row.location);
    const lineComments = lineAnnotations.filter(annotation => annotation.kind === "comment");
    const lineQuestions = lineAnnotations.filter(annotation => annotation.kind === "question");
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
    if (lineAnnotations.length > 0) {
      const thread = diffView.ownerDocument.createElement("div");
      thread.className = "mobile-diff-inline-comments";
      for (const annotation of lineAnnotations) {
        const item = diffView.ownerDocument.createElement("div");
        item.className = `mobile-diff-inline-comment mobile-diff-inline-${annotation.kind}`;
        item.textContent = `${annotation.kind === "question" ? "Question" : "Comment"}: ${annotation.text}`;
        thread.append(item);
      }
      wrap.append(thread);
    }
    return wrap;
  }

  function renderMobileDiffComments(comments: DiffReviewAnnotation[]): void {
    const section = diffView.ownerDocument.createElement("section");
    section.className = "mobile-diff-comments";
    const title = diffView.ownerDocument.createElement("strong");
    title.textContent = "Review annotations";
    section.append(title);
    if (comments.length === 0) {
      const empty = diffView.ownerDocument.createElement("p");
      empty.className = "mobile-empty-state";
      empty.textContent = "No annotations on this diff yet.";
      section.append(empty);
    } else {
      for (const comment of comments) {
        const item = diffView.ownerDocument.createElement("article");
        item.className = `mobile-diff-comment mobile-diff-${comment.kind}`;
        const location = diffView.ownerDocument.createElement("code");
        location.textContent = formatDiffLocation(comment);
        const body = diffView.ownerDocument.createElement("p");
        body.textContent = comment.text;
        item.append(location, body);
        section.append(item);
      }
    }
    diffView.append(section);
  }

  return { connect, send };
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
