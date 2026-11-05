// An address with no page: a link to it is a load, not a navigation of the router's.
export const GET = () => new Response('hello', { headers: { 'content-type': 'text/plain' } });
