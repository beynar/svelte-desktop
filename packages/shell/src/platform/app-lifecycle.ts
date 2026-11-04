import { callPlatform, NativeApiError, onPlatform, onPlatformReady } from './bus';

export type QuitReason = 'api' | 'menu' | 'lastWindowClosed' | 'logout' | 'shutdown' | 'system' | 'signal';
export interface QuitRequest {
	requestId: number;
	reason: QuitReason;
	/** Each phase is bounded by this native deadline (Unix milliseconds). */
	deadline: number;
}
export type QuitDecision = 'quit' | 'cancel';
type Phase = 'quitRequested' | 'beforeQuit' | 'willQuit';

function subscribe(phase: Phase, callback: (request: QuitRequest) => unknown): () => void {
	const token = crypto.randomUUID();
	let active = true;
	const off = onPlatform<QuitRequest & { tokens?: string[] }>(phase, async (request) => {
		if (!active) return;
		// Older/non-macOS backends have an observational willQuit event only.
		// Preserve its parameterless listeners without claiming an awaited phase.
		if (!request.tokens) {
			if (phase === 'willQuit') {
				try { await callback(request); } catch (error) { console.error('[shell] willQuit handler failed', error); }
			}
			return;
		}
		if (!request.tokens.includes(token)) return;
		let decision: QuitDecision = 'quit';
		try {
			const result = await callback(request);
			if (phase === 'quitRequested' && result !== 'quit') decision = 'cancel';
		} catch (error) {
			console.error(`[shell] ${phase} handler failed`, error);
			if (phase === 'quitRequested') decision = 'cancel';
		}
		await callPlatform('app', 'replyQuit', { token, phase, requestId: request.requestId, decision }).catch(() => {});
	});
	onPlatformReady(() => {
		if (active) void callPlatform('app', 'subscribeQuit', { token, phase }).catch((error) => {
			if (phase === 'willQuit' && error instanceof NativeApiError && error.code === 'unsupported') return;
			console.error('[shell] quit subscription failed', error);
		});
	});
	return () => {
		if (!active) return;
		active = false;
		off();
		void callPlatform('app', 'unsubscribeQuit', { token }).catch(() => {});
	};
}

/** All registered page and server guards vote; any cancel keeps every window alive. */
export const appLifecycle = {
	onQuitRequested: (callback: (request: QuitRequest) => QuitDecision | Promise<QuitDecision>) => subscribe('quitRequested', callback),
	/** Runs after every guard allows quit, while windows and the server still exist. */
	onBeforeQuit: (callback: (request: QuitRequest) => void | Promise<void>) => subscribe('beforeQuit', callback),
	/** Final bounded cleanup phase, after beforeQuit completes. Cannot veto. */
	onWillQuit: (callback: (request: QuitRequest) => void | Promise<void>) => subscribe('willQuit', callback),
};
