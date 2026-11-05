export function load({ cookies }) {
	return { layout: 'from +layout.server.ts', visitor: cookies.get('visitor') ?? null };
}
