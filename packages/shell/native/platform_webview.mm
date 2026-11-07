// webview.* — web view features every WKWebView of the shell gets (windows and
// popovers): JS dialogs, media permissions, file drop with real paths,
// downloads, print, find, zoom, context-menu control, snapshots, JS eval, and
// open-file (document) events. See WEBVIEW.md.
//
// Every web view goes through platform_webview_configure() right after it is
// created. It attaches an SDWebViewState to the WKWebView (associated object,
// strong) which owns our WKUIDelegate (WKWebView.UIDelegate is weak) and the
// per-view settings. WKWebView itself is patched once, at class level, for
// drag & drop (performDragOperation: & co) and willOpenMenu:withEvent:; the
// patches call through to the original and are no-ops for views without state.
//
// Events: fileDragEnter, fileDragLeave, fileDrop, contextMenu, jsDialog,
// downloadStarted, downloadProgress, downloadFinished, downloadFailed,
// printFinished, closeRequested (popover pages calling window.close()), openFiles.
// Every web-view event carries {windowId} (public id) or {popoverId}.
#import <AVFoundation/AVFoundation.h>
#import <Quartz/Quartz.h>
#import <CoreLocation/CoreLocation.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <initializer_list>
#include <signal.h>
#include <unistd.h>

#include "platform_internal.h"
#include "platform_web_content.h"
#include "platform_web_policy.h"

// These APIs are private: guard the class and every selector before use.
@interface WKProcessPool (SDMemoryPolicy)
- (instancetype)_initWithConfiguration:(id)configuration __attribute__((objc_method_family(init)));
@end

void platform_webview_prepare_configuration(WKWebViewConfiguration *configuration, NSString *session) {
  platform_session_prepare(configuration, session);
  platform_web_content_prepare(configuration);
  static WKProcessPool *pool;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class policyClass = NSClassFromString(@"_WKProcessPoolConfiguration");
    id policy = [policyClass new];
    SEL prewarm = NSSelectorFromString(@"setPrewarmsProcessesAutomatically:");
    SEL cache = NSSelectorFromString(@"setUsesWebProcessCache:");
    if (![policy respondsToSelector:prewarm] || ![policy respondsToSelector:cache] ||
        ![WKProcessPool instancesRespondToSelector:@selector(_initWithConfiguration:)]) {
      NSLog(@"[shell] WebKit memory policy unavailable; using WebKit defaults");
      return;
    }
    // Explicit NO also prevents the heuristic from enabling prewarming after a process swap.
    ((void (*)(id, SEL, BOOL))objc_msgSend)(policy, prewarm, NO);
    ((void (*)(id, SEL, BOOL))objc_msgSend)(policy, cache, NO);
    pool = [[WKProcessPool alloc] _initWithConfiguration:policy];
  });
  if (pool) configuration.processPool = pool;
}

// The vendored main-window factory is C++, so its hook passes an untyped Objective-C pointer.
extern "C" void webview_sd_configure_webkit(void *configuration) {
  platform_webview_prepare_configuration((__bridge WKWebViewConfiguration *)configuration);
}

@class SDWebViewState;
static void emit_for(SDWebViewState *s, NSString *name, NSDictionary *data);

// ---------------------------------------------------------------------------
// Global settings

static BOOL g_file_drop_default = YES;
static NSString *g_context_mode_default = nil; // nil → 'none' unless debug, then 'default'
static NSArray *g_context_items_default = nil;
static NSString *g_download_dir = nil;          // nil → ~/Downloads
static NSMutableArray<NSString *> *g_opened_files; // queued until a page is ready / getOpenedFiles
static BOOL g_page_ready = NO;
static char kStateKey;

static NSMapTable<NSNumber *, SDWebViewState *> *states(void) {
  static NSMapTable *t;
  if (!t) t = [NSMapTable strongToWeakObjectsMapTable];
  return t;
}

static NSString *origin_string(WKSecurityOrigin *o) {
  return o.port ? [NSString stringWithFormat:@"%@://%@:%ld", o.protocol, o.host, (long)o.port]
                : [NSString stringWithFormat:@"%@://%@", o.protocol, o.host];
}

static NSString *json_text(id obj) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:NSJSONWritingFragmentsAllowed error:nil];
  return d ? [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] : @"null";
}

// Runs a block outside any GCD main-queue block, so an app-modal loop started
// inside it (runModal) still lets the dispatcher's dispatch_async(main) work run.
static void run_outside_gcd(dispatch_block_t block) {
  CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopDefaultMode, block);
  CFRunLoopWakeUp(CFRunLoopGetMain());
}

// ---------------------------------------------------------------------------
// Per-view state

@interface SDUIDelegate : NSObject <WKUIDelegate>
@property(nonatomic, weak) SDWebViewState *state;
@end

@interface SDWebViewState : NSObject <WKScriptMessageHandler>
@property(nonatomic) int nativeId;
@property(nonatomic, copy, nullable) NSString *popoverId;
@property(nonatomic, weak) WKWebView *webview;
@property(nonatomic, strong) SDUIDelegate *ui;
@property(nonatomic, strong, nullable) WKFrameInfo *permissionFrame; // test channel: real WebKit frame metadata
@property(nonatomic, strong, nullable) id originalUIDelegate; // webview/webview's, kept alive
@property(nonatomic) BOOL fileDrop;
@property(nonatomic) BOOL dragging; // a file drag is over the view (enter emitted)
@property(nonatomic, copy) NSString *contextMode; // default | none | custom
@property(nonatomic, copy, nullable) NSArray *contextItems;
@property(nonatomic) BOOL editMenu; // keep Cut/Copy/Paste/spelling in none/custom modes
@property(nonatomic, strong, nullable) NSAlert *activeAlert;
@property(nonatomic, strong, nullable) NSTextField *activeInput;
@property(nonatomic, copy, nullable) NSString *activeType;
@property(nonatomic, copy, nullable) NSDictionary *lastMenu; // test hook: identifiers before/after the policy
@property(nonatomic) BOOL dismissMenus;                      // test hook: cancel tracking right away
- (BOOL)debug;
- (NSDictionary *)source;
@end

static NSString *const kWebviewScript =
    @"(()=>{if(window.__shellWebview)return;Object.defineProperty(window,'__shellWebview',{value:1});"
     "const post=(m)=>{try{window.webkit.messageHandlers.__shellwv__.postMessage(m)}catch(e){}};"
     "window.print=function(){post({t:'print'})};"
     "window.close=function(){post({t:'close'})};"
     "const EDIT='textarea,select,input:not([type]),input[type=text],input[type=search],input[type=email],"
     "input[type=url],input[type=tel],input[type=password],input[type=number],input[type=date],input[type=time]';"
     "addEventListener('contextmenu',(e)=>{let t=e.target;if(t&&!(t instanceof Element))t=t.parentElement;"
     "const a=t&&t.closest('a[href]'),img=t&&t.closest('img[src]');"
     "post({t:'contextmenu',x:e.clientX,y:e.clientY,linkURL:a?a.href:null,srcURL:img?img.src:null,"
     "selectionText:String(getSelection()||''),editable:!!(t&&(t.isContentEditable||t.closest(EDIT)))});},true);"
     "document.addEventListener('DOMContentLoaded',()=>post({t:'ready'}));})();";

static void close_requested(SDWebViewState *s) {
  if (NSWindow *win = platform_window(s.nativeId)) [win performClose:nil]; // honours the close veto
  else emit_for(s, @"closeRequested", @{});
}

// Starts a print operation; returns an error message when it could not start.
static NSString *print_view(SDWebViewState *s, BOOL silent, NSString *pdfPath, NSPrintInfo *info, NSArray *ranges, void (^done)(BOOL ok));

@implementation SDWebViewState
- (BOOL)debug {
  return [[self.webview.configuration.preferences valueForKey:@"developerExtrasEnabled"] boolValue];
}
- (NSDictionary *)source {
  if (platform_lifecycle_target(self.webview).count) return platform_lifecycle_target(self.webview);
  if (self.popoverId) return @{@"popoverId" : self.popoverId};
  return @{@"windowId" : @(platform_public_window_id(self.nativeId))};
}
- (void)userContentController:(WKUserContentController *)ucc didReceiveScriptMessage:(WKScriptMessage *)message {
  if (!message.frameInfo.isMainFrame || ![message.body isKindOfClass:NSDictionary.class]) return;
  NSDictionary *m = message.body;
  NSString *t = m[@"t"];
  if ([t isEqual:@"ready"]) {
    if (platform_test_channel()) self.permissionFrame = message.frameInfo;
    NSString *app = platform_app_origin();
    if (app && [origin_string(message.frameInfo.securityOrigin) isEqualToString:app]) g_page_ready = YES;
  } else if ([t isEqual:@"print"]) {
    if (NSString *e = print_view(self, NO, nil, nil, nil, nil)) NSLog(@"[shell] window.print(): %@", e);
  } else if ([t isEqual:@"close"]) {
    close_requested(self);
  } else if ([t isEqual:@"contextmenu"]) {
    NSMutableDictionary *d = [NSMutableDictionary dictionaryWithDictionary:self.source];
    d[@"x"] = m[@"x"] ?: @0;
    d[@"y"] = m[@"y"] ?: @0;
    d[@"editable"] = @([m[@"editable"] boolValue]);
    for (NSString *k in @[ @"linkURL", @"srcURL" ])
      if ([m[k] isKindOfClass:NSString.class]) d[k] = m[k];
    if ([m[@"selectionText"] isKindOfClass:NSString.class] && [m[@"selectionText"] length]) d[@"selectionText"] = m[@"selectionText"];
    d[@"mode"] = self.contextMode;
    platform_emit(@"contextMenu", d);
  }
}
@end

