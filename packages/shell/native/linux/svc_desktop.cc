// The app on the desktop, same ops and replies as macOS where Linux has a meaning for them:
//   app.metrics: /proc for this process and everything it started (no public API says which web
//     view a WebKitWebProcess draws: no windowId).
//   app.addRecentDocument, clearRecentDocuments: GtkRecentManager. It's the user's list across apps:
//     clearing removes what only this app added.
//   app.setDockBadge, setDockProgress: the Unity LauncherEntry signal (Ubuntu dock, KDE, Plank…).
//     It carries a count and a fraction, so a badge is a number and progress has no colors. Docks
//     can't be read back: the getters say what the app set.
//   app.bounceDock: the windows' urgency hint. app.setDockIcon, setIcon: the windows' icon.
//   app.setActivationPolicy: `accessory` as skip-taskbar and skip-pager on the app's windows.
//   files.*: no sandbox to get through, so a bookmark is the path and the file's identity.
//   Wayland: shortcuts.* and capture.* through xdg-desktop-portal (called from svc_extra.cc).
#include <glib/gstdio.h>
#include <sys/stat.h>
#include <unistd.h>

#include <climits>
#include <deque>
#include <fstream>
#include <map>
#include <sstream>

#include "linux.hpp"

namespace sd {
namespace lx {

// ---------------------------------------------------------------------------
// app.metrics

struct ProcStat {
  int ppid = 0;
  double cpu = 0; // seconds
  char state = 0;
  std::string comm;
};

static bool read_stat(int pid, ProcStat *out) {
  std::ifstream f("/proc/" + std::to_string(pid) + "/stat");
  std::string s((std::istreambuf_iterator<char>(f)), {});
  auto open = s.find('('), close = s.rfind(')');
  if (open == std::string::npos || close == std::string::npos) return false;
  out->comm = s.substr(open + 1, close - open - 1);
  std::istringstream rest(s.substr(close + 2));
  std::string field;
  unsigned long long ticks = 0;
  for (int i = 3; i <= 15 && rest >> field; i++) {
    if (i == 3) out->state = field[0];
    if (i == 4) out->ppid = atoi(field.c_str());
    if (i == 14 || i == 15) ticks += strtoull(field.c_str(), nullptr, 10);
  }
  out->cpu = (double)ticks / (double)sysconf(_SC_CLK_TCK);
  return true;
}

// Footprint: what this process alone holds (private pages and its swap), which adds up across
// processes. Resident also counts the libraries it shares with others.
static void read_memory(int pid, unsigned long long *footprint, unsigned long long *resident) {
  std::ifstream f("/proc/" + std::to_string(pid) + "/smaps_rollup");
  std::string key;
  unsigned long long kb = 0;
  *footprint = *resident = 0;
  std::string line;
  while (std::getline(f, line)) {
    std::istringstream l(line);
    if (!(l >> key >> kb)) continue;
    if (key == "Rss:") *resident = kb * 1024;
    if (key == "Private_Clean:" || key == "Private_Dirty:" || key == "Swap:") *footprint += kb * 1024;
  }
}

static std::string exe_of(int pid) {
  char buf[PATH_MAX];
  ssize_t n = readlink(("/proc/" + std::to_string(pid) + "/exe").c_str(), buf, sizeof buf - 1);
  return n > 0 ? std::string(buf, (size_t)n) : "";
}

static void app_metrics(CallPtr c) {
  static std::map<int, std::pair<double, gint64>> last; // pid → CPU seconds, when
  std::map<int, ProcStat> all;
  std::map<int, std::vector<int>> children;
  if (GDir *dir = g_dir_open("/proc", 0, nullptr)) {
    while (const char *name = g_dir_read_name(dir)) {
      int pid = atoi(name);
      ProcStat st;
      if (pid > 0 && read_stat(pid, &st)) {
        all[pid] = st;
        children[st.ppid].push_back(pid);
      }
    }
    g_dir_close(dir);
  }
  int me = getpid();
  std::string myExe = exe_of(me);
  std::vector<int> pids{me};
  for (size_t i = 0; i < pids.size(); i++) // and what it started, and what those started
    for (int kid : children[pids[i]]) pids.push_back(kid);
  json rows = json::array();
  std::map<int, std::pair<double, gint64>> seen;
  unsigned long long total = 0;
  gint64 now = g_get_monotonic_time();
  for (int pid : pids) {
    auto it = all.find(pid);
    if (it == all.end() || it->second.state == 'Z') continue;
    const ProcStat &st = it->second;
    unsigned long long footprint, resident;
    read_memory(pid, &footprint, &resident);
    total += footprint;
    std::string exe = exe_of(pid);
    gchar *base = exe.empty() ? nullptr : g_path_get_basename(exe.c_str());
    std::string name = base ? base : st.comm; // comm stops at 15 characters: WebKitWebProces
    g_free(base);
    const char *type = pid == me ? "main" : name.rfind("WebKitWebProcess", 0) == 0 ? "webview" : name.rfind("python", 0) == 0 ? "python" : exe == myExe ? "helper" : "child";
    json percent = nullptr;
    auto prev = last.find(pid);
    if (prev != last.end() && now > prev->second.second) percent = std::max(0.0, (st.cpu - prev->second.first) / ((double)(now - prev->second.second) / 1e6) * 100);
    seen[pid] = {st.cpu, now};
    rows.push_back(json{{"pid", pid}, {"type", type}, {"name", name}, {"memory", {{"footprint", footprint}, {"resident", resident}}}, {"cpu", {{"time", st.cpu}, {"percent", percent}}}});
  }
  last = seen;
  c->ok(json{{"processes", rows}, {"memory", {{"footprint", total}}}});
}

// ---------------------------------------------------------------------------
// Recent documents

static void add_recent(CallPtr c) {
  std::string path = c->str("path");
  if (path.empty()) return c->fail("invalid_args", "app.addRecentDocument: `path` is required");
  gchar *uri = g_filename_to_uri(path.c_str(), nullptr, nullptr);
  if (!uri) return c->fail("invalid_args", "app.addRecentDocument: `path` must be absolute");
  gtk_recent_manager_add_item(gtk_recent_manager_get_default(), uri);
  g_free(uri);
  c->ok();
}

static void clear_recent(CallPtr c) {
  GtkRecentManager *manager = gtk_recent_manager_get_default();
  const char *me = g_get_application_name(); // what add_item registers them under
  GList *items = gtk_recent_manager_get_items(manager);
  for (GList *l = items; l; l = l->next) {
    auto *info = static_cast<GtkRecentInfo *>(l->data);
    gsize apps = 0;
    g_strfreev(gtk_recent_info_get_applications(info, &apps));
    if (apps == 1 && gtk_recent_info_has_application(info, me)) gtk_recent_manager_remove_item(manager, gtk_recent_info_get_uri(info), nullptr);
    gtk_recent_info_unref(info);
  }
  g_list_free(items);
  c->ok();
}

// ---------------------------------------------------------------------------
// The launcher entry and the windows

static json g_dock_progress = json{{"status", "none"}}, g_dock_icon;
static std::string g_activation_policy = "regular";

void apply_activation_policy(Window *w) {
  bool skip = g_activation_policy == "accessory";
  gtk_window_set_skip_taskbar_hint(GTK_WINDOW(w->window), skip);
  gtk_window_set_skip_pager_hint(GTK_WINDOW(w->window), skip);
}

static void set_dock_badge(CallPtr c) {
  std::string text = c->str("text");
  // The signal carries a number. Anything else can't be shown: false, and no old number left behind.
  bool number = !text.empty() && text.size() < 16 && text.find_first_not_of("0123456789") == std::string::npos;
  std::string err = set_badge_count(number ? atoll(text.c_str()) : 0);
  c->ok(err.empty() && (number || text.empty()));
}

static void set_dock_progress(CallPtr c) {
  std::string status = c->str("status", "normal");
  double total = c->num("total", 1), done = c->num("completed", 0);
  // An indeterminate bar is a full one, as macOS draws it: the signal has no animation.
  double fraction = status == "indeterminate" ? 1 : total > 0 ? std::max(0.0, std::min(1.0, done / total)) : 0;
  GVariantBuilder b;
  g_variant_builder_init(&b, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&b, "{sv}", "progress", g_variant_new_double(status == "none" ? 0 : fraction));
  g_variant_builder_add(&b, "{sv}", "progress-visible", g_variant_new_boolean(status != "none"));
  std::string err = launcher_update(g_variant_builder_end(&b));
  if (!err.empty()) return c->fail("unavailable", "app.setDockProgress: " + err);
  g_dock_progress = status == "none" ? json{{"status", "none"}} : json{{"status", status}, {"completed", done}, {"total", total}};
  c->ok();
}

static gboolean on_attention_answered(GtkWidget *win, GdkEvent *, gpointer) {
  gtk_window_set_urgency_hint(GTK_WINDOW(win), FALSE);
  return FALSE;
}

// Asks for the user's attention until they come to a window. Already there: nothing to ask, as on macOS.
static void bounce_dock(CallPtr c) {
  Window *target = nullptr;
  for (int id : window_ids()) {
    Window *w = find_window(id);
    if (gtk_window_is_active(GTK_WINDOW(w->window))) return c->ok(true);
    if (!target && gtk_widget_get_visible(w->window)) target = w;
  }
  if (!target) return c->ok(false);
  if (!g_object_get_data(G_OBJECT(target->window), "sd-attention")) {
    g_object_set_data(G_OBJECT(target->window), "sd-attention", GINT_TO_POINTER(1));
    g_signal_connect(target->window, "focus-in-event", G_CALLBACK(on_attention_answered), nullptr);
  }
  gtk_window_set_urgency_hint(GTK_WINDOW(target->window), TRUE);
  c->ok(true);
}

static void set_icon(CallPtr c) {
  GdkPixbuf *image = nullptr;
  bool restore = !c->has("icon");
  if (restore) { // the packaged app's own, else none: GTK's generic one
    std::string own = exe_dir() + "/" + app_identifier() + ".png";
    image = gdk_pixbuf_new_from_file(own.c_str(), nullptr);
  } else {
    std::string code, error, icon = resolve_icon(c->args["icon"], &code, &error);
    if (icon.empty()) return c->fail("invalid_args", "app.setDockIcon: " + error);
    GError *err = nullptr;
    image = icon.find('/') != std::string::npos ? gdk_pixbuf_new_from_file(icon.c_str(), &err)
                                                : gtk_icon_theme_load_icon(gtk_icon_theme_get_default(), icon.c_str(), 128, GTK_ICON_LOOKUP_USE_BUILTIN, &err);
    if (!image) {
      std::string m = err ? err->message : "no such icon";
      g_clear_error(&err);
      return c->fail("invalid_args", "app.setDockIcon: " + m);
    }
  }
  // The windows to come, then the ones there are.
  if (image) gtk_window_set_default_icon(image);
  else gtk_window_set_default_icon_list(nullptr);
  for (int id : window_ids()) gtk_window_set_icon(GTK_WINDOW(find_window(id)->window), image);
  if (image) g_object_unref(image);
  g_dock_icon = restore ? json(nullptr) : c->args["icon"];
  c->ok();
}

// ---------------------------------------------------------------------------
// files.*: {path, dev, ino} in base64. The file at its path with the same identity: not stale.
// Renamed in its folder, or something else in its place: stale. Gone from the folder: it can't be
// found, there's no index of files to ask.

static void create_bookmark(CallPtr c) {
  std::string path = c->str("path");
  if (path.rfind("~/", 0) == 0) path = std::string(g_get_home_dir()) + path.substr(1);
  if (!g_path_is_absolute(path.c_str())) return c->fail("invalid_args", "files.createBookmark: absolute path required");
  struct stat st;
  if (stat(path.c_str(), &st) != 0) return c->fail("unavailable", "files.createBookmark: no such file `" + path + "`");
  std::string data = json{{"path", path}, {"dev", (unsigned long long)st.st_dev}, {"ino", (unsigned long long)st.st_ino}}.dump();
  c->ok(json{{"bookmark", base64_encode((const unsigned char *)data.data(), data.size())}});
}

static void open_bookmark(CallPtr c) {
  bool decoded = false;
  auto bytes = base64_decode(c->str("bookmark"), &decoded);
  json b = decoded ? json::parse(bytes.begin(), bytes.end(), nullptr, false) : json();
  if (!b.is_object() || !b.contains("path") || !b["path"].is_string() || !b.contains("dev") || !b["dev"].is_number() || !b.contains("ino") || !b["ino"].is_number())
    return c->fail("invalid_args", "files.openBookmark: invalid bookmark");
  std::string path = b["path"], found;
  unsigned long long dev = b["dev"], ino = b["ino"];
  auto same = [&](const std::string &p) {
    struct stat st;
    return stat(p.c_str(), &st) == 0 && (unsigned long long)st.st_dev == dev && (unsigned long long)st.st_ino == ino;
  };
  bool stale = false;
  if (same(path)) found = path;
  else {
    stale = true;
    gchar *parent = g_path_get_dirname(path.c_str());
    if (GDir *dir = g_dir_open(parent, 0, nullptr)) {
      while (const char *name = g_dir_read_name(dir))
        if (same(std::string(parent) + "/" + name)) {
          found = std::string(parent) + "/" + name;
          break;
        }
      g_dir_close(dir);
    }
    g_free(parent);
    if (found.empty() && g_file_test(path.c_str(), G_FILE_TEST_EXISTS)) found = path;
  }
  if (found.empty()) return c->fail("unavailable", "files.openBookmark: the file is gone from `" + path + "`");
  gchar *id = g_uuid_string_random(); // nothing to hold on to here: for release, which has nothing to do
  c->ok(json{{"id", id}, {"path", found}, {"stale", stale}});
  g_free(id);
}

// ---------------------------------------------------------------------------
// xdg-desktop-portal: a call answers with a Request object, whose Response signal has the result.
// It's subscribed to before the call: its path is known from the token (the portal's documented way).

static const char *const kPortalName = "org.freedesktop.portal.Desktop", *const kPortalPath = "/org/freedesktop/portal/desktop";
static const char *const kPortalShortcuts = "org.freedesktop.portal.GlobalShortcuts", *const kPortalScreenshot = "org.freedesktop.portal.Screenshot";

using PortalDone = std::function<void(const std::string &error, guint32 response, GVariant *results)>;
struct PortalRequest {
  GDBusConnection *bus;
  guint subscription;
  PortalDone done;
};

static std::string portal_token() {
  static int next = 1;
  return "kitop" + std::to_string(getpid()) + "_" + std::to_string(next++);
}

// A host app says who it is, once, before its first portal call. Older portals don't have this.
static void portal_register_app(GDBusConnection *bus) {
  static bool done = false;
  if (done) return;
  done = true;
  g_dbus_connection_call(bus, kPortalName, kPortalPath, "org.freedesktop.host.portal.Registry", "Register",
                         g_variant_new_parsed("(%s, @a{sv} {})", app_identifier().c_str()), nullptr, G_DBUS_CALL_FLAGS_NONE, -1, nullptr, nullptr, nullptr);
}

static void portal_request(const char *interface, const char *method, const std::function<GVariant *(const std::string &token)> &params, PortalDone done) {
  GError *err = nullptr;
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &err);
  if (!bus) {
    std::string m = err ? err->message : "no session bus";
    g_clear_error(&err);
    return done(m, 2, nullptr);
  }
  portal_register_app(bus);
  std::string sender = g_dbus_connection_get_unique_name(bus) + 1, token = portal_token();
  for (auto &ch : sender)
    if (ch == '.') ch = '_';
  std::string path = std::string(kPortalPath) + "/request/" + sender + "/" + token;
  auto *r = new PortalRequest{bus, 0, std::move(done)};
  r->subscription = g_dbus_connection_signal_subscribe(bus, kPortalName, "org.freedesktop.portal.Request", "Response", path.c_str(), nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
      [](GDBusConnection *, const gchar *, const gchar *, const gchar *, const gchar *, GVariant *args, gpointer data) {
        auto *r = static_cast<PortalRequest *>(data);
        guint32 response = 2;
        GVariant *results = nullptr;
        g_variant_get(args, "(u@a{sv})", &response, &results);
        g_dbus_connection_signal_unsubscribe(r->bus, r->subscription);
        r->done("", response, results);
        g_variant_unref(results);
        g_object_unref(r->bus);
        delete r;
      }, r, nullptr);
  g_dbus_connection_call(bus, kPortalName, kPortalPath, interface, method, params(token), G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, 10000, nullptr,
      [](GObject *src, GAsyncResult *res, gpointer data) {
        auto *r = static_cast<PortalRequest *>(data);
        GError *err = nullptr;
        GVariant *v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, &err);
        if (v) return g_variant_unref(v); // the answer is the signal's
        std::string m = err ? err->message : "no reply";
        g_clear_error(&err);
        g_dbus_connection_signal_unsubscribe(r->bus, r->subscription);
        r->done(m, 2, nullptr);
        g_object_unref(r->bus);
        delete r;
      }, r);
}

