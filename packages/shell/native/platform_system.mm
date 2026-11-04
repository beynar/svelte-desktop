// system.* — OS info, keyboard layout, accent color, accessibility prefs and
// TCC permissions (check / request / open the Settings pane).
// Events: keyboardLayoutChanged {} (kTISNotifySelectedKeyboardInputSourceChanged).
#include "platform_internal.h"
#import <ServiceManagement/ServiceManagement.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <IOKit/hidsystem/IOHIDLib.h>

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
    @"accessibility|screenRecording|inputMonitoring|notifications|fullDiskAccess|camera|microphone";

static NSString *hid_status(IOHIDAccessType t) {
  switch (t) {
    case kIOHIDAccessTypeGranted: return @"granted";
    case kIOHIDAccessTypeDenied: return @"denied";
    default: return @"notDetermined";
  }
}

NSString *platform_permission_status(NSString *name) {
  if ([name isEqual:@"accessibility"]) return AXIsProcessTrusted() ? @"granted" : @"denied"; // no notDetermined for AX
  if ([name isEqual:@"screenRecording"]) return CGPreflightScreenCaptureAccess() ? @"granted" : @"denied";
  if ([name isEqual:@"inputMonitoring"]) return hid_status(IOHIDCheckAccess(kIOHIDRequestTypeListenEvent));
  if ([name isEqual:@"fullDiskAccess"]) return full_disk_access_status();
  if ([name isEqual:@"camera"]) return av_status([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]);
  if ([name isEqual:@"microphone"]) return av_status([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]);
  return nil; // unknown here, or asynchronous (notifications)
}

static void check_permission(PlatformCall *call) {
  NSString *name = [call string:@"name"];
  if (!name) return [call fail:@"invalid_args" message:@"system.checkPermission: missing `name`"];
  if ([name isEqual:@"notifications"]) return platform_notifications_permission(call, NO);
  if (NSString *status = platform_permission_status(name)) return [call ok:@{@"status" : status}];
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
  if ([name isEqual:@"inputMonitoring"]) {
    // Adds the app to the Input Monitoring list and shows the system prompt (first call).
    BOOL granted = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent);
    return [call ok:@{@"status" : granted ? @"granted" : hid_status(IOHIDCheckAccess(kIOHIDRequestTypeListenEvent))}];
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
  if ([pane isEqual:@"loginItems"]) {
    if (@available(macOS 13.0, *)) {
      [SMAppService openSystemSettingsLoginItems];
      return [call ok:@{@"opened" : @YES}];
    }
    return [call ok:@{@"opened" : @NO}];
  }
  NSString *privacy = @"x-apple.systempreferences:com.apple.preference.security";
  NSDictionary *urls = @{
    @"privacy-accessibility" : [privacy stringByAppendingString:@"?Privacy_Accessibility"],
    @"privacy-screenCapture" : [privacy stringByAppendingString:@"?Privacy_ScreenCapture"],
    @"privacy-inputMonitoring" : [privacy stringByAppendingString:@"?Privacy_ListenEvent"],
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

static NSString *biometry_name(LAContext *ctx) {
  switch (ctx.biometryType) {
    case LABiometryTypeTouchID: return @"touchID";
    case LABiometryTypeFaceID: return @"faceID";
    default:
      if (@available(macOS 14.0, *))
        if (ctx.biometryType == LABiometryTypeOpticID) return @"opticID";
      return @"none";
  }
}

void platform_register_system(void) {
  // Touch ID: whether it can be asked, and which biometry (the prompt is secureStorage.authenticate).
  platform_register(@"system", @"biometrics", ^(PlatformCall *call) {
    LAContext *ctx = [LAContext new];
    NSError *err = nil;
    BOOL available = [ctx canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&err];
    [call ok:@{@"available" : @(available), @"type" : biometry_name(ctx), @"enrolled" : @(available || err.code != LAErrorBiometryNotEnrolled)}];
  });
  platform_register(@"system", @"info", ^(PlatformCall *call) {
    [call ok:@{
      @"os" : @"macos",
      @"family" : @"unix",
      @"arch" : arch_name(),
      @"keyboardLayout" : keyboard_layout()[@"name"],
    }];
  });
  platform_register(@"system", @"getKeyboardLayout", ^(PlatformCall *call) { [call ok:keyboard_layout()]; });
  // The installed font families (what a page's CSS can name), with their styles on request: the web's
  // Local Font Access API isn't in WebKit.
  platform_register(@"system", @"fonts", ^(PlatformCall *call) {
    NSFontManager *fm = NSFontManager.sharedFontManager;
    NSArray<NSString *> *families = [fm.availableFontFamilies sortedArrayUsingSelector:@selector(localizedCaseInsensitiveCompare:)];
    if (![call boolean:@"styles" or:NO]) return [call ok:families];
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:families.count];
    for (NSString *family in families) {
      NSMutableArray *styles = [NSMutableArray new];
      // Each member: [PostScript name, style name, weight (0–15, 5 regular, 9 bold), traits].
      for (NSArray *m in [fm availableMembersOfFontFamily:family]) {
        if (m.count < 4) continue;
        NSInteger w = [m[2] integerValue];
        int css = w <= 1 ? 100 : w == 2 ? 200 : w == 3 ? 300 : w <= 5 ? 400 : w == 6 ? 500 : w <= 8 ? 600 : w <= 10 ? 700 : w == 11 ? 800 : 900;
        [styles addObject:@{@"name" : m[1], @"postscriptName" : m[0], @"weight" : @(css), @"italic" : @(([m[3] unsignedIntegerValue] & NSItalicFontMask) != 0)}];
      }
      [out addObject:@{@"family" : family, @"styles" : styles}];
    }
    [call ok:out];
  });
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
