// Typed surface for the nkit props lane — the literal unions mirror the
// runtime tables in tokens.js and the vocabulary switch in style.js.
// probe-stylex.ts drift-checks every union against its table, so a new
// scale name or vocab key without a type entry fails the probe.

// ── value types ────────────────────────────────────────────────────────

export type SpacingToken =
	| '0' | 'micro' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'
	| 'layout-sm' | 'layout-md' | 'layout-lg' | 'layout-xl';
/** number = raw px; string numerics follow the ×--spacing convention. */
export type Spacing = SpacingToken | number | `${number}` | 'px';

export type ControlSize = 'sm' | 'md' | 'lg';
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type GeometryName =
	| `control-${ControlSize}` | `row-${IconSize}` | `icon-${IconSize}`
	| `hit-${IconSize}` | `indent-${IconSize}`;

export type Dimension =
	| number | `${number}` | `${number}%` | `${number}px`
	| 'auto' | 'fit' | 'full' | SpacingToken | GeometryName;
export type Inset = Spacing | `indent-${IconSize}`;
export type Basis = Dimension | `${number}/${number}`;

export type PaletteName =
	| 'primary' | 'secondary' | 'danger' | 'success' | 'warning' | 'info'
	| 'neutral' | 'surface';
export type PaletteRole =
	| 'dark' | 'light' | 'lighter' | 'muted' | 'contrast' | 'readable'
	| 'muted-readable' | 'recessed' | 'canvas' | 'raised' | 'floating';
/**
 * `primary`, `primary-muted`, ctx `color-*`, literals (#hex, rgb(), var()),
 * alpha suffixes (`primary/50`). The palette is runtime-extensible
 * (`registerPalette`), so unknown bare names stay assignable — the
 * definition sweep flags ones that resolve under no palette.
 */
export type ColorRef =
	| PaletteName | `${PaletteName}-${PaletteRole}` | `color-${PaletteRole}`
	| `#${string}` | `${string}(${string})` | `${string}/${number}`
	| (string & {});

export type Radius = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | 'full' | number;
export type FontSize =
	| 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl'
	| '6xl' | '7xl' | '8xl' | '9xl' | number;
export type FontWeight = 'normal' | 'medium' | 'semibold' | 'bold' | number | `${number}`;
export type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline' | 'flex-start' | 'flex-end';
export type Justify =
	| 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly'
	| 'flex-start' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
export type FlexDirection =
	| 'row' | 'col' | 'column' | 'row-reverse' | 'col-reverse' | 'column-reverse';
export type FlexWrap = 'wrap' | 'nowrap';
export type Overflow = 'auto' | 'hidden' | 'scroll' | 'visible' | 'clip';
export type Position = 'relative' | 'absolute' | 'fixed' | 'sticky';
export type Display = 'flex' | 'grid' | 'block' | 'inline' | 'inline-flex' | 'inline-block' | 'none' | 'contents' | (string & {});
export type Cursor =
	| 'pointer' | 'default' | 'not-allowed' | 'text' | 'grab' | 'grabbing'
	| 'move' | 'col-resize' | 'row-resize' | 'ew-resize' | 'ns-resize'
	| (string & {});
export type RaisedLevel = true | '' | 'DEFAULT' | 'none' | '0' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '1' | '2' | '3' | '4' | '5' | number;
export type Shadow = 'xs' | 'sm' | 'md' | 'lg' | ShadowMember | ShadowMember[];
export interface ShadowMember {
	offsetX: number; offsetY: number; blurRadius: number; spreadRadius: number;
	color: ColorRef; inset?: boolean; ring?: boolean;
}
export type TextDecoration = true | 'underline' | 'line-through' | 'none';
export type UserSelect = 'none' | 'text' | 'all' | 'auto' | true;

// ── StyleProps — the closed vocabulary ─────────────────────────────────

export interface StyleProps {
	// layout
	display?: Display | null;
	flex?: boolean | 'row' | null;
	grid?: boolean | null;
	direction?: FlexDirection | null;
	flexDirection?: FlexDirection | null;
	row?: boolean | null;
	col?: boolean | null;
	column?: boolean | null;
	wrap?: FlexWrap | null;
	flexWrap?: FlexWrap | null;
	grow?: number | true | null;
	flexGrow?: number | true | null;
	flex1?: boolean | null;
	shrink?: number | true | null;
	flexShrink?: number | true | null;
	basis?: Basis | null;
	flexBasis?: Basis | null;
	items?: Align | null;
	alignItems?: Align | null;
	self?: Align | null;
	alignSelf?: Align | null;
	justify?: Justify | null;
	justifyContent?: Justify | null;
	content?: Justify | null;
	alignContent?: Justify | null;
	gap?: Spacing | null;
	rowGap?: Spacing | null;
	columnGap?: Spacing | null;
	gridCols?: number | null;
	gridTemplateColumns?: number | null;
	gridRows?: number | null;
	gridTemplateRows?: number | null;

