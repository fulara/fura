import { describe, expect, it } from "vitest";
import { clearBootstrapToken, consumeBootstrapToken, FURA_TOKEN_STORAGE_KEY, storeBootstrapToken, stripUrlToken } from "./bootstrapAuth";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("consumeBootstrapToken", () => {
  it("strips the URL token without using or storing it", () => {
    const storage = new MemoryStorage();
    storage.setItem(FURA_TOKEN_STORAGE_KEY, "stored");
    const replacements: string[] = [];

    const token = consumeBootstrapToken(
      "http://127.0.0.1:3737/mobile.html?token=dev&view=mobile#session",
      storage,
      url => replacements.push(url),
    );

    expect(token).toBe("stored");
    expect(storage.getItem(FURA_TOKEN_STORAGE_KEY)).toBe("stored");
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

  it("clears stored tokens", () => {
    const storage = new MemoryStorage();
    storage.setItem(FURA_TOKEN_STORAGE_KEY, "stored");

    clearBootstrapToken(storage);

    expect(storage.getItem(FURA_TOKEN_STORAGE_KEY)).toBeNull();
  });
});

describe("stripUrlToken", () => {
  it("returns false when the URL has no token", () => {
    const replacements: string[] = [];

    expect(stripUrlToken("http://127.0.0.1:3737/mobile.html?view=mobile", url => replacements.push(url))).toBe(false);
    expect(replacements).toEqual([]);
  });
});
