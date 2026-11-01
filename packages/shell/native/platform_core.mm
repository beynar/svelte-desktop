// Platform dispatcher: registry of `service.op` handlers, the page bridge and
// the Worker entry point. Both transports hit the same handlers on the main thread.
#import <objc/runtime.h>
#include <map>
#include <string>

#include "platform_internal.h"

#include <set>
#include "shell.h"

// ---------------------------------------------------------------------------
// PlatformCall

typedef void (^ReplyBlock)(NSDictionary *reply);

@interface PlatformCall ()
@property(nonatomic, readwrite) NSString *service;
@property(nonatomic, readwrite) NSString *op;
@property(nonatomic, readwrite) NSDictionary *args;
@property(nonatomic, readwrite) int callerWindow;
@property(nonatomic, copy) ReplyBlock reply;
@property(nonatomic) BOOL done;
@end

@implementation PlatformCall
- (void)ok:(id)value {
  if (self.done) return;
  self.done = YES;
  self.reply(@{@"ok" : @YES, @"value" : value ?: NSNull.null});
}
- (void)fail:(NSString *)code message:(NSString *)message {
  if (self.done) return;
  self.done = YES;
  self.reply(@{@"ok" : @NO, @"error" : @{@"code" : code, @"message" : message ?: @""}});
}
- (NSString *)string:(NSString *)key {
  id v = self.args[key];
  return [v isKindOfClass:NSString.class] ? v : nil;
}
- (double)number:(NSString *)key or:(double)fallback {
  id v = self.args[key];
  return [v isKindOfClass:NSNumber.class] ? [v doubleValue] : fallback;
}
- (BOOL)boolean:(NSString *)key or:(BOOL)fallback {
  id v = self.args[key];
  return [v isKindOfClass:NSNumber.class] ? [v boolValue] : fallback;
}
- (BOOL)has:(NSString *)key {
  id v = self.args[key];
  return v && v != NSNull.null;
}
@end

// ---------------------------------------------------------------------------
// Registry

static NSMutableDictionary<NSString *, PlatformHandler> *g_handlers;

void platform_register(NSString *service, NSString *op, PlatformHandler handler) {
  if (!g_handlers) g_handlers = [NSMutableDictionary dictionary];
  g_handlers[[NSString stringWithFormat:@"%@.%@", service, op]] = handler;
}

void platform_register_many(NSString *service, NSArray<NSString *> *ops, PlatformHandler handler) {
  for (NSString *op in ops) platform_register(service, op, handler);
}

NSArray<NSString *> *platform_registered_ops(void) {
  return [g_handlers.allKeys sortedArrayUsingSelector:@selector(compare:)];
}

static NSSet<NSString *> *known_services(void) {
  NSMutableSet *s = [NSMutableSet set];
  for (NSString *key in g_handlers) [s addObject:[key componentsSeparatedByString:@"."][0]];
  return s;
}

static void dispatch_call(NSDictionary *request, int callerWindow, ReplyBlock reply) {
  PlatformCall *call = [PlatformCall new];
  call.service = [request[@"service"] isKindOfClass:NSString.class] ? request[@"service"] : @"";
  call.op = [request[@"op"] isKindOfClass:NSString.class] ? request[@"op"] : @"";
  call.args = [request[@"args"] isKindOfClass:NSDictionary.class] ? request[@"args"] : @{};
  call.callerWindow = callerWindow;
  call.reply = reply;
  PlatformHandler h = g_handlers[[NSString stringWithFormat:@"%@.%@", call.service, call.op]];
  if (!h) {
    if ([known_services() containsObject:call.service])
      [call fail:@"unsupported" message:[NSString stringWithFormat:@"%@.%@ is not implemented in this build", call.service, call.op]];
    else
      [call fail:@"unknown" message:[NSString stringWithFormat:@"unknown platform service `%@`", call.service]];
    return;
  }
  @try {
    h(call);
  } @catch (NSException *e) {
    [call fail:@"internal" message:[NSString stringWithFormat:@"%@: %@", e.name, e.reason]];
  }
}

// ---------------------------------------------------------------------------
// Events

static std::map<int, WKWebView *__weak> g_webviews;
static std::set<int> g_ready_pages; // native ids whose main frame reported DOMContentLoaded

static NSString *json_string(id obj) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:NSJSONWritingFragmentsAllowed error:nil];
  return d ? [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] : @"null";
}

