// The rest of what macOS has, outside the web view, on a real Windows runner: the cancellable quit asked for real
// (messages a session sends, the Restart Manager, the real close button), metrics against what PowerShell reads,
// the icon and the taskbar, the clipboard with another process, route dialogs, the jump list's stored tasks run as
// Windows runs them, a bookmark following a file really moved, a drag dropped in another process, the share sheet.
//   WINDOWS_E2E=1 [WINDOWS_APP=<app folder>] bun test --timeout 120000 tests/windows-desktop.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, type AppHandle } from '@kitop/shell/test';
import { APP, driver, log, pngDataUrl, ps, stopLeftovers, tmp, win, within } from './windows-input.ts';

const TITLE = 'E2E desktop window';
const ID = 'dev.kitop.notes';
const b64 = (s: string | Uint8Array) => Buffer.from(s as string).toString('base64');
const specFile = (spec: object) => {
	const file = join(tmp, `q${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify(spec));
	return file;
};

// What another process sees and does, through Win32.
const SEE_PS1 = String.raw`param([string]$Mode, [string]$Spec)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class SdSee {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint ms, out IntPtr r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool ShutdownBlockReasonQuery(IntPtr h, StringBuilder s, ref uint n);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { var t = new StringBuilder(512); GetWindowText(h, t, 512); if (t.ToString() == title) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string[] Windows() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256); var t = new StringBuilder(256); GetWindowText(h, t, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(c + "|" + t + "|" + pid);
      return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public static void Click(int x, int y, bool right) { SetProcessDPIAware(); SetCursorPos(x, y); System.Threading.Thread.Sleep(200); mouse_event(right ? 8u : 2u, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(right ? 16u : 4u, 0, 0, 0, UIntPtr.Zero); }
  public static string IconPixel(IntPtr h, int which) {
    IntPtr icon = SendMessage(h, 0x7F, new IntPtr(which), IntPtr.Zero);
    if (icon == IntPtr.Zero) return "none";
    using (var b = Icon.FromHandle(icon).ToBitmap()) { var p = b.GetPixel(b.Width / 2, b.Height / 2); return b.Width + "x" + b.Height + ":" + p.R + "," + p.G + "," + p.B; }
  }
  // HRESULT of asking a runtime class's factory for an interface: 0 when it has it.
  [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string s, int n, out IntPtr h);
  [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr cls, ref Guid iid, out IntPtr f);
  public static int Factory(string cls, string iid) { IntPtr h, f; WindowsCreateString(cls, cls.Length, out h); var g = new Guid(iid); return RoGetActivationFactory(h, ref g, out f); }
}
"@
$s = if ($Spec) { Get-Content -Raw $Spec | ConvertFrom-Json } else { $null }
function Hwnd { $h = [SdSee]::Find($s.title); if ($h -eq [IntPtr]::Zero) { throw "no window titled '$($s.title)'" }; $h }
switch ($Mode) {
  'exists' { "$([SdSee]::Find($s.title) -ne [IntPtr]::Zero)" }
  'visible' { "$([SdSee]::IsWindowVisible((Hwnd)))" }
  'enabled' { "$([SdSee]::IsWindowEnabled((Hwnd)))" }
  'owner' { "$([SdSee]::GetWindow((Hwnd), 4) -eq [SdSee]::Find($s.owner))" }
  'exstyle' { "$([SdSee]::GetLong((Hwnd), -20).ToInt64())" }
  'client-y' { $p = New-Object SdSee+POINT; [void][SdSee]::ClientToScreen((Hwnd), [ref]$p); "$($p.Y)" }
  'sheet-ui' { # What the share sheet shows: its window, through UI Automation.
    $frames = @([SdSee]::Windows() | Where-Object { $_ -like 'ApplicationFrameWindow|*' })
    $h = [SdSee]::FindWindow('ApplicationFrameWindow', $null)
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $names = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { "$($_.Current.ControlType.ProgrammaticName)|$($_.Current.Name)|$($_.Current.AutomationId)" })
    if ($s.close) {
      foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($e.Current.Name -eq 'Close' -or $e.Current.AutomationId -eq 'CloseButton') { $p = $null; if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); $names += 'INVOKED ' + $e.Current.AutomationId } }
      }
    }
    @{ frames = $frames; names = $names } | ConvertTo-Json -Compress -Depth 3
  }
  'icon' { [SdSee]::IconPixel((Hwnd), [int]$s.which) }
  'menu-open' { "$([SdSee]::IsWindowVisible([SdSee]::FindWindow('#32768', $null)))" }
  'windows' { [SdSee]::Windows() -join [char]10 }
  'taskbar' {
    $bar = [System.Windows.Automation.AutomationElement]::FromHandle([SdSee]::FindWindow('Shell_TrayWnd', $null))
    @($bar.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join [char]10
  }
  'session' { # The message a session's end sends, to the app's hidden window (class + identifier title), and the answer.
    $h = [SdSee]::FindWindow($s.class, $s.hidden)
    if ($h -eq [IntPtr]::Zero) { throw 'no hidden window' }
    $r = [IntPtr]::Zero
    $sent = [SdSee]::SendMessageTimeout($h, [uint32]$s.msg, [IntPtr][int64]$s.wp, [IntPtr][int64]$s.lp, 0, 8000, [ref]$r)
    $reason = New-Object Text.StringBuilder 256; $n = [uint32]256
    $blocked = [SdSee]::ShutdownBlockReasonQuery($h, $reason, [ref]$n)
    @{ sent = $sent -ne [IntPtr]::Zero; answer = $r.ToInt64(); blocked = $blocked; reason = $reason.ToString() } | ConvertTo-Json -Compress
  }
  'jump-list' { # The real thing: a right click on the app's taskbar button, then a real click on a task of the list that opens.
    # UI Automation doesn't reach that list here, neither from the desktop nor from a point. It opens above the button, its rows
    # counted from the bottom: Close window, Pin to taskbar, the app, then the tasks, last one first. What's on the screen says when it's open.
    $bar = [System.Windows.Automation.AutomationElement]::FromHandle([SdSee]::FindWindow('Shell_TrayWnd', $null))
    $button = $null
    foreach ($e in $bar.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($e.Current.Name -like "$($s.app)*") { $button = $e; break } }
    if (-not $button) { throw 'no taskbar button' }
    $r = $button.Current.BoundingRectangle
    $x = [int]($r.X + $r.Width / 2); $y = [int]$r.Y
    function Pixel { $b = New-Object Drawing.Bitmap 1, 1; $g = [Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($x, ($y - 33), 0, 0, (New-Object Drawing.Size 1, 1)); $g.Dispose(); $p = $b.GetPixel(0, 0).ToArgb(); $b.Dispose(); $p }
    $before = Pixel
    [SdSee]::Click($x, $y + 10, $true)
    $opened = $false
    for ($i = 0; $i -lt 50 -and -not $opened; $i++) { Start-Sleep -Milliseconds 200; $opened = (Pixel) -ne $before }
    Start-Sleep -Milliseconds 800 # it slides in
    if ($s.path) { $o = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object Drawing.Bitmap $o.Width, $o.Height; $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($o.Left, $o.Top, 0, 0, $bmp.Size); $bmp.Save($s.path, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose() }
    [SdSee]::Click($x, $y - [int]$s.above, $false)
    @{ button = $button.Current.Name; opened = $opened } | ConvertTo-Json -Compress
  }
  'factories' { @($s.pairs | ForEach-Object { [SdSee]::Factory($_.cls, $_.iid) }) -join ',' }
  'shot' {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save($s.path, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); 'saved'
  }
}
`;
const see = async (mode: string, spec: object = {}) => {
	const r = await ps(SEE_PS1, mode, specFile(spec));
	if (r.code !== 0) throw new Error(`${mode} failed: ${r.err || r.out}`);
	return r.out;
};
const shot = async (name: string) => {
	if (process.env.WINDOWS_SHOTS) await see('shot', { path: join(process.env.WINDOWS_SHOTS, `desktop-${name}.png`) }).catch(() => {});
};

// The Restart Manager closing the app, as an installer has it done: the system's own WM_QUERYENDSESSION and WM_ENDSESSION.
const RESTART_MANAGER_PS1 = String.raw`param([int]$Id)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;
public static class SdRm {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public int Pid; public FILETIME Start; }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nf, string[] files, uint na, UniqueProcess[] apps, uint ns, string[] services);
  [DllImport("rstrtmgr.dll")] static extern int RmShutdown(uint h, uint flags, IntPtr progress);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out FILETIME c, out FILETIME e, out FILETIME k, out FILETIME u);
  public static int Close(int pid) {
    uint h; int r = RmStartSession(out h, 0, Guid.NewGuid().ToString("N"));
    if (r != 0) return -r;
    FILETIME c, e, k, u; GetProcessTimes(OpenProcess(0x1000, false, pid), out c, out e, out k, out u);
    var app = new UniqueProcess { Pid = pid, Start = c };
    r = RmRegisterResources(h, 0, null, 1, new[] { app }, 0, null);
    if (r == 0) r = RmShutdown(h, 0, IntPtr.Zero);
    RmEndSession(h);
    return r;
  }
}
"@
[SdRm]::Close($Id)
`;

// Another program's real drop target, and the real mouse going from the page to it. It says what it received.
const DROP_PS1 = String.raw`param([string]$Spec)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Threading; using System.Windows.Forms;
public static class SdDrop {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  static void Move(int x, int y) { mouse_event(0x8001, (x * 65535) / (GetSystemMetrics(0) - 1), (y * 65535) / (GetSystemMetrics(1) - 1), 0, UIntPtr.Zero); }
  static void Glide(int x0, int y0, int x1, int y1) { for (int i = 1; i <= 20; i++) { Move(x0 + (x1 - x0) * i / 20, y0 + (y1 - y0) * i / 20); Thread.Sleep(40); } }
  public static string Run(int fromX, int fromY, bool escape, bool refuse) {
    SetProcessDPIAware();
    string got = "none"; string image = "no"; string seen = "never entered";
    var form = new Form { Text = "kitop-drop-target", StartPosition = FormStartPosition.Manual, Bounds = new Rectangle(650, 400, 300, 300), TopMost = true, AllowDrop = true };
    form.DragEnter += (s, e) => { seen = String.Join(",", e.Data.GetFormats()) + " allowed " + e.AllowedEffect; e.Effect = !refuse && e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None; };
    form.DragDrop += (s, e) => { got = String.Join("|", (string[])e.Data.GetData(DataFormats.FileDrop)); };
    form.Shown += (s, e) => new Thread(() => {
      Thread.Sleep(500);
      Move(fromX, fromY); Thread.Sleep(200);
      mouse_event(2, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(900); // the press reaches the page, whose handler starts the drag
      Glide(fromX, fromY, 800, 550); Thread.Sleep(500);
      image = IsWindowVisible(FindWindow("SysDragImage", null)) ? "yes" : "no";
      if (escape) { keybd_event(0x1B, 0, 0, UIntPtr.Zero); Thread.Sleep(60); keybd_event(0x1B, 0, 2, UIntPtr.Zero); Thread.Sleep(100); Glide(800, 550, 810, 560); Thread.Sleep(300); }
      mouse_event(4, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(900);
      form.Invoke((Action)(() => form.Close()));
    }) { IsBackground = true }.Start();
    Application.Run(form);
    return got + "\n" + image + "\n" + seen;
  }
}
"@
$s = Get-Content -Raw $Spec | ConvertFrom-Json
[SdDrop]::Run([int]$s.x, [int]$s.y, [bool]$s.escape, [bool]$s.refuse)
`;

// The clipboard as another program has it, .NET's own view of the system's formats.
const CLIP_READ_PS1 = String.raw`param([string]$Spec)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$s = Get-Content -Raw $Spec | ConvertFrom-Json
$d = [Windows.Forms.Clipboard]::GetDataObject()
function Bytes($name) { $v = $d.GetData($name); if ($v -is [IO.MemoryStream]) { [Convert]::ToBase64String($v.ToArray()) } else { $null } }
$out = @{ formats = @($d.GetFormats($false)); text = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$d.GetData('UnicodeText')))
  html = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$d.GetData('HTML Format'))); rtf = [string]$d.GetData('Rich Text Format')
  files = @([Windows.Forms.Clipboard]::GetFileDropList()); custom = Bytes $s.custom; png = Bytes 'PNG' }
