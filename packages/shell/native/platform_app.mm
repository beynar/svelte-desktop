// app.* — identity, paths, lifecycle, Dock, login item, single instance, About.
// Events: willQuit, willRestart (here); reopened, openUrls, appActivated,
// appDeactivated (platform_core.mm); secondInstance (single-instance lock).
#import <ServiceManagement/ServiceManagement.h>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>

#include "platform_internal.h"
#include "platform_app_windows.h"
#include "shell.h"
#import <Carbon/Carbon.h>
#import <objc/runtime.h>

// AppKit owns termination. Every source enters terminate:, and only this owner
// replies. Snapshot participants per phase so late registrations cannot hang it.
static NSMutableDictionary<NSString *, NSDictionary *> *g_quit_handlers;
static NSMutableDictionary<NSString *, NSNumber *> *g_quit_pending;
static NSUInteger g_quit_id = 0, g_quit_stage = 0;
static BOOL g_quit_active = NO, g_quit_scheduled = NO, g_quit_cancelled = NO, g_quit_in_native_call = NO;
static NSString *g_quit_reason, *g_next_quit_reason;
static NSArray<NSString *> *quit_phases() { return @[ @"quitRequested", @"beforeQuit", @"willQuit" ]; }
static void quit_phase(void);

static void on_app_run_loop(dispatch_block_t block) {
  CFRunLoopPerformBlock(CFRunLoopGetMain(), (__bridge CFArrayRef)@[ NSDefaultRunLoopMode, NSModalPanelRunLoopMode, NSEventTrackingRunLoopMode ], block);
  CFRunLoopWakeUp(CFRunLoopGetMain());
}

static NSString *termination_reason() {
  NSAppleEventDescriptor *event = NSAppleEventManager.sharedAppleEventManager.currentAppleEvent;
  DescType reason = [[event paramDescriptorForKeyword:kAEQuitReason] typeCodeValue];
  if (reason == kAEShutDown || reason == kAERestart) return @"shutdown";
  if (reason == kAEReallyLogOut || reason == kAELogOut) return @"logout";
  return event.eventID == kAEQuitApplication ? @"system" : @"menu";
}

static void quit_finish(BOOL allow) {
  g_quit_pending = nil;
  if (allow) g_quit_active = NO;
  else g_quit_cancelled = YES;
  [NSApp replyToApplicationShouldTerminate:allow];
  // A reply from a dispatch source must also release AppKit's nextEvent wait,
  // so the outer terminate: call can finish before publishing cancellation.
  NSEvent *wake = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0
                                  timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
  [NSApp postEvent:wake atStart:YES];
}

static void quit_advance() {
  if (!g_quit_active || !g_quit_pending || g_quit_pending.count) return;
  if (++g_quit_stage == quit_phases().count) quit_finish(YES);
  else quit_phase();
}

static void quit_phase() {
  NSString *phase = quit_phases()[g_quit_stage];
  g_quit_pending = [NSMutableDictionary dictionary];
  for (NSString *token in g_quit_handlers) {
    NSDictionary *h = g_quit_handlers[token];
    if ([h[@"phase"] isEqual:phase]) g_quit_pending[token] = h[@"owner"];
  }
  platform_emit(phase, @{@"requestId":@(g_quit_id), @"reason":g_quit_reason,
                         @"deadline":@((NSDate.date.timeIntervalSince1970 + 10) * 1000),
                         @"tokens":g_quit_pending.allKeys});
  NSUInteger request = g_quit_id, stage = g_quit_stage;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    if (!g_quit_active || g_quit_id != request || g_quit_stage != stage) return;
    platform_emit(@"quitTimedOut", @{@"requestId":@(request), @"phase":phase, @"reason":g_quit_reason});
    [g_quit_pending removeAllObjects];
    quit_advance();
  });
  // Let the initiating platform call's result and AppKit's NSTerminateLater land first.
  dispatch_async(dispatch_get_main_queue(), ^{
    if (g_quit_active && g_quit_id == request && g_quit_stage == stage) quit_advance();
  });
}

