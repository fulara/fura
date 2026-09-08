import { afterEach, describe, expect, it } from "vitest";

type RpcChild = {
  stdin: { write(chunk: string): void };
  stdout: { on(event: "data", callback: (chunk: { toString(encoding: string): string }) => void): void };
  kill(): void;
};

type RpcMessage = {
  role?: string;
  entryId?: string;
  content?: Array<{ type?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};


type RpcFrame = {
  id?: string;
  success?: boolean;
  type?: string;
  command?: string;
  data: {
    messages: RpcMessage[];
    sessionId: string;
    sessionFile: string;
    [key: string]: unknown;
  };
};

let child: RpcChild | null = null;

afterEach(() => {
  child?.kill();
  child = null;
});

describe("mock OMP RPC fixture", () => {

  it("lists branchable prompts and branches without starting an agent turn", async () => {
    child = await spawnFixture();
    const frames = createFrameReader(child);
    const textImages = [
      { type: "image", data: "png-one", mimeType: "image/png", detail: "high" },
      { type: "image", data: "webp-two", mimeType: "image/webp", providerFile: "mock://two.webp" },
    ];
    const imageOnly = {
      type: "image",
      data: "png-image-only",
      mimeType: "image/png",
      url: "mock://image-only.png",
    };

    child.stdin.write(`${JSON.stringify({ id: "state-before", type: "get_state" })}\n`);
    const stateBefore = await frames.next("state-before");

    child.stdin.write(`${JSON.stringify({ id: "prompt-text", type: "prompt", message: "kept prompt" })}\n`);
    expect((await frames.next("prompt-text")).success).toBe(true);
    child.stdin.write(`${JSON.stringify({
      id: "prompt-images",
      type: "prompt",
      message: "rollback target",
      images: textImages,
    })}\n`);
    expect((await frames.next("prompt-images")).success).toBe(true);
    child.stdin.write(`${JSON.stringify({
      id: "prompt-image-only",
      type: "prompt",
      message: "",
      images: [imageOnly],
    })}\n`);
    expect((await frames.next("prompt-image-only")).success).toBe(true);

    child.stdin.write(`${JSON.stringify({ id: "messages-before", type: "get_messages" })}\n`);
    const messagesBefore = await frames.next("messages-before");
    const userMessages = messagesBefore.data.messages.filter(message => message.role === "user");
    expect(userMessages.map(message => message.entryId)).toEqual([
      "mock-user-entry-1",
      "mock-user-entry-2",
      "mock-user-entry-3",
    ]);
    expect(userMessages[1].content?.filter(item => item.type === "image")).toEqual(textImages);

    child.stdin.write(`${JSON.stringify({ id: "branch-points-1", type: "get_branch_messages" })}\n`);
    const branchPoints = await frames.next("branch-points-1");
    expect(branchPoints.data.messages).toEqual([
      { entryId: "mock-user-entry-1", text: "kept prompt", imageCount: 0 },
      { entryId: "mock-user-entry-2", text: "rollback target", imageCount: 2 },
      { entryId: "mock-user-entry-3", text: "", imageCount: 1 },
    ]);
    child.stdin.write(`${JSON.stringify({ id: "branch-points-2", type: "get_branch_messages" })}\n`);
    expect((await frames.next("branch-points-2")).data.messages).toEqual(branchPoints.data.messages);

    frames.takeUnmatched();
    child.stdin.write(`${JSON.stringify({
      id: "branch-select",
      type: "branch",
      entryId: "mock-user-entry-2",
    })}\n`);
    expect(await frames.next("branch-select")).toMatchObject({
      success: true,
      data: { text: "rollback target", images: textImages, cancelled: false },
    });
    child.stdin.write(`${JSON.stringify({ id: "state-after", type: "get_state" })}\n`);
    const stateAfter = await frames.next("state-after");
    expect(stateAfter.data.sessionId).not.toBe(stateBefore.data.sessionId);
    expect(stateAfter.data.sessionFile).not.toBe(stateBefore.data.sessionFile);

    child.stdin.write(`${JSON.stringify({ id: "messages-after", type: "get_messages" })}\n`);
    const messagesAfter = await frames.next("messages-after");
    const selectedIndex = messagesBefore.data.messages.findIndex(
      message => message.entryId === "mock-user-entry-2",
    );
    expect(messagesAfter.data.messages).toEqual(messagesBefore.data.messages.slice(0, selectedIndex));
    expect(frames.takeUnmatched().map(frame => frame.type)).not.toEqual(
      expect.arrayContaining(["agent_start", "message_end", "agent_end"]),
    );
  });
});

async function spawnFixture(): Promise<RpcChild> {
  // @ts-expect-error Node built-in types are intentionally absent from the browser app tsconfig.
  const { spawn } = await import("node:child_process");
  const nodeProcess = (globalThis as unknown as { process: { cwd(): string; execPath: string } }).process;
  return spawn(nodeProcess.execPath, [`${nodeProcess.cwd()}/../fixtures/mock-omp-rpc.mjs`], {
    stdio: ["pipe", "pipe", "pipe"],
  }) as RpcChild;
}

function createFrameReader(process: RpcChild) {
  const pending: RpcFrame[] = [];
  const waiters = new Map<string, (frame: RpcFrame) => void>();
  let buffered = "";

  process.stdout.on("data", chunk => {
    buffered += chunk.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        const frame = JSON.parse(line) as RpcFrame;
        const frameId = frame.id;
        const waiter = typeof frameId === "string" ? waiters.get(frameId) : undefined;
        if (waiter && typeof frameId === "string") {
          waiters.delete(frameId);
          waiter(frame);
        } else {
          pending.push(frame);
        }
      }
      newline = buffered.indexOf("\n");
    }
  });

  return {
    next(id: string): Promise<RpcFrame> {
      const index = pending.findIndex(frame => frame.id === id);
      if (index >= 0) {
        const [frame] = pending.splice(index, 1);
        return Promise.resolve(frame);
      }
      return new Promise((resolveFrame, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`Timed out waiting for mock RPC frame ${id}`));
        }, 2000);
        waiters.set(id, frame => {
          clearTimeout(timeout);
          resolveFrame(frame);
        });
      });
    },
    takeUnmatched(): RpcFrame[] {
      return pending.splice(0);
    },
  };
}

