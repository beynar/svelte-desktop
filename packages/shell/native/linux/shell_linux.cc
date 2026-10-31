// Linux implementation of shell.h: GTK 3 windows hosting WebKitGTK 4.1 web views.
// Mirrors shell_macos.mm: windows, hidden-until-ready, navigation policy,
// SIGINT/SIGTERM/SIGHUP → graceful quit, web process crash → reload, plus the
// backend_* hooks of the portable core (dispatcher, bridge protocol, plugins).
//
// Threading: the process main thread (Bun's main JS thread) is the GTK thread.
// shell_window_create / shell_run run on it; every other export copies its
// arguments and hops over with g_idle_add (thread-safe on the default context).
//
// Page bridge and frame identity: WebKitGTK's script-message-received signal does
// not say which frame posted the message, and `window.webkit.messageHandlers` is
// reachable from every frame. So the bridge script (installed in the top frame
// only, at document start) captures the handler in a closure and stamps every
// message with a per-web-view random nonce that only that closure knows. A
// message without the right nonce (a subframe posting to the handler directly)
// is treated as "not the main frame" and denied by the core. The origin checked
// is the one of the top document's last committed load (LOAD_COMMITTED URI) —
// provisional loads and pushState can't change it under us.
#include <fcntl.h>
#include <glib-unix.h>
#include <unistd.h>

#include <algorithm>
#include <climits>
#include <csignal>
#include <cstring>
#include <map>
#include <random>
#include <thread>

#include "../shell.h"
#include "linux.hpp"

