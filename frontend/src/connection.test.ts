import { describe, expect, it } from "vitest";
import { buildWebSocketUrl, createFuraConnection, type WebSocketLike } from "./connection";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(event: { data: unknown }) => void>> = {};

  constructor(url: string | URL) {
    this.url = url.toString();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data: unknown }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  emit(type: "open" | "close" | "error"): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.listeners[type] ?? []) listener({ data: undefined });
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.message ?? []) listener({ data });
  }
}

function resetFakeWebSockets(): void {
  FakeWebSocket.instances = [];
}

describe("buildWebSocketUrl", () => {
  it("builds legacy query-token ws URLs from http page URLs", () => {
    expect(buildWebSocketUrl(
      "http://127.0.0.1:3737/?token=old",
      { type: "legacyQueryToken", token: "dev token" },
    )).toBe(
      "ws://127.0.0.1:3737/ws?token=dev+token",
    );
  });

  it("builds legacy query-token wss URLs from https page URLs", () => {
    expect(buildWebSocketUrl(
      "https://fura.example/app",
      { type: "legacyQueryToken", token: "secret" },
    )).toBe(
      "wss://fura.example/ws?token=secret",
    );
  });

  it("preserves empty legacy query tokens so callers own empty-token validation", () => {
    expect(buildWebSocketUrl(
      "http://localhost:3737/",
      { type: "legacyQueryToken", token: "" },
    )).toBe(
      "ws://localhost:3737/ws?token=",
    );
  });

  it("drops page path and replaces any page token with the explicit legacy query token", () => {
    expect(buildWebSocketUrl(
      "http://localhost:3737/app/path?token=old&other=ignored",
      { type: "legacyQueryToken", token: "new" },
    )).toBe(
      "ws://localhost:3737/ws?token=new",
    );
  });
});

describe("createFuraConnection", () => {
  it("reports status changes and requests the session list on open", () => {
    resetFakeWebSockets();
    const statuses: string[] = [];
    const logs: string[] = [];
    const connection = createFuraConnection({
      auth: { type: "legacyQueryToken", token: "dev" },
      locationHref: "http://localhost:3737/",
      WebSocketCtor: FakeWebSocket,
      onStatus: status => statuses.push(status),
      onOpen: () => connection.send({ type: "session.list" }),
      onClose: () => logs.push("closed"),
      onMessage: () => {},
      onLog: message => logs.push(message),
    });

    connection.connect();
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("close");

    expect(socket.url).toBe("ws://localhost:3737/ws?token=dev");
    expect(statuses).toEqual(["connecting", "connected", "disconnected"]);
    expect(socket.sent).toEqual([JSON.stringify({ type: "session.list" })]);
    expect(logs).toEqual(["closed"]);
  });

  it("routes text messages and ignores non-text frames", () => {
    resetFakeWebSockets();
    const logs: string[] = [];
    const received: string[] = [];
    const connection = createFuraConnection({
      auth: { type: "legacyQueryToken", token: "dev" },
      locationHref: "http://localhost:3737/",
      WebSocketCtor: FakeWebSocket,
      onStatus: () => {},
      onMessage: message => received.push(message.type),
      onLog: message => logs.push(message),
    });

    connection.connect();
    const socket = FakeWebSocket.instances[0];
    socket.emitMessage(JSON.stringify({ type: "sessions.snapshot", sessions: [] }));
    socket.emitMessage(new Uint8Array());

    expect(received).toEqual(["sessions.snapshot"]);
    expect(logs).toEqual(["Ignored non-text WebSocket frame."]);
  });

  it("does not send before the socket is open", () => {
    resetFakeWebSockets();
    const logs: string[] = [];
    const connection = createFuraConnection({
      auth: { type: "legacyQueryToken", token: "dev" },
      locationHref: "http://localhost:3737/",
      WebSocketCtor: FakeWebSocket,
      onStatus: () => {},
      onMessage: () => {},
      onLog: message => logs.push(message),
    });

    connection.connect();

    expect(connection.send({ type: "session.list" })).toBe(false);
    expect(FakeWebSocket.instances[0].sent).toEqual([]);
    expect(logs).toEqual(["Not connected."]);
  });
});
