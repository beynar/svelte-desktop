// popover.* — web content (a route of the app) in a native popover.
//
//   style "popover": NSPopover with the arrow, anchored to the tray button, a rect
//                    of a window's page, the cursor or a screen rect.
//   style "panel":   borderless translucent NSPanel (Spotlight-like, no arrow),
//                    non-activating, placed under the tray, centered, at the
//                    cursor or at {x,y}.
//
// Every popover owns one WKWebView created at popover.create and kept warm in an
// invisible staging window, so the first show paints immediately (WKWebView
// does not render while detached/hidden). Same data store as the windows, so
// the app session cookie applies; the page bridge (window.__shell) is attached
// and `window.__shellPopover = {id}` is injected so the page knows where it is.
//
// Ops: create, show, hide, toggle, setSize, setPosition, isShown, get, list, eval, reload, destroy;
// events.emit fans a {channel, data} message out to every page (popover ↔ windows).
// Events: popoverReady, popoverShown, popoverHidden {id}.
#include "platform_internal.h"

@interface SDPanel : NSPanel
@end
@implementation SDPanel
- (BOOL)canBecomeKeyWindow { return YES; }
@end

@interface SDPopover : NSObject <NSPopoverDelegate, NSWindowDelegate>
@property(nonatomic, copy) NSString *ident;
@property(nonatomic) int nativeId;
@property(nonatomic, copy) NSString *style;    // popover | panel
@property(nonatomic, copy) NSString *behavior; // transient | semitransient | manual
@property(nonatomic, copy) NSString *url;
@property(nonatomic) CGFloat width, height;
@property(nonatomic) BOOL closeOnEscape, activate, ready, loaded;
@property(nonatomic, copy) void (^pendingShow)(void); // preload:false — show once the page is ready
@property(nonatomic) NSRectEdge edge;
@property(nonatomic, strong) id position; // panel placement: preset string or {x,y}
@property(nonatomic, strong) WKWebView *webview;
@property(nonatomic, strong) NSView *container;
@property(nonatomic, strong) NSWindow *stage;
@property(nonatomic, strong) NSPopover *popover;
@property(nonatomic, strong) SDPanel *panel;
@property(nonatomic, strong) NSWindow *anchorWindow; // 1×1 helper for screen-point anchors
@property(nonatomic, strong) id<WKNavigationDelegate> nav;
@property(nonatomic) CFTimeInterval lastClosedAt;
@property(nonatomic, strong) id outsideMonitor; // panel: global mouse-down → dismiss
@property(nonatomic, strong) id keyObserver;    // panel: another of our windows took key → dismiss
- (BOOL)shown;
@end

static NSMutableDictionary<NSString *, SDPopover *> *g_popovers;
static NSString *g_tray_popover;
static int g_next_native = 1000;

static SDPopover *find_native(int nativeId) {
  for (SDPopover *p in g_popovers.allValues)
    if (p.nativeId == nativeId) return p;
  return nil;
}

static NSDictionary *describe(SDPopover *p) {
  return @{@"id" : p.ident, @"style" : p.style, @"shown" : @(p.shown), @"width" : @(p.width), @"height" : @(p.height),
           @"url" : p.url ?: NSNull.null, @"ready" : @(p.ready),
           @"key" : @(p.webview.window.isKeyWindow), @"appActive" : @(NSApp.isActive)};
}

