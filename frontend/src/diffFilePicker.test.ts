import { afterEach, expect, it, vi } from "vitest";
import { openDiffFilePicker } from "./diffFilePicker";
import type { ClientMessage, ServerMessage } from "./protocol";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("ignores superseded and cancelled replies and remembers only successful directories", () => {
  // jsdom lacks the native dialog methods used by the browser surface.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  const sent: ClientMessage[] = [];
  const send = (message: ClientMessage) => { sent.push(message); return true; };
  const onOpen = vi.fn();
  const picker = openDiffFilePicker(document, "/start", send, onOpen, () => {});
  const first = sent.at(-1) as Extract<ClientMessage, { type: "diffFile.list" }>;
  const inputs = document.querySelectorAll<HTMLInputElement>(".diff-file-picker input");
  inputs[0].value = "/next";
  inputs[0].dispatchEvent(new Event("input"));
  inputs[0].form!.dispatchEvent(new Event("submit", { cancelable: true }));
  const next = sent.at(-1) as typeof first;
  const result: Extract<ServerMessage, { type: "diffFile.listed" }> = {
    type: "diffFile.listed", requestId: next.requestId, path: "/next", parentPath: "/",
    entries: [{ name: "review.patch", path: "/next/review.patch", isDirectory: false }], truncated: false,
  };
  picker.handleMessage(result);
  picker.handleMessage({ ...result, requestId: first.requestId, path: "/stale" });
  expect(document.querySelector(".diff-file-picker-location")?.textContent).toBe("/next");
  inputs[1].value = "/next/review.patch";
  inputs[1].form!.dispatchEvent(new Event("submit", { cancelable: true }));
  const opening = sent.at(-1) as Extract<ClientMessage, { type: "diffFile.open" }>;
  inputs[1].value = "/next/different.patch";
  inputs[1].dispatchEvent(new Event("input"));
  picker.handleMessage({ type: "diffFile.opened", requestId: opening.requestId, path: opening.path, rows: [] });
  expect(onOpen).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLDialogElement>(".diff-file-picker")?.open).toBe(true);
  inputs[0].value = "/missing";
  inputs[0].form!.dispatchEvent(new Event("submit", { cancelable: true }));
  const missing = sent.at(-1) as typeof first;
  picker.handleMessage({ type: "diffFile.error", requestId: missing.requestId, message: "Directory not found" });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Directory not found");
  expect(document.querySelector(".diff-file-picker-entry")?.textContent).toBe("review.patch");
  picker.close();
  const reopened = openDiffFilePicker(document, "/fallback", send, onOpen, () => {});
  expect(sent.at(-1)).toMatchObject({ type: "diffFile.list", path: "/next" });
  picker.handleMessage({ ...result, requestId: missing.requestId, path: "/late" });
  expect(localStorage.getItem("fura.diff.lastDirectory")).toBe("/next");
  reopened.close();
});
