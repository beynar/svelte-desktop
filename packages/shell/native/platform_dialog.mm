// dialog.* — message box, open, save. Sheets on the calling window when there is
// one, app-modal otherwise; the reply arrives when the user answers.
//   sheet {route, width?, height?, style?, top?} → {result}: a route of the app in a sheet — its
//   page alone (it loads as a view: window.__desktopView, X-Desktop-View), shown once loaded;
//   `close {result?}` from that page ends it, Escape / ⌘. cancel it (result null).
//   style "sheet" (default): the system's sheet (macOS 26: centered, the window dimmed).
//   style "attached": slides down from under the title bar (or `top` px down the window's
//   content), the window left as it is but not clickable meanwhile.
//   style "window": a small dialog window with a title bar (`title`, else the page's), centered
//   on the window, which isn't clickable meanwhile; its close button cancels.
#import <QuartzCore/QuartzCore.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include "platform_internal.h"
#include "platform_files.h"

static NSWindow *parent_for(PlatformCall *c) {
  NSWindow *w = platform_window(platform_resolve_window(c));
  return w.isVisible ? w : nil;
}

static void apply_filters(NSSavePanel *panel, id filters) {
  if (![filters isKindOfClass:NSArray.class]) return;
  NSMutableArray *types = [NSMutableArray array];
  for (NSDictionary *f in filters) {
    if (![f isKindOfClass:NSDictionary.class]) continue;
    for (NSString *ext in f[@"extensions"]) {
      if ([ext isEqual:@"*"]) return; // "all files" disables filtering
      if (UTType *t = [UTType typeWithFilenameExtension:ext]) [types addObject:t];
    }
  }
  if (types.count) panel.allowedContentTypes = types;
}

static void present(NSWindow *parent, NSSavePanel *panel, void (^done)(NSModalResponse)) {
  if (parent) [panel beginSheetModalForWindow:parent completionHandler:done];
  else {
    [NSApp activateIgnoringOtherApps:YES];
    [panel beginWithCompletionHandler:done];
  }
}

static void message_box(PlatformCall *c, BOOL confirm) {
  NSAlert *alert = [NSAlert new];
  alert.messageText = [c string:@"message"] ?: [c string:@"title"] ?: @"";
  if (NSString *detail = [c string:@"detail"]) alert.informativeText = detail;
  NSString *type = [c string:@"type"];
  alert.alertStyle = ([type isEqual:@"critical"] || [type isEqual:@"error"]) ? NSAlertStyleCritical
                     : [type isEqual:@"warning"]                            ? NSAlertStyleWarning
                                                                            : NSAlertStyleInformational;
  NSArray *buttons = [c.args[@"buttons"] isKindOfClass:NSArray.class] ? c.args[@"buttons"] : (confirm ? @[ @"OK", @"Cancel" ] : @[ @"OK" ]);
  for (id b in buttons) [alert addButtonWithTitle:[b description]];
  NSInteger cancelId = (NSInteger)[c number:@"cancelId" or:(buttons.count > 1 ? (double)buttons.count - 1 : -1)];
  if (cancelId >= 0 && cancelId < (NSInteger)alert.buttons.count) alert.buttons[cancelId].keyEquivalent = @"\033";
  void (^done)(NSModalResponse) = ^(NSModalResponse r) {
    NSInteger response = r - NSAlertFirstButtonReturn;
    if (confirm) [c ok:@(response == 0)];
    else [c ok:@{@"response" : @(response), @"canceled" : @(response == cancelId)}];
  };
  NSWindow *parent = parent_for(c);
  if (parent) [alert beginSheetModalForWindow:parent completionHandler:done];
  else {
    [NSApp activateIgnoringOtherApps:YES];
    done([alert runModal]);
  }
}

// ---------------------------------------------------------------------------
// Sheets with a route of the app

@interface SDSheetWindow : NSWindow
@end
@implementation SDSheetWindow
- (BOOL)canBecomeKeyWindow { return YES; }
@end

