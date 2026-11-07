import type { Component, Snippet } from 'svelte';
import type { IconSource, PopoverPosition } from '@svelte-desktop/platform';
import type { MenuBarItem } from './MenuBar.js';

export type StatusItemProps = {
	/** Status icon — 'add' → native image name (NATIVE_ICON_NAMES),
	 *  './x.png' → file, {native}/{path} explicit. Renders as a template. */
	icon?: IconSource;
	/** Text shown next to the icon in the status bar. */
	label?: string;
	tooltip?: string;
	/** Dot composited on the icon's top-right — css color or null to clear. */
	badgeColor?: string | null;
	/** Dropdown menu items — mutually exclusive with a children popover. */
	items?: MenuBarItem[];
	/** Fires on every tray click (all modes). */
	onClick?: () => void;
	/** Popover open state — bindable; toggled by tray clicks in popover mode. */
	open?: boolean;
	/** Popover placement — preset name (default 'trayBottom'), fixed {x,y}
	 *  in the window's screen coordinates, or a callback evaluated on every
	 *  fit: `({width,height,tray,displays}) => preset | {x,y}`. */
	position?: PopoverPosition;
	/** Popover content — renders into a borderless window sized to fit. */
	children?: Snippet;
};

declare const StatusItem: Component<StatusItemProps, {}, 'open'>;
export default StatusItem;
