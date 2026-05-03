export const FURA_TOKEN_STORAGE_KEY = "fura.token";

type TokenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function consumeBootstrapToken(
  locationHref: string,
  storage: TokenStorage,
  replaceUrl: (url: string) => void,
): string {
  stripUrlToken(locationHref, replaceUrl);
  return readStoredBootstrapToken(storage);
}

export function stripUrlToken(locationHref: string, replaceUrl: (url: string) => void): boolean {
  const url = new URL(locationHref);
  if (!url.searchParams.has("token")) return false;
  url.searchParams.delete("token");
  replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  return true;
}

export function readStoredBootstrapToken(storage: TokenStorage): string {
  return storage.getItem(FURA_TOKEN_STORAGE_KEY)?.trim() ?? "";
}

export function storeBootstrapToken(token: string, storage: TokenStorage): string {
  const bridgeToken = token.trim();
  if (bridgeToken) storage.setItem(FURA_TOKEN_STORAGE_KEY, bridgeToken);
  return bridgeToken;
}

export function clearBootstrapToken(storage: TokenStorage): void {
  storage.removeItem(FURA_TOKEN_STORAGE_KEY);
}
