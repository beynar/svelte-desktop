// Run by windows-desktop.test.ts in the platform harness, in a console of its own: a guard refuses the first
// Ctrl+Break and takes the next. What happens goes to a file: nothing reads this process's output.
import { appendFileSync } from 'node:fs';
import { deliverPlatformEvent, initPlatformForTests } from '../../../packages/shell/src/platform/bus.ts';
import { appLifecycle } from '../../../packages/shell/src/platform/app-lifecycle.ts';
import type { Harness } from '../../../packages/shell/test/harness-worker.ts';

const say = (what: string) => appendFileSync(process.env.QUIT_LOG!, what + '\n');

export default async (t: Harness) => {
	initPlatformForTests({
		platformCall(request) {
			const { id, service, op, args } = JSON.parse(request);
			void t.call(service, op, args).then((r) => deliverPlatformEvent('platformResult', { ...r, id }));
			return JSON.stringify({ pending: true });
		},
	});
	t.onEvent((name, data) => {
		deliverPlatformEvent(name, data);
		if (name === 'quitCancelled') say(`cancelled ${data.reason}`);
	});
	let asked = 0;
	appLifecycle.onQuitRequested((request) => {
		say(`asked ${request.reason}${asked++ ? ' again' : ''}`);
		return asked === 1 ? 'cancel' : 'quit';
	});
	await t.sleep(300);
	say('ready');
	while (!asked) await t.sleep(100);
	await t.sleep(500);
	if ((await t.page('return 40 + 2')) === 42) say('still here');
	await new Promise(() => {}); // the process ends under this
};
