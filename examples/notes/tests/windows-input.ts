// What the Windows e2e files share: running PowerShell, real input through Win32 and UI Automation,
// and calls that fail a test instead of hanging it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppHandle } from '@kitop/shell/test';

export const APP = resolve(process.env.WINDOWS_APP ?? '.desktop/dist/Svelte Notes-windows-x64');
export const tmp = process.platform === 'win32' ? mkdtempSync(join(tmpdir(), 'sd-win-')) : '';
export const log = (...a: unknown[]) => console.log('[windows-e2e]', ...a);

export async function ps(script: string, ...args: string[]) {
	const file = join(tmp, `s${Math.random().toString(36).slice(2)}.ps1`);
	writeFileSync(file, script);
	const p = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { out: out.trim(), err: err.trim(), code };
}

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
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
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
function Wait-Window($title, $tries = 40) {
  for ($i = 0; $i -lt $tries; $i++) { $h = [SdWin]::Find($title); if ($h -ne [IntPtr]::Zero) { return $h }; Start-Sleep -Milliseconds 250 }
  throw "no window titled '$title'"
}
function Rect($h) { $r = New-Object SdWin+RECT; [void][SdWin]::GetWindowRect($h, [ref]$r); return $r }
function Front($h) { [SdWin]::Chord([byte[]]@(0x87)); [void][SdWin]::SetForegroundWindow($h); Start-Sleep -Milliseconds 300 } # F24: any input lifts the foreground lock; Alt would open a menu bar
function Press($x, $y) { [void][SdWin]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 120; [SdWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero) }
function Release { [SdWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
function Descendant($h, [scriptblock]$pred) {
  $root = $A::FromHandle($h)
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
  'enabled' { $h = Wait-Window $s.title; "$([SdWin]::IsWindowEnabled($h))" }
  'child-button' { $h = Wait-Window $s.title; $b = Descendant $h { param($e) $e.Current.Name -eq $s.button }; Invoke-El $b; 'pressed' }
  'dialog-button' { $h = Wait-Window $s.title; $b = Descendant $h { param($e) $e.Current.AutomationId -like 'CommandButton_*' -and $e.Current.Name -eq $s.button }; Invoke-El $b; 'pressed' }
  'file-dialog' { # The file name box of the common dialog (1001 saving, 1148 opening; WM_SETTEXT), then its default button.
    $h = Wait-Window $s.title 120 # the shell can take a while to open one: over 11 s has been seen on the runner
    $edit = Descendant $h { param($e) $e.Current.ClassName -eq 'Edit' -and @('1001', '1148') -contains $e.Current.AutomationId }
    [void][SdWin]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, $s.path)
    Start-Sleep -Milliseconds 300
    $ok = Descendant $h { param($e) $e.Current.AutomationId -eq '1' }
    Invoke-El $ok; 'chosen'
  }
}
`;

export async function win(mode: string, spec: object) {
	const file = join(tmp, `w${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify(spec));
	const r = await ps(INPUT_PS1, mode, file);
	if (r.code !== 0) throw new Error(`${mode} failed: ${r.err || r.out}`);
	return r.out;
}

/** The suite before closes its app; a copy still going would take the next launch for a second instance, and its browser process would hold the profile. */
export async function stopLeftovers() {
	const left = await ps(`Get-CimInstance Win32_Process -Filter "name='SvelteNotes.exe' or name='msedgewebview2.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.Name }`);
	if (left.out) log('stopped what was still running', left.out.replace(/\s+/g, ' '));
}

export const within = <T>(ms: number, what: string, p: Promise<T>) =>
	Promise.race([p, Bun.sleep(ms).then(() => { throw Object.assign(new Error(`${what}: no answer within ${ms} ms`), { code: 'timeout' }); })]);
// A real file drag from another process: a window offers the paths through OLE, and the real mouse
// drags from it to (x, y), then lets go there, or comes back and lets go on itself ('leave').
const FILE_DRAG_PS1 = String.raw`param([string]$Spec)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Threading; using System.Windows.Forms;
public static class SdDrag {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  static void Move(int x, int y) { mouse_event(0x8001, (x * 65535) / (GetSystemMetrics(0) - 1), (y * 65535) / (GetSystemMetrics(1) - 1), 0, UIntPtr.Zero); }
  static void Glide(int x0, int y0, int x1, int y1) { for (int i = 1; i <= 15; i++) { Move(x0 + (x1 - x0) * i / 15, y0 + (y1 - y0) * i / 15); Thread.Sleep(40); } }
  public static void Run(string[] paths, int x, int y, bool leave) {
    SetProcessDPIAware();
    var form = new Form { Text = "kitop-drag", StartPosition = FormStartPosition.Manual, Bounds = new Rectangle(10, 10, 200, 200), TopMost = true };
    var data = new DataObject(DataFormats.FileDrop, paths);
    form.MouseDown += (s, e) => form.DoDragDrop(data, DragDropEffects.Copy | DragDropEffects.Move | DragDropEffects.Link);
    form.Shown += (s, e) => new Thread(() => {
      Thread.Sleep(400);
      form.Invoke((Action)(() => { form.Activate(); SetForegroundWindow(form.Handle); }));
      Thread.Sleep(300);
      Move(110, 110); Thread.Sleep(150);
      mouse_event(2, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(250);
      Glide(110, 110, x, y); Thread.Sleep(700);
      if (leave) { Glide(x, y, 110, 110); Thread.Sleep(500); }
      mouse_event(4, 0, 0, 0, UIntPtr.Zero); Thread.Sleep(700);
      form.Invoke((Action)(() => form.Close()));
    }) { IsBackground = true }.Start();
    Application.Run(form);
  }
}
"@
$s = Get-Content -Raw $Spec | ConvertFrom-Json
[SdDrag]::Run([string[]]@($s.paths), [int]$s.x, [int]$s.y, [bool]$s.leave)
'dragged'
`;

export async function fileDrag(spec: { paths: string[]; x: number; y: number; leave?: boolean }) {
	const file = join(tmp, `d${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(file, JSON.stringify(spec));
	const r = await ps(FILE_DRAG_PS1, file);
	if (r.code !== 0) throw new Error(`file drag failed: ${r.err || r.out}`);
	return r.out;
}

/** Calls on the app under test. Each test is bounded; once the app stops answering, the rest fail at once. */
export function driver(getApp: () => AppHandle) {
	let stopped = ''; // the test where the app stopped answering
	const op = <T = any>(service: string, name: string, args: Record<string, unknown> = {}, ms = 20_000) =>
		within(ms, `${service}.${name}`, getApp().platform<T>(service, name, args));
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
					log('app output', getApp()?.stdout?.slice(-2000));
				}
				throw e;
			}
		}, ms);
	const until = async (what: string, fn: () => Promise<boolean>, ms = 10_000) => {
		for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (await fn().catch(() => false)) return;
		throw new Error(`timed out: ${what}`);
	};
	const inView = <T = any>(id: string, code: string, ms = 20_000) => op<T>('view', 'executeJavaScript', { id, code }, ms);
	return { op, code, check, until, inView };
}
