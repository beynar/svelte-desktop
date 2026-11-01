// dist/ → Cloudflare's Build Output (.cloudflare/output/v0): an assets-only Worker that
// `cf deploy --prebuilt` uploads. Blume builds the site; cf has no Blume builder.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, ".cloudflare", "output", "v0");
const worker = join(out, "workers", "default");

rmSync(join(root, ".cloudflare"), { recursive: true, force: true });
mkdirSync(worker, { recursive: true });
writeFileSync(join(out, "config.json"), JSON.stringify({ accountId: "6886250e2aff0047919a1ed731a55c64", buildContext: { isPreview: false, mode: "production" } }));
writeFileSync(
  join(worker, "worker.config.json"),
  JSON.stringify({
    name: "svelte-desktop-docs",
    compatibilityDate: "2026-11-01",
    // Blume writes <route>/index.html and links without a trailing slash.
    assets: { htmlHandling: "drop-trailing-slash", notFoundHandling: "404-page" },
  }),
);
cpSync(join(root, "dist"), join(worker, "assets"), { recursive: true });
