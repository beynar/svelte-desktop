import { redirect } from '#kit';

export function load({ params, url }) {
	const id = Number(params.id);
	if (id === 0) redirect(302, '/'); // control flow via thrown redirect
	// reading url.searchParams marks uses.search_params — a search-only
	// change to the same route must rerun this load
	return { id, doubled: id * 2, tab: url.searchParams.get('tab') ?? 'none' };
}
