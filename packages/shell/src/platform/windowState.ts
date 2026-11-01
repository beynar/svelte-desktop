/**
 * Window-bounds persistence. Pure JS: reads/writes a JSON file under
 * `app.getPath('userData')` (from a page, through the app's server process:
 * app-files.ts) and applies origin + size through
 * `windows.setPosition`/`windows.setSize`.
 *
 * `flags` narrow which aspects are captured (save) or applied (restore);
 * the default is ALL. Snapshots record the flags they were saved with —
 * restore() falls back to them when the caller passes none, so a
 * partial snapshot never applies aspects it didn't capture.
 */
import { windows } from './index';
import { readAppFile, writeAppFile } from './app-files';
import type { WindowStateName } from './index';

export type WindowStateFlag = 'size' | 'position' | 'maximized' | 'visible' | 'fullscreen';

const ALL_FLAGS: WindowStateFlag[] = ['size', 'position', 'maximized', 'visible', 'fullscreen'];

export interface PersistedWindowState {
	bounds: { x: number; y: number; width: number; height: number };
	/** Window state at save time — captured when maximized|fullscreen flagged. */
	state?: WindowStateName;
	/** Visibility at save time — captured when 'visible' flagged. */
	visible?: boolean;
	/** Aspects this snapshot captured; restore() defaults to these. */
	flags?: WindowStateFlag[];
	savedAt: number;
}

const FILE_NAME = 'window-state.json';


export const windowState = {
	/** Snapshot the live window state to disk — `flags` picks which aspects. */
	async save(options: { flags?: WindowStateFlag[] } = {}): Promise<PersistedWindowState> {
		const flags = options.flags ?? ALL_FLAGS;
		const { bounds, state } = await windows.getBounds();
		const persisted: PersistedWindowState = { bounds, savedAt: Date.now(), flags };
		if (flags.includes('maximized') || flags.includes('fullscreen')) {
			persisted.state = state;
		}
		if (flags.includes('visible')) {
			// No isVisible pull op exists — minimized is the visible-proxy;
			// backends without isMinimized fall back to `true`.
			const min = await windows.isMinimized().catch(() => null);
			persisted.visible = min == null ? true : !(min as { minimized?: boolean }).minimized;
		}
		await writeAppFile('userData', FILE_NAME, JSON.stringify(persisted, null, 2));
		return persisted;
	},

	/** Read the persisted state without applying it. Null when absent/corrupt. */
	async load(): Promise<PersistedWindowState | null> {
		const text = await readAppFile('userData', FILE_NAME);
		if (text === null) return null;
		try {
			const state = JSON.parse(text) as PersistedWindowState;
			// All four fields — restore() applies x/y via setPosition and
			// undefined coordinates would surface as invalid_args mid-restore.
			const b = state?.bounds;
			if (
				typeof b?.x !== 'number' ||
				typeof b?.y !== 'number' ||
				typeof b?.width !== 'number' ||
				typeof b?.height !== 'number'
			) {
				return null;
			}
			return state;
		} catch {
			return null;
		}
	},

	/**
	 * Load the persisted state and apply it — `flags` picks which aspects
	 * (default: the snapshot's own flags, else all).
	 */
	async restore(options: { flags?: WindowStateFlag[] } = {}): Promise<PersistedWindowState | null> {
		const state = await windowState.load();
		if (!state) return null;
		const flags = options.flags ?? state.flags ?? ALL_FLAGS;
		if (flags.includes('position')) {
			await windows.setPosition(state.bounds.x, state.bounds.y);
		}
		if (flags.includes('size')) {
			await windows.setSize(state.bounds.width, state.bounds.height);
		}
		if (flags.includes('maximized') && state.state != null) {
			if (state.state === 'maximized') await windows.maximize();
			else await windows.unmaximize();
		}
		if (flags.includes('fullscreen') && state.state != null) {
			await windows.setFullscreen(state.state === 'fullscreen');
		}
		if (flags.includes('visible') && state.visible != null) {
			if (state.visible) await windows.show();
			else await windows.hide();
		}
		return state;
	},
};
