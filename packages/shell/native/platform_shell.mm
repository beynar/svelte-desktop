// shell.* — hand URLs/files to the OS.
#include "platform_internal.h"

void platform_register_shell(void) {
  platform_register(@"shell", @"openExternal", ^(PlatformCall *c) {
    NSURL *url = [NSURL URLWithString:[c string:@"url"] ?: @""];
    NSSet *allowed = [NSSet setWithArray:@[ @"http", @"https", @"mailto", @"tel", @"sms", @"facetime", @"maps" ]];
    if (!url || ![allowed containsObject:url.scheme.lowercaseString])
      return [c fail:@"invalid_args" message:@"shell.openExternal: only http(s)/mailto/tel/sms/facetime/maps URLs (use openPath for files)"];
    [NSWorkspace.sharedWorkspace openURL:url configuration:[NSWorkspaceOpenConfiguration configuration]
                       completionHandler:^(NSRunningApplication *, NSError *err) {
                         dispatch_async(dispatch_get_main_queue(), ^{
                           err ? [c fail:@"internal" message:err.localizedDescription] : [c ok:nil];
                         });
                       }];
  });
  platform_register(@"shell", @"openPath", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"].stringByExpandingTildeInPath;
    if (!path.length || ![NSFileManager.defaultManager fileExistsAtPath:path])
      return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"shell.openPath: no such file `%@`", path]];
    [NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:path] configuration:[NSWorkspaceOpenConfiguration configuration]
                       completionHandler:^(NSRunningApplication *, NSError *err) {
                         dispatch_async(dispatch_get_main_queue(), ^{
                           err ? [c fail:@"internal" message:err.localizedDescription] : [c ok:nil];
                         });
                       }];
  });
  platform_register(@"shell", @"showItemInFolder", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"].stringByExpandingTildeInPath;
    if (!path.length || ![NSFileManager.defaultManager fileExistsAtPath:path])
      return [c fail:@"invalid_args" message:[NSString stringWithFormat:@"shell.showItemInFolder: no such file `%@`", path]];
    [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[ [NSURL fileURLWithPath:path] ]];
    [c ok:nil];
  });
  platform_register(@"shell", @"trashItem", ^(PlatformCall *c) {
    NSString *path = [c string:@"path"].stringByExpandingTildeInPath;
    NSError *err = nil;
    if (!path.length || ![NSFileManager.defaultManager trashItemAtURL:[NSURL fileURLWithPath:path] resultingItemURL:nil error:&err])
      return [c fail:@"invalid_args" message:err.localizedDescription ?: @"shell.trashItem: `path` is required"];
    [c ok:nil];
  });
  platform_register(@"shell", @"beep", ^(PlatformCall *c) {
    NSBeep();
    [c ok:nil];
  });
}