	// spacing — shorthands expand to longhands in authored order
	p?: Spacing | null;
	padding?: Spacing | null;
	px?: Spacing | null;
	py?: Spacing | null;
	pt?: Spacing | null;
	pr?: Spacing | null;
	pb?: Spacing | null;
	pl?: Spacing | null;
	ps?: Spacing | null;
	pe?: Spacing | null;
	m?: Spacing | null;
	margin?: Spacing | null;
	mx?: Spacing | null;
	my?: Spacing | null;
	mt?: Spacing | null;
	mr?: Spacing | null;
	mb?: Spacing | null;
	ml?: Spacing | null;
	ms?: Spacing | null;
	me?: Spacing | null;

	// sizing
	control?: ControlSize | number | null;
	icon?: IconSize | number | null;
	w?: Dimension | null;
	width?: Dimension | null;
	h?: Dimension | null;
	height?: Dimension | null;
	minW?: Dimension | null;
	minWidth?: Dimension | null;
	minH?: Dimension | null;
	minHeight?: Dimension | null;
	maxW?: Dimension | null;
	maxWidth?: Dimension | null;
	maxH?: Dimension | null;
	maxHeight?: Dimension | null;
	aspect?: number | `${number}/${number}` | null;
	aspectRatio?: number | `${number}/${number}` | null;

	// box
	bg?: ColorRef | null;
	backgroundColor?: ColorRef | null;
	background?: ColorRef | Gradient | null;
	fg?: ColorRef | null;
	color?: ColorRef | null;
	border?: ColorRef | true | 1 | null;
	borderColor?: ColorRef | null;
	borderW?: number | true | null;
	borderWidth?: number | true | null;
	borderT?: number | true | null;
	borderR?: number | true | null;
	borderB?: number | true | null;
	borderL?: number | true | null;
	radius?: Radius | null;
	borderRadius?: Radius | null;
	radiusTl?: Radius | null;
	borderTopLeftRadius?: Radius | null;
	radiusTr?: Radius | null;
	borderTopRightRadius?: Radius | null;
	radiusBl?: Radius | null;
	borderBottomLeftRadius?: Radius | null;
	radiusBr?: Radius | null;
	borderBottomRightRadius?: Radius | null;
	radiusT?: Radius | null;
	radiusB?: Radius | null;
	radiusL?: Radius | null;
	radiusR?: Radius | null;
	ring?: number | true | null;
	ringColor?: ColorRef | null;
	ringInset?: boolean | null;
	shadow?: Shadow | null;
	boxShadow?: Shadow | null;
	opacity?: number | null;
	overflow?: Overflow | null;
	overflowX?: Overflow | null;
	overflowY?: Overflow | null;
	visibility?: 'visible' | 'hidden' | (string & {}) | null;

	// text
	text?: FontSize | null;
	fontSize?: FontSize | null;
	fontW?: FontWeight | null;
	fontWeight?: FontWeight | null;
	font?: string | null;
	fontFamily?: string | null;
	align?: 'left' | 'center' | 'right' | 'justify' | 'start' | 'end' | null;
	textAlign?: 'left' | 'center' | 'right' | 'justify' | 'start' | 'end' | null;
	lineHeight?: number | string | null;
	/** CSS letter-spacing in px — negative allowed (`tracking-tight`). */
	tracking?: number | null;
	letterSpacing?: number | null;
	/** Unitless line-height multiplier (Tailwind `leading-tight` → 1.25). */
	leading?: number | null;
	lineHeightScale?: number | null;
	/** OpenType feature map — `{ tnum: 1, liga: false }`. */
	fontFeatures?: Record<string, boolean | number> | null;
	/** String transform before shaping — cascades like the CSS property. */
	textTransform?: 'uppercase' | 'lowercase' | 'capitalize' | 'none' | null;
	case?: 'uppercase' | 'lowercase' | 'capitalize' | 'none' | null;
	whitespace?: 'nowrap' | 'pre' | 'pre-wrap' | 'normal' | (string & {}) | null;
	whiteSpace?: 'nowrap' | 'pre' | 'pre-wrap' | 'normal' | (string & {}) | null;
	ellipsis?: boolean | null;
	truncate?: boolean | null;
	lineClamp?: number | null;
	underline?: TextDecoration | null;
	textDecoration?: TextDecoration | null;
	lineThrough?: boolean | null;
	decoration?: ColorRef | null;
	textDecorationColor?: ColorRef | null;
	italic?: boolean | 'italic' | 'normal' | null;
	fontStyle?: 'italic' | 'normal' | null;

