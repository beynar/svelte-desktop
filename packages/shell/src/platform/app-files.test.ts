import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAppFile, writeAppFile } from './app-files';
import { PlatformTransport, initPlatformForTests } from './bus';

test('a write the disk took only part of goes on until all of it is there', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'sd-appfile-'));
	const t = new PlatformTransport();
	t.serve('app', 'getPath', { ok: true, value: dir });
	initPlatformForTests(t);
	const fs = process.getBuiltinModule('node:fs');
	const real = fs.writeSync;
	(fs as { writeSync: unknown }).writeSync = (fd: number, bytes: Uint8Array, at = 0) => real(fd, bytes, at, Math.min(7, bytes.length - at));
	try {
		await writeAppFile('userData', 'short.json', 'é'.repeat(50));
	} finally {
		(fs as { writeSync: unknown }).writeSync = real;
	}
	expect(await readAppFile('userData', 'short.json')).toBe('é'.repeat(50));
});
