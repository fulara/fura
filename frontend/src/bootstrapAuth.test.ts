import { describe, expect, it } from "vitest";
import { consumeBootstrapToken, FURA_TOKEN_STORAGE_KEY, storeBootstrapToken } from "./bootstrapAuth";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("consumeBootstrapToken", () => {
  it("uses the URL token, stores it, and removes it from the URL", () => {
    const storage = new MemoryStorage();
    storage.setItem(FURA_TOKEN_STORAGE_KEY, "stored");
    const replacements: string[] = [];

    const token = consumeBootstrapToken(
      "http://127.0.0.1:3737/mobile.html?token=dev&view=mobile#session",
      storage,
      url => replacements.push(url),
    );

    expect(token).toBe("dev");
    expect(storage.getItem(FURA_TOKEN_STORAGE_KEY)).toBe("dev");
    expect(replacements).toEqual(["/mobile.html?view=mobile#session"]);
  });

  it("falls back to the stored token without replacing the URL", () => {
    const storage = new MemoryStorage();
    storage.setItem(FURA_TOKEN_STORAGE_KEY, "stored");
    const replacements: string[] = [];

    const token = consumeBootstrapToken(
      "http://127.0.0.1:3737/mobile.html?view=mobile#session",
      storage,
      url => replacements.push(url),
    );

    expect(token).toBe("stored");
    expect(replacements).toEqual([]);
  });

  it("returns an empty token when neither source has one", () => {
    const storage = new MemoryStorage();

    expect(consumeBootstrapToken("http://127.0.0.1:3737/", storage, () => undefined)).toBe("");
  });
});

describe("storeBootstrapToken", () => {
  it("trims and stores non-empty tokens", () => {
    const storage = new MemoryStorage();

    expect(storeBootstrapToken(" dev ", storage)).toBe("dev");
    expect(storage.getItem(FURA_TOKEN_STORAGE_KEY)).toBe("dev");
  });

  it("does not overwrite storage with an empty token", () => {
    const storage = new MemoryStorage();
    storage.setItem(FURA_TOKEN_STORAGE_KEY, "stored");

    expect(storeBootstrapToken("  ", storage)).toBe("");
    expect(storage.getItem(FURA_TOKEN_STORAGE_KEY)).toBe("stored");
  });
});
