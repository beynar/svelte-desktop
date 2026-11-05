// view.* — extra web views embedded in a window (Electron's BrowserView).
//   create {id?, windowId?, url|route, bounds:{x,y,width,height}, autoresize?, transparent?, hidden?, debug?} → {id}
//   (`hidden`: it loads out of sight, until `show`)
//   setBounds {id, x, y, width, height} · navigate {id, url|route} · show {seeThrough?} · hide · reload
//   executeJavaScript {id, code} → JSON · list · destroy
// Bounds are CSS px from the window content's top-left. `autoresize`:
// "width" | "height" | "both" | "none" (default) — follow window resizes.
// Events: viewLoaded {id, url}, viewNavigated {id, url}, viewFailed {id, error}, viewTitle {id, title}.
// The view's page has window.__desktopView = its id.
// Any origin may load (it's a browser view); the platform bridge still only
// answers the app origin's main frame, so third-party content can't call native.
#include "platform_internal.h"
#include "platform_web_policy.h"
#include "platform_web_content.h"
#import <objc/runtime.h>

@interface SDView : NSObject <WKNavigationDelegate>
@property(nonatomic, copy) NSString *ident;
@property(nonatomic) int nativeId;
@property(nonatomic) int windowNative;
@property(nonatomic, strong) WKWebView *webview;
@property(nonatomic, copy) NSString *autoresize;
/// Created `hidden`: it loads over the page, see-through and letting the pointer through (still
/// drawing: behind the page or out of the window, WebKit stops), until `show`.
@property(nonatomic) BOOL seeThrough;
@property(nonatomic) BOOL provisional; // a load not committed yet: its URL isn't where the page is
@end

static NSMutableDictionary<NSString *, SDView *> *g_views;
static NSMutableDictionary<NSNumber *, NSNumber *> *g_owners; // the window of every view there was, this run
static int g_next_view = 2000;

static NSView *host_for(int windowNative) {
  WKWebView *main = platform_webview(windowNative);
  return main.superview; // webview/webview's widget = window contentView container
}

static NSRect to_frame(NSView *host, NSDictionary *b) {
  double x = [b[@"x"] doubleValue], y = [b[@"y"] doubleValue], w = [b[@"width"] doubleValue], h = [b[@"height"] doubleValue];
  return host.isFlipped ? NSMakeRect(x, y, w, h) : NSMakeRect(x, host.bounds.size.height - y - h, w, h);
}

static NSAutoresizingMaskOptions mask_for(NSString *mode, BOOL flipped) {
  NSAutoresizingMaskOptions m = flipped ? NSViewMaxYMargin : NSViewMinYMargin; // keep the top edge pinned
  if ([mode isEqual:@"width"] || [mode isEqual:@"both"]) m |= NSViewWidthSizable;
  if ([mode isEqual:@"height"] || [mode isEqual:@"both"]) m = (m & ~(NSViewMinYMargin | NSViewMaxYMargin)) | NSViewHeightSizable;
  return m;
}

static NSURL *url_from(PlatformCall *c) {
  NSString *u = [c string:@"url"];
  if (!u) {
    NSString *route = [c string:@"route"];
    NSString *origin = platform_app_origin();
    if (route && origin) u = [origin stringByAppendingString:[route hasPrefix:@"/"] ? route : [@"/" stringByAppendingString:route]];
  }
  return u ? [NSURL URLWithString:u] : nil;
}

