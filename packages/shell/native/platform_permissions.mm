// permissions.* — the guided flow for permissions that have no grant prompt
// (Screen Recording, Accessibility, Input Monitoring, Full Disk Access) or that the
// user denied once (camera, microphone): open the right System Settings pane and
// float a small panel next to its window with the app's icon to drag into the
// list, the reason from desktop.config, and a live status. The panel closes by
// itself once the permission is granted.
//   guide {name, reason?, open? = true} → {status, canceled}   (resolves when granted or dismissed)
//   cancelGuide → {canceled}                                    · guideState → {open, name, anchored}
// Events: permissionChanged {name, status} when the guide sees the grant.
#include "platform_internal.h"
#include "shell.h"

#import <AppKit/AppKit.h>

static NSString *const kPrivacy = @"x-apple.systempreferences:com.apple.preference.security?Privacy_";

static NSDictionary<NSString *, NSString *> *panes(void) {
  return @{
    @"screenRecording" : @"ScreenCapture",
    @"accessibility" : @"Accessibility",
    @"inputMonitoring" : @"ListenEvent",
    @"fullDiskAccess" : @"AllFiles",
    @"camera" : @"Camera",
    @"microphone" : @"Microphone",
  };
}

/// Lists that take a dragged app (the others only list apps that asked).
static BOOL accepts_drag(NSString *name) {
  return [@[ @"screenRecording", @"accessibility", @"inputMonitoring", @"fullDiskAccess" ] containsObject:name];
}

static BOOL french(void) { return [NSLocale.preferredLanguages.firstObject hasPrefix:@"fr"]; }

static NSString *label_for(NSString *name) {
  NSDictionary *en = @{@"screenRecording" : @"Screen Recording", @"accessibility" : @"Accessibility", @"inputMonitoring" : @"Input Monitoring",
                       @"fullDiskAccess" : @"Full Disk Access", @"camera" : @"Camera", @"microphone" : @"Microphone"};
  NSDictionary *fr = @{@"screenRecording" : @"Enregistrement de l'écran", @"accessibility" : @"Accessibilité",
                       @"inputMonitoring" : @"Surveillance de l'entrée", @"fullDiskAccess" : @"Accès complet au disque",
                       @"camera" : @"Caméra", @"microphone" : @"Micro"};
  return (french() ? fr : en)[name] ?: name;
}

static NSString *app_display_name(void) {
  return [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleDisplayName"] ?: [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleName"]
                                                                                  ?: NSProcessInfo.processInfo.processName;
}

/// The app bundle when packaged; the executable when run unbundled (dev).
static NSURL *app_url(void) {
  NSURL *bundle = NSBundle.mainBundle.bundleURL;
  return [bundle.pathExtension isEqual:@"app"] ? bundle : NSRunningApplication.currentApplication.executableURL;
}

// ---------------------------------------------------------------------------
// The draggable icon: a real drag source carrying the app's file URL, which the
// Privacy & Security lists accept like a drop from Finder.

@interface SDDragIcon : NSImageView <NSDraggingSource>
@end

@implementation SDDragIcon
- (void)mouseDown:(NSEvent *)event {
  NSURL *url = app_url();
  NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:url];
  [item setDraggingFrame:self.bounds contents:self.image];
  [self beginDraggingSessionWithItems:@[ item ] event:event source:self];
}
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return NSDragOperationCopy | NSDragOperationLink | NSDragOperationGeneric;
}
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)resetCursorRects { [self addCursorRect:self.bounds cursor:NSCursor.openHandCursor]; }
@end

// ---------------------------------------------------------------------------

@interface SDGuide : NSObject <NSWindowDelegate>
@property(nonatomic, copy) NSString *name;
@property(nonatomic, strong) NSPanel *panel;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, strong) PlatformCall *call;
@property(nonatomic, strong) NSTextField *status;
@property(nonatomic) BOOL anchored;
@end

static SDGuide *g_guide;

static NSTextField *text(NSString *s, CGFloat size, NSFontWeight weight, NSColor *color) {
  NSTextField *t = [NSTextField wrappingLabelWithString:s];
  t.font = [NSFont systemFontOfSize:size weight:weight];
  t.textColor = color;
  t.selectable = NO;
  t.preferredMaxLayoutWidth = 280;
  return t;
}

@implementation SDGuide

- (void)openPane {
  NSString *pane = panes()[self.name];
  if (pane) [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:[kPrivacy stringByAppendingString:pane]]];
}

