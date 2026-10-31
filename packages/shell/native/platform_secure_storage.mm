// secureStorage.* — Keychain generic passwords keyed by (service, account), and
// an LAContext owner-authentication prompt. SecItem calls can block on a
// Keychain access prompt, so they run on a private serial queue and reply on
// the main thread. Secrets never leave the reply of getPassword (no events,
// no error messages).
#include "platform_internal.h"

#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>

static dispatch_queue_t keychain_queue(void) {
  static dispatch_queue_t q;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ q = dispatch_queue_create("dev.svelte-desktop.keychain", DISPATCH_QUEUE_SERIAL); });
  return q;
}

static void on_main(dispatch_block_t block) {
  dispatch_async(dispatch_get_main_queue(), block);
}

static NSString *sec_message(OSStatus status) {
  CFStringRef msg = SecCopyErrorMessageString(status, NULL);
  NSString *s = msg ? [NSString stringWithFormat:@"%@ (OSStatus %d)", (__bridge_transfer NSString *)msg, (int)status]
                    : [NSString stringWithFormat:@"OSStatus %d", (int)status];
  return s;
}

static void fail_status(PlatformCall *call, NSString *op, OSStatus status) {
  BOOL denied = status == errSecUserCanceled || status == errSecAuthFailed || status == errSecInteractionNotAllowed ||
                status == errSecNoAccessForItem;
  [call fail:denied ? @"denied" : @"internal"
       message:[NSString stringWithFormat:@"secureStorage.%@: %@", op, sec_message(status)]];
}

static NSMutableDictionary *base_query(NSString *service, NSString *account) {
  NSMutableDictionary *q = [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : service,
  } mutableCopy];
  if (account) q[(__bridge id)kSecAttrAccount] = account;
  return q;
}

// Validates service (+ account when required). Returns NO after failing the call.
static BOOL read_key(PlatformCall *call, NSString *op, BOOL needAccount, NSString **service, NSString **account) {
  *service = [call string:@"service"];
  *account = [call string:@"account"];
  if (!(*service).length) {
    [call fail:@"invalid_args" message:[NSString stringWithFormat:@"secureStorage.%@: `service` must be a non-empty string", op]];
    return NO;
  }
  if (needAccount && !*account) {
    [call fail:@"invalid_args" message:[NSString stringWithFormat:@"secureStorage.%@: `account` must be a string", op]];
    return NO;
  }
  return YES;
}

static void set_password(PlatformCall *call) {
  NSString *service, *account;
  if (!read_key(call, @"setPassword", YES, &service, &account)) return;
  NSString *password = [call string:@"password"];
  if (!password) return [call fail:@"invalid_args" message:@"secureStorage.setPassword: `password` must be a string"];
  NSData *secret = [password dataUsingEncoding:NSUTF8StringEncoding];
  dispatch_async(keychain_queue(), ^{
    NSMutableDictionary *add = base_query(service, account);
    add[(__bridge id)kSecValueData] = secret;
    add[(__bridge id)kSecAttrLabel] = service;
    OSStatus st = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
    if (st == errSecDuplicateItem)
      st = SecItemUpdate((__bridge CFDictionaryRef)base_query(service, account),
                         (__bridge CFDictionaryRef) @{(__bridge id)kSecValueData : secret});
    on_main(^{
      if (st == errSecSuccess) [call ok:nil];
      else fail_status(call, @"setPassword", st);
    });
  });
}

static void get_password(PlatformCall *call) {
  NSString *service, *account;
  if (!read_key(call, @"getPassword", YES, &service, &account)) return;
  dispatch_async(keychain_queue(), ^{
    NSMutableDictionary *q = base_query(service, account);
    q[(__bridge id)kSecReturnData] = @YES;
    q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    CFTypeRef out = NULL;
    OSStatus st = SecItemCopyMatching((__bridge CFDictionaryRef)q, &out);
    NSData *data = st == errSecSuccess ? (__bridge_transfer NSData *)out : nil;
    on_main(^{
      if (st == errSecItemNotFound) return [call ok:nil];
      if (st != errSecSuccess) return fail_status(call, @"getPassword", st);
      NSString *s = [data isKindOfClass:NSData.class] ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
      if (!s) return [call fail:@"internal" message:@"secureStorage.getPassword: stored value is not UTF-8"];
      [call ok:s];
    });
  });
}

// account omitted -> every entry of the service.
static void delete_password(PlatformCall *call) {
  NSString *service, *account;
  if (!read_key(call, @"deletePassword", NO, &service, &account)) return;
  dispatch_async(keychain_queue(), ^{
    OSStatus st = errSecSuccess;
    // File-based keychains delete one match per call; loop (bounded) until none left.
    for (int i = 0; i < 256; i++) {
      st = SecItemDelete((__bridge CFDictionaryRef)base_query(service, account));
      if (st != errSecSuccess) break;
    }
    on_main(^{
      if (st == errSecSuccess || st == errSecItemNotFound) [call ok:nil];
      else fail_status(call, @"deletePassword", st);
    });
  });
}

static void authenticate(PlatformCall *call) {
  NSString *reason = [call string:@"reason"];
  if (!reason.length) reason = @"authenticate to continue";
  LAContext *ctx = [LAContext new];
  NSError *error = nil;
  if (![ctx canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error])
    return [call ok:@{@"authenticated" : @NO, @"reason" : error.localizedDescription ?: @"owner authentication unavailable"}];
  [ctx evaluatePolicy:LAPolicyDeviceOwnerAuthentication
      localizedReason:reason
                reply:^(BOOL success, NSError *err) {
                  (void)ctx; // keep the context alive until the reply
                  on_main(^{
                    if (success) [call ok:@{@"authenticated" : @YES}];
                    else [call ok:@{@"authenticated" : @NO, @"reason" : err.localizedDescription ?: @"authentication failed"}];
                  });
                }];
}

void platform_register_secure_storage(void) {
  platform_register(@"secureStorage", @"setPassword", ^(PlatformCall *call) { set_password(call); });
  platform_register(@"secureStorage", @"getPassword", ^(PlatformCall *call) { get_password(call); });
  platform_register(@"secureStorage", @"deletePassword", ^(PlatformCall *call) { delete_password(call); });
  platform_register(@"secureStorage", @"authenticate", ^(PlatformCall *call) { authenticate(call); });
}
