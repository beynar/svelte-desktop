// Thread-safe shims over webview/webview: callable from any thread (e.g. the
// Bun Worker that runs the server). Each copies its arguments and hops to the
// UI thread through webview_dispatch.
#include "webview/api.h"
#include <cstdlib>
#include <cstring>

namespace {
struct str_task { char *s; };

void run_eval(webview_t w, void *arg) {
  auto *t = static_cast<str_task *>(arg);
  webview_eval(w, t->s);
  free(t->s);
  delete t;
}

void run_title(webview_t w, void *arg) {
  auto *t = static_cast<str_task *>(arg);
  webview_set_title(w, t->s);
  free(t->s);
  delete t;
}

void run_navigate(webview_t w, void *arg) {
  auto *t = static_cast<str_task *>(arg);
  webview_navigate(w, t->s);
  free(t->s);
  delete t;
}

int post(webview_t w, const char *s, void (*fn)(webview_t, void *)) {
  return webview_dispatch(w, fn, new str_task{strdup(s)});
}
} // namespace

extern "C" {
WEBVIEW_API int shell_eval_async(webview_t w, const char *js) { return post(w, js, run_eval); }
WEBVIEW_API int shell_set_title_async(webview_t w, const char *t) { return post(w, t, run_title); }
WEBVIEW_API int shell_navigate_async(webview_t w, const char *u) { return post(w, u, run_navigate); }
}
