import { callPlatform, onPlatform } from './bus';

export type InputModifier = 'meta' | 'control' | 'alt' | 'shift';
export type InputShortcut = { key: string; modifiers?: InputModifier[] };
export type InputPolicy = { intercept?: InputShortcut[]; menuShortcuts?: boolean };
export type BeforeInputEvent = {
	windowId: number;
	key: string;
	keyCode: number;
	type: 'keyDown' | 'keyUp';
	isAutoRepeat: boolean;
	modifiers: InputModifier[];
	intercepted: true;
};
export const input = {
	/** macOS and Linux. Replaces this window's policy. Decisions are native; events are observational. */
	setInputPolicy: (policy: InputPolicy, windowId?: number) =>
		callPlatform<{ monitorInstalled: boolean; interceptCount: number; menuShortcuts: boolean }>('webview', 'setInputPolicy', { ...policy, ...(windowId === undefined ? {} : { windowId }) }),
	getInputPolicy: (windowId?: number) =>
		callPlatform<{ monitorInstalled: boolean; intercept: InputShortcut[]; menuShortcuts: boolean }>('webview', 'getInputPolicy', windowId === undefined ? {} : { windowId }),
	onBeforeInput: (cb: (event: BeforeInputEvent) => void) => onPlatform('beforeInput', cb),
};
