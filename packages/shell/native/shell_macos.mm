// macOS implementation of shell.h on top of webview/webview (WKWebView backend).
// Compiled with -fobjc-arc. All UI state lives on the main thread; public
// functions marked "any thread" only copy their arguments and dispatch_async.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <atomic>
#include <csignal>
#include <map>
#include <string>
#include <vector>

#include "platform_internal.h"
#include "shell.h"
#include "webview/api.h"

static const int kAbiVersion = 2;

// ---------------------------------------------------------------------------
// Event sink

static std::atomic<shell_event_fn> g_sink{nullptr};

void shell_emit(NSDictionary *event) {
  shell_event_fn fn = g_sink.load();
  if (!fn) return;
  NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (!data) return;
  char *buf = (char *)malloc(data.length + 1);
  memcpy(buf, data.bytes, data.length);
  buf[data.length] = 0;
  fn(buf); // receiver frees with shell_free
}
#define emit shell_emit

static void on_main(void (^block)(void)) {
  if ([NSThread isMainThread]) block();
  else dispatch_async(dispatch_get_main_queue(), block);
}

static NSString *str(const char *s) { return s ? [NSString stringWithUTF8String:s] : nil; }

static id parse_json(const char *json) {
  if (!json) return nil;
  NSData *data = [NSData dataWithBytes:json length:strlen(json)];
  return [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
}

// ---------------------------------------------------------------------------
// Windows

@interface ShellNavDelegate : NSObject <WKNavigationDelegate>
@property(nonatomic, assign) int windowId;
@end

struct Window {
  int id;
  webview_t wv;
  NSWindow *__weak window;
  WKWebView *__weak webview;
  ShellNavDelegate *nav;
  bool shown;
  bool veto;
  NSString *label;
  std::vector<NSObject *> observers; // NotificationCenter tokens
  NSDictionary *animation = nil;     // how it comes in when it shows (create {animate}); nil: at once
};

static std::map<int, Window *> g_windows; // main thread only
static std::vector<int> g_order;         // creation order; front = primary
static int g_next_id = 1;
static NSString *g_app_origin = nil;     // main thread only
static NSString *g_app_name = nil;
static NSString *g_app_identifier = nil;
static bool g_menu_installed = false;

static Window *find(int id) {
  auto it = g_windows.find(id);
  return it == g_windows.end() ? nullptr : it->second;
}

static Window *find_by_nswindow(NSWindow *win) {
  for (auto &[id, w] : g_windows)
    if (w->window == win) return w;
  return nullptr;
}

static CAMediaTimingFunction *timing_function(id easing) {
  if ([easing isKindOfClass:NSArray.class] && [easing count] == 4) { // cubic-bezier(x1, y1, x2, y2)
    NSArray *p = easing;
    return [CAMediaTimingFunction functionWithControlPoints:[p[0] floatValue]:[p[1] floatValue]:[p[2] floatValue]:[p[3] floatValue]];
  }
  NSDictionary *names = @{@"linear" : kCAMediaTimingFunctionLinear, @"easeIn" : kCAMediaTimingFunctionEaseIn, @"easeInOut" : kCAMediaTimingFunctionEaseInEaseOut};
  return [CAMediaTimingFunction functionWithName:names[easing] ?: kCAMediaTimingFunctionEaseOut];
}

static void reveal(Window *w) {
  if (w->shown) return;
  w->shown = true;
  NSWindow *win = w->window;
  NSDictionary *a = w->animation;
  double duration = a[@"duration"] ? [a[@"duration"] doubleValue] / 1000.0 : 0.18;
  if (!a || duration <= 0) {
    [win setAlphaValue:1.0];
    [win makeKeyAndOrderFront:nil];
    return;
  }
  // From where it starts — offset (CSS points, y down; default 10 above), scaled around its
  // middle, at an opacity — into place.
  NSRect to = win.frame;
  NSDictionary *offset = [a[@"offset"] isKindOfClass:NSDictionary.class] ? a[@"offset"] : nil;
  double dx = offset ? [offset[@"x"] doubleValue] : 0, dy = offset ? [offset[@"y"] doubleValue] : -10;
  double scale = a[@"scale"] ? MAX(0.1, [a[@"scale"] doubleValue]) : 1;
  NSRect from = NSMakeRect(NSMidX(to) - to.size.width * scale / 2 + dx, NSMidY(to) - to.size.height * scale / 2 - dy, to.size.width * scale, to.size.height * scale);
  [win setFrame:from display:NO];
  [win setAlphaValue:a[@"opacity"] ? MIN(1, MAX(0, [a[@"opacity"] doubleValue])) : 0];
  [win makeKeyAndOrderFront:nil];
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
    ctx.duration = duration;
    ctx.timingFunction = timing_function(a[@"easing"]);
    [[win animator] setFrame:to display:YES];
    [[win animator] setAlphaValue:1.0];
  }];
}

