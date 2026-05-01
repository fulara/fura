import type { ClientMessage, ServerMessage } from "./protocol";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type WebSocketLike = {
  readonly readyState: number;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
  send(data: string): void;
};

export type WebSocketConstructor = new (url: string | URL) => WebSocketLike;

export type FuraConnection = {
  connect(): void;
  disconnect(): void;
  isOpen(): boolean;
  send(message: ClientMessage): boolean;
};

type FuraConnectionOptions = {
  token: string;
  locationHref?: string;
  WebSocketCtor?: WebSocketConstructor;
  onStatus(status: ConnectionStatus, label: string): void;
  onOpen?(): void;
  onClose?(): void;
  onMessage(message: ServerMessage): void;
  onLog(message: string): void;
};

const OPEN_READY_STATE = 1;

export function buildWebSocketUrl(locationHref: string, token: string): string {
  const wsUrl = new URL("/ws", locationHref);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("token", token);
  return wsUrl.toString();
}

export function createFuraConnection(options: FuraConnectionOptions): FuraConnection {
  const WebSocketCtor = options.WebSocketCtor ?? WebSocket;
  const locationHref = options.locationHref ?? window.location.href;
  let socket: WebSocketLike | null = null;

  return {
    connect() {
      socket?.close();
      options.onStatus("connecting", "connecting");
      socket = new WebSocketCtor(buildWebSocketUrl(locationHref, options.token));
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
    },
    disconnect() {
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