// An app page loaded in a view says so (X-Desktop-View: its id): the server renders it as a
// view (<WindowTabs> draws the page alone), not the window's chrome for hydration to remove.
@implementation SDView
- (void)webView:(WKWebView *)view didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)challenge
    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completionHandler {
  platform_web_auth(view, challenge, completionHandler);
}
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)ctx {
  // The URL also moves within a document (a site's own router), which nothing else tells.
  if ([keyPath isEqual:@"URL"]) { if (!self.provisional) platform_emit(@"viewUrl", @{@"id" : self.ident, @"url" : self.webview.URL.absoluteString ?: @""}); }
  else platform_emit(@"viewTitle", @{@"id" : self.ident, @"title" : self.webview.title ?: @""});
}
- (void)webView:(WKWebView *)wv decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  if (action.shouldPerformDownload) { // <a download>: what the content policy allows
    if (platform_web_content_decide_navigation(wv, action, ^(WKNavigationActionPolicy policy) {
          decisionHandler(policy == WKNavigationActionPolicyAllow ? WKNavigationActionPolicyDownload : policy);
        }))
      return;
    decisionHandler(WKNavigationActionPolicyDownload);
    return;
  }
  NSString *scheme = action.request.URL.scheme.lowercaseString;
  if (action.targetFrame == nil) { // target=_blank / window.open → the default browser
    decisionHandler(WKNavigationActionPolicyCancel);
    if ([scheme hasPrefix:@"http"] || [scheme isEqual:@"mailto"]) [NSWorkspace.sharedWorkspace openURL:action.request.URL];
    return;
  }
  BOOL ok = [scheme isEqual:@"http"] || [scheme isEqual:@"https"] || [scheme isEqual:@"about"] || [scheme isEqual:@"data"] || [scheme isEqual:@"blob"] || platform_web_content_is_scheme(scheme);
  if (ok && platform_web_content_decide_navigation(wv, action, decisionHandler)) return;
  decisionHandler(ok ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
// Downloads (platform_webview.mm): attachments and non-displayable responses.
- (void)webView:(WKWebView *)wv decidePolicyForNavigationResponse:(WKNavigationResponse *)response
    decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
  decisionHandler(platform_webview_response_policy(response));
}
- (void)webView:(WKWebView *)wv navigationAction:(WKNavigationAction *)a didBecomeDownload:(WKDownload *)d {
  platform_webview_download_started(self.nativeId, d);
}
- (void)webView:(WKWebView *)wv navigationResponse:(WKNavigationResponse *)r didBecomeDownload:(WKDownload *)d {
  platform_webview_download_started(self.nativeId, d);
}
// Once it's there: a response that turns out to be a download leaves the page where it is.
- (void)webView:(WKWebView *)wv didCommitNavigation:(WKNavigation *)nav {
  self.provisional = NO;
  platform_emit(@"viewUrl", @{@"id" : self.ident, @"url" : wv.URL.absoluteString ?: @""});
  platform_emit(@"viewNavigated", @{@"id" : self.ident, @"url" : wv.URL.absoluteString ?: @""});
}
- (void)webView:(WKWebView *)wv didFinishNavigation:(WKNavigation *)nav {
  platform_lifecycle_emit(wv, @"loaded", nil, NO, nav);
  platform_emit(@"viewLoaded", @{@"id" : self.ident, @"url" : wv.URL.absoluteString ?: @""});
}
- (void)webView:(WKWebView *)wv didFailProvisionalNavigation:(WKNavigation *)nav withError:(NSError *)error {
  self.provisional = NO;
  platform_lifecycle_emit(wv, @"failed", error, YES, nav);
  platform_emit(@"viewFailed", @{@"id" : self.ident, @"error" : error.localizedDescription ?: @""});
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)wv {
  platform_page_unloaded(self.nativeId);
  platform_lifecycle_emit(wv, @"terminated", nil, NO);
}
- (void)webView:(WKWebView *)wv didStartProvisionalNavigation:(WKNavigation *)nav {
  self.provisional = YES;
  platform_page_unloaded(self.nativeId);
  platform_lifecycle_emit(wv, @"navigationStarted", nil, YES, nav);
}
- (void)webView:(WKWebView *)wv didFailNavigation:(WKNavigation *)nav withError:(NSError *)error {
  platform_lifecycle_emit(wv, @"failed", error, NO, nav);
  platform_emit(@"viewFailed", @{@"id":self.ident, @"error":error.localizedDescription ?: @""});
}
@end

// Capture before removal: AppKit can retain a removed responder's web view until focus changes.
static NSWindow *window_focusing_view(SDView *v) {
  NSWindow *win = v.webview.window;
  NSResponder *focus = win.firstResponder;
  return [focus isKindOfClass:NSView.class] && [(NSView *)focus isDescendantOf:v.webview] ? win : nil;
}

static void destroy_view(SDView *v) {
  NSWindow *focusWindow = window_focusing_view(v);
  @try {
    [v.webview removeObserver:v forKeyPath:@"title"];
    [v.webview removeObserver:v forKeyPath:@"URL"];
  } @catch (NSException *) {
  }
  platform_detach_webview(v.nativeId);
  [v.webview stopLoading];
  [v.webview removeFromSuperview];
  if (focusWindow) [focusWindow makeFirstResponder:platform_webview(v.windowNative)];
  [g_views removeObjectForKey:v.ident];
}