static void emit_for(SDWebViewState *s, NSString *name, NSDictionary *data) {
  NSMutableDictionary *d = [NSMutableDictionary dictionaryWithDictionary:s ? s.source : @{}];
  [d addEntriesFromDictionary:data ?: @{}];
  platform_emit(name, d);
}

static SDWebViewState *state_of(WKWebView *wv) { return wv ? objc_getAssociatedObject(wv, &kStateKey) : nil; }

// ---------------------------------------------------------------------------
// JS dialogs (alert / confirm / prompt), file input, media permission, close

static void present_alert(SDWebViewState *s, NSAlert *alert, NSString *type, NSString *message, NSString *defaultText,
                          void (^handler)(NSModalResponse)) {
  s.activeAlert = alert;
  s.activeType = type;
  SDWebViewState *__weak weak = s;
  void (^finish)(NSModalResponse) = ^(NSModalResponse r) {
    handler(r);
    SDWebViewState *st = weak;
    if (st && st.activeAlert == alert) {
      st.activeAlert = nil;
      st.activeInput = nil;
      st.activeType = nil;
    }
  };
  NSMutableDictionary *ev = [@{@"type" : type, @"message" : message ?: @""} mutableCopy];
  if (defaultText) ev[@"defaultValue"] = defaultText;
  emit_for(s, @"jsDialog", ev);
  // Windows: a sheet on the page's window (never blocks the run loop). Popovers
  // (and windows that already carry a sheet): app-modal.
  NSWindow *win = platform_window(s.nativeId) ?: platform_window(platform_view_owner(s.nativeId)); // a view's: its window
  if (win && !win.attachedSheet) {
    [alert beginSheetModalForWindow:win completionHandler:finish];
  } else {
    run_outside_gcd(^{
      [NSApp activateIgnoringOtherApps:YES];
      finish([alert runModal]);
    });
  }
}

static NSAlert *make_alert(NSString *message, NSArray<NSString *> *buttons) {
  NSAlert *alert = [NSAlert new];
  alert.messageText = platform_app_name();
  alert.informativeText = message ?: @"";
  for (NSString *b in buttons) [alert addButtonWithTitle:b];
  return alert;
}

static void media_step(NSArray<AVMediaType> *media, NSUInteger i, void (^decide)(WKPermissionDecision)) {
  if (i >= media.count) return decide(WKPermissionDecisionGrant);
  switch ([AVCaptureDevice authorizationStatusForMediaType:media[i]]) {
  case AVAuthorizationStatusAuthorized: return media_step(media, i + 1, decide);
  case AVAuthorizationStatusNotDetermined: {
    [AVCaptureDevice requestAccessForMediaType:media[i] completionHandler:^(BOOL granted) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (granted) media_step(media, i + 1, decide);
        else decide(WKPermissionDecisionDeny);
      });
    }];
    return;
  }
  default: return decide(WKPermissionDecisionDeny);
  }
}

// Usage descriptions declared in the config: a dev run has no Info.plist of the app's own (the
// process is bun; macOS asks on behalf of the app that started it, the terminal).
static NSDictionary *g_usage;
void platform_set_usage_descriptions(NSDictionary *usage) { g_usage = [usage copy]; }

/// The app declared why it uses this (Info.plist, or the config in dev): without it macOS kills
/// the process on first use.
static BOOL has_usage(NSString *key) {
  return [NSBundle.mainBundle.infoDictionary[key] length] || [g_usage[key] length];
}

// Location for navigator.geolocation: WebKit reads it through CoreLocation once the app is
// authorized — asked the first time a page wants it.
@interface SDLocationAuth : NSObject <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@property(nonatomic, strong) NSMutableArray<void (^)(BOOL)> *waiting;
@end
@implementation SDLocationAuth
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager API_AVAILABLE(macos(11.0)) {
  CLAuthorizationStatus status = manager.authorizationStatus;
  if (status == kCLAuthorizationStatusNotDetermined) return;
  BOOL ok = status == kCLAuthorizationStatusAuthorizedAlways || status == (CLAuthorizationStatus)4; // when in use
  NSArray *waiting = [self.waiting copy];
  [self.waiting removeAllObjects];
  for (void (^done)(BOOL) in waiting) done(ok);
}
@end

static void location_authorized(void (^done)(BOOL)) {
  static SDLocationAuth *auth;
  if (@available(macOS 11.0, *)) {
    if (!auth) {
      auth = [SDLocationAuth new];
      auth.waiting = [NSMutableArray array];
      auth.manager = [CLLocationManager new];
      auth.manager.delegate = auth;
    }
    CLAuthorizationStatus status = auth.manager.authorizationStatus;
    if (status != kCLAuthorizationStatusNotDetermined) return done(status == kCLAuthorizationStatusAuthorizedAlways || status == (CLAuthorizationStatus)4);
    [auth.waiting addObject:done];
    [auth.manager requestWhenInUseAuthorization];
    // No answer (a dev run: bun has no bundle for macOS to ask on behalf of): the page gets a
    // denial instead of waiting forever.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      if (![auth.waiting containsObject:done]) return;
      [auth.waiting removeObject:done];
      NSLog(@"[shell] geolocation: no answer from macOS (a dev run can't ask: try the built app)");
      done(NO);
    });
  } else done(NO);
}

@implementation SDUIDelegate
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
      forNavigationAction:(WKNavigationAction *)navigationAction windowFeatures:(WKWindowFeatures *)windowFeatures {
  return nil; // window.open → the navigation policy (shell_macos.mm) already sends it to the browser
}

// The input's `accept` (MIME types — image/* too — and .extensions) as the panel's file types.
// WebKit keeps them on the parameters without a public accessor: read when there, else any file.
static NSArray<UTType *> *accepted_types(WKOpenPanelParameters *parameters) {
  NSMutableArray<UTType *> *types = [NSMutableArray array];
  NSDictionary<NSString *, UTType *> *families = @{@"image" : UTTypeImage, @"video" : UTTypeMovie, @"audio" : UTTypeAudio, @"text" : UTTypeText};
  if ([parameters respondsToSelector:NSSelectorFromString(@"_acceptedMIMETypes")])
    for (NSString *mime in [parameters valueForKey:@"_acceptedMIMETypes"]) {
      if (![mime isKindOfClass:NSString.class]) continue;
      UTType *t = [mime hasSuffix:@"/*"] ? families[[mime substringToIndex:mime.length - 2]] : [UTType typeWithMIMEType:mime];
      if (t) [types addObject:t];
    }
  if ([parameters respondsToSelector:NSSelectorFromString(@"_acceptedFileExtensions")])
    for (NSString *ext in [parameters valueForKey:@"_acceptedFileExtensions"]) {
      if (![ext isKindOfClass:NSString.class]) continue;
      if (UTType *t = [UTType typeWithFilenameExtension:[ext hasPrefix:@"."] ? [ext substringFromIndex:1] : ext]) [types addObject:t];
    }
  return types;
}

- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *))completionHandler {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.canChooseFiles = !parameters.allowsDirectories;
  panel.canChooseDirectories = parameters.allowsDirectories;
  panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
  NSArray<UTType *> *types = parameters.allowsDirectories ? @[] : accepted_types(parameters);
  if (types.count) panel.allowedContentTypes = types;
  void (^done)(NSModalResponse) = ^(NSModalResponse r) { completionHandler(r == NSModalResponseOK ? panel.URLs : nil); };
  NSWindow *win = platform_window(self.state.nativeId) ?: platform_window(platform_view_owner(self.state.nativeId)); // a view's: its window
  if (win && !win.attachedSheet) [panel beginSheetModalForWindow:win completionHandler:done];
  else run_outside_gcd(^{ done([panel runModal]); });
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
  SDWebViewState *s = self.state;
  if (!s) return completionHandler();
  present_alert(s, make_alert(message, @[ @"OK" ]), @"alert", message, nil, ^(NSModalResponse) { completionHandler(); });
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message
    initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
  SDWebViewState *s = self.state;
  if (!s) return completionHandler(NO);
  present_alert(s, make_alert(message, @[ @"OK", @"Cancel" ]), @"confirm", message, nil,
                ^(NSModalResponse r) { completionHandler(r == NSAlertFirstButtonReturn); });
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
    defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame
    completionHandler:(void (^)(NSString *))completionHandler {
  SDWebViewState *s = self.state;
  if (!s) return completionHandler(nil);
  NSAlert *alert = make_alert(prompt, @[ @"OK", @"Cancel" ]);
  NSTextField *input = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 260, 24)];
  input.stringValue = defaultText ?: @"";
  alert.accessoryView = input;
  [alert layout];
  alert.window.initialFirstResponder = input;
  s.activeInput = input;
  present_alert(s, alert, @"prompt", prompt, defaultText ?: @"", ^(NSModalResponse r) {
    completionHandler(r == NSAlertFirstButtonReturn ? input.stringValue : nil);
  });
}

