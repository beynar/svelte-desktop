// deliberately slow universal load — exercises navigation coalescing:
// a faster goto() issued after this one must win, this nav gets abandoned.
export async function load() {
	await new Promise((r) => setTimeout(r, 150));
	return { slow: 'done' };
}