typedef void (^ViewOp)(PlatformCall *c, SDView *v);
static void reg(NSString *op, ViewOp body) {
  platform_register(@"view", op, ^(PlatformCall *c) {
    SDView *v = g_views[[c string:@"id"] ?: @""];
    if (!v) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"view.%@: unknown view `%@`", c.op, [c string:@"id"]]];
    if (!platform_window(v.windowNative)) {
      destroy_view(v);
      return [c fail:@"invalid_args" message:@"view: its window is closed"];
    }
    body(c, v);
  });
}

// A view loading out of sight (alpha 0) lets the pointer through to the page under it.
static IMP g_hit_test;
// The strip along a view's edges that it leaves to what's under it (a pane's: the line between two panes,
// grabbable a little beyond the gap between their views). The window's page hears the mouse there anyway:
// it shows that line as hovered, a press has to reach it too.
static char kHitInset;
static NSView *see_through_hit_test(NSView *self, SEL cmd, NSPoint point) {
  if (self.alphaValue == 0) return nil;
  if (NSValue *inset = objc_getAssociatedObject(self, &kHitInset)) {
    NSEdgeInsets i = inset.edgeInsetsValue;
    NSRect f = self.frame;
    CGFloat fromTop = self.superview.isFlipped ? point.y - NSMinY(f) : NSMaxY(f) - point.y;
    if (NSPointInRect(point, f) && (point.x - NSMinX(f) < i.left || NSMaxX(f) - point.x < i.right || fromTop < i.top || NSHeight(f) - fromTop < i.bottom))
      return nil;
  }
  return ((NSView * (*)(id, SEL, NSPoint)) g_hit_test)(self, cmd, point);
}

// The window a view is in: its page's calls are about that one, not whichever has the focus.
int platform_view_owner(int nativeId) {
  for (SDView *v in g_views.allValues)
    if (v.nativeId == nativeId) return v.windowNative;
  return 0;
}

WKWebView *platform_view_webview(int nativeId) {
  for (SDView *v in g_views.allValues)
    if (v.nativeId == nativeId) return v.webview;
  return nil;
}

BOOL platform_view_at_app(int nativeId) {
  NSString *origin = platform_app_origin();
  NSString *at = platform_view_webview(nativeId).URL.absoluteString;
  return origin && at && ([at isEqual:origin] || [at hasPrefix:[origin stringByAppendingString:@"/"]]);
}

int platform_view_last_owner(int nativeId) { return g_owners[@(nativeId)].intValue; }

void platform_views_window_closed(int windowNative) {
  for (SDView *v in g_views.allValues)
    if (v.windowNative == windowNative) destroy_view(v);
}

WKWebView *platform_view_focused(NSWindow *window) {
  id first = window.firstResponder;
  if (![first isKindOfClass:NSView.class]) return nil;
  for (SDView *v in g_views.allValues)
    if (v.webview.window == window && [(NSView *)first isDescendantOf:v.webview]) return v.webview;
  return nil;
}

int platform_view_native(NSString *ident) { return g_views[ident].nativeId; }

void platform_view_reveal(int nativeId) {
  for (SDView *v in g_views.allValues)
    if (v.nativeId == nativeId) return platform_emit(@"viewReveal", @{@"id" : v.ident});
}

