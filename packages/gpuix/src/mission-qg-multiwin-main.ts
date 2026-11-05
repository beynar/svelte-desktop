import { runHost } from '@quickgui/native/runtime';
await runHost(new URL('./mission-qg-multiwin-worker.ts', import.meta.url).pathname);
