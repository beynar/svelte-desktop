export async function load({ data, fetch }) {
	const echo = await (await fetch('/api/echo?from=universal-load')).json();
	return { ...data, universal: 'from +page.ts', fetched: echo.query.from };
}