namespace sd {
namespace lx {

static std::thread::id g_main_thread;
static bool g_gtk_ready = false;
static std::map<int, Window *> g_windows; // main thread only
static std::vector<int> g_order;         // creation order; front = primary
static int g_next_id = 1;
static std::string g_app_name, g_app_identifier, g_app_version, g_name_override, g_identifier_override;
static bool g_in_main = false, g_quit_requested = false;

struct Page {
  WebKitWebView *wv = nullptr;
  std::string nonce;
  std::string origin; // origin of the last committed top-level load
};
static std::map<int, Page> g_pages;

// ---------------------------------------------------------------------------
// Small helpers

static json parse(const char *s) {
  if (!s) return json::object();
  json j = json::parse(s, nullptr, false);
  return j.is_discarded() ? json::object() : j;
}

static std::string random_hex(int bytes) {
  std::random_device rd;
  static const char *hex = "0123456789abcdef";
  std::string out;
  for (int i = 0; i < bytes; i++) {
    unsigned v = rd() & 0xff;
    out += hex[v >> 4];
    out += hex[v & 15];
  }
  return out;
}

std::string origin_of(const std::string &url) {
  // scheme://host[:port] — same normalization as the macOS backend.
  auto p = url.find("://");
  if (p == std::string::npos) return "";
  auto end = url.find_first_of("/?#", p + 3);
  std::string scheme = url.substr(0, p), auth = url.substr(p + 3, end == std::string::npos ? std::string::npos : end - p - 3);
  auto at = auth.rfind('@');
  if (at != std::string::npos) auth = auth.substr(at + 1);
  for (auto &ch : scheme) ch = (char)g_ascii_tolower(ch);
  return scheme + "://" + auth;
}

bool same_origin(const std::string &url) {
  std::string app = app_origin();
  return !app.empty() && origin_of(url) == app;
}

static std::string scheme_of(const std::string &url) {
  auto p = url.find(':');
  std::string s = p == std::string::npos ? "" : url.substr(0, p);
  for (auto &ch : s) ch = (char)g_ascii_tolower(ch);
  return s;
}

static bool scheme_is_web(const std::string &url) {
  std::string s = scheme_of(url);
  return s == "http" || s == "https";
}

static bool internal_url(const std::string &url) {
  std::string s = scheme_of(url);
  return s == "about" || s == "data" || s == "blob" || app_origin().empty() || same_origin(url);
}

std::string exe_path() {
  char buf[PATH_MAX];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
  if (n <= 0) return "";
  buf[n] = 0;
  return buf;
}
std::string exe_dir() {
  std::string e = exe_path();
  auto p = e.rfind('/');
  return p == std::string::npos ? "." : e.substr(0, p);
}
bool packaged() { return g_file_test((exe_dir() + "/lib/libshell.so").c_str(), G_FILE_TEST_EXISTS); }

std::string base64_encode(const unsigned char *data, size_t len) {
  gchar *s = g_base64_encode(data, len);
  std::string out = s;
  g_free(s);
  return out;
}
std::vector<unsigned char> base64_decode(const std::string &s, bool *ok) {
  for (char ch : s)
    if (!(g_ascii_isalnum(ch) || ch == '+' || ch == '/' || ch == '=' || g_ascii_isspace(ch))) {
      *ok = false;
      return {};
    }
  gsize n = 0;
  guchar *b = g_base64_decode(s.c_str(), &n);
  std::vector<unsigned char> out(b, b + n);
  g_free(b);
  *ok = n > 0;
  return out;
}

std::string user_dir(GUserDirectory d, const char *fallback) {
  const char *p = g_get_user_special_dir(d);
  if (p && *p) return p;
  return std::string(g_get_home_dir()) + "/" + fallback;
}

// ---------------------------------------------------------------------------
// Windows

Window *find_window(int id) {
  auto it = g_windows.find(id);
  return it == g_windows.end() ? nullptr : it->second;
}
std::vector<int> window_ids() { return g_order; }
int primary_window() { return g_order.empty() ? 0 : g_order.front(); }
int public_id(int native_id) { return (!g_order.empty() && g_order.front() == native_id) ? 0 : native_id; }

int resolve_window(const Call &c) {
  if (c.has("windowId")) {
    int pid = (int)c.num("windowId", -1);
    if (pid == 0) return primary_window();
    return find_window(pid) ? pid : 0;
  }
  if (c.caller && find_window(c.caller)) return c.caller;
  for (int id : g_order)
    if (gtk_window_is_active(GTK_WINDOW(find_window(id)->window))) return id;
  return primary_window();
}

std::string app_name() { return !g_name_override.empty() ? g_name_override : !g_app_name.empty() ? g_app_name : "App"; }
std::string app_identifier() {
  return !g_identifier_override.empty() ? g_identifier_override : !g_app_identifier.empty() ? g_app_identifier : "dev.svelte-desktop.app";
}
std::string app_version() { return g_app_version.empty() ? "0.0.0" : g_app_version; }
void set_app_name_override(const std::string &n) { g_name_override = n; }
void set_app_identifier_override(const std::string &i) { g_identifier_override = i; }

void request_quit() {
  g_quit_requested = true;
  if (g_in_main) gtk_main_quit();
}

GdkRectangle frame_rect(Window *w) {
  GdkRectangle r{0, 0, 0, 0};
  GdkWindow *g = gtk_widget_get_window(w->window);
  if (g && gtk_widget_get_mapped(w->window)) {
    gdk_window_get_frame_extents(g, &r);
    return r;
  }
  gtk_window_get_position(GTK_WINDOW(w->window), &r.x, &r.y);
  gtk_window_get_size(GTK_WINDOW(w->window), &r.width, &r.height);
  return r;
}

GdkRectangle content_rect(Window *w) {
  GdkRectangle r{0, 0, 0, 0};
  gtk_window_get_size(GTK_WINDOW(w->window), &r.width, &r.height);
  GdkWindow *g = gtk_widget_get_window(w->window);
  if (g && gtk_widget_get_mapped(w->window)) gdk_window_get_origin(g, &r.x, &r.y);
  else gtk_window_get_position(GTK_WINDOW(w->window), &r.x, &r.y);
  return r;
}

GdkMonitor *primary_monitor() {
  GdkDisplay *d = gdk_display_get_default();
  GdkMonitor *m = gdk_display_get_primary_monitor(d);
  return m ? m : gdk_display_get_monitor(d, 0);
}
GdkMonitor *monitor_at(int x, int y) { return gdk_display_get_monitor_at_point(gdk_display_get_default(), x, y); }
void pointer_position(int *x, int *y) {
  GdkSeat *seat = gdk_display_get_default_seat(gdk_display_get_default());
  GdkDevice *dev = seat ? gdk_seat_get_pointer(seat) : nullptr;
  *x = *y = 0;
  if (dev) gdk_device_get_position(dev, nullptr, x, y);
}

void reveal(Window *w) {
  if (w->shown) return;
  w->shown = true;
  gtk_widget_show(w->window);
  gtk_window_present(GTK_WINDOW(w->window));
}

static json bounds_event(Window *w) {
  GdkRectangle f = frame_rect(w);
  return json{{"windowId", public_id(w->id)}, {"x", f.x}, {"y", f.y}, {"width", f.width}, {"height", f.height}};
}

static gboolean on_delete(GtkWidget *, GdkEvent *, gpointer data) {
  Window *w = find_window(GPOINTER_TO_INT(data));
  if (w && w->veto && !w->closing) {
    emit("willClose", json{{"windowId", public_id(w->id)}});
    return TRUE; // refuse
  }
  return FALSE;
}

static void on_destroy(GtkWidget *, gpointer data) {
  int id = GPOINTER_TO_INT(data);
  Window *w = find_window(id);
  if (!w) return;
  int pub = public_id(id);
  detach_webview(id);
  g_windows.erase(id);
  g_order.erase(std::remove(g_order.begin(), g_order.end(), id), g_order.end());
  delete w;
  emit_raw(json{{"type", "closed"}, {"window", id}});
  emit("closed", json{{"windowId", pub}});
  if (g_order.empty()) request_quit(); // like webview/webview on macOS: last window ends the loop
}

static gboolean on_focus(GtkWidget *, GdkEventFocus *ev, gpointer data) {
  Window *w = find_window(GPOINTER_TO_INT(data));
  if (!w) return FALSE;
  bool in = ev->in != 0;
  if (w->focused == in) return FALSE;
  w->focused = in;
  emit_raw(json{{"type", in ? "focus" : "blur"}, {"window", w->id}});
  emit("focusChanged", json{{"focused", in}, {"windowId", public_id(w->id)}});
  return FALSE;
}

static void schedule_save(Window *w); // autosaveName (below)

static gboolean on_configure(GtkWidget *, GdkEventConfigure *, gpointer data) {
  Window *w = find_window(GPOINTER_TO_INT(data));
  if (w && w->shown) emit("boundsChanged", bounds_event(w));
  if (w) schedule_save(w);
  return FALSE;
}

static gboolean on_window_state(GtkWidget *, GdkEventWindowState *ev, gpointer data) {
  if (Window *w = find_window(GPOINTER_TO_INT(data))) {
    w->state = ev->new_window_state;
    schedule_save(w);
  }
  return FALSE;
}

static void on_scale(GObject *obj, GParamSpec *, gpointer data) {
  Window *w = find_window(GPOINTER_TO_INT(data));
  if (w) emit("scaleFactorChanged", json{{"scaleFactor", gtk_widget_get_scale_factor(GTK_WIDGET(obj))}, {"windowId", public_id(w->id)}});
}

static gboolean reveal_timeout(gpointer data) {
  if (Window *w = find_window(GPOINTER_TO_INT(data))) reveal(w);
  return G_SOURCE_REMOVE;
}

static void apply_geometry(Window *w) {
  GdkGeometry g{};
  int mask = 0;
  if (w->minW || w->minH) {
    g.min_width = std::max(1, w->minW);
    g.min_height = std::max(1, w->minH);
    mask |= GDK_HINT_MIN_SIZE;
  }
  if (w->maxW || w->maxH) {
    g.max_width = w->maxW ? w->maxW : G_MAXINT16;
    g.max_height = w->maxH ? w->maxH : G_MAXINT16;
    mask |= GDK_HINT_MAX_SIZE;
  }
  gtk_window_set_geometry_hints(GTK_WINDOW(w->window), nullptr, mask ? &g : nullptr, (GdkWindowHints)mask);
}

// ---- autosaveName: position, size and maximized state across launches ------

static std::string g_identifier;

static std::string autosave_file(const std::string &name) {
  const char *state = getenv("XDG_STATE_HOME");
  std::string base = state && *state ? state : std::string(g_get_home_dir()) + "/.local/state";
  std::string safe;
  for (char ch : name) safe += (isalnum((unsigned char)ch) || ch == '-' || ch == '_') ? ch : '_';
  return base + "/" + (g_identifier.empty() ? app_name() : g_identifier) + "/windows/" + safe + ".json";
}

static gboolean save_frame(gpointer data) {
  Window *w = find_window(GPOINTER_TO_INT(data));
  if (!w) return G_SOURCE_REMOVE;
  w->saveTimer = 0;
  json frame{{"x", w->normX}, {"y", w->normY}, {"width", w->normW}, {"height", w->normH},
             {"maximized", (w->state & GDK_WINDOW_STATE_MAXIMIZED) != 0}};
  std::string file = w->autosave;
  gchar *dir = g_path_get_dirname(file.c_str());
  g_mkdir_with_parents(dir, 0700);
  g_free(dir);
  g_file_set_contents(file.c_str(), frame.dump().c_str(), -1, nullptr);
  return G_SOURCE_REMOVE;
}

static void schedule_save(Window *w) {
  if (w->autosave.empty() || !w->shown) return;
  if (!(w->state & (GDK_WINDOW_STATE_MAXIMIZED | GDK_WINDOW_STATE_FULLSCREEN))) {
    gtk_window_get_position(GTK_WINDOW(w->window), &w->normX, &w->normY);
    gtk_window_get_size(GTK_WINDOW(w->window), &w->normW, &w->normH);
  }
  if (w->saveTimer) g_source_remove(w->saveTimer);
  w->saveTimer = g_timeout_add(300, save_frame, GINT_TO_POINTER(w->id));
}

static int create_window(const json &o) {
  auto num = [&](const char *k, double f) { return o.contains(k) && o[k].is_number() ? o[k].get<double>() : f; };
  auto flag = [&](const char *k, bool f) { return o.contains(k) && o[k].is_boolean() ? o[k].get<bool>() : f; };
  auto str = [&](const char *k) { return o.contains(k) && o[k].is_string() ? o[k].get<std::string>() : std::string(); };

  if (g_identifier.empty() && o.contains("identifier") && o["identifier"].is_string()) g_identifier = o["identifier"].get<std::string>();
  // The app's own arguments (first window): URLs / documents it was opened with.
  if (o.contains("args") && o["args"].is_array()) set_launch_args(o["args"], o.value("cwd", std::string()));
  // Opening a document or a link from the desktop starts a new process: hand it to
  // the running instance (openUrls / openFiles there) and leave before any window.
  if (g_order.empty() && o.value("singleInstance", false) && !claim_single_instance()) _exit(0);
  Window *w = new Window;
  w->id = g_next_id++;
  w->label = str("label");
  if (w->label.empty()) w->label = g_order.empty() ? "main" : "window-" + std::to_string(w->id);
  g_windows[w->id] = w;
  g_order.push_back(w->id);

  w->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  GtkWindow *win = GTK_WINDOW(w->window);
  gtk_window_set_title(win, str("title").empty() ? app_name().c_str() : str("title").c_str());
  gtk_window_set_default_size(win, (int)num("width", 1024), (int)num("height", 720));
  w->minW = (int)num("minWidth", 0);
  w->minH = (int)num("minHeight", 0);
  apply_geometry(w);
  if (!flag("resizable", true)) gtk_window_set_resizable(win, FALSE);
  if (!flag("decorations", true)) gtk_window_set_decorated(win, FALSE);
  if (flag("alwaysOnTop", false)) gtk_window_set_keep_above(win, TRUE);
  json saved;
  if (!str("autosaveName").empty()) {
    w->autosave = autosave_file(str("autosaveName"));
    gchar *text = nullptr;
    if (g_file_get_contents(w->autosave.c_str(), &text, nullptr, nullptr)) saved = json::parse(text, nullptr, false);
    g_free(text);
  }
  if (saved.is_object() && saved.value("width", 0) > 0 && saved.value("height", 0) > 0) {
    gtk_window_set_default_size(win, saved.value("width", 1024), saved.value("height", 720));
    gtk_window_move(win, saved.value("x", 0), saved.value("y", 0));
    if (saved.value("maximized", false)) gtk_window_maximize(win);
  } else if (o.contains("x") && o.contains("y")) gtk_window_move(win, (int)num("x", 0), (int)num("y", 0));
  else gtk_window_set_position(win, GTK_WIN_POS_CENTER);

  w->webview = make_webview(w->id, flag("debug", false), "");
  if (!str("titleBarStyle").empty()) set_title_bar_style(w->id, str("titleBarStyle"));
  if (flag("transparent", false)) {
    GdkScreen *screen = gtk_widget_get_screen(w->window);
    if (GdkVisual *v = gdk_screen_get_rgba_visual(screen)) {
      gtk_widget_set_visual(w->window, v);
      gtk_widget_set_app_paintable(w->window, TRUE);
      GdkRGBA clear{0, 0, 0, 0};
      webkit_web_view_set_background_color(w->webview, &clear);
    }
  }
  // window → box (app menu bar, then the overlay) → overlay (the page; view.* on top)
  w->accel = gtk_accel_group_new();
  gtk_window_add_accel_group(win, w->accel);
  w->box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  w->overlay = gtk_overlay_new();
  gtk_container_add(GTK_CONTAINER(w->overlay), GTK_WIDGET(w->webview));
  gtk_box_pack_end(GTK_BOX(w->box), w->overlay, TRUE, TRUE, 0);
  gtk_container_add(GTK_CONTAINER(w->window), w->box);
  gtk_widget_show_all(w->box);
  attach_app_menu(w);

  gpointer id = GINT_TO_POINTER(w->id);
  g_signal_connect(w->window, "delete-event", G_CALLBACK(on_delete), id);
  g_signal_connect(w->window, "destroy", G_CALLBACK(on_destroy), id);
  g_signal_connect(w->window, "focus-in-event", G_CALLBACK(on_focus), id);
  g_signal_connect(w->window, "focus-out-event", G_CALLBACK(on_focus), id);
  g_signal_connect(w->window, "configure-event", G_CALLBACK(on_configure), id);
  g_signal_connect(w->window, "window-state-event", G_CALLBACK(on_window_state), id);
  g_signal_connect(w->window, "notify::scale-factor", G_CALLBACK(on_scale), id);
  gtk_widget_realize(w->window); // geometry ops work before the first show

  // Hidden until DOMContentLoaded (or the timeout) to avoid a white flash. The
  // window is simply not mapped yet: WebKitGTK loads and runs the page anyway.
  bool hidden = flag("hiddenUntilReady", true);
  bool visible = o.contains("visible") ? flag("visible", true) : flag("show", true);
  w->visible = visible;
  if (!visible) w->shown = true; // never auto-reveal; window.show() does
  else if (!hidden) reveal(w);
  else g_timeout_add((guint)num("readyTimeoutMs", 3000), reveal_timeout, id);

  std::string url = str("url"), html = str("html");
  if (!url.empty()) webkit_web_view_load_uri(w->webview, url.c_str());
  else if (!html.empty()) webkit_web_view_load_html(w->webview, html.c_str(), nullptr);
  return w->id;
}

int create_window_from_platform(const json &opts) {
  std::string label = opts.value("label", "");
  if (!label.empty())
    for (auto &[id, w] : g_windows)
      if (w->label == label) return -4;
  json o = opts;
  std::string path = opts.value("path", "/");
  std::string origin = app_origin();
  if (!origin.empty() && !o.contains("url") && !o.contains("html")) o["url"] = origin + (path.rfind('/', 0) == 0 ? path : "/" + path);
  int id = create_window(o);
  if (id > 0) emit("created", json{{"windowId", public_id(id)}, {"label", find_window(id)->label}});
  return id;
}

// ---------------------------------------------------------------------------
// Web views: bridge, navigation policy, crash recovery

static std::string bridge_script(const std::string &nonce) {
  // Same API as kBridgeScript (core.cc); messages carry the nonce (see top of file).
  return "(()=>{if(window.__shell)return;const N=" + json(nonce).dump() +
         ";const S=JSON.stringify,P=JSON.parse;"
         "const h=window.webkit.messageHandlers.__shell__;const send=h.postMessage.bind(h);"
         "const q=[];let sink=null;const raw=(m)=>{m.n=N;send(S(m));};"
         "window.__shell=Object.freeze({"
         "post:(req)=>raw({t:'call',req:typeof req==='string'?P(req):req}),"
         "setSink:(fn)=>{sink=fn;for(const [n,d] of q.splice(0))fn(n,d);},"
         "deliver:(n,d)=>{sink?sink(n,d):q.push([n,d]);}});"
         "document.addEventListener('DOMContentLoaded',()=>raw({t:'ready'}));" +
         std::string(kDragListener) + "})();";
}

static void on_script_message(WebKitUserContentManager *, WebKitJavascriptResult *r, gpointer data) {
  int id = GPOINTER_TO_INT(data);
  auto it = g_pages.find(id);
  if (it == g_pages.end()) return;
  JSCValue *v = webkit_javascript_result_get_js_value(r);
  if (!jsc_value_is_string(v)) return;
  char *s = jsc_value_to_string(v);
  json msg = json::parse(s ? s : "", nullptr, false);
  g_free(s);
  if (!msg.is_object()) return;
  bool trusted = msg.contains("n") && msg["n"].is_string() && msg["n"].get<std::string>() == it->second.nonce;
  msg.erase("n");
  static const bool trace = getenv("SVELTE_DESKTOP_BRIDGE_DEBUG") != nullptr;
  if (trace) fprintf(stderr, "[shell] bridge %d %s origin=%s trusted=%d %.200s\n", id, msg.value("t", "").c_str(), it->second.origin.c_str(), trusted, msg.dump().c_str());
  on_bridge_message(id, msg.dump(), it->second.origin, trusted);
}

static void open_external(int id, const std::string &url) {
  std::string s = scheme_of(url);
  if (s == "http" || s == "https" || s == "mailto") {
    const char *argv[] = {"xdg-open", url.c_str(), nullptr};
    GError *err = nullptr;
    if (!g_spawn_async(nullptr, (char **)argv, nullptr, G_SPAWN_SEARCH_PATH, nullptr, nullptr, nullptr, &err)) {
      g_warning("[shell] xdg-open %s: %s", url.c_str(), err ? err->message : "?");
      g_clear_error(&err);
    }
  }
  emit_raw(json{{"type", "external-navigation"}, {"window", id}, {"url", url}});
}

static gboolean on_decide_policy(WebKitWebView *, WebKitPolicyDecision *d, WebKitPolicyDecisionType type, gpointer data) {
  int id = GPOINTER_TO_INT(data);
  if (type == WEBKIT_POLICY_DECISION_TYPE_RESPONSE) {
    // Top-frame loads that end up on another origin (scripted navigations,
    // server redirects): refused before commit, so the app page stays.
    WebKitResponsePolicyDecision *r = WEBKIT_RESPONSE_POLICY_DECISION(d);
    if (!webkit_response_policy_decision_is_main_frame_main_resource(r)) return FALSE;
    const char *uri = webkit_uri_response_get_uri(webkit_response_policy_decision_get_response(r));
    if (!uri || internal_url(uri)) return FALSE;
    webkit_policy_decision_ignore(d);
    open_external(id, uri);
    return TRUE;
  }
  WebKitNavigationAction *a = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(d));
  const char *uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(a));
  std::string url = uri ? uri : "";
  if (type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) { // target=_blank, window.open
    webkit_policy_decision_ignore(d);
    if (!url.empty() && url != "about:blank") open_external(id, url);
    return TRUE;
  }
  if (internal_url(url)) return FALSE;
  // The navigation decision doesn't say which frame it targets. Link clicks and
  // form submissions to another origin leave the app right away (no request
  // sent, macOS parity); other loads (iframe src, scripted top-level
  // navigations) proceed, and the top-frame ones are refused at response time
  // above (or, when the request fails, in on_load_failed).
  WebKitNavigationType nt = webkit_navigation_action_get_navigation_type(a);
  if (nt == WEBKIT_NAVIGATION_TYPE_LINK_CLICKED || nt == WEBKIT_NAVIGATION_TYPE_FORM_SUBMITTED || !scheme_is_web(url)) {
    webkit_policy_decision_ignore(d);
    open_external(id, url);
    return TRUE;
  }
  return FALSE;
}

