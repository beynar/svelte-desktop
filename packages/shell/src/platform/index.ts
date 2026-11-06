/**
 * Typed platform API surface. Each namespace maps to a `service` in the
 * brokered dispatch (native/src/platform.rs). All calls are async; failures
 * reject with `NativeApiError` carrying a typed `code` — `unsupported` means
 * the op is not implementable on this OS through the current backend.
 */
import { callPlatform, onPlatform, NativeApiError, reducesMotion } from './bus';
import { webContent } from './web-content';
export type { ContentRule, UserScript, NavigationRequest, NavigationPolicy } from './web-content';
export { protocol, type ProtocolHandler } from './protocol';
import { webPolicy } from './web-policy';
export type { WebPermission, WebPermissionDecision, WebPermissionRequest, WebPermissionRecord, ClientIdentity, AuthChallenge, AuthChallengeAnswer, PermissionHandler, AuthChallengeHandler } from './web-policy';
import { appLifecycle } from './app-lifecycle';
import { windowTransitions } from './windows-events';
export type { WindowTransition, WindowFullscreenTransition, WindowTransitionEvents } from './windows-events';
import { input } from './input';
import { clipboardData } from './clipboard-data';
export type { InputModifier, InputShortcut, InputPolicy, BeforeInputEvent } from './input';
export type { ClipboardData, ClipboardRead } from './clipboard-data';
export type { QuitRequest, QuitDecision, QuitReason } from './app-lifecycle';

export {
	NativeApiError, initPlatform, initPlatformForTests, onPlatform, oncePlatform,
	onAnyPlatform, emitTo, onWindow, onPlatformReady, platformReady,
	platformReady as isNative,
	Channel, PlatformTransport, mockPlatform,
} from './bus';
export type { PlatformErrorCode, PlatformInitOptions } from './bus';
export { oauth, OAuthError, type AuthorizeOptions, type AuthorizeResult, type ExchangeOptions } from './oauth';
export { LogicalPosition, PhysicalPosition, LogicalSize, PhysicalSize } from './dpi';
export type { Position, Size } from './dpi';
export { downloads } from './downloads';
export type { DownloadState, DownloadRecord, DownloadRequest, DownloadDecision } from './downloads';
export { files } from './files';
export type { BookmarkAccess } from './files';
export { sessions } from './sessions';
export type { SessionInfo, SessionCookie, CookieFilter, CookieSetOptions, CookieChangedEvent, SessionProxy, SessionProxyInfo, SessionCapabilities } from './sessions';

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

/** One of the app's processes (app.metrics). */
export type ProcessMetrics = {
	pid: number;
	/** main: the shell (UI thread and the server's Worker). webview: a WebKit content process (a
	 *  window's page, a kept-alive tab, a popover). python: the Python process. helper: the app's
	 *  own executable again (a service, a job). child: another process it started (a sidecar…). */
	type: 'main' | 'webview' | 'python' | 'helper' | 'child';
	name: string;
	/** The window whose page this content process draws (webview, macOS). */
	windowId?: number;
	/** Bytes. footprint: the memory macOS counts for it (Activity Monitor's Memory); on Linux, its private pages and swap. */
	memory: { footprint: number; resident: number };
	/** time: CPU seconds used so far. percent: of one core since the previous call (null the first time). */
	cpu: { time: number; percent: number | null };
};
export type AppMetrics = { processes: ProcessMetrics[]; memory: { footprint: number } };

/** Launch at login (app.getLoginItem, app.setLoginItem). */
export type LoginItem = {
	/** Whether this build can set it: false in `vite dev`, where the other fields are false too. */
	available: boolean;
	/** The app launches at login. */
	enabled: boolean;
	/** The user turned it off in the system's settings, and only they can turn it on again:
	 *  system.openSettings('loginItems'). macOS and Windows. */
	requiresApproval: boolean;
	/** This launch came from the login item: start out of the way (no window, the menu bar). */
	launchedAtLogin: boolean;
};

