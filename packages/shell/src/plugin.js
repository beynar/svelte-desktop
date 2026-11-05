// What `@kitop/shell/vite` loads. It's plain JavaScript that imports nothing of the shell until a
// desktop target asks for it, so a website's build also runs on Node, where the shell's TypeScript
// in node_modules wouldn't load.
//
//   desktop({ adapter: adapter() })   a website, and a desktop app with a target (kitop dev --mac)
//   desktop()                         a desktop app only
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeHostTypes } from "./host/types-file.js";

export function defineConfig(config) {
  return config;
}

/** The app's own SvelteKit: a linked shell can have another copy next to it. */
async function appKit(root) {
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules/@sveltejs/kit/package.json");
    if (existsSync(manifest)) {
      const entry = JSON.parse(readFileSync(manifest, "utf8")).exports["./vite"].import;
      return import(pathToFileURL(join(dirname(manifest), entry)).href);
    }
    if (dirname(dir) === dir) return import("@sveltejs/kit/vite");
  }
}

// The site's own `host`, ahead of SvelteKit's runtime on both sides.
function websiteHost() {
  const file = fileURLToPath(new URL("./host/website.js", import.meta.url));
  return {
    name: "kitop:website-host",
    config: () => ({ server: { fs: { allow: [dirname(file)] } } }),
    transform(code, id) {
      if (/@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/](client[\\/]client|server[\\/]index)\.js/.test(id)) return `import ${JSON.stringify(file)};\n${code}`;
    },
  };
}

export async function desktop(kitOptions = {}, options = {}) {
  if (kitOptions.adapter && !process.env.KITOP_TARGET) {
    const root = process.cwd();
    writeHostTypes(root);
    const { sveltekit } = await appKit(root);
    return [...(await sveltekit(kitOptions)), websiteHost()];
  }
  if (typeof Bun === "undefined") throw new Error("kitop runs on Bun: use `bunx --bun vite …`");
  return (await import("./vite.ts")).desktop(kitOptions, options);
}

export default desktop;
