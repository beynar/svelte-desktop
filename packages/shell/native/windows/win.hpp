// Internal contract of the Windows backend (Win32 + WebView2).
//
// Threading: everything here runs on the UI thread (the thread that called
// shell_window_create). Other threads only reach it through
// sd::backend_run_on_main, which queues the closure and wakes a message-only
// window with PostMessage.
//
// Units: window sizes and positions are DIPs (CSS px at 100% zoom), like macOS
// points: physical pixels divided by the scale factor of the monitor the
// window (or rect, or point) is on. The process runs per-monitor-v2 DPI aware.
#pragma once
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <objbase.h>

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunknown-pragmas"
#include "WebView2.h"
#pragma GCC diagnostic pop

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "../portable/core.hpp"
#include "../portable/reload_budget.hpp"

namespace sd::win {

// ---------------------------------------------------------------------------
// Strings

std::wstring wide(const std::string &s);
std::string utf8(const wchar_t *s, int len = -1);
inline std::string utf8(const std::wstring &s) { return utf8(s.c_str(), (int)s.size()); }
std::string lower(std::string s);
std::string base64_encode(const void *data, size_t len);
bool base64_decode(const std::string &in, std::string &out);
/// "scheme://host[:port]" of a URL, "" when it has no authority.
std::string url_origin(const std::string &url);
std::string url_scheme(const std::string &url);
/// Its host, without port: "[::1]" keeps its brackets.
std::string url_host(const std::string &url);
std::string last_error_message(DWORD err = GetLastError());
std::string hresult_message(HRESULT hr);

// Typed JSON field access that never throws (missing/mistyped -> fallback).
bool jbool(const json &o, const char *key, bool fallback);
double jnum(const json &o, const char *key, double fallback);
std::string jstr(const json &o, const char *key, const std::string &fallback = "");
bool jhas(const json &o, const char *key);

/// Run at shell_run exit (remove tray icons, release hotkeys, reset power requests).
void add_quit_hook(std::function<void()> hook);
/// Once, on the UI thread, in `ms` milliseconds.
void run_after(UINT ms, std::function<void()> fn);
/// %LOCALAPPDATA%/<identifier>/<name>, the folder created.
std::string local_file(const std::string &name);
json read_json_file(const std::string &path, const json &fallback);
/// Whole or not at all: through a temporary file.
void write_json_file(const std::string &path, const json &value);
/// "~/x" -> the user's folder.
std::string expand_home(const std::string &path);

// ---------------------------------------------------------------------------
// COM callback objects for WebView2's handler interfaces (single Invoke).
// Created with refcount 1: pass to the API, then Release().

template <class I, class... A>
class Cb final : public I {
public:
  using Fn = std::function<HRESULT(A...)>;
  Cb(const IID &iid, Fn fn) : iid_(iid), fn_(std::move(fn)) {}
  ULONG STDMETHODCALLTYPE AddRef() override { return ++rc_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --rc_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **pp) override {
    if (!pp) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, iid_)) {
      *pp = static_cast<I *>(this);
      AddRef();
      return S_OK;
    }
    *pp = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE Invoke(A... a) override { return fn_ ? fn_(a...) : S_OK; }

private:
  std::atomic<ULONG> rc_{1};
  const IID &iid_;
  Fn fn_;
};

