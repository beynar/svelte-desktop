/**
 * Live QuickGUI window — main thread entry.
 * Owns AppKit via quickgui_run_host(); the app runs in a Bun worker.
 */
import { runHost } from '@quickgui/native/runtime';

await runHost(new URL('./qg-app.ts', import.meta.url).pathname);