static bool same_origin(NSURL *url) {
  if (!g_app_origin || !url.host) return false;
  NSString *port = url.port ? [NSString stringWithFormat:@":%@", url.port] : @"";
  NSString *origin = [NSString stringWithFormat:@"%@://%@%@", url.scheme, url.host, port];
  return [origin isEqualToString:g_app_origin];
}

@implementation ShellNavDelegate
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  if (action.shouldPerformDownload) { // <a download>
    decisionHandler(WKNavigationActionPolicyDownload);
    return;
  }
  NSURL *url = action.request.URL;
  NSString *scheme = url.scheme.lowercaseString;
  bool newWindow = action.targetFrame == nil;
  bool subframe = action.targetFrame && !action.targetFrame.isMainFrame;
  bool internal = [scheme isEqualToString:@"about"] || [scheme isEqualToString:@"data"] ||
                  [scheme isEqualToString:@"blob"] || same_origin(url) || !g_app_origin;
  if (subframe || (internal && !newWindow)) {
    decisionHandler(WKNavigationActionPolicyAllow);
    return;
  }
  decisionHandler(WKNavigationActionPolicyCancel);
  if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"] ||
      [scheme isEqualToString:@"mailto"]) {
    [[NSWorkspace sharedWorkspace] openURL:url];
  }
  emit(@{@"type" : @"external-navigation", @"window" : @(self.windowId), @"url" : url.absoluteString ?: @""});
}

// Downloads (platform_webview.mm): attachments and non-displayable responses.
- (void)webView:(WKWebView *)webView decidePolicyForNavigationResponse:(WKNavigationResponse *)response
                      decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
  decisionHandler(platform_webview_response_policy(response));
}
- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)a didBecomeDownload:(WKDownload *)d {
  platform_webview_download_started(self.windowId, d);
}
- (void)webView:(WKWebView *)webView navigationResponse:(WKNavigationResponse *)r didBecomeDownload:(WKDownload *)d {
  platform_webview_download_started(self.windowId, d);
}

// Electrobun #550-style "frozen after sleep / web process died": reload instead of a dead view.
// A new document is coming (reload, full navigation): the old page can't take responses any more
// until the new one reports ready (notifications target / claim queue, platform_core.mm).
- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation {
  platform_page_unloaded(self.windowId);
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  platform_page_unloaded(self.windowId);
  emit(@{@"type" : @"webcontent-terminated", @"window" : @(self.windowId)});
  [webView reload];
}
@end

id<WKNavigationDelegate> shell_make_nav_delegate(int nativeId) {
  ShellNavDelegate *d = [ShellNavDelegate new];
  d.windowId = nativeId;
  return d;
}

void shell_on_page_ready(int wid) {
  Window *w = find(wid);
  if (!w) return platform_popover_page_ready(wid);
  reveal(w);
  emit(@{@"type" : @"ready", @"window" : @(wid)});
}

// Close veto: webview/webview's window delegate only implements windowWillClose:,
// so windowShouldClose: is added to its class at runtime.
static bool g_keep_alive = false; // desktop.config quitOnLastWindowClosed: false

static void install_close_veto_hook(NSWindow *win) {
  Class cls = [win.delegate class];
  if (!cls) return;
  class_addMethod(cls, @selector(windowShouldClose:), imp_implementationWithBlock(^BOOL(id, NSWindow *sender) {
                    Window *w = find_by_nswindow(sender);
                    if (w && w->veto) {
                      platform_emit(@"willClose", @{@"windowId" : @(platform_public_window_id(w->id))});
                      return NO;
                    }
                    // quitOnLastWindowClosed: false — the last visible window hides instead (macOS apps
                    // stay alive; a Dock or notification click shows it again, its page still loaded).
                    if (w && g_keep_alive) {
                      bool other = false;
                      for (auto &[id, x] : g_windows)
                        if (x != w && x->window.isVisible) other = true;
                      if (!other) {
                        [sender orderOut:nil];
                        return NO;
                      }
                    }
                    return YES;
                  }),
                  "c@:@");
}