// window.open() asks for a new web view: hand the URL to the browser instead.
static GtkWidget *on_create(WebKitWebView *, WebKitNavigationAction *a, gpointer data) {
  const char *uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(a));
  if (uri && *uri && strcmp(uri, "about:blank") != 0) open_external(GPOINTER_TO_INT(data), uri);
  return nullptr;
}

void page_committed(int native_id, const char *uri) {
  page_unloaded(native_id); // until the new document's bridge reports ready
  auto it = g_pages.find(native_id);
  if (it != g_pages.end()) it->second.origin = origin_of(uri ? uri : "");
}

static void on_load_changed(WebKitWebView *wv, WebKitLoadEvent ev, gpointer data) {
  if (ev != WEBKIT_LOAD_COMMITTED) return;
  page_committed(GPOINTER_TO_INT(data), webkit_web_view_get_uri(wv));
}

static gboolean on_load_failed(WebKitWebView *, WebKitLoadEvent, gchar *uri, GError *err, gpointer data) {
  if (!uri || internal_url(uri)) return FALSE;
  // Refused by the response policy above (already handed over) or cancelled.
  if (err && (err->domain == WEBKIT_POLICY_ERROR || g_error_matches(err, WEBKIT_NETWORK_ERROR, WEBKIT_NETWORK_ERROR_CANCELLED))) return TRUE;
  // A top-level load to another origin that failed before any response (offline,
  // DNS): no WebKit error page in place of the app — hand it to the browser.
  open_external(GPOINTER_TO_INT(data), uri);
  return TRUE;
}

