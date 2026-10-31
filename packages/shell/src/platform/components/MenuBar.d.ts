import type { Component } from 'svelte';
import type { IconSource, MenuItemRole } from '../index.ts';

export type MenuBarItem = {
	label?: string;
	/** 'add' → native image name (NATIVE_ICON_NAMES); './x.png' → file;
	 *  {native}/{path} explicit. */
	icon?: IconSource;
	onClick?: () => void;
	subItems?: MenuBarItem[];
	submenu?: MenuBarItem[];
	role?: MenuItemRole;
	checked?: boolean;
	disabled?: boolean;
	/** Explicit action id — otherwise generated. */
	id?: string;
} | 'separator' | '-';

export type MenuBarProps = {
	/** Top-level menu title shown in the menu bar. */
	label: string;
	/** Bar-item icon — same sources as item icons (name/file/{native}/{path}). */
	icon?: IconSource;
	/** Dropdown items. Omit for a plain clickable bar entry (uses onClick). */
	items?: MenuBarItem[];
	/** Bar position — absent lands before "Window". */
	index?: number;
	/** Click handler for the items-less clickable form. */
	onClick?: () => void;
};

declare const MenuBar: Component<MenuBarProps>;
export default MenuBar;
