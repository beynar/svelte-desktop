// notifications.* and push.* — UNUserNotificationCenter + APNs (contract: NOTIFICATIONS.md).
// Every entry point of UNUserNotificationCenter raises NSInternalInconsistencyException
// when the process has no bundle identifier (running from `bun` instead of a .app), so
// each op checks NSBundle.mainBundle.bundleIdentifier first and fails `unavailable`.
// Events: notificationResponse, notificationShown, pushToken, pushMessage.
#include "platform_internal.h"

#import <Security/Security.h>
#import <UserNotifications/UserNotifications.h>
#import <objc/runtime.h>

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

static UNUserNotificationCenter *center(void) {
  return UNUserNotificationCenter.currentNotificationCenter;
}

static NSString *un_status(UNAuthorizationStatus s) {
  switch (s) {
    case UNAuthorizationStatusNotDetermined: return @"notDetermined";
    case UNAuthorizationStatusDenied: return @"denied";
    default: return @"granted"; // authorized, provisional (ephemeral is iOS)
  }
}

static void request_authorization(void (^done)(NSString *status, NSError *error)) {
  [center() requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge
                          completionHandler:^(BOOL granted, NSError *error) {
                            on_main(^{ done(granted ? @"granted" : @"denied", granted ? nil : error); });
                          }];
}

/// Shared with system.checkPermission / requestPermission ('notifications').
void platform_notifications_permission(PlatformCall *call, BOOL request) {
  if (!require_bundle(call)) return;
  if (request) {
    request_authorization(^(NSString *status, NSError *error) {
      // A real error means the request never ran (unsigned app, ...).
      if (error)
        return [call fail:@"unavailable"
                  message:[NSString stringWithFormat:@"%@.%@: %@", call.service, call.op, error.localizedDescription]];
      [call ok:@{@"status" : status}];
    });
  } else {
    [center() getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
      on_main(^{ [call ok:@{@"status" : un_status(settings.authorizationStatus)}]; });
    }];
  }
}

// ---------------------------------------------------------------------------
// Responses: targeting, claim queue, ring.

static NSInteger g_seq;
static NSMutableArray<NSDictionary *> *g_ring;      // last 64 responses
static NSMutableArray<NSDictionary *> *g_unclaimed; // responses no page has handled
static BOOL g_foreground = YES;

static NSString *json_text(id obj) {
  if ([obj isKindOfClass:NSString.class]) return obj;
  if (!obj || obj == NSNull.null || ![NSJSONSerialization isValidJSONObject:obj]) return nil;
  NSData *d = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  return d ? [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] : nil;
}

/// The payload of a notification: ours (`sd`), or a push's `sd` (string or object).
static NSString *payload_of(NSDictionary *userInfo) {
  return json_text(userInfo[@"sd"]);
}

