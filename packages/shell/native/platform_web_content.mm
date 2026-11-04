// Declarative WebKit rules, content worlds and Worker-backed resource schemes.
#include "platform_internal.h"
#include "platform_web_content.h"

static NSArray<NSString *> *g_schemes = @[];
static NSHashTable<WKWebView *> *views(void) {
  static NSHashTable *v; if (!v) v = [NSHashTable weakObjectsHashTable]; return v;
}
static NSMutableDictionary<NSString *, WKContentRuleList *> *rules(void) {
  static NSMutableDictionary *v; if (!v) v = [NSMutableDictionary dictionary]; return v;
}
// The rules as the app gave them (WebKit's compiled lists can't be read), for listContentRules.
static NSMutableDictionary<NSString *, NSArray *> *rule_specs(void) {
  static NSMutableDictionary<NSString *, NSArray *> *specs;
  return specs ?: (specs = [NSMutableDictionary dictionary]);
}
static NSMutableDictionary<NSString *, NSNumber *> *versions(void) {
  static NSMutableDictionary *v; if (!v) v = [NSMutableDictionary dictionary]; return v;
}
static NSMutableDictionary<NSString *, NSDictionary *> *scripts(void) {
  static NSMutableDictionary *v; if (!v) v = [NSMutableDictionary dictionary]; return v;
}
static NSMutableArray<NSString *> *script_order(void) {
  static NSMutableArray *v; if (!v) v = [NSMutableArray array]; return v;
}
static NSMapTable<WKWebView *, NSArray<WKUserScript *> *> *installed_scripts(void) {
  static NSMapTable *v; if (!v) v = [NSMapTable weakToStrongObjectsMapTable]; return v;
}
static void worker_event(NSString *name, NSDictionary *data) {
  // Requests and cancellation tokens never go to untrusted page listeners.
  shell_emit(@{@"type":@"platform", @"name":name, @"data":data});
}
static BOOL worker_call(PlatformCall *c) {
  if (!c.callerWindow) return YES;
  [c fail:@"denied" message:@"this operation belongs to server code"]; return NO;
}
static BOOL valid_id(NSString *s) { return s.length && s.length <= 256; }

// Scheme handlers live with the configuration, and retain only active tasks.
@interface SDResourceTask : NSObject
@property(nonatomic, strong) id<WKURLSchemeTask> task;
@property(nonatomic) BOOL responded;
@end
@implementation SDResourceTask
@end
static NSMutableDictionary<NSString *, SDResourceTask *> *tasks(void) {
  static NSMutableDictionary *v; if (!v) v = [NSMutableDictionary dictionary]; return v;
}
static void cancel_task(NSString *ident) {
  if (!tasks()[ident]) return;
  [tasks() removeObjectForKey:ident];
  worker_event(@"protocolCancel", @{@"requestId":ident});
}
@interface SDResourceHandler : NSObject <WKURLSchemeHandler>
@end
@implementation SDResourceHandler
- (void)webView:(WKWebView *)view startURLSchemeTask:(id<WKURLSchemeTask>)task {
  NSString *ident = NSUUID.UUID.UUIDString;
  SDResourceTask *s = [SDResourceTask new]; s.task = task;
  tasks()[ident] = s;
  NSURLRequest *r = task.request;
  if (r.HTTPBodyStream) {
    [tasks() removeObjectForKey:ident];
    [task didFailWithError:[NSError errorWithDomain:@"SDProtocol" code:1 userInfo:@{NSLocalizedDescriptionKey:@"streamed request uploads are unsupported"}]];
    return;
  }
  NSMutableDictionary *data = [@{@"requestId":ident, @"url":r.URL.absoluteString ?: @"", @"method":r.HTTPMethod ?: @"GET", @"headers":r.allHTTPHeaderFields ?: @{}} mutableCopy];
  if (r.HTTPBody) data[@"body"] = [r.HTTPBody base64EncodedStringWithOptions:0];
  worker_event(@"protocolRequest", data);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    SDResourceTask *pending = tasks()[ident];
    if (!pending || pending.responded) return;
    [pending.task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorTimedOut userInfo:nil]];
    cancel_task(ident);
  });
}
- (void)webView:(WKWebView *)view stopURLSchemeTask:(id<WKURLSchemeTask>)task {
  for (NSString *ident in tasks().allKeys) if (tasks()[ident].task == task) { cancel_task(ident); break; }
}
@end