// Over the window while an attached sheet is up: the window's clicks go to the sheet.
@interface SDSheetBlocker : NSView
@property(nonatomic, weak) NSWindow *sheet;
@end
@implementation SDSheetBlocker
- (NSView *)hitTest:(NSPoint)point { return self; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)mouseDown:(NSEvent *)event { [self.sheet makeKeyAndOrderFront:nil]; }
- (void)rightMouseDown:(NSEvent *)event { [self.sheet makeKeyAndOrderFront:nil]; }
- (void)scrollWheel:(NSEvent *)event {}
@end

@interface SDSheet : NSObject <WKNavigationDelegate, NSWindowDelegate>
@property(nonatomic) int nativeId;
@property(nonatomic) BOOL attached;
@property(nonatomic) BOOL dialogWindow;
@property(nonatomic) BOOL titled;
@property(nonatomic) double top;
@property(nonatomic, strong) SDSheetBlocker *blocker;
@property(nonatomic, strong) SDSheetWindow *window;
@property(nonatomic, strong) WKWebView *webview;
@property(nonatomic, weak) NSWindow *parent;
@property(nonatomic, strong) PlatformCall *call;
@property(nonatomic) BOOL presented;
@property(nonatomic) BOOL done;
@end

static NSMutableDictionary<NSNumber *, SDSheet *> *g_sheets;
static int g_next_sheet = 3000;

/// Room around an attached sheet's card for its shadow (sides and bottom).
static const CGFloat kSheetShadowRoom = 28;

// Where an attached sheet sits: centered, its top under the title bar (or `top` px down the
// content) — and where it slides from.
static NSRect attached_frame(SDSheet *s, NSWindow *parent, CGFloat lift) {
  NSSize size = s.window.frame.size;
  NSRect pf = parent.frame;
  NSRect content = [parent convertRectToScreen:parent.contentView.frame];
  CGFloat top = s.top >= 0 ? NSMaxY(content) - s.top : pf.origin.y + NSMaxY(parent.contentLayoutRect);
  return NSMakeRect(round(NSMidX(pf) - size.width / 2), top - size.height + lift, size.width, size.height);
}

static void present_sheet(SDSheet *s) {
  if (s.presented || s.done) return;
  s.presented = YES;
  [s.window orderOut:nil];
  s.window.ignoresMouseEvents = NO;
  NSWindow *parent = s.parent;
  if (parent && (s.attached || s.dialogWindow)) {
    // The window stays as it is, its clicks go to the sheet.
    s.blocker = [[SDSheetBlocker alloc] initWithFrame:parent.contentView.bounds];
    s.blocker.sheet = s.window;
    s.blocker.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [parent.contentView addSubview:s.blocker positioned:NSWindowAbove relativeTo:nil];
  }
  if (parent && s.dialogWindow) {
    // Centered on the window, fading in.
    NSRect pf = parent.frame, f = s.window.frame;
    [s.window setFrameOrigin:NSMakePoint(round(NSMidX(pf) - f.size.width / 2), round(NSMidY(pf) - f.size.height / 2))];
    s.window.alphaValue = 0;
    [parent addChildWindow:s.window ordered:NSWindowAbove];
    [s.window makeKeyAndOrderFront:nil];
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
      ctx.duration = 0.15;
      s.window.animator.alphaValue = 1;
    }];
  } else if (parent && s.attached) {
    // Down from under the title bar.
    [s.window setFrame:attached_frame(s, parent, 14) display:NO];
    s.window.alphaValue = 0;
    [parent addChildWindow:s.window ordered:NSWindowAbove];
    [s.window makeKeyAndOrderFront:nil];
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
      ctx.duration = 0.2;
      ctx.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.2 :0.9 :0.1 :1];
      [s.window.animator setFrame:attached_frame(s, parent, 0) display:YES];
      s.window.animator.alphaValue = 1;
    }];
  } else if (parent) {
    s.window.alphaValue = 1;
    [parent beginSheet:s.window completionHandler:nil];
  } else {
    s.window.alphaValue = 1;
    [NSApp activateIgnoringOtherApps:YES];
    [s.window center];
    [s.window makeKeyAndOrderFront:nil];
  }
  [s.window makeFirstResponder:s.webview];
  // Loaded out of sight, the page's autofocus didn't take: now it's the key window.
  [s.webview evaluateJavaScript:@"document.querySelector('[autofocus]')?.focus()" completionHandler:nil];
}