- (void)buildWithReason:(NSString *)reason {
  BOOL fr = french();
  NSString *app = app_display_name(), *what = label_for(self.name);
  NSStackView *stack = [NSStackView new];
  stack.orientation = NSUserInterfaceLayoutOrientationVertical;
  stack.alignment = NSLayoutAttributeLeading;
  stack.spacing = 10;
  stack.edgeInsets = NSEdgeInsetsMake(16, 16, 16, 16);

  NSStackView *head = [NSStackView new];
  head.spacing = 12;
  head.alignment = NSLayoutAttributeCenterY;
  NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:app_url().path];
  NSImageView *iv = accepts_drag(self.name) ? [SDDragIcon imageViewWithImage:icon] : [NSImageView imageViewWithImage:icon];
  [iv.widthAnchor constraintEqualToConstant:56].active = YES;
  [iv.heightAnchor constraintEqualToConstant:56].active = YES;
  iv.toolTip = accepts_drag(self.name) ? (fr ? @"Fais-moi glisser dans la liste" : @"Drag me into the list") : nil;
  [head addArrangedSubview:iv];
  NSString *title = fr ? [NSString stringWithFormat:@"Autoriser %@ — %@", app, what] : [NSString stringWithFormat:@"Allow %@ — %@", app, what];
  [head addArrangedSubview:text(title, 14, NSFontWeightSemibold, NSColor.labelColor)];
  [stack addArrangedSubview:head];

  NSString *steps;
  if (accepts_drag(self.name))
    steps = fr ? [NSString stringWithFormat:@"1. Fais glisser l'icône de %@ dans la liste « %@ ».\n2. Active l'interrupteur à côté de %@.", app, what, app]
               : [NSString stringWithFormat:@"1. Drag %@'s icon into the %@ list.\n2. Turn on the switch next to %@.", app, what, app];
  else
    steps = fr ? [NSString stringWithFormat:@"Active l'interrupteur à côté de %@ dans « %@ ».", app, what]
               : [NSString stringWithFormat:@"Turn on the switch next to %@ in %@.", app, what];
  [stack addArrangedSubview:text(steps, 13, NSFontWeightRegular, NSColor.labelColor)];
  if (reason.length) [stack addArrangedSubview:text(reason, 12, NSFontWeightRegular, NSColor.secondaryLabelColor)];

  self.status = text(fr ? @"En attente de l'autorisation…" : @"Waiting for permission…", 12, NSFontWeightMedium, NSColor.tertiaryLabelColor);
  [stack addArrangedSubview:self.status];

  NSStackView *buttons = [NSStackView new];
  buttons.spacing = 8;
  NSButton *open = [NSButton buttonWithTitle:(fr ? @"Ouvrir les Réglages" : @"Open Settings") target:self action:@selector(openPane)];
  NSButton *cancel = [NSButton buttonWithTitle:(fr ? @"Plus tard" : @"Not now") target:self action:@selector(cancel)];
  cancel.keyEquivalent = @"\033";
  [buttons addArrangedSubview:open];
  if ([self.name isEqual:@"screenRecording"] || [self.name isEqual:@"inputMonitoring"]) {
    // macOS often applies these grants to the next launch only.
    NSButton *relaunch = [NSButton buttonWithTitle:(fr ? @"Relancer" : @"Relaunch") target:self action:@selector(relaunch)];
    relaunch.toolTip = fr ? @"macOS applique souvent cette autorisation au prochain lancement" : @"macOS often applies this grant at the next launch";
    [buttons addArrangedSubview:relaunch];
  }
  [buttons addArrangedSubview:cancel];
  [stack addArrangedSubview:buttons];

  self.panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 340, 200)
                                          styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskUtilityWindow |
                                                    NSWindowStyleMaskNonactivatingPanel | NSWindowStyleMaskFullSizeContentView
                                            backing:NSBackingStoreBuffered
                                              defer:NO];
  self.panel.titlebarAppearsTransparent = YES;
  self.panel.titleVisibility = NSWindowTitleHidden;
  self.panel.floatingPanel = YES;
  self.panel.level = NSStatusWindowLevel; // above System Settings, which takes focus
  self.panel.hidesOnDeactivate = NO;
  self.panel.becomesKeyOnlyIfNeeded = YES;
  self.panel.movableByWindowBackground = YES;
  self.panel.releasedWhenClosed = NO;
  self.panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
  self.panel.delegate = self;
  NSVisualEffectView *bg = [NSVisualEffectView new];
  bg.material = NSVisualEffectMaterialPopover;
  bg.state = NSVisualEffectStateActive;
  self.panel.contentView = bg;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [bg addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:bg.leadingAnchor], [stack.trailingAnchor constraintEqualToAnchor:bg.trailingAnchor],
    [stack.topAnchor constraintEqualToAnchor:bg.topAnchor constant:8], [stack.bottomAnchor constraintEqualToAnchor:bg.bottomAnchor],
    [bg.widthAnchor constraintEqualToConstant:340]
  ]];
  [self.panel setContentSize:bg.fittingSize];
}

