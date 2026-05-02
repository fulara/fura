/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import mobileSource from "./mobile.ts?raw";

describe("mobile entry boundary", () => {
  it("does not import desktop Dockview or Ask Fura controller paths", () => {
    expect(mobileSource).not.toContain("desktopDockview");
    expect(mobileSource).not.toContain("Dockview");
    expect(mobileSource).not.toContain("askFura");
    expect(mobileSource).not.toContain("control.prompt");
  });
});
