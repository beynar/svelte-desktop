// theme.* — app appearance. Events: appearanceChanged {appearance, dark}.
#include "platform_internal.h"

static NSDictionary *theme_info(void) {
  NSAppearance *a = NSApp.effectiveAppearance;
  NSAppearanceName best = [a bestMatchFromAppearancesWithNames:@[
    NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSAppearanceNameVibrantLight, NSAppearanceNameVibrantDark
  ]];
  NSString *name = [best isEqual:NSAppearanceNameDarkAqua]       ? @"dark"
                   : [best isEqual:NSAppearanceNameVibrantDark]  ? @"vibrantDark"
                   : [best isEqual:NSAppearanceNameVibrantLight] ? @"vibrantLight"
                                                                 : @"light";
  BOOL dark = [[a bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]] isEqual:NSAppearanceNameDarkAqua];
  return @{@"appearance" : name, @"dark" : @(dark)};
}

@interface SDAppearanceObserver : NSObject
@property(nonatomic, copy) NSString *last;
@end
@implementation SDAppearanceObserver
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)ctx {
  NSDictionary *info = theme_info();
  NSString *key = [NSString stringWithFormat:@"%@", info];
  if ([key isEqualToString:self.last]) return;
  self.last = key;
  platform_emit(@"appearanceChanged", info);
}
@end

static SDAppearanceObserver *g_observer;

void platform_register_theme(void) {
  platform_register_many(@"theme", @[ @"get", @"getAppearance" ], ^(PlatformCall *c) { [c ok:theme_info()]; });
  platform_register_many(@"theme", @[ @"set", @"setAppearance" ], ^(PlatformCall *c) {
    NSString *a = [c string:@"appearance"] ?: @"system";
    NSDictionary *names = @{
      @"light" : NSAppearanceNameAqua, @"dark" : NSAppearanceNameDarkAqua,
      @"vibrantLight" : NSAppearanceNameVibrantLight, @"vibrantDark" : NSAppearanceNameVibrantDark
    };
    if (![a isEqual:@"system"] && !names[a])
      return [c fail:@"invalid_args" message:@"theme.set: appearance must be system|light|dark|vibrantLight|vibrantDark"];
    NSApp.appearance = [a isEqual:@"system"] ? nil : [NSAppearance appearanceNamed:names[a]];
    [c ok:theme_info()];
  });
  platform_register(@"theme", @"shouldUseDarkColors", ^(PlatformCall *c) { [c ok:theme_info()[@"dark"]]; });
  g_observer = [SDAppearanceObserver new];
  g_observer.last = [NSString stringWithFormat:@"%@", theme_info()];
  [NSApp addObserver:g_observer forKeyPath:@"effectiveAppearance" options:0 context:nil];
}