// Events reach the app's own pages only: a view showing another site gets none.
static void deliver_to_page(WKWebView *wv, NSString *name, id data) {
  NSString *app = platform_app_origin();
  NSString *guard = app ? [NSString stringWithFormat:@"location.origin===%@&&", json_string(app)] : @"";
  NSString *js = [NSString stringWithFormat:@"%@window.__shell&&window.__shell.deliver(%@,%@)", guard, json_string(name),
                                            json_string(data ?: NSNull.null)];
  [wv evaluateJavaScript:js completionHandler:nil];
}

void platform_emit(NSString *name, NSDictionary *data) {
  void (^send)(void) = ^{
    shell_emit(@{@"type" : @"platform", @"name" : name, @"data" : data ?: @{}});
    for (auto &[id, wv] : g_webviews)
      if (WKWebView *strong = wv) deliver_to_page(strong, name, data ?: @{});
  };
  if (NSThread.isMainThread) send();
  else dispatch_async(dispatch_get_main_queue(), send);
}

void platform_emit_targeted(NSString *name, NSDictionary *data, int target) {
  void (^send)(void) = ^{
    shell_emit(@{@"type" : @"platform", @"name" : name, @"data" : data ?: @{}});
    for (auto &[id, wv] : g_webviews) {
      WKWebView *strong = wv;
      if (!strong) continue;
      NSMutableDictionary *d = [data ?: @{} mutableCopy];
      d[@"target"] = @(id == target);
      deliver_to_page(strong, name, d);
    }
  };
  if (NSThread.isMainThread) send();
  else dispatch_async(dispatch_get_main_queue(), send);
}

void platform_page_unloaded(int native_id) {
  g_ready_pages.erase(native_id);
}

int platform_target_window(int preferred) {
  auto ready = [](int id) { return g_ready_pages.count(id) && g_webviews.count(id) && g_webviews[id] && platform_window(id); };
  if (preferred > 0 && ready(preferred)) return preferred;
  for (NSWindow *w in @[ NSApp.keyWindow ?: NSNull.null, NSApp.mainWindow ?: NSNull.null ]) {
    if (![w isKindOfClass:NSWindow.class]) continue;
    for (auto &[id, wv] : g_webviews)
      if (ready(id) && platform_window(id) == w) return id;
  }
  for (NSNumber *n in platform_window_ids())
    if (ready(n.intValue)) return n.intValue;
  return 0;
}

// ---------------------------------------------------------------------------
// Page bridge: our own message handler (not webview_bind) so every message is
// checked for main frame + app origin. Subframes can reach message handlers,
// they cannot pass this check.

static NSString *const kBridgeScript =
    @"(()=>{if(window.__shell)return;const q=[];let sink=null;"
     "const post=(m)=>window.webkit.messageHandlers.__shell__.postMessage(JSON.stringify(m));"
     "window.__shell=Object.freeze({"
     "post:(req)=>post({t:'call',req:typeof req==='string'?JSON.parse(req):req}),"
     "setSink:(fn)=>{sink=fn;for(const [n,d] of q.splice(0))fn(n,d);},"
     "deliver:(n,d)=>{sink?sink(n,d):q.push([n,d]);}});"
     "document.addEventListener('DOMContentLoaded',()=>post({t:'ready'}));"
     // No elastic overscroll (rubber band): zero specificity, so the app's CSS can bring it back.
     "const os=()=>{const s=document.createElement('style');s.textContent=':where(html,body){overscroll-behavior:none}';(document.head||document.documentElement).prepend(s);};document.documentElement?os():addEventListener('DOMContentLoaded',os,{once:true});"
     // Drag regions: [data-desktop-drag], `--app-region: drag` (inherited, so
     // `--app-region: no-drag` carves holes) and the title bar strip of a hidden/inset title bar
     // (like a native title bar: Swish and the like drag it); controls stay clickable.
     "const nd='button,a,input,select,textarea,label,summary,option,[contenteditable],[role=button],[role=tab],[data-desktop-no-drag]';"
     "const dr=(t,y)=>{if(!(t instanceof Element)||t.closest(nd))return false;if(t.closest('[data-desktop-drag]'))return true;const r=getComputedStyle(t).getPropertyValue('--app-region').trim();return r==='drag'||(r!=='no-drag'&&y<(parseFloat(document.documentElement.style.getPropertyValue('--desktop-titlebar-height'))||0));};"
     "addEventListener('mousedown',(e)=>{if(e.button!==0||!dr(e.target,e.clientY))return;"
     "if(e.detail===2){e.preventDefault();post({t:'dragDouble'});}else if(e.detail===1)post({t:'drag'});},true);})();";