// Per-origin policy precedes TCC and usage checks. The callback never blocks the UI thread.
- (void)webView:(WKWebView *)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type
    decisionHandler:(void (^)(WKPermissionDecision))decisionHandler API_AVAILABLE(macos(12.0)) {
  NSMutableArray<AVMediaType> *media = [NSMutableArray array];
  if (type == WKMediaCaptureTypeCamera || type == WKMediaCaptureTypeCameraAndMicrophone) [media addObject:AVMediaTypeVideo];
  if (type == WKMediaCaptureTypeMicrophone || type == WKMediaCaptureTypeCameraAndMicrophone) [media addObject:AVMediaTypeAudio];
  void (^authorize)(BOOL) = ^(BOOL prompt) {
    for (AVMediaType m in media) {
      if (!has_usage([m isEqual:AVMediaTypeVideo] ? @"NSCameraUsageDescription" : @"NSMicrophoneUsageDescription"))
        return decisionHandler(WKPermissionDecisionDeny);
    }
    media_step(media, 0, ^(WKPermissionDecision d) {
      decisionHandler(d == WKPermissionDecisionGrant && prompt ? WKPermissionDecisionPrompt : d);
    });
  };
  NSString *first = [media.firstObject isEqual:AVMediaTypeVideo] ? @"camera" : @"microphone";
  platform_web_permission(webView, origin, frame, first, ^(NSString *decision) {
    if ([decision isEqual:@"deny"]) return decisionHandler(WKPermissionDecisionDeny);
    if (media.count < 2) return authorize([decision isEqual:@"prompt"]);
    platform_web_permission(webView, origin, frame, @"microphone", ^(NSString *second) {
      if ([second isEqual:@"deny"]) return decisionHandler(WKPermissionDecisionDeny);
      authorize([decision isEqual:@"prompt"] || [second isEqual:@"prompt"]);
    });
  });
}

// WebKit invokes these private SPI callbacks only on engines that support them. They do
// not confer USB/HID/serial support. Older boolean forms can prompt TCC, not WebKit UI.
- (void)_webView:(WKWebView *)webView requestGeolocationPermissionForOrigin:(WKSecurityOrigin *)origin initiatedByFrame:(WKFrameInfo *)frame
         decisionHandler:(void (^)(WKPermissionDecision))decisionHandler API_AVAILABLE(macos(12.0)) {
  platform_web_permission(webView, origin, frame, @"location", ^(NSString *decision) {
    if ([decision isEqual:@"deny"] || !has_usage(@"NSLocationUsageDescription")) return decisionHandler(WKPermissionDecisionDeny);
    location_authorized(^(BOOL ok) { decisionHandler(!ok ? WKPermissionDecisionDeny : [decision isEqual:@"prompt"] ? WKPermissionDecisionPrompt : WKPermissionDecisionGrant); });
  });
}
- (void)_webView:(WKWebView *)webView requestGeolocationPermissionForFrame:(WKFrameInfo *)frame decisionHandler:(void (^)(BOOL))decisionHandler {
  platform_web_permission(webView, frame.securityOrigin, frame, @"location", ^(NSString *decision) {
    if ([decision isEqual:@"deny"] || !has_usage(@"NSLocationUsageDescription")) return decisionHandler(NO);
    location_authorized(decisionHandler);
  });
}
- (void)_webView:(WKWebView *)webView requestSpeechRecognitionPermissionForOrigin:(WKSecurityOrigin *)origin decisionHandler:(void (^)(BOOL))decisionHandler {
  platform_web_permission(webView, origin, nil, @"speech", ^(NSString *decision) {
    if ([decision isEqual:@"deny"]) return decisionHandler(NO);
    platform_web_permission(webView, origin, nil, @"microphone", ^(NSString *mic) {
      decisionHandler(![mic isEqual:@"deny"] && has_usage(@"NSSpeechRecognitionUsageDescription") && has_usage(@"NSMicrophoneUsageDescription"));
    });
  });
}
- (void)_webView:(WKWebView *)webView requestDisplayCapturePermissionForOrigin:(WKSecurityOrigin *)origin initiatedByFrame:(WKFrameInfo *)frame
     withSystemAudio:(BOOL)withSystemAudio decisionHandler:(void (^)(NSInteger))decisionHandler {
  platform_web_permission(webView, origin, frame, @"screenRecording", ^(NSString *decision) {
    if ([decision isEqual:@"deny"]) return decisionHandler(0);
    if (CGPreflightScreenCaptureAccess()) return decisionHandler(1);
    CGRequestScreenCaptureAccess();
    decisionHandler(0);
  });
}

- (void)webViewDidClose:(WKWebView *)webView {
  if (SDWebViewState *s = self.state) close_requested(s);
}
@end

// ---------------------------------------------------------------------------
// File drop: WKWebView's NSDraggingDestination methods, patched at class level.

static NSArray<NSString *> *dragged_paths(id<NSDraggingInfo> info) {
  NSArray<NSURL *> *urls = [info.draggingPasteboard readObjectsForClasses:@[ NSURL.class ]
                                                                  options:@{NSPasteboardURLReadingFileURLsOnlyKey : @YES}];
  NSMutableArray *paths = [NSMutableArray array];
  for (NSURL *u in urls)
    if (u.isFileURL && u.path) [paths addObject:u.path];
  return paths;
}

// Window point → CSS px from the page's top-left corner.
static NSPoint page_point(WKWebView *wv, NSPoint windowPoint) {
  NSPoint p = [wv convertPoint:windowPoint fromView:nil];
  if (!wv.isFlipped) p.y = NSHeight(wv.bounds) - p.y;
  CGFloat scale = (wv.pageZoom ?: 1) * (wv.magnification ?: 1);
  return NSMakePoint(p.x / scale, p.y / scale);
}

static void file_drag(SDWebViewState *s, NSString *phase, NSArray<NSString *> *paths, NSPoint pt) {
  if ([phase isEqual:@"leave"]) {
    if (!s.dragging) return;
    s.dragging = NO;
    return emit_for(s, @"fileDragLeave", @{});
  }
  if (!paths.count) return;
  NSDictionary *d = @{@"paths" : paths, @"x" : @(round(pt.x)), @"y" : @(round(pt.y))};
  if ([phase isEqual:@"enter"]) {
    if (s.dragging) return;
    s.dragging = YES;
    emit_for(s, @"fileDragEnter", d);
  } else {
    s.dragging = NO;
    emit_for(s, @"fileDrop", d);
  }
}

// Test hook: an in-process NSDraggingInfo (a private pasteboard with file URLs),
// fed to the patched WKWebView methods; WebKit gets the real call-through.
@interface SDFakeDrag : NSObject <NSDraggingInfo>
@property(nonatomic, strong) NSPasteboard *pasteboard;
@property(nonatomic) NSPoint location;
@property(nonatomic, weak) NSWindow *window;
@end
@implementation SDFakeDrag
@synthesize draggingFormation, animatesToDestination, numberOfValidItemsForDrop;
- (NSWindow *)draggingDestinationWindow { return self.window; }
- (NSDragOperation)draggingSourceOperationMask { return NSDragOperationCopy | NSDragOperationGeneric | NSDragOperationLink; }
- (NSPoint)draggingLocation { return self.location; }
- (NSPoint)draggedImageLocation { return self.location; }
- (NSImage *)draggedImage { return nil; }
- (NSPasteboard *)draggingPasteboard { return self.pasteboard; }
- (id)draggingSource { return nil; }
- (NSInteger)draggingSequenceNumber { return 4242; }
- (void)slideDraggedImageTo:(NSPoint)screenPoint {}
- (void)enumerateDraggingItemsWithOptions:(NSDraggingItemEnumerationOptions)enumOpts forView:(NSView *)view
                                  classes:(NSArray<Class> *)classArray searchOptions:(NSDictionary *)searchOptions
                               usingBlock:(void (^)(NSDraggingItem *, NSInteger, BOOL *))block {}
- (NSSpringLoadingHighlight)springLoadingHighlight { return NSSpringLoadingHighlightNone; }
- (void)resetSpringLoading {}
@end

static IMP swizzle(Class cls, SEL sel, id block, const char *types) {
  Method m = class_getInstanceMethod(cls, sel);
  IMP imp = imp_implementationWithBlock(block);
  if (!m) {
    class_addMethod(cls, sel, imp, types);
    return NULL;
  }
  IMP orig = method_getImplementation(m);
  if (!class_addMethod(cls, sel, imp, method_getTypeEncoding(m))) orig = method_setImplementation(m, imp);
  return orig; // inherited → the superclass implementation, still valid to call
}

static void apply_context_menu(SDWebViewState *s, NSMenu *menu);

static void install_class_patches(void) {
  static BOOL done = NO;
  if (done) return;
  done = YES;
  Class cls = WKWebView.class;

  static IMP entered, exited, perform, willOpen;
  entered = swizzle(cls, @selector(draggingEntered:), ^NSDragOperation(WKWebView *self_, id<NSDraggingInfo> info) {
    SDWebViewState *s = state_of(self_);
    if (s.fileDrop) file_drag(s, @"enter", dragged_paths(info), page_point(self_, info.draggingLocation));
    return entered ? ((NSDragOperation(*)(id, SEL, id))entered)(self_, @selector(draggingEntered:), info) : NSDragOperationNone;
  }, "Q@:@");
  exited = swizzle(cls, @selector(draggingExited:), ^(WKWebView *self_, id<NSDraggingInfo> info) {
    SDWebViewState *s = state_of(self_);
    if (s) file_drag(s, @"leave", nil, NSZeroPoint);
    if (exited) ((void (*)(id, SEL, id))exited)(self_, @selector(draggingExited:), info);
  }, "v@:@");
  perform = swizzle(cls, @selector(performDragOperation:), ^BOOL(WKWebView *self_, id<NSDraggingInfo> info) {
    SDWebViewState *s = state_of(self_);
    if (s.fileDrop) file_drag(s, @"drop", dragged_paths(info), page_point(self_, info.draggingLocation));
    else if (s) s.dragging = NO;
    // Call through: the page still gets its DOM dragenter/dragover/drop with File objects.
    return perform ? ((BOOL(*)(id, SEL, id))perform)(self_, @selector(performDragOperation:), info) : NO;
  }, "c@:@");
  // A drag let go where nothing takes it ends there, without sliding back to where it started
  // (WebKit starts page drags with the classic NSView call): a tab dropped out of its window
  // opens its own window at once, not half a second later.
  static IMP dragImage;
  dragImage = swizzle(cls, @selector(dragImage:at:offset:event:pasteboard:source:slideBack:),
                      ^(WKWebView *self_, NSImage *image, NSPoint at, NSSize offset, NSEvent *event, NSPasteboard *pb, id source, BOOL) {
                        ((void (*)(id, SEL, id, NSPoint, NSSize, id, id, id, BOOL))dragImage)(
                            self_, @selector(dragImage:at:offset:event:pasteboard:source:slideBack:), image, at, offset, event, pb, source, NO);
                      },
                      "v@:@{CGPoint=dd}{CGSize=dd}@@@c");
  willOpen = swizzle(cls, @selector(willOpenMenu:withEvent:), ^(WKWebView *self_, NSMenu *menu, NSEvent *event) {
    if (willOpen) ((void (*)(id, SEL, id, id))willOpen)(self_, @selector(willOpenMenu:withEvent:), menu, event);
    if (SDWebViewState *s = state_of(self_)) apply_context_menu(s, menu);
  }, "v@:@@");
}

