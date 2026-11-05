/**
 * probe-stylex — definition-time style validation, the StyleX-shaped layer:
 *
 *   grammar tier (at define):  typo'd props, malformed values, non-object
 *                              buckets, undeclared defaultVariants — surface
 *                              at module load, not first render.
 *   palette tier (at sweep):   grammar-fine refs that resolve under no
 *                              registered palette — re-checked on every
 *                              theme swap via the token-cache-clear hook.
 *   call time:                 unknown variant values warn once.
 *   shipped surface:           every nkit recipe defines clean — zero
 *                              'props'-lane definition issues.
 */
await import('@svelte-desktop/svelte/build.ts');

const {
	s, defineStyles, checkStyleProps, definitionIssues, validateDefinitions,
	isNativeStyle, resolveStyleProps,
} = await import('@svelte-desktop/gpuix/gen/nkit/style.js');
const { recipe } = await import('@svelte-desktop/gpuix/gen/nkit/recipe.js');
const { checkTokens } = await import('@svelte-desktop/gpuix/gen/nkit/tokens.js');

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
	if (cond) { pass++; console.log(`✅ ${name}`); }
	else { fail++; console.log(`❌ ${name} ${extra}`); }
};
const issuesFor = (label: string) => definitionIssues.filter((i) => i.label === label || i.label.startsWith(label + '.'));

// ── grammar tier: checkStyleProps ────────────────────────────────
check('clean fragment → no drops', checkStyleProps({ bg: 'primary', px: 'lg', hover: { fg: 'color-readable' } }).length === 0);
check('typo key dropped', checkStyleProps({ raduis: 'lg' }).includes('raduis'));
check('malformed aspect dropped', checkStyleProps({ aspect: 'banana' }).some((d) => d.startsWith('aspect:')));
check('non-object bucket dropped', checkStyleProps({ hover: 5 as any }).some((d) => d.includes('bucket')));
check('grammar-ok palette-unknown ref passes define (deferred to sweep)',
	checkStyleProps({ bg: 'brandnewcolor' }).length === 0);

// ── defineStyles: validate + freeze + register ───────────────────
const styles = defineStyles(
	{
		root: { bg: 'surface', radius: 'lg', p: 'lg', hover: { bg: 'surface-raised' } },
		title: { fontW: 600, text: 'lg' },
	},
	'probe',
);
check('defineStyles returns frozen map (deep)',
	Object.isFrozen(styles) && Object.isFrozen(styles.root) && Object.isFrozen((styles.root as any).hover));
// style() ships the raw fragment to the native engine — the JS mirror maps it
check('style() returns the native envelope (raw frags, no JS mapping)',
	isNativeStyle(style(styles.root as any)) &&
	(style(styles.root as any) as any).__frags[0] === styles.root);
check('defineStyles fragment maps through the JS mirror',
	(resolveStyleProps(styles.root as any) as any).backgroundColor === 'surface' &&
	(resolveStyleProps(styles.title as any) as any).fontWeight === 600);
// application-order shorthand conflicts — the StyleX rule (Rust owns this
// natively; the mirror must agree)
check('px then p: later shorthand wins (application order)',
	(resolveStyleProps([{ px: 'xl' }, { p: 'md' }] as any) as any).paddingLeft === 'md');
check('p then px: later longhand wins (application order)',
	(resolveStyleProps([{ p: 'md' }, { px: 'xl' }] as any) as any).paddingLeft === 'xl' &&
	(resolveStyleProps([{ p: 'md' }, { px: 'xl' }] as any) as any).paddingTop === 'md');

// ── palette tier: sweep flags refs no palette can resolve ────────
const before = definitionIssues.length;
defineStyles({ bad: { bg: 'definitelynotacolor' } }, 'sweepprobe');
check('unknown color name passes grammar silently', issuesFor('sweepprobe').length === 0);
validateDefinitions();
check('palette sweep flags unresolvable ref',
	issuesFor('sweepprobe').some((i) => i.key === 'bg:definitelynotacolor'));
check('sweep adds exactly one new issue', definitionIssues.length === before + 1,
	`got ${definitionIssues.length - before}`);

// ── recipe(): declaration + call-time checks ─────────────────────
const issuesAt = (label: string) => definitionIssues.filter((i) => i.label.startsWith(label));
recipe({ base: { raduis: 'lg' } }, 'typoRecipe');
check('recipe base typo flagged at define', issuesAt('typoRecipe').some((i) => i.key === 'raduis'));
recipe({ variants: { size: { a: {}, b: {} } }, defaultVariants: { siz: 'a' } }, 'badDefault');
check('typo defaultVariants key flagged', issuesAt('badDefault').some((i) => i.key.includes("'siz'")));
recipe({ variants: { size: { a: {} } }, defaultVariants: { size: 'huge' } }, 'badDefaultVal');
check('undeclared defaultVariants value flagged', issuesAt('badDefaultVal').some((i) => i.key.includes("'huge'")));
recipe({ variants: { size: { a: {} } }, compoundVariants: [{ colour: 'a', style: { p: 'sm' } }] }, 'badCompound');
check('typo compoundVariants key flagged', issuesAt('badCompound').some((i) => i.key.includes("'colour'")));

const r = recipe({ variants: { size: { a: { p: 'sm' }, b: { p: 'lg' } } }, defaultVariants: { size: 'a' } }, 'calltime');
const n0 = definitionIssues.length;
r({ size: 'huge' });
r({ size: 'huge' }); // dedup — warns once
check('unknown variant value warns at call', issuesAt('calltime').some((i) => i.key === "unknown size='huge'"));
check('variant warn dedupes', definitionIssues.length === n0 + 1);
check('false/absent variant values never warn',
	(() => { const m = definitionIssues.length; r({ size: undefined }); return definitionIssues.length === m; })());