static void observe_window(Window *w) {
  NSWindow *win = w->window;
  int wid = w->id;
  NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
  auto pub = ^{ return @(platform_public_window_id(wid)); };
  auto bounds = ^NSDictionary *(NSWindow *x) {
    NSRect f = x.frame;
    NSRect screen = x.screen ? x.screen.frame : NSScreen.screens.firstObject.frame;
    return @{@"windowId" : pub(), @"x" : @(f.origin.x), @"y" : @(NSMaxY(screen) - NSMaxY(f)),
             @"width" : @(f.size.width), @"height" : @(f.size.height)};
  };
  auto add = ^(NSNotificationName name, void (^block)(NSNotification *)) {
    w->observers.push_back((NSObject *)[nc addObserverForName:name object:win queue:nil usingBlock:block]);
  };
  add(NSWindowDidBecomeKeyNotification, ^(NSNotification *) {
    emit(@{@"type" : @"focus", @"window" : @(wid)});
    platform_emit(@"focusChanged", @{@"focused" : @YES, @"windowId" : pub()});
  });
  add(NSWindowDidResignKeyNotification, ^(NSNotification *) {
    emit(@{@"type" : @"blur", @"window" : @(wid)});
    platform_emit(@"focusChanged", @{@"focused" : @NO, @"windowId" : pub()});
  });
  add(NSWindowDidMoveNotification, ^(NSNotification *n) { platform_emit(@"boundsChanged", bounds(n.object)); });
  add(NSWindowDidResizeNotification, ^(NSNotification *n) { platform_emit(@"boundsChanged", bounds(n.object)); });
  add(NSWindowDidChangeBackingPropertiesNotification, ^(NSNotification *n) {
    platform_emit(@"scaleFactorChanged", @{@"scaleFactor" : @([n.object backingScaleFactor]), @"windowId" : pub()});
  });
  add(NSWindowWillCloseNotification, ^(NSNotification *) {
    NSNumber *publicId = pub();
    Window *x = find(wid);
    if (x) {
      for (NSObject *o : x->observers) [nc removeObserver:o];
      platform_detach_webview(wid);
      g_windows.erase(wid);
      g_order.erase(std::remove(g_order.begin(), g_order.end(), wid), g_order.end());
      // webview/webview tears down the view and stops the loop after the last window.
    }
    emit(@{@"type" : @"closed", @"window" : @(wid)});
    platform_emit(@"closed", @{@"windowId" : publicId});
  });
}

static void install_default_menu(NSString *appName);

// Scrolling over a transparent title bar (titleBarStyle transparent / hidden / hiddenInset: the page
// extends under it) doesn't scroll the page: the strip behaves like a title bar, and title-bar
// gesture tools (Swish…) aren't fighting a scrolling page. A gesture is routed as a whole, by where
// it began: one that starts in the page keeps scrolling when it crosses the strip, and the reverse.
bool platform_scroll_in_title_bar(NSWindow *w, NSPoint locationInWindow) {
  if (!w || !(w.styleMask & NSWindowStyleMaskFullSizeContentView) || (w.styleMask & NSWindowStyleMaskFullScreen)) return false;
  return locationInWindow.y > NSMaxY(w.contentLayoutRect);
}

/// The routing decision (shared by the monitor and the e2e test op): swallow this scroll event?
bool platform_title_bar_scroll_filter(NSWindow *w, NSPoint locationInWindow, NSEventPhase phase, NSEventPhase momentum) {
  static bool swallowing = false; // the current trackpad gesture began in the title bar
  bool inBar = platform_scroll_in_title_bar(w, locationInWindow);
  if (phase & (NSEventPhaseBegan | NSEventPhaseMayBegin)) swallowing = inBar;
  else if (phase == NSEventPhaseNone && momentum == NSEventPhaseNone) swallowing = inBar; // mouse wheel: per event
  return swallowing;
}

static void install_title_bar_scroll_monitor() {
  static bool installed = false;
  if (installed) return;
  installed = true;
  [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
                                        handler:^NSEvent *(NSEvent *e) {
                                          if (!find_by_nswindow(e.window)) return e;
                                          return platform_title_bar_scroll_filter(e.window, e.locationInWindow, e.phase, e.momentumPhase) ? nil : e;
                                        }];
}

