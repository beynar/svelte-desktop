export async function load({ parent }) {
	const p = await parent();
	return { greeting: `hello ${p.user}` };
}
