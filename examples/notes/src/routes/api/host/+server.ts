// `host` in server code, with no import.
import { json } from '@sveltejs/kit';

export async function GET() {
	return json({
		available: host.available,
		name: await host.app.getName(),
		data: host.available ? host.paths.data : null,
		jobs: Array.isArray(host.jobs.list()),
		start: typeof host.jobs.start
	});
}