void portal_version(const char *interface, std::function<void(unsigned)> done) {
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
  if (!bus) return done(0);
  g_dbus_connection_call(bus, kPortalName, kPortalPath, "org.freedesktop.DBus.Properties", "Get", g_variant_new("(ss)", interface, "version"),
      G_VARIANT_TYPE("(v)"), G_DBUS_CALL_FLAGS_NONE, 5000, nullptr,
      [](GObject *src, GAsyncResult *res, gpointer data) {
        auto *f = static_cast<std::function<void(unsigned)> *>(data);
        GVariant *v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, nullptr);
        unsigned version = 0;
        if (v) {
          GVariant *inner = nullptr;
          g_variant_get(v, "(v)", &inner);
          if (g_variant_is_of_type(inner, G_VARIANT_TYPE_UINT32)) version = g_variant_get_uint32(inner);
          g_variant_unref(inner);
          g_variant_unref(v);
        }
        (*f)(version);
        delete f;
      }, new std::function<void(unsigned)>(std::move(done)));
  g_object_unref(bus);
}

// ---- screenshots ----------------------------------------------------------

void portal_screenshot(CallPtr c, std::function<void(GdkPixbuf *)> done) {
  portal_request(kPortalScreenshot, "Screenshot", [](const std::string &token) {
    GVariantBuilder o;
    g_variant_builder_init(&o, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&o, "{sv}", "handle_token", g_variant_new_string(token.c_str()));
    g_variant_builder_add(&o, "{sv}", "interactive", g_variant_new_boolean(FALSE));
    return g_variant_new("(sa{sv})", "", &o);
  }, [c, done](const std::string &error, guint32 response, GVariant *results) {
    if (!error.empty()) return c->fail("unavailable", "capture.captureSource: no desktop portal for screenshots: " + error);
    if (response != 0) return c->fail("denied", "capture.captureSource: the desktop refused the screenshot");
    const char *uri = nullptr;
    g_variant_lookup(results, "uri", "&s", &uri);
    gchar *file = uri ? g_filename_from_uri(uri, nullptr, nullptr) : nullptr;
    GdkPixbuf *image = file ? gdk_pixbuf_new_from_file(file, nullptr) : nullptr;
    if (file) g_unlink(file); // it was made for this call, and is ours to keep or not: the caller has the bytes
    g_free(file);
    if (!image) return c->fail("internal", "capture.captureSource: the portal's screenshot can't be read");
    done(image);
  });
}

