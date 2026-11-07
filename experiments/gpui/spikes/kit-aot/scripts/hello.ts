// Sanity baseline: the smallest possible Bun.serve app.
const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	fetch: () => new Response('hello world')
});
console.log(`Listening on ${server.url}`);
