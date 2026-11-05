// The Windows build (KITOP_TARGET=windows bunx --bun vite build) on a Windows
// machine: WebView2 window, host global, WinRT toasts, the COM toast activator; then the rest of
// the shell (windows, menus, tray, dialogs, clipboard, views, DPI, jobs, MCP, relaunch) and web
// content control (permissions, downloads, printing, navigation policy, cookies).
//   WINDOWS_E2E=1 [WINDOWS_APP=<app folder>] bun test --timeout 120000 tests/windows.test.ts
// Skipped unless WINDOWS_E2E is set (CI: .github/workflows/windows.yml).
//
// Toast clicks are driven exactly like the shell does it: the app's toast activator
// (INotificationActivationCallback, CLSID derived from the identifier) is created
// over COM from PowerShell and Activate()d with the arguments the toast XML carries.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type AppHandle } from '@kitop/shell/test';
import { toastActivatorClsid } from '../../../packages/shell/src/build/package-windows.ts';

const ID = 'dev.kitop.notes';
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
  $seen.Values | Where-Object { $f = $_.Split('|'); $f[1] -notin @('KitopWindow', 'Progman', 'WorkerW', 'Shell_TrayWnd', 'CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass') }
}
function CenterOpen { @(ProbeWindows | Where-Object { $_.Split('|')[2] -eq 'Notification Center' }).Count -gt 0 }
function CloseCenter { # toast popups don't show while the notification center is open: click outside it
  [SdInput]::Click(300, 12); Start-Sleep -Milliseconds 900
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
    CloseCenter
  }
  'act' {
    $out = @{ where = 'popup' }
    $hasTitle = { param($e) $e.Current.Name -like ('*' + $s.title + '*') }
    $inPopup = { param($e) $e.Current.ClassName -eq 'FlexibleToastView' -and $e.Current.Name -like ('*' + $s.title + '*') }
    $toast = $null
    if (-not $s.center) { for ($i = 0; $i -lt 20 -and -not $toast; $i++) { $toast = Find (Hosts) $inPopup; if (-not $toast) { Start-Sleep -Milliseconds 500 } } } # the popup can take a while
    if ($s.center) { # the entry in the notification center: open it, expand collapsed groups, click the entry
      $out.where = 'center'
      [SdInput]::Chord(0x5B, 0x4E); Start-Sleep -Milliseconds 1500
      $inCenter = { param($e) $e.Current.ClassName -eq 'ListViewItem' -and $e.Current.Name -like ('*' + $s.title + '*') }
      for ($i = 0; $i -lt 10 -and -not $toast; $i++) {
        $toast = Find (Hosts) $inCenter
        if (-not $toast) {
          $more = Find (Hosts) { param($e) $e.Current.AutomationId -eq 'SeeMoreLessButton' -and $e.Current.Name -match '^\+' }
          if ($more) { $out.expanded = Desc $more; [void](ClickEl $more) }
          Start-Sleep -Milliseconds 700
        }
      }
      if ($toast -and $s.shot) { Shot $s.shot }
      if ($toast -and -not $s.button) {
        $title = $null
        foreach ($e in $toast.FindAll($TS::Descendants, $True_)) { if ($e.Current.AutomationId -eq 'Title' -and $e.Current.Name -like ('*' + $s.title + '*')) { $title = $e; break } }
        if ($title) { $toast = $title }
      }
    } elseif (-not $toast) {
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
    if ($out.where -eq 'center') { Start-Sleep -Milliseconds 300; CloseCenter }
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

	test('repeating schedules hand the OS 30 days of occurrences (≤ 128), so they keep firing while the app is closed', async () => {
		await show({ id: 'rep-h', title: 'Hourly', delay: 600_000, repeat: 'hour' });
		await show({ id: 'rep-d', title: 'Daily', delay: 600_000, repeat: 'day' });
		const t = await toasts();
		expect(t.scheduled.filter((x) => x === 'rep-h')).toHaveLength(128);
		const daily = t.scheduled.filter((x) => x === 'rep-d').length;
		expect(daily).toBeGreaterThanOrEqual(30);
		expect(daily).toBeLessThanOrEqual(31);
		expect((await pending()).filter((p) => p.id.startsWith('rep-')).map((p) => p.repeat).sort()).toEqual(['day', 'hour']);
		await app.eval(`host.notifications.dismissAll()`);
		await Bun.sleep(300);
		expect((await toasts()).scheduled).toHaveLength(0);
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
		await app.eval(`host.notifications.dismiss('v1')`);
		await show({ id: 'v1', title: 'Visual check (critical)', body: 'Urgent scenario, after Allow', urgency: 'critical', ...rich });
		await Bun.sleep(3500);
		await shot('toast-urgent.png');
		await app.eval(`host.notifications.dismiss('v1')`);
		await app.eval(`host.notifications.setBadge(7)`);
		await Bun.sleep(800);
		await shot('taskbar-badge.png');
		await app.eval(`host.notifications.setBadge(null)`);
	});

	test('real click on the entry in the notification center (expanded if grouped) → navigates, once', async () => {
		await home();
		await app.eval(`host.notifications.dismissAll()`);
		await show({ id: 'nc0', title: 'Older one', body: 'groups the app' });
		await show({ id: 'nc1', title: 'In the center', body: 'Click me there', url: '/about' });
		await Bun.sleep(9000); // the popups time out: the entries stay in the notification center
		const r = await uia('act', { title: 'In the center', center: true, shot: join(SHOTS, 'notification-center.png') });
		log('act', r);
		if (JSON.parse(r).error) log(await uia('dump'));
		expect(JSON.parse(r).error).toBeUndefined();
		await app.waitFor(() => location.pathname === '/about', { timeout: 15_000 });
		await app.waitFor(() => /click nc1/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
		await once('nc1', 'click');
		await app.eval(`host.notifications.dismissAll()`);
	});

	test('toastXml: the raw XML toast shows; a real click arrives as click, its button as action', async () => {
		await home();
		const xml = (n: string) => `<toast launch="custom-launch-${n}"><visual><binding template="ToastGeneric"><text>Custom XML ${n}</text><text>Raw toastXml</text></binding></visual><actions><action content="Custom button" arguments="custom-action"/></actions></toast>`;
		await show({ id: 'x1', title: 'ignored', toastXml: xml('one') });
		await Bun.sleep(1500);
		await shot('toast-xml.png');
		let next = app.nextEvent<{ id: string; kind: string; actionId: string | null }>('notificationResponse', (d) => d.id === 'x1', 20_000);
		let r = await uia('act', { title: 'Custom XML one' });
		log('act', r);
		expect(JSON.parse(r).error).toBeUndefined();
		expect(await next).toMatchObject({ kind: 'click', actionId: null });
		await once('x1', 'click');
		await show({ id: 'x2', title: 'ignored', toastXml: xml('two') });
		next = app.nextEvent('notificationResponse', (d) => d.id === 'x2', 20_000);
		r = await uia('act', { title: 'Custom XML two', button: '^Custom button$' });
		log('act', r);
		expect(JSON.parse(r).error).toBeUndefined();
		expect(await next).toMatchObject({ kind: 'action', actionId: 'custom-action' });
	});

	test('autoCancel: false — after a real click the entry stays (history + delivered)', async () => {
		await home();
		await show({ id: 'k1', title: 'Keep me', body: 'Stays after the click', autoCancel: false });
		const next = app.nextEvent<{ id: string; kind: string }>('notificationResponse', (d) => d.id === 'k1', 20_000);
		const r = await uia('act', { title: 'Keep me' });
		log('act', r);
		expect(JSON.parse(r).error).toBeUndefined();
		expect((await next).kind).toBe('click');
		await Bun.sleep(2000);
		expect((await toasts()).history).toContain('k1');
		expect((await delivered()).map((n) => n.id)).toContain('k1');
		await app.eval(`host.notifications.dismiss('k1')`);
	});

	const windows = () => app.platform<unknown[]>('window', 'list');
	const until = async (what: string, fn: () => Promise<boolean>, ms = 20_000) => {
		for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(250)) if (await fn().catch(() => false)) return;
		throw new Error(`timed out: ${what}`);
	};

	test('quitOnLastWindowClosed: false — closing the last window hides it (page kept); a toast click shows it, so does a second instance', async () => {
		await home();
		await show({ id: 'q1', title: 'Reopen me', body: 'No window open', url: '/about', requireInteraction: true });
		await app.eval('(window.__kept = 42, true)');
		const visible = () => app.platform<boolean>('window', 'isVisible', { windowId: 0 });
		await app.platform('window', 'close', { windowId: 0 });
		await until('window hidden', async () => !(await visible()), 10_000);
		expect(await windows()).toHaveLength(1); // hidden, not destroyed
		expect((await app.platform<{ identifier: string }>('app', 'getInfo')).identifier).toBe(ID); // still answering
		const r = await uia('act', { title: 'Reopen me' });
		log('act', r);
		expect(JSON.parse(r).error).toBeUndefined();
		await until('main window shown', visible);
		await app.waitFor(() => location.pathname === '/about', { timeout: 30_000 });
		await app.waitFor(() => /click q1/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
		expect(await app.eval('window.__kept')).toBe(42); // the same page: shown, not reloaded
		await shot('reopened-by-toast.png');
		// A second launch with the window hidden: the instance it hands over to shows it.
		await app.platform('window', 'close', { windowId: 0 });
		await until('window hidden again', async () => !(await visible()), 10_000);
		const exe = join(APP, readdirSync(APP).find((f) => /\.exe$/i.test(f))!);
		const second = Bun.spawn([exe], { stdout: 'ignore', stderr: 'ignore' });
		expect(await Promise.race([second.exited, Bun.sleep(20_000).then(() => 'running')])).toBe(0); // handed over and left
		await until('main window shown by the second instance', visible);
		expect(await app.eval('window.__kept')).toBe(42);
	});

	test('cold start: the activator launches the app (-ToastActivated), the click reaches it with its whole payload', async () => {
		// > 2 KB of data: the toast arguments carry the id only, the payload comes from the persisted record.
		const big = 'x'.repeat(3000);
		await app.platform('notifications', 'show', { id: 'cold', title: 'Cold', payload: JSON.stringify({ url: '/about', data: big }) });
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
					// KITOP_TEST and runs the registered command ("<exe>" -ToastActivated
					// -Embedding). The app writes the real value back when it starts.
					const cmd = join(tmp, 'toast-launch.cmd');
					writeFileSync(cmd, `@echo off\r\nset KITOP_TEST=${url}\r\n"${exe}" -ToastActivated %*\r\n`);
					const wrapper = `"${process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'}" /d /c "${cmd}"`;
					for (const root of hklm ? ['HKCU', 'HKLM'] : ['HKCU']) reg('add', `${root}\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`, '/ve', '/d', wrapper, '/f');
					activation = activate({ i: 'cold' }).then(() => Date.now() - t0);
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
			const rs = await app.platform<Array<{ id: string; kind: string; payload: string | null }>>('notifications', 'responses');
			expect(rs.find((r) => r.id === 'cold')).toMatchObject({ kind: 'click' });
			expect(JSON.parse(rs.find((r) => r.id === 'cold')!.payload!)).toEqual({ url: '/about', data: big });
			expect(await app.platform<unknown[]>('notifications', 'claim')).toHaveLength(0); // the page took it
			expect(reg('query', `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`).stdout.toString()).toContain(`"${exe}" -ToastActivated`); // restored by the app
		} finally {
			reg('add', `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`, '/ve', '/d', `"${exe}" -ToastActivated`, '/f');
			if (hklm) reg('delete', `HKLM\\Software\\Classes\\CLSID\\${CLSID}`, '/f');
		}
	});

	/** Start the app the way Windows does for a toast (the activator's LocalServer32), with the
	 *  test channel: `trigger` is the real click; a .cmd wrapper only adds KITOP_TEST. */
	async function coldLaunch(trigger: () => Promise<unknown>) {
		const exe = join(APP, readdirSync(APP).find((f) => /\.exe$/i.test(f))!);
		try {
			return await launch({
				timeout: 60_000,
				connect: (url) => {
					const cmd = join(tmp, 'toast-launch.cmd');
					writeFileSync(cmd, `@echo off\r\nset KITOP_TEST=${url}\r\n"${exe}" -ToastActivated %*\r\n`);
					reg('add', `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`, '/ve', '/d', `"${process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'}" /d /c "${cmd}"`, '/f');
					void trigger().then((r) => log('trigger', r), (e) => log('trigger failed', String(e)));
				},
			});
		} finally {
			reg('add', `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`, '/ve', '/d', `"${exe}" -ToastActivated`, '/f');
		}
	}

	test('real cold-start click: the app quits, the entry in the notification center is clicked → Windows starts it → the page navigates', async () => {
		await home();
		await show({ id: 'cc1', title: 'Cold click', body: 'Clicked after quitting', url: '/about' });
		await Bun.sleep(1500);
		await app.close();
		closed = true;
		await Bun.sleep(2000);
		app = await coldLaunch(() => uia('act', { title: 'Cold click', center: true, shot: join(SHOTS, 'cold-click-center.png') }));
		closed = false;
		await app.waitFor(() => location.pathname === '/about', { timeout: 30_000 });
		await app.waitFor(() => /click cc1/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
		expect(await app.platform<unknown[]>('notifications', 'claim')).toHaveLength(0);
		await once('cc1', 'click');
	});

	test('scheduled toast fires while the app is closed (ScheduledToastNotification); a real click cold-starts it', async () => {
		await home();
		expect(await show({ id: 'sc1', title: 'Scheduled cold', body: 'Fired while closed', url: '/about', delay: 20_000 })).toMatchObject({ scheduled: true });
		await app.close();
		closed = true;
		await Bun.sleep(26_000);
		const t = await toasts();
		log('while closed', t);
		expect(t.history).toContain('sc1');
		await shot('scheduled-while-closed.png');
		app = await coldLaunch(() => uia('act', { title: 'Scheduled cold', center: true }));
		closed = false;
		await app.waitFor(() => location.pathname === '/about', { timeout: 30_000 });
		await app.waitFor(() => /click sc1/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
		expect(await pending()).toHaveLength(0);
	});

	test('notifications.show conformance fixtures (native/notifications.fixtures.json)', async () => {
		const fx = await Bun.file(new URL('../../../packages/shell/native/notifications.fixtures.json', import.meta.url)).json();
		const withTime = (a: Record<string, unknown>) => (typeof a.at === 'number' ? { ...a, at: Date.now() + a.at } : a);
		for (const c of fx.valid) {
			const r = await app.platform<{ id: string; scheduled?: boolean }>('notifications', 'show', withTime(c.args)).catch((e: unknown) => e);
			expect({ name: c.name, r }).toMatchObject({ name: c.name, r: { id: c.args.id, scheduled: !!c.scheduled } });
		}
		for (const c of fx.invalid) {
			const e = await app.platform('notifications', 'show', withTime(c.args)).then(() => null, (err: { code?: string }) => err);
			expect({ name: c.name, code: (e as { code?: string } | null)?.code }).toEqual({ name: c.name, code: 'invalid_args' });
		}
		await app.platform('notifications', 'dismissAll');
	});

	test.skipIf(!process.env.WINDOWS_INSTALLER)('NSIS installer: silent install, Start Menu shortcut with AUMID + activator, toast, silent uninstall removes the identity', async () => {
		await app.close();
		closed = true;
		await Bun.sleep(1500);
		const dir = resolve(process.env.WINDOWS_INSTALLER!);
		const setup = join(dir, readdirSync(dir).find((f) => /-setup\.exe$/i.test(f))!);
		const install = Bun.spawnSync([setup, '/S']);
		log('installer exit', install.exitCode);
		const instDir = join(process.env.LOCALAPPDATA!, 'Programs', 'Svelte Notes');
		const lnk = join(process.env.APPDATA!, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Svelte Notes.lnk');
		await until('installed', async () => existsSync(join(instDir, 'SvelteNotes.exe')) && existsSync(lnk), 30_000);
		app = await launch({
			timeout: 60_000,
			connect: (url) => {
				Bun.spawn(['powershell.exe', '-NoProfile', '-Command', `Start-Process -FilePath '${lnk}'`], { env: { ...process.env, KITOP_TEST: url }, stdout: 'ignore', stderr: 'ignore' });
			},
		});
		closed = false;
		const exePath = await app.platform<string>('app', 'getPath', { name: 'exe' });
		log('running', exePath);
		expect(exePath.toLowerCase()).toContain('programs\\svelte notes');
		await Bun.sleep(1000);
		const props = await ps(String.raw`param([string]$Lnk)
$sh = New-Object -ComObject Shell.Application
$item = $sh.Namespace((Split-Path $Lnk)).ParseName((Split-Path $Lnk -Leaf))
@{ id = "$($item.ExtendedProperty('System.AppUserModel.ID'))"; clsid = "$($item.ExtendedProperty('System.AppUserModel.ToastActivatorCLSID'))" } | ConvertTo-Json -Compress`, lnk);
		log('shortcut', props.out, props.err);
		const sp = JSON.parse(props.out);
		expect(sp.id).toBe(ID);
		expect(sp.clsid.replace(/[{}]/g, '').toUpperCase()).toBe(CLSID.replace(/[{}]/g, ''));
		expect(reg('query', `HKCU\\Software\\Classes\\CLSID\\${CLSID}\\LocalServer32`).stdout.toString().toLowerCase()).toContain('programs\\svelte notes');
		await show({ id: 'inst', title: 'From the installed app', body: 'NSIS install' });
		await Bun.sleep(800);
		expect((await toasts()).history).toContain('inst');
		await shot('installed-app-toast.png');
		await app.eval(`host.notifications.dismissAll()`);
		await app.close();
		closed = true;
		await Bun.sleep(1500);
		Bun.spawnSync([join(instDir, 'Uninstall.exe'), '/S']);
		await until('uninstalled', async () => !existsSync(join(instDir, 'SvelteNotes.exe')) && !existsSync(lnk), 60_000);
		await until('identity removed', async () =>
			reg('query', `HKCU\\Software\\Classes\\AppUserModelId\\${ID}`).exitCode !== 0 && reg('query', `HKCU\\Software\\Classes\\CLSID\\${CLSID}`).exitCode !== 0, 30_000);
	});
});

// In a launch of their own: what's tested here leaves a page crashed, or a question on screen.
describe.skipIf(!process.env.WINDOWS_E2E)('windows: when the web process fails', () => {
	const killRenderers = () =>
		Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -match '--type=renderer' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);

	test('a page that keeps crashing: reloaded a few times, then a page that says so, with a way back', async () => {
		const app = await launch({ app: APP, timeout: 90_000 });
		// A call to a dead page may never come back.
		const check = <T,>(code: string) => Promise.race([app.eval<T>(code).catch(() => null), Bun.sleep(1000).then(() => null)]);
		const until = async (what: string, fn: () => Promise<boolean>) => {
			const end = Date.now() + 30_000;
			while (Date.now() < end) {
				if (await fn()) return;
				await Bun.sleep(200);
			}
			throw new Error(`timed out: ${what}`);
		};
		try {
			await app.waitFor('#counter', { timeout: 30_000 });
			for (let n = 1; n <= 3; n++) {
				await app.eval('window.__before_crash = 1');
				killRenderers();
				await until(`reload ${n}`, async () => (await check<boolean>(`window.__before_crash === undefined && !!document.querySelector('#counter')`)) === true);
			}
			killRenderers();
			await until('the page that says so', async () => (await check<string>('location.pathname')) === '/__desktop/page-crashed');
			expect(await app.text()).toContain('keeps crashing');
			await app.click('a');
			await app.waitFor('#counter', { timeout: 20_000 });
		} finally {
			await app.close();
		}
	}, 180_000);

	test('a page that is only slow is not reloaded: what is typed in it stays', async () => {
		const app = await launch({ app: APP, timeout: 90_000 });
		try {
			await app.waitFor('#counter', { timeout: 30_000 });
			await app.eval('window.__typed = 1');
			// Long enough for WebView2 to call it unresponsive. It used to reload right then.
			await app.eval('(() => { const end = Date.now() + 30000; while (Date.now() < end); })()');
			expect(await app.eval('window.__typed')).toBe(1);
		} finally {
			await app.close();
		}
	}, 180_000);
});

// ---------------------------------------------------------------------------
// Windows beyond notifications: what the shell does on a real desktop, and web content control.
// Each test is bounded and says what it found; a call that gets no answer fails its test, and
// once the app stops answering the rest fail at once instead of waiting their turn.

const INPUT_PS1 = String.raw`param([string]$Mode, [string]$Spec)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class SdWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (t.ToString() == title) { found = h; return false; }
      return true; }, IntPtr.Zero);
    return found;
  }
  public static void Chord(byte[] keys) {
    foreach (var k in keys) { keybd_event(k, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(30); }
    Array.Reverse(keys);
    foreach (var k in keys) { keybd_event(k, 0, 2, UIntPtr.Zero); System.Threading.Thread.Sleep(30); }
  }
}
"@
[void][SdWin]::SetProcessDPIAware()
$s = Get-Content -Raw $Spec | ConvertFrom-Json
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$True_ = [System.Windows.Automation.Condition]::TrueCondition
function Wait-Window($title) {
  for ($i = 0; $i -lt 40; $i++) { $h = [SdWin]::Find($title); if ($h -ne [IntPtr]::Zero) { return $h }; Start-Sleep -Milliseconds 250 }
  throw "no window titled '$title'"
}
function Rect($h) { $r = New-Object SdWin+RECT; [void][SdWin]::GetWindowRect($h, [ref]$r); return $r }
function Front($h) { [SdWin]::Chord([byte[]]@(0x87)); [void][SdWin]::SetForegroundWindow($h); Start-Sleep -Milliseconds 300 } # F24: any input lifts the foreground lock; Alt would open a menu bar
function Press($x, $y) { [void][SdWin]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 120; [SdWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero) }
function Release { [SdWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
function Descendant($h, [scriptblock]$pred) {
  $root = if ($h -is [System.Windows.Automation.AutomationElement]) { $h } else { $A::FromHandle($h) }
  $last = ''
  for ($i = 0; $i -lt 40; $i++) {
    foreach ($e in $root.FindAll($TS::Descendants, $True_)) { try { if (& $pred $e) { return $e } } catch { $last = $_.Exception.Message } }
    Start-Sleep -Milliseconds 250
  }
  $seen = @($root.FindAll($TS::Descendants, $True_) | ForEach-Object { "$($_.Current.ControlType.ProgrammaticName) '$($_.Current.Name)' #$($_.Current.AutomationId)" }) -join '; '
  throw "nothing matches in the window. Saw: $seen. Last error: $last"
}
# The runner's UI Automation shows standard Win32 controls as panes with no patterns: a button takes BM_CLICK.
function Invoke-El($e) {
  $p = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return }
  $w = $e.Current.NativeWindowHandle
  if ($w -eq 0) { throw "'$($e.Current.Name)' has no pattern and no window" }
  [void][SdWin]::PostMessage([IntPtr]$w, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
}
switch ($Mode) {
  'rect' { $h = Wait-Window $s.title; $r = Rect $h; @{ x = $r.L; y = $r.T; width = $r.R - $r.L; height = $r.B - $r.T; dpi = [SdWin]::GetDpiForWindow($h) } | ConvertTo-Json -Compress }
  'post-close' { $h = Wait-Window $s.title; [void][SdWin]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero); 'posted' }
  'close-if-any' { $h = [SdWin]::Find($s.title); if ($h -ne [IntPtr]::Zero) { [void][SdWin]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero); 'closed' } else { 'none' } }
  'click' { $h = Wait-Window $s.title; Front $h; $r = Rect $h; $n = if ($s.times) { $s.times } else { 1 }; for ($i = 0; $i -lt $n; $i++) { Press ($r.L + $s.dx) ($r.T + $s.dy); Release; Start-Sleep -Milliseconds 90 }; 'clicked' }
  'drag' { # The press goes through the page, which then starts the move loop: leave it the time.
    $h = Wait-Window $s.title; Front $h; $r = Rect $h
    Press ($r.L + $s.dx) ($r.T + $s.dy); Start-Sleep -Milliseconds 700
    for ($i = 1; $i -le 12; $i++) { [void][SdWin]::SetCursorPos(($r.L + $s.dx + ($s.byX * $i / 12)), ($r.T + $s.dy + ($s.byY * $i / 12))); Start-Sleep -Milliseconds 40 }
    Start-Sleep -Milliseconds 200; Release; 'dragged'
  }
  'keys' { if ($s.title) { Front (Wait-Window $s.title) }; [SdWin]::Chord([byte[]]@($s.keys)); 'pressed' }
  'dialog-button' { $h = Wait-Window $s.title; $b = Descendant $h { param($e) $e.Current.AutomationId -like 'CommandButton_*' -and $e.Current.Name -eq $s.button }; Invoke-El $b; 'pressed' }
  'file-dialog' { # The Edit in the file name box of the common dialog (WM_SETTEXT), then its default button.
    $h = Wait-Window $s.title
    $box = Descendant $h { param($e) $e.Current.AutomationId -eq 'FileNameControlHost' }
    $edit = Descendant $box { param($e) $e.Current.ClassName -eq 'Edit' }
    [void][SdWin]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, $s.path)
    Start-Sleep -Milliseconds 300
    $ok = Descendant $h { param($e) $e.Current.AutomationId -eq '1' }
    Invoke-El $ok; 'chosen'
  }
}
`;

async function win(mode: string, spec: object) {
	const file = join(tmp, `w${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify(spec));
	const r = await ps(INPUT_PS1, mode, file);
	if (r.code !== 0) throw new Error(`${mode} failed: ${r.err || r.out}`);
	return r.out;
}

const within = <T>(ms: number, what: string, p: Promise<T>) =>
	Promise.race([p, Bun.sleep(ms).then(() => { throw Object.assign(new Error(`${what}: no answer within ${ms} ms`), { code: 'timeout' }); })]);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const near = (a: number, b: number, by = 2) => Math.abs(a - b) <= by;
const Pdf = { pages: (b: Buffer) => (b.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length, box: (b: Buffer) => /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)/.exec(b.toString('latin1'))?.slice(1).map(Number) };

describe.skipIf(!process.env.WINDOWS_E2E)('windows: beyond notifications', () => {
	let app: AppHandle;
	let stopped = ''; // the test where the app stopped answering
	const dir = process.platform === 'win32' ? mkdtempSync(join(tmpdir(), 'sd-web-')) : '';
	const hits = new Map<string, number>();
	let ext = ''; // another origin than the app's, on this machine
	let closedPort = 0;
	let slowUrl = '';
	const SLOW_SIZE = 40 * 32 * 1024;

	const op = <T = any>(service: string, name: string, args: Record<string, unknown> = {}, ms = 20_000) =>
		within(ms, `${service}.${name}`, app.platform<T>(service, name, args));
	/** The error code of a call that has to fail ('ok' if it didn't). */
	const code = (service: string, name: string, args: Record<string, unknown> = {}) =>
		op(service, name, args).then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
	const check = (name: string, fn: () => Promise<unknown>, ms = 60_000) =>
		test(name, async () => {
			if (stopped) throw new Error(`not run: the app stopped answering in "${stopped}"`);
			try {
				await fn();
			} catch (e) {
				if ((e as { code?: string }).code === 'timeout') {
					stopped = name;
					log('STOPPED ANSWERING', name, String(e));
					log('app output', app?.stdout?.slice(-2000));
				}
				throw e;
			}
		}, ms);
	const until = async (what: string, fn: () => Promise<boolean>, ms = 10_000) => {
		for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (await fn().catch(() => false)) return;
		throw new Error(`timed out: ${what}`);
	};
	const inView = <T = any>(id: string, code: string, ms = 20_000) => op<T>('view', 'executeJavaScript', { id, code }, ms);
	const openView = async (id: string, path: string) => {
		const loaded = app.nextEvent('viewLoaded', (e: { id: string }) => e.id === id, 20_000);
		await op('view', 'create', { id, windowId: 0, url: ext + path, bounds: { x: 0, y: 0, width: 400, height: 300 } });
		await loaded;
	};
	const closeView = (id: string) => op('view', 'destroy', { id }).catch(() => {});
	const mainTitle = 'E2E main window';
	const home = async () => {
		await op('window', 'setTitle', { windowId: 0, title: mainTitle });
		await op('window', 'show', { windowId: 0 });
		if ((await app.eval<string>('location.pathname')) !== '/') await app.goto('/');
		await app.waitFor('#counter', { timeout: 20_000 });
	};

	beforeAll(async () => {
		expect(existsSync(APP)).toBe(true);
		// The suite before closes its app; a copy still going would take this launch for a second instance.
		const left = await ps(`Get-CimInstance Win32_Process -Filter "name='SvelteNotes.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`);
		if (left.out) log('stopped a copy still running', left.out);
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			idleTimeout: 60,
			fetch(req) {
				const { pathname } = new URL(req.url);
				hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
				const html = (body: string) => new Response(`<!doctype html><title>${pathname}</title>${body}`, { headers: { 'content-type': 'text/html' } });
				const attachment = { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' };
				if (pathname === '/file.txt') return new Response('downloaded body', { headers: attachment });
				if (pathname === '/inline.txt') return new Response('not an attachment', { headers: { 'content-type': 'text/plain' } });
				if (pathname === '/frame') return html('<iframe src="/framed"></iframe>');
				if (pathname === '/blocked') log('a request for /blocked', req.method, Object.fromEntries(req.headers));
				return html(`<p>${pathname}</p>`);
			},
		});
		ext = `http://127.0.0.1:${server.port}`;
		// Bun.serve drops the Content-Length of a streamed response, and the size is part of what's checked.
		const chunk = new Uint8Array(32 * 1024).fill(97);
		const slow = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="slow.bin"', 'content-length': String(SLOW_SIZE) });
			let sent = 0;
			const timer = setInterval(() => {
				if (sent++ < 40) return void res.write(chunk);
				clearInterval(timer);
				res.end();
			}, 100);
			res.on('close', () => clearInterval(timer));
		});
		await new Promise<void>((done) => slow.listen(0, '127.0.0.1', done));
		slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/slow.bin`;
		const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
		closedPort = gone.port!;
		gone.stop(true);
		app = await launch({ app: APP, timeout: 90_000 });
		await app.waitFor('#counter', { timeout: 30_000 });
		await home();
	}, 150_000);
	afterAll(async () => {
		await app?.close().catch(() => {});
	}, 30_000);

	check('report: the running platform and every operation it registers', async () => {
		const report = await op<{ platform: string; arch: string; services: Record<string, Record<string, string>> }>('capabilities', 'describe');
		log('diagnostics', await op('diagnostics', 'info'));
		for (const [service, ops] of Object.entries(report.services)) log('ops', service, Object.keys(ops).join(' '));
		expect(report.platform).toBe('windows');
		for (const name of ['configurePolicy', 'respondPolicy', 'setPermissionDecision', 'setNavigationPolicy', 'navigationDecision', 'download', 'decideDownload', 'pauseDownload', 'resumeDownload', 'listDownloads', 'printToPDF', 'print', 'getPrinters'])
			expect({ name, status: report.services.webview?.[name] }).toEqual({ name, status: 'implemented' });
		for (const name of ['list', 'capabilities', 'cookiesGet', 'cookiesSet', 'cookiesRemove', 'watchCookies'])
			expect({ name, status: report.services.sessions?.[name] }).toEqual({ name, status: 'implemented' });
		// What isn't finished says so, instead of half-working.
		expect(await code('sessions', 'create', { id: 'x', persistent: false })).toBe('unsupported');
		expect(await code('webview', 'setContentRules', { id: 'x', rules: [] })).toBe('unsupported');
		expect(await code('webview', 'configurePolicy', { kind: 'auth', enabled: true })).toBe('unsupported');
	});

	// ── windows ─────────────────────────────────────────────────────────────

	check('window: a second window, its page, labels, closed', async () => {
		const created = app.nextEvent<{ label: string; windowId: number }>('created', (e) => e.label === 'e2e-second', 15_000);
		const made = await op<{ windowId: number; label: string }>('window', 'create', { label: 'e2e-second', path: '/about', x: 80, y: 80, width: 640, height: 480 });
		expect((await created).windowId).toBe(made.windowId);
		expect(made.windowId).not.toBe(0);
		await until('its page', async () => (await op('webview', 'executeJavaScript', { windowId: made.windowId, code: 'location.pathname' })) === '/about', 20_000);
		expect(await op<unknown[]>('window', 'list')).toHaveLength(2);
		expect(await op('window', 'get', { label: 'e2e-second' })).toMatchObject({ windowId: made.windowId, label: 'e2e-second' });
		expect(await op('window', 'get', { label: 'nobody' })).toBeNull();
		expect(await code('window', 'create', { label: 'e2e-second', path: '/' })).toBe('invalid_args');
		expect(await code('window', 'getTitle', { windowId: 99999 })).toBe('invalid_args');
		const closed = app.nextEvent('closed', (e: { windowId: number }) => e.windowId === made.windowId, 15_000);
		await op('window', 'close', { windowId: made.windowId });
		await closed;
		await until('it left the list', async () => (await op<unknown[]>('window', 'list')).length === 1);
	});

	check('window: bounds, size, position, limits, in DIPs against what Win32 reports', async () => {
		const id = { windowId: 0 };
		await op('window', 'setBounds', { ...id, x: 100, y: 60, width: 800, height: 600 });
		const { bounds } = await op<{ bounds: { x: number; y: number; width: number; height: number } }>('window', 'getBounds', id);
		expect([near(bounds.x, 100), near(bounds.y, 60), near(bounds.width, 800), near(bounds.height, 600)]).toEqual([true, true, true, true]);
		const real = JSON.parse(await win('rect', { title: mainTitle }));
		const scale = await op<number>('window', 'getScaleFactor', id);
		log('Win32 rect', real, 'scale', scale);
		expect(scale).toBeCloseTo(real.dpi / 96, 3);
		expect(near(real.width / scale, 800)).toBe(true);
		expect(near(real.x / scale, 100)).toBe(true);
		await op('window', 'setPosition', { ...id, x: 140, y: 90 });
		expect(near((await op<{ x: number }>('window', 'getPosition', id)).x, 140)).toBe(true);
		await op('window', 'setSize', { ...id, width: 700, height: 500 });
		const size = await op<{ width: number; height: number }>('window', 'getSize', id);
		expect(near(size.width, 700)).toBe(true);
		expect(near(await app.eval<number>('innerWidth'), 700, 4)).toBe(true); // the page follows
		const moved = app.nextEvent('boundsChanged', (e: { windowId: number }) => e.windowId === 0, 8000);
		await op('window', 'center', id);
		await moved;
		// Limits: desktop.config's minWidth, then ones set now.
		await op('window', 'setMinSize', { ...id, width: 600, height: 450 });
		expect(await op('window', 'getMinSize', id)).toEqual({ width: 600, height: 450 });
		await op('window', 'setSize', { ...id, width: 300, height: 200 });
		expect((await op<{ width: number }>('window', 'getSize', id)).width).toBeGreaterThanOrEqual(598);
		await op('window', 'setMinSize', { ...id, width: 520, height: 400 });
		await op('window', 'setBounds', { ...id, x: 100, y: 60, width: 900, height: 650 });
	});

	check('window: minimize, maximize, fullscreen, hide, each undone', async () => {
		const id = { windowId: 0 };
		await op('window', 'minimize', id);
		await until('minimized', async () => (await op<{ minimized: boolean }>('window', 'isMinimized', id)).minimized);
		await op('window', 'unminimize', id);
		await until('restored', async () => !(await op<{ minimized: boolean }>('window', 'isMinimized', id)).minimized);
		await op('window', 'maximize', id);
		await until('maximized', () => op<boolean>('window', 'isMaximized', id));
		expect((await op<{ state: string }>('window', 'getBounds', id)).state).toBe('maximized');
		await op('window', 'unmaximize', id);
		await until('unmaximized', async () => !(await op<boolean>('window', 'isMaximized', id)));
		const before = (await op<{ bounds: { width: number } }>('window', 'getBounds', id)).bounds;
		const display = await op<{ bounds: { width: number; height: number } }>('screen', 'getDisplayNearestWindow', id);
		await op('window', 'setFullscreen', { ...id, fullscreen: true });
		await until('fullscreen', () => op<boolean>('window', 'isFullscreen', id));
		expect(near((await op<{ bounds: { width: number } }>('window', 'getBounds', id)).bounds.width, display.bounds.width)).toBe(true);
		await op('window', 'setFullscreen', { ...id, fullscreen: false });
		await until('windowed', async () => !(await op<boolean>('window', 'isFullscreen', id)));
		expect(near((await op<{ bounds: { width: number } }>('window', 'getBounds', id)).bounds.width, before.width)).toBe(true);
		await op('window', 'hide', id);
		await until('hidden', async () => !(await op<boolean>('window', 'isVisible', id)));
		await op('window', 'show', id);
		await until('shown', () => op<boolean>('window', 'isVisible', id));
		log('focused after show', await op('window', 'isFocused', id));
	});

	check('window: the close button with a veto armed stays open and says so; window.close goes through', async () => {
		const made = await op<{ windowId: number }>('window', 'create', { label: 'e2e-veto', path: '/about', width: 500, height: 400 });
		const id = { windowId: made.windowId };
		const title = 'E2E veto window';
		await until('its page', async () => (await op('webview', 'executeJavaScript', { ...id, code: 'document.readyState' })) === 'complete', 20_000);
		await op('window', 'setTitle', { ...id, title });
		expect(await op('window', 'setCloseVeto', { ...id, enabled: true })).toEqual({ armed: true });
		expect(await op('window', 'hasCloseVeto', id)).toBe(true);
		const asked = app.nextEvent('willClose', (e: { windowId: number }) => e.windowId === made.windowId, 15_000);
		await win('post-close', { title }); // WM_CLOSE, what the X sends
		await asked;
		expect((await op<Array<{ windowId: number }>>('window', 'list')).some((w) => w.windowId === made.windowId)).toBe(true);
		const closed = app.nextEvent('closed', (e: { windowId: number }) => e.windowId === made.windowId, 15_000);
		await op('window', 'close', id);
		await closed;
	});

	check('window: z-order and chrome flags read back; ops macOS has say unsupported', async () => {
		const id = { windowId: 0 };
		await op('window', 'setAlwaysOnTop', { ...id, enabled: true });
		expect(await op('window', 'isAlwaysOnTop', id)).toBe(true);
		await op('window', 'setAlwaysOnTop', { ...id, enabled: false });
		expect(await op('window', 'isAlwaysOnTop', id)).toBe(false);
		await op('window', 'setOpacity', { ...id, opacity: 0.5 });
		expect(await op('window', 'getOpacity', id)).toEqual({ opacity: 0.5 });
		await op('window', 'setOpacity', { ...id, opacity: 1 });
		await op('window', 'setResizable', { ...id, enabled: false });
		expect(await op('window', 'isResizable', id)).toEqual({ resizable: false });
		await op('window', 'setResizable', { ...id, enabled: true });
		await op('window', 'setContentProtected', { ...id, enabled: true });
		expect(await op('window', 'isContentProtected', id)).toEqual({ contentProtected: true });
		await op('window', 'setContentProtected', { ...id, enabled: false });
		expect(await code('window', 'setTheme', { ...id, theme: 'bogus' })).toBe('invalid_args');
		await op('window', 'setTheme', { ...id, theme: 'dark' });
		expect(await op('window', 'getTheme', id)).toBe('dark');
		await op('window', 'setTheme', { ...id, theme: 'system' });
		expect(await code('window', 'setVibrancy', { ...id, material: 'sidebar' })).toBe('unsupported');
	});

	check('title bar: hiddenInset is frameless with no native controls; the style switches at runtime', async () => {
		const id = { windowId: 0 };
		expect(await op('window', 'getTitleBarStyle', id)).toEqual({ style: 'hiddenInset', frameless: true }); // desktop.config
		const mode = () => app.eval<{ bar: string; controls: string }>(`({ bar: document.documentElement.dataset.desktopTitlebar, controls: document.documentElement.dataset.desktopControls })`);
		expect(await mode()).toEqual({ bar: 'hiddenInset', controls: 'none' });
		await op('window', 'setTitleBarStyle', { ...id, style: 'default' });
		expect(await op('window', 'getTitleBarStyle', id)).toEqual({ style: 'default', frameless: false });
		await until('the page knows', async () => (await mode()).controls === 'native');
		await op('window', 'setTitleBarStyle', { ...id, style: 'hiddenInset' });
		expect(await code('window', 'setTitleBarStyle', { ...id, style: 'bogus' })).toBe('invalid_args');
		await until('frameless again', async () => (await mode()).controls === 'none');
	});

	check('title bar: a real drag on a drag region moves the window; a double click maximizes it', async () => {
		const id = { windowId: 0 };
		await op('window', 'setBounds', { ...id, x: 100, y: 100, width: 800, height: 600 });
		await app.eval(`(() => { const d = document.createElement('div'); d.id = 'e2e-drag'; d.dataset.desktopDrag = ''; d.style.cssText = 'position:fixed;left:0;right:0;top:0;height:60px;z-index:99999;background:#f0f'; document.body.append(d); })()`);
		try {
			const before = (await op<{ bounds: { x: number; y: number } }>('window', 'getBounds', id)).bounds;
			await win('drag', { title: mainTitle, dx: 300, dy: 40, byX: 120, byY: 70 });
			await Bun.sleep(300);
			const after = (await op<{ bounds: { x: number; y: number } }>('window', 'getBounds', id)).bounds;
			log('drag', before, '->', after);
			await shot('titlebar-drag.png');
			expect(after.x).toBeGreaterThan(before.x + 40);
			expect(after.y).toBeGreaterThan(before.y + 20);
			await win('click', { title: mainTitle, dx: 300, dy: 40, times: 2 });
			await until('maximized by the double click', () => op<boolean>('window', 'isMaximized', id), 5000);
			await op('window', 'unmaximize', id);
		} finally {
			await app.eval(`document.querySelector('#e2e-drag')?.remove()`).catch(() => {});
			await op('window', 'setBounds', { ...id, x: 100, y: 60, width: 900, height: 650 }).catch(() => {});
		}
	});

	// ── menus, tray, popover ────────────────────────────────────────────────

	check('menu: bar set, read, updated; an accelerator pressed for real and a popup driven by keys reach menuAction', async () => {
		const previous = await op('menu', 'getAppMenu');
		try {
			expect(await code('menu', 'setAppMenu', { menus: [{ name: 'Bad', items: [{ label: 'x', accelerator: 'NotAKey+++' }] }] })).toBe('invalid_args');
			await op('menu', 'setAppMenu', { menus: [{ name: 'E2E', items: [
				{ label: 'Say hi', id: 'e2e-hi', accelerator: 'Ctrl+Shift+F8' },
				{ type: 'separator' },
				{ label: 'Check', id: 'e2e-check', type: 'checkbox', checked: false },
			] }] });
			const bar = await op<Array<{ label?: string; submenu?: Array<{ id?: string }> }>>('menu', 'items');
			log('menu items', JSON.stringify(bar));
			expect(bar.flatMap((m) => m.submenu ?? []).some((i) => i.id === 'e2e-hi')).toBe(true);
			await op('menu', 'update', { id: 'e2e-check', label: 'Checked', checked: true, enabled: false });
			expect(await op('menu', 'get', { id: 'e2e-check' })).toEqual({ id: 'e2e-check', text: 'Checked', enabled: false, checked: true });
			expect(await code('menu', 'update', { id: 'nobody', label: 'x' })).toBe('invalid_args');
			expect(await op('menu', 'insert', { name: 'Extra', items: [{ label: 'One', id: 'e2e-extra' }] })).toEqual({ inserted: true, name: 'Extra' });
			expect(await op('menu', 'get', { id: 'e2e-extra' })).toMatchObject({ text: 'One' });
			expect(await op('menu', 'remove', { name: 'Extra' })).toEqual({ removed: true, name: 'Extra' });

			await app.eval(`(() => { const d = document.createElement('div'); d.id = 'e2e-cover'; d.style.cssText = 'position:fixed;inset:0;z-index:99999'; document.body.append(d); })()`);
			await win('click', { title: mainTitle, dx: 400, dy: 300 }); // the page has the keyboard
			await app.eval(`document.querySelector('#e2e-cover')?.remove()`);
			const hi = app.nextEvent('menuAction', (e: { id: string }) => e.id === 'e2e-hi', 10_000);
			await win('keys', { title: mainTitle, keys: [0x11, 0x10, 0x77] }); // Ctrl+Shift+F8
			await hi;

			const picked = app.nextEvent('menuAction', (e: { id: string }) => e.id === 'e2e-popup', 15_000);
			const popup = op('menu', 'popup', { items: [{ label: 'Popup item', id: 'e2e-popup' }] }, 25_000);
			await Bun.sleep(1200);
			await win('keys', { keys: [0x28] }); // Down
			await win('keys', { keys: [0x0d] }); // Enter
			await picked;
			expect(await popup).toEqual({ dismissed: true });
		} finally {
			await win('keys', { keys: [0x1b] }).catch(() => {}); // a popup left open
			await op('menu', 'setAppMenu', { menus: Array.isArray(previous) ? previous : [] }).catch(() => {});
		}
	});

	check('tray and popover: the app\'s icon, its bound popover opened by a click, tooltip and menu changed, removed', async () => {
		await until('the app set its tray', () => op<boolean>('tray', 'isSet'), 15_000);
		log('tray rect', await op('tray', 'getBounds'));
		await until('the popover is ready', async () => !!(await op<Array<{ id: string; ready: boolean }>>('popover', 'list')).find((p) => p.id === 'status-item')?.ready, 20_000);
		const inside = await op<{ text: string; id: string }>('webview', 'executeJavaScript', { popoverId: 'status-item', code: `({ text: document.body.innerText, id: window.__shellPopover.id })` });
		expect(inside.id).toBe('status-item');
		expect(inside.text).toContain('Quick note');
		const shown = app.nextEvent('popoverShown', (e: { id: string }) => e.id === 'status-item', 10_000);
		const clicked = app.nextEvent('trayClick', undefined, 10_000);
		expect(await op('tray', 'performClick')).toEqual({ clicked: true });
		await Promise.all([shown, clicked]);
		await shot('tray-popover.png');
		expect(await op('popover', 'isShown', { id: 'status-item' })).toBe(true);
		const hidden = app.nextEvent('popoverHidden', (e: { id: string }) => e.id === 'status-item', 10_000);
		await op('popover', 'hide', { id: 'status-item' });
		await hidden;
		expect(await op('tray', 'set', { tooltip: 'E2E tooltip', menu: [{ label: 'Tray item', id: 'e2e-tray' }] })).toEqual({ set: true });
		expect(await op('tray', 'set', { menu: null })).toEqual({ set: true });
		expect(await code('tray', 'set', { badgeColor: 'not-a-color' })).toBe('invalid_args');
		expect(await op('tray', 'remove')).toEqual({ removed: true });
		expect(await op('tray', 'isSet')).toBe(false);
		expect(await code('tray', 'performClick')).toBe('unavailable');
		expect(await op('tray', 'set', { tooltip: 'Svelte Notes', popover: 'status-item' })).toEqual({ set: true });
	});

	// ── dialogs ─────────────────────────────────────────────────────────────

	check('dialog: a message box answered by pressing its second button', async () => {
		const title = 'E2E message box';
		const reply = op('dialog', 'showMessageBox', { windowId: 0, title, message: 'Which one?', buttons: ['First', 'Second', 'Third'], cancelId: 2 }, 30_000);
		try {
			await Bun.sleep(500);
			await shot('dialog-message.png');
			expect(await win('dialog-button', { title, button: 'Second' })).toContain('pressed');
			expect(await reply).toEqual({ response: 1, canceled: false });
		} finally {
			await win('close-if-any', { title }).catch(() => {});
			await reply.catch(() => {});
		}
	});

	check('dialog: a confirm answers by its buttons', async () => {
		const title = 'E2E confirm';
		const reply = op('dialog', 'showConfirm', { windowId: 0, title, message: 'Sure?' }, 30_000);
		try {
			await Bun.sleep(500);
			await win('dialog-button', { title, button: 'Cancel' });
			expect(await reply).toBe(false);
		} finally {
			await win('close-if-any', { title }).catch(() => {});
			await reply.catch(() => {});
		}
	});

	check('dialog: save and open dialogs, a path typed in the real dialog, and a cancel', async () => {
		const target = join(dir, 'chosen.txt');
		let title = 'E2E save';
		let reply = op<{ canceled: boolean; path: string | null }>('dialog', 'showSaveDialog', { windowId: 0, title, defaultPath: dir }, 40_000);
		try {
			await Bun.sleep(1000);
			await shot('dialog-save.png');
			await win('file-dialog', { title, path: target });
			const saved = await reply;
			log('save dialog', saved);
			expect(saved.canceled).toBe(false);
			expect(saved.path!.toLowerCase()).toBe(target.toLowerCase());
		} finally {
			await win('close-if-any', { title }).catch(() => {});
			await reply.catch(() => {});
		}
		writeFileSync(target, 'chosen');
		title = 'E2E open';
		const opened = op<{ canceled: boolean; paths: string[] }>('dialog', 'showOpenDialog', { windowId: 0, title, defaultPath: dir }, 40_000);
		try {
			await Bun.sleep(1000);
			await win('file-dialog', { title, path: target });
			expect((await opened).paths.map((p) => p.toLowerCase())).toEqual([target.toLowerCase()]);
		} finally {
			await win('close-if-any', { title }).catch(() => {});
			await opened.catch(() => {});
		}
		title = 'E2E cancel';
		reply = op('dialog', 'showSaveDialog', { windowId: 0, title }, 40_000);
		await Bun.sleep(1000);
		await win('post-close', { title });
		expect(await reply).toEqual({ canceled: true, path: null });
	}, 120_000);

	// ── clipboard ───────────────────────────────────────────────────────────

	check('clipboard: text across processes, html, rtf, image, files, clear', async () => {
		const text = 'héllo wörld ✓';
		await op('clipboard', 'writeText', { text });
		expect(await op('clipboard', 'readText')).toBe(text);
		// Another process, not this app's own round trip. (Scripts stay ASCII: PowerShell 5 reads them as ANSI.)
		const read = await ps(`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))`);
		expect(read.out).toBe(b64(text));
		const written = await ps(String.raw`param([string]$V)
Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($V)))`, b64('from powershell é'));
		expect(written.code).toBe(0);
		expect((await op<string>('clipboard', 'readText')).trim()).toBe('from powershell é');
		await op('clipboard', 'writeHtml', { html: '<b>bold</b>' });
		expect(await op('clipboard', 'readHtml')).toContain('<b>bold</b>');
		expect(await op('clipboard', 'has', { format: 'text/html' })).toBe(true);
		await op('clipboard', 'writeRtf', { rtf: '{\\rtf1 hi}' });
		expect(await op('clipboard', 'readRtf')).toContain('\\rtf1');
		const png = pngDataUrl(4, 3, () => [10, 20, 30, 255]).split(',')[1]!;
		await op('clipboard', 'writeImage', { bytes: png });
		const image = await op<{ bytes: string; format: string }>('clipboard', 'readImage');
		const decoded = Buffer.from(image.bytes, 'base64');
		expect(image.format).toBe('png');
		expect([decoded.readUInt32BE(16), decoded.readUInt32BE(20)]).toEqual([4, 3]);
		expect(await code('clipboard', 'writeImage', { bytes: 'not an image' })).toBe('invalid_args');
		const file = join(dir, 'clip.txt');
		writeFileSync(file, 'x');
		await op('clipboard', 'writePaths', { paths: [file] });
		expect(await op('clipboard', 'readPaths')).toEqual([file]);
		expect(await op('clipboard', 'availableFormats')).toContain('files');
		await op('clipboard', 'clear');
		expect(await op('clipboard', 'availableFormats')).toEqual([]);
		expect(await op('clipboard', 'readPaths')).toBeNull();
	});

	// ── views ───────────────────────────────────────────────────────────────

	check('view: another site in the window, its events, bounds, visibility, what it can reach', async () => {
		const title = app.nextEvent('viewTitle', (e: { id: string; title: string }) => e.id === 'e2e-view' && e.title === '/one', 20_000);
		const loaded = app.nextEvent('viewLoaded', (e: { id: string; url: string }) => e.id === 'e2e-view', 20_000);
		expect(await op('view', 'create', { id: 'e2e-view', windowId: 0, url: `${ext}/one`, bounds: { x: 10, y: 20, width: 400, height: 300 } })).toEqual({ id: 'e2e-view', windowId: 0 });
		expect((await loaded).url).toBe(`${ext}/one`);
		await title;
		await shot('view-external.png');
		expect(await op('view', 'getInfo', { id: 'e2e-view' })).toMatchObject({ id: 'e2e-view', url: `${ext}/one`, title: '/one', hidden: false });
		expect((await op<Array<{ id: string }>>('view', 'list')).map((v) => v.id)).toContain('e2e-view');
		// The bridge script is there, but it answers the app's origin only: no `host`, no events.
		expect(await inView('e2e-view', `({ marker: window.__desktopView, host: typeof host, origin: location.origin })`)).toEqual({ marker: 'e2e-view', host: 'undefined', origin: ext });
		expect(await op('view', 'getBounds', { id: 'e2e-view' })).toEqual({ x: 10, y: 20, width: 400, height: 300 });
		await op('view', 'setBounds', { id: 'e2e-view', x: 30, y: 40, width: 320, height: 240 });
		expect(await op('view', 'getBounds', { id: 'e2e-view' })).toEqual({ x: 30, y: 40, width: 320, height: 240 });
		await until('the page got the new size', async () => near(await inView<number>('e2e-view', 'innerWidth'), 320, 4), 5000);
		await op('view', 'hide', { id: 'e2e-view' });
		expect(await op('view', 'getInfo', { id: 'e2e-view' })).toMatchObject({ hidden: true });
		await op('view', 'show', { id: 'e2e-view' });
		const navigated = app.nextEvent('viewNavigated', (e: { id: string; url: string }) => e.id === 'e2e-view' && e.url.endsWith('/two'), 15_000);
		await op('view', 'navigate', { id: 'e2e-view', url: `${ext}/two` });
		await navigated;
		await until('it reports the new page', async () => (await op<{ url: string }>('webview', 'getInfo', { viewId: 'e2e-view' })).url === `${ext}/two`);
		expect(await op('webview', 'getInfo', { viewId: 'e2e-view' })).toMatchObject({ windowId: 0, viewId: 'e2e-view' });
		expect(await code('view', 'navigate', { id: 'nobody', url: ext })).toBe('invalid_args');
		expect(await op('view', 'destroy', { id: 'e2e-view' })).toEqual({ destroyed: true });
		expect((await op<Array<{ id: string }>>('view', 'list')).map((v) => v.id)).not.toContain('e2e-view');
	});

	check('view: an app route runs as the app, a failed load is reported, autoresize follows the window', async () => {
		await op('window', 'setBounds', { windowId: 0, x: 100, y: 60, width: 900, height: 650 });
		const loaded = app.nextEvent('viewLoaded', (e: { id: string }) => e.id === 'e2e-app', 20_000);
		await op('view', 'create', { id: 'e2e-app', windowId: 0, route: '/about', autoresize: 'both', bounds: { x: 0, y: 0, width: 300, height: 200 } });
		await loaded;
		await until('host in the view', async () => (await inView<string>('e2e-app', 'typeof host')) === 'object', 15_000);
		expect(await inView('e2e-app', `location.pathname`)).toBe('/about');
		const before = await op<{ width: number; height: number }>('view', 'getBounds', { id: 'e2e-app' });
		await op('window', 'setSize', { windowId: 0, width: 760, height: 560 });
		await until('it follows', async () => (await op<{ width: number }>('view', 'getBounds', { id: 'e2e-app' })).width < before.width);
		const failed = app.nextEvent<{ id: string; error: string }>('viewFailed', (e: { id: string }) => e.id === 'e2e-dead', 25_000);
		await op('view', 'create', { id: 'e2e-dead', windowId: 0, url: `http://127.0.0.1:${closedPort}/`, bounds: { x: 0, y: 0, width: 100, height: 100 } });
		log('viewFailed', await failed);
		await closeView('e2e-dead');
		await closeView('e2e-app');
		await op('window', 'setBounds', { windowId: 0, x: 100, y: 60, width: 900, height: 650 });
	});

	// ── screen, DPI, capture ────────────────────────────────────────────────

	check('screen and DPI: displays, what the page and Win32 say, real captures', async () => {
		const displays = await op<Array<{ bounds: { width: number }; workArea: { height: number; width: number }; scaleFactor: number; isPrimary: boolean }>>('screen', 'getAllDisplays');
		log('displays', displays);
		expect(displays.length).toBeGreaterThan(0);
		expect(displays.filter((d) => d.isPrimary)).toHaveLength(1);
		const primary = await op<{ scaleFactor: number; bounds: { width: number } }>('screen', 'getPrimaryDisplay');
		expect(primary.bounds.width).toBeGreaterThan(0);
		expect(await op('screen', 'scaleFactor')).toBe(primary.scaleFactor);
		const cursor = await op<{ x: number; y: number }>('screen', 'getCursorScreenPoint');
		expect(typeof cursor.x).toBe('number');
		const scale = await op<number>('window', 'getScaleFactor', { windowId: 0 });
		expect(await app.eval<number>('devicePixelRatio')).toBeCloseTo(scale, 2);
		// The web view is the size of the window's client area, whatever the scale.
		const inner = await op<{ width: number }>('window', 'innerSize', { windowId: 0 });
		expect(near(await app.eval<number>('innerWidth'), inner.width, 2)).toBe(true);

		const png = await op<{ data: string; format: string; width: number }>('webview', 'capturePage', { windowId: 0 });
		expect(Buffer.from(png.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
		expect(near(png.width, inner.width * scale, 4)).toBe(true);
		const jpeg = await op<{ data: string; format: string; width: number; height: number }>('webview', 'capturePage', { windowId: 0, format: 'jpeg', rect: { x: 0, y: 0, width: 100, height: 50 } });
		expect(jpeg.format).toBe('jpeg');
		expect(near(jpeg.width, 100 * scale, 2)).toBe(true);
		expect(Buffer.from(jpeg.data, 'base64')[0]).toBe(0xff);
		expect(await code('webview', 'capturePage', { windowId: 0, rect: { x: 100000, y: 0, width: 10, height: 10 } })).toBe('invalid_args');

		const sources = await op<Array<{ id: number; type: string; label: string }>>('capture', 'getSources');
		expect(sources.some((s) => s.type === 'display')).toBe(true);
		expect(sources.some((s) => s.type === 'window' && s.label === mainTitle)).toBe(true);
		const still = await op<{ width: number; pngBase64: string }>('capture', 'captureSource', { id: sources.find((s) => s.type === 'display')!.id, type: 'display' }, 30_000);
		expect(still.width).toBeGreaterThan(0);
		expect(Buffer.from(still.pngBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
		const windowStill = await op<{ pngBase64: string }>('capture', 'captureSource', { id: sources.find((s) => s.label === mainTitle)!.id, type: 'window' }, 30_000);
		writeFileSync(join(SHOTS, 'capture-window.png'), Buffer.from(windowStill.pngBase64, 'base64'));
	});

	// ── jobs and MCP: child processes of the packaged exe ───────────────────

	check('background jobs: own process, progress, result, cancel, failure, concurrency', async () => {
		await home();
		const api = <T>(path: string, init?: RequestInit) => within(40_000, path, app.eval<T>(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then((r) => r.json())`));
		const start = (body: unknown) => api<{ id: string; state: string }>('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
		const halfway = app.nextEvent<{ channel: string; data: { event?: { data: { halfway: number } } } }>('message', (m) => m.channel === 'jobs' && !!m.data?.event, 30_000);
		const a = await start({ name: 'count', args: { to: 6, delay: 30 } });
		const done = await api<{ state: string; result: { counted: number; pid: number }; progress: number; log: string[]; error?: string }>(`/api/jobs?id=${a.id}&wait=1`);
		log('job', done);
		expect(done).toMatchObject({ state: 'done', progress: 1, result: { counted: 6 } });
		const { pid } = await op<{ pid: number }>('diagnostics', 'info');
		expect(done.result.pid).not.toBe(pid);
		expect(done.log.join('\n')).toContain('counted to 6');
		expect((await halfway).data.event!.data).toEqual({ halfway: 3 });
		const f = await start({ name: 'fail' });
		expect(await api(`/api/jobs?id=${f.id}&wait=1`)).toMatchObject({ state: 'failed', error: 'this job always fails' });
		const slow = await start({ name: 'count', args: { to: 100, delay: 50 } });
		await Bun.sleep(800);
		expect(await api(`/api/jobs?id=${slow.id}`, { method: 'DELETE' })).toEqual({ canceled: true });
		expect(await api(`/api/jobs?id=${slow.id}&wait=1`)).toMatchObject({ state: 'canceled' });
		const c1 = await start({ name: 'count', args: { to: 5, delay: 40 }, concurrency: 1 });
		const c2 = await start({ name: 'count', args: { to: 5, delay: 40 }, concurrency: 1 });
		expect(c2.state).toBe('queued');
		const [r1, r2] = await Promise.all([api<{ endedAt: number }>(`/api/jobs?id=${c1.id}&wait=1`), api<{ startedAt: number }>(`/api/jobs?id=${c2.id}&wait=1`)]);
		expect(r2.startedAt).toBeGreaterThanOrEqual(r1.endedAt);
	}, 120_000);

	check('MCP: what an agent starts (the exe with --mcp): tools listed, a call runs in the running app', async () => {
		await home();
		const server = await within(20_000, 'mcp-status', app.eval<{ available: boolean; name: string; command: string; args: string[]; tools: string[] }>(`fetch('/api/mcp-status').then((r) => r.json())`));
		log('mcp', server);
		expect(server).toMatchObject({ available: true, name: 'svelte-notes', args: ['--mcp'], tools: ['list_notes', 'add_note'] });
		expect(existsSync(server.command)).toBe(true);
		const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
		const proc = Bun.spawn([server.command, ...server.args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
		try {
			const reader = proc.stdout.getReader();
			let buffered = '';
			const next = async () => {
				while (!buffered.includes('\n')) {
					const { value, done } = await reader.read();
					if (done) throw new Error(`the bridge closed: ${await new Response(proc.stderr).text()}`);
					buffered += new TextDecoder().decode(value);
				}
				const at = buffered.indexOf('\n');
				const line = buffered.slice(0, at);
				buffered = buffered.slice(at + 1);
				return JSON.parse(line);
			};
			const ask = (id: number, method: string, params: object = {}) => {
				proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } })}\n`);
				proc.stdin.flush();
				return within(30_000, `mcp ${method}`, next()).catch((e) => { throw Object.assign(e, { code: undefined }); }); // the bridge, not the app
			};
			const windows = (await op<unknown[]>('window', 'list')).length;
			const { result } = await ask(1, 'tools/list');
			expect(result.tools.map((t: { name: string }) => t.name)).toEqual(['list_notes', 'add_note']);
			const text = `from an agent ${Date.now()}`;
			const added = await ask(2, 'tools/call', { name: 'add_note', arguments: { text } });
			expect(added.result.isError).toBeUndefined();
			const listed = await ask(3, 'tools/call', { name: 'list_notes', arguments: { limit: 1 } });
			expect(listed.result.structuredContent.notes[0].text).toBe(text);
			const wrong = await ask(4, 'tools/call', { name: 'add_note', arguments: { text: 3 } });
			expect(wrong.result.isError).toBe(true);
			expect((await op<unknown[]>('window', 'list')).length).toBe(windows);
		} finally {
			proc.kill();
		}
	}, 120_000);

	// ── web content control ─────────────────────────────────────────────────

	const locate = (view: string) => inView<string>(view, `new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('position'), (e) => r('error:' + e.code), { timeout: 3000 }))`, 30_000);
	const configure = (enabled: boolean, timeoutMs = 15_000) => op('webview', 'configurePolicy', { kind: 'permission', enabled, timeoutMs });

	check('permissions: no handler, another origin is refused without asking; the app\'s own origin is allowed', async () => {
		await openView('e2e-perm', '/perm');
		try {
			const asked = app.nextEvent('webPermissionRequest', undefined, 3000).then(() => true, () => false);
			expect(await locate('e2e-perm')).toBe('error:1');
			expect(await asked).toBe(false);
			expect(await op('webview', '_permissionPolicyForTesting', { viewId: 'e2e-perm', permission: 'camera' })).toBe('deny');
			expect(await op('webview', '_permissionPolicyForTesting', { windowId: 0, permission: 'camera' })).toBe('allow');
			log('notification permission, app page', await app.eval(`Notification.requestPermission()`));
			expect(await inView('e2e-perm', `Notification.requestPermission()`)).toBe('denied');
		} finally {
			await closeView('e2e-perm');
		}
	});

	check('permissions: setPermissionHandler sees the request, its answer holds it, once; a late answer has expired', async () => {
		await openView('e2e-perm', '/perm');
		await configure(true);
		try {
			type Req = { requestId: string; origin: string; permission: string; frame: unknown; viewId: string; windowId: number };
			let request = app.nextEvent<Req>('webPermissionRequest', (r) => r.permission === 'location', 15_000);
			let result = locate('e2e-perm');
			const r = await request;
			expect(r).toMatchObject({ origin: ext, permission: 'location', frame: null, viewId: 'e2e-perm', windowId: 0 });
			await Bun.sleep(300);
			await op('webview', 'respondPolicy', { requestId: r.requestId, answer: 'deny' });
			expect(await result).toBe('error:1');
			expect(await code('webview', 'respondPolicy', { requestId: r.requestId, answer: 'allow' })).toBe('unavailable');
			// Allowed: past the web layer. What comes then is the OS's (no location service on a runner).
			request = app.nextEvent<Req>('webPermissionRequest', (x) => x.permission === 'location', 15_000);
			result = locate('e2e-perm');
			await op('webview', 'respondPolicy', { requestId: (await request).requestId, answer: 'allow' });
			log('location after allow', await result);
			// An unanswered request is refused at the deadline, and asks again next time: nothing was saved.
			await configure(true, 300);
			request = app.nextEvent<Req>('webPermissionRequest', (x) => x.permission === 'location', 15_000);
			result = locate('e2e-perm');
			const late = await request;
			expect(await result).toBe('error:1');
			expect(await code('webview', 'respondPolicy', { requestId: late.requestId, answer: 'allow' })).toBe('unavailable');
			expect(await code('webview', 'configurePolicy', { kind: 'permission', enabled: true, timeoutMs: 10 })).toBe('invalid_args');
		} finally {
			await configure(false).catch(() => {});
			await closeView('e2e-perm');
		}
	}, 90_000);

	check('permissions: saved decisions come before the handler and are server only; camera and display capture go through the same policy', async () => {
		await openView('e2e-perm', '/perm');
		await configure(true);
		try {
			await op('webview', 'setPermissionDecision', { origin: `${ext}/any/path`, permission: 'location', decision: 'deny' });
			expect(await op('webview', 'listPermissionDecisions')).toContainEqual({ origin: ext, permission: 'location', decision: 'deny' });
			const asked = app.nextEvent('webPermissionRequest', undefined, 3000).then(() => true, () => false);
			expect(await locate('e2e-perm')).toBe('error:1');
			expect(await asked).toBe(false);
			expect(await op('webview', '_permissionPolicyForTesting', { viewId: 'e2e-perm', permission: 'location' })).toBe('deny');
			await op('webview', 'setPermissionDecision', { origin: ext, permission: 'location', decision: 'allow' });
			expect(await op('webview', '_permissionPolicyForTesting', { viewId: 'e2e-perm', permission: 'location' })).toBe('allow');
			await op('webview', 'revokePermissionDecision', { origin: ext, permission: 'location' });
			expect(await op('webview', 'listPermissionDecisions')).toEqual([]);
			expect(await code('webview', 'setPermissionDecision', { origin: 'file:///x', permission: 'location', decision: 'deny' })).toBe('invalid_args');
			expect(await code('webview', 'setPermissionDecision', { origin: ext, permission: 'usb', decision: 'deny' })).toBe('invalid_args');
			expect(await code('webview', 'setPermissionDecision', { origin: ext, permission: 'location', decision: 'maybe' })).toBe('invalid_args');
			await home();
			expect(await app.eval(`host.webview.listPermissionDecisions().then(() => 'ok', (e) => e.code)`)).toBe('denied');

			// A runner has no camera: WebView2 may say so before it asks. Report which.
			const camera = app.nextEvent<{ requestId: string; permission: string }>('webPermissionRequest', (x) => x.permission === 'camera', 5000).then((x) => x, () => null);
			const media = inView('e2e-perm', `navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'stream', (e) => e.name)`, 25_000);
			const cameraRequest = await camera;
			log('camera request', cameraRequest);
			if (cameraRequest) await op('webview', 'respondPolicy', { requestId: cameraRequest.requestId, answer: 'deny' });
			log('getUserMedia', await media);
			if (cameraRequest) expect(await media).toBe('NotAllowedError');

			const capture = app.nextEvent<{ requestId: string; origin: string; permission: string }>('webPermissionRequest', (x) => x.permission === 'screenRecording', 8000);
			const display = inView('e2e-perm', `navigator.mediaDevices.getDisplayMedia().then(() => 'stream', (e) => e.name)`, 25_000);
			const asking = await capture;
			expect(asking.origin).toBe(ext);
			await op('webview', 'respondPolicy', { requestId: asking.requestId, answer: 'deny' });
			expect(await display).toBe('NotAllowedError');
		} finally {
			await op('webview', 'revokePermissionDecision', { origin: ext, permission: 'location' }).catch(() => {});
			await configure(false).catch(() => {});
			await closeView('e2e-perm');
		}
	}, 90_000);

	const downloadsDir = () => join(dir, 'downloads');
	const stateOf = (id: string) => op<{ state: string; receivedBytes: number; totalBytes: number; canResume: boolean; path?: string; suggestedFilename: string; mimeType: string | null; fraction: number; error?: string; windowId?: number }>('webview', 'getDownload', { id });
	const reached = async (id: string, state: string, ms = 20_000) => {
		await until(`download ${id} ${state}`, async () => (await stateOf(id)).state === state, ms);
		return stateOf(id);
	};

	check('downloads: from the page, its events, a record, unique names, an explicit path', async () => {
		await home();
		const folder = downloadsDir();
		expect(await op('webview', 'setDownloadDirectory', { path: folder })).toEqual({ path: folder });
		expect(await op('webview', 'getDownloadDirectory')).toEqual({ path: folder });
		const url = `${ext}/file.txt`;
		const started = app.nextEvent<{ id: string; url: string; path: string; suggestedFilename: string; windowId: number }>('downloadStarted', (e) => e.url === url, 20_000);
		const finished = app.nextEvent<{ id: string; url: string; path: string; bytes: number }>('downloadFinished', (e) => e.url === url, 20_000);
		const dl = await op<{ id: string; url: string }>('webview', 'download', { windowId: 0, url }, 25_000); // another origin: an attachment
		expect(dl.url).toBe(url);
		expect(await started).toMatchObject({ id: dl.id, suggestedFilename: 'report.txt', windowId: 0, path: join(folder, 'report.txt') });
		const fin = await finished;
		expect(fin).toMatchObject({ id: dl.id, path: join(folder, 'report.txt'), bytes: 15 });
		expect(readFileSync(fin.path, 'utf8')).toBe('downloaded body');
		expect(await reached(dl.id, 'completed')).toMatchObject({ receivedBytes: 15, fraction: 1, canResume: false, windowId: 0, mimeType: 'text/plain' });
		expect((await op<Array<{ id: string }>>('webview', 'listDownloads'))[0]!.id).toBe(dl.id);

		const second = app.nextEvent<{ url: string; path: string }>('downloadFinished', (e) => e.url === url, 20_000);
		await op('webview', 'download', { windowId: 0, url }, 25_000);
		expect((await second).path).toBe(join(folder, 'report (1).txt'));

		const target = join(dir, 'explicit', 'named.txt');
		const third = app.nextEvent<{ path: string }>('downloadFinished', (e) => e.path === target, 20_000);
		await op('webview', 'download', { windowId: 0, url, path: target }, 25_000);
		await third;
		expect(readFileSync(target, 'utf8')).toBe('downloaded body');

		// The page's own origin, relative; a blob made in the page; a link clicked by the page.
		const blob = await app.eval<string>(`URL.createObjectURL(new Blob(['blob body'], { type: 'text/plain' }))`);
		const fromBlob = join(dir, 'from-blob.txt');
		const fourth = app.nextEvent<{ path: string }>('downloadFinished', (e) => e.path === fromBlob, 20_000);
		await op('webview', 'download', { windowId: 0, url: blob, path: fromBlob }, 25_000);
		await fourth;
		expect(readFileSync(fromBlob, 'utf8')).toBe('blob body');
		const fifth = app.nextEvent<{ url: string; path: string }>('downloadFinished', (e) => e.url === url && e.path.includes('report (2)'), 20_000);
		await app.eval(`(() => { const f = document.createElement('iframe'); f.style.display = 'none'; f.src = ${JSON.stringify(url)}; document.body.append(f); })()`);
		await fifth;

		expect(await code('webview', 'download', { windowId: 0, url: 'ftp://x/y' })).toBe('invalid_args');
		expect(await code('webview', 'download', { windowId: 0, url, path: 'relative.txt' })).toBe('invalid_args');
		expect(await code('webview', 'cancelDownload', { id: 'nope' })).toBe('invalid_args');
		expect(await op('webview', 'getDownload', { id: 'nope' })).toBeNull();
	}, 120_000);

	check('downloads: another origin that isn\'t an attachment is refused and the page stays where it is', async () => {
		await home();
		const before = await app.eval('location.href');
		expect(await op('webview', 'download', { windowId: 0, url: `${ext}/inline.txt` }, 25_000).then(() => 'ok', (e: { code: string }) => e.code)).toBe('unavailable');
		expect(await app.eval('location.href')).toBe(before);
	});

	check('downloads: a handler picks the destination or cancels; a bad decision cancels', async () => {
		await home();
		const url = `${ext}/file.txt`;
		const handlerId = 'e2e-handler';
		await op('webview', 'setDownloadHandler', { handlerId });
		try {
			type Req = { id: string; handlerId: string; suggestedFilename: string; mimeType: string | null; size: number; windowId: number };
			let requested = app.nextEvent<Req>('downloadRequested', (e) => e.handlerId === handlerId, 20_000);
			await op('webview', 'download', { windowId: 0, url }, 25_000);
			const first = await requested;
			expect(first).toMatchObject({ suggestedFilename: 'report.txt', mimeType: 'text/plain', windowId: 0 });
			expect((await stateOf(first.id)).state).toBe('requested');
			const chosen = join(dir, 'handler', 'chosen.txt');
			const done = app.nextEvent<{ id: string }>('downloadFinished', (e) => e.id === first.id, 20_000);
			expect(await code('webview', 'decideDownload', { id: first.id, handlerId: 'someone-else', decision: 'default' })).toBe('unavailable');
			await op('webview', 'decideDownload', { id: first.id, handlerId, decision: { path: chosen } });
			await done;
			expect(readFileSync(chosen, 'utf8')).toBe('downloaded body');

			requested = app.nextEvent<Req>('downloadRequested', (e) => e.handlerId === handlerId, 20_000);
			await op('webview', 'download', { windowId: 0, url }, 25_000);
			const second = await requested;
			const failed = app.nextEvent<{ id: string; canceled: boolean; error: string }>('downloadFailed', (e) => e.id === second.id, 15_000);
			await op('webview', 'decideDownload', { id: second.id, handlerId, decision: 'cancel' });
			expect(await failed).toMatchObject({ canceled: true });
			expect(await reached(second.id, 'canceled')).toMatchObject({ canResume: false });
			expect(await code('webview', 'decideDownload', { id: second.id, handlerId, decision: 'default' })).toBe('unavailable');

			requested = app.nextEvent<Req>('downloadRequested', (e) => e.handlerId === handlerId, 20_000);
			await op('webview', 'download', { windowId: 0, url }, 25_000);
			const third = await requested;
			expect(await code('webview', 'decideDownload', { id: third.id, handlerId, decision: { path: 'relative.txt' } })).toBe('invalid_args');
			expect((await stateOf(third.id)).state).toBe('canceled');
		} finally {
			await op('webview', 'clearDownloadHandler', { handlerId }).catch(() => {});
		}
	}, 90_000);

	check('downloads: a slow one reports progress, pauses, resumes to every byte; another is canceled and leaves no file', async () => {
		await home();
		const url = slowUrl;
		const pausedAt = join(dir, 'slow-paused.bin');
		const progress = app.nextEvent<{ url: string; receivedBytes: number; totalBytes: number; fraction: number }>('downloadProgress', (e) => e.url === url, 20_000);
		const dl = await op<{ id: string }>('webview', 'download', { windowId: 0, url, path: pausedAt }, 25_000);
		const p = await progress;
		log('progress', p);
		expect(p.receivedBytes).toBeGreaterThan(0);
		expect(p.totalBytes).toBe(SLOW_SIZE);
		expect(p.fraction).toBeGreaterThan(0);
		const paused = await op<{ state: string; canResume: boolean }>('webview', 'pauseDownload', { id: dl.id });
		log('paused', paused);
		expect(paused.state).toBe('paused');
		expect(paused.canResume).toBe(true);
		expect(await code('webview', 'pauseDownload', { id: dl.id })).toBe('unavailable');
		const held = (await stateOf(dl.id)).receivedBytes;
		await Bun.sleep(1000);
		expect((await stateOf(dl.id)).receivedBytes - held).toBeLessThan(SLOW_SIZE / 2);
		const finished = app.nextEvent<{ id: string; bytes: number }>('downloadFinished', (e) => e.id === dl.id, 30_000);
		expect(await op('webview', 'resumeDownload', { id: dl.id })).toMatchObject({ state: 'downloading' });
		expect((await finished).bytes).toBe(SLOW_SIZE);
		expect(statSync(pausedAt).size).toBe(SLOW_SIZE);
		expect(await code('webview', 'resumeDownload', { id: dl.id })).toBe('unavailable');

		const canceledAt = join(dir, 'slow-canceled.bin');
		const failed = app.nextEvent<{ url: string; canceled: boolean }>('downloadFailed', (e) => e.url === url, 20_000);
		const other = await op<{ id: string }>('webview', 'download', { windowId: 0, url, path: canceledAt }, 25_000);
		await Bun.sleep(500);
		expect(await op('webview', 'cancelDownload', { id: other.id, snapshot: true })).toMatchObject({ state: 'canceled', canResume: false });
		expect((await failed).canceled).toBe(true);
		await until('no partial file', async () => !existsSync(canceledAt), 5000);
		await op('webview', 'setDownloadDirectory', { path: null });
	}, 90_000);

	const longPage = `(() => { const d = document.createElement('div'); d.id = 'e2e-long'; d.style.height = '4000px'; d.textContent = 'printed'; document.body.append(d); })()`;

	check('printing: PDFs, default and with options; bad options refused before anything starts', async () => {
		await home();
		await app.eval(longPage);
		try {
			const finished = app.nextEvent<{ success: boolean; path: string; windowId: number }>('printFinished', (e) => e.path === join(dir, 'all.pdf'), 30_000);
			expect(await op('webview', 'printToPDF', { windowId: 0, path: join(dir, 'all.pdf') }, 40_000)).toEqual({ path: join(dir, 'all.pdf') });
			expect(await finished).toMatchObject({ success: true, windowId: 0 });
			const read = (name: string) => readFileSync(join(dir, name));
			const all = read('all.pdf');
			expect(all.subarray(0, 5).toString()).toBe('%PDF-');
			log('all.pdf', all.length, 'bytes', Pdf.pages(all), 'pages, box', Pdf.box(all));
			await op('webview', 'printToPDF', { windowId: 0, path: join(dir, 'first.pdf'), pageRanges: [{ from: 1, to: 1 }] }, 40_000);
			const first = read('first.pdf');
			log('first.pdf', first.length, 'bytes', Pdf.pages(first), 'pages');
			expect(first.length).toBeLessThan(all.length);
			await op('webview', 'printToPDF', { windowId: 0, path: join(dir, 'land.pdf'), orientation: 'landscape' }, 40_000);
			await op('webview', 'printToPDF', { windowId: 0, path: join(dir, 'small.pdf'), paperSize: { width: 300, height: 400 }, margins: { top: 10, right: 10, bottom: 10, left: 10 } }, 40_000);
			const land = Pdf.box(read('land.pdf')), small = Pdf.box(read('small.pdf')), portrait = Pdf.box(all);
			log('boxes', { portrait, land, small });
			expect(read('land.pdf').equals(all)).toBe(false);
			if (portrait && land) expect(land[0]!).toBeGreaterThan(land[1]!);
			if (small) expect([near(small[0]!, 300, 3), near(small[1]!, 400, 3)]).toEqual([true, true]);
			expect(await op('webview', 'print', { windowId: 0, pdfPath: join(dir, 'via-print.pdf') }, 40_000)).toEqual({ success: true, path: join(dir, 'via-print.pdf') });
			expect(read('via-print.pdf').subarray(0, 5).toString()).toBe('%PDF-');

			const refused = (o: Record<string, unknown>) => code('webview', 'printToPDF', { windowId: 0, path: join(dir, 'no.pdf'), ...o });
			expect(await refused({ orientation: 'sideways' })).toBe('invalid_args');
			expect(await refused({ copies: 0 })).toBe('invalid_args');
			expect(await refused({ paperSize: { width: 0, height: 100 } })).toBe('invalid_args');
			expect(await refused({ margins: { top: 1 } })).toBe('invalid_args');
			expect(await refused({ paperSize: { width: 100, height: 100 }, margins: { top: 60, right: 0, bottom: 60, left: 0 } })).toBe('invalid_args');
			expect(await refused({ pageRanges: [{ from: 3, to: 2 }] })).toBe('invalid_args');
			expect(await refused({ pageRanges: [] })).toBe('invalid_args');
			expect(existsSync(join(dir, 'no.pdf'))).toBe(false);
			expect(await code('webview', 'printToPDF', { windowId: 0 })).toBe('invalid_args');
		} finally {
			await app.eval(`document.querySelector('#e2e-long')?.remove()`).catch(() => {});
		}
	}, 120_000);

	check('printing: the installed printers are listed; silent print refuses a printer that isn\'t there', async () => {
		const printers = await op<string[]>('webview', 'getPrinters');
		log('printers', printers);
		expect(Array.isArray(printers)).toBe(true);
		expect(await code('webview', 'print', { windowId: 0, silent: true, printer: 'No such printer' })).toBe('invalid_args');
		expect(await code('webview', 'print', { windowId: 0, silent: true, pageRanges: [{ from: 1, to: 1 }, { from: 3, to: 4 }] })).toBe('invalid_args');
	});

	check('navigation policy: a view\'s navigations wait for the server, main frame and frames; the app\'s origin is exempt', async () => {
		await home();
		await openView('e2e-nav', '/start');
		await op('webview', 'setNavigationPolicy', { enabled: true });
		try {
			type Nav = { requestId: string; url: string; isMainFrame: boolean; viewId: string };
			const asked = (path: string) => app.nextEvent<Nav>('webContentNavigation', (e) => e.url === ext + path, 15_000);
			let request = asked('/blocked');
			await op('view', 'navigate', { id: 'e2e-nav', url: `${ext}/blocked` });
			const blocked = await request;
			expect(blocked).toMatchObject({ isMainFrame: true, viewId: 'e2e-nav' });
			await op('webview', 'navigationDecision', { requestId: blocked.requestId, allow: false });
			await Bun.sleep(800);
			expect(await inView('e2e-nav', 'location.pathname')).toBe('/start');
			expect(hits.get('/blocked') ?? 0).toBe(0);
			expect(await code('webview', 'navigationDecision', { requestId: blocked.requestId, allow: true })).toBe('unavailable');

			request = asked('/allowed');
			let loaded = app.nextEvent('viewLoaded', (e: { id: string; url: string }) => e.id === 'e2e-nav' && e.url.endsWith('/allowed'), 15_000);
			await op('view', 'navigate', { id: 'e2e-nav', url: `${ext}/allowed` });
			await op('webview', 'navigationDecision', { requestId: (await request).requestId, allow: true });
			await loaded;
			expect(hits.get('/allowed')).toBe(1);

			// Its frames: the page loads, the frame in it doesn't.
			request = asked('/frame');
			const frame = asked('/framed');
			loaded = app.nextEvent('viewLoaded', (e: { id: string; url: string }) => e.id === 'e2e-nav' && e.url.endsWith('/frame'), 20_000);
			await op('view', 'navigate', { id: 'e2e-nav', url: `${ext}/frame` });
			await op('webview', 'navigationDecision', { requestId: (await request).requestId, allow: true });
			const inner = await frame;
			expect(inner.isMainFrame).toBe(false);
			await op('webview', 'navigationDecision', { requestId: inner.requestId, allow: false });
			await loaded;
			expect(hits.get('/framed') ?? 0).toBe(0);

			// Unanswered: refused at the deadline, and the app went on meanwhile.
			request = asked('/unanswered');
			await op('view', 'navigate', { id: 'e2e-nav', url: `${ext}/unanswered` });
			const unanswered = await request;
			expect(await op('window', 'getTitle', { windowId: 0 })).toBe(mainTitle); // the UI thread answers while it waits
			await Bun.sleep(11_000);
			expect(await code('webview', 'navigationDecision', { requestId: unanswered.requestId, allow: true })).toBe('unavailable');
			expect(hits.get('/unanswered') ?? 0).toBe(0);

			// The app's own origin is never asked, in a view either.
			const none = app.nextEvent('webContentNavigation', undefined, 4000).then(() => true, () => false);
			const appLoaded = app.nextEvent('viewLoaded', (e: { id: string }) => e.id === 'e2e-nav', 15_000);
			await op('view', 'navigate', { id: 'e2e-nav', route: '/about' });
			await appLoaded;
			expect(await none).toBe(false);

		} finally {
			await op('webview', 'setNavigationPolicy', { enabled: false }).catch(() => {});
			await closeView('e2e-nav');
		}
		const off = app.nextEvent('webContentNavigation', undefined, 3000).then(() => true, () => false);
		await openView('e2e-nav', '/free');
		expect(await off).toBe(false);
		await closeView('e2e-nav');
	}, 90_000);

	check('cookies: the default profile set, read by the page, removed; the shell\'s own is out of reach', async () => {
		await openView('e2e-cookies', '/cookies');
		const url = `${ext}/`;
		try {
			expect(await op('sessions', 'list')).toEqual([{ id: 'default', persistent: true }]);
			expect(await op('sessions', 'capabilities')).toEqual({ private: false, persistentNamed: false, proxy: false, proxyAuthentication: false, pac: false, customBypass: false });
			expect(await op('sessions', 'getProxy')).toBeNull();
			await op('sessions', 'cookiesSet', { url, name: 'e2e', value: 'one' });
			expect(await inView('e2e-cookies', 'document.cookie')).toContain('e2e=one');
			const [read] = await op<Array<Record<string, unknown>>>('sessions', 'cookiesGet', { url, name: 'e2e' });
			log('cookie', read);
			expect(read).toMatchObject({ name: 'e2e', value: 'one', domain: '127.0.0.1', path: '/', secure: false, httpOnly: false, sessionOnly: true });
			const expires = Math.floor(Date.now() / 1000) + 3600;
			await op('sessions', 'cookiesSet', { url, name: 'e2e-hidden', value: 'two', httpOnly: true, expires, sameSite: 'Strict' });
			const [hidden] = await op<Array<{ httpOnly: boolean; sessionOnly: boolean; expires: number; sameSite: string }>>('sessions', 'cookiesGet', { url, name: 'e2e-hidden' });
			expect(hidden).toMatchObject({ httpOnly: true, sessionOnly: false, sameSite: 'Strict' });
			expect(near(hidden!.expires, expires, 2)).toBe(true);
			expect(await inView('e2e-cookies', 'document.cookie')).not.toContain('e2e-hidden');
			await inView('e2e-cookies', `document.cookie = 'from-page=yes; path=/'`);
			expect((await op<Array<{ name: string }>>('sessions', 'cookiesGet', { url })).map((c) => c.name)).toContain('from-page');
			const every = await op<Array<{ name: string }>>('sessions', 'cookiesGet');
			expect(every.map((c) => c.name)).toContain('e2e');
			expect(every.map((c) => c.name)).not.toContain('__kitop');
			expect(await code('sessions', 'cookiesGet', { name: '__kitop' })).toBe('denied');
			expect(await code('sessions', 'cookiesSet', { url: app.origin, name: '__kitop', value: 'x' })).toBe('denied');
			expect(await code('sessions', 'cookiesGet', { session: 'other' })).toBe('invalid_args');
			expect(await code('sessions', 'cookiesSet', { url, name: 'a=b', value: 'x' })).toBe('invalid_args');
			expect(await code('sessions', 'cookiesSet', { url, name: 'a', value: 'x', domain: 'other.example' })).toBe('invalid_args');
			expect(await code('sessions', 'cookiesSet', { url, name: 'a', value: 'x', secure: true })).toBe('invalid_args');
			expect(await code('sessions', 'cookiesSet', { url: 'ftp://x/', name: 'a', value: 'x' })).toBe('invalid_args');
			expect(await op('sessions', 'cookiesRemove', { url, name: 'e2e' })).toEqual({ removed: 1 });
			expect(await op('sessions', 'cookiesRemove', { url, name: 'e2e' })).toEqual({ removed: 0 });
			expect(await inView('e2e-cookies', 'document.cookie')).not.toContain('e2e=one');
		} finally {
			for (const name of ['e2e', 'e2e-hidden', 'from-page']) await op('sessions', 'cookiesRemove', { url, name }).catch(() => {});
			await closeView('e2e-cookies');
		}
	});

	check('cookies: changes are reported while someone listens, native ones and a page\'s own', async () => {
		await openView('e2e-cookies', '/cookies');
		const url = `${ext}/`;
		type Changed = { session: string; cookie: { name: string; value: string }; removed: boolean };
		const changed = (name: string, removed: boolean) => app.nextEvent<Changed>('sessionCookieChanged', (e) => e.cookie.name === name && e.removed === removed, 8000);
		await op('sessions', 'watchCookies', { enabled: true });
		try {
			await Bun.sleep(1500); // the comparison starts from what's there
			let event = changed('e2e-watch', false);
			await op('sessions', 'cookiesSet', { url, name: 'e2e-watch', value: '1' });
			expect(await event).toMatchObject({ session: 'default', cookie: { value: '1' } });
			event = changed('e2e-page', false);
			await inView('e2e-cookies', `document.cookie = 'e2e-page=1; path=/'`);
			await event;
			event = changed('e2e-watch', true);
			await op('sessions', 'cookiesRemove', { url, name: 'e2e-watch' });
			await event;
		} finally {
			await op('sessions', 'watchCookies', { enabled: false }).catch(() => {});
			await op('sessions', 'cookiesRemove', { url, name: 'e2e-page' }).catch(() => {});
			await closeView('e2e-cookies');
		}
	});

	// ── relaunch ────────────────────────────────────────────────────────────

	const openDb = `new Promise((resolve, reject) => {
		const open = indexedDB.open('relaunch', 1);
		open.onupgradeneeded = () => open.result.createObjectStore('s');
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
	})`;

	check('relaunch: localStorage, IndexedDB, the port, a saved permission and the download history are still there', async () => {
		await home();
		const stamp = String(Date.now());
		const origin = await app.eval<string>('location.origin');
		await app.eval(`(async () => {
			localStorage.setItem('relaunch', '${stamp}');
			const db = await ${openDb};
			await new Promise((done) => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put('${stamp}', 'k'); tx.oncomplete = done; });
		})()`);
		await op('webview', 'setPermissionDecision', { origin: 'https://saved.example', permission: 'microphone', decision: 'allow' });
		const history = await op<Array<{ id: string; state: string }>>('webview', 'listDownloads');
		expect(history.length).toBeGreaterThan(0);
		await op('window', 'setBounds', { windowId: 0, x: 130, y: 70, width: 820, height: 610 });
		await Bun.sleep(1500); // what web views write to disk comes a moment after
		await app.close();
		await Bun.sleep(1500);
		app = await launch({ app: APP, timeout: 90_000 });
		await app.waitFor('#counter', { timeout: 30_000 });
		expect(await app.eval('location.origin')).toBe(origin);
		expect(await app.eval(`localStorage.getItem('relaunch')`)).toBe(stamp);
		expect(await app.eval(`(async () => { const db = await ${openDb}; return new Promise((done) => { const get = db.transaction('s').objectStore('s').get('k'); get.onsuccess = () => done(get.result); }); })()`)).toBe(stamp);
		expect(await op('webview', 'listPermissionDecisions')).toContainEqual({ origin: 'https://saved.example', permission: 'microphone', decision: 'allow' });
		await op('webview', 'revokePermissionDecision', { origin: 'https://saved.example', permission: 'microphone' });
		const after = await op<Array<{ id: string; state: string; canResume: boolean }>>('webview', 'listDownloads');
		log('downloads after relaunch', after.map((d) => d.state).join(' '));
		expect(after.map((d) => d.id)).toEqual(history.map((d) => d.id));
		expect(after.every((d) => !d.canResume)).toBe(true); // a transfer belongs to the run it started in
		expect(after.every((d) => !['requested', 'downloading', 'pausing', 'paused'].includes(d.state))).toBe(true);
		await home();
	}, 180_000);

	check('relaunch: the window comes back where it was (autosaveName)', async () => {
		const { bounds } = await op<{ bounds: { x: number; y: number; width: number; height: number } }>('window', 'getBounds', { windowId: 0 });
		log('bounds after relaunch', bounds);
		expect([near(bounds.x, 130, 4), near(bounds.y, 70, 4), near(bounds.width, 820, 4), near(bounds.height, 610, 4)]).toEqual([true, true, true, true]);
	});
});
