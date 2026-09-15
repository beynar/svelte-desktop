// +page.ts — universal load. parent() yields layout data; depends('home')
// makes this re-runnable via invalidate('home').
let loads = 0;

export async function load({ parent, depends, data }) {
	const p = await parent();
	depends('home');
	return { greeting: `hello ${p.user}`, n: ++loads, viaData: data?.noteCount };
}
