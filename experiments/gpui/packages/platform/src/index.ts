/**
 * Typed platform API surface. Each namespace maps to a `service` in the
 * brokered dispatch (native/src/platform.rs). All calls are async; failures
 * reject with `NativeApiError` carrying a typed `code` — `unsupported` means
 * the op is not implementable on this OS through the current backend.
 */
import { callPlatform, onPlatform } from './bus';

export {
	NativeApiError, initPlatform, initPlatformForTests, onPlatform, oncePlatform,
	onAnyPlatform, emitTo, onWindow, onPlatformReady, platformReady,
	platformReady as isNative,
	Channel, PlatformTransport, mockPlatform,
} from './bus';
export type { PlatformErrorCode, PlatformInitOptions } from './bus';
export { LogicalPosition, PhysicalPosition, LogicalSize, PhysicalSize } from './dpi';
export type { Position, Size } from './dpi';

// ── app ─────────────────────────────────────────────────────────────

export type AppPathName =
	| 'home' | 'appPath' | 'exe' | 'temp' | 'appData' | 'userData' | 'logs'
	| 'caches' | 'documents' | 'downloads' | 'desktop' | 'music' | 'pictures'
	| 'videos';

export interface AppInfo {
	name: string;
	version: string;
	identifier: string;
	appPath: string | null;
	packaged: boolean;
	platform: string;
	arch: string;
}

export type ActivationPolicy = 'regular' | 'accessory' | 'prohibited';
export type DockBounceType = 'critical' | 'informational';

export type DockProgressStatus = 'none' | 'normal' | 'indeterminate' | 'paused' | 'error';

// `type` (not interface) — object type literals get an implicit index
// signature, keeping them assignable to callPlatform's args record.
export type DockProgress = {
	status: DockProgressStatus;
	completed?: number;
	total?: number;
};

export type BundleType = 'app' | 'binary';

export type AboutPanelOptions = {
	name?: string;
	version?: string;
	copyright?: string;
	credits?: string;
};

export const app = {
	whenReady: () => callPlatform<true>('app', 'whenReady'),
	getInfo: () => callPlatform<AppInfo>('app', 'getInfo'),
	getName: () => callPlatform<string>('app', 'getName'),
	getVersion: () => callPlatform<string>('app', 'getVersion'),
	getPath: (name: AppPathName) => callPlatform<string>('app', 'getPath', { name }),
	setName: (name: string) => callPlatform<null>('app', 'setName', { name }),
	setIdentity: (identifier: string, name?: string) =>
		callPlatform<null>('app', 'setIdentity', { identifier, name }),
	quit: () => callPlatform<null>('app', 'quit'),
	relaunch: () => callPlatform<null>('app', 'relaunch'),
	/** Immediate process exit — skips GPUI teardown; the returned promise
	 * never resolves by design. Prefer quit(). */
	exit: (code = 0) => callPlatform<never>('app', 'exit', { code }),
	hide: () => callPlatform<null>('app', 'hide'),
	show: () => callPlatform<null>('app', 'show'),
	hideOthers: () => callPlatform<null>('app', 'hideOthers'),
	showAll: () => callPlatform<null>('app', 'showAll'),
	addRecentDocument: (path: string) =>
		callPlatform<null>('app', 'addRecentDocument', { path }),
	/** macOS Dock tile badge text; null clears it. */
	setDockBadge: (text: string | null) =>
		callPlatform<boolean>('app', 'setDockBadge', { text }),
	/** Bounce the Dock icon (macOS). */
	bounceDock: (type: DockBounceType) => callPlatform<boolean>('app', 'bounceDock', { type }),
	/** Launch at login; resolves to the effective state. */
	setLoginItem: (enabled: boolean) =>
		callPlatform<{ enabled: boolean }>('app', 'setLoginItem', { enabled }),
	/** macOS activation policy — 'accessory' hides the Dock icon. */
	setActivationPolicy: (policy: ActivationPolicy) =>
		callPlatform<boolean>('app', 'setActivationPolicy', { policy }),
	/** Acquire the single-instance lock; `acquired:false` means another
	 *  instance holds it (second instances should quit). */
	requestSingleInstanceLock: () =>
		callPlatform<{ acquired: boolean }>('app', 'requestSingleInstanceLock'),
	/** macOS Dock progress bar; `{status:'none'}` clears it. */
	setDockProgress: (progress: DockProgress) =>
		callPlatform<null>('app', 'setDockProgress', progress),
	/** Whether we're running inside an .app bundle or as a bare binary. */
	getBundleType: () => callPlatform<{ type: BundleType }>('app', 'getBundleType'),
	/** PNG (base64) of the bundle's default window icon — null for bare binaries. */
	defaultWindowIcon: () =>
		callPlatform<{ pngBase64: string } | null>('app', 'defaultWindowIcon'),
	/** Open the standard About panel (macOS orderFrontStandardAboutPanel). */
	aboutPanel: (options: AboutPanelOptions = {}) =>
		callPlatform<null>('app', 'aboutPanel', options),
	onReopen: (cb: () => void) => onPlatform('reopened', cb),
	onOpenUrls: (cb: (data: { urls: string[] }) => void) => onPlatform('openUrls', cb),
	onWillQuit: (cb: () => void) => onPlatform('willQuit', cb),
	onWillRestart: (cb: () => void) => onPlatform('willRestart', cb),
	/** Fires when a second instance tries to launch while we hold the lock. */
	onSecondInstance: (cb: (data: { argv: string[]; cwd: string }) => void) =>
		onPlatform('secondInstance', cb),
	/** App gained/lost OS focus (NSApplication activate/deactivate). */
	onActivated: (cb: (data: Record<string, never>) => void) => onPlatform('appActivated', cb),
	onDeactivated: (cb: (data: Record<string, never>) => void) => onPlatform('appDeactivated', cb),
};

// ── window ──────────────────────────────────────────────────────────

export interface WindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type WindowStateName = 'normal' | 'maximized' | 'fullscreen';

export type WindowPositionPreset =
	| 'center'
	| 'trayCenter'
	| 'trayLeft'
	| 'trayRight'
	| 'trayTop'
	| 'trayBottom'
	| 'cursorTopLeft'
	| 'cursorBottomLeft';

/** Context handed to a PopoverPosition callback each time the popover
 *  resizes to its content — everything needed to compute an anchor. */
