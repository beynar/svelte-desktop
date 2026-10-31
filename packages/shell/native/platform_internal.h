// Internal contract between the platform dispatcher (platform_core.mm) and the
// service modules (platform_*.mm). Everything here runs on the main thread.
//
// Wire format (same as the GPUI-era bus, packages/platform/src/bus.ts):
//   request  {id, service, op, args}
//   reply    {ok:true, value} | {ok:false, error:{code, message}}
//   events   (name, data) — delivered to the Worker sink AND to every page
// Error codes: invalid_args | unknown | unsupported | unavailable | denied | internal
#pragma once
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface PlatformCall : NSObject
@property(nonatomic, readonly) NSString *service;
@property(nonatomic, readonly) NSString *op;
@property(nonatomic, readonly) NSDictionary *args;
/// Native id of the window that issued the call from its page, or 0 when the
/// call came from the Worker. Window ops resolve `args.windowId` first.
@property(nonatomic, readonly) int callerWindow;
/// Resolve with a JSON-serializable value (nil -> null). Call exactly once,
/// now or later (async ops like dialogs).
- (void)ok:(nullable id)value;
- (void)fail:(NSString *)code message:(NSString *)message;
// Typed argument helpers: missing/mistyped -> fallback.
- (nullable NSString *)string:(NSString *)key;
- (double)number:(NSString *)key or:(double)fallback;
- (BOOL)boolean:(NSString *)key or:(BOOL)fallback;
- (BOOL)has:(NSString *)key;
@end

typedef void (^PlatformHandler)(PlatformCall *call);

/// Register `service.op`. Call from a module's register function.
void platform_register(NSString *service, NSString *op, PlatformHandler handler);
/// Same handler for several ops (aliases).
void platform_register_many(NSString *service, NSArray<NSString *> *ops, PlatformHandler handler);

/// Broadcast a platform event to the Worker sink and every page.
void platform_emit(NSString *name, NSDictionary *_Nullable data);
/// Same, with `target: true` only in the page of window `target` (native id), false in the others.
void platform_emit_targeted(NSString *name, NSDictionary *_Nullable data, int target);
/// The window whose page should handle a user response: `preferred` if open and loaded, else the
/// key/main window, else the first loaded one. 0 when no page is loaded (cold start).
int platform_target_window(int preferred);

// Windows ------------------------------------------------------------------
// Public ids follow the GPUI contract: the primary window is 0, others keep
// their native id. These helpers translate.
int platform_public_window_id(int native_id);
/// Resolves args.windowId (public id) or, if absent, the caller window, or the
/// primary window. Returns 0 if none.
int platform_resolve_window(PlatformCall *call);
NSWindow *_Nullable platform_window(int native_id);
WKWebView *_Nullable platform_webview(int native_id);
NSArray<NSNumber *> *platform_window_ids(void); // native ids, creation order
NSString *_Nullable platform_window_label(int native_id);
/// Create a window on the app origin (multi-window). opts as shell_window_create
/// plus "path" (appended to the app origin) and "label". Returns native id or <0.
int platform_create_window(NSDictionary *opts);
/// quitOnLastWindowClosed: false — recreate the main window when none is left (Dock click). 0 if windows exist.
int platform_recreate_main_window(void);
NSString *_Nullable platform_app_origin(void);
/// App identity from Info.plist, falling back to the shell options.
NSString *platform_app_name(void);
NSString *platform_app_identifier(void);
NSString *platform_app_version(void);

/// Close veto (set by window.setCloseVeto): when armed, windowShouldClose
/// emits `willClose` and refuses.
void platform_set_close_veto(int native_id, BOOL armed);
BOOL platform_close_veto(int native_id);

// Module registration (each platform_*.mm defines one) ----------------------
void platform_register_app(void);
void platform_register_window(void);
void platform_register_screen(void);
void platform_register_clipboard(void);
void platform_register_shell(void);
void platform_register_dialog(void);
void platform_register_theme(void);
void platform_register_menu(void);
void platform_register_system(void);
void platform_register_permissions(void);
/// Synchronous TCC status (granted | denied | notDetermined | unknown), nil if unknown here.
NSString *_Nullable platform_permission_status(NSString *name);
void platform_register_power(void);
void platform_register_secure_storage(void);
void platform_register_notifications(void);
void platform_register_deep_link(void);
void platform_register_tray(void);
void platform_register_shortcuts(void);
void platform_register_diagnostics(void);
void platform_register_capture(void);
void platform_register_view(void);

