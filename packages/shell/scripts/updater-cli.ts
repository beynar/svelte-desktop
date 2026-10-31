#!/usr/bin/env bun
/**
 * Publishing CLI for the svelte-desktop updater.
 *
 *   bun scripts/updater-cli.ts keygen [--out updater.key] [--force]
 *   bun scripts/updater-cli.ts sign <manifest.json> (--key <file> | --key-env VAR) [--out <file>]
 *   bun scripts/updater-cli.ts verify <manifest.json> --public-key <base64>
 *   bun scripts/updater-cli.ts pack <path>... --out <archive.tar.zst|.tar.gz>
 *   bun scripts/updater-cli.ts make-manifest --name <app> --version <x.y.z> --channel <ch>
 *        --artifact <os-arch>=<archive> [--artifact ...] [--base-url <url>]
 *        (--key <file> | --key-env VAR) [--notes <text> | --notes-file <file>]
 *        [--minimum-version <x.y.z>] [--released-at <iso>] [--out update.json]
 */
import { chmod } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { generateKeyPair, privateKeyFromText, privateKeyToPem, publicKeyFromPrivate, toBase64 } from "../src/updater/crypto.ts";
import { sha256File } from "../src/updater/download.ts";
import { createArchive, formatFromPath } from "../src/updater/archive.ts";
import {
	PLATFORM_KEYS,
	parseSignedManifest,
	signManifest,
	validateManifest,
	type Artifact,
	type PlatformKey,
	type UpdateManifest,
} from "../src/updater/manifest.ts";

const USAGE = (await Bun.file(import.meta.path).text()).match(/\/\*\*([\s\S]*?)\*\//)![1]!.replace(/^ \* ?/gm, "");

class CliError extends Error {}

async function loadPrivateKey(values: { key?: string; "key-env"?: string }): Promise<Uint8Array> {
	let text: string | undefined;
	if (values.key) {
		const f = Bun.file(values.key);
		if (!(await f.exists())) throw new CliError(`key file not found: ${values.key}`);
		text = await f.text();
	} else if (values["key-env"]) {
		text = process.env[values["key-env"]];
		if (!text) throw new CliError(`environment variable ${values["key-env"]} is empty`);
	} else {
		throw new CliError("--key <file> or --key-env <VAR> is required");
	}
	try {
		return privateKeyFromText(text);
	} catch (err) {
		throw new CliError(`invalid private key: ${(err as Error).message}`);
	}
}

async function writeJson(path: string | undefined, value: unknown): Promise<void> {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (path) await Bun.write(path, text);
	else process.stdout.write(text);
}

async function keygen(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { out: { type: "string", default: "updater.key" }, force: { type: "boolean" } } });
	const out = values.out!;
	if ((await Bun.file(out).exists()) && !values.force) throw new CliError(`${out} exists; pass --force to overwrite`);
	const { privateKey, publicKey } = await generateKeyPair();
	await Bun.write(out, privateKeyToPem(privateKey));
	await chmod(out, 0o600);
	const pub = toBase64(publicKey);
	await Bun.write(`${out}.pub`, `${pub}\n`);
	console.error(`private key written to ${out} (keep it secret, e.g. in your CI secret store)`);
	console.error(`public key written to ${out}.pub; embed it in the app as publicKey:`);
	console.log(pub);
}

async function sign(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { key: { type: "string" }, "key-env": { type: "string" }, out: { type: "string" } },
	});
	const file = positionals[0];
	if (!file) throw new CliError("sign: missing <manifest.json>");
	const key = await loadPrivateKey(values);
	const manifest = (await Bun.file(file).json()) as UpdateManifest;
	const signed = await signManifest(manifest, key);
	await writeJson(values.out ?? file, signed);
	console.error(`signed ${values.out ?? file} (${manifest.name} ${manifest.version}, ${manifest.channel})`);
}

