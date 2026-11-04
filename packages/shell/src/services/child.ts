import { channel, limits, type Packet } from './channel.ts';
import type { ServiceFunction, ServicePort } from './types.ts';

type Message = { kind: 'message'; data: unknown } | { kind: 'request'; id: number; data: unknown };
export function runService(service: ServiceFunction) {
  const controller = new AbortController();
  const listeners = new Set<(data: unknown) => void | Promise<void>>();
  let request: ((data: unknown) => unknown | Promise<unknown>) | undefined;
  let wire: ReturnType<typeof channel> | undefined;
  let cleanup: void | (() => void | Promise<void>);
  let started = false;
  let stopping = false;
  const fatal = (error: Error) => { if (!stopping) { console.error('[service]', error); process.exit(1); } };
  async function stop() {
    if (stopping) return;
    stopping = true;
    wire?.close(new Error('service stopping'));
    controller.abort();
    setTimeout(() => process.exit(0), 500);
    try { await cleanup?.(); } catch (error) { console.error('[service] cleanup', error); }
    process.exit(0);
  }
  // The same cleanup runs if the parent crashes or its dev server disappears.
  process.on('disconnect', () => { void stop(); });
  process.on('message', async (raw: unknown) => {
    const m = raw as { t: string; args?: unknown; capacity?: number; maxMessageBytes?: number };
    if (m?.t === 'stop') { await stop(); return; }
    if (m?.t !== 'start') { if (wire) void wire.receive(raw as Packet); return; }
    if (started) return;
    started = true;
    const bounds = limits(m);
    wire = channel((packet) => process.send!(packet), bounds.capacity, bounds.maxMessageBytes, async (value) => {
      const message = value as Message;
      if (message.kind === 'message') {
        for (const fn of listeners) await fn(message.data);
      } else if (message.kind === 'request') {
        let response: { kind: 'reply'; id: number; data?: unknown; error?: string };
        try {
          if (!request) throw new Error('service has no request handler');
          response = { kind: 'reply', id: message.id, data: await request(message.data) ?? null };
        } catch (error) { response = { kind: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) }; }
        try { await wire!.send(response); }
        catch (error) { fatal(error instanceof Error ? error : new Error(String(error))); }
      }
    }, fatal);
    const port: ServicePort = {
      signal: controller.signal,
      postMessage: (data) => wire!.send({ kind: 'message', data }),
      on(_event, fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
      onRequest(fn) { request = fn; },
    };
    try {
      cleanup = await service(m.args, port);
      process.send!({ t: 'ready' });
    } catch (error) { fatal(error instanceof Error ? error : new Error(String(error))); }
  });
  process.send?.({ t: 'boot' });
}
