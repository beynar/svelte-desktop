export async function load({ fetch, depends }) {
	depends('app:counter');
	return { n: (await (await fetch('/api/counter')).json()).n };
}