async function verifyCmd(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "public-key": { type: "string", multiple: true } } });
	if (!positionals[0]) throw new CliError("verify: missing <manifest.json>");
	if (!values["public-key"]?.length) throw new CliError("verify: --public-key <base64> is required");
	const m = await parseSignedManifest(await Bun.file(positionals[0]).text(), values["public-key"]);
	console.log(`OK: ${m.name} ${m.version} (${m.channel}), artifacts: ${Object.keys(m.artifacts).join(", ")}`);
}

async function pack(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { out: { type: "string" } } });
	if (!values.out) throw new CliError("pack: --out <file.tar.zst|file.tar.gz> is required");
	if (positionals.length === 0) throw new CliError("pack: nothing to pack");
	const format = formatFromPath(values.out);
	if (!format) throw new CliError("pack: --out must end in .tar.zst or .tar.gz");
	await createArchive(positionals, values.out, format);
	console.error(`packed ${positionals.map((p) => basename(p)).join(", ")} -> ${values.out}`);
}

async function makeManifest(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			name: { type: "string" },
			version: { type: "string" },
			channel: { type: "string", default: "stable" },
			artifact: { type: "string", multiple: true },
			"base-url": { type: "string" },
			key: { type: "string" },
			"key-env": { type: "string" },
			notes: { type: "string" },
			"notes-file": { type: "string" },
			"minimum-version": { type: "string" },
			"released-at": { type: "string" },
			out: { type: "string" },
		},
	});
	if (!values.name) throw new CliError("make-manifest: --name is required");
	if (!values.version) throw new CliError("make-manifest: --version is required");
	if (!values.artifact?.length) throw new CliError("make-manifest: at least one --artifact <os-arch>=<path> is required");
	const key = await loadPrivateKey(values);

	const artifacts: Partial<Record<PlatformKey, Artifact>> = {};
	for (const spec of values.artifact) {
		const eq = spec.indexOf("=");
		const platformKey = spec.slice(0, eq) as PlatformKey;
		const path = spec.slice(eq + 1);
		if (eq < 0 || !PLATFORM_KEYS.includes(platformKey)) {
			throw new CliError(`bad --artifact ${spec}; expected <os-arch>=<path> with os-arch in ${PLATFORM_KEYS.join(", ")}`);
		}
		const format = formatFromPath(path);
		if (!format) throw new CliError(`${path}: archive must end in .tar.zst or .tar.gz`);
		const file = Bun.file(path);
		if (!(await file.exists())) throw new CliError(`${path}: not found`);
		const name = encodeURIComponent(basename(path));
		const base = values["base-url"];
		artifacts[platformKey] = {
			url: base ? `${base.replace(/\/+$/, "")}/${name}` : name,
			sha256: await sha256File(path),
			size: file.size,
			format,
		};
	}
	const notes = values["notes-file"] ? await Bun.file(values["notes-file"]).text() : values.notes;
	const unsigned = {
		name: values.name,
		version: values.version,
		channel: values.channel!,
		releasedAt: values["released-at"] ?? new Date().toISOString(),
		...(notes !== undefined ? { notes } : {}),
		...(values["minimum-version"] ? { minimumVersion: values["minimum-version"] } : {}),
		artifacts,
	};
	validateManifest(unsigned, { unsigned: true });
	const signed = await signManifest(unsigned, key);
	await writeJson(values.out, signed);
	if (values.out) console.error(`wrote signed manifest ${values.out}`);
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
	keygen,
	sign,
	verify: verifyCmd,
	pack,
	"make-manifest": makeManifest,
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
	console.log(USAGE.trim());
	process.exit(cmd ? 0 : 1);
}
const run = commands[cmd];
if (!run) {
	console.error(`unknown command ${cmd}\n\n${USAGE.trim()}`);
	process.exit(1);
}
try {
	await run(rest);
} catch (err) {
	console.error(`error: ${(err as Error).message}`);
	process.exit(1);
}
