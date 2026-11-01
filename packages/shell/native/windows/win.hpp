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
#include <string>
#include <vector>

#include "../portable/core.hpp"

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
std::string last_error_message(DWORD err = GetLastError());
std::string hresult_message(HRESULT hr);

// Typed JSON field access that never throws (missing/mistyped -> fallback).
bool jbool(const json &o, const char *key, bool fallback);
double jnum(const json &o, const char *key, double fallback);
std::string jstr(const json &o, const char *key, const std::string &fallback = "");
bool jhas(const json &o, const char *key);

/// Run at shell_run exit (remove tray icons, release hotkeys, reset power requests).
void add_quit_hook(std::function<void()> hook);

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
  bool failed = false;                 // controller creation failed for good
  bool ready = false;                  // controller set up and bridge script registered
  EventRegistrationToken tokens[8]{};  // [7]: DocumentTitleChanged (view.* only)
  std::string browserView;             // view.* id: any origin may load ("" = app page)
};

/// Every live web view by native id (windows + popovers).
std::map<int, View *> &views();
View *find_view(int nativeId);
/// Create the controller for `v` (async). `v->host` must be set.
void view_create(View *v);
/// Run now if the controller exists, else when it does.
void view_when_ready(View *v, std::function<void()> fn);
void view_navigate(View *v, const std::string &url);
void view_set_html(View *v, const std::string &html);
void view_eval(View *v, const std::string &js);
void view_resize(View *v);
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
  double minW = 0, minH = 0, maxW = 0, maxH = 0; // DIP, content size
  bool fullscreen = false;
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
};

Window *find_window(int nativeId);
Window *find_window_hwnd(HWND hwnd);
const std::vector<int> &window_order(); // creation order; front = primary
int primary_window();
/// args.windowId (public id) or the calling page's window, else the
/// foreground one of ours, else the primary. 0 when none.
int resolve_window(const Call &c);
/// opts as shell_window_create (+ "path", "label" for multi-window). <0 on error (-4 duplicate label).
int create_app_window(const json &opts);
/// No window left (quitOnLastWindowClosed: false): reopen the first window's options. 0 when
/// windows exist (or none was ever created), else the new native id.
int show_main_window();
void reveal_window(Window *w);
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

/// Graceful quit (emits nothing; callers emit willQuit when appropriate).
void request_quit();

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
void register_deep_link();

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
} // namespace sd::win