static int create_window(NSDictionary *o) {
  bool debug = [o[@"debug"] boolValue];
  webview_t wv = webview_create(debug ? 1 : 0, nullptr);
  if (!wv) return -1;

  Window *w = new Window{g_next_id++, wv, nil, nil, nil, false, false, nil, {}};
  w->window = (__bridge NSWindow *)webview_get_window(wv);
  w->webview = (__bridge WKWebView *)webview_get_native_handle(wv, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER);
  w->label = o[@"label"] ?: (g_order.empty() ? @"main" : [NSString stringWithFormat:@"window-%d", w->id]);
  id animate = o[@"animate"];
  w->animation = [animate isKindOfClass:NSDictionary.class] ? animate : ([animate boolValue] ? @{} : nil);
  g_windows[w->id] = w;
  g_order.push_back(w->id);

  NSWindow *win = w->window;
  // Avoid the white flash: keep the window transparent until the page signals
  // DOMContentLoaded (or a timeout). Alpha, not orderOut — WKWebView doesn't paint
  // while hidden (Electrobun #566).
  bool hidden = o[@"hiddenUntilReady"] ? [o[@"hiddenUntilReady"] boolValue] : true;
  bool visible = o[@"visible"] ? [o[@"visible"] boolValue] : (o[@"show"] ? [o[@"show"] boolValue] : true);
  if (hidden || !visible) [win setAlphaValue:0.0];
  else w->shown = true;
  if (!visible) {
    w->shown = true; // never auto-reveal; window.show() does
    // Off screen entirely (an alpha-0 window would still sit in the window list).
    dispatch_async(dispatch_get_main_queue(), ^{ [win orderOut:nil]; });
  }

  NSWindowStyleMask mask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable;
  if (!o[@"minimizable"] || [o[@"minimizable"] boolValue]) mask |= NSWindowStyleMaskMiniaturizable;
  if (!o[@"resizable"] || [o[@"resizable"] boolValue]) mask |= NSWindowStyleMaskResizable;
  if (o[@"decorations"] && ![o[@"decorations"] boolValue]) mask = NSWindowStyleMaskBorderless | NSWindowStyleMaskResizable;
  win.styleMask = mask;
  if ([o[@"titlebarTransparent"] boolValue]) {
    win.titlebarAppearsTransparent = YES;
    win.styleMask |= NSWindowStyleMaskFullSizeContentView;
  }
  if (o[@"movable"] && ![o[@"movable"] boolValue]) win.movable = NO;
  if ([o[@"alwaysOnTop"] boolValue]) win.level = NSFloatingWindowLevel;
  if (NSString *tab = o[@"tabbingIdentifier"]) win.tabbingIdentifier = tab;
  if ([o[@"transparent"] boolValue]) {
    win.opaque = NO;
    win.backgroundColor = NSColor.clearColor;
    [w->webview setValue:@NO forKey:@"drawsBackground"];
  }

  int width = o[@"width"] ? [o[@"width"] intValue] : 1024;
  int height = o[@"height"] ? [o[@"height"] intValue] : 720;
  webview_set_size(wv, width, height, WEBVIEW_HINT_NONE);
  if (o[@"minWidth"] || o[@"minHeight"])
    win.contentMinSize = NSMakeSize([o[@"minWidth"] doubleValue], [o[@"minHeight"] doubleValue]);
  if (o[@"x"] && o[@"y"]) {
    NSRect screen = NSScreen.screens.firstObject.frame;
    [win setFrameTopLeftPoint:NSMakePoint([o[@"x"] doubleValue], NSMaxY(screen) - [o[@"y"] doubleValue])];
  } else {
    [win center];
  }
  if (NSString *name = o[@"autosaveName"]) [win setFrameAutosaveName:name]; // persists frame in NSUserDefaults
  if (NSString *title = o[@"title"]) webview_set_title(wv, title.UTF8String);

  w->nav = [ShellNavDelegate new];
  w->nav.windowId = w->id;
  w->webview.navigationDelegate = w->nav;
  platform_attach_webview(w->id, w->webview);
  platform_webview_configure(w->id, w->webview);
  if (NSString *style = o[@"titleBarStyle"]) platform_apply_title_bar_style(win, w->webview, style);
  install_close_veto_hook(win);
  observe_window(w);

  int wid = w->id;
  if (hidden && visible) {
    double timeout = o[@"readyTimeoutMs"] ? [o[@"readyTimeoutMs"] doubleValue] / 1000.0 : 3.0;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      if (Window *x = find(wid)) reveal(x);
    });
  }

  if (NSString *url = o[@"url"]) webview_navigate(wv, url.UTF8String);
  else if (NSString *html = o[@"html"]) webview_set_html(wv, html.UTF8String);
  return w->id;
}

// The first window's options: a Dock click with no window left recreates it
// (desktop.config quitOnLastWindowClosed: false).
static NSDictionary *g_main_opts;
extern "C" void webview_sd_keep_running_without_windows(int keep); // vendor/webview/webview.cc (patch)

