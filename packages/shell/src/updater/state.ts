import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { rename, rm } from "node:fs/promises";

/** One filesystem swap: `src` (staged) replaces `dest`; the previous `dest` is kept at `backup`. */
export interface Move {
	src: string;
	dest: string;
	backup: string;
	/** Whether `dest` existed before the update (false = file added by the update). */
	existed: boolean;
	/** Next to `dest`: `src` goes here first, so what can fail or take time (another filesystem) is over before `dest` is touched. */
	via?: string;
}

export type Phase =
	/** apply() spawned the helper; the swap has not completed (yet). */
	| "applying"
	/** Helper swapped files; the new version has not confirmed yet. */
	| "applied"
	/** Helper failed and restored the previous files. */
	| "failed"
	/** rollbackIfNeeded() restored the previous version; `to` is the rejected version. */
	| "rolled-back";

export interface UpdateState {
	phase: Phase;
	from: string;
	to: string;
	/** Number of unconfirmed starts of `to` (incremented by rollbackIfNeeded()). */
	attempts: number;
	platform: string;
	moves: Move[];
	stagingDir: string;
	helperPid?: number;
	error?: string;
	updatedAt: string;
}

export async function readState(path: string): Promise<UpdateState | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		// Strip a UTF-8 BOM in case a Windows tool wrote the file.
		const text = (await file.text()).replace(/^﻿/, "");
		const s = JSON.parse(text) as UpdateState;
		if (!s || typeof s.phase !== "string" || !Array.isArray(s.moves)) return null;
		return s;
	} catch {
		return null;
	}
}

/** A full disk can take part of it and say so only in the count. */
export function writeAll(fd: number, text: string, write: typeof writeSync = writeSync): void {
	const bytes = new TextEncoder().encode(text);
	for (let at = 0; at < bytes.length; ) at += write(fd, bytes, at);
}

export async function writeState(path: string, state: UpdateState): Promise<void> {
	const tmp = `${path}.tmp`;
	// Durable: a power cut must not lose how many times a new version has failed to start.
	const fd = openSync(tmp, "w");
	try {
		writeAll(fd, `${JSON.stringify(state, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	await rename(tmp, path);
}

export async function clearState(path: string): Promise<void> {
	await rm(path, { force: true });
}