export type PopoverPlacement = {
	/** Measured content size — the window was just resized to this. */
	width: number;
	height: number;
	/** Tray-click button rect (global screen coords) when the popover was
	 *  opened by a click. */
	tray?: TrayClickRect;
	/** Connected displays. `bounds`/`workArea` describe each display's own
	 *  space — in gpui's window model every display's bounds are
	 *  (0,0)-anchored, so returned {x,y} land on the screen the window
	 *  sits on (the primary display while it is hidden). */
	displays: DisplayInfo[];
};

/** Popover placement: a preset name, a fixed {x,y} in the window's
 *  screen coordinates, or a callback returning either (null/undefined
 *  leaves the window where it is). Example — Spotlight-style
 *  bottom-center of the window's screen:
 *
 *    position={({ width, height, displays }) => {
 *      const wa = displays[0].workArea;
 *      return { x: wa.x + (wa.width - width) / 2,
 *               y: wa.y + wa.height - height - 96 };
 *    }} */
export type PopoverPosition =
	| WindowPositionPreset
	| { x: number; y: number }
	| ((
			placement: PopoverPlacement,
	  ) => WindowPositionPreset | { x: number; y: number } | null | undefined);

export type TitleBarStyle = 'default' | 'transparent' | 'hidden' | 'hiddenInset';

/** Per-window NSAppearance — narrower than the app-level AppearancePreference. */
export type WindowTheme = 'light' | 'dark' | 'system';

/** Options for windows.create — every field optional. */
export type WindowCreateOptions = {
	/** Unique per app — a duplicate label rejects `invalid_args`. */
	label?: string;
	title?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	minWidth?: number;
	minHeight?: number;
	/** `false` → borderless window (no titlebar chrome). */
	decorations?: boolean;
	/** Shown on creation (default true); `show` is accepted as an alias. */
	visible?: boolean;
	/** Float above normal windows (NSFloatingWindowLevel). */
	alwaysOnTop?: boolean;
	resizable?: boolean;
	movable?: boolean;
	minimizable?: boolean;
	/** Focus on creation (default true). */
	focus?: boolean;
	/** Transparent window background (content must paint its own chrome). */
	transparent?: boolean;
	/** Window alpha 0–1, applied before the first presented frame — `0`
	 *  stages a window invisible while keeping it on a screen (positioning
	 *  ops still work). Restore later with `windows.setOpacity`. */
	opacity?: number;
	/** Titlebar blends into content (macOS). */
	titlebarTransparent?: boolean;
	/** Native tab group name — same id groups windows as tabs (macOS). */
	tabbingIdentifier?: string;
};

/** One row of windows.list()/get(). `windowId` 0 is the primary window. */
export interface WindowInfo {
	windowId: number;
	label: string;
	focused: boolean;
	bounds: WindowBounds;
}

/** A rect in window-frame coordinates — top-left origin, y down. */
export type ControlsRect = { x: number; y: number; width: number; height: number };

/** The region the OS window controls occupy, in **window-frame
 *  coordinates** — `x`/`y` are the union rect's distance from the window's
 *  top-left corner, so the values answer "where in the window do the
 *  controls sit" directly. `contentTop` converts back to drawable space:
 *  `y - contentTop` is the cluster's offset from the top of the laid-out
 *  content (negative when the drawable starts below a real titlebar). */
export type WindowControlsArea = ControlsRect & {
	/** Distance from the window's top edge to the drawable's top edge —
	 *  the titlebar/toolbar inset (`0` when content underlaps it, e.g.
	 *  `fullSizeContentView`). */
	contentTop: number;
	/** Which edge the controls live on — `left` on macOS, `right` on
	 *  Windows/Linux — so layouts can mirror instead of hardcoding. */
	side: 'left' | 'right';
	buttons: {
		close?: ControlsRect & { visible: boolean };
		minimize?: ControlsRect & { visible: boolean };
		zoom?: ControlsRect & { visible: boolean };
	};
};

/** Optional `windowId` passthrough shared by every window op — absent, the
 *  native side resolves the dispatching view's window (→ 0 single-window). */
const wid = (windowId?: number) => (windowId === undefined ? {} : { windowId });