// Page permissions (desktop.config `permissions.pages`): nil = everything.
static NSArray<NSString *> *g_page_permissions = nil;

static BOOL page_may_call(NSString *service, NSString *op) {
  if (!g_page_permissions) return YES;
  NSString *full = [NSString stringWithFormat:@"%@.%@", service, op];
  for (NSString *rule in g_page_permissions) {
    if ([rule isEqualToString:full] || [rule isEqualToString:@"*"]) return YES;
    if ([rule hasSuffix:@".*"] && [service isEqualToString:[rule substringToIndex:rule.length - 2]]) return YES;
  }
  return NO;
}

int shell_set_page_permissions(const char *json) {
  NSArray *rules = nil;
  if (json) {
    id v = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil];
    if ([v isKindOfClass:NSArray.class]) rules = v;
  }
  dispatch_async(dispatch_get_main_queue(), ^{ g_page_permissions = rules; });
  return 0;
}

static BOOL origin_allowed(WKFrameInfo *frame) {
  if (!frame.isMainFrame) return NO;
  NSString *app = platform_app_origin();
  if (!app) return NO;
  WKSecurityOrigin *o = frame.securityOrigin;
  NSString *origin = o.port ? [NSString stringWithFormat:@"%@://%@:%ld", o.protocol, o.host, (long)o.port]
                            : [NSString stringWithFormat:@"%@://%@", o.protocol, o.host];
  return [origin isEqualToString:app];
}

@interface ShellBridge : NSObject <WKScriptMessageHandler>
@property(nonatomic) int windowId;
@end

@implementation ShellBridge
- (void)userContentController:(WKUserContentController *)ucc didReceiveScriptMessage:(WKScriptMessage *)message {
  if (![message.body isKindOfClass:NSString.class]) return;
  NSData *data = [message.body dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *msg = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![msg isKindOfClass:NSDictionary.class]) return;
  NSString *t = msg[@"t"];
  if ([t isEqual:@"ready"]) {
    if (message.frameInfo.isMainFrame) {
      g_ready_pages.insert(self.windowId);
      shell_on_page_ready(self.windowId);
    }
    return;
  }
  if ([t isEqual:@"drag"] || [t isEqual:@"dragDouble"]) {
    if (message.frameInfo.isMainFrame && origin_allowed(message.frameInfo)) platform_window_drag(message.webView.window, [t isEqual:@"dragDouble"]);
    return;
  }
  if (![t isEqual:@"call"]) return;
  NSDictionary *req = msg[@"req"];
  if (![req isKindOfClass:NSDictionary.class]) return;
  id callId = req[@"id"] ?: @0;
  WKWebView *__weak wv = message.webView;
  ReplyBlock reply = ^(NSDictionary *r) {
    NSMutableDictionary *out = [r mutableCopy];
    out[@"id"] = callId;
    if (WKWebView *strong = wv) deliver_to_page(strong, @"platformResult", out);
  };
  if (!origin_allowed(message.frameInfo)) {
    reply(@{@"ok" : @NO, @"error" : @{@"code" : @"denied", @"message" : @"platform calls are only accepted from the app origin's main frame"}});
    return;
  }
  NSString *service = [req[@"service"] description] ?: @"", *op = [req[@"op"] description] ?: @"";
  if (!page_may_call(service, op)) {
    reply(@{@"ok" : @NO, @"error" : @{@"code" : @"denied", @"message" : [NSString stringWithFormat:@"%@.%@ is not in permissions.pages (desktop.config)", service, op]}});
    return;
  }
  dispatch_call(req, self.windowId, reply);
}
@end

void platform_attach_webview(int native_id, WKWebView *webview) {
  WKUserContentController *ucc = webview.configuration.userContentController;
  ShellBridge *bridge = [ShellBridge new];
  bridge.windowId = native_id;
  [ucc addScriptMessageHandler:bridge name:@"__shell__"];
  [ucc addUserScript:[[WKUserScript alloc] initWithSource:kBridgeScript
                                            injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                         forMainFrameOnly:YES]];
  g_webviews[native_id] = webview;
}