// ── class lane: checkTokens + intentional boundary drops ─────────
check('checkTokens clean string', checkTokens('bg-primary px-lg hover:bg-color').length === 0);
check('checkTokens drops malformed', checkTokens('banana-token').includes('banana-token'));
check('boundary pseudo is a drop (documented)', checkTokens('data-[x]:bg-primary').length === 1);

// ── shipped surface: every nkit recipe defines clean ─────────────
const shippedAt = definitionIssues.length; // exclude the synthetic issues above
await import('@svelte-desktop/gpuix/gen/nkit/recipes/button.js');
await import('@svelte-desktop/gpuix/gen/nkit/recipes/card.js');
await import('@svelte-desktop/gpuix/gen/nkit/recipes/chip.js');
await import('@svelte-desktop/gpuix/gen/nkit/recipes/display.js');
await import('@svelte-desktop/gpuix/gen/nkit/recipes/form.js');
await import('@svelte-desktop/gpuix/gen/nkit/recipes/nav.js');
await import('@svelte-desktop/gpuix/gen/nkit/recipes/overlay.js');
await import('@svelte-desktop/gpuix/gen/nkit/themes.js'); // class-lane cva themes
validateDefinitions();

const shippedIssues = definitionIssues.slice(shippedAt);
const propIssues = shippedIssues.filter((i) => i.lane !== 'class');
const classIssues = shippedIssues.filter((i) => i.lane === 'class');
check('all shipped recipes: zero props-lane issues', propIssues.length === 0,
	JSON.stringify(propIssues.slice(0, 8)));
console.log(`   (class-lane audit: ${classIssues.length} boundary drops — informational)`);

// ── type drift: style.d.ts unions vs the runtime tables ──────────
// The .d.ts is the static contract; these checks fail it if a table grows a
// key nobody typed, or the interface admits a key the vocabulary drops.
const { SPACING, PALETTE, FONT_SIZE, RADIUS, FONT_W, CURSOR, CONTROL_H, ICON } =
	await import('@svelte-desktop/gpuix/gen/nkit/tokens.js');

const dts = await Bun.file('../gpuix/src/nkit/style.d.ts').text();
const union = (name: string) => {
	const m = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(dts);
	return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
};
const tableCheck = (label: string, typeName: string, table: Record<string, unknown>) => {
	const t = new Set(union(typeName));
	const k = Object.keys(table);
	check(`${typeName} ⊇ ${label}`, k.every((x) => t.has(x)), `missing: ${k.filter((x) => !t.has(x)).join(',')}`);
	check(`${label} ⊆ ${typeName}`, union(typeName).every((x) => x in table),
		`extra: ${union(typeName).filter((x) => !(x in table)).join(',')}`);
};
tableCheck('SPACING', 'SpacingToken', SPACING);
tableCheck('PALETTE', 'PaletteName', PALETTE);
tableCheck('FONT_SIZE', 'FontSize', FONT_SIZE);
tableCheck('RADIUS', 'Radius', RADIUS);
tableCheck('FONT_W', 'FontWeight', FONT_W);
tableCheck('CURSOR', 'Cursor', CURSOR);
tableCheck('CONTROL_H', 'ControlSize', CONTROL_H);
tableCheck('ICON', 'IconSize', ICON);

// StyleProps interface keys vs the runtime vocabulary. The vocab set comes
// from style.js itself — `case 'x'` arms, `k === 'x'` tests, and the
// direction tables — so a new key in applyProps without a type entry fails.
const srcJs = await Bun.file('../gpuix/src/nkit/style.js').text();
const vocab = new Set<string>();
for (const m of srcJs.matchAll(/case '([a-zA-Z0-9]+)'/g)) vocab.add(m[1]);
for (const m of srcJs.matchAll(/k === '([a-zA-Z0-9]+)'/g)) vocab.add(m[1]);
for (const t of ['PAD_DIR', 'MAR_DIR', 'BORD_SIDE']) {
	const m = new RegExp(`const ${t} = \\{([^}]*)\\}`).exec(srcJs);
	for (const km of (m?.[1] ?? '').matchAll(/(\w+)\s*:/g)) vocab.add(km[1]);
}
const ifaceBody = /export interface StyleProps \{([\s\S]*?)\n\}/.exec(dts)?.[1] ?? '';
const typedKeys = new Set([...ifaceBody.matchAll(/^\t(\w+)\?:/gm)].map((m) => m[1]));
const NON_VOCAB_TYPED = new Set(['style']); // mergeProps recursion slots, not applyProps vocab
const DEAD_VOCAB = new Set(['tracking', 'letterSpacing']); // no native field — recorded drops
check('typed keys ⊆ vocabulary',
	[...typedKeys].every((k) => vocab.has(k) || NON_VOCAB_TYPED.has(k)),
	`untyped-vocab: ${[...typedKeys].filter((k) => !vocab.has(k) && !NON_VOCAB_TYPED.has(k)).join(',')}`);
check('vocabulary ⊆ typed keys',
	[...vocab].every((k) => typedKeys.has(k) || DEAD_VOCAB.has(k)),
	`missing types: ${[...vocab].filter((k) => !typedKeys.has(k) && !DEAD_VOCAB.has(k)).join(',')}`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
