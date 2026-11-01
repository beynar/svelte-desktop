// app.* — identity, paths, lifecycle, Dock, login item, single instance, About.
// Events: willQuit, willRestart (here); reopened, openUrls, appActivated,
// appDeactivated (platform_core.mm); secondInstance (single-instance lock).
#import <ServiceManagement/ServiceManagement.h>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>

#include "platform_internal.h"
#include "shell.h"

static NSString *g_name_override = nil;
static NSString *g_identifier_override = nil;

static BOOL bundled(void) { return [NSBundle.mainBundle.bundlePath hasSuffix:@".app"]; }
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

void platform_register_app(void) {
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
    platform_emit(@"willQuit", @{});
    [c ok:nil];
    shell_quit();
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
  platform_register(@"app", @"bounceDock", ^(PlatformCall *c) {
    BOOL critical = [[c string:@"type"] isEqual:@"critical"];
    [NSApp requestUserAttention:critical ? NSCriticalRequest : NSInformationalRequest];
    [c ok:@YES];
  });
  platform_register(@"app", @"setLoginItem", ^(PlatformCall *c) {
    if (@available(macOS 13.0, *)) {
      if (!bundled()) return [c fail:@"unavailable" message:@"app.setLoginItem needs the app to run from its .app bundle"];
      SMAppService *svc = SMAppService.mainAppService;
      NSError *err = nil;
      BOOL want = [c boolean:@"enabled" or:YES];
      BOOL ok = want ? [svc registerAndReturnError:&err] : [svc unregisterAndReturnError:&err];
      if (!ok && err) return [c fail:@"denied" message:err.localizedDescription];
      [c ok:@{@"enabled" : @(svc.status == SMAppServiceStatusEnabled)}];
    } else {
      [c fail:@"unsupported" message:@"app.setLoginItem needs macOS 13"];
    }
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
  platform_register(@"app", @"requestSingleInstanceLock", ^(PlatformCall *c) { request_single_instance(c); });
  platform_register(@"app", @"setDockProgress", ^(PlatformCall *c) {
    NSString *status = [c string:@"status"] ?: @"normal";
    NSDockTile *tile = NSApp.dockTile;
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
  // The Dock icon (dev mode: the app's icon instead of bun's); null restores the bundle's.
  platform_register_many(@"app", @[ @"setDockIcon", @"setIcon" ], ^(PlatformCall *c) {
    id icon = c.args[@"icon"];
    if (!icon || icon == NSNull.null) {
      NSApp.applicationIconImage = nil;
      return [c ok:nil];
    }
    NSString *error = nil;
    NSImage *img = platform_icon(icon, @"app.setDockIcon", &error);
    if (!img) return [c fail:@"invalid_args" message:error];
    NSApp.applicationIconImage = img;
    [c ok:nil];
  });
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
