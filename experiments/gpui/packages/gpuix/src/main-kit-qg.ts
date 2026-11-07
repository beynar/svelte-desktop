/**
 * Live QuickGUI window running the kit app — main thread entry.
 */
import { runHost } from '@quickgui/native/runtime';

await runHost(new URL('./qg-app-kit.ts', import.meta.url).pathname);
