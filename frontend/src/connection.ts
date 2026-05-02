import type { ClientMessage, ServerMessage } from "./protocol";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type WebSocketLike = {
  readonly readyState: number;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
  send(data: string): void;
};

export type WebSocketConstructor = new (url: string | URL) => WebSocketLike;
export type FetchLike = (input: string | URL, init?: AuthSessionRequestInit) => Promise<{ ok: boolean; status: number }>;

type AuthSessionRequestInit = {
  method: "POST";
  headers: Record<string, string>;
  credentials: RequestCredentials;
  body: string;
};

export type FuraConnection = {
  connect(): void;
  disconnect(): void;
  isOpen(): boolean;
  send(message: ClientMessage): boolean;
};

export type WebSocketAuth =
  | { type: "sessionCookie"; token: string };

type FuraConnectionOptions = {
  auth: WebSocketAuth;
  locationHref?: string;
  WebSocketCtor?: WebSocketConstructor;
  fetchImpl?: FetchLike;
  onStatus(status: ConnectionStatus, label: string): void;
  onOpen?(): void;
  onClose?(): void;
  onMessage(message: ServerMessage): void;
  onLog(message: string): void;
};

const OPEN_READY_STATE = 1;

export function buildWebSocketUrl(locationHref: string): string {
  const wsUrl = new URL("/ws", locationHref);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return wsUrl.toString();
}

export function buildAuthSessionUrl(locationHref: string): string {
  return new URL("/auth/session", locationHref).toString();
}

export async function establishAuthSession(locationHref: string, auth: WebSocketAuth, fetchImpl: FetchLike): Promise<boolean> {
  switch (auth.type) {
    case "sessionCookie": {
      const response = await fetchImpl(buildAuthSessionUrl(locationHref), {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token: auth.token }),
      });
      return response.ok;
    }
  }
}

export function createFuraConnection(options: FuraConnectionOptions): FuraConnection {
  const WebSocketCtor = options.WebSocketCtor ?? WebSocket;
  const fetchImpl = options.fetchImpl ?? fetch;
  const locationHref = options.locationHref ?? window.location.href;
  let socket: WebSocketLike | null = null;
  let connectionGeneration = 0;

  async function connectWithAuth(generation: number): Promise<void> {
    try {
      const authenticated = await establishAuthSession(locationHref, options.auth, fetchImpl);
      if (generation !== connectionGeneration) return;
      if (!authenticated) {
        options.onStatus("disconnected", "disconnected");
        options.onLog("Authentication failed. Check the token and bridge server.");
        return;
      }

      socket = new WebSocketCtor(buildWebSocketUrl(locationHref));
      socket.addEventListener("open", () => {
        options.onStatus("connected", "connected");
        options.onOpen?.();
      });
      socket.addEventListener("close", () => {
        options.onStatus("disconnected", "disconnected");
        options.onClose?.();
      });
      socket.addEventListener("error", () => {
        options.onLog("WebSocket error. Check the token and bridge server.");
      });
      socket.addEventListener("message", event => {
        if (typeof event.data !== "string") {
          options.onLog("Ignored non-text WebSocket frame.");
          return;
        }
        const message = JSON.parse(event.data) as ServerMessage;
        options.onMessage(message);
      });
    } catch (error) {
      if (generation !== connectionGeneration) return;
      options.onStatus("disconnected", "disconnected");
      options.onLog(error instanceof Error ? `Authentication failed: ${error.message}` : "Authentication failed.");
    }
  }

  return {
    connect() {
      connectionGeneration += 1;
      const generation = connectionGeneration;
      socket?.close();
      socket = null;
      options.onStatus("connecting", "connecting");
      void connectWithAuth(generation);
    },
    disconnect() {
      connectionGeneration += 1;
      socket?.close();
      socket = null;
    },
    isOpen(): boolean {
      return socket?.readyState === OPEN_READY_STATE;
    },
    send(message: ClientMessage): boolean {
      if (!socket || socket.readyState !== OPEN_READY_STATE) {
        options.onLog("Not connected.");
        return false;
      }
      socket.send(JSON.stringify(message));
      return true;
    },
  };
}
