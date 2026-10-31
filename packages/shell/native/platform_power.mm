// power.* — thermal state, global idle time, battery, sleep assertions.
// Events: thermalStateChanged, systemSleep, systemWake, screenLocked,
// screenUnlocked (all {}), plus displaySleep/displayWake (NSWorkspace screens
// sleep) and screensaverStarted/screensaverStopped.
#include "platform_internal.h"

#import <IOKit/ps/IOPSKeys.h>
#import <IOKit/ps/IOPowerSources.h>
#import <IOKit/pwr_mgt/IOPMLib.h>

static NSString *thermal_name(NSProcessInfoThermalState s) {
  switch (s) {
    case NSProcessInfoThermalStateNominal: return @"nominal";
    case NSProcessInfoThermalStateFair: return @"fair";
    case NSProcessInfoThermalStateSerious: return @"serious";
    case NSProcessInfoThermalStateCritical: return @"critical";
  }
  return @"nominal";
}

// ---------------------------------------------------------------------------
// Battery (IOPowerSources). Same semantics as the GPUI build: percent is null
// without an internal battery; charging is true while charging or on AC;
// external is true on AC or when there is no battery at all.

static void get_battery(PlatformCall *call) {
  CFTypeRef blob = IOPSCopyPowerSourcesInfo();
  if (!blob) return [call fail:@"unavailable" message:@"power.getBattery: IOPSCopyPowerSourcesInfo returned no data"];
  NSString *providing = (__bridge NSString *)IOPSGetProvidingPowerSourceType(blob); // Get rule, not owned
  BOOL onAC = [providing isEqualToString:@kIOPSACPowerValue];
  BOOL onBattery = [providing isEqualToString:@kIOPSBatteryPowerValue];
  BOOL found = NO, charging = NO;
  id percent = NSNull.null;
  CFArrayRef list = IOPSCopyPowerSourcesList(blob);
  if (list) {
    for (CFIndex i = 0, n = CFArrayGetCount(list); i < n; i++) {
      NSDictionary *d = (__bridge NSDictionary *)IOPSGetPowerSourceDescription(blob, CFArrayGetValueAtIndex(list, i));
      if (![d isKindOfClass:NSDictionary.class] || ![d[@kIOPSTypeKey] isEqual:@kIOPSInternalBatteryType]) continue;
      found = YES;
      id cur = d[@kIOPSCurrentCapacityKey], max = d[@kIOPSMaxCapacityKey];
      if ([cur isKindOfClass:NSNumber.class] && [max isKindOfClass:NSNumber.class] && [max doubleValue] > 0)
        percent = @([cur doubleValue] * 100.0 / [max doubleValue]);
      id ch = d[@kIOPSIsChargingKey];
      charging = [ch isKindOfClass:NSNumber.class] && [ch boolValue];
      break; // a Mac has one internal battery
    }
    CFRelease(list);
  }
  CFRelease(blob);
  [call ok:@{@"percent" : percent, @"charging" : @(charging || onAC), @"external" : @(!found || !onBattery)}];
}

// ---------------------------------------------------------------------------
// Sleep assertions. Only ids we created can be released.

static NSMutableSet<NSNumber *> *g_assertions;

static void block_sleep(PlatformCall *call) {
  NSString *type = [call string:@"type"];
  NSDictionary *kinds = @{
    @"system" : @"PreventSystemSleep", // no public constant; IOPMLib private name
    @"display" : (__bridge NSString *)kIOPMAssertPreventUserIdleDisplaySleep,
    @"idle" : (__bridge NSString *)kIOPMAssertPreventUserIdleSystemSleep,
  };
  NSString *assertion = type ? kinds[type] : nil;
  if (!assertion)
    return [call fail:@"invalid_args"
              message:[NSString stringWithFormat:@"power.blockSleep: unknown type `%@`, expected system|display|idle", type ?: @""]];
  NSString *reason = [call string:@"reason"];
  if (!reason.length) reason = [NSString stringWithFormat:@"%@ sleep block", platform_app_name()];
  IOPMAssertionID aid = 0;
  IOReturn rc = IOPMAssertionCreateWithName((__bridge CFStringRef)assertion, kIOPMAssertionLevelOn,
                                            (__bridge CFStringRef)reason, &aid);
  if (rc != kIOReturnSuccess)
    return [call fail:@"internal" message:[NSString stringWithFormat:@"power.blockSleep: IOPMAssertionCreateWithName failed (0x%x)", rc]];
  [g_assertions addObject:@(aid)];
  [call ok:@{@"id" : @(aid)}];
}

