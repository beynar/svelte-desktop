// A file to share and to drag out (written by the server: the page can't write files), and the demo
// OAuth provider's address.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoProvider } from '../../lib/server/demo-provider';
import '../../lib/server/web-content';

export async function load() {
	const path = join(tmpdir(), 'Dashboard report.txt');
	await Bun.write(path, `Dashboard report\n${new Date().toLocaleString()}\n\nOpen tasks, upcoming events, recent activity.\n`);
	return { sample: path, provider: demoProvider() };
}
