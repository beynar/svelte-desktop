// What `@kitop/shell/vite` loads, next to SvelteKit's own plugin. It's plain JavaScript that imports
// nothing of the shell until a desktop target asks for it, so a website's build also runs on Node,
// where the shell's TypeScript in node_modules wouldn't load.
//
//   plugins: [sveltekit({ adapter: adapter() }), desktop()]    a website, and with a target a desktop app
//   plugins: [sveltekit(), desktop({ website: false })]        a desktop app only
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeHostTypes } from "./host/types-file.js";
import { routesOverlay } from "./routes-overlay.js";

export function defineConfig(config) {
  return config;
}

// The site's own `host`, ahead of SvelteKit's runtime on both sides.
function websiteHost() {
  const file = fileURLToPath(new URL("./host/website.js", import.meta.url));
  const shellRoot = fileURLToPath(new URL("..", import.meta.url));
  return {
    name: "kitop:website-host",
    config: () => ({
      server: { fs: { allow: [shellRoot] } },
      // Installed, the package is TypeScript and runes sources the dep optimizer can't read, should a page import it.
      ...(/[\\/]node_modules[\\/]/.test(shellRoot) ? { optimizeDeps: { exclude: ["@kitop/shell"] } } : {}),
    }),
    transform(code, id) {
      if (/@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/](client[\\/]client|server[\\/]index)\.js/.test(id)) return { code: `import ${JSON.stringify(file)};\n${code}`, map: null };
    },
  };
}

export async function desktop(options = {}) {
  if (!process.env.KITOP_TARGET && options.website !== false) {
    writeHostTypes(process.cwd());
    return [routesOverlay("web", options.routes), websiteHost()];
  }
  if (typeof Bun === "undefined") throw new Error("kitop runs on Bun: use `bunx --bun vite …`");
  return (await import("./vite.ts")).desktop(options);
}

export default desktop;
