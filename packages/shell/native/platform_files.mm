// Security-scoped access belongs to each open handle, until its matching release.
#include "platform_internal.h"
#include "platform_files.h"
#import <Security/Security.h>

static BOOL sandboxed(void) {
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  if (!task) return NO;
  CFTypeRef value = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.security.app-sandbox"), NULL);
  BOOL yes = value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value);
  if (value) CFRelease(value);
  CFRelease(task);
  return yes;
}

NSData *platform_file_bookmark(NSURL *url, NSError **error) {
  return [url bookmarkDataWithOptions:sandboxed() ? NSURLBookmarkCreationWithSecurityScope : 0
      includingResourceValuesForKeys:nil relativeToURL:nil error:error];
}

void platform_register_files(void) {
  static NSMutableDictionary<NSString *, NSURL *> *handles;
  handles = [NSMutableDictionary dictionary];
  platform_register(@"files", @"createBookmark", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"].stringByExpandingTildeInPath;
    if (!path.isAbsolutePath) return [c fail:@"invalid_args" message:@"files.createBookmark: absolute path required"];
    NSError *error = nil;
    NSData *data = platform_file_bookmark([NSURL fileURLWithPath:path], &error);
    if (!data) return [c fail:@"unavailable" message:error.localizedDescription ?: @"could not create bookmark"];
    [c ok:@{@"bookmark" : [data base64EncodedStringWithOptions:0]}];
  });
  platform_register(@"files", @"openBookmark", ^(PlatformCall *c) {
    NSData *data = [[NSData alloc] initWithBase64EncodedString:[c string:@"bookmark"] ?: @"" options:0];
    if (!data.length) return [c fail:@"invalid_args" message:@"files.openBookmark: invalid bookmark"];
    NSError *error = nil;
    BOOL stale = NO, scoped = sandboxed();
    NSURL *url = [NSURL URLByResolvingBookmarkData:data options:NSURLBookmarkResolutionWithoutUI | (scoped ? NSURLBookmarkResolutionWithSecurityScope : 0)
        relativeToURL:nil bookmarkDataIsStale:&stale error:&error];
    if (!url.isFileURL) return [c fail:@"unavailable" message:error.localizedDescription ?: @"bookmark did not resolve to a file"];
    if (scoped && ![url startAccessingSecurityScopedResource])
      return [c fail:@"denied" message:@"files.openBookmark: security-scoped access denied"];
    NSString *ident = NSUUID.UUID.UUIDString;
    handles[ident] = url;
    [c ok:@{@"id" : ident, @"path" : url.path, @"stale" : @(stale)}];
  });
  platform_register(@"files", @"releaseBookmark", ^(PlatformCall *c) {
    NSString *ident = [c string:@"id"] ?: @"";
    NSURL *url = handles[ident];
    if (url) {
      if (sandboxed()) [url stopAccessingSecurityScopedResource];
      [handles removeObjectForKey:ident];
    }
    [c ok:nil];
  });
}