static void bring_to_front(int wid) {
  NSWindow *w = platform_window(wid);
  if (!w) return;
  if (w.miniaturized) [w deminiaturize:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [w makeKeyAndOrderFront:nil];
}

static void deliver_response(NSDictionary *base, int origin, BOOL activates, BOOL cold = NO) {
  NSMutableDictionary *r = [base mutableCopy];
  r[@"seq"] = @(++g_seq);
  r[@"tag"] = r[@"id"];
  [g_ring addObject:r];
  if (g_ring.count > 64) [g_ring removeObjectAtIndex:0];
  int target = cold ? 0 : platform_target_window(origin);
  if (!target) [g_unclaimed addObject:r];
  // No loaded window (quitOnLastWindowClosed: false and the main one was closed): open it; its page
  // claims the click. A hidden one is a target already (bring_to_front shows it).
  if (!target && activates) platform_show_main_window();
  else if (activates) bring_to_front(target);
  platform_emit_targeted(@"notificationResponse", r, target);
}

// ---------------------------------------------------------------------------
// Delegate: foreground presentation + responses.

static BOOL is_push(UNNotification *n) {
  return [n.request.trigger isKindOfClass:UNPushNotificationTrigger.class];
}

static NSDictionary *push_message(NSDictionary *userInfo, UNNotificationContent *content, BOOL foreground) {
  NSMutableDictionary *data = [NSMutableDictionary dictionary];
  for (id k in userInfo)
    if (![k isEqual:@"aps"] && [NSJSONSerialization isValidJSONObject:@{@"v" : userInfo[k]}]) data[[k description]] = userInfo[k];
  NSMutableDictionary *m = [@{@"data" : data, @"foreground" : @(foreground)} mutableCopy];
  if (NSString *p = payload_of(userInfo)) m[@"payload"] = p;
  if (content.title.length || content.body.length) m[@"notification"] = @{@"title" : content.title ?: @"", @"body" : content.body ?: @""};
  return m;
}

@interface SDNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation SDNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)c
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  NSDictionary *info = notification.request.content.userInfo;
  BOOL push = is_push(notification);
  NSString *payload = payload_of(info);
  on_main(^{
    NSMutableDictionary *shown = [@{@"id" : notification.request.identifier, @"push" : @(push)} mutableCopy];
    if (payload) shown[@"payload"] = payload;
    platform_emit(@"notificationShown", shown);
    if (push) {
      NSMutableDictionary *m = [push_message(info, notification.request.content, YES) mutableCopy];
      m[@"id"] = notification.request.identifier;
      platform_emit(@"pushMessage", m);
    }
  });
  NSNumber *own = info[@"sdf"];
  BOOL show = [own isKindOfClass:NSNumber.class] ? own.boolValue : g_foreground;
  completionHandler(show ? UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList | UNNotificationPresentationOptionSound
                         : UNNotificationPresentationOptionNone);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)c
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler {
  UNNotificationRequest *req = response.notification.request;
  NSString *action = response.actionIdentifier;
  NSMutableDictionary *r = [@{@"id" : req.identifier ?: @"", @"actionId" : NSNull.null} mutableCopy];
  if ([action isEqualToString:UNNotificationDefaultActionIdentifier]) r[@"kind"] = @"click";
  else if ([action isEqualToString:UNNotificationDismissActionIdentifier]) r[@"kind"] = @"dismiss";
  else {
    r[@"actionId"] = action;
    r[@"kind"] = @"action";
    if ([response isKindOfClass:UNTextInputNotificationResponse.class]) {
      r[@"kind"] = @"reply";
      r[@"input"] = ((UNTextInputNotificationResponse *)response).userText ?: @"";
    }
  }
  NSDictionary *info = req.content.userInfo;
  if (NSString *p = payload_of(info)) r[@"payload"] = p;
  NSNumber *origin = info[@"sdw"];
  NSArray *background = info[@"sdb"]; // action ids that don't bring the app forward
  BOOL activates = ![r[@"kind"] isEqual:@"dismiss"] && !([background isKindOfClass:NSArray.class] && [background containsObject:action]);
  on_main(^{
    deliver_response(r, [origin isKindOfClass:NSNumber.class] ? origin.intValue : 0, activates);
    completionHandler();
  });
}
@end

static SDNotificationDelegate *g_delegate;
static NSMutableDictionary<NSString *, UNNotificationCategory *> *g_categories;
static NSString *const kPlainCategory = @"sd-plain"; // no actions, still reports dismissals

static void install_categories(void) {
  [center() setNotificationCategories:[NSSet setWithArray:g_categories.allValues]];
}

// Action sets of notifications that may outlive this process (scheduled ones): persisted, so
// their buttons exist again after a relaunch. Bounded; the oldest go first.
static NSString *const kCategoriesKey = @"svelte-desktop.notificationCategories";
static const NSUInteger kMaxStoredCategories = 64;

