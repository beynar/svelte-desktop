// SvelteKit 3: every param matcher in one module, as Standard Schema validators.
export const params = {
	integer: {
		'~standard': {
			version: 1,
			vendor: 'kit-conformance',
			validate: (value: unknown) =>
				typeof value === 'string' && /^\d+$/.test(value) ? { value } : { issues: [{ message: 'not an integer' }] }
		}
	}
};
