// Copied into examples/notes by e2e.sh, for crash-recovery.test.ts: server code that dies on demand.
import { onDesktopReady } from '@kitop/shell/server';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const how = Bun.env.CRASH_HOW;
const dir = Bun.env.CRASH_DIR;
if (dir) appendFileSync(`${dir}/starts`, `${process.pid}\n`);
const already = Bun.env.CRASH_ONCE && dir && existsSync(`${dir}/crashed`);

if (how === 'import' && !already) {
	if (Bun.env.CRASH_ONCE) writeFileSync(`${dir}/crashed`, '');
	throw new Error('crash probe: at import');
}

onDesktopReady((desktop) => {
	if (dir) desktop.on('webcontent-terminated', (e) => appendFileSync(`${dir}/web`, `${JSON.stringify(e)}\n`));
	if (!how || already) return;
	if (Bun.env.CRASH_ONCE) writeFileSync(`${dir}/crashed`, '');
	// Not an async function: a throw in one is a rejection.
	const crash = () => {
		if (how === 'throw') throw new Error('crash probe: thrown');
		if (how === 'reject') void Promise.reject(new Error('crash probe: rejected'));
		if (how === 'exit0') process.exit(0);
		if (how === 'exit3') process.exit(3);
		if (how === 'store-then-quit') {
			void host.store.load().then(() => {
				host.store.set('set-just-before-quit', Bun.env.CRASH_STAMP);
				desktop.quit();
			});
		}
	};
	// CRASH_ON_GO: when the test says so, for what it has to look at first.
	if (!Bun.env.CRASH_ON_GO) return void setTimeout(crash, 800);
	const waiting = setInterval(() => {
		if (!existsSync(`${dir}/go`)) return;
		clearInterval(waiting);
		crash();
	}, 50);
});
