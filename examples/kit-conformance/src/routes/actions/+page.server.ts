import { fail, redirect } from '@sveltejs/kit';

export function load({ cookies }) {
	return { name: cookies.get('name') ?? null };
}

export const actions = {
	save: async ({ request, cookies }) => {
		const name = String((await request.formData()).get('name') ?? '');
		cookies.set('name', name, { path: '/', httpOnly: true, sameSite: 'strict' });
		return { saved: name };
	},
	echo: async ({ request }) => ({ echo: String((await request.formData()).get('text') ?? '') }),
	invalid: async () => fail(400, { missing: true }),
	go: async () => redirect(303, '/load?q=from-action')
};