	// position
	absolute?: boolean | null;
	fixed?: boolean | null;
	position?: Position | null;
	top?: Inset | null;
	right?: Inset | null;
	bottom?: Inset | null;
	left?: Inset | null;
	inset?: Inset | null;

	// behavior
	cursor?: Cursor | null;
	select?: UserSelect | null;
	userSelect?: UserSelect | null;
	pointerEvents?: 'none' | 'auto' | (string & {}) | null;
	selectionColor?: ColorRef | null;

	// interaction — `raised`/`lift` resolve through the native elevation
	// engine; `stateLayer` bakes the currentColor overlay natively.
	stateLayer?: boolean | null;
	raised?: RaisedLevel | null;
	lift?: RaisedLevel | null;

	// pseudo buckets — native refinement channels, merge key-wise
	hover?: StyleProps | null;
	active?: StyleProps | null;
	focus?: StyleProps | null;
	focusWithin?: StyleProps | null;
	focusVisible?: StyleProps | null;

	/** recipe `style` escape / nested slot — merges like a bucket. */
	style?: StyleProps | null;
}

export interface Gradient {
	stops: Array<{ color: ColorRef; position?: number | string }>;
	[k: string]: unknown;
}

// ── envelope + resolved desc ───────────────────────────────────────────

/** The native style envelope `style()`/`recipe()` return — an opaque payload of
 *  raw fragments + recipe binding that gdom ships to Rust (`setStyleProps`/
 *  `setRecipe`). Treat as opaque; `mergeStyleDesc`/`mergeProps` compose it. */
export interface NativeStyle {
	/** `{@attach}` lane — the envelope is itself an attachment: it applies
	 *  through the element's `styleProps` prop and clears on teardown. */
	(element: Element): () => void;
	readonly __native: true;
	readonly __frags: ReadonlyArray<StyleProps>;
	readonly __recipe: { name: string; variants: Record<string, unknown>; extra: StyleProps | null } | null;
	readonly __ctx: ColorRef | null;
	/** Spreadable view — `<div {...card.style}>` emits `styleProps: this`;
	 *  the gdom prop routes it into the same lane `use:applyStyle` drives. */
	readonly style: { readonly styleProps: NativeStyle };
}

/** The symbolic resolved field map (JS mirror output / `setStyle` lane).
 *  Values stay token-symbolic — the native resolver owns scale/palette. */
export type StyleDesc = Record<string, unknown>;

export type StyleInput = StyleProps | NativeStyle | StyleDesc | null | undefined | false;

// ── api ────────────────────────────────────────────────────────────────

export function style(props?: StyleProps | ReadonlyArray<StyleProps | null | false> | NativeStyle | null, ctx?: { color?: ColorRef }): NativeStyle;
/** `s` — kept as the shorthand alias; `style` is the canonical name. */
export declare const s: typeof style;
/** JS mirror of the native mapping — validation/probes/drift only. The
 *  production path resolves in Rust; this must stay field-identical to
 *  `style_props::resolve_style_props`. */
export function resolveStyleProps(props?: StyleProps | ReadonlyArray<StyleProps | null | false> | null, ctx?: { color?: ColorRef; strict?: boolean }): StyleDesc;
export function isNativeStyle(v: unknown): v is NativeStyle;

export function mergeStyleDesc(a: NativeStyle | null | undefined, b: StyleDesc | NativeStyle | null | undefined): NativeStyle;
export function mergeStyleDesc(a: StyleDesc | null | undefined, b: NativeStyle | null | undefined): NativeStyle;
export function mergeStyleDesc(a?: StyleDesc | null, b?: StyleDesc | null): StyleDesc;

export function mergeProps<T extends StyleProps>(into: T, src: StyleProps | null | undefined | false): T;

export function checkStyleProps(props: StyleProps | null | undefined): string[];
export function defineStyles<M extends Record<string, StyleProps>>(map: M, label?: string): Readonly<M>;
export function deepFreeze<T>(v: T): Readonly<T>;

export interface DefinitionIssue {
	label: string;
	key: string;
	lane: 'props' | 'class';
}
export const droppedProps: ReadonlySet<string>;
export const definitionIssues: ReadonlyArray<DefinitionIssue>;
export function reportIssues(label: string, keys: string[], opts?: { lane?: 'props' | 'class'; loud?: boolean }): void;
export function registerStyleDef(label: string, props: StyleProps | null | undefined): string[];
export function validateDefinitions(): void;