// ---- global shortcuts -----------------------------------------------------
// A session binds its shortcuts once (the portal's rule), so a change is a new session with all of them.
// The old session closes only when the new one is bound: a refusal leaves things as they were.

struct PortalKey {
  std::string accel, trigger;
};
static std::map<std::string, PortalKey> g_portal_keys;
static std::string g_portal_session;
static std::deque<std::function<void()>> g_portal_queue; // one change at a time
static bool g_portal_busy = false;

static void portal_next() {
  g_portal_busy = false;
  if (g_portal_queue.empty()) return;
  auto fn = std::move(g_portal_queue.front());
  g_portal_queue.pop_front();
  g_portal_busy = true;
  fn();
}

static void portal_enqueue(std::function<void()> fn) {
  g_portal_queue.push_back(std::move(fn));
  if (!g_portal_busy) portal_next();
}

static std::string portal_trigger(guint key, GdkModifierType mods) { // the XDG shortcuts format
  std::string out;
  if (mods & GDK_CONTROL_MASK) out += "CTRL+";
  if (mods & GDK_MOD1_MASK) out += "ALT+";
  if (mods & GDK_SHIFT_MASK) out += "SHIFT+";
  if (mods & GDK_SUPER_MASK) out += "LOGO+";
  const char *name = gdk_keyval_name(key);
  return out + (name ? name : "");
}