int shell_window_create(const char *opts_json) {
  if (![NSThread isMainThread]) return -2;
  NSDictionary *o = parse_json(opts_json) ?: @{};
  if (!g_main_opts) {
    g_main_opts = o;
    // Dev: the app's icon in the Dock instead of bun's. Again once the run loop starts:
    // finishLaunching gives a bare executable the generic icon.
    if (NSString *icon = o[@"appIcon"])
      if (NSImage *image = [[NSImage alloc] initWithContentsOfFile:icon]) {
        NSApp.applicationIconImage = image;
        dispatch_async(dispatch_get_main_queue(), ^{ NSApp.applicationIconImage = image; });
      }
    if (o[@"quitOnLastWindowClosed"] && ![o[@"quitOnLastWindowClosed"] boolValue]) {
      g_keep_alive = true;
      webview_sd_keep_running_without_windows(1); // a window closed by other means doesn't stop the loop either
    }
  }
  if (!g_app_name) g_app_name = o[@"appName"];
  if (!g_app_identifier) g_app_identifier = o[@"identifier"];
  int id = create_window(o);
  if (id > 0) {
    install_title_bar_scroll_monitor();
    platform_init();
    if (!g_menu_installed) install_default_menu(platform_app_name());
  }
  return id;
}

// ---------------------------------------------------------------------------
// Window accessors for the platform modules (platform_internal.h)

int platform_public_window_id(int native_id) {
  return (!g_order.empty() && g_order.front() == native_id) ? 0 : native_id;
}
int platform_resolve_window(PlatformCall *call) {
  if ([call has:@"windowId"]) {
    int pid = (int)[call number:@"windowId" or:0];
    if (pid == 0) return g_order.empty() ? 0 : g_order.front();
    return find(pid) ? pid : 0;
  }
  if (call.callerWindow && find(call.callerWindow)) return call.callerWindow;
  if (Window *key = find_by_nswindow(NSApp.keyWindow)) return key->id;
  return g_order.empty() ? 0 : g_order.front();
}
NSWindow *platform_window(int id) {
  Window *w = find(id);
  return w ? w->window : nil;
}
WKWebView *platform_webview(int id) {
  Window *w = find(id);
  return w ? w->webview : nil;
}
NSArray<NSNumber *> *platform_window_ids(void) {
  NSMutableArray *ids = [NSMutableArray array];
  for (int id : g_order) [ids addObject:@(id)];
  return ids;
}
NSString *platform_window_label(int id) {
  Window *w = find(id);
  return w ? w->label : nil;
}
int platform_show_main_window(void) {
  // Hidden (the usual case): show it again, page and state intact.
  for (int id : g_order) {
    Window *w = find(id);
    if (!w) continue;
    if (w->window.miniaturized) [w->window deminiaturize:nil];
    [w->window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    return id;
  }
  // Closed by other means: a new main window.
  if (!g_main_opts) return 0;
  NSMutableDictionary *o = [g_main_opts mutableCopy];
  for (NSString *k in @[ @"args", @"cwd", @"singleInstance", @"url" ]) [o removeObjectForKey:k];
  o[@"label"] = @"main";
  return platform_create_window(o);
}

int platform_create_window(NSDictionary *opts) {
  NSString *label = opts[@"label"];
  if (label)
    for (auto &[id, w] : g_windows)
      if ([w->label isEqualToString:label]) return -4; // duplicate label
  NSMutableDictionary *o = [opts mutableCopy];
  NSString *path = opts[@"path"] ?: @"/";
  if (g_app_origin && !o[@"url"] && !o[@"html"])
    o[@"url"] = [g_app_origin stringByAppendingString:[path hasPrefix:@"/"] ? path : [@"/" stringByAppendingString:path]];
  int id = create_window(o);
  if (id > 0) platform_emit(@"created", @{@"windowId" : @(platform_public_window_id(id)), @"label" : platform_window_label(id) ?: @""});
  return id;
}
NSString *platform_app_origin(void) { return g_app_origin; }
NSString *platform_app_name(void) {
  return NSBundle.mainBundle.infoDictionary[@"CFBundleName"] ?: g_app_name ?: NSProcessInfo.processInfo.processName;
}
NSString *platform_app_identifier(void) {
  return NSBundle.mainBundle.bundleIdentifier ?: g_app_identifier ?: @"dev.svelte-desktop.app";
}
NSString *platform_app_version(void) {
  return NSBundle.mainBundle.infoDictionary[@"CFBundleShortVersionString"] ?: @"0.0.0";
}
void platform_set_close_veto(int id, BOOL armed) {
  if (Window *w = find(id)) w->veto = armed;
}
BOOL platform_close_veto(int id) {
  Window *w = find(id);
  return w && w->veto;
}

// ---------------------------------------------------------------------------
// Run loop, quit, signals

static void install_signal_sources() {
  // Bun's own signal handlers can't run once the main JS thread is parked in the
  // Cocoa loop, so signals are handled natively and turned into a graceful quit.
  static dispatch_source_t sources[3];
  int sigs[3] = {SIGINT, SIGTERM, SIGHUP};
  const char *names[3] = {"SIGINT", "SIGTERM", "SIGHUP"};
  for (int i = 0; i < 3; i++) {
    signal(sigs[i], SIG_IGN);
    sources[i] = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, sigs[i], 0, dispatch_get_main_queue());
    NSString *name = @(names[i]);
    dispatch_source_set_event_handler(sources[i], ^{
      emit(@{@"type" : @"signal", @"signal" : name});
      shell_quit();
    });
    dispatch_resume(sources[i]);
  }
}

