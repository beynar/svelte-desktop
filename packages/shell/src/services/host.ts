import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { channel, jsonValue, limits, type Packet } from './channel.ts';
import type { ServiceExit, ServiceHandle, ServiceOptions } from './types.ts';
export type * from './types.ts';

const KEY = Symbol.for('svelte-desktop.services');
const globalState = globalThis as typeof globalThis & { [KEY]?: Set<ServiceHandle> };
const running = globalState[KEY] ??= new Set<ServiceHandle>();

function command(name: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid service name "${name}"`);
  const dir = process.env.SVELTE_DESKTOP_SERVICES_DIR;
  if (dir) {
    const file = ['ts', 'js'].map((ext) => join(dir, `${name}.${ext}`)).find(existsSync);
    if (!file) throw new Error(`no service "${name}" (expected src/services/${name}.ts)`);
    return { argv: [process.execPath, process.env.SVELTE_DESKTOP_SERVICES_RUNNER ?? join(import.meta.dir, 'dev-runner.ts'), file], env: {} };
  }
  const names = (globalThis as typeof globalThis & { [key: symbol]: string[] })[Symbol.for('svelte-desktop.services.names')] ?? [];
  if (!names.includes(name)) throw new Error(`no bundled service "${name}"`);
  return { argv: [process.execPath], env: { SVELTE_DESKTOP_SERVICE: name } };
}
function positive(n: number) { if (!Number.isFinite(n) || n <= 0) throw new Error('service timeout must be positive'); return n; }

export const services = {
  /** Start a persistent src/services/<name>.ts child; resolves after initialization. */
  async start(name: string, args: unknown = null, options: ServiceOptions = {}): Promise<ServiceHandle> {
    const cmd = command(name), bounds = limits(options);
    const startupTimeout = positive(options.startupTimeoutMs ?? 10_000);
    const maxRestarts = options.restart?.maxRestarts ?? 0, delay = options.restart?.delayMs ?? 100;
    if (!Number.isSafeInteger(maxRestarts) || maxRestarts < 0 || !Number.isFinite(delay) || delay < 0) throw new Error('invalid service restart policy');
    args = jsonValue(args, bounds.maxMessageBytes);
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let wire: ReturnType<typeof channel> | undefined;
    let state: ServiceHandle['state'] = 'restarting', stopping = false, restarts = 0, seq = 0;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let stopPromise: Promise<void> | undefined;
    const messages = new Set<(data: unknown) => void>(), exits = new Set<(exit: ServiceExit) => void>();
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    function rejectPending(error: Error) {
      wire?.close(error);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
      pending.clear();
    }
    function notify<T>(listeners: Set<(value: T) => void>, value: T) {
      for (const fn of listeners) { try { fn(value); } catch (error) { console.error('[service] listener', error); } }
    }
    function launch(): Promise<void> {
      return new Promise((resolve, reject) => {
        let ready = false;
        const timer = setTimeout(() => { reject(new Error(`service ${name} startup timed out`)); child.kill(); }, startupTimeout);
        let child: ReturnType<typeof Bun.spawn>;
        try { child = Bun.spawn(cmd.argv, {
          env: { ...process.env, ...cmd.env },
          // Inherit the app's output instead of buffering unread pipes.
          stdout: 'inherit', stderr: 'inherit',
          ipc(raw: unknown) {
            if (proc !== child) return;
            const m = raw as { t: string };
            if (m?.t === 'boot' && !stopping) child.send({ t: 'start', args, ...bounds });
            else if (m?.t === 'ready' && !stopping) { ready = true; clearTimeout(timer); state = 'running'; resolve(); }
            else void wire?.receive(raw as Packet);
          },
        }); } catch (error) { clearTimeout(timer); reject(error); return; }
        proc = child;
        wire = channel((packet) => child.send(packet), bounds.capacity, bounds.maxMessageBytes, (raw) => {
          const m = raw as { kind: string; id: number; data?: unknown; error?: string };
          if (m.kind === 'message') notify(messages, m.data);
          else if (m.kind === 'reply') {
            const p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id); clearTimeout(p.timer);
            if (m.error !== undefined) p.reject(new Error(m.error)); else p.resolve(m.data);
          }
        }, (error) => { rejectPending(error); child.kill(); });
        void child.exited.then((code) => {
          clearTimeout(timer);
          const error = new Error(`service ${name} exited with code ${code}`);
          if (!ready) reject(error);
          rejectPending(error);
          proc = undefined;
          const restarting = ready && !stopping && restarts < maxRestarts;
          state = restarting ? 'restarting' : 'stopped';
          notify(exits, { code, signal: child.signalCode ?? null, restarting });
          if (restarting && !stopping) {
            restarts++;
            restartTimer = setTimeout(() => { restartTimer = undefined; void launch().catch((e) => { console.error('[service] restart failed', e); void handle.stop(); }); }, delay);
          } else running.delete(handle);
        });
      });
    }
    const handle: ServiceHandle = {
      name,
      get pid() { return proc?.pid; },
      get state() { return state; },
      send(data) {
        if (state !== 'running') return Promise.reject(new Error(`service ${name} is ${state}`));
        return wire!.send({ kind: 'message', data });
      },
      request<T>(data: unknown, requestOptions: { timeoutMs?: number } = {}): Promise<T> {
        if (state !== 'running') return Promise.reject(new Error(`service ${name} is ${state}`));
        if (pending.size >= bounds.capacity) return Promise.reject(new Error('service requests full'));
        const timeout = positive(requestOptions.timeoutMs ?? 30_000), id = ++seq;
        return new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`service request timed out after ${timeout} ms`)); }, timeout);
          pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
          void wire!.send({ kind: 'request', id, data }).catch((error) => {
            clearTimeout(timer); pending.delete(id); reject(error);
          });
        });
      },
      on(event: 'message' | 'exit', fn: ((data: unknown) => void) | ((exit: ServiceExit) => void)) {
        // The overloads ensure each event carries its own payload.
        if (event === 'message') { const cb = fn as (data: unknown) => void; messages.add(cb); return () => { messages.delete(cb); }; }
        const cb = fn as (exit: ServiceExit) => void; exits.add(cb); return () => { exits.delete(cb); };
      },
      stop() {
        return stopPromise ??= (async () => {
          stopping = true; state = 'stopped'; clearTimeout(restartTimer);
          rejectPending(new Error(`service ${name} stopped`));
          const child = proc;
          if (child) {
            const kill = setTimeout(() => child.kill('SIGKILL'), 500);
            try { child.send({ t: 'stop' }); } catch { child.kill(); }
            try { await child.exited; } finally { clearTimeout(kill); }
          }
          running.delete(handle);
        })();
      },
    };
    running.add(handle);
    try { await launch(); return handle; }
    catch (error) { await handle.stop(); throw error; }
  },
};

/** @internal App quit: disable supervision first and reap every child. */
export async function stopAllServices() { await Promise.all([...running].map((handle) => handle.stop())); }
