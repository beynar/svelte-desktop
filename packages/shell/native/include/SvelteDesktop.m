#import "SvelteDesktop.h"

static const sd_host *g_host;

static NSString *SDJSON(id value) {
  if (!value || value == NSNull.null) return @"null";
  NSData *d = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:nil];
  return d ? [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] : SDJSON([value description]);
}

static void SDTrampoline(sd_call *call, const char *args_json, void *user) {
  void (^handler)(NSDictionary *, SDReply) = (__bridge void (^)(NSDictionary *, SDReply))user;
  NSData *d = [NSData dataWithBytes:args_json length:strlen(args_json)];
  NSDictionary *args = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil] ?: @{};
  __block BOOL replied = NO;
  handler(args, ^(id value, NSError *error) {
    if (replied) return;
    replied = YES;
    if (error) g_host->reject(call, (error.userInfo[@"code"] ?: @"internal").UTF8String, error.localizedDescription.UTF8String);
    else g_host->resolve(call, SDJSON(value).UTF8String);
  });
}

void SDCommand(NSString *name, void (^handler)(NSDictionary *, SDReply)) {
  NSArray *parts = [name componentsSeparatedByString:@"."];
  NSCAssert(parts.count == 2, @"SDCommand name must be \"service.op\"");
  void *user = (__bridge_retained void *)[handler copy];
  if (g_host->register_op([parts[0] UTF8String], [parts[1] UTF8String], SDTrampoline, user) != 0)
    g_host->log([[NSString stringWithFormat:@"%@ is a built-in op; not registered", name] UTF8String]);
}

void SDEmit(NSString *event, id data) { g_host->emit(event.UTF8String, SDJSON(data).UTF8String); }
NSWindow *SDWindow(int windowId) { return (__bridge NSWindow *)g_host->window(windowId); }
NSError *SDError(NSString *code, NSString *message) {
  return [NSError errorWithDomain:@"svelte-desktop" code:1 userInfo:@{@"code" : code, NSLocalizedDescriptionKey : message}];
}

int sd_plugin_init(const sd_host *host) {
  if (host->abi != SD_ABI_VERSION) return -1;
  g_host = host;
  SDSetup();
  return 0;
}