int shell_run(void) {
  if (![NSThread isMainThread]) return -2;
  if (g_order.empty()) return -1;
  install_signal_sources();
  [[[NSWorkspace sharedWorkspace] notificationCenter] addObserverForName:NSWorkspaceDidWakeNotification object:nil
      queue:nil usingBlock:^(NSNotification *) { emit(@{@"type" : @"wake"}); }];
  return webview_run(find(g_order.front())->wv);
}

int shell_quit(void) {
  on_main(^{
    [NSApp stop:nil];
    // stop: only takes effect after the next event is processed.
    NSEvent *ev = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0
                                    timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
    [NSApp postEvent:ev atStart:YES];
  });
  return 0;
}

// ---------------------------------------------------------------------------
// Window operations (any thread)

#define WITH_WINDOW(id_, body)                                                                                         \
  do {                                                                                                                 \
    int wid_ = (id_);                                                                                                  \
    on_main(^{                                                                                                         \
      Window *w = find(wid_);                                                                                          \
      if (!w) return;                                                                                                  \
      body;                                                                                                            \
    });                                                                                                                \
    return 0;                                                                                                          \
  } while (0)

int shell_window_navigate(int id, const char *url) {
  if (!url) return -3;
  std::string s(url);
  WITH_WINDOW(id, webview_navigate(w->wv, s.c_str()));
}
int shell_window_eval(int id, const char *js) {
  if (!js) return -3;
  std::string s(js);
  WITH_WINDOW(id, webview_eval(w->wv, s.c_str()));
}
int shell_window_set_title(int id, const char *title) {
  if (!title) return -3;
  std::string s(title);
  WITH_WINDOW(id, webview_set_title(w->wv, s.c_str()));
}
int shell_window_set_size(int id, int width, int height) {
  WITH_WINDOW(id, webview_set_size(w->wv, width, height, WEBVIEW_HINT_NONE));
}
int shell_window_show(int id) { WITH_WINDOW(id, { w->shown = false; reveal(w); }); }
int shell_window_hide(int id) { WITH_WINDOW(id, [w->window orderOut:nil]); }
int shell_window_focus(int id) {
  WITH_WINDOW(id, {
    [NSApp activateIgnoringOtherApps:YES];
    [w->window makeKeyAndOrderFront:nil];
  });
}
int shell_window_close(int id) { WITH_WINDOW(id, [w->window performClose:nil]); }

int shell_set_app_origin(const char *origin) {
  NSString *o = str(origin);
  on_main(^{ g_app_origin = o; });
  return 0;
}

// ---------------------------------------------------------------------------
// Menus

@interface ShellMenuTarget : NSObject
@end
@implementation ShellMenuTarget
- (void)custom:(NSMenuItem *)item {
  emit(@{@"type" : @"menu", @"id" : item.representedObject ?: @""});
}
- (void)quit:(id)sender {
  emit(@{@"type" : @"quit-requested"});
  shell_quit();
}
- (void)reload:(id)sender {
  NSWindow *key = NSApp.keyWindow;
  for (auto &[id, w] : g_windows)
    if (w->window == key) [w->webview reload];
}
@end

static ShellMenuTarget *g_menu_target = nil;

static void apply_accelerator(NSMenuItem *item, NSString *acc) {
  if (!acc.length) return;
  NSEventModifierFlags mask = 0;
  NSString *key = @"";
  for (NSString *part in [acc componentsSeparatedByString:@"+"]) {
    NSString *p = part.lowercaseString;
    if ([p isEqualToString:@"cmd"] || [p isEqualToString:@"command"] || [p isEqualToString:@"cmdorctrl"] ||
        [p isEqualToString:@"commandorcontrol"])
      mask |= NSEventModifierFlagCommand;
    else if ([p isEqualToString:@"shift"]) mask |= NSEventModifierFlagShift;
    else if ([p isEqualToString:@"alt"] || [p isEqualToString:@"option"]) mask |= NSEventModifierFlagOption;
    else if ([p isEqualToString:@"ctrl"] || [p isEqualToString:@"control"]) mask |= NSEventModifierFlagControl;
    else key = p;
  }
  item.keyEquivalent = key;
  item.keyEquivalentModifierMask = mask;
}