/// System Settings' main window, in Cocoa coordinates (NSZeroRect if not on screen).
static NSRect settings_frame(void) {
  NSArray *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.systempreferences"];
  if (!apps.count) return NSZeroRect;
  pid_t pid = ((NSRunningApplication *)apps.firstObject).processIdentifier;
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  NSRect found = NSZeroRect;
  for (NSDictionary *w in (__bridge NSArray *)list) {
    if ([w[(id)kCGWindowOwnerPID] intValue] != pid || [w[(id)kCGWindowLayer] intValue] != 0) continue;
    CGRect r;
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds], &r) || r.size.width < 200) continue;
    CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame); // CG: top-left origin of the primary screen
    found = NSMakeRect(r.origin.x, top - r.origin.y - r.size.height, r.size.width, r.size.height);
    break;
  }
  if (list) CFRelease(list);
  return found;
}

- (void)reposition {
  NSRect s = settings_frame(), p = self.panel.frame;
  self.anchored = !NSIsEmptyRect(s);
  NSRect visible = (NSScreen.mainScreen ?: NSScreen.screens.firstObject).visibleFrame;
  NSPoint origin;
  if (self.anchored) {
    // Beside System Settings (right, else left), top-aligned: the icon is a short drag away.
    origin = NSMakePoint(NSMaxX(s) + 12, NSMaxY(s) - p.size.height);
    if (origin.x + p.size.width > NSMaxX(visible)) origin.x = NSMinX(s) - p.size.width - 12;
    if (origin.x < NSMinX(visible)) origin.x = NSMaxX(s) - p.size.width - 16, origin.y = NSMinY(s) + 16; // no room: inside, bottom-right
  } else {
    origin = NSMakePoint(NSMidX(visible) - p.size.width / 2, NSMidY(visible));
  }
  if (!NSEqualPoints(origin, p.origin)) [self.panel setFrameOrigin:origin];
}

- (void)tick {
  [self reposition];
  NSString *status = platform_permission_status(self.name);
  if ([status isEqual:@"granted"]) [self finish:@"granted" canceled:NO];
}

- (void)finish:(NSString *)status canceled:(BOOL)canceled {
  [self.timer invalidate];
  self.timer = nil;
  [self.panel orderOut:nil];
  if ([status isEqual:@"granted"]) platform_emit(@"permissionChanged", @{@"name" : self.name, @"status" : status});
  [self.call ok:@{@"status" : status ?: @"unknown", @"canceled" : @(canceled)}];
  self.call = nil;
  if (g_guide == self) g_guide = nil;
}

- (void)cancel {
  [self finish:platform_permission_status(self.name) canceled:YES];
}

- (void)relaunch {
  [self cancel];
  shell_platform_call("{\"id\":0,\"service\":\"app\",\"op\":\"relaunch\"}");
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
  [self cancel];
  return NO;
}

@end

void platform_register_permissions(void) {
  platform_register(@"permissions", @"guide", ^(PlatformCall *c) {
    NSString *name = [c string:@"name"];
    if (!panes()[name])
      return [c fail:@"invalid_args"
             message:[NSString stringWithFormat:@"permissions.guide: `%@` has no System Settings pane to guide to (%@)", name ?: @"",
                                                [panes().allKeys componentsJoinedByString:@"|"]]];
    if ([platform_permission_status(name) isEqual:@"granted"]) return [c ok:@{@"status" : @"granted", @"canceled" : @NO}];
    if (g_guide) [g_guide cancel]; // one guide at a time
    SDGuide *g = [SDGuide new];
    g.name = name;
    g.call = c;
    [g buildWithReason:[c string:@"reason"]];
    g_guide = g;
    if ([c boolean:@"open" or:YES]) [g openPane];
    [g reposition];
    [g.panel orderFrontRegardless];
    g.timer = [NSTimer scheduledTimerWithTimeInterval:0.25 target:g selector:@selector(tick) userInfo:nil repeats:YES];
  });
  platform_register(@"permissions", @"cancelGuide", ^(PlatformCall *c) {
    BOOL open = g_guide != nil;
    if (g_guide) [g_guide cancel];
    [c ok:@{@"canceled" : @(open)}];
  });
  platform_register(@"permissions", @"guideState", ^(PlatformCall *c) {
    if (!g_guide) return [c ok:@{@"open" : @NO}];
    [c ok:@{@"open" : @(g_guide.panel.isVisible), @"name" : g_guide.name, @"anchored" : @(g_guide.anchored),
            @"draggable" : @(accepts_drag(g_guide.name)), @"appUrl" : app_url().path ?: NSNull.null,
            @"frame" : @{@"width" : @(g_guide.panel.frame.size.width), @"height" : @(g_guide.panel.frame.size.height)}}];
  });
}
