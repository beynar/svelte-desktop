// screen.* — displays (top-left origin of the primary screen, y down) + cursor.
// Events: displaysChanged.
#include "platform_internal.h"

static NSDictionary *display_info(NSScreen *s) {
  CGDirectDisplayID did = [s.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
  id uuid = NSNull.null;
  if (CFUUIDRef u = CGDisplayCreateUUIDFromDisplayID(did)) {
    uuid = (__bridge_transfer NSString *)CFUUIDCreateString(NULL, u);
    CFRelease(u);
  }
  return @{
    @"id" : @(did),
    @"uuid" : uuid,
    @"label" : s.localizedName ?: NSNull.null,
    @"bounds" : platform_rect_dict(platform_to_top_left(s.frame)),
    @"workArea" : platform_rect_dict(platform_to_top_left(s.visibleFrame)),
    @"scaleFactor" : @(s.backingScaleFactor),
    @"isPrimary" : @(s == NSScreen.screens.firstObject),
  };
}

void platform_register_screen(void) {
  platform_register(@"screen", @"getAllDisplays", ^(PlatformCall *c) {
    NSMutableArray *list = [NSMutableArray array];
    for (NSScreen *s in NSScreen.screens) [list addObject:display_info(s)];
    [c ok:list];
  });
  platform_register(@"screen", @"getPrimaryDisplay", ^(PlatformCall *c) {
    NSScreen *s = NSScreen.screens.firstObject;
    s ? [c ok:display_info(s)] : [c fail:@"unavailable" message:@"no display"];
  });
  platform_register(@"screen", @"getDisplayNearestWindow", ^(PlatformCall *c) {
    NSScreen *s = platform_window(platform_resolve_window(c)).screen ?: NSScreen.mainScreen ?: NSScreen.screens.firstObject;
    s ? [c ok:display_info(s)] : [c fail:@"unavailable" message:@"no display"];
  });
  platform_register(@"screen", @"getCursorScreenPoint", ^(PlatformCall *c) {
    NSPoint p = NSEvent.mouseLocation;
    NSRect r = platform_to_top_left(NSMakeRect(p.x, p.y, 0, 0));
    [c ok:@{@"x" : @(r.origin.x), @"y" : @(r.origin.y)}];
  });
  platform_register(@"screen", @"scaleFactor", ^(PlatformCall *c) {
    [c ok:@((NSScreen.mainScreen ?: NSScreen.screens.firstObject).backingScaleFactor ?: 1)];
  });
  [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil
                                                   queue:nil usingBlock:^(NSNotification *) {
                                                     platform_emit(@"displaysChanged", @{});
                                                   }];
}
