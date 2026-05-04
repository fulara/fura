/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import mobileSource from "./mobile.ts?raw";
import mobileAppSource from "./mobileApp.ts?raw";

describe("mobile entry boundary", () => {
  it("does not import desktop Dockview paths", () => {
    for (const source of [mobileSource, mobileAppSource]) {
      expect(source).not.toContain("desktopDockview");
      expect(source).not.toContain("Dockview");
      expect(source).not.toContain("ask-fura-toggle");
    }
  });
});
