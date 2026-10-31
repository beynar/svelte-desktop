import type { Component } from 'svelte';
import type { PanelPosition, PopoverAnchor, PopoverCreateOptions } from '../index.ts';

export type PopoverProps = Omit<PopoverCreateOptions, 'tray' | 'position'> & {
	/** Element of this page the arrow points at, 'cursor', or a rect. Default 'cursor'. */
	anchor?: Element | PopoverAnchor;
	/** Panel placement (style 'panel'). */
	position?: PanelPosition;
	/** Global hotkey that toggles it, e.g. 'Alt+Space'. */
	shortcut?: string;
	open?: boolean;
	onShow?: () => void;
	onHide?: () => void;
};

declare const Popover: Component<PopoverProps, {}, 'open'>;
export default Popover;
