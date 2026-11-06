// The handler of the `notes-asset` scheme, under test only (tests/windows-sessions.test.ts): real
// resources, a large one, a response a test holds up, and it tells the test when a request goes away.
import { onDesktopReady } from '@kitop/shell/server';

// A 1×1 PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const BIG = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const html = { 'content-type': 'text/html; charset=utf-8' };

if (Bun.env.KITOP_TEST && Bun.env.NOTES_PROTOCOL_CONTROL) {
	const control = Bun.env.NOTES_PROTOCOL_CONTROL;
	onDesktopReady(async () => {
		const { protocol } = await import('@kitop/shell/platform');
		protocol.handle('notes-asset', async (request) => {
			const url = new URL(request.url);
			request.signal.addEventListener('abort', () => void fetch(`${control}/aborted${url.pathname}`).catch(() => {}));
			switch (url.pathname) {
				case '/pixel.png': return new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
				case '/script.js': return new Response(`window.fromScheme = "ran";`, { headers: { 'content-type': 'text/javascript' } });
				case '/page.html': return new Response(`<!doctype html><title>scheme page</title><p id=p>from the scheme</p>`, { headers: html });
				case '/frame.html': return new Response(`<!doctype html><script>parent.postMessage("frame says hi", "*")</script>`, { headers: html });
				case '/big.bin': {
					const bytes = new Uint8Array(BIG);
					for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
					return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
				}
				case '/missing': return new Response('not here', { status: 404, headers: { 'content-type': 'text/plain', 'x-custom': 'yes' } });
				case '/empty': return new Response(null, { status: 204 });
				case '/echo': return new Response(`${request.method}:${await request.text()}`, { headers: { 'content-type': 'text/plain', 'x-got': request.headers.get('content-type') ?? '' } });
				case '/throws': throw new Error('handler broke');
				case '/stream.html': {
					let sent = false;
					return new Response(new ReadableStream({
						async pull(c) {
							if (!sent) {
								sent = true;
								c.enqueue(encoder.encode(`<!doctype html><title>stream</title><script>window.firstChunk = true</script><p id=first>one</p>`));
								return;
							}
							await fetch(`${control}/wait/stream`);
							c.enqueue(encoder.encode(`<p id=second>two</p>`));
							c.close();
						},
					}), { headers: html });
				}
				case '/endless':
					return new Response(new ReadableStream({
						async pull(c) {
							await Bun.sleep(20);
							c.enqueue(new Uint8Array(32768));
						},
					}), { headers: { 'content-type': 'application/octet-stream' } });
				case '/idle': {
					let sent = false;
					return new Response(new ReadableStream({
						async pull(c) {
							if (!sent) {
								sent = true;
								c.enqueue(new Uint8Array(1024));
								return;
							}
							await new Promise(() => {});
						},
					}), { headers: { 'content-type': 'application/octet-stream' } });
				}
				case '/hold': return new Promise<Response>(() => {});
				default: return new Response('nothing', { status: 404 });
			}
		});
	});
}