void platform_web_content_set_schemes(NSArray *input) {
  // Called once at startup, before the first configuration exists.
  static BOOL set; if (set) return; set = YES;
  NSMutableArray *out = [NSMutableArray array];
  NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^[a-z][a-z0-9+.-]*$" options:0 error:nil];
  for (id name in input) {
    if (![name isKindOfClass:NSString.class] || ![pattern numberOfMatchesInString:name options:0 range:NSMakeRange(0, [name length])] ||
        [WKWebView handlesURLScheme:name] || [@[@"http",@"https",@"file",@"data",@"blob",@"about",@"javascript",@"ws",@"wss"] containsObject:name]) continue;
    if (![out containsObject:name]) [out addObject:name];
  }
  g_schemes = out.copy;
}
BOOL platform_web_content_is_scheme(NSString *scheme) { return [g_schemes containsObject:scheme.lowercaseString]; }
void platform_web_content_prepare(WKWebViewConfiguration *configuration) {
  for (NSString *scheme in g_schemes) [configuration setURLSchemeHandler:[SDResourceHandler new] forURLScheme:scheme];
  for (WKContentRuleList *list in rules().allValues) [configuration.userContentController addContentRuleList:list];
}

static BOOL matches_target(NSDictionary *target, WKWebView *wv) {
  NSDictionary *actual = platform_lifecycle_target(wv);
  for (NSString *key in @[@"windowId", @"popoverId", @"viewId"])
    if (target[key] && ![target[key] isEqual:actual[key]]) return NO;
  return YES;
}
static void apply_scripts(WKWebView *wv) {
  WKUserContentController *ucc = wv.configuration.userContentController;
  NSArray *old = [installed_scripts() objectForKey:wv] ?: @[];
  // WK has no removeUserScript:; preserve every script owned by the bridge/other modules.
  NSMutableArray *keep = [NSMutableArray array];
  for (WKUserScript *script in ucc.userScripts) if (![old containsObject:script]) [keep addObject:script];
  [ucc removeAllUserScripts];
  for (WKUserScript *script in keep) [ucc addUserScript:script];
  NSMutableArray *next = [NSMutableArray array];
  for (NSString *ident in script_order()) {
    NSDictionary *s = scripts()[ident];
    if (!matches_target(s[@"target"] ?: @{}, wv)) continue;
    WKContentWorld *world = [s[@"world"] isEqual:@"page"] ? WKContentWorld.pageWorld : [WKContentWorld worldWithName:s[@"world"]];
    WKUserScript *script = [[WKUserScript alloc] initWithSource:s[@"source"]
      injectionTime:[s[@"timing"] isEqual:@"start"] ? WKUserScriptInjectionTimeAtDocumentStart : WKUserScriptInjectionTimeAtDocumentEnd
      forMainFrameOnly:[s[@"mainFrameOnly"] boolValue] inContentWorld:world];
    [ucc addUserScript:script]; [next addObject:script];
  }
  [installed_scripts() setObject:next forKey:wv];
}
void platform_web_content_attach(WKWebView *wv) {
  [views() addObject:wv];
  for (WKContentRuleList *list in rules().allValues) [wv.configuration.userContentController addContentRuleList:list];
  apply_scripts(wv);
}

static BOOL g_navigation_policy;
static NSMutableDictionary<NSString *, void (^)(WKNavigationActionPolicy)> *decisions(void) {
  static NSMutableDictionary *v; if (!v) v = [NSMutableDictionary dictionary]; return v;
}
BOOL platform_web_content_decide_navigation(WKWebView *wv, WKNavigationAction *action, void (^decision)(WKNavigationActionPolicy)) {
  NSURL *url = action.request.URL;
  NSURL *app = [NSURL URLWithString:platform_app_origin() ?: @""];
  // An app policy cannot sever its own origin or its bridge.
  if (!g_navigation_policy || ([url.scheme isEqual:app.scheme] && [url.host isEqual:app.host] && [url.port isEqual:app.port])) return NO;
  NSString *ident = NSUUID.UUID.UUIDString;
  decisions()[ident] = decision;
  NSDictionary *target = platform_lifecycle_target(wv);
  NSString *viewId = target[@"viewId"] ?: (target[@"popoverId"] ?: [NSString stringWithFormat:@"window:%@", target[@"windowId"] ?: @0]);
  worker_event(@"webContentNavigation", @{@"requestId":ident, @"url":url.absoluteString ?: @"", @"isMainFrame":@(action.targetFrame.isMainFrame), @"viewId":viewId});
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    void (^pending)(WKNavigationActionPolicy) = decisions()[ident];
    if (pending) { [decisions() removeObjectForKey:ident]; pending(WKNavigationActionPolicyCancel); }
  });
  return YES;
}

