import type { Component } from 'svelte';
import type { IconSource, PanelPosition, PopoverCreateOptions, PopoverStyle, DisplayInfo, TrayClickRect } from '../index.ts';
import type { MenuBarItem } from './MenuBar.js';

export type StatusItemProps = {
	/** 'star.fill' → SF Symbol / AppKit name; './x.png' → file; {native}/{path} explicit. Template image. */
	icon?: IconSource;
	/** Text next to the icon in the status bar. */
	label?: string;
	tooltip?: string;
	/** Dot on the icon's top-right — css color, null clears. */
	badgeColor?: string | null;
	/** Native dropdown menu. Wins over `popover`. */
	items?: MenuBarItem[];
	/** Fires on every click (popover and plain modes). */
	onClick?: () => void;
	/** Route (e.g. '/quick') or full options shown in a popover on click. */
	popover?: string | PopoverCreateOptions;
	style?: PopoverStyle;
	width?: number;
	height?: number;
	/** Panel placement: preset, {x,y}, or a callback re-run on every resize. */
	position?: PanelPosition | ((placement: { width: number; height: number; tray?: TrayClickRect; displays: DisplayInfo[] }) => PanelPosition | null | undefined);
	/** Popover open state — toggled by clicks, bindable. */
	open?: boolean;
};

declare const StatusItem: Component<StatusItemProps, {}, 'open'>;
export default StatusItem;