static void finish_sheet(SDSheet *s, id result) {
  if (s.done) return;
  s.done = YES;
  [s.call ok:@{@"result" : result ?: NSNull.null}];
  NSWindow *parent = s.parent;
  // Torn down after this turn: `close` comes from the sheet's own page, its web view still in
  // the middle of that call.
  void (^teardown)(void) = ^{
    [s.blocker removeFromSuperview];
    if (s.window.parentWindow) [s.window.parentWindow removeChildWindow:s.window];
    [s.window orderOut:nil];
    platform_detach_webview(s.nativeId);
    s.webview.navigationDelegate = nil;
    // AppKit may retain the last ended sheet window: release its page explicitly.
    [s.webview stopLoading];
    [s.webview removeFromSuperview];
    s.window.contentView = nil;
    s.window.delegate = nil;
    dispatch_async(dispatch_get_main_queue(), ^{ [g_sheets removeObjectForKey:@(s.nativeId)]; });
    if (parent.isVisible) [parent makeKeyAndOrderFront:nil];
  };
  if (s.presented && parent && s.window.sheetParent) {
    [parent endSheet:s.window];
    dispatch_async(dispatch_get_main_queue(), teardown);
  } else if (s.presented && parent && (s.attached || s.dialogWindow)) {
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
      ctx.duration = 0.14;
      if (s.attached) [s.window.animator setFrame:attached_frame(s, parent, 10) display:YES];
      s.window.animator.alphaValue = 0;
    } completionHandler:teardown];
  } else dispatch_async(dispatch_get_main_queue(), teardown);
}

@implementation SDSheet
// Loaded (server-rendered as the page alone): shown a frame later, painted.
- (void)webView:(WKWebView *)wv didFinishNavigation:(WKNavigation *)nav {
  if (self.dialogWindow && !self.titled) self.window.title = wv.title ?: @"";
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.03 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ present_sheet(self); });
}
- (void)webView:(WKWebView *)wv didFailProvisionalNavigation:(WKNavigation *)nav withError:(NSError *)error {
  present_sheet(self);
}
// A dialog window's close button: canceled.
- (BOOL)windowShouldClose:(NSWindow *)sender {
  finish_sheet(self, nil);
  return NO;
}
@end

