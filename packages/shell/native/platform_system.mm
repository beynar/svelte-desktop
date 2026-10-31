// system.* — OS info, keyboard layout, accent color, accessibility prefs and
// TCC permissions (check / request / open the Settings pane).
// Events: keyboardLayoutChanged {} (kTISNotifySelectedKeyboardInputSourceChanged).
#include "platform_internal.h"

#import <AVFoundation/AVFoundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <fcntl.h>
#include <unistd.h>

// Defined in platform_notifications.mm (UNUserNotificationCenter, bundle-guarded).
void platform_notifications_permission(PlatformCall *call, BOOL request);

static NSString *arch_name(void) {
#if defined(__aarch64__) || defined(__arm64__)
  return @"aarch64";
#else
  return @"x86_64";
#endif
}

static void on_main(dispatch_block_t block) {
  if (NSThread.isMainThread) block();
  else dispatch_async(dispatch_get_main_queue(), block);
}

// Same pair GPUI's MacKeyboardLayout reports: localized name + input source id.
static NSDictionary *keyboard_layout(void) {
  NSString *name = @"", *ident = @"";
  TISInputSourceRef src = TISCopyCurrentKeyboardLayoutInputSource();
  if (src) {
    CFStringRef n = (CFStringRef)TISGetInputSourceProperty(src, kTISPropertyLocalizedName);
    CFStringRef i = (CFStringRef)TISGetInputSourceProperty(src, kTISPropertyInputSourceID);
    if (n) name = [(__bridge NSString *)n copy];
    if (i) ident = [(__bridge NSString *)i copy];
    CFRelease(src);
  }
  return @{@"name" : name, @"id" : ident};
}

// ---------------------------------------------------------------------------
// Permissions

static NSString *av_status(AVAuthorizationStatus s) {
  switch (s) {
    case AVAuthorizationStatusNotDetermined: return @"notDetermined";
    case AVAuthorizationStatusAuthorized: return @"granted";
    default: return @"denied"; // restricted folds into denied
  }
}

// TCC offers no Full Disk Access query: probe the system TCC database, which is
// only readable with FDA. Unreadable means denied OR never asked -> unknown.
static NSString *full_disk_access_status(void) {
  int fd = open("/Library/Application Support/com.apple.TCC/TCC.db", O_RDONLY);
  if (fd < 0) return @"unknown";
  close(fd);
  return @"granted";
}

static NSString *const kPermissionNames =
    @"accessibility|screenRecording|notifications|fullDiskAccess|camera|microphone";

static void check_permission(PlatformCall *call) {
  NSString *name = [call string:@"name"];
  if (!name) return [call fail:@"invalid_args" message:@"system.checkPermission: missing `name`"];
  if ([name isEqual:@"accessibility"]) // no notDetermined state for AX
    return [call ok:@{@"status" : AXIsProcessTrusted() ? @"granted" : @"denied"}];
  if ([name isEqual:@"screenRecording"])
    return [call ok:@{@"status" : CGPreflightScreenCaptureAccess() ? @"granted" : @"denied"}];
  if ([name isEqual:@"notifications"]) return platform_notifications_permission(call, NO);
  if ([name isEqual:@"fullDiskAccess"]) return [call ok:@{@"status" : full_disk_access_status()}];
  if ([name isEqual:@"camera"])
    return [call ok:@{@"status" : av_status([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo])}];
  if ([name isEqual:@"microphone"])
    return [call ok:@{@"status" : av_status([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio])}];
  [call fail:@"invalid_args"
       message:[NSString stringWithFormat:@"system.checkPermission: unknown name `%@`, expected %@", name, kPermissionNames]];
}

// requestAccessForMediaType: aborts the process (TCC) when the matching usage
// description is missing from Info.plist, so check it first.
static void request_av(PlatformCall *call, NSString *name, AVMediaType type, NSString *usageKey) {
  if (![NSBundle.mainBundle objectForInfoDictionaryKey:usageKey]) {
    return [call fail:@"unavailable"
              message:[NSString stringWithFormat:@"system.requestPermission %@: Info.plist has no %@ (the request would "
                                                 @"crash the process); package the app with that key",
                                                 name, usageKey]];
  }
  [AVCaptureDevice requestAccessForMediaType:type
                           completionHandler:^(BOOL granted) {
                             on_main(^{ [call ok:@{@"status" : granted ? @"granted" : @"denied"}]; });
                           }];
}

