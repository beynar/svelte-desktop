/**
 * svelte-desktop/stores — the public, reactive platform API.
 *
 * One import gives app code every namespace:
 *
 *   import { app, theme, window, secureStorage } from 'svelte-desktop/stores';
 *   await initStores();
 *   {theme.dark ? 'dark' : 'light'}    // reactive — OS flips update live
 *   {app.info?.version}
 *   secureStorage.setPassword(…)       // action namespaces stay functional
 *
 * Normalization rule: every nullary value-getter is a $state field on its
 * namespace object; parameterized queries and side-effecting actions are
 * methods on the same object. secureStorage is the exception — it carries
 * methods only, secrets never enter reactive memory.
 *
 * Event-fed fields update without app code: appearanceChanged → theme,
 * keyboardLayoutChanged → system, thermalStateChanged/systemWake → power,
 * openUrls → deepLink, menuAction → menu, notificationResponse →
 * notifications, reopened/willQuit/willRestart/appActivated/appDeactivated
 * → app, focusChanged/scaleFactorChanged → window, trayClick → tray.
 *
 * Compiled by build.ts (compileModule) → src/gen/native-api/stores.js; its
 * `./x` specifiers are rewritten back into src/native-api/ so all stores
 * share THE bus backend initialized by initPlatform().
 */
import {
	app as appSvc, windows as windowSvc, screen as screenSvc,
	clipboard as clipboardSvc, theme as themeSvc, system as systemSvc,
	power as powerSvc, deepLink as deepLinkSvc, menu as menuSvc,
	notifications as notificationsSvc, push as pushSvc, onNotification, capture as captureSvc,
	diagnostics as diagnosticsSvc, capabilities as capabilitiesSvc,
	updater as updaterSvc, tray as traySvc, shortcuts as shortcutsSvc,
	emitTo as emitToWindow,
	broadcast, onBroadcast,
	permissions as permissionsSvc, type PermissionName, type PermissionStatus,
	ShortcutRegistration, SleepBlocker, TrayHandle,
} from './index';
import { windowState as windowStateSvc } from './windowState';
import { store as storeSvc } from './store';
import { onPlatform, oncePlatform, onPlatformReady, NativeApiError } from './bus';
import type {
	AccessibilityInfo, AccentColor, AppearancePreference, AvailableUpdate,
	BatteryInfo, CaptureSource, UpdateEndpoints, DockProgress,
	AppInfo, CapabilitiesReport, DiagnosticsInfo, DisplayInfo, SystemInfo,
	ThermalState, ThemeInfo, TrayOptions, TrayClickRect, WindowBounds,
	WindowControlsArea, WindowStateName, WindowPositionPreset, TitleBarStyle, WindowTheme,
} from './index';
import type { PersistedWindowState, WindowStateFlag } from './windowState';
import type {
	NotificationEvent, NotificationEventMap, NotificationPermission, PushMessage, PushTarget,
} from './notifications';

// Bus + init helpers pass through — stores module is the whole surface.
export {
	initPlatform, initPlatformForTests, onPlatform, oncePlatform, onAnyPlatform,
	onPlatformReady, platformReady, platformReady as isNative,
	NativeApiError, Channel, PlatformTransport, mockPlatform,
} from './bus';
export type { PlatformErrorCode, PlatformInitOptions } from './bus';
export type {
	AccessibilityInfo, AccentColor, ActivationPolicy, AppInfo, AppPathName,
	AppearanceName, AppearancePreference, AvailableUpdate, BatteryInfo,
	BundleType, CaptureSource, CaptureSourceType, CapabilitiesReport,
	DiagnosticsInfo, DialogFilter, DisplayInfo,
	DockBounceType, MenuItemSpec, MenuItemState, MenuItemInfo, MenuItemUpdate,
	MenuItemRole, MenuItemIcon,
	MenuSpec, NotificationAction, NotificationEvent, NotificationEventMap, NotificationPermission, PushTarget, PushMessage,
	OpenDialogOptions, SaveDialogOptions,
	MessageBoxOptions, PermissionName, PermissionStatus, SettingsPane,
	SleepBlockType, SystemInfo, ThermalState, ThemeInfo, TitleBarStyle,
	TrayOptions, TrayClickRect, UpdateEndpoints, ControlsRect, WindowControlsArea,
	WindowBounds, WindowStateName, WindowPositionPreset, WindowTheme,
	DockProgress, DockProgressStatus, AboutPanelOptions,
	CapturedImage, Position, Size,
} from './index';
export { LogicalPosition, PhysicalPosition, LogicalSize, PhysicalSize } from './index';
export {
	ShortcutRegistration, SleepBlocker, TrayHandle,
} from './index';
export type { PersistedWindowState, WindowStateFlag } from './windowState';
// Action-only namespaces re-exported verbatim — same import path, no $state.
export { shell, dialog, secureStorage } from './index';

abstract class PlatformNamespace {
	ready = $state(false);
	/** init failure captured here — a failed namespace never poisons initStores. */
	error = $state<Error | null>(null);
	abstract init(): unknown;
}

/** `{}` payloads — the platform emits an empty object for these events. */
type EmptyPayload = Record<string, never>;

interface AppEvents {
	reopened: EmptyPayload;
	willQuit: EmptyPayload;
	willRestart: EmptyPayload;
	secondInstance: { argv: string[]; cwd: string };
	appActivated: EmptyPayload;
	appDeactivated: EmptyPayload;
}
interface WindowEvents {
	boundsChanged: WindowBounds;
	willClose: EmptyPayload;
	focusChanged: { focused: boolean };
	scaleFactorChanged: { scaleFactor: number };
}
interface ScreenEvents {
	displaysChanged: EmptyPayload;
}
interface ThemeEvents {
	appearanceChanged: ThemeInfo;
}
interface SystemEvents {
	keyboardLayoutChanged: EmptyPayload;
}
interface PowerEvents {
	thermalStateChanged: EmptyPayload;
	systemWake: EmptyPayload;
	systemSleep: EmptyPayload;
	screenLocked: EmptyPayload;
	screenUnlocked: EmptyPayload;
}
interface DeepLinkEvents {
	openUrls: { urls: string[] };
}
interface MenuEvents {
	menuAction: { id: string };
}
interface NotificationsEvents extends NotificationEventMap {
	/** Raw native event (every context, no targeting). Prefer click/action/reply/dismiss. */
	notificationResponse: { tag: string; id: string; actionId: string | null; kind: string };
}
interface TrayEvents {
	trayClick: TrayClickRect;
}
interface ShortcutEvents {
	shortcutPressed: { id: string };
}