@implementation SDPopover
- (BOOL)shown {
  return [self.style isEqual:@"panel"] ? self.panel.isVisible : self.popover.isShown;
}
- (void)moveContainerInto:(NSView *)host {
  if (self.container.superview == host) return;
  [self.container removeFromSuperview];
  self.container.frame = host.bounds;
  self.container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [host addSubview:self.container];
}
- (void)focusContent {
  NSWindow *w = self.webview.window;
  [w makeKeyWindow];
  [w makeFirstResponder:self.webview];
}
- (void)stopDismissWatch {
  if (self.outsideMonitor) [NSEvent removeMonitor:self.outsideMonitor];
  if (self.keyObserver) [NSNotificationCenter.defaultCenter removeObserver:self.keyObserver];
  self.outsideMonitor = nil;
  self.keyObserver = nil;
}
// Panels are non-activating, so resignKey alone misses clicks in other apps
// and focus moves that race the show. Watch both explicitly while visible.
- (void)startDismissWatch {
  [self stopDismissWatch];
  if ([self.behavior isEqual:@"manual"]) return;
  SDPopover *__weak weak = self;
  self.outsideMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown
                                                               handler:^(NSEvent *) { [weak dismissPanel]; }];
  self.keyObserver = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidBecomeKeyNotification object:nil queue:nil
                                                                 usingBlock:^(NSNotification *n) {
                                                                   if (n.object != weak.panel) [weak dismissPanel];
                                                                 }];
}
- (void)dismissPanel {
  if (!self.panel.isVisible) return;
  [self.panel orderOut:nil];
  [self didHide];
}
- (void)didHide {
  [self stopDismissWatch];
  self.lastClosedAt = NSProcessInfo.processInfo.systemUptime;
  platform_emit(@"popoverHidden", @{@"id" : self.ident});
}
// NSPopoverDelegate
- (void)popoverDidShow:(NSNotification *)n { platform_emit(@"popoverShown", @{@"id" : self.ident}); }
- (void)popoverDidClose:(NSNotification *)n {
  // Only now: ordering the anchor window out mid-animation aborts the close.
  [self.anchorWindow orderOut:nil];
  [self didHide];
}
// Panel: light dismiss when it loses key status.
- (void)windowDidResignKey:(NSNotification *)n {
  if (n.object == self.panel && ![self.behavior isEqual:@"manual"]) [self dismissPanel];
}
@end

// ---------------------------------------------------------------------------
// Creation

static NSString *const kPopoverScript = @"window.__shellPopover=Object.freeze({id:%@});"
                                         "document.documentElement.setAttribute('data-shell-popover','');";

