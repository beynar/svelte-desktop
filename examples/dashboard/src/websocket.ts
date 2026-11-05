// WebSockets on the app's own server.
//   /ws        every page that connects joins the lobby; a message comes back to its sender (echo) and
//              goes to the other pages (peer). Other server code pushes with sockets.publish('lobby', …)
//              — see routes/native/push — and reads the shared presence count.
//   /terminal  the user's shell in a pseudo-terminal (Bun.spawn's `terminal`), for the Modules
//              page's xterm.js: input and size as JSON, output as raw bytes. Only the app's pages
//              reach the app's sockets (its session cookie), so only they get a shell.
import { dev } from '$app/env';
import { defineWebSocket } from '@kitop/shell/websocket';
import { presence } from './lib/server/presence';

let next = 1;
const terminals = new Map<number, { proc: ReturnType<typeof Bun.spawn>; terminal: Bun.Terminal }>();

export default defineWebSocket<{ id: number }>({
	path: ['/ws', '/terminal'],
	upgrade: () => ({ id: next++ }),
	open(ws) {
		const { id } = ws.data.data;
		if (ws.data.path === '/terminal') {
			// A login shell: it reads the user's profile, so their PATH, aliases and prompt are there.
			const shell = process.env.SHELL || '/bin/zsh';
			const cols = Number(ws.data.query.cols) || 80;
			const rows = Number(ws.data.query.rows) || 24;
			const proc = Bun.spawn([shell, '-l'], {
				cwd: process.env.HOME,
				env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
				terminal: { cols, rows, data: (_term, bytes) => ws.send(bytes) }
			});
			terminals.set(id, { proc, terminal: proc.terminal! });
			void proc.exited.then(() => ws.close(1000, 'shell exited'));
			return;
		}
		presence.online++;
		if (dev) console.log(`[websocket] #${id} connected (${presence.online} online)`);
		ws.subscribe('lobby');
		ws.send(JSON.stringify({ type: 'hello', id }));
	},
	message(ws, message) {
		const t = terminals.get(ws.data.data.id);
		if (t) {
			const m = JSON.parse(String(message)) as { input?: string; cols?: number; rows?: number };
			if (m.input) t.terminal.write(m.input);
			if (m.cols && m.rows) t.terminal.resize(m.cols, m.rows);
			return;
		}
		const text = String(message);
		ws.send(JSON.stringify({ type: 'echo', text }));
		ws.publish('lobby', JSON.stringify({ type: 'peer', from: ws.data.data.id, text }));
	},
	close(ws) {
		const t = terminals.get(ws.data.data.id);
		if (t) {
			terminals.delete(ws.data.data.id);
			t.proc.kill();
			t.terminal.close();
			return;
		}
		presence.online--;
	}
});
