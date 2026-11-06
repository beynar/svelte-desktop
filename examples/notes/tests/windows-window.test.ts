// The window operations macOS has, on a real Windows runner, read back from another process through Win32 and DWM
// and driven with the real mouse: a border dragged, a title bar dragged, a click that doesn't activate.
//   WINDOWS_E2E=1 [WINDOWS_APP=<app folder>] bun test --timeout 120000 tests/windows-window.test.ts
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launch, type AppHandle } from '@kitop/shell/test';
import { APP, driver, log, ps, stopLeftovers, tmp, win } from './windows-input.ts';

const TITLE = 'E2E window ops';
const SHOTS = process.env.WINDOWS_SHOTS ?? tmp;

// What another process sees, through Win32 and DWM.
const FACTS_PS1 = String.raw`param([string]$Mode, [string]$Spec)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic; using System.Diagnostics;
public static class SdWinFacts {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetLong(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int n);
  [StructLayout(LayoutKind.Sequential)] public struct MARGINS { public int L, R, T, B; }
  [DllImport("dwmapi.dll")] public static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref MARGINS m);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a, uint p, IntPtr v, uint f);
  [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static extern int DwmGetRect(IntPtr h, int a, out RECT v, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  public static string Title(IntPtr h) { if (h == IntPtr.Zero) return ""; var t = new StringBuilder(512); GetWindowText(h, t, 512); return t.ToString(); }
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { if (Title(h) == title) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string[] Windows() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      string name = ""; try { name = Process.GetProcessById((int)pid).ProcessName; } catch {}
      list.Add(c + "|" + Title(h) + "|" + name);
      return true; }, IntPtr.Zero);
    return list.ToArray();
  }
}
"@
[void][SdWinFacts]::SetProcessDPIAware()
$s = Get-Content -Raw -Encoding UTF8 $Spec | ConvertFrom-Json
function Hwnd { $h = [SdWinFacts]::Find($s.title); if ($h -eq [IntPtr]::Zero) { throw "no window titled '$($s.title)'" }; $h }
function Dwm($h, $attr) { $v = 0; $hr = [SdWinFacts]::DwmGetWindowAttribute($h, $attr, [ref]$v, 4); if ($hr -ne 0) { return $null }; $v }
function Rc($r) { @{ x = $r.L; y = $r.T; width = $r.R - $r.L; height = $r.B - $r.T } }
switch ($Mode) {
  'facts' {
    $h = Hwnd
    $r = New-Object SdWinFacts+RECT; [void][SdWinFacts]::GetWindowRect($h, [ref]$r)
    $c = New-Object SdWinFacts+RECT; [void][SdWinFacts]::GetClientRect($h, [ref]$c)
    $at = New-Object SdWinFacts+POINT; [void][SdWinFacts]::ClientToScreen($h, [ref]$at)
    $caption = New-Object SdWinFacts+RECT; $hasCaption = [SdWinFacts]::DwmGetRect($h, 5, [ref]$caption, 16) -eq 0
    $visible = New-Object SdWinFacts+RECT; [void][SdWinFacts]::DwmGetRect($h, 9, [ref]$visible, 16)
    $ex = [SdWinFacts]::GetLong($h, -20).ToInt64()
    $style = [SdWinFacts]::GetLong($h, -16).ToInt64()
    @{ frame = (Rc $r); client = @{ x = $at.X; y = $at.Y; width = $c.R; height = $c.B }; visibleFrame = (Rc $visible); caption = $(if ($hasCaption) { Rc $caption } else { $null })
       topmost = ($ex -band 8) -ne 0; noActivate = ($ex -band 0x08000000) -ne 0; hasCaptionStyle = ($style -band 0xC00000) -eq 0xC00000; shown = [SdWinFacts]::IsWindowVisible($h)
       owner = [SdWinFacts]::Title([SdWinFacts]::GetWindow($h, 4)); foreground = [SdWinFacts]::Title([SdWinFacts]::GetForegroundWindow())
       backdrop = (Dwm $h 38); ncRendering = (Dwm $h 1); screen = @{ width = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; height = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height }
    } | ConvertTo-Json -Compress -Depth 4
  }
  'foreground' { [SdWinFacts]::Title([SdWinFacts]::GetForegroundWindow()) }
  'exists' { "$([SdWinFacts]::Find($s.title) -ne [IntPtr]::Zero)" }
  'pixel' {
    $b = New-Object Drawing.Bitmap 1, 1; $g = [Drawing.Graphics]::FromImage($b); $g.CopyFromScreen([int]$s.x, [int]$s.y, 0, 0, (New-Object Drawing.Size 1, 1)); $g.Dispose()
    $p = $b.GetPixel(0, 0); $b.Dispose(); @{ r = $p.R; g = $p.G; b = $p.B } | ConvertTo-Json -Compress
  }
  'root-at' { $p = New-Object SdWinFacts+POINT; $p.X = [int]$s.x; $p.Y = [int]$s.y; [SdWinFacts]::Title([SdWinFacts]::GetAncestor([SdWinFacts]::WindowFromPoint($p), 2)) }
  'press' { [void][SdWinFacts]::SetCursorPos([int]$s.x, [int]$s.y); Start-Sleep -Milliseconds 200; [SdWinFacts]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [SdWinFacts]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); 'pressed' }
  'windows' { [SdWinFacts]::Windows() -join [char]10 }
  'drop-shadows' { "$([SdWinFacts]::SystemParametersInfo(0x1025, 0, [IntPtr]1, 3))" }
  'control' { # What the runner's DWM draws for a window that isn't a web view: a black form over its frame.
    $f = New-Object System.Windows.Forms.Form; $f.BackColor = 'Black'; $f.StartPosition = 'Manual'; $f.Text = 'E2E control'
    $f.Bounds = New-Object Drawing.Rectangle ([int]$s.x), ([int]$s.y), 300, 200; $f.TopMost = $true; $f.Show(); [System.Windows.Forms.Application]::DoEvents()
    $k = [int]$s.kind; $m = New-Object SdWinFacts+MARGINS; $m.L = -1; $m.R = -1; $m.T = -1; $m.B = -1
    $hr = [SdWinFacts]::DwmSetWindowAttribute($f.Handle, 38, [ref]$k, 4); [void][SdWinFacts]::DwmExtendFrameIntoClientArea($f.Handle, [ref]$m)
    for ($i = 0; $i -lt 15; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
    $b = New-Object Drawing.Bitmap 1, 1; $g = [Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(([int]$s.x + 150), ([int]$s.y + 120), 0, 0, (New-Object Drawing.Size 1, 1)); $g.Dispose()
    $p = $b.GetPixel(0, 0); $b.Dispose()
    $f.Close()
    @{ hr = $hr; r = $p.R; g = $p.G; b = $p.B } | ConvertTo-Json -Compress
  }
  'shot' {
    $o = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object Drawing.Bitmap $o.Width, $o.Height; $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($o.Left, $o.Top, 0, 0, $bmp.Size)
    $bmp.Save($s.path, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); 'saved'
  }
}
`;
const see = async (mode: string, spec: object = {}) => {
	const file = join(tmp, `f${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify(spec));
	const r = await ps(FACTS_PS1, mode, file);
	if (r.code !== 0) throw new Error(`${mode} failed: ${r.err || r.out}`);
	return r.out;
};
type Rect = { x: number; y: number; width: number; height: number };
type Facts = { frame: Rect; client: Rect; visibleFrame: Rect; caption: Rect | null; topmost: boolean; noActivate: boolean; hasCaptionStyle: boolean; shown: boolean; owner: string; foreground: string; backdrop: number | null; ncRendering: number | null; screen: { width: number; height: number } };
const facts = async (title = TITLE) => JSON.parse(await see('facts', { title })) as Facts;
const pixel = async (x: number, y: number) => JSON.parse(await see('pixel', { x, y })) as { r: number; g: number; b: number };
const shot = async (name: string) => {
	if (process.env.WINDOWS_SHOTS) await see('shot', { path: join(SHOTS, `window-${name}.png`) }).catch(() => {});
};
const near = (a: number, b: number, by = 3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(by);

describe.skipIf(!process.env.WINDOWS_E2E)('windows: the window operations', () => {
	let app: AppHandle;
	const { op, code, check, until } = driver(() => app);
	const main = { windowId: 0 };
	const HOME = { ...main, x: 20, y: 20, width: 540, height: 460 }; // the runner's screen is 1024 x 768
	const box = (color: string) => `<!doctype html><body style="margin:0;height:100vh;background:${color}">`;
	const open = async (title: string, options: Record<string, unknown> = {}) => {
		const { windowId } = await op<{ windowId: number }>('window', 'create', { label: title, title, html: box('#fff'), width: 380, height: 280, x: 600, y: 300, hiddenUntilReady: false, ...options });
		await until(`${title} is on the screen`, async () => (await see('exists', { title })) === 'True');
		return windowId;
	};

	const start = async () => {
		app = await launch({ app: APP, timeout: 90_000 });
		await app.waitFor('#counter', { timeout: 30_000 });
		await op('window', 'setTitle', { ...main, title: TITLE });
		await op('window', 'setTitleBarStyle', { ...main, style: 'default' });
		await op('window', 'setMinSize', { ...main, width: 0, height: 0 });
		await op('window', 'setBounds', HOME);
	};

	beforeAll(async () => {
		await stopLeftovers();
		await start();
	}, 150_000);
	afterAll(async () => {
		await app?.close().catch(() => {});
	}, 30_000);

	check('report: what is registered, and what stays out', async () => {
		const { services } = await op<{ services: Record<string, Record<string, string>> }>('capabilities', 'describe');
		for (const name of ['setAspectRatio', 'getAspectRatio', 'setParent', 'getParent', 'getChildren', 'getLevel', 'setHasShadow', 'hasShadow', 'setSimpleFullscreen', 'isSimpleFullscreen', 'setMovable', 'isMovable', 'setFocusable', 'isFocusable', 'controlsArea', 'showCharacterPalette', 'setVibrancy', 'getVibrancy', 'setGlass', 'getGlass'])
			expect({ name, status: services.window?.[name] }).toEqual({ name, status: 'implemented' });
		for (const name of ['setRepresentedFilename', 'getRepresentedFilename', 'setTrafficLightPosition', 'getTrafficLightPosition', 'invalidateShadow', 'setMovableByWindowBackground', 'isMovableByWindowBackground', 'setVisibleOnAllWorkspaces', 'isVisibleOnAllWorkspaces', 'setMaterialRegions', 'testScroll'])
			expect({ name, code: await code('window', name, main) }).toEqual({ name, code: 'unsupported' });
	});

	check('aspect ratio: a border really dragged keeps it, from a corner and from an edge; freed, it does not', async () => {
		expect(await op('window', 'getAspectRatio', main)).toBeNull();
		await op('window', 'setAspectRatio', { ...main, ratio: 2 });
		expect(await op('window', 'getAspectRatio', main)).toBe(2);
		const at = await facts();
		await win('drag', { title: TITLE, dx: at.frame.width - 3, dy: at.frame.height - 3, byX: 160, byY: -40 });
		await Bun.sleep(300);
		const corner = await facts();
		log('after the corner', corner.frame, corner.client);
		expect(corner.client.width).toBeGreaterThan(at.client.width + 100);
		near(corner.client.width / corner.client.height, 2, 0.03);
		await win('drag', { title: TITLE, dx: Math.floor(corner.frame.width / 2), dy: corner.frame.height - 3, byX: 0, byY: -60 });
		await Bun.sleep(300);
		const edge = await facts();
		log('after the edge', edge.frame, edge.client);
		expect(edge.client.height).toBeLessThan(corner.client.height - 40);
		near(edge.client.width / edge.client.height, 2, 0.03);
		await op('window', 'setAspectRatio', { ...main, ratio: 0 });
		expect(await op('window', 'getAspectRatio', main)).toBeNull();
		await op('window', 'setBounds', HOME);
		const free = await facts();
		await win('drag', { title: TITLE, dx: free.frame.width - 3, dy: free.frame.height - 3, byX: 100, byY: -100 });
		await Bun.sleep(300);
		const after = await facts();
		near(after.frame.width, free.frame.width + 100, 6);
		near(after.frame.height, free.frame.height - 100, 6);
		await op('window', 'setBounds', HOME);
		// At creation.
		const id = await open('E2E aspect', { aspectRatio: 1, width: 300, height: 300, x: 600, y: 100 });
		expect(await op('window', 'getAspectRatio', { windowId: id })).toBe(1);
		const sq = await facts('E2E aspect');
		await win('drag', { title: 'E2E aspect', dx: sq.frame.width - 3, dy: sq.frame.height - 3, byX: 60, byY: 10 });
		await Bun.sleep(300);
		const sq2 = await facts('E2E aspect');
		near(sq2.client.width, sq2.client.height, 2);
		await op('window', 'close', { windowId: id });
	});

	check('parent: Windows sees the owner; it takes the child down with it, and closes it', async () => {
		const child = await open('E2E child', { parentId: 0, x: 300, y: 200 });
		expect((await facts('E2E child')).owner).toBe(TITLE);
		expect(await op('window', 'getParent', { windowId: child })).toMatchObject({ windowId: 0 });
		expect(await op('window', 'getInfo', { windowId: child })).toMatchObject({ parentId: 0 });
		expect(await op('window', 'getInfo', main)).toMatchObject({ parentId: null });
		expect((await op<{ windowId: number }[]>('window', 'getChildren', main)).map((w) => w.windowId)).toEqual([child]);
		expect(await code('window', 'setParent', { ...main, parentId: child })).toBe('invalid_args');
		expect(await code('window', 'setParent', { windowId: child, parentId: 999 })).toBe('invalid_args');
		expect(await code('window', 'setParent', { windowId: child })).toBe('invalid_args');
		expect(await code('window', 'create', { label: 'no-parent', parentId: 999 })).toBe('invalid_args');
		// Above its owner, even once the owner has the foreground.
		await win('click', { title: TITLE, dx: 50, dy: 10 });
		const c = await facts('E2E child');
		expect((await facts()).foreground).toBe(TITLE);
		expect(await see('root-at', { x: c.client.x + 100, y: c.client.y + 100 })).toBe('E2E child');
		// Off the screen with it.
		await op('window', 'minimize', main);
		await until('the child goes with its owner', async () => !(await facts('E2E child')).shown);
		await op('window', 'unminimize', main);
		await until('and comes back with it', async () => (await facts('E2E child')).shown);
		await op('window', 'setParent', { windowId: child, parentId: null });
		expect((await facts('E2E child')).owner).toBe('');
		expect(await op('window', 'getParent', { windowId: child })).toBeNull();
		await op('window', 'setParent', { windowId: child, parentId: 0 });
		expect((await facts('E2E child')).owner).toBe(TITLE);
		await op('window', 'setParent', { windowId: child, parentId: null });
		// Closing a parent closes what it owns.
		const grand = await open('E2E grandchild', { parentId: child, x: 340, y: 240 });
		const closed: number[] = [];
		const gone = Promise.all([app.nextEvent('closed', (e: { windowId: number }) => (closed.push(e.windowId), e.windowId === child), 10_000)]);
		await op('window', 'close', { windowId: child });
		await gone;
		await until('both are gone', async () => (await see('exists', { title: 'E2E child' })) === 'False' && (await see('exists', { title: 'E2E grandchild' })) === 'False');
		expect((await op<unknown[]>('window', 'list')).length).toBe(1);
		expect(closed).toContain(grand);
	});

	check('level: follows always on top and bottom, as Windows has them', async () => {
		expect(await op('window', 'getLevel', main)).toBe(0);
		await op('window', 'setAlwaysOnTop', { ...main, enabled: true });
		expect((await facts()).topmost).toBe(true);
		expect(await op('window', 'getLevel', main)).toBe(3);
		await op('window', 'setAlwaysOnTop', { ...main, enabled: false });
		expect((await facts()).topmost).toBe(false);
		await op('window', 'setAlwaysOnBottom', { ...main, enabled: true });
		expect(await op('window', 'getLevel', main)).toBeLessThan(0);
		await op('window', 'setAlwaysOnBottom', { ...main, enabled: false });
		expect(await op('window', 'getLevel', main)).toBe(0);
	});

	check('shadow: DWM stops drawing the frame: the pixels under the window and in its title bar say so', async () => {
		log('drop shadows on', await see('drop-shadows'));
		const back = await open('E2E white', { x: 0, y: 0, width: 1000, height: 720 });
		await win('click', { title: TITLE, dx: 200, dy: 10 });
		await Bun.sleep(600);
		const below = async () => {
			const v = (await facts()).visibleFrame;
			return pixel(v.x + v.width / 2, v.y + v.height + 4);
		};
		expect(await op('window', 'hasShadow', main)).toBe(true);
		expect((await facts()).ncRendering).toBe(1);
		const shadowed = await below();
		const barAt = async () => { const v = (await facts()).visibleFrame; return pixel(v.x + 250, v.y + 8); };
		const bar = await barAt();
		await shot('shadow-on');
		await op('window', 'setHasShadow', { ...main, enabled: false });
		expect(await op('window', 'hasShadow', main)).toBe(false);
		expect((await facts()).ncRendering).toBe(0);
		await Bun.sleep(600);
		const bare = await below();
		const flatBar = await barAt();
		await shot('shadow-off');
		log('under the window', { shadowed, bare }, 'title bar', { bar, flatBar });
		expect(bare).toEqual({ r: 255, g: 255, b: 255 });
		expect(flatBar).not.toEqual(bar);
		await op('window', 'setHasShadow', { ...main, enabled: true });
		expect(await op('window', 'hasShadow', main)).toBe(true);
		expect((await facts()).ncRendering).toBe(1);
		await Bun.sleep(600);
		log('shadow back', await below());
		expect(await barAt()).toEqual(bar);
		await op('window', 'close', { windowId: back });
	});

	check('simple full screen: borderless over the monitor and the taskbar, not the full-screen state, and back', async () => {
		const before = await facts();
		expect(await op('window', 'isSimpleFullscreen', main)).toEqual({ simpleFullscreen: false });
		await op('window', 'setSimpleFullscreen', { ...main, enabled: true });
		const over = await facts();
		expect(over.frame).toEqual({ x: 0, y: 0, width: over.screen.width, height: over.screen.height });
		expect(over.hasCaptionStyle).toBe(false);
		expect(await op('window', 'isSimpleFullscreen', main)).toEqual({ simpleFullscreen: true });
		expect(await op('window', 'isFullscreen', main)).toBe(false);
		expect(await see('root-at', { x: 40, y: over.screen.height - 10 })).toBe(TITLE); // where the taskbar is
		await shot('simple-fullscreen');
		// One or the other: the native kind takes over, and leaves the window as it first was.
		await op('window', 'setFullscreen', { ...main, fullscreen: true });
		expect(await op('window', 'isSimpleFullscreen', main)).toEqual({ simpleFullscreen: false });
		await op('window', 'setFullscreen', { ...main, fullscreen: false });
		const back = await facts();
		expect(back.frame).toEqual(before.frame);
		expect(back.hasCaptionStyle).toBe(true);
		await op('window', 'setSimpleFullscreen', { ...main, enabled: true });
		await op('window', 'setSimpleFullscreen', { ...main, enabled: false });
		expect((await facts()).frame).toEqual(before.frame);
	});

	check('movable: a real drag of the title bar stays put, the shell can still move it, and it moves again', async () => {
		expect(await op('window', 'isMovable', main)).toBe(true);
		await op('window', 'setMovable', { ...main, enabled: false });
		expect(await op('window', 'isMovable', main)).toBe(false);
		const at = await facts();
		await win('drag', { title: TITLE, dx: 200, dy: 16, byX: 120, byY: 70 });
		await Bun.sleep(300);
		expect((await facts()).frame).toEqual(at.frame);
		await op('window', 'setPosition', { ...main, x: 140, y: 90 });
		const moved = await facts();
		near(moved.frame.x, 140, 1);
		await op('window', 'setMovable', { ...main, enabled: true });
		await win('drag', { title: TITLE, dx: 200, dy: 16, byX: 120, byY: 70 });
		await Bun.sleep(300);
		const again = await facts();
		near(again.frame.x, moved.frame.x + 120, 4);
		near(again.frame.y, moved.frame.y + 70, 4);
		await op('window', 'setBounds', HOME);
		// At creation.
		const id = await open('E2E fixed', { movable: false });
		const f = await facts('E2E fixed');
		await win('drag', { title: 'E2E fixed', dx: 150, dy: 16, byX: 100, byY: 50 });
		await Bun.sleep(300);
		expect((await facts('E2E fixed')).frame).toEqual(f.frame);
		await op('window', 'close', { windowId: id });
	});

	check('focusable: a real click reaches the page, and the foreground ends where it was', async () => {
		const id = await open('E2E unfocusable', { focusable: false, html: `${box('#fff')}<script>addEventListener('mousedown',()=>{window.pressed=(window.pressed||0)+1})</script>`, x: 600, y: 200 });
		const windowId = { windowId: id };
		expect((await facts('E2E unfocusable')).noActivate).toBe(true);
		expect(await op('window', 'isFocusable', windowId)).toBe(false);
		expect(await op('window', 'getInfo', windowId)).toMatchObject({ focusable: false });
		expect(await code('window', 'focus', windowId)).toBe('unavailable');
		expect(await code('window', 'showCharacterPalette', windowId)).toBe('unavailable');
		await win('click', { title: TITLE, dx: 200, dy: 10 });
		await until('the main window has the foreground', async () => (await see('foreground')) === TITLE);
		const u = await facts('E2E unfocusable');
		await see('press', { x: u.client.x + 100, y: u.client.y + 100 });
		await until('the page got the press', async () => (await op<number>('window', 'eval', { ...windowId, js: 'window.pressed' })) === 1);
		await Bun.sleep(500);
		expect(await see('foreground')).toBe(TITLE);
		expect(await op('window', 'isFocused', windowId)).toBe(false);
		// Its title bar: the style alone holds that one.
		await see('press', { x: u.frame.x + 100, y: u.frame.y + 12 });
		await Bun.sleep(500);
		expect(await see('foreground')).toBe(TITLE);
		// The other way: the same click takes the foreground.
		await op('window', 'setFocusable', { ...windowId, enabled: true });
		expect((await facts('E2E unfocusable')).noActivate).toBe(false);
		await see('press', { x: u.client.x + 100, y: u.client.y + 100 });
		await until('now it does', async () => (await see('foreground')) === 'E2E unfocusable');
		// And back while it has it: it lets go.
		await op('window', 'setFocusable', { ...windowId, enabled: false });
		await until('it gives the foreground up', async () => (await see('foreground')) !== 'E2E unfocusable');
		await op('window', 'close', { windowId: id });
	});

	check('controlsArea: what DWM reports; its buttons are where a real click works them; none without a caption', async () => {
		const id = await open('E2E controls');
		const windowId = { windowId: id };
		type Button = Rect & { visible: boolean };
		const area = await op<Rect & { contentTop: number; side: string; buttons: { close: Button; minimize: Button; zoom: Button } }>('window', 'controlsArea', windowId);
		const f = await facts('E2E controls');
		log('controls', area, f.caption);
		expect(area.side).toBe('right');
		expect({ x: area.x, y: area.y, width: area.width, height: area.height }).toEqual(f.caption!);
		expect(area.contentTop).toBe(f.client.y - f.frame.y);
		expect(area.buttons.close.visible).toBe(true);
		expect(area.buttons.minimize.x).toBeLessThan(area.buttons.zoom.x);
		expect(area.buttons.zoom.x).toBeLessThan(area.buttons.close.x);
		const middle = (b: Button) => ({ x: f.frame.x + b.x + b.width / 2, y: f.frame.y + b.y + b.height / 2 });
		await see('press', middle(area.buttons.minimize));
		await until('the minimize button minimized it', async () => (await op<{ minimized: boolean }>('window', 'isMinimized', windowId)).minimized);
		await op('window', 'unminimize', windowId);
		await Bun.sleep(400);
		await op('window', 'setCloseVeto', { ...windowId, enabled: true });
		await win('click', { title: 'E2E controls', dx: 60, dy: 10 });
		const asked = app.nextEvent('willClose', (e: { windowId: number }) => e.windowId === id, 10_000);
		await see('press', middle(area.buttons.close));
		await asked;
		await op('window', 'setCloseVeto', { ...windowId, enabled: false });
		await op('window', 'setTitleBarStyle', { ...windowId, style: 'hidden' });
		expect(await op('window', 'controlsArea', windowId)).toBeNull();
		await op('window', 'close', windowId);
	});

	// The system answers: its input host opens its window, which wasn't there. On the runner's Windows Server that window stays cloaked, so no panel is drawn.
	check('showCharacterPalette: Win+period, for real, with the window in front', async () => {
		const host = async () => (await see('windows')).split('\n').some((w) => w.includes('|TextInputHost'));
		expect(await host()).toBe(false);
		await app.eval(`document.querySelector('input').focus(), 1`);
		await op('window', 'showCharacterPalette', main);
		await until('the system opens its input host', host);
		expect(await see('foreground')).toBe(TITLE);
		await win('keys', { keys: [0x1b] });
	});

	// The runner has no GPU. WebView2 then paints its page opaque, `transparent: true` too, unless it's told to use
	// the software adapter; and DWM draws each backdrop as a flat color, the same for a window that isn't a web view.
	// So: the color DWM gives a black form with that backdrop is the color that has to come through the page.
	check('materials: the backdrop DWM says the window has, and that it comes through a transparent page', async () => {
		await app.close();
		process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--use-angle=d3d11-warp --ignore-gpu-blocklist';
		await start().finally(() => delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS);
		const title = 'E2E backdrop';
		const id = await open(title, { html: box('transparent'), x: 300, y: 150, width: 500, height: 400 });
		const windowId = { windowId: id };
		const middle = async () => {
			await win('click', { title, dx: 60, dy: 10 });
			await Bun.sleep(1200);
			const f = await facts(title);
			return pixel(f.client.x + f.client.width / 2, f.client.y + f.client.height / 2);
		};
		const form = async (kind: number) => JSON.parse(await see('control', { x: 350, y: 200, kind })) as { hr: number; r: number; g: number; b: number };
		expect(await op('window', 'getVibrancy', windowId)).toBeNull();
		expect(await code('window', 'setVibrancy', { ...windowId, material: 'nope' })).toBe('invalid_args');
		const answer = await code('window', 'setVibrancy', { ...windowId, material: 'sidebar' });
		const build = Number((await ps(`[System.Environment]::OSVersion.Version.Build`)).out);
		log('OS build', build, 'setVibrancy', answer);
		if (build < 22621) {
			expect(answer).toBe('unavailable');
			expect(await op('window', 'getVibrancy', windowId)).toBeNull();
			expect(await code('window', 'setGlass', { ...windowId, glass: {} })).toBe('unavailable');
			return void (await op('window', 'close', windowId));
		}
		expect(answer).toBe('ok');
		expect((await facts(title)).backdrop).toBe(2); // Mica
		expect(await op('window', 'getVibrancy', windowId)).toEqual({ material: 'sidebar', state: 'followsWindow' });
		const close = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
			near(a.r, b.r, 4);
			near(a.g, b.g, 4);
			near(a.b, b.b, 4);
		};
		const mica = await form(2);
		log('a black form with Mica', mica);
		const page = await middle();
		log('the page on Mica', page);
		close(page, mica);
		await op('window', 'setVibrancy', { ...windowId, material: 'titlebar', state: 'active' });
		expect((await facts(title)).backdrop).toBe(4); // Mica Alt
		expect(await op('window', 'getVibrancy', windowId)).toEqual({ material: 'titlebar', state: 'followsWindow' }); // no such choice here
		await op('window', 'setVibrancy', { ...windowId, material: 'hud' });
		expect((await facts(title)).backdrop).toBe(3); // Acrylic
		const acrylic = await form(3);
		log('a black form with Acrylic', acrylic);
		const onAcrylic = await middle();
		log('the page on Acrylic', onAcrylic);
		close(onAcrylic, acrylic);
		expect(acrylic).not.toEqual(mica);
		// Bigger: the new part of the window has it too.
		await op('window', 'setBounds', { ...windowId, x: 250, y: 100, width: 640, height: 520 });
		await Bun.sleep(500);
		const grown = await facts(title);
		await win('click', { title, dx: 60, dy: 10 });
		await Bun.sleep(1200);
		close(await pixel(grown.client.x + grown.client.width - 30, grown.client.y + grown.client.height - 30), acrylic);
		// macOS before version 26: the underWindow material, { glass: false }, and no glass to read back.
		expect(await code('window', 'setGlass', { ...windowId, glass: { style: 'bogus' } })).toBe('invalid_args');
		expect(await code('window', 'setGlass', { ...windowId, glass: { tint: 'red' } })).toBe('invalid_args');
		expect(await op('window', 'setGlass', { ...windowId, glass: { style: 'clear', tint: '#336699', cornerRadius: 12 } })).toEqual({ glass: false });
		expect(await op('window', 'getGlass', windowId)).toBeNull();
		expect(await op('window', 'getVibrancy', windowId)).toEqual({ material: 'underWindow', state: 'followsWindow' });
		expect((await facts(title)).backdrop).toBe(3);
		await op('window', 'setGlass', { ...windowId, glass: null });
		expect(await op('window', 'getVibrancy', windowId)).toBeNull();
		expect((await facts(title)).backdrop).toBe(1); // none
		await Bun.sleep(600);
		expect(await middle()).toEqual({ r: 255, g: 255, b: 255 }); // the web view's opaque white again
		await op('window', 'close', windowId);
		// At creation.
		const made = await open('E2E made', { vibrancy: 'window', html: box('transparent') });
		expect((await facts('E2E made')).backdrop).toBe(2);
		expect(await op('window', 'getVibrancy', { windowId: made })).toEqual({ material: 'window', state: 'followsWindow' });
		await op('window', 'close', { windowId: made });
		// A page's regions are refused, what materials.ts takes quietly, and the page goes on.
		expect(await code('window', 'setMaterialRegions', { ...main, regions: [{ id: 1, material: 'sidebar', x: 0, y: 0, width: 10, height: 10, radius: 0 }] })).toBe('unsupported');
		expect(await app.eval(`document.documentElement.hasAttribute('data-desktop-materials')`)).toBe(false);
	}, 150_000);

	check('document edited: the title bar has the mark, getTitle does not', async () => {
		expect(await op('window', 'isDocumentEdited', main)).toEqual({ edited: false });
		await op('window', 'setDocumentEdited', { ...main, edited: true });
		expect(await see('exists', { title: `• ${TITLE}` })).toBe('True');
		expect(await op('window', 'getTitle', main)).toBe(TITLE);
		await op('window', 'setTitle', { ...main, title: 'E2E renamed' });
		expect(await see('exists', { title: '• E2E renamed' })).toBe('True');
		await op('window', 'setDocumentEdited', { ...main, edited: false });
		expect(await see('exists', { title: 'E2E renamed' })).toBe('True');
		await op('window', 'setTitle', { ...main, title: TITLE });
	});
});