static SDPopover *build(PlatformCall *c, NSString *ident, NSString **error) {
  NSString *url = [c string:@"url"];
  if (!url) {
    NSString *route = [c string:@"route"] ?: @"/";
    NSString *origin = platform_app_origin();
    if (!origin) {
      *error = @"popover.create: the app origin isn't known yet (create popovers after the shell is ready)";
      return nil;
    }
    url = [origin stringByAppendingString:[route hasPrefix:@"/"] ? route : [@"/" stringByAppendingString:route]];
  }
  SDPopover *p = [SDPopover new];
  p.ident = ident;
  p.nativeId = g_next_native++;
  p.style = [[c string:@"style"] isEqual:@"panel"] ? @"panel" : @"popover";
  p.behavior = [c string:@"behavior"] ?: @"transient";
  p.url = url;
  p.width = MAX(40, [c number:@"width" or:320]);
  p.height = MAX(24, [c number:@"height" or:240]);
  p.closeOnEscape = [c boolean:@"closeOnEscape" or:YES];
  p.activate = [c boolean:@"activate" or:YES];
  p.position = c.args[@"position"] ?: @"tray";
  NSString *edge = [c string:@"edge"] ?: @"bottom";
  p.edge = [edge isEqual:@"top"] ? NSMaxYEdge : [edge isEqual:@"left"] ? NSMinXEdge : [edge isEqual:@"right"] ? NSMaxXEdge : NSMinYEdge;

  WKWebViewConfiguration *config = [WKWebViewConfiguration new]; // default data store: shares the session cookie
  if ([c boolean:@"debug" or:NO]) [config.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
  NSString *script = [NSString stringWithFormat:kPopoverScript,
                                                [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:ident options:NSJSONWritingFragmentsAllowed error:nil]
                                                                      encoding:NSUTF8StringEncoding]];
  [config.userContentController addUserScript:[[WKUserScript alloc] initWithSource:script
                                                                     injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                                  forMainFrameOnly:YES]];
  NSRect frame = NSMakeRect(0, 0, p.width, p.height);
  p.webview = [[WKWebView alloc] initWithFrame:frame configuration:config];
  p.webview.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  if ([c boolean:@"transparent" or:YES]) {
    [p.webview setValue:@NO forKey:@"drawsBackground"]; // let the popover's vibrancy show through
    if (@available(macOS 12.0, *)) p.webview.underPageBackgroundColor = NSColor.clearColor;
  }
  if (@available(macOS 13.3, *)) p.webview.inspectable = [c boolean:@"debug" or:NO];
  p.nav = shell_make_nav_delegate(p.nativeId);
  p.webview.navigationDelegate = p.nav;
  platform_attach_webview(p.nativeId, p.webview);
  platform_webview_configure(p.nativeId, p.webview);

  p.container = [[NSView alloc] initWithFrame:frame];
  [p.container addSubview:p.webview];

  // Warm staging: on screen but fully transparent and click-through, so WebKit
  // lays out and paints before the first show.
  NSRect screen = NSScreen.screens.firstObject.visibleFrame;
  p.stage = [[NSWindow alloc] initWithContentRect:NSMakeRect(NSMinX(screen), NSMinY(screen), p.width, p.height)
                                        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
  p.stage.releasedWhenClosed = NO;
  p.stage.alphaValue = 0;
  p.stage.ignoresMouseEvents = YES;
  p.stage.collectionBehavior = NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle;
  [p moveContainerInto:p.stage.contentView];
  [p.stage orderBack:nil];

  if ([p.style isEqual:@"panel"]) {
    p.panel = [[SDPanel alloc] initWithContentRect:frame
                                         styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                           backing:NSBackingStoreBuffered defer:NO];
    p.panel.releasedWhenClosed = NO;
    p.panel.opaque = NO;
    p.panel.backgroundColor = NSColor.clearColor;
    p.panel.hasShadow = YES;
    p.panel.level = NSPopUpMenuWindowLevel;
    p.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    p.panel.hidesOnDeactivate = NO;
    p.panel.delegate = p;
    NSVisualEffectView *fx = [[NSVisualEffectView alloc] initWithFrame:frame];
    fx.material = NSVisualEffectMaterialPopover;
    fx.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    fx.state = NSVisualEffectStateActive;
    fx.wantsLayer = YES;
    fx.layer.cornerRadius = [c number:@"cornerRadius" or:12];
    fx.layer.masksToBounds = YES;
    p.panel.contentView = fx;
  } else {
    p.popover = [NSPopover new];
    NSViewController *vc = [NSViewController new];
    vc.view = [[NSView alloc] initWithFrame:frame];
    p.popover.contentViewController = vc;
    p.popover.contentSize = frame.size;
    p.popover.behavior = [p.behavior isEqual:@"manual"]          ? NSPopoverBehaviorApplicationDefined
                         : [p.behavior isEqual:@"semitransient"] ? NSPopoverBehaviorSemitransient
                                                                 : NSPopoverBehaviorTransient;
    p.popover.animates = [c boolean:@"animate" or:YES];
    p.popover.delegate = p;
  }
  // preload (default): load now, keep warm — instant first show at the cost of a
  // WebKit content process per popover. preload:false loads on first show.
  if ([c boolean:@"preload" or:YES]) {
    p.loaded = YES;
    [p.webview loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:url]]];
  }
  return p;
}

static void destroy(SDPopover *p) {
  [p stopDismissWatch];
  if (p.popover.isShown) [p.popover close];
  [p.panel orderOut:nil];
  platform_detach_webview(p.nativeId);
  [p.webview stopLoading];
  [p.container removeFromSuperview];
  [p.stage orderOut:nil];
  [p.anchorWindow orderOut:nil];
  if ([g_tray_popover isEqual:p.ident]) g_tray_popover = nil;
  [g_popovers removeObjectForKey:p.ident];
}

