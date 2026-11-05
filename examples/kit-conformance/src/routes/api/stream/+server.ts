export function GET() {
	let i = 0;
	const stream = new ReadableStream({
		async pull(controller) {
			if (i === 5) return controller.close();
			await new Promise((r) => setTimeout(r, 100));
			controller.enqueue(new TextEncoder().encode(`chunk${i++}\n`));
		}
	});
	return new Response(stream, { headers: { 'content-type': 'text/plain' } });
}
