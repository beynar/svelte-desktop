// Fails if the package isn't complete: what `bun pm pack` really produces, as a consumer would
// get it, not what the repo happens to hold. `bun scripts/check-package.ts [dir]`, and before
// `bun publish` (prepublishOnly). It doesn't care about `private`: that one is the owner's call.
import { $ } from "bun";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve } from "node:path";

// What the code starts or reads by path, not by import, so the import walk below can't see it.
const NEEDED_BY_PATH = [
  "native/build-macos.sh",
  "native/build-linux.sh",
  "native/build-windows.sh",
  "native/docker/Dockerfile",
  "native/docker/build-lib.sh",
  "native/docker/windows/Dockerfile",
  "native/docker/windows/build.sh",
  "native/include",
  "native/linux",
  "native/portable",
  "native/windows",
  "native/vendor/webview",
  "native/vendor/node-api/include",
  "native/sdk/rust",
  "native/sdk/go",
  "native/sdk/python",
  "native/sdk/ai",
  "src/dev/main.ts",
  "src/jobs/dev-runner.ts",
  "src/services/dev-runner.ts",
  "src/host/client.ts",
  "src/host/server.ts",
  "src/push/service-worker.js",
  "scripts/updater-cli.ts",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
];
// A consumer gets none of this: tests and what a build leaves behind.
const NEVER_SHIPPED = [/\.test\.ts$/, /^native\/build\//, /^test\//, /^bench\//, /(^|\/)node_modules\//, /(^|\/)\.DS_Store$/, /(^|\/)__pycache__\//, /^native\/sdk\/rust\/target\//];
const REQUIRED_FIELDS = ["name", "version", "description", "license", "homepage", "repository", "engines", "files", "exports", "bin", "peerDependencies", "publishConfig"];
const SOURCE = /\.(ts|js|svelte)$/;

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [relative(base, p).replaceAll("\\", "/")];
  });
}

const packageName = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

