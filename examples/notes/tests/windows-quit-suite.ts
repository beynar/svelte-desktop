// Run by windows-desktop.test.ts in the platform harness, a window of the shell with
// quitOnLastWindowClosed on: the notes app keeps running with no window, so it can't show this. The cancellable
// quit through the real src/platform/app-lifecycle.ts, from a real close of the last window to a process's end.
import { resolve } from 'node:path';
import { deliverPlatformEvent, initPlatformForTests } from '../../../packages/shell/src/platform/bus.ts';
import { appLifecycle, type QuitRequest } from '../../../packages/shell/src/platform/app-lifecycle.ts';
import type { Harness } from '../../../packages/shell/test/harness-worker.ts';

const powershell = (script: string) => Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { stdout: 'pipe', stderr: 'pipe' });
const USER32 = `Add-Type -Name U -Namespace Sd -MemberDefinition '
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, int[] r);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
';$h = [Sd.U]::FindWindow('KitopWindow', 'platform harness');`;
/** WM_CLOSE from another process, as the taskbar's Close does. */
const postClose = () => powershell(`${USER32} [void][Sd.U]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)`);
/** The real mouse on the window's close button. */
const clickClose = () => powershell(`${USER32} [void][Sd.U]::SetProcessDPIAware(); [Sd.U]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [Sd.U]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero); [void][Sd.U]::SetForegroundWindow($h); Start-Sleep -Milliseconds 300; $r = New-Object int[] 4; [void][Sd.U]::GetWindowRect($h, $r); [void][Sd.U]::SetCursorPos($r[2] - 22, $r[1] + 14); Start-Sleep -Milliseconds 200; [Sd.U]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [Sd.U]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)`);

export default async (t: Harness) => {
	initPlatformForTests({
		platformCall(request) {
			const { id, service, op, args } = JSON.parse(request);
			void t.call(service, op, args).then((r) => deliverPlatformEvent('platformResult', { ...r, id }));
			return JSON.stringify({ pending: true });
		},
	});
	t.onEvent((name, data) => deliverPlatformEvent(name, data));
	await t.sleep(10);
	const app = (op: string, args: Record<string, unknown> = {}) => t.call('app', op, args);
	const alive = async () => (await t.call('window', 'isVisible')).value === true && (await t.page('return 40 + 2')) === 42;

	// ---- a veto, from each source -------------------------------------------------------
	const seen: QuitRequest[] = [];
	const off = appLifecycle.onQuitRequested((request) => {
		seen.push(request);
		return 'cancel';
	});
	await t.sleep(100);
	const vetoed = async (name: string, reason: string, ask: () => unknown) => {
		const before = seen.length;
		const cancelled = t.waitEvent('quitCancelled', 6000);
		await ask();
		const c = await cancelled;
		const last = seen[seen.length - 1];
		t.check(`${name}: the guard is asked, reason ${reason}`, seen.length === before + 1 && last?.reason === reason && last.deadline > Date.now(), last);
		t.check(`${name}: quitCancelled, same request`, c?.requestId === last?.requestId && c?.reason === reason, c);
		await t.sleep(200);
		t.check(`${name}: the window and its page are still there`, await alive());
	};
	await vetoed('WM_CLOSE on the last window', 'lastWindowClosed', postClose);
	await vetoed('the close button, the real mouse', 'lastWindowClosed', clickClose);
	t.check('no beforeQuit after a veto', !t.events.get('beforeQuit')?.length);
	off();
	await t.sleep(100);

	// ---- all the way to the end of a process ---------------------------------------------
	const harness = resolve(import.meta.dir, '../../../packages/shell/test/harness.ts'), helper = resolve(import.meta.dir, '../../../packages/shell/test/platform/_quit-phases.ts');
	const run = async (mode: string, atMost: number, midway: number) => {
		const started = Date.now();
		const proc = Bun.spawn([process.execPath, harness, helper], { env: { ...process.env, QUIT_MODE: mode }, stdout: 'pipe', stderr: 'ignore' });
		await t.sleep(midway);
		const running = proc.exitCode === null;
		const stopped = await Promise.race([proc.exited, Bun.sleep(atMost).then(() => null)]);
		if (stopped === null) proc.kill();
		const out = await new Response(proc.stdout).text();
		const log = out.split('\n').filter((l) => l.startsWith('QUIT ')).map((l) => JSON.parse(l.slice(5)));
		return { running, stopped, ms: Date.now() - started, log };
	};
	const delayed = await run('delay', 25_000, 1000); // its guard alone takes longer
	const order = delayed.log.map((l) => l.what);
	t.check('delayed quit: still running while the guard waits', delayed.running, delayed);
	t.check('delayed quit: guard, then beforeQuit, then willQuit, each to its end', ['quitRequested', 'allowed', 'beforeQuit', 'beforeQuit done', 'willQuit', 'willQuit done'].every((w, i, all) => order.indexOf(w) >= 0 && (i === 0 || order.indexOf(w) > order.indexOf(all[i - 1]!))), order);
	const at = (what: string) => delayed.log.find((l) => l.what === what);
	t.check('delayed quit: the guard really held it', at('allowed')?.at - at('quitRequested')?.at >= 1400 && at('beforeQuit')?.at >= at('allowed')?.at, delayed.log);
	t.check('delayed quit: same request and reason in every phase', ['quitRequested', 'beforeQuit', 'willQuit'].every((p) => at(p)?.extra?.requestId === at('quitRequested')?.extra?.requestId && at(p)?.extra?.reason === 'api'), delayed.log);
	t.check('delayed quit: the page answered, and the window was up until after beforeQuit', at('allowed')?.extra?.page === 2 && at('beforeQuit done')?.extra === true, delayed.log);
	t.check('delayed quit: then the process ended, exit 0', delayed.stopped === 0, delayed.stopped);
	const timedOut = await run('timeout', 30_000, 3000);
	t.check('a guard that never answers: still running after 3 s', timedOut.running, timedOut);
	const when = timedOut.log.find((l) => l.what === 'quitTimedOut');
	t.check('… quitTimedOut for its phase at the 10 s deadline', when?.extra?.phase === 'quitRequested' && when.at >= 9500, when);
	t.check('… then the app quits', timedOut.stopped === 0, timedOut.stopped);

	// ---- nothing to ask: the last window really ends it, last of all because the harness goes with it -----
	const closed = t.waitEvent('willQuit', 6000);
	postClose();
	const last = await closed;
	t.check('with no guard, WM_CLOSE on the last window quits, reason lastWindowClosed', last?.reason === 'lastWindowClosed', last);
};
