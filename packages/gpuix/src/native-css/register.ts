/**
 * Shared stylesheet registry — the runtime half of the CSS → native-styling
 * pipeline (and of the vite plugin's `virtual:svelte-native-style?<id>`
 * modules).
 *
 *   transform (.svelte, css:'external')
 *     → parseStylesheet(css) → NativeStyleRule[]   (native-css/parse.ts)
 *     → virtual module calls registerSheet('<id>', <rules>)
 *     → emit('stylesheet.register', id, rules)     (this file)
 *     → Rust StyleSheetRegistry matches/resolves    (native/src/stylesheet.rs)
 *
 * Contract — same one probe-styled.ts exercises: `registerSheet(id, rules)`
 * ships the parsed rule list once; elements carry their class tokens via
 * gdom's `setClass` op; matching, cascade and pseudo-bucket routing run in
 * Rust. Same-id re-registration REPLACES the sheet (StyleSheetRegistry is
 * keyed), so re-emitted sheets are edits, not appends — dev reloads stay
 * clean.
 *
 * Note on unaware renderers: `stylesheet.register` lands as an unknown op
 * on builds that predate the Rust ops — the batch retries once then drops
 * (see native.ts flush), so sheet styling is lost but the tree still
 * mounts. Keeping the op in its own batch (call flush() after registration)
 * limits that blast radius on old builds.
 */
import { emit } from '../native.ts';
import {
	registerComputedStyleRules,
	registerCssAnimations,
	unregisterComputedStyleRules,
	unregisterCssAnimations,
} from '../gdom.ts';
import type { CssAnimationRule, CssKeyframesDef, NativeStyleRule } from './parse.ts';

/** id → last-registered rule list (introspection + future rebind replay). */
const sheets = new Map<string, NativeStyleRule[]>();

/**
 * Register (or replace) one module's stylesheet. Called once per compiled
 * component at module-eval time — before mount, so the rules are in the
 * native registry ahead of first paint.
 *
 * `keyframes`/`animations` are the sheet's declared-CSS-animation payload:
 * `@keyframes` name→frames plus each `animation:`-carrying selector lowered
 * to an animate() spec. They never cross the wire — gdom reconciles them
 * onto elements whose classes match, the same CSS→WAAPI lowering browsers
 * perform.
 */
export function registerSheet(
	id: string,
	rules: NativeStyleRule[] = [],
	keyframes?: CssKeyframesDef[],
	animations?: CssAnimationRule[],
): void {
	sheets.set(id, rules);
	emit('stylesheet.register', id, rules);
	registerComputedStyleRules(id, rules);
	registerCssAnimations(id, keyframes, animations);
}

/**
 * Drop a sheet entirely — e.g. a `<style>` block deleted from a component
 * during dev. Rust removes it and re-resolves only affected elements
 * (rules with no class comp trigger the broad path).
 */
export function unregisterSheet(id: string): void {
	if (!sheets.delete(id)) return;
	emit('stylesheet.unregister', id);
	unregisterComputedStyleRules(id);
	unregisterCssAnimations(id);
}

/** Test/debug introspection: id → rule list last sent for that sheet. */
export function registeredSheets(): Record<string, NativeStyleRule[]> {
	return Object.fromEntries(sheets);
}