static gboolean on_web_process_terminated(WebKitWebView *wv, WebKitWebProcessTerminationReason, gpointer data) {
  // Electrobun #550-style "web process died": reload instead of a dead view.
  emit_raw(json{{"type", "webcontent-terminated"}, {"window", GPOINTER_TO_INT(data)}});
  webkit_web_view_reload(wv);
  return FALSE;
}

static void on_webview_close(WebKitWebView *, gpointer data) {
  int id = GPOINTER_TO_INT(data);
  if (Window *w = find_window(id)) gtk_window_close(GTK_WINDOW(w->window)); // window.close() from the page
  else if (!popover_ident(id).empty()) emit("closeRequested", json{{"popoverId", popover_ident(id)}});
}

WebKitWebView *make_webview(int native_id, bool debug, const std::string &extra_script) {
  WebKitUserContentManager *ucm = webkit_user_content_manager_new();
  WebKitWebView *wv = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW, "user-content-manager", ucm, nullptr));
  g_object_unref(ucm); // the view holds it
  Page page;
  page.wv = wv;
  page.nonce = random_hex(16);
  gpointer id = GINT_TO_POINTER(native_id);
  g_signal_connect(ucm, "script-message-received::__shell__", G_CALLBACK(on_script_message), id);
  webkit_user_content_manager_register_script_message_handler(ucm, "__shell__");
  for (const std::string &src : {bridge_script(page.nonce), extra_script}) {
    if (src.empty()) continue;
    WebKitUserScript *us = webkit_user_script_new(src.c_str(), WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
                                                  WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, nullptr, nullptr);
    webkit_user_content_manager_add_script(ucm, us);
    webkit_user_script_unref(us);
  }
  WebKitSettings *settings = webkit_web_view_get_settings(wv);
  webkit_settings_set_enable_developer_extras(settings, debug);
  webkit_settings_set_javascript_can_access_clipboard(settings, TRUE);
  // window.open must reach decide-policy (→ default browser) instead of being
  // swallowed by the popup blocker.
  webkit_settings_set_javascript_can_open_windows_automatically(settings, TRUE);
  g_signal_connect(wv, "decide-policy", G_CALLBACK(on_decide_policy), id);
  g_signal_connect(wv, "load-changed", G_CALLBACK(on_load_changed), id);
  g_signal_connect(wv, "load-failed", G_CALLBACK(on_load_failed), id);
  g_signal_connect(wv, "create", G_CALLBACK(on_create), id);
  g_signal_connect(wv, "web-process-terminated", G_CALLBACK(on_web_process_terminated), id);
  g_signal_connect(wv, "close", G_CALLBACK(on_webview_close), id);
  g_pages[native_id] = page;
  return wv;
}