void platform_detach_webview(int native_id) {
  auto it = g_webviews.find(native_id);
  if (it == g_webviews.end()) return;
  if (WKWebView *wv = it->second) [wv.configuration.userContentController removeScriptMessageHandlerForName:@"__shell__"];
  g_webviews.erase(it);
  g_ready_pages.erase(native_id);
}

// ---------------------------------------------------------------------------
// Worker entry point (shell.h)

int shell_platform_call(const char *request_json) {
  if (!request_json) return -3;
  NSData *data = [NSData dataWithBytes:request_json length:strlen(request_json)];
  NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![req isKindOfClass:NSDictionary.class]) return -3;
  id callId = req[@"id"] ?: @0;
  dispatch_async(dispatch_get_main_queue(), ^{
    dispatch_call(req, 0, ^(NSDictionary *r) {
      NSMutableDictionary *out = [r mutableCopy];
      out[@"type"] = @"platformResult";
      out[@"id"] = callId;
      shell_emit(out);
    });
  });
  return 0;
}

// ---------------------------------------------------------------------------
// App-delegate hooks: webview/webview owns NSApp.delegate; we add the methods it
// doesn't implement to its class at runtime.

void (^platform_on_reopen)(BOOL) = nil;
void (^platform_on_open_urls)(NSArray<NSURL *> *) = nil;
NSMenu *_Nullable (^platform_dock_menu)(void) = nil;

static void install_app_delegate_hooks(void) {
  Class cls = [NSApp.delegate class];
  if (!cls) return;
  class_addMethod(cls, @selector(applicationShouldHandleReopen:hasVisibleWindows:),
                  imp_implementationWithBlock(^BOOL(id, NSApplication *, BOOL visible) {
                    if (platform_on_reopen) platform_on_reopen(visible);
                    platform_emit(@"reopened", @{@"hasVisibleWindows" : @(visible)});
                    if (!visible) {
                      platform_show_main_window();
                    }
                    return YES;
                  }),
                  "c@:@c");
  class_addMethod(cls, @selector(application:openURLs:), imp_implementationWithBlock(^(id, NSApplication *, NSArray<NSURL *> *urls) {
                    if (platform_on_open_urls) platform_on_open_urls(urls);
                    NSMutableArray *list = [NSMutableArray array], *files = [NSMutableArray array];
                    for (NSURL *u in urls) u.isFileURL ? [files addObject:u] : [list addObject:u.absoluteString];
                    if (files.count) platform_webview_open_files(files); // documents → openFiles
                    if (list.count) platform_emit(@"openUrls", @{@"urls" : list});
                  }),
                  "v@:@@");
  class_addMethod(cls, @selector(applicationDockMenu:), imp_implementationWithBlock(^NSMenu *(id, NSApplication *) {
                    return platform_dock_menu ? platform_dock_menu() : nil;
                  }),
                  "@@:@");
  // Dock > Quit, logout and `osascript quit` send terminate:. Route them through
  // the graceful path (Worker beforeQuit hooks) instead of an immediate exit().
  class_addMethod(cls, @selector(applicationShouldTerminate:), imp_implementationWithBlock(^NSUInteger(id, NSApplication *) {
                    platform_emit(@"willQuit", @{});
                    shell_quit();
                    return NSTerminateCancel;
                  }),
                  "Q@:@");
}

void platform_init(void) {
  static BOOL done = NO;
  if (done) return;
  done = YES;
  platform_register_app();
  platform_register_window();
  platform_register_screen();
  platform_register_clipboard();
  platform_register_shell();
  platform_register_dialog();
  platform_register_theme();
  platform_register_menu();
  platform_register_system();
  platform_register_permissions();
  platform_register_power();
  platform_register_secure_storage();
  platform_register_notifications();
  platform_register_deep_link();
  platform_register_tray();
  platform_register_shortcuts();
  platform_register_diagnostics();
  platform_register_popover();
  platform_register_webview();
  platform_register_capture();
  platform_register_view();
  install_app_delegate_hooks();

  NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
  [nc addObserverForName:NSApplicationDidBecomeActiveNotification object:nil queue:nil
              usingBlock:^(NSNotification *) { platform_emit(@"appActivated", @{}); }];
  [nc addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil
              usingBlock:^(NSNotification *) { platform_emit(@"appDeactivated", @{}); }];
}
