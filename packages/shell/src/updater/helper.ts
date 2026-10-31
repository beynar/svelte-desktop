/**
 * The post-exit swap helper. A running executable cannot be replaced safely in
 * place on every OS, so apply() writes a tiny script, starts it detached, and
 * quits. The script waits for our PID to disappear, swaps files (keeping the
 * previous ones as `<name>.old`), writes the state file, and optionally
 * relaunches. If any move fails it restores what it already moved.
 *
 * All values are embedded as quoted literals (no argument parsing in the
 * script); quoting is single-quote based for both sh and PowerShell.
 */
import type { Move } from "./state.ts";

export interface HelperPlan {
	waitPid: number;
	waitTimeoutSec: number;
	moves: Move[];
	statePath: string;
	logPath: string;
	/** Precomputed state JSON written on each outcome. */
	appliedJson: string;
	failedTimeoutJson: string;
	failedSwapJson: string;
	/** argv to relaunch the app with, or null. */
	relaunch: string[] | null;
	relaunchCwd: string;
}

export function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function psQuote(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

export function renderShHelper(p: HelperPlan): string {
	const q = shQuote;
	const exists = (path: string) => `{ [ -e ${q(path)} ] || [ -L ${q(path)} ]; }`;
	const relaunch = p.relaunch
		? `  log "relaunching"\n  (cd ${q(p.relaunchCwd)} && nohup ${p.relaunch.map(q).join(" ")} >/dev/null 2>&1 &)`
		: "  :";
	const restore = [...p.moves]
		.map((m, i) => ({ m, i }))
		.reverse()
		.map(
			({ m, i }) =>
				`  if ${exists(m.backup)}; then rm -rf ${q(m.dest)}; mv -f ${q(m.backup)} ${q(m.dest)}; elif [ "$DONE_${i}" = 1 ]; then rm -rf ${q(m.dest)}; fi`,
		)
		.join("\n");
	const swap = p.moves
		.map(
			(m, i) =>
				`if ${exists(m.dest)}; then mv -f ${q(m.dest)} ${q(m.backup)} || fail; fi\nmv -f ${q(m.src)} ${q(m.dest)} || fail\nDONE_${i}=1`,
		)
		.join("\n");
	return `#!/bin/sh
# svelte-desktop updater helper (generated; safe to delete).
STATE=${q(p.statePath)}
exec >>${q(p.logPath)} 2>&1
log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*"; }
write_state() { printf '%s\\n' "$1" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"; }
relaunch() {
${relaunch}
}
${p.moves.map((_, i) => `DONE_${i}=0`).join("\n")}
restore() {
  log "swap failed, restoring previous files"
${restore || "  :"}
}
fail() { restore; write_state ${q(p.failedSwapJson)}; relaunch; exit 1; }

log "helper $$ waiting for pid ${p.waitPid}"
deadline=$(( $(date +%s) + ${p.waitTimeoutSec} ))
while kill -0 ${p.waitPid} 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "timed out waiting for pid ${p.waitPid}"
    write_state ${q(p.failedTimeoutJson)}
    exit 1
  fi
  sleep 0.1
done

# Drop stale backups from an older update before touching anything.
${p.moves.map((m) => `rm -rf ${q(m.backup)}`).join("\n")}
${swap}
write_state ${q(p.appliedJson)}
log "applied"
relaunch
rm -f "$0"
exit 0
`;
}

export function renderPs1Helper(p: HelperPlan): string {
	const q = psQuote;
	let relaunch = "  # relaunch not requested";
	if (p.relaunch) {
		const [exe, ...args] = p.relaunch;
		const argList = args.length ? ` -ArgumentList @(${args.map(q).join(", ")})` : "";
		relaunch = `  Log 'relaunching'\n  Start-Process -FilePath ${q(exe!)}${argList} -WorkingDirectory ${q(p.relaunchCwd)}`;
	}
	const restore = [...p.moves]
		.map((m, i) => ({ m, i }))
		.reverse()
		.map(
			({ m, i }) =>
				`  if (Test-Path -LiteralPath ${q(m.backup)}) { Remove-PathQuiet ${q(m.dest)}; Move-Item -LiteralPath ${q(m.backup)} -Destination ${q(m.dest)} -Force }\n  elseif ($script:done[${i}]) { Remove-PathQuiet ${q(m.dest)} }`,
		)
		.join("\n");
	const swap = p.moves
		.map(
			(m, i) =>
				`  if (Test-Path -LiteralPath ${q(m.dest)}) { Move-Retry ${q(m.dest)} ${q(m.backup)} }\n  Move-Retry ${q(m.src)} ${q(m.dest)}\n  $script:done[${i}] = $true`,
		)
		.join("\n");
	return `# svelte-desktop updater helper (generated; safe to delete).
$ErrorActionPreference = 'Stop'
$StatePath = ${q(p.statePath)}
$LogPath = ${q(p.logPath)}
function Log([string]$m) { Add-Content -LiteralPath $LogPath -Value ("[{0}] {1}" -f (Get-Date -Format o), $m) }
function Write-State([string]$json) {
  $tmp = "$StatePath.tmp"
  [System.IO.File]::WriteAllText($tmp, $json)  # UTF-8 without BOM
  if (Test-Path -LiteralPath $StatePath) { Remove-Item -LiteralPath $StatePath -Force }
  Move-Item -LiteralPath $tmp -Destination $StatePath
}
function Remove-PathQuiet([string]$p) {
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
}
# Files can stay locked briefly after exit (AV scanners, WebView2 children): retry.
function Move-Retry([string]$src, [string]$dst) {
  for ($i = 0; $i -lt 40; $i++) {
    try { Move-Item -LiteralPath $src -Destination $dst -ErrorAction Stop; return }
    catch { Start-Sleep -Milliseconds 250 }
  }
  throw "cannot move $src -> $dst"
}
function Relaunch {
${relaunch}
}
$script:done = @{}
function Restore {
  Log 'swap failed, restoring previous files'
${restore || "  # nothing to restore"}
}

$TargetPid = ${p.waitPid}
Log "helper $PID waiting for pid $TargetPid"
$deadline = (Get-Date).AddSeconds(${p.waitTimeoutSec})
while (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) {
  if ((Get-Date) -gt $deadline) {
    Log "timed out waiting for pid $TargetPid"
    Write-State ${q(p.failedTimeoutJson)}
    exit 1
  }
  Start-Sleep -Milliseconds 100
}

try {
${p.moves.map((m) => `  Remove-PathQuiet ${q(m.backup)}`).join("\n")}
${swap}
  Write-State ${q(p.appliedJson)}
  Log 'applied'
} catch {
  Log "error: $_"
  try { Restore } catch { Log "restore error: $_" }
  Write-State ${q(p.failedSwapJson)}
  Relaunch
  exit 1
}
Relaunch
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
exit 0
`;
}

export function windowsPowerShell(): string {
	return `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** argv used to start the helper script. */
export function helperCommand(platform: string, scriptPath: string): string[] {
	if (platform === "win32") {
		return [windowsPowerShell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath];
	}
	return ["/bin/sh", scriptPath];
}