// One category per distinct action set; we own every category of the app.
static NSString *category_for(NSArray *actions, NSMutableArray *background, NSString **error) {
  NSMutableArray<UNNotificationAction *> *list = [NSMutableArray array];
  NSMutableArray *key = [NSMutableArray array];
  for (id a in actions) {
    NSDictionary *d = [a isKindOfClass:NSDictionary.class] ? a : nil;
    NSString *aid = d[@"id"];
    NSString *title = d[@"title"] ?: d[@"label"];
    if (![aid isKindOfClass:NSString.class] || ![title isKindOfClass:NSString.class] || !aid.length) {
      *error = @"notifications.show: each action needs string `id` and `title`";
      return nil;
    }
    UNNotificationActionOptions options = 0;
    BOOL fg = ![d[@"foreground"] isEqual:@NO];
    if (fg) options |= UNNotificationActionOptionForeground;
    else [background addObject:aid];
    if ([d[@"destructive"] isEqual:@YES]) options |= UNNotificationActionOptionDestructive;
    id input = d[@"input"];
    UNNotificationAction *action;
    if (input && input != NSNull.null && ![input isEqual:@NO]) {
      NSDictionary *in = [input isKindOfClass:NSDictionary.class] ? input : @{};
      NSString *button = [in[@"button"] isKindOfClass:NSString.class] ? in[@"button"] : title;
      NSString *placeholder = [in[@"placeholder"] isKindOfClass:NSString.class] ? in[@"placeholder"] : @"";
      action = [UNTextInputNotificationAction actionWithIdentifier:aid title:title options:options textInputButtonTitle:button textInputPlaceholder:placeholder];
    } else {
      action = [UNNotificationAction actionWithIdentifier:aid title:title options:options];
    }
    [list addObject:action];
    [key addObject:[NSString stringWithFormat:@"%@=%@=%lu=%@", aid, title, (unsigned long)options, json_text(input) ?: @""]];
  }
  NSString *ident = [@"sd-actions:" stringByAppendingString:[key componentsJoinedByString:@"\x1f"]];
  if (!g_categories[ident]) {
    g_categories[ident] = [UNNotificationCategory categoryWithIdentifier:ident
                                                                 actions:list
                                                       intentIdentifiers:@[]
                                                                 options:UNNotificationCategoryOptionCustomDismissAction];
    install_categories();
    NSMutableArray *stored = [[NSUserDefaults.standardUserDefaults arrayForKey:kCategoriesKey] ?: @[] mutableCopy];
    [stored addObject:actions];
    while (stored.count > kMaxStoredCategories) [stored removeObjectAtIndex:0];
    [NSUserDefaults.standardUserDefaults setObject:stored forKey:kCategoriesKey];
  }
  return ident;
}

static void restore_categories(void) {
  for (id actions in [NSUserDefaults.standardUserDefaults arrayForKey:kCategoriesKey]) {
    NSString *error = nil;
    if ([actions isKindOfClass:NSArray.class]) category_for(actions, [NSMutableArray array], &error);
  }
}

static NSArray *const kRepeats = @[ @"minute", @"hour", @"day", @"week", @"month", @"year" ];

static UNNotificationTrigger *trigger_for(double atMs, NSString *repeat) {
  NSDate *at = [NSDate dateWithTimeIntervalSince1970:atMs / 1000];
  NSCalendar *cal = NSCalendar.currentCalendar;
  if (!repeat) {
    NSTimeInterval delta = MAX(at.timeIntervalSinceNow, 0.1);
    return [UNTimeIntervalNotificationTrigger triggerWithTimeInterval:delta repeats:NO];
  }
  // Repeat from `at`: keep the components below the period.
  NSCalendarUnit units = NSCalendarUnitSecond;
  if (![repeat isEqual:@"minute"]) units |= NSCalendarUnitMinute;
  if ([repeat isEqual:@"day"] || [repeat isEqual:@"week"] || [repeat isEqual:@"month"] || [repeat isEqual:@"year"]) units |= NSCalendarUnitHour;
  if ([repeat isEqual:@"week"]) units |= NSCalendarUnitWeekday;
  if ([repeat isEqual:@"month"] || [repeat isEqual:@"year"]) units |= NSCalendarUnitDay;
  if ([repeat isEqual:@"year"]) units |= NSCalendarUnitMonth;
  return [UNCalendarNotificationTrigger triggerWithDateMatchingComponents:[cal components:units fromDate:at] repeats:YES];
}