// ---------------------------------------------------------------------------
// Placement

static NSScreen *screen_containing(NSRect r) {
  for (NSScreen *s in NSScreen.screens)
    if (NSIntersectsRect(s.frame, r)) return s;
  return NSScreen.mainScreen ?: NSScreen.screens.firstObject;
}

static NSRect clamp_to_screen(NSRect r) {
  NSRect vis = screen_containing(r).visibleFrame;
  r.origin.x = MAX(NSMinX(vis) + 4, MIN(r.origin.x, NSMaxX(vis) - r.size.width - 4));
  r.origin.y = MAX(NSMinY(vis) + 4, MIN(r.origin.y, NSMaxY(vis) - r.size.height));
  return r;
}

// Panel frame (bottom-left coords) for a placement; nil error on success.
static NSString *panel_frame(SDPopover *p, id position, NSRect *out) {
  NSSize size = NSMakeSize(p.width, p.height);
  if ([position isKindOfClass:NSDictionary.class] && position[@"x"] && position[@"y"]) {
    *out = platform_from_top_left(NSMakeRect([position[@"x"] doubleValue], [position[@"y"] doubleValue], size.width, size.height));
    return nil;
  }
  NSString *preset = [position isKindOfClass:NSString.class] ? position : @"tray";
  if ([preset hasPrefix:@"tray"]) {
    NSDictionary *t = platform_tray_button_rect();
    if (!t) {
      preset = @"center"; // no tray (programmatic open): fall back rather than strand it offscreen
    } else {
      double tx = [t[@"x"] doubleValue], ty = [t[@"y"] doubleValue], tw = [t[@"width"] doubleValue], th = [t[@"height"] doubleValue];
      double x = [preset isEqual:@"trayLeft"] ? tx : [preset isEqual:@"trayRight"] ? tx + tw - size.width : tx + tw / 2 - size.width / 2;
      *out = clamp_to_screen(platform_from_top_left(NSMakeRect(x, ty + th + 4, size.width, size.height)));
      return nil;
    }
  }
  if ([preset isEqual:@"cursor"]) {
    NSPoint m = NSEvent.mouseLocation;
    *out = clamp_to_screen(NSMakeRect(m.x - size.width / 2, m.y - size.height - 8, size.width, size.height));
    return nil;
  }
  if ([preset isEqual:@"center"]) {
    NSRect vis = (NSScreen.mainScreen ?: NSScreen.screens.firstObject).visibleFrame;
    // Spotlight-ish: horizontally centered, upper third.
    *out = NSMakeRect(NSMidX(vis) - size.width / 2, NSMaxY(vis) - vis.size.height / 3 - size.height / 2, size.width, size.height);
    return nil;
  }
  return [NSString stringWithFormat:@"popover: unknown position `%@` (tray|trayLeft|trayRight|center|cursor|{x,y})", preset];
}