void platform_register_view(void) {
  g_views = [NSMutableDictionary dictionary];
  Method m = class_getInstanceMethod(WKWebView.class, @selector(hitTest:));
  g_hit_test = method_getImplementation(m);
  if (!class_addMethod(WKWebView.class, @selector(hitTest:), (IMP)see_through_hit_test, method_getTypeEncoding(m)))
    method_setImplementation(m, (IMP)see_through_hit_test);
  // A press in a view: it has the user's attention (panes follow it; nothing else tells the page).
  [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown
                                        handler:^NSEvent *(NSEvent *e) {
                                          // What's under it, as AppKit sees it: stacking and see-through views included.
                                          NSView *under = [e.window.contentView.superview ?: e.window.contentView hitTest:e.locationInWindow];
                                          for (NSView *n = under; n; n = n.superview)
                                            for (SDView *v in g_views.allValues)
                                              if (v.webview == n) {
                                                platform_emit(@"viewFocused", @{@"id" : v.ident});
                                                return e;
                                              }
                                          return e;
                                        }];
  platform_register(@"view", @"create", ^(PlatformCall *c) {
    if (!platform_webview_options_valid(c.args)) return [c fail:@"invalid_args" message:@"view.create: unknown session or invalid recovery policy"];
    int win = platform_resolve_window(c);
    NSView *host = host_for(win);
    if (!host) return [c fail:@"invalid_args" message:@"view.create: no such window"];
    NSDictionary *b = [c.args[@"bounds"] isKindOfClass:NSDictionary.class] ? c.args[@"bounds"] : nil;
    if (!b) return [c fail:@"invalid_args" message:@"view.create: `bounds` {x,y,width,height} is required"];
    NSURL *url = url_from(c);
    if (!url) return [c fail:@"invalid_args" message:@"view.create: `url` or `route` is required"];
    NSString *ident = [c string:@"id"] ?: [NSString stringWithFormat:@"view-%d", g_next_view];
    if (SDView *old = g_views[ident]) destroy_view(old);

    SDView *v = [SDView new];
    v.ident = ident;
    v.nativeId = g_next_view++;
    v.windowNative = win;
    v.autoresize = [c string:@"autoresize"] ?: @"none";
    WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
    platform_webview_prepare_configuration(cfg, [c string:@"session"]);
    // A tab's page is its window's: the same profile, inspectable if the window's is.
    BOOL tab = [c boolean:@"tab" or:NO];
    WKWebView *page = platform_webview(win);
    if (tab && page && ![c string:@"session"]) cfg.websiteDataStore = page.configuration.websiteDataStore;
    // The page knows it's a view (an isolated tab), not a window: window.__desktopView = its id.
    NSString *mark = [NSString stringWithFormat:@"window.__desktopView=%@;",
                                                [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:ident options:NSJSONWritingFragmentsAllowed error:nil]
                                                                      encoding:NSUTF8StringEncoding]];
    if ([c boolean:@"pane" or:NO]) mark = [mark stringByAppendingString:@"window.__desktopPaneView=true;"]; // what it shows comes back to it
    if ([c boolean:@"tab" or:NO]) mark = [mark stringByAppendingString:@"window.__desktopTabView=true;"]; // <WindowTabs>'s, not the app's own
    [cfg.userContentController addUserScript:[[WKUserScript alloc] initWithSource:mark injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    v.webview = [[WKWebView alloc] initWithFrame:to_frame(host, b) configuration:cfg];
    v.webview.autoresizingMask = mask_for(v.autoresize, host.isFlipped);
    if ([c boolean:@"transparent" or:NO]) {
      // See-through: where its page paints nothing, the window's page under it shows.
      [v.webview setValue:@NO forKey:@"drawsBackground"];
      if (@available(macOS 12.0, *)) v.webview.underPageBackgroundColor = NSColor.clearColor;
    }
    if (@available(macOS 13.3, *)) v.webview.inspectable = [c boolean:@"debug" or:tab && page.inspectable];
    if (![c boolean:@"backgroundThrottling" or:YES]) platform_webview_set_throttling(v.webview, NO); // keeps running at full speed hidden
    v.webview.navigationDelegate = v;
    [v.webview addObserver:v forKeyPath:@"title" options:0 context:nil];
    [v.webview addObserver:v forKeyPath:@"URL" options:0 context:nil];
    platform_attach_webview(v.nativeId, v.webview);
    platform_lifecycle_configure(v.webview, @{@"viewId":ident, @"windowId":@(platform_public_window_id(win))}, [c string:@"recovery"], win);
    platform_webview_configure(v.nativeId, v.webview);
    v.seeThrough = [c boolean:@"hidden" or:NO];
    if (v.seeThrough) v.webview.alphaValue = 0;
    [host addSubview:v.webview positioned:NSWindowAbove relativeTo:nil];
    g_views[ident] = v;
    (g_owners ?: (g_owners = [NSMutableDictionary dictionary]))[@(v.nativeId)] = @(win);
    platform_webview_load(v.webview, platform_webview_request(v.webview, url));
    [c ok:@{@"id" : ident, @"windowId" : @(platform_public_window_id(win))}];
  });
  reg(@"setBounds", ^(PlatformCall *c, SDView *v) {
    NSView *host = host_for(v.windowNative);
    v.webview.frame = to_frame(host, @{@"x" : c.args[@"x"] ?: @0, @"y" : c.args[@"y"] ?: @0, @"width" : c.args[@"width"] ?: @(v.webview.frame.size.width),
                                       @"height" : c.args[@"height"] ?: @(v.webview.frame.size.height)});
    [c ok:nil];
  });
  reg(@"setHitInset", ^(PlatformCall *c, SDView *v) {
    NSEdgeInsets i = NSEdgeInsetsMake([c number:@"top" or:0], [c number:@"left" or:0], [c number:@"bottom" or:0], [c number:@"right" or:0]);
    objc_setAssociatedObject(v.webview, &kHitInset, [NSValue valueWithEdgeInsets:i], OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [c ok:nil];
  });
  reg(@"getBounds", ^(PlatformCall *c, SDView *v) {
    NSView *host = host_for(v.windowNative);
    NSRect f = v.webview.frame;
    double y = host.isFlipped ? f.origin.y : host.bounds.size.height - NSMaxY(f);
    [c ok:@{@"x" : @(f.origin.x), @"y" : @(y), @"width" : @(f.size.width), @"height" : @(f.size.height)}];
  });
  reg(@"navigate", ^(PlatformCall *c, SDView *v) {
    NSURL *url = url_from(c);
    if (!url) return [c fail:@"invalid_args" message:@"view.navigate: `url` or `route` is required"];
    platform_webview_load(v.webview, platform_webview_request(v.webview, url));
    [c ok:nil];
  });
  // A hidden view leaves the window (kept alive): left in place, even hidden, it keeps the
  // keyboard and stops the page's own drag and drop.
  reg(@"show", ^(PlatformCall *c, SDView *v) {
    // `seeThrough`: in the window, drawing, but see-through and letting the pointer through
    // (a view about to be shown, getting its page ready).
    BOOL veiled = [c boolean:@"seeThrough" or:NO];
    if (!v.webview.superview) [host_for(v.windowNative) addSubview:v.webview positioned:NSWindowAbove relativeTo:nil];
    v.webview.alphaValue = veiled ? 0 : 1;
    v.seeThrough = veiled;
    [c ok:nil];
  });
  reg(@"hide", ^(PlatformCall *c, SDView *v) {
    NSWindow *focusWindow = window_focusing_view(v);
    [v.webview removeFromSuperview];
    v.webview.alphaValue = 1;
    v.seeThrough = NO;
    if (focusWindow) [focusWindow makeFirstResponder:platform_webview(v.windowNative)];
    [c ok:nil];
  });
  reg(@"focus", ^(PlatformCall *c, SDView *v) {
    if (v.webview.window) [v.webview.window makeFirstResponder:v.webview];
    [c ok:nil];
  });
  // The keyboard back to the window's own page, from a view (F6, <WindowTabs>): nothing else takes it there but a press.
  platform_register(@"view", @"focusPage", ^(PlatformCall *c) {
    int win = platform_resolve_window(c);
    NSWindow *w = platform_window(win);
    if (!w) return [c fail:@"invalid_args" message:@"view.focusPage: no such window"];
    [w makeFirstResponder:platform_webview(win)];
    [c ok:nil];
  });
  reg(@"reload", ^(PlatformCall *c, SDView *v) {
    platform_webview_reload(v.webview);
    [c ok:nil];
  });
  reg(@"getInfo", ^(PlatformCall *c, SDView *v) {
    [c ok:@{@"id" : v.ident, @"url" : v.webview.URL.absoluteString ?: NSNull.null, @"title" : v.webview.title ?: @"",
            @"loading" : @(v.webview.isLoading), @"hidden" : @(!v.webview.superview || v.seeThrough)}];
  });
  reg(@"executeJavaScript", ^(PlatformCall *c, SDView *v) {
    NSString *code = [c string:@"code"];
    if (!code) return [c fail:@"invalid_args" message:@"view.executeJavaScript: `code` is required"];
    NSString *body = @"const v = await (0, eval)(__code); return v === undefined ? 'null' : (JSON.stringify(v) ?? 'null');";
    [v.webview callAsyncJavaScript:body arguments:@{@"__code" : code} inFrame:nil inContentWorld:WKContentWorld.pageWorld
                 completionHandler:^(id result, NSError *error) {
                   if (error) return [c fail:@"internal" message:error.localizedDescription];
                   NSData *d = [result isKindOfClass:NSString.class] ? [result dataUsingEncoding:NSUTF8StringEncoding] : nil;
                   [c ok:(d ? [NSJSONSerialization JSONObjectWithData:d options:NSJSONReadingFragmentsAllowed error:nil] : nil) ?: NSNull.null];
                 }];
  });
  reg(@"destroy", ^(PlatformCall *c, SDView *v) {
    destroy_view(v);
    [c ok:@{@"destroyed" : @YES}];
  });
  platform_register(@"view", @"list", ^(PlatformCall *c) {
    NSMutableArray *out = [NSMutableArray array];
    for (SDView *v in g_views.allValues)
      [out addObject:@{@"id" : v.ident, @"windowId" : @(platform_public_window_id(v.windowNative)), @"url" : v.webview.URL.absoluteString ?: NSNull.null}];
    [c ok:out];
  });
}
