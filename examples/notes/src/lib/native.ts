import { nativeModule } from '@svelte-desktop/shell/platform';

/** Typed view of native/Greeter.swift — works from pages and server code. */
export interface Greeter {
	hello(args: { name: string }): string;
	windowTitle(): string | null;
	add(args: { a: number; b: number }): number;
	ping(): boolean;
}

export const greeter = nativeModule<Greeter>('greeter');
