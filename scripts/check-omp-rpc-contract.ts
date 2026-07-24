import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "Usage: bun scripts/check-omp-rpc-contract.ts <OMP_ROOT>";
const DEFAULT_FURA_FIXTURE_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"omp-rpc-contract",
);

interface ContractDirectory {
	files: string[];
	manifestFiles: Set<string>;
}

export interface RpcContractCheckResult {
	exitCode: 0 | 1 | 2;
	summary: string;
	differences: string[];
	errors: string[];
}

export interface RpcContractCheckOptions {
	fixtureDir?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inspectContractDirectory(label: string, directory: string): Promise<{
	contract?: ContractDirectory;
	errors: string[];
}> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		return { errors: [`${label} directory is unreadable: ${directory}: ${errorMessage(error)}`] };
	}

	const files = entries
		.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
		.map(entry => entry.name)
		.sort();
	const manifestPath = join(directory, "manifest.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch (error) {
		return { errors: [`${label} manifest is unreadable or malformed: ${manifestPath}: ${errorMessage(error)}`] };
	}

	if (!Array.isArray(parsed)) {
		return { errors: [`${label} manifest must be an array: ${manifestPath}`] };
	}

	const errors: string[] = [];
	const names = new Set<string>();
	const manifestFiles = new Set<string>();
	for (const [index, value] of parsed.entries()) {
		const prefix = `${label} manifest entry ${index}`;
		if (!isRecord(value)) {
			errors.push(`${prefix} must be an object`);
			continue;
		}
		const { name, category, file } = value;
		if (typeof name !== "string" || name.length === 0) errors.push(`${prefix} has an invalid name`);
		if (typeof category !== "string" || category.length === 0) errors.push(`${prefix} has an invalid category`);
		if (
			typeof file !== "string" ||
			file.length === 0 ||
			basename(file) !== file ||
			!file.endsWith(".json") ||
			file === "manifest.json"
		) {
			errors.push(`${prefix} has an invalid file`);
		}
		if (typeof name === "string" && name.length > 0) {
			if (names.has(name)) errors.push(`${label} manifest has duplicate name: ${name}`);
			names.add(name);
		}
		if (
			typeof file === "string" &&
			file.length > 0 &&
			basename(file) === file &&
			file.endsWith(".json") &&
			file !== "manifest.json"
		) {
			if (manifestFiles.has(file)) errors.push(`${label} manifest has duplicate file: ${file}`);
			manifestFiles.add(file);
		}
	}

	if (errors.length > 0) return { errors: errors.sort() };
	return { contract: { files, manifestFiles }, errors: [] };
}

export async function compareRpcContract(
	ompRoot: string,
	options: RpcContractCheckOptions = {},
): Promise<RpcContractCheckResult> {
	const sourceDir = resolve(
		ompRoot,
		"packages",
		"coding-agent",
		"test",
		"fixtures",
		"rpc-contract",
		"generated",
	);
	const fixtureDir = resolve(options.fixtureDir ?? DEFAULT_FURA_FIXTURE_DIR);
	const [source, fura] = await Promise.all([
		inspectContractDirectory("OMP", sourceDir),
		inspectContractDirectory("Fura", fixtureDir),
	]);
	const errors = [...source.errors, ...fura.errors].sort();
	if (!source.contract || !fura.contract || errors.length > 0) {
		return {
			exitCode: 2,
			summary: `RPC contract check failed: ${errors.length} error(s).`,
			differences: [],
			errors,
		};
	}

	const differences: string[] = [];
	for (const file of source.contract.manifestFiles) {
		if (!source.contract.files.includes(file)) differences.push(`OMP manifest references missing file: ${file}`);
	}
	for (const file of fura.contract.manifestFiles) {
		if (!fura.contract.files.includes(file)) differences.push(`Fura manifest references missing file: ${file}`);
	}

	const allFiles = [...new Set([...source.contract.files, ...fura.contract.files])].sort();
	for (const file of allFiles) {
		const inSource = source.contract.files.includes(file);
		const inFura = fura.contract.files.includes(file);
		if (!inSource) {
			differences.push(`extra in Fura: ${file}`);
			continue;
		}
		if (!inFura) {
			differences.push(`missing in Fura: ${file}`);
			continue;
		}
		try {
			const [sourceBytes, furaBytes] = await Promise.all([
				readFile(join(sourceDir, file)),
				readFile(join(fixtureDir, file)),
			]);
			if (!sourceBytes.equals(furaBytes)) differences.push(`different bytes: ${file}`);
		} catch (error) {
			errors.push(`Unable to compare ${file}: ${errorMessage(error)}`);
		}
	}

	errors.sort();
	differences.sort();
	if (errors.length > 0) {
		return {
			exitCode: 2,
			summary: `RPC contract check failed: ${errors.length} error(s).`,
			differences,
			errors,
		};
	}
	if (differences.length > 0) {
		return {
			exitCode: 1,
			summary: `RPC contract drift: ${differences.length} difference(s).`,
			differences,
			errors: [],
		};
	}
	return {
		exitCode: 0,
		summary: `RPC contract parity: ${allFiles.length} JSON files match.`,
		differences: [],
		errors: [],
	};
}

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	if (args.length !== 1) {
		console.error(USAGE);
		process.exit(2);
	}
	const result = await compareRpcContract(args[0]);
	for (const error of result.errors) console.error(error);
	for (const difference of result.differences) console.error(difference);
	const output = result.exitCode === 0 ? console.log : console.error;
	output(result.summary);
	process.exit(result.exitCode);
}

if (import.meta.main) await main();
