import { rename, rm, stat } from "node:fs/promises";
import { UpdateError } from "./errors.ts";

/** A connection that goes quiet fails the download instead of holding it forever. Slow is fine: any byte counts. */
export const STALL_TIMEOUT_MS = 60_000;

export interface DownloadProgress {
	received: number;
	total: number;
	/** 0..1 */
	fraction: number;
}

export interface Expected {
	sha256: string;
	size: number;
}

export async function sha256File(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

/** True if `path` already holds exactly the expected bytes (resume-free cache hit). */
export async function hasVerifiedFile(path: string, expected: Expected): Promise<boolean> {
	try {
		const s = await stat(path);
		if (!s.isFile() || s.size !== expected.size) return false;
		return (await sha256File(path)) === expected.sha256;
	} catch {
		return false;
	}
}

/**
 * Stream `url` to `dest`, hashing as bytes arrive. The byte count is enforced
 * during the stream (an oversize body is cut off, not buffered to disk), and
 * size + SHA-256 are verified before the file is renamed into place. On any
 * failure the partial file is removed.
 */
export async function downloadVerified(
	url: string,
	dest: string,
	expected: Expected,
	opts: {
		fetch?: typeof fetch;
		signal?: AbortSignal;
		onProgress?: (p: DownloadProgress) => void;
		/** Nothing received for this long (connecting included) fails the download. */
		stallTimeoutMs?: number;
	} = {},
): Promise<void> {
	const doFetch = opts.fetch ?? fetch;
	const part = `${dest}.part`;
	await rm(part, { force: true });

	const stallMs = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
	const stall = new AbortController();
	let stalled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const receiving = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			stalled = true;
			stall.abort();
		}, stallMs);
	};
	const stalledError = (cause: unknown) => new UpdateError("download_failed", `download failed: nothing received for ${stallMs / 1000} s`, { cause });
	const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal;
	receiving();

	let res: Response;
	try {
		res = await doFetch(url, { signal, redirect: "follow" });
	} catch (err) {
		clearTimeout(timer);
		if (opts.signal?.aborted) throw new UpdateError("aborted", "download aborted", { cause: err });
		if (stalled) throw stalledError(err);
		throw new UpdateError("download_failed", `download failed: ${(err as Error).message}`, { cause: err });
	}
	if (!res.ok || !res.body) {
		clearTimeout(timer);
		throw new UpdateError("download_failed", `download failed: HTTP ${res.status} for ${url}`);
	}
	const declared = res.headers.get("content-length");
	if (declared !== null && !res.headers.get("content-encoding") && Number(declared) !== expected.size) {
		clearTimeout(timer);
		await res.body.cancel().catch(() => {});
		throw new UpdateError("size_mismatch", `server declares ${declared} bytes, manifest pins ${expected.size}`);
	}

	const hasher = new Bun.CryptoHasher("sha256");
	const sink = Bun.file(part).writer({ highWaterMark: 1 << 20 });
	let received = 0;
	try {
		const reader = res.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			receiving();
			received += value.byteLength;
			if (received > expected.size) {
				await reader.cancel().catch(() => {});
				throw new UpdateError("size_mismatch", `download exceeds pinned size of ${expected.size} bytes`);
			}
			hasher.update(value);
			sink.write(value);
			opts.onProgress?.({ received, total: expected.size, fraction: received / expected.size });
		}
		await sink.end();
		if (received !== expected.size) {
			throw new UpdateError("size_mismatch", `downloaded ${received} bytes, manifest pins ${expected.size}`);
		}
		const digest = hasher.digest("hex");
		if (digest !== expected.sha256) {
			throw new UpdateError("hash_mismatch", `sha256 mismatch: got ${digest}, manifest pins ${expected.sha256}`);
		}
		await rename(part, dest);
		clearTimeout(timer);
	} catch (err) {
		clearTimeout(timer);
		try {
			await sink.end();
		} catch {}
		await rm(part, { force: true });
		if (err instanceof UpdateError) throw err;
		if (opts.signal?.aborted) throw new UpdateError("aborted", "download aborted", { cause: err });
		if (stalled) throw stalledError(err);
		throw new UpdateError("download_failed", `download failed: ${(err as Error).message}`, { cause: err });
	}
}
