import { mkEl } from "./dom";
import {
  extensionDialogBodyText,
  extensionDialogHttpUrl,
  parseExtensionDialogRequest,
  type ExtensionDialogRequest,
} from "./extensionDialog";

export type PendingAsk = ExtensionDialogRequest;
export type AskResponse = Record<string, unknown>;

export type AskCardActions = {
  /** Send a response (or `{ cancelled: true }`) for the active ask request. */
  onRespond: (response: AskResponse) => void;
};

const RENDERABLE_ASK_METHODS = new Set(["select", "confirm", "input", "editor", "open_url"]);
const BLOCKING_ASK_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Methods that lock the composer and require a user response. */
export function isBlockingAskMethod(method: string): boolean {
  return BLOCKING_ASK_METHODS.has(method);
}

/**
 * Parse the projection `pendingAsk` value into a renderable ask request, or `null`
 * when there is no ask or the method has no inline card surface.
 */
export function parsePendingAsk(sessionId: string, value: unknown): PendingAsk | null {
  if (value === null || value === undefined) return null;
  const request = parseExtensionDialogRequest(sessionId, value);
  if (!request || !RENDERABLE_ASK_METHODS.has(request.method)) return null;
  return request;
}

/** Stable identity for transcript render caching; changes whenever the visible ask changes. */
export function askCardRenderKey(ask: PendingAsk): string {
  return [
    ask.sessionId,
    ask.id,
    ask.method,
    ask.title,
    ask.message ?? "",
    ask.instructions ?? "",
    (ask.options ?? []).join("\u0001"),
    ask.placeholder ?? "",
    ask.prefill ?? "",
    ask.promptStyle ? "1" : "0",
    ask.timeoutMs ?? "",
    ask.url ?? "",
  ].join("\u0000");
}

function lockCard(root: HTMLElement, statusText: string): void {
  for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>(
    "button, input, textarea",
  )) {
    control.disabled = true;
  }
  const status = root.querySelector<HTMLElement>(".ask-card-status");
  if (status) status.textContent = statusText;
}

function respond(root: HTMLElement, actions: AskCardActions, response: AskResponse, statusText: string): void {
  lockCard(root, statusText);
  actions.onRespond(response);
}

function renderSelectOptions(root: HTMLElement, ask: PendingAsk, actions: AskCardActions): HTMLElement {
  const list = mkEl("div");
  list.className = "ask-card-options";
  const options = ask.options ?? [];
  if (options.length === 0) {
    const empty = mkEl("p");
    empty.className = "ask-card-empty";
    empty.textContent = "No options were provided for this question.";
    list.append(empty);
    return list;
  }
  for (const option of options) {
    const button = mkEl("button");
    button.type = "button";
    button.className = "ask-card-option";
    button.textContent = option;
    button.addEventListener("click", () => respond(root, actions, { value: option }, "Sending response…"));
    list.append(button);
  }
  return list;
}

function renderConfirmActions(root: HTMLElement, actions: AskCardActions): HTMLElement {
  const list = mkEl("div");
  list.className = "ask-card-options";
  const confirm = mkEl("button");
  confirm.type = "button";
  confirm.className = "ask-card-option ask-card-confirm";
  confirm.textContent = "Confirm";
  confirm.addEventListener("click", () => respond(root, actions, { confirmed: true }, "Sending response…"));
  list.append(confirm);
  return list;
}

function renderTextEntry(root: HTMLElement, ask: PendingAsk, actions: AskCardActions): HTMLElement {
  const wrapper = mkEl("div");
  wrapper.className = "ask-card-entry";
  const field: HTMLTextAreaElement | HTMLInputElement =
    ask.method === "editor" ? mkEl("textarea") : mkEl("input");
  field.className = "ask-card-input";
  if (field instanceof HTMLTextAreaElement) {
    field.rows = ask.promptStyle ? 4 : 8;
    field.value = ask.prefill ?? "";
  } else {
    field.type = "text";
    field.autocomplete = "off";
    field.spellcheck = false;
    if (ask.prefill) field.value = ask.prefill;
  }
  if (ask.placeholder) field.placeholder = ask.placeholder;
  const submit = mkEl("button");
  submit.type = "button";
  submit.className = "ask-card-option ask-card-submit";
  submit.textContent = "Send";
  submit.addEventListener("click", () => respond(root, actions, { value: field.value }, "Sending response…"));
  wrapper.append(field, submit);
  return wrapper;
}

function renderOpenUrl(root: HTMLElement, ask: PendingAsk, actions: AskCardActions): HTMLElement {
  const wrapper = mkEl("div");
  wrapper.className = "ask-card-open-url";
  const safeUrl = extensionDialogHttpUrl(ask);
  if (safeUrl) {
    const link = mkEl("a");
    link.href = safeUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "ask-card-option";
    link.textContent = "Open link";
    wrapper.append(link);
  } else {
    const warning = mkEl("p");
    warning.className = "ask-card-empty";
    warning.textContent = "Fura only opens http:// and https:// extension URLs.";
    wrapper.append(warning);
  }
  const code = mkEl("code");
  code.className = "ask-card-url";
  code.textContent = ask.url ?? "No URL provided.";
  wrapper.append(code);
  const dismiss = mkEl("button");
  dismiss.type = "button";
  dismiss.className = "ask-card-cancel";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => respond(root, actions, { cancelled: true }, "Dismissing…"));
  wrapper.append(dismiss);
  return wrapper;
}

/** Render the inline ask card shown in a session's transcript while it awaits a user response. */
export function renderAskCard(ask: PendingAsk, actions: AskCardActions): HTMLElement {
  const root = mkEl("section");
  root.className = "ask-card";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Agent question");

  const header = mkEl("header");
  header.className = "ask-card-header";
  const kicker = mkEl("span");
  kicker.className = "ask-card-kicker";
  kicker.textContent = "Agent is asking";
  const title = mkEl("h3");
  title.className = "ask-card-title";
  title.textContent = ask.title;
  header.append(kicker, title);
  root.append(header);

  const bodyText = extensionDialogBodyText(ask);
  if (bodyText) {
    const body = mkEl("p");
    body.className = "ask-card-body";
    body.textContent = bodyText;
    root.append(body);
  }

  switch (ask.method) {
    case "select":
      root.append(renderSelectOptions(root, ask, actions));
      break;
    case "confirm":
      root.append(renderConfirmActions(root, actions));
      break;
    case "input":
    case "editor":
      root.append(renderTextEntry(root, ask, actions));
      break;
    case "open_url":
      root.append(renderOpenUrl(root, ask, actions));
      break;
  }

  const status = mkEl("p");
  status.className = "ask-card-status";
  status.setAttribute("aria-live", "polite");
  if (ask.timeoutMs !== undefined) {
    status.textContent = `Auto-resolves in ${Math.ceil(ask.timeoutMs / 1000)}s if unanswered.`;
  }
  root.append(status);

  if (isBlockingAskMethod(ask.method)) {
    const footer = mkEl("div");
    footer.className = "ask-card-actions";
    const cancel = mkEl("button");
    cancel.type = "button";
    cancel.className = "ask-card-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => respond(root, actions, { cancelled: true }, "Cancelling…"));
    footer.append(cancel);
    root.append(footer);
  }

  return root;
}
