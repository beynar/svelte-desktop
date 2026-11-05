import { json, error } from '@sveltejs/kit';
import type { ServiceHandle } from '@kitop/shell/server';

let counter: Promise<ServiceHandle> | undefined;
export async function POST({ request, url }) {
  if (request.headers.get('origin') !== url.origin) error(403, 'Same-origin requests only');
  if (!counter) counter = host.services.start('counter', { initial: 0 }, { restart: { maxRestarts: 3 } }).catch((e) => { counter = undefined; throw e; });
  const service = await counter;
  if (service.state === 'stopped') { counter = undefined; error(503, 'Counter stopped; try again'); }
  return json(await service.request<{ count: number; pid: number }>('increment'));
}