/// Release a COM pointer and null it.
template <class T> void release(T *&p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

/// QueryInterface helper: returns an owned pointer or nullptr.
template <class T> T *query(IUnknown *from, const IID &iid) {
  T *out = nullptr;
  if (from && SUCCEEDED(from->QueryInterface(iid, reinterpret_cast<void **>(&out)))) return out;
  return nullptr;
}

// ---------------------------------------------------------------------------
// Web views (windows and popovers share this)

struct View {
  int id = 0;           // native id: windows 1.., popovers 1000..
  HWND host = nullptr;  // the HWND the controller is parented to
  ICoreWebView2Controller *controller = nullptr;
  ICoreWebView2 *webview = nullptr;
  bool debug = false;
  bool transparent = false;
  bool contextMenu = false;            // default context menus
  std::string extraScript;             // injected after the bridge (popovers)
  std::string userAgent;               // custom UA ("" = default)
  std::vector<std::function<void()>> pending; // run once the controller exists
  std::string lastUrl;                 // for recovery after a browser crash
  ReloadBudget reloads;                // after its render process dies
  bool askingToReload = false;         // the "not responding" question is on screen
  bool failed = false;                 // controller creation failed for good
  bool ready = false;                  // controller set up and bridge script registered
  EventRegistrationToken tokens[13]{}; // [7]: DocumentTitleChanged (view.* only), [8]: FrameNavigationStarting, [9]: DownloadStarting, [10]: ScreenCaptureStarting, [11]: WebResourceRequested (navigation policy), [12]: WebResourceRequested (schemes and content rules)
  bool holdsRequests = false;          // navigation policy: see web_policy_attach
  bool pageHidden = false;             // its window or view is hidden or minimized
  bool throttling = true;              // setBackgroundThrottling: false keeps it visible to the page regardless
  std::string browserView;             // view.* id: any origin may load ("" = app page)
  std::string session;                 // named session ("" = the default one), for good once created
  bool watchesRequests = false;        // tokens[12] is registered
  bool ruleFilter = false;             // the every-resource filter is on (content rules in use)
  std::string pendingTop;              // the top-level navigation under way: what's first party for its own request
  unsigned navigation = 0;             // top-level navigations started
};

/// Every live web view by native id (windows + popovers).
std::map<int, View *> &views();
View *find_view(int nativeId);
/// Create the controller for `v` (async), in its session. `v->host` must be set.
void view_create(View *v);
/// Run now if the controller exists, else when it does.
void view_when_ready(View *v, std::function<void()> fn);
void view_navigate(View *v, const std::string &url);
void view_set_html(View *v, const std::string &html);
void view_eval(View *v, const std::string &js);
void view_resize(View *v);
/// What the page is told: hidden (WebView2 throttles it) only with throttling on.
void view_apply_visibility(View *v);
void view_destroy(View *v);
/// Awaits promises (DevTools Runtime.evaluate), resolves with a JSON value.
void view_execute(View *v, const std::string &code, std::function<void(bool ok, const json &value, const std::string &error)> done);
double view_zoom(View *v);

// ---------------------------------------------------------------------------
// Windows

struct Window {
  int id = 0;
  HWND hwnd = nullptr;
  View view;
  std::string label;
  bool shown = false;     // revealed (or never auto-revealed)
  bool veto = false;      // close veto armed
  bool alwaysOnBottom = false;
  double minW = 0, minH = 0, maxW = 0, maxH = 0; // DIP, content size
  bool fullscreen = false;
  bool simpleFullscreen = false;
  RECT savedRect{};
  LONG_PTR savedStyle = 0;
  bool documentEdited = false;
  double opacity = 1;
  bool ignoreMouse = false;
  bool contentProtected = false;
  std::string theme = "system";
  std::string autosaveName;
  bool startMaximized = false; // restored autosave placement was maximized
  HMENU menu = nullptr;   // menu bar (owned)
  bool closing = false;   // window.close: it goes, whatever the last window's rule says
  double aspect = 0;      // content width / height kept while resizing (0 = free)
  bool movable = true;    // the user can move it (the shell's own moves always work)
  std::string vibrancy;   // setVibrancy's material ("" = no system backdrop)
};

Window *find_window(int nativeId);
Window *find_window_hwnd(HWND hwnd);
const std::vector<int> &window_order(); // creation order; front = primary
int primary_window();
/// args.windowId (public id) or the calling page's window, else the
/// foreground one of ours, else the primary. 0 when none.
int resolve_window(const Call &c);
View *view_named(const std::string &ident); // a view by its id, if there's one (svc_embed.cc)
bool view_at_app(int native_id); // its page is the app's, not another site's
int view_last_owner(int native_id); // the window it was in, even gone since
int view_owner(int native_id); // the window a view is in (svc_embed.cc), 0 if it isn't one
View *view_with_focus(int window); // the shown view with the keyboard in it, if any (svc_embed.cc)
void views_window_closed(int window); // its views go with it (svc_embed.cc)
void view_page_focused(int window); // the window's own page has it
void view_reveal(int native_id); // asks the window's page to show it (viewReveal)
/// opts as shell_window_create (+ "path", "label" for multi-window). <0 on error (-4 duplicate label).
int create_app_window(const json &opts);
/// No window left (quitOnLastWindowClosed: false): reopen the first window's options. 0 when
/// windows exist (or none was ever created), else the new native id.
int show_main_window();
void reveal_window(Window *w);
/// `parent` owns `w` (nullptr: nothing does). false, and no change, for a cycle. (svc_window.cc)
bool set_window_parent(Window *w, Window *parent);
/// To the next window in z-order that isn't it. (svc_window.cc)
void give_up_foreground(Window *w);
/// Repaint the window's own surface under its web view. (shell_win.cc)
void paint_under_view(Window *w);
/// `options.vibrancy` at creation, setVibrancy: "" or why not. (svc_window.cc)
std::string set_window_vibrancy(Window *w, const std::string &material);
/// The title apps set and read; the title bar also shows the document-edited mark. (svc_window.cc)
void set_window_title(Window *w, const std::string &title);
void adjust_for_dpi(RECT *rc, DWORD style, BOOL menu, DWORD ex, UINT dpi);
/// Resize the client area to width x height DIPs (keeps the position).
void set_content_size(Window *w, double width, double height);
json window_bounds_json(HWND hwnd);

// App identity
std::string app_name();
std::string app_identifier();
std::string app_version();
void set_app_name(const std::string &name);
void set_app_identifier(const std::string &identifier);
std::wstring exe_path();
bool packaged();
std::string arch_name(); // "x64" | "arm64"

/// Leaves the run loop now. What ends the app otherwise goes through quit_request.
void request_quit();
/// The cancellable quit (svc_app.cc): quitRequested, beforeQuit and willQuit, then request_quit.
/// reason: api, menu, lastWindowClosed, logout, shutdown, system, signal. Joins one under way.
void quit_request(const std::string &reason);
void quit_page_unloaded(int native_id); // its guards can't answer: it voted against, if it had to answer
/// app.hide, the role too: which windows it took off the screen, for app.showAll.
void app_hide_windows();
void app_show_hidden_windows();

// Hidden top-level window: tray callbacks, hotkeys, clipboard owner and the
// system broadcasts (WM_SETTINGCHANGE, WM_DISPLAYCHANGE, WM_POWERBROADCAST,
// WM_QUERYENDSESSION, session notifications, TaskbarCreated).
HWND hidden_window();
/// Class of the hidden window (its title is the app identifier).
extern const wchar_t *const kHiddenClass;
using MsgHook = std::function<bool(HWND, UINT, WPARAM, LPARAM, LRESULT *)>;
void add_hidden_hook(MsgHook hook);

// DPI
double hwnd_scale(HWND hwnd);
double monitor_scale(HMONITOR mon);
double point_scale(POINT pt);
json rect_json(double x, double y, double w, double h);
/// Physical-pixel screen rect -> DIP json, scaled by the rect's monitor.
json screen_rect_dip(const RECT &r);
void set_dark_title_bar(HWND hwnd, bool dark);
bool system_dark();
/// The effective appearance after theme.set (system|light|dark).
bool app_dark();

// ---------------------------------------------------------------------------
// Menus (svc_menu.cc). One builder for the menu bar, tray and popup menus.

enum class MenuOwner { App = 0, Tray = 1, Popup = 2 };
/// MenuItemSpec[] -> HMENU (popup menu). nullptr + error on invalid specs.
HMENU build_menu(const json &items, MenuOwner owner, const std::string &ctx, std::string &error);
/// Forget the command ids of an owner (before rebuilding its menu).
void reset_menu_owner(MenuOwner owner);
/// WM_COMMAND / TrackPopupMenu result. `nativeWindow` = window whose bar it is (0 = none).
bool handle_menu_command(UINT cmd, int nativeWindow);
/// Accelerator from the focused web view (AcceleratorKeyPressed). true = handled.
bool handle_accelerator(UINT vk, int nativeWindow);
/// Replace the menu bar of every window with `menus` ([{name, items}]).
bool set_app_menu(const json &menus, std::string &error);
/// shell_menu_set legacy spec [{label, submenu:[...]}].
bool set_legacy_menu(const json &spec, std::string &error);
/// Attach the current app menu to a new window.
void attach_app_menu(Window *w);
/// "CmdOrCtrl+Shift+K" -> virtual key + MOD_* flags + display text ("Ctrl+Shift+K").
bool parse_accelerator(const std::string &accel, UINT &vk, UINT &mods, std::string &display, std::string &error);
/// Register a root HMENU of an owner so menu.update reaches it (tray menus).
void track_menu_root(MenuOwner owner, HMENU menu);
/// Window fullscreen (svc_window.cc), used by the togglefullscreen role.
void set_fullscreen(Window *w, bool on);

// ---------------------------------------------------------------------------
// Images (svc_clipboard.cc, WIC)

bool wic_decode(const std::string &bytes, std::vector<uint8_t> &bgra, UINT &w, UINT &h);
bool wic_encode(const uint8_t *bgra, UINT w, UINT h, UINT stride, bool jpeg, double quality, std::string &out);
HICON icon_from_bgra(const std::vector<uint8_t> &bgra, UINT w, UINT h);
/// {native}|{path}|string -> HICON at `size` px. nullptr + error.
HICON load_icon(const json &spec, int size, const std::string &ctx, std::string &error);
HICON app_icon(bool small);

// ---------------------------------------------------------------------------
// Cross-module glue

/// HICON → top-down BGRA pixels (svc_tray.cc).
bool icon_pixels(HICON icon, std::vector<uint8_t> &px, int &w, int &h);
/// Tray balloon fallback for notifications (svc_tray.cc): the tray icon, or a temporary
/// one. A click calls notification_balloon_clicked(id) (svc_notifications.cc).
bool tray_balloon_show(const std::string &id, const std::string &title, const std::string &body, bool silent, std::string &error);
void tray_balloon_hide(const std::string &id); // "" = whatever is shown
void notification_balloon_clicked(const std::string &id);
/// Toast COM activator (svc_notifications.cc): a second instance launched with
/// -ToastActivated pumps messages until Windows delivers the activation ({args, inputs}
/// JSON, "" on timeout); the holder replays what it forwards.
std::string toast_activation_wait(int ms);
void toast_activation_forwarded(const json &activation);
/// A window's taskbar button exists (re-apply the badge overlay).
void taskbar_button_created(HWND hwnd);
/// Tray icon rect (physical px), false when no tray icon is placed (svc_tray.cc).
bool tray_rect(RECT &out);
/// Popovers (svc_popover.cc)
void popover_page_ready(int nativeId);
bool popover_tray_click();
void popover_bind_tray(const std::string &id);
std::string popover_id_of(int nativeId);
View *popover_view(const std::string &id);
/// Escape in a popover page (closeOnEscape). true = handled.
bool popover_key(int nativeId, UINT vk);
/// Open-file / deep-link arguments (svc_app.cc): argv of this or a second instance.
void handle_open_args(const std::vector<std::wstring> &args);
/// The first page became ready: flush the startup argv (svc_app.cc).
void on_first_page_ready();
/// Theme (svc_theme.cc): apply the effective appearance to a new web view / window.
void theme_apply_window(Window *w);
void theme_apply_view(View *v);

// Module registration
void register_app();
void register_window();
void register_screen();
void register_clipboard();
void register_shell();
void register_dialog();
void register_theme();
void register_menu();
void register_system();
void register_power();
void register_secure_storage();
void register_notifications();
void register_tray();
void register_shortcuts();
void register_diagnostics();
void register_popover();
void register_webview();
void register_web_policy();
void register_web_control();
void register_downloads();
void register_sessions();    // svc_cookies.cc: cookie ops
void register_web_sessions(); // svc_web_sessions.cc
void register_deep_link();

/// Web policy (svc_web_policy.cc): held until the server answers or its deadline.
void web_permission_requested(View *v, ICoreWebView2PermissionRequestedEventArgs *args);
void web_screen_capture_starting(View *v, ICoreWebView2ScreenCaptureStartingEventArgs *args);
void web_navigation_policy(View *v, const std::string &url, bool main_frame, ICoreWebView2NavigationStartingEventArgs *args);
void web_policy_attach(View *v);
void web_policy_forget(int view);
void web_auth_attach(View *v);
/// Web control (svc_web_control.cc).
void web_control_attach(View *v);
void web_control_detach(int id);
json web_control_info(View *v); // what getInfo adds
std::string web_control_recovery(int id);
void web_control_navigating(int id);
/// A file drag from the page script: true when the message was one, however it's frame-sent.
bool web_control_message(int id, const std::string &body, ICoreWebView2WebMessageReceivedEventArgs *args, bool top);
void web_site_seen(const std::string &url); // an origin some view loaded, for clearData
/// Delete every cookie of the profile but the hosts `keep` names; `done` gets the hosts cleared (svc_cookies.cc).
void clear_site_cookies(std::function<bool(const std::string &host)> keep, std::function<void(const std::set<std::string> &)> done);
/// Downloads (svc_downloads.cc).
void downloads_attach(View *v);
void downloads_detach(View *v);
/// Cookie watchers of a page leaving (svc_cookies.cc).
void sessions_page_unloaded(int native_id);

// Sessions (svc_web_sessions.cc). A named one is a WebView2 profile with a hidden web view holding it
// open, which is also what reaches its cookies with no view of the app's in it. It has an environment
// of its own (`folder`) once it has had a proxy: browser arguments are per environment.
struct Session {
  std::string id;
  bool persistent = true;
  bool removing = false;        // being set up, changed or deleted: nothing can use it now
  int pending = 0;              // cookie operations under way
  std::string profile, folder;  // WebView2 profile name; its own user data folder ("": the app's)
  ICoreWebView2Environment *env = nullptr; // with `folder`
  ICoreWebView2Controller *anchor = nullptr;
  ICoreWebView2 *web = nullptr;
  ICoreWebView2CookieManager *cookies = nullptr;
  bool opening = false;
  std::vector<std::function<void(const std::string &)>> waiters;
  json proxy;                   // what getProxy answers, null: system defaults
  std::string proxyUser, proxyPassword;
  int proxyAnswers = 0;         // credentials given lately: too many means they're wrong
  ULONGLONG proxyAnswered = 0;
  std::map<std::string, json> snapshot; // svc_cookies.cc
  bool hasSnapshot = false, reading = false, dirty = false;
};
using SessionPtr = std::shared_ptr<Session>;
/// By id ("" or "default": the default one). nullptr: unknown or not usable now.
SessionPtr session_named(const std::string &id);
std::map<std::string, SessionPtr> &sessions();
/// The hidden web view of a named session, opened if it had to be. `error` is "" when it's there.
void session_open(const SessionPtr &s, std::function<void(const std::string &error)> done);
/// json `session` option of a window, view or popover. false: it names no session.
bool session_option(const json &options, std::string &session);
/// Runs `fn` when the session can take a controller: a null `options` means the default one's.
void session_controller_options(const std::string &session, std::function<void(ICoreWebView2Environment *, ICoreWebView2ControllerOptions *, const std::string &error)> fn);
/// Runs `load` once the app's own cookie is in the view's session, or says the load failed.
void session_before_load(View *v, const std::string &url, std::function<void()> load);
/// The environment a session's views are in: "" for the app's, shared by the other sessions.
std::string session_environment_key(const std::string &session);
/// That environment's browser process is gone: forget what was in it.
void sessions_environment_lost(const std::string &key);
/// The default environment (shell_win.cc): every view and session without its own.
void with_env(std::function<void(ICoreWebView2Environment *)> fn);
std::wstring user_data_folder();
/// A new environment on `folder`, with the app's custom schemes and these browser arguments. They come from the shell, never from the process's environment.
HRESULT environment_create(const std::wstring &folder, const std::wstring &arguments, std::function<void(HRESULT, ICoreWebView2Environment *)> done);
/// Proxy credentials for a challenge from `uri`, if it's the proxy of the view's session.
bool session_proxy_challenge(View *v, const std::string &uri, bool &has_credentials, std::string &user, std::string &password);
/// The profile's cookie manager (svc_cookies.cc), owned, nullptr when no web view is open.
ICoreWebView2CookieManager *session_cookie_manager(const SessionPtr &s);
using CookiesFn = std::function<void(HRESULT, ICoreWebView2CookieList *)>;
/// Empty uri: every cookie of the profile.
bool session_get_cookies(ICoreWebView2CookieManager *m, const std::string &uri, CookiesFn done);
/// Every cookie as JSON, the shell's own included, and back: for a session changing environment.
void session_read_cookies(const SessionPtr &s, std::function<void(const json &)> done);
void session_write_cookies(const SessionPtr &s, const json &cookies);
/// The first thing changes compare to, for a session that starts while someone listens.
void session_cookies_started(const SessionPtr &s, std::function<void()> done);

// Custom schemes (svc_web_sessions.cc).
void set_protocol_schemes(const json &input); // desktop.config protocols, before the first web view
const std::vector<std::string> &protocol_schemes();
bool protocol_scheme(const std::string &scheme);
// What every web view gets from svc_web_sessions.cc: registered scripts, the request handler, the input policy.
void web_sessions_attach(View *v, std::function<void()> done);
void web_sessions_detach(View *v);
void web_sessions_navigating(View *v, const std::string &url);
void web_sessions_content_loading(View *v);
/// A key the web view reports. true: consumed. `menus`: whether menu accelerators may have it.
bool input_policy_key(int native_id, UINT vk, ICoreWebView2AcceleratorKeyPressedEventArgs *args, bool &menus);
UINT current_key_mods(); // MOD_* held now (svc_menu.cc)
/// The web view a webview.* call targets (svc_webview.cc); nullptr after failing the call.
View *view_for_call(const CallPtr &c);
/// WebviewSource of a web view: windowId, popoverId, viewId (svc_webview.cc).
json view_source(View *v);

/// Shell dialog helpers shared with shell_dialog (svc_dialog.cc).
void run_message_box(const json &opts, HWND parent, std::function<void(int button)> done);
void run_file_dialog(const json &opts, bool save, HWND parent, std::function<void(bool canceled, std::vector<std::string> paths)> done);

/// WebView2 runtime version string ("" when missing).
std::string webview2_version();

/// singleInstance (desktop.config, default on): false when another instance holds the
/// mutex — this process's arguments were handed to it and it should exit.
bool claim_single_instance();
/// view.* (svc_embed.cc): keep autoresizing views in step with their window.
void embedded_views_resized(Window *w);
void register_embed(); // view.*, capture.*
void register_desktop(); // svc_desktop.cc: metrics, the app's icon and activation policy, bookmarks, thermal state, drag out
void register_winrt(); // svc_winrt.cc: the share sheet, Windows Hello
/// What a new window takes from the app (svc_desktop.cc).
void apply_app_look(Window *w);
/// Route dialogs (svc_dialog.cc).
bool sheet_page_ready(int native_id);
bool sheet_key(int native_id, UINT vk); // Escape cancels. true = handled.
/// A jump list task's arguments (svc_menu.cc). true: they were one, and it ran.
bool jump_task_args(const std::vector<std::wstring> &args);
} // namespace sd::win
