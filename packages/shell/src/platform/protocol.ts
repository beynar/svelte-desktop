import { callPlatform, onPlatform, onPlatformReady, NativeApiError } from './bus';
import { isCustomProtocolScheme } from '../protocol-schemes';

export type ProtocolHandler = (request: Request) => Response | Promise<Response>;
type ProtocolRequest = { requestId: string; url: string; method: string; headers: Record<string, string>; body?: string };
type Active = { controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array> };
interface ProtocolState {
	handlers: Map<string, ProtocolHandler>;
	active: Map<string, Active>;
	listening: boolean;
}
const key = Symbol.for('kitop.protocol');
const state = ((globalThis as Record<symbol, ProtocolState | undefined>)[key] ??= {
	handlers: new Map(), active: new Map(), listening: false,
});

export function validateProtocolScheme(scheme: string): string {
	if (!isCustomProtocolScheme(scheme))
		throw new NativeApiError('invalid_args', 'protocol scheme must be lowercase and not reserved by WebKit');
	return scheme;
}
function serverOnly() {
	if (typeof window !== 'undefined') throw new NativeApiError('denied', 'protocol handlers belong to server code');
}

/** Custom resource schemes declared in desktop.config.protocols (macOS and Linux). */
export const protocol = {
	handle(scheme: string, handler: ProtocolHandler): void {
		serverOnly();
		validateProtocolScheme(scheme);
		if (typeof handler !== 'function') throw new TypeError('protocol handler must be a function');
		if (state.handlers.has(scheme)) throw new NativeApiError('invalid_args', `protocol ${scheme} already has a handler; unhandle it first`);
		state.handlers.set(scheme, handler);
	},
	unhandle(scheme: string): void { serverOnly(); state.handlers.delete(validateProtocolScheme(scheme)); },
	isProtocolHandled(scheme: string): boolean { serverOnly(); return state.handlers.has(scheme); },
};

async function serve(event: ProtocolRequest): Promise<void> {
	const active: Active = { controller: new AbortController() };
	state.active.set(event.requestId, active);
	const send = (op: string, args: Record<string, unknown> = {}) => callPlatform<null>('protocol', op, { requestId: event.requestId, ...args });
	try {
		const handler = state.handlers.get(new URL(event.url).protocol.slice(0, -1));
		const request = new Request(event.url, {
			method: event.method, headers: event.headers, signal: active.controller.signal,
			...(event.body && !['GET', 'HEAD'].includes(event.method) ? { body: Buffer.from(event.body, 'base64') } : {}),
		});
		const response = handler ? await handler(request) : new Response('No protocol handler registered', { status: 404 });
		if (!(response instanceof Response)) throw new TypeError('protocol handler must return a Response');
		if (active.controller.signal.aborted) { await response.body?.cancel(); return; }
		active.reader = response.body?.getReader();
		await send('response', { status: response.status, headers: Object.fromEntries(response.headers) });
		if (active.reader && event.method !== 'HEAD') {
			while (!active.controller.signal.aborted) {
				const { value, done } = await active.reader.read();
				if (done) break;
				// One acknowledged 64 KiB chunk at a time bounds the native queue.
				for (let offset = 0; offset < value.length && !active.controller.signal.aborted; offset += 65536)
					await send('data', { data: Buffer.from(value.subarray(offset, offset + 65536)).toString('base64') });
			}
		} else await active.reader?.cancel();
		if (!active.controller.signal.aborted) await send('finish');
	} catch (error) {
		if (!active.controller.signal.aborted) await send('fail', { message: String(error instanceof Error ? error.message : error) }).catch(() => {});
	} finally {
		await active.reader?.cancel().catch(() => {});
		state.active.delete(event.requestId);
	}
}

onPlatformReady(() => {
	if (typeof window !== 'undefined' || state.listening) return;
	state.listening = true;
	onPlatform<ProtocolRequest>('protocolRequest', (event) => { void serve(event); });
	onPlatform<{ requestId: string }>('protocolCancel', ({ requestId }) => {
		const active = state.active.get(requestId);
		state.active.delete(requestId);
		active?.controller.abort();
		void active?.reader?.cancel().catch(() => {});
	});
});
