// Routes for one side only: `+page.desktop.svelte` takes the place of `+page.svelte` in the desktop
// app, the website ignores it, and `desktop({ routes: { exclude } })` keeps routes out of the app.
// SvelteKit refuses such a file in its routes folder and can't filter routes. It does follow links,
// so it gets a folder of them instead, `.desktop/routes`, through the options it shows its neighbors
// (`api.options` on its setup plugin). Modules keep their real paths, so relative imports and hot
// reload don't notice. A project using none of this keeps its own folder, untouched.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

const VARIANT = /^(\+.+)\.desktop(\.[^.]+)$/;
const IGNORED_BY_KIT = /\.(test|spec|stories)\./;

/** What a route file is, whatever its layout reset or extension: one of each per folder. */
const role = (name) => `${name.replace(/\.[^.]+$/, "").replace(/@[^.]*/, "")}:${/\.[jt]s$/.test(name) ? "module" : "component"}`;

/** `/admin` is that route, `/admin/**` that route and everything under it. Ids keep their (groups). */
function matcher(patterns) {
  const regexes = patterns.map((pattern) => {
    const subtree = pattern.endsWith("/**");
    const source = (subtree ? pattern.slice(0, -3) : pattern)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, "(?:.*/)?");
    return { subtree, regex: new RegExp(`^${source || "/"}${subtree ? "(?:/.*)?" : ""}$`) };
  });
  return {
    /** The folder and everything under it goes. */
    subtree: (id) => regexes.some((r) => r.subtree && r.regex.test(id)),
    /** The folder's own page and endpoint go, its layouts stay for what's under it. */
    leaf: (id) => regexes.some((r) => !r.subtree && r.regex.test(id)),
  };
}

/**
 * The route files one side sees: where they appear under the routes folder, and the real file.
 * Null when that's what the folder has already, which leaves SvelteKit on the real one.
 */
export function planRoutes(routes, side, exclude = []) {
  const excluded = matcher(side === "desktop" ? exclude : []);
  const files = new Map();
  let differs = false;
  const walk = (dir, id) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const isDir = (e) => (e.isSymbolicLink() ? statSync(join(dir, e.name)).isDirectory() : e.isDirectory());
    const names = entries.filter((e) => !isDir(e) && e.name.startsWith("+") && !IGNORED_BY_KIT.test(e.name)).map((e) => e.name);
    const variants = names.filter((n) => VARIANT.test(n)).map((n) => n.replace(VARIANT, "$1$2"));
    if (variants.length) differs = true;
    const taken = new Set(variants.map(role));
    const place = (name, as) => files.set(join(relative(routes, dir), as), join(dir, name));
    for (const name of names) {
      const variant = name.match(VARIANT);
      if (variant ? side !== "desktop" : side === "desktop" && taken.has(role(name))) continue;
      const as = variant ? variant[1] + variant[2] : name;
      if (excluded.leaf(id || "/") && /^\+(page|server)\b/.test(as)) {
        differs = true;
        continue;
      }
      place(name, as);
    }
    for (const entry of entries) {
      if (!isDir(entry)) continue;
      const child = `${id}/${entry.name}`;
      if (excluded.subtree(child)) differs = true;
      else walk(join(dir, entry.name), child);
    }
  };
  if (excluded.subtree("/")) throw new Error("kitop: routes.exclude leaves the app without routes");
  walk(routes, "");
  return differs ? files : null;
}

/** Makes `out` hold exactly these links, touching only what changed: SvelteKit is watching. */
export function writeRoutes(out, files) {
  const present = [];
  const walk = (dir) => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else present.push(path);
    }
  };
  walk(out);
  for (const path of present) {
    const wanted = files.get(relative(out, path));
    if (!wanted || !lstatSync(path).isSymbolicLink() || readlinkSync(path) !== wanted) rmSync(path, { force: true });
  }
  for (const [as, file] of files) {
    const at = join(out, as);
    if (existsSync(at)) continue;
    mkdirSync(dirname(at), { recursive: true });
    try {
      symlinkSync(file, at);
    } catch (error) {
      if (error?.code === "EPERM") throw new Error("kitop: .desktop routes and routes.exclude need symbolic links, which Windows only allows with Developer Mode on (Settings > For developers)");
      throw error;
    }
  }
  const prune = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) prune(join(dir, entry.name));
    if (dir !== out && !readdirSync(dir).length) rmSync(dir, { recursive: true });
  };
  if (existsSync(out)) prune(out);
}

export async function flatPlugins(list) {
  const value = await list;
  return Array.isArray(value) ? (await Promise.all(value.map(flatPlugins))).flat() : value ? [value] : [];
}

const SETUP = "vite-plugin-sveltekit-setup";
const KIT_RANGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).peerDependencies["@sveltejs/kit"];