static void on_portal_shortcut(GDBusConnection *, const gchar *, const gchar *, const gchar *, const gchar *signal, GVariant *args, gpointer) {
  const char *session = nullptr, *id = nullptr;
  guint64 timestamp = 0;
  g_variant_get(args, "(&o&st@a{sv})", &session, &id, &timestamp, nullptr);
  auto it = g_portal_keys.find(id);
  if (g_portal_session != session || it == g_portal_keys.end()) return;
  emit(g_strcmp0(signal, "Activated") == 0 ? "shortcutPressed" : "shortcutReleased", json{{"id", id}, {"accelerator", it->second.accel}});
}

static void portal_close_session(const std::string &session) {
  if (session.empty()) return;
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
  if (!bus) return;
  g_dbus_connection_call(bus, kPortalName, session.c_str(), "org.freedesktop.portal.Session", "Close", nullptr, nullptr, G_DBUS_CALL_FLAGS_NONE, -1, nullptr, nullptr, nullptr);
  g_object_unref(bus);
}

static void portal_listen() {
  static bool done = false;
  GDBusConnection *bus = done ? nullptr : g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
  if (!bus) return;
  done = true;
  for (const char *signal : {"Activated", "Deactivated"})
    g_dbus_connection_signal_subscribe(bus, kPortalName, kPortalShortcuts, signal, kPortalPath, nullptr, G_DBUS_SIGNAL_FLAGS_NONE, on_portal_shortcut, nullptr, nullptr);
  g_object_unref(bus);
}

