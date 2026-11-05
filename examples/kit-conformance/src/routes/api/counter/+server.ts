import { json } from '@sveltejs/kit';
let n = 0;
export function GET() {
	return json({ n: ++n });
}