void platform_app_request_quit(NSString *reason) {
  if (g_quit_active || g_quit_scheduled || g_quit_in_native_call) return;
  g_next_quit_reason = reason;
  [NSApp terminate:nil];
}

void platform_app_page_unloaded(int nativeId) {
  if (!nativeId) return;
  BOOL voting = NO;
  for (NSString *token in g_quit_handlers.allKeys) {
    if ([g_quit_handlers[token][@"owner"] intValue] != nativeId) continue;
    voting |= g_quit_pending[token] != nil;
    [g_quit_handlers removeObjectForKey:token];
    [g_quit_pending removeObjectForKey:token];
  }
  // A disappearing document cannot consent to losing its unsaved work.
  if (g_quit_active && voting && g_quit_stage == 0) quit_finish(NO);
  else if (g_quit_active) quit_advance();
}

void platform_app_install_quit_hook() {
  g_quit_handlers = [NSMutableDictionary dictionary];
  // All terminate: callers (including menu actions and Apple events) share the
  // same outer call. AppKit must unwind it before another attempt may begin.
  Class appClass = NSApp.class;
  SEL terminate = @selector(terminate:);
  Method method = class_getInstanceMethod(appClass, terminate);
  IMP original = method_getImplementation(method);
  class_replaceMethod(appClass, terminate, imp_implementationWithBlock(^(id app, id sender) {
    if (g_quit_active || g_quit_scheduled || g_quit_in_native_call) return;
    g_quit_scheduled = YES;
    if (!g_next_quit_reason) g_next_quit_reason = termination_reason();
    // NSTerminateLater pumps a nested loop; never start it inside GCD.
    on_app_run_loop(^{
      g_quit_scheduled = NO;
      g_quit_in_native_call = YES;
      // AppKit refuses terminate: before consulting its delegate while a sheet
      // is attached. Withdraw our sheets without destroying their pages.
      platform_window_suspend_sheets_for_quit(^(NSArray<NSWindow *> *sheets) {
        on_app_run_loop(^{
          ((void (*)(id, SEL, id))original)(app, terminate, sender);
          g_quit_in_native_call = NO;
          platform_window_restore_sheets_after_quit(sheets);
          if (g_quit_cancelled) {
            g_quit_cancelled = NO;
            g_quit_active = NO;
            platform_emit(@"quitCancelled", @{@"requestId":@(g_quit_id), @"reason":g_quit_reason});
          }
        });
      });
    });
  }), method_getTypeEncoding(method));
  Class cls = [NSApp.delegate class];
  class_addMethod(cls, @selector(applicationShouldTerminate:), imp_implementationWithBlock(^NSUInteger(id, NSApplication *) {
    if (g_quit_active) return NSTerminateLater;
    g_quit_active = YES;
    g_quit_stage = 0;
    ++g_quit_id;
    g_quit_reason = g_next_quit_reason ?: termination_reason();
    g_next_quit_reason = nil;
    dispatch_async(dispatch_get_main_queue(), ^{ if (g_quit_active) quit_phase(); });
    return NSTerminateLater;
  }), "Q@:@");
}

