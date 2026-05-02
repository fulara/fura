/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import mobileSource from "./mobile.ts?raw";
import mobileAppSource from "./mobileApp.ts?raw";

describe("mobile entry boundary", () => {
  it("does not import desktop Dockview or Ask Fura controller paths", () => {
    for (const source of [mobileSource, mobileAppSource]) {
      expect(source).not.toContain("desktopDockview");
      expect(source).not.toContain("Dockview");
      expect(source).not.toContain("askFura");
      expect(source).not.toContain("control.prompt");
    }
  });
});