void detach_webview(int native_id) {
  auto it = g_pages.find(native_id);
  if (it == g_pages.end()) return;
  if (it->second.wv) {
    WebKitUserContentManager *ucm = webkit_web_view_get_user_content_manager(it->second.wv);
    g_signal_handlers_disconnect_by_func(ucm, (gpointer)on_script_message, GINT_TO_POINTER(native_id));
    webkit_user_content_manager_unregister_script_message_handler(ucm, "__shell__");
  }
  g_pages.erase(it);
}

WebKitWebView *webview_for(int native_id) {
  auto it = g_pages.find(native_id);
  return it == g_pages.end() ? nullptr : it->second.wv;
}

// ---------------------------------------------------------------------------
// Signals

static gboolean on_signal(gpointer name) {
  emit_raw(json{{"type", "signal"}, {"signal", (const char *)name}});
  request_quit();
  return G_SOURCE_CONTINUE;
}

static void install_signal_sources() {
  // Bun's own handlers can't run while its main thread is parked in gtk_main, so
  // signals become a graceful quit here (then main.ts drains the Worker).
  static bool done = false;
  if (done) return;
  done = true;
  g_unix_signal_add(SIGINT, on_signal, (gpointer) "SIGINT");
  g_unix_signal_add(SIGTERM, on_signal, (gpointer) "SIGTERM");
  g_unix_signal_add(SIGHUP, on_signal, (gpointer) "SIGHUP");
}

