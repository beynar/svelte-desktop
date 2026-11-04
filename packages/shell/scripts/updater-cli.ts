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
 *   bun scripts/updater-cli.ts merge <manifest.json>... (--key <file> | --key-env VAR) --out update.json
 *        [--notes <text> | --notes-file <file>] [--minimum-version <x.y.z>]
 *        one release built on several machines (one manifest each, signed or not) → one signed update.json
 *   bun scripts/updater-cli.ts fetch-previous <update.json URL> --platform <os-arch> [--platform ...]
 *        [--dir .desktop/dist/release] [--public-key <base64>]
 *        the published release's archives into <dir>/<version>/, so the next build makes delta patches
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

async function merge(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			key: { type: "string" },
			"key-env": { type: "string" },
			out: { type: "string" },
			notes: { type: "string" },
			"notes-file": { type: "string" },
			"minimum-version": { type: "string" },
		},
	});
	if (!positionals.length) throw new CliError("merge: pass the manifests of every platform (release/update.json or update.unsigned.json)");
	const key = await loadPrivateKey(values);
	const parts = await Promise.all(positionals.map(async (f) => ({ file: f, m: (await Bun.file(f).json()) as UpdateManifest & { signature?: string } })));
	const first = parts[0]!.m;
	for (const { file, m } of parts)
		if (m.name !== first.name || m.version !== first.version || m.channel !== first.channel)
			throw new CliError(`merge: ${file} is ${m.name} ${m.version} (${m.channel}), ${parts[0]!.file} is ${first.name} ${first.version} (${first.channel})`);
	const notes = values["notes-file"] ? await Bun.file(values["notes-file"]).text() : (values.notes ?? parts.find((p) => p.m.notes)?.m.notes);
	const minimumVersion = values["minimum-version"] ?? parts.find((p) => p.m.minimumVersion)?.m.minimumVersion;
	const patches: Record<string, unknown> = Object.assign({}, ...parts.map((p) => (p.m.patches as Record<string, unknown> | undefined) ?? {}));
	const merged = {
		name: first.name,
		version: first.version,
		channel: first.channel,
		releasedAt: parts.map((p) => p.m.releasedAt).sort().at(-1)!,
		...(notes !== undefined ? { notes } : {}),
		...(minimumVersion ? { minimumVersion } : {}),
		artifacts: Object.assign({}, ...parts.map((p) => p.m.artifacts)),
		...(Object.keys(patches).length ? { patches } : {}),
	};
	validateManifest(merged, { unsigned: true });
	await writeJson(values.out, await signManifest(merged, key));
	console.error(`merged ${parts.length} manifest(s) → ${values.out ?? "stdout"} (${merged.name} ${merged.version}, ${merged.channel}): ${Object.keys(merged.artifacts).join(", ")}`);
}

async function fetchPrevious(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { platform: { type: "string", multiple: true }, dir: { type: "string", default: ".desktop/dist/release" }, "public-key": { type: "string", multiple: true } },
	});
	const url = positionals[0];
	if (!url) throw new CliError("fetch-previous: missing <update.json URL>");
	if (!values.platform?.length) throw new CliError(`fetch-previous: --platform <os-arch> is required (${PLATFORM_KEYS.join(", ")})`);
	const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
	// Nothing published yet (the first release): nothing to make a patch from.
	if (res.status === 404 || res.status === 403) return void console.error(`no published release at ${url} (${res.status}): first release, no delta patch`);
	if (!res.ok) throw new CliError(`fetch-previous: ${url} answered ${res.status}`);
	const text = await res.text();
	const m = values["public-key"]?.length ? await parseSignedManifest(text, values["public-key"]) : (JSON.parse(text) as UpdateManifest);
	const seen = new Set<string>();
	for (const platform of values.platform) {
		const artifact = m.artifacts[platform as PlatformKey];
		if (!artifact) {
			console.error(`${m.version} has no ${platform} archive: no delta patch for it`);
			continue;
		}
		const from = new URL(artifact.url, url).href;
		if (seen.has(from)) continue;
		seen.add(from);
		const out = `${values.dir}/${m.version}/${decodeURIComponent(basename(new URL(from).pathname))}`;
		const r = await fetch(from);
		if (!r.ok) throw new CliError(`fetch-previous: ${from} answered ${r.status}`);
		await Bun.write(out, r);
		if ((await sha256File(out)) !== artifact.sha256 || Bun.file(out).size !== artifact.size) throw new CliError(`fetch-previous: ${out} doesn't match the manifest (sha256 or size)`);
		console.error(`${platform}: ${m.version} → ${out}`);
	}
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
	merge,
	"fetch-previous": fetchPrevious,
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