// `done(code, message)`: empty code when `keys` are now what's bound.
using BindDone = std::function<void(const std::string &code, const std::string &message)>;
static void portal_bind(const std::map<std::string, PortalKey> &keys, BindDone done) {
  if (keys.empty()) {
    portal_close_session(g_portal_session);
    g_portal_session.clear();
    g_portal_keys.clear();
    return done("", "");
  }
  auto refused = [done](const std::string &error, guint32) {
    if (!error.empty()) done("unavailable", "no desktop portal for global shortcuts: " + error);
    else done("denied", "the desktop refused the shortcuts");
  };
  portal_listen();
  portal_request(kPortalShortcuts, "CreateSession", [](const std::string &token) {
    GVariantBuilder o;
    g_variant_builder_init(&o, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&o, "{sv}", "handle_token", g_variant_new_string(token.c_str()));
    g_variant_builder_add(&o, "{sv}", "session_handle_token", g_variant_new_string(token.c_str()));
    return g_variant_new("(a{sv})", &o);
  }, [keys, done, refused](const std::string &error, guint32 response, GVariant *results) {
    const char *handle = nullptr;
    if (error.empty() && response == 0) g_variant_lookup(results, "session_handle", "&s", &handle);
    if (!handle) return refused(error, response);
    std::string session = handle;
    portal_request(kPortalShortcuts, "BindShortcuts", [keys, session](const std::string &token) {
      GVariantBuilder list, o;
      g_variant_builder_init(&list, G_VARIANT_TYPE("a(sa{sv})"));
      for (auto &[id, key] : keys) {
        GVariantBuilder props;
        g_variant_builder_init(&props, G_VARIANT_TYPE("a{sv}"));
        g_variant_builder_add(&props, "{sv}", "description", g_variant_new_string(id.c_str()));
        g_variant_builder_add(&props, "{sv}", "preferred_trigger", g_variant_new_string(key.trigger.c_str()));
        g_variant_builder_add(&list, "(sa{sv})", id.c_str(), &props);
      }
      g_variant_builder_init(&o, G_VARIANT_TYPE("a{sv}"));
      g_variant_builder_add(&o, "{sv}", "handle_token", g_variant_new_string(token.c_str()));
      return g_variant_new("(oa(sa{sv})sa{sv})", session.c_str(), &list, "", &o);
    }, [keys, session, done, refused](const std::string &error, guint32 response, GVariant *results) {
      if (!error.empty() || response != 0) {
        portal_close_session(session);
        return refused(error, response);
      }
      // The user can leave one out of the dialog: it isn't bound, so it wasn't registered.
      std::map<std::string, bool> bound;
      if (GVariant *list = g_variant_lookup_value(results, "shortcuts", G_VARIANT_TYPE("a(sa{sv})"))) {
        GVariantIter it;
        g_variant_iter_init(&it, list);
        const char *id = nullptr;
        while (g_variant_iter_next(&it, "(&s@a{sv})", &id, nullptr)) bound[id] = true;
        g_variant_unref(list);
      }
      for (auto &[id, key] : keys)
        if (!bound.count(id)) {
          portal_close_session(session);
          return refused("", response);
        }
      portal_close_session(g_portal_session);
      g_portal_session = session;
      g_portal_keys = keys;
      done("", "");
    });
  });
}

