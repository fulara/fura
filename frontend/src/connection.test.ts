import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthSessionUrl,
  buildWebSocketUrl,
  createFuraConnection,
  establishAuthSession,
  type FetchLike,
  type WebSocketLike,
} from "./connection";

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

function okFetch(calls: Array<{ input: string | URL; init?: Parameters<FetchLike>[1] }> = []): FetchLike {
  return async (input, init) => {
    calls.push({ input, init });
    return { ok: true, status: 204 };
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("auth and WebSocket URLs", () => {
  it("builds auth session URLs from the current page origin", () => {
    expect(buildAuthSessionUrl("http://127.0.0.1:3737/app?token=dev")).toBe("http://127.0.0.1:3737/auth/session");
  });

  it("builds WebSocket URLs without putting tokens in the URL", () => {
    expect(buildWebSocketUrl("http://127.0.0.1:3737/?token=dev")).toBe("ws://127.0.0.1:3737/ws");
    expect(buildWebSocketUrl("https://fura.example/app?token=secret")).toBe("wss://fura.example/ws");
  });

  it("establishes an HttpOnly cookie session before WebSocket connection", async () => {
    const calls: Array<{ input: string | URL; init?: Parameters<FetchLike>[1] }> = [];

    await expect(establishAuthSession(
      "http://localhost:3737/?token=dev",
      { type: "sessionCookie", token: "dev" },
      okFetch(calls),
    )).resolves.toBe(true);

    expect(calls).toEqual([{
      input: "http://localhost:3737/auth/session",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token: "dev" }),
      },
    }]);
  });
});

describe("createFuraConnection", () => {
  it("authenticates, reports status changes, and automatically reconnects after close", async () => {
    vi.useFakeTimers();
    resetFakeWebSockets();
    const statuses: string[] = [];
    const logs: string[] = [];
    const fetchCalls: Array<{ input: string | URL; init?: Parameters<FetchLike>[1] }> = [];
    const connection = createFuraConnection({
      auth: { type: "sessionCookie", token: "dev" },
      locationHref: "http://localhost:3737/?token=dev",
      WebSocketCtor: FakeWebSocket,
      fetchImpl: okFetch(fetchCalls),
      onStatus: status => statuses.push(status),
      onOpen: () => connection.send({ type: "session.list" }),
      onClose: () => logs.push("closed"),
      onMessage: () => {},
      onLog: message => logs.push(message),
    });

    connection.connect();
    await flushPromises();
    const socket = FakeWebSocket.instances[0];
    socket.emit("open");
    socket.emit("close");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    const reconnectSocket = FakeWebSocket.instances[1];
    reconnectSocket.emit("open");

    expect(fetchCalls.map(call => call.input)).toEqual([
      "http://localhost:3737/auth/session",
      "http://localhost:3737/auth/session",
    ]);
    expect(socket.url).toBe("ws://localhost:3737/ws");
    expect(reconnectSocket.url).toBe("ws://localhost:3737/ws");
    expect(statuses).toEqual([
      "connecting",
      "connected",
      "reconnecting in 500ms",
      "connecting",
      "connected",
    ]);
    expect(socket.sent).toEqual([JSON.stringify({ type: "session.list" })]);
    expect(reconnectSocket.sent).toEqual([JSON.stringify({ type: "session.list" })]);
    expect(logs).toEqual(["closed"]);
    connection.disconnect();
  });

  it("does not open a WebSocket when authentication fails", async () => {
    resetFakeWebSockets();
    const statuses: string[] = [];
    const logs: string[] = [];
    const authFailures: string[] = [];
    const connection = createFuraConnection({
      auth: { type: "sessionCookie", token: "bad" },
      locationHref: "http://localhost:3737/",
      WebSocketCtor: FakeWebSocket,
      fetchImpl: async () => ({ ok: false, status: 401 }),
      onStatus: status => statuses.push(status),
      onMessage: () => {},
      onLog: message => logs.push(message),
      onAuthFailure: message => authFailures.push(message),
    });

    connection.connect();
    await flushPromises();

    expect(FakeWebSocket.instances).toEqual([]);
    expect(statuses).toEqual(["connecting", "disconnected"]);
    expect(logs).toEqual(["Authentication failed. Check the token and bridge server."]);
    expect(authFailures).toEqual(["Authentication failed. Check the token and bridge server."]);
  });

  it("routes text messages and ignores non-text frames", async () => {
    resetFakeWebSockets();
    const logs: string[] = [];
    const received: string[] = [];
    const connection = createFuraConnection({
      auth: { type: "sessionCookie", token: "dev" },
      locationHref: "http://localhost:3737/",
      WebSocketCtor: FakeWebSocket,
      fetchImpl: okFetch(),
      onStatus: () => {},
      onMessage: message => received.push(message.type),
      onLog: message => logs.push(message),
    });

    connection.connect();
    await flushPromises();
    const socket = FakeWebSocket.instances[0];
    socket.emitMessage(JSON.stringify({ type: "sessions.snapshot", sessions: [] }));
    socket.emitMessage(new Uint8Array());

    expect(received).toEqual(["sessions.snapshot"]);
    expect(logs).toEqual(["Ignored non-text WebSocket frame."]);
  });

  it("does not send before the socket is open", async () => {
    resetFakeWebSockets();
    const logs: string[] = [];
    const connection = createFuraConnection({
      auth: { type: "sessionCookie", token: "dev" },
      locationHref: "http://localhost:3737/",
      WebSocketCtor: FakeWebSocket,
      fetchImpl: okFetch(),
      onStatus: () => {},
      onMessage: () => {},
      onLog: message => logs.push(message),
    });

    connection.connect();
    await flushPromises();

    expect(connection.send({ type: "session.list" })).toBe(false);
    expect(FakeWebSocket.instances[0].sent).toEqual([]);
    expect(logs).toEqual(["Not connected."]);
  });
});
