export const FURA_TOKEN_STORAGE_KEY = "fura.token";

type TokenStorage = Pick<Storage, "getItem" | "setItem">;

export function consumeBootstrapToken(
  locationHref: string,
  storage: TokenStorage,
  replaceUrl: (url: string) => void,
): string {
  const url = new URL(locationHref);
  const urlToken = url.searchParams.get("token")?.trim() ?? "";
  const storedToken = storage.getItem(FURA_TOKEN_STORAGE_KEY)?.trim() ?? "";
  if (urlToken) {
    storage.setItem(FURA_TOKEN_STORAGE_KEY, urlToken);
    url.searchParams.delete("token");
    replaceUrl(`${url.pathname}${url.search}${url.hash}`);
  }
  return urlToken || storedToken;
}

export function storeBootstrapToken(token: string, storage: TokenStorage): string {
  const bridgeToken = token.trim();
  if (bridgeToken) storage.setItem(FURA_TOKEN_STORAGE_KEY, bridgeToken);
  return bridgeToken;
}