/// App-delegate hooks installed at runtime on webview/webview's delegate class.
/// Modules set these to observe reopen / openURLs / dock menu.
extern void (^_Nullable platform_on_reopen)(BOOL hasVisibleWindows);
extern void (^_Nullable platform_on_open_urls)(NSArray<NSURL *> *urls);
extern NSMenu *_Nullable (^_Nullable platform_dock_menu)(void);

/// Every registered `service.op`, for capabilities.describe.
NSArray<NSString *> *platform_registered_ops(void);

NS_ASSUME_NONNULL_END

// Glue between shell_macos.mm (windows, run loop) and platform_core.mm ------
NS_ASSUME_NONNULL_BEGIN
/// Send a raw event object to the Worker sink (shell.h event stream).
void shell_emit(NSDictionary *event);
/// Called by the bridge when a page's DOMContentLoaded arrives.
void shell_on_page_ready(int native_id);
/// Install the page bridge (WKUserScript + origin-checked message handler).
void platform_attach_webview(int native_id, WKWebView *webview);
/// Title bar style (default | hidden | hiddenInset) + the page's chrome CSS variables.
void platform_apply_title_bar_style(NSWindow *w, WKWebView *_Nullable webview, NSString *style);
/// Start a window drag from the current mouse-down (or the double-click action).
void platform_window_drag(NSWindow *_Nullable w, BOOL doubleClick);
void platform_detach_webview(int native_id);
/// Register all modules + app-delegate hooks. Idempotent; main thread.
void platform_init(void);
NS_ASSUME_NONNULL_END

// Shared helpers -------------------------------------------------------------
NS_ASSUME_NONNULL_BEGIN
/// GPUI-era coordinate convention: top-left origin of the primary screen, y down.
static inline NSRect platform_to_top_left(NSRect r) {
  CGFloat h = NSMaxY(NSScreen.screens.firstObject.frame);
  return NSMakeRect(r.origin.x, h - NSMaxY(r), r.size.width, r.size.height);
}
static inline NSRect platform_from_top_left(NSRect r) {
  CGFloat h = NSMaxY(NSScreen.screens.firstObject.frame);
  return NSMakeRect(r.origin.x, h - r.origin.y - r.size.height, r.size.width, r.size.height);
}
static inline NSDictionary *platform_rect_dict(NSRect r) {
  return @{@"x" : @(r.origin.x), @"y" : @(r.origin.y), @"width" : @(r.size.width), @"height" : @(r.size.height)};
}
/// {native}|{path}|string icon -> image (platform_tray.mm). nil + *error on failure.
NSImage *_Nullable platform_icon(id icon, NSString *context, NSString *_Nullable *_Nullable error);
/// The tray button rect (top-left convention) or nil when no tray item is placed.
NSDictionary *_Nullable platform_tray_button_rect(void);
/// MenuItemSpec[] -> NSMenu (platform_menu.mm). Items with `id` emit menuAction
/// and are registered for menu.update/get. nil + *error on invalid specs.
NSMenu *_Nullable platform_build_menu(NSArray *items, NSString *context, NSString *_Nullable *_Nullable error);
NS_ASSUME_NONNULL_END

// Popovers (platform_popover.mm) ----------------------------------------------
NS_ASSUME_NONNULL_BEGIN
/// The status item button, nil when no tray item exists (platform_tray.mm).
NSStatusBarButton *_Nullable platform_tray_button(void);
/// Bind a popover to the tray button (nil unbinds). Clicks then toggle it natively.
void platform_popover_bind_tray(NSString *_Nullable popoverId);
/// Called on every tray click; YES when a bound popover handled it.
BOOL platform_popover_tray_click(void);
/// Page-ready from the bridge for a web view that is not a window (popover ids).
void platform_popover_page_ready(int nativeId);
/// Navigation delegate with the shell's policy (shell_macos.mm).
id<WKNavigationDelegate> shell_make_nav_delegate(int nativeId);
void platform_register_popover(void);
NS_ASSUME_NONNULL_END

// Web view features (platform_webview.mm) -------------------------------------
NS_ASSUME_NONNULL_BEGIN
/// Called once for every web view the shell creates (windows and popovers),
/// right after creation: UI delegate, drop handling, downloads, menus…
void platform_webview_configure(int nativeId, WKWebView *webview);
void platform_register_webview(void);
/// Navigation-delegate glue (ShellNavDelegate): download non-displayable /
/// Content-Disposition: attachment responses, and adopt the resulting WKDownload.
WKNavigationResponsePolicy platform_webview_response_policy(WKNavigationResponse *response);
void platform_webview_download_started(int nativeId, WKDownload *download);
/// File URLs from application:openURLs: (documents opened with the app).
void platform_webview_open_files(NSArray<NSURL *> *files);
NS_ASSUME_NONNULL_END
