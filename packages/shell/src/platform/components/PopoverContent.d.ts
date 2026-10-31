import type { Component, Snippet } from 'svelte';

export type PopoverContentProps = {
	/** Size the popover to the content: 'height' (default), 'both' (max-content width), 'none'. */
	fit?: 'height' | 'both' | 'none';
	padding?: string;
	class?: string;
	children?: Snippet;
};

declare const PopoverContent: Component<PopoverContentProps>;
export default PopoverContent;
