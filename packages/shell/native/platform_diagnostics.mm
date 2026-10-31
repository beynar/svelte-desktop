// diagnostics.info and capabilities.describe.
#include "platform_internal.h"

#include <sys/sysctl.h>
#include <unistd.h>

static NSString *arch_name(void) {
#if defined(__aarch64__) || defined(__arm64__)
  return @"aarch64";
#else
  return @"x86_64";
#endif
}

// Seconds since the process started (kernel start time, not first call).
static double uptime_seconds(void) {
  struct kinfo_proc info;
  size_t size = sizeof info;
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
  if (sysctl(mib, 4, &info, &size, NULL, 0) == 0 && size > 0) {
    struct timeval start = info.kp_proc.p_starttime;
    double started = start.tv_sec + start.tv_usec / 1e6;
    double now = NSDate.date.timeIntervalSince1970;
    if (now >= started) return now - started;
  }
  return 0;
}

static NSString *webkit_version(void) {
  NSDictionary *info = [NSBundle bundleForClass:WKWebView.class].infoDictionary;
  return info[@"CFBundleVersion"] ?: info[@"CFBundleShortVersionString"] ?: @"";
}

void platform_register_diagnostics(void) {
  platform_register(@"diagnostics", @"info", ^(PlatformCall *call) {
    [call ok:@{
      @"pid" : @(getpid()),
      @"uptimeSeconds" : @(uptime_seconds()),
      @"os" : @"macos",
      @"family" : @"unix",
      @"arch" : arch_name(),
      @"renderer" : @"wkwebview",
      @"rendererVersion" : webkit_version(),
      @"osVersion" : NSProcessInfo.processInfo.operatingSystemVersionString,
    }];
  });

  // Truth table built from the live registry: every registered op is
  // "implemented", except ops that cannot work in this environment, reported
  // "unavailable" (UNUserNotificationCenter / URL schemes need a bundle).
  platform_register(@"capabilities", @"describe", ^(PlatformCall *call) {
    BOOL bundled = NSBundle.mainBundle.bundleIdentifier.length > 0;
    NSMutableDictionary<NSString *, NSMutableDictionary *> *services = [NSMutableDictionary dictionary];
    for (NSString *key in platform_registered_ops()) {
      NSRange dot = [key rangeOfString:@"."];
      if (dot.location == NSNotFound) continue;
      NSString *service = [key substringToIndex:dot.location], *op = [key substringFromIndex:dot.location + 1];
      NSString *status = @"implemented";
      if (!bundled && ([service isEqual:@"notifications"] || [key isEqual:@"deepLink.register"] ||
                       [key isEqual:@"deepLink.registerScheme"]))
        status = @"unavailable";
      (services[service] ?: (services[service] = [NSMutableDictionary dictionary]))[op] = status;
    }
    [call ok:@{@"platform" : @"macos", @"arch" : arch_name(), @"services" : services}];
  });
}
