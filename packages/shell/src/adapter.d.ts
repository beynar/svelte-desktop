import type { Adapter } from '@sveltejs/kit';
import type { DesktopConfig, ResolvedConfig } from './config.ts';

/** Normally created by the Vite plugin (`desktop()` from '@svelte-desktop/shell/vite'). */
export default function desktopAdapter(
	options: ResolvedConfig | (DesktopConfig & { stage?: string; out?: string; package?: boolean })
): Adapter;