// ── app ─────────────────────────────────────────────────────────────

class AppNamespace extends PlatformNamespace {
	info = $state<AppInfo | null>(null);
	reopenCount = $state(0);
	lastReopenedAt = $state<number | null>(null);
	quitting = $state(false);
	restarting = $state(false);
	/** Echo of the last setDockBadge() arg. */
	dockBadge = $state<string | null>(null);
	secondInstanceCount = $state(0);
	/** argv/cwd of the most recent second-instance launch attempt. */
	lastSecondInstance = $state<{ argv: string[]; cwd: string } | null>(null);
	/**
	 * Whether the app has OS focus. Initialized true — no app.isActive pull
	 * op exists; appActivated/appDeactivated keep it correct thereafter.
	 */
	active = $state(true);

	get name() { return this.info?.name ?? null; }
	get version() { return this.info?.version ?? null; }
	get packaged() { return this.info?.packaged ?? null; }
	get platform() { return this.info?.platform ?? null; }

	async init(): Promise<this> {
		this.info = await appSvc.getInfo();
		await appSvc.whenReady();
		this.ready = true;
		this.#events ??= [
			onPlatform('reopened', () => {
				this.reopenCount++;
				this.lastReopenedAt = Date.now();
			}),
			onPlatform('willQuit', () => { this.quitting = true; }),
			onPlatform('willRestart', () => { this.restarting = true; }),
			onPlatform<{ argv: string[]; cwd: string }>('secondInstance', (data) => {
				this.secondInstanceCount++;
				this.lastSecondInstance = data;
			}),
			onPlatform('appActivated', () => { this.active = true; }),
			onPlatform('appDeactivated', () => { this.active = false; }),
		];
		return this;
	}

	// actions
	getPath = appSvc.getPath;
	setName = appSvc.setName;
	setIdentity = appSvc.setIdentity;
	quit = appSvc.quit;
	relaunch = appSvc.relaunch;
	exit = appSvc.exit;
	hide = appSvc.hide;
	show = appSvc.show;
	hideOthers = appSvc.hideOthers;
	showAll = appSvc.showAll;
	addRecentDocument = appSvc.addRecentDocument;
	async setDockBadge(text: string | null) {
		await appSvc.setDockBadge(text);
		this.dockBadge = text;
	}
	bounceDock = appSvc.bounceDock;
	setLoginItem = appSvc.setLoginItem;
	setActivationPolicy = appSvc.setActivationPolicy;
	requestSingleInstanceLock = appSvc.requestSingleInstanceLock;
	setDockProgress = appSvc.setDockProgress;
	getBundleType = appSvc.getBundleType;
	defaultWindowIcon = appSvc.defaultWindowIcon;
	aboutPanel = appSvc.aboutPanel;

	/** Typed subscription to this namespace's platform events. */
	on<E extends keyof AppEvents & string>(
		event: E,
		cb: (data: AppEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof AppEvents & string>(
		event: E,
		cb: (data: AppEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}

	#events: (() => void)[] | null = null;
	dispose() { this.#events?.forEach((off) => off()); this.#events = null; }
}
export const app = new AppNamespace();

// ── window ──────────────────────────────────────────────────────────

class WindowNamespace extends PlatformNamespace {
	live = $state<{ bounds: WindowBounds; state: WindowStateName } | null>(null);
	title = $state('');
	focused = $state(false);
	maximized = $state(false);
	fullscreen = $state(false);
	/** Non-Spaces fullscreen — distinct from `fullscreen` (native Spaces). */
	simpleFullscreen = $state(false);
	scaleFactor = $state(1);
	/** Window-relative cursor — pull-only, updated by refresh(). */
	cursor = $state<{ x: number; y: number } | null>(null);
	/** OS window-controls cluster (traffic lights) in content coordinates —
	 *  `null` on borderless windows. Re-pulled by refresh()/boundsChanged so
	 *  fullscreen + titlebar-style transitions stay current. */
	controlsArea = $state<WindowControlsArea | null>(null);

	get bounds() { return this.live?.bounds ?? null; }
	get size() { return this.live ? { width: this.live.bounds.width, height: this.live.bounds.height } : null; }
	get position() {
		return this.live ? { x: this.live.bounds.x, y: this.live.bounds.y } : null;
	}
	get state() { return this.live?.state ?? 'normal'; }

	async init(): Promise<this> {
		await this.refresh();
		this.ready = true;
		// Event-driven live bounds — the OS streams move/resize here.
		this.#events ??= [
			onPlatform<WindowBounds>('boundsChanged', (bounds) => {
				this.live = { bounds, state: this.live?.state ?? 'normal' };
				// OS-chrome zoom/maximize also moves bounds — re-pull so
				// state/maximized/fullscreen don't go stale.
				this.#syncLater();
			}),
			onPlatform<{ focused: boolean }>('focusChanged', ({ focused }) => {
				this.focused = focused;
			}),
			onPlatform<{ scaleFactor: number }>('scaleFactorChanged', ({ scaleFactor }) => {
				this.scaleFactor = scaleFactor;
			}),
		];
		return this;
	}

	/** Re-pull every live field (bounds also stream in via boundsChanged). */
	async refresh(): Promise<this> {
		const [live, title, focused, maximized, fullscreen, simpleFullscreen, scaleFactor, cursor, controlsArea] =
			await Promise.all([
				windowSvc.getBounds().catch(() => null),
				windowSvc.getTitle().catch(() => this.title),
				windowSvc.isFocused().catch(() => this.focused),
				windowSvc.isMaximized().catch(() => this.maximized),
				windowSvc.isFullscreen().catch(() => this.fullscreen),
				windowSvc
					.isSimpleFullscreen()
					.then((r) => r.simpleFullscreen)
					.catch(() => this.simpleFullscreen),
				windowSvc.getScaleFactor().catch(() => this.scaleFactor),
				windowSvc.getCursorPoint().catch(() => null),
				windowSvc.getControlsArea().catch(() => null),
			]);
		this.live = live;
		this.title = title;
		this.focused = focused;
		this.maximized = maximized;
		this.fullscreen = fullscreen;
		this.simpleFullscreen = simpleFullscreen;
		this.scaleFactor = scaleFactor;
		this.cursor = cursor;
		this.controlsArea = controlsArea;
		return this;
	}

	/** Trailing re-pull — native geometry settles a frame after a resize. */
	#syncLater = () => setTimeout(() => void this.refresh().catch(() => {}), 150);

	async setTitle(title: string) { await windowSvc.setTitle(title); this.title = title; }
	// No optimistic bounds write — setSize sets CONTENT size while live.bounds
	// is the FRAME rect (off by the titlebar); #syncLater pulls the truth.
	async setSize(width: number, height: number) {
		await windowSvc.setSize(width, height);
		this.#syncLater();
	}
	async setPosition(x: number, y: number) {
		await windowSvc.setPosition(x, y);
		if (this.live) this.live = { bounds: { ...this.live.bounds, x, y }, state: this.live.state };
		this.#syncLater();
	}
	async setFullscreen(fullscreen: boolean) { await windowSvc.setFullscreen(fullscreen); this.fullscreen = fullscreen; this.#syncLater(); }
	async toggleFullscreen() {
		const { fullscreen } = await windowSvc.toggleFullscreen();
		this.fullscreen = fullscreen;
		this.#syncLater();
	}
	async minimize() { await windowSvc.minimize(); }
	// No optimistic `focused` write — the OS can refuse focus; focusChanged
	// is the source of truth.
	async focus() { await windowSvc.focus(); }
	/**
	 * Arm/disarm the close veto. While armed, OS-initiated closes are
	 * suppressed and `willClose` fires instead — disarm then `close()` to
	 * actually close.
	 */
	async setCloseVeto(enabled: boolean) {
		const { armed } = await windowSvc.setCloseVeto(enabled);
		return armed;
	}
	/**
	 * Arm the close veto and subscribe to willClose in one call — the
	 * "unsaved changes" flow. While armed, EVERY OS-initiated close (red
	 * button, ⌘W) fires `handler` instead of closing; only `window.close()`
	 * proceeds. The returned async function disarms: unsubscribes the
	 * handler and drops the veto.
	 *
	 * One handler at a time: the veto is a single native flag — a second
	 * call replaces the handler, and invoking the first disarm drops the
	 * veto under the surviving handler.
	 */
	async onCloseRequested(handler: () => void): Promise<() => Promise<void>> {
		// Invariant: veto armed ⇒ handler attached. Subscribe before arming
		// (a close between arm and subscribe would be swallowed), and disarm
		// before unsubscribing (a close in flight during the off()→disarm
		// window would hit no handler).
		const off = this.on('willClose', handler);
		try {
			await windowSvc.setCloseVeto(true);
		} catch (e) {
			off();
			throw e;
		}
		return async () => {
			await windowSvc.setCloseVeto(false);
			off();
		};
	}
	requestAttention = windowSvc.requestAttention;
	setRepresentedFilename = windowSvc.setRepresentedFilename;
	async close() {
		await windowSvc.close();
		// The window is gone — live state is stale from here on.
		this.live = null;
	}
	showCharacterPalette = windowSvc.showCharacterPalette;

	// ── geometry + visibility ───────────────────────────────────────
	async center() { await windowSvc.center(); this.#syncLater(); }
	hide = windowSvc.hide;
	show = windowSvc.show;
	async setBounds(x: number, y: number, width: number, height: number) {
		await windowSvc.setBounds(x, y, width, height);
		if (this.live) this.live = { bounds: { x, y, width, height }, state: this.live.state };
		this.#syncLater();
	}
	async positionTo(preset: WindowPositionPreset) {
		await windowSvc.positionTo(preset);
		this.#syncLater();
	}
	unminimize = windowSvc.unminimize;
	isMinimized = windowSvc.isMinimized;
	async restore() { await windowSvc.restore(); this.#syncLater(); }

	// ── fullscreen + z-order ────────────────────────────────────────
	async toggleMaximize() {
		const { maximized } = await windowSvc.toggleMaximize();
		this.maximized = maximized;
		this.#syncLater();
	}
	async maximize() {
		const { maximized } = await windowSvc.maximize();
		this.maximized = maximized;
		this.#syncLater();
	}
	async unmaximize() {
		const { maximized } = await windowSvc.unmaximize();
		this.maximized = maximized;
		this.#syncLater();
	}
	isMaximized = windowSvc.isMaximized;
	isFullscreen = windowSvc.isFullscreen;
	isFocused = windowSvc.isFocused;
	async setSimpleFullscreen(enabled: boolean) {
		await windowSvc.setSimpleFullscreen(enabled);
		this.simpleFullscreen = enabled;
		this.#syncLater();
	}
	isSimpleFullscreen = windowSvc.isSimpleFullscreen;
	setAlwaysOnTop = windowSvc.setAlwaysOnTop;
	setAlwaysOnBottom = windowSvc.setAlwaysOnBottom;
	blur = windowSvc.blur;
	isHovered = windowSvc.isHovered;
	isActive = windowSvc.isActive;

	// ── chrome toggles ──────────────────────────────────────────────
	setResizable = windowSvc.setResizable;
	isResizable = windowSvc.isResizable;
	setClosable = windowSvc.setClosable;
	isClosable = windowSvc.isClosable;
	setMinimizable = windowSvc.setMinimizable;
	isMinimizable = windowSvc.isMinimizable;
	setMaximizable = windowSvc.setMaximizable;
	isMaximizable = windowSvc.isMaximizable;
	setTitleBarStyle = windowSvc.setTitleBarStyle;
	setDecorations = windowSvc.setDecorations;
	setHasShadow = windowSvc.setHasShadow;
	invalidateShadow = windowSvc.invalidateShadow;

	// ── appearance + behavior ───────────────────────────────────────
	setOpacity = windowSvc.setOpacity;
	getOpacity = windowSvc.getOpacity;
	setMovable = windowSvc.setMovable;
	setMovableByWindowBackground = windowSvc.setMovableByWindowBackground;
	setIgnoresMouseEvents = windowSvc.setIgnoresMouseEvents;
	ignoresMouseEvents = windowSvc.ignoresMouseEvents;
	setContentProtected = windowSvc.setContentProtected;
	isContentProtected = windowSvc.isContentProtected;
	setVisibleOnAllWorkspaces = windowSvc.setVisibleOnAllWorkspaces;
	setDocumentEdited = windowSvc.setDocumentEdited;
	isDocumentEdited = windowSvc.isDocumentEdited;
	setEdited = windowSvc.setEdited;
	setFocusable = windowSvc.setFocusable;
	setCursorHidden = windowSvc.setCursorHidden;
	setCursorPosition = windowSvc.setCursorPosition;
	setTheme = windowSvc.setTheme;

	// ── size + position queries ─────────────────────────────────────
	innerSize = windowSvc.innerSize;
	innerPosition = windowSvc.innerPosition;
	outerSize = windowSvc.outerSize;
	outerPosition = windowSvc.outerPosition;
	setMinSize = windowSvc.setMinSize;
	setMaxSize = windowSvc.setMaxSize;

	/** Typed subscription to this namespace's platform events. */
	on<E extends keyof WindowEvents & string>(
		event: E,
		cb: (data: WindowEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof WindowEvents & string>(
		event: E,
		cb: (data: WindowEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}

	#events: (() => void)[] | null = null;
	dispose() { this.#events?.forEach((off) => off()); this.#events = null; }
}
export const window = new WindowNamespace();

// ── windowState (persistence — the JSON value) ──────────────────────

class WindowStateNamespace extends PlatformNamespace {
	/** The persisted JSON — what save() wrote / load() read. */
	persisted = $state<PersistedWindowState | null>(null);
	saving = $state(false);

	async init(): Promise<this> {
		this.persisted = await windowStateSvc.load();
		this.ready = true;
		return this;
	}
	load = windowStateSvc.load;
	/** `flags` picks which aspects to capture (default: all). */
	async save(options?: { flags?: WindowStateFlag[] }) {
		this.saving = true;
		try {
			this.persisted = await windowStateSvc.save(options);
			return this.persisted;
		} finally {
			this.saving = false;
		}
	}
	/** `flags` picks which aspects to apply (default: the snapshot's own, else all). */
	async restore(options?: { flags?: WindowStateFlag[] }) {
		const state = await windowStateSvc.restore(options);
		if (state) this.persisted = state;
		return state;
	}
}
export const windowState = new WindowStateNamespace();

// ── screen ──────────────────────────────────────────────────────────

class ScreenNamespace extends PlatformNamespace {
	displays = $state<DisplayInfo[]>([]);
	primary = $state<DisplayInfo | null>(null);
	nearestWindow = $state<DisplayInfo | null>(null);
	scaleFactor = $state(1);
	/** Global cursor — pull-only. */
	cursorPoint = $state<{ x: number; y: number } | null>(null);

	get displayCount() { return this.displays.length; }

	async init(): Promise<this> {
		await this.refresh();
		this.ready = true;
		// Event-driven like theme — the OS reports attach/detach/reconfigure.
		this.#unsub ??= onPlatform('displaysChanged', () => void this.refresh().catch(() => {}));
		return this;
	}
	async refresh(): Promise<this> {
		const [displays, primary, nearestWindow, scaleFactor, cursorPoint] = await Promise.all([
			screenSvc.getAllDisplays(), screenSvc.getPrimaryDisplay(),
			screenSvc.getDisplayNearestWindow().catch(() => null), screenSvc.scaleFactor(),
			screenSvc.getCursorScreenPoint().catch(() => null),
		]);
		this.displays = displays;
		this.primary = primary;
		this.nearestWindow = nearestWindow;
		this.scaleFactor = scaleFactor;
		this.cursorPoint = cursorPoint;
		return this;
	}
	/** Reads the global cursor and mirrors it into `cursorPoint`. */
	async getCursorScreenPoint() {
		this.cursorPoint = await screenSvc.getCursorScreenPoint();
		return this.cursorPoint;
	}

	on<E extends keyof ScreenEvents & string>(
		event: E,
		cb: (data: ScreenEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof ScreenEvents & string>(
		event: E,
		cb: (data: ScreenEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}

	#unsub: (() => void) | null = null;
	dispose() { this.#unsub?.(); this.#unsub = null; }
}
export const screen = new ScreenNamespace();

// ── clipboard ───────────────────────────────────────────────────────
// No OS change-event exists; text/formats mirror the last read and stay
// coherent through the namespace's own write/clear calls.

class ClipboardNamespace extends PlatformNamespace {
	text = $state<string | null>(null);
	html = $state<string | null>(null);
	rtf = $state<string | null>(null);
	formats = $state<string[]>([]);

	get hasText() { return this.formats.includes('text/plain'); }

	async init(): Promise<this> {
		await this.refresh();
		this.ready = true;
		return this;
	}
	async refresh(): Promise<this> {
		const [text, formats, html, rtf] = await Promise.all([
			clipboardSvc.readText(), clipboardSvc.availableFormats(),
			clipboardSvc.readHtml().catch(() => null), clipboardSvc.readRtf().catch(() => null),
		]);
		this.text = text;
		this.formats = formats;
		this.html = html;
		this.rtf = rtf;
		return this;
	}
	async writeText(text: string) {
		await clipboardSvc.writeText(text);
		this.text = text;
		this.formats = ['text/plain'];
	}
	async writeHtml(html: string) {
		await clipboardSvc.writeHtml(html);
		this.html = html;
	}
	async writeRtf(rtf: string) {
		await clipboardSvc.writeRtf(rtf);
		this.rtf = rtf;
	}
	/** Re-read HTML markup and mirror it into `html`. */
	async readHtml() {
		this.html = await clipboardSvc.readHtml();
		return this.html;
	}
	/** Re-read RTF markup and mirror it into `rtf`. */
	async readRtf() {
		this.rtf = await clipboardSvc.readRtf();
		return this.rtf;
	}
	async clear() {
		await clipboardSvc.clear();
		this.text = null;
		this.html = null;
		this.rtf = null;
		this.formats = [];
	}
	// parameterized queries + image/path lanes stay methods
	has = clipboardSvc.has;
	readImage = clipboardSvc.readImage;
	writeImage = clipboardSvc.writeImage;
	readPaths = clipboardSvc.readPaths;
}
export const clipboard = new ClipboardNamespace();

// ── theme ───────────────────────────────────────────────────────────

class ThemeNamespace extends PlatformNamespace {
	/** Resolved OS appearance — live via `appearanceChanged`. */
	current = $state<ThemeInfo | null>(null);
	/** What set() last applied; 'system' = following the OS. */
	preference = $state<AppearancePreference>('system');

	get dark() { return this.current?.dark ?? false; }
	get name() { return this.current?.appearance ?? null; }

	async init(): Promise<this> {
		this.current = await themeSvc.get();
		this.ready = true;
		this.#unsub ??= onPlatform<ThemeInfo>('appearanceChanged', (info) => {
			this.current = info;
		});
		return this;
	}

	async set(preference: AppearancePreference) {
		// Assign after the call resolves — a rejected set must not leave
		// `preference` claiming a value the OS never applied.
		const current = await themeSvc.set(preference);
		this.preference = preference;
		this.current = current;
		return this.current;
	}
	shouldUseDarkColors = themeSvc.shouldUseDarkColors;

	on<E extends keyof ThemeEvents & string>(
		event: E,
		cb: (data: ThemeEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof ThemeEvents & string>(
		event: E,
		cb: (data: ThemeEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}

	#unsub: (() => void) | null = null;
	dispose() { this.#unsub?.(); this.#unsub = null; }
}
export const theme = new ThemeNamespace();

// ── system ──────────────────────────────────────────────────────────

class SystemNamespace extends PlatformNamespace {
	info = $state<SystemInfo | null>(null);
	/** OS accent color — pull-only (no change event exists). */
	accentColor = $state<AccentColor | null>(null);
	/** OS accessibility preferences — pull-only. */
	accessibility = $state<AccessibilityInfo | null>(null);

	get layout() { return this.info?.keyboardLayout ?? null; }
	get arch() { return this.info?.arch ?? null; }
	get os() { return this.info?.os ?? null; }

	async init(): Promise<this> {
		const [info, accentColor, accessibility] = await Promise.all([
			systemSvc.info(),
			systemSvc.getAccentColor().catch(() => null),
			systemSvc.getAccessibility().catch(() => null),
		]);
		this.info = info;
		this.accentColor = accentColor;
		this.accessibility = accessibility;
		this.ready = true;
		this.#unsub ??= onPlatform('keyboardLayoutChanged', async () => {
			const { name } = await systemSvc.getKeyboardLayout().catch(() => ({ name: null }));
			if (name && this.info) this.info = { ...this.info, keyboardLayout: name };
		});
		return this;
	}
	getKeyboardLayout = systemSvc.getKeyboardLayout;
	checkPermission = systemSvc.checkPermission;
	requestPermission = systemSvc.requestPermission;
	openSettings = systemSvc.openSettings;

	on<E extends keyof SystemEvents & string>(
		event: E,
		cb: (data: SystemEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof SystemEvents & string>(
		event: E,
		cb: (data: SystemEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}

	#unsub: (() => void) | null = null;
	dispose() { this.#unsub?.(); this.#unsub = null; }
}
export const system = new SystemNamespace();

// ── power ───────────────────────────────────────────────────────────

class PowerNamespace extends PlatformNamespace {
	thermal = $state<ThermalState | null>(null);
	/** Battery snapshot — null on battery-less machines. */
	battery = $state<BatteryInfo | null>(null);
	/** Seconds since the last global input event — pull-only. */
	idleSeconds = $state<number | null>(null);
	lastWakeAt = $state<number | null>(null);
	wakeCount = $state(0);

	async init(): Promise<this> {
		await this.refresh();
		this.ready = true;
		this.#events ??= [
			onPlatform('thermalStateChanged', async () => {
				const { state } = await powerSvc.getThermalState().catch(() => ({ state: null }));
				if (state) this.thermal = state;
			}),
			onPlatform('systemWake', () => {
				this.lastWakeAt = Date.now();
				this.wakeCount++;
			}),
		];
		return this;
	}
	async refresh(): Promise<this> {
		const [thermal, idleSeconds, battery] = await Promise.all([
			powerSvc.getThermalState().catch(() => null),
			powerSvc.getSystemIdleTime().catch(() => null),
			powerSvc.getBattery().catch(() => null),
		]);
		if (thermal) this.thermal = thermal.state;
		this.idleSeconds = idleSeconds;
		this.battery = battery;
		return this;
	}
	getSystemIdleTime = powerSvc.getSystemIdleTime;
	getThermalState = powerSvc.getThermalState;
	getBattery = powerSvc.getBattery;
	blockSleep = powerSvc.blockSleep;
	unblockSleep = powerSvc.unblockSleep;
	/** blockSleep() + a disposable SleepBlocker for `await using`. */
	acquireSleepBlocker = powerSvc.acquireSleepBlocker;

	on<E extends keyof PowerEvents & string>(
		event: E,
		cb: (data: PowerEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof PowerEvents & string>(
		event: E,
		cb: (data: PowerEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}

	#events: (() => void)[] | null = null;
	dispose() { this.#events?.forEach((off) => off()); this.#events = null; }
}
export const power = new PowerNamespace();

// ── deepLink ────────────────────────────────────────────────────────

class DeepLinkNamespace extends PlatformNamespace {
	/** URLs delivered by the OS, most recent last. */
	urls = $state<string[]>([]);
	get last() { return this.urls[this.urls.length - 1] ?? null; }

	init(): this {
		this.#unsub ??= onPlatform<{ urls: string[] }>('openUrls', ({ urls }) => {
			this.urls = [...this.urls, ...urls].slice(-100);
		});
		this.ready = true;
		return this;
	}
	register = deepLinkSvc.register;

	on<E extends keyof DeepLinkEvents & string>(
		event: E,
		cb: (data: DeepLinkEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof DeepLinkEvents & string>(
		event: E,
		cb: (data: DeepLinkEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}

	#unsub: (() => void) | null = null;
	dispose() { this.#unsub?.(); this.#unsub = null; }
}
export const deepLink = new DeepLinkNamespace();

// ── menu ────────────────────────────────────────────────────────────

class MenuNamespace extends PlatformNamespace {
	/** id of the last activated app/dock menu item. */
	lastAction = $state<string | null>(null);
	actionLog = $state<string[]>([]);

	init(): this {
		this.#unsub ??= onPlatform<{ id: string }>('menuAction', ({ id }) => {
			this.lastAction = id;
			// Bounded — an unbounded log is a slow leak on a long-lived app.
			this.actionLog = [...this.actionLog.slice(-99), id];
		});
		this.ready = true;
		return this;
	}
	setAppMenu = menuSvc.setAppMenu;
	setDockMenu = menuSvc.setDockMenu;
	addRecentDocument = menuSvc.addRecentDocument;
	popup = menuSvc.popup;
	update = menuSvc.update;
	get = menuSvc.get;
	items = menuSvc.items;

	on<E extends keyof MenuEvents & string>(
		event: E,
		cb: (data: MenuEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof MenuEvents & string>(
		event: E,
		cb: (data: MenuEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}

	#unsub: (() => void) | null = null;
	dispose() { this.#unsub?.(); this.#unsub = null; }
}
export const menu = new MenuNamespace();

// ── notifications ───────────────────────────────────────────────────

declare const __SVELTE_DESKTOP_NOTIFICATIONS__: { foreground?: boolean } | undefined;

class NotificationsNamespace extends PlatformNamespace {
	/** 'unknown' until read; refreshed when the app comes back to front. */
	permission = $state<NotificationPermission | 'unknown'>('unknown');
	/** The last click/action/reply/dismiss handled in this context. */
	lastResponse = $state<NotificationEvent | null>(null);

	async init(): Promise<this> {
		if (!this.#bound) {
			this.#bound = true;
			onPlatform('appActivated', () => void this.refresh());
			const config = typeof __SVELTE_DESKTOP_NOTIFICATIONS__ !== 'undefined' ? __SVELTE_DESKTOP_NOTIFICATIONS__ : undefined;
			if (config?.foreground === false) void notificationsSvc.setForeground(false).catch(() => {});
		}
		await this.refresh();
		this.ready = true;
		return this;
	}
	async refresh(): Promise<this> {
		this.permission = (await notificationsSvc.getPermissionStatus().catch(() => ({ status: 'unavailable' as const }))).status;
		return this;
	}
	async requestPermission() {
		const r = await notificationsSvc.requestPermission();
		this.permission = r.status;
		return r;
	}
	/** click · action · reply · dismiss · response (all four) · shown. Responses wait for their first listener. */
	on<E extends keyof NotificationsEvents & string>(
		event: E,
		cb: (data: NotificationsEvents[E]) => void,
	): () => void {
		if (event === 'notificationResponse') return onPlatform(event, cb);
		return onNotification(event as keyof NotificationEventMap, (e) => {
			if (e && typeof e === 'object' && 'kind' in e) this.lastResponse = e as NotificationEvent;
			cb(e as unknown as NotificationsEvents[E]);
		});
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof NotificationsEvents & string>(
		event: E,
		cb: (data: NotificationsEvents[E]) => void,
	): () => void {
		const off = this.on(event, (d) => { off(); cb(d); });
		return off;
	}

	#bound = false;
	dispose() {}
}
export const notifications = new NotificationsNamespace();

// ── push ────────────────────────────────────────────────────────────

class PushNamespace extends PlatformNamespace {
	/** The registered target (send it to your server), null when not registered. */
	target = $state<PushTarget | null>(null);

	async init(): Promise<this> {
		if (!this.#bound) {
			this.#bound = true;
			pushSvc.on('token', (t) => { this.target = t; });
		}
		this.target = await pushSvc.token().catch(() => null);
		this.ready = true;
		return this;
	}
	async register(opts?: { vapidPublicKey?: string }): Promise<PushTarget> {
		return (this.target = await pushSvc.register(opts));
	}
	async unregister() {
		await pushSvc.unregister();
		this.target = null;
		return null;
	}
	/** token: a new or rotated target · message: a push received while the app runs. */
	on<E extends 'token' | 'message'>(event: E, fn: (e: E extends 'token' ? PushTarget : PushMessage) => void): () => void {
		return pushSvc.on(event, fn);
	}

	#bound = false;
}
export const push = new PushNamespace();

// ── capture ─────────────────────────────────────────────────────────

class CaptureNamespace extends PlatformNamespace {
	supported = $state(false);
	sources = $state<CaptureSource[]>([]);

	async init(): Promise<this> {
		this.supported = (await captureSvc.isSupported()).supported;
		if (this.supported) this.sources = await captureSvc.getSources();
		this.ready = true;
		return this;
	}
	async refresh(): Promise<this> {
		if (this.supported) this.sources = await captureSvc.getSources();
		return this;
	}
	isSupported = captureSvc.isSupported;
	/** Parameterized query — `types` filters (default: every kind). */
	getSources = captureSvc.getSources;
	/** Grab one frame — rejects `unavailable` when the source can't be captured. */
	captureSource = captureSvc.captureSource;
}
export const capture = new CaptureNamespace();

// ── diagnostics ─────────────────────────────────────────────────────

class DiagnosticsNamespace extends PlatformNamespace {
	info = $state<DiagnosticsInfo | null>(null);

	get pid() { return this.info?.pid ?? null; }
	get uptimeSeconds() { return this.info?.uptimeSeconds ?? null; }

	async init(): Promise<this> {
		await this.refresh();
		this.ready = true;
		return this;
	}
	async refresh(): Promise<this> {
		this.info = await diagnosticsSvc.info();
		return this;
	}
}
export const diagnostics = new DiagnosticsNamespace();

// ── capabilities ────────────────────────────────────────────────────

class CapabilitiesNamespace extends PlatformNamespace {
	report = $state<CapabilitiesReport | null>(null);

	/** 'implemented' | 'unavailable' | 'unsupported' | … for service.op */
	opStatus(service: string, op: string): string | null {
		return this.report?.services[service]?.[op] ?? null;
	}

	async init(): Promise<this> {
		this.report = await capabilitiesSvc.describe();
		this.ready = true;
		return this;
	}
	describe = capabilitiesSvc.describe;
}
export const capabilities = new CapabilitiesNamespace();

// ── update ──────────────────────────────────────────────────────────
// check() hits the network — opt-in, init() only marks the namespace ready.

class UpdateNamespace extends PlatformNamespace {
	checking = $state(false);
	available = $state<AvailableUpdate | null>(null);
	checkedAt = $state<number | null>(null);
	checkError = $state<Error | null>(null);

	get upToDate() { return this.checkedAt !== null && this.available === null && !this.checkError; }

	init(): this {
		this.ready = true;
		return this;
	}
	async check(currentVersion?: string, options?: UpdateEndpoints) {
		this.checking = true;
		this.checkError = null;
		try {
			this.available = await updaterSvc.check(currentVersion, options);
			this.checkedAt = Date.now();
			return this.available;
		} catch (error) {
			this.checkError = error as Error;
			throw error;
		} finally {
			this.checking = false;
		}
	}
}
export const update = new UpdateNamespace();

// ── tray ────────────────────────────────────────────────────────────
// Echo-only namespace — no pull op exists; fields mirror set()/remove().

class TrayNamespace extends PlatformNamespace {
	title = $state<string | null>(null);
	tooltip = $state<string | null>(null);
	imagePath = $state<string | null>(null);
	/** Whether a tray item is currently installed. */
	active = $state(false);
	/** Screen rect of the last trayClick event (fields optional per platform). */
	lastRect = $state<TrayClickRect | null>(null);

	init(): this {
		this.#unsub ??= onPlatform<TrayClickRect>('trayClick', (rect) => {
			this.lastRect = rect;
		});
		this.ready = true;
		return this;
	}
	async set(options: TrayOptions) {
		const { set } = await traySvc.set(options);
		this.title = options.title ?? null;
		this.tooltip = options.tooltip ?? null;
		this.imagePath = options.imagePath ?? null;
		this.active = set;
		return set;
	}
	async remove() {
		await traySvc.remove();
		this.active = false;
		this.title = null;
		this.tooltip = null;
		this.imagePath = null;
	}
	/** set() + a disposable TrayHandle for `await using`. */
	async acquire(options: TrayOptions): Promise<TrayHandle> {
		await this.set(options);
		return new TrayHandle(() => this.remove());
	}

	on<E extends keyof TrayEvents & string>(
		event: E,
		cb: (data: TrayEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof TrayEvents & string>(
		event: E,
		cb: (data: TrayEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}

	#unsub: (() => void) | null = null;
	dispose() { this.#unsub?.(); this.#unsub = null; }
}
export const tray = new TrayNamespace();

// ── shortcuts ───────────────────────────────────────────────────────
// Global hotkeys — `registered` tracks the ids this session registered.

class ShortcutsNamespace extends PlatformNamespace {
	/** Ids of shortcuts registered through this namespace. */
	registered = $state<string[]>([]);

	init(): this {
		this.ready = true;
		return this;
	}
	async register(options: { accelerator: string; id?: string }) {
		const result = await shortcutsSvc.register(options);
		if (!this.registered.includes(result.id)) {
			this.registered = [...this.registered, result.id];
		}
		return result;
	}
	async unregister(options: { id: string }) {
		await shortcutsSvc.unregister(options);
		this.registered = this.registered.filter((id) => id !== options.id);
	}
	async unregisterAll() {
		await shortcutsSvc.unregisterAll();
		this.registered = [];
	}
	/** register() + a disposable ShortcutRegistration for `await using`. */
	async acquire(options: { accelerator: string; id?: string }): Promise<ShortcutRegistration> {
		const { id } = await this.register(options);
		return new ShortcutRegistration(id, () => this.unregister({ id }));
	}

	on<E extends keyof ShortcutEvents & string>(
		event: E,
		cb: (data: ShortcutEvents[E]) => void,
	): () => void {
		return onPlatform(event, cb);
	}
	/** Like on() but unsubscribes after the first delivery. */
	once<E extends keyof ShortcutEvents & string>(
		event: E,
		cb: (data: ShortcutEvents[E]) => void,
	): () => void {
		return oncePlatform(event, cb);
	}
}
export const shortcuts = new ShortcutsNamespace();

// ── store (persisted JSON KV) ───────────────────────────────────────
// Local namespace — no native ops; store.ts reads/writes the JSON file.
// `data` mirrors the file between saves; failures land on `store.error`.

class StoreNamespace extends PlatformNamespace {
	/** Live snapshot of the persisted record. */
	data = $state<Record<string, unknown>>({});
	/** The JSON file (in the app data directory) — set once load() runs (init calls it). */
	path = $state<string | null>(null);

	async init(): Promise<this> {
		await storeSvc.load();
		this.data = { ...storeSvc.data };
		this.path = storeSvc.path;
		this.ready = true;
		return this;
	}
	get<T = unknown>(key: string): T | undefined {
		return this.data[key] as T | undefined;
	}
	set(key: string, value: unknown): void {
		storeSvc.set(key, value);
		this.data = { ...storeSvc.data };
	}
	delete(key: string): void {
		storeSvc.delete(key);
		this.data = { ...storeSvc.data };
	}
	clear(): void {
		storeSvc.clear();
		this.data = {};
	}
	/** Re-read the JSON file into `data`. */
	async load() {
		await storeSvc.load();
		this.data = { ...storeSvc.data };
		this.path = storeSvc.path;
		return this.data;
	}
	/** Force the pending debounced write to disk now. */
	flush = storeSvc.flush;
}
export const store = new StoreNamespace();

// ── events (pure JS local bus) ──────────────────────────────────────
// NO native ops — a renderer-local event bus for app code (custom
// window→window messages once multi-window lands: emitTo('main') is the
// only routable id today; other ids reject with invalid_args).

class EventsNamespace extends PlatformNamespace {
	#local = new Map<string, Set<(data: unknown) => void>>();

	init(): this {
		this.ready = true;
		return this;
	}
	on<T = unknown>(name: string, cb: (data: T) => void): () => void {
		let set = this.#local.get(name);
		if (!set) {
			set = new Set();
			this.#local.set(name, set);
		}
		set.add(cb as (data: unknown) => void);
		return () => {
			set!.delete(cb as (data: unknown) => void);
			if (set!.size === 0) this.#local.delete(name);
		};
	}
	once<T = unknown>(name: string, cb: (data: T) => void): () => void {
		let off: () => void = () => {};
		off = this.on<T>(name, (data) => {
			off();
			cb(data);
		});
		return off;
	}
	/** Dispatch to local listeners only — never crosses the bus. */
	emit(name: string, payload?: unknown): void {
		// Isolated per listener — a throwing cb must not starve the rest.
		for (const cb of this.#local.get(name) ?? []) {
			try {
				cb(payload);
			} catch {
				/* listener errors stay listener-local */
			}
		}
	}
	/**
	 * Route an event to a window. `'main'`/`'0'` dispatch on this local bus;
	 * numeric ids route over the platform event bus to `onWindow(id, name)`
	 * listeners — the real multi-window channel. Other strings reject.
	 */
	async emitTo(windowId: string, name: string, payload?: unknown): Promise<void> {
		if (windowId === 'main' || windowId === '0') {
			this.emit(name, payload);
			return;
		}
		const id = Number(windowId);
		if (Number.isInteger(id) && id > 0) {
			emitToWindow(id, name, payload);
			return;
		}
		throw new NativeApiError(
			'invalid_args',
			`emitTo: unknown window '${windowId}' — pass 'main' or a numeric windowId from windows.create`,
		);
	}
}
export const events = new EventsNamespace();

// ── background jobs ─────────────────────────────────────────────────
// Mirrors `jobs` from '@svelte-desktop/shell/server' (src/jobs/*.ts run in their own
// processes): the server broadcasts snapshots on the `jobs` channel.

export interface JobView {
	id: string;
	name: string;
	state: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
	progress: number;
	message: string | null;
	args: unknown;
	result?: unknown;
	error?: string;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	log: string[];
}

class JobsNamespace extends PlatformNamespace {
	#all = $state<JobView[]>([]);
	#events = new Set<(e: { id: string; data: unknown }) => void>();
	#changes = new Set<(type: JobView['state'], job: JobView) => void>();
	#bound = false;

	async init(): Promise<this> {
		if (!this.#bound) {
			this.#bound = true;
			onBroadcast<{ jobs: JobView[]; event?: { id: string; data: unknown }; change?: { type: JobView['state']; job: JobView } }>('jobs', (d) => {
				if (Array.isArray(d?.jobs)) this.#all = d.jobs;
				if (d?.event) for (const fn of this.#events) fn(d.event);
				if (d?.change) for (const fn of this.#changes) fn(d.change.type, d.change.job);
			});
		}
		await broadcast('jobs:hello'); // the server answers with a snapshot
		this.ready = true;
		return this;
	}
	/** Every job of this launch (and restored history), oldest first. Reactive. */
	list(): JobView[] { return this.#all; }
	/** Queued or running. Reactive. */
	active(): JobView[] { return this.#all.filter((j) => j.state === 'running' || j.state === 'queued'); }
	/** Running now. Reactive. */
	running(): JobView[] { return this.#all.filter((j) => j.state === 'running'); }
	get(id: string): JobView | undefined { return this.#all.find((j) => j.id === id); }
	/** Ask the server to cancel a job (its ctx.signal fires). */
	cancel(id: string): Promise<null> { return broadcast('jobs:cancel', { id }); }
	/** State transitions: `on('done', (job) => …)`; '*' for every one. */
	on(state: JobView['state'] | '*', fn: (job: JobView, state: JobView['state']) => void): () => void {
		const cb = (type: JobView['state'], job: JobView) => (state === '*' || state === type) && fn(job, type);
		this.#changes.add(cb);
		return () => this.#changes.delete(cb);
	}
	/** Custom events from `ctx.emit(data)` in a job. */
	onEvent(fn: (e: { id: string; data: unknown }) => void): () => void {
		this.#events.add(fn);
		return () => this.#events.delete(fn);
	}
}
export const jobs = new JobsNamespace();

// ── permissions ─────────────────────────────────────────────────────
// Statuses of the permissions declared in desktop.config, kept current: on start,
// when the app comes back to the front (the user may have toggled them in System
// Settings) and after request/guide. `host.permissions.camera` reads them.

class PermissionsNamespace extends PlatformNamespace {
	#statuses = $state<Record<string, PermissionStatus>>({});
	#listeners = new Set<(name: string, status: PermissionStatus) => void>();
	#bound = false;

	async init(): Promise<this> {
		if (!this.#bound) {
			this.#bound = true;
			const again = () => void this.refresh();
			onPlatform('appActivated', again);
			onPlatform('focusChanged', (d: { focused?: boolean }) => d?.focused && again());
			permissionsSvc.onChange(({ name, status }) => this.#set(name, status));
		}
		await this.refresh();
		this.ready = true;
		return this;
	}
	#set(name: string, status: PermissionStatus) {
		const before = this.#statuses[name];
		if (before === status) return;
		this.#statuses = { ...this.#statuses, [name]: status };
		if (before !== undefined) for (const fn of this.#listeners) fn(name, status);
	}
	/** Re-read the declared (and already seen) permissions. */
	async refresh(): Promise<this> {
		const names = new Set([...Object.keys(permissionsSvc.declared()), ...Object.keys(this.#statuses)]);
		await Promise.all([...names].map(async (n) => this.#set(n, await permissionsSvc.status(n).catch(() => 'unknown' as const))));
		return this;
	}
	/** Reactive status ('unknown' until read). */
	get(name: PermissionName | string): PermissionStatus { return this.#statuses[name] ?? 'unknown'; }
	/** Read the status now (and keep it current). */
	async status(name: PermissionName | string): Promise<PermissionStatus> {
		const status = await permissionsSvc.status(name);
		this.#set(name, status);
		return status;
	}
	guideState() { return permissionsSvc.guideState(); }
	/** Every known status. Reactive. */
	all(): Record<string, PermissionStatus> { return this.#statuses; }
	declared(): Record<string, string> { return permissionsSvc.declared(); }
	settingsOnly(name: PermissionName | string): boolean { return permissionsSvc.settingsOnly(name); }
	async request(name: PermissionName | string, opts?: { guide?: boolean }): Promise<PermissionStatus> {
		const status = await permissionsSvc.request(name, opts);
		this.#set(name, status);
		return status;
	}
	async guide(name: PermissionName | string, opts?: { open?: boolean }) {
		const r = await permissionsSvc.guide(name, opts);
		this.#set(name, r.status);
		return r;
	}
	cancelGuide() { return permissionsSvc.cancelGuide(); }
	openSettings(name: PermissionName | string) { return permissionsSvc.openSettings(name); }
	/** Status changes: `on('change', (name, status) => …)`. */
	on(_event: 'change', fn: (name: string, status: PermissionStatus) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}
}
export const permissions = new PermissionsNamespace();

// ── aggregate init ──────────────────────────────────────────────────

const ALL: PlatformNamespace[] = [
	app, window, windowState, screen, clipboard, theme, system, power,
	deepLink, menu, notifications, push, capture, diagnostics, capabilities, update,
	tray, shortcuts, store, events, jobs, permissions,
];

let running: Promise<PlatformNamespace[]> | null = null;

/**
 * Initialize every namespace in parallel. A namespace that rejects captures
 * its failure on `namespace.error` — initStores() itself never throws.
 * Concurrent calls share one in-flight boot; a call after completion re-runs
 * (doubles as a refresh-all). Apps don't need to call this — importing the
 * module self-initializes once initPlatform() binds a backend.
 */
export function initStores(): Promise<PlatformNamespace[]> {
	running ??= Promise.all(
		ALL.map(async (ns) => {
			try {
				ns.error = null;
				await ns.init();
			} catch (error) {
				ns.error = error as Error;
			}
		}),
	).then(() => {
		running = null;
		return ALL;
	});
	return running;
}

// Zero-ceremony: importing this module is enough — namespaces self-initialize
// the moment a platform backend binds (initPlatform → onPlatformReady flush).
onPlatformReady(() => void initStores());
