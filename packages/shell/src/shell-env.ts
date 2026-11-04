// The user's shell environment, for server code that runs their tools (git, node, uv, claude,
// codex…). An app opened from the Finder, the Dock or Spotlight on macOS — or a desktop launcher on
// Linux — inherits the session's environment, not the one their terminal builds: PATH lacks
// Homebrew, nvm, ~/.local/bin and the rest, so `Bun.spawn(['claude'])` fails there while it works
// from a terminal. `shellEnv()` asks the user's login shell for its environment, once, the way a
// terminal would; `which()` finds a command on its PATH.
//
//   const env = await host.shellEnv();
//   const codex = await host.which('codex');
//   if (codex) Bun.spawn([codex, 'app-server'], { env });
//
// Windows: GUI apps get the user's environment from the registry, so it's process.env as is.

const MARK = "__SVELTE_DESKTOP_ENV__";

export interface ShellEnvOptions {
  /** Ask the shell again (the result is kept after the first call). */
  refresh?: boolean;
  /** How long the shell may take, in ms. Default 5000: past it, the app's own environment. */
  timeoutMs?: number;
}

let cached: Promise<Record<string, string>> | null = null;

const own = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));

/** The environment of the user's login shell, merged over the app's own. */
export function shellEnv(options: ShellEnvOptions = {}): Promise<Record<string, string>> {
  if (cached && !options.refresh) return cached;
  cached = read(options.timeoutMs ?? 5000);
  return cached;
}

async function read(timeoutMs: number): Promise<Record<string, string>> {
  const base = own();
  if (process.platform === "win32") return base;
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  // Interactive and login, as a terminal opens it (rc files set PATH as often as profiles do).
  // `env -0` between marks: whatever the rc files print around it is ignored.
  const script = `printf '%s' '${MARK}'; command env -0; printf '%s' '${MARK}'`;
  const args = /\/(fish|nu)$/.test(shell) ? ["-l", "-c", script] : ["-i", "-l", "-c", script];
  try {
    const proc = Bun.spawn([shell, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      // No terminal to talk to, and no prompt theme or plugin manager that would wait for one.
      env: { ...base, TERM: "dumb", DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTARTED: "true", ZSH_TMUX_AUTOSTART: "false", POWERLEVEL9K_INSTANT_PROMPT: "off" },
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const start = out.indexOf(MARK);
    const end = out.lastIndexOf(MARK);
    if (start < 0 || end <= start) return base;
    const env: Record<string, string> = {};
    for (const entry of out.slice(start + MARK.length, end).split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    // The shell's own bookkeeping isn't the user's environment.
    for (const k of ["_", "SHLVL", "PWD", "OLDPWD"]) delete env[k];
    return { ...base, ...env };
  } catch {
    return base;
  }
}

/** The absolute path of `command` on the user's shell PATH, or null. */
export async function which(command: string, options: ShellEnvOptions = {}): Promise<string | null> {
  const env = await shellEnv(options);
  return Bun.which(command, { PATH: env.PATH ?? process.env.PATH ?? "" }) ?? null;
}