// NSPopover anchor: a view + rect in that view.
static NSString *popover_anchor(SDPopover *p, NSDictionary *args, int caller, NSView **view, NSRect *rect) {
  id anchor = args[@"anchor"] ?: @"tray";
  if ([anchor isEqual:@"tray"]) {
    NSStatusBarButton *b = platform_tray_button();
    if (!b) return @"popover.show: anchor `tray` needs a tray item (tray.set)";
    *view = b;
    *rect = b.bounds;
    return nil;
  }
  NSRect screenRect;
  if ([anchor isEqual:@"cursor"]) {
    NSPoint m = NSEvent.mouseLocation;
    screenRect = NSMakeRect(m.x, m.y, 1, 1);
  } else if ([anchor isKindOfClass:NSDictionary.class] && anchor[@"screen"]) {
    NSDictionary *r = anchor[@"screen"];
    screenRect = platform_from_top_left(NSMakeRect([r[@"x"] doubleValue], [r[@"y"] doubleValue], MAX(1, [r[@"width"] doubleValue]), MAX(1, [r[@"height"] doubleValue])));
  } else if ([anchor isKindOfClass:NSDictionary.class]) {
    // A rect in a window's page (CSS px, e.g. getBoundingClientRect()). WKWebView
    // is flipped, so page coordinates map straight to view coordinates.
    // Public window id (0 = primary) if given, else the calling page.
    WKWebView *wv = nil;
    if (anchor[@"windowId"]) {
      int wid = [anchor[@"windowId"] intValue];
      wv = platform_webview(wid == 0 ? [platform_window_ids().firstObject intValue] : wid);
    } else {
      wv = platform_webview(caller) ?: find_native(caller).webview; // a window page, or another popover
      if (!wv) wv = platform_webview([platform_window_ids().firstObject intValue]);
    }
    if (!wv) return @"popover.show: no window to anchor to";
    double z = wv.pageZoom ?: 1;
    *view = wv;
    *rect = NSMakeRect([anchor[@"x"] doubleValue] * z, [anchor[@"y"] doubleValue] * z, MAX(1, [anchor[@"width"] doubleValue] * z),
                       MAX(1, [anchor[@"height"] doubleValue] * z));
    return nil;
  } else {
    return [NSString stringWithFormat:@"popover.show: unknown anchor `%@` (tray|cursor|{x,y,width,height[,windowId]}|{screen:{…}})", anchor];
  }
  // Screen anchors: NSPopover needs a view, so park a 1×1 invisible window there.
  if (!p.anchorWindow) {
    p.anchorWindow = [[NSWindow alloc] initWithContentRect:screenRect styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    p.anchorWindow.releasedWhenClosed = NO;
    p.anchorWindow.opaque = NO;
    p.anchorWindow.backgroundColor = NSColor.clearColor;
    p.anchorWindow.ignoresMouseEvents = YES;
    p.anchorWindow.level = NSPopUpMenuWindowLevel;
  }
  [p.anchorWindow setFrame:screenRect display:NO];
  [p.anchorWindow orderFront:nil];
  *view = p.anchorWindow.contentView;
  *rect = p.anchorWindow.contentView.bounds;
  return nil;
}

static NSString *show_now(SDPopover *p, NSDictionary *args, int caller);

// Lazy popovers load on first show and present once the page is ready (≤1.5 s),
// so even a cold open doesn't flash an empty frame.
static NSString *show(SDPopover *p, NSDictionary *args, int caller) {
  if (p.loaded) return show_now(p, args, caller);
  p.loaded = YES;
  [p.webview loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:p.url]]];
  __block BOOL done = NO;
  SDPopover *__weak weak = p;
  p.pendingShow = ^{
    if (done || !weak) return;
    done = YES;
    weak.pendingShow = nil;
    if (NSString *e = show_now(weak, args, caller)) NSLog(@"[shell] popover %@: %@", weak.ident, e);
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (weak.pendingShow) weak.pendingShow();
  });
  return nil;
}

static NSString *show_now(SDPopover *p, NSDictionary *args, int caller) {
  if ([p.style isEqual:@"panel"]) {
    NSRect f;
    if (NSString *e = panel_frame(p, args[@"position"] ?: p.position, &f)) return e;
    if (args[@"position"]) p.position = args[@"position"];
    [p.panel setFrame:f display:NO];
    [p moveContainerInto:p.panel.contentView];
    // Since macOS 14 a background app's panel only reliably takes keystrokes once
    // the app is active (cooperative activation honors it after a click/hotkey).
    if (p.activate) [NSApp activateIgnoringOtherApps:YES];
    [p.panel makeKeyAndOrderFront:nil];
    [p focusContent];
    [p startDismissWatch];
    platform_emit(@"popoverShown", @{@"id" : p.ident});
    return nil;
  }
  NSView *view = nil;
  NSRect rect;
  if (NSString *e = popover_anchor(p, args, caller, &view, &rect)) return e;
  [p moveContainerInto:p.popover.contentViewController.view];
  p.popover.contentSize = NSMakeSize(p.width, p.height);
  if (p.activate) [NSApp activateIgnoringOtherApps:YES]; // NSPopover windows only take keys in an active app
  [p.popover showRelativeToRect:rect ofView:view preferredEdge:p.edge];
  [p focusContent];
  return nil;
}

