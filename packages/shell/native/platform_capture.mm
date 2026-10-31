// capture.* — ScreenCaptureKit (macOS 12.3+ listing, 14+ stills).
//   isSupported → {supported}
//   getSources {types?} → [{id, type, label, isMain, resolution:{width,height}, bundleIdentifier?}]
//   captureSource {id, type?} → {width, height, pngBase64}
// Needs the Screen Recording permission (system.requestPermission
// 'screenRecording'); without it the calls reject `denied`.
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include "platform_internal.h"

static void on_main(void (^b)(void)) { dispatch_async(dispatch_get_main_queue(), b); }

static NSString *denied_or(NSError *err) {
  return err.localizedDescription ?: @"screen capture failed";
}

static BOOL wants(NSArray *types, NSString *t) { return !types.count || [types containsObject:t]; }

void platform_register_capture(void) {
  platform_register(@"capture", @"isSupported", ^(PlatformCall *c) {
    if (@available(macOS 12.3, *)) return [c ok:@{@"supported" : @YES, @"stills" : @(NSProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 14)}];
    [c ok:@{@"supported" : @NO}];
  });

  platform_register(@"capture", @"getSources", ^(PlatformCall *c) {
    if (@available(macOS 12.3, *)) {
      NSArray *types = [c.args[@"types"] isKindOfClass:NSArray.class] ? c.args[@"types"] : @[];
      if (!CGPreflightScreenCaptureAccess())
        return [c fail:@"denied" message:@"capture: Screen Recording permission not granted (system.requestPermission('screenRecording'))"];
      [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES
                                                    completionHandler:^(SCShareableContent *content, NSError *err) {
        if (!content) return on_main(^{ [c fail:@"denied" message:denied_or(err)]; });
        NSMutableArray *out = [NSMutableArray array];
        CGDirectDisplayID mainId = CGMainDisplayID();
        if (wants(types, @"display"))
          for (SCDisplay *d in content.displays)
            [out addObject:@{@"id" : @(d.displayID), @"type" : @"display", @"label" : [NSString stringWithFormat:@"Display %u", d.displayID],
                             @"isMain" : @(d.displayID == mainId), @"resolution" : @{@"width" : @(d.width), @"height" : @(d.height)}}];
        if (wants(types, @"window"))
          for (SCWindow *w in content.windows) {
            if (w.windowLayer != 0 || w.frame.size.width < 40) continue; // skip menu bar items, shadows, tiny panels
            NSString *label = w.title.length ? [NSString stringWithFormat:@"%@ — %@", w.owningApplication.applicationName ?: @"", w.title]
                                             : w.owningApplication.applicationName;
            [out addObject:@{@"id" : @(w.windowID), @"type" : @"window", @"label" : label ?: NSNull.null, @"isMain" : NSNull.null,
                             @"resolution" : @{@"width" : @(w.frame.size.width), @"height" : @(w.frame.size.height)},
                             @"bundleIdentifier" : w.owningApplication.bundleIdentifier ?: NSNull.null}];
          }
        if (wants(types, @"application"))
          for (SCRunningApplication *a in content.applications) {
            if (!a.applicationName.length) continue;
            [out addObject:@{@"id" : @(a.processID), @"type" : @"application", @"label" : a.applicationName, @"isMain" : NSNull.null,
                             @"resolution" : @{@"width" : @0, @"height" : @0}, @"bundleIdentifier" : a.bundleIdentifier ?: NSNull.null}];
          }
        on_main(^{ [c ok:out]; });
      }];
      return;
    }
    [c fail:@"unsupported" message:@"capture needs macOS 12.3"];
  });

  platform_register(@"capture", @"captureSource", ^(PlatformCall *c) {
    if (@available(macOS 14.0, *)) {
      if (![c has:@"id"]) return [c fail:@"invalid_args" message:@"capture.captureSource: `id` is required"];
      if (!CGPreflightScreenCaptureAccess())
        return [c fail:@"denied" message:@"capture: Screen Recording permission not granted (system.requestPermission('screenRecording'))"];
      uint32_t ident = (uint32_t)[c number:@"id" or:0];
      NSString *type = [c string:@"type"];
      [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
                                                    completionHandler:^(SCShareableContent *content, NSError *err) {
        if (!content) return on_main(^{ [c fail:@"denied" message:denied_or(err)]; });
        SCContentFilter *filter = nil;
        CGSize size = CGSizeZero;
        if (!type || [type isEqual:@"display"])
          for (SCDisplay *d in content.displays)
            if (d.displayID == ident) {
              filter = [[SCContentFilter alloc] initWithDisplay:d excludingWindows:@[]];
              size = CGSizeMake(d.width, d.height);
            }
        if (!filter && (!type || [type isEqual:@"window"]))
          for (SCWindow *w in content.windows)
            if (w.windowID == ident) {
              filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:w];
              size = w.frame.size;
            }
        if (!filter) return on_main(^{ [c fail:@"invalid_args" message:[NSString stringWithFormat:@"capture: no source %u", ident]]; });
        SCStreamConfiguration *cfg = [SCStreamConfiguration new];
        CGFloat scale = NSScreen.mainScreen.backingScaleFactor ?: 2;
        cfg.width = (size_t)(size.width * scale);
        cfg.height = (size_t)(size.height * scale);
        cfg.showsCursor = NO;
        [SCScreenshotManager captureImageWithFilter:filter configuration:cfg completionHandler:^(CGImageRef image, NSError *e2) {
          if (!image) return on_main(^{ [c fail:@"unavailable" message:denied_or(e2)]; });
          NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
          NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
          NSDictionary *r = @{@"width" : @(rep.pixelsWide), @"height" : @(rep.pixelsHigh), @"pngBase64" : [png base64EncodedStringWithOptions:0]};
          on_main(^{ [c ok:r]; });
        }];
      }];
      return;
    }
    [c fail:@"unavailable" message:@"capture.captureSource needs macOS 14 (SCScreenshotManager)"];
  });
}
