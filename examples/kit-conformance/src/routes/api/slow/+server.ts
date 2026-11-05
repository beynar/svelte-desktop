import { json } from '@sveltejs/kit';

// Longer than Bun.serve's default idle timeout (10 s).
export async function GET({ url }) {
	const ms = Number(url.searchParams.get('ms') ?? 12000);
	await new Promise((r) => setTimeout(r, ms));
	return json({ waited: ms });
}
