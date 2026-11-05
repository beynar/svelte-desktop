// src/mcp.ts in the built app (`bunx --bun vite build` first) or under `vite dev` (DESKTOP_TEST_DEV=1):
// what an agent's client does, starting what host.mcp says on stdio, the tools running in the app on
// its database. It opens the app's window: run it when that's fine.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, type AppHandle } from '@kitop/shell/test';

const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

function executable(): string {
	const dist = resolve('.desktop/dist');
	const names = readdirSync(dist);
	const mac = names.find((n) => n.endsWith('.app'));
	if (mac) {
		const plist = readFileSync(join(dist, mac, 'Contents/Info.plist'), 'utf8');
		return join(dist, mac, 'Contents/MacOS', /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)/.exec(plist)![1]!);
	}
	const folder = join(dist, names.find((n) => existsSync(join(dist, n, 'lib', 'libshell.so')))!);
	const entry = readdirSync(folder).find((f) => f.endsWith('.desktop'))!;
	return join(folder, /^Exec=(\S+)/m.exec(readFileSync(join(folder, entry), 'utf8'))![1]!);
}

function bridge() {
	const proc = Bun.spawn([server.command, ...server.args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	const next = async () => {
		while (!buffered.includes('\n')) {
			const { value, done } = await reader.read();
			if (done) throw new Error(`the bridge closed: ${await new Response(proc.stderr).text()}`);
			buffered += decoder.decode(value);
		}
		const at = buffered.indexOf('\n');
		const line = buffered.slice(0, at);
		buffered = buffered.slice(at + 1);
		return JSON.parse(line);
	};
	const ask = (id: number, method: string, params: object = {}) => {
		proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } })}\n`);
		proc.stdin.flush();
		return next();
	};
	return { proc, ask, next };
}

const dev = !!process.env.DESKTOP_TEST_DEV;
let app: AppHandle | undefined;
let server: { available: boolean; name: string; command: string; args: string[]; tools: string[] };
beforeAll(async () => {
	app = await launch(dev ? { dev: true } : {});
	await app.waitFor('#counter');
	server = await app.eval(`fetch('/api/mcp-status').then((r) => r.json())`);
});
/** The copy a call opened, which nothing else would close. */
let opened: number | null = null;
afterAll(() => {
	if (opened) process.kill(opened);
	return app?.close();
});

test('the tools are listed, as the app declares them', async () => {
	const b = bridge();
	const { result } = await b.ask(1, 'tools/list');
	expect(result.tools.map((t: { name: string }) => t.name)).toEqual(['list_notes', 'add_note']);
	expect(result.tools[0].annotations).toEqual({ readOnlyHint: true });
	expect(result.tools[1].inputSchema.required).toEqual(['text']);
	b.proc.stdin.end();
	expect(await b.proc.exited).toBe(0);
});

test('a call runs in the running app: on its database, and no second window', async () => {
	const windows = (await app!.platform<unknown[]>('window', 'list')).length;
	const text = `from an agent ${Date.now()}`;
	const b = bridge();
	const added = await b.ask(1, 'tools/call', { name: 'add_note', arguments: { text } });
	expect(added.result.isError).toBeUndefined();
	const { id } = added.result.structuredContent as { id: number };
	const listed = await b.ask(2, 'tools/call', { name: 'list_notes', arguments: { limit: 1 } });
	expect(listed.result.structuredContent).toEqual({ notes: [{ id, text }] });
	// What the app's own pages read: reloaded, the note is there.
	await app!.eval(`(location.reload(), true)`).catch(() => {});
	await app!.waitFor(`#counter`);
	for (let i = 0; i < 50 && !(await app!.text('body')).includes(text); i++) await Bun.sleep(100);
	expect(await app!.text('body')).toContain(text);
	expect((await app!.platform<unknown[]>('window', 'list')).length).toBe(windows);
	b.proc.kill();
});

test.if(dev)('under vite dev, an edit to src/mcp.ts: the list and the calls are the new ones', async () => {
	const file = 'src/mcp.ts';
	const before = await Bun.file(file).text();
	try {
		await Bun.write(file, before.replace('return server;', "server.registerTool('added_in_dev', { description: 'New' }, () => ({ content: [{ type: 'text', text: 'fresh' }] }));\n\treturn server;"));
		const b = bridge();
		let names: string[] = [];
		for (let i = 0; i < 50 && !names.includes('added_in_dev'); i++) {
			await Bun.sleep(100);
			names = (await b.ask(i, 'tools/list')).result.tools.map((t: { name: string }) => t.name);
		}
		expect(names).toContain('added_in_dev');
		const called = await b.ask(100, 'tools/call', { name: 'added_in_dev', arguments: {} });
		expect(called.result.content[0].text).toBe('fresh');
		b.proc.kill();
	} finally {
		await Bun.write(file, before);
	}
});

test('wrong arguments: for the agent to read and correct, nothing run', async () => {
	const b = bridge();
	const wrong = await b.ask(1, 'tools/call', { name: 'add_note', arguments: { text: 3 } });
	expect(wrong.result.isError).toBe(true);
	expect(wrong.result.content[0].text).toMatch(/Invalid arguments for tool add_note/);
	b.proc.kill();
});

test('host.mcp in the app: what a client starts, its tools', async () => {
	expect(server).toMatchObject({ available: true, name: 'svelte-notes', tools: ['list_notes', 'add_note'] });
	if (!dev) expect(server.args).toEqual(['--mcp']);
	expect(statSync(server.command).isFile()).toBe(true);
});

test.skipIf(dev)('the app quit: the list from its file without opening it; a call opens it', async () => {
	await app!.close();
	app = undefined;
	await Bun.sleep(500);
	const b = bridge();
	const { result } = await b.ask(1, 'tools/list');
	expect(result.tools.length).toBe(2);
	await Bun.sleep(1000);
	expect(await running()).toBeNull(); // listing opened nothing
	const called = await b.ask(2, 'tools/call', { name: 'list_notes', arguments: {} });
	opened = await running();
	expect(called.result.isError).toBeUndefined();
	expect((called.result.structuredContent as { notes: unknown[] }).notes.length).toBeGreaterThan(0);
	expect(opened).not.toBeNull();
	b.proc.kill();
}, 60_000);

/** The pid of a window-owning copy of the app: its executable, without --mcp. */
async function running(): Promise<number | null> {
	const exe = executable();
	const out = await new Response(Bun.spawn(['ps', '-eo', 'pid=,args='], { stdout: 'pipe' }).stdout).text();
	for (const line of out.split('\n')) {
		const [, pid, args] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
		if (args?.startsWith(exe) && !args.includes('--mcp')) return Number(pid);
	}
	return null;
}