$img = [Windows.Forms.Clipboard]::GetImage()
if ($img) { $b = New-Object Drawing.Bitmap $img; $p = $b.GetPixel(0, 0); $out.bitmap = "$($b.Width)x$($b.Height):$($p.R),$($p.G),$($p.B)" }
$out | ConvertTo-Json -Compress
`;
const CLIP_WRITE_PS1 = String.raw`param([string]$Spec)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$s = Get-Content -Raw $Spec | ConvertFrom-Json
$d = New-Object Windows.Forms.DataObject
$d.SetData('UnicodeText', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s.text)))
$nl = [string][char]13 + [char]10; $pre = '<html><body><!--StartFragment-->'; $frag = '<i>from ps</i>'; $post = '<!--EndFragment--></body></html>'
$head = 'Version:0.9' + $nl + 'StartHTML:{0:D10}' + $nl + 'EndHTML:{1:D10}' + $nl + 'StartFragment:{2:D10}' + $nl + 'EndFragment:{3:D10}' + $nl
$h = ($head -f 0, 0, 0, 0).Length
$html = ($head -f $h, ($h + $pre.Length + $frag.Length + $post.Length), ($h + $pre.Length), ($h + $pre.Length + $frag.Length)) + $pre + $frag + $post
$d.SetData('HTML Format', (New-Object IO.MemoryStream (,[Text.Encoding]::UTF8.GetBytes($html))))
$d.SetData($s.custom, (New-Object IO.MemoryStream (,[Convert]::FromBase64String($s.bytes))))
$files = New-Object Collections.Specialized.StringCollection
[void]$files.Add($s.file)
$d.SetFileDropList($files)
$b = New-Object Drawing.Bitmap 5, 7
for ($x = 0; $x -lt 5; $x++) { for ($y = 0; $y -lt 7; $y++) { $b.SetPixel($x, $y, [Drawing.Color]::FromArgb(255, 200, 100, 50)) } }
$d.SetImage($b)
[Windows.Forms.Clipboard]::SetDataObject($d, $true)
'written'
`;

const PROCESSES_PS1 = String.raw`param([string]$Spec)
$s = Get-Content -Raw $Spec | ConvertFrom-Json
@($s.pids | ForEach-Object {
  $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
  $c = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue
  if ($p) { @{ pid = $_; name = $p.ProcessName; workingSet = $p.WorkingSet64; privateBytes = $p.PrivateMemorySize64; cpu = $p.TotalProcessorTime.TotalSeconds; command = $c.CommandLine; parent = $c.ParentProcessId } }
}) | ConvertTo-Json -Compress
`;

const HELLO_PS1 = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$as = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
$t = $as.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()))
$t.Wait()
"$($t.Result)"
`;

/** The stored tasks of the app's jump list, from the file Windows keeps them in. */
function jumpFiles() {
	const dir = join(process.env.APPDATA!, 'Microsoft', 'Windows', 'Recent', 'CustomDestinations');
	if (!existsSync(dir)) return '';
	return readdirSync(dir).filter((f) => f.endsWith('.customDestinations-ms')).map((f) => readFileSync(join(dir, f)).toString('utf16le') + '\n' + readFileSync(join(dir, f)).subarray(1).toString('utf16le')).join('\n');
}

