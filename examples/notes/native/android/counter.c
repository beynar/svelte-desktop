// An Android-only C plugin (native/android/ is compiled for Android only; the
// Swift Greeter in native/ covers macOS). Same sd_host ABI as Linux and Windows.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "svelte_desktop.h"

static const sd_host *host;
static long total;

// counter.add {n} → running total; also broadcast as `counterChanged`.
static void add(sd_call *call, const char *args_json, void *user) {
  (void)user;
  const char *p = strstr(args_json, "\"n\"");
  if (!p || !(p = strchr(p, ':'))) {
    host->reject(call, "invalid_args", "counter.add: `n` must be a number");
    return;
  }
  total += strtol(p + 1, NULL, 10);
  char out[64];
  snprintf(out, sizeof out, "%ld", total);
  host->resolve(call, out);
  char ev[64];
  snprintf(ev, sizeof ev, "{\"total\":%ld}", total);
  host->emit("counterChanged", ev);
}

static void hello(sd_call *call, const char *args_json, void *user) {
  (void)args_json;
  (void)user;
  host->resolve(call, "\"hello from C on Android\"");
}

int sd_plugin_init(const sd_host *h) {
  if (h->abi != SD_ABI_VERSION) return -1;
  host = h;
  h->register_op("counter", "add", add, NULL);
  h->register_op("counter", "hello", hello, NULL);
  h->log("counter plugin ready");
  return 0;
}