static void hide(SDPopover *p) {
  if (!p.shown) return;
  if ([p.style isEqual:@"panel"]) {
    [p dismissPanel];
  } else {
    // Programmatic closes skip the fade: the animated close can stall until the
    // next input event (seen with helper-window anchors), leaving isShown stale.
    // popoverDidClose emits popoverHidden and parks the anchor window.
    BOOL animates = p.popover.animates;
    p.popover.animates = NO;
    [p.popover close];
    p.popover.animates = animates;
  }
}

// ---------------------------------------------------------------------------
// Tray integration + Escape

void platform_popover_bind_tray(NSString *popoverId) { g_tray_popover = popoverId.length ? popoverId : nil; }

BOOL platform_popover_tray_click(void) {
  SDPopover *p = g_tray_popover ? g_popovers[g_tray_popover] : nil;
  if (!p) return NO;
  if (p.shown) {
    hide(p);
    return YES;
  }
  // The click that reached the button already dismissed a transient popover on
  // mouse-down: that click means "close", not "reopen".
  if (NSProcessInfo.processInfo.systemUptime - p.lastClosedAt < 0.35) return YES;
  NSString *e = show(p, @{@"anchor" : @"tray"}, 0);
  if (e) NSLog(@"[shell] tray popover: %@", e);
  return YES;
}

void platform_popover_page_ready(int nativeId) {
  SDPopover *p = find_native(nativeId);
  if (!p) return;
  p.ready = YES;
  platform_emit(@"popoverReady", @{@"id" : p.ident});
  if (p.pendingShow) p.pendingShow();
}

static void install_escape_monitor(void) {
  [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *e) {
    if (e.keyCode != 53) return e; // Escape
    for (SDPopover *p in g_popovers.allValues) {
      if (p.closeOnEscape && p.shown && p.webview.window.isKeyWindow) {
        hide(p);
        return nil;
      }
    }
    return e;
  }];
}

// ---------------------------------------------------------------------------

typedef void (^PopoverOp)(PlatformCall *c, SDPopover *p);

static void reg(NSString *op, PopoverOp body) {
  platform_register(@"popover", op, ^(PlatformCall *c) {
    // Inside a popover page, `id` defaults to that popover.
    NSString *ident = [c string:@"id"] ?: find_native(c.callerWindow).ident;
    SDPopover *p = ident ? g_popovers[ident] : nil;
    if (!p) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"popover.%@: unknown popover `%@`", c.op, ident]];
    body(c, p);
  });
}

