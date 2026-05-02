import { describe, expect, it, vi } from "vitest";
import { createDesktopPanelShell } from "./desktopDockview";

describe("createDesktopPanelShell", () => {
  it("creates a desktop panel content shell with toolbar and scroll container", () => {
    const onPopout = vi.fn();

    const shell = createDesktopPanelShell(document, "transcript", onPopout);

    expect(shell.element.className).toBe("panel-content panel-content-transcript");
    expect(shell.scroll.className).toBe("panel-scroll");
    expect(shell.element.firstElementChild?.className).toBe("panel-toolbar");
    expect(shell.element.lastElementChild).toBe(shell.scroll);
  });

  it("wires the popout button to the provided callback", () => {
    const onPopout = vi.fn();
    const shell = createDesktopPanelShell(document, "tools", onPopout);

    shell.element.querySelector<HTMLButtonElement>(".panel-popout-btn")?.click();

    expect(onPopout).toHaveBeenCalledOnce();
    expect(shell.element.querySelector(".panel-popout-btn")?.textContent).toBe("Pop out");
  });
});
