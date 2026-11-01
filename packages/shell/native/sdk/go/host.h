// C side of the Go SDK: cgo can't call the host's function pointers itself.
#include "svelte_desktop.h"

int sd_go_set_host(const sd_host *host);
int sd_go_register(const char *service, const char *op, unsigned long user);
void sd_go_resolve(sd_call *call, const char *value_json);
void sd_go_reject(sd_call *call, const char *code, const char *message);
void sd_go_emit(const char *event, const char *data_json);
void sd_go_log(const char *message);
