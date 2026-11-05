import { fail, redirect } from '#kit';

export const actions = {
	default: async ({ request }) => {
		const fd = await request.formData();
		return { saved: fd.get('note'), via: 'default' };
	},
	named: async ({ request }) => {
		const fd = await request.formData();
		return { saved: fd.get('note'), via: 'named' };
	},
	intent: async ({ request }) => {
		const fd = await request.formData();
		return { via: 'intent', intent: fd.get('intent') };
	},
	bad: async () => fail(400, { problem: 'invalid-input' }),
	away: async () => redirect(303, '/about'),
};
