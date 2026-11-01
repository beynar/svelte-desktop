// view.* — extra web views embedded in a window (Electron's BrowserView).
//   create {id?, windowId?, url|route, bounds:{x,y,width,height}, autoresize?, transparent?, debug?} → {id}
//   setBounds {id, x, y, width, height} · navigate {id, url|route} · show · hide · reload
//   executeJavaScript {id, code} → JSON · list · destroy
// Bounds are CSS px from the window content's top-left. `autoresize`:
// "width" | "height" | "both" | "none" (default) — follow window resizes.
// Events: viewLoaded {id, url}, viewNavigated {id, url}, viewFailed {id, error}, viewTitle {id, title}.
// The view's page has window.__desktopView = its id.
// Any origin may load (it's a browser view); the platform bridge still only
// answers the app origin's main frame, so third-party content can't call native.
#include "platform_internal.h"

@interface SDView : NSObject <WKNavigationDelegate>
@property(nonatomic, copy) NSString *ident;
@property(nonatomic) int nativeId;
@property(nonatomic) int windowNative;
@property(nonatomic, strong) WKWebView *webview;
@property(nonatomic, copy) NSString *autoresize;
@end

static NSMutableDictionary<NSString *, SDView *> *g_views;
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

@implementation SDView
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)ctx {
  platform_emit(@"viewTitle", @{@"id" : self.ident, @"title" : self.webview.title ?: @""});
}
- (void)webView:(WKWebView *)wv decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  NSString *scheme = action.request.URL.scheme.lowercaseString;
  if (action.targetFrame == nil) { // target=_blank / window.open → the default browser
    decisionHandler(WKNavigationActionPolicyCancel);
    if ([scheme hasPrefix:@"http"] || [scheme isEqual:@"mailto"]) [NSWorkspace.sharedWorkspace openURL:action.request.URL];
    return;
  }
  BOOL ok = [scheme isEqual:@"http"] || [scheme isEqual:@"https"] || [scheme isEqual:@"about"] || [scheme isEqual:@"data"] || [scheme isEqual:@"blob"];
  decisionHandler(ok ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
  if (ok && action.targetFrame.isMainFrame) platform_emit(@"viewNavigated", @{@"id" : self.ident, @"url" : action.request.URL.absoluteString ?: @""});
}
- (void)webView:(WKWebView *)wv didFinishNavigation:(WKNavigation *)nav {
  platform_emit(@"viewLoaded", @{@"id" : self.ident, @"url" : wv.URL.absoluteString ?: @""});
}
- (void)webView:(WKWebView *)wv didFailProvisionalNavigation:(WKNavigation *)nav withError:(NSError *)error {
  platform_emit(@"viewFailed", @{@"id" : self.ident, @"error" : error.localizedDescription ?: @""});
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)wv {
  [wv reload];
}
@end

static void destroy_view(SDView *v) {
  @try {
    [v.webview removeObserver:v forKeyPath:@"title"];
  } @catch (NSException *) {
  }
  platform_detach_webview(v.nativeId);
  [v.webview stopLoading];
  [v.webview removeFromSuperview];
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

void platform_register_view(void) {
  g_views = [NSMutableDictionary dictionary];
  platform_register(@"view", @"create", ^(PlatformCall *c) {
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
    // The page knows it's a view (an isolated tab), not a window: window.__desktopView = its id.
    NSString *mark = [NSString stringWithFormat:@"window.__desktopView=%@;",
                                                [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:ident options:NSJSONWritingFragmentsAllowed error:nil]
                                                                      encoding:NSUTF8StringEncoding]];
    [cfg.userContentController addUserScript:[[WKUserScript alloc] initWithSource:mark injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    v.webview = [[WKWebView alloc] initWithFrame:to_frame(host, b) configuration:cfg];
    v.webview.autoresizingMask = mask_for(v.autoresize, host.isFlipped);
    if ([c boolean:@"transparent" or:NO]) [v.webview setValue:@NO forKey:@"drawsBackground"];
    if (@available(macOS 13.3, *)) v.webview.inspectable = [c boolean:@"debug" or:NO];
    v.webview.navigationDelegate = v;
    [v.webview addObserver:v forKeyPath:@"title" options:0 context:nil];
    platform_attach_webview(v.nativeId, v.webview);
    platform_webview_configure(v.nativeId, v.webview);
    [host addSubview:v.webview positioned:NSWindowAbove relativeTo:nil];
    g_views[ident] = v;
    [v.webview loadRequest:[NSURLRequest requestWithURL:url]];
    [c ok:@{@"id" : ident, @"windowId" : @(platform_public_window_id(win))}];
  });
  reg(@"setBounds", ^(PlatformCall *c, SDView *v) {
    NSView *host = host_for(v.windowNative);
    v.webview.frame = to_frame(host, @{@"x" : c.args[@"x"] ?: @0, @"y" : c.args[@"y"] ?: @0, @"width" : c.args[@"width"] ?: @(v.webview.frame.size.width),
                                       @"height" : c.args[@"height"] ?: @(v.webview.frame.size.height)});
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
    [v.webview loadRequest:[NSURLRequest requestWithURL:url]];
    [c ok:nil];
  });
  // A hidden view leaves the window (kept alive): left in place, even hidden, it keeps the
  // keyboard and stops the page's own drag and drop.
  reg(@"show", ^(PlatformCall *c, SDView *v) {
    if (!v.webview.superview) [host_for(v.windowNative) addSubview:v.webview positioned:NSWindowAbove relativeTo:nil];
    [c ok:nil];
  });
  reg(@"hide", ^(PlatformCall *c, SDView *v) {
    NSWindow *win = v.webview.window;
    NSResponder *focus = win.firstResponder;
    BOOL had = [focus isKindOfClass:NSView.class] && [(NSView *)focus isDescendantOf:v.webview];
    [v.webview removeFromSuperview];
    if (had) [win makeFirstResponder:platform_webview(v.windowNative)];
    [c ok:nil];
  });
  reg(@"reload", ^(PlatformCall *c, SDView *v) {
    [v.webview reload];
    [c ok:nil];
  });
  reg(@"getInfo", ^(PlatformCall *c, SDView *v) {
    [c ok:@{@"id" : v.ident, @"url" : v.webview.URL.absoluteString ?: NSNull.null, @"title" : v.webview.title ?: @"",
            @"loading" : @(v.webview.isLoading), @"hidden" : @(!v.webview.superview)}];
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