static void open_sheet(PlatformCall *c) {
  NSString *route = [c string:@"route"];
  NSString *origin = platform_app_origin();
  if (!route || !origin) return [c fail:@"invalid_args" message:@"dialog.sheet: `route` is required"];
  NSURL *url = [NSURL URLWithString:[origin stringByAppendingString:[route hasPrefix:@"/"] ? route : [@"/" stringByAppendingString:route]]];
  if (!url) return [c fail:@"invalid_args" message:@"dialog.sheet: invalid route"];
  if (!g_sheets) g_sheets = [NSMutableDictionary dictionary];

  SDSheet *s = [SDSheet new];
  s.nativeId = g_next_sheet++;
  s.parent = parent_for(c);
  s.call = c;
  s.attached = [[c string:@"style"] isEqual:@"attached"];
  s.dialogWindow = [[c string:@"style"] isEqual:@"window"];
  s.top = [c has:@"top"] ? [c number:@"top" or:0] : -1;
  NSString *ident = [NSString stringWithFormat:@"sheet-%d", s.nativeId];
  NSRect frame = NSMakeRect(0, 0, [c number:@"width" or:440], [c number:@"height" or:280]);

  WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
  platform_webview_prepare_configuration(cfg);
  // The page alone, as in a kept-alive tab's view.
  NSString *mark = [NSString stringWithFormat:@"window.__desktopView=%@;", [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:ident options:NSJSONWritingFragmentsAllowed error:nil] encoding:NSUTF8StringEncoding]];
  [cfg.userContentController addUserScript:[[WKUserScript alloc] initWithSource:mark injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
  s.webview = [[WKWebView alloc] initWithFrame:frame configuration:cfg];
  s.webview.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  // Opaque: the page paints the sheet (the system's sheet material behind a light or dark page
  // reads badly); a page without a background of its own gets the light / dark canvas.
  s.webview.navigationDelegate = s;
  platform_attach_webview(s.nativeId, s.webview);
  platform_webview_configure(s.nativeId, s.webview);

  s.window = [[SDSheetWindow alloc] initWithContentRect:frame
                                              styleMask:s.attached       ? NSWindowStyleMaskBorderless
                                                        : s.dialogWindow ? NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                                                         : NSWindowStyleMaskTitled | NSWindowStyleMaskFullSizeContentView
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
  s.window.releasedWhenClosed = NO;
  if (s.dialogWindow) {
    s.window.delegate = s;
    if (NSString *title = [c string:@"title"]) s.window.title = title, s.titled = YES;
  } else {
    s.window.titlebarAppearsTransparent = YES;
    s.window.titleVisibility = NSWindowTitleHidden;
  }
  if (s.attached) {
    // A card coming out from under the title bar: square top, rounded bottom, a hairline on the
    // sides and bottom, our own soft shadow (the system's on a borderless window draws a dark
    // rim). The window is the card plus room for the shadow; its clear margins let clicks through.
    CGFloat w = frame.size.width, h = frame.size.height, m = kSheetShadowRoom, r = 10;
    s.window.opaque = NO;
    s.window.backgroundColor = NSColor.clearColor;
    s.window.hasShadow = NO;
    [s.window setContentSize:NSMakeSize(w + 2 * m, h + m)];
    NSView *root = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, w + 2 * m, h + m)];
    root.wantsLayer = YES;
    CGMutablePathRef edge = CGPathCreateMutable(); // left side, bottom (rounded), right side
    CGPathMoveToPoint(edge, NULL, 0, h);
    CGPathAddArcToPoint(edge, NULL, 0, 0, r, 0, r);
    CGPathAddArcToPoint(edge, NULL, w, 0, w, r, r);
    CGPathAddLineToPoint(edge, NULL, w, h);
    NSView *card = [[NSView alloc] initWithFrame:NSMakeRect(m, m, w, h)];
    card.wantsLayer = YES;
    card.layer.shadowColor = NSColor.blackColor.CGColor;
    card.layer.shadowOpacity = 0.16;
    card.layer.shadowRadius = 16;
    card.layer.shadowOffset = CGSizeMake(0, -6);
    CGMutablePathRef body = CGPathCreateMutableCopy(edge);
    CGPathCloseSubpath(body);
    card.layer.shadowPath = body;
    NSView *clip = [[NSView alloc] initWithFrame:card.bounds];
    clip.wantsLayer = YES;
    clip.layer.cornerRadius = r;
    clip.layer.maskedCorners = kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner;
    clip.layer.masksToBounds = YES;
    s.webview.frame = clip.bounds;
    [clip addSubview:s.webview];
    CAShapeLayer *hairline = [CAShapeLayer layer];
    hairline.path = edge;
    hairline.fillColor = nil;
    hairline.strokeColor = [[NSColor.separatorColor colorWithAlphaComponent:0.35] CGColor];
    hairline.lineWidth = 1;
    [card addSubview:clip];
    [card.layer addSublayer:hairline];
    [root addSubview:card];
    s.window.contentView = root;
    CGPathRelease(edge);
    CGPathRelease(body);
  } else s.window.contentView = s.webview;
  // Loading: on screen but invisible and click-through, so WebKit paints before it's shown.
  s.window.alphaValue = 0;
  s.window.ignoresMouseEvents = YES;
  [s.window orderBack:nil];
  g_sheets[@(s.nativeId)] = s;

  NSMutableURLRequest *r = [NSMutableURLRequest requestWithURL:url];
  [r setValue:ident forHTTPHeaderField:@"X-Desktop-View"];
  [s.webview loadRequest:r];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ present_sheet(s); });
}

