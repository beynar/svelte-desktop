// Website stores own cookies and proxy policy. Views select a store before construction.
#include "platform_internal.h"
#include "platform_sessions.h"
#import <CommonCrypto/CommonDigest.h>
#import <Network/Network.h>
#import <objc/runtime.h>
#include <cmath>
#include <new>
#include "portable/reload_budget.hpp"

static NSString *const gateCookie = @"__kitop";
static NSMutableDictionary *sessions;
static NSMapTable<NSNumber *, WKWebView *> *views;
static NSString *creatingSession;
static char targetKey, recoveryKey, navigationKey, navigationsKey, windowKey, terminatedKey, recoveryURLKey, loadKey, reloadsKey, gaveUpKey;

static void provision_app_cookie(WKWebsiteDataStore *store, void (^done)(NSArray<NSHTTPCookie *> *, NSString *)) {
  // Vite serves dev pages directly, without the packaged app's loopback gate.
  if (getenv("KITOP_DEV")) {
    [store.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) { done(cookies, nil); }];
    return;
  }
  [WKWebsiteDataStore.defaultDataStore.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    NSHTTPCookie *gate = nil;
    NSString *host = [NSURL URLWithString:platform_app_origin()].host;
    for (NSHTTPCookie *cookie in cookies) if ([cookie.name isEqual:gateCookie] && [cookie.domain isEqual:host]) { gate = cookie; break; }
    if (!gate) return done(nil, @"App authentication is not ready");
    [store.httpCookieStore setCookie:gate completionHandler:^{
      [store.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *initial) {
        for (NSHTTPCookie *cookie in initial)
          if ([cookie.name isEqual:gateCookie] && [cookie.domain isEqual:gate.domain] && [cookie.path isEqual:gate.path] && [cookie.value isEqual:gate.value]) return done(initial, nil);
        done(nil, @"WebKit did not retain the app authentication cookie");
      }];
    }];
  }];
}

@interface SDSession : NSObject <WKHTTPCookieStoreObserver>
@property(nonatomic, copy) NSString *ident;
@property(nonatomic, strong) WKWebsiteDataStore *store;
@property(nonatomic, strong) NSUUID *uuid;
@property(nonatomic, strong) NSDictionary *proxy;
@property(nonatomic, strong) NSDictionary<NSString *, NSDictionary *> *snapshot;
@property(nonatomic) BOOL reading, dirty, removing;
@property(nonatomic) NSUInteger pending;
- (void)refresh;
@end

static NSDictionary *cookie_json(NSHTTPCookie *c) {
  NSMutableDictionary *d = [@{@"name":c.name, @"value":c.value, @"domain":c.domain, @"path":c.path,
    @"secure":@(c.secure), @"httpOnly":@(c.HTTPOnly), @"sessionOnly":@(c.sessionOnly)} mutableCopy];
  if (c.expiresDate) d[@"expires"] = @([c.expiresDate timeIntervalSince1970]);
  NSString *sameSite = [c.properties[NSHTTPCookieSameSitePolicy] lowercaseString];
  if ([@[@"lax", @"strict", @"none"] containsObject:sameSite]) d[@"sameSite"] = sameSite.capitalizedString;
  return d;
}
@implementation SDSession
- (void)cookiesDidChangeInCookieStore:(WKHTTPCookieStore *)store { [self refresh]; }
- (void)refresh {
  if (self.removing) return;
  if (self.reading) { self.dirty = YES; return; }
  self.reading = YES;
  [self.store.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
    if (self.removing) { self.reading = NO; self.dirty = NO; return; }
    NSMutableDictionary *next = [NSMutableDictionary dictionary];
    for (NSHTTPCookie *c in cookies) {
      if ([c.name isEqual:gateCookie]) continue; // Never export the shell credential, including in events.
      NSString *key = [NSString stringWithFormat:@"%@\n%@\n%@", c.domain, c.path, c.name];
      next[key] = cookie_json(c);
    }
    if (self.snapshot) {
      for (NSString *key in self.snapshot) if (!next[key])
        platform_emit(@"sessionCookieChanged", @{@"session":self.ident, @"cookie":self.snapshot[key], @"removed":@YES});
      for (NSString *key in next) if (![next[key] isEqual:self.snapshot[key]])
        platform_emit(@"sessionCookieChanged", @{@"session":self.ident, @"cookie":next[key], @"removed":@NO});
    }
    self.snapshot = next;
    self.reading = NO;
    if (self.dirty) { self.dirty = NO; [self refresh]; }
  }];
}
@end

