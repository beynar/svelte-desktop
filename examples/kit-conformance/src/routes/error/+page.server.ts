import { error } from '@sveltejs/kit';
export function load() {
	error(418, 'teapot');
}
