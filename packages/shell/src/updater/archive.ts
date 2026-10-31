/**
 * Archive extraction/creation via the system `tar` (bsdtar on macOS and
 * Windows 10+, GNU tar on most Linux). zstd is never delegated to tar:
 * macOS's bsdtar and Windows' tar.exe are built without zstd, and GNU tar
 * needs the external `zstd` binary. Instead we stream-(de)compress zstd in
 * Bun (node:zlib zstd streams) and pipe a plain tar through stdin/stdout.
 * gzip is handled by tar itself everywhere.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import type { ArchiveFormat } from "./manifest.ts";
import { UpdateError } from "./errors.ts";

export function tarBinary(platform: string = process.platform): string {
	// On Windows, never pick up Git/MSYS GNU tar from PATH: it parses "C:\x" as host:path.
	if (platform === "win32") return `${process.env.SystemRoot || "C:\\Windows"}\\System32\\tar.exe`;
	if (platform === "darwin") return "/usr/bin/tar";
	return "tar";
}

export function formatFromPath(path: string): ArchiveFormat | null {
	if (/\.(tar\.zst|tzst)$/i.test(path)) return "tar.zst";
	if (/\.(tar\.gz|tgz)$/i.test(path)) return "tar.gz";
	return null;
}

function zstdDecompressStream(): NodeJS.ReadWriteStream {
	const create = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;
	if (!create) throw new UpdateError("extract_failed", "this runtime has no streaming zstd (node:zlib createZstdDecompress)");
	return create();
}

function zstdCompressStream(): NodeJS.ReadWriteStream {
	const create = (zlib as unknown as { createZstdCompress?: (o?: unknown) => NodeJS.ReadWriteStream }).createZstdCompress;
	if (!create) throw new Error("this runtime has no streaming zstd (node:zlib createZstdCompress)");
	return create();
}

export async function extractArchive(
	archivePath: string,
	format: ArchiveFormat,
	destDir: string,
	platform: string = process.platform,
): Promise<void> {
	await mkdir(destDir, { recursive: true });
	const tar = tarBinary(platform);
	const env = { ...process.env, COPYFILE_DISABLE: "1" };
	let proc;
	if (format === "tar.gz") {
		proc = Bun.spawn([tar, "-xzf", archivePath, "-C", destDir], { stdout: "ignore", stderr: "pipe", env });
	} else {
		proc = Bun.spawn([tar, "-xf", "-", "-C", destDir], { stdin: "pipe", stdout: "ignore", stderr: "pipe", env });
		try {
			const decompressed = createReadStream(archivePath).pipe(zstdDecompressStream());
			for await (const chunk of decompressed as AsyncIterable<Uint8Array>) {
				proc.stdin.write(chunk);
				await proc.stdin.flush();
			}
			await proc.stdin.end();
		} catch (err) {
			proc.kill();
			await proc.exited;
			throw new UpdateError("extract_failed", `zstd decompression failed: ${(err as Error).message}`, { cause: err });
		}
	}
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (code !== 0) throw new UpdateError("extract_failed", `tar exited with ${code}: ${stderr.trim()}`);
}

/**
 * Create an archive whose top-level entries are the basenames of `inputs`
 * (e.g. `My.app`, or `myapp` + `libwebview.so`). Used by the publishing CLI and tests.
 */
export async function createArchive(
	inputs: string[],
	outPath: string,
	format: ArchiveFormat,
	platform: string = process.platform,
): Promise<void> {
	if (inputs.length === 0) throw new Error("createArchive: no inputs");
	const args: string[] = [];
	for (const input of inputs) {
		const abs = resolve(input);
		args.push("-C", dirname(abs), basename(abs));
	}
	await mkdir(dirname(resolve(outPath)), { recursive: true });
	const tar = tarBinary(platform);
	// COPYFILE_DISABLE: stop macOS bsdtar from adding AppleDouble "._*" entries.
	const env = { ...process.env, COPYFILE_DISABLE: "1" };
	if (format === "tar.gz") {
		const proc = Bun.spawn([tar, "-czf", resolve(outPath), ...args], { stderr: "pipe", env });
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		if (code !== 0) throw new Error(`tar exited with ${code}: ${stderr.trim()}`);
		return;
	}
	const proc = Bun.spawn([tar, "-cf", "-", ...args], { stdout: "pipe", stderr: "pipe", env });
	const stderrText = new Response(proc.stderr).text();
	await pipeline(
		Readable.fromWeb(proc.stdout as unknown as import("node:stream/web").ReadableStream),
		zstdCompressStream(),
		createWriteStream(resolve(outPath)),
	);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`tar exited with ${code}: ${(await stderrText).trim()}`);
}
