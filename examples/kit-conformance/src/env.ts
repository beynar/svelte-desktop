// SvelteKit 3: environment variables are declared here (read when the app starts).
import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	CONFORMANCE_SECRET: { schema: (value?: string) => value ?? 'unset' }
});
