// Internal contract of the Linux backend (GTK 3 + WebKitGTK 4.1).
// Everything here runs on the GTK main thread unless stated otherwise.
//
// Files:
//   shell_linux.cc      windows, run loop, signals, navigation policy, page bridge,
//                       backend_* hooks of ../portable/core.hpp, shell_* exports
//   svc_app.cc          app.*  (+ single-instance lock)
//   svc_window.cc       window.*
//   svc_misc.cc         screen.*, clipboard.*, shell.*, theme.*, diagnostics.info,
//                       capabilities.describe, power.*
//   svc_dialog.cc       dialog.* (GtkFileChooserNative, GtkMessageDialog)
//   svc_webview.cc      webview.*, popover.*, events.emit
//   svc_web_control.cc  webview.*: navigation policy, web policy, find, context menu,
//                       JS dialogs, media, crash recovery, file drop
//   svc_optional.cc     tray.* (ayatana-appindicator), secureStorage.* (libsecret)
//                       — dlopen()ed at runtime
//   svc_notifications.cc notifications.* (libnotify, dlopen()ed; Unity badge over
//                       GDBus), push.* (unsupported)
#pragma once
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

#include <functional>
#include <string>
#include <vector>

#include "../portable/core.hpp"
#include "../portable/reload_budget.hpp"

