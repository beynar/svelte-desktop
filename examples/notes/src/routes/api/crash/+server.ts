// How the previous run ended (desktop.crashInfo()): an app could offer to send the reports.
import { json } from '@sveltejs/kit';

export function GET() {
	return json(host.available ? host.crashInfo() : null);
}
