/** Config and server handlers must agree on resource-scheme names. Native checks WebKit too. */
export function isCustomProtocolScheme(scheme: unknown): scheme is string {
	return typeof scheme === 'string' && /^[a-z][a-z0-9+.-]*$/.test(scheme) &&
		!['http', 'https', 'file', 'data', 'blob', 'about', 'javascript', 'ws', 'wss'].includes(scheme);
}
