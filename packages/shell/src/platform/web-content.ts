import { callPlatform, onPlatform, NativeApiError } from './bus';
import type { WebviewTarget } from './index';

/** WebKit content-blocker JSON. No request callbacks or header/body rewriting. */
type ContentRuleTrigger = {
	'url-filter': string;
	'url-filter-is-case-sensitive'?: boolean;
	'resource-type'?: Array<'document' | 'image' | 'style-sheet' | 'script' | 'font' | 'raw' | 'svg-document' | 'media' | 'popup' | 'ping' | 'fetch' | 'websocket' | 'other'>;
	'load-type'?: Array<'first-party' | 'third-party'>;
	'if-domain'?: string[];
	'unless-domain'?: string[];
	'if-top-url'?: string[];
	'unless-top-url'?: string[];
};
export type ContentRule =
	| { trigger: ContentRuleTrigger; action: { type: 'block' | 'block-cookies' | 'make-https' | 'ignore-previous-rules' } }
	| { trigger: Omit<ContentRuleTrigger, 'if-domain' | 'if-top-url'> & { 'if-domain'?: never; 'if-top-url'?: never }; action: { type: 'css-display-none'; selector: string } };
export type UserScript = {
	id: string;
	source: string;
	timing: 'start' | 'end';
	/** 'page' shares page globals; any other name creates an isolated WKContentWorld. */
	world: 'page' | string;
	mainFrameOnly?: boolean;
	/** Omitted: every existing and future web view, across sessions. */
	target?: WebviewTarget;
};
export type NavigationRequest = { url: string; isMainFrame: boolean; viewId: string };
export type NavigationPolicy = (request: NavigationRequest) => 'allow' | 'cancel' | Promise<'allow' | 'cancel'>;
const navigationState = ((globalThis as Record<symbol, { off?: () => void } | undefined>)[Symbol.for('kitop.navigation-policy')] ??= {});

export const webContent = {
	/** Global, including all sessions. The app origin and bridge are always exempt. */
	setContentRules: (options: { id: string; rules: ContentRule[] }) => callPlatform<null>('webview', 'setContentRules', options),
	listContentRules: () => callPlatform<{ id: string; rules: ContentRule[] }[]>('webview', 'listContentRules'),
	removeContentRules: (id: string) => callPlatform<null>('webview', 'removeContentRules', { id }),
	scripts: {
		register: (script: UserScript) => callPlatform<null>('webview', 'registerScript', script),
		unregister: (id: string) => callPlatform<null>('webview', 'unregisterScript', { id }),
		list: () => callPlatform<UserScript[]>('webview', 'listScripts'),
	},
	/** Server only. Adds a veto to the shell's existing navigation safety checks. On Windows it holds the UI thread's callbacks: don't wait on a web view in it. */
	async setNavigationPolicy(policy: NavigationPolicy | null): Promise<void> {
		if (typeof window !== 'undefined') throw new NativeApiError('denied', 'navigation policy belongs to server code');
		navigationState.off?.();
		navigationState.off = policy ? onPlatform<NavigationRequest & { requestId: string }>('webContentNavigation', (request) => {
			void Promise.resolve().then(() => policy(request)).then((decision) => {
				return callPlatform('webview', 'navigationDecision', { requestId: request.requestId, allow: decision === 'allow' });
			}, () => callPlatform('webview', 'navigationDecision', { requestId: request.requestId, allow: false })).catch(() => {});
		}) : undefined;
		try { await callPlatform('webview', 'setNavigationPolicy', { enabled: !!policy }); }
		catch (error) { navigationState.off?.(); navigationState.off = undefined; throw error; }
	},
};
