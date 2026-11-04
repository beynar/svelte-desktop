import { webSecurityDemo } from '#lib/server/web-security';
export async function GET() { return Response.json(await webSecurityDemo()); }
export async function POST({ request }: { request: Request }) {
	// This endpoint changes native policy: require a same-origin POST, including in browser dev.
	if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
	const { action } = await request.json();
	if (typeof action !== 'string') return new Response('Invalid action', { status: 400 });
	return Response.json(await webSecurityDemo(action));
}
