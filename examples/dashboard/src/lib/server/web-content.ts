// Worker-side custom resources. The page only gets URLs and probe statistics.
import { protocol } from '@svelte-desktop/shell/platform';
export const assetStats = { bytes: 0, completed: 0, cancelled: 0, requests: 0 };
if (protocol.isProtocolHandled('asset')) protocol.unhandle('asset');
protocol.handle('asset', (request) => {
	const url = new URL(request.url);
	assetStats.requests++;
	if (url.pathname === '/image.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64"><rect width="160" height="64" rx="12" fill="#397969"/><text x="80" y="39" text-anchor="middle" fill="white" font-family="system-ui" font-size="18">asset:// ✓</text></svg>', { headers: { 'content-type': 'image/svg+xml' } });
	if (url.pathname === '/data.json') return Response.json({ source: 'Bun Worker', streamed: true });
	if (url.pathname === '/stream') {
		let count = 0, ended = false;
		return new Response(new ReadableStream<Uint8Array>({
			async pull(controller) {
				await Bun.sleep(20);
				if (ended) return;
				const chunk = new TextEncoder().encode(count++ === 0 ? '<!doctype html><body><h1>Streaming from the Bun Worker</h1>' : `<!--${'x'.repeat(32750)}-->\n`);
				assetStats.bytes += chunk.length;
				controller.enqueue(chunk);
				if (count >= 256) { ended = true; assetStats.completed++; controller.close(); }
			},
			cancel() { if (!ended) { ended = true; assetStats.cancelled++; } },
		}), { headers: { 'content-type': 'text/html; charset=utf-8' } });
	}
	if (url.pathname === '/document') return new Response('<!doctype html><body><h1>Custom protocol document</h1><script>globalThis.pageOnly = 42</script><img id="blocked" src="asset://dashboard/image.svg"><script>document.getElementById("blocked").onerror=()=>document.body.dataset.blocked="yes";document.getElementById("blocked").onload=()=>document.body.dataset.blocked="no";</script>', { headers: { 'content-type': 'text/html' } });
	return new Response('Not found', { status: 404 });
});
