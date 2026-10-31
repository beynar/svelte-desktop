// The contract between pages and the self-hosted push client in the app's server process
// (desktop.ts), over the platform broadcast channel. Dependency-free: pages import it.
import type { WebPushTarget, WirePushMessage } from './protocol.ts';

/** The client registered on globalThis by desktop.ts, used directly by server code. */
export const PUSH_CLIENT = Symbol.for('svelte-desktop.push.client');

export const CHANNEL = {
	request: 'push:request',
	reply: 'push:reply',
	/** A received message, relayed to pages. */
	message: 'push:message',
	/** A new target, relayed to pages. */
	target: 'push:target',
} as const;

/** Each operation and its result. */
export interface DesktopPushOps {
	register: WebPushTarget;
	token: WebPushTarget | null;
	unregister: null;
}
export type DesktopPushOp = keyof DesktopPushOps;

export interface DesktopPushClient {
	run<O extends DesktopPushOp>(op: O): Promise<DesktopPushOps[O]>;
}

export type DesktopPushRequest = { op: DesktopPushOp; nonce: string };
export type DesktopPushReply =
	| { nonce: string; ok: true; value: DesktopPushOps[DesktopPushOp] }
	| { nonce: string; ok: false; error: string };

/** What the server process relays as `pushMessage` (same shape as the native backends emit). */
export interface RelayedPushMessage {
	id?: string;
	data: WirePushMessage;
	payload?: string;
	notification?: { title: string; body: string };
	foreground: boolean;
}

export const isDesktopPushOp = (op: unknown): op is DesktopPushOp => op === 'register' || op === 'token' || op === 'unregister';
