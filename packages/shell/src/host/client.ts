// Installed in the page by the Vite plugin (injected before the SvelteKit client starts).
import { buildHost } from "./build.ts";

(globalThis as any).host ??= buildHost();
