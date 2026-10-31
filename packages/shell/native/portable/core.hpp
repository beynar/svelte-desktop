// Portable core of libshell for the non-Apple backends (Linux/GTK, Windows/WebView2):
// the platform dispatcher, page bridge protocol, permissions and plugin host.
// Same wire format and C ABI as the macOS implementation (../shell.h,
// ../platform_internal.h): the TypeScript layers don't know which OS they run on.
//
// A backend implements the `backend_*` hooks below plus the shell_window_* /
// shell_run / shell_quit / shell_window_create exports, and registers its
// service modules with sd::reg().
#pragma once
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "vendor/json.hpp"

namespace sd {
using json = nlohmann::json;

struct Call {
  std::string service, op;
  json args = json::object();
  int caller = 0; // native id of the page that called, 0 = Worker/server code
  std::function<void(const json &)> reply;
  std::atomic<bool> done{false};

  void ok(const json &value = nullptr);
  void fail(const std::string &code, const std::string &message);
  std::string str(const char *key, const std::string &fallback = "") const;
  double num(const char *key, double fallback = 0) const;
  bool flag(const char *key, bool fallback = false) const;
  bool has(const char *key) const;
};
using CallPtr = std::shared_ptr<Call>;
using Handler = std::function<void(CallPtr)>;

void reg(const std::string &service, const std::string &op, Handler handler);
void reg_many(const std::string &service, const std::vector<std::string> &ops, Handler handler);
std::vector<std::string> registered_ops();
/// Main thread. Unknown service → "unknown", known service + unknown op → "unsupported".
void dispatch(const json &request, int caller, std::function<void(const json &)> reply);

/// Raw shell event to the Worker sink ({"type":"ready",...}). Any thread.
void emit_raw(const json &event);
/// Platform event: Worker sink + every page. Any thread.
void emit(const std::string &name, const json &data = json::object());

std::string app_origin();
bool page_may_call(const std::string &service, const std::string &op);

/// The page bridge script (installed at document start, main frame only).
/// Uses webkit.messageHandlers.__shell__ (WebKit) or chrome.webview (WebView2).
extern const char *const kBridgeScript;
/// A message from a page's bridge. `origin` is the sender frame's origin
/// ("http://127.0.0.1:1234"), `main_frame` whether it's the top document.
void on_bridge_message(int native_id, const std::string &body, const std::string &origin, bool main_frame);

/// Page drag regions ([data-desktop-drag] / `--app-region: drag`): JS for inside a bridge
/// script, calling its `raw(message)` sender (kBridgeScript already includes it).
extern const char *const kDragListener;
/// Title bar style per window: default | transparent | hidden | hiddenInset. Anything but
/// `default` is a frameless window here (no native buttons: html[data-desktop-controls=none]).
void set_title_bar_style(int native_id, const std::string &style);
std::string title_bar_style(int native_id);

/// A page whose current document reported DOMContentLoaded (bridge `ready`) and that
/// still exists. Main thread. page_unloaded: a new document is loading.
bool page_loaded(int native_id);
void page_unloaded(int native_id);

/// JSON for `deliver(name, data)` into a page (used by emit and replies).
std::string deliver_js(const std::string &name, const json &data);

// ---- hooks each backend implements ----------------------------------------
void backend_run_on_main(std::function<void()> fn);
bool backend_is_main_thread();
void backend_eval_in_page(int native_id, const std::string &js);
std::vector<int> backend_page_ids();        // every web view that receives events
void backend_page_ready(int native_id);     // DOMContentLoaded from the bridge
int backend_public_window_id(int native_id); // 0 = primary window
int backend_native_window_id(int public_id);
void *backend_native_window(int native_id);  // GtkWindow* / HWND
void *backend_native_webview(int native_id); // WebKitWebView* / ICoreWebView2*
void backend_init_services();                // reg() every service module (called once)
void backend_set_frameless(int native_id, bool frameless); // title bar off / on
void backend_window_drag(int native_id, bool double_click); // move from the current pointer / maximize toggle
} // namespace sd