void platform_register_popover(void) {
  g_popovers = [NSMutableDictionary dictionary];
  install_escape_monitor();
  platform_register(@"popover", @"create", ^(PlatformCall *c) {
    NSString *ident = [c string:@"id"] ?: [NSString stringWithFormat:@"popover-%d", g_next_native];
    if (SDPopover *old = g_popovers[ident]) destroy(old); // re-create replaces
    NSString *error = nil;
    SDPopover *p = build(c, ident, &error);
    if (!p) return [c fail:@"unavailable" message:error];
    g_popovers[ident] = p;
    if ([c boolean:@"tray" or:NO]) platform_popover_bind_tray(ident);
    [c ok:describe(p)];
  });
  reg(@"show", ^(PlatformCall *c, SDPopover *p) {
    if (NSString *e = show(p, c.args, c.callerWindow)) return [c fail:@"invalid_args" message:e];
    [c ok:describe(p)];
  });
  reg(@"hide", ^(PlatformCall *c, SDPopover *p) {
    hide(p);
    [c ok:nil];
  });
  reg(@"toggle", ^(PlatformCall *c, SDPopover *p) {
    if (p.shown) {
      hide(p);
      return [c ok:@{@"shown" : @NO}];
    }
    if (NSString *e = show(p, c.args, c.callerWindow)) return [c fail:@"invalid_args" message:e];
    [c ok:@{@"shown" : @YES}];
  });
  reg(@"setSize", ^(PlatformCall *c, SDPopover *p) {
    p.width = MAX(40, [c number:@"width" or:p.width]);
    p.height = MAX(24, [c number:@"height" or:p.height]);
    if ([p.style isEqual:@"panel"]) {
      NSRect f = p.panel.frame;
      NSRect next = NSMakeRect(f.origin.x, NSMaxY(f) - p.height, p.width, p.height); // keep the top edge
      if ([p.position isKindOfClass:NSString.class] && [p.position hasPrefix:@"tray"]) panel_frame(p, p.position, &next);
      [p.panel setFrame:next display:YES animate:NO];
    } else {
      p.popover.contentSize = NSMakeSize(p.width, p.height);
    }
    // Still staged (never shown): keep the warm view at the real size so the
    // first show paints the final layout.
    if (p.container.window == p.stage) [p.stage setContentSize:NSMakeSize(p.width, p.height)];
    platform_emit(@"popoverResized", @{@"id" : p.ident, @"width" : @(p.width), @"height" : @(p.height)});
    [c ok:nil];
  });
  reg(@"setPosition", ^(PlatformCall *c, SDPopover *p) {
    if (![p.style isEqual:@"panel"]) return [c fail:@"unsupported" message:@"popover.setPosition: only for style `panel` (popovers follow their anchor)"];
    id position = c.args[@"position"] ?: ([c has:@"x"] ? @{@"x" : c.args[@"x"], @"y" : c.args[@"y"]} : nil);
    NSRect f;
    if (NSString *e = panel_frame(p, position, &f)) return [c fail:@"invalid_args" message:e];
    p.position = position;
    [p.panel setFrame:f display:YES];
    [c ok:nil];
  });
  reg(@"isShown", ^(PlatformCall *c, SDPopover *p) { [c ok:@(p.shown)]; });
  reg(@"get", ^(PlatformCall *c, SDPopover *p) { [c ok:describe(p)]; });
  reg(@"eval", ^(PlatformCall *c, SDPopover *p) {
    NSString *js = [c string:@"js"];
    if (!js) return [c fail:@"invalid_args" message:@"popover.eval: `js` is required"];
    [p.webview evaluateJavaScript:js completionHandler:nil];
    [c ok:nil];
  });
  reg(@"reload", ^(PlatformCall *c, SDPopover *p) {
    [p.webview reload];
    [c ok:nil];
  });
  reg(@"destroy", ^(PlatformCall *c, SDPopover *p) {
    destroy(p);
    [c ok:@{@"destroyed" : @YES}];
  });
  platform_register(@"popover", @"list", ^(PlatformCall *c) {
    NSMutableArray *out = [NSMutableArray array];
    for (SDPopover *p in g_popovers.allValues) [out addObject:describe(p)];
    [c ok:out];
  });
  // Page-to-page messages (popover ↔ windows): fan out to every page + the Worker.
  platform_register(@"events", @"emit", ^(PlatformCall *c) {
    NSString *channel = [c string:@"channel"];
    if (!channel.length) return [c fail:@"invalid_args" message:@"events.emit: `channel` is required"];
    platform_emit(@"message", @{@"channel" : channel, @"data" : c.args[@"data"] ?: NSNull.null,
                                @"from" : find_native(c.callerWindow).ident ?: @(platform_public_window_id(c.callerWindow))});
    [c ok:nil];
  });
}
