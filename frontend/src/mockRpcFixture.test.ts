import { afterEach, describe, expect, it } from "vitest";

type RpcChild = {
  stdin: { write(chunk: string): void };
  stdout: { on(event: "data", callback: (chunk: { toString(encoding: string): string }) => void): void };
  kill(): void;
};

type RpcFrame = {
  id?: string;
  success?: boolean;
  data?: any;
};

let child: RpcChild | null = null;

afterEach(() => {
  child?.kill();
  child = null;
});

describe("mock OMP RPC fixture", () => {
  it("returns repo-diff snapshots with the current OMP snapshot fields", async () => {
    child = await spawnFixture();
    const frames = createFrameReader(child);

    child.stdin.write(`${JSON.stringify({ id: "diff-get", type: "repo_diff_get" })}\n`);
    const getResponse = await frames.next("diff-get");
    expect(getResponse.success).toBe(true);
    expectSnapshotShape(getResponse.data.selectedSnapshot);
    expect(getResponse.data.snapshots).toHaveLength(1);
    expectSnapshotShape(getResponse.data.snapshots[0]);

    child.stdin.write(`${JSON.stringify({ id: "snapshot", type: "repo_diff_snapshot", label: "manual-check" })}\n`);
    const snapshotResponse = await frames.next("snapshot");
    expect(snapshotResponse.success).toBe(true);
    expectSnapshotShape(snapshotResponse.data.selectedSnapshot);
    expect(snapshotResponse.data.selectedSnapshot.label).toBe("manual-check");
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
  };
}

function expectSnapshotShape(snapshot: any): void {
  expect(snapshot).toMatchObject({
    entryId: expect.any(String),
    label: expect.any(String),
    kind: expect.any(String),
    createdAt: expect.any(String),
    repoRoot: expect.any(String),
    ref: expect.any(String),
    commit: expect.stringMatching(/^[0-9a-f]{40}$/),
    headCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
  });
  expect(snapshot).not.toHaveProperty("tree");
}
