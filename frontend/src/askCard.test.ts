import { describe, expect, it, vi } from "vitest";
import { askCardRenderKey, isBlockingAskMethod, parsePendingAsk, renderAskCard } from "./askCard";

describe("parsePendingAsk", () => {
  it("returns null for absent or non-renderable methods", () => {
    expect(parsePendingAsk("s1", null)).toBeNull();
    expect(parsePendingAsk("s1", undefined)).toBeNull();
    expect(parsePendingAsk("s1", { id: "n", method: "notify", message: "hi" })).toBeNull();
    expect(parsePendingAsk("s1", { id: "w", method: "setWidget" })).toBeNull();
    expect(parsePendingAsk("s1", { method: "select" })).toBeNull();
  });

  it("parses renderable ask methods and carries their fields", () => {
    const ask = parsePendingAsk("s1", { id: "a1", method: "select", title: "Pick", options: ["x", "y"] });
    expect(ask?.id).toBe("a1");
    expect(ask?.method).toBe("select");
    expect(ask?.options).toEqual(["x", "y"]);
    expect(parsePendingAsk("s1", { id: "u", method: "open_url", url: "https://x.test" })?.method).toBe("open_url");
  });
});

describe("isBlockingAskMethod", () => {
  it("treats response-required methods as blocking and open_url as non-blocking", () => {
    for (const method of ["select", "confirm", "input", "editor"]) {
      expect(isBlockingAskMethod(method)).toBe(true);
    }
    expect(isBlockingAskMethod("open_url")).toBe(false);
  });
});

describe("askCardRenderKey", () => {
  it("changes when the visible ask changes", () => {
    const a = parsePendingAsk("s1", { id: "a1", method: "select", title: "Pick", options: ["x"] })!;
    const b = parsePendingAsk("s1", { id: "a2", method: "select", title: "Pick", options: ["x"] })!;
    expect(askCardRenderKey(a)).not.toBe(askCardRenderKey(b));
  });

  it("changes when a rendered field changes on the same dialog id", () => {
    const base = parsePendingAsk("s1", { id: "a1", method: "input", title: "T", placeholder: "one" })!;
    const changed = parsePendingAsk("s1", { id: "a1", method: "input", title: "T", placeholder: "two" })!;
    expect(askCardRenderKey(base)).not.toBe(askCardRenderKey(changed));
  });
});

describe("renderAskCard", () => {
  it("renders select options and responds verbatim on click", () => {
    const ask = parsePendingAsk("s1", { id: "a1", method: "select", title: "Review Mode", options: ["Review a commit", "Review changes"] })!;
    const onRespond = vi.fn();
    const card = renderAskCard(ask, { onRespond });

    expect(card.querySelector(".ask-card-title")?.textContent).toBe("Review Mode");
    const options = [...card.querySelectorAll<HTMLButtonElement>(".ask-card-option")];
    expect(options.map(button => button.textContent)).toEqual(["Review a commit", "Review changes"]);

    options[0]?.click();
    expect(onRespond).toHaveBeenCalledWith({ value: "Review a commit" });
    expect(options.every(button => button.disabled)).toBe(true);
  });

  it("confirms and cancels a confirm ask", () => {
    const ask = parsePendingAsk("s1", { id: "c1", method: "confirm", title: "Continue?", message: "Proceed?" })!;
    const confirmSpy = vi.fn();
    const confirmCard = renderAskCard(ask, { onRespond: confirmSpy });
    confirmCard.querySelector<HTMLButtonElement>(".ask-card-confirm")?.click();
    expect(confirmSpy).toHaveBeenCalledWith({ confirmed: true });

    const cancelSpy = vi.fn();
    const cancelCard = renderAskCard(ask, { onRespond: cancelSpy });
    cancelCard.querySelector<HTMLButtonElement>(".ask-card-cancel")?.click();
    expect(cancelSpy).toHaveBeenCalledWith({ cancelled: true });
  });

  it("sends the edited value for an editor ask", () => {
    const ask = parsePendingAsk("s1", { id: "e1", method: "editor", title: "Notes", prefill: "draft" })!;
    const onRespond = vi.fn();
    const card = renderAskCard(ask, { onRespond });
    const input = card.querySelector<HTMLTextAreaElement>(".ask-card-input");
    if (!input) throw new Error("editor input missing");
    expect(input.value).toBe("draft");
    input.value = "final answer";
    card.querySelector<HTMLButtonElement>(".ask-card-submit")?.click();
    expect(onRespond).toHaveBeenCalledWith({ value: "final answer" });
  });

  it("renders open_url as a safe link with a dismiss control", () => {
    const ask = parsePendingAsk("s1", { id: "o1", method: "open_url", url: "https://auth.test/start", instructions: "Open it." })!;
    const onRespond = vi.fn();
    const card = renderAskCard(ask, { onRespond });
    expect(card.querySelector<HTMLAnchorElement>("a.ask-card-option")?.href).toBe("https://auth.test/start");
    card.querySelector<HTMLButtonElement>(".ask-card-cancel")?.click();
    expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
  });

  it("rejects unsafe open_url protocols", () => {
    const ask = parsePendingAsk("s1", { id: "o2", method: "open_url", url: "javascript:alert(1)" })!;
    const card = renderAskCard(ask, { onRespond: vi.fn() });
    expect(card.querySelector("a.ask-card-option")).toBeNull();
    expect(card.querySelector(".ask-card-empty")?.textContent).toContain("http://");
  });
});
