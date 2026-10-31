// Runs the `hello` sidecar from server code (Android builds compile it from
// native/android/sidecars/hello.c). 404 where the app ships no such sidecar.
import { json } from '@sveltejs/kit';
import { sidecar } from '@svelte-desktop/shell/server';

export async function GET({ url }: { url: URL }) {
	try {
		const proc = await sidecar('hello', [url.searchParams.get('arg') ?? 'world'], { stdout: 'pipe' });
		const out = await new Response(proc.stdout as ReadableStream).text();
		return json({ ok: true, code: await proc.exited, out: out.trim() });
	} catch (err) {
		return json({ ok: false, error: String((err as Error).message) }, { status: 404 });
	}
}
