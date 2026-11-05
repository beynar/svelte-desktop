// window.* — every op of the GPUI-era contract (packages/platform/src/index.ts).
// Coordinates: top-left origin of the primary screen, y down. `windowId` is the
// public id (0 = primary); absent → the calling page's window (or key/primary).
// Events (emitted by shell_macos.mm): focusChanged, boundsChanged,
// scaleFactorChanged, willClose, closed, created.
#include <map>
#include <cfloat>

#include "platform_internal.h"
#include "platform_app_windows.h"
#include <objc/runtime.h>

static NSDictionary *g_window_creation_options;
static char kWindowId, kWindowObservers, kWindowVisible, kModalWindow, kParentWindow, kShowFocus, kSuspendedSheet, kSheetEnding, kSheetWaiters;
static NSWindow *window_parent(NSWindow *w);
static BOOL defer_window_close(NSWindow *w, dispatch_block_t done);
static void close_owned_window(NSWindow *w, dispatch_block_t done);
static void end_owned_sheet(NSWindow *w, dispatch_block_t done);
static void hide_owned_window(NSWindow *w, dispatch_block_t done);

static BOOL creation_wants_focus() {
  id visible = g_window_creation_options[@"visible"] ?: g_window_creation_options[@"show"];
  return (!visible || [visible boolValue]) && (!g_window_creation_options[@"focus"] || [g_window_creation_options[@"focus"] boolValue]);
}

@interface SDNativeWindow : NSWindow
@property(nonatomic) BOOL sdFocusable;
@end
@interface SDNativePanel : NSPanel
@property(nonatomic) BOOL sdFocusable;
@end

// Class policy is fixed before the vendor creates the WKWebView. No private
// isa changes, and a nonfocusable panel never briefly steals the key window.
#define SD_WINDOW_POLICY \
- (BOOL)canBecomeKeyWindow { return self.sdFocusable; } \
- (void)makeKeyAndOrderFront:(id)sender { \
  if (!self.sdFocusable || !creation_wants_focus()) [self orderFront:sender]; \
  else [super makeKeyAndOrderFront:sender]; \
} \
- (void)orderWindow:(NSWindowOrderingMode)place relativeTo:(NSInteger)other { \
  [super orderWindow:place relativeTo:other]; platform_window_visibility_changed(self); \
} \
- (void)setAlphaValue:(CGFloat)value { [super setAlphaValue:value]; platform_window_visibility_changed(self); }
// End AppKit's modal session before NSWindow starts destroying its sheet.
#define SD_SHEET_CLOSE \
- (void)close { \
  if (defer_window_close(self, nil)) return; \
  NSWindow *parent = window_parent(self); \
  [super close]; \
  if (parent.isVisible) [parent makeKeyAndOrderFront:nil]; \
}

@implementation SDNativeWindow
SD_WINDOW_POLICY
SD_SHEET_CLOSE
- (BOOL)canBecomeMainWindow { return self.sdFocusable && [super canBecomeMainWindow]; }
@end
@implementation SDNativePanel
SD_WINDOW_POLICY
SD_SHEET_CLOSE
- (BOOL)canBecomeMainWindow { return NO; }
@end
#undef SD_WINDOW_POLICY
#undef SD_SHEET_CLOSE

void platform_window_creation_options(NSDictionary *options) { g_window_creation_options = options; }

