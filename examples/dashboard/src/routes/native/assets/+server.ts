import { assetStats } from '../../../lib/server/web-content';
export function GET() { return Response.json(assetStats); }
export async function POST({ request }: { request: Request }) {
	const { action } = await request.json();
	if (action === 'policy') {
		await host.webview.setNavigationPolicy(({ url }) => new URL(url).pathname === '/denied' ? 'cancel' : 'allow');
		return Response.json({ enabled: true });
	}
	if (action === 'clear-policy') {
		await host.webview.setNavigationPolicy(null);
		return Response.json({ enabled: false });
	}
	return new Response('Unknown action', { status: 400 });
}
