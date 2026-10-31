// Deprecated: `bunx --bun vite build` now produces the .app, zip, DMG and release
// artifacts (the desktop Vite plugin runs the packager). Kept as a forwarder.
import { $ } from "bun";
console.warn("scripts/build.ts is deprecated — use `bunx --bun vite build` (configure desktop.config.ts)");
await $`bunx --bun vite build`.cwd(process.cwd());