bool portal_shortcut_registered(const std::string &id) { return g_portal_keys.count(id) > 0; }

void portal_shortcut_register(CallPtr c, const std::string &id, const std::string &accel, guint key, GdkModifierType mods) {
  std::string trigger = portal_trigger(key, mods);
  portal_enqueue([=] {
    if (g_portal_keys.count(id)) {
      c->fail("invalid_args", "shortcuts.register: id `" + id + "` is already registered");
      return portal_next();
    }
    for (auto &[other, k] : g_portal_keys)
      if (k.trigger == trigger) {
        c->fail("invalid_args", "shortcuts.register: `" + accel + "` is already registered");
        return portal_next();
      }
    auto keys = g_portal_keys;
    keys[id] = PortalKey{accel, trigger};
    portal_bind(keys, [=](const std::string &code, const std::string &message) {
      if (code.empty()) c->ok(json{{"id", id}});
      else c->fail(code, "shortcuts.register: " + message);
      portal_next();
    });
  });
}

void portal_shortcut_unregister(CallPtr c) {
  std::string id = c->str("id");
  portal_enqueue([=] {
    if (!g_portal_keys.count(id)) {
      c->ok(json{{"unregistered", false}});
      return portal_next();
    }
    auto keys = g_portal_keys;
    keys.erase(id);
    portal_bind(keys, [=](const std::string &code, const std::string &message) {
      if (code.empty()) c->ok(json{{"unregistered", true}});
      else c->fail(code, "shortcuts.unregister: " + message);
      portal_next();
    });
  });
}

