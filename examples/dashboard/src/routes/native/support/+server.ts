import { json, error } from '@sveltejs/kit';

export async function POST({ request, url }) {
  if (request.headers.get('origin') !== url.origin) error(403, 'Same-origin requests only');
  console.info('[dashboard] collecting a local support bundle');
  const path = await host.diagnostics.collect();
  return json({ path });
}
