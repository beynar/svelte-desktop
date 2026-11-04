// The user's tools, found on their shell's PATH: an app opened from the Finder doesn't get the
// PATH their terminal builds (host.which reads it from their login shell). And the server's network:
// the system's certificates and proxy (desktop.config `network`, on by default).
import tls from 'node:tls';

export const load = async () => {
	const names = ['claude', 'codex', 'gemini', 'git', 'uv', 'node', 'python3'];
	const tools = await Promise.all(names.map(async (name) => ({ name, path: await host.which(name) })));
	return {
		tools,
		appPath: (process.env.PATH ?? '').split(':').length,
		shellPath: ((await host.shellEnv()).PATH ?? '').split(':').length,
		network: {
			systemCertificates: process.env.NODE_USE_SYSTEM_CA === '1',
			certificates: tls.getCACertificates('default').length,
			proxy: process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? null
		}
	};
};
