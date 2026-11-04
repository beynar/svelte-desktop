// deepLink.register — make this app the default handler of a URL scheme.
// LaunchServices only routes a scheme to an app that is a registered bundle
// declaring it in Info.plist CFBundleURLTypes, so the op reports `unavailable`
// when unbundled or undeclared. Incoming URLs arrive as `openUrls {urls}`
// (application:openURLs:, installed by platform_core.mm).
#include "platform_internal.h"

static void on_main(dispatch_block_t block) {
  if (NSThread.isMainThread) block();
  else dispatch_async(dispatch_get_main_queue(), block);
}

static BOOL valid_scheme(NSString *s) {
  // RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
  if (!s.length) return NO;
  NSCharacterSet *alpha = [NSCharacterSet characterSetWithCharactersInString:
                                              @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  NSMutableCharacterSet *rest = [alpha mutableCopy];
  [rest addCharactersInString:@"0123456789+-."];
  if (![alpha characterIsMember:[s characterAtIndex:0]]) return NO;
  return [s rangeOfCharacterFromSet:rest.invertedSet].location == NSNotFound;
}

static BOOL declared_in_info_plist(NSString *scheme) {
  id types = [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleURLTypes"];
  if (![types isKindOfClass:NSArray.class]) return NO;
  for (id t in types) {
    id schemes = [t isKindOfClass:NSDictionary.class] ? t[@"CFBundleURLSchemes"] : nil;
    if (![schemes isKindOfClass:NSArray.class]) continue;
    for (id s in schemes)
      if ([s isKindOfClass:NSString.class] && [s caseInsensitiveCompare:scheme] == NSOrderedSame) return YES;
  }
  return NO;
}

static void register_scheme(PlatformCall *call) {
  NSString *scheme = [call string:@"scheme"];
  if ([scheme hasSuffix:@"://"]) scheme = [scheme substringToIndex:scheme.length - 3];
  else if ([scheme hasSuffix:@":"]) scheme = [scheme substringToIndex:scheme.length - 1];
  if (!valid_scheme(scheme))
    return [call fail:@"invalid_args"
              message:[NSString stringWithFormat:@"deepLink.register: `%@` is not a valid URL scheme", scheme ?: @""]];
  scheme = scheme.lowercaseString;
  NSBundle *bundle = NSBundle.mainBundle;
  // From `bun` (`vite dev`) no app can be set as the handler: nothing to do, not an error.
  if (!bundle.bundleIdentifier.length) return [call ok:@{@"scheme" : scheme, @"registered" : @NO}];
  if (!declared_in_info_plist(scheme))
    return [call fail:@"unavailable"
              message:[NSString stringWithFormat:@"deepLink.register: Info.plist CFBundleURLTypes does not declare "
                                                 @"`%@`; LaunchServices will not route it to this app",
                                                 scheme]];
  // Non-deprecated, asynchronous replacement of LSSetDefaultHandlerForURLScheme
  // (macOS 12+). The system may ask the user to confirm for some schemes.
  [NSWorkspace.sharedWorkspace setDefaultApplicationAtURL:bundle.bundleURL
                                     toOpenURLsWithScheme:scheme
                                        completionHandler:^(NSError *error) {
                                          on_main(^{
                                            if (!error) return [call ok:@{@"scheme" : scheme, @"registered" : @YES}];
                                            [call fail:@"unavailable"
                                                 message:[NSString stringWithFormat:@"deepLink.register `%@` failed: %@", scheme,
                                                                                    error.localizedDescription]];
                                          });
                                        }];
}

void platform_register_deep_link(void) {
  platform_register_many(@"deepLink", @[ @"register", @"registerScheme" ], ^(PlatformCall *call) { register_scheme(call); });
  // Whether this app opens the scheme's URLs. Not an error from `bun` (`vite dev`): it doesn't.
  platform_register(@"deepLink", @"isDefault", ^(PlatformCall *call) {
    NSString *scheme = [call string:@"scheme"];
    if (!valid_scheme(scheme))
      return [call fail:@"invalid_args"
                message:[NSString stringWithFormat:@"deepLink.isDefault: `%@` is not a valid URL scheme", scheme ?: @""]];
    NSString *mine = NSBundle.mainBundle.bundleIdentifier;
    NSURL *url = [NSURL URLWithString:[scheme.lowercaseString stringByAppendingString:@"://"]];
    NSURL *handler = [NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:url];
    [call ok:@(mine.length && handler && [[NSBundle bundleWithURL:handler].bundleIdentifier isEqual:mine])];
  });
}