// Legacy shell_dialog: every kind maps onto the dialog service (svc_dialog.cc).
static void legacy_dialog(int request_id, json o) { dialog_legacy(request_id, o); }

} // namespace lx

// ---------------------------------------------------------------------------
// Hooks of the portable core

void backend_run_on_main(std::function<void()> fn) {
  auto *p = new std::function<void()>(std::move(fn));
  g_idle_add_full(
      G_PRIORITY_DEFAULT,
      [](gpointer d) -> gboolean {
        auto *f = static_cast<std::function<void()> *>(d);
        (*f)();
        return G_SOURCE_REMOVE;
      },
      p, [](gpointer d) { delete static_cast<std::function<void()> *>(d); });
}

bool backend_is_main_thread() { return lx::g_gtk_ready && std::this_thread::get_id() == lx::g_main_thread; }

void backend_eval_in_page(int native_id, const std::string &js) {
  if (WebKitWebView *wv = lx::webview_for(native_id))
    webkit_web_view_evaluate_javascript(wv, js.c_str(), (gssize)js.size(), nullptr, nullptr, nullptr, nullptr, nullptr);
}

std::vector<int> backend_page_ids() {
  std::vector<int> out;
  for (auto &[id, _] : lx::g_pages) out.push_back(id);
  return out;
}

