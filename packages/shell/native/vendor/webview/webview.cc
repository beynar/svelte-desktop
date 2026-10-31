#include "webview/webview.h"

// svelte-desktop patch: desktop.config quitOnLastWindowClosed: false.
extern "C" void webview_sd_keep_running_without_windows(int keep) {
  webview::detail::keep_running_without_windows() = keep != 0;
}