/** The imports of a source file. Type-only ones are erased: `tsc` in test/docker/pack.sh has those. */
function importsOf(file: string): string[] {
  let code = readFileSync(file, "utf8").replace(/^#!.*/, "");
  if (file.endsWith(".d.ts")) return [];
  if (file.endsWith(".svelte")) code = [...code.matchAll(/<script(?:\s+[\w:-]+(?:=(?:"[^"]*"|'[^']*'))?)*\s*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  const loader = file.endsWith(".js") ? "js" : "ts";
  return new Bun.Transpiler({ loader }).scanImports(code).map((i) => i.path);
}

/** A relative import's file: TypeScript sources may be imported as `.js`. */
function resolveRelative(from: string, spec: string, shipped: Set<string>): string | undefined {
  const file = posix.join(posix.dirname(from), spec);
  return [file, `${file}.ts`, `${file}.js`, file.replace(/\.js$/, ".ts"), `${file}/index.ts`, `${file}/index.js`].find((c) => shipped.has(c));
}

/** Everything wrong with the package in `dir`, empty when it can be published. */
export async function checkPackage(dir: string): Promise<string[]> {
  const problems: string[] = [];
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

  for (const field of REQUIRED_FIELDS) if (pkg[field] === undefined) problems.push(`package.json: no "${field}"`);
  if (pkg.version && !(Bun.semver.satisfies(pkg.version, pkg.version) && Bun.semver.order(pkg.version, "0.1.0") >= 0)) problems.push(`package.json: "${pkg.version}" is not a release version`);
  if (pkg.engines && !pkg.engines.bun) problems.push(`package.json: no "engines.bun", and the package only runs on Bun`);
  if (pkg.repository && !(pkg.repository.url && pkg.repository.directory)) problems.push(`package.json: "repository" needs "url" and "directory"`);
  if (pkg.publishConfig && pkg.publishConfig.access !== "public") problems.push(`package.json: a scoped package needs publishConfig.access "public"`);

  const tmp = mkdtempSync(join(tmpdir(), "kitop-check-"));
  try {
    const packed = await $`bun pm pack --ignore-scripts --quiet --destination ${tmp}`.cwd(dir).nothrow().quiet();
    if (packed.exitCode !== 0) return [...problems, `bun pm pack failed: ${packed.stderr.toString().trim()}`];
    const tarball = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tarball) return [...problems, "bun pm pack wrote no tarball"];
    await $`tar -xzf ${tarball}`.cwd(tmp).quiet();
    const root = join(tmp, "package");
    const shipped = new Set(walk(root));
    const has = (rel: string) => shipped.has(rel) || [...shipped].some((f) => f.startsWith(`${rel}/`));

    for (const rel of NEEDED_BY_PATH) if (!has(rel)) problems.push(`tarball: no ${rel}`);
    for (const rel of shipped) if (NEVER_SHIPPED.some((re) => re.test(rel))) problems.push(`tarball: ships ${rel}`);

    if (pkg.version && !new RegExp(`^## ${pkg.version.replaceAll(".", "\\.")}\\b`, "m").test(has("CHANGELOG.md") ? readFileSync(join(root, "CHANGELOG.md"), "utf8") : "")) problems.push(`CHANGELOG.md: no "## ${pkg.version}" section`);

    // The CLI, and the scripts the build starts directly.
    for (const [name, target] of Object.entries((pkg.bin ?? {}) as Record<string, string>)) {
      const rel = target.replace(/^\.\//, "");
      if (!shipped.has(rel)) problems.push(`bin ${name}: ${target} isn't in the tarball`);
      else if (!readFileSync(join(root, rel), "utf8").startsWith("#!/usr/bin/env bun")) problems.push(`bin ${name}: ${target} has no bun shebang`);
    }
    if (process.platform !== "win32") for (const rel of shipped) if (rel.endsWith(".sh") && !(statSync(join(root, rel)).mode & 0o100)) problems.push(`tarball: ${rel} isn't executable, and the build runs it directly`);

    // Every import in a shipped source goes somewhere a consumer has.
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
    const builtin = new Set(builtinModules);
    const edges = new Map<string, string[]>();
    for (const rel of shipped) {
      if (!SOURCE.test(rel)) continue;
      const local: string[] = [];
      for (const spec of importsOf(join(root, rel))) {
        if (spec.startsWith(".")) {
          const found = resolveRelative(rel, spec, shipped);
          if (found) local.push(found);
          else problems.push(`${rel}: imports ${spec}, which isn't in the tarball`);
        } else if (spec.startsWith("@kitop/shell")) {
          const sub = `.${spec.slice("@kitop/shell".length)}`;
          if (!pkg.exports?.[sub]) problems.push(`${rel}: imports ${spec}, which isn't exported`);
        } else if (!/^(node:|bun:|bun$|\$|#)/.test(spec) && !builtin.has(spec) && !declared.has(packageName(spec))) {
          problems.push(`${rel}: imports ${spec}, which isn't a dependency or a peer dependency`);
        }
      }
      edges.set(rel, local);
    }
    const reachesSvelte = (start: string) => {
      const seen = new Set<string>();
      const todo = [start];
      while (todo.length) {
        const f = todo.pop()!;
        if (seen.has(f)) continue;
        seen.add(f);
        if (/\.svelte(\.(ts|js))?$/.test(f)) return true;
        todo.push(...(edges.get(f) ?? []));
      }
      return false;
    };

    // Each entry point exists, and says what TypeScript and Svelte's tools look for. `svelte` is the
    // convention that marks Svelte sources; the peer dependency on svelte is what has them compiled.
    for (const [sub, value] of Object.entries((pkg.exports ?? {}) as Record<string, unknown>)) {
      if (sub === "./package.json") continue;
      const conditions = (typeof value === "string" ? { default: value } : value) as Record<string, string>;
      for (const [condition, target] of Object.entries(conditions)) if (!shipped.has(target.replace(/^\.\//, ""))) problems.push(`exports["${sub}"].${condition}: ${target} isn't in the tarball`);
      const keys = Object.keys(conditions);
      const main = (conditions.default ?? conditions.types ?? "").replace(/^\.\//, "");
      if (keys.includes("types") && keys[0] !== "types") problems.push(`exports["${sub}"]: "types" must come first`);
      if (keys.includes("default") && keys.at(-1) !== "default") problems.push(`exports["${sub}"]: "default" must come last`);
      if (/\.ts$/.test(main) && !conditions.types) problems.push(`exports["${sub}"]: no "types"`);
      if (main.endsWith(".js") && shipped.has(main.replace(/\.js$/, ".d.ts")) && !conditions.types) problems.push(`exports["${sub}"]: no "types", and ${main.replace(/\.js$/, ".d.ts")} exists`);
      if (reachesSvelte(main) && !conditions.svelte) problems.push(`exports["${sub}"]: no "svelte", and ${main} leads to Svelte sources`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
  if (!existsSync(join(dir, "package.json"))) throw new Error(`no package.json in ${dir}`);
  const problems = await checkPackage(dir);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (problems.length) {
    console.error(`${pkg.name}@${pkg.version} is incomplete:`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(`${pkg.name}@${pkg.version} is complete.${pkg.private ? ` It stays unpublished while "private" is true.` : ""}`);
}
