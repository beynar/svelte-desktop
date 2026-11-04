// Server-owned web policy. No challenge, identity or credential is broadcast to pages.
#include "platform_internal.h"
#include "platform_web_policy.h"
#import <Security/Security.h>
#import <CommonCrypto/CommonDigest.h>
#import <LocalAuthentication/LocalAuthentication.h>

static BOOL permissionHandler, authHandler;
static NSTimeInterval permissionTimeout = 15, authTimeout = 15;
static NSMutableDictionary<NSString *, void (^)(id)> *pendingPolicy;
static NSMutableSet<NSString *> *certificatePins;
static NSString *decisions_key(void) { return [@"SDWebPermissionDecisions.v1." stringByAppendingString:platform_app_identifier()]; }

static NSString *url_origin(NSURL *url) {
  NSString *scheme = url.scheme.lowercaseString;
  if (!url.host.length || ![@[@"http", @"https"] containsObject:scheme]) return nil;
  NSString *host = url.host.lowercaseString;
  if ([host containsString:@":"] && ![host hasPrefix:@"["]) host = [NSString stringWithFormat:@"[%@]", host];
  NSInteger port = url.port.integerValue;
  BOOL standard = !url.port || ([scheme isEqual:@"https"] ? port == 443 : port == 80);
  return [NSString stringWithFormat:@"%@://%@%@", scheme, host,
    standard ? @"" : [NSString stringWithFormat:@":%ld", (long)port]];
}
static NSString *security_origin(WKSecurityOrigin *origin) {
  if (!origin) return nil;
  NSString *host = origin.host;
  if ([host containsString:@":"] && ![host hasPrefix:@"["]) host = [NSString stringWithFormat:@"[%@]", host];
  NSString *port = origin.port ? [NSString stringWithFormat:@":%ld", (long)origin.port] : @"";
  return url_origin([NSURL URLWithString:[NSString stringWithFormat:@"%@://%@%@", origin.protocol, host, port]]);
}
static NSString *decision_key(NSString *origin, NSString *permission) { return [NSString stringWithFormat:@"%@\n%@", origin, permission]; }
static BOOL known_permission(NSString *p) { return [@[@"camera", @"microphone", @"location", @"speech", @"screenRecording"] containsObject:p]; }
static BOOL server_only(PlatformCall *c) {
  if (!c.callerWindow) return YES;
  [c fail:@"denied" message:@"Web policy is owned by server code, not pages"];
  return NO;
}
static void request_policy(NSString *event, NSDictionary *data, void (^done)(id)) {
  if (pendingPolicy.count >= 256) return done(nil);
  NSString *ident = NSUUID.UUID.UUIDString;
  pendingPolicy[ident] = [done copy];
  NSMutableDictionary *d = [data mutableCopy]; d[@"requestId"] = ident;
  shell_emit(@{@"type":@"platform", @"name":event, @"data":d});
  NSTimeInterval timeout = [event isEqual:@"webPermissionRequest"] ? permissionTimeout : authTimeout;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    void (^cb)(id) = pendingPolicy[ident];
    [pendingPolicy removeObjectForKey:ident];
    if (cb) cb(nil);
  });
}
static void permission_policy(WKWebView *view, NSString *site, NSDictionary *frame,
                              NSString *permission, void (^done)(NSString *)) {
  if (!site || !platform_webview_is_attached(view)) return done(@"deny");
  NSDictionary *saved = [NSUserDefaults.standardUserDefaults dictionaryForKey:decisions_key()];
  NSString *decision = saved[decision_key(site, permission)][@"decision"];
  if ([@[@"allow", @"deny", @"prompt"] containsObject:decision]) return done(decision);
  if (!permissionHandler) return done([site isEqual:url_origin([NSURL URLWithString:platform_app_origin()])] ? @"allow" : @"deny");
  NSMutableDictionary *d = [platform_lifecycle_target(view) mutableCopy];
  d[@"origin"] = site; d[@"permission"] = permission;
  d[@"frame"] = frame ?: (id)NSNull.null;
  WKWebView *__weak weak = view;
  NSString *navigation = view.URL.absoluteString ?: @"";
  request_policy(@"webPermissionRequest", d, ^(id answer) {
    WKWebView *current = weak;
    BOOL valid = platform_webview_is_attached(current) && [(current.URL.absoluteString ?: @"") isEqual:navigation];
    done(valid && [@[@"allow", @"deny", @"prompt"] containsObject:answer] ? answer : @"deny");
  });
}
void platform_web_permission(WKWebView *view, WKSecurityOrigin *origin, WKFrameInfo *frame,
                             NSString *permission, void (^done)(NSString *)) {
  NSString *site = security_origin(origin);
  if (!site || (frame && ![site isEqual:security_origin(frame.securityOrigin)])) return done(@"deny");
  NSDictionary *details = frame ? @{@"origin":site, @"url":frame.request.URL.absoluteString ?: @"", @"main":@(frame.mainFrame)} : nil;
  permission_policy(view, site, details, permission, done);
}
static NSString *fingerprint(SecCertificateRef certificate) {
  if (!certificate) return nil;
  NSData *der = CFBridgingRelease(SecCertificateCopyData(certificate));
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(der.bytes, (CC_LONG)der.length, digest);
  NSMutableString *out = [NSMutableString string];
  for (unsigned char byte : digest) [out appendFormat:@"%02x", byte];
  return out;
}
// Query without authorizing private-key use or opening Keychain UI. The credential keeps the
// selected identity alive only for its challenge; no private key is exported.
static NSDictionary<NSString *, id> *identities(OSStatus *error) {
  CFTypeRef result = NULL;
  LAContext *context = [LAContext new]; context.interactionNotAllowed = YES;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)@{(__bridge id)kSecClass:(__bridge id)kSecClassIdentity,
    (__bridge id)kSecReturnRef:@YES, (__bridge id)kSecMatchLimit:(__bridge id)kSecMatchLimitAll,
    (__bridge id)kSecUseAuthenticationContext:context}, &result);
  NSArray *items = CFBridgingRelease(result);
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  if (status != errSecSuccess) { if (error && status != errSecItemNotFound) *error = status; return out; }
  for (id item in items) {
    SecCertificateRef cert = NULL;
    if (SecIdentityCopyCertificate((__bridge SecIdentityRef)item, &cert) != errSecSuccess) continue;
    NSString *ident = fingerprint(cert); CFRelease(cert);
    if (ident) out[ident] = item;
  }
  return out;
}
static NSArray *identity_choices(NSDictionary *items) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSString *ident in items) {
    SecCertificateRef cert = NULL; SecIdentityCopyCertificate((__bridge SecIdentityRef)items[ident], &cert);
    NSString *label = cert ? CFBridgingRelease(SecCertificateCopySubjectSummary(cert)) : @"";
    if (cert) CFRelease(cert);
    [out addObject:@{@"identity":ident, @"fingerprint":ident, @"label":label ?: @""}];
  }
  return out;
}
static void auth_challenge(WKWebView *view, NSURLAuthenticationChallenge *challenge, BOOL evaluated, BOOL trusted,
                           void (^done)(NSURLSessionAuthChallengeDisposition, NSURLCredential *)) {
  if (!platform_webview_is_attached(view)) return done(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
  NSURLProtectionSpace *space = challenge.protectionSpace;
  NSString *host = space.host;
  if ([host containsString:@":"] && ![host hasPrefix:@"["]) host = [NSString stringWithFormat:@"[%@]", host];
  NSString *origin = url_origin([NSURL URLWithString:[NSString stringWithFormat:@"%@://%@:%ld", space.protocol ?: @"https", host, (long)space.port]]);
  if ([origin isEqual:url_origin([NSURL URLWithString:platform_app_origin()])]) return done(NSURLSessionAuthChallengePerformDefaultHandling, nil);
  NSString *rawMethod = space.authenticationMethod;
  NSDictionary *methods = @{NSURLAuthenticationMethodHTTPBasic:@"basic", NSURLAuthenticationMethodHTTPDigest:@"digest",
    NSURLAuthenticationMethodNTLM:@"ntlm", NSURLAuthenticationMethodClientCertificate:@"clientCertificate", NSURLAuthenticationMethodServerTrust:@"serverTrust"};
  NSString *method = methods[rawMethod];
  if (!method) return done(NSURLSessionAuthChallengePerformDefaultHandling, nil);
  BOOL tls = [method isEqual:@"serverTrust"];
  id trustOwner = (__bridge id)space.serverTrust;
  SecTrustRef trust = (__bridge SecTrustRef)trustOwner;
  NSArray *chain = tls && trust ? CFBridgingRelease(SecTrustCopyCertificateChain(trust)) : nil;
  NSString *sha = chain.count ? fingerprint((__bridge SecCertificateRef)chain.firstObject) : nil;
  NSString *pin = sha ? decision_key(space.host.lowercaseString, sha) : nil;
  // Pins apply to the challenged host and leaf certificate only, never an entire store/session.
  if (tls && pin && [certificatePins containsObject:pin]) return done(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:trust]);
  if (!authHandler) return done(NSURLSessionAuthChallengePerformDefaultHandling, nil);
  if (tls && trust && !evaluated) {
    // Trust evaluation can fetch intermediates; never perform it synchronously on the UI thread.
    OSStatus status = SecTrustEvaluateAsyncWithError(trust, dispatch_get_main_queue(), ^(SecTrustRef t, bool ok, CFErrorRef error) {
      auth_challenge(view, challenge, YES, ok, done);
    });
    if (status != errSecSuccess) done(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
    return;
  }
  if (tls && trusted) return done(NSURLSessionAuthChallengePerformDefaultHandling, nil);
  NSDictionary *available = [method isEqual:@"clientCertificate"] ? identities(NULL) : @{};
  NSArray *choices = identity_choices(available);
  NSMutableDictionary *d = [platform_lifecycle_target(view) mutableCopy];
  [d addEntriesFromDictionary:@{@"origin":origin ?: @"", @"host":space.host, @"port":@(space.port), @"realm":space.realm ?: @"",
    @"method":method, @"proxy":@([space isProxy]), @"previousFailures":@(challenge.previousFailureCount), @"identities":choices}];
  if (sha) d[@"fingerprint"] = sha;
  WKWebView *__weak weak = view; NSString *navigation = view.URL.absoluteString ?: @"";
  request_policy(@"webAuthChallenge", d, ^(id answer) {
    if (!platform_webview_is_attached(weak) || ![(weak.URL.absoluteString ?: @"") isEqual:navigation]) return done(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
    // A server may register this exact fingerprint while handling the challenge, then return default.
    if (tls) {
      SecTrustRef retainedTrust = (__bridge SecTrustRef)trustOwner;
      if ([answer isEqual:@"default"] && pin && [certificatePins containsObject:pin]) return done(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialForTrust:retainedTrust]);
      return done([answer isEqual:@"default"] ? NSURLSessionAuthChallengePerformDefaultHandling : NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
    }
    if ([answer isEqual:@"default"]) return done(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    if ([answer isKindOfClass:NSDictionary.class]) {
      NSString *identity = answer[@"identity"];
      if ([method isEqual:@"clientCertificate"] && [identity isKindOfClass:NSString.class] && available[identity])
        return done(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialWithIdentity:(__bridge SecIdentityRef)available[identity] certificates:nil persistence:NSURLCredentialPersistenceNone]);
      if ([@[@"basic", @"digest", @"ntlm"] containsObject:method] && [answer[@"username"] isKindOfClass:NSString.class] && [answer[@"password"] isKindOfClass:NSString.class])
        return done(NSURLSessionAuthChallengeUseCredential, [NSURLCredential credentialWithUser:answer[@"username"] password:answer[@"password"] persistence:NSURLCredentialPersistenceNone]);
    }
    done(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
  });
}
void platform_web_auth(WKWebView *view, NSURLAuthenticationChallenge *challenge,
                      void (^done)(NSURLSessionAuthChallengeDisposition, NSURLCredential *)) {
  auth_challenge(view, challenge, NO, NO, done);
}
void platform_register_web_policy(void) {
  pendingPolicy = [NSMutableDictionary dictionary]; certificatePins = [NSMutableSet set];
  platform_register(@"webview", @"configurePolicy", ^(PlatformCall *c) {
    if (!server_only(c)) return;
    NSString *kind = [c string:@"kind"];
    if (![@[@"permission", @"auth"] containsObject:kind]) return [c fail:@"invalid_args" message:@"Unknown policy kind"];
    double ms = [c number:@"timeoutMs" or:15000];
    if (!isfinite(ms) || ms < 50 || ms > 30000) return [c fail:@"invalid_args" message:@"timeoutMs must be 50–30000"];
    if ([kind isEqual:@"permission"]) { permissionTimeout = ms / 1000; permissionHandler = [c boolean:@"enabled" or:NO]; }
    else { authTimeout = ms / 1000; authHandler = [c boolean:@"enabled" or:NO]; }
    [c ok:nil];
  });
  platform_register(@"webview", @"respondPolicy", ^(PlatformCall *c) {
    if (!server_only(c)) return;
    NSString *ident = [c string:@"requestId"];
    void (^cb)(id) = nil;
    if (ident) cb = pendingPolicy[ident];
    if (!cb) return [c fail:@"unavailable" message:@"Policy request expired or was already answered"];
    [pendingPolicy removeObjectForKey:ident]; cb(c.args[@"answer"]); [c ok:nil];
  });
  platform_register_many(@"webview", @[@"listPermissionDecisions", @"setPermissionDecision", @"revokePermissionDecision"], ^(PlatformCall *c) {
    if (!server_only(c)) return;
    NSMutableDictionary *saved = [[NSUserDefaults.standardUserDefaults dictionaryForKey:decisions_key()] mutableCopy] ?: [NSMutableDictionary dictionary];
    if ([c.op isEqual:@"listPermissionDecisions"]) return [c ok:saved.allValues];
    NSString *site = url_origin([NSURL URLWithString:[c string:@"origin"] ?: @""]), *permission = [c string:@"permission"];
    if (!site || !known_permission(permission)) return [c fail:@"invalid_args" message:@"An HTTP(S) origin and web permission are required"];
    NSString *key = decision_key(site, permission);
    if ([c.op isEqual:@"revokePermissionDecision"]) [saved removeObjectForKey:key];
    else {
      NSString *decision = [c string:@"decision"];
      if (![@[@"allow", @"deny", @"prompt"] containsObject:decision]) return [c fail:@"invalid_args" message:@"Expected allow, deny or prompt"];
      saved[key] = @{@"origin":site, @"permission":permission, @"decision":decision};
    }
    [NSUserDefaults.standardUserDefaults setObject:saved forKey:decisions_key()]; [c ok:nil];
  });
  platform_register_many(@"webview", @[@"allowCertificate", @"revokeCertificate"], ^(PlatformCall *c) {
    if (!server_only(c)) return;
    NSString *host = [c string:@"host"], *sha = [[c string:@"fingerprint"] lowercaseString];
    NSCharacterSet *nonHex = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
    if (!host.length || [host containsString:@"/"] || [host containsString:@"*"] || !sha || sha.length != 64 || [sha rangeOfCharacterFromSet:nonHex].location != NSNotFound)
      return [c fail:@"invalid_args" message:@"An exact host and 64-character SHA-256 fingerprint are required"];
    NSString *key = decision_key(host.lowercaseString, sha);
    if ([c.op isEqual:@"allowCertificate"]) [certificatePins addObject:key]; else [certificatePins removeObject:key];
    [c ok:nil];
  });
  platform_register(@"webview", @"listClientIdentities", ^(PlatformCall *c) {
    if (!server_only(c)) return;
    OSStatus status = errSecSuccess;
    NSDictionary *items = identities(&status);
    if (status != errSecSuccess) return [c fail:@"unavailable" message:[NSString stringWithFormat:@"Keychain identities unavailable (%d)", (int)status]];
    [c ok:identity_choices(items)];
  });
}