void backend_page_ready(int native_id) {
  if (lx::Window *w = lx::find_window(native_id)) {
    lx::reveal(w);
    emit_raw(json{{"type", "ready"}, {"window", native_id}});
    lx::flush_open_requests();
    return;
  }
  lx::popover_page_ready(native_id);
}

int backend_public_window_id(int native_id) { return lx::public_id(native_id); }
int backend_native_window_id(int public_id) {
  if (public_id == 0) return lx::primary_window();
  return lx::find_window(public_id) ? public_id : 0;
}
void *backend_native_window(int native_id) {
  lx::Window *w = lx::find_window(native_id);
  return w ? w->window : nullptr;
}
void *backend_native_webview(int native_id) { return lx::webview_for(native_id); }

// Hidden title bar: an undecorated window (the page draws its own controls and drags
// it through its drag regions).
void backend_set_frameless(int native_id, bool frameless) {
  if (lx::Window *w = lx::find_window(native_id)) gtk_window_set_decorated(GTK_WINDOW(w->window), !frameless);
}

void backend_window_drag(int native_id, bool double_click) {
  lx::Window *w = lx::find_window(native_id);
  if (!w) return;
  GtkWindow *win = GTK_WINDOW(w->window);
  if (double_click) {
    if (gtk_window_is_maximized(win)) gtk_window_unmaximize(win);
    else gtk_window_maximize(win);
    return;
  }
  GdkDisplay *display = gtk_widget_get_display(w->window);
  GdkDevice *pointer = gdk_seat_get_pointer(gdk_display_get_default_seat(display));
  int x = 0, y = 0;
  gdk_device_get_position(pointer, nullptr, &x, &y);
  gtk_window_begin_move_drag(win, 1, x, y, GDK_CURRENT_TIME);
}

void backend_init_services() {
  lx::register_app();
  lx::register_window();
  lx::register_extra();
  lx::register_view();
  lx::register_misc();
  lx::register_dialog();
  lx::register_webview();
  lx::register_optional();
}

} // namespace sd

