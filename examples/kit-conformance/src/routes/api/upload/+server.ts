import { json } from '@sveltejs/kit';

export async function POST({ request }) {
	const file = (await request.formData()).get('file') as File;
	const bytes = new Uint8Array(await file.arrayBuffer());
	let sum = 0;
	for (let i = 0; i < bytes.length; i += 4096) sum = (sum + bytes[i]!) % 65536;
	return json({ name: file.name, size: file.size, sum });
}
