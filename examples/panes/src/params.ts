import { defineParams } from '@sveltejs/kit/params';

export const params = defineParams({
	int: (param: string) => /^\d+$/.test(param)
});
