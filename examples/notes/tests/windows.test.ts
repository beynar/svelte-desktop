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

	test('quitOnLastWindowClosed: false — no window left: the app lives; a toast click reopens the main window, so does a second instance', async () => {
		await home();
		await show({ id: 'q1', title: 'Reopen me', body: 'No window open', url: '/about', requireInteraction: true });
		await app.platform('window', 'close', { windowId: 0 });
		await until('window closed', async () => (await windows()).length === 0, 10_000);
		expect((await app.platform<{ identifier: string }>('app', 'getInfo')).identifier).toBe(ID); // still answering
		const r = await uia('act', { title: 'Reopen me' });
		log('act', r);
		expect(JSON.parse(r).error).toBeUndefined();
		await until('main window reopened', async () => (await windows()).length === 1);
		await app.waitFor(() => location.pathname === '/about', { timeout: 30_000 });
		await app.waitFor(() => /click q1/.test(document.querySelector('#notification-log')?.textContent ?? ''), { timeout: 10_000 });
		await shot('reopened-by-toast.png');
		// A second launch with no window: the instance it hands over to reopens the main window.
		await app.platform('window', 'close', { windowId: 0 });
		await until('window closed again', async () => (await windows()).length === 0, 10_000);
		const exe = join(APP, readdirSync(APP).find((f) => /\.exe$/i.test(f))!);
		const second = Bun.spawn([exe], { stdout: 'ignore', stderr: 'ignore' });
		expect(await Promise.race([second.exited, Bun.sleep(20_000).then(() => 'running')])).toBe(0); // handed over and left
		await until('main window reopened by the second instance', async () => (await windows()).length === 1);
		await app.waitFor('#counter', { timeout: 30_000 });
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

	/** Start the app the way Windows does for a toast (the activator's LocalServer32), with the
	 *  test channel: `trigger` is the real click; a .cmd wrapper only adds SVELTE_DESKTOP_TEST. */
	async function coldLaunch(trigger: () => Promise<unknown>) {
		const exe = join(APP, readdirSync(APP).find((f) => /\.exe$/i.test(f))!);
		try {
			return await launch({
				timeout: 60_000,
				connect: (url) => {
					const cmd = join(tmp, 'toast-launch.cmd');
					writeFileSync(cmd, `@echo off\r\nset SVELTE_DESKTOP_TEST=${url}\r\n"${exe}" -ToastActivated %*\r\n`);
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
				Bun.spawn(['powershell.exe', '-NoProfile', '-Command', `Start-Process -FilePath '${lnk}'`], { env: { ...process.env, SVELTE_DESKTOP_TEST: url }, stdout: 'ignore', stderr: 'ignore' });
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