export const app = {
	/** Memory and CPU of the app's processes: the shell, each web view's content process, the
	 *  Python process, services, jobs and sidecars (macOS, Linux). Call it twice for CPU percentages. */
	metrics: () => callPlatform<AppMetrics>('app', 'metrics'),
	...appLifecycle,
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
	clearRecentDocuments: () => callPlatform<null>('app', 'clearRecentDocuments'),
	/** macOS Dock tile badge text; null clears it. On Linux the launcher entry's count: false for anything but a number. */
	setDockBadge: (text: string | null) =>
		callPlatform<boolean>('app', 'setDockBadge', { text }),
	getDockBadge: () => callPlatform<string | null>('app', 'getDockBadge'),
	/** macOS Dock icon, Linux windows' icon: an image path or native icon name; null restores the bundle's. */
	setDockIcon: (icon: IconSource | null) => callPlatform<null>('app', 'setDockIcon', { icon }),
	/** What setDockIcon set; null with the bundle's. */
	getDockIcon: () => callPlatform<IconSource | null>('app', 'getDockIcon'),
	/** Bounce the Dock icon (macOS), flash the taskbar (Windows), the window's urgency hint (Linux). */
	bounceDock: (type: DockBounceType) => callPlatform<boolean>('app', 'bounceDock', { type }),
	/** Launch at login: whether it's on, and whether this launch came from it. */
	getLoginItem: () => callPlatform<LoginItem>('app', 'getLoginItem'),
	/** Turns launch at login on or off; resolves to the state after. Does nothing where it's not
	 *  available (`vite dev`). */
	setLoginItem: (enabled: boolean) => callPlatform<LoginItem>('app', 'setLoginItem', { enabled }),
	/** macOS activation policy — 'accessory' hides the Dock icon. Linux: skip-taskbar and skip-pager on the app's windows. */
	setActivationPolicy: (policy: ActivationPolicy) =>
		callPlatform<boolean>('app', 'setActivationPolicy', { policy }),
	/** 'regular' on Windows, which has no other. */
	getActivationPolicy: () => callPlatform<ActivationPolicy>('app', 'getActivationPolicy'),
	/** Acquire the single-instance lock; `acquired:false` means another
	 *  instance holds it (second instances should quit). */
	requestSingleInstanceLock: () =>
		callPlatform<{ acquired: boolean }>('app', 'requestSingleInstanceLock'),
	/** Dock or taskbar progress bar, the launcher entry's on Linux; `{status:'none'}` clears it. */
	setDockProgress: (progress: DockProgress) =>
		callPlatform<null>('app', 'setDockProgress', progress),
	getDockProgress: () => callPlatform<DockProgress>('app', 'getDockProgress'),
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

/** Liquid Glass behind the page (macOS 26; see windows.setGlass). */
export type GlassOptions = {
	/** 'regular' (default): frosted, readable over anything. 'clear': more transparent. */
	style?: 'regular' | 'clear';
	/** A tint over the glass: '#rgb', '#rrggbb' or '#rrggbbaa' (the alpha is its strength). */
	tint?: string;
	/** Rounds the glass's corners, in points. Default 0 (the window's own corners still apply). */
	cornerRadius?: number;
};

/** A macOS vibrancy material: what shows where the page paints no background (see windows.setVibrancy). */
export type VibrancyMaterial =
	| 'sidebar'
	| 'titlebar'
	| 'header'
	| 'content'
	| 'window'
	| 'underWindow'
	| 'underPage'
	| 'menu'
	| 'popover'
	| 'sheet'
	| 'hud'
	| 'tooltip'
	| 'fullscreenUI'
	| 'selection';
/** 'followsWindow' (default): dimmed while the window isn't active, as the system does. */
export type VibrancyState = 'followsWindow' | 'active' | 'inactive';

/** Per-window NSAppearance — narrower than the app-level AppearancePreference. */
export type WindowTheme = 'light' | 'dark' | 'system';

/** Options for windows.create — every field optional. */
/** How a window comes in when it shows — at launch, window.create, window.show (macOS; elsewhere
 *  it shows at once). `true` is the default one: 180 ms, ease out, from 10 points above, faded. */
export type WindowAnimation = {
	/** In ms (default 180; 0: no animation). */
	duration?: number;
	/** 'easeOut' (default), 'easeIn', 'easeInOut', 'linear', or cubic-bezier control points. */
	easing?: 'easeOut' | 'easeIn' | 'easeInOut' | 'linear' | [x1: number, y1: number, x2: number, y2: number];
	/** Where it starts from its place, in points, y down (default { x: 0, y: -10 }: 10 above). */
	offset?: { x?: number; y?: number };
	/** Its size at the start, around its middle (default 1; 0.96: grows a little). The page is
	 *  resized while it runs: keep it short. */
	scale?: number;
	/** Its opacity at the start (default 0). */
	opacity?: number;
};

export type WindowCreateOptions = {
	/** macOS: a child follows its parent; modal children are native sheets. */
	parentId?: number;
	modal?: boolean;
	type?: 'normal' | 'panel';
	focusable?: boolean;
	session?: string;
	recovery?: WebviewRecovery;
	/** Unique per app — a duplicate label rejects `invalid_args`. */
	label?: string;
	/** The app route to open (default '/'), signed in like the main window. */
	path?: string;
	/** Open this URL instead of an app route (another origin gets no native bridge). */
	url?: string;
	/** Or this HTML document. */
	html?: string;
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
	/** Come in animated when it shows: `true` (fades and slides down into place) or your own. */
	animate?: boolean | WindowAnimation;
	/** Transparent window background (content must paint its own chrome). */
	transparent?: boolean;
	/** Window alpha 0–1, applied before the first presented frame — `0`
	 *  stages a window invisible while keeping it on a screen (positioning
	 *  ops still work). Restore later with `windows.setOpacity`. */
	opacity?: number;
	/** Titlebar blends into content (macOS). */
	titlebarTransparent?: boolean;
	/** Vibrancy behind the page (macOS): it shows where the page paints no background. */
	vibrancy?: VibrancyMaterial;
	vibrancyState?: VibrancyState;
	/** The traffic lights at your own place (macOS, title bar hidden or hiddenInset): the close button's
	 *  top-left, in points from the window's top-left — for a taller custom title bar. */
	trafficLightPosition?: { x: number; y: number };
	/** Width / height kept while resizing (16/9, 1 for a square). */
	aspectRatio?: number;
	/** false: the page runs at full speed when hidden or covered (timers, audio, sockets). Default true. */
	backgroundThrottling?: boolean;
	/** Native tab group name — same id groups windows as tabs (macOS). */
	tabbingIdentifier?: string;
};

/** One row of windows.list()/get(). `windowId` 0 is the primary window. */
export interface WindowInfo {
	/** macOS relationship and class policy (absent on other backends). */
	parentId?: number | null;
	modal?: boolean;
	type?: 'normal' | 'panel';
	focusable?: boolean;
	windowId: number;
	/** Whether AppKit has presented this modal child as a sheet. */
	sheetAttached?: boolean;
	label: string;
	focused: boolean;
	/** On screen (not hidden or minimized away). */
	visible: boolean;
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
	...windowTransitions,
	// ── multi-window ──────────────────────────────────────────────
	/** Open another window on an app route (`path`). Labels are unique
	 *  (duplicate → `invalid_args`). */
	create: (options: WindowCreateOptions = {}) =>
		callPlatform<{ windowId: number; label: string }>('window', 'create', options),
	/** This page's own window (or `windowId`'s): its id, label, focus and bounds. */
	getInfo: (windowId?: number) => callPlatform<WindowInfo>('window', 'getInfo', wid(windowId)),
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
	/** The page's area, without the title bar. */
	getContentSize: (windowId?: number) =>
		callPlatform<{ width: number; height: number }>('window', 'getContentSize', wid(windowId)),
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
	/** Bring the window to the front and make the app active, as far as macOS allows (another app may
	 *  keep the front): `activated` says whether the app is active now. */
	focus: (windowId?: number) => callPlatform<{ activated: boolean } | null>('window', 'focus', wid(windowId)),
	/** Bounce/flash the platform attention affordance (Dock bounce on macOS). */
	requestAttention: (windowId?: number) =>
		callPlatform<null>('window', 'requestAttention', wid(windowId)),
	/** Associates a file with the window (macOS titlebar document icon). */
	setRepresentedFilename: (path: string | null, windowId?: number) =>
		callPlatform<null>('window', 'setRepresentedFilename', { path, ...wid(windowId) }),
	getRepresentedFilename: (windowId?: number) => callPlatform<string | null>('window', 'getRepresentedFilename', wid(windowId)),
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
	hasCloseVeto: (windowId?: number) => callPlatform<boolean>('window', 'hasCloseVeto', wid(windowId)),

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
	isAlwaysOnBottom: (windowId?: number) => callPlatform<boolean>('window', 'isAlwaysOnBottom', wid(windowId)),
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
	hasDecorations: (windowId?: number) => callPlatform<boolean>('window', 'hasDecorations', wid(windowId)),
	/** frameless: the window has no system title bar at all (decorations off). */
	getTitleBarStyle: (windowId?: number) =>
		callPlatform<{ style: TitleBarStyle; frameless: boolean }>('window', 'getTitleBarStyle', wid(windowId)),
	setDecorations: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setDecorations', { enabled, ...wid(windowId) }),
	setHasShadow: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setHasShadow', { enabled, ...wid(windowId) }),
	invalidateShadow: (windowId?: number) =>
		callPlatform<null>('window', 'invalidateShadow', wid(windowId)),

	// ── appearance + behavior ───────────────────────────────────────
	/** Vibrancy behind the page (macOS), or `null` to remove it. It shows where the page paints no
	 *  background — `body { background: transparent }`, a transparent sidebar — and costs the page
	 *  nothing (the system draws it), unlike a CSS backdrop-filter. */
	setVibrancy: (material: VibrancyMaterial | null, options: { state?: VibrancyState } = {}, windowId?: number) =>
		callPlatform<null>('window', 'setVibrancy', { material, ...options, ...wid(windowId) }),
	/** The window's vibrancy, null without (macOS). */
	getVibrancy: (windowId?: number) =>
		callPlatform<{ material: VibrancyMaterial; state: VibrancyState } | null>('window', 'getVibrancy', wid(windowId)),
	/** Liquid Glass behind the page (macOS 26), or `null` to remove it. Like vibrancy, it shows
	 *  where the page paints no background; the window becomes non-opaque so the glass shows
	 *  what's behind it. Replaces vibrancy (one effect at a time). Resolves `{ glass: false }`
	 *  before macOS 26, where the `underWindow` vibrancy material is used instead. */
	setGlass: (glass: GlassOptions | null, windowId?: number) =>
		callPlatform<{ glass: boolean } | null>('window', 'setGlass', { glass, ...wid(windowId) }),
	/** The window's Liquid Glass, null without (macOS 26; before it, setGlass sets vibrancy). */
	getGlass: (windowId?: number) => callPlatform<GlassOptions | null>('window', 'getGlass', wid(windowId)),
	/** The traffic lights at `{ x, y }` (macOS): the close button's top-left, in points from the
	 *  window's top-left. `null`: back to the system's place. `--desktop-titlebar-height` follows. */
	setTrafficLightPosition: (position: { x: number; y: number } | null, windowId?: number) =>
		callPlatform<null>('window', 'setTrafficLightPosition', { position, ...wid(windowId) }),
	/** What setTrafficLightPosition set; null at the system's place. */
	getTrafficLightPosition: (windowId?: number) =>
		callPlatform<{ x: number; y: number } | null>('window', 'getTrafficLightPosition', wid(windowId)),
	/** Keep width / height while resizing (16/9, 1 for a square), or `null` to free it. */
	setAspectRatio: (ratio: number | null, windowId?: number) =>
		callPlatform<null>('window', 'setAspectRatio', { ratio: ratio ?? 0, ...wid(windowId) }),
	/** Width over height, null when free (macOS). */
	getAspectRatio: (windowId?: number) => callPlatform<number | null>('window', 'getAspectRatio', wid(windowId)),
	setOpacity: (opacity: number, windowId?: number) =>
		callPlatform<null>('window', 'setOpacity', { opacity, ...wid(windowId) }),
	getOpacity: (windowId?: number) =>
		callPlatform<{ opacity: number }>('window', 'getOpacity', wid(windowId)),
	setMovable: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setMovable', { enabled, ...wid(windowId) }),
	setMovableByWindowBackground: (enabled: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setMovableByWindowBackground', { enabled, ...wid(windowId) }),
	isMovableByWindowBackground: (windowId?: number) => callPlatform<boolean>('window', 'isMovableByWindowBackground', wid(windowId)),
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
	isVisibleOnAllWorkspaces: (windowId?: number) => callPlatform<boolean>('window', 'isVisibleOnAllWorkspaces', wid(windowId)),
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
		callPlatform<null>('window', 'setFocusable', { enabled, ...wid(windowId) }),
	setCursorHidden: (hidden: boolean, windowId?: number) =>
		callPlatform<null>('window', 'setCursorHidden', { hidden, ...wid(windowId) }),
	isCursorHidden: (windowId?: number) => callPlatform<boolean>('window', 'isCursorHidden', wid(windowId)),
	/** Screen coordinates — warps the OS cursor. */
	setCursorPosition: (x: number, y: number, windowId?: number) =>
		callPlatform<null>('window', 'setCursorPosition', { x, y, ...wid(windowId) }),
	/** Per-window NSAppearance override. */
	setTheme: (theme: WindowTheme, windowId?: number) =>
		callPlatform<null>('window', 'setTheme', { theme, ...wid(windowId) }),
	/** The window's own theme ('system' follows the app's). macOS and Windows. */
	getTheme: (windowId?: number) => callPlatform<WindowTheme>('window', 'getTheme', wid(windowId)),

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
	...clipboardData,
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
	/** The system share menu (macOS: AirDrop, Mail, Messages, Notes…) for text, a URL and files,
	 *  anchored on `anchor` (a rect in the page's CSS pixels, e.g. a button's getBoundingClientRect())
	 *  or at the pointer. Resolves to the service chosen, or `null` when dismissed. */
	share: (items: ShareItems, windowId?: number) =>
		callPlatform<{ service: string | null }>('shell', 'share', { ...items, anchor: items.anchor && rectOf(items.anchor), ...wid(windowId) }),
	/** Drag files out of the page to the Finder or another app (macOS). Call it in a `dragstart`
	 *  handler after `event.preventDefault()`, or on `mousedown`, while the button is down. Resolves
	 *  once dropped (or abandoned). */
	startDrag: (options: { files: string[]; icon?: string }, windowId?: number) =>
		callPlatform<{ dropped: boolean }>('shell', 'startDrag', { ...options, ...wid(windowId) }),
	/** Quick Look (macOS): the system's preview panel — the Finder's space bar — on files: images,
	 *  PDFs, videos, documents… Several paths: the arrows go through them. */
	previewFile: (paths: string | string[]) => callPlatform<null>('shell', 'previewFile', { paths }),
};

export type ShareItems = {
	text?: string;
	url?: string;
	/** Absolute paths. */
	files?: string[];
	anchor?: { x: number; y: number; width: number; height: number };
};
const rectOf = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

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
	/** macOS: bookmarks aligned with paths; useful for App Sandbox persistence. */
	securityScoped?: boolean;
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
		callPlatform<{ canceled: boolean; paths: string[]; bookmarks?: string[] }>('dialog', 'showOpenDialog', options),
	showSaveDialog: (options: SaveDialogOptions = {}) =>
		callPlatform<{ canceled: boolean; path: string | null }>('dialog', 'showSaveDialog', options),
	/** A route of the app in a sheet on the window (macOS, Linux): its page alone, shown once loaded.
	 *  Resolves with what that page passes to `dialog.close(result)`; undefined when canceled
	 *  (Escape, ⌘.). Pass data to it in the route (`/sheets/new?folder=…`).
	 *  `style`: 'sheet' (default) the system's sheet — on macOS 26 centered, the window dimmed;
	 *  'attached' slides down from under the title bar (or `top` px down the window's content),
	 *  the window left as it is, not clickable meanwhile; 'window' a small dialog window with a
	 *  title bar (`title`, else the page's), centered on the window — its close button cancels. */
	sheet: <T = unknown>(
		route: string,
		options: { width?: number; height?: number; style?: 'sheet' | 'attached' | 'window'; top?: number; title?: string } = {},
	) =>
		callPlatform<{ result: T | null }>('dialog', 'sheet', { route, ...options }).then((r) => r?.result ?? undefined),
	/** In a sheet's page: close it — `dialog.sheet` resolves with `result`. */
	close: (result?: unknown) => callPlatform<null>('dialog', 'close', { result: result ?? null }),
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
	| 'camera' | 'microphone' | 'location' | 'contacts' | 'calendars' | 'reminders' | 'photos' | 'bluetooth'
	| 'speech' | 'appleEvents' | 'notifications' | 'screenRecording' | 'accessibility' | 'inputMonitoring'
	| 'fullDiskAccess' | 'desktopFolder' | 'documentsFolder' | 'downloadsFolder';

/** Resolved permission state. `unsupported` is an error code (the promise
 *  rejects with NativeApiError), never a resolved status. */
export type PermissionStatus = 'granted' | 'denied' | 'notDetermined' | 'unknown';

export type SettingsPane =
	| 'privacy-accessibility'
	| 'privacy-screenCapture'
	| 'privacy-inputMonitoring'
	| 'privacy-fullDiskAccess'
	| 'privacy-camera'
	| 'privacy-microphone'
	| 'notifications'
	| 'loginItems';

/** An installed font family and its styles (system.fonts({ styles: true })). */
export type FontFamily = { family: string; styles: Array<{ name: string; postscriptName: string; weight: number; italic: boolean }> };

export const system = {
	info: () => callPlatform<SystemInfo>('system', 'info'),
	/** The installed font families, sorted — the names a page's CSS can use (WebKit has no Local
	 *  Font Access API). With `{ styles: true }`, each family's styles: name, CSS weight, italic. */
	fonts: ((options: { styles?: boolean } = {}) => callPlatform('system', 'fonts', options)) as {
		(options?: { styles?: false }): Promise<string[]>;
		(options: { styles: true }): Promise<FontFamily[]>;
	},
	/** Whether Touch ID (or another biometry) can be asked, and which (the prompt: secureStorage.authenticate). */
	biometrics: () => callPlatform<{ available: boolean; type: 'touchID' | 'faceID' | 'opticID' | 'none'; enrolled: boolean }>('system', 'biometrics'),
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
	/** Seconds since the last global input event. macOS, Windows, Linux on X11. */
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
	/** The system runs short of memory (macOS): free what you can. */
	onMemoryPressure: (cb: (e: { level: 'warning' | 'critical' }) => void) => onPlatform('memoryPressure', cb),
	/** Plugged in or unplugged (macOS): `{ onBattery }`. */
	onPowerSourceChange: (cb: (e: { onBattery: boolean }) => void) => onPlatform('powerSourceChanged', cb),
	/** The Mac is shutting down, restarting or logging out (macOS): save what must be saved, now. */
	onShutdown: (cb: () => void) => onPlatform('shutdown', cb),
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
	/** Touch ID prompt, the account password as a fallback unless `biometricsOnly` (macOS LAContext):
	 *  to confirm a sensitive action or gate a secret. `reason` completes "<App> is trying to …". */
	authenticate: (reason?: string, options: { biometricsOnly?: boolean } = {}) =>
		callPlatform<{ authenticated: boolean; reason?: string }>(
			'secureStorage',
			'authenticate',
			{ reason, ...options },
		),
};

// ── notifications · push ────────────────────────────────────────────

export {
	notifications, push, onNotification, openNotificationUrl,
} from './notifications';
export type {
	NotificationAction, NotificationOptions, NotificationInfo, PendingNotification, NotificationEvent,
	NotificationEventKind, NotificationShownEvent, NotificationEventMap,
	NotificationUrgency, NotificationRepeat, NotificationPermission, PushTarget, PushMessage,
} from './notifications';

// ── deepLink ────────────────────────────────────────────────────────

export const deepLink = {
	/** Make this app the handler of a custom URL scheme. macOS also needs it declared in the bundle
	 *  (desktop.config `schemes`). Does nothing in `vite dev`: registered false. */
	register: (scheme: string) => callPlatform<{ scheme: string; registered: boolean }>('deepLink', 'register', { scheme }),
	/** Whether this app opens the scheme's URLs: the user or another app can take a scheme over.
	 *  False in `vite dev`. */
	isDefault: (scheme: string) => callPlatform<boolean>('deepLink', 'isDefault', { scheme }),
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

/** Component-facing icon shorthand: a native name — AppKit ('add') or SF
 *  Symbol ('note.text') — a file path ('./tray.png': a separator, `~` or an
 *  image extension makes it a path), or the explicit {native}/{path} forms. */
export type IconSource = NativeIconName | MenuItemIcon | (string & {});

export interface MenuItemSpec {
	type?: 'action' | 'separator' | 'submenu' | 'checkbox' | 'radio';
	/** Radio groups are exclusive within their immediate parent menu (macOS). */
	group?: string;
	enabled?: boolean;
	visible?: boolean;
	tooltip?: string;
	/** For action items — reported back in the `menuAction` event. */
	id?: string;
	label?: string;
	submenu?: MenuItemSpec[];
	checked?: boolean;
	disabled?: boolean;
	/** OS-provided standard item (copy/quit/hide/…). */
	role?: MenuItemRole;
	/** Keyboard shortcut: 'CmdOrCtrl+Shift+K', named keys plus, space, tab, enter, escape, arrows, F1…. */
	accelerator?: string;
	icon?: MenuItemIcon;
}

export interface MenuSpec {
	/** Lifecycle event identity; defaults to name. */
	id?: string;
	name: string;
	items: MenuItemSpec[];
}

// `type` (not interface) — assignable to callPlatform's args record.
export type MenuItemUpdate = {
	id: string;
	visible?: boolean;
	tooltip?: string;
	text?: string;
	enabled?: boolean;
	checked?: boolean;
	accelerator?: string;
};

/** Runtime state of a single menu item (from menu.get / menu.items). */
export interface MenuItemState {
	id?: string;
	type?: MenuItemSpec['type'];
	group?: string;
	visible?: boolean;
	tooltip?: string;
	/** Separators report visibility but have no action or checked state. */
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
	/** What the app set with setAppMenu and insert; null with the default menus. */
	getAppMenu: () => callPlatform<MenuSpec[] | null>('menu', 'getAppMenu'),
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
	setDockMenu: (items: MenuItemSpec[], id = 'dock') =>
		callPlatform<null>('menu', 'setDockMenu', { items, id }),
	/** What setDockMenu set; null without one. */
	getDockMenu: () => callPlatform<MenuItemSpec[] | null>('menu', 'getDockMenu'),
	addRecentDocument: (path: string) =>
		callPlatform<null>('menu', 'addRecentDocument', { path }),
	/** Show a context menu at the given top-left-origin screen position (or the
	 * cursor). Always resolves `{dismissed:true}` — AppKit can't distinguish a
	 * pick from a dismissal; the `menuAction` event is the selection signal. */
	popup: (options: { items: MenuItemSpec[]; id?: string; x?: number; y?: number }) =>
		callPlatform<{ dismissed: boolean }>('menu', 'popup', options),
	closePopup: (id = 'context') => callPlatform<null>('menu', 'closePopup', { id }),
	/** Observational macOS lifecycle callbacks; do not synchronously delay menu opening. */
	onWillShow: (id: string, cb: () => void) => onPlatform<{ id: string }>('menuWillShow', (event) => { if (event.id === id) cb(); }),
	onDidClose: (id: string, cb: () => void) => onPlatform<{ id: string }>('menuDidClose', (event) => { if (event.id === id) cb(); }),
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
	/** Bind a popover (popover.create id): clicks toggle it natively; null unbinds. */
	popover?: string | null;
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
	/** Screen rect of the status item (top-left origin), null when unset. */
	getBounds: () => callPlatform<TrayClickRect | null>('tray', 'getBounds'),
	/** Programmatic click (refused while a menu is attached). */
	performClick: () => callPlatform<{ clicked: boolean }>('tray', 'performClick'),
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
	type: CaptureSourceType;
	label: string | null;
	isMain: boolean | null;
	resolution: { width: number; height: number };
	bundleIdentifier?: string | null;
}

/** Still frame of a capture source — PNG bytes as base64. */
export interface CapturedImage {
	width: number;
	height: number;
	pngBase64: string;
}

export const capture = {
	/** `stills`, macOS only: this version can capture stills (macOS 14+). */
	isSupported: () => callPlatform<{ supported: boolean; stills?: boolean }>('capture', 'isSupported'),
	/** List capturable sources; `types` filters (default: every kind). */
	getSources: (options: { types?: CaptureSourceType[] } = {}) =>
		callPlatform<CaptureSource[]>('capture', 'getSources', options),
	/** Grab one frame — rejects `unavailable` when the source can't be captured. */
	/** Needs the Screen Recording permission (rejects `denied`) and macOS 14 for stills. */
	captureSource: (id: number, type?: CaptureSourceType) =>
		callPlatform<CapturedImage>('capture', 'captureSource', { id, type }),
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
// The signed updater (src/updater) runs in the shell's Worker. Pages reach it
// through the shell's gated routes; server code calls it in-process. Feed URL,
// public key and channel come from the adapter's `update` option — the GPUI-era
// `UpdateEndpoints` argument is accepted for source compatibility and ignored.

export interface UpdateEndpoints {
	endpoints?: string[];
	pubkey?: string;
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
	readonly mandatory: boolean;
	/** Download, verify (ed25519 manifest + sha256), swap after quit, relaunch. */
	downloadAndInstall(): Promise<void>;
}

type UpdateInfoWire = Omit<AvailableUpdate, 'downloadAndInstall'>;

/** In the Worker the shell installs an in-process implementation here. */
const UPDATER_KEY = Symbol.for('kitop.updater');
interface InProcessUpdater {
	check(): Promise<UpdateInfoWire | null>;
	install(): Promise<void>;
}

async function updaterCall<T>(op: 'check' | 'install'): Promise<T> {
	const local = (globalThis as Record<symbol, InProcessUpdater | undefined>)[UPDATER_KEY];
	if (local) return (await local[op]()) as T;
	if (typeof location === 'undefined') {
		const { NativeApiError } = await import('./bus');
		throw new NativeApiError('unavailable', 'the updater runs inside the kitop shell');
	}
	const res = await fetch(`/__desktop/update/${op}`, { method: 'POST' });
	const body = await res.json();
	if (!res.ok) {
		const { NativeApiError } = await import('./bus');
		throw new NativeApiError(body?.code ?? 'internal', body?.message ?? `update ${op} failed`);
	}
	return body as T;
}

export const updater = {
	/** Query the signed feed. Resolves to null when already current. */
	async check(_currentVersion?: string, _options?: UpdateEndpoints): Promise<AvailableUpdate | null> {
		const info = await updaterCall<UpdateInfoWire | null>('check');
		return info && { ...info, downloadAndInstall: () => updaterCall<void>('install') };
	},
};

// ── popover ─────────────────────────────────────────────────────────
// A route of the app in a native popover (arrow, anchored) or a borderless
// translucent panel (Spotlight-like). The web view is created and loaded at
// `create` and kept warm, so `show` is instant. Inside the popover page,
// `currentPopover()` returns its id and ops default to it.

export type PopoverStyle = 'popover' | 'panel';
export type PopoverAnchor =
	| 'tray'
	| 'cursor'
	/** A rect in a window's page (CSS px, e.g. getBoundingClientRect()); the calling page by default. */
	| { x: number; y: number; width: number; height: number; windowId?: number }
	/** A rect in screen coordinates (top-left origin). */
	| { screen: { x: number; y: number; width: number; height: number } };
export type PanelPosition = 'tray' | 'trayLeft' | 'trayRight' | 'center' | 'cursor' | { x: number; y: number };

export type PopoverCreateOptions = {
	session?: string;
	recovery?: WebviewRecovery;
	id?: string;
	/** App route, e.g. '/quick' — or a full `url`. */
	route?: string;
	url?: string;
	style?: PopoverStyle;
	width?: number;
	height?: number;
	/** transient (default): closes on outside click · semitransient · manual */
	behavior?: 'transient' | 'semitransient' | 'manual';
	/** Arrow side relative to the anchor (popover style). Default 'bottom'. */
	edge?: 'top' | 'bottom' | 'left' | 'right';
	/** Panel placement. Default 'tray' (falls back to center without a tray). */
	position?: PanelPosition;
	closeOnEscape?: boolean;
	/** Activate the app on show so inputs take keystrokes (popover style). Default true. */
	activate?: boolean;
	/** Page background shows the native vibrancy. Default true. */
	transparent?: boolean;
	animate?: boolean;
	cornerRadius?: number;
	debug?: boolean;
	/** Bind to the tray button right away. */
	tray?: boolean;
	/** Load the route at create (default true): instant first open, but one WebKit
	 *  content process per popover (~30–40 MB). false: load on first open. */
	preload?: boolean;
};

export interface PopoverInfo {
	id: string;
	style: PopoverStyle;
	shown: boolean;
	width: number;
	height: number;
	url: string | null;
	ready: boolean;
}

type PopoverId = { id?: string };

export const popover = {
	// Without a word from the app, it doesn't move when the system asks for less motion.
	create: (options: PopoverCreateOptions) => callPlatform<PopoverInfo>('popover', 'create', reducesMotion() ? { animate: false, ...options } : options),
	show: (id?: string, options: { anchor?: PopoverAnchor; position?: PanelPosition } = {}) =>
		callPlatform<PopoverInfo>('popover', 'show', { id, ...options }),
	hide: (id?: string) => callPlatform<null>('popover', 'hide', { id }),
	toggle: (id?: string, options: { anchor?: PopoverAnchor; position?: PanelPosition } = {}) =>
		callPlatform<{ shown: boolean }>('popover', 'toggle', { id, ...options }),
	setSize: (size: { width?: number; height?: number } & PopoverId) =>
		callPlatform<null>('popover', 'setSize', size),
	setPosition: (position: PanelPosition, id?: string) =>
		callPlatform<null>('popover', 'setPosition', { id, position }),
	isShown: (id?: string) => callPlatform<boolean>('popover', 'isShown', { id }),
	get: (id?: string) => callPlatform<PopoverInfo>('popover', 'get', { id }),
	list: () => callPlatform<PopoverInfo[]>('popover', 'list'),
	eval: (js: string, id?: string) => callPlatform<null>('popover', 'eval', { id, js }),
	reload: (id?: string) => callPlatform<null>('popover', 'reload', { id }),
	destroy: (id?: string) => callPlatform<{ destroyed: boolean }>('popover', 'destroy', { id }),
	onReady: (cb: (data: { id: string }) => void) => onPlatform('popoverReady', cb),
	onShown: (cb: (data: { id: string }) => void) => onPlatform('popoverShown', cb),
	onHidden: (cb: (data: { id: string }) => void) => onPlatform('popoverHidden', cb),
	onResized: (cb: (data: { id: string; width: number; height: number }) => void) =>
		onPlatform('popoverResized', cb),
};

/** Inside a popover page: its id; elsewhere null. */
export function currentPopover(): { id: string } | null {
	return (globalThis as { __shellPopover?: { id: string } }).__shellPopover ?? null;
}

/** Inside a popover page: close it. */
export function closePopover(): Promise<null> {
	return popover.hide(currentPopover()?.id);
}

// ── broadcast ───────────────────────────────────────────────────────
// Page-to-page messages through native (every window, every popover, and the
// Worker's bus): the glue between a popover route and the main window.

export function broadcast(channel: string, data?: unknown): Promise<null> {
	return callPlatform<null>('events', 'emit', { channel, data: data ?? null });
}

export function onBroadcast<T = unknown>(
	channel: string,
	cb: (data: T, from: string | number) => void,
): () => void {
	return onPlatform<{ channel: string; data: T; from: string | number }>('message', (m) => {
		if (m?.channel === channel) cb(m.data, m.from);
	});
}

// ── native modules ──────────────────────────────────────────────────
// The app's own native commands: `native` from '@kitop/shell/native' (also host.native).

// ── webview ─────────────────────────────────────────────────────────
// Features of windows, popovers and embedded views. Every op targets, in order:
// `viewId`, `popoverId`, `windowId` (0 = primary), the calling page, the primary
// window. Events carry the corresponding target.
// See WEBVIEW.md.

export type WebviewTarget = { windowId?: number; popoverId?: string; viewId?: string };
export type WebviewSource = WebviewTarget;
export type WebviewRecovery = 'reload' | 'manual';
export type WebviewLifecycleEvent = WebviewTarget & { url: string; navigationId: string | null } & (
	| { type: 'navigationStarted' | 'loaded' }
	| { type: 'failed'; domain: string; code: number; message: string; provisional: boolean }
	| { type: 'terminated'; recovery: WebviewRecovery; reason: 'unknown' }
);

export type ContextMenuMode = 'default' | 'none' | 'custom';
export type ContextMenuOptions = WebviewTarget & {
	/** default: WebKit's menu · none: no menu (production default) · custom: `items`. */
	mode: ContextMenuMode;
	items?: MenuItemSpec[];
	/** Keep WebKit's Cut/Copy/Paste and spelling guesses when the click is on
	 *  editable text or a selection (none/custom). Default true. */
	editMenu?: boolean;
	/** Apply to every web view, and to the ones created later. */
	all?: boolean;
};

export type FindOptions = WebviewTarget & {
	text: string;
	backwards?: boolean;
	caseSensitive?: boolean;
	/** Default true. */
	wraps?: boolean;
};

export type PrintOptions = WebviewTarget & {
	printer?: string;
	copies?: number;
	/** One-based inclusive ranges; physical printing accepts one contiguous range. */
	pageRanges?: { from: number; to: number }[];
	/** Dimensions in points (72 points per inch), before orientation. */
	paperSize?: { width: number; height: number };
	orientation?: 'portrait' | 'landscape';
	margins?: { top: number; right: number; bottom: number; left: number };
	/** No panel: straight to the default printer (or to `pdfPath`). */
	silent?: boolean;
	/** Paginated PDF through the print system instead of a printer (implies silent). */
	pdfPath?: string;
};

export type CaptureOptions = WebviewTarget & {
	/** CSS px of the page; whole visible page by default. */
	rect?: { x: number; y: number; width: number; height: number };
	/** Output width in points (keeps the aspect ratio). */
	width?: number;
	format?: 'png' | 'jpeg';
	/** JPEG quality 0…1 (default 0.85). */
	quality?: number;
};

export interface WebviewInfo extends WebviewSource {
	url: string | null;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	zoom: number;
	userAgent: string | null;
	debug: boolean;
	fileDrop: boolean;
	contextMenu: ContextMenuMode;
	inspectable?: boolean;
	/** setBackgroundThrottling's state (macOS, Linux). */
	backgroundThrottling?: boolean;
	/** setRecovery's state (macOS, Linux). */
	recovery?: WebviewRecovery;
}

export type FileDropEvent = WebviewSource & { paths: string[]; x: number; y: number };
export type ContextMenuEvent = WebviewSource & {
	/** CSS px from the page's top-left corner. */
	x: number;
	y: number;
	linkURL?: string;
	srcURL?: string;
	selectionText?: string;
	editable: boolean;
	mode: ContextMenuMode;
};
export type JsDialogEvent = WebviewSource & {
	type: 'alert' | 'confirm' | 'prompt';
	message: string;
	defaultValue?: string;
};
type DownloadBase = WebviewSource & { id: string; url: string; path?: string };
export type DownloadStartedEvent = DownloadBase & {
	path: string;
	suggestedFilename: string;
	totalBytes: number;
	mimeType: string | null;
};
export type DownloadProgressEvent = DownloadBase & {
	receivedBytes: number;
	/** -1 when unknown. */
	totalBytes: number;
	/** 0…1, -1 when unknown. */
	fraction: number;
};
export type DownloadFinishedEvent = DownloadBase & { path: string; bytes: number };
export type DownloadFailedEvent = DownloadBase & { error: string; canceled: boolean };

// ── permissions ─────────────────────────────────────────────────────
// Declared in desktop.config.ts `permissions` (reason per permission), injected
// at build time by the Vite plugin. Some must be declared (the OS kills an app
// that asks without a usage string); the "Settings-only" ones (no grant prompt)
// get a guided flow: the right System Settings pane plus a floating panel with
// the app's icon to drag into the list.

declare const __KITOP_PERMISSIONS__: Record<string, string> | undefined;
const DECLARED: Record<string, string> = typeof __KITOP_PERMISSIONS__ === 'object' && __KITOP_PERMISSIONS__ ? __KITOP_PERMISSIONS__ : {};

/** Must be in desktop.config `permissions` before asking (usage strings / manifest entries). */
const MUST_DECLARE = new Set<string>(['camera', 'microphone', 'location', 'contacts', 'calendars', 'reminders', 'photos', 'bluetooth', 'speech', 'appleEvents', 'desktopFolder', 'documentsFolder', 'downloadsFolder']);
/** No grant prompt: only System Settings can grant them (macOS). */
const SETTINGS_ONLY = new Set<string>(['screenRecording', 'accessibility', 'inputMonitoring', 'fullDiskAccess']);
const PANES: Record<string, string> = {
	screenRecording: 'privacy-screenCapture', accessibility: 'privacy-accessibility', inputMonitoring: 'privacy-inputMonitoring',
	fullDiskAccess: 'privacy-fullDiskAccess', camera: 'privacy-camera', microphone: 'privacy-microphone', notifications: 'notifications',
};

function requireDeclared(name: string, op: string) {
	if (MUST_DECLARE.has(name) && !(name in DECLARED))
		throw new NativeApiError('undeclared', `permissions.${op}('${name}'): declare it in desktop.config.ts → permissions: { ${name}: 'why the app needs it' } (the OS requires the reason)`);
}

export const permissions = {
	/** desktop.config `permissions`: name → reason. */
	declared: (): Record<string, string> => ({ ...DECLARED }),
	/** Whether the permission can only be granted in System Settings (no prompt). */
	settingsOnly: (name: PermissionName | string) => SETTINGS_ONLY.has(name),
	async status(name: PermissionName | string): Promise<PermissionStatus> {
		const r = await callPlatform<{ status: PermissionStatus }>('system', 'checkPermission', { name });
		return r.status;
	},
	/**
	 * Ask for a permission: the system prompt when there is one; the guided flow for the
	 * Settings-only ones (unless `{ guide: false }`). Resolves with the resulting status.
	 */
	async request(name: PermissionName | string, opts: { guide?: boolean } = {}): Promise<PermissionStatus> {
		requireDeclared(name, 'request');
		if (SETTINGS_ONLY.has(name) && opts.guide !== false) return (await permissions.guide(name)).status;
		const r = await callPlatform<{ status: PermissionStatus }>('system', 'requestPermission', { name });
		return r.status;
	},
	/**
	 * The guided flow: opens the permission's System Settings pane and floats a panel next to it
	 * with the app's icon (drag it into the list) and the reason from desktop.config. Resolves when
	 * granted, or when the user dismisses the panel. Where there is no guide (other platforms), the
	 * settings page opens and the current status comes back.
	 */
	async guide(name: PermissionName | string, opts: { open?: boolean } = {}): Promise<{ status: PermissionStatus; canceled: boolean }> {
		requireDeclared(name, 'guide');
		try {
			return await callPlatform<{ status: PermissionStatus; canceled: boolean }>('permissions', 'guide', { name, reason: DECLARED[name], open: opts.open ?? true });
		} catch (e) {
			if (!(e instanceof NativeApiError) || (e.code !== 'unknown' && e.code !== 'unsupported')) throw e;
			if (PANES[name] && opts.open !== false) await callPlatform('system', 'openSettings', { pane: PANES[name] }).catch(() => {});
			return { status: await permissions.status(name).catch(() => 'unknown' as const), canceled: false };
		}
	},
	/** Close an open guide panel (its guide() resolves with canceled: true). */
	cancelGuide: () => callPlatform<{ canceled: boolean }>('permissions', 'cancelGuide').catch(() => ({ canceled: false })),
	guideState: () => callPlatform<{ open: boolean; name?: string; anchored?: boolean; draggable?: boolean }>('permissions', 'guideState'),
	/** Open the permission's settings page. */
	openSettings: (name: PermissionName | string) => callPlatform<{ opened: boolean }>('system', 'openSettings', { pane: PANES[name] ?? name }),
	/** Grants seen by the guide (the store also re-checks when the app comes back to the front). */
	onChange: (cb: (e: { name: string; status: PermissionStatus }) => void) => onPlatform('permissionChanged', cb),
};

export type MediaState = {
	/** Sound coming out now (not muted). */
	audible: boolean;
	muted: boolean;
	playback: 'none' | 'playing' | 'paused' | 'suspended';
	camera: 'none' | 'active' | 'muted';
	microphone: 'none' | 'active' | 'muted';
};
export type WebsiteDataType = 'cookies' | 'localStorage' | 'sessionStorage' | 'indexedDB' | 'cache' | 'serviceWorkers' | 'all';

export const webview = {
	...webContent,
	...input,
	...webPolicy,
	/** Events for windows, popovers and embedded views. Unsubscribe with the returned function. */
	onLifecycle: (cb: (event: WebviewLifecycleEvent) => void) => onPlatform('webviewLifecycle', cb),
	/** Default reload; manual leaves a terminated page stopped until explicitly reloaded. */
	setRecovery: (recovery: WebviewRecovery, target: WebviewTarget = {}) =>
		callPlatform<null>('webview', 'setRecovery', { ...target, recovery }),
	/** Clear what sites stored (macOS, Linux). Other sites' data (tabs on other sites), and with `app: true`
	 *  the app's own too — except its cookies, which hold its session with the app's server. Default
	 *  types: all. Resolves to the sites cleared. */
	clearData: (options: { types?: WebsiteDataType[]; app?: boolean } = {}) =>
		callPlatform<{ cleared: string[] }>('webview', 'clearData', options),
	/** false: the page runs at full speed when hidden or covered (timers, audio, sockets), at an energy
	 *  cost. WebKit throttles by default (macOS, Linux). */
	setBackgroundThrottling: (enabled: boolean, target: WebviewTarget = {}) =>
		callPlatform<null>('webview', 'setBackgroundThrottling', { ...target, enabled }),
	/** The page's sound muted (it keeps playing), or back (macOS, Linux). */
	setAudioMuted: (muted: boolean, target: WebviewTarget = {}) => callPlatform<null>('webview', 'setAudioMuted', { ...target, muted }),
	/** Pause every audio and video of the page (macOS, Linux). */
	pauseMedia: (target: WebviewTarget = {}) => callPlatform<null>('webview', 'pauseMedia', target),
	/** What the page plays and captures (macOS, Linux). */
	getMediaState: (target: WebviewTarget = {}) =>
		callPlatform<MediaState>('webview', 'getMediaState', target),
	setZoom: (zoom: number, target: WebviewTarget = {}) =>
		callPlatform<{ zoom: number }>('webview', 'setZoom', { ...target, zoom }),
	getZoom: (target: WebviewTarget = {}) => callPlatform<{ zoom: number }>('webview', 'getZoom', target),
	find: (options: FindOptions) => callPlatform<{ matchFound: boolean }>('webview', 'find', options),
	clearFind: (target: WebviewTarget = {}) => callPlatform<null>('webview', 'clearFind', target),
	setContextMenu: (options: ContextMenuOptions) =>
		callPlatform<{ mode: ContextMenuMode }>('webview', 'setContextMenu', options),
	getContextMenu: (target: WebviewTarget = {}) =>
		callPlatform<{ mode: ContextMenuMode; editMenu: boolean; debug: boolean; items: MenuItemSpec[] }>(
			'webview', 'getContextMenu', target),
	/** fileDragEnter / fileDragLeave / fileDrop events with real paths. Default on. */
	setFileDrop: (options: WebviewTarget & { enabled: boolean; all?: boolean }) =>
		callPlatform<{ enabled: boolean }>('webview', 'setFileDrop', options),
	/** null → ~/Downloads (the default). Downloads get a unique name there. */
	setDownloadDirectory: (path: string | null) =>
		callPlatform<{ path: string }>('webview', 'setDownloadDirectory', { path }),
	getDownloadDirectory: () => callPlatform<{ path: string }>('webview', 'getDownloadDirectory'),
	/** Download with the page's session (cookies). Relative URLs resolve against the page. */
	download: (url: string, options: WebviewTarget & { path?: string } = {}) =>
		callPlatform<{ id: string; url: string }>('webview', 'download', { ...options, url }),
	cancelDownload: (id: string) => callPlatform<null>('webview', 'cancelDownload', { id }),
	listDownloads: () =>
		callPlatform<import('./downloads').DownloadRecord[]>('webview', 'listDownloads'),
	/** Interactive: resolves {started} once the print sheet is up (printFinished follows).
	 *  silent / pdfPath: resolves when the job is done. */
	print: (options: PrintOptions = {}) =>
		callPlatform<{ started?: true; success?: boolean; path?: string }>('webview', 'print', options),
	getPrinters: () => callPlatform<string[]>('webview', 'getPrinters'),
	printToPDF: (path: string, target: Omit<PrintOptions, 'pdfPath' | 'silent'> = {}) =>
		callPlatform<{ path: string }>('webview', 'printToPDF', { ...target, path }),
	/** Answer the open alert/confirm/prompt (automation). accept defaults to true. */
	respondToDialog: (options: WebviewTarget & { accept?: boolean; text?: string } = {}) =>
		callPlatform<{ type: JsDialogEvent['type'] }>('webview', 'respondToDialog', options),
	getDialog: (target: WebviewTarget = {}) =>
		callPlatform<{ type: JsDialogEvent['type']; message: string } | null>('webview', 'getDialog', target),
	reload: (options: WebviewTarget & { ignoreCache?: boolean } = {}) =>
		callPlatform<null>('webview', 'reload', options),
	stop: (target: WebviewTarget = {}) => callPlatform<null>('webview', 'stop', target),
	goBack: (target: WebviewTarget = {}) => callPlatform<{ navigated: boolean }>('webview', 'goBack', target),
	goForward: (target: WebviewTarget = {}) => callPlatform<{ navigated: boolean }>('webview', 'goForward', target),
	getInfo: (target: WebviewTarget = {}) => callPlatform<WebviewInfo>('webview', 'getInfo', target),
	/** '' restores WebKit's default. */
	setUserAgent: (userAgent: string, target: WebviewTarget = {}) =>
		callPlatform<null>('webview', 'setUserAgent', { ...target, userAgent }),
	getUserAgent: (target: WebviewTarget = {}) => callPlatform<string>('webview', 'getUserAgent', target),
	/** Safari Web Inspector access (macOS 13.3+, else `unsupported`). */
	setInspectable: (enabled: boolean, target: WebviewTarget = {}) =>
		callPlatform<{ inspectable: boolean }>('webview', 'setInspectable', { ...target, enabled }),
	/** Evaluate in the selected content world (default page); await promises and return JSON. */
	executeJavaScript: <T = unknown>(code: string, target: WebviewTarget & { world?: string } = {}) =>
		callPlatform<T>('webview', 'executeJavaScript', { ...target, code }),
	/** Snapshot of the page, base64 PNG (or JPEG); width/height in pixels. */
	capturePage: (options: CaptureOptions = {}) =>
		callPlatform<{ data: string; format: 'png' | 'jpeg'; width: number; height: number }>(
			'webview', 'capturePage', options),
	/** Documents opened with the app before a page could listen (cold launch); clears the queue.
	 *  Same as native `app.getOpenedFiles`. */
	getOpenedFiles: () => callPlatform<{ paths: string[] }>('webview', 'getOpenedFiles'),

	onFileDragEnter: (cb: (e: FileDropEvent) => void) => onPlatform('fileDragEnter', cb),
	onFileDragLeave: (cb: (e: WebviewSource) => void) => onPlatform('fileDragLeave', cb),
	onFileDrop: (cb: (e: FileDropEvent) => void) => onPlatform('fileDrop', cb),
	onContextMenu: (cb: (e: ContextMenuEvent) => void) => onPlatform('contextMenu', cb),
	onJsDialog: (cb: (e: JsDialogEvent) => void) => onPlatform('jsDialog', cb),
	onDownloadStarted: (cb: (e: DownloadStartedEvent) => void) => onPlatform('downloadStarted', cb),
	onDownloadProgress: (cb: (e: DownloadProgressEvent) => void) => onPlatform('downloadProgress', cb),
	onDownloadFinished: (cb: (e: DownloadFinishedEvent) => void) => onPlatform('downloadFinished', cb),
	onDownloadFailed: (cb: (e: DownloadFailedEvent) => void) => onPlatform('downloadFailed', cb),
	onPrintFinished: (cb: (e: WebviewSource & { success: boolean; path?: string }) => void) =>
		onPlatform('printFinished', cb),
	/** A popover page called window.close() (window pages close their window instead). */
	onCloseRequested: (cb: (e: WebviewSource) => void) => onPlatform('closeRequested', cb),
	/** Documents opened with the app (Finder double-click, Dock drop, `open`). */
	onOpenFiles: (cb: (e: { paths: string[] }) => void) => onPlatform('openFiles', cb),
};

// ── view ────────────────────────────────────────────────────────────
// Extra web views embedded in a window (Electron's BrowserView): an app route
// or any URL at CSS-pixel bounds from the window content's top-left. External
// content can't call native: the bridge only answers the app origin.

export type ViewBounds = { x: number; y: number; width: number; height: number };

export const view = {
	create: (options: {
		session?: string;
		recovery?: WebviewRecovery;
		id?: string;
		windowId?: number;
		url?: string;
		route?: string;
		bounds: ViewBounds;
		/** Follow window resizes: 'width' | 'height' | 'both' | 'none' (default). */
		autoresize?: 'width' | 'height' | 'both' | 'none';
		transparent?: boolean;
		/** Load out of sight, until `show` (no blank view while its page loads). */
		hidden?: boolean;
		/** false: keeps running at full speed while hidden (macOS). Default true. */
		backgroundThrottling?: boolean;
		debug?: boolean;
	}) => callPlatform<{ id: string; windowId: number }>('view', 'create', options),
	setBounds: (id: string, bounds: ViewBounds) => callPlatform<null>('view', 'setBounds', { id, ...bounds }),
	getBounds: (id: string) => callPlatform<ViewBounds>('view', 'getBounds', { id }),
	navigate: (id: string, target: { url?: string; route?: string }) => callPlatform<null>('view', 'navigate', { id, ...target }),
	/** `seeThrough`: in the window, drawing, but see-through and letting the pointer through (macOS). */
	show: (id: string, options: { seeThrough?: boolean } = {}) => callPlatform<null>('view', 'show', { id, ...options }),
	hide: (id: string) => callPlatform<null>('view', 'hide', { id }),
	reload: (id: string) => callPlatform<null>('view', 'reload', { id }),
	/** Give it the keyboard. */
	focus: (id: string) => callPlatform<null>('view', 'focus', { id }),
	getInfo: (id: string) =>
		callPlatform<{ id: string; url: string | null; title: string; loading: boolean; hidden: boolean }>('view', 'getInfo', { id }),
	executeJavaScript: <T = unknown>(id: string, code: string) => callPlatform<T>('view', 'executeJavaScript', { id, code }),
	list: () => callPlatform<Array<{ id: string; windowId: number; url: string | null }>>('view', 'list'),
	destroy: (id: string) => callPlatform<{ destroyed: boolean }>('view', 'destroy', { id }),
	onLoaded: (cb: (e: { id: string; url: string }) => void) => onPlatform('viewLoaded', cb),
	onNavigated: (cb: (e: { id: string; url: string }) => void) => onPlatform('viewNavigated', cb),
	onFailed: (cb: (e: { id: string; error: string }) => void) => onPlatform('viewFailed', cb),
	onTitle: (cb: (e: { id: string; title: string }) => void) => onPlatform('viewTitle', cb),
	/** The user pressed in the view (macOS), or it got the keyboard (Linux, Windows). */
	onFocused: (cb: (e: { id: string }) => void) => onPlatform('viewFocused', cb),
	/** The page's URL changed, within a document too (a site's own router). */
	onUrl: (cb: (e: { id: string; url: string }) => void) => onPlatform('viewUrl', cb),
};