static NSMenuItem *build_item(NSDictionary *spec) {
  if ([spec[@"type"] isEqual:@"separator"]) return [NSMenuItem separatorItem];
  NSString *label = spec[@"label"] ?: @"";
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:label action:nil keyEquivalent:@""];
  NSString *role = spec[@"role"];
  static NSDictionary<NSString *, NSString *> *selectors = @{
    @"undo" : @"undo:", @"redo" : @"redo:", @"cut" : @"cut:", @"copy" : @"copy:", @"paste" : @"paste:",
    @"selectAll" : @"selectAll:", @"minimize" : @"performMiniaturize:", @"zoom" : @"performZoom:",
    @"close" : @"performClose:", @"hide" : @"hide:", @"hideOthers" : @"hideOtherApplications:",
    @"unhide" : @"unhideAllApplications:", @"about" : @"orderFrontStandardAboutPanel:",
    @"toggleFullScreen" : @"toggleFullScreen:", @"front" : @"arrangeInFront:"
  };
  if ([role isEqual:@"quit"]) {
    item.action = @selector(quit:);
    item.target = g_menu_target;
  } else if ([role isEqual:@"reload"]) {
    item.action = @selector(reload:);
    item.target = g_menu_target;
  } else if (role && selectors[role]) {
    item.action = NSSelectorFromString(selectors[role]); // nil target = responder chain
  } else if (spec[@"id"]) {
    item.action = @selector(custom:);
    item.target = g_menu_target;
    item.representedObject = [spec[@"id"] description];
  }
  apply_accelerator(item, spec[@"accelerator"]);
  if (spec[@"enabled"] && ![spec[@"enabled"] boolValue]) {
    item.enabled = NO;
  }
  if (NSArray *sub = spec[@"submenu"]) {
    NSMenu *menu = [[NSMenu alloc] initWithTitle:label];
    menu.autoenablesItems = !(spec[@"enabled"] && ![spec[@"enabled"] boolValue]);
    for (NSDictionary *child in sub) [menu addItem:build_item(child)];
    item.submenu = menu;
  }
  return item;
}

static void set_menu(NSArray *spec) {
  if (!g_menu_target) g_menu_target = [ShellMenuTarget new];
  NSMenu *bar = [NSMenu new];
  for (NSDictionary *top in spec) [bar addItem:build_item(top)];
  NSApp.mainMenu = bar;
  g_menu_installed = true;
}

// Without an Edit menu, Cmd+C/V/X/A/Z do nothing in a WKWebView, and without an
// app menu there is no Cmd+Q. webview/webview installs neither. Built like menu.setAppMenu
// (platform_menu.mm): the Window menu becomes NSApp.windowsMenu, so macOS adds its tiling
// items (Fill, Center, Move & Resize) — which window tools such as Swish drive, animated.
static void install_default_menu(NSString *appName) {
  NSString *name = appName ?: NSRunningApplication.currentApplication.localizedName ?: @"App";
  NSArray *spec = @[
    @{@"label" : name, @"submenu" : @[
      @{@"label" : [@"About " stringByAppendingString:name], @"role" : @"about"}, @{@"type" : @"separator"},
      @{@"label" : [@"Hide " stringByAppendingString:name], @"role" : @"hide", @"accelerator" : @"Cmd+H"},
      @{@"label" : @"Hide Others", @"role" : @"hideOthers", @"accelerator" : @"Cmd+Alt+H"},
      @{@"label" : @"Show All", @"role" : @"unhide"}, @{@"type" : @"separator"},
      @{@"label" : [@"Quit " stringByAppendingString:name], @"role" : @"quit", @"accelerator" : @"Cmd+Q"}
    ]},
    @{@"label" : @"Edit", @"submenu" : @[
      @{@"label" : @"Undo", @"role" : @"undo", @"accelerator" : @"Cmd+Z"},
      @{@"label" : @"Redo", @"role" : @"redo", @"accelerator" : @"Cmd+Shift+Z"}, @{@"type" : @"separator"},
      @{@"label" : @"Cut", @"role" : @"cut", @"accelerator" : @"Cmd+X"},
      @{@"label" : @"Copy", @"role" : @"copy", @"accelerator" : @"Cmd+C"},
      @{@"label" : @"Paste", @"role" : @"paste", @"accelerator" : @"Cmd+V"},
      @{@"label" : @"Select All", @"role" : @"selectAll", @"accelerator" : @"Cmd+A"}
    ]},
    @{@"label" : @"View", @"submenu" : @[
      @{@"label" : @"Reload", @"role" : @"reload", @"accelerator" : @"Cmd+R"},
      @{@"label" : @"Enter Full Screen", @"role" : @"toggleFullScreen", @"accelerator" : @"Cmd+Ctrl+F"}
    ]},
    @{@"label" : @"Window", @"submenu" : @[
      @{@"label" : @"Minimize", @"role" : @"minimize", @"accelerator" : @"Cmd+M"},
      @{@"label" : @"Zoom", @"role" : @"zoom"},
      @{@"label" : @"Close", @"role" : @"close", @"accelerator" : @"Cmd+W"}
    ]}
  ];
  NSString *error = nil;
  NSMenu *bar = platform_build_menu(spec, @"default menu", &error);
  if (!bar) return (void)fprintf(stderr, "[shell] default menu: %s\n", error.UTF8String);
  NSApp.mainMenu = bar;
  g_menu_installed = true;
}

