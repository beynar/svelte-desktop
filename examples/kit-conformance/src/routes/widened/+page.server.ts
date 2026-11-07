// tests/bridge.test.ts: a page that sets its own Permissions-Policy.
export const load = ({ setHeaders }) => {
	setHeaders({ 'permissions-policy': 'camera=*' });
};