/// Image bytes from a local path, file:// URL or data: URL.
static NSData *image_bytes(NSString *src, NSString **ext) {
  if ([src hasPrefix:@"data:"]) {
    NSRange comma = [src rangeOfString:@","];
    if (comma.location == NSNotFound) return nil;
    NSString *meta = [src substringWithRange:NSMakeRange(5, comma.location - 5)];
    NSString *mime = [meta componentsSeparatedByString:@";"].firstObject;
    NSString *sub = [mime componentsSeparatedByString:@"/"].lastObject;
    *ext = [sub isEqual:@"jpeg"] ? @"jpg" : [sub isEqual:@"svg+xml"] ? @"svg" : sub.length ? sub : @"png";
    NSString *body = [src substringFromIndex:comma.location + 1];
    if ([meta hasSuffix:@";base64"]) return [[NSData alloc] initWithBase64EncodedString:body options:NSDataBase64DecodingIgnoreUnknownCharacters];
    return [body.stringByRemovingPercentEncoding dataUsingEncoding:NSUTF8StringEncoding];
  }
  NSString *path = [src hasPrefix:@"file:"] ? [NSURL URLWithString:src].path : src;
  *ext = path.pathExtension.length ? path.pathExtension : @"png";
  return [NSData dataWithContentsOfFile:path];
}

static UNNotificationAttachment *attachment_for(NSData *bytes, NSString *ext, NSString *src, NSString **error) {
  // The center moves the file into its store: hand it a file of our own.
  if (!bytes.length) {
    *error = [NSString stringWithFormat:@"notifications.show: image %@ could not be read", [src substringToIndex:MIN(src.length, (NSUInteger)80)]];
    return nil;
  }
  NSString *file = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"sd-notification-%@.%@", NSUUID.UUID.UUIDString, ext]];
  NSError *e = nil;
  if (![bytes writeToFile:file options:NSDataWritingAtomic error:&e]) {
    *error = [NSString stringWithFormat:@"notifications.show: image: %@", e.localizedDescription];
    return nil;
  }
  UNNotificationAttachment *a = [UNNotificationAttachment attachmentWithIdentifier:@"image" URL:[NSURL fileURLWithPath:file] options:nil error:&e];
  if (!a) *error = [NSString stringWithFormat:@"notifications.show: image: %@", e.localizedDescription];
  return a;
}

static void post(PlatformCall *call, NSString *ident, UNMutableNotificationContent *content, NSString *repeat);