void portal_shortcut_unregister_all(CallPtr c) {
  portal_enqueue([=] {
    int n = (int)g_portal_keys.size();
    portal_bind({}, [=](const std::string &, const std::string &) {
      c->ok(json{{"unregistered", n}});
      portal_next();
    });
  });
}

// ---------------------------------------------------------------------------

void register_desktop() {
  reg("app", "metrics", app_metrics);
  reg("app", "addRecentDocument", add_recent);
  reg("app", "clearRecentDocuments", clear_recent);
  reg("app", "setDockBadge", set_dock_badge);
  reg("app", "getDockBadge", [](CallPtr c) { c->ok(badge_count() > 0 ? json(std::to_string(badge_count())) : json(nullptr)); });
  reg("app", "setDockProgress", set_dock_progress);
  reg("app", "getDockProgress", [](CallPtr c) { c->ok(g_dock_progress); });
  reg("app", "bounceDock", bounce_dock);
  reg_many("app", {"setDockIcon", "setIcon"}, set_icon);
  reg("app", "getDockIcon", [](CallPtr c) { c->ok(g_dock_icon); });
  reg("app", "setActivationPolicy", [](CallPtr c) {
    std::string policy = c->str("policy");
    if (policy != "regular" && policy != "accessory" && policy != "prohibited") return c->fail("invalid_args", "app.setActivationPolicy: policy must be regular|accessory|prohibited");
    if (policy == "prohibited") return c->ok(false); // nothing stops a Linux app from having windows
    g_activation_policy = policy;
    for (int id : window_ids()) apply_activation_policy(find_window(id));
    c->ok(true);
  });
  reg("app", "getActivationPolicy", [](CallPtr c) { c->ok(g_activation_policy); });
  reg("files", "createBookmark", create_bookmark);
  reg("files", "openBookmark", open_bookmark);
  reg("files", "releaseBookmark", [](CallPtr c) { c->ok(); });
}

} // namespace lx
} // namespace sd