describe.skipIf(!process.env.WINDOWS_E2E)('windows: the app on the desktop', () => {
	let app: AppHandle;
	const { op, code, check, until } = driver(() => app);
	const dir = process.platform === 'win32' ? realpathSync.native(tmp) : '';
	const front = () => win('click', { title: TITLE, dx: 450, dy: 330 });
	const rect = async (title = TITLE) => JSON.parse(await win('rect', { title })) as { x: number; y: number; width: number; height: number };
	const exe = () => join(APP, readdirSync(APP).find((f) => /\.exe$/i.test(f) && f !== 'Uninstall.exe')!);

	beforeAll(async () => {
		await stopLeftovers();
		app = await launch({ app: APP, timeout: 90_000 });
		await app.waitFor('#counter', { timeout: 30_000 });
		await op('window', 'setTitle', { windowId: 0, title: TITLE });
		await op('window', 'setBounds', { windowId: 0, x: 200, y: 60, width: 900, height: 650 });
	}, 150_000);
	afterAll(async () => {
		await app?.close().catch(() => {});
	}, 30_000);

	check('report: every operation of this batch is registered, and what stays out is not', async () => {
		const { services } = await op<{ services: Record<string, Record<string, string>> }>('capabilities', 'describe');
		for (const [service, name] of [['app', 'subscribeQuit'], ['app', 'unsubscribeQuit'], ['app', 'replyQuit'], ['app', 'metrics'], ['app', 'showAll'], ['app', 'setDockIcon'], ['app', 'getDockIcon'], ['app', 'setIcon'], ['app', 'defaultWindowIcon'], ['app', 'setActivationPolicy'], ['app', 'getActivationPolicy'], ['clipboard', 'read'], ['clipboard', 'write'], ['dialog', 'sheet'], ['dialog', 'close'], ['menu', 'closePopup'], ['menu', 'setDockMenu'], ['menu', 'getDockMenu'], ['files', 'createBookmark'], ['files', 'openBookmark'], ['files', 'releaseBookmark'], ['shell', 'startDrag'], ['shell', 'share'], ['system', 'biometrics'], ['secureStorage', 'authenticate']] as const)
			expect({ service, name, status: services[service]?.[name] }).toEqual({ service, name, status: 'implemented' });
		expect(services.power?.getThermalState).toBe('unavailable');
		for (const [service, name] of [['app', 'hideOthers'], ['shell', 'previewFile'], ['notifications', 'simulateResponse'], ['window', 'testScroll']] as const) {
			expect(services[service]?.[name]).toBeUndefined();
			expect({ service, name, code: await code(service, name, {}) }).toEqual({ service, name, code: 'unsupported' });
		}
		// No op in the service at all: the dispatcher's other way of saying it, which host.permissions takes the same.
		expect(services.permissions).toBeUndefined();
		for (const name of ['guide', 'guideState', 'cancelGuide']) expect(await code('permissions', name)).toBe('unknown');
	});

	// ── quit ────────────────────────────────────────────────────────────────

	const guard = async (answer: string | null, phase = 'quitRequested') => {
		await app.eval(`(() => {
			window.__quit = []; window.__answer = ${JSON.stringify(answer)};
			window.__off?.();
			window.__off = host.app.${phase === 'quitRequested' ? 'onQuitRequested' : 'onBeforeQuit'}((r) => { window.__quit.push(r); return window.__answer ?? new Promise(() => {}); });
			return 1;
		})()`);
		await Bun.sleep(300); // its subscribeQuit, on its way through the bridge
	};
	const unguard = () => app.eval(`(window.__off?.(), window.__off = null, 1)`);
	const asked = () => app.eval<{ reason: string; requestId: number; deadline: number; tokens: string[] }[]>(`window.__quit`);
	const alive = async () => expect(await app.eval<number>(`40 + 2`)).toBe(42);
	const session = (msg: number, wp: number, lp: number) => see('session', { class: 'KitopHidden', hidden: ID, msg, wp, lp }).then((r) => JSON.parse(r) as { sent: boolean; answer: number; blocked: boolean; reason: string });
	const WM_QUERYENDSESSION = 0x11, WM_ENDSESSION = 0x16, ENDSESSION_LOGOFF = 0x80000000, ENDSESSION_CLOSEAPP = 1;

	check('quit: what it refuses, and a reply to nothing does nothing', async () => {
		expect(await code('app', 'subscribeQuit', { token: 'x' })).toBe('invalid_args');
		expect(await code('app', 'subscribeQuit', { token: 'x', phase: 'afterQuit' })).toBe('invalid_args');
		expect(await code('app', 'unsubscribeQuit')).toBe('invalid_args');
		expect(await code('app', 'replyQuit', { token: 'x', decision: 'maybe' })).toBe('invalid_args');
		expect(await code('app', 'replyQuit', { token: 'x', decision: 'cancel', requestId: 99, phase: 'quitRequested' })).toBe('ok');
		await alive();
	});

	check('quit: a page\'s guard, through host.app, vetoes host.app.quit', async () => {
		await guard('cancel');
		const cancelled = app.nextEvent<{ reason: string; requestId: number }>('quitCancelled', undefined, 10_000);
		await app.eval(`host.app.quit()`);
		const c = await cancelled;
		const [r] = await asked();
		expect(r).toMatchObject({ reason: 'api', requestId: c.requestId });
		expect(r!.deadline).toBeGreaterThan(Date.now());
		expect(c.reason).toBe('api');
		await Bun.sleep(300);
		await alive();
		expect(await see('visible', { title: TITLE })).toBe('True');
	});

	check('quit: the menu\'s Quit, a real key press, is vetoed the same way', async () => {
		await guard('cancel');
		await op('menu', 'setAppMenu', { menus: [{ name: 'App', items: [{ role: 'quit', accelerator: 'CmdOrCtrl+Shift+Q' }] }] });
		await front();
		const cancelled = app.nextEvent<{ reason: string }>('quitCancelled', undefined, 10_000);
		await win('keys', { title: TITLE, keys: [0x11, 0x10, 0x51] });
		expect((await cancelled).reason).toBe('menu');
		await op('menu', 'setAppMenu', { menus: [] });
		await alive();
	});

	check('quit: a server guard and a page\'s: each answers for itself, and any cancel holds', async () => {
		await guard(null); // the page thinks
		await op('app', 'subscribeQuit', { token: 'server', phase: 'quitRequested' });
		const requested = app.nextEvent<{ requestId: number; tokens: string[] }>('quitRequested', undefined, 10_000);
		const cancelled = app.nextEvent('quitCancelled', undefined, 10_000);
		await op('app', 'quit');
		const r = await requested;
		expect(r.tokens).toContain('server');
		const page = r.tokens.find((t) => t !== 'server')!;
		expect(await code('app', 'replyQuit', { token: page, phase: 'quitRequested', requestId: r.requestId, decision: 'quit' })).toBe('denied');
		expect(await code('app', 'subscribeQuit', { token: page, phase: 'beforeQuit' })).toBe('denied');
		await op('app', 'quit'); // joins this one
		await op('app', 'replyQuit', { token: 'server', phase: 'quitRequested', requestId: r.requestId, decision: 'quit' });
		await Bun.sleep(300);
		await alive();
		expect((await asked()).length).toBe(1);
		await app.eval(`(window.__answer = 'x', 1)`);
		// A document going away can't agree to losing its work.
		const reloaded = app.waitFor('#counter', { timeout: 20_000 });
		await app.eval(`(setTimeout(() => location.reload(), 50), 1)`);
		await cancelled;
		await reloaded;
		await op('app', 'unsubscribeQuit', { token: 'server' });
		await until('the new document has its host', () => app.eval<boolean>(`typeof host === 'object' && !!document.getElementById('counter')`), 20_000);
		await alive();
	}, 90_000);

	check('quit: a session ending is refused while a guard votes, with the reason Windows shows, and says who asked', async () => {
		await guard(null);
		for (const [lp, reason] of [[ENDSESSION_LOGOFF, 'logout'], [0, 'shutdown'], [ENDSESSION_CLOSEAPP, 'system']] as const) {
			const requested = app.nextEvent<{ reason: string; requestId: number }>('quitRequested', undefined, 10_000);
			const cancelled = app.nextEvent<{ reason: string }>('quitCancelled', undefined, 10_000);
			const r = await session(WM_QUERYENDSESSION, 0, lp);
			log('WM_QUERYENDSESSION', lp, r);
			expect(r).toMatchObject({ sent: true, answer: 0 });
			expect((await requested).reason).toBe(reason);
			// The user chose not to wait, or another program said no: what was voted for isn't happening.
			const off = await session(WM_ENDSESSION, 0, lp);
			expect(off).toMatchObject({ sent: true, blocked: false });
			expect((await cancelled).reason).toBe(reason);
			await alive();
		}
		await unguard();
		await Bun.sleep(300);
		// No guard: nothing to wait for.
		expect(await session(WM_QUERYENDSESSION, 0, ENDSESSION_LOGOFF)).toMatchObject({ sent: true, answer: 1, blocked: false });
		// Going down whatever anyone answers: ENDSESSION_CRITICAL.
		await guard(null);
		expect(await session(WM_QUERYENDSESSION, 0, 0x40000000)).toMatchObject({ sent: true, answer: 1 });
		await unguard();
		await alive();
	}, 90_000);

	check('quit: the Restart Manager asks to close the app, and a guard says no', async () => {
		await guard('cancel');
		const { pid } = (await op<{ processes: { pid: number; type: string }[] }>('app', 'metrics')).processes.find((p) => p.type === 'main')! as { pid: number };
		const cancelled = app.nextEvent<{ reason: string }>('quitCancelled', undefined, 40_000);
		const r = await ps(RESTART_MANAGER_PS1, String(pid));
		log('RmShutdown with a guard', r.out, r.err);
		expect((await cancelled).reason).toBe('system');
		expect(r.out).not.toBe('0');
		await alive();
		await unguard();
	}, 90_000);

	// ── metrics ─────────────────────────────────────────────────────────────

	type Row = { pid: number; type: string; name: string; windowId?: number; memory: { footprint: number; resident: number }; cpu: { time: number; percent: number | null } };
	const metrics = () => op<{ processes: Row[]; memory: { footprint: number } }>('app', 'metrics');
	const others = async (pids: number[]) => {
		const r = await ps(PROCESSES_PS1, specFile({ pids }));
		const v = JSON.parse(r.out);
		return ([v].flat() as { pid: number; name: string; workingSet: number; privateBytes: number; cpu: number; command: string; parent: number }[]);
	};

	check('metrics: the app\'s processes, what PowerShell reads of them, whose page each draws', async () => {
		const m = await metrics();
		log('metrics', m.processes.map((p) => `${p.pid} ${p.type} ${p.name} w=${p.windowId} ${Math.round(p.memory.footprint / 1e6)}MB`));
		const main = m.processes.filter((p) => p.type === 'main');
		expect(main.length).toBe(1);
		expect(main[0]!.name.toLowerCase()).toEndWith('.exe');
		expect(m.memory.footprint).toBe(m.processes.reduce((n, p) => n + p.memory.footprint, 0));
		const seen = await others(m.processes.map((p) => p.pid));
		const of = (pid: number) => seen.find((s) => s.pid === pid)!;
		expect(of(main[0]!.pid).name.toLowerCase()).toBe(main[0]!.name.toLowerCase().replace(/\.exe$/, ''));
		for (const p of m.processes) {
			const s = of(p.pid);
			if (!s) continue; // gone since
			expect(p.memory.footprint).toBeGreaterThan(0);
			expect(Math.abs(p.memory.footprint - s.privateBytes) / s.privateBytes).toBeLessThan(0.5);
			expect(Math.abs(p.memory.resident - s.workingSet) / s.workingSet).toBeLessThan(0.5);
			expect(s.cpu).toBeGreaterThanOrEqual(p.cpu.time - 0.5);
		}
		// Renderers are what Windows calls them. The page's own, by the id of the window.
		const pages = m.processes.filter((p) => p.type === 'webview');
		expect(pages.length).toBeGreaterThan(0);
		for (const p of pages) expect(of(p.pid).command).toContain('--type=renderer');
		const own = pages.filter((p) => p.windowId === 0);
		expect(own.length).toBe(1);
		// The browser process and the rest of what WebView2 runs are the app's memory too.
		expect(m.processes.some((p) => p.type === 'child' && p.name.toLowerCase() === 'msedgewebview2.exe')).toBe(true);
	});

	check('metrics: a page that works and allocates shows, in its own process', async () => {
		const before = (await metrics()).processes.find((p) => p.windowId === 0)!;
		// A known amount: filling it for as long as the loop lasts got to 3 GB, near what a page can have.
		await app.eval(`(() => { window.__keep = []; for (let i = 0; i < 30; i++) window.__keep.push(new Float64Array(1 << 20).fill(1)); const end = Date.now() + 1200; let n = 0; while (Date.now() < end) n += Math.random(); return n > 0; })()`);
		const after = (await metrics()).processes.find((p) => p.windowId === 0)!;
		log('page process', before, after);
		expect(after.pid).toBe(before.pid);
		expect(after.cpu.time - before.cpu.time).toBeGreaterThan(0.5);
		expect(after.cpu.percent).toBeGreaterThan(10);
		expect(after.memory.footprint - before.memory.footprint).toBeGreaterThan(200 * 1024 * 1024); // 240 MB of it
		await app.eval(`(window.__keep = null, 1)`);
	});

	check('metrics: a job is a helper, the app\'s own executable again', async () => {
		const api = <T>(path: string, init?: RequestInit) => within(40_000, path, app.eval<T>(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then((r) => r.json())`));
		const job = await api<{ id: string }>('/api/jobs', { method: 'POST', body: JSON.stringify({ name: 'count', args: { to: 200, delay: 100 } }) });
		await until('the job is running', async () => (await metrics()).processes.some((p) => p.type === 'helper'), 15_000);
		const helper = (await metrics()).processes.find((p) => p.type === 'helper')!;
		const [seen] = await others([helper.pid]);
		expect(seen!.name.toLowerCase()).toBe(helper.name.toLowerCase().replace(/\.exe$/, ''));
		await api(`/api/jobs?id=${job.id}`, { method: 'DELETE' });
	});

	// ── the windows, the icon, the taskbar ──────────────────────────────────

	check('showAll: brings back what app.hide took off the screen, not what the app hid itself', async () => {
		const other = await op<{ windowId: number }>('window', 'create', { path: '/about', label: 'other', title: 'E2E other', width: 300, height: 200 });
		await until('it shows', async () => (await see('exists', { title: 'E2E other' })) === 'True' && (await see('visible', { title: 'E2E other' })) === 'True', 15_000);
		await op('window', 'setTitle', { windowId: other.windowId, title: 'E2E other' });
		await op('window', 'hide', { windowId: other.windowId });
		await op('app', 'hide');
		expect(await see('visible', { title: TITLE })).toBe('False');
		await op('app', 'showAll');
		expect(await see('visible', { title: TITLE })).toBe('True');
		expect(await see('visible', { title: 'E2E other' })).toBe('False');
		await op('window', 'close', { windowId: other.windowId });
		expect(await code('app', 'hideOthers')).toBe('unsupported');
	});

	const solid = (name: string, rgb: [number, number, number]) => {
		const file = join(dir, name);
		writeFileSync(file, Buffer.from(pngDataUrl(64, 64, () => [...rgb, 255]).split(',')[1]!, 'base64'));
		return file;
	};

	check('icon: setDockIcon is the windows\' icon, read back with WM_GETICON, for windows to come too; null restores the executable\'s', async () => {
		const red = solid('red.png', [250, 10, 10]), blue = solid('blue.png', [10, 10, 250]);
		const original = await see('icon', { title: TITLE, which: 1 });
		log('icon before', original);
		expect(await op('app', 'getDockIcon')).toBeNull();
		await op('app', 'setDockIcon', { icon: red });
		for (const which of [0, 1]) expect(await see('icon', { title: TITLE, which })).toMatch(/:25\d,1\d,1\d$|:250,10,10$/);
		expect(await op('app', 'getDockIcon')).toBe(red);
		await op('app', 'setIcon', { icon: blue });
		expect(await see('icon', { title: TITLE, which: 1 })).toMatch(/:1\d,1\d,25\d$/);
		const other = await op<{ windowId: number }>('window', 'create', { path: '/about', label: 'iconed', title: 'E2E iconed', width: 300, height: 200 });
		await until('it\'s there', async () => (await see('exists', { title: 'E2E iconed' })) === 'True', 15_000);
		await op('window', 'setTitle', { windowId: other.windowId, title: 'E2E iconed' });
		expect(await see('icon', { title: 'E2E iconed', which: 1 })).toMatch(/:1\d,1\d,25\d$/);
		await op('window', 'close', { windowId: other.windowId });
		expect(await code('app', 'setDockIcon', { icon: join(dir, 'missing.png') })).toBe('invalid_args');
		expect(await see('icon', { title: TITLE, which: 1 })).toMatch(/:1\d,1\d,25\d$/); // a refused one changes nothing
		await op('app', 'setDockIcon', { icon: null });
		expect(await op('app', 'getDockIcon')).toBeNull();
		const restored = await see('icon', { title: TITLE, which: 1 });
		expect(restored).not.toMatch(/:1\d,1\d,25\d$/);
		log('icon restored', restored);
	});

	check('icon: defaultWindowIcon is the executable\'s, whatever setDockIcon did', async () => {
		const first = await op<{ pngBase64: string }>('app', 'defaultWindowIcon');
		const png = Buffer.from(first.pngBase64, 'base64');
		expect(png.subarray(1, 4).toString()).toBe('PNG');
		expect(png.readUInt32BE(16)).toBeGreaterThan(15);
		await op('app', 'setDockIcon', { icon: solid('red.png', [250, 10, 10]) });
		expect((await op<{ pngBase64: string }>('app', 'defaultWindowIcon')).pngBase64).toBe(first.pngBase64);
		await op('app', 'setDockIcon', { icon: null });
		const file = join(dir, 'default.png');
		writeFileSync(file, png);
		const same = await ps(String.raw`param([string]$Png, [string]$Exe)
Add-Type -AssemblyName System.Drawing
$a = New-Object Drawing.Bitmap $Png; $b = [Drawing.Icon]::ExtractAssociatedIcon($Exe).ToBitmap()
$same = 0; $all = 0
for ($x = 0; $x -lt $a.Width; $x += 3) { for ($y = 0; $y -lt $a.Height; $y += 3) { $all++; if ($a.Width -ne $b.Width) { continue }; $p = $a.GetPixel($x, $y); $q = $b.GetPixel($x, $y); if ([Math]::Abs($p.R - $q.R) -lt 40 -and [Math]::Abs($p.G - $q.G) -lt 40 -and [Math]::Abs($p.B - $q.B) -lt 40) { $same++ } } }
"$same/$all $($a.Width) $($b.Width)"`, file, exe());
		log('default icon against the exe\'s', same.out, same.err);
		const [matched, total] = same.out.split(' ')[0]!.split('/').map(Number);
		expect(matched! / total!).toBeGreaterThan(0.9);
	});

	const WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
	check('activation policy: accessory is out of the taskbar, read back from the style; prohibited has no meaning here', async () => {
		const before = await see('taskbar');
		log('taskbar with the app', before.replace(/\n/g, ' | '));
		expect(await op('app', 'getActivationPolicy')).toBe('regular');
		expect(Number(await see('exstyle', { title: TITLE })) & WS_EX_TOOLWINDOW).toBe(0);
		expect(await op('app', 'setActivationPolicy', { policy: 'accessory' })).toBe(true);
		expect(await op('app', 'getActivationPolicy')).toBe('accessory');
		const ex = Number(await see('exstyle', { title: TITLE }));
		expect(ex & WS_EX_TOOLWINDOW).toBe(WS_EX_TOOLWINDOW);
		expect(ex & WS_EX_APPWINDOW).toBe(0);
		expect(await see('visible', { title: TITLE })).toBe('True');
		await Bun.sleep(800);
		const during = await see('taskbar');
		log('taskbar as an accessory', during.replace(/\n/g, ' | '));
		expect(before).toContain('Svelte Notes');
		expect(during).not.toContain('Svelte Notes');
		await shot('accessory');
		const other = await op<{ windowId: number }>('window', 'create', { path: '/about', label: 'tool', title: 'E2E tool', width: 300, height: 200 });
		await until('it\'s there', async () => (await see('exists', { title: 'E2E tool' })) === 'True', 15_000);
		await op('window', 'setTitle', { windowId: other.windowId, title: 'E2E tool' });
		expect(Number(await see('exstyle', { title: 'E2E tool' })) & WS_EX_TOOLWINDOW).toBe(WS_EX_TOOLWINDOW);
		await op('window', 'close', { windowId: other.windowId });
		expect(await op('app', 'setActivationPolicy', { policy: 'prohibited' })).toBe(false);
		expect(await op('app', 'getActivationPolicy')).toBe('accessory');
		expect(await code('app', 'setActivationPolicy', { policy: 'bogus' })).toBe('invalid_args');
		expect(await op('app', 'setActivationPolicy', { policy: 'regular' })).toBe(true);
		const back = Number(await see('exstyle', { title: TITLE }));
		expect(back & WS_EX_TOOLWINDOW).toBe(0);
		expect(back & WS_EX_APPWINDOW).toBe(WS_EX_APPWINDOW);
		await Bun.sleep(800);
		expect(await see('taskbar')).toContain('Svelte Notes');
	});

	// ── the clipboard ───────────────────────────────────────────────────────

	const CUSTOM = 'application/x-kitop-test';
	const binary = Uint8Array.from([0, 1, 2, 255, 0, 7]);

	check('clipboard.write: every representation, read by another process', async () => {
		const file = join(dir, 'clip file.txt');
		writeFileSync(file, 'x');
		const png = pngDataUrl(4, 3, () => [10, 20, 30, 128]).split(',')[1]!;
		const w = await op<{ changeCount: number; previousChangeCount: number }>('clipboard', 'write', { text: 'plain é ✓', html: '<b>rich</b>', rtf: '{\\rtf1 hi}', image: png, files: [file], formats: { [CUSTOM]: b64(binary) } });
		expect(w.changeCount).toBeGreaterThan(w.previousChangeCount);
		const r = await ps(CLIP_READ_PS1, specFile({ custom: CUSTOM }));
		if (r.code !== 0) throw new Error(r.err);
		const other = JSON.parse(r.out) as { formats: string[]; text: string; html: string; rtf: string; files: string[]; custom: string; png: string; bitmap: string };
		log('another process sees', other.formats, other.bitmap);
		expect(other.formats).toEqual(expect.arrayContaining(['UnicodeText', 'HTML Format', 'Rich Text Format', 'PNG', 'FileDrop', CUSTOM, 'Format17']));
		expect(Buffer.from(other.text, 'base64').toString()).toBe('plain é ✓');
		const cf = Buffer.from(other.html, 'base64').toString();
		expect(cf).toContain('StartFragment:');
		const start = Number(cf.match(/StartFragment:(\d+)/)![1]), end = Number(cf.match(/EndFragment:(\d+)/)![1]);
		expect(Buffer.from(cf).subarray(start, end).toString()).toBe('<b>rich</b>'); // its offsets are right, by the format's own rule
		expect(other.rtf).toContain('\\rtf1 hi');
		expect(other.files).toEqual([file]);
		expect(Buffer.from(other.custom, 'base64').equals(Buffer.from(binary))).toBe(true);
		const seenPng = Buffer.from(other.png, 'base64');
		expect([seenPng.readUInt32BE(16), seenPng.readUInt32BE(20)]).toEqual([4, 3]);
		expect(other.bitmap).toStartWith('4x3:'); // Windows made a bitmap out of CF_DIBV5
		const back = await op<{ changeCount: number; formats: Record<string, string | null> }>('clipboard', 'read', { formats: ['text/plain', 'text/html', 'text/rtf', 'image/png', 'files', CUSTOM, 'application/x-absent'] });
		const got = (f: string) => Buffer.from(back.formats[f] ?? '', 'base64');
		expect(got('text/plain').toString()).toBe('plain é ✓');
		expect(got('text/html').toString()).toBe('<b>rich</b>');
		expect(got('text/rtf').toString()).toBe('{\\rtf1 hi}');
		expect(got(CUSTOM).equals(Buffer.from(binary))).toBe(true);
		expect(got('image/png').subarray(1, 4).toString()).toBe('PNG');
		expect(got('files').toString()).toContain('clip%20file.txt');
		expect(back.formats['application/x-absent']).toBeNull();
		expect(await op('clipboard', 'availableFormats')).toEqual(expect.arrayContaining(['text/plain', 'text/html', 'text/rtf', 'image/png', 'files', CUSTOM]));
		expect(await op('clipboard', 'has', { format: CUSTOM })).toBe(true);
	});

	check('clipboard.read: what another process put there', async () => {
		const file = join(dir, 'from ps.txt');
		writeFileSync(file, 'y');
		const before = (await op<{ changeCount: number }>('clipboard', 'read', { formats: ['text/plain'] })).changeCount;
		const r = await ps(CLIP_WRITE_PS1, specFile({ text: b64('from powershell é'), custom: 'x-kitop-from-ps', bytes: b64(Uint8Array.from([9, 0, 8])), file }));
		if (r.code !== 0) throw new Error(r.err);
		const read = await op<{ changeCount: number; formats: Record<string, string | null> }>('clipboard', 'read', { formats: ['text/plain', 'text/html', 'x-kitop-from-ps', 'files', 'image/png', CUSTOM] });
		const got = (f: string) => Buffer.from(read.formats[f] ?? '', 'base64');
		expect(read.changeCount).toBeGreaterThan(before);
		expect(got('text/plain').toString()).toBe('from powershell é');
		expect(got('text/html').toString()).toBe('<i>from ps</i>');
		expect(got('x-kitop-from-ps').equals(Buffer.from([9, 0, 8]))).toBe(true);
		expect(got('files').toString()).toContain('from%20ps.txt');
		const png = got('image/png'); // a bitmap there, a PNG here
		expect([png.subarray(1, 4).toString(), png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual(['PNG', 5, 7]);
		expect(read.formats[CUSTOM]).toBeNull();
		expect(await op('clipboard', 'availableFormats')).toContain('x-kitop-from-ps');
	});

	check('clipboard: what the calls refuse, as on macOS', async () => {
		for (const args of [{ text: 1 }, { image: 'not an image' }, { formats: 'x' }, { formats: { x: 1 } }, { files: 'x' }, { files: ['relative.txt'] }, {}, { text: 'a', formats: { 'text/plain': b64('b') } }, { formats: { x: 'A'.repeat(23 * 1024 * 1024) } }])
			expect({ args: JSON.stringify(args).slice(0, 40), code: await code('clipboard', 'write', args) }).toEqual({ args: JSON.stringify(args).slice(0, 40), code: 'invalid_args' });
		for (const args of [{}, { formats: 'x' }, { formats: [''] }, { formats: [1] }, { formats: ['text/plain'], maxBytes: 0 }, { formats: ['text/plain'], maxBytes: 1.5 }, { formats: ['text/plain'], maxBytes: 17 * 1024 * 1024 }])
			expect(await code('clipboard', 'read', args)).toBe('invalid_args');
		await op('clipboard', 'write', { text: 'four' });
		expect(await code('clipboard', 'read', { formats: ['text/plain'], maxBytes: 3 })).toBe('invalid_args');
		expect(await code('clipboard', 'read', { formats: ['text/plain'], maxBytes: 4 })).toBe('ok');
		await op('clipboard', 'clear');
	});

	// ── route dialogs ───────────────────────────────────────────────────────

	const openSheet = (route: string, options: object = {}) => app.eval(`(window.__sheet = null, host.dialog.sheet(${JSON.stringify(route)}, ${JSON.stringify(options)}).then((r) => window.__sheet = { done: true, result: r ?? null }), 1)`);
	const sheetResult = () => app.eval<{ done: boolean; result: any } | null>(`window.__sheet`);
	const untilAnswered = async () => {
		await until('the opener\'s call has its answer', async () => !!(await sheetResult()), 10_000);
		return (await sheetResult())!.result;
	};
	const untilSheet = (title: string) => until(`the sheet ${title} shows`, async () => (await see('exists', { title })) === 'True' && (await see('visible', { title })) === 'True', 20_000);
	const gone = (title: string) => until(`${title} is gone`, async () => (await see('exists', { title })) === 'False', 10_000);

	check('dialog.close outside a sheet, and a sheet without a route, are refused', async () => {
		expect(await code('dialog', 'sheet', {})).toBe('invalid_args');
		expect(await app.eval(`host.dialog.close(1).then(() => 'ok', (e) => e.code)`)).toBe('invalid_args');
	});

	check('dialog.sheet: a real page, owned and modal, typed in and clicked for real, resolves its opener\'s call', async () => {
		await front();
		await app.eval(`(window.__clicks = 0, window.__count = () => window.__clicks++, document.addEventListener('mousedown', window.__count, true), 1)`);
		await openSheet('/sheet-probe?t=probe%20sheet', { width: 420, height: 230 });
		await untilSheet('probe sheet');
		await shot('sheet');
		expect(await see('owner', { title: 'probe sheet', owner: TITLE })).toBe('True');
		const r = await rect('probe sheet');
		const parent = await rect();
		expect([r.width >= 420, r.height >= 230, r.width <= 430, r.height <= 240]).toEqual([true, true, true, true]);
		expect(Math.abs(r.x + r.width / 2 - (parent.x + parent.width / 2))).toBeLessThan(3); // centered
		// Modal: the window takes no click, and only it: another window of the app is free.
		expect(await see('enabled', { title: TITLE })).toBe('False');
		await win('click', { title: TITLE, dx: 40, dy: 300 }).catch(() => {});
		await Bun.sleep(400);
		expect(await app.eval(`window.__clicks`)).toBe(0);
		// The input has the keyboard (its autofocus): real keys.
		await win('click', { title: 'probe sheet', dx: 200, dy: 125 });
		await win('keys', { keys: [0x48] });
		await win('keys', { keys: [0x49] });
		await win('click', { title: 'probe sheet', dx: 100, dy: 50 });
		const result = await untilAnswered();
		log('sheet result', result);
		expect(result).toMatchObject({ typed: 'hi', title: 'probe sheet' });
		expect(result.view).toStartWith('sheet-');
		expect(result.header).toBe(result.view); // X-Desktop-View reached the server
		await gone('probe sheet');
		expect(await see('enabled', { title: TITLE })).toBe('True');
		await Bun.sleep(300);
		await win('click', { title: TITLE, dx: 40, dy: 300 });
		await until('the window takes clicks again', async () => (await app.eval<number>(`window.__clicks`)) > 0);
		await app.eval(`(document.removeEventListener('mousedown', window.__count, true), 1)`);
	});

	check('dialog.sheet: Escape and its own Cancel button answer undefined; the styles', async () => {
		await openSheet('/sheet-probe?t=escape%20me');
		await untilSheet('escape me');
		await Bun.sleep(500);
		await win('keys', { title: 'escape me', keys: [0x1b] });
		expect(await untilAnswered()).toBeNull();
		await gone('escape me');

		await openSheet('/sheet-probe?t=attached%20one', { style: 'attached', width: 300, height: 200, top: 40 });
		await untilSheet('attached one');
		expect((await rect('attached one')).y).toBe(Number(await see('client-y', { title: TITLE })) + 40);
		await win('click', { title: 'attached one', dx: 220, dy: 50 }); // Cancel
		expect(await untilAnswered()).toBeNull();
		await gone('attached one');

		await openSheet('/sheet-probe?t=the%20page%20title', { style: 'window', width: 360, height: 220 });
		await untilSheet('the page title');
		const titled = await rect('the page title');
		expect(titled.height).toBeGreaterThan(220); // it has a title bar
		await win('post-close', { title: 'the page title' }); // its close button's message
		expect(await untilAnswered()).toBeNull();
		await gone('the page title');

		await openSheet('/sheet-probe?t=ignored', { style: 'window', title: 'Pick one', width: 360, height: 220 });
		await untilSheet('Pick one');
		await Bun.sleep(600);
		expect(await see('exists', { title: 'ignored' })).toBe('False');
		await win('post-close', { title: 'Pick one' });
		expect(await untilAnswered()).toBeNull();
		await gone('Pick one');
	}, 120_000);

	check('dialog.sheet: closing its parent closes it, the opener gets its answer; a route that never loads still shows', async () => {
		const other = await op<{ windowId: number }>('window', 'create', { path: '/about', label: 'parent', title: 'E2E parent', width: 700, height: 500 });
		await until('it shows', async () => (await see('exists', { title: 'E2E parent' })) === 'True', 15_000);
		await op('window', 'setTitle', { windowId: other.windowId, title: 'E2E parent' });
		await openSheet('/sheet-probe?t=orphan', { windowId: other.windowId });
		await untilSheet('orphan');
		const opened = op('dialog', 'sheet', { route: '/sheet-probe?t=orphan2', windowId: other.windowId });
		await untilSheet('orphan2');
		expect(await see('owner', { title: 'orphan2', owner: 'E2E parent' })).toBe('True');
		expect(await see('enabled', { title: TITLE })).toBe('True'); // only its parent
		// Two on it: the first to go leaves it blocked for the other.
		await win('post-close', { title: 'orphan' });
		await untilAnswered();
		await gone('orphan');
		expect(await see('enabled', { title: 'E2E parent' })).toBe('False');
		await op('window', 'close', { windowId: other.windowId });
		expect(await opened).toEqual({ result: null });
		await gone('orphan2');

		const started = Date.now();
		await app.eval(`(window.__sheet = null, host.dialog.sheet('/api/stats?never=1', {}).then((r) => window.__sheet = { done: true, result: r ?? null }), 1)`);
		await Bun.sleep(2000);
		log('a sheet of a page with no bridge script run after', Date.now() - started);
		const w = await see('windows');
		log('windows with it', w.replace(/\n/g, ' ; '));
		expect(w).toContain('KitopSheet');
		await win('keys', { keys: [0x1b] }).catch(() => {});
		await see('windows');
		// Whichever key reached it: nothing is left disabled.
		await until('the window takes input again', async () => {
			await ps(`Add-Type -Name P -Namespace Sd -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; [void][Sd.P]::PostMessage([Sd.P]::FindWindow('KitopSheet', $null), 0x10, [IntPtr]::Zero, [IntPtr]::Zero)`);
			return (await see('enabled', { title: TITLE })) === 'True';
		}, 10_000);
		await untilAnswered();
	}, 90_000);

	// ── menus ───────────────────────────────────────────────────────────────

	check('menu.closePopup: a real popup on screen, its id closes it, another\'s doesn\'t', async () => {
		await front();
		const p = await rect();
		const popup = op('menu', 'popup', { id: 'ctx', items: [{ id: 'one', label: 'One' }], x: p.x + 100, y: p.y + 100 });
		await until('the menu is on screen', async () => (await see('menu-open')) === 'True');
		await op('menu', 'closePopup', { id: 'another' });
		await Bun.sleep(300);
		expect(await see('menu-open')).toBe('True');
		let action = false;
		void app.nextEvent('menuAction', undefined, 3000).then(() => (action = true), () => {});
		await op('menu', 'closePopup', { id: 'ctx' });
		expect(await popup).toEqual({ dismissed: true });
		expect(await see('menu-open')).toBe('False');
		await Bun.sleep(500);
		expect(action).toBe(false);
		await op('menu', 'closePopup', { id: 'ctx' }); // nothing open: nothing happens
	});

	check('jump list: tasks stored where Windows keeps them; each, run as the shell runs it, reaches the app', async () => {
		expect(await op('menu', 'getDockMenu')).toBeNull();
		const items = [{ id: 'new-note', label: 'New note from the list' }, { type: 'separator' }, { label: 'By its label' }, { label: 'Off', id: 'off', enabled: false }, { role: 'hide', label: 'Hide it' }];
		await op('menu', 'setDockMenu', { items });
		expect(await op('menu', 'getDockMenu')).toEqual(items);
		const stored = jumpFiles();
		expect(stored).toContain('New note from the list');
		expect(stored).toContain('By its label');
		expect(stored).toContain('Hide it');
		expect(stored).not.toContain('Off');
		const tasks = [...new Set(stored.match(/--kitop-jump-task=[A-Za-z0-9+/=]+/g) ?? [])];
		log('stored tasks', tasks);
		expect(tasks.length).toBe(3);
		const run = async (arg: string) => {
			// Without this suite's test channel, as Windows starts it: the running app gets it, this one leaves.
			const { KITOP_TEST: _, ...env } = process.env;
			const second = Bun.spawn([exe(), arg], { env, stdout: 'ignore', stderr: 'ignore' });
			return within(30_000, 'the second instance', second.exited);
		};
		const argOf = (value: string) => `--kitop-jump-task=${b64(value)}`;
		expect(tasks).toEqual(expect.arrayContaining([argOf('new-note'), argOf('By its label'), argOf('role:hide')]));
		let second = false;
		void app.nextEvent('secondInstance', undefined, 25_000).then(() => (second = true), () => {});
		const first = app.nextEvent<{ id: string }>('menuAction', (e) => e.id === 'new-note', 25_000);
		await run(argOf('new-note'));
		expect((await first).id).toBe('new-note');
		const byLabel = app.nextEvent<{ id: string }>('menuAction', (e) => e.id === 'By its label', 25_000);
		await run(argOf('By its label'));
		expect((await byLabel).id).toBe('By its label');
		await run(argOf('role:hide'));
		await until('the role ran', async () => (await see('visible', { title: TITLE })) === 'False', 15_000);
		await op('app', 'showAll');
		expect(second).toBe(false);
		// The same from the real list on the taskbar: the second task, by a real click.
		const clicked = app.nextEvent<{ id: string }>('menuAction', (e) => e.id === 'By its label', 20_000);
		const ui = JSON.parse(await see('jump-list', { app: 'Svelte Notes', above: 166, path: process.env.WINDOWS_SHOTS ? join(process.env.WINDOWS_SHOTS, 'desktop-jump-list.png') : '' }));
		log('the jump list on screen', ui);
		expect(ui.opened).toBe(true);
		expect((await clicked).id).toBe('By its label');
		expect(await code('menu', 'setDockMenu', { items: [{ label: 'Nested', submenu: [{ label: 'x' }] }] })).toBe('invalid_args');
		expect(await code('menu', 'setDockMenu', { items: [{ role: 'bogus' }] })).toBe('invalid_args');
		expect(await op('menu', 'getDockMenu')).toEqual(items); // refused: what was there stays
		await op('menu', 'setDockMenu', { items: [] });
		expect(await op('menu', 'getDockMenu')).toBeNull();
		expect(jumpFiles()).not.toContain('New note from the list');
	}, 120_000);

	// ── bookmarks ───────────────────────────────────────────────────────────

	check('bookmarks: follow a file really moved on its volume, renamed, a folder too; stale once it isn\'t where it was', async () => {
		const root = join(dir, 'bookmarks');
		mkdirSync(join(root, 'a'), { recursive: true });
		mkdirSync(join(root, 'b', 'deep'), { recursive: true });
		const file = join(root, 'a', 'file.txt');
		writeFileSync(file, 'the content');
		const { bookmark } = await op<{ bookmark: string }>('files', 'createBookmark', { path: file });
		type Opened = { id: string; path: string; stale: boolean };
		const open = (b = bookmark) => op<Opened>('files', 'openBookmark', { bookmark: b });
		expect(await open()).toMatchObject({ path: file, stale: false });
		const renamed = join(root, 'a', 'renamed.txt');
		renameSync(file, renamed);
		expect(await open()).toMatchObject({ path: renamed, stale: true });
		const moved = join(root, 'b', 'deep', 'moved.txt');
		const r = await ps(`Move-Item -LiteralPath '${renamed}' -Destination '${moved}'`);
		expect(r.code).toBe(0);
		expect(existsSync(renamed)).toBe(false);
		const opened = await open();
		expect(opened).toMatchObject({ path: moved, stale: true });
		expect(readFileSync(opened.path, 'utf8')).toBe('the content');
		expect(await code('files', 'releaseBookmark', { id: opened.id })).toBe('ok');
		// A new bookmark from where it is now isn't stale.
		const again = (await op<{ bookmark: string }>('files', 'createBookmark', { path: moved })).bookmark;
		expect(await open(again)).toMatchObject({ path: moved, stale: false });
		// The folder it's in, moved with its contents.
		const folder = (await op<{ bookmark: string }>('files', 'createBookmark', { path: join(root, 'b') })).bookmark;
		renameSync(join(root, 'b'), join(root, 'c'));
		expect(await open(folder)).toMatchObject({ path: join(root, 'c'), stale: true });
		expect(await open(again)).toMatchObject({ path: join(root, 'c', 'deep', 'moved.txt'), stale: true });
	});

	check('bookmarks: something else in its place is stale, gone is unavailable, another volume loses it', async () => {
		const root = join(dir, 'bookmarks2');
		mkdirSync(root, { recursive: true });
		const file = join(root, 'f.txt');
		writeFileSync(file, 'one');
		const { bookmark } = await op<{ bookmark: string }>('files', 'createBookmark', { path: file });
		const replaced = join(root, 'replaced.txt');
		writeFileSync(replaced, 'two');
		rmSync(file);
		renameSync(replaced, file); // what an atomic save does: same path, another file
		expect(await op('files', 'openBookmark', { bookmark })).toMatchObject({ path: file, stale: true });
		rmSync(file);
		expect(await code('files', 'openBookmark', { bookmark })).toBe('unavailable');

		const elsewhere = process.env.RUNNER_TEMP;
		if (elsewhere && elsewhere[0]!.toLowerCase() !== root[0]!.toLowerCase()) {
			log('moving across volumes', root[0], elsewhere[0]);
			const local = join(root, 'crossing.txt'), far = join(realpathSync.native(elsewhere), `crossing-${Date.now()}.txt`);
			writeFileSync(local, 'x');
			const b = (await op<{ bookmark: string }>('files', 'createBookmark', { path: local })).bookmark;
			copyFileSync(local, far);
			rmSync(local); // a move across volumes is a copy
			expect(await code('files', 'openBookmark', { bookmark: b })).toBe('unavailable');
			rmSync(far);
		} else log('no second volume here');
		// What the calls refuse.
		expect(await code('files', 'createBookmark', { path: 'relative.txt' })).toBe('invalid_args');
		expect(await code('files', 'createBookmark', { path: join(root, 'missing.txt') })).toBe('unavailable');
		expect(await code('files', 'openBookmark', { bookmark: 'not a bookmark' })).toBe('invalid_args');
		expect(await code('files', 'openBookmark', { bookmark: b64(JSON.stringify({ path: 'x', volume: 'zz' })) })).toBe('invalid_args');
		// Through the host API, with the handle it gives.
		writeFileSync(file, 'again');
		const access = await app.eval<{ path: string; stale: boolean; released: null | undefined }>(`(async () => {
			const { bookmark } = await host.files.createBookmark(${JSON.stringify(file)});
			const access = await host.files.openBookmark(bookmark);
			return { path: access.path, stale: access.stale, released: (await access.release()) ?? null };
		})()`);
		expect(access).toEqual({ path: file, stale: false, released: null });
	});

	// ── thermal state, permissions, accessibility ───────────────────────────

	check('thermal state: Windows says nothing, and the call says so', async () => {
		expect(await code('power', 'getThermalState')).toBe('unavailable');
		expect(await code('power', 'thermalState')).toBe('unavailable');
		expect(await app.eval(`host.power.getThermalState().then((r) => r, (e) => e.code)`)).toBe('unavailable');
	});

	check('permissions.guide: nothing to float a panel over, so host.permissions.guide() falls back as documented', async () => {
		expect(await app.eval(`host.permissions.guide('camera', { open: false })`)).toMatchObject({ canceled: false, status: expect.stringMatching(/granted|denied/) });
		expect(await app.eval(`host.permissions.cancelGuide()`)).toEqual({ canceled: false });
		expect(await code('permissions', 'guideState')).toBe('unknown');
		expect(await op('system', 'checkPermission', { name: 'camera' })).toMatchObject({ status: expect.stringMatching(/granted|denied/) });
	});

	check('accessibility: the settings Windows has are read; differentiateWithoutColor is no setting of its own', async () => {
		const a = await op<Record<string, boolean>>('system', 'getAccessibility');
		expect(a).toMatchObject({ differentiateWithoutColor: false, highContrast: false });
		expect(typeof a.reduceMotion).toBe('boolean');
	});

	// ── Windows Hello ───────────────────────────────────────────────────────

	check('Windows Hello: what the runner really has, against the same WinRT call from another process', async () => {
		const r = await ps(HELLO_PS1);
		if (r.code !== 0) throw new Error(r.err);
		log('UserConsentVerifier says', r.out);
		const b = await op<{ available: boolean; type: string; enrolled: boolean }>('system', 'biometrics');
		log('system.biometrics', b);
		const expected: Record<string, object> = {
			DeviceNotPresent: { available: false, type: 'none', enrolled: false },
			NotConfiguredForUser: { available: false, type: 'windowsHello', enrolled: false },
			DisabledByPolicy: { available: false, type: 'windowsHello', enrolled: false },
			DeviceBusy: { available: false, type: 'windowsHello', enrolled: true },
			Available: { available: true, type: 'windowsHello', enrolled: true },
		};
		expect(b).toEqual(expected[r.out] as typeof b);
		expect(r.out).not.toBe('Available'); // this suite counts on it: nothing could answer the prompt
		const a = await op<{ authenticated: boolean; reason: string }>('secureStorage', 'authenticate', { reason: 'test this' });
		log('secureStorage.authenticate', a);
		expect(a.authenticated).toBe(false);
		expect(a.reason).toMatch(/Windows Hello/i);
		expect(await op('secureStorage', 'authenticate', { biometricsOnly: true })).toEqual({ authenticated: false, reason: expect.stringContaining('biometrics') });
		// The interfaces mingw-w64 has no header for: the runner's factories have them, under these ids.
		const hr = await see('factories', { pairs: [{ cls: 'Windows.Security.Credentials.UI.UserConsentVerifier', iid: '39E050C3-4E74-441A-8DC0-B81104DF949C' }, { cls: 'Windows.Storage.StorageFile', iid: '5984C710-DAF2-43C8-8BB4-A4D3EACFD03F' }, { cls: 'Windows.Storage.StorageFolder', iid: '08F327FF-85D5-48B9-AEE9-28511E339F9F' }, { cls: 'Windows.Storage.StorageFolder', iid: '00000000-1111-2222-3333-444444444444' }] });
		log('factories', hr);
		const [hello, files, folders, bogus] = hr.split(',').map(Number);
		expect(bogus).not.toBe(0); // the check itself can say no
		expect([hello, files, folders]).toEqual([0, 0, 0]);
	});

	// ── drag out and share ──────────────────────────────────────────────────

	const arm = (files: string[], icon?: string) => app.eval(`(() => {
		window.__dragged = null;
		document.addEventListener('mousedown', (e) => {
			e.preventDefault(); e.stopPropagation();
			host.shell.startDrag(${JSON.stringify(icon ? { files, icon } : { files })}).then((r) => window.__dragged = r, (e) => window.__dragged = { error: e.code });
		}, { capture: true, once: true });
		return 1;
	})()`);
	const drag = async (mode: { escape?: boolean; refuse?: boolean } = {}) => {
		const r = await rect();
		const out = await ps(DROP_PS1, specFile({ x: r.x + 200, y: r.y + 330, ...mode }));
		if (out.code !== 0) throw new Error(out.err || out.out);
		const [got, image, seen] = out.out.split('\n').map((l) => l.trim());
		log('the target saw', seen);
		return { got: got!, seen: seen! };
	};

	check('shell.startDrag: what it refuses', async () => {
		expect(await code('shell', 'startDrag', { files: [] })).toBe('invalid_args');
		expect(await code('shell', 'startDrag', { files: [join(dir, 'missing.txt')] })).toBe('invalid_args');
		const file = join(dir, 'd.txt');
		writeFileSync(file, 'x');
		expect(await code('shell', 'startDrag', { files: [file] })).toBe('not_dragging'); // no button down
	});

	check('shell.startDrag: the real mouse, from the page to another process\'s drop target, which gets the paths', async () => {
		await front();
		const one = join(dir, 'drag one.txt'), other = join(dir, 'drag two.txt');
		writeFileSync(one, 'one');
		writeFileSync(other, 'two');
		await arm([one, other], solid('red.png', [250, 10, 10]));
		const { got, seen } = await drag();
		log('the target got', got, 'the call', await app.eval(`window.__dragged`));
		expect(got.split('|').sort()).toEqual([one, other].sort());
		expect(seen).toContain('DragImageBits'); // what the shell's helper leaves for a target that shows it
		await until('the call answered', async () => !!(await app.eval(`window.__dragged`)), 10_000);
		expect(await app.eval(`window.__dragged`)).toEqual({ dropped: true });
		expect(existsSync(one)).toBe(true); // a copy offered: the file stays
	}, 90_000);

	for (const [name, mode] of [['Escape abandons it', { escape: true }], ['a target that refuses it', { refuse: true }]] as const)
		check(`shell.startDrag: ${name}, and nothing is dropped`, async () => {
			await front();
			await arm([join(dir, 'drag one.txt')]);
			expect((await drag(mode)).got).toBe('none');
			await until('the call answered', async () => !!(await app.eval(`window.__dragged`)), 10_000);
			expect(await app.eval(`window.__dragged`)).toEqual({ dropped: false });
		}, 90_000);

	check('shell.share: what it refuses, and the real sheet opening', async () => {
		expect(await code('shell', 'share', {})).toBe('invalid_args');
		expect(await code('shell', 'share', { url: 'not absolute' })).toBe('invalid_args');
		expect(await code('shell', 'share', { files: [join(dir, 'missing.txt')] })).toBe('invalid_args');
		const file = join(dir, 'share me.txt');
		writeFileSync(file, 'x');
		for (const [name, items] of [['text', { text: 'shared text' }], ['everything', { text: 'shared text', url: 'https://example.com/', files: [file] }]] as const) {
			await front();
			const before = new Set((await see('windows')).split('\n'));
			const shared = app.platform<{ service: string | null }>('shell', 'share', items).then((v) => ({ v }), (e) => ({ e }));
			let appeared: string[] = [];
			for (let i = 0; i < 40 && !appeared.length; i++) {
				await Bun.sleep(500);
				appeared = (await see('windows')).split('\n').filter((w) => !before.has(w));
				if (await Promise.race([shared.then(() => true), Bun.sleep(1).then(() => false)])) break;
			}
			log(name, 'windows that appeared', appeared);
			await Bun.sleep(4000);
			const shown = await see('sheet-ui').catch((e) => String(e));
			log(name, 'what the sheet shows', shown);
			await shot(`share-${name}`);
			const over = await Promise.race([shared, Bun.sleep(1).then(() => null)]);
			log(name, 'the call so far', over);
			await win('keys', { keys: [0x1b] });
			let answer = await Promise.race([shared, Bun.sleep(8000).then(() => null)]);
			log(name, 'after Escape', answer);
			if (!answer) {
				log(name, 'closing it', await see('sheet-ui', { close: true }).catch((e) => String(e)));
				answer = await Promise.race([shared, Bun.sleep(15_000).then(() => null)]);
				log(name, 'after its close button', answer);
			}
			log(name, 'windows left', (await see('windows')).split('\n').filter((w) => !before.has(w)));
			expect(over).toBeNull(); // it waits for the user
			expect(appeared.length).toBeGreaterThan(0);
			expect(shown).toContain('ControlType.Window|Share|');
			expect(app.stdout).not.toContain('shell.share');
			expect(answer).toEqual({ v: { service: null } });
		}
	}, 120_000);
});

// A real process's end, once per process. These leave no app behind.
describe.skipIf(!process.env.WINDOWS_E2E)('windows: the app really ending', () => {
	let app: AppHandle;
	const exited = (pid: number) => ps(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.WaitForExit(15000); "$($p.HasExited)" } else { 'True' }`).then((r) => r.out);
	const start = async () => {
		await stopLeftovers();
		app = await launch({ app: APP, timeout: 90_000 });
		await app.waitFor('#counter', { timeout: 30_000 });
		await app.platform('window', 'setTitle', { windowId: 0, title: TITLE });
		const m = await app.platform<{ processes: { pid: number; type: string }[] }>('app', 'metrics');
		return m.processes.find((p) => p.type === 'main')!.pid;
	};
	afterAll(async () => {
		await app?.close().catch(() => {});
	}, 30_000);

	test('a guard answers late: the session\'s end waits, and the app goes when it says yes', async () => {
		const pid = await start();
		await app.eval(`(host.app.onQuitRequested(async (r) => { await new Promise((d) => setTimeout(d, 1500)); return 'quit'; }), host.app.onBeforeQuit(async () => { await new Promise((d) => setTimeout(d, 300)); }), 1)`);
		await Bun.sleep(400);
		const stages: string[] = [];
		const seen = (name: string) => app.nextEvent<{ reason: string }>(name, undefined, 15_000).then((e) => { stages.push(`${name}:${e.reason}`); });
		const all = Promise.all([seen('quitRequested'), seen('beforeQuit'), seen('willQuit')]);
		const r = JSON.parse((await ps(SEE_PS1, 'session', specFile({ class: 'KitopHidden', hidden: ID, msg: 0x11, wp: 0, lp: 0x80000000 }))).out);
		expect(r).toMatchObject({ sent: true, answer: 0 });
		log('the answer, and the reason given', r);
		await all;
		expect(stages).toEqual(['quitRequested:logout', 'beforeQuit:logout', 'willQuit:logout']);
		expect(await exited(pid)).toBe('True');
	}, 150_000);

	test('WM_ENDSESSION: nobody can refuse now, the phases run, the process ends', async () => {
		const pid = await start();
		await app.eval(`(host.app.onQuitRequested(() => 'cancel'), 1)`);
		await Bun.sleep(400);
		const will = app.nextEvent<{ reason: string }>('willQuit', undefined, 15_000);
		const r = JSON.parse((await ps(SEE_PS1, 'session', specFile({ class: 'KitopHidden', hidden: ID, msg: 0x16, wp: 1, lp: 0 }))).out);
		log('WM_ENDSESSION', r);
		expect((await will).reason).toBe('shutdown');
		expect(await exited(pid)).toBe('True');
	}, 150_000);

	test('the Restart Manager closes the app when no guard objects', async () => {
		const pid = await start();
		const will = app.nextEvent<{ reason: string }>('willQuit', undefined, 40_000);
		const r = await ps(RESTART_MANAGER_PS1, String(pid));
		log('RmShutdown', r.out, r.err);
		expect((await will).reason).toBe('system');
		expect(r.out).toBe('0');
		expect(await exited(pid)).toBe('True');
	}, 150_000);

	// A console's Ctrl+Break: a console of its own, or it would reach this test too.
	test('a console\'s Ctrl+Break: the reason is signal, a guard can refuse it, and it can end the app', async () => {
		await stopLeftovers();
		const logFile = join(tmp, 'signal.log');
		const started = await ps(String.raw`param([string]$Bun, [string]$Harness, [string]$Suite, [string]$Lib, [string]$Log)
$env:KITOP_LIB = $Lib; $env:QUIT_LOG = $Log; $env:HARNESS_WINDOW = '{}'
$p = Start-Process -FilePath $Bun -ArgumentList @($Harness, $Suite) -WindowStyle Minimized -PassThru
"$($p.Id)"`, process.execPath, resolve(import.meta.dir, '../../../packages/shell/test/harness.ts'), resolve(import.meta.dir, 'windows-signal-suite.ts'), join(APP, 'shell.dll'), logFile);
		const pid = Number(started.out);
		expect(pid).toBeGreaterThan(0);
		const said = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : []);
		const until = async (what: string) => {
			for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(200)) if (said().includes(what)) return;
			throw new Error(`not said: ${what}, only ${said().join(', ')}`);
		};
		const breakIt = async () => {
			const r = await ps(String.raw`param([int]$Id)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class SdBreak {
  delegate bool Handler(uint t);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler h, bool add);
  [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint e, uint g);
  static Handler keep = t => true;
  public static string Send(int pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "attach failed " + Marshal.GetLastWin32Error();
    SetConsoleCtrlHandler(keep, true);
    bool sent = GenerateConsoleCtrlEvent(1, 0);
    System.Threading.Thread.Sleep(500);
    FreeConsole();
    return "sent " + sent;
  }
}
"@
[SdBreak]::Send($Id)`, String(pid));
			log('Ctrl+Break', r.out, r.err);
		};
		try {
			await until('ready');
			await breakIt();
			await until('asked signal');
			await until('cancelled signal');
			await until('still here');
			await breakIt();
			await until('asked signal again');
			expect(await ps(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.WaitForExit(20000); "$($p.HasExited)" } else { 'True' }`).then((r) => r.out)).toBe('True');
			log('what it said', said());
		} finally {
			await ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
		}
	}, 120_000);

	test('quitOnLastWindowClosed: the last window\'s WM_CLOSE and close button are vetoed; a delayed and a stuck guard, to the process\'s end', async () => {
		await stopLeftovers();
		const harness = resolve(import.meta.dir, '../../../packages/shell/test/harness.ts'), suite = resolve(import.meta.dir, 'windows-quit-suite.ts');
		const proc = Bun.spawn([process.execPath, harness, suite], { env: { ...process.env, KITOP_LIB: join(APP, 'shell.dll'), HARNESS_WINDOW: JSON.stringify({ quitOnLastWindowClosed: true }) }, stdout: 'pipe', stderr: 'pipe' });
		const code = await within(180_000, 'the harness', proc.exited);
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const lines = out.split('\n').flatMap((l) => {
			try {
				return [JSON.parse(l) as { check?: string; pass?: boolean; detail?: unknown; summary?: { passed: number; failed: number } }];
			} catch {
				return [];
			}
		});
		for (const l of lines) if (l.check) log(l.pass ? 'ok' : 'FAILED', l.check, l.pass ? '' : JSON.stringify(l.detail));
		if (err.trim()) log('harness stderr', err.slice(-1500));
		expect(lines.filter((l) => l.check && !l.pass).map((l) => l.check)).toEqual([]);
		expect(lines.find((l) => l.summary)?.summary?.passed).toBeGreaterThan(10);
		expect(code).toBe(0);
	}, 200_000);
});