static void install_sheet_escape(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *e) {
      BOOL cancel = e.keyCode == 53 || ((e.modifierFlags & NSEventModifierFlagCommand) && [e.charactersIgnoringModifiers isEqual:@"."]);
      if (!cancel) return e;
      for (SDSheet *s in g_sheets.allValues)
        if (s.presented && s.window.isKeyWindow) return finish_sheet(s, nil), (NSEvent *)nil;
      return e;
    }];
  });
}

void platform_register_dialog(void) {
  install_sheet_escape();
  platform_register(@"dialog", @"sheet", ^(PlatformCall *c) { open_sheet(c); });
  platform_register(@"dialog", @"close", ^(PlatformCall *c) {
    SDSheet *s = g_sheets[@(c.callerWindow)];
    if (!s) return [c fail:@"invalid_args" message:@"dialog.close: not called from a sheet's page"];
    id result = c.args[@"result"];
    finish_sheet(s, [result isKindOfClass:NSNull.class] ? nil : result);
    [c ok:nil];
  });
  platform_register(@"dialog", @"showMessageBox", ^(PlatformCall *c) { message_box(c, NO); });
  platform_register(@"dialog", @"showConfirm", ^(PlatformCall *c) { message_box(c, YES); });
  platform_register_files();
  platform_register(@"dialog", @"showOpenDialog", ^(PlatformCall *c) {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = [c boolean:@"files" or:YES];
    panel.canChooseDirectories = [c boolean:@"directories" or:NO];
    panel.allowsMultipleSelection = [c boolean:@"multiple" or:NO];
    if (NSString *prompt = [c string:@"prompt"]) panel.prompt = prompt;
    if (NSString *title = [c string:@"title"]) panel.message = title;
    if (NSString *dir = [c string:@"defaultPath"]) panel.directoryURL = [NSURL fileURLWithPath:dir.stringByExpandingTildeInPath];
    apply_filters(panel, c.args[@"filters"]);
    present(parent_for(c), panel, ^(NSModalResponse r) {
      NSMutableArray *paths = [NSMutableArray array];
      NSMutableArray *bookmarks = [NSMutableArray array];
      BOOL scoped = [c boolean:@"securityScoped" or:NO];
      if (r == NSModalResponseOK) {
        for (NSURL *u in panel.URLs) {
          [paths addObject:u.path];
          if (scoped) {
            NSError *error = nil;
            NSData *bookmark = platform_file_bookmark(u, &error);
            if (!bookmark) return [c fail:@"unavailable" message:error.localizedDescription ?: @"could not create bookmark"];
            [bookmarks addObject:[bookmark base64EncodedStringWithOptions:0]];
          }
        }
      }
      NSMutableDictionary *result = [@{@"canceled" : @(r != NSModalResponseOK), @"paths" : paths} mutableCopy];
      if (scoped) result[@"bookmarks"] = bookmarks;
      [c ok:result];
    });
  });
  platform_register(@"dialog", @"showSaveDialog", ^(PlatformCall *c) {
    NSSavePanel *panel = [NSSavePanel savePanel];
    NSString *def = [c string:@"defaultPath"].stringByExpandingTildeInPath;
    BOOL isDir = NO;
    if (def.length && [NSFileManager.defaultManager fileExistsAtPath:def isDirectory:&isDir] && isDir) {
      panel.directoryURL = [NSURL fileURLWithPath:def];
    } else if (def.length) {
      panel.directoryURL = [NSURL fileURLWithPath:def.stringByDeletingLastPathComponent];
      panel.nameFieldStringValue = def.lastPathComponent;
    }
    if (NSString *name = [c string:@"suggestedName"]) panel.nameFieldStringValue = name;
    apply_filters(panel, c.args[@"filters"]);
    present(parent_for(c), panel, ^(NSModalResponse r) {
      [c ok:@{@"canceled" : @(r != NSModalResponseOK), @"path" : (r == NSModalResponseOK && panel.URL) ? panel.URL.path : NSNull.null}];
    });
  });
}
