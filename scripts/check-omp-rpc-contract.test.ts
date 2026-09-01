import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRpcContract, runRpcContractCheckCli } from "./check-omp-rpc-contract";

const temporaryRoots: string[] = [];

interface FixtureTree {
	root: string;
	ompRoot: string;
	sourceDir: string;
	fixtureDir: string;
}

async function createFixtureTree(): Promise<FixtureTree> {
	const root = await mkdtemp(join(tmpdir(), "fura-rpc-contract-"));
	temporaryRoots.push(root);
	const ompRoot = join(root, "omp");
	const sourceDir = join(
		ompRoot,
		"packages",
		"coding-agent",
		"test",
		"fixtures",
		"rpc-contract",
		"generated",
	);
	const fixtureDir = join(root, "fura-fixtures");
	await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(fixtureDir, { recursive: true })]);
	const manifest = [{ name: "ready", category: "lifecycle", file: "ready.json" }];
	const frame = { type: "ready", protocolVersion: 1 };
	for (const directory of [sourceDir, fixtureDir]) {
		await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		await writeFile(join(directory, "ready.json"), `${JSON.stringify(frame, null, 2)}\n`);
	}
	return { root, ompRoot, sourceDir, fixtureDir };
}

async function snapshotTree(directory: string): Promise<Array<{ file: string; bytes: string; mtimeMs: number }>> {
	const files = (await readdir(directory)).sort();
	return Promise.all(
		files.map(async file => ({
			file,
			bytes: (await readFile(join(directory, file))).toString("base64"),
			mtimeMs: (await stat(join(directory, file))).mtimeMs,
		})),
	);
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("OMP RPC contract parity checker", () => {
	test("reports exact byte parity without modifying either tree", async () => {
		const tree = await createFixtureTree();
		const before = await Promise.all([snapshotTree(tree.sourceDir), snapshotTree(tree.fixtureDir)]);

		const result = await compareRpcContract(tree.ompRoot, { fixtureDir: tree.fixtureDir });

		expect(result).toEqual({
			exitCode: 0,
			summary: "RPC contract parity: 2 JSON files match.",
			differences: [],
			errors: [],
		});
		expect(await Promise.all([snapshotTree(tree.sourceDir), snapshotTree(tree.fixtureDir)])).toEqual(before);
	});

	test("reports byte differences deterministically", async () => {
		const tree = await createFixtureTree();
		await writeFile(join(tree.fixtureDir, "ready.json"), '{"type":"ready"}\n');

		const result = await compareRpcContract(tree.ompRoot, { fixtureDir: tree.fixtureDir });

		expect(result.exitCode).toBe(1);
		expect(result.differences).toEqual(["different bytes: ready.json"]);
	});

	test("reports missing committed files", async () => {
		const tree = await createFixtureTree();
		await rm(join(tree.fixtureDir, "ready.json"));

		const result = await compareRpcContract(tree.ompRoot, { fixtureDir: tree.fixtureDir });

		expect(result.exitCode).toBe(1);
		expect(result.differences).toEqual([
			"Fura manifest references missing file: ready.json",
			"missing in Fura: ready.json",
		]);
	});

	test("reports stale extra files", async () => {
		const tree = await createFixtureTree();
		await writeFile(join(tree.fixtureDir, "stale.json"), "{}\n");

		const result = await compareRpcContract(tree.ompRoot, { fixtureDir: tree.fixtureDir });

		expect(result.exitCode).toBe(1);
		expect(result.differences).toEqual(["extra in Fura: stale.json"]);
	});

	test("rejects malformed manifests", async () => {
		const tree = await createFixtureTree();
		await writeFile(join(tree.fixtureDir, "manifest.json"), "{not-json}\n");

		const result = await compareRpcContract(tree.ompRoot, { fixtureDir: tree.fixtureDir });

		expect(result.exitCode).toBe(2);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Fura manifest is unreadable or malformed");
	});

	test("rejects duplicate manifest names and files", async () => {
		const tree = await createFixtureTree();
		const duplicateManifest = [
			{ name: "ready", category: "lifecycle", file: "ready.json" },
			{ name: "ready", category: "event", file: "ready.json" },
		];
		await writeFile(join(tree.fixtureDir, "manifest.json"), `${JSON.stringify(duplicateManifest, null, 2)}\n`);

		const result = await compareRpcContract(tree.ompRoot, { fixtureDir: tree.fixtureDir });

		expect(result.exitCode).toBe(2);
		expect(result.errors).toEqual([
			"Fura manifest has duplicate file: ready.json",
			"Fura manifest has duplicate name: ready",
		]);
	});

	test("rejects more than one CLI argument and exits with code 2", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const exitCode = await runRpcContractCheckCli(["first", "second"], {
			stdout: line => stdout.push(line),
			stderr: line => stderr.push(line),
		});

		expect(exitCode).toBe(2);
		expect(stdout).toEqual([]);
		expect(stderr).toEqual(["Usage: bun scripts/check-omp-rpc-contract.ts [OMP_ROOT]"]);
	});
});
