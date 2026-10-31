// Local pre-flight for Apple notarization: checks a bundle against what the
// notary service rejects, so the first real submission doesn't bounce.
// (https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
import { $ } from "bun";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PreflightIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

async function isMachO(path: string): Promise<boolean> {
  const f = Bun.file(path);
  if (f.size < 4) return false;
  const magic = new Uint8Array(await f.slice(0, 4).arrayBuffer());
  const m = ((magic[0]! << 24) | (magic[1]! << 16) | (magic[2]! << 8) | magic[3]!) >>> 0;
  return [0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca].includes(m);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export async function notaryPreflight(app: string): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  const add = (level: PreflightIssue["level"], path: string, message: string) => issues.push({ level, path: path.replace(`${app}/`, ""), message });

  const binaries: string[] = [];
  for (const f of walk(app)) if (statSync(f).size > 0 && (await isMachO(f))) binaries.push(f);

  for (const bin of [...binaries, app]) {
    const info = await $`codesign -dvvv ${bin}`.nothrow().quiet();
    const text = info.stderr.toString();
    if (info.exitCode !== 0 || /not signed/.test(text)) {
      add("error", bin, "not code signed");
      continue;
    }
    if (!/flags=0x[0-9a-f]*\(.*runtime.*\)/.test(text) && !/flags=0x1[0-9a-f]{4}/.test(text)) add("error", bin, "hardened runtime not enabled (--options runtime)");
    if (!/Timestamp=/.test(text)) add("error", bin, "no secure timestamp (codesign --timestamp)");
    if (/Signature=adhoc/.test(text)) add("error", bin, "ad-hoc signature (needs a Developer ID Application certificate)");
    else if (!/Authority=Developer ID Application/.test(text)) add("error", bin, `not signed with a Developer ID Application certificate (${text.match(/Authority=([^\n]+)/)?.[1] ?? "?"})`);
    const ent = await $`codesign -d --entitlements - --xml ${bin}`.nothrow().quiet();
    if (/get-task-allow/.test(ent.stdout.toString())) add("error", bin, "com.apple.security.get-task-allow entitlement (debug builds are rejected)");
  }

  const verify = await $`codesign --verify --deep --strict ${app}`.nothrow().quiet();
  if (verify.exitCode !== 0) add("error", app, `codesign --verify --deep --strict: ${verify.stderr.toString().trim()}`);

  for (const bin of binaries) {
    const lc = (await $`otool -l ${bin}`.nothrow().quiet()).stdout.toString();
    const sdks = [...lc.matchAll(/sdk (\d+)\.(\d+)/g)].map((m) => Number(m[1]) + Number(m[2]) / 100);
    if (sdks.length && Math.min(...sdks) < 10.09) add("error", bin, "linked against an SDK older than macOS 10.9");
    if (!/LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX/.test(lc)) add("warning", bin, "no minimum OS load command");
  }
  return issues;
}

export function formatPreflight(issues: PreflightIssue[]): string {
  if (!issues.length) return "notary pre-flight: no issues";
  return issues.map((i) => `  ${i.level === "error" ? "✗" : "!"} ${i.path}: ${i.message}`).join("\n");
}