// Returns +1, adopted by the vendor's existing owning-window lifecycle.
extern "C" void *webview_sd_create_window(void) {
  BOOL panel = [g_window_creation_options[@"type"] isEqual:@"panel"];
  Class cls = panel ? SDNativePanel.class : SDNativeWindow.class;
  NSWindow *w = [[cls alloc] initWithContentRect:NSZeroRect styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
  [(id)w setSdFocusable:!g_window_creation_options[@"focusable"] || [g_window_creation_options[@"focusable"] boolValue]];
  objc_setAssociatedObject(w, &kShowFocus, g_window_creation_options[@"focus"] ?: @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if (panel) {
    ((NSPanel *)w).hidesOnDeactivate = NO;
    ((NSPanel *)w).becomesKeyOnlyIfNeeded = YES;
  }
  return (__bridge_retained void *)w;
}

static NSWindow *parent_option(id publicId) {
  if (![publicId isKindOfClass:NSNumber.class] || [publicId doubleValue] < 0 || [publicId doubleValue] != [publicId intValue]) return nil;
  int native = [publicId intValue];
  if (!native) native = platform_window_ids().firstObject.intValue;
  return platform_window(native);
}

BOOL platform_window_options_valid(NSDictionary *o) {
  if (o[@"type"] && ![@[ @"normal", @"panel" ] containsObject:o[@"type"]]) return NO;
  for (NSString *key in @[ @"modal", @"focusable" ])
    if (o[key] && ![o[key] isKindOfClass:NSNumber.class]) return NO;
  NSWindow *parent = parent_option(o[@"parentId"]);
  if (o[@"parentId"] && !parent) return NO;
  if ([o[@"modal"] boolValue] && (!parent || parent.attachedSheet || (o[@"focusable"] && ![o[@"focusable"] boolValue]))) return NO;
  return YES;
}

static NSWindow *window_parent(NSWindow *w) { return objc_getAssociatedObject(w, &kParentWindow); }

BOOL platform_window_last_family(NSWindow *window) {
  for (NSNumber *native in platform_window_ids()) {
    NSWindow *candidate = platform_window(native.intValue);
    while (candidate && candidate != window) candidate = window_parent(candidate);
    if (!candidate) return NO;
  }
  return YES;
}

static NSString *set_parent(NSWindow *w, NSWindow *parent, BOOL modal) {
  if (modal && (!parent || (parent.attachedSheet && parent.attachedSheet != w))) return @"modal requires a parent without another attached sheet";
  for (NSWindow *ancestor = parent; ancestor; ancestor = window_parent(ancestor))
    if (ancestor == w) return @"parent relationship cannot contain a cycle";
  if (window_parent(w) == parent && [objc_getAssociatedObject(w, &kModalWindow) boolValue] == modal) return nil;
  if (modal && (w.sheetParent || [objc_getAssociatedObject(w, &kSheetEnding) boolValue])) return @"hide the modal before changing its parent";
  if (w.sheetParent) [w.sheetParent endSheet:w];
  if (w.parentWindow) [w.parentWindow removeChildWindow:w];
  // Cleared before either window closes; do not retain an ancestor through its child.
  objc_setAssociatedObject(w, &kParentWindow, parent, OBJC_ASSOCIATION_ASSIGN);
  objc_setAssociatedObject(w, &kModalWindow, @(modal), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if (parent) {
    if (modal && w.isVisible && w.alphaValue > 0) platform_window_present(w);
    else if (!modal) [parent addChildWindow:w ordered:NSWindowAbove];
  }
  return nil;
}

void platform_window_configure_relationship(NSWindow *w, NSDictionary *o) {
  set_parent(w, parent_option(o[@"parentId"]), [o[@"modal"] boolValue]);
}

void platform_window_present(NSWindow *w) {
  objc_setAssociatedObject(w, &kSuspendedSheet, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if ([objc_getAssociatedObject(w, &kSheetEnding) boolValue]) {
    end_owned_sheet(w, ^{ if (objc_getAssociatedObject(w, &kWindowId)) platform_window_present(w); });
    return;
  }
  NSWindow *parent = window_parent(w);
  if (parent && [objc_getAssociatedObject(w, &kModalWindow) boolValue] && !w.sheetParent) {
    // The vendor stages windows ordered front with alpha zero. AppKit requires
    // a sheet to be ordered out before beginSheet (as dialog.sheet does).
    [w orderOut:nil];
    NSWindow *__weak weak = w;
    [parent beginSheet:w completionHandler:^(NSModalResponse) {
      NSWindow *sheet = weak;
      [sheet orderOut:nil];
      objc_setAssociatedObject(sheet, &kSheetEnding, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      NSArray *waiters = [objc_getAssociatedObject(sheet, &kSheetWaiters) copy];
      objc_setAssociatedObject(sheet, &kSheetWaiters, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      for (dispatch_block_t done in waiters) done();
    }];
  }
  else if ([objc_getAssociatedObject(w, &kShowFocus) boolValue]) [w makeKeyAndOrderFront:nil];
  else [w orderFront:nil];
  platform_window_visibility_changed(w);
}

static void end_owned_sheet(NSWindow *w, dispatch_block_t done) {
  BOOL ending = [objc_getAssociatedObject(w, &kSheetEnding) boolValue];
  if (!ending && !w.sheetParent) { if (done) done(); return; }
  NSMutableArray *waiters = objc_getAssociatedObject(w, &kSheetWaiters);
  if (!waiters) {
    waiters = [NSMutableArray array];
    objc_setAssociatedObject(w, &kSheetWaiters, waiters, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  if (done) [waiters addObject:[done copy]];
  if (ending) return;
  objc_setAssociatedObject(w, &kSheetEnding, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [w.sheetParent endSheet:w];
}

static void hide_owned_window(NSWindow *w, dispatch_block_t done) {
  if (w.sheetParent || [objc_getAssociatedObject(w, &kSheetEnding) boolValue]) {
    end_owned_sheet(w, ^{ hide_owned_window(w, done); });
    return;
  }
  [w orderOut:nil];
  platform_window_visibility_changed(w);
  if (done) done();
}

static BOOL defer_window_close(NSWindow *w, dispatch_block_t done) {
  for (NSNumber *native in platform_window_ids()) {
    NSWindow *child = platform_window(native.intValue);
    if (window_parent(child) != w) continue;
    close_owned_window(child, ^{ close_owned_window(w, done); });
    return YES;
  }
  if (w.sheetParent || [objc_getAssociatedObject(w, &kSheetEnding) boolValue]) {
    end_owned_sheet(w, ^{ close_owned_window(w, done); });
    return YES;
  }
  return NO;
}

static void close_owned_window(NSWindow *w, dispatch_block_t done) {
  if (objc_getAssociatedObject(w, &kWindowId)) {
    if (defer_window_close(w, done)) return;
    [w close];
  }
  if (done) done();
}

void platform_window_suspend_sheets_for_quit(void (^ready)(NSArray<NSWindow *> *)) {
  NSMutableArray<NSWindow *> *sheets = [NSMutableArray array];
  NSMutableArray<NSWindow *> *endingSheets = [NSMutableArray array];
  for (NSNumber *native in platform_window_ids().reverseObjectEnumerator) {
    NSWindow *w = platform_window(native.intValue);
    BOOL ending = [objc_getAssociatedObject(w, &kSheetEnding) boolValue];
    if ((!w.sheetParent && !ending) || ![objc_getAssociatedObject(w, &kModalWindow) boolValue]) continue;
    [endingSheets addObject:w];
    if (!ending) {
      objc_setAssociatedObject(w, &kSuspendedSheet, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      [sheets addObject:w];
    }
  }
  if (!endingSheets.count) { ready(sheets); return; }
  __block NSUInteger pending = endingSheets.count;
  for (NSWindow *w in endingSheets) end_owned_sheet(w, ^{
    [w orderOut:nil];
    if (!--pending) ready(sheets);
  });
}

void platform_window_restore_sheets_after_quit(NSArray<NSWindow *> *sheets) {
  for (NSWindow *w in sheets.reverseObjectEnumerator) {
    if (!objc_getAssociatedObject(w, &kWindowId) || ![objc_getAssociatedObject(w, &kSuspendedSheet) boolValue]) continue;
    if (window_parent(w) && !window_parent(w).attachedSheet) platform_window_present(w);
    objc_setAssociatedObject(w, &kSuspendedSheet, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}

void platform_window_visibility_changed(NSWindow *w) {
  NSNumber *native = objc_getAssociatedObject(w, &kWindowId);
  if (!native) return;
  BOOL visible = w.isVisible && w.alphaValue > 0 && !NSApp.hidden;
  NSNumber *before = objc_getAssociatedObject(w, &kWindowVisible);
  if (before && before.boolValue == visible) return;
  objc_setAssociatedObject(w, &kWindowVisible, @(visible), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  platform_emit(visible ? @"shown" : @"hidden", @{@"windowId":@(platform_public_window_id(native.intValue))});
}

void platform_window_observe(int nativeId, NSWindow *w) {
  NSWindowCollectionBehavior full = ([w isKindOfClass:NSPanel.class] || [objc_getAssociatedObject(w, &kModalWindow) boolValue])
      ? NSWindowCollectionBehaviorFullScreenAuxiliary : NSWindowCollectionBehaviorFullScreenPrimary;
  w.collectionBehavior = (w.collectionBehavior & ~(NSWindowCollectionBehaviorFullScreenPrimary | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorFullScreenNone)) | full;
  objc_setAssociatedObject(w, &kWindowId, @(nativeId), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  objc_setAssociatedObject(w, &kWindowVisible, @NO, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  NSMutableArray *tokens = [NSMutableArray array];
  objc_setAssociatedObject(w, &kWindowObservers, tokens, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
  NSWindow *__weak weak = w;
  NSDictionary *events = @{
    NSWindowDidMiniaturizeNotification:@"minimized", NSWindowDidDeminiaturizeNotification:@"restored",
    NSWindowDidEnterFullScreenNotification:@"fullscreenChanged", NSWindowDidExitFullScreenNotification:@"fullscreenChanged",
    NSWindowDidMoveNotification:@"moved", NSWindowDidResizeNotification:@"resized",
    NSWindowDidBecomeKeyNotification:@"focus", NSWindowDidResignKeyNotification:@"blur"
  };
  for (NSNotificationName name in events)
    [tokens addObject:[nc addObserverForName:name object:w queue:nil usingBlock:^(NSNotification *) {
      NSWindow *win = weak;
      if (!win) return;
      NSMutableDictionary *data = [@{@"windowId":@(platform_public_window_id(nativeId))} mutableCopy];
      NSString *event = events[name];
      if ([event isEqual:@"fullscreenChanged"]) {
        BOOL full = [name isEqualToString:NSWindowDidEnterFullScreenNotification];
        data[@"fullscreen"] = @(full);
        data[@"transition"] = full ? @"entered" : @"exited";
      } else if ([event isEqual:@"moved"] || [event isEqual:@"resized"]) [data addEntriesFromDictionary:platform_rect_dict(platform_to_top_left(win.frame))];
      platform_emit(event, data);
      platform_window_visibility_changed(win);
    }]];
  for (NSNotificationName name in @[ NSApplicationDidHideNotification, NSApplicationDidUnhideNotification ])
    [tokens addObject:[nc addObserverForName:name object:NSApp queue:nil usingBlock:^(NSNotification *) { platform_window_visibility_changed(weak); }]];
  [tokens addObject:[nc addObserverForName:NSWindowDidChangeOcclusionStateNotification object:w queue:nil usingBlock:^(NSNotification *) { platform_window_visibility_changed(weak); }]];
  [tokens addObject:[nc addObserverForName:NSWindowWillCloseNotification object:w queue:nil usingBlock:^(NSNotification *) {
    NSWindow *win = weak;
    if (win.parentWindow) [win.parentWindow removeChildWindow:win];
    objc_setAssociatedObject(win, &kParentWindow, nil, OBJC_ASSOCIATION_ASSIGN);
    for (id token in (NSArray *)objc_getAssociatedObject(win, &kWindowObservers)) [NSNotificationCenter.defaultCenter removeObserver:token];
    objc_setAssociatedObject(win, &kWindowObservers, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(win, &kWindowId, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }]];
  platform_window_visibility_changed(w);
}

// ── title bar styles ────────────────────────────────────────────────────
// default: the system title bar. transparent: the page extends under a title bar
// that keeps its title. hidden: no title bar, the page extends under the traffic lights. hiddenInset: same, with the traffic lights inset (a unified
// compact toolbar, like Safari / Electron's hiddenInset). The page gets
// --desktop-titlebar-height / --desktop-controls-width and
// html[data-desktop-titlebar] to lay itself out, kept current across fullscreen.

static char kStyleKey, kObserversKey, kTrafficLightsKey, kTrafficObserversKey, kTrafficHomeKey;

static void publish_chrome(NSWindow *w, WKWebView *wv) {
  if (!wv) return;
  NSString *style = objc_getAssociatedObject(w, &kStyleKey) ?: @"default";
  BOOL hidden = ![style isEqual:@"default"];
  BOOL full = (w.styleMask & NSWindowStyleMaskFullScreen) != 0;
  CGFloat bar = hidden && !full ? MAX(0, NSHeight(w.frame) - NSHeight(w.contentLayoutRect)) : 0;
  // Traffic lights moved down (setTrafficLightPosition): the strip reaches below them.
  if (NSValue *at = objc_getAssociatedObject(w, &kTrafficLightsKey); at && hidden && !full)
    bar = MAX(bar, at.pointValue.y * 2 + NSHeight([w standardWindowButton:NSWindowCloseButton].frame));
  NSButton *zoom = [w standardWindowButton:NSWindowZoomButton];
  CGFloat controls = hidden && !full && zoom ? NSMaxX([zoom convertRect:zoom.bounds toView:nil]) + 12 : 0;
  NSString *js = [NSString stringWithFormat:
      @"(()=>{const a=()=>{const r=document.documentElement;r.style.setProperty('--desktop-titlebar-height','%.0fpx');"
       "r.style.setProperty('--desktop-controls-width','%.0fpx');r.dataset.desktopTitlebar='%@';r.dataset.desktopControls='native';};"
       "document.documentElement?a():document.addEventListener('readystatechange',a,{once:true});})()",
      bar, controls, full ? @"fullscreen" : style];
  // Now, and for every later document in this web view.
  [wv evaluateJavaScript:js completionHandler:nil];
  [wv.configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:js
                                                                              injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                                           forMainFrameOnly:YES]];
}

// Traffic lights at a position of your own ({x, y}: the close button's top-left, in points from the
// window's top-left), for a custom title bar. AppKit lays them out again on resize and focus
// changes: placed again after each.
static void place_traffic_lights(NSWindow *w) {
  NSValue *at = objc_getAssociatedObject(w, &kTrafficLightsKey);
  NSButton *close = [w standardWindowButton:NSWindowCloseButton], *mini = [w standardWindowButton:NSWindowMiniaturizeButton],
           *zoom = [w standardWindowButton:NSWindowZoomButton];
  if (!at || !close.superview.superview || (w.styleMask & NSWindowStyleMaskFullScreen)) return;
  NSPoint p = at.pointValue;
  NSView *titlebar = close.superview, *container = titlebar.superview;
  // Where AppKit had them, to put them back (setTrafficLightPosition(null)).
  if (!objc_getAssociatedObject(w, &kTrafficHomeKey))
    objc_setAssociatedObject(w, &kTrafficHomeKey, @[ [NSValue valueWithRect:container.frame], [NSValue valueWithPoint:close.frame.origin],
                                                     [NSValue valueWithPoint:mini.frame.origin], [NSValue valueWithPoint:zoom.frame.origin] ], OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  CGFloat bh = NSHeight(close.frame), height = bh + 2 * p.y;
  NSRect r = container.frame;
  r.size.height = height;
  r.origin.y = NSHeight(w.frame) - height;
  container.frame = r;
  CGFloat space = mini ? NSMinX(mini.frame) - NSMinX(close.frame) : 20;
  if (space <= 0) space = 20;
  NSArray *buttons = @[ close, mini ?: NSNull.null, zoom ?: NSNull.null ];
  for (NSUInteger i = 0; i < buttons.count; i++) {
    if (buttons[i] == NSNull.null) continue;
    NSButton *b = buttons[i];
    [b setFrameOrigin:NSMakePoint(p.x + i * space, NSHeight(titlebar.frame) - p.y - bh)];
  }
}

void platform_window_set_traffic_lights(NSWindow *w, WKWebView *_Nullable wv, NSValue *_Nullable at) {
  objc_setAssociatedObject(w, &kTrafficLightsKey, at, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if (at && !objc_getAssociatedObject(w, &kTrafficObserversKey)) {
    NSMutableArray *tokens = [NSMutableArray array];
    NSWindow *__weak weak = w;
    for (NSNotificationName n in @[ NSWindowDidResizeNotification, NSWindowDidEndLiveResizeNotification, NSWindowDidExitFullScreenNotification,
                                    NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification, NSWindowDidChangeBackingPropertiesNotification ])
      [tokens addObject:[NSNotificationCenter.defaultCenter addObserverForName:n object:w queue:NSOperationQueue.mainQueue
                                                                    usingBlock:^(NSNotification *) {
                                                                      if (weak) place_traffic_lights(weak);
                                                                    }]];
    objc_setAssociatedObject(w, &kTrafficObserversKey, tokens, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  if (at) place_traffic_lights(w);
  else if (NSArray<NSValue *> *home = objc_getAssociatedObject(w, &kTrafficHomeKey)) {
    // Back where AppKit had them.
    NSButton *close = [w standardWindowButton:NSWindowCloseButton];
    NSView *container = close.superview.superview;
    NSRect r = home[0].rectValue;
    r.origin.y = NSHeight(w.frame) - NSHeight(r);
    r.size.width = NSWidth(container.frame);
    container.frame = r;
    NSArray *buttons = @[ close, [w standardWindowButton:NSWindowMiniaturizeButton] ?: NSNull.null, [w standardWindowButton:NSWindowZoomButton] ?: NSNull.null ];
    for (NSUInteger i = 0; i < buttons.count; i++)
      if (buttons[i] != NSNull.null) [(NSButton *)buttons[i] setFrameOrigin:home[i + 1].pointValue];
    objc_setAssociatedObject(w, &kTrafficHomeKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  publish_chrome(w, wv);
}

// hiddenInset's traffic lights sit in an empty unified toolbar. In full screen macOS shows that toolbar
// as an opaque strip across the top: it goes while the window is full screen.
static void update_inset_toolbar(NSWindow *w, BOOL enteringFullScreen = NO) {
  BOOL inset = [objc_getAssociatedObject(w, &kStyleKey) isEqual:@"hiddenInset"];
  BOOL full = enteringFullScreen || (w.styleMask & NSWindowStyleMaskFullScreen);
  if (inset && !full) {
    if (!w.toolbar) w.toolbar = [[NSToolbar alloc] initWithIdentifier:@"sd-inset"];
    w.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
  } else if ([w.toolbar.identifier isEqual:@"sd-inset"]) {
    w.toolbar = nil;
  }
}

void platform_apply_title_bar_style(NSWindow *w, WKWebView *_Nullable wv, NSString *style) {
  BOOL transparent = ![style isEqual:@"default"];
  w.titlebarAppearsTransparent = transparent;
  if (transparent) w.styleMask |= NSWindowStyleMaskFullSizeContentView;
  else w.styleMask &= ~NSWindowStyleMaskFullSizeContentView;
  w.titleVisibility = [style hasPrefix:@"hidden"] ? NSWindowTitleHidden : NSWindowTitleVisible; // transparent keeps the title
  objc_setAssociatedObject(w, &kStyleKey, style, OBJC_ASSOCIATION_COPY_NONATOMIC);
  update_inset_toolbar(w);
  if (!objc_getAssociatedObject(w, &kObserversKey)) {
    NSMutableArray *tokens = [NSMutableArray array];
    WKWebView *__weak weakView = wv;
    NSWindow *__weak weakWindow = w;
    // Off before the full-screen animation starts, back once it has ended (as Electron does).
    for (NSNotificationName n in @[ NSWindowWillEnterFullScreenNotification, NSWindowDidExitFullScreenNotification ])
      [tokens addObject:[NSNotificationCenter.defaultCenter addObserverForName:n object:w queue:NSOperationQueue.mainQueue
                                                                    usingBlock:^(NSNotification *note) {
                                                                      if (weakWindow) update_inset_toolbar(weakWindow, [note.name isEqual:NSWindowWillEnterFullScreenNotification]);
                                                                    }]];
    for (NSNotificationName n in @[ NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification ])
      [tokens addObject:[NSNotificationCenter.defaultCenter addObserverForName:n object:w queue:NSOperationQueue.mainQueue
                                                                    usingBlock:^(NSNotification *) {
                                                                      if (weakWindow) publish_chrome(weakWindow, weakView);
                                                                    }]];
    objc_setAssociatedObject(w, &kObserversKey, tokens, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  publish_chrome(w, wv);
}

/// Page drag regions (bridge messages `drag` / `dragDouble`, main frame of the app origin).
void platform_window_drag(NSWindow *w, BOOL doubleClick) {
  if (!w) return;
  if (doubleClick) {
    // The user's "double-click a window's title bar to" setting.
    NSString *action = [NSUserDefaults.standardUserDefaults stringForKey:@"AppleActionOnDoubleClick"];
    if ([action isEqual:@"Minimize"]) [w miniaturize:nil];
    else if (![action isEqual:@"None"]) [w zoom:nil];
    return;
  }
  NSEvent *e = NSApp.currentEvent;
  if (e && (e.type == NSEventTypeLeftMouseDown || e.type == NSEventTypeLeftMouseDragged)) [w performWindowDragWithEvent:e];
}

// Vibrancy: an NSVisualEffectView behind the page, filling the window; where the page paints no
// background, the material shows (the system blurs what's behind or under the window — nothing in
// the page's own memory, unlike a CSS backdrop-filter).
static NSDictionary<NSString *, NSNumber *> *vibrancy_materials(void) {
  return @{
    @"sidebar" : @(NSVisualEffectMaterialSidebar),
    @"titlebar" : @(NSVisualEffectMaterialTitlebar),
    @"header" : @(NSVisualEffectMaterialHeaderView),
    @"content" : @(NSVisualEffectMaterialContentBackground),
    @"window" : @(NSVisualEffectMaterialWindowBackground),
    @"underWindow" : @(NSVisualEffectMaterialUnderWindowBackground),
    @"underPage" : @(NSVisualEffectMaterialUnderPageBackground),
    @"menu" : @(NSVisualEffectMaterialMenu),
    @"popover" : @(NSVisualEffectMaterialPopover),
    @"sheet" : @(NSVisualEffectMaterialSheet),
    @"hud" : @(NSVisualEffectMaterialHUDWindow),
    @"tooltip" : @(NSVisualEffectMaterialToolTip),
    @"fullscreenUI" : @(NSVisualEffectMaterialFullScreenUI),
    @"selection" : @(NSVisualEffectMaterialSelection),
  };
}

static NSString *const kVibrancyId = @"sd-vibrancy";
static NSString *const kGlassId = @"sd-glass";
static char kGlassSavedKey, kRegionsKey, kRegionGlassKey, kMaterialNameKey, kGlassTintKey;
static BOOL g_cursor_hidden = NO;

// What the effects need from the window and the page, from all of them together: window vibrancy
// or glass, and the CSS materials. The page draws no background while any is on; the window is
// non-opaque while there's glass (its opacity and color come back after).
static void update_backdrop(NSWindow *w, WKWebView *page) {
  BOOL windowVibrancy = NO, windowGlass = NO;
  for (NSView *v in w.contentView.subviews) {
    windowVibrancy |= [v.identifier isEqual:kVibrancyId];
    windowGlass |= [v.identifier isEqual:kGlassId];
  }
  NSDictionary *regions = objc_getAssociatedObject(w, &kRegionsKey);
  if (page) [page setValue:@(!(windowVibrancy || windowGlass || regions.count)) forKey:@"drawsBackground"];
  BOOL clear = windowGlass || [objc_getAssociatedObject(w, &kRegionGlassKey) boolValue];
  NSArray *saved = objc_getAssociatedObject(w, &kGlassSavedKey);
  if (clear && !saved) {
    objc_setAssociatedObject(w, &kGlassSavedKey, @[ @(w.opaque), w.backgroundColor ?: NSColor.windowBackgroundColor ], OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    w.opaque = NO;
    w.backgroundColor = NSColor.clearColor;
  } else if (!clear && saved) {
    w.opaque = [saved[0] boolValue];
    w.backgroundColor = saved[1];
    objc_setAssociatedObject(w, &kGlassSavedKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}

/// Sets (or, with a nil material, removes) the window's vibrancy. Returns an error message.
NSString *platform_window_set_vibrancy(NSWindow *w, int nativeId, NSString *material, NSString *state) {
  NSView *host = w.contentView;
  NSVisualEffectView *fx = nil;
  for (NSView *v in host.subviews)
    if ([v.identifier isEqual:kVibrancyId]) fx = (NSVisualEffectView *)v;
  WKWebView *page = platform_webview(nativeId);
  if (!material) {
    [fx removeFromSuperview];
    update_backdrop(w, page);
    return nil;
  }
  NSNumber *m = vibrancy_materials()[material];
  if (!m) return [NSString stringWithFormat:@"unknown material `%@`, expected one of %@", material, [vibrancy_materials().allKeys componentsJoinedByString:@", "]];
  platform_window_set_glass(w, nativeId, nil, nil); // one effect at a time
  if (!fx) {
    fx = [[NSVisualEffectView alloc] initWithFrame:host.bounds];
    fx.identifier = kVibrancyId;
    fx.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    fx.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    [host addSubview:fx positioned:NSWindowBelow relativeTo:nil];
  }
  fx.material = (NSVisualEffectMaterial)m.integerValue;
  objc_setAssociatedObject(fx, &kMaterialNameKey, material, OBJC_ASSOCIATION_COPY_NONATOMIC);
  fx.state = [state isEqual:@"active"] ? NSVisualEffectStateActive : [state isEqual:@"inactive"] ? NSVisualEffectStateInactive : NSVisualEffectStateFollowsWindowActiveState;
  update_backdrop(w, page); // the page's transparent parts show it
  return nil;
}

// Liquid Glass (macOS 26): an NSGlassEffectView behind the page, filling the window, which is made
// non-opaque so the glass shows what's behind it. Before macOS 26, the `underWindow` vibrancy
// material instead. One effect at a time: glass removes vibrancy and the other way round.
/// "#rgb", "#rrggbb" or "#rrggbbaa", or nil.
static NSColor *parse_hex_color(NSString *hex) {
  if (![hex hasPrefix:@"#"]) return nil;
  NSString *h = [hex substringFromIndex:1];
  if (h.length == 3) h = [NSString stringWithFormat:@"%C%C%C%C%C%C", [h characterAtIndex:0], [h characterAtIndex:0], [h characterAtIndex:1], [h characterAtIndex:1], [h characterAtIndex:2], [h characterAtIndex:2]];
  if (h.length == 6) h = [h stringByAppendingString:@"ff"];
  if (h.length != 8) return nil;
  unsigned v = 0;
  if (![[NSScanner scannerWithString:h] scanHexInt:&v]) return nil;
  return [NSColor colorWithSRGBRed:((v >> 24) & 0xff) / 255.0 green:((v >> 16) & 0xff) / 255.0 blue:((v >> 8) & 0xff) / 255.0 alpha:(v & 0xff) / 255.0];
}

/// Sets (or, with nil options, removes) the window's glass. Returns an error message; `*glass`
/// tells whether it is Liquid Glass (NO: the vibrancy fallback, before macOS 26).
NSString *platform_window_set_glass(NSWindow *w, int nativeId, NSDictionary *opts, BOOL *glass) {
  NSView *host = w.contentView;
  NSView *existing = nil;
  for (NSView *v in host.subviews)
    if ([v.identifier isEqual:kGlassId]) existing = v;
  WKWebView *page = platform_webview(nativeId);
  if (!opts) {
    if (!existing) return nil;
    [existing removeFromSuperview];
    update_backdrop(w, page);
    return nil;
  }
  NSString *style = [opts[@"style"] isKindOfClass:NSString.class] ? opts[@"style"] : @"regular";
  if (![style isEqual:@"regular"] && ![style isEqual:@"clear"]) return [NSString stringWithFormat:@"unknown style `%@`, expected regular or clear", style];
  NSString *tintSpec = [opts[@"tint"] isKindOfClass:NSString.class] ? opts[@"tint"] : nil;
  NSColor *tint = tintSpec ? parse_hex_color(tintSpec) : nil;
  if (tintSpec && !tint) return [NSString stringWithFormat:@"tint `%@` is not a #rgb, #rrggbb or #rrggbbaa color", tintSpec];
  if (@available(macOS 26.0, *)) {
    platform_window_set_vibrancy(w, nativeId, nil, nil);
    NSGlassEffectView *g = (NSGlassEffectView *)existing;
    if (!g) {
      g = [[NSGlassEffectView alloc] initWithFrame:host.bounds];
      g.identifier = kGlassId;
      g.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      [host addSubview:g positioned:NSWindowBelow relativeTo:nil];
    }
    g.style = [style isEqual:@"clear"] ? NSGlassEffectViewStyleClear : NSGlassEffectViewStyleRegular;
    g.tintColor = tint;
    objc_setAssociatedObject(g, &kGlassTintKey, tintSpec, OBJC_ASSOCIATION_COPY_NONATOMIC);
    g.cornerRadius = MAX(0, [opts[@"cornerRadius"] isKindOfClass:NSNumber.class] ? [opts[@"cornerRadius"] doubleValue] : 0);
    update_backdrop(w, page);
    if (glass) *glass = YES;
    return nil;
  }
  if (glass) *glass = NO;
  return platform_window_set_vibrancy(w, nativeId, @"underWindow", nil);
}

// Materials from CSS (src/host/materials.ts): the page sends the elements that declare
// `--desktop-material` — their rects in CSS px, radius, tint — and each gets an effect view behind
// the web view at that place: NSVisualEffectView for a vibrancy material, NSGlassEffectView for
// `glass` / `glass-clear` (macOS 26; the `underWindow` material before). The whole list each
// time: views of elements gone are removed. Glass needs a non-opaque window to show what's behind.
static char kRegionRadiusKey;

static NSImage *rounded_mask(CGFloat r) {
  NSImage *img = [NSImage imageWithSize:NSMakeSize(2 * r + 1, 2 * r + 1)
                                flipped:NO
                         drawingHandler:^BOOL(NSRect rect) {
                           [NSColor.blackColor setFill];
                           [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:r yRadius:r] fill];
                           return YES;
                         }];
  img.capInsets = NSEdgeInsetsMake(r, r, r, r);
  img.resizingMode = NSImageResizingModeStretch;
  return img;
}

static NSString *apply_material_regions(NSWindow *w, int nativeId, NSArray *regions) {
  WKWebView *page = platform_webview(nativeId);
  if (!page) return @"no web view";
  NSView *host = page.superview ?: w.contentView;
  NSMutableDictionary<NSString *, NSView *> *views = objc_getAssociatedObject(w, &kRegionsKey);
  if (!views) objc_setAssociatedObject(w, &kRegionsKey, views = [NSMutableDictionary new], OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  CGFloat zoom = page.magnification;
  if (@available(macOS 11.0, *)) zoom *= page.pageZoom;
  NSMutableSet *seen = [NSMutableSet new];
  BOOL anyGlass = NO;
  for (NSDictionary *r in regions) {
    if (![r isKindOfClass:NSDictionary.class]) continue;
    NSString *rid = [r[@"id"] description];
    NSString *material = [r[@"material"] isKindOfClass:NSString.class] ? r[@"material"] : nil;
    if (!rid || !material) continue;
    BOOL glass = [material isEqual:@"glass"] || [material isEqual:@"glass-clear"];
    NSNumber *vm = glass ? nil : vibrancy_materials()[material];
    if (!glass && !vm) return [NSString stringWithFormat:@"unknown material `%@`", material];
    NSRect rr = NSMakeRect([r[@"x"] doubleValue] * zoom, [r[@"y"] doubleValue] * zoom, [r[@"width"] doubleValue] * zoom, [r[@"height"] doubleValue] * zoom);
    if (!page.isFlipped) rr.origin.y = NSHeight(page.bounds) - NSMaxY(rr);
    NSRect frame = [page convertRect:rr toView:host];
    CGFloat radius = MAX(0, [r[@"radius"] doubleValue] * zoom);
    NSString *tintSpec = [r[@"tint"] isKindOfClass:NSString.class] ? r[@"tint"] : nil;
    [seen addObject:rid];
    NSView *v = views[rid];
    BOOL useGlass = NO;
    if (glass) {
      if (@available(macOS 26.0, *)) useGlass = YES;
    }
    Class want = useGlass ? NSClassFromString(@"NSGlassEffectView") : NSVisualEffectView.class;
    if (v && ![v isKindOfClass:want]) {
      [v removeFromSuperview];
      v = nil;
    }
    if (!v) {
      v = [[want alloc] initWithFrame:frame];
      v.identifier = [@"sd-material-" stringByAppendingString:rid];
      if (!useGlass) ((NSVisualEffectView *)v).blendingMode = NSVisualEffectBlendingModeBehindWindow;
      [host addSubview:v positioned:NSWindowBelow relativeTo:page];
      views[rid] = v;
    }
    if (!NSEqualRects(v.frame, frame)) v.frame = frame;
    if (useGlass) {
      if (@available(macOS 26.0, *)) {
        NSGlassEffectView *g = (NSGlassEffectView *)v;
        g.style = [material isEqual:@"glass-clear"] ? NSGlassEffectViewStyleClear : NSGlassEffectViewStyleRegular;
        g.cornerRadius = radius;
        g.tintColor = tintSpec ? parse_hex_color(tintSpec) : nil;
      }
      anyGlass = YES;
    } else {
      NSVisualEffectView *fx = (NSVisualEffectView *)v;
      NSVisualEffectMaterial m = glass ? NSVisualEffectMaterialUnderWindowBackground : (NSVisualEffectMaterial)vm.integerValue;
      if (fx.material != m) fx.material = m;
      NSString *state = [r[@"state"] isKindOfClass:NSString.class] ? r[@"state"] : nil;
      fx.state = [state isEqual:@"active"] ? NSVisualEffectStateActive : [state isEqual:@"inactive"] ? NSVisualEffectStateInactive : NSVisualEffectStateFollowsWindowActiveState;
      NSNumber *had = objc_getAssociatedObject(fx, &kRegionRadiusKey);
      if (!had || had.doubleValue != radius) {
        fx.maskImage = radius > 0 ? rounded_mask(radius) : nil;
        objc_setAssociatedObject(fx, &kRegionRadiusKey, @(radius), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      }
    }
  }
  for (NSString *rid in views.allKeys)
    if (![seen containsObject:rid]) {
      [views[rid] removeFromSuperview];
      [views removeObjectForKey:rid];
    }
  objc_setAssociatedObject(w, &kRegionGlassKey, @(anyGlass), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  update_backdrop(w, page);
  return nil;
}

typedef void (^WindowOp)(PlatformCall *c, NSWindow *w, int nativeId);

static void reg(NSString *op, WindowOp body) {
  platform_register(@"window", op, ^(PlatformCall *c) {
    int id = platform_resolve_window(c);
    NSWindow *w = platform_window(id);
    if (!w) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"window.%@: no such window", c.op]];
    body(c, w, id);
  });
}

static void reg_flag(NSString *setter, NSString *getter, NSString *key, void (^set)(NSWindow *, BOOL), BOOL (^get)(NSWindow *)) {
  reg(setter, ^(PlatformCall *c, NSWindow *w, int) {
    set(w, [c boolean:@"enabled" or:YES]);
    [c ok:nil];
  });
  if (getter)
    reg(getter, ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{key : @(get(w))}]; });
}

static void set_mask(NSWindow *w, NSWindowStyleMask bit, BOOL on) {
  w.styleMask = on ? (w.styleMask | bit) : (w.styleMask & ~bit);
}

static NSString *state_name(NSWindow *w) {
  if (w.styleMask & NSWindowStyleMaskFullScreen) return @"fullscreen";
  if (w.isZoomed) return @"maximized";
  return @"normal";
}

static NSDictionary *info_row(int id) {
  NSWindow *w = platform_window(id);
  NSNumber *parent = objc_getAssociatedObject(window_parent(w), &kWindowId);
  return @{
    @"parentId" : parent ? @(platform_public_window_id(parent.intValue)) : (NSObject *)NSNull.null,
    @"modal" : @([objc_getAssociatedObject(w, &kModalWindow) boolValue]),
    @"sheetAttached" : @(w.sheetParent != nil),
    @"type" : [w isKindOfClass:NSPanel.class] ? @"panel" : @"normal",
    @"focusable" : @([(SDNativeWindow *)w sdFocusable]),
    @"windowId" : @(platform_public_window_id(id)),
    @"session" : platform_session_of(platform_webview(id)) ?: (NSObject *)NSNull.null,
    @"label" : platform_window_label(id) ?: @"",
    @"focused" : @(w.isKeyWindow),
    @"visible" : @(w.isVisible),
    @"bounds" : platform_rect_dict(platform_to_top_left(w.frame)),
  };
}

// Simple fullscreen: borderless frame over the whole screen, menu bar and Dock
// auto-hidden, no new Space.
static std::map<int, NSRect> g_simple_fs_frames;
static std::map<int, NSWindowStyleMask> g_simple_fs_masks;

static NSRect controls_rect(NSWindow *w, NSWindowButton b) {
  NSButton *btn = [w standardWindowButton:b];
  if (!btn || !btn.superview) return NSZeroRect;
  NSRect inWindow = [btn convertRect:btn.bounds toView:nil];
  CGFloat h = w.frame.size.height;
  return NSMakeRect(inWindow.origin.x, h - NSMaxY(inWindow), inWindow.size.width, inWindow.size.height);
}

// e2e tests (launch() sets SVELTE_DESKTOP_TEST): a trackpad gesture (began / changed… / ended) through
// the title-bar routing decision the scroll monitor uses, then to the window like a real one — WebKit
// scrolls (or rubber-bands) for real. {x, y}: point in the window (top-left, points); dx/dy per step
// (positive dy = scrolling up); steps. Answers mid-gesture; the gesture ends ~200 ms later.
static void send_scroll_step(NSWindow *w, NSPoint local, double dx, double dy, CGScrollPhase cgPhase, NSEventPhase phase) {
  if (platform_title_bar_scroll_filter(w, local, phase, NSEventPhaseNone)) return; // what the monitor would swallow
  CGEventRef e = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2, (int32_t)dy, (int32_t)dx, 0);
  // A synthesized event has no window: AppKit reads its location as window coordinates when the
  // window dispatches it, so place it at the window-local point.
  CGFloat primaryHeight = NSMaxY(NSScreen.screens.firstObject.frame);
  CGEventSetLocation(e, CGPointMake(local.x, primaryHeight - local.y));
  CGEventSetIntegerValueField(e, kCGScrollWheelEventIsContinuous, 1);
  CGEventSetIntegerValueField(e, kCGScrollWheelEventScrollPhase, cgPhase);
  NSEvent *ns = [NSEvent eventWithCGEvent:e];
  CFRelease(e);
  if (ns) [w sendEvent:ns];
}

static void register_test_scroll(void) {
  const char *test = getenv("SVELTE_DESKTOP_TEST");
  if (!test || strncmp(test, "ws://127.0.0.1:", 15)) return;
  platform_register(@"window", @"testScroll", ^(PlatformCall *c) {
    NSWindow *w = platform_window(platform_resolve_window(c));
    if (!w) return [c fail:@"invalid_args" message:@"window.testScroll: no such window"];
    NSPoint local = NSMakePoint([c number:@"x" or:100], NSHeight(w.frame) - [c number:@"y" or:100]);
    double dx = [c number:@"dx" or:0], dy = [c number:@"dy" or:0];
    int steps = (int)[c number:@"steps" or:10];
    send_scroll_step(w, local, 0, 0, kCGScrollPhaseBegan, NSEventPhaseBegan);
    for (int i = 1; i <= steps; i++)
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)i * 16 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        send_scroll_step(w, local, dx, dy, kCGScrollPhaseChanged, NSEventPhaseChanged);
      });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(steps * 16 + 30) * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      [c ok:nil];
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        send_scroll_step(w, local, 0, 0, kCGScrollPhaseEnded, NSEventPhaseEnded);
      });
    });
  });
}

void platform_register_window(void) {
  register_test_scroll();
  // ── multi-window ──────────────────────────────────────────────────────
  platform_register(@"window", @"create", ^(PlatformCall *c) {
    int id = platform_create_window(c.args);
    if (id == -6) return [c fail:@"invalid_args" message:@"window.create: invalid parent, modal, type or focusable option"];
    if (id == -5) return [c fail:@"invalid_args" message:@"window.create: unknown session or invalid recovery policy"];
    if (id == -4) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"window.create: label `%@` is already used", [c string:@"label"]]];
    if (id <= 0) return [c fail:@"internal" message:@"window.create failed"];
    if ([c has:@"opacity"]) platform_window(id).alphaValue = [c number:@"opacity" or:1];
    if ([c boolean:@"focus" or:YES] && [c boolean:@"focusable" or:YES] && [c boolean:@"visible" or:YES]) [NSApp activateIgnoringOtherApps:YES];
    [c ok:@{@"windowId" : @(platform_public_window_id(id)), @"label" : platform_window_label(id) ?: @""}];
  });
  platform_register(@"window", @"list", ^(PlatformCall *c) {
    NSMutableArray *rows = [NSMutableArray array];
    for (NSNumber *n in platform_window_ids()) [rows addObject:info_row(n.intValue)];
    [c ok:rows];
  });
  platform_register(@"window", @"get", ^(PlatformCall *c) {
    NSString *label = [c string:@"label"];
    for (NSNumber *n in platform_window_ids())
      if ([platform_window_label(n.intValue) isEqualToString:label]) return [c ok:info_row(n.intValue)];
    [c ok:nil];
  });

  // ── geometry ──────────────────────────────────────────────────────────
  // The calling page's own window (or windowId's): {windowId, label, focused, visible, bounds}.
  reg(@"getInfo", ^(PlatformCall *c, NSWindow *, int id) { [c ok:info_row(id)]; });
  reg(@"setParent", ^(PlatformCall *c, NSWindow *w, int) {
    id requested = c.args[@"parentId"];
    NSWindow *parent = requested == NSNull.null ? nil : parent_option(requested);
    if (requested != NSNull.null && !parent) return [c fail:@"invalid_args" message:@"window.setParent: no such parent"];
    if (NSString *error = set_parent(w, parent, [objc_getAssociatedObject(w, &kModalWindow) boolValue])) return [c fail:@"invalid_args" message:error];
    [c ok:nil];
  });
  reg(@"getParent", ^(PlatformCall *c, NSWindow *w, int) {
    NSNumber *native = objc_getAssociatedObject(window_parent(w), &kWindowId);
    [c ok:native ? info_row(native.intValue) : nil];
  });
  reg(@"getChildren", ^(PlatformCall *c, NSWindow *w, int) {
    NSMutableArray *children = [NSMutableArray array];
    for (NSNumber *native in platform_window_ids())
      if (window_parent(platform_window(native.intValue)) == w) [children addObject:info_row(native.intValue)];
    [c ok:children];
  });
  reg(@"getLevel", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.level)]; });
  reg(@"isAlwaysOnTop", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.level > NSNormalWindowLevel)]; });
  reg(@"hasShadow", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.hasShadow)]; });
  reg(@"isMovable", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.movable)]; });
  reg(@"isFocusable", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@([(id)w sdFocusable])]; });
  reg(@"getMinSize", ^(PlatformCall *c, NSWindow *w, int) {
    [c ok:@{@"width":@(w.contentMinSize.width), @"height":@(w.contentMinSize.height)}];
  });
  reg(@"getMaxSize", ^(PlatformCall *c, NSWindow *w, int) {
    NSSize size = w.contentMaxSize;
    [c ok:@{@"width":@(size.width >= FLT_MAX ? 0 : size.width), @"height":@(size.height >= FLT_MAX ? 0 : size.height)}];
  });
  reg(@"getBounds", ^(PlatformCall *c, NSWindow *w, int) {
    [c ok:@{@"bounds" : platform_rect_dict(platform_to_top_left(w.frame)), @"state" : state_name(w)}];
  });
  reg(@"setBounds", ^(PlatformCall *c, NSWindow *w, int) {
    NSRect r = NSMakeRect([c number:@"x" or:0], [c number:@"y" or:0], [c number:@"width" or:w.frame.size.width],
                          [c number:@"height" or:w.frame.size.height]);
    [w setFrame:platform_from_top_left(r) display:YES];
    [c ok:nil];
  });
  void (^size)(PlatformCall *, NSWindow *, int) = ^(PlatformCall *c, NSWindow *w, int) {
    NSSize s = [w contentRectForFrameRect:w.frame].size;
    [c ok:@{@"width" : @(s.width), @"height" : @(s.height)}];
  };
  reg(@"getSize", size);
  reg(@"getContentSize", size);
  reg(@"innerSize", size);
  reg(@"outerSize", ^(PlatformCall *c, NSWindow *w, int) {
    [c ok:@{@"width" : @(w.frame.size.width), @"height" : @(w.frame.size.height)}];
  });
  reg(@"setSize", ^(PlatformCall *c, NSWindow *w, int) {
    NSRect f = w.frame;
    NSRect content = [w contentRectForFrameRect:f];
    content.size = NSMakeSize([c number:@"width" or:content.size.width], [c number:@"height" or:content.size.height]);
    NSRect next = [w frameRectForContentRect:content];
    next.origin.y = NSMaxY(f) - next.size.height; // keep the top edge fixed
    [w setFrame:next display:YES animate:NO];
    [c ok:nil];
  });
  void (^pos)(PlatformCall *, NSWindow *, int) = ^(PlatformCall *c, NSWindow *w, int) {
    NSRect r = platform_to_top_left(w.frame);
    [c ok:@{@"x" : @(r.origin.x), @"y" : @(r.origin.y)}];
  };
  reg(@"getPosition", pos);
  reg(@"outerPosition", pos);
  reg(@"innerPosition", ^(PlatformCall *c, NSWindow *w, int) {
    NSRect r = platform_to_top_left([w contentRectForFrameRect:w.frame]);
    [c ok:@{@"x" : @(r.origin.x), @"y" : @(r.origin.y)}];
  });
  reg(@"setPosition", ^(PlatformCall *c, NSWindow *w, int) {
    NSRect r = platform_to_top_left(w.frame);
    r.origin = NSMakePoint([c number:@"x" or:r.origin.x], [c number:@"y" or:r.origin.y]);
    [w setFrame:platform_from_top_left(r) display:YES];
    [c ok:nil];
  });
  reg(@"center", ^(PlatformCall *c, NSWindow *w, int) {
    [w center];
    [c ok:nil];
  });
  reg(@"positionTo", ^(PlatformCall *c, NSWindow *w, int) {
    NSString *preset = [c string:@"preset"] ?: @"";
    NSRect f = platform_to_top_left(w.frame);
    NSPoint mouse = NSEvent.mouseLocation;
    NSRect m = platform_to_top_left(NSMakeRect(mouse.x, mouse.y, 0, 0));
    if ([preset isEqual:@"center"]) {
      [w center];
      return [c ok:nil];
    } else if ([preset isEqual:@"cursorTopLeft"]) {
      f.origin = m.origin;
    } else if ([preset isEqual:@"cursorBottomLeft"]) {
      f.origin = NSMakePoint(m.origin.x, m.origin.y - f.size.height);
    } else if ([preset hasPrefix:@"tray"]) {
      NSDictionary *t = platform_tray_button_rect();
      if (!t) return [c fail:@"unavailable" message:@"window.positionTo: no tray item is placed"];
      double tx = [t[@"x"] doubleValue], ty = [t[@"y"] doubleValue], tw = [t[@"width"] doubleValue], th = [t[@"height"] doubleValue];
      if ([preset isEqual:@"trayCenter"] || [preset isEqual:@"trayBottom"]) f.origin = NSMakePoint(tx + tw / 2 - f.size.width / 2, ty + th);
      else if ([preset isEqual:@"trayLeft"]) f.origin = NSMakePoint(tx, ty + th);
      else if ([preset isEqual:@"trayRight"]) f.origin = NSMakePoint(tx + tw - f.size.width, ty + th);
      else if ([preset isEqual:@"trayTop"]) f.origin = NSMakePoint(tx + tw / 2 - f.size.width / 2, ty - f.size.height);
      else return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"window.positionTo: unknown preset `%@`", preset]];
    } else {
      return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"window.positionTo: unknown preset `%@`", preset]];
    }
    [w setFrame:platform_from_top_left(f) display:YES];
    [c ok:nil];
  });
  reg(@"setMinSize", ^(PlatformCall *c, NSWindow *w, int) {
    double width = [c number:@"width" or:0], height = [c number:@"height" or:0];
    w.contentMinSize = (width || height) ? NSMakeSize(width, height) : NSMakeSize(1, 1);
    [c ok:nil];
  });
  reg(@"setMaxSize", ^(PlatformCall *c, NSWindow *w, int) {
    double width = [c number:@"width" or:0], height = [c number:@"height" or:0];
    w.contentMaxSize = (width || height) ? NSMakeSize(width ?: CGFLOAT_MAX, height ?: CGFLOAT_MAX) : NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
    [c ok:nil];
  });
  reg(@"getScaleFactor", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.backingScaleFactor)]; });
  reg(@"getCursorPoint", ^(PlatformCall *c, NSWindow *w, int) {
    NSPoint p = w.mouseLocationOutsideOfEventStream;
    NSRect content = w.contentLayoutRect;
    [c ok:@{@"x" : @(p.x), @"y" : @(NSMaxY(content) - p.y)}];
  });
  reg(@"controlsArea", ^(PlatformCall *c, NSWindow *w, int) {
    NSButton *close = [w standardWindowButton:NSWindowCloseButton];
    if (!close || close.superview == nil) return [c ok:nil];
    NSDictionary *names = @{@"close" : @(NSWindowCloseButton), @"minimize" : @(NSWindowMiniaturizeButton), @"zoom" : @(NSWindowZoomButton)};
    NSMutableDictionary *buttons = [NSMutableDictionary dictionary];
    NSRect u = NSZeroRect;
    for (NSString *name in names) {
      NSWindowButton b = (NSWindowButton)[names[name] integerValue];
      NSRect r = controls_rect(w, b);
      if (NSIsEmptyRect(r)) continue;
      NSMutableDictionary *d = [platform_rect_dict(r) mutableCopy];
      d[@"visible"] = @(![w standardWindowButton:b].isHidden);
      buttons[name] = d;
      u = NSIsEmptyRect(u) ? r : NSUnionRect(u, r);
    }
    NSMutableDictionary *out = [platform_rect_dict(u) mutableCopy];
    out[@"contentTop"] = @(w.frame.size.height - NSMaxY(w.contentLayoutRect));
    out[@"side"] = @"left";
    out[@"buttons"] = buttons;
    [c ok:out];
  });

  // ── state ─────────────────────────────────────────────────────────────
  reg(@"getTitle", ^(PlatformCall *c, NSWindow *w, int) { [c ok:w.title ?: @""]; });
  // Run JS in the window's page; resolves with its JSON-serializable result.
  reg(@"eval", ^(PlatformCall *c, NSWindow *, int wid) {
    NSString *js = [c string:@"js"];
    if (!js) return [c fail:@"invalid_args" message:@"window.eval: `js` is required"];
    [platform_webview(wid) evaluateJavaScript:js completionHandler:^(id result, NSError *err) {
      if (err) return [c fail:@"internal" message:err.localizedDescription];
      [c ok:[NSJSONSerialization isValidJSONObject:@[ result ?: NSNull.null ]] ? result : [result description]];
    }];
  });
  reg(@"setTitle", ^(PlatformCall *c, NSWindow *w, int) {
    w.title = [c string:@"title"] ?: @"";
    [c ok:nil];
  });
  reg(@"minimize", ^(PlatformCall *c, NSWindow *w, int) {
    [w miniaturize:nil];
    [c ok:nil];
  });
  reg(@"unminimize", ^(PlatformCall *c, NSWindow *w, int) {
    [w deminiaturize:nil];
    [c ok:nil];
  });
  reg(@"isMinimized", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"minimized" : @(w.isMiniaturized)}]; });
  reg(@"maximize", ^(PlatformCall *c, NSWindow *w, int) {
    if (!w.isZoomed) [w zoom:nil];
    [c ok:@{@"maximized" : @(w.isZoomed)}];
  });
  reg(@"unmaximize", ^(PlatformCall *c, NSWindow *w, int) {
    if (w.isZoomed) [w zoom:nil];
    [c ok:@{@"maximized" : @(w.isZoomed)}];
  });
  reg(@"toggleMaximize", ^(PlatformCall *c, NSWindow *w, int) {
    [w zoom:nil];
    [c ok:@{@"maximized" : @(w.isZoomed)}];
  });
  reg(@"isMaximized", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.isZoomed)]; });
  reg(@"isFullscreen", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@((w.styleMask & NSWindowStyleMaskFullScreen) != 0)]; });
  reg(@"setFullscreen", ^(PlatformCall *c, NSWindow *w, int) {
    BOOL want = [c boolean:@"fullscreen" or:YES];
    BOOL is = (w.styleMask & NSWindowStyleMaskFullScreen) != 0;
    if (want != is && !(w.collectionBehavior & NSWindowCollectionBehaviorFullScreenPrimary))
      return [c fail:@"unsupported" message:@"panels and modal children do not own native fullscreen Spaces"];
    if (want != is) [w toggleFullScreen:nil];
    [c ok:@{@"fullscreen" : @(want)}]; // the transition animates; the state lands ~0.5–1 s later
  });
  reg(@"toggleFullscreen", ^(PlatformCall *c, NSWindow *w, int) {
    if (!(w.collectionBehavior & NSWindowCollectionBehaviorFullScreenPrimary))
      return [c fail:@"unsupported" message:@"panels and modal children do not own native fullscreen Spaces"];
    BOOL is = (w.styleMask & NSWindowStyleMaskFullScreen) != 0;
    [w toggleFullScreen:nil];
    [c ok:@{@"fullscreen" : @(!is)}];
  });
  reg(@"restore", ^(PlatformCall *c, NSWindow *w, int) {
    if (w.isMiniaturized) [w deminiaturize:nil];
    if (w.styleMask & NSWindowStyleMaskFullScreen) [w toggleFullScreen:nil];
    else if (w.isZoomed) [w zoom:nil];
    [c ok:nil];
  });
  reg(@"setSimpleFullscreen", ^(PlatformCall *c, NSWindow *w, int id) {
    BOOL on = [c boolean:@"enabled" or:YES];
    BOOL is = g_simple_fs_frames.count(id) > 0;
    if (on && !is) {
      g_simple_fs_frames[id] = w.frame;
      g_simple_fs_masks[id] = w.styleMask;
      NSApp.presentationOptions = NSApplicationPresentationAutoHideMenuBar | NSApplicationPresentationAutoHideDock;
      w.styleMask = NSWindowStyleMaskBorderless;
      [w setFrame:(w.screen ?: NSScreen.mainScreen).frame display:YES];
    } else if (!on && is) {
      NSApp.presentationOptions = NSApplicationPresentationDefault;
      w.styleMask = g_simple_fs_masks[id];
      [w setFrame:g_simple_fs_frames[id] display:YES];
      g_simple_fs_frames.erase(id);
      g_simple_fs_masks.erase(id);
    }
    [c ok:nil];
  });
  reg(@"isSimpleFullscreen", ^(PlatformCall *c, NSWindow *, int id) { [c ok:@{@"simpleFullscreen" : @(g_simple_fs_frames.count(id) > 0)}]; });
  reg(@"isFocused", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.isKeyWindow)]; });
  reg(@"isActive", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.isKeyWindow && NSApp.isActive)]; });
  reg(@"focus", ^(PlatformCall *c, NSWindow *w, int) {
    if (!w.canBecomeKeyWindow) return [c fail:@"unavailable" message:@"window.focus: this window is not focusable"];
    [NSApp unhide:nil];
    [w makeKeyAndOrderFront:nil];
    // Best effort, like a browser's window.focus(): macOS may keep another app in front (it decides);
    // the answer says whether the app is active now, it doesn't fail.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [NSApp activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
    [c ok:@{@"activated" : @(NSApp.isActive)}];
  });
  reg(@"blur", ^(PlatformCall *c, NSWindow *w, int) {
    [w resignKeyWindow];
    for (NSNumber *n in platform_window_ids())
      if (platform_window(n.intValue) != w && platform_window(n.intValue).isVisible) {
        [platform_window(n.intValue) makeKeyWindow];
        break;
      }
    [c ok:nil];
  });
  reg(@"isHovered", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"hovered" : @(NSPointInRect(NSEvent.mouseLocation, w.frame))}]; });
  reg(@"isOccluded", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(!(w.occlusionState & NSWindowOcclusionStateVisible))]; });
  reg(@"isVisible", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.isVisible && w.alphaValue > 0)]; });
  reg(@"show", ^(PlatformCall *c, NSWindow *w, int) {
    if (w.alphaValue == 0) w.alphaValue = 1;
    platform_window_present(w);
    [c ok:nil];
  });
  reg(@"hide", ^(PlatformCall *c, NSWindow *w, int) {
    objc_setAssociatedObject(w, &kSuspendedSheet, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    hide_owned_window(w, ^{ [c ok:nil]; });
  });
  reg(@"close", ^(PlatformCall *c, NSWindow *w, int id) {
    platform_set_close_veto(id, NO); // programmatic close bypasses the veto
    if ([objc_getAssociatedObject(w, &kModalWindow) boolValue]) {
      close_owned_window(w, ^{ [c ok:nil]; });
      return;
    }
    [c ok:nil];
    [w performClose:nil];
  });
  reg(@"setCloseVeto", ^(PlatformCall *c, NSWindow *, int id) {
    BOOL on = [c boolean:@"enabled" or:YES];
    platform_set_close_veto(id, on);
    [c ok:@{@"armed" : @(on)}];
  });
  reg_flag(@"requestAttention", nil, nil, ^(NSWindow *, BOOL) { [NSApp requestUserAttention:NSInformationalRequest]; }, nil);
  reg(@"flashFrame", ^(PlatformCall *c, NSWindow *, int) {
    [NSApp requestUserAttention:NSInformationalRequest];
    [c ok:nil];
  });
  reg(@"setRepresentedFilename", ^(PlatformCall *c, NSWindow *w, int) {
    NSString *path = [c string:@"path"];
    w.representedURL = path.length ? [NSURL fileURLWithPath:path] : nil;
    [c ok:nil];
  });
  reg(@"showCharacterPalette", ^(PlatformCall *c, NSWindow *w, int) {
    [w makeKeyAndOrderFront:nil];
    [NSApp orderFrontCharacterPalette:nil];
    [c ok:nil];
  });

  // ── z-order + chrome ──────────────────────────────────────────────────
  reg_flag(@"setAlwaysOnTop", nil, nil, ^(NSWindow *w, BOOL on) { w.level = on ? NSFloatingWindowLevel : NSNormalWindowLevel; }, nil);
  reg_flag(@"setAlwaysOnBottom", nil, nil, ^(NSWindow *w, BOOL on) { w.level = on ? kCGDesktopIconWindowLevel + 1 : NSNormalWindowLevel; }, nil);
  reg_flag(@"setResizable", @"isResizable", @"resizable", ^(NSWindow *w, BOOL on) { set_mask(w, NSWindowStyleMaskResizable, on); },
           ^BOOL(NSWindow *w) { return (w.styleMask & NSWindowStyleMaskResizable) != 0; });
  reg_flag(@"setClosable", @"isClosable", @"closable", ^(NSWindow *w, BOOL on) { set_mask(w, NSWindowStyleMaskClosable, on); },
           ^BOOL(NSWindow *w) { return (w.styleMask & NSWindowStyleMaskClosable) != 0; });
  reg_flag(@"setMinimizable", @"isMinimizable", @"minimizable", ^(NSWindow *w, BOOL on) { set_mask(w, NSWindowStyleMaskMiniaturizable, on); },
           ^BOOL(NSWindow *w) { return (w.styleMask & NSWindowStyleMaskMiniaturizable) != 0; });
  reg_flag(@"setMaximizable", @"isMaximizable", @"maximizable",
           ^(NSWindow *w, BOOL on) { [w standardWindowButton:NSWindowZoomButton].enabled = on; },
           ^BOOL(NSWindow *w) { return [w standardWindowButton:NSWindowZoomButton].isEnabled; });
  reg(@"setTitleBarStyle", ^(PlatformCall *c, NSWindow *w, int native) {
    NSString *style = [c string:@"style"] ?: @"default";
    if (![@[ @"default", @"transparent", @"hidden", @"hiddenInset" ] containsObject:style])
      return [c fail:@"invalid_args" message:@"window.setTitleBarStyle: style is default | transparent | hidden | hiddenInset"];
    platform_apply_title_bar_style(w, platform_webview(native), style);
    [c ok:nil];
  });
  reg(@"getTitleBarStyle", ^(PlatformCall *c, NSWindow *w, int) {
    [c ok:@{@"style" : objc_getAssociatedObject(w, &kStyleKey) ?: @"default", @"frameless" : @NO}]; // the traffic lights stay
  });
  reg_flag(@"setDecorations", nil, nil, ^(NSWindow *w, BOOL on) {
    if (on) w.styleMask |= NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable;
    else w.styleMask &= ~(NSWindowStyleMaskTitled);
  }, nil);
  reg_flag(@"setHasShadow", nil, nil, ^(NSWindow *w, BOOL on) { w.hasShadow = on; }, nil);
  reg(@"invalidateShadow", ^(PlatformCall *c, NSWindow *w, int) {
    [w invalidateShadow];
    [c ok:nil];
  });

  // ── appearance + behavior ─────────────────────────────────────────────
  reg(@"setTrafficLightPosition", ^(PlatformCall *c, NSWindow *w, int id) {
    NSDictionary *at = [c.args[@"position"] isKindOfClass:NSDictionary.class] ? c.args[@"position"] : nil;
    platform_window_set_traffic_lights(w, platform_webview(id), at ? [NSValue valueWithPoint:NSMakePoint([at[@"x"] doubleValue], [at[@"y"] doubleValue])] : nil);
    [c ok:nil];
  });
  // Width / height kept while resizing (16/9, 1 for a square), or null.
  reg(@"setAspectRatio", ^(PlatformCall *c, NSWindow *w, int) {
    double ratio = [c number:@"ratio" or:0];
    if (ratio > 0) w.contentAspectRatio = NSMakeSize(ratio, 1);
    else w.contentResizeIncrements = NSMakeSize(1, 1); // clears the aspect ratio
    [c ok:nil];
  });
  reg(@"setVibrancy", ^(PlatformCall *c, NSWindow *w, int id) {
    NSString *material = [c.args[@"material"] isKindOfClass:NSString.class] ? c.args[@"material"] : nil;
    if (NSString *err = platform_window_set_vibrancy(w, id, material, [c string:@"state"])) return [c fail:@"invalid_args" message:[@"window.setVibrancy: " stringByAppendingString:err]];
    [c ok:nil];
  });
  reg(@"setGlass", ^(PlatformCall *c, NSWindow *w, int id) {
    NSDictionary *opts = [c.args[@"glass"] isKindOfClass:NSDictionary.class] ? c.args[@"glass"] : nil;
    BOOL glass = NO;
    if (NSString *err = platform_window_set_glass(w, id, opts, &glass)) return [c fail:@"invalid_args" message:[@"window.setGlass: " stringByAppendingString:err]];
    [c ok:opts ? @{@"glass" : @(glass)} : nil];
  });
  reg(@"setMaterialRegions", ^(PlatformCall *c, NSWindow *w, int id) {
    NSArray *regions = [c.args[@"regions"] isKindOfClass:NSArray.class] ? c.args[@"regions"] : @[];
    if (NSString *err = apply_material_regions(w, id, regions)) return [c fail:@"invalid_args" message:[@"window.setMaterialRegions: " stringByAppendingString:err]];
    [c ok:nil];
  });
  reg(@"setOpacity", ^(PlatformCall *c, NSWindow *w, int) {
    w.alphaValue = MAX(0, MIN(1, [c number:@"opacity" or:1]));
    [c ok:nil];
  });
  reg(@"getOpacity", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"opacity" : @(w.alphaValue)}]; });
  reg_flag(@"setMovable", nil, nil, ^(NSWindow *w, BOOL on) { w.movable = on; }, nil);
  reg_flag(@"setMovableByWindowBackground", nil, nil, ^(NSWindow *w, BOOL on) { w.movableByWindowBackground = on; }, nil);
  reg_flag(@"setIgnoresMouseEvents", @"ignoresMouseEvents", @"ignored", ^(NSWindow *w, BOOL on) { w.ignoresMouseEvents = on; },
           ^BOOL(NSWindow *w) { return w.ignoresMouseEvents; });
  reg(@"setContentProtected", ^(PlatformCall *c, NSWindow *w, int) {
    BOOL on = [c boolean:@"enabled" or:YES];
    w.sharingType = on ? NSWindowSharingNone : NSWindowSharingReadOnly;
    // Observed on macOS 26: once a window is NSWindowSharingNone it can't be
    // switched back (the setter is ignored). Report it instead of faking state.
    if (!on && w.sharingType == NSWindowSharingNone)
      return [c fail:@"unsupported" message:@"window.setContentProtected(false): macOS keeps a window protected once enabled"];
    [c ok:nil];
  });
  reg(@"isContentProtected", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"contentProtected" : @(w.sharingType == NSWindowSharingNone)}]; });
  reg_flag(@"setVisibleOnAllWorkspaces", nil, nil, ^(NSWindow *w, BOOL on) {
    w.collectionBehavior = on ? (w.collectionBehavior | NSWindowCollectionBehaviorCanJoinAllSpaces)
                              : (w.collectionBehavior & ~NSWindowCollectionBehaviorCanJoinAllSpaces);
  }, nil);
  reg(@"setDocumentEdited", ^(PlatformCall *c, NSWindow *w, int) {
    w.documentEdited = [c boolean:@"edited" or:YES];
    [c ok:nil];
  });
  reg(@"isDocumentEdited", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@{@"edited" : @(w.isDocumentEdited)}]; });
  reg(@"setFocusable", ^(PlatformCall *c, NSWindow *w, int) {
    BOOL enabled = [c boolean:@"enabled" or:YES];
    if (!enabled && [objc_getAssociatedObject(w, &kModalWindow) boolValue]) return [c fail:@"invalid_args" message:@"modal windows must be focusable"];
    [(id)w setSdFocusable:enabled];
    if (!enabled && w.isKeyWindow) [w resignKeyWindow];
    [c ok:nil];
  });
  // NSCursor counts: hiding twice would need showing twice, and no one could read the state.
  reg(@"setCursorHidden", ^(PlatformCall *c, NSWindow *, int) {
    BOOL hidden = [c boolean:@"hidden" or:YES];
    if (hidden != g_cursor_hidden) hidden ? [NSCursor hide] : [NSCursor unhide];
    g_cursor_hidden = hidden;
    [c ok:nil];
  });
  reg(@"setCursorPosition", ^(PlatformCall *c, NSWindow *, int) {
    CGWarpMouseCursorPosition(CGPointMake([c number:@"x" or:0], [c number:@"y" or:0])); // CG space is top-left already
    [c ok:nil];
  });
  reg(@"setTheme", ^(PlatformCall *c, NSWindow *w, int) {
    NSString *t = [c string:@"theme"] ?: @"system";
    w.appearance = [t isEqual:@"dark"]    ? [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]
                   : [t isEqual:@"light"] ? [NSAppearance appearanceNamed:NSAppearanceNameAqua]
                                          : nil;
    [c ok:nil];
  });
  reg(@"isCursorHidden", ^(PlatformCall *c, NSWindow *, int) { [c ok:@(g_cursor_hidden)]; });
  reg(@"hasCloseVeto", ^(PlatformCall *c, NSWindow *, int id) { [c ok:@(platform_close_veto(id))]; });
  reg(@"getRepresentedFilename", ^(PlatformCall *c, NSWindow *w, int) { [c ok:w.representedURL.path]; });
  reg(@"isAlwaysOnBottom", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.level == kCGDesktopIconWindowLevel + 1)]; });
  reg(@"hasDecorations", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@((w.styleMask & NSWindowStyleMaskTitled) != 0)]; });
  reg(@"isMovableByWindowBackground", ^(PlatformCall *c, NSWindow *w, int) { [c ok:@(w.movableByWindowBackground)]; });
  reg(@"getTrafficLightPosition", ^(PlatformCall *c, NSWindow *w, int) {
    NSValue *at = objc_getAssociatedObject(w, &kTrafficLightsKey);
    [c ok:at ? @{@"x" : @(at.pointValue.x), @"y" : @(at.pointValue.y)} : nil];
  });
  reg(@"getTheme", ^(PlatformCall *c, NSWindow *w, int) {
    NSAppearance *a = w.appearance;
    [c ok:!a ? @"system" : [a.name isEqual:NSAppearanceNameDarkAqua] ? @"dark" : @"light"];
  });
  reg(@"isVisibleOnAllWorkspaces", ^(PlatformCall *c, NSWindow *w, int) {
    [c ok:@((w.collectionBehavior & NSWindowCollectionBehaviorCanJoinAllSpaces) != 0)];
  });
  reg(@"getAspectRatio", ^(PlatformCall *c, NSWindow *w, int) {
    NSSize r = w.contentAspectRatio;
    [c ok:r.width > 0 && r.height > 0 ? @(r.width / r.height) : nil];
  });
  reg(@"getVibrancy", ^(PlatformCall *c, NSWindow *w, int) {
    for (NSView *v in w.contentView.subviews) {
      if (![v.identifier isEqual:kVibrancyId]) continue;
      NSVisualEffectView *fx = (NSVisualEffectView *)v;
      NSString *state = fx.state == NSVisualEffectStateActive ? @"active" : fx.state == NSVisualEffectStateInactive ? @"inactive" : @"followsWindow";
      return [c ok:@{@"material" : objc_getAssociatedObject(fx, &kMaterialNameKey), @"state" : state}];
    }
    [c ok:nil];
  });
  reg(@"getGlass", ^(PlatformCall *c, NSWindow *w, int) {
    if (@available(macOS 26.0, *)) {
      for (NSView *v in w.contentView.subviews) {
        if (![v.identifier isEqual:kGlassId]) continue;
        NSGlassEffectView *g = (NSGlassEffectView *)v;
        NSMutableDictionary *d = [@{@"style" : g.style == NSGlassEffectViewStyleClear ? @"clear" : @"regular", @"cornerRadius" : @(g.cornerRadius)} mutableCopy];
        d[@"tint"] = objc_getAssociatedObject(g, &kGlassTintKey);
        return [c ok:d];
      }
    }
    [c ok:nil];
  });
}
