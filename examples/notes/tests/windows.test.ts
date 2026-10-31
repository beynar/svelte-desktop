// The Windows build (SVELTE_DESKTOP_TARGET=windows bunx --bun vite build) on a Windows
// machine: WebView2 window, host global, WinRT toasts, the COM toast activator.
//   WINDOWS_E2E=1 [WINDOWS_APP=<app folder>] bun test --timeout 120000 tests/windows.test.ts
// Skipped unless WINDOWS_E2E is set (CI: .github/workflows/windows.yml).
//
// Toast clicks are driven exactly like the shell does it: the app's toast activator
// (INotificationActivationCallback, CLSID derived from the identifier) is created
// over COM from PowerShell and Activate()d with the arguments the toast XML carries.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type AppHandle } from '@svelte-desktop/shell/test';
import { toastActivatorClsid } from '../../../packages/shell/src/build/package-windows.ts';

const ID = 'dev.svelte-desktop.notes';
const CLSID = toastActivatorClsid(ID);
const APP = resolve(process.env.WINDOWS_APP ?? '.desktop/dist/Svelte Notes-windows-x64');
const tmp = process.platform === 'win32' ? mkdtempSync(join(tmpdir(), 'sd-win-')) : '';

const ACTIVATE_PS1 = String.raw`param([string]$Spec)
$ErrorActionPreference = 'Stop'
$s = Get-Content -Raw $Spec | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct SdInput { [MarshalAs(UnmanagedType.LPWStr)] public string Key; [MarshalAs(UnmanagedType.LPWStr)] public string Value; }
[ComImport, Guid("53e31837-6600-4a81-9395-75cffe746f94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface INotificationActivationCallback {
  void Activate([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string invokedArgs,
                [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 3)] SdInput[] data, uint count);
}
public static class SdToast {
  public static void Activate(string clsid, string aumid, string args, string[] keys, string[] values) {
    Type t = Type.GetTypeFromCLSID(new Guid(clsid), true);
    object o = Activator.CreateInstance(t);
    INotificationActivationCallback cb = (INotificationActivationCallback)o;
    SdInput[] data = new SdInput[keys.Length];
    for (int i = 0; i < keys.Length; i++) { data[i].Key = keys[i]; data[i].Value = values[i]; }
    cb.Activate(aumid, args, data, (uint)data.Length);
    Marshal.ReleaseComObject(o);
  }
}
"@
$keys = [string[]]@(); $values = [string[]]@()
if ($s.inputs) { foreach ($p in $s.inputs.PSObject.Properties) { $keys += $p.Name; $values += [string]$p.Value } }
[SdToast]::Activate($s.clsid, $s.aumid, $s.args, $keys, $values)
'activated'
`;

const TOASTS_PS1 = String.raw`param([string]$Aumid)
$ErrorActionPreference = 'Stop'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid)
$sched = @($n.GetScheduledToastNotifications() | ForEach-Object { $_.Tag })
$hist = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($Aumid) | ForEach-Object { $_.Tag })
@{ setting = "$($n.Setting)"; scheduled = $sched; history = $hist } | ConvertTo-Json -Compress
`;

async function ps(script: string, ...args: string[]) {
	const file = join(tmp, `s${Math.random().toString(36).slice(2)}.ps1`);
	writeFileSync(file, script);
	const p = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { out: out.trim(), err: err.trim(), code };
}