static void register_quit_handlers() {
  platform_register(@"app", @"subscribeQuit", ^(PlatformCall *c) {
    NSString *token = [c string:@"token"], *phase = [c string:@"phase"];
    if (!token.length || token.length > 128 || ![quit_phases() containsObject:phase])
      return [c fail:@"invalid_args" message:@"app.subscribeQuit: token and lifecycle phase required"];
    if (g_quit_handlers[token] && [g_quit_handlers[token][@"owner"] intValue] != c.callerWindow)
      return [c fail:@"denied" message:@"quit handler belongs to another context"];
    g_quit_handlers[token] = @{@"phase":phase, @"owner":@(c.callerWindow)};
    [c ok:nil];
  });
  platform_register(@"app", @"unsubscribeQuit", ^(PlatformCall *c) {
    NSString *token = [c string:@"token"];
    if (!token.length) return [c fail:@"invalid_args" message:@"app.unsubscribeQuit: token required"];
    if (g_quit_handlers[token] && [g_quit_handlers[token][@"owner"] intValue] != c.callerWindow)
      return [c fail:@"denied" message:@"quit handler belongs to another context"];
    [g_quit_handlers removeObjectForKey:token];
    [g_quit_pending removeObjectForKey:token];
    [c ok:nil];
    if (g_quit_active) quit_advance();
  });
  platform_register(@"app", @"replyQuit", ^(PlatformCall *c) {
    NSString *token = [c string:@"token"], *decision = [c string:@"decision"];
    if (!token.length || ![@[ @"quit", @"cancel" ] containsObject:decision])
      return [c fail:@"invalid_args" message:@"app.replyQuit: token and quit|cancel decision required"];
    if (!g_quit_active || [c number:@"requestId" or:-1] != g_quit_id || ![[c string:@"phase"] isEqual:quit_phases()[g_quit_stage]] || !g_quit_pending[token])
      return [c ok:nil]; // late/duplicate reply, including a completed timeout
    if ([g_quit_pending[token] intValue] != c.callerWindow)
      return [c fail:@"denied" message:@"quit reply belongs to another context"];
    [g_quit_pending removeObjectForKey:token];
    [c ok:nil];
    if (g_quit_stage == 0 && [decision isEqual:@"cancel"]) quit_finish(NO);
    else quit_advance();
  });
}

static NSString *g_name_override = nil;
static NSString *g_identifier_override = nil;

static BOOL bundled(void) { return [NSBundle.mainBundle.bundlePath hasSuffix:@".app"]; }

// Launched by the login item: the launch's Apple event says so, while AppKit finishes launching.
static BOOL g_launched_at_login = NO;

// What the app set, for the getters: the Dock has no way to read these back.
static NSDictionary *g_dock_progress;
static id g_dock_icon;

void platform_app_observe_launch(void) {
  static id observer;
  if (observer) return;
  observer = [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidFinishLaunchingNotification object:nil queue:nil usingBlock:^(NSNotification *) {
    NSAppleEventDescriptor *event = NSAppleEventManager.sharedAppleEventManager.currentAppleEvent;
    g_launched_at_login = event.eventID == kAEOpenApplication && [event paramDescriptorForKeyword:keyAEPropData].enumCodeValue == keyAELaunchedAsLogInItem;
  }];
}

// Not available (`vite dev`, macOS 12) is a state, not an error: settings pages work the same in dev.
static NSDictionary *login_item(void) {
  BOOL available = NO, enabled = NO, approval = NO;
  if (@available(macOS 13.0, *)) {
    if (bundled()) {
      SMAppServiceStatus status = SMAppService.mainAppService.status;
      available = YES;
      enabled = status == SMAppServiceStatusEnabled;
      approval = status == SMAppServiceStatusRequiresApproval;
    }
  }
  return @{@"available" : @(available), @"enabled" : @(enabled), @"requiresApproval" : @(approval), @"launchedAtLogin" : @(g_launched_at_login)};
}
static NSString *app_name(void) { return g_name_override ?: platform_app_name(); }
static NSString *app_identifier(void) { return g_identifier_override ?: platform_app_identifier(); }
static NSString *exe_path(void) { return NSBundle.mainBundle.executablePath ?: NSProcessInfo.processInfo.arguments.firstObject; }

static NSString *user_dir(NSSearchPathDirectory d) {
  return NSSearchPathForDirectoriesInDomains(d, NSUserDomainMask, YES).firstObject;
}