static void unblock_sleep(PlatformCall *call) {
  double raw = [call number:@"id" or:-1];
  if (raw < 0 || raw != floor(raw) || raw > UINT32_MAX)
    return [call fail:@"invalid_args" message:@"power.unblockSleep: `id` must be an id returned by blockSleep"];
  NSNumber *aid = @((IOPMAssertionID)raw);
  if (![g_assertions containsObject:aid])
    return [call fail:@"invalid_args"
              message:[NSString stringWithFormat:@"power.unblockSleep: no live sleep block with id %@", aid]];
  [g_assertions removeObject:aid];
  IOReturn rc = IOPMAssertionRelease(aid.unsignedIntValue);
  if (rc != kIOReturnSuccess)
    return [call fail:@"internal" message:[NSString stringWithFormat:@"power.unblockSleep: IOPMAssertionRelease failed (0x%x)", rc]];
  [call ok:nil];
}

// ---------------------------------------------------------------------------
// Events

@interface SDPowerObserver : NSObject
@end
@implementation SDPowerObserver
- (void)forward:(NSNotification *)note {
  static NSDictionary<NSString *, NSString *> *map;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    map = @{
      NSWorkspaceWillSleepNotification : @"systemSleep",
      NSWorkspaceDidWakeNotification : @"systemWake",
      NSWorkspaceScreensDidSleepNotification : @"displaySleep",
      NSWorkspaceScreensDidWakeNotification : @"displayWake",
      NSProcessInfoThermalStateDidChangeNotification : @"thermalStateChanged",
      @"com.apple.screenIsLocked" : @"screenLocked",
      @"com.apple.screenIsUnlocked" : @"screenUnlocked",
      @"com.apple.screensaver.didstart" : @"screensaverStarted",
      @"com.apple.screensaver.didstop" : @"screensaverStopped",
    };
  });
  NSString *name = map[note.name];
  if (name) platform_emit(name, @{}); // platform_emit hops to the main thread
}
@end

static SDPowerObserver *g_observer;

void platform_register_power(void) {
  g_assertions = [NSMutableSet set];
  platform_register_many(@"power", @[ @"getThermalState", @"thermalState" ], ^(PlatformCall *call) {
    [call ok:@{@"state" : thermal_name(NSProcessInfo.processInfo.thermalState)}];
  });
  platform_register(@"power", @"getSystemIdleTime", ^(PlatformCall *call) {
    // kCGAnyInputEventType, not 0 (kCGEventNull does not track user input).
    [call ok:@(CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType))];
  });
  platform_register(@"power", @"getBattery", ^(PlatformCall *call) { get_battery(call); });
  platform_register(@"power", @"blockSleep", ^(PlatformCall *call) { block_sleep(call); });
  platform_register(@"power", @"unblockSleep", ^(PlatformCall *call) { unblock_sleep(call); });

  g_observer = [SDPowerObserver new];
  NSNotificationCenter *ws = NSWorkspace.sharedWorkspace.notificationCenter;
  for (NSString *n in @[
         NSWorkspaceWillSleepNotification, NSWorkspaceDidWakeNotification, NSWorkspaceScreensDidSleepNotification,
         NSWorkspaceScreensDidWakeNotification
       ])
    [ws addObserver:g_observer selector:@selector(forward:) name:n object:nil];
  [NSNotificationCenter.defaultCenter addObserver:g_observer
                                         selector:@selector(forward:)
                                             name:NSProcessInfoThermalStateDidChangeNotification
                                           object:nil];
  NSDistributedNotificationCenter *dist = NSDistributedNotificationCenter.defaultCenter;
  for (NSString *n in @[
         @"com.apple.screenIsLocked", @"com.apple.screenIsUnlocked", @"com.apple.screensaver.didstart",
         @"com.apple.screensaver.didstop"
       ])
    [dist addObserver:g_observer
             selector:@selector(forward:)
                 name:n
               object:nil
   suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
}