export const windows = {
	// ── multi-window ──────────────────────────────────────────────
	/** Open another OS window on the shared realm/tree. Labels are unique
	 *  (duplicate → `invalid_args`); macOS only — `unsupported` elsewhere. */
	create: (options: WindowCreateOptions = {}) =>
		callPlatform<{ windowId: number; label: string }>('window', 'create', options),
	/** Every open window — primary is `windowId` 0. */
	list: () => callPlatform<WindowInfo[]>('window', 'list'),
	/** Window info by label — resolves null on an unknown label. */
	get: (label: string) => callPlatform<WindowInfo | null>('window', 'get', { label }),

	getBounds: (windowId?: number) =>
		callPlatform<{ bounds: WindowBounds; state: WindowStateName }>(
			'window',
			'getBounds',
			wid(windowId),
		),
	getSize: (windowId?: number) =>
		callPlatform<{ width: number; height: number }>('window', 'getSize', wid(windowId)),
	setSize: (width: number, height: number, windowId?: number) =>
		callPlatform<null>('window', 'setSize', { width, height, ...wid(windowId) }),
	getTitle: (windowId?: number) => callPlatform<string>('window', 'getTitle', wid(windowId)),
	setTitle: (title: string, windowId?: number) =>
		callPlatform<null>('window', 'setTitle', { title, ...wid(windowId) }),
	minimize: (windowId?: number) => callPlatform<null>('window', 'minimize', wid(windowId)),
	maximize: (windowId?: number) =>
		callPlatform<{ maximized: boolean }>('window', 'maximize', wid(windowId)),
	unmaximize: (windowId?: number) =>
		callPlatform<{ maximized: boolean }>('window', 'unmaximize', wid(windowId)),
	toggleMaximize: (windowId?: number) =>
		callPlatform<{ maximized: boolean }>('window', 'toggleMaximize', wid(windowId)),
	isMaximized: (windowId?: number) => callPlatform<boolean>('window', 'isMaximized', wid(windowId)),
	isFullscreen: (windowId?: number) =>
		callPlatform<boolean>('window', 'isFullscreen', wid(windowId)),
	setFullscreen: (fullscreen: boolean, windowId?: number) =>
		callPlatform<{ fullscreen: boolean }>(
			'window',
			'setFullscreen',
			{ fullscreen, ...wid(windowId) },
		),
	toggleFullscreen: (windowId?: number) =>
		callPlatform<{ fullscreen: boolean }>('window', 'toggleFullscreen', wid(windowId)),
	isFocused: (windowId?: number) => callPlatform<boolean>('window', 'isFocused', wid(windowId)),
	/** Focus a window (makeKeyAndOrderFront + app activate); absent → the
	 *  dispatching view's window. */
	focus: (windowId?: number) => callPlatform<null>('window', 'focus', wid(windowId)),
	/** Bounce/flash the platform attention affordance (Dock bounce on macOS). */
	requestAttention: (windowId?: number) =>
		callPlatform<null>('window', 'requestAttention', wid(windowId)),
	/** Associates a file with the window (macOS titlebar document icon). */
	setRepresentedFilename: (path: string | null, windowId?: number) =>
		callPlatform<null>('window', 'setRepresentedFilename', { path, ...wid(windowId) }),
	/** windowId absent → the dispatching view's window (existing semantics). */
	close: (windowId?: number) => callPlatform<null>('window', 'close', wid(windowId)),
	showCharacterPalette: (windowId?: number) =>
		callPlatform<null>('window', 'showCharacterPalette', wid(windowId)),
	getScaleFactor: (windowId?: number) =>
		callPlatform<number>('window', 'getScaleFactor', wid(windowId)),
	/** Cursor position in window coordinates (only while inside our window). */
	getCursorPoint: (windowId?: number) =>
		callPlatform<{ x: number; y: number }>('window', 'getCursorPoint', wid(windowId)),
	getPosition: (windowId?: number) =>
		callPlatform<{ x: number; y: number }>('window', 'getPosition', wid(windowId)),
	setPosition: (x: number, y: number, windowId?: number) =>
		callPlatform<null>('window', 'setPosition', { x, y, ...wid(windowId) }),
	/**
	 * Arm/disarm the close veto. While armed, OS-initiated closes (red button,
	 * ⌘W) are suppressed and a `willClose`/`closeRequested` event fires
	 * instead; disarm then call `close()` to actually close.
	 */
	setCloseVeto: (enabled: boolean, windowId?: number) =>
		callPlatform<{ armed: boolean }>('window', 'setCloseVeto', { enabled, ...wid(windowId) }),

	// ── geometry + visibility ───────────────────────────────────────
	center: (windowId?: number) => callPlatform<null>('window', 'center', wid(windowId)),
	hide: (windowId?: number) => callPlatform<null>('window', 'hide', wid(windowId)),
	show: (windowId?: number) => callPlatform<null>('window', 'show', wid(windowId)),
	setBounds: (x: number, y: number, width: number, height: number, windowId?: number) =>
		callPlatform<null>('window', 'setBounds', { x, y, width, height, ...wid(windowId) }),
	positionTo: (preset: WindowPositionPreset, windowId?: number) =>
		callPlatform<null>('window', 'positionTo', { preset, ...wid(windowId) }),
	/** The OS window-controls cluster (macOS traffic lights; caption buttons
	 *  on Windows/Linux) in **window-frame coordinates** — measured from the
	 *  window's top-left corner, y down. `contentTop` carries the drawable's
	 *  inset from the frame top; `y - contentTop` converts to content space
	 *  for reserving layout regions. `null` when the window has no standard
	 *  buttons (borderless popovers). macOS-only — `unsupported` elsewhere. */
	getControlsArea: (windowId?: number) =>
		callPlatform<WindowControlsArea | null>('window', 'controlsArea', wid(windowId)),
	unminimize: (windowId?: number) =>
		callPlatform<null>('window', 'unminimize', wid(windowId)),
	isMinimized: (windowId?: number) =>
		callPlatform<{ minimized: boolean }>('window', 'isMinimized', wid(windowId)),
	/** Undo minimize/maximize/fullscreen back to the normal state. */
	restore: (windowId?: number) => callPlatform<null>('window', 'restore', wid(windowId)),

	// ── fullscreen + z-order ────────────────────────────────────────
	/** macOS simple fullscreen (non-native, keeps other spaces usable). */
	setSimpleFullscreen: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setSimpleFullscreen', { enabled, ...wid(windowId) }),
	isSimpleFullscreen: (windowId?: number) =>
		callPlatform<{ simpleFullscreen: boolean }>(
			'window',
			'isSimpleFullscreen',
			wid(windowId),
		),
	setAlwaysOnTop: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setAlwaysOnTop', { enabled, ...wid(windowId) }),
	setAlwaysOnBottom: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setAlwaysOnBottom', { enabled, ...wid(windowId) }),
	blur: (windowId?: number) => callPlatform<null>('window', 'blur', wid(windowId)),
	isHovered: (windowId?: number) =>
		callPlatform<{ hovered: boolean }>('window', 'isHovered', wid(windowId)),
	isActive: (windowId?: number) => callPlatform<boolean>('window', 'isActive', wid(windowId)),
	/** Fully covered / minimized / off-space — no pixel on screen. */
	isOccluded: (windowId?: number) =>
		callPlatform<boolean>('window', 'isOccluded', wid(windowId)),

	// ── chrome toggles ──────────────────────────────────────────────
	setResizable: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setResizable', { enabled, ...wid(windowId) }),
	isResizable: (windowId?: number) =>
		callPlatform<{ resizable: boolean }>('window', 'isResizable', wid(windowId)),
	setClosable: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setClosable', { enabled, ...wid(windowId) }),
	isClosable: (windowId?: number) =>
		callPlatform<{ closable: boolean }>('window', 'isClosable', wid(windowId)),
	setMinimizable: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setMinimizable', { enabled, ...wid(windowId) }),
	isMinimizable: (windowId?: number) =>
		callPlatform<{ minimizable: boolean }>('window', 'isMinimizable', wid(windowId)),
	setMaximizable: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setMaximizable', { enabled, ...wid(windowId) }),
	isMaximizable: (windowId?: number) =>
		callPlatform<{ maximizable: boolean }>('window', 'isMaximizable', wid(windowId)),
	setTitleBarStyle: (style: TitleBarStyle, windowId?: number) =>
		callPlatform<null>('window', 'setTitleBarStyle', { style, ...wid(windowId) }),
	setDecorations: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setDecorations', { enabled, ...wid(windowId) }),
	setHasShadow: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setHasShadow', { enabled, ...wid(windowId) }),
	invalidateShadow: (windowId?: number) =>
		callPlatform<null>('window', 'invalidateShadow', wid(windowId)),

	// ── appearance + behavior ───────────────────────────────────────
	setOpacity: (opacity: number, windowId?: number) =>
		callPlatform<null>('window', 'setOpacity', { opacity, ...wid(windowId) }),
	getOpacity: (windowId?: number) =>
		callPlatform<{ opacity: number }>('window', 'getOpacity', wid(windowId)),
	setMovable: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setMovable', { enabled, ...wid(windowId) }),
	setMovableByWindowBackground: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setMovableByWindowBackground', { enabled, ...wid(windowId) }),
	setIgnoresMouseEvents: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setIgnoresMouseEvents', { enabled, ...wid(windowId) }),
	ignoresMouseEvents: (windowId?: number) =>
		callPlatform<{ ignored: boolean }>('window', 'ignoresMouseEvents', wid(windowId)),
	/** Exclude the window from screen capture (Screen Recording). */
	setContentProtected: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setContentProtected', { enabled, ...wid(windowId) }),
	isContentProtected: (windowId?: number) =>
		callPlatform<{ contentProtected: boolean }>(
			'window',
			'isContentProtected',
			wid(windowId),
		),
	setVisibleOnAllWorkspaces: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setVisibleOnAllWorkspaces', { enabled, ...wid(windowId) }),
	/** macOS document-edited dot in the close button. */
	setDocumentEdited: (edited: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setDocumentEdited', { edited, ...wid(windowId) }),
	isDocumentEdited: (windowId?: number) =>
		callPlatform<{ edited: boolean }>('window', 'isDocumentEdited', wid(windowId)),
	/** Alias for setDocumentEdited. */
	setEdited: (edited: boolean, windowId?: number) =>
		windows.setDocumentEdited(edited, windowId),
	/** Whether the window can take keyboard focus — unsupported on some backends. */
	setFocusable: (enabled: boolean, windowId?: number) =>
		callPlatform<never>('window', 'setFocusable', { enabled, ...wid(windowId) }),
	setCursorHidden: (hidden: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setCursorHidden', { hidden, ...wid(windowId) }),
	/** Screen coordinates — warps the OS cursor. */
	setCursorPosition: (x: number, y: number, windowId?: number) =>
		callPlatform<null>('window', 'setCursorPosition', { x, y, ...wid(windowId) }),
	/** Per-window NSAppearance override. */
	setTheme: (theme: WindowTheme, windowId?: number) =>
		callPlatform<null>('window', 'setTheme', { theme, ...wid(windowId) }),

	// ── size + position queries ─────────────────────────────────────
	innerSize: (windowId?: number) =>
		callPlatform<{ width: number; height: number }>('window', 'innerSize', wid(windowId)),
	innerPosition: (windowId?: number) =>
		callPlatform<{ x: number; y: number }>('window', 'innerPosition', wid(windowId)),
	outerSize: (windowId?: number) =>
		callPlatform<{ width: number; height: number }>('window', 'outerSize', wid(windowId)),
	outerPosition: (windowId?: number) =>
		callPlatform<{ x: number; y: number }>('window', 'outerPosition', wid(windowId)),
	/** 0 clears the constraint. Unsupported on some backends. */
	setMinSize: (width: number, height: number, windowId?: number) =>
		callPlatform<null>('window', 'setMinSize', { width, height, ...wid(windowId) }),
	/** 0 clears the constraint. Unsupported on some backends. */
	setMaxSize: (width: number, height: number, windowId?: number) =>
		callPlatform<null>('window', 'setMaxSize', { width, height, ...wid(windowId) }),

	// ── window-scoped events (all carry `windowId` in data) ─────────
	/** Bounds stream — move/resize events from the OS. */
	onBoundsChanged: (cb: (data: WindowBounds & { windowId?: number }) => void) =>
		onPlatform('boundsChanged', cb),
	/** Fires when an OS-initiated close is suppressed by the armed veto. */
	onWillClose: (cb: (data: { windowId?: number }) => void) => onPlatform('willClose', cb),
	/** Alias for `onWillClose` — same wire event, Tauri-style name. */
	onCloseRequested: (cb: (data: { windowId?: number }) => void) =>
		onPlatform('willClose', cb),
	/** The window was closed — its native root binding is already gone. */
	onClosed: (cb: (data: { windowId?: number }) => void) => onPlatform('closed', cb),
	/** A window was created via windows.create. */
	onCreated: (cb: (data: { windowId?: number; label?: string }) => void) =>
		onPlatform('created', cb),
	/** Window gained/lost focus. */
	onFocusChanged: (cb: (data: { focused: boolean; windowId?: number }) => void) =>
		onPlatform('focusChanged', cb),
	/** Moved to a display with a different backing scale factor. */
	onScaleFactorChanged: (cb: (data: { scaleFactor: number; windowId?: number }) => void) =>
		onPlatform('scaleFactorChanged', cb),
};

// ── screen ──────────────────────────────────────────────────────────

export interface DisplayInfo {
	id: number;
	uuid: string | null;
	bounds: WindowBounds;
	workArea: WindowBounds;
	isPrimary: boolean;
}

export const screen = {
	getAllDisplays: () => callPlatform<DisplayInfo[]>('screen', 'getAllDisplays'),
	getPrimaryDisplay: () => callPlatform<DisplayInfo>('screen', 'getPrimaryDisplay'),
	getDisplayNearestWindow: () => callPlatform<DisplayInfo>('screen', 'getDisplayNearestWindow'),
	/** Global cursor position (screen coordinates). macOS only. */
	getCursorScreenPoint: () => callPlatform<{ x: number; y: number }>('screen', 'getCursorScreenPoint'),
	scaleFactor: () => callPlatform<number>('screen', 'scaleFactor'),
	/** Fires when the display set changes (attach/detach/reconfigure). */
	onDisplaysChanged: (cb: () => void) => onPlatform('displaysChanged', cb),
};

// ── clipboard ───────────────────────────────────────────────────────

export const clipboard = {
	readText: () => callPlatform<string | null>('clipboard', 'readText'),
	writeText: (text: string) => callPlatform<null>('clipboard', 'writeText', { text }),
	clear: () => callPlatform<null>('clipboard', 'clear'),
	availableFormats: () => callPlatform<string[]>('clipboard', 'availableFormats'),
	has: (format: 'text/plain' | 'image/png' | 'files' | string) =>
		callPlatform<boolean>('clipboard', 'has', { format }),
	readImage: () =>
		callPlatform<{ bytes: string; format: string } | null>('clipboard', 'readImage'),
	/** PNG bytes as base64. */
	writeImage: (pngBase64: string) =>
		callPlatform<null>('clipboard', 'writeImage', { bytes: pngBase64 }),
	readPaths: () => callPlatform<string[] | null>('clipboard', 'readPaths'),
	/** HTML markup on the clipboard, or null when absent. */
	readHtml: () => callPlatform<string | null>('clipboard', 'readHtml'),
	writeHtml: (html: string) => callPlatform<null>('clipboard', 'writeHtml', { html }),
	/** RTF markup on the clipboard, or null when absent. */
	readRtf: () => callPlatform<string | null>('clipboard', 'readRtf'),
	writeRtf: (rtf: string) => callPlatform<null>('clipboard', 'writeRtf', { rtf }),
};

// ── shell ───────────────────────────────────────────────────────────

export const shell = {
	/** http(s)/mailto/tel/sms/facetime/maps only — file: goes through openPath. */
	openExternal: (url: string) => callPlatform<null>('shell', 'openExternal', { url }),
	openPath: (path: string) => callPlatform<null>('shell', 'openPath', { path }),
	showItemInFolder: (path: string) =>
		callPlatform<null>('shell', 'showItemInFolder', { path }),
	/** Move a file or directory to the OS trash. */
	trashItem: (path: string) => callPlatform<null>('shell', 'trashItem', { path }),
	/** Play the system alert sound. */
	beep: () => callPlatform<null>('shell', 'beep'),
};

// ── dialog ──────────────────────────────────────────────────────────
// All three are genuinely async — the promise resolves when the user answers.

// `type` (not interface) — these objects are passed straight into
// callPlatform's args record and need the implicit index signature.
export type MessageBoxOptions = {
	type?: 'info' | 'warning' | 'critical';
	title?: string;
	message?: string;
	detail?: string;
	buttons?: string[];
	cancelId?: number;
};

export type DialogFilter = {
	name: string;
	extensions: string[];
};

export type OpenDialogOptions = {
	files?: boolean;
	directories?: boolean;
	multiple?: boolean;
	prompt?: string;
	filters?: DialogFilter[];
};

export type SaveDialogOptions = {
	defaultPath?: string;
	suggestedName?: string;
	filters?: DialogFilter[];
};

export const dialog = {
	showMessageBox: (options: MessageBoxOptions | string) =>
		callPlatform<{ response: number; canceled: boolean }>(
			'dialog',
			'showMessageBox',
			typeof options === 'string' ? { message: options } : options,
		),
	showOpenDialog: (options: OpenDialogOptions = {}) =>
		callPlatform<{ canceled: boolean; paths: string[] }>('dialog', 'showOpenDialog', options),
	showSaveDialog: (options: SaveDialogOptions = {}) =>
		callPlatform<{ canceled: boolean; path: string | null }>('dialog', 'showSaveDialog', options),
};

// ── theme ───────────────────────────────────────────────────────────

export type AppearanceName = 'light' | 'dark' | 'vibrantLight' | 'vibrantDark';
export type AppearancePreference = AppearanceName | 'system';

export interface ThemeInfo {
	appearance: AppearanceName;
	dark: boolean;
}

export const theme = {
	get: () => callPlatform<ThemeInfo>('theme', 'get'),
	set: (appearance: AppearancePreference) => callPlatform<ThemeInfo>('theme', 'set', { appearance }),
	shouldUseDarkColors: () => callPlatform<boolean>('theme', 'shouldUseDarkColors'),
	onChange: (cb: (info: ThemeInfo) => void) => onPlatform('appearanceChanged', cb),
};

// ── system ──────────────────────────────────────────────────────────

export interface SystemInfo {
	os: string;
	family: string;
	arch: string;
	keyboardLayout: string;
}

export interface AccentColor {
	r: number;
	g: number;
	b: number;
	a: number;
}

export interface AccessibilityInfo {
	reduceMotion: boolean;
	highContrast: boolean;
	differentiateWithoutColor: boolean;
	reduceTransparency: boolean;
}

export type PermissionName =
	| 'accessibility'
	| 'screenRecording'
	| 'notifications'
	| 'fullDiskAccess'
	| 'camera'
	| 'microphone';

/** Resolved permission state. `unsupported` is an error code (the promise
 *  rejects with NativeApiError), never a resolved status. */
export type PermissionStatus = 'granted' | 'denied' | 'notDetermined' | 'unknown';

export type SettingsPane =
	| 'privacy-accessibility'
	| 'privacy-screenCapture'
	| 'privacy-fullDiskAccess'
	| 'privacy-camera'
	| 'privacy-microphone'
	| 'notifications';

export const system = {
	info: () => callPlatform<SystemInfo>('system', 'info'),
	getKeyboardLayout: () => callPlatform<{ name: string }>('system', 'getKeyboardLayout'),
	/** OS accent color (0–1 float channels, sRGB). */
	getAccentColor: () => callPlatform<AccentColor>('system', 'getAccentColor'),
	/** OS accessibility preferences snapshot. */
	getAccessibility: () => callPlatform<AccessibilityInfo>('system', 'getAccessibility'),
	/** Query a macOS permission/TCC status without prompting. */
	checkPermission: (name: PermissionName) =>
		callPlatform<{ status: PermissionStatus }>('system', 'checkPermission', { name }),
	/** Prompt for the permission where the OS supports it; resolves to the status. */
	requestPermission: (name: PermissionName) =>
		callPlatform<{ status: PermissionStatus; note?: string }>(
			'system',
			'requestPermission',
			{ name },
		),
	/** Open System Settings to the relevant privacy pane. */
	openSettings: (pane: SettingsPane) =>
		callPlatform<{ opened: boolean }>('system', 'openSettings', { pane }),
	onKeyboardLayoutChange: (cb: () => void) => onPlatform('keyboardLayoutChanged', cb),
};

// ── power ───────────────────────────────────────────────────────────

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export interface BatteryInfo {
	/** 0-100, or null when no battery / level unknown. */
	percent: number | null;
	charging: boolean;
	/** On AC/external power. */
	external: boolean;
}

export type SleepBlockType = 'system' | 'display' | 'idle';

/** Handle from power.acquireSleepBlocker — `await using` unblocks on dispose. */
export class SleepBlocker {
	constructor(
		readonly id: number,
		private readonly onDispose: () => Promise<unknown>,
	) {}
	#disposing?: Promise<void>;
	async [Symbol.asyncDispose](): Promise<void> {
		// Memoized — a second dispose is a no-op rather than a failed
		// double-release against the native side.
		this.#disposing ??= this.onDispose().then(() => undefined);
		await this.#disposing;
	}
}

export const power = {
	getThermalState: () => callPlatform<{ state: ThermalState }>('power', 'getThermalState'),
	/** Seconds since the last global input event. macOS only. */
	getSystemIdleTime: () => callPlatform<number>('power', 'getSystemIdleTime'),
	/** Battery snapshot — percent is null on battery-less machines. */
	getBattery: () => callPlatform<BatteryInfo>('power', 'getBattery'),
	/** Prevent sleep; resolves to a blocker id for unblockSleep. */
	blockSleep: (options: { type: SleepBlockType; reason?: string }) =>
		callPlatform<{ id: number }>('power', 'blockSleep', options),
	unblockSleep: (id: number) => callPlatform<null>('power', 'unblockSleep', { id }),
	/** blockSleep() + a disposable handle for `await using`. */
	acquireSleepBlocker: async (options: {
		type: SleepBlockType;
		reason?: string;
	}): Promise<SleepBlocker> => {
		const { id } = await power.blockSleep(options);
		return new SleepBlocker(id, () => power.unblockSleep(id));
	},
	onSystemWake: (cb: () => void) => onPlatform('systemWake', cb),
	onSystemSleep: (cb: () => void) => onPlatform('systemSleep', cb),
	onScreenLocked: (cb: () => void) => onPlatform('screenLocked', cb),
	onScreenUnlocked: (cb: () => void) => onPlatform('screenUnlocked', cb),
	onThermalStateChange: (cb: () => void) => onPlatform('thermalStateChanged', cb),
};

// ── secureStorage ───────────────────────────────────────────────────
// macOS Keychain via the platform credential APIs. Entries are keyed by
// (service, account); never a plaintext fallback.

export const secureStorage = {
	setPassword: (service: string, account: string, password: string) =>
		callPlatform<null>('secureStorage', 'setPassword', { service, account, password }),
	/** Resolves to the stored password, or null when no entry exists. */
	getPassword: (service: string, account: string) =>
		callPlatform<string | null>('secureStorage', 'getPassword', { service, account }),
	deletePassword: (service: string, account: string) =>
		callPlatform<null>('secureStorage', 'deletePassword', { service, account }),
	/** Biometric/passcode prompt (macOS LAContext) gating secret access. */
	authenticate: (reason?: string) =>
		callPlatform<{ authenticated: boolean; reason?: string }>(
			'secureStorage',
			'authenticate',
			{ reason },
		),
};

// ── notifications ───────────────────────────────────────────────────

export interface NotificationAction {
	id: string;
	label: string;
}

export const notifications = {
	show: (options: {
		title: string;
		body?: string;
		tag?: string;
		actions?: NotificationAction[];
	}) => callPlatform<{ tag: string }>('notifications', 'show', options),
	dismiss: (tag: string) => callPlatform<null>('notifications', 'dismiss', { tag }),
	/** Alias of `system.checkPermission('notifications')` — `unavailable`
	 *  on unbundled binaries (UNUserNotificationCenter needs a bundle id). */
	getPermissionStatus: () =>
		callPlatform<{ status: PermissionStatus }>('notifications', 'getPermissionStatus'),
	/** Alias of `system.requestPermission('notifications')`. */
	requestPermission: () =>
		callPlatform<{ status: PermissionStatus }>('notifications', 'requestPermission'),
	/** actionId is null when the user clicked the notification body. */
	onResponse: (cb: (data: { tag: string; actionId: string | null }) => void) =>
		onPlatform('notificationResponse', cb),
};

// ── deepLink ────────────────────────────────────────────────────────

export const deepLink = {
	/** Register a custom URL scheme at runtime (packaged apps should also
	 *  declare it in the bundle manifest). */
	register: (scheme: string) => callPlatform<{ scheme: string }>('deepLink', 'register', { scheme }),
	onOpen: (cb: (data: { urls: string[] }) => void) => onPlatform('openUrls', cb),
};

// ── menu ────────────────────────────────────────────────────────────

/** Well-known item roles; the backend also accepts any string it knows.
 * Coverage is context-dependent: app/dock menus (setAppMenu/setDockMenu)
 * map a subset via gpui actions, tray/popup NSMenuItems map a different
 * subset via responder-chain selectors — unknown roles reject
 * `invalid_args`. Edit roles (cut/copy/paste/selectAll/undo/redo) are the
 * portable core. */
export type MenuItemRole =
	| 'about' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle'
	| 'selectAll' | 'delete' | 'minimize' | 'close' | 'quit' | 'hide' | 'hideOthers'
	| 'reload' | 'toggleDevTools' | 'resetZoom' | 'zoomIn' | 'zoomOut'
	| 'toggleFullscreen' | 'front' | 'zoom' | 'window' | 'help'
	| 'appMenu' | 'fileMenu' | 'editMenu' | 'viewMenu' | 'windowMenu'
	| (string & {});

/**
 * AppKit `NSImageName*` vocabulary for `{icon:{native}}` — the native match
 * is case-insensitive; these are the canonical lowercase spellings:
 *
 *   actiontemplate add advanced bluetooth bonjour bookmarks caution color
 *   colorpanel columnview computer enterfullscreen everyone exitfullscreen
 *   folder folderburnable foldersmart followlinkfreestandingtemplate
 *   fontpanel freestandingtemplate goleft goright home ichattheater
 *   invaliddatafreestanding leftfacingtriangle listview locklocked
 *   lockunlocked me menumixedstate mobileme multipledocuments network
 *   noaccounts openpanel preferencesgeneral quicklook refresh
 *   refreshfreestanding remove reveal revealfreestanding
 *   rightfacingtriangle share slideshow smartbadge statusavailable
 *   statusnone statuspartiallyavailable statusunavailable stopprogress
 *   stopprogressfreestanding trashempty trashfull user useraccounts
 *   usergroup userguest
 */
export const NATIVE_ICON_NAMES = [
	'actiontemplate', 'add', 'advanced', 'bluetooth', 'bonjour', 'bookmarks',
	'caution', 'color', 'colorpanel', 'columnview', 'computer',
	'enterfullscreen', 'everyone', 'exitfullscreen', 'folder',
	'folderburnable', 'foldersmart', 'followlinkfreestandingtemplate',
	'fontpanel', 'freestandingtemplate', 'goleft', 'goright', 'home',
	'ichattheater', 'invaliddatafreestanding', 'leftfacingtriangle',
	'listview', 'locklocked', 'lockunlocked', 'me', 'menumixedstate',
	'mobileme', 'multipledocuments', 'network', 'noaccounts', 'openpanel',
	'preferencesgeneral', 'quicklook', 'refresh', 'refreshfreestanding',
	'remove', 'reveal', 'revealfreestanding', 'rightfacingtriangle', 'share',
	'slideshow', 'smartbadge', 'statusavailable', 'statusnone',
	'statuspartiallyavailable', 'statusunavailable', 'stopprogress',
	'stopprogressfreestanding', 'trashempty', 'trashfull', 'user',
	'useraccounts', 'usergroup', 'userguest',
] as const;
export type NativeIconName = (typeof NATIVE_ICON_NAMES)[number];

/** Tray/menu item icon — a named native image or a file path. */
export type MenuItemIcon = { native: NativeIconName } | { path: string };

/** Component-facing icon shorthand: a native image name ('add'), a file
 *  path ('./tray.png' — any string containing `/ \ . : ~` resolves as a
 *  path), or the explicit {native}/{path} forms. */
export type IconSource = NativeIconName | MenuItemIcon | (string & {});

export interface MenuItemSpec {
	type?: 'action' | 'separator' | 'submenu';
	/** For action items — reported back in the `menuAction` event. */
	id?: string;
	label?: string;
	submenu?: MenuItemSpec[];
	checked?: boolean;
	disabled?: boolean;
	/** OS-provided standard item (copy/quit/hide/…). */
	role?: MenuItemRole;
	icon?: MenuItemIcon;
}

export interface MenuSpec {
	name: string;
	items: MenuItemSpec[];
}

// `type` (not interface) — assignable to callPlatform's args record.
export type MenuItemUpdate = {
	id: string;
	text?: string;
	enabled?: boolean;
	checked?: boolean;
	accelerator?: string;
};

/** Runtime state of a single menu item (from menu.get / menu.items). */
export interface MenuItemState {
	id?: string;
	/** `{"separator":true}` items carry no other fields. */
	separator?: boolean;
	text?: string;
	enabled?: boolean;
	checked?: boolean;
	submenu?: MenuItemState[];
}

/** menu.get always reports the queried item's id. */
export interface MenuItemInfo extends MenuItemState {
	id: string;
}

export const menu = {
	setAppMenu: (menus: MenuSpec[]) => callPlatform<null>('menu', 'setAppMenu', { menus }),
	/** Insert one top-level entry into the menu bar without replacing the
	 *  existing menus. With `items` the entry drops a submenu (same spec as
	 *  setAppMenu items — ids fire `menuAction`); without `items` it is a
	 *  clickable bar item firing `menuAction` with `id` (or `name`).
	 *  `index` positions it — absent, it lands before the "Window" menu.
	 *  Re-inserting the same `name` replaces the entry. */
	insert: (options: {
		name: string;
		items?: MenuItemSpec[];
		icon?: MenuItemIcon;
		/** Clickable bar items only — reported back as the menuAction id. */
		id?: string;
		index?: number;
	}) => callPlatform<{ inserted: boolean; name: string }>('menu', 'insert', options),
	/** Drop a top-level bar entry by name — inserted or gpui-built. */
	remove: (name: string) =>
		callPlatform<{ removed: boolean; name: string }>('menu', 'remove', { name }),
	setDockMenu: (items: MenuItemSpec[]) =>
		callPlatform<null>('menu', 'setDockMenu', { items }),
	addRecentDocument: (path: string) =>
		callPlatform<null>('menu', 'addRecentDocument', { path }),
	/** Show a context menu at the given top-left-origin screen position (or the
	 * cursor). Always resolves `{dismissed:true}` — AppKit can't distinguish a
	 * pick from a dismissal; the `menuAction` event is the selection signal. */
	popup: (options: { items: MenuItemSpec[]; x?: number; y?: number }) =>
		callPlatform<{ dismissed: boolean }>('menu', 'popup', options),
	/** Patch fields of an existing item (created via setAppMenu/setDockMenu). */
	update: (update: MenuItemUpdate) => callPlatform<null>('menu', 'update', update),
	/** Current state of one item — null when the id is unknown. */
	get: (id: string) => callPlatform<MenuItemInfo | null>('menu', 'get', { id }),
	/** Snapshot of every item in the app menu. */
	items: () => callPlatform<MenuItemState[]>('menu', 'items'),
	/** Fires when a menu item created via setAppMenu/setDockMenu is activated. */
	onAction: (cb: (data: { id: string }) => void) => onPlatform('menuAction', cb),
};

// ── tray ────────────────────────────────────────────────────────────
// System tray / status-bar item with an optional dropdown menu.

// `type` (not interface) — object type literals get an implicit index
// signature, keeping TrayOptions assignable to callPlatform's args record.
export type TrayOptions = {
	title?: string;
	tooltip?: string;
	/** Path to the tray icon image. */
	imagePath?: string;
	/** Native AppKit image name (`NATIVE_ICON_NAMES`) — alternative to a
	 *  file icon; renders as a template by default. */
	imageName?: NativeIconName;
	/** Same icon sources as menu items — {native:name} or {path:file}. A
	 *  string icon resolves by shape: path-looking → file, bare word →
	 *  native name. */
	icon?: MenuItemIcon;
	/** Dot composited onto the icon's top-right corner — any color string the
	 *  native parser accepts (`#hex`, `rgb()`, named colors). `null` clears. */
	badgeColor?: string | null;
	menu?: { items: MenuItemSpec[] };
};

/** trayClick payload — the icon's screen rect when the platform reports it. */
export type TrayClickRect = {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
};

/** Handle from tray.acquire — `await using` removes the tray item on dispose. */
export class TrayHandle {
	constructor(private readonly onDispose: () => Promise<unknown>) {}
	#disposing?: Promise<void>;
	async [Symbol.asyncDispose](): Promise<void> {
		this.#disposing ??= this.onDispose().then(() => undefined);
		await this.#disposing;
	}
}

export const tray = {
	set: (options: TrayOptions) => callPlatform<{ set: boolean }>('tray', 'set', options),
	remove: () => callPlatform<{ removed: boolean }>('tray', 'remove'),
	isSet: () => callPlatform<boolean>('tray', 'isSet'),
	/** set() + a disposable handle — `await using h = await tray.acquire(opts)`. */
	acquire: async (options: TrayOptions): Promise<TrayHandle> => {
		await tray.set(options);
		return new TrayHandle(() => tray.remove());
	},
	/** Fires when the tray icon is clicked. */
	onClick: (cb: (data: TrayClickRect) => void) => onPlatform('trayClick', cb),
};

// ── shortcuts ───────────────────────────────────────────────────────
// Global (OS-wide) hotkeys. register returns the effective id — pass your
// own `id` or take the generated one.

/**
 * Handle from shortcuts.acquire — `await using` unregisters on dispose:
 * `await using reg = await shortcuts.acquire({ accelerator: 'CmdOrCtrl+K' })`.
 */
export class ShortcutRegistration {
	constructor(
		readonly id: string,
		private readonly onDispose: () => Promise<unknown>,
	) {}
	#disposing?: Promise<void>;
	async [Symbol.asyncDispose](): Promise<void> {
		this.#disposing ??= this.onDispose().then(() => undefined);
		await this.#disposing;
	}
}

export const shortcuts = {
	register: (options: { accelerator: string; id?: string }) =>
		callPlatform<{ id: string }>('shortcuts', 'register', options),
	unregister: (options: { id: string }) =>
		callPlatform<{ unregistered: boolean }>('shortcuts', 'unregister', options),
	/** Resolves the count of registrations removed. */
	unregisterAll: () => callPlatform<{ unregistered: number }>('shortcuts', 'unregisterAll'),
	isRegistered: (id: string) => callPlatform<boolean>('shortcuts', 'isRegistered', { id }),
	/** register() + a disposable handle for `await using`. */
	acquire: async (options: { accelerator: string; id?: string }): Promise<ShortcutRegistration> => {
		const { id } = await shortcuts.register(options);
		return new ShortcutRegistration(id, () => shortcuts.unregister({ id }));
	},
	/** Fires when a registered global shortcut is pressed. */
	onPressed: (cb: (data: { id: string }) => void) => onPlatform('shortcutPressed', cb),
	/** Fires when a registered global shortcut is released. */
	onReleased: (cb: (data: { id: string }) => void) => onPlatform('shortcutReleased', cb),
};

// ── capture ─────────────────────────────────────────────────────────

export type CaptureSourceType = 'display' | 'window' | 'application';

export interface CaptureSource {
	id: number;
	label: string | null;
	isMain: boolean | null;
	resolution: { width: number; height: number };
}

/** Still frame of a capture source — PNG bytes as base64. */
export interface CapturedImage {
	width: number;
	height: number;
	pngBase64: string;
}

export const capture = {
	isSupported: () => callPlatform<{ supported: boolean }>('capture', 'isSupported'),
	/** List capturable sources; `types` filters (default: every kind). */
	getSources: (options: { types?: CaptureSourceType[] } = {}) =>
		callPlatform<CaptureSource[]>('capture', 'getSources', options),
	/** Grab one frame — rejects `unavailable` when the source can't be captured. */
	captureSource: (id: number) =>
		callPlatform<CapturedImage>('capture', 'captureSource', { id }),
};

// ── diagnostics ─────────────────────────────────────────────────────

export interface DiagnosticsInfo {
	pid: number;
	uptimeSeconds: number;
	os: string;
	family: string;
	arch: string;
	renderer: string;
	rendererVersion: string;
}

export const diagnostics = {
	info: () => callPlatform<DiagnosticsInfo>('diagnostics', 'info'),
};

// ── capabilities ────────────────────────────────────────────────────
// Machine-readable per-op truth table for the running platform.

export interface CapabilitiesReport {
	platform: string;
	arch: string;
	services: Record<string, Record<string, string>>;
}

export const capabilities = {
	describe: () => callPlatform<CapabilitiesReport>('capabilities', 'describe'),
};

// ── updater ─────────────────────────────────────────────────────────
// Signed self-update: checkUpdate is a direct napi export (no UI thread
// needed), so this service wraps the module function rather than the bus.

export interface UpdateEndpoints {
	/** Feed URLs; `{{target}}`, `{{arch}}`, `{{current_version}}` are filled. */
	endpoints: string[];
	/** Minisign public key from `cargo packager signer generate`. */
	pubkey: string;
	headers?: { name: string; value: string }[];
	timeoutMs?: number;
	installerArgs?: string[];
	installMode?: 'passive' | 'quiet' | 'basicUi';
}

export interface AvailableUpdate {
	readonly currentVersion: string;
	readonly version: string;
	readonly notes: string | null;
	readonly date: string | null;
	readonly downloadUrl: string;
	readonly format: string;
	/** Download, verify the signature, and swap the app. Quit afterwards. */
	downloadAndInstall(): Promise<void>;
}

interface UpdaterModule {
	checkUpdate(
		currentVersion: string,
		options: {
			endpoints: string[];
			pubkey: string;
			headers?: { name: string; value: string }[];
			timeoutMs?: number;
			installerArgs?: string[];
			installMode?: string;
		},
	): Promise<AvailableUpdate | null>;
}

export const updater = {
	/**
	 * Query the update feed. Resolves to null when already current.
	 * Throws NativeApiError('unavailable') when the binding lacks the updater.
	 * Bypasses `platform.allow` — it's a direct napi import, not a service op.
	 */
	async check(currentVersion: string, options: UpdateEndpoints): Promise<AvailableUpdate | null> {
		const mod = await import('@gpuix/native')
			.catch(() => null) as unknown as UpdaterModule | null;
		if (typeof mod?.checkUpdate !== 'function') {
			const { NativeApiError } = await import('./bus');
			throw new NativeApiError('unavailable', 'this build does not include the updater');
		}
		return mod.checkUpdate(currentVersion, {
			endpoints: options.endpoints,
			pubkey: options.pubkey,
			headers: options.headers,
			timeoutMs: options.timeoutMs,
			installerArgs: options.installerArgs,
			installMode: options.installMode,
		});
	},
};