/** What Windows does on a toast click: Activate(aumid, <toast launch/action arguments>, inputs). */
async function activate(args: object | string, inputs: Record<string, string> = {}) {
	const spec = join(tmp, `a${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(spec, JSON.stringify({ clsid: CLSID, aumid: ID, args: typeof args === 'string' ? args : JSON.stringify(args), inputs }));
	const r = await ps(ACTIVATE_PS1, spec);
	if (r.code !== 0 || !r.out.includes('activated')) throw new Error(`activate failed (${r.code}): ${r.err || r.out}`);
}

async function toasts(): Promise<{ setting: string; scheduled: string[]; history: string[] }> {
	const r = await ps(TOASTS_PS1, ID);
	if (r.code !== 0) throw new Error(`toast query failed: ${r.err}`);
	const v = JSON.parse(r.out);
	return { setting: v.setting, scheduled: [v.scheduled ?? []].flat(), history: [v.history ?? []].flat() };
}

const reg = (...a: string[]) => Bun.spawnSync(['reg', ...a], { stdout: 'pipe', stderr: 'pipe' });
const log = (...a: unknown[]) => console.log('[windows-e2e]', ...a);

describe.skipIf(!process.env.WINDOWS_E2E)('windows', () => {
	let app: AppHandle;
	const payloadAbout = JSON.stringify({ url: '/about' });
	const show = (o: Record<string, unknown>) => app.eval<{ id: string; scheduled: boolean; skipped?: boolean }>(`host.notifications.show(${JSON.stringify(o)})`);
	const delivered = () => app.eval<Array<{ id: string; title: string }>>(`host.notifications.delivered()`);
	const pending = () => app.eval<Array<{ id: string }>>(`host.notifications.pending()`);
	const home = async () => {
		if ((await app.eval<string>('location.pathname')) !== '/') await app.goto('/');
		await app.waitFor('#counter', { timeout: 20_000 });
	};

	beforeAll(async () => {
		expect(existsSync(APP)).toBe(true);
		app = await launch({ app: APP, timeout: 90_000 });
		await app.waitFor('#counter', { timeout: 30_000 });
	});
	let closed = false;
	afterAll(() => (closed ? undefined : app?.close()));

	test('app loads (SSR + hydration), host global, window op', async () => {
		expect(await app.text('body')).toContain('desktop shell');
		expect(await app.eval<string>(`typeof host`)).toBe('object');
		expect(await app.eval<string>(`typeof host.notifications.show`)).toBe('function');
		const info = await app.platform<{ platform: string; identifier: string }>('app', 'getInfo');
		expect(info).toMatchObject({ platform: 'win32', identifier: ID, packaged: true });
		await app.platform('window', 'setTitle', { title: 'Under test' });
		expect(await app.platform<string>('window', 'getTitle')).toBe('Under test');
		const b = await app.platform<{ bounds: { width: number } }>('window', 'getBounds');
		expect(b.bounds.width).toBeGreaterThan(400);
	});

	test('toast identity registered (AUMID + COM activator)', () => {
		const aumid = reg('query', `HKCU\\Software\\Classes\\AppUserModelId\\${ID}`);
		const out = aumid.stdout.toString();
		log(out.trim());
		expect(out).toContain('DisplayName');
		expect(out).toContain(CLSID);
		const srv = reg('query', `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`).stdout.toString();
		expect(srv).toContain('-ToastActivated');
	});

	test('notifications: supported, permission', async () => {
		expect(await app.eval<boolean>(`host.notifications.isSupported()`)).toBe(true);
		const st = await app.eval<{ status: string }>(`host.notifications.getPermissionStatus()`);
		log('permission', st, 'notifier', await toasts().catch((e) => String(e)));
		expect(['granted', 'denied']).toContain(st.status);
	});

	test('show → delivered (toast history) → same id replaces → replace:false skipped', async () => {
		await app.eval(`host.notifications.dismissAll()`);
		expect(await show({ id: 'w1', title: 'Hello', body: 'from the e2e', url: '/about' })).toMatchObject({ id: 'w1', scheduled: false });
		await Bun.sleep(500);
		const t = await toasts();
		log('after show', t);
		expect(t.history).toContain('w1');
		expect((await delivered()).filter((n) => n.id === 'w1')).toHaveLength(1);
		await show({ id: 'w1', title: 'Hello again', body: 'replaced', url: '/about' });
		await Bun.sleep(500);
		const list = (await delivered()).filter((n) => n.id === 'w1');
		expect(list).toHaveLength(1);
		expect(list[0]!.title).toBe('Hello again');
		expect((await toasts()).history.filter((x) => x === 'w1')).toHaveLength(1);
		expect(await show({ id: 'w1', title: 'not shown', replace: false })).toMatchObject({ skipped: true });
	});

	test('scheduled → pending (ScheduledToastNotification) → dismiss / dismissAll', async () => {
		expect(await show({ id: 's1', title: 'Later', delay: 120_000 })).toMatchObject({ scheduled: true });
		expect((await pending()).map((p) => p.id)).toContain('s1');
		expect((await toasts()).scheduled).toContain('s1');
		await app.eval(`host.notifications.dismiss('s1')`);
		expect((await pending()).map((p) => p.id)).not.toContain('s1');
		expect((await toasts()).scheduled).not.toContain('s1');
		await show({ id: 's2', title: 'Later too', delay: 120_000 });
		await app.eval(`host.notifications.dismissAll()`);
		await Bun.sleep(300);
		expect(await pending()).toHaveLength(0);
		expect(await delivered()).toHaveLength(0);
		const t = await toasts();
		expect(t.scheduled).toHaveLength(0);
		expect(t.history).toHaveLength(0);
	});

	test('data: URL image → cache file', async () => {
		const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
		expect(await show({ id: 'img', title: 'With image', image: png, icon: png })).toMatchObject({ id: 'img' });
		const dir = join(process.env.LOCALAPPDATA ?? '', ID, 'notification-images');
		expect(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.png'))).toBe(true);
		await app.eval(`host.notifications.dismiss('img')`);
	});

	test('setBadge (taskbar overlay)', async () => {
		expect(await app.eval(`host.notifications.setBadge(3)`)).toBeNull();
		expect(await app.eval(`host.notifications.setBadge(120)`)).toBeNull();
		expect(await app.eval(`host.notifications.setBadge(null)`)).toBeNull();
	});

	test('click (COM activator) → response in the page that showed it → navigates to its url', async () => {
		await home();
		await show({ id: 'c1', title: 'Click me', body: 'opens About', url: '/about' });
		await activate({ i: 'c1', p: payloadAbout }); // the toast's launch attribute
		await app.waitFor(() => location.pathname === '/about', { timeout: 15_000 });
		await app.waitFor(() => /click c1/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
		const rs = await app.platform<Array<{ id: string; kind: string; payload: string }>>('notifications', 'responses');
		expect(rs.find((r) => r.id === 'c1')).toMatchObject({ kind: 'click', payload: payloadAbout });
	});

	test('action with input → reply text', async () => {
		await home();
		await show({ id: 'r1', title: 'Message', actions: [{ id: 'reply', title: 'Reply', input: { placeholder: 'Message', button: 'Send' } }, { id: 'later', title: 'Later', foreground: false }] });
		await activate({ i: 'r1', a: 'reply', t: 't0' }, { t0: 'On my way' }); // the action's arguments + its input
		await app.waitFor(() => /reply r1 reply: On my way/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
		await activate({ i: 'r1', a: 'later' });
		await app.waitFor(() => /action r1 later/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
	});

	test('cold start: the activator launches the app (-ToastActivated), the click reaches it', async () => {
		await app.close();
		closed = true;
		await Bun.sleep(2000);
		// Elevated clients ignore per-user COM classes: mirror the registration machine-wide when we can.
		const hklm = reg('copy', `HKCU\\Software\\Classes\\CLSID\\${CLSID}`, `HKLM\\Software\\Classes\\CLSID\\${CLSID}`, '/s', '/f').exitCode === 0;
		log('HKLM mirror of the activator:', hklm);
		const sysEnv = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
		let activation: Promise<number> | null = null;
		const t0 = Date.now();
		try {
			const connected = await launch({
				timeout: 45_000,
				connect: (url) => {
					// A COM-launched server gets the user's registry environment, not ours.
					reg('add', 'HKCU\\Environment', '/v', 'SVELTE_DESKTOP_TEST', '/d', url, '/f');
					reg('add', sysEnv, '/v', 'SVELTE_DESKTOP_TEST', '/d', url, '/f');
					activation = activate({ i: 'cold', p: payloadAbout }).then(() => Date.now() - t0);
					activation.then((ms) => log(`cold activation returned after ${ms} ms`), (e) => log('cold activation failed:', String(e)));
				},
			}).catch((e) => (log(String(e).split('\n')[0]), null));
			const ms = await activation;
			const procs = await ps(`Get-CimInstance Win32_Process -Filter "name='SvelteNotes.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`);
			log('processes:', procs.out);
			expect(ms).toBeGreaterThan(0); // Activate() returned: COM started the exe and reached its activator
			expect(procs.out).toContain('-ToastActivated');
			if (connected) {
				app = connected;
				closed = false;
				await app.waitFor(() => location.pathname === '/about', { timeout: 20_000 });
				await app.waitFor(() => /click cold/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
				expect(await app.platform<unknown[]>('notifications', 'claim')).toHaveLength(0); // the page took it
			} else {
				// No test channel (the COM-started process didn't get SVELTE_DESKTOP_TEST): ask the
				// app's own server what its Worker saw (/api/notifications logs every response).
				const pid = procs.out.split('\n').find((l) => l.includes('-ToastActivated'))!.split(' ')[0]!;
				const ports = await ps(`Get-NetTCPConnection -State Listen -OwningProcess ${pid} | ForEach-Object { $_.LocalPort }`);
				log('listening:', ports.out);
				let seen: Array<{ kind: string; id: string }> = [];
				for (const port of ports.out.split(/\s+/).filter(Boolean)) {
					const r = await fetch(`http://127.0.0.1:${port}/api/notifications`).catch(() => null);
					if (r?.ok) seen = await r.json().catch(() => []);
					if (seen.length) break;
				}
				log('worker saw:', seen);
				expect(seen.find((r) => r.id === 'cold')).toMatchObject({ kind: 'click' });
				Bun.spawnSync(['taskkill', '/PID', pid, '/T', '/F']);
			}
		} finally {
			reg('delete', 'HKCU\\Environment', '/v', 'SVELTE_DESKTOP_TEST', '/f');
			reg('delete', sysEnv, '/v', 'SVELTE_DESKTOP_TEST', '/f');
			if (hklm) reg('delete', `HKLM\\Software\\Classes\\CLSID\\${CLSID}`, '/f');
		}
	});
});