// ---------------------------------------------------------------------------
// C exports (window + run loop half of shell.h; the rest lives in core.cc)

using sd::json;
namespace lx = sd::lx;

#define ON_WINDOW(id_, body)                                                                                           \
  do {                                                                                                                 \
    int wid_ = (id_);                                                                                                  \
    sd::backend_run_on_main([=] {                                                                                      \
      lx::Window *w = lx::find_window(wid_);                                                                           \
      if (!w) return;                                                                                                  \
      body;                                                                                                            \
    });                                                                                                                \
    return 0;                                                                                                          \
  } while (0)

extern "C" {

SHELL_API int shell_window_create(const char *opts_json) {
  json o = lx::parse(opts_json);
  if (!lx::g_gtk_ready) {
    lx::g_main_thread = std::this_thread::get_id();
    if (o.contains("identifier") && o["identifier"].is_string()) g_set_prgname(o["identifier"].get<std::string>().c_str());
    if (o.contains("appName") && o["appName"].is_string()) g_set_application_name(o["appName"].get<std::string>().c_str());
    if (!gtk_init_check(nullptr, nullptr)) {
      fprintf(stderr, "[shell] gtk_init failed (no display? set DISPLAY or WAYLAND_DISPLAY)\n");
      return -1;
    }
    lx::g_gtk_ready = true;
  } else if (!sd::backend_is_main_thread()) {
    return -2;
  }
  auto take = [&](const char *k, std::string &dst) {
    if (dst.empty() && o.contains(k) && o[k].is_string()) dst = o[k].get<std::string>();
  };
  take("appName", lx::g_app_name);
  take("identifier", lx::g_app_identifier);
  take("version", lx::g_app_version);
  if (lx::g_app_version.empty())
    if (const char *v = getenv("SVELTE_DESKTOP_APP_VERSION")) lx::g_app_version = v;
  return lx::create_window(o);
}

SHELL_API int shell_run(void) {
  if (!sd::backend_is_main_thread()) return -2;
  if (lx::g_order.empty()) return -1;
  lx::install_signal_sources();
  // Register the services now: their startup work (scheduled notifications) runs
  // before the first platform call.
  sd::dispatch(json{{"service", ""}, {"op", ""}}, 0, [](const json &) {});
  if (lx::g_quit_requested) return 0;
  lx::g_in_main = true;
  gtk_main();
  lx::g_in_main = false;
  return 0;
}

SHELL_API int shell_quit(void) {
  sd::backend_run_on_main([] { lx::request_quit(); });
  return 0;
}

SHELL_API int shell_window_navigate(int id, const char *url) {
  if (!url) return -3;
  std::string s(url);
  ON_WINDOW(id, webkit_web_view_load_uri(w->webview, s.c_str()));
}
SHELL_API int shell_window_eval(int id, const char *js) {
  if (!js) return -3;
  std::string s(js);
  ON_WINDOW(id, webkit_web_view_evaluate_javascript(w->webview, s.c_str(), (gssize)s.size(), nullptr, nullptr, nullptr, nullptr, nullptr));
}
SHELL_API int shell_window_set_title(int id, const char *title) {
  if (!title) return -3;
  std::string s(title);
  ON_WINDOW(id, gtk_window_set_title(GTK_WINDOW(w->window), s.c_str()));
}
SHELL_API int shell_window_set_size(int id, int width, int height) {
  ON_WINDOW(id, gtk_window_resize(GTK_WINDOW(w->window), std::max(1, width), std::max(1, height)));
}
SHELL_API int shell_window_show(int id) {
  ON_WINDOW(id, {
    w->shown = false;
    lx::reveal(w);
  });
}
SHELL_API int shell_window_hide(int id) { ON_WINDOW(id, gtk_widget_hide(w->window)); }
SHELL_API int shell_window_focus(int id) {
  ON_WINDOW(id, {
    lx::reveal(w);
    gtk_window_present(GTK_WINDOW(w->window));
  });
}
// OS-style close: goes through delete-event, so an armed close veto applies.
SHELL_API int shell_window_close(int id) { ON_WINDOW(id, gtk_window_close(GTK_WINDOW(w->window))); }

// No default menu on Linux: WebKitGTK handles the editing shortcuts itself and
// GTK apps don't have a global menu bar. Accepted and ignored.
SHELL_API int shell_menu_set(const char *spec_json) {
  json spec = lx::parse(spec_json);
  return spec.is_array() ? 0 : -3;
}

SHELL_API int shell_dialog(int request_id, const char *opts_json) {
  json o = lx::parse(opts_json);
  if (!o.is_object()) return -3;
  sd::backend_run_on_main([request_id, o] { lx::legacy_dialog(request_id, o); });
  return 0;
}
}
