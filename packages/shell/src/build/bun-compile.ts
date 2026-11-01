// Flags for `bun build --compile` shared by the packagers. `--trim` drops the Bun APIs the app
// never calls — the Bun command line alone is ~45 MB (notes: 86 → 51 MB with --aot) — and is on
// by default when the Bun compiling has it (experimental: canary today); `build.trim: false`
// turns it off. `--aot` (machine code at build time, ~8 MB more off) stays opt-in.
import { $ } from "bun";
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
    else opts.warn("build.trim: this Bun has no --trim (canary today: build.bun or $SVELTE_DESKTOP_BUN) — skipped");
  }
  if (c.build?.aot && opts.aot) {
    if (has.aot) flags.push("--aot");
    else opts.warn("build.aot: this Bun has no --aot (canary today: build.bun or $SVELTE_DESKTOP_BUN) — skipped");
  }
  return flags;
}

/** `bun build --compile` of the staged entries. A target runtime that can't be trimmed (a cross
 *  build: Bun downloads that target's runtime, without the trim table) is built again without. */
export async function compileStaged(bun: string, stage: string, out: string, flags: string[], warn: (m: string) => void): Promise<void> {
  const run = (f: string[]) => $`${bun} build --compile ${f} ${join(stage, "desktop-main.js")} ${join(stage, "desktop-worker.js")} --outfile ${out}`.cwd(stage).nothrow().quiet();
  let r = await run(flags);
  if (r.exitCode !== 0 && flags.includes("--trim") && /doesn't support --trim/.test(r.stderr.toString())) {
    warn("--trim: this target's Bun runtime can't be trimmed (cross build) — built without");
    r = await run(flags.filter((f) => f !== "--trim" && !f.startsWith("--trim-locales")));
  }
  if (r.exitCode !== 0) throw new Error(`bun build --compile failed:\n${r.stderr.toString()}${r.stdout.toString().slice(-4000)}`);
}