static void show(PlatformCall *call) {
  NSString *title = [call string:@"title"];
  if (!title) return [call fail:@"invalid_args" message:@"notifications.show: `title` must be a string"];
  if (!require_bundle(call)) return;
  NSString *ident = [call string:@"id"] ?: [call string:@"tag"];
  if (!ident.length) ident = NSUUID.UUID.UUIDString;
  NSString *repeat = [call string:@"repeat"];
  if (repeat && ![kRepeats containsObject:repeat])
    return [call fail:@"invalid_args" message:@"notifications.show: `repeat` must be minute|hour|day|week|month|year"];
  if (repeat && ![call has:@"at"]) return [call fail:@"invalid_args" message:@"notifications.show: `repeat` needs `at`"];

  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = title;
  if (NSString *body = [call string:@"body"] ?: [call string:@"message"]) content.body = body;
  if (NSString *subtitle = [call string:@"subtitle"]) content.subtitle = subtitle;
  if (NSString *group = [call string:@"group"]) content.threadIdentifier = group;
  if ([call has:@"badge"]) content.badge = @((NSInteger)[call number:@"badge" or:0]);
  if (![call boolean:@"silent" or:NO]) {
    NSString *sound = [call string:@"sound"];
    content.sound = !sound || [sound isEqual:@"default"] ? UNNotificationSound.defaultSound : [UNNotificationSound soundNamed:sound];
  }
  if (@available(macOS 12.0, *)) {
    NSString *urgency = [call string:@"urgency"];
    if ([urgency isEqual:@"low"]) content.interruptionLevel = UNNotificationInterruptionLevelPassive;
    else if ([urgency isEqual:@"critical"]) content.interruptionLevel = UNNotificationInterruptionLevelTimeSensitive;
  }
  NSMutableDictionary *info = [NSMutableDictionary dictionary];
  if (NSString *payload = [call string:@"payload"]) info[@"sd"] = payload;
  int origin = call.callerWindow;
  if (origin) info[@"sdw"] = @(origin);
  if ([call has:@"foreground"]) info[@"sdf"] = @([call boolean:@"foreground" or:YES]);
  if (repeat) info[@"sdr"] = repeat;
  NSString *error = nil;
  id actions = call.args[@"actions"];
  NSMutableArray *background = [NSMutableArray array];
  if ([actions isKindOfClass:NSArray.class] && [actions count]) {
    NSString *category = category_for(actions, background, &error);
    if (!category) return [call fail:@"invalid_args" message:error];
    content.categoryIdentifier = category;
  } else {
    content.categoryIdentifier = kPlainCategory;
  }
  if (background.count) info[@"sdb"] = background;
  content.userInfo = info;
  NSString *image = [call string:@"image"]; // a path, file: or data: URL (TS resolves the others)
  if (image) {
    NSString *ext = nil;
    UNNotificationAttachment *a = attachment_for(image_bytes(image, &ext), ext, image, &error);
    if (!a) return [call fail:@"invalid_args" message:error];
    content.attachments = @[ a ];
  }
  post(call, ident, content, repeat);
}

static void post(PlatformCall *call, NSString *ident, UNMutableNotificationContent *content, NSString *repeat) {
  BOOL scheduled = [call has:@"at"] && ([call number:@"at" or:0] / 1000 > NSDate.date.timeIntervalSince1970 + 0.5 || repeat);
  UNNotificationTrigger *trigger = scheduled ? trigger_for([call number:@"at" or:0], repeat) : nil;
  // A calendar repeat has no start date: it would fire at its next match, before `at`. Refuse
  // instead of firing early (start it within one period of `at`, or schedule the first one alone).
  if (repeat && [trigger isKindOfClass:UNCalendarNotificationTrigger.class]) {
    NSDate *next = [(UNCalendarNotificationTrigger *)trigger nextTriggerDate];
    if (next && next.timeIntervalSince1970 * 1000 < [call number:@"at" or:0] - 1000)
      return [call fail:@"invalid_args"
                message:[NSString stringWithFormat:@"notifications.show: on Apple platforms a `%@` repeat starts at its next occurrence (%@), "
                                                   @"before `at` — use an `at` within one %@ from now",
                                                   repeat, next, repeat]];
  }
  UNNotificationRequest *req = [UNNotificationRequest requestWithIdentifier:ident content:content trigger:trigger];
  // Same identifier = replaced (dedupe) — for a pending one too, but clear a delivered
  // copy when the new one is only scheduled, so the old one doesn't linger.
  if (scheduled) [center() removeDeliveredNotificationsWithIdentifiers:@[ ident ]];
  [center() addNotificationRequest:req
             withCompletionHandler:^(NSError *e) {
               on_main(^{
                 if (!e) return [call ok:@{@"id" : ident, @"tag" : ident, @"scheduled" : @(scheduled)}];
                 BOOL denied = [e.domain isEqual:UNErrorDomain] && e.code == UNErrorCodeNotificationsNotAllowed;
                 [call fail:denied ? @"denied" : @"internal"
                    message:[NSString stringWithFormat:@"notifications.show: %@", e.localizedDescription]];
               });
             }];
}

