// Flags for `bun build --compile` shared by the packagers. `--trim` drops the Bun APIs the app
// never calls — the Bun command line alone is ~45 MB (notes: 86 → 51 MB with --aot) — and is on
// by default when the Bun compiling has it (experimental: canary today); `build.trim: false`
// turns it off. `--aot` (machine code at build time, ~8 MB more off) stays opt-in.
import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "../config.ts";

const support = new Map<string, Promise<{ trim: boolean; aot: boolean }>>();

/** What this Bun's compiler supports. */
export function compilerFeatures(bun: string): Promise<{ trim: boolean; aot: boolean }> {
  let p = support.get(bun);
  if (!p) {
    p = $`${bun} build --help`.nothrow().quiet().then((r) => {
      const help = r.stdout.toString();
      return { trim: /^\s+--trim\b/m.test(help), aot: /^\s+--aot\b/m.test(help) };
    });
    support.set(bun, p);
  }
  return p;
}

/** The trim / aot flags for this build; `aot` false where it can't apply (cross-compiling). */
export async function sizeFlags(c: ResolvedConfig, bun: string, opts: { aot: boolean; warn: (m: string) => void }): Promise<string[]> {
  const has = await compilerFeatures(bun);
  const flags: string[] = [];
  if (c.build?.trim ?? has.trim) {
    if (has.trim) flags.push("--trim", "--trim-locales=en");
    else opts.warn("build.trim: this Bun has no --trim (canary today: build.bun or $KITOP_BUN) — skipped");
  }
  if (c.build?.aot && opts.aot) {
    if (has.aot) flags.push("--aot");
    else opts.warn("build.aot: this Bun has no --aot (canary today: build.bun or $KITOP_BUN) — skipped");
  }
  return flags;
}

// The Bun runtime in the executable obeys these before any of the app's code runs: BUN_BE_BUN=1
// makes it the bun command line, BUN_OPTIONS=--preload runs a file in it, BUN_INSPECT (and its
// _CONNECT_TO, _PRELOAD) opens a debugger on it. In a build made to be distributed, whoever starts
// the app would borrow its identity (its keychain items, its OS permissions) that way. Bun has no
// flag for this. The same length under another name: the runtime never finds them set.
const RUNTIME_SWITCHES = ["BUN_BE_BUN", "BUN_OPTIONS", "BUN_INSPECT"];

export function closeRuntimeSwitches(exe: string): void {
  const bytes = readFileSync(exe);
  for (const name of RUNTIME_SWITCHES) {
    let found = 0;
    for (const encoding of ["latin1", "utf16le"] as const) {
      const wanted = Buffer.from(name, encoding);
      const other = Buffer.from(`KTP${name.slice(3)}`, encoding);
      for (let at = bytes.indexOf(wanted); at >= 0; at = bytes.indexOf(wanted, at + wanted.length), found++) other.copy(bytes, at);
    }
    // A Bun that keeps it some other way: better no build than one that still obeys.
    if (!found) throw new Error(`${name} isn't in the Bun runtime of ${exe}: this Bun can't be closed for a build to distribute. Pin the Bun version kitop was tested with.`);
  }
  writeFileSync(exe, bytes);
}

/** `bun build --compile` of the staged entries. A target runtime that can't be trimmed (a cross
 *  build: Bun downloads that target's runtime, without the trim table) is built again without. */
export async function compileStaged(bun: string, stage: string, out: string, flags: string[], warn: (m: string) => void, distributed: boolean): Promise<void> {
  const run = (f: string[]) => $`${bun} build --compile ${f} ${join(stage, "desktop-main.js")} ${join(stage, "desktop-supervisor.js")} ${join(stage, "desktop-worker.js")} --outfile ${out}`.cwd(stage).nothrow().quiet();
  let r = await run(flags);
  if (r.exitCode !== 0 && flags.includes("--trim") && /doesn't support --trim/.test(r.stderr.toString())) {
    warn("--trim: this target's Bun runtime can't be trimmed (cross build) — built without");
    r = await run(flags.filter((f) => f !== "--trim" && !f.startsWith("--trim-locales")));
  }
  if (r.exitCode !== 0) throw new Error(`bun build --compile failed:\n${r.stderr.toString()}${r.stdout.toString().slice(-4000)}`);
  if (distributed) closeRuntimeSwitches(out);
}