int shell_menu_set(const char *spec_json) {
  NSArray *spec = parse_json(spec_json);
  if (![spec isKindOfClass:NSArray.class]) return -3;
  on_main(^{ set_menu(spec); });
  return 0;
}

// ---------------------------------------------------------------------------
// Dialogs (sheet on the key window, never blocking the caller)

static NSArray<NSString *> *types_of(NSDictionary *o) { return o[@"extensions"]; }

int shell_dialog(int request_id, const char *opts_json) {
  NSDictionary *o = parse_json(opts_json);
  if (![o isKindOfClass:NSDictionary.class]) return -3;
  on_main(^{
    NSWindow *parent = NSApp.keyWindow;
    NSString *kind = o[@"kind"];
    if ([kind isEqual:@"message"]) {
      NSAlert *alert = [NSAlert new];
      alert.messageText = o[@"message"] ?: @"";
      if (o[@"detail"]) alert.informativeText = o[@"detail"];
      NSString *style = o[@"style"];
      alert.alertStyle = [style isEqual:@"critical"] ? NSAlertStyleCritical
                         : [style isEqual:@"warning"] ? NSAlertStyleWarning
                                                       : NSAlertStyleInformational;
      for (NSString *b in (o[@"buttons"] ?: @[ @"OK" ])) [alert addButtonWithTitle:b];
      void (^done)(NSModalResponse) = ^(NSModalResponse r) {
        emit(@{@"type" : @"dialog", @"requestId" : @(request_id), @"button" : @(r - NSAlertFirstButtonReturn)});
      };
      if (parent) [alert beginSheetModalForWindow:parent completionHandler:done];
      else done([alert runModal]);
      return;
    }

    NSSavePanel *panel;
    if ([kind isEqual:@"save"]) {
      panel = [NSSavePanel savePanel];
      if (o[@"defaultName"]) panel.nameFieldStringValue = o[@"defaultName"];
    } else {
      NSOpenPanel *open = [NSOpenPanel openPanel];
      open.allowsMultipleSelection = [o[@"multiple"] boolValue];
      open.canChooseDirectories = [o[@"directories"] boolValue];
      open.canChooseFiles = o[@"files"] ? [o[@"files"] boolValue] : YES;
      panel = open;
    }
    if (o[@"title"]) panel.message = o[@"title"];
    if (o[@"defaultPath"]) panel.directoryURL = [NSURL fileURLWithPath:o[@"defaultPath"]];
    if (NSArray *exts = types_of(o)) {
      NSMutableArray *types = [NSMutableArray array];
      for (NSString *e in exts)
        if (UTType *t = [UTType typeWithFilenameExtension:e]) [types addObject:t];
      if (types.count) panel.allowedContentTypes = types;
    }
    void (^done)(NSModalResponse) = ^(NSModalResponse r) {
      NSMutableArray *paths = [NSMutableArray array];
      if (r == NSModalResponseOK) {
        if ([panel isKindOfClass:NSOpenPanel.class])
          for (NSURL *u in ((NSOpenPanel *)panel).URLs) [paths addObject:u.path];
        else if (panel.URL) [paths addObject:panel.URL.path];
      }
      emit(@{@"type" : @"dialog", @"requestId" : @(request_id), @"canceled" : @(r != NSModalResponseOK), @"paths" : paths});
    };
    if (parent) [panel beginSheetModalForWindow:parent completionHandler:done];
    else done([panel runModal]);
  });
  return 0;
}

// ---------------------------------------------------------------------------

int shell_abi_version(void) { return kAbiVersion; }
void shell_set_event_sink(shell_event_fn fn) { g_sink.store(fn); }
void shell_free(void *p) { free(p); }
