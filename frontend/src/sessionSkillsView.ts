import type { ClientMessage, ServerMessage, SessionSkillCatalogEntry, SessionSkillsState } from "./protocol";

type SessionSkillsContext = { sessionId: string | null; state?: SessionSkillsState; ready: boolean; visible: boolean };
type SkillsReply = Extract<ServerMessage, { type: "session.skills.result" | "session.skills.error" }>;

export function createSessionSkillsView(button: HTMLButtonElement, options: {
  context(): SessionSkillsContext;
  send(message: ClientMessage): boolean;
  requestId(): string;
}) {
  let dialog: HTMLDialogElement | undefined;
  let current: SessionSkillsState | undefined;
  let expectedRevision = "";
  let draft = new Set<string>();
  let catalog: SessionSkillCatalogEntry[] = [];
  let draftNames = new Map<string, string>();
  let loaded = false;
  let needsReload = false;
  let error = "";
  let pending: { requestId: string; kind: "get" | "apply"; revision: string } | undefined;
  let previousFocus: HTMLElement | null = null;
  let pointerFocus: HTMLElement | null = null;
  let search: HTMLInputElement;
  let list: HTMLDivElement;
  let currentLabel: HTMLParagraphElement;
  let stagedLabel: HTMLParagraphElement;
  let status: HTMLParagraphElement;
  let apply: HTMLButtonElement;
  let reload: HTMLButtonElement;
  let cancel: HTMLButtonElement;

  function close(focus = true): void {
    const closing = dialog;
    dialog = undefined;
    current = undefined;
    pending = undefined;
    // Retire synchronously: a closed popout cannot deliver a queued close event.
    // Removing first also prevents native focus restoration into a changed session.
    closing?.remove();
    closing?.close();
    if (closing && focus && previousFocus?.isConnected && !previousFocus.closest("[hidden]")) previousFocus.focus();
  }

  function renderStatus(): void {
    if (!dialog || !current) return;
    const names = current.active.map(skill => skill.name).join(", ") || "None";
    currentLabel.textContent = current.error ? `Current: unavailable — ${current.error}`
      : `Current${current.pending ? " main request" : " (confirmed)"}: ${names}${current.pending
        ? `; Next main request: ${current.selected.map(skill => skill.name).join(", ") || "None"}` : ""}`;
    stagedLabel.textContent = `Staged (${draft.size}): ${[...draft].map(id => draftNames.get(id) ?? id).join(", ") || "None"}`;
    status.textContent = current.error || error || (pending?.kind === "apply" ? "Applying session guidance… Closing does not cancel Apply."
      : pending ? "Loading skill catalog…" : current.applying ? "Another client is applying session guidance…"
      : current.pending ? "Saved selection is waiting for the next main model request." : "Apply pins the current definitions, even when the selection is unchanged.");
    status.setAttribute("role", current.error || error ? "alert" : "status");
    status.classList.toggle("error", Boolean(current.error || error));
    apply.disabled = Boolean(pending || !loaded || needsReload || current.error || current.applying);
    reload.disabled = Boolean(pending || current.applying);
    // Apply is already in flight; closing never claims to cancel its commit.
    cancel.textContent = pending?.kind === "apply" ? "Close" : "Cancel";
    for (const checkbox of list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      checkbox.disabled = Boolean(pending || current.applying || current.error);
    }
  }

  function renderCatalog(): void {
    if (!dialog || !current) return;
    list.replaceChildren();
    const rows = [...catalog];
    if (loaded) {
      for (const id of draft) {
        if (!rows.some(row => row.id === id)) rows.push({ id, name: draftNames.get(id) ?? id, description: "Previously selected definition; remove or reload to resolve.", status: "missing" });
      }
    }
    const query = search.value.trim().toLocaleLowerCase();
    for (const entry of rows) {
      if (query && !`${entry.name} ${entry.description} ${entry.id}`.toLocaleLowerCase().includes(query)) continue;
      const owner = dialog.ownerDocument;
      const row = owner.createElement("label");
      row.className = "model-picker-row session-skill-row";
      const checkbox = owner.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = entry.id;
      checkbox.checked = draft.has(entry.id);
      checkbox.setAttribute("aria-label", entry.name);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) draft.add(entry.id);
        else draft.delete(entry.id);
        renderStatus();
      });
      const text = owner.createElement("span");
      const title = owner.createElement("span");
      title.className = "model-picker-row-title";
      title.textContent = entry.name;
      const details = owner.createElement("span");
      details.className = "model-picker-row-details";
      details.textContent = `${entry.description}${entry.status === "available" ? "" : ` · ${entry.status}`}`;
      const path = owner.createElement("span");
      path.className = "model-picker-row-details session-skill-path";
      path.textContent = entry.id;
      text.append(title, details, path);
      row.append(checkbox, text);
      list.append(row);
    }
    if (!list.childElementCount) {
      const empty = dialog.ownerDocument.createElement("p");
      empty.className = "model-picker-empty";
      empty.textContent = loaded ? "No matching skills." : "Loading skill catalog…";
      list.append(empty);
    }
    renderStatus();
  }

  function sync(): void {
    const context = options.context();
    const state = context.state?.sessionId === context.sessionId ? context.state : undefined;
    button.hidden = !context.visible;
    button.disabled = !context.ready || !state;
    button.textContent = state?.error ? "Skills… unavailable"
      : state?.pending ? `Skills… Pending (${state.active.length} → ${state.selected.length})`
      : state ? `Skills… Current (${state.active.length}): ${state.active.map(skill => skill.name).join(", ") || "None"}`
      : "Skills…";
    button.title = state?.error || (!state ? "Session skills are unsupported by this runtime."
      : !context.ready ? "Connect to a managed session to edit session skills."
      : `Current: ${state.active.map(skill => skill.name).join(", ") || "None"}${state.pending
        ? `; Next main request: ${state.selected.map(skill => skill.name).join(", ") || "None"}` : ""}. Edit session guidance; one-shot skills remain separate /commands.`);
    if (!dialog) return;
    if (!context.ready || !state || !context.visible || current?.sessionId !== state.sessionId
      || current.journalSessionId !== state.journalSessionId
      || dialog.ownerDocument !== button.ownerDocument || !dialog.isConnected) {
      close(false);
      return;
    }
    if (state.revision !== current.revision && pending?.kind !== "apply") {
      needsReload = true;
      error = "Session selection changed. Reload current state, review your staged selection, then Apply.";
    }
    current = state;
    renderStatus();
  }

  function request(kind: "get" | "apply"): void {
    sync();
    if (!dialog || !current || pending || (kind === "apply" && apply.disabled)) return;
    pending = { requestId: options.requestId(), kind, revision: current.revision };
    error = "";
    const identity = { sessionId: current.sessionId, journalSessionId: current.journalSessionId };
    const message: ClientMessage = kind === "get"
      ? { type: "session.skills.get", requestId: pending.requestId, ...identity }
      : { type: "session.skills.apply", requestId: pending.requestId, ...identity, expectedRevision, skillIds: [...draft] };
    renderStatus();
    if (!options.send(message)) {
      pending = undefined;
      error = "Not connected. Reload current state before applying.";
      needsReload = true;
      renderStatus();
    }
  }

  function receive(message: SkillsReply): SessionSkillsState | undefined {
    sync();
    if (!dialog || !current || !pending || pending.requestId !== message.requestId || message.sessionId !== current.sessionId) return;
    const state = message.state;
    if (state && (state.sessionId !== current.sessionId || state.journalSessionId !== current.journalSessionId)) return;
    const submitted = pending;
    pending = undefined;
    // An intervening projection is newer than a reply for the old revision.
    if (state && current.revision !== submitted.revision && state.revision !== current.revision) {
      needsReload = true;
      error = "A newer session selection arrived. Reload current state before applying.";
      renderStatus();
      return;
    }
    if (state) current = state;
    if (message.type === "session.skills.error") {
      error = message.message;
      needsReload ||= !state || state.revision !== expectedRevision;
      renderStatus();
      return state;
    }
    if (submitted.kind === "apply") {
      close();
      return state;
    }
    if (!message.catalog) {
      error = "The runtime did not return a skill catalog. Reload to retry.";
      needsReload = true;
      renderStatus();
      return state;
    }
    catalog = message.catalog;
    for (const entry of catalog) draftNames.set(entry.id, entry.name);
    if (!loaded) draft = new Set(current.selected.map(skill => skill.id));
    for (const entry of current.selected) draftNames.set(entry.id, entry.name);
    expectedRevision = current.revision;
    loaded = true;
    needsReload = false;
    error = "";
    renderCatalog();
    return state;
  }

  button.setAttribute("aria-haspopup", "dialog");
  button.addEventListener("pointerdown", () => {
    pointerFocus = button.ownerDocument.activeElement as HTMLElement | null;
  });
  button.addEventListener("click", () => {
    sync();
    if (button.disabled || dialog) return;
    current = options.context().state!;
    expectedRevision = current.revision;
    draft = new Set(current.selected.map(skill => skill.id));
    draftNames = new Map(current.selected.map(skill => [skill.id, skill.name]));
    catalog = [];
    loaded = false;
    needsReload = false;
    error = "";
    const owner = button.ownerDocument;
    previousFocus = pointerFocus?.ownerDocument === owner ? pointerFocus : owner.activeElement as HTMLElement | null;
    pointerFocus = null;
    dialog = owner.createElement("dialog");
    dialog.id = "sessionSkillsDialog";
    dialog.className = "session-skills-dialog modal-panel";
    dialog.setAttribute("aria-labelledby", "sessionSkillsTitle");
    dialog.setAttribute("aria-describedby", "sessionSkillsDescription");
    dialog.innerHTML = `
      <header class="modal-header"><div><h2 id="sessionSkillsTitle">Session skills</h2>
        <p id="sessionSkillsDescription">Standing guidance for this session, not a task request. Run one-shot skills with arguments separately through /commands.</p></div></header>
      <div class="session-skills-summary"><p id="sessionSkillsCurrent"></p><p id="sessionSkillsStaged"></p></div>
      <input id="sessionSkillsSearch" class="model-picker-search" type="search" aria-label="Search session skills" placeholder="Search skills" autocomplete="off" />
      <div id="sessionSkillsList" class="model-picker-list" role="group" aria-label="Staged session skills"></div>
      <footer class="modal-footer"><p id="sessionSkillsStatus" class="model-picker-status" aria-live="polite"></p>
        <div class="modal-actions"><button id="sessionSkillsReload" type="button">Reload current</button><button id="sessionSkillsCancel" type="button">Cancel</button><button id="sessionSkillsApply" type="button">Apply</button></div></footer>`;
    search = dialog.querySelector<HTMLInputElement>("#sessionSkillsSearch")!;
    list = dialog.querySelector<HTMLDivElement>("#sessionSkillsList")!;
    currentLabel = dialog.querySelector<HTMLParagraphElement>("#sessionSkillsCurrent")!;
    stagedLabel = dialog.querySelector<HTMLParagraphElement>("#sessionSkillsStaged")!;
    status = dialog.querySelector<HTMLParagraphElement>("#sessionSkillsStatus")!;
    apply = dialog.querySelector<HTMLButtonElement>("#sessionSkillsApply")!;
    reload = dialog.querySelector<HTMLButtonElement>("#sessionSkillsReload")!;
    cancel = dialog.querySelector<HTMLButtonElement>("#sessionSkillsCancel")!;
    search.addEventListener("input", renderCatalog);
    apply.addEventListener("click", () => request("apply"));
    reload.addEventListener("click", () => request("get"));
    cancel.addEventListener("click", () => close());
    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      close();
    });
    owner.body.append(dialog);
    renderCatalog();
    dialog.showModal();
    search.focus();
    request("get");
  });
  return { sync, receive, close };
}
