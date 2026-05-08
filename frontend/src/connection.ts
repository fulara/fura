import type { ClientMessage, ServerMessage } from "./protocol";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

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

export type FuraClientKind = "desktop" | "mobile";

type FuraConnectionOptions = {
  auth: WebSocketAuth;
  clientKind?: FuraClientKind;
  locationHref?: string;
  WebSocketCtor?: WebSocketConstructor;
  fetchImpl?: FetchLike;
  onStatus(label: string, className: ConnectionStatus): void;
  onOpen?(): void;
  onClose?(): void;
  onAuthFailure?(message: string): void;
  onMessage(message: ServerMessage): void;
  onLog(message: string): void;
  reconnect?: {
    enabled?: boolean;
    delaysMs?: readonly number[];
  };
};

const OPEN_READY_STATE = 1;
const DEFAULT_RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000] as const;

export function buildWebSocketUrl(locationHref: string, clientKind?: FuraClientKind): string {
  const wsUrl = new URL("/ws", locationHref);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  if (clientKind) wsUrl.searchParams.set("client", clientKind);
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
  const reconnectEnabled = options.reconnect?.enabled ?? true;
  const reconnectDelaysMs = normalizedReconnectDelays(options.reconnect?.delaysMs);
  let socket: WebSocketLike | null = null;
  let connectionGeneration = 0;
  let manuallyDisconnected = true;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  async function connectWithAuth(generation: number): Promise<void> {
    try {
      const authenticated = await establishAuthSession(locationHref, options.auth, fetchImpl);
      if (generation !== connectionGeneration || manuallyDisconnected) return;
      if (!authenticated) {
        manuallyDisconnected = true;
        clearReconnectTimer();
        const message = "Authentication failed. Check the token and bridge server.";
        options.onStatus("disconnected", "disconnected");
        options.onLog(message);
        options.onAuthFailure?.(message);
        return;
      }

      const nextSocket = new WebSocketCtor(buildWebSocketUrl(locationHref, options.clientKind));
      socket = nextSocket;
      nextSocket.addEventListener("open", () => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        reconnectAttempts = 0;
        options.onStatus("connected", "connected");
        options.onOpen?.();
      });
      nextSocket.addEventListener("close", () => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        socket = null;
        options.onClose?.();
        scheduleReconnect(generation);
      });
      nextSocket.addEventListener("error", () => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        options.onLog("WebSocket error. Check the token and bridge server.");
      });
      nextSocket.addEventListener("message", event => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        if (typeof event.data !== "string") {
          options.onLog("Ignored non-text WebSocket frame.");
          return;
        }
        const message = JSON.parse(event.data) as ServerMessage;
        options.onMessage(message);
      });
    } catch (error) {
      if (generation !== connectionGeneration || manuallyDisconnected) return;
      const message = error instanceof Error ? `Connection failed: ${error.message}` : "Connection failed.";
      options.onLog(message);
      scheduleReconnect(generation);
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(generation: number): void {
    clearReconnectTimer();
    if (!reconnectEnabled || manuallyDisconnected || generation !== connectionGeneration) {
      options.onStatus("disconnected", "disconnected");
      return;
    }
    const delayMs = reconnectDelaysMs[Math.min(reconnectAttempts, reconnectDelaysMs.length - 1)];
    reconnectAttempts += 1;
    options.onStatus(`reconnecting in ${formatReconnectDelay(delayMs)}`, "reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (generation !== connectionGeneration || manuallyDisconnected) return;
      options.onStatus("connecting", "connecting");
      void connectWithAuth(generation);
    }, delayMs);
  }

  function startConnection(resetBackoff: boolean): void {
    connectionGeneration += 1;
    const generation = connectionGeneration;
    manuallyDisconnected = false;
    if (resetBackoff) reconnectAttempts = 0;
    clearReconnectTimer();
    socket?.close();
    socket = null;
    options.onStatus("connecting", "connecting");
    void connectWithAuth(generation);
  }

  return {
    connect() {
      startConnection(true);
    },
    disconnect() {
      connectionGeneration += 1;
      manuallyDisconnected = true;
      clearReconnectTimer();
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

function normalizedReconnectDelays(delaysMs: readonly number[] | undefined): number[] {
  const delays = (delaysMs?.length ? delaysMs : DEFAULT_RECONNECT_DELAYS_MS)
    .map(delayMs => Math.max(0, Math.trunc(delayMs)))
    .filter(delayMs => Number.isFinite(delayMs));
  return delays.length > 0 ? delays : [...DEFAULT_RECONNECT_DELAYS_MS];
}

function formatReconnectDelay(delayMs: number): string {
  if (delayMs < 1000) return `${delayMs}ms`;
  const seconds = delayMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}
