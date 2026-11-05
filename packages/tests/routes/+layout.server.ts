// +layout.server.ts — runs through hooks.handle; sees event.locals.
import { state } from '../hooks.ts';

export function load({ locals }) {
	state.layoutLoads = (state.layoutLoads ?? 0) + 1;
	return { serverUser: locals.user ?? 'no-hook' };
}