// ---------------------------------------------------------------------------
// Context menu
//
//   default  WebKit's own menu (Reload, Inspect Element when debug, Look Up…).
//   none     nothing — except, with editMenu (default true), the text-editing
//            items WebKit offers for the click (Cut/Copy/Paste, spelling
//            guesses): what Slack/VS Code/Discord ship. No editing context → no menu.
//   custom   the app's MenuItemSpec[] (items emit menuAction), + the edit items
//            on top when editMenu and the click is on text/an input.
// Debug views always keep "Inspect Element".

static BOOL is_edit_item(NSMenuItem *item) {
  NSString *ident = item.identifier ?: @"";
  for (NSString *suffix in @[ @"Cut", @"Copy", @"Paste", @"PasteAsPlainText" ])
    if ([ident hasSuffix:[@"MenuItemIdentifier" stringByAppendingString:suffix]]) return YES;
  // Spelling guesses / Ignore / Learn, not the whole "Spelling and Grammar" submenu.
  return [ident containsString:@"Spelling"] && ![ident hasSuffix:@"SpellingMenu"];
}
static BOOL is_inspect_item(NSMenuItem *item) { return [item.identifier hasSuffix:@"InspectElement"]; }

static void tidy_separators(NSMenu *menu) {
  BOOL lastSep = YES;
  for (NSMenuItem *item in [menu.itemArray copy]) {
    if (item.isSeparatorItem && lastSep) [menu removeItem:item];
    else lastSep = item.isSeparatorItem;
  }
  if (menu.itemArray.lastObject.isSeparatorItem) [menu removeItem:menu.itemArray.lastObject];
}

static NSArray *menu_identifiers(NSMenu *menu) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSMenuItem *item in menu.itemArray)
    [out addObject:item.isSeparatorItem ? @"-"
                   : [item.identifier hasPrefix:@"WKMenuItemIdentifier"] ? [item.identifier substringFromIndex:20]
                                                                       : item.title];
  return out;
}

static void apply_context_menu_policy(SDWebViewState *s, NSMenu *menu);
static void apply_context_menu(SDWebViewState *s, NSMenu *menu) {
  NSArray *before = s.dismissMenus ? menu_identifiers(menu) : nil;
  apply_context_menu_policy(s, menu);
  if (s.dismissMenus) {
    s.lastMenu = @{@"before" : before, @"after" : menu_identifiers(menu)};
    [menu performSelector:@selector(cancelTracking) withObject:nil afterDelay:0.05
                  inModes:@[ NSEventTrackingRunLoopMode, NSDefaultRunLoopMode, NSModalPanelRunLoopMode ]];
  }
}

static void apply_context_menu_policy(SDWebViewState *s, NSMenu *menu) {
  NSString *mode = s.contextMode;
  if ([mode isEqual:@"default"]) return;
  NSMutableArray<NSMenuItem *> *edit = [NSMutableArray array];
  NSMenuItem *inspect = nil;
  for (NSMenuItem *item in menu.itemArray) {
    if (s.editMenu && is_edit_item(item)) [edit addObject:item];
    else if (is_inspect_item(item)) inspect = item;
  }
  if (!s.debug) inspect = nil;
  [menu removeAllItems];
  for (NSMenuItem *item in edit) [menu addItem:item];
  if ([mode isEqual:@"custom"] && s.contextItems.count) {
    NSString *error = nil;
    NSMenu *custom = platform_build_menu(s.contextItems, @"webview.setContextMenu", &error);
    if (custom.numberOfItems) {
      if (menu.numberOfItems) [menu addItem:NSMenuItem.separatorItem];
      for (NSMenuItem *item in [custom.itemArray copy]) {
        [custom removeItem:item];
        [menu addItem:item];
      }
    }
  }
  if (inspect) {
    if (menu.numberOfItems) [menu addItem:NSMenuItem.separatorItem];
    [menu addItem:inspect];
  }
  tidy_separators(menu); // an empty menu is not shown at all
}

// ---------------------------------------------------------------------------
// Print

@interface SDPrintRunner : NSObject
@property(nonatomic, copy) void (^done)(BOOL ok);
@property(nonatomic, strong) NSPrintOperation *op;
@end
@implementation SDPrintRunner
- (void)printOperationDidRun:(NSPrintOperation *)op success:(BOOL)success contextInfo:(void *)ctx {
  // AppKit may finish a panel-less operation on its own thread: hop to main,
  // after AppKit is done with the operation.
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.done) self.done(success);
    self.done = nil;
    self.op = nil;
  });
}
@end

static NSMutableSet<SDPrintRunner *> *g_print_runners;
#include "webview_print.h"

static NSString *print_view(SDWebViewState *s, BOOL silent, NSString *pdfPath, NSPrintInfo *info, NSArray *ranges, void (^done)(BOOL ok)) {
  WKWebView *wv = s.webview;
  NSWindow *win = wv.window;
  if (!wv || !win) return @"the web view is not in a window";
  if (win.attachedSheet) return @"the window already shows a sheet (another print or dialog)";
  if (!info) { NSString *error = nil; info = print_info(@{}, pdfPath != nil, &error); }
  if (!info) return @"invalid print configuration";
  NSString *output = pdfPath ? [pdfPath.stringByDeletingLastPathComponent stringByAppendingPathComponent:
      [NSString stringWithFormat:@".sd-print-%@.pdf", NSUUID.UUID.UUIDString]] : nil;
  if (pdfPath) {
    info.jobDisposition = NSPrintSaveJob;
    info.dictionary[NSPrintJobSavingURL] = [NSURL fileURLWithPath:output];
  }
  NSPrintOperation *op = [wv printOperationWithPrintInfo:info];
  if (!op) return @"WebKit could not create a print operation";
  op.showsPrintPanel = !silent;
  op.showsProgressPanel = !silent;
  op.view.frame = wv.bounds; // WebKit's print view starts at 0×0 → blank output otherwise
  SDPrintRunner *runner = [SDPrintRunner new];
  runner.op = op;
  if (!g_print_runners) g_print_runners = [NSMutableSet set];
  [g_print_runners addObject:runner];
  SDWebViewState *__weak weak = s;
  SDPrintRunner *__weak weakRunner = runner;
  runner.done = ^(BOOL ok) {
    if (pdfPath) {
      if (ok) ok = select_pdf_pages(output, ranges);
      if (ok) ok = rename(output.fileSystemRepresentation, pdfPath.fileSystemRepresentation) == 0;
      [NSFileManager.defaultManager removeItemAtPath:output error:nil];
    }
    if (SDPrintRunner *r = weakRunner) [g_print_runners removeObject:r];
    if (SDWebViewState *st = weak) emit_for(st, @"printFinished", pdfPath ? @{@"success" : @(ok), @"path" : pdfPath} : @{@"success" : @(ok)});
    if (done) done(ok);
  };
  [op runOperationModalForWindow:win delegate:runner didRunSelector:@selector(printOperationDidRun:success:contextInfo:) contextInfo:NULL];
  return nil;
}

// ---------------------------------------------------------------------------
// Downloads (WKDownload, macOS 11.3+)

#include "webview_downloads.h"

void platform_webview_download_started(int nativeId, WKDownload *download) {
  SDWebViewState *s = [states() objectForKey:@(nativeId)];
  adopt_download(download, s ? s.source : @{@"windowId" : @(platform_public_window_id(nativeId))}, nil);
}