/** The SvelteKit installed for `root`, wherever node_modules is above it. */
export function kitVersion(root) {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", "@sveltejs", "kit", "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version;
    if (dir === dirname(dir)) return undefined;
  }
}

/**
 * What's wrong with what kitop reads of SvelteKit's options, null when nothing. SvelteKit shows them to
 * the plugins next to it on its setup plugin (`api.options`), and builds from that same object after
 * the config hooks, so kitop changes routes, hooks and the adapter there. It isn't a public API.
 */
export function kitOptionsProblem(plugins) {
  const setup = plugins.find((p) => p?.name === SETUP);
  if (!setup) return `no ${SETUP} plugin`;
  const kit = setup.api?.options;
  if (!kit || typeof kit !== "object") return `${SETUP} has no api.options`;
  if (typeof kit.files?.routes !== "string") return "api.options.files.routes isn't a path";
  if (!["client", "server", "universal"].every((kind) => typeof kit.files.hooks?.[kind] === "string")) return "api.options.files.hooks isn't { client, server, universal }";
  if (!Array.isArray(kit.moduleExtensions)) return "api.options.moduleExtensions isn't a list";
  if (!kit.typescript || typeof kit.typescript !== "object") return "api.options.typescript isn't an object";
  return null;
}

/** SvelteKit's options, from the plugins of the Vite config. Throws, naming the SvelteKit, when they aren't there. */
export async function kitOptions(plugins, root) {
  const all = await flatPlugins(plugins);
  const problem = kitOptionsProblem(all);
  if (!problem) return all.find((p) => p.name === SETUP).api.options;
  const kit = `SvelteKit ${kitVersion(root) ?? "(not installed)"}`;
  if (!all.some((p) => p?.name?.startsWith("vite-plugin-sveltekit"))) throw new Error(`kitop: desktop() goes next to SvelteKit's plugin, plugins: [sveltekit(), desktop()], and there's none here (${kit})`);
  throw new Error(`kitop: ${kit} doesn't show its options the way kitop reads them: ${problem}. kitop supports @sveltejs/kit ${KIT_RANGE}`);
}

/** `hooks.server.desktop.ts` in the place of `hooks.server.ts`. The website never looks at it. */
function desktopHooks(kit, root) {
  for (const kind of ["client", "server", "universal"]) {
    const base = resolve(root, kit.files.hooks[kind]);
    if (kit.moduleExtensions.some((ext) => existsSync(`${base}.desktop${ext}`))) kit.files.hooks[kind] = `${base}.desktop`;
  }
}

/** Also what tells code which side it's built for, so that a side's imports can leave the other's bundle. */
export function routesOverlay(side, options = {}) {
  let routes;
  let out;
  let active = false;
  return {
    name: "kitop:routes",
    enforce: "pre",
    config: {
      order: "pre",
      async handler(user) {
        const define = { "import.meta.env.KITOP_DESKTOP": JSON.stringify(side === "desktop") };
        const root = resolve(user.root ?? process.cwd());
        const kit = await kitOptions(user.plugins, root);
        // Relative still: SvelteKit makes these absolute later on.
        out = join(root, ".desktop", "routes");
        const given = resolve(root, kit.files.routes);
        // Its nested builds come through here again, with what was set the first time.
        if (given !== out) routes = given;
        if (side === "desktop") desktopHooks(kit, root);
        const files = existsSync(routes) ? planRoutes(routes, side, options.exclude) : null;
        active = !!files;
        if (!files || given === out) return { define };
        writeRoutes(out, files);
        kit.files.routes = out;
        // So that `./$types` next to the real files finds what SvelteKit generates for the links.
        const own = kit.typescript?.config;
        kit.typescript = {
          ...kit.typescript,
          config(config) {
            const result = own?.(config) ?? config;
            // SvelteKit's two: the project, and its generated types, relative to wherever this tsconfig is.
            const [project, types] = result.compilerOptions.rootDirs;
            result.compilerOptions.rootDirs.push(posix.join(project, relative(root, routes).replaceAll("\\", "/")), posix.join(types, relative(root, out).replaceAll("\\", "/")));
            return result;
          },
        };
        return { define };
      },
    },
    configureServer(server) {
      if (!routes) return;
      server.watcher.add(routes);
      const changed = (file) => {
        if (!file.startsWith(routes) || !/[\\/]\+[^\\/]*$/.test(file)) return;
        const files = planRoutes(routes, side, options.exclude);
        // Starting or ending with variants moves SvelteKit from one folder to the other.
        if (!!files !== active) return void server.restart();
        if (files) writeRoutes(out, files);
      };
      server.watcher.on("add", changed);
      server.watcher.on("unlink", changed);
    },
  };
}