void platform_register_web_content(void) {
  platform_register(@"webview", @"setContentRules", ^(PlatformCall *c) {
    NSString *ident = [c string:@"id"];
    id input = c.args[@"rules"];
    if (!valid_id(ident) || ![input isKindOfClass:NSArray.class] || ![input count]) return [c fail:@"invalid_args" message:@"id and a nonempty rules array are required"];
    NSString *origin = platform_app_origin();
    if (!origin) return [c fail:@"unavailable" message:@"the app origin is not ready"];
    NSMutableArray *safe = [NSMutableArray array];
    NSSet *actions = [NSSet setWithArray:@[@"block", @"block-cookies", @"css-display-none", @"make-https", @"ignore-previous-rules"]];
    // Final exceptions protect the app document, its resources and the event WebSocket.
    NSString *escaped = [NSRegularExpression escapedPatternForString:origin];
    // WebKit rejects alternation and interior anchors; network URLs have a canonical slash.
    NSString *appFilter = [NSString stringWithFormat:@"^%@/", escaped];
    NSURL *app = [NSURL URLWithString:origin];
    NSString *bridgeFilter = [NSString stringWithFormat:@"^wss?://%@:%@/", [NSRegularExpression escapedPatternForString:app.host], app.port ?: @80];
    for (id raw in input) {
      if (![raw isKindOfClass:NSDictionary.class] || ![raw[@"trigger"] isKindOfClass:NSDictionary.class] ||
          ![raw[@"action"] isKindOfClass:NSDictionary.class] || ![actions containsObject:raw[@"action"][@"type"]])
        return [c fail:@"invalid_args" message:@"invalid content blocker rule or unsupported action"];
      if ([raw[@"action"][@"type"] isEqual:@"css-display-none"]) {
        NSMutableDictionary *trigger = [raw[@"trigger"] mutableCopy];
        // CSS can bypass ignore-previous-rules. Its exclusion must be in the trigger.
        // WebKit permits one domain/top/frame condition, so reject incompatible ones.
        if (trigger[@"if-domain"] || trigger[@"if-top-url"] || trigger[@"if-frame-url"] || trigger[@"unless-frame-url"])
          return [c fail:@"invalid_args" message:@"css-display-none requires an app-origin exclusion; use unless-domain or unless-top-url instead of positive/frame conditions"];
        id top = trigger[@"unless-top-url"], domains = trigger[@"unless-domain"];
        if ((top && ![top isKindOfClass:NSArray.class]) || (domains && ![domains isKindOfClass:NSArray.class]) || (top && domains) || (top && ![top count]) || (domains && ![domains count]))
          return [c fail:@"invalid_args" message:@"invalid CSS exclusion conditions"];
        NSMutableArray *excluded = top ? [top mutableCopy] : [NSMutableArray array];
        for (id value in domains ?: @[]) {
          if (![value isKindOfClass:NSString.class] || ![value length]) return [c fail:@"invalid_args" message:@"invalid CSS domain"];
          NSString *domain = value;
          if (![domain isEqual:domain.lowercaseString] || ![domain dataUsingEncoding:NSASCIIStringEncoding allowLossyConversion:NO])
            return [c fail:@"invalid_args" message:@"CSS domains must be lowercase ASCII or punycode"];
          BOOL subdomains = [domain hasPrefix:@"*"];
          if (subdomains) domain = [domain substringFromIndex:1];
          // The same domain-to-top-URL conversion used by WebKit's public rule parser.
          [excluded addObject:[NSString stringWithFormat:@"[a-z][a-z+.-]*://%@%@[:/]", subdomains ? @"([^/]*\\.)*" : @"", [NSRegularExpression escapedPatternForString:domain]]];
        }
        [trigger removeObjectForKey:@"unless-domain"];
        [excluded addObject:appFilter];
        trigger[@"unless-top-url"] = excluded;
        [safe addObject:@{@"trigger":trigger, @"action":raw[@"action"]}];
      } else [safe addObject:raw];
    }
    [safe addObject:@{@"trigger":@{@"url-filter":appFilter}, @"action":@{@"type":@"ignore-previous-rules"}}];
    [safe addObject:@{@"trigger":@{@"url-filter":bridgeFilter}, @"action":@{@"type":@"ignore-previous-rules"}}];
    NSError *error; NSData *json = [NSJSONSerialization dataWithJSONObject:safe options:0 error:&error];
    if (!json) return [c fail:@"invalid_args" message:error.localizedDescription];
    NSNumber *version = @([versions()[ident] unsignedLongLongValue] + 1); versions()[ident] = version;
    NSString *storeId = [NSString stringWithFormat:@"sd-%@-%@", NSUUID.UUID.UUIDString, ident];
    [WKContentRuleListStore.defaultStore compileContentRuleListForIdentifier:storeId encodedContentRuleList:[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] completionHandler:^(WKContentRuleList *list, NSError *err) {
      if (![versions()[ident] isEqual:version]) {
        if (list) [WKContentRuleListStore.defaultStore removeContentRuleListForIdentifier:storeId completionHandler:^(NSError *e) {}];
        return [c fail:@"unavailable" message:@"content rules were replaced during compilation"];
      }
      if (!list) return [c fail:@"invalid_args" message:err.localizedFailureReason ?: err.localizedDescription ?: @"WebKit could not compile content rules"];
      WKContentRuleList *previous = rules()[ident]; rules()[ident] = list; rule_specs()[ident] = input;
      for (WKWebView *wv in views()) {
        WKUserContentController *ucc = wv.configuration.userContentController;
        if (previous) [ucc removeContentRuleList:previous];
        [ucc addContentRuleList:list];
      }
      // Lists are process-owned; avoid persisting a cache entry for every launch.
      [WKContentRuleListStore.defaultStore removeContentRuleListForIdentifier:storeId completionHandler:^(NSError *e) {}];
      [c ok:nil];
    }];
  });
  platform_register(@"webview", @"removeContentRules", ^(PlatformCall *c) {
    NSString *ident = [c string:@"id"];
    if (!valid_id(ident)) return [c fail:@"invalid_args" message:@"id is required"];
    versions()[ident] = @([versions()[ident] unsignedLongLongValue] + 1);
    WKContentRuleList *list = rules()[ident];
    if (list) for (WKWebView *wv in views()) [wv.configuration.userContentController removeContentRuleList:list];
    [rules() removeObjectForKey:ident]; [rule_specs() removeObjectForKey:ident]; [c ok:nil];
  });
  platform_register(@"webview", @"listContentRules", ^(PlatformCall *c) {
    NSMutableArray *out = [NSMutableArray array];
    for (NSString *ident in [rule_specs().allKeys sortedArrayUsingSelector:@selector(compare:)]) [out addObject:@{@"id" : ident, @"rules" : rule_specs()[ident]}];
    [c ok:out];
  });
  platform_register(@"webview", @"registerScript", ^(PlatformCall *c) {
    NSString *ident = [c string:@"id"], *source = [c string:@"source"], *world = [c string:@"world"], *timing = [c string:@"timing"];
    if (!valid_id(ident) || !source || !valid_id(world) || ![@[@"start", @"end"] containsObject:timing]) return [c fail:@"invalid_args" message:@"script requires id, source, world and start/end timing"];
    id target = c.args[@"target"];
    if (target && ![target isKindOfClass:NSDictionary.class]) return [c fail:@"invalid_args" message:@"target must be an object"];
    for (NSString *key in target ?: @{}) {
      id value = target[key];
      if (!([key isEqual:@"windowId"] ? [value isKindOfClass:NSNumber.class] :
            ([@[@"popoverId", @"viewId"] containsObject:key] && [value isKindOfClass:NSString.class]))) return [c fail:@"invalid_args" message:@"invalid script target"];
    }
    NSMutableDictionary *spec = [@{@"id":ident, @"source":source, @"world":world, @"timing":timing, @"mainFrameOnly":@([c boolean:@"mainFrameOnly" or:YES])} mutableCopy];
    if (target) spec[@"target"] = target;
    if (!scripts()[ident]) [script_order() addObject:ident];
    scripts()[ident] = spec;
    for (WKWebView *wv in views()) apply_scripts(wv);
    [c ok:nil];
  });
  platform_register(@"webview", @"unregisterScript", ^(PlatformCall *c) {
    NSString *ident = [c string:@"id"];
    if (!valid_id(ident)) return [c fail:@"invalid_args" message:@"id is required"];
    [scripts() removeObjectForKey:ident]; [script_order() removeObject:ident];
    for (WKWebView *wv in views()) apply_scripts(wv);
    [c ok:nil];
  });
  platform_register(@"webview", @"listScripts", ^(PlatformCall *c) {
    NSMutableArray *out = [NSMutableArray array]; for (NSString *ident in script_order()) [out addObject:scripts()[ident]]; [c ok:out];
  });
  platform_register(@"webview", @"setNavigationPolicy", ^(PlatformCall *c) {
    if (!worker_call(c)) return;
    g_navigation_policy = [c boolean:@"enabled" or:NO];
    for (NSString *ident in decisions().allKeys) { void (^done)(WKNavigationActionPolicy) = decisions()[ident]; [decisions() removeObjectForKey:ident]; done(WKNavigationActionPolicyCancel); }
    [c ok:nil];
  });
  platform_register(@"webview", @"navigationDecision", ^(PlatformCall *c) {
    if (!worker_call(c)) return;
    NSString *ident = [c string:@"requestId"];
    void (^done)(WKNavigationActionPolicy) = decisions()[ident ?: @""];
    if (!done) return [c fail:@"unavailable" message:@"navigation decision expired"];
    [decisions() removeObjectForKey:ident]; done([c boolean:@"allow" or:NO] ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel); [c ok:nil];
  });
  for (NSString *op in @[@"response", @"data", @"finish", @"fail"]) platform_register(@"protocol", op, ^(PlatformCall *c) {
    if (!worker_call(c)) return;
    NSString *ident = [c string:@"requestId"];
    SDResourceTask *s = ident ? tasks()[ident] : nil;
    if (!s) return [c fail:@"unavailable" message:@"protocol task was cancelled or completed"];
    if ([op isEqual:@"response"]) {
      int status = (int)[c number:@"status" or:200];
      id headers = c.args[@"headers"];
      if (s.responded || status < 200 || status > 599 || ![headers isKindOfClass:NSDictionary.class]) return [c fail:@"invalid_args" message:@"invalid or duplicate protocol response"];
      for (id key in headers) if (![key isKindOfClass:NSString.class] || ![headers[key] isKindOfClass:NSString.class]) return [c fail:@"invalid_args" message:@"invalid response headers"];
      NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:s.task.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:headers];
      s.responded = YES; [s.task didReceiveResponse:response];
    } else if ([op isEqual:@"data"]) {
      NSString *encoded = [c string:@"data"];
      NSData *data = encoded && encoded.length <= 87384 ? [[NSData alloc] initWithBase64EncodedString:encoded options:0] : nil;
      if (!s.responded || !data || data.length > 65536) return [c fail:@"invalid_args" message:@"protocol data requires response headers and at most 64 KiB"];
      [s.task didReceiveData:data];
    } else if ([op isEqual:@"finish"]) {
      if (!s.responded) return [c fail:@"invalid_args" message:@"protocol response headers are missing"];
      [tasks() removeObjectForKey:ident]; [s.task didFinish];
    } else {
      [tasks() removeObjectForKey:ident];
      [s.task didFailWithError:[NSError errorWithDomain:@"SDProtocol" code:2 userInfo:@{NSLocalizedDescriptionKey:[c string:@"message"] ?: @"protocol handler failed"}]];
      worker_event(@"protocolCancel", @{@"requestId":ident});
    }
    [c ok:nil];
  });
}