static NSMutableDictionary *describe(UNNotificationRequest *req) {
  UNNotificationContent *c = req.content;
  NSMutableDictionary *d = [@{@"id" : req.identifier, @"title" : c.title ?: @"", @"body" : c.body ?: @""} mutableCopy];
  if (c.subtitle.length) d[@"subtitle"] = c.subtitle;
  if (c.threadIdentifier.length) d[@"group"] = c.threadIdentifier;
  if (NSString *p = payload_of(c.userInfo)) d[@"payload"] = p;
  return d;
}

static void dismiss(PlatformCall *call) {
  NSString *ident = [call string:@"id"] ?: [call string:@"tag"];
  if (!ident) return [call fail:@"invalid_args" message:@"notifications.dismiss: `id` must be a string"];
  if (!require_bundle(call)) return;
  [center() removeDeliveredNotificationsWithIdentifiers:@[ ident ]];
  [center() removePendingNotificationRequestsWithIdentifiers:@[ ident ]];
  [call ok:nil];
}

// ---------------------------------------------------------------------------
// push.* — APNs. Needs the aps-environment entitlement (push.apns in desktop.config)
// and a provisioning profile that enables Push Notifications.

static NSString *aps_environment(void) {
  SecTaskRef task = SecTaskCreateFromSelf(NULL);
  if (!task) return nil;
  CFTypeRef v = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.developer.aps-environment"), NULL);
  CFRelease(task);
  id value = CFBridgingRelease(v);
  return [value isKindOfClass:NSString.class] ? value : nil;
}

static NSMutableArray<PlatformCall *> *g_register_calls;
static BOOL g_wants_push; // false after unregister: a late token is dropped
static NSString *g_token;

static NSString *hex(NSData *data) {
  NSMutableString *s = [NSMutableString stringWithCapacity:data.length * 2];
  const unsigned char *b = (const unsigned char *)data.bytes;
  for (NSUInteger i = 0; i < data.length; i++) [s appendFormat:@"%02x", b[i]];
  return s;
}

static NSDictionary *token_value(void) {
  return @{@"provider" : @"apns", @"token" : g_token, @"topic" : NSBundle.mainBundle.bundleIdentifier ?: @"",
           @"environment" : aps_environment() ?: @"development"};
}

static void finish_register(NSDictionary *value, NSString *error) {
  NSArray *calls = [g_register_calls copy];
  [g_register_calls removeAllObjects];
  for (PlatformCall *c in calls) {
    if (value) [c ok:value];
    else [c fail:@"unavailable" message:[@"push.register: " stringByAppendingString:error]];
  }
}

// The app delegate belongs to the webview library: add the remote-notification
// callbacks to its class (once).
static void install_app_delegate_hooks(void) {
  static BOOL done = NO;
  id<NSApplicationDelegate> delegate = NSApp.delegate;
  if (done || !delegate) return;
  done = YES;
  Class cls = [delegate class];
  class_addMethod(cls, @selector(application:didRegisterForRemoteNotificationsWithDeviceToken:),
                  imp_implementationWithBlock(^(id, NSApplication *, NSData *token) {
                    if (!g_wants_push) return [NSApp unregisterForRemoteNotifications];
                    NSString *t = hex(token);
                    BOOL changed = ![t isEqual:g_token];
                    g_token = t;
                    if (changed) platform_emit(@"pushToken", @{@"provider" : @"apns", @"token" : t});
                    finish_register(token_value(), nil);
                  }),
                  "v@:@@");
  class_addMethod(cls, @selector(application:didFailToRegisterForRemoteNotificationsWithError:),
                  imp_implementationWithBlock(^(id, NSApplication *, NSError *error) {
                    finish_register(nil, error.localizedDescription);
                  }),
                  "v@:@@");
  // Data (content-available) pushes while running; alert pushes go through willPresent.
  class_addMethod(cls, @selector(application:didReceiveRemoteNotification:),
                  imp_implementationWithBlock(^(id, NSApplication *, NSDictionary *userInfo) {
                    NSDictionary *aps = userInfo[@"aps"];
                    if ([aps isKindOfClass:NSDictionary.class] && aps[@"alert"]) return;
                    NSMutableDictionary *m = [push_message(userInfo, nil, NSApp.isActive) mutableCopy];
                    if ([userInfo[@"sd_id"] isKindOfClass:NSString.class]) m[@"id"] = userInfo[@"sd_id"];
                    platform_emit(@"pushMessage", m);
                  }),
                  "v@:@@");
}

