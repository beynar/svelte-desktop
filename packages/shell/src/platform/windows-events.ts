import { callPlatform, onPlatform } from './bus';
import type { WindowBounds, WindowInfo } from './index';

export interface WindowTransition { windowId: number }
export interface WindowFullscreenTransition extends WindowTransition {
	fullscreen: boolean;
	transition: 'entered' | 'exited';
}
export interface WindowTransitionEvents {
	shown: WindowTransition;
	hidden: WindowTransition;
	minimized: WindowTransition;
	restored: WindowTransition;
	fullscreenChanged: WindowFullscreenTransition;
	moved: WindowTransition & WindowBounds;
	resized: WindowTransition & WindowBounds;
	focus: WindowTransition;
	blur: WindowTransition;
}
const wid = (windowId?: number) => windowId === undefined ? {} : { windowId };
const on = <E extends keyof WindowTransitionEvents>(event: E, callback: (data: WindowTransitionEvents[E]) => void) => onPlatform(event, callback);

export const windowTransitions = {
	on,
	onShown: (callback: (data: WindowTransition) => void) => on('shown', callback),
	onHidden: (callback: (data: WindowTransition) => void) => on('hidden', callback),
	onMinimized: (callback: (data: WindowTransition) => void) => on('minimized', callback),
	onRestored: (callback: (data: WindowTransition) => void) => on('restored', callback),
	onFullscreenChanged: (callback: (data: WindowFullscreenTransition) => void) => on('fullscreenChanged', callback),
	onMoved: (callback: (data: WindowTransition & WindowBounds) => void) => on('moved', callback),
	onResized: (callback: (data: WindowTransition & WindowBounds) => void) => on('resized', callback),
	onFocus: (callback: (data: WindowTransition) => void) => on('focus', callback),
	onBlur: (callback: (data: WindowTransition) => void) => on('blur', callback),
	/** null detaches. A modal child must always have a parent. */
	setParent: (parentId: number | null, windowId?: number) => callPlatform<null>('window', 'setParent', { parentId, ...wid(windowId) }),
	getParent: (windowId?: number) => callPlatform<WindowInfo | null>('window', 'getParent', wid(windowId)),
	getChildren: (windowId?: number) => callPlatform<WindowInfo[]>('window', 'getChildren', wid(windowId)),
	getLevel: (windowId?: number) => callPlatform<number>('window', 'getLevel', wid(windowId)),
	isAlwaysOnTop: (windowId?: number) => callPlatform<boolean>('window', 'isAlwaysOnTop', wid(windowId)),
	hasShadow: (windowId?: number) => callPlatform<boolean>('window', 'hasShadow', wid(windowId)),
	isMovable: (windowId?: number) => callPlatform<boolean>('window', 'isMovable', wid(windowId)),
	isFocusable: (windowId?: number) => callPlatform<boolean>('window', 'isFocusable', wid(windowId)),
	getMinSize: (windowId?: number) => callPlatform<{ width: number; height: number }>('window', 'getMinSize', wid(windowId)),
	/** An unconstrained axis is 0, matching setMaxSize. Sizes are content points. */
	getMaxSize: (windowId?: number) => callPlatform<{ width: number; height: number }>('window', 'getMaxSize', wid(windowId)),
};
