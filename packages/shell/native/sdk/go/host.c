#include "host.h"
#include "_cgo_export.h"

static const sd_host *g_host;

int sd_go_set_host(const sd_host *host) {
  if (!host || host->abi != SD_ABI_VERSION) return -1;
  g_host = host;
  return 0;
}

static void dispatch(sd_call *call, const char *args_json, void *user) { sdGoDispatch(call, (char *)args_json, user); }

int sd_go_register(const char *service, const char *op, unsigned long user) {
  return g_host->register_op(service, op, dispatch, (void *)user);
}
void sd_go_resolve(sd_call *call, const char *value_json) { g_host->resolve(call, value_json); }
void sd_go_reject(sd_call *call, const char *code, const char *message) { g_host->reject(call, code, message); }
void sd_go_emit(const char *event, const char *data_json) { if (g_host) g_host->emit(event, data_json); }
void sd_go_log(const char *message) { if (g_host) g_host->log(message); }