namespace sd {
namespace lx {

struct Window {
  int id = 0;
  std::string label;
  GtkWidget *window = nullptr; // GtkWindow
  WebKitWebView *webview = nullptr;
  bool shown = false;   // revealed at least once (hidden-until-ready done)
  bool visible = true;  // requested visibility at creation
  bool veto = false;
  bool closing = false; // programmatic close: bypass veto
  GdkWindowState state = (GdkWindowState)0;
  bool focused = false;
  int minW = 0, minH = 0, maxW = 0, maxH = 0;
  bool alwaysOnTop = false, alwaysOnBottom = false, onAllWorkspaces = false; // GTK has setters only
  bool ignoreMouse = false;
  GtkWidget *box = nullptr;      // vertical: app menu bar + overlay
  GtkWidget *overlay = nullptr;  // the page, plus view.* web views on top
  GtkWidget *menubar = nullptr;
  GtkAccelGroup *accel = nullptr;
  std::string autosave;          // autosaveName → state file
  int normX = 0, normY = 0, normW = 0, normH = 0; // last un-maximized geometry
  guint saveTimer = 0;
};

// ---- windows (shell_linux.cc) ---------------------------------------------
Window *find_window(int native_id);
std::vector<int> window_ids();              // native ids, creation order
int primary_window();                       // native id of the primary window, 0 if none
int public_id(int native_id);               // 0 = primary
/// Resolves args.windowId (public id) → native id; else the caller window, the
/// active window, the primary window. 0 if none / unknown windowId.
int resolve_window(const Call &c);
int view_owner(int native_id); // the window a view is in (svc_view.cc), 0 if it isn't one
void views_window_closed(int window); // its views go with it (svc_view.cc)
bool view_at_app(int native_id); // its page is the app's, not another site's
int view_last_owner(int native_id); // the window it was in, even gone since
int view_native(const std::string &ident); // 0 if there's none
std::string view_ident(int native_id); // its id (svc_view.cc), empty if it isn't one
void view_reveal(int native_id); // asks the window's page to show it (viewReveal)
/// window.create: opts as shell_window_create plus `path` and `label`.
/// Returns native id, -4 for a duplicate label, <0 on failure.
int create_window_from_platform(const json &opts);

// ---- launch arguments → openUrls / openFiles (svc_app.cc) --------------------
/// The app's own arguments (URLs from scheme handlers, documents) at startup;
/// delivered once the first page is ready.
void set_launch_args(const json &args, const std::string &cwd);
/// A later instance's arguments (single instance): delivered now.
void handle_open_args(const json &args, const std::string &cwd);
void flush_open_requests();

// ---- menus (svc_optional.cc builder, svc_extra.cc services) ------------------
/// MenuItemSpec[] → GtkMenu (nullptr + *error on invalid specs); accelerators into `accel`.
GtkWidget *build_gtk_menu(const json &items, std::string *error, GtkAccelGroup *accel = nullptr);
/// "CmdOrCtrl+Shift+K" → keyval + modifiers.
bool parse_accelerator(const std::string &accel, guint *key, GdkModifierType *mods, std::string *error);
/// The app menu bar on a (new) window.
void attach_app_menu(Window *w);
void register_extra(); // menu, shortcuts, capture, system
/// singleInstance (desktop.config, default on): false when another instance holds
/// the lock — this process's arguments were handed to it and it should exit.
bool claim_single_instance();
void reveal(Window *w);
std::string app_name();
std::string app_identifier();
std::string app_version();
void set_app_name_override(const std::string &name);
void set_app_identifier_override(const std::string &id);
void request_quit();

// ---- web views (shell_linux.cc) ------------------------------------------
/// Creates a WebKitWebView with the page bridge attached (bridge script at
/// document start in the top frame, `__shell__` message handler, nonce-checked)
/// and the shell's navigation policy / crash recovery. `extra_script` is an
/// optional additional top-frame document-start script (popovers).
WebKitWebView *make_webview(int native_id, bool debug, const std::string &extra_script);
void detach_webview(int native_id);
WebKitWebView *webview_for(int native_id); // windows and popovers
bool same_origin(const std::string &url);
std::string origin_of(const std::string &url);
std::string page_origin(int native_id); // of its last committed top-level load

// ---- popovers (svc_webview.cc) -------------------------------------------
bool popover_page_ready(int native_id); // true if native_id is a popover
std::string popover_ident(int native_id); // "" if not a popover
bool popover_tray_click();               // true if a bound popover handled it

// ---- JS helpers (svc_webview.cc) -----------------------------------------
/// Evaluate `js` in the page (script semantics), reply with its JSON value.
void eval_to_json(WebKitWebView *wv, const std::string &js, CallPtr c, const char *what);
/// Awaited JS → JSON value (webview.executeJavaScript, view.executeJavaScript).
void execute_js(WebKitWebView *wv, const std::string &code, CallPtr c);
/// A web view committed a top-level load: track its origin (the bridge checks it).
void page_committed(int native_id, const char *uri);
void register_view();

/// What a webview.* op acts on: popoverId, viewId, windowId, the calling page, the primary window.
struct Target {
  WebKitWebView *wv = nullptr;
  json source; // {windowId} | {popoverId} | {viewId, windowId}
};
bool resolve_target(CallPtr c, Target *t); // false: the call has failed

// ---- web control (svc_web_control.cc) ---------------------------------------
/// make_webview: its signal handlers and per-view settings. detach_webview: they end.
void web_control_attach(int native_id, WebKitWebView *wv);
void web_control_detach(WebKitWebView *wv);
/// The navigation policy holds this navigation (it answers `d` later): the decide-policy handler returns TRUE.
bool web_navigation_held(WebKitWebView *wv, WebKitPolicyDecision *d, const std::string &url);
json web_control_info(WebKitWebView *wv); // getInfo's fileDrop, contextMenu, backgroundThrottling, recovery
void register_web_control();

// ---- misc helpers ---------------------------------------------------------
inline json rect_json(double x, double y, double w, double h) { return json{{"x", x}, {"y", y}, {"width", w}, {"height", h}}; }
/// Frame rect (decorations included) in root coordinates.
GdkRectangle frame_rect(Window *w);
/// Content (client area) rect in root coordinates.
GdkRectangle content_rect(Window *w);
GdkMonitor *monitor_at(int x, int y);
GdkMonitor *primary_monitor();
void pointer_position(int *x, int *y);
std::string base64_encode(const unsigned char *data, size_t len);
std::vector<unsigned char> base64_decode(const std::string &s, bool *ok);
std::string user_dir(GUserDirectory d, const char *fallback_name);
std::string exe_path();
std::string exe_dir();
bool packaged(); // <exeDir>/lib/libshell.so exists (an app directory / AppImage)

// ---- service registration ---------------------------------------------------
void register_app();
void register_window();
void register_misc();   // screen, clipboard, shell, theme, diagnostics, capabilities, power
void register_dialog();
void register_webview(); // webview, popover, events
void register_optional(); // notifications, tray, secureStorage
void register_notifications(); // svc_notifications.cc (called by register_optional)
/// "" when notifications can be shown, else why not (no libnotify / no server).
std::string notifications_unavailable();
/// Ops that cannot work in this environment (library or daemon missing), for
/// capabilities.describe: "service.op" → reason. Filled by register_optional().
const std::vector<std::string> &unavailable_ops();
/// Tray: bind a popover to the indicator (activations toggle it).
void tray_bind_popover(const std::string &id);
bool tray_is_set();

/// Legacy shell_dialog support: run the dialog service and translate its reply.
void dialog_legacy(int request_id, const json &opts);

} // namespace lx
} // namespace sd
