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

// Real input on the shell's toast UI: UI Automation finds the toast (popup, else the
// notification center opened with Win+N) and the mouse clicks it; ValuePattern types the reply.
const UIA_PS1 = String.raw`param([string]$Mode, [string]$Spec)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class SdInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  // The root window under a screen point: "hwnd|class|title|pid|rect" (band windows included).
  public static string At(int x, int y) {
    POINT p; p.X = x; p.Y = y; IntPtr h = GetAncestor(WindowFromPoint(p), 2);
    if (h == IntPtr.Zero) return "";
    var c = new System.Text.StringBuilder(256); GetClassName(h, c, 256);
    var t = new System.Text.StringBuilder(256); GetWindowText(h, t, 256);
    uint pid; GetWindowThreadProcessId(h, out pid); RECT r; GetWindowRect(h, out r);
    return h.ToInt64() + "|" + c + "|" + t + "|" + pid + "|" + r.L + "," + r.T + "," + r.R + "," + r.B;
  }
  // Visible top-level windows (toast popups sit in a shell z-band UIA's root doesn't list): "hwnd|class|title|pid|l,t,r,b"
  public static string[] Windows() {
    var list = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new System.Text.StringBuilder(256); GetClassName(h, c, 256);
      var t = new System.Text.StringBuilder(256); GetWindowText(h, t, 256);
      uint pid; GetWindowThreadProcessId(h, out pid); RECT r; GetWindowRect(h, out r);
      list.Add(h.ToInt64() + "|" + c + "|" + t + "|" + pid + "|" + r.L + "," + r.T + "," + r.R + "," + r.B);
      return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static void Click(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(150); mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
  public static void Chord(byte a, byte b) { keybd_event(a, 0, 0, UIntPtr.Zero); keybd_event(b, 0, 0, UIntPtr.Zero); keybd_event(b, 0, 2, UIntPtr.Zero); keybd_event(a, 0, 2, UIntPtr.Zero); }
}
"@
[void][SdInput]::SetProcessDPIAware()
$s = if ($Spec) { Get-Content -Raw $Spec | ConvertFrom-Json } else { $null }
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$True_ = [System.Windows.Automation.Condition]::TrueCondition
function Shot($path) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
}
function Desc($e) { $c = $e.Current; "[$($c.ControlType.ProgrammaticName)] '$($c.Name)' class=$($c.ClassName) aid=$($c.AutomationId) rect=$($c.BoundingRectangle)" }
function Dump($el, $depth, $max) {
  if ($depth -gt $max) { return }
  ('  ' * $depth) + (Desc $el)
  $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $ch = $w.GetFirstChild($el)
  while ($ch) { Dump $ch ($depth + 1) $max; $ch = $w.GetNextSibling($ch) }
}
function ShellWindows { [SdInput]::Windows() | Where-Object { $f = $_.Split('|'); $f[1] -eq 'Windows.UI.Core.CoreWindow' -or $f[2] -match 'otification' } }
# Toast popups don't show up in EnumWindows / UIA's root on this shell: probe the bottom-right
# corner (where they stack) with WindowFromPoint and take the windows that aren't ours.
function ProbeWindows {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $seen = @{}
  for ($y = $b.Bottom - 20; $y -gt $b.Bottom - 700 -and $y -gt $b.Top; $y -= 40) {
    foreach ($x in @(($b.Right - 60), ($b.Right - 200), ($b.Right - 330))) {
      $w = [SdInput]::At($x, $y)
      if ($w -and -not $seen.ContainsKey($w.Split('|')[0])) { $seen[$w.Split('|')[0]] = $w }
    }
  }
  $seen.Values | Where-Object { $f = $_.Split('|'); $f[1] -notin @('SvelteDesktopWindow', 'Progman', 'WorkerW', 'Shell_TrayWnd', 'CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass') }
}
function Hosts {
  $out = @()
  foreach ($w in @(ShellWindows) + @(ProbeWindows)) { try { $out += $A::FromHandle([IntPtr][long]$w.Split('|')[0]) } catch {} }
  $out += @($A::RootElement.FindAll($TS::Children, $True_) | Where-Object { $_.Current.ClassName -like '*CoreWindow*' -or $_.Current.Name -match 'otification' })
  return $out
}
function Find($hosts, [scriptblock]$pred) {
  foreach ($h in $hosts) { foreach ($e in $h.FindAll($TS::Descendants, $True_)) { try { if (& $pred $e) { return $e } } catch {} } }
  return $null
}
function ClickEl($e) {
  $r = $e.Current.BoundingRectangle
  if ($r.Width -gt 0 -and -not [double]::IsInfinity($r.Width)) { [SdInput]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)); return 'mouse' }
  $p = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return 'invoke' }
  throw "no way to click $(Desc $e)"
}
switch ($Mode) {
  'shot' { Shot $s.path; 'ok' }
  'dump' {
    '== windows'; [SdInput]::Windows() | ForEach-Object { $f = $_.Split('|'); $p = (Get-Process -Id $f[3] -ErrorAction SilentlyContinue).ProcessName; "$_|$p" }
    '== probed'; ProbeWindows | ForEach-Object { $f = $_.Split('|'); $p = (Get-Process -Id $f[3] -ErrorAction SilentlyContinue).ProcessName; "$_|$p" }
    foreach ($h in Hosts) { '== host'; Dump $h 0 14 }
  }
  'dnd-off' { # the runner session starts with Do Not Disturb on (only priority banners pop up)
    [SdInput]::Chord(0x5B, 0x4E); Start-Sleep -Milliseconds 1500
    $btn = Find (Hosts) { param($e) $e.Current.AutomationId -eq 'DoNotDisturbButton' }
    if (-not $btn) { 'no DND button'; exit 0 }
    $tp = $null; [void]$btn.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)
    $before = "$($tp.Current.ToggleState)"
    if ($before -eq 'On') { $tp.Toggle(); Start-Sleep -Milliseconds 500 }
    "DND $before -> $($tp.Current.ToggleState)"
    [SdInput]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); [SdInput]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
  }
  'act' {
    $out = @{ where = 'popup' }
    $hasTitle = { param($e) $e.Current.Name -like ('*' + $s.title + '*') }
    $toast = $null
    for ($i = 0; $i -lt 20 -and -not $toast; $i++) { $toast = Find (Hosts) $hasTitle; if (-not $toast) { Start-Sleep -Milliseconds 500 } } # the popup can take a while
    if ($toast -and $toast.Current.ClassName -eq 'ListViewItem') { $toast = $null } # that's the center (left open): want the popup
    if (-not $toast) {
      if ($s.noCenter) { $out.error = 'no popup'; ($out | ConvertTo-Json -Compress); exit 0 }
      [SdInput]::Chord(0x5B, 0x4E); Start-Sleep -Milliseconds 1500 # Win+N: notification center
      $out.where = 'center'; $toast = Find (Hosts) $hasTitle
    }
    if (-not $toast) { $out.error = 'toast not found'; ($out | ConvertTo-Json -Compress); exit 0 }
    $out.toast = Desc $toast
    $hosts = Hosts
    if ($s.text) {
      $edit = Find $hosts { param($e) $e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit }
      if (-not $edit) { $out.error = 'no edit box'; ($out | ConvertTo-Json -Compress); exit 0 }
      $vp = $null; [void]$edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)
      $edit.SetFocus(); $vp.SetValue($s.text); $out.edit = Desc $edit
    }
    if ($s.button) {
      $btn = Find $hosts { param($e) $e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and ($e.Current.Name -match $s.button -or $e.Current.AutomationId -match $s.button) }
      if (-not $btn) { $out.error = "no button $($s.button)"; ($out | ConvertTo-Json -Compress); exit 0 }
      $out.button = Desc $btn; $out.how = ClickEl $btn
    } else { $out.how = ClickEl $toast }
    if ($out.where -eq 'center') { Start-Sleep -Milliseconds 300; [SdInput]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); [SdInput]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero) }
    ($out | ConvertTo-Json -Compress)
  }
}
`;

