// notifications.* — UNUserNotificationCenter. Every entry point of that class
// raises NSInternalInconsistencyException when the process has no bundle
// identifier (running from `bun` instead of a .app), so each op checks
// NSBundle.mainBundle.bundleIdentifier first and fails `unavailable`.
// Events: notificationResponse {tag, actionId|null}.
#include "platform_internal.h"

#import <UserNotifications/UserNotifications.h>

static void on_main(dispatch_block_t block) {
  if (NSThread.isMainThread) block();
  else dispatch_async(dispatch_get_main_queue(), block);
}

static BOOL has_bundle(void) {
  return NSBundle.mainBundle.bundleIdentifier.length > 0;
}

static BOOL require_bundle(PlatformCall *call) {
  if (has_bundle()) return YES;
  [call fail:@"unavailable"
       message:[NSString stringWithFormat:@"%@.%@: notifications need a bundled app (NSBundle.mainBundle has no "
                                          @"bundleIdentifier when running from `bun`); run the packaged .app",
                                          call.service, call.op]];
  return NO;
}

static NSString *un_status(UNAuthorizationStatus s) {
  switch (s) {
    case UNAuthorizationStatusNotDetermined: return @"notDetermined";
    case UNAuthorizationStatusDenied: return @"denied";
    default: return @"granted"; // authorized, provisional (ephemeral is iOS)
  }
}

/// Shared with system.checkPermission / requestPermission ('notifications').
void platform_notifications_permission(PlatformCall *call, BOOL request) {
  if (!require_bundle(call)) return;
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  if (request) {
    [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge
                          completionHandler:^(BOOL granted, NSError *error) {
                            on_main(^{
                              if (granted) [call ok:@{@"status" : @"granted"}];
                              else if (error)
                                // A real error means the request never ran (unsigned app, ...).
                                [call fail:@"unavailable"
                                     message:[NSString stringWithFormat:@"%@.%@: %@", call.service, call.op,
                                                                        error.localizedDescription]];
                              else [call ok:@{@"status" : @"denied"}];
                            });
                          }];
  } else {
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
      on_main(^{ [call ok:@{@"status" : un_status(settings.authorizationStatus)}]; });
    }];
  }
}

// ---------------------------------------------------------------------------
// Delegate: foreground presentation + responses.

@interface SDNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation SDNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList |
                    UNNotificationPresentationOptionSound);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler {
  NSString *action = response.actionIdentifier;
  id actionId = [action isEqualToString:UNNotificationDefaultActionIdentifier] ? (id)NSNull.null : action;
  platform_emit(@"notificationResponse", @{@"tag" : response.notification.request.identifier ?: @"", @"actionId" : actionId});
  completionHandler();
}
@end

static SDNotificationDelegate *g_delegate;
static NSMutableDictionary<NSString *, UNNotificationCategory *> *g_categories;

// One category per distinct action set; we own every category of the app.
static NSString *category_for(NSArray *actions, NSString **error) {
  NSMutableArray<UNNotificationAction *> *list = [NSMutableArray array];
  NSMutableArray *key = [NSMutableArray array];
  for (id a in actions) {
    NSString *aid = [a isKindOfClass:NSDictionary.class] ? a[@"id"] : nil;
    NSString *label = [a isKindOfClass:NSDictionary.class] ? a[@"label"] : nil;
    if (![aid isKindOfClass:NSString.class] || ![label isKindOfClass:NSString.class] || !aid.length) {
      *error = @"notifications.show: each action needs string `id` and `label`";
      return nil;
    }
    [list addObject:[UNNotificationAction actionWithIdentifier:aid title:label options:UNNotificationActionOptionForeground]];
    [key addObject:[NSString stringWithFormat:@"%@=%@", aid, label]];
  }
  NSString *ident = [@"sd-actions:" stringByAppendingString:[key componentsJoinedByString:@"\x1f"]];
  if (!g_categories[ident]) {
    g_categories[ident] = [UNNotificationCategory categoryWithIdentifier:ident actions:list intentIdentifiers:@[] options:0];
    [UNUserNotificationCenter.currentNotificationCenter setNotificationCategories:[NSSet setWithArray:g_categories.allValues]];
  }
  return ident;
}

static void show(PlatformCall *call) {
  NSString *title = [call string:@"title"];
  if (!title) return [call fail:@"invalid_args" message:@"notifications.show: `title` must be a string"];
  if (!require_bundle(call)) return;
  NSString *tag = [call string:@"tag"];
  if (!tag.length) tag = @"default";
  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = title;
  if (NSString *body = [call string:@"body"]) content.body = body;
  if (NSString *subtitle = [call string:@"subtitle"]) content.subtitle = subtitle;
  if (![call boolean:@"silent" or:NO]) content.sound = UNNotificationSound.defaultSound;
  id actions = call.args[@"actions"];
  if ([actions isKindOfClass:NSArray.class] && [actions count]) {
    NSString *error = nil;
    NSString *category = category_for(actions, &error);
    if (!category) return [call fail:@"invalid_args" message:error];
    content.categoryIdentifier = category;
  }
  UNNotificationRequest *req = [UNNotificationRequest requestWithIdentifier:tag content:content trigger:nil];
  [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:req
                                                       withCompletionHandler:^(NSError *error) {
                                                         on_main(^{
                                                           if (!error) return [call ok:@{@"tag" : tag}];
                                                           BOOL denied = [error.domain isEqual:UNErrorDomain] &&
                                                                         error.code == UNErrorCodeNotificationsNotAllowed;
                                                           [call fail:denied ? @"denied" : @"internal"
                                                                message:[NSString stringWithFormat:@"notifications.show: %@",
                                                                                                   error.localizedDescription]];
                                                         });
                                                       }];
}

static void dismiss(PlatformCall *call) {
  NSString *tag = [call string:@"tag"];
  if (!tag) return [call fail:@"invalid_args" message:@"notifications.dismiss: `tag` must be a string"];
  if (!require_bundle(call)) return;
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  [center removeDeliveredNotificationsWithIdentifiers:@[ tag ]];
  [center removePendingNotificationRequestsWithIdentifiers:@[ tag ]];
  [call ok:nil];
}

void platform_register_notifications(void) {
  g_categories = [NSMutableDictionary dictionary];
  platform_register_many(@"notifications", @[ @"show", @"notify" ], ^(PlatformCall *call) { show(call); });
  platform_register_many(@"notifications", @[ @"dismiss", @"close" ], ^(PlatformCall *call) { dismiss(call); });
  platform_register(@"notifications", @"getPermissionStatus",
                    ^(PlatformCall *call) { platform_notifications_permission(call, NO); });
  platform_register(@"notifications", @"requestPermission",
                    ^(PlatformCall *call) { platform_notifications_permission(call, YES); });
  // The delegate must be in place early so a click that launched the app is
  // still delivered. The center holds it weakly.
  if (has_bundle()) {
    g_delegate = [SDNotificationDelegate new];
    UNUserNotificationCenter.currentNotificationCenter.delegate = g_delegate;
  }
}
