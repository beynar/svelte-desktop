// Shared item-spec plumbing for MenuBar/StatusItem: component items
// ({label, icon, onClick, subItems, checked, disabled, role} | 'separator')
// become wire MenuItemSpecs, and item callbacks register against a global
// id → fn table fed by the single `menuAction` subscription.
import { menu } from '../index.ts';

const callbacks = new Map();
let wired = false;
let nextId = 0;

function wire() {
	if (wired) return;
	wired = true;
	menu.onAction(({ id }) => callbacks.get(id)?.());
}

/** A string that looks like a file path: a separator, `~`, or an image
 *  extension. Anything else — 'add', 'note.text', 'star.fill' — is a native
 *  name: AppKit image (NATIVE_ICON_NAMES) or SF Symbol. */
const PATHISH = /[\/\\~]|\.(png|jpe?g|gif|tiff?|icns|pdf|svg|heic|webp|bmp)$/i;

/** icon shorthand: 'add' → {native:'add'} (NATIVE_ICON_NAMES); './x.png' →
 *  {path:'./x.png'}; {native}/{path} objects pass through. */
export function toIcon(icon) {
	if (icon == null) return undefined;
	if (typeof icon === 'string')
		return PATHISH.test(icon) ? { path: icon } : { native: icon };
	return icon;
}

/** Register one callback id (clickable bar items, StatusItem clicks). */
export function registerCallback(id, fn) {
	if (!id || !fn) return;
	wire();
	callbacks.set(id, fn);
}
export function releaseCallback(id) {
	if (id) callbacks.delete(id);
}

/** items → {specs, ids}. `ids` are the generated callback ids the caller
 *  must release on teardown/refresh. */
export function toMenuItems(items, prefix = 'mi') {
	const ids = [];
	const convert = (list) =>
		list.map((it) => {
			if (it === '-' || it === 'separator' || it?.separator === true)
				return { type: 'separator' };
			const spec = {};
			if (it.label != null) spec.label = it.label;
			const icon = toIcon(it.icon);
			if (icon) spec.icon = icon;
			if (it.checked != null) spec.checked = !!it.checked;
			if (it.disabled != null) spec.disabled = !!it.disabled;
			if (it.role) spec.role = it.role;
			const sub = it.subItems ?? it.submenu;
			if (sub?.length) {
				spec.type = 'submenu';
				spec.submenu = convert(sub);
			}
			if (it.onClick) {
				const id = it.id ?? `${prefix}:${nextId++}`;
				registerCallback(id, it.onClick);
				ids.push(id);
				spec.id = id;
			} else if (it.id) {
				spec.id = it.id;
			}
			return spec;
		});
	return { specs: convert(items), ids };
}

export function releaseItems(ids) {
	for (const id of ids) callbacks.delete(id);
}
