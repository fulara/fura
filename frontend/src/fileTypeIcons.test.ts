import { describe, expect, it } from "vitest";
import { filePathWithIcon, fileTypeIcon } from "./fileTypeIcons";

describe("file type icons", () => {
  it("uses Oh My Pi language icons for common code files", () => {
    expect(fileTypeIcon("src/main.rs")).toBe("🦀");
    expect(fileTypeIcon("scripts/build.py")).toBe("🐍");
    expect(fileTypeIcon("frontend/src/main.ts")).toBe("🟦");
    expect(fileTypeIcon("frontend/src/app.jsx")).toBe("🟨");
  });

  it("recognizes special filenames and non-code file families", () => {
    expect(fileTypeIcon("Dockerfile.dev")).toBe("🐳");
    expect(fileTypeIcon(".env.local")).toBe("🔧");
    expect(fileTypeIcon("archive.tar.gz")).toBe("🗜");
    expect(fileTypeIcon("diagram.png")).toBe("🖼");
    expect(fileTypeIcon("notes.md")).toBe("📝");
  });

  it("falls back without pretending unknown files are known", () => {
    expect(fileTypeIcon("unknown.weird")).toBe("⌘");
    expect(filePathWithIcon("unknown.weird", value => value.toUpperCase())).toBe("⌘ UNKNOWN.WEIRD");
    expect(filePathWithIcon(undefined)).toBe("…");
  });
});