async function uia(mode: 'shot' | 'dump' | 'act' | 'dnd-off', spec?: object) {
	const file = join(tmp, `u${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify(spec ?? {}));
	const r = await ps(UIA_PS1, mode, file);
	if (r.code !== 0) throw new Error(`uia ${mode} failed: ${r.err || r.out}`);
	return r.out;
}
const SHOTS = process.env.WINDOWS_SHOTS ?? tmp;
const shot = async (name: string) => (await uia('shot', { path: join(SHOTS, name) }), log('screenshot', join(SHOTS, name)));

/** A real PNG as a data: URL (RGB gradient / disc), for the hero image and the logo. */
function pngDataUrl(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) {
	const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
	const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
	const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 4 + 1) + 1 + x * 4);
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', require('node:zlib').deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
	return `data:image/png;base64,${png.toString('base64')}`;
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

	const once = async (id: string, kind: string) => {
		await Bun.sleep(1500); // let a second path (Activated event + COM activator) deliver a duplicate if it would
		const rs = await app.platform<Array<{ id: string; kind: string }>>('notifications', 'responses');
		expect(rs.filter((r) => r.id === id && r.kind === kind)).toHaveLength(1);
	};

	test('real click on the toast (UI Automation + mouse) → page navigates to its url', async () => {
		await home();
		log(await uia('dnd-off'));
		await app.eval(`host.notifications.dismissAll()`); // one toast on screen at a time
		await Bun.sleep(1000);
		await show({ id: 'u1', title: 'Real click', body: 'Opens About', url: '/about', requireInteraction: true });
		await Bun.sleep(1500);
		await shot('toast-click.png');
		const r = await uia('act', { title: 'Real click' });
		log('act', r);
		if (JSON.parse(r).error) log(await uia('dump'));
		expect(JSON.parse(r).error).toBeUndefined();
		await app.waitFor(() => location.pathname === '/about', { timeout: 15_000 });
		await app.waitFor(() => /click u1/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
		await once('u1', 'click');
	});

	test('real reply: type in the toast input, press Send → kind reply with the text', async () => {
		await home();
		await show({ id: 'u2', title: 'Real reply', body: 'Type something', requireInteraction: true,
			actions: [{ id: 'reply', title: 'Reply', input: { placeholder: 'Type a reply', button: 'Send' } }] });
		await Bun.sleep(1500);
		await shot('toast-reply.png');
		const r = await uia('act', { title: 'Real reply', text: 'Typed for real', button: '^Send$' });
		log('act', r);
		if (JSON.parse(r).error) log(await uia('dump'));
		expect(JSON.parse(r).error).toBeUndefined();
		await app.waitFor(() => /reply u2 reply: Typed for real/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
		await once('u2', 'reply');
	});

	test('real dismiss (the toast close button) → kind dismiss (Dismissed/UserCanceled)', async () => {
		await home();
		await show({ id: 'u3', title: 'Real dismiss', body: 'Close me', requireInteraction: true, closeButtonText: 'Not now' });
		await Bun.sleep(1500);
		const next = app.nextEvent<{ id: string; kind: string }>('notificationResponse', (d) => d.id === 'u3', 20_000);
		const r = await uia('act', { title: 'Real dismiss', button: '^(Not now|Dismiss|Close|Clear this notification)$' });
		log('act', r);
		if (JSON.parse(r).error) log(await uia('dump'));
		expect(JSON.parse(r).error).toBeUndefined();
		expect((await next).kind).toBe('dismiss');
		await once('u3', 'dismiss');
	});

	test('real close (the popup X) → kind dismiss through the Dismissed event (UserCanceled)', async () => {
		await home();
		await show({ id: 'u4', title: 'Real close', body: 'Use the X' });
		const next = app.nextEvent<{ id: string; kind: string }>('notificationResponse', (d) => d.id === 'u4', 20_000);
		const r = await uia('act', { title: 'Real close', button: '^(DismissButton|Close|Dismiss notification)$', noCenter: true });
		log('act', r);
		if (JSON.parse(r).error) log(await uia('dump'));
		expect(JSON.parse(r).error).toBeUndefined();
		expect((await next).kind).toBe('dismiss');
		await once('u4', 'dismiss');
	});

	test('visual: rich toast (hero image, logo, buttons, critical) + taskbar badge → screenshots', async () => {
		const hero = pngDataUrl(364, 180, (x, y) => [255 - (x * 200) / 364, 62 + (y * 120) / 180, 0 + (x * 255) / 364, 255]);
		const logo = pngDataUrl(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 < 900 ? [255, 62, 0, 255] : [0, 0, 0, 0]));
		const rich = { subtitle: '#general', image: hero, icon: logo,
			actions: [{ id: 'reply', title: 'Reply', input: { placeholder: 'Type a reply', button: 'Send' } }, { id: 'delete', title: 'Delete', destructive: true }] };
		await show({ id: 'v2', title: 'Visual check', body: 'Hero image, logo override, input + buttons', ...rich });
		await Bun.sleep(2000);
		await shot('toast-rich.png');
		log(await uia('dump'));
		await app.eval(`host.notifications.dismiss('v2')`);
		// urgency critical = scenario "urgent": Windows 11 first asks the user ("Important Notification Request").
		await show({ id: 'v1', title: 'Visual check (critical)', body: 'Urgent scenario', urgency: 'critical', ...rich });
		await Bun.sleep(2000);
		await shot('toast-urgent-request.png');
		log('allow important:', await uia('act', { title: 'important notifications', button: '^Allow$' }));
		await Bun.sleep(1000);
		await show({ id: 'v1', title: 'Visual check (critical)', body: 'Urgent scenario, after Allow', urgency: 'critical', ...rich });
		await Bun.sleep(2000);
		await shot('toast-urgent.png');
		await app.eval(`host.notifications.dismiss('v1')`);
		await app.eval(`host.notifications.setBadge(7)`);
		await Bun.sleep(800);
		await shot('taskbar-badge.png');
		await app.eval(`host.notifications.setBadge(null)`);
	});

	test('cold start: the activator launches the app (-ToastActivated), the click reaches it', async () => {
		await app.close();
		closed = true;
		await Bun.sleep(2000);
		// Elevated clients ignore per-user COM classes: mirror the registration machine-wide when we can.
		const hklm = reg('copy', `HKCU\\Software\\Classes\\CLSID\\${CLSID}`, `HKLM\\Software\\Classes\\CLSID\\${CLSID}`, '/s', '/f').exitCode === 0;
		log('HKLM mirror of the activator:', hklm);
		const exe = join(APP, readdirSync(APP).find((f) => /\.exe$/i.test(f))!);
		let activation: Promise<number> | null = null;
		const t0 = Date.now();
		try {
			const connected = await launch({
				timeout: 45_000,
				connect: (url) => {
					// A COM-launched server doesn't get our environment (nor, on the runner, registry
					// changes made after logon): point the class's LocalServer32 at a wrapper that sets
					// SVELTE_DESKTOP_TEST and runs the registered command ("<exe>" -ToastActivated
					// -Embedding). The app writes the real value back when it starts.
					const cmd = join(tmp, 'toast-launch.cmd');
					writeFileSync(cmd, `@echo off\r\nset SVELTE_DESKTOP_TEST=${url}\r\n"${exe}" -ToastActivated %*\r\n`);
					const wrapper = `"${process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'}" /d /c "${cmd}"`;
					for (const root of hklm ? ['HKCU', 'HKLM'] : ['HKCU']) reg('add', `${root}\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`, '/ve', '/d', wrapper, '/f');
					activation = activate({ i: 'cold', p: payloadAbout }).then(() => Date.now() - t0);
					activation.then((ms) => log(`cold activation returned after ${ms} ms`), (e) => log('cold activation failed:', String(e)));
				},
			}).catch((e) => (log(String(e).split('\n')[0]), null));
			const ms = await activation;
			const procs = await ps(`Get-CimInstance Win32_Process -Filter "name='SvelteNotes.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`);
			log('processes:', procs.out);
			expect(ms).toBeGreaterThan(0); // Activate() returned: COM started the exe and reached its activator
			expect(procs.out).toContain('-ToastActivated');
			log('test channel:', connected ? 'connected' : 'not connected');
			expect(connected).not.toBeNull();
			app = connected!;
			closed = false;
			await app.waitFor(() => location.pathname === '/about', { timeout: 20_000 });
			await app.waitFor(() => /click cold/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
			const rs = await app.platform<Array<{ id: string; kind: string }>>('notifications', 'responses');
			expect(rs.find((r) => r.id === 'cold')).toMatchObject({ kind: 'click' });
			expect(await app.platform<unknown[]>('notifications', 'claim')).toHaveLength(0); // the page took it
			expect(reg('query', `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`).stdout.toString()).toContain(`"${exe}" -ToastActivated`); // restored by the app
		} finally {
			reg('add', `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`, '/ve', '/d', `"${exe}" -ToastActivated`, '/f');
			if (hklm) reg('delete', `HKLM\\Software\\Classes\\CLSID\\${CLSID}`, '/f');
		}
	});
});
