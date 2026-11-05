// The app's command in the user's terminal, like VS Code's `code`: desktop.config `command: 'notes'`,
// then `notes report.md ~/Projects` opens those in the app — the running one if it is (onOpenFiles).
// Server code installs it (a menu item, a settings page): host.command.install().
//
//   macOS: Contents/Resources/bin/<command> (written by the build) runs `open -a <the app>` with the
//   files and folders; other arguments reach a new launch only (`open --args`). The link goes in a
//   folder of the user's shell PATH they can write to (~/.local/bin, ~/bin, /opt/homebrew/bin), or
//   in /usr/local/bin after the system's administrator prompt.
//   Linux: a link to the app's executable (the AppImage) in ~/.local/bin; the single instance hands
//   the arguments to the running app.
//   Windows: not yet.
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { shellEnv } from "./shell-env.ts";

export interface CommandStatus {
  /** The command's name (desktop.config `command`), or null when the app has none. */
  name: string | null;
  /** Whether this build can install it (a built app on macOS or Linux). */
  available: boolean;
  /** Where it's installed, when it is (a link to this app). */
  path: string | null;
  /** Whether that folder is on the user's shell PATH (a new terminal finds the command). */
  onPath: boolean;
}

/** desktop.config `command`, set for the app's processes by its entry (src/adapter.js). */
const commandName = (): string | null => process.env.KITOP_COMMAND || null;

/** What the link points to: the launcher script in the bundle (macOS), the app's executable (Linux). */
function target(name: string): string | null {
  if (process.platform === "darwin") {
    const script = resolve(dirname(process.execPath), "../Resources/bin", name);
    return existsSync(script) ? script : null;
  }
  if (process.platform === "linux") return process.env.APPIMAGE ?? (process.execPath.endsWith("/bun") ? null : process.execPath);
  return null;
}

const writable = (dir: string) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

async function pathDirs(): Promise<string[]> {
  return ((await shellEnv()).PATH ?? "").split(":").filter(Boolean);
}

function linkedHere(link: string, to: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === to;
  } catch {
    return false;
  }
}

export const command = {
  async status(): Promise<CommandStatus> {
    const name = commandName();
    const to = name ? target(name) : null;
    if (!name || !to) return { name, available: false, path: null, onPath: false };
    const dirs = await pathDirs();
    const candidates = [...new Set([...dirs, join(homedir(), ".local/bin"), join(homedir(), "bin"), "/opt/homebrew/bin", "/usr/local/bin"])];
    const path = candidates.map((d) => join(d, name)).find((l) => linkedHere(l, to)) ?? null;
    return { name, available: true, path, onPath: !!path && dirs.includes(dirname(path)) };
  },

  /** Installs the command; resolves where. Does nothing (path null) where it's not available:
   *  `vite dev`, an app without one, Windows. */
  async install(): Promise<{ path: string | null; onPath: boolean }> {
    const name = commandName();
    const to = name ? target(name) : null;
    if (!name || !to) return { path: null, onPath: false };
    const dirs = await pathDirs();
    const home = homedir();
    // A folder of the user's PATH they can write to, preferring their own.
    const own = [join(home, ".local/bin"), join(home, "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    let dir = own.find((d) => dirs.includes(d) && existsSync(d) && writable(d));
    if (!dir && process.platform === "linux") {
      dir = join(home, ".local/bin"); // the XDG place, on most distributions' PATH once it exists
      mkdirSync(dir, { recursive: true });
    }
    if (dir) {
      const link = join(dir, name);
      if (existsSync(link) || isLink(link)) unlinkSync(link);
      symlinkSync(to, link);
      return { path: link, onPath: dirs.includes(dir) };
    }
    // macOS: /usr/local/bin, after the system's administrator prompt.
    const link = `/usr/local/bin/${name}`;
    const sh = `mkdir -p /usr/local/bin && ln -sf ${quote(to)} ${quote(link)}`;
    const r = Bun.spawnSync(["osascript", "-e", `do shell script ${appleScriptString(sh)} with administrator privileges with prompt ${appleScriptString(`Install the \`${name}\` command in /usr/local/bin`)}`], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`host.command: not installed${/-128/.test(r.stderr.toString()) ? " (canceled)" : `: ${r.stderr.toString().trim()}`}`);
    return { path: link, onPath: dirs.includes("/usr/local/bin") };
  },

  /** Removes the command where it links to this app. */
  async uninstall(): Promise<void> {
    const { path } = await command.status();
    if (!path) return;
    try {
      unlinkSync(path);
    } catch {
      const r = Bun.spawnSync(["osascript", "-e", `do shell script ${appleScriptString(`rm -f ${quote(path)}`)} with administrator privileges`], { stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`host.command: not removed: ${r.stderr.toString().trim()}`);
    }
  },
};

function isLink(p: string) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const appleScriptString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The launcher script for macOS bundles (Contents/Resources/bin/<command>). */
export function macLauncher(appName: string): string {
  return `#!/bin/sh
# Opens files and folders in ${appName} (the running app if it is). Installed by the app as a link.
# Other arguments reach a new launch only.
self="$0"
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
app=$(cd "$(dirname "$self")/../../.." && pwd)
# One argument per line: names with spaces stay whole, nothing is globbed.
set -f
IFS='
'
files=""
others=""
for arg in "$@"; do
  if [ -e "$arg" ]; then files="$files
$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")"; else others="$others
$arg"; fi
done
if [ -n "$others" ]; then exec open -a "$app" $files --args $others; fi
exec open -a "$app" $files
`;
}
