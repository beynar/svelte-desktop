// Imported by the generated Worker entry BEFORE the SvelteKit handler, because
// adapter-bun reads these at module-evaluation time. With no baked
// `paths.origin`, adapter-bun derives the origin from the request and defaults
// the protocol to https; the gate stamps this header with "http" instead.
export const PROTOCOL_HEADER = "x-svelte-desktop-proto";
Bun.env.PROTOCOL_HEADER = PROTOCOL_HEADER;