static NSString *get_path(NSString *name) {
  NSString *home = NSHomeDirectory();
  NSString *support = user_dir(NSApplicationSupportDirectory);
  // userData/caches/logs scope to the identifier so a renamed app cannot
  // scribble over another app's directory (same rule as the GPUI build).
  NSDictionary<NSString *, NSString *> *paths = @{
    @"home" : home,
    @"appPath" : bundled() ? NSBundle.mainBundle.bundlePath : exe_path().stringByDeletingLastPathComponent,
    @"exe" : exe_path(),
    @"module" : exe_path(),
    @"temp" : NSTemporaryDirectory(),
    @"appData" : support,
    @"userData" : [support stringByAppendingPathComponent:app_identifier()],
    @"logs" : [[home stringByAppendingPathComponent:@"Library/Logs"] stringByAppendingPathComponent:app_identifier()],
    @"caches" : [user_dir(NSCachesDirectory) stringByAppendingPathComponent:app_identifier()],
    @"documents" : user_dir(NSDocumentDirectory),
    @"downloads" : user_dir(NSDownloadsDirectory),
    @"desktop" : user_dir(NSDesktopDirectory),
    @"music" : user_dir(NSMusicDirectory),
    @"pictures" : user_dir(NSPicturesDirectory),
    @"videos" : user_dir(NSMoviesDirectory),
  };
  return paths[name];
}

// ---------------------------------------------------------------------------
// Dock progress: an image view of the app icon with a bar drawn over it.

@interface SDDockProgressView : NSView
@property(nonatomic) double fraction; // <0 = indeterminate
@property(nonatomic, copy) NSString *status;
@end
@implementation SDDockProgressView
- (void)drawRect:(NSRect)dirty {
  [NSApp.applicationIconImage drawInRect:self.bounds];
  NSRect bar = NSInsetRect(NSMakeRect(0, 0, self.bounds.size.width, self.bounds.size.height * 0.16), self.bounds.size.width * 0.1, 0);
  bar.origin.y = self.bounds.size.height * 0.08;
  [[NSColor colorWithWhite:0 alpha:0.55] setFill];
  [[NSBezierPath bezierPathWithRoundedRect:bar xRadius:bar.size.height / 2 yRadius:bar.size.height / 2] fill];
  NSColor *fill = [self.status isEqual:@"error"]    ? NSColor.systemRedColor
                  : [self.status isEqual:@"paused"] ? NSColor.systemYellowColor
                                                    : NSColor.controlAccentColor;
  [fill setFill];
  NSRect inner = NSInsetRect(bar, 2, 2);
  inner.size.width *= self.fraction < 0 ? 1.0 : MAX(0, MIN(1, self.fraction));
  [[NSBezierPath bezierPathWithRoundedRect:inner xRadius:inner.size.height / 2 yRadius:inner.size.height / 2] fill];
}
@end

// ---------------------------------------------------------------------------
// Single instance: flock on a file under the caches dir (works unbundled too);
// later instances post a distributed notification the holder turns into
// `secondInstance`.

static int g_lock_fd = -1;

static void request_single_instance(PlatformCall *call) {
  if (g_lock_fd >= 0) return [call ok:@{@"acquired" : @YES}];
  NSString *dir = get_path(@"caches");
  [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *path = [dir stringByAppendingPathComponent:@"instance.lock"];
  int fd = open(path.fileSystemRepresentation, O_RDWR | O_CREAT, 0600);
  if (fd < 0) return [call fail:@"internal" message:[NSString stringWithFormat:@"cannot open %@", path]];
  NSString *channel = [app_identifier() stringByAppendingString:@".secondInstance"];
  if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
    g_lock_fd = fd;
    [NSDistributedNotificationCenter.defaultCenter addObserverForName:channel object:nil queue:nil
        usingBlock:^(NSNotification *n) {
          platform_emit(@"secondInstance", @{@"argv" : n.userInfo[@"argv"] ?: @[], @"cwd" : n.userInfo[@"cwd"] ?: @""});
        }];
    return [call ok:@{@"acquired" : @YES}];
  }
  close(fd);
  [NSDistributedNotificationCenter.defaultCenter
      postNotificationName:channel object:nil
                  userInfo:@{@"argv" : NSProcessInfo.processInfo.arguments, @"cwd" : NSFileManager.defaultManager.currentDirectoryPath}
        deliverImmediately:YES];
  [call ok:@{@"acquired" : @NO}];
}

