// Objective-C layer over kitop.h — compiled with an app's native/*.m when
// the plugin has no Swift files. The app defines:
//
//   void SDSetup(void) {
//     SDCommand(@"files.count", ^(NSDictionary *args, SDReply reply) {
//       reply(@([[NSFileManager.defaultManager contentsOfDirectoryAtPath:args[@"dir"] error:nil] count]), nil);
//     });
//   }
#import <Cocoa/Cocoa.h>
#include "kitop.h"

typedef void (^SDReply)(id _Nullable value, NSError *_Nullable error);
/// Register "service.op"; the block runs on the main thread, reply once (any thread).
void SDCommand(NSString *_Nonnull name, void (^_Nonnull handler)(NSDictionary *_Nonnull args, SDReply _Nonnull reply));
void SDEmit(NSString *_Nonnull event, id _Nullable data);
NSWindow *_Nullable SDWindow(int windowId);
/// Error with an kitop code (invalid_args, unavailable, …).
NSError *_Nonnull SDError(NSString *_Nonnull code, NSString *_Nonnull message);
/// Defined by the app.
void SDSetup(void);