static void request_permission(PlatformCall *call) {
  NSString *name = [call string:@"name"];
  if (!name) return [call fail:@"invalid_args" message:@"system.requestPermission: missing `name`"];
  if ([name isEqual:@"accessibility"]) {
    // Posts the "allow in Settings" prompt once, then reports the current value.
    // The user still has to toggle the app in Settings (and often relaunch).
    NSDictionary *opts = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
    if (AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts)) return [call ok:@{@"status" : @"granted"}];
    return [call ok:@{
      @"status" : @"denied",
      @"note" : @"grant the app in System Settings > Privacy & Security > Accessibility, then relaunch"
    }];
  }
  if ([name isEqual:@"screenRecording"]) {
    // Non-blocking: the prompt (first call only) is shown by the system.
    if (CGRequestScreenCaptureAccess()) return [call ok:@{@"status" : @"granted"}];
    return [call ok:@{
      @"status" : @"denied",
      @"note" : @"grant the app in System Settings > Privacy & Security > Screen Recording, then relaunch"
    }];
  }
  if ([name isEqual:@"notifications"]) return platform_notifications_permission(call, YES);
  if ([name isEqual:@"camera"]) return request_av(call, name, AVMediaTypeVideo, @"NSCameraUsageDescription");
  if ([name isEqual:@"microphone"]) return request_av(call, name, AVMediaTypeAudio, @"NSMicrophoneUsageDescription");
  if ([name isEqual:@"fullDiskAccess"])
    return [call fail:@"unsupported"
              message:@"system.requestPermission fullDiskAccess cannot be requested programmatically; call "
                      @"system.openSettings {pane: \"privacy-fullDiskAccess\"} and relaunch the app"];
  [call fail:@"invalid_args"
       message:[NSString stringWithFormat:@"system.requestPermission: unknown name `%@`, expected %@", name, kPermissionNames]];
}

static void open_settings(PlatformCall *call) {
  NSString *pane = [call string:@"pane"];
  if (!pane) return [call fail:@"invalid_args" message:@"system.openSettings: missing `pane`"];
  NSString *privacy = @"x-apple.systempreferences:com.apple.preference.security";
  NSDictionary *urls = @{
    @"privacy-accessibility" : [privacy stringByAppendingString:@"?Privacy_Accessibility"],
    @"privacy-screenCapture" : [privacy stringByAppendingString:@"?Privacy_ScreenCapture"],
    @"privacy-fullDiskAccess" : [privacy stringByAppendingString:@"?Privacy_AllFiles"],
    @"privacy-camera" : [privacy stringByAppendingString:@"?Privacy_Camera"],
    @"privacy-microphone" : [privacy stringByAppendingString:@"?Privacy_Microphone"],
    @"notifications" : @"x-apple.systempreferences:com.apple.preference.notifications",
  };
  NSString *url = urls[pane];
  if (!url)
    return [call fail:@"invalid_args"
              message:[NSString stringWithFormat:@"system.openSettings: unknown pane `%@`, expected %@", pane,
                                                 [urls.allKeys componentsJoinedByString:@"|"]]];
  BOOL opened = [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:url]];
  [call ok:@{@"opened" : @(opened)}];
}

// ---------------------------------------------------------------------------
// Events

@interface SDSystemObserver : NSObject
@end
@implementation SDSystemObserver
- (void)inputSourceChanged:(NSNotification *)note {
  platform_emit(@"keyboardLayoutChanged", @{});
}
@end

static SDSystemObserver *g_observer;

void platform_register_system(void) {
  platform_register(@"system", @"info", ^(PlatformCall *call) {
    [call ok:@{
      @"os" : @"macos",
      @"family" : @"unix",
      @"arch" : arch_name(),
      @"keyboardLayout" : keyboard_layout()[@"name"],
    }];
  });
  platform_register(@"system", @"getKeyboardLayout", ^(PlatformCall *call) { [call ok:keyboard_layout()]; });
  platform_register(@"system", @"getAccentColor", ^(PlatformCall *call) {
    NSColor *rgb = [NSColor.controlAccentColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    if (!rgb) return [call fail:@"unavailable" message:@"system.getAccentColor: accent color has no sRGB form"];
    [call ok:@{@"r" : @(rgb.redComponent), @"g" : @(rgb.greenComponent), @"b" : @(rgb.blueComponent), @"a" : @(rgb.alphaComponent)}];
  });
  platform_register(@"system", @"getAccessibility", ^(PlatformCall *call) {
    NSWorkspace *ws = NSWorkspace.sharedWorkspace;
    [call ok:@{
      @"reduceMotion" : @(ws.accessibilityDisplayShouldReduceMotion),
      @"highContrast" : @(ws.accessibilityDisplayShouldIncreaseContrast),
      @"differentiateWithoutColor" : @(ws.accessibilityDisplayShouldDifferentiateWithoutColor),
      @"reduceTransparency" : @(ws.accessibilityDisplayShouldReduceTransparency),
    }];
  });
  platform_register(@"system", @"checkPermission", ^(PlatformCall *call) { check_permission(call); });
  platform_register(@"system", @"requestPermission", ^(PlatformCall *call) { request_permission(call); });
  platform_register(@"system", @"openSettings", ^(PlatformCall *call) { open_settings(call); });

  // Distributed notification; DeliverImmediately so it still arrives while the
  // app is inactive (NSApplication suspends coalesced delivery then).
  g_observer = [SDSystemObserver new];
  [NSDistributedNotificationCenter.defaultCenter addObserver:g_observer
                                                    selector:@selector(inputSourceChanged:)
                                                        name:(__bridge NSString *)kTISNotifySelectedKeyboardInputSourceChanged
                                                      object:nil
                                          suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
}
