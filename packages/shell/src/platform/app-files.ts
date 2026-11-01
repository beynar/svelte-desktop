// Small files in the app's own directories (the store, the window state), from page or server code.
// Server code reads and writes them; a page asks the app's server process over the `events` bus,
// so there is one owner and every window sees the same file. In a plain browser tab (no native
// layer): localStorage.
import { callPlatform, onPlatform, platformReady } from './bus';

export type AppDir = 'appData' | 'userData';

const CHANNEL = { request: 'appfile:request', reply: 'appfile:reply' } as const;
type Request = { op: 'read' | 'write'; dir: AppDir; name: string; text?: string; nonce: string };
type Reply = { nonce: string; ok: true; text: string | null } | { nonce: string; ok: false; error: string };

const isPage = typeof window !== 'undefined' && typeof document !== 'undefined';
const validName = (name: string) => /^[A-Za-z0-9._-]+$/.test(name);

async function filePath(dir: AppDir, name: string): Promise<string> {
	if (!validName(name)) throw new Error(`app file: invalid name ${name}`);
	return `${await callPlatform<string>('app', 'getPath', { name: dir })}/${name}`;
}

async function local(op: 'read' | 'write', dir: AppDir, name: string, text?: string): Promise<string | null> {
	const path = await filePath(dir, name);
	if (op === 'write') {
		await Bun.write(path, text ?? '');
		return null;
	}
	const file = Bun.file(path);
	return (await file.exists()) ? file.text() : null;
}

function viaServer(op: 'read' | 'write', dir: AppDir, name: string, text?: string): Promise<string | null> {
	const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
	const request: Request = { op, dir, name, text, nonce };
	return new Promise((resolve, reject) => {
		let resend: ReturnType<typeof setInterval>;
		const done = () => (clearInterval(resend), clearTimeout(timer), off());
		const off = onPlatform<{ channel: string; data: Reply }>('message', (m) => {
			if (m?.channel !== CHANNEL.reply || m.data?.nonce !== nonce) return;
			done();
			m.data.ok ? resolve(m.data.text) : reject(new Error(m.data.error));
		});
		const send = () => void callPlatform('events', 'emit', { channel: CHANNEL.request, data: request }).catch(() => {});
		// The server may still be connecting (vite dev): ask again until it answers.
		resend = setInterval(send, 500);
		const timer = setTimeout(() => (done(), reject(new Error(`app file ${name}: no answer from the app server`))), 10_000);
		send();
	});
}

async function run(op: 'read' | 'write', dir: AppDir, name: string, text?: string): Promise<string | null> {
	if (!isPage) return local(op, dir, name, text);
	if (!platformReady()) {
		const key = `svelte-desktop:${dir}/${name}`;
		if (op === 'write') localStorage.setItem(key, text ?? '');
		return op === 'write' ? null : localStorage.getItem(key);
	}
	return viaServer(op, dir, name, text);
}

export const readAppFile = (dir: AppDir, name: string) => run('read', dir, name);
export const writeAppFile = (dir: AppDir, name: string, text: string) => run('write', dir, name, text).then(() => undefined);

/** Server side: answer the pages (installed once with the server runtime). */
export function serveAppFiles(): void {
	const g = globalThis as { __sdAppFiles?: boolean };
	if (g.__sdAppFiles) return;
	g.__sdAppFiles = true;
	onPlatform<{ channel: string; data: Request }>('message', async (m) => {
		if (m?.channel !== CHANNEL.request) return;
		const r = m.data;
		if (!r || typeof r.nonce !== 'string') return;
		let reply: Reply;
		try {
			if ((r.op !== 'read' && r.op !== 'write') || (r.dir !== 'appData' && r.dir !== 'userData')) throw new Error('invalid request');
			reply = { nonce: r.nonce, ok: true, text: await local(r.op, r.dir, r.name, r.text) };
		} catch (err) {
			reply = { nonce: r.nonce, ok: false, error: (err as Error).message };
		}
		void callPlatform('events', 'emit', { channel: CHANNEL.reply, data: reply }).catch(() => {});
	});
}
