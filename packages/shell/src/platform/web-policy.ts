import { callPlatform, onPlatform, NativeApiError } from './bus';

export type WebPermission = 'camera' | 'microphone' | 'location' | 'speech' | 'screenRecording';
export type WebPermissionDecision = 'allow' | 'deny' | 'prompt';
export type WebPermissionRequest = {
	origin: string;
	/** Null when WebKit's speech SPI does not expose the initiating frame. */
	frame: { origin: string; url: string; main: boolean } | null;
	permission: WebPermission;
	viewId?: string;
	windowId?: number;
	popoverId?: string;
};
export type WebPermissionRecord = { origin: string; permission: WebPermission; decision: WebPermissionDecision };
export type ClientIdentity = { identity: string; label: string; fingerprint: string };
export type AuthChallenge = {
	origin: string;
	host: string;
	port: number;
	realm: string;
	method: 'basic' | 'digest' | 'ntlm' | 'clientCertificate' | 'serverTrust';
	proxy: boolean;
	previousFailures: number;
	viewId?: string;
	windowId?: number;
	popoverId?: string;
	/** SHA-256 of the DER leaf certificate, lowercase hex; present for failed server trust. */
	fingerprint?: string;
	identities: ClientIdentity[];
};
export type AuthChallengeAnswer = { username: string; password: string } | { identity: string } | 'cancel' | 'default';
export type PermissionHandler = (request: WebPermissionRequest) => WebPermissionDecision | Promise<WebPermissionDecision>;
export type AuthChallengeHandler = (request: AuthChallenge) => AuthChallengeAnswer | Promise<AuthChallengeAnswer>;
type Request<T> = T & { requestId: string };
type PolicyState = { permission: PermissionHandler | null; auth: AuthChallengeHandler | null; listening: boolean };
const state = ((globalThis as Record<symbol, PolicyState | undefined>)[Symbol.for('svelte-desktop.web-policy')] ??= {
	permission: null, auth: null, listening: false,
});
function assertServer() {
	if (typeof window !== 'undefined') throw new NativeApiError('denied', 'Web policy handlers and decisions must be configured in server code');
}
function listen() {
	if (state.listening) return;
	state.listening = true;
	onPlatform<Request<WebPermissionRequest>>('webPermissionRequest', async ({ requestId, ...request }) => {
		let answer: WebPermissionDecision = 'deny';
		try { answer = await state.permission?.(request) ?? 'deny'; } catch { /* Handler failures deny. */ }
		await callPlatform('webview', 'respondPolicy', { requestId, answer }).catch(() => {});
	});
	onPlatform<Request<AuthChallenge>>('webAuthChallenge', async ({ requestId, ...request }) => {
		let answer: AuthChallengeAnswer = 'cancel';
		try { answer = await state.auth?.(request) ?? 'cancel'; } catch { /* Credentials never reach logs or page events. */ }
		await callPlatform('webview', 'respondPolicy', { requestId, answer }).catch(() => {});
	});
}

/** Server-only policy, shared by all shell views. macOS only. */
export const webPolicy = {
	async setPermissionHandler(handler: PermissionHandler | null, options: { timeoutMs?: number } = {}): Promise<void> {
		assertServer(); listen();
		await callPlatform('webview', 'configurePolicy', { kind: 'permission', enabled: handler !== null, ...options });
		state.permission = handler;
	},
	async onAuthChallenge(handler: AuthChallengeHandler | null, options: { timeoutMs?: number } = {}): Promise<void> {
		assertServer(); listen();
		await callPlatform('webview', 'configurePolicy', { kind: 'auth', enabled: handler !== null, ...options });
		state.auth = handler;
	},
	/** Explicit app-owned persistence. Handlers alone do not persist their answers. */
	setPermissionDecision: (record: WebPermissionRecord) => callPlatform<null>('webview', 'setPermissionDecision', record),
	listPermissionDecisions: () => callPlatform<WebPermissionRecord[]>('webview', 'listPermissionDecisions'),
	revokePermissionDecision: (record: Pick<WebPermissionRecord, 'origin' | 'permission'>) => callPlatform<null>('webview', 'revokePermissionDecision', record),
	/** Exact host + DER leaf SHA-256, valid for this app run. Never a global trust bypass. */
	allowCertificate: (pin: { host: string; fingerprint: string }) => callPlatform<null>('webview', 'allowCertificate', pin),
	revokeCertificate: (pin: { host: string; fingerprint: string }) => callPlatform<null>('webview', 'revokeCertificate', pin),
	listClientIdentities: () => callPlatform<ClientIdentity[]>('webview', 'listClientIdentities'),
};