static void ensure_sessions(void) {
  if (sessions) return;
  sessions = [NSMutableDictionary dictionary];
  views = [NSMapTable strongToWeakObjectsMapTable];
  SDSession *s = [SDSession new];
  s.ident = @"default";
  s.store = WKWebsiteDataStore.defaultDataStore;
  sessions[s.ident] = s;
  [s.store.httpCookieStore addObserver:s];
  [s refresh];
}
WKWebsiteDataStore *platform_session_store(NSString *ident) {
  ensure_sessions();
  SDSession *s = sessions[ident ?: @"default"];
  return s.removing ? nil : s.store;
}
void platform_session_window_creation(NSString *ident) { creatingSession = ident; }
NSString *platform_session_of(WKWebView *wv) {
  ensure_sessions();
  WKWebsiteDataStore *store = wv.configuration.websiteDataStore;
  for (NSString *ident in sessions)
    if (![ident isEqual:@"default"] && platform_session_store(ident) == store) return ident;
  return nil;
}
void platform_session_prepare(WKWebViewConfiguration *cfg, NSString *session) { cfg.websiteDataStore = platform_session_store(session ?: creatingSession); }
void platform_session_track(int nativeId, WKWebView *wv) { ensure_sessions(); [views setObject:wv forKey:@(nativeId)]; }
void platform_session_detach(int nativeId) { [views removeObjectForKey:@(nativeId)]; }
BOOL platform_webview_options_valid(NSDictionary *o) {
  id session = o[@"session"], recovery = o[@"recovery"];
  return (!session || ([session isKindOfClass:NSString.class] && platform_session_store(session))) &&
    (!recovery || [recovery isEqual:@"reload"] || [recovery isEqual:@"manual"]);
}
void platform_lifecycle_configure(WKWebView *wv, NSDictionary *target, NSString *recovery, int windowNative) {
  objc_setAssociatedObject(wv, &targetKey, target, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  objc_setAssociatedObject(wv, &recoveryKey, recovery ?: @"reload", OBJC_ASSOCIATION_COPY_NONATOMIC);
  if (windowNative) objc_setAssociatedObject(wv, &windowKey, @(windowNative), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
NSString *platform_lifecycle_recovery(WKWebView *wv) { return objc_getAssociatedObject(wv, &recoveryKey) ?: @"reload"; }
NSDictionary *platform_lifecycle_target(WKWebView *wv) {
  NSMutableDictionary *target = [objc_getAssociatedObject(wv, &targetKey) mutableCopy] ?: [NSMutableDictionary dictionary];
  NSNumber *window = objc_getAssociatedObject(wv, &windowKey);
  if (window) target[@"windowId"] = @(platform_public_window_id(window.intValue));
  return target;
}
NSURLRequest *platform_webview_request(WKWebView *wv, NSURL *url) {
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
  request.mainDocumentURL = url;
  NSString *viewId = platform_lifecycle_target(wv)[@"viewId"], *origin = platform_app_origin();
  if (viewId && origin && [url.absoluteString hasPrefix:[origin stringByAppendingString:@"/"]])
    [request setValue:viewId forHTTPHeaderField:@"X-Desktop-View"];
  return request;
}
BOOL platform_webview_terminated(WKWebView *wv) { return [objc_getAssociatedObject(wv, &terminatedKey) boolValue]; }
void platform_webview_load(WKWebView *wv, NSURLRequest *input) {
  NSMutableURLRequest *request = [input mutableCopy];
  NSObject *token = [NSObject new];
  objc_setAssociatedObject(wv, &loadKey, token, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  WKWebView *__weak weak = wv;
  void (^load)(NSString *) = ^(NSString *error) {
    WKWebView *current = weak;
    if (!current || objc_getAssociatedObject(current, &loadKey) != token || ![views.objectEnumerator.allObjects containsObject:current]) return;
    if (error) {
      NSError *failure = [NSError errorWithDomain:@"KitopSessionErrorDomain" code:1 userInfo:@{NSLocalizedDescriptionKey:error, NSURLErrorFailingURLErrorKey:request.URL}];
      platform_lifecycle_emit(current, @"failed", failure, YES);
    } else [current loadRequest:request];
  };
  NSString *origin = platform_app_origin();
  if (origin && [request.URL.absoluteString hasPrefix:[origin stringByAppendingString:@"/"]] && ![request.URL.path isEqual:@"/__desktop/auth"]) {
    WKWebsiteDataStore *store = wv.configuration.websiteDataStore;
    SDSession *owner = nil;
    for (SDSession *s in sessions.allValues) if (s.store == store) { owner = s; break; }
    owner.pending++;
    provision_app_cookie(store, ^(NSArray<NSHTTPCookie *> *cookies, NSString *error) {
      owner.pending--;
      load(error);
    });
  } else load(nil);
}
void platform_webview_stop(WKWebView *wv) {
  objc_setAssociatedObject(wv, &loadKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [wv stopLoading];
}
void platform_webview_reload(WKWebView *wv, BOOL ignoreCache) {
  NSURL *url = wv.URL ?: objc_getAssociatedObject(wv, &recoveryURLKey);
  if (platform_webview_terminated(wv) && url) {
    NSMutableURLRequest *request = [platform_webview_request(wv, url) mutableCopy];
    request.cachePolicy = ignoreCache ? NSURLRequestReloadIgnoringLocalCacheData : NSURLRequestReloadRevalidatingCacheData;
    platform_webview_load(wv, request);
  } else if (ignoreCache) [wv reloadFromOrigin];
  else [wv reload];
}
BOOL platform_webview_gave_up(WKWebView *wv) { return [objc_getAssociatedObject(wv, &gaveUpKey) boolValue]; }
// Reload, later each time, until the page has died too often (portable/reload_budget.hpp).
static void recover_terminated(WKWebView *wv, NSURL *url) {
  NSMutableData *budget = objc_getAssociatedObject(wv, &reloadsKey);
  if (!budget) {
    budget = [NSMutableData dataWithLength:sizeof(sd::ReloadBudget)];
    new (budget.mutableBytes) sd::ReloadBudget();
    objc_setAssociatedObject(wv, &reloadsKey, budget, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  int delay = ((sd::ReloadBudget *)budget.mutableBytes)->next(NSProcessInfo.processInfo.systemUptime);
  objc_setAssociatedObject(wv, &gaveUpKey, @(delay < 0), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  if (delay < 0) {
    std::string page = sd::crashed_page_url(platform_app_origin().UTF8String ?: "", url.absoluteString.UTF8String ?: "");
    if (!page.empty()) platform_webview_load(wv, platform_webview_request(wv, [NSURL URLWithString:@(page.c_str())]));
    return;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delay * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    // Since then, the app may have sent it somewhere (navigating clears the mark).
    if (platform_webview_terminated(wv)) platform_webview_reload(wv);
  });
}
void platform_lifecycle_emit(WKWebView *wv, NSString *type, NSError *error, BOOL provisional, WKNavigation *navigation) {
  NSMapTable *navigations = objc_getAssociatedObject(wv, &navigationsKey);
  if (!navigations) { navigations = [NSMapTable weakToStrongObjectsMapTable]; objc_setAssociatedObject(wv, &navigationsKey, navigations, OBJC_ASSOCIATION_RETAIN_NONATOMIC); }
  if ([type isEqual:@"navigationStarted"]) {
    objc_setAssociatedObject(wv, &loadKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(wv, &terminatedKey, @NO, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    NSString *ident = NSUUID.UUID.UUIDString;
    objc_setAssociatedObject(wv, &navigationKey, ident, OBJC_ASSOCIATION_COPY_NONATOMIC);
    if (navigation) [navigations setObject:ident forKey:navigation];
  }
  NSMutableDictionary *d = [platform_lifecycle_target(wv) mutableCopy];
  d[@"type"] = type;
  d[@"navigationId"] = (navigation ? [navigations objectForKey:navigation] : objc_getAssociatedObject(wv, &navigationKey)) ?: NSNull.null;
  d[@"url"] = wv.URL.absoluteString ?: @"";
  if (error) {
    id url = error.userInfo[NSURLErrorFailingURLErrorKey] ?: error.userInfo[NSURLErrorFailingURLStringErrorKey];
    if ([url isKindOfClass:NSURL.class]) url = [url absoluteString];
    if ([url isKindOfClass:NSString.class]) d[@"url"] = url;
    d[@"domain"] = error.domain; d[@"code"] = @(error.code);
    d[@"message"] = error.localizedDescription ?: @""; d[@"provisional"] = @(provisional);
  }
  NSString *recovery = objc_getAssociatedObject(wv, &recoveryKey) ?: @"reload";
  if ([type isEqual:@"terminated"]) {
    // WebKit clears URL after this callback; delayed manual recovery still needs it.
    if (wv.URL) objc_setAssociatedObject(wv, &recoveryURLKey, wv.URL, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(wv, &terminatedKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    d[@"recovery"] = recovery; d[@"reason"] = @"unknown";
    if ([recovery isEqual:@"reload"]) {
      recover_terminated(wv, objc_getAssociatedObject(wv, &recoveryURLKey));
      d[@"gaveUp"] = @(platform_webview_gave_up(wv));
    }
  }
  NSURLComponents *url = [NSURLComponents componentsWithString:d[@"url"]];
  if ([url.path isEqual:@"/__desktop/auth"]) {
    url.query = nil; url.fragment = nil; d[@"url"] = url.string ?: @"";
    if (error) d[@"message"] = @"Application authentication navigation failed";
  }
  platform_emit(@"webviewLifecycle", d);
}

static SDSession *resolve_session(PlatformCall *c) {
  ensure_sessions();
  id ident = c.args[@"session"] ?: @"default";
  SDSession *s = [ident isKindOfClass:NSString.class] ? sessions[ident] : nil;
  if (!s || s.removing) { [c fail:@"invalid_args" message:@"sessions: unknown or removing session"]; return nil; }
  return s;
}
static NSDictionary *describe(SDSession *s) { return @{@"id":s.ident, @"persistent":@(s.store.persistent)}; }
static NSUUID *identifier_for(NSString *ident) {
  NSData *d = [[NSString stringWithFormat:@"%@/sessions/%@", platform_app_identifier(), ident] dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(d.bytes, (CC_LONG)d.length, hash);
  hash[6] = (hash[6] & 0x0f) | 0x50; hash[8] = (hash[8] & 0x3f) | 0x80;
  return [[NSUUID alloc] initWithUUIDBytes:hash];
}
// URL filtering follows cookie domain, path-boundary and secure matching rules.
static BOOL cookie_matches_url(NSHTTPCookie *cookie, NSURL *url) {
  NSString *domain = cookie.domain.lowercaseString, *host = url.host.lowercaseString;
  BOOL domainMatch = [host isEqual:domain];
  if ([domain hasPrefix:@"."]) { domain = [domain substringFromIndex:1]; domainMatch = [host isEqual:domain] || [host hasSuffix:[@"." stringByAppendingString:domain]]; }
  NSString *path = url.path.length ? url.path : @"/", *cp = cookie.path;
  BOOL pathMatch = [path isEqual:cp] || ([path hasPrefix:cp] && ([cp hasSuffix:@"/"] || (path.length > cp.length && [path characterAtIndex:cp.length] == '/')));
  return domainMatch && pathMatch && (!cookie.secure || [url.scheme.lowercaseString isEqual:@"https"]);
}
static BOOL matches(NSHTTPCookie *cookie, NSURL *url, NSString *name) {
  return ![cookie.name isEqual:gateCookie] && (!name || [cookie.name isEqual:name]) && (!url || cookie_matches_url(cookie, url));
}
static BOOL filter(PlatformCall *c, NSURL **url, NSString **name) {
  *url = nil; *name = [c string:@"name"];
  if ([c has:@"name"] && !*name) { [c fail:@"invalid_args" message:@"cookies: name must be a string"]; return NO; }
  if ([c has:@"url"]) {
    *url = [NSURL URLWithString:[c string:@"url"] ?: @""];
    if (!(*url).host || ![@[@"http", @"https"] containsObject:(*url).scheme.lowercaseString]) { [c fail:@"invalid_args" message:@"cookies: an HTTP(S) URL is required"]; return NO; }
  }
  if ([*name isEqual:gateCookie]) { [c fail:@"denied" message:@"cookies: the shell authentication cookie is protected"]; return NO; }
  return YES;
}
// WebKit on macOS can omit observer callbacks for document.cookie writes, so open profiles are also
// reconciled once a second — only while a page listens for cookie changes (onChanged): otherwise
// it would wake WebKit's network process every second for nothing. Native mutations still notify
// at once through refresh().
static NSMutableSet<NSNumber *> *g_cookie_watchers; // pages listening (their window ids)
static NSTimer *g_cookie_timer;
static void update_cookie_timer(void) {
  if (g_cookie_watchers.count && !g_cookie_timer) {
    g_cookie_timer = [NSTimer timerWithTimeInterval:1 repeats:YES block:^(NSTimer *) {
      NSMutableSet *active = [NSMutableSet set];
      for (WKWebView *wv in views.objectEnumerator) [active addObject:wv.configuration.websiteDataStore];
      for (SDSession *s in sessions.allValues) if (!s.removing && [active containsObject:s.store]) [s refresh];
    }];
    [NSRunLoop.mainRunLoop addTimer:g_cookie_timer forMode:NSRunLoopCommonModes];
  } else if (!g_cookie_watchers.count && g_cookie_timer) {
    [g_cookie_timer invalidate];
    g_cookie_timer = nil;
  }
}
void platform_sessions_page_unloaded(int nativeId) {
  [g_cookie_watchers removeObject:@(nativeId)];
  update_cookie_timer();
}

void platform_register_sessions(void) {
  ensure_sessions();
  g_cookie_watchers = [NSMutableSet set];
  platform_register(@"sessions", @"watchCookies", ^(PlatformCall *c) {
    if ([c boolean:@"enabled" or:YES]) [g_cookie_watchers addObject:@(c.callerWindow)];
    else [g_cookie_watchers removeObject:@(c.callerWindow)];
    update_cookie_timer();
    [c ok:nil];
  });
  platform_register(@"sessions", @"create", ^(PlatformCall *c) {
    NSString *ident = [c string:@"id"];
    if (!ident.length || [ident isEqual:@"default"] || sessions[ident] || ident.length > 200 ||
        ![c.args[@"persistent"] isKindOfClass:NSNumber.class])
      return [c fail:@"invalid_args" message:@"sessions.create: a unique non-default id and boolean persistent are required"];
    BOOL persistent = [c boolean:@"persistent" or:NO];
    SDSession *s = [SDSession new]; s.ident = ident;
    if (persistent) {
      if (@available(macOS 14.0, *)) { s.uuid = identifier_for(ident); s.store = [WKWebsiteDataStore dataStoreForIdentifier:s.uuid]; }
      else return [c fail:@"unsupported" message:@"Persistent named sessions require macOS 14+"];
    } else s.store = WKWebsiteDataStore.nonPersistentDataStore;
    // Reserve the id during asynchronous bootstrap. No view can use an unauthenticated store.
    s.removing = YES; sessions[ident] = s;
    provision_app_cookie(s.store, ^(NSArray<NSHTTPCookie *> *initial, NSString *error) {
      if (error) { [sessions removeObjectForKey:ident]; return [c fail:@"unavailable" message:error]; }
      NSMutableDictionary *snapshot = [NSMutableDictionary dictionary];
      for (NSHTTPCookie *cookie in initial) if (![cookie.name isEqual:gateCookie])
        snapshot[[NSString stringWithFormat:@"%@\n%@\n%@", cookie.domain, cookie.path, cookie.name]] = cookie_json(cookie);
      s.snapshot = snapshot;
      s.removing = NO;
      [s.store.httpCookieStore addObserver:s];
      [c ok:describe(s)];
    });
  });
  platform_register(@"sessions", @"list", ^(PlatformCall *c) {
    NSMutableArray *out = [NSMutableArray array];
    for (NSString *key in [sessions.allKeys sortedArrayUsingSelector:@selector(compare:)]) { SDSession *s = sessions[key]; if (!s.removing) [out addObject:describe(s)]; }
    [c ok:out];
  });
  platform_register(@"sessions", @"remove", ^(PlatformCall *c) {
    SDSession *s = resolve_session(c); if (!s) return;
    if ([s.ident isEqual:@"default"]) return [c fail:@"denied" message:@"The default session belongs to the shell"];
    if (s.pending) return [c fail:@"unavailable" message:@"sessions.remove: cookie operations are still pending"];
    for (WKWebView *wv in views.objectEnumerator) if (wv.configuration.websiteDataStore == s.store)
      return [c fail:@"unavailable" message:@"sessions.remove: destroy the session's windows, views and popovers first"];
    s.removing = YES;
    [s.store.httpCookieStore removeObserver:s];
    void (^finish)(NSError *) = ^(NSError *error) {
      if (error) { s.removing = NO; [s.store.httpCookieStore addObserver:s]; [c fail:@"unavailable" message:error.localizedDescription]; }
      else { [sessions removeObjectForKey:s.ident]; [c ok:nil]; }
    };
    // Clear cookie-only profiles too: WebKit may not have created a website-data directory yet.
    [s.store removeDataOfTypes:WKWebsiteDataStore.allWebsiteDataTypes modifiedSince:NSDate.distantPast completionHandler:^{
      if (!s.uuid) return finish(nil);
      if (@available(macOS 14.0, *)) {
        NSUUID *uuid = s.uuid;
        NSArray *proxy = s.store.proxyConfigurations;
        s.store = nil;
        // Let the clear operation release its own store reference before removing the profile.
        dispatch_async(dispatch_get_main_queue(), ^{
          [WKWebsiteDataStore removeDataStoreForIdentifier:uuid completionHandler:^(NSError *error) {
            if (!error) return finish(nil);
            [WKWebsiteDataStore fetchAllDataStoreIdentifiers:^(NSArray<NSUUID *> *identifiers) {
              // An absent directory can make WebKit report deletion failure. Data was cleared,
              // and its public registry now confirms that no persistent profile remains.
              if (![identifiers containsObject:uuid]) return finish(nil);
              s.store = [WKWebsiteDataStore dataStoreForIdentifier:uuid];
              s.store.proxyConfigurations = proxy;
              finish(error);
            }];
          }];
        });
      }
    }];
  });
  platform_register(@"sessions", @"cookiesGet", ^(PlatformCall *c) {
    SDSession *s = resolve_session(c); if (!s) return;
    NSURL *url; NSString *name; if (!filter(c, &url, &name)) return;
    s.pending++;
    [s.store.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
      NSMutableArray *out = [NSMutableArray array];
      for (NSHTTPCookie *cookie in cookies) if (matches(cookie, url, name)) [out addObject:cookie_json(cookie)];
      s.pending--; [c ok:out];
    }];
  });
  platform_register(@"sessions", @"cookiesSet", ^(PlatformCall *c) {
    SDSession *s = resolve_session(c); if (!s) return;
    NSURL *url; NSString *name; if (!filter(c, &url, &name)) return;
    for (NSString *key in @[@"domain", @"path", @"sameSite"])
      if ([c has:key] && ![c string:key]) return [c fail:@"invalid_args" message:@"cookies.set: domain, path and sameSite must be strings"];
    for (NSString *key in @[@"secure", @"httpOnly"])
      if ([c has:key] && ![c.args[key] isKindOfClass:NSNumber.class]) return [c fail:@"invalid_args" message:@"cookies.set: secure and httpOnly must be booleans"];
    NSString *value = [c string:@"value"], *path = [c string:@"path"] ?: @"/", *domain = [c string:@"domain"] ?: url.host;
    if (!url || !name.length || !value || !domain.length || ![path hasPrefix:@"/"] ||
        [name rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"=;\r\n\t "]].location != NSNotFound ||
        [value rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@";\r\n"]].location != NSNotFound)
      return [c fail:@"invalid_args" message:@"cookies.set: url, name, value and a valid path/domain are required"];
    NSString *bare = [domain hasPrefix:@"."] ? [domain substringFromIndex:1] : domain;
    if (![url.host.lowercaseString isEqual:bare.lowercaseString] && !([domain hasPrefix:@"."] && [url.host.lowercaseString hasSuffix:[@"." stringByAppendingString:bare.lowercaseString]]))
      return [c fail:@"invalid_args" message:@"cookies.set: domain does not match url"];
    NSMutableDictionary *p = [@{NSHTTPCookieName:name, NSHTTPCookieValue:value, NSHTTPCookieDomain:domain, NSHTTPCookiePath:path, NSHTTPCookieOriginURL:url} mutableCopy];
    if ([c boolean:@"secure" or:NO]) p[NSHTTPCookieSecure] = @"TRUE";
    if ([c boolean:@"httpOnly" or:NO]) p[@"HttpOnly"] = @"TRUE";
    NSString *same = [c string:@"sameSite"];
    if (same) { if (![@[@"Lax", @"Strict", @"None"] containsObject:same]) return [c fail:@"invalid_args" message:@"cookies.set: invalid sameSite"]; p[NSHTTPCookieSameSitePolicy] = same.lowercaseString; }
    if ([c has:@"expires"]) {
      double expires = [c number:@"expires" or:NAN];
      if (!std::isfinite(expires)) return [c fail:@"invalid_args" message:@"cookies.set: expires must be seconds since epoch"];
      p[NSHTTPCookieExpires] = [NSDate dateWithTimeIntervalSince1970:expires];
    }
    if (([c boolean:@"secure" or:NO] && ![url.scheme isEqual:@"https"]) || ([same isEqual:@"None"] && ![c boolean:@"secure" or:NO]))
      return [c fail:@"invalid_args" message:@"cookies.set: Secure requires HTTPS; SameSite=None requires Secure"];
    NSHTTPCookie *cookie = [NSHTTPCookie cookieWithProperties:p];
    if (!cookie) return [c fail:@"invalid_args" message:@"cookies.set: invalid cookie"];
    s.pending++;
    [s.store.httpCookieStore setCookie:cookie completionHandler:^{
      [s refresh];
      [s.store.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *stored) {
        BOOL found = NO;
        for (NSHTTPCookie *value in stored) if ([value.name isEqual:cookie.name] && [value.domain isEqual:cookie.domain] && [value.path isEqual:cookie.path] && [value.value isEqual:cookie.value]) { found = YES; break; }
        BOOL expired = cookie.expiresDate && [cookie.expiresDate timeIntervalSinceNow] <= 0;
        s.pending--;
        if (found || expired) [c ok:nil];
        else [c fail:@"unavailable" message:@"WebKit did not retain the cookie"];
      }];
    }];
  });
  platform_register(@"sessions", @"cookiesRemove", ^(PlatformCall *c) {
    SDSession *s = resolve_session(c); if (!s) return;
    NSURL *url; NSString *name; if (!filter(c, &url, &name)) return;
    if (!url || !name.length) return [c fail:@"invalid_args" message:@"cookies.remove: url and name are required"];
    s.pending++;
    [s.store.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
      dispatch_group_t group = dispatch_group_create(); __block int count = 0;
      for (NSHTTPCookie *cookie in cookies) if (matches(cookie, url, name)) { count++; dispatch_group_enter(group);
        [s.store.httpCookieStore deleteCookie:cookie completionHandler:^{ dispatch_group_leave(group); }]; }
      dispatch_group_notify(group, dispatch_get_main_queue(), ^{ s.pending--; [s refresh]; [c ok:@{@"removed":@(count)}]; });
    }];
  });
  platform_register(@"sessions", @"setProxy", ^(PlatformCall *c) {
    SDSession *s = resolve_session(c); if (!s) return;
    if (@available(macOS 14.0, *)) {
      id p = c.args[@"proxy"];
      if (p == NSNull.null) { s.store.proxyConfigurations = @[]; s.proxy = nil; return [c ok:nil]; }
      if (![p isKindOfClass:NSDictionary.class]) return [c fail:@"invalid_args" message:@"sessions.setProxy: proxy configuration or null is required"];
      NSSet *keys = [NSSet setWithArray:@[@"type", @"host", @"port", @"username", @"password", @"tls"]];
      for (id key in p) if (![keys containsObject:key]) return [c fail:@"unsupported" message:@"Proxy PAC, bypass and other options are unsupported"];
      NSString *type = p[@"type"], *host = p[@"host"]; id port = p[@"port"];
      if (![@[@"http", @"socks"] containsObject:type] || ![host isKindOfClass:NSString.class] || !host.length ||
          ![port isKindOfClass:NSNumber.class] || [port doubleValue] != [port intValue] || [port intValue] < 1 || [port intValue] > 65535)
        return [c fail:@"invalid_args" message:@"sessions.setProxy: type, host and port 1–65535 are required"];
      for (NSString *k in @[@"username", @"password"]) if (p[k] && ![p[k] isKindOfClass:NSString.class]) return [c fail:@"invalid_args" message:@"Proxy credentials must be strings"];
      if (p[@"tls"] && ![p[@"tls"] isKindOfClass:NSNumber.class]) return [c fail:@"invalid_args" message:@"Proxy tls must be boolean"];
      if (([p[@"tls"] boolValue] && [type isEqual:@"socks"]) || (p[@"password"] && !p[@"username"])) return [c fail:@"invalid_args" message:@"TLS is HTTP-only; password requires username"];
      nw_endpoint_t endpoint = nw_endpoint_create_host(host.UTF8String, [[port stringValue] UTF8String]);
      nw_proxy_config_t proxy = [type isEqual:@"http"] ? nw_proxy_config_create_http_connect(endpoint, [p[@"tls"] boolValue] ? nw_tls_create_options() : nil) : nw_proxy_config_create_socksv5(endpoint);
      if (!proxy) return [c fail:@"unavailable" message:@"Could not create proxy configuration"];
      nw_proxy_config_add_match_domain(proxy, "");
      nw_proxy_config_set_failover_allowed(proxy, false);
      if (p[@"username"]) nw_proxy_config_set_username_and_password(proxy, [p[@"username"] UTF8String], [p[@"password"] UTF8String]);
      // Local app traffic must stay reachable; callers cannot override this authentication boundary.
      nw_proxy_config_add_excluded_domain(proxy, "127.0.0.1"); nw_proxy_config_add_excluded_domain(proxy, "localhost"); nw_proxy_config_add_excluded_domain(proxy, "::1");
      s.store.proxyConfigurations = @[proxy];
      s.proxy = @{@"type":type, @"host":host, @"port":port, @"tls":@([p[@"tls"] boolValue]), @"authenticated":@(p[@"username"] != nil)};
      [c ok:nil];
    } else [c fail:@"unsupported" message:@"Per-session proxies require macOS 14+"];
  });
  platform_register(@"sessions", @"getProxy", ^(PlatformCall *c) { SDSession *s = resolve_session(c); if (s) [c ok:s.proxy]; });
  platform_register(@"sessions", @"capabilities", ^(PlatformCall *c) {
    BOOL modern = NO; if (@available(macOS 14.0, *)) modern = YES;
    [c ok:@{@"private":@YES, @"persistentNamed":@(modern), @"proxy":@(modern), @"proxyAuthentication":@(modern), @"pac":@NO, @"customBypass":@NO}];
  });
}
