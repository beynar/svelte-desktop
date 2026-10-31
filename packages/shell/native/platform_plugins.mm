// Loads the app's native plugin (libapp-native.dylib) and bridges its ops into
// the platform registry. See include/svelte_desktop.h.
#include <dlfcn.h>

#include "include/svelte_desktop.h"
#include "platform_internal.h"
#include "shell.h"

struct sd_call {
  PlatformCall *__strong call;
};

static NSString *str(const char *s) { return s ? [NSString stringWithUTF8String:s] : @""; }

static id parse_value(const char *json) {
  if (!json) return nil;
  NSData *d = [NSData dataWithBytes:json length:strlen(json)];
  NSError *err = nil;
  id v = [NSJSONSerialization JSONObjectWithData:d options:NSJSONReadingFragmentsAllowed error:&err];
  return err ? [NSString stringWithUTF8String:json] : v; // non-JSON text → string
}

static void on_main(void (^b)(void)) {
  if (NSThread.isMainThread) b();
  else dispatch_async(dispatch_get_main_queue(), b);
}

static int host_register(const char *service, const char *op, sd_op_fn fn, void *user) {
  NSString *key = [NSString stringWithFormat:@"%s.%s", service, op];
  if ([platform_registered_ops() containsObject:key]) return -1;
  platform_register(str(service), str(op), ^(PlatformCall *c) {
    sd_call *handle = new sd_call{c};
    NSData *d = [NSJSONSerialization dataWithJSONObject:c.args options:0 error:nil] ?: [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
    NSString *json = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
    fn(handle, json.UTF8String, user);
  });
  return 0;
}

static void host_resolve(sd_call *h, const char *value_json) {
  id value = parse_value(value_json);
  on_main(^{
    [h->call ok:value];
    delete h;
  });
}

static void host_reject(sd_call *h, const char *code, const char *message) {
  NSString *c = str(code), *m = str(message);
  on_main(^{
    [h->call fail:c.length ? c : @"internal" message:m];
    delete h;
  });
}

static void host_emit(const char *event, const char *data_json) {
  id data = parse_value(data_json);
  platform_emit(str(event), [data isKindOfClass:NSDictionary.class] ? data : @{@"value" : data ?: NSNull.null});
}

static int native_id(int publicId) {
  NSArray *ids = platform_window_ids();
  if (publicId == 0) return ids.count ? [ids[0] intValue] : 0;
  return publicId;
}

static void *host_window(int wid) { return (__bridge void *)platform_window(native_id(wid)); }
static void *host_webview(int wid) { return (__bridge void *)platform_webview(native_id(wid)); }
static int host_caller(sd_call *h) { return h->call.callerWindow ? platform_public_window_id(h->call.callerWindow) : -1; }
static void host_log(const char *m) { NSLog(@"[native plugin] %s", m); }

static const sd_host kHost = {SD_ABI_VERSION, host_register, host_resolve, host_reject, host_emit,
                              host_window, host_webview, host_caller, host_log};

int shell_load_plugin(const char *path) {
  if (!NSThread.isMainThread) return -2;
  platform_init(); // the registry must exist; shell ops win name clashes
  void *h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!h) {
    NSLog(@"[shell] native plugin: %s", dlerror());
    return -1;
  }
  auto init = (sd_plugin_init_fn)dlsym(h, "sd_plugin_init");
  if (!init) {
    NSLog(@"[shell] native plugin %s has no sd_plugin_init", path);
    return -3;
  }
  int rc = init(&kHost);
  if (rc != 0) NSLog(@"[shell] native plugin init returned %d", rc);
  return rc;
}
