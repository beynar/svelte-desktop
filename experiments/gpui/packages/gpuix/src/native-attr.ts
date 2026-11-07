/**
 * HTML attribute → native prop mapping. gdom uses it when shipping attrs as
 * `setCustomProp` ops; the stylesheet compiler uses it so `[attr]` selectors
 * test the same prop names and coerced value shapes the element carries.
 */

export const NATIVE_ATTR: Record<string, string> = {
	tabindex: 'tabIndex', autofocus: 'autoFocus', readonly: 'readOnly', maxlength: 'maxLength',
	// svelai's `data-color` is the ctx cascade channel — it maps onto the
	// `color` custom prop that `color-*` token refs resolve through natively.
	'data-color': 'color',
	// `data-window-drag` marks an app-owned titlebar region — the renderer
	// performs the AppKit window drag from it (see app_owns_titlebar_drag).
	'data-window-drag': 'windowDrag',
};
export const nativeAttrName = (k: string) => NATIVE_ATTR[k.toLowerCase()] ?? k;
const ARIA_BOOL = /^aria-(checked|selected|hidden|expanded|disabled|pressed|modal|required|readonly|multiline|busy|invalid|grabbed|current|atomic|live)$/;
const ARIA_NUM = /^aria-(level|valuenow|valuemin|valuemax|setsize|posinset|colcount|rowcount|colindex|rowindex|colspan|rowspan|valuemaxchar)$/;
export const nativeAttrValue = (k: string, v: string): string | number | boolean => {
	const n = NATIVE_ATTR[k.toLowerCase()];
	if (n === 'autoFocus' || n === 'windowDrag') return v !== 'false';
	if (n === 'tabIndex' || n === 'maxLength') { const f = parseInt(v, 10); return Number.isFinite(f) ? f : v; }
	if (ARIA_BOOL.test(k)) return v === 'true' || v === '';
	if (ARIA_NUM.test(k)) { const f = parseFloat(v); return Number.isFinite(f) ? f : v; }
	return v;
};