// ---------------------------------------------------------------------------

static NSImage *g_default_dock_icon;
void platform_set_default_dock_icon(NSImage *image) { g_default_dock_icon = image; }

void platform_register_app(void) {
  register_quit_handlers();
  platform_register(@"app", @"whenReady", ^(PlatformCall *c) { [c ok:@YES]; });
  platform_register(@"app", @"getInfo", ^(PlatformCall *c) {
    [c ok:@{
      @"name" : app_name(),
      @"version" : platform_app_version(),
      @"identifier" : app_identifier(),
      @"appPath" : bundled() ? NSBundle.mainBundle.bundlePath : (id)NSNull.null,
      @"packaged" : @(bundled()),
      @"platform" : @"darwin",
#if defined(__arm64__)
      @"arch" : @"arm64",
#else
      @"arch" : @"x64",
#endif
    }];
  });
  platform_register(@"app", @"getName", ^(PlatformCall *c) { [c ok:app_name()]; });
  platform_register(@"app", @"getVersion", ^(PlatformCall *c) { [c ok:platform_app_version()]; });
  platform_register(@"app", @"getPath", ^(PlatformCall *c) {
    NSString *name = [c string:@"name"];
    NSString *p = name ? get_path(name) : nil;
    if (!p) return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"app.getPath: unknown name `%@`", name]];
    [c ok:p];
  });
  platform_register(@"app", @"setName", ^(PlatformCall *c) {
    NSString *name = [c string:@"name"];
    if (!name.length) return [c fail:@"invalid_args" message:@"app.setName: `name` is required"];
    g_name_override = name;
    [c ok:nil];
  });
  platform_register(@"app", @"setIdentity", ^(PlatformCall *c) {
    NSString *identifier = [c string:@"identifier"];
    if (!identifier.length) return [c fail:@"invalid_args" message:@"app.setIdentity: `identifier` is required"];
    g_identifier_override = identifier;
    if (NSString *name = [c string:@"name"]) g_name_override = name;
    [c ok:nil];
  });
  platform_register(@"app", @"quit", ^(PlatformCall *c) {
    [c ok:nil];
    platform_app_request_quit(@"api");
  });
  platform_register(@"app", @"relaunch", ^(PlatformCall *c) {
    platform_emit(@"willRestart", @{});
    // A detached shell waits for this pid to exit, then starts a fresh copy.
    NSString *target = bundled() ? NSBundle.mainBundle.bundlePath : exe_path();
    NSString *cmd = bundled() ? [NSString stringWithFormat:@"while kill -0 %d 2>/dev/null; do sleep 0.1; done; open -n \"$0\"", getpid()]
                              : [NSString stringWithFormat:@"while kill -0 %d 2>/dev/null; do sleep 0.1; done; \"$0\" &", getpid()];
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:@"/bin/sh"];
    task.arguments = @[ @"-c", cmd, target ];
    NSError *err = nil;
    if (![task launchAndReturnError:&err]) return [c fail:@"internal" message:err.localizedDescription];
    [c ok:nil];
    shell_quit();
  });
  platform_register(@"app", @"exit", ^(PlatformCall *c) { exit((int)[c number:@"code" or:0]); });
  platform_register(@"app", @"hide", ^(PlatformCall *c) {
    [NSApp hide:nil];
    [c ok:nil];
  });
  platform_register_many(@"app", @[ @"show", @"activate" ], ^(PlatformCall *c) {
    [NSApp unhide:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [c ok:nil];
  });
  platform_register(@"app", @"hideOthers", ^(PlatformCall *c) {
    [NSApp hideOtherApplications:nil];
    [c ok:nil];
  });
  platform_register(@"app", @"showAll", ^(PlatformCall *c) {
    [NSApp unhideAllApplications:nil];
    [c ok:nil];
  });
  platform_register(@"app", @"addRecentDocument", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"];
    if (!path.length) return [c fail:@"invalid_args" message:@"app.addRecentDocument: `path` is required"];
    [NSDocumentController.sharedDocumentController noteNewRecentDocumentURL:[NSURL fileURLWithPath:path]];
    [c ok:nil];
  });
  platform_register(@"app", @"clearRecentDocuments", ^(PlatformCall *c) {
    [NSDocumentController.sharedDocumentController clearRecentDocuments:nil];
    [c ok:nil];
  });
  platform_register(@"app", @"setDockBadge", ^(PlatformCall *c) {
    NSString *text = [c string:@"text"];
    NSApp.dockTile.badgeLabel = text.length ? text : nil;
    [c ok:@YES];
  });
  platform_register(@"app", @"getDockBadge", ^(PlatformCall *c) { [c ok:NSApp.dockTile.badgeLabel]; });
  platform_register(@"app", @"bounceDock", ^(PlatformCall *c) {
    BOOL critical = [[c string:@"type"] isEqual:@"critical"];
    [NSApp requestUserAttention:critical ? NSCriticalRequest : NSInformationalRequest];
    [c ok:@YES];
  });
  // SMAppService asks a system daemon: about 400 ms, so never on the main thread.
  platform_register(@"app", @"getLoginItem", ^(PlatformCall *c) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSDictionary *state = login_item();
      dispatch_async(dispatch_get_main_queue(), ^{ [c ok:state]; });
    });
  });
  platform_register(@"app", @"setLoginItem", ^(PlatformCall *c) {
    BOOL want = [c boolean:@"enabled" or:YES];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *failure = nil;
      if (@available(macOS 13.0, *)) {
        if (bundled()) {
          SMAppService *svc = SMAppService.mainAppService;
          BOOL needed = want ? svc.status != SMAppServiceStatusEnabled : svc.status != SMAppServiceStatusNotRegistered;
          NSError *err = nil;
          BOOL ok = !needed || (want ? [svc registerAndReturnError:&err] : [svc unregisterAndReturnError:&err]);
          // Turned off by the user in System Settings: only they can turn it on again (requiresApproval).
          if (!ok && svc.status != SMAppServiceStatusRequiresApproval) failure = err.localizedDescription ?: @"app.setLoginItem failed";
        }
      }
      NSDictionary *state = failure ? nil : login_item();
      dispatch_async(dispatch_get_main_queue(), ^{
        if (failure) [c fail:@"denied" message:failure];
        else [c ok:state];
      });
    });
  });
  platform_register(@"app", @"setActivationPolicy", ^(PlatformCall *c) {
    NSString *p = [c string:@"policy"];
    NSApplicationActivationPolicy policy = [p isEqual:@"accessory"]    ? NSApplicationActivationPolicyAccessory
                                           : [p isEqual:@"prohibited"] ? NSApplicationActivationPolicyProhibited
                                           : [p isEqual:@"regular"]    ? NSApplicationActivationPolicyRegular
                                                                       : (NSApplicationActivationPolicy)-1;
    if ((NSInteger)policy == -1) return [c fail:@"invalid_args" message:@"app.setActivationPolicy: policy must be regular|accessory|prohibited"];
    [c ok:@([NSApp setActivationPolicy:policy])];
  });
  platform_register(@"app", @"getActivationPolicy", ^(PlatformCall *c) {
    NSApplicationActivationPolicy policy = NSApp.activationPolicy;
    [c ok:policy == NSApplicationActivationPolicyAccessory ? @"accessory" : policy == NSApplicationActivationPolicyProhibited ? @"prohibited" : @"regular"];
  });
  platform_register(@"app", @"requestSingleInstanceLock", ^(PlatformCall *c) { request_single_instance(c); });
  platform_register(@"app", @"setDockProgress", ^(PlatformCall *c) {
    NSString *status = [c string:@"status"] ?: @"normal";
    NSDockTile *tile = NSApp.dockTile;
    g_dock_progress = [status isEqual:@"none"] ? nil : @{@"status" : status, @"completed" : @([c number:@"completed" or:0]), @"total" : @([c number:@"total" or:1])};
    if ([status isEqual:@"none"]) {
      tile.contentView = nil;
      [tile display];
      return [c ok:nil];
    }
    SDDockProgressView *view = [tile.contentView isKindOfClass:SDDockProgressView.class] ? (SDDockProgressView *)tile.contentView : nil;
    if (!view) {
      view = [[SDDockProgressView alloc] initWithFrame:NSMakeRect(0, 0, tile.size.width, tile.size.height)];
      tile.contentView = view;
    }
    double total = [c number:@"total" or:1], done = [c number:@"completed" or:0];
    view.status = status;
    view.fraction = [status isEqual:@"indeterminate"] ? -1 : (total > 0 ? done / total : 0);
    [view setNeedsDisplay:YES];
    [tile display];
    [c ok:nil];
  });
  platform_register(@"app", @"getDockProgress", ^(PlatformCall *c) { [c ok:g_dock_progress ?: @{@"status" : @"none"}]; });
  // The Dock icon (dev mode: the app's icon instead of bun's); null restores the app's own.
  platform_register_many(@"app", @[ @"setDockIcon", @"setIcon" ], ^(PlatformCall *c) {
    id icon = c.args[@"icon"];
    if (!icon || icon == NSNull.null) {
      NSApp.applicationIconImage = g_default_dock_icon; // nil: the bundle's
      g_dock_icon = nil;
      return [c ok:nil];
    }
    NSString *error = nil;
    NSImage *img = platform_icon(icon, @"app.setDockIcon", &error);
    if (!img) return [c fail:@"invalid_args" message:error];
    NSApp.applicationIconImage = img;
    g_dock_icon = icon;
    [c ok:nil];
  });
  platform_register(@"app", @"getDockIcon", ^(PlatformCall *c) { [c ok:g_dock_icon]; });
  platform_register(@"app", @"getBundleType", ^(PlatformCall *c) { [c ok:@{@"type" : bundled() ? @"app" : @"binary"}]; });
  platform_register(@"app", @"defaultWindowIcon", ^(PlatformCall *c) {
    if (!bundled()) return [c ok:nil];
    NSImage *icon = NSApp.applicationIconImage;
    CGImageRef cg = [icon CGImageForProposedRect:NULL context:nil hints:nil];
    if (!cg) return [c ok:nil];
    NSData *png = [[[NSBitmapImageRep alloc] initWithCGImage:cg] representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [c ok:@{@"pngBase64" : [png base64EncodedStringWithOptions:0]}];
  });
  platform_register(@"app", @"aboutPanel", ^(PlatformCall *c) {
    NSMutableDictionary *opts = [NSMutableDictionary dictionary];
    if (NSString *v = [c string:@"name"]) opts[NSAboutPanelOptionApplicationName] = v;
    if (NSString *v = [c string:@"version"]) opts[NSAboutPanelOptionApplicationVersion] = v;
    if (NSString *v = [c string:@"copyright"]) opts[@"Copyright"] = v;
    if (NSString *v = [c string:@"credits"]) opts[NSAboutPanelOptionCredits] = [[NSAttributedString alloc] initWithString:v];
    [NSApp activateIgnoringOtherApps:YES];
    [NSApp orderFrontStandardAboutPanelWithOptions:opts];
    [c ok:nil];
  });
}