WKNavigationResponsePolicy platform_webview_response_policy(WKNavigationResponse *r) {
  if (!r.canShowMIMEType) return WKNavigationResponsePolicyDownload;
  if ([r.response isKindOfClass:NSHTTPURLResponse.class]) {
    NSString *cd = [(NSHTTPURLResponse *)r.response valueForHTTPHeaderField:@"Content-Disposition"];
    if ([[cd stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString hasPrefix:@"attachment"])
      return WKNavigationResponsePolicyDownload;
  }
  return WKNavigationResponsePolicyAllow;
}

// ---------------------------------------------------------------------------
// Open files (application:openURLs: with file URLs, split out by platform_core.mm)

void platform_webview_open_files(NSArray<NSURL *> *files) {
  NSMutableArray *paths = [NSMutableArray array];
  for (NSURL *u in files)
    if (u.isFileURL && u.path) [paths addObject:u.path];
  if (!paths.count) return;
  if (!g_opened_files) g_opened_files = [NSMutableArray array];
  // Cold launch (double-clicked document): no page can listen yet → queue for app.getOpenedFiles.
  if (!g_page_ready) [g_opened_files addObjectsFromArray:paths];
  platform_emit(@"openFiles", @{@"paths" : paths});
}

// ---------------------------------------------------------------------------
// Configure

static NSString *popover_ident(WKWebView *wv) {
  for (WKUserScript *script in wv.configuration.userContentController.userScripts) {
    NSString *src = script.source;
    NSRange r = [src rangeOfString:@"__shellPopover=Object.freeze({id:"];
    if (r.location == NSNotFound) continue;
    NSString *rest = [src substringFromIndex:NSMaxRange(r)];
    NSRange end = [rest rangeOfString:@"});"];
    if (end.location == NSNotFound) continue;
    NSData *json = [[rest substringToIndex:end.location] dataUsingEncoding:NSUTF8StringEncoding];
    id ident = [NSJSONSerialization JSONObjectWithData:json options:NSJSONReadingFragmentsAllowed error:nil];
    if ([ident isKindOfClass:NSString.class]) return ident;
  }
  return nil;
}

static void set_context_mode(SDWebViewState *s, NSString *mode, NSArray *items) {
  s.contextMode = mode ?: (s.debug ? @"default" : @"none");
  s.contextItems = items;
}

void platform_webview_configure(int nativeId, WKWebView *webview) {
  platform_session_track(nativeId, webview);
  platform_web_content_attach(webview);
  install_class_patches();
  SDWebViewState *s = [SDWebViewState new];
  s.nativeId = nativeId;
  s.webview = webview;
  s.popoverId = platform_window(nativeId) ? nil : popover_ident(webview);
  s.fileDrop = g_file_drop_default;
  s.editMenu = YES;
  set_context_mode(s, g_context_mode_default, g_context_items_default);
  s.ui = [SDUIDelegate new];
  s.ui.state = s;

  id previous = webview.UIDelegate;
  if (previous && [NSStringFromClass([previous class]) isEqual:@"WebviewWKUIDelegate"]) {
    // webview/webview owns its delegate (+1) and releases whatever UIDelegate is
    // set when its engine is destroyed with the window still open. Take over its
    // reference, and give that potential release one of ours to balance.
    s.originalUIDelegate = CFBridgingRelease((__bridge CFTypeRef)previous);
    CFBridgingRetain(s.ui);
  }
  webview.UIDelegate = s.ui;

  WKUserContentController *ucc = webview.configuration.userContentController;
  [ucc removeScriptMessageHandlerForName:@"__shellwv__"];
  [ucc addScriptMessageHandler:s name:@"__shellwv__"]; // retains s; s holds the web view weakly
  [ucc addUserScript:[[WKUserScript alloc] initWithSource:kWebviewScript injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                         forMainFrameOnly:YES]];
  objc_setAssociatedObject(webview, &kStateKey, s, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [states() setObject:s forKey:@(nativeId)];
}

// ---------------------------------------------------------------------------
// Ops

// Target: viewId, popoverId, windowId (public), the calling page, or primary.
static SDWebViewState *resolve(PlatformCall *c) {
  if (c.args[@"viewId"]) {
    NSString *vid = [c string:@"viewId"];
    if (!vid.length) { [c fail:@"invalid_args" message:@"webview: viewId must be a non-empty string"]; return nil; }
    for (SDWebViewState *s in states().objectEnumerator)
      if ([platform_lifecycle_target(s.webview)[@"viewId"] isEqual:vid] && s.webview) return s;
    [c fail:@"invalid_args" message:@"webview: unknown viewId"];
    return nil;
  }
  if (NSString *pid = [c string:@"popoverId"]) {
    for (SDWebViewState *s in states().objectEnumerator)
      if ([s.popoverId isEqual:pid] && s.webview) return s;
    [c fail:@"invalid_args" message:[NSString stringWithFormat:@"webview.%@: unknown popover `%@`", c.op, pid]];
    return nil;
  }
  if (![c has:@"windowId"] && c.callerWindow && !platform_window(c.callerWindow)) {
    SDWebViewState *s = [states() objectForKey:@(c.callerWindow)];
    if (s.webview) return s;
  }
  int nid = platform_resolve_window(c);
  SDWebViewState *s = nid ? [states() objectForKey:@(nid)] : nil;
  if (!s.webview) {
    [c fail:@"invalid_args" message:[NSString stringWithFormat:@"webview.%@: no such window", c.op]];
    return nil;
  }
  return s;
}

typedef void (^ViewOp)(PlatformCall *c, SDWebViewState *s, WKWebView *wv);
static void reg(NSString *op, ViewOp body) {
  platform_register(@"webview", op, ^(PlatformCall *c) {
    SDWebViewState *s = resolve(c);
    if (s) body(c, s, s.webview);
  });
}

static NSString *js_error(NSError *e) {
  return e.userInfo[@"WKJavaScriptExceptionMessage"] ?: e.localizedDescription ?: @"JavaScript error";
}

static id json_safe(id v) {
  if (!v || v == NSNull.null) return NSNull.null;
  if ([v isKindOfClass:NSDate.class]) return @([(NSDate *)v timeIntervalSince1970] * 1000);
  if ([v isKindOfClass:NSArray.class]) {
    NSMutableArray *a = [NSMutableArray array];
    for (id x in v) [a addObject:json_safe(x)];
    return a;
  }
  if ([v isKindOfClass:NSDictionary.class]) {
    NSMutableDictionary *d = [NSMutableDictionary dictionary];
    for (id k in v) d[[k description]] = json_safe(v[k]);
    return d;
  }
  return [v isKindOfClass:NSString.class] || [v isKindOfClass:NSNumber.class] ? v : [v description];
}

static NSArray *all_states(void) {
  NSMutableArray *out = [NSMutableArray array];
  for (SDWebViewState *s in states().objectEnumerator)
    if (s.webview) [out addObject:s];
  return out;
}

static void execute_js(SDWebViewState *s, NSString *code, PlatformCall *c) {
  WKWebView *wv = s.webview;
  // Awaits promises and returns a JSON value. Indirect eval keeps script
  // semantics (value of the last statement); a page CSP without 'unsafe-eval'
  // blocks it, then we fall back to evaluateJavaScript (no promise awaiting).
  NSString *worldName = [c has:@"world"] ? [c string:@"world"] : @"page";
  if (!worldName.length) return [c fail:@"invalid_args" message:@"world must be nonempty"];
  WKContentWorld *world = [worldName isEqual:@"page"] ? WKContentWorld.pageWorld : [WKContentWorld worldWithName:worldName];
  NSString *body = @"const v = await (0, eval)(__code); return v === undefined ? 'null' : (JSON.stringify(v) ?? 'null');";
  [wv callAsyncJavaScript:body arguments:@{@"__code" : code} inFrame:nil inContentWorld:world
        completionHandler:^(id result, NSError *error) {
          if (!error) {
            NSData *data = [result isKindOfClass:NSString.class] ? [result dataUsingEncoding:NSUTF8StringEncoding] : nil;
            id value = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:nil] : nil;
            return [c ok:value ?: NSNull.null];
          }
          NSString *msg = js_error(error);
          if (![msg containsString:@"EvalError"] && ![msg containsString:@"unsafe-eval"])
            return [c fail:@"internal" message:[@"webview.executeJavaScript: " stringByAppendingString:msg]];
          [wv evaluateJavaScript:code inFrame:nil inContentWorld:world completionHandler:^(id r2, NSError *e2) {
            if (e2) return [c fail:@"internal" message:[@"webview.executeJavaScript: " stringByAppendingString:js_error(e2)]];
            [c ok:json_safe(r2)];
          }];
        }];
}

// Background throttling: WebKit slows a hidden or occluded page's timers and may suspend its
// process (energy). Off, the page runs at full speed out of sight — a player, a chat, a timer.
static NSMutableSet<NSValue *> *g_full_speed; // web views running at full speed out of sight
static id<NSObject> g_activity;                  // keeps App Nap off while there's one

static BOOL is_full_speed(WKWebView *wv) { return [g_full_speed containsObject:[NSValue valueWithNonretainedObject:wv]]; }

void platform_webview_set_throttling(WKWebView *wv, BOOL enabled) {
  WKPreferences *prefs = wv.configuration.preferences;
  if (@available(macOS 14.0, *)) prefs.inactiveSchedulingPolicy = enabled ? WKInactiveSchedulingPolicySuspend : WKInactiveSchedulingPolicyNone;
  for (NSString *name in @[ @"_setHiddenPageDOMTimerThrottlingEnabled:", @"_setPageVisibilityBasedProcessSuppressionEnabled:", @"_setDOMTimersThrottlingEnabled:",
                            @"_setHiddenPageDOMTimerThrottlingAutoIncreases:", @"_setAppNapEnabled:" ]) {
    SEL sel = NSSelectorFromString(name);
    if ([prefs respondsToSelector:sel]) ((void (*)(id, SEL, BOOL))objc_msgSend)(prefs, sel, enabled);
  }
  // Covered by other windows: still a visible page.
  SEL occlusion = NSSelectorFromString(@"_setWindowOcclusionDetectionEnabled:");
  if ([wv respondsToSelector:occlusion]) ((void (*)(id, SEL, BOOL))objc_msgSend)(wv, occlusion, enabled);
  // App Nap would slow the whole app (and the page's process with it) once the window is hidden.
  g_full_speed = g_full_speed ?: [NSMutableSet set];
  NSValue *key = [NSValue valueWithNonretainedObject:wv];
  if (enabled) [g_full_speed removeObject:key];
  else [g_full_speed addObject:key];
  if (g_full_speed.count && !g_activity)
    g_activity = [NSProcessInfo.processInfo beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep reason:@"a page runs at full speed out of sight"];
  else if (!g_full_speed.count && g_activity) {
    [NSProcessInfo.processInfo endActivity:g_activity];
    g_activity = nil;
  }
}

// Website data: the kinds a page or a site stores, by name.
static NSSet<NSString *> *data_types(id names, NSString **bad) {
  NSDictionary *map = @{
    @"cookies" : @[ WKWebsiteDataTypeCookies ],
    @"localStorage" : @[ WKWebsiteDataTypeLocalStorage ],
    @"sessionStorage" : @[ WKWebsiteDataTypeSessionStorage ],
    @"indexedDB" : @[ WKWebsiteDataTypeIndexedDBDatabases ],
    @"cache" : @[ WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeFetchCache, WKWebsiteDataTypeOfflineWebApplicationCache ],
    @"serviceWorkers" : @[ WKWebsiteDataTypeServiceWorkerRegistrations ],
  };
  NSMutableSet *types = [NSMutableSet set];
  for (id n in [names isKindOfClass:NSArray.class] ? names : @[ @"all" ]) {
    if ([n isEqual:@"all"]) return WKWebsiteDataStore.allWebsiteDataTypes;
    if (!map[n]) {
      if (bad) *bad = [n description];
      return nil;
    }
    [types addObjectsFromArray:map[n]];
  }
  return types;
}

void platform_register_webview(void) {
  platform_register_web_content();
  platform_register_web_policy();
  reg(@"_permissionPolicyForTesting", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    if (!platform_test_channel()) return [c fail:@"denied" message:@"Only available to the test channel"];
    NSString *permission = [c string:@"permission"];
    if (!permission || ![@[@"camera", @"microphone", @"location", @"speech", @"screenRecording"] containsObject:permission])
      return [c fail:@"invalid_args" message:@"Expected a web permission"];
    WKFrameInfo *frame = s.permissionFrame;
    if (!frame) return [c fail:@"unavailable" message:@"The page has not reported its frame yet"];
    if ([c boolean:@"mediaDelegate" or:NO]) {
      if (![@[@"camera", @"microphone"] containsObject:permission]) return [c fail:@"invalid_args" message:@"Expected camera or microphone"];
      [s.ui webView:wv requestMediaCapturePermissionForOrigin:frame.securityOrigin initiatedByFrame:frame
        type:[permission isEqual:@"camera"] ? WKMediaCaptureTypeCamera : WKMediaCaptureTypeMicrophone
        decisionHandler:^(WKPermissionDecision decision) {
          [c ok:decision == WKPermissionDecisionDeny ? @"deny" : decision == WKPermissionDecisionGrant ? @"allow" : @"prompt"];
        }];
      return;
    }
    platform_web_permission(wv, frame.securityOrigin, frame, permission, ^(NSString *decision) { [c ok:decision]; });
  });
  reg(@"setRecovery", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    NSString *policy = [c string:@"recovery"];
    if (![@[@"reload", @"manual"] containsObject:policy]) return [c fail:@"invalid_args" message:@"recovery must be reload or manual"];
    platform_lifecycle_configure(wv, platform_lifecycle_target(wv), policy);
    [c ok:nil];
  });
  // Test-channel-only crash injection. WebKit exposes no public termination API.
  reg(@"_terminateForTesting", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    if (!platform_test_channel()) return [c fail:@"denied" message:@"Only available to the test channel"];
    // A real crash exercises the public termination callback; graceful termination SPI can stall.
    SEL process = NSSelectorFromString(@"_webProcessIdentifier");
    if (![wv respondsToSelector:process]) return [c fail:@"unsupported" message:@"WebKit process identifier SPI unavailable"];
    pid_t pid = ((pid_t (*)(id, SEL))objc_msgSend)(wv, process);
    if (pid <= 1 || pid == getpid()) return [c fail:@"unavailable" message:@"The web view has no running content process"];
    if (kill(pid, SIGKILL) != 0) return [c fail:@"unavailable" message:@"Could not terminate the view's content process"];
    [c ok:nil];
  });
  // Clear what sites stored (cookies, storage, caches): other sites' (tabs on other sites), and with
  // `app: true` the app's own too — except its cookies, which hold the session with the app's server.
  platform_register(@"webview", @"clearData", ^(PlatformCall *c) {
    NSString *bad = nil;
    NSSet *types = data_types(c.args[@"types"], &bad);
    if (!types) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"webview.clearData: unknown type `%@` (cookies, localStorage, sessionStorage, indexedDB, cache, serviceWorkers, all)", bad]];
    BOOL app = [c boolean:@"app" or:NO];
    NSString *appHost = [NSURL URLWithString:platform_app_origin() ?: @""].host;
    WKWebsiteDataStore *store = WKWebsiteDataStore.defaultDataStore;
    [store fetchDataRecordsOfTypes:types completionHandler:^(NSArray<WKWebsiteDataRecord *> *records) {
      NSMutableArray *sites = [NSMutableArray array], *own = [NSMutableArray array], *names = [NSMutableArray array];
      for (WKWebsiteDataRecord *r in records) {
        BOOL mine = [r.displayName isEqual:appHost] || [r.displayName isEqual:@"localhost"] || [r.displayName isEqual:@"127.0.0.1"];
        [(mine ? own : sites) addObject:r];
        if (!mine || app) [names addObject:r.displayName];
      }
      NSMutableSet *ownTypes = [types mutableCopy];
      [ownTypes removeObject:WKWebsiteDataTypeCookies];
      [store removeDataOfTypes:types forDataRecords:sites completionHandler:^{
        void (^done)(void) = ^{ [c ok:@{@"cleared" : names}]; };
        if (app && own.count && ownTypes.count) [store removeDataOfTypes:ownTypes forDataRecords:own completionHandler:done];
        else done();
      }];
    }];
  });
  install_class_patches();

  // -- zoom
  reg(@"setZoom", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    double z = [c number:@"zoom" or:NAN];
    if (!(z > 0)) return [c fail:@"invalid_args" message:@"webview.setZoom: `zoom` must be a positive number (1 = 100%)"];
    wv.pageZoom = MIN(5.0, MAX(0.25, z));
    [c ok:@{@"zoom" : @(wv.pageZoom)}];
  });
  reg(@"getZoom", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) { [c ok:@{@"zoom" : @(wv.pageZoom)}]; });

  // -- find in page
  reg(@"find", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    NSString *text = [c string:@"text"];
    if (!text.length) return [c fail:@"invalid_args" message:@"webview.find: `text` is required"];
    WKFindConfiguration *cfg = [WKFindConfiguration new];
    cfg.backwards = [c boolean:@"backwards" or:NO];
    cfg.caseSensitive = [c boolean:@"caseSensitive" or:NO];
    cfg.wraps = [c boolean:@"wraps" or:YES];
    [wv findString:text withConfiguration:cfg completionHandler:^(WKFindResult *r) { [c ok:@{@"matchFound" : @(r.matchFound)}]; }];
  });
  reg(@"clearFind", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    // No public API to drop the find highlight; the match is the selection.
    [wv evaluateJavaScript:@"getSelection().removeAllRanges()" completionHandler:^(id, NSError *) { [c ok:nil]; }];
  });

  // -- context menu
  platform_register(@"webview", @"setContextMenu", ^(PlatformCall *c) {
    NSString *mode = [c string:@"mode"];
    if (![@[ @"default", @"none", @"custom" ] containsObject:mode ?: @""])
      return [c fail:@"invalid_args" message:@"webview.setContextMenu: `mode` must be default | none | custom"];
    NSArray *items = [c.args[@"items"] isKindOfClass:NSArray.class] ? c.args[@"items"] : nil;
    if ([mode isEqual:@"custom"]) {
      if (!items) return [c fail:@"invalid_args" message:@"webview.setContextMenu: mode `custom` needs `items` (MenuItemSpec[])"];
      NSString *error = nil;
      if (!platform_build_menu(items, @"webview.setContextMenu", &error)) return [c fail:@"invalid_args" message:error ?: @"invalid items"];
    }
    BOOL all = [c boolean:@"all" or:NO];
    NSArray *targets;
    if (all) {
      g_context_mode_default = mode;
      g_context_items_default = items;
      targets = all_states();
    } else {
      SDWebViewState *s = resolve(c);
      if (!s) return;
      targets = @[ s ];
    }
    for (SDWebViewState *s in targets) {
      set_context_mode(s, mode, items);
      if ([c has:@"editMenu"]) s.editMenu = [c boolean:@"editMenu" or:YES];
    }
    [c ok:@{@"mode" : mode}];
  });
  reg(@"getContextMenu", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    [c ok:@{@"mode" : s.contextMode, @"editMenu" : @(s.editMenu), @"debug" : @(s.debug), @"items" : s.contextItems ?: @[]}];
  });

  // -- file drop
  platform_register(@"webview", @"setFileDrop", ^(PlatformCall *c) {
    if (![c has:@"enabled"]) return [c fail:@"invalid_args" message:@"webview.setFileDrop: `enabled` is required"];
    BOOL enabled = [c boolean:@"enabled" or:YES];
    NSArray *targets;
    if ([c boolean:@"all" or:NO]) {
      g_file_drop_default = enabled;
      targets = all_states();
    } else {
      SDWebViewState *s = resolve(c);
      if (!s) return;
      targets = @[ s ];
    }
    for (SDWebViewState *s in targets) s.fileDrop = enabled;
    [c ok:@{@"enabled" : @(enabled)}];
  });

  // -- downloads
  platform_register(@"webview", @"setDownloadDirectory", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"];
    if (!path.length) {
      g_download_dir = nil;
      return [c ok:@{@"path" : download_dir()}];
    }
    path = path.stringByExpandingTildeInPath;
    NSError *error = nil;
    if (![NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:nil error:&error])
      return [c fail:@"denied" message:[NSString stringWithFormat:@"webview.setDownloadDirectory: %@", error.localizedDescription]];
    g_download_dir = path;
    [c ok:@{@"path" : path}];
  });
  platform_register(@"webview", @"getDownloadDirectory", ^(PlatformCall *c) { [c ok:@{@"path" : download_dir()}]; });
  reg(@"download", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    NSString *raw = [c string:@"url"];
    NSURL *url = raw.length ? [NSURL URLWithString:raw relativeToURL:wv.URL].absoluteURL : nil;
    NSString *scheme = url.scheme.lowercaseString;
    if (!url || ![@[ @"http", @"https", @"blob", @"data" ] containsObject:scheme ?: @""])
      return [c fail:@"invalid_args" message:@"webview.download: `url` must be an http(s), blob: or data: URL"];
    NSString *path = [c string:@"path"];
    if (path && !path.stringByExpandingTildeInPath.isAbsolutePath) return [c fail:@"invalid_args" message:@"download path must be absolute"];
    NSDictionary *source = s.source;
    [wv startDownloadUsingRequest:[NSURLRequest requestWithURL:url] completionHandler:^(WKDownload *download) {
      SDDownload *d = adopt_download(download, source, path);
      [c ok:@{@"id" : d.ident, @"url" : d.url}];
    }];
  });
  register_download_controls();
  reg(@"resumeDownload", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    SDDownload *d = g_downloads[[c string:@"id"] ?: @""];
    if (!d) return [c fail:@"invalid_args" message:@"unknown download id"];
    if (d.download || [d.state isEqual:@"requested"] || !download_can_resume(d)) return [c fail:@"unavailable" message:@"download is active or cannot safely resume (requires resume data and a known total length)"];
    if (d.store && d.store != wv.configuration.websiteDataStore) return [c fail:@"invalid_args" message:@"resume in the original web session"];
    if (download_path_busy(d.path, d)) return [c fail:@"unavailable" message:@"download destination is in use by another transfer"];
    d.state = @"requested"; d.resumed = YES;
    NSData *data = d.resumeData;
    NSString *path = d.path, *prefix = platform_download_prefix(d.path, d.ident);
    int64_t checkpointBytes = d.checkpointBytes;
    download_changed(d);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      NSError *error = nil;
      BOOL restored = platform_download_rewind(path, prefix, checkpointBytes, &error);
      dispatch_async(dispatch_get_main_queue(), ^{
        if (!restored || !wv.window) {
          d.state = @"interrupted"; d.error = error.localizedDescription ?: @"the download's view is no longer in a window";
          download_changed(d); [c fail:@"unavailable" message:d.error]; return;
        }
        d.lastBytes = checkpointBytes;
        @try {
          [wv resumeDownloadFromResumeData:data completionHandler:^(WKDownload *download) {
            d.download = download; d.store = wv.configuration.websiteDataStore; d.source = s.source;
            download.delegate = g_download_delegate;
            d.error = nil; track_download(d);
            [c ok:download_snapshot(d)];
          }];
        } @catch (NSException *exception) {
          d.state = @"interrupted"; d.error = [NSString stringWithFormat:@"WebKit resume failed (%@)", exception.name];
          download_changed(d); [c fail:@"unavailable" message:d.error];
        }
      });
    });
  });

  // -- print
  platform_register(@"webview", @"getPrinters", ^(PlatformCall *c) { [c ok:NSPrinter.printerNames ?: @[]]; });
  reg(@"print", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    BOOL silent = [c boolean:@"silent" or:NO];
    NSString *pdf = [c string:@"pdfPath"].stringByExpandingTildeInPath;
    if (pdf) silent = YES;
    // silent / pdfPath: resolves when the job is done (spooled or PDF written).
    // Interactive: the print panel is a sheet; resolves at once, printFinished follows.
    void (^done)(BOOL) = ^(BOOL ok) {
      if (ok) [c ok:pdf ? @{@"success" : @YES, @"path" : pdf} : @{@"success" : @YES}];
      else [c fail:@"unavailable" message:@"webview.print: the print job failed or was canceled"];
    };
    NSString *validation = nil;
    NSPrintInfo *info = print_info(c.args, pdf != nil, &validation);
    if (!info) return [c fail:@"invalid_args" message:validation];
    NSString *e = print_view(s, silent, pdf, info, c.args[@"pageRanges"], silent ? done : (void (^)(BOOL))nil);
    if (e) return [c fail:@"unavailable" message:[@"webview.print: " stringByAppendingString:e]];
    if (!silent) [c ok:@{@"started" : @YES}];
  });
  platform_register(@"webview", @"printToPDF", ^(PlatformCall *c) {
    // Paginated PDF through the print system, no panel.
    NSString *path = [c string:@"path"].stringByExpandingTildeInPath;
    if (!path) return [c fail:@"invalid_args" message:@"webview.printToPDF: `path` is required"];
    SDWebViewState *s = resolve(c);
    if (!s) return;
    NSString *validation = nil;
    NSPrintInfo *info = print_info(c.args, YES, &validation);
    if (!info) return [c fail:@"invalid_args" message:validation];
    NSString *e = print_view(s, YES, path, info, c.args[@"pageRanges"], ^(BOOL ok) {
      if (ok) [c ok:@{@"path" : path}];
      else [c fail:@"unavailable" message:@"webview.printToPDF: the print job failed"];
    });
    if (e) [c fail:@"unavailable" message:[@"webview.printToPDF: " stringByAppendingString:e]];
  });

  // -- JS dialogs: answer the open alert/confirm/prompt (automation, tests)
  reg(@"respondToDialog", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    NSAlert *alert = s.activeAlert;
    if (!alert) return [c fail:@"unavailable" message:@"webview.respondToDialog: no JavaScript dialog is open"];
    NSString *type = s.activeType ?: @"alert";
    BOOL accept = [c boolean:@"accept" or:YES];
    if (NSString *text = [c string:@"text"]) s.activeInput.stringValue = text;
    NSArray<NSButton *> *buttons = alert.buttons;
    [buttons[(!accept && buttons.count > 1) ? 1 : 0] performClick:nil];
    [c ok:@{@"type" : type}];
  });
  reg(@"getDialog", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    [c ok:s.activeAlert ? @{@"type" : s.activeType ?: @"alert", @"message" : s.activeAlert.informativeText ?: @""} : NSNull.null];
  });

  // -- navigation & misc (Electron webContents parity)
  reg(@"reload", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    platform_webview_reload(wv, [c boolean:@"ignoreCache" or:NO]);
    [c ok:nil];
  });
  reg(@"stop", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    platform_webview_stop(wv);
    [c ok:nil];
  });
  reg(@"goBack", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) { [c ok:@{@"navigated" : @([wv goBack] != nil)}]; });
  reg(@"goForward", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) { [c ok:@{@"navigated" : @([wv goForward] != nil)}]; });
  reg(@"getInfo", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    NSMutableDictionary *d = [NSMutableDictionary dictionaryWithDictionary:s.source];
    [d addEntriesFromDictionary:@{
      @"url" : wv.URL.absoluteString ?: NSNull.null, @"title" : wv.title ?: @"", @"loading" : @(wv.loading),
      @"canGoBack" : @(wv.canGoBack), @"canGoForward" : @(wv.canGoForward), @"zoom" : @(wv.pageZoom),
      @"userAgent" : wv.customUserAgent.length ? wv.customUserAgent : NSNull.null, @"debug" : @(s.debug),
      @"fileDrop" : @(s.fileDrop), @"contextMenu" : s.contextMode, @"backgroundThrottling" : @(!is_full_speed(wv)),
      @"recovery" : platform_lifecycle_recovery(wv)
    }];
    if (@available(macOS 13.3, *)) d[@"inspectable"] = @(wv.inspectable);
    [c ok:d];
  });
  reg(@"setUserAgent", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    wv.customUserAgent = [c string:@"userAgent"] ?: @""; // empty → WebKit's default
    [c ok:nil];
  });
  reg(@"getUserAgent", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    [wv evaluateJavaScript:@"navigator.userAgent" completionHandler:^(id ua, NSError *e) {
      [c ok:[ua isKindOfClass:NSString.class] ? ua : (wv.customUserAgent ?: NSNull.null)];
    }];
  });
  reg(@"setInspectable", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    if (@available(macOS 13.3, *)) {
      wv.inspectable = [c boolean:@"enabled" or:YES];
      return [c ok:@{@"inspectable" : @(wv.inspectable)}];
    }
    [c fail:@"unsupported" message:@"webview.setInspectable: needs macOS 13.3"];
  });
  reg(@"executeJavaScript", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    NSString *code = [c string:@"code"];
    if (!code) return [c fail:@"invalid_args" message:@"webview.executeJavaScript: `code` is required"];
    execute_js(s, code, c);
  });
  reg(@"setBackgroundThrottling", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    platform_webview_set_throttling(wv, [c boolean:@"enabled" or:YES]);
    [c ok:nil];
  });
  // Media: the page's sound muted (it keeps playing), everything paused, and what's going on.
  reg(@"setAudioMuted", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    SEL sel = NSSelectorFromString(@"_setPageMuted:");
    if (![wv respondsToSelector:sel]) return [c fail:@"unsupported" message:@"webview.setAudioMuted: not in this WebKit"];
    // WKMediaMutedState: 1 = audio muted (capture devices untouched).
    ((void (*)(id, SEL, NSUInteger))objc_msgSend)(wv, sel, [c boolean:@"muted" or:YES] ? 1 : 0);
    [c ok:nil];
  });
  reg(@"pauseMedia", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    [wv pauseAllMediaPlaybackWithCompletionHandler:^{ [c ok:nil]; }];
  });
  reg(@"getMediaState", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    SEL muted = NSSelectorFromString(@"_mediaMutedState"), audible = NSSelectorFromString(@"_isPlayingAudio");
    BOOL isMuted = [wv respondsToSelector:muted] && (((NSUInteger (*)(id, SEL))objc_msgSend)(wv, muted) & 1);
    BOOL isAudible = [wv respondsToSelector:audible] && ((BOOL (*)(id, SEL))objc_msgSend)(wv, audible);
    NSString *(^capture)(WKMediaCaptureState) = ^(WKMediaCaptureState st) { return st == WKMediaCaptureStateActive ? @"active" : st == WKMediaCaptureStateMuted ? @"muted" : @"none"; };
    NSDictionary *devices = @{@"camera" : capture(wv.cameraCaptureState), @"microphone" : capture(wv.microphoneCaptureState)};
    [wv requestMediaPlaybackStateWithCompletionHandler:^(WKMediaPlaybackState st) {
      NSString *playback = st == WKMediaPlaybackStatePlaying ? @"playing" : st == WKMediaPlaybackStatePaused ? @"paused" : st == WKMediaPlaybackStateSuspended ? @"suspended" : @"none";
      NSMutableDictionary *out = [devices mutableCopy];
      [out addEntriesFromDictionary:@{@"muted" : @(isMuted), @"audible" : @(isAudible && !isMuted), @"playback" : playback}];
      [c ok:out];
    }];
  });
  reg(@"capturePage", ^(PlatformCall *c, SDWebViewState *s, WKWebView *wv) {
    WKSnapshotConfiguration *cfg = [WKSnapshotConfiguration new];
    if ([c.args[@"rect"] isKindOfClass:NSDictionary.class]) {
      NSDictionary *r = c.args[@"rect"];
      double z = wv.pageZoom ?: 1;
      cfg.rect = NSMakeRect([r[@"x"] doubleValue] * z, [r[@"y"] doubleValue] * z, [r[@"width"] doubleValue] * z, [r[@"height"] doubleValue] * z);
    }
    if ([c has:@"width"]) cfg.snapshotWidth = @([c number:@"width" or:0]);
    NSString *format = [[c string:@"format"] isEqual:@"jpeg"] ? @"jpeg" : @"png";
    double quality = [c number:@"quality" or:0.85];
    [wv takeSnapshotWithConfiguration:cfg completionHandler:^(NSImage *image, NSError *error) {
      CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
      if (!cg) return [c fail:@"internal" message:[@"webview.capturePage: " stringByAppendingString:error.localizedDescription ?: @"no image"]];
      NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:cg];
      NSData *data = [format isEqual:@"jpeg"]
                         ? [rep representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor : @(quality)}]
                         : [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      [c ok:@{@"data" : [data base64EncodedStringWithOptions:0], @"format" : format, @"width" : @(rep.pixelsWide),
              @"height" : @(rep.pixelsHigh)}];
    }];
  });

  // -- open files
  PlatformHandler opened = ^(PlatformCall *c) {
    NSArray *out = [g_opened_files copy] ?: @[];
    [g_opened_files removeAllObjects];
    [c ok:@{@"paths" : out}];
  };
  platform_register(@"app", @"getOpenedFiles", opened);
  platform_register(@"webview", @"getOpenedFiles", opened);

  // -- internal test hooks (no synthetic events / Accessibility needed)
  platform_register(@"webview", @"_test", ^(PlatformCall *c) {
    NSString *action = [c string:@"action"];
    if ([action isEqual:@"openFiles"]) {
      // Through the real app-delegate method, so the core's file/scheme split runs too.
      NSMutableArray *urls = [NSMutableArray array];
      for (id p in [c.args[@"paths"] isKindOfClass:NSArray.class] ? c.args[@"paths"] : @[]) [urls addObject:[NSURL fileURLWithPath:p]];
      for (id u in [c.args[@"urls"] isKindOfClass:NSArray.class] ? c.args[@"urls"] : @[])
        if (NSURL *url = [NSURL URLWithString:u]) [urls addObject:url];
      id<NSApplicationDelegate> del = NSApp.delegate;
      if (![del respondsToSelector:@selector(application:openURLs:)]) return [c fail:@"unavailable" message:@"no openURLs hook"];
      [del application:NSApp openURLs:urls];
      return [c ok:@{@"pageReady" : @(g_page_ready)}];
    }
    if ([action isEqual:@"resetPageReady"]) {
      g_page_ready = [c boolean:@"value" or:NO];
      return [c ok:nil];
    }
    SDWebViewState *s = resolve(c);
    if (!s) return;
    if ([action isEqual:@"fileDrop"]) {
      NSArray *paths = [c.args[@"paths"] isKindOfClass:NSArray.class] ? c.args[@"paths"] : @[];
      NSPoint pt = NSMakePoint([c number:@"x" or:0], [c number:@"y" or:0]);
      if (!s.fileDrop) return [c ok:@{@"emitted" : @NO}];
      file_drag(s, @"enter", paths, pt);
      if ([c boolean:@"leave" or:NO]) file_drag(s, @"leave", nil, pt);
      else file_drag(s, @"drop", paths, pt);
      return [c ok:@{@"emitted" : @YES}];
    }
    if ([action isEqual:@"contextMenu"]) {
      // Run the menu policy on a WebKit-like menu built from item identifiers.
      NSMenu *menu = [NSMenu new];
      for (NSString *ident in [c.args[@"identifiers"] isKindOfClass:NSArray.class] ? c.args[@"identifiers"] : @[]) {
        NSMenuItem *item = [ident isEqual:@"-"] ? NSMenuItem.separatorItem : [[NSMenuItem alloc] initWithTitle:ident action:nil keyEquivalent:@""];
        if (![ident isEqual:@"-"]) item.identifier = [@"WKMenuItemIdentifier" stringByAppendingString:ident];
        [menu addItem:item];
      }
      apply_context_menu(s, menu);
      NSMutableArray *out = [NSMutableArray array];
      for (NSMenuItem *item in menu.itemArray)
        [out addObject:item.isSeparatorItem ? @"-" : [item.identifier hasPrefix:@"WKMenuItemIdentifier"] ? [item.identifier substringFromIndex:20] : item.title];
      return [c ok:out];
    }
    if ([action isEqual:@"realDrop"]) {
      WKWebView *v = s.webview;
      SDFakeDrag *drag = [SDFakeDrag new];
      drag.window = v.window;
      drag.pasteboard = [NSPasteboard pasteboardWithUniqueName];
      NSMutableArray *urls = [NSMutableArray array];
      for (id p in [c.args[@"paths"] isKindOfClass:NSArray.class] ? c.args[@"paths"] : @[]) [urls addObject:[NSURL fileURLWithPath:p]];
      [drag.pasteboard clearContents];
      [drag.pasteboard writeObjects:urls];
      double x = [c number:@"x" or:20], y = [c number:@"y" or:20];
      drag.location = [v convertPoint:NSMakePoint(x, v.isFlipped ? y : NSHeight(v.bounds) - y) toView:nil];
      NSDragOperation op = [v draggingEntered:drag];
      [v draggingUpdated:drag];
      BOOL performed = NO;
      if ([c boolean:@"leave" or:NO]) [v draggingExited:drag];
      else if ([v prepareForDragOperation:drag]) {
        performed = [v performDragOperation:drag];
        [v concludeDragOperation:drag];
      }
      [drag.pasteboard releaseGlobally];
      return [c ok:@{@"operation" : @(op), @"performed" : @(performed)}];
    }
    if ([action isEqual:@"rightClick"]) {
      // In-process synthetic right-click (no Accessibility): WebKit builds its
      // real menu, our willOpenMenu: policy runs, tracking is cancelled at once.
      WKWebView *v = s.webview;
      NSWindow *win = v.window;
      s.dismissMenus = YES;
      s.lastMenu = nil;
      NSPoint p = [v convertPoint:NSMakePoint([c number:@"x" or:20], v.isFlipped ? [c number:@"y" or:20] : NSHeight(v.bounds) - [c number:@"y" or:20]) toView:nil];
      for (NSEventType type : {NSEventTypeRightMouseDown, NSEventTypeRightMouseUp}) {
        NSEvent *e = [NSEvent mouseEventWithType:type location:p modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
                                    windowNumber:win.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
        [win sendEvent:e];
      }
      SDWebViewState *__weak weak = s;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        SDWebViewState *st = weak;
        st.dismissMenus = NO;
        [c ok:st.lastMenu ?: NSNull.null];
      });
      return;
    }
    if ([action isEqual:@"endSheet"]) {
      NSWindow *win = s.webview.window;
      NSWindow *sheet = win.attachedSheet;
      if (sheet) [win endSheet:sheet returnCode:NSModalResponseCancel];
      return [c ok:@{@"ended" : @(sheet != nil)}];
    }
    if ([action isEqual:@"hasSheet"]) return [c ok:@(s.webview.window.attachedSheet != nil)];
    if ([action isEqual:@"uiDelegate"]) return [c ok:NSStringFromClass([s.webview.UIDelegate class]) ?: NSNull.null];
    [c fail:@"invalid_args" message:@"webview._test: unknown action"];
  });
}
