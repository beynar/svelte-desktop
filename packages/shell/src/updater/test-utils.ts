/** Shared fixtures for the updater tests (not a test file itself). */
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, toBase64 } from "./crypto.ts";
import { createArchive } from "./archive.ts";
import { sha256File } from "./download.ts";
import { signManifest, type ArchiveFormat, type PlatformKey, type UpdateManifest } from "./manifest.ts";

export async function tempDir(prefix = "updater-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function makeKeys() {
	const kp = await generateKeyPair();
	return { privateKey: kp.privateKey, publicKey: toBase64(kp.publicKey) };
}

/** A fake "executable": a shell script that records its version into `marker` when run. */
export async function writeFakeExe(path: string, version: string, marker: string): Promise<void> {
	await Bun.write(path, `#!/bin/sh\necho ${version} > '${marker}'\n`);
	await chmod(path, 0o755);
}

/** Fake macOS bundle: <dir>/<name>.app/Contents/{Info.plist,MacOS/<name>}. Returns the .app path. */
export async function writeFakeApp(dir: string, name: string, version: string, marker: string): Promise<string> {
	const app = join(dir, `${name}.app`);
	await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
	await Bun.write(
		join(app, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`,
	);
	await writeFakeExe(join(app, "Contents", "MacOS", name), version, marker);
	return app;
}

export async function buildArtifact(inputs: string[], out: string, format: ArchiveFormat = "tar.zst") {
	await createArchive(inputs, out, format);
	return { path: out, sha256: await sha256File(out), size: Bun.file(out).size, format };
}

export async function signedManifest(
	privateKey: Uint8Array,
	fields: Partial<Omit<UpdateManifest, "signature">> & { artifacts?: UpdateManifest["artifacts"] },
): Promise<UpdateManifest> {
	return signManifest(
		{
			name: "TestApp",
			version: "2.0.0",
			channel: "stable",
			releasedAt: "2026-10-30T12:00:00.000Z",
			artifacts: {} as Partial<Record<PlatformKey, never>>,
			...fields,
		} as Omit<UpdateManifest, "signature">,
		privateKey,
	);
}

/** Static host: serves files from a map path -> body/file. Records requests. */
export function serveStatic(files: Record<string, () => Response>) {
	const hits: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			hits.push(path);
			const make = files[path];
			return make ? make() : new Response("not found", { status: 404 });
		},
	});
	return { server, hits, base: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

/** A body without content-length (chunked), emitting `chunks` pieces. */
export function chunkedResponse(bytes: Uint8Array, chunks = 8): Response {
	const size = Math.ceil(bytes.length / chunks);
	let i = 0;
	return new Response(
		new ReadableStream({
			async pull(controller) {
				if (i >= bytes.length) return controller.close();
				if (i > 0) await Bun.sleep(2); // keep chunks from coalescing over loopback
				controller.enqueue(bytes.slice(i, i + size));
				i += size;
			},
		}),
	);
}

/** Poll until `fn` returns truthy or time runs out. */
export async function waitFor<T>(fn: () => Promise<T> | T, timeoutMs = 5000): Promise<T> {
	const end = Date.now() + timeoutMs;
	while (true) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error("waitFor: timed out");
		await Bun.sleep(25);
	}
}
