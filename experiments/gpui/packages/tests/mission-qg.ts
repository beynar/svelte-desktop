/** Mission probe — QuickGUI host entry (main thread owns AppKit). */
import { runHost } from '@quickgui/native/runtime';

await runHost(new URL('./mission-qg-app.ts', import.meta.url).pathname);
