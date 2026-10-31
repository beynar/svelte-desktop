import { json } from '@sveltejs/kit';

export function GET({ url }: { url: URL }) {
	return json({
		ok: true,
		runtime: Bun.version,
		echo: url.searchParams.get('echo'),
		uptime: Math.round(process.uptime() * 1000)
	});
}