static void push_register(PlatformCall *call) {
  if (!require_bundle(call)) return;
  NSString *env = aps_environment();
  if (!env)
    return [call fail:@"unavailable"
              message:@"push.register: the app has no aps-environment entitlement — set `push.apns` in desktop.config and "
                      @"sign with a provisioning profile that enables Push Notifications (sign.provisioningProfile)"];
  g_wants_push = YES;
  if (g_token) return [call ok:token_value()];
  [g_register_calls addObject:call];
  if (g_register_calls.count > 1) return;
  install_app_delegate_hooks();
  request_authorization(^(NSString *status, NSError *error) {
    // Alerts may be refused: a token still allows silent pushes.
    [NSApp registerForRemoteNotifications];
  });
}

void platform_register_notifications(void) {
  g_categories = [NSMutableDictionary dictionary];
  g_ring = [NSMutableArray array];
  g_unclaimed = [NSMutableArray array];
  g_register_calls = [NSMutableArray array];
  g_categories[kPlainCategory] = [UNNotificationCategory categoryWithIdentifier:kPlainCategory
                                                                        actions:@[]
                                                              intentIdentifiers:@[]
                                                                        options:UNNotificationCategoryOptionCustomDismissAction];
  platform_register_many(@"notifications", @[ @"show", @"notify" ], ^(PlatformCall *call) { show(call); });
  platform_register_many(@"notifications", @[ @"dismiss", @"close" ], ^(PlatformCall *call) { dismiss(call); });
  platform_register(@"notifications", @"dismissAll", ^(PlatformCall *call) {
    if (!require_bundle(call)) return;
    [center() removeAllDeliveredNotifications];
    [center() removeAllPendingNotificationRequests];
    [call ok:nil];
  });
  platform_register(@"notifications", @"delivered", ^(PlatformCall *call) {
    if (!require_bundle(call)) return;
    [center() getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *list) {
      NSMutableArray *out = [NSMutableArray array];
      for (UNNotification *n in list) {
        NSMutableDictionary *d = describe(n.request);
        d[@"date"] = @((long long)(n.date.timeIntervalSince1970 * 1000));
        [out addObject:d];
      }
      on_main(^{ [call ok:out]; });
    }];
  });
  platform_register(@"notifications", @"pending", ^(PlatformCall *call) {
    if (!require_bundle(call)) return;
    [center() getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *list) {
      NSMutableArray *out = [NSMutableArray array];
      for (UNNotificationRequest *req in list) {
        NSMutableDictionary *d = describe(req);
        NSDate *next = nil;
        if ([req.trigger isKindOfClass:UNCalendarNotificationTrigger.class]) next = [(UNCalendarNotificationTrigger *)req.trigger nextTriggerDate];
        else if ([req.trigger isKindOfClass:UNTimeIntervalNotificationTrigger.class]) next = [(UNTimeIntervalNotificationTrigger *)req.trigger nextTriggerDate];
        if (next) d[@"at"] = @((long long)(next.timeIntervalSince1970 * 1000));
        if (NSString *r = req.content.userInfo[@"sdr"]) d[@"repeat"] = r;
        [out addObject:d];
      }
      on_main(^{ [call ok:out]; });
    }];
  });
  platform_register(@"notifications", @"claim", ^(PlatformCall *call) {
    // Windows only: popover and embedded pages start too, they don't own app navigation.
    if (call.callerWindow && !platform_window(call.callerWindow)) return [call ok:@[]];
    NSArray *out = [g_unclaimed copy];
    [g_unclaimed removeAllObjects];
    if (out.count && call.callerWindow) bring_to_front(call.callerWindow);
    [call ok:out];
  });
  platform_register(@"notifications", @"responses", ^(PlatformCall *call) { [call ok:[g_ring copy]]; });
  platform_register(@"notifications", @"setBadge", ^(PlatformCall *call) {
    double n = [call number:@"count" or:0];
    NSApp.dockTile.badgeLabel = n > 0 ? [NSString stringWithFormat:@"%lld", (long long)n] : nil;
    [call ok:nil];
  });
  platform_register(@"notifications", @"setForeground", ^(PlatformCall *call) {
    g_foreground = [call boolean:@"show" or:YES];
    [call ok:nil];
  });
  platform_register(@"notifications", @"getPermissionStatus",
                    ^(PlatformCall *call) { platform_notifications_permission(call, NO); });
  platform_register(@"notifications", @"requestPermission",
                    ^(PlatformCall *call) { platform_notifications_permission(call, YES); });

  // e2e tests (launch() sets SVELTE_DESKTOP_TEST): a user response to a delivered
  // notification, through the same path as a real one. `cold`: as if no page was loaded.
  // Same condition as the test channel (which already drives the app): ws://127.0.0.1:<port>.
  const char *test = getenv("SVELTE_DESKTOP_TEST");
  if (test && !strncmp(test, "ws://127.0.0.1:", 15))
    platform_register(@"notifications", @"simulateResponse", ^(PlatformCall *call) {
      if (!require_bundle(call)) return;
      NSString *ident = [call string:@"id"] ?: @"";
      [center() getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *list) {
        on_main(^{
          NSDictionary *info = @{};
          for (UNNotification *n in list)
            if ([n.request.identifier isEqual:ident]) info = n.request.content.userInfo;
          NSString *action = [call string:@"actionId"];
          NSString *input = [call string:@"input"];
          NSMutableDictionary *r = [@{@"id" : ident, @"actionId" : action ?: NSNull.null} mutableCopy];
          r[@"kind"] = [call string:@"kind"] ?: (input ? @"reply" : action ? @"action" : @"click");
          if (input) r[@"input"] = input;
          if (NSString *p = payload_of(info)) r[@"payload"] = p;
          NSNumber *origin = info[@"sdw"];
          // Like a real click: anything but a dismissal brings the app forward.
          deliver_response(r, [origin isKindOfClass:NSNumber.class] ? origin.intValue : 0, ![r[@"kind"] isEqual:@"dismiss"], [call boolean:@"cold" or:NO]);
          [call ok:r];
        });
      }];
    });

  platform_register(@"push", @"register", ^(PlatformCall *call) { push_register(call); });
  platform_register(@"push", @"unregister", ^(PlatformCall *call) {
    g_wants_push = NO;
    finish_register(nil, @"unregistered while registering");
    [NSApp unregisterForRemoteNotifications];
    g_token = nil;
    [call ok:nil];
  });
  platform_register(@"push", @"token", ^(PlatformCall *call) { [call ok:g_token ? token_value() : nil]; });

  // The delegate must be in place early so a click that launched the app is
  // still delivered. The center holds it weakly.
  if (has_bundle()) {
    g_delegate = [SDNotificationDelegate new];
    center().delegate = g_delegate;
    restore_categories();
    install_categories();
  }
}
