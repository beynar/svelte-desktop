// screen.*, clipboard.*, shell.*, theme.*, diagnostics.info,
// capabilities.describe, power.* on GTK/GIO.
#include <sys/utsname.h>
#include <unistd.h>

#include <algorithm>
#include <fstream>
#include <map>
#include <set>
#include <sstream>

#include "linux.hpp"

namespace sd {
namespace lx {

static std::string expand_home(const std::string &p) {
  if (p.rfind("~/", 0) == 0 || p == "~") return std::string(g_get_home_dir()) + p.substr(1);
  return p;
}
static std::string gerror_message(GError *e, const std::string &fallback) {
  std::string m = e ? e->message : fallback;
  if (e) g_error_free(e);
  return m;
}

// ===========================================================================
// screen.* — monitors in root coordinates (top-left origin, y down)

static json display_info(GdkMonitor *m, int index) {
  GdkRectangle g, wa;
  gdk_monitor_get_geometry(m, &g);
  gdk_monitor_get_workarea(m, &wa);
  const char *model = gdk_monitor_get_model(m), *maker = gdk_monitor_get_manufacturer(m);
  std::string uuid = std::string(maker ? maker : "display") + "-" + (model ? model : "") + "-" + std::to_string(index);
  return json{{"id", index + 1},
              {"uuid", uuid},
              {"label", model ? json(model) : json("Display " + std::to_string(index + 1))},
              {"bounds", rect_json(g.x, g.y, g.width, g.height)},
              {"workArea", rect_json(wa.x, wa.y, wa.width, wa.height)},
              {"scaleFactor", gdk_monitor_get_scale_factor(m)},
              {"isPrimary", m == primary_monitor()}};
}

static int monitor_index(GdkMonitor *m) {
  GdkDisplay *d = gdk_display_get_default();
  for (int i = 0; i < gdk_display_get_n_monitors(d); i++)
    if (gdk_display_get_monitor(d, i) == m) return i;
  return 0;
}

static void register_screen() {
  reg("screen", "getAllDisplays", [](CallPtr c) {
    GdkDisplay *d = gdk_display_get_default();
    json list = json::array();
    for (int i = 0; i < gdk_display_get_n_monitors(d); i++) list.push_back(display_info(gdk_display_get_monitor(d, i), i));
    c->ok(list);
  });
  reg("screen", "getPrimaryDisplay", [](CallPtr c) {
    GdkMonitor *m = primary_monitor();
    m ? c->ok(display_info(m, monitor_index(m))) : c->fail("unavailable", "no display");
  });
  reg("screen", "getDisplayNearestWindow", [](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    GdkWindow *g = w ? gtk_widget_get_window(w->window) : nullptr;
    GdkMonitor *m = g ? gdk_display_get_monitor_at_window(gdk_display_get_default(), g) : primary_monitor();
    m ? c->ok(display_info(m, monitor_index(m))) : c->fail("unavailable", "no display");
  });
  reg("screen", "getCursorScreenPoint", [](CallPtr c) {
    int x, y;
    pointer_position(&x, &y);
    c->ok(json{{"x", x}, {"y", y}});
  });
  reg("screen", "scaleFactor", [](CallPtr c) {
    GdkMonitor *m = primary_monitor();
    c->ok(m ? gdk_monitor_get_scale_factor(m) : 1);
  });
  GdkDisplay *d = gdk_display_get_default();
  auto changed = +[](GdkDisplay *, GdkMonitor *, gpointer) { emit("displaysChanged"); };
  g_signal_connect(d, "monitor-added", G_CALLBACK(changed), nullptr);
  g_signal_connect(d, "monitor-removed", G_CALLBACK(changed), nullptr);
}

// ===========================================================================
// clipboard.* — the CLIPBOARD selection: text, html, rtf, png images, file paths

static GtkClipboard *cb() { return gtk_clipboard_get(GDK_SELECTION_CLIPBOARD); }

struct ClipPayload {
  std::map<std::string, std::string> raw; // target name → bytes
  std::string text;                       // served for every text target when non-empty
  bool hasText = false;
};

static void clip_get(GtkClipboard *, GtkSelectionData *sel, guint, gpointer data) {
  auto *p = static_cast<ClipPayload *>(data);
  gchar *name = gdk_atom_name(gtk_selection_data_get_target(sel));
  std::string target = name ? name : "";
  g_free(name);
  auto it = p->raw.find(target);
  if (it != p->raw.end()) {
    gtk_selection_data_set(sel, gtk_selection_data_get_target(sel), 8, (const guchar *)it->second.data(), (gint)it->second.size());
    return;
  }
  if (p->hasText) gtk_selection_data_set_text(sel, p->text.c_str(), (gint)p->text.size());
}
static void clip_clear(GtkClipboard *, gpointer data) { delete static_cast<ClipPayload *>(data); }

static void clip_set(ClipPayload *p) {
  GtkTargetList *list = gtk_target_list_new(nullptr, 0);
  for (auto &[target, _] : p->raw) gtk_target_list_add(list, gdk_atom_intern(target.c_str(), FALSE), 0, 0);
  if (p->hasText) gtk_target_list_add_text_targets(list, 0);
  int n = 0;
  GtkTargetEntry *entries = gtk_target_table_new_from_list(list, &n);
  if (!gtk_clipboard_set_with_data(cb(), entries, (guint)n, clip_get, clip_clear, p)) delete p;
  gtk_target_table_free(entries, n);
  gtk_target_list_unref(list);
}

static std::string strip_html(const std::string &html) {
  std::string out;
  bool tag = false;
  for (char ch : html) {
    if (ch == '<') tag = true;
    else if (ch == '>') tag = false;
    else if (!tag) out += ch;
  }
  static const std::pair<const char *, const char *> ents[] = {{"&amp;", "&"}, {"&lt;", "<"}, {"&gt;", ">"}, {"&quot;", "\""}, {"&#39;", "'"}, {"&nbsp;", " "}};
  for (auto &[from, to] : ents)
    for (size_t pos; (pos = out.find(from)) != std::string::npos;) out.replace(pos, strlen(from), to);
  return out;
}

static std::string read_target(const char *target) {
  GtkSelectionData *sel = gtk_clipboard_wait_for_contents(cb(), gdk_atom_intern(target, FALSE));
  if (!sel) return "";
  gint len = 0;
  const guchar *d = gtk_selection_data_get_data_with_length(sel, &len);
  std::string out = d && len > 0 ? std::string((const char *)d, (size_t)len) : "";
  gtk_selection_data_free(sel);
  while (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

static std::set<std::string> clip_targets() {
  std::set<std::string> out;
  GdkAtom *atoms = nullptr;
  gint n = 0;
  if (!gtk_clipboard_wait_for_targets(cb(), &atoms, &n)) return out;
  for (int i = 0; i < n; i++) {
    gchar *name = gdk_atom_name(atoms[i]);
    out.insert(name);
    g_free(name);
  }
  if (gtk_targets_include_text(atoms, n)) out.insert("text/plain");
  if (gtk_targets_include_image(atoms, n, FALSE)) out.insert("image/png");
  if (out.count("application/rtf")) out.insert("text/rtf");
  if (out.count("text/uri-list")) out.insert("files");
  g_free(atoms);
  return out;
}

static void register_clipboard() {
  reg("clipboard", "readText", [](CallPtr c) {
    gchar *t = gtk_clipboard_wait_for_text(cb());
    if (!t) return c->ok(nullptr);
    std::string s = t;
    g_free(t);
    c->ok(s);
  });
  reg("clipboard", "writeText", [](CallPtr c) {
    if (!c->args.contains("text") || !c->args["text"].is_string()) return c->fail("invalid_args", "clipboard.writeText: `text` must be a string");
    auto *p = new ClipPayload;
    p->text = c->str("text");
    p->hasText = true;
    clip_set(p);
    c->ok();
  });
  reg("clipboard", "readHtml", [](CallPtr c) {
    std::string h = read_target("text/html");
    h.empty() ? c->ok(nullptr) : c->ok(h);
  });
  reg("clipboard", "writeHtml", [](CallPtr c) {
    if (!c->args.contains("html") || !c->args["html"].is_string()) return c->fail("invalid_args", "clipboard.writeHtml: `html` must be a string");
    auto *p = new ClipPayload;
    p->raw["text/html"] = c->str("html");
    p->text = strip_html(c->str("html"));
    p->hasText = !p->text.empty();
    clip_set(p);
    c->ok();
  });
  reg("clipboard", "readRtf", [](CallPtr c) {
    std::string r = read_target("text/rtf");
    if (r.empty()) r = read_target("application/rtf");
    r.empty() ? c->ok(nullptr) : c->ok(r);
  });
  reg("clipboard", "writeRtf", [](CallPtr c) {
    if (!c->args.contains("rtf") || !c->args["rtf"].is_string()) return c->fail("invalid_args", "clipboard.writeRtf: `rtf` must be a string");
    auto *p = new ClipPayload;
    p->raw["text/rtf"] = p->raw["application/rtf"] = c->str("rtf");
    clip_set(p);
    c->ok();
  });
  reg("clipboard", "clear", [](CallPtr c) {
    // Take ownership, then release it: the selection has no owner → nothing to read.
    gtk_clipboard_set_text(cb(), "", 0);
    gtk_clipboard_clear(cb());
    c->ok();
  });
  reg("clipboard", "availableFormats", [](CallPtr c) {
    auto t = clip_targets();
    json out = json::array();
    for (const char *f : {"files", "image/png", "text/html", "text/plain", "text/rtf"})
      if (t.count(f)) out.push_back(f);
    c->ok(out);
  });
  reg("clipboard", "has", [](CallPtr c) {
    std::string f = c->str("format");
    if (f.empty()) return c->fail("invalid_args", "clipboard.has: `format` is required");
    c->ok(clip_targets().count(f) > 0); // contract names, or raw target names
  });
  reg("clipboard", "readImage", [](CallPtr c) {
    GdkPixbuf *pb = gtk_clipboard_wait_for_image(cb());
    if (!pb) return c->ok(nullptr);
    gchar *buf = nullptr;
    gsize len = 0;
    bool ok = gdk_pixbuf_save_to_buffer(pb, &buf, &len, "png", nullptr, nullptr);
    g_object_unref(pb);
    if (!ok) return c->ok(nullptr);
    std::string b64 = base64_encode((const unsigned char *)buf, len);
    g_free(buf);
    c->ok(json{{"bytes", b64}, {"format", "png"}});
  });
  reg("clipboard", "writeImage", [](CallPtr c) {
    bool ok = false;
    auto bytes = base64_decode(c->str("bytes"), &ok);
    GdkPixbuf *pb = nullptr;
    if (ok) {
      GdkPixbufLoader *loader = gdk_pixbuf_loader_new();
      if (gdk_pixbuf_loader_write(loader, bytes.data(), bytes.size(), nullptr) && gdk_pixbuf_loader_close(loader, nullptr)) {
        pb = gdk_pixbuf_loader_get_pixbuf(loader);
        if (pb) g_object_ref(pb);
      } else {
        gdk_pixbuf_loader_close(loader, nullptr);
      }
      g_object_unref(loader);
    }
    if (!pb) return c->fail("invalid_args", "clipboard.writeImage: `bytes` must be base64 image data");
    gtk_clipboard_set_image(cb(), pb);
    g_object_unref(pb);
    c->ok();
  });
  reg("clipboard", "readPaths", [](CallPtr c) {
    gchar **uris = gtk_clipboard_wait_for_uris(cb());
    if (!uris || !uris[0]) {
      g_strfreev(uris);
      return c->ok(nullptr);
    }
    json out = json::array();
    for (int i = 0; uris[i]; i++)
      if (gchar *p = g_filename_from_uri(uris[i], nullptr, nullptr)) {
        out.push_back(p);
        g_free(p);
      }
    g_strfreev(uris);
    out.empty() ? c->ok(nullptr) : c->ok(out);
  });
  reg("clipboard", "writePaths", [](CallPtr c) {
    if (!c->args.contains("paths") || !c->args["paths"].is_array()) return c->fail("invalid_args", "clipboard.writePaths: `paths` must be an array");
    std::string list, gnome = "copy", plain;
    for (auto &p : c->args["paths"]) {
      if (!p.is_string()) continue;
      gchar *uri = g_filename_to_uri(p.get<std::string>().c_str(), nullptr, nullptr);
      if (!uri) continue;
      list += std::string(uri) + "\r\n";
      gnome += std::string("\n") + uri;
      plain += (plain.empty() ? "" : "\n") + p.get<std::string>();
      g_free(uri);
    }
    auto *payload = new ClipPayload;
    payload->raw["text/uri-list"] = list;
    payload->raw["x-special/gnome-copied-files"] = gnome;
    payload->text = plain;
    payload->hasText = !plain.empty();
    clip_set(payload);
    c->ok();
  });
}

// ===========================================================================
// shell.* — hand URLs and files to the desktop (GIO)

static void launch_uri(CallPtr c, const std::string &uri) {
  auto *holder = new CallPtr(c);
  g_app_info_launch_default_for_uri_async(uri.c_str(), nullptr, nullptr, [](GObject *, GAsyncResult *res, gpointer data) {
    auto *h = static_cast<CallPtr *>(data);
    GError *err = nullptr;
    if (g_app_info_launch_default_for_uri_finish(res, &err)) (*h)->ok();
    else (*h)->fail("internal", gerror_message(err, "no handler"));
    delete h;
  }, holder);
}

static void register_shell() {
  reg("shell", "openExternal", [](CallPtr c) {
    std::string url = c->str("url");
    gchar *scheme = g_uri_parse_scheme(url.c_str());
    std::string s = scheme ? scheme : "";
    g_free(scheme);
    for (auto &ch : s) ch = (char)g_ascii_tolower(ch);
    static const std::set<std::string> allowed = {"http", "https", "mailto", "tel", "sms"};
    if (!allowed.count(s)) return c->fail("invalid_args", "shell.openExternal: only http(s)/mailto/tel/sms URLs (use openPath for files)");
    launch_uri(c, url);
  });
  reg("shell", "openPath", [](CallPtr c) {
    std::string path = expand_home(c->str("path"));
    if (path.empty() || !g_file_test(path.c_str(), G_FILE_TEST_EXISTS)) return c->fail("invalid_args", "shell.openPath: no such file `" + path + "`");
    gchar *uri = g_filename_to_uri(path.c_str(), nullptr, nullptr);
    launch_uri(c, uri ? uri : "");
    g_free(uri);
  });
  reg("shell", "showItemInFolder", [](CallPtr c) {
    std::string path = expand_home(c->str("path"));
    if (path.empty() || !g_file_test(path.c_str(), G_FILE_TEST_EXISTS))
      return c->fail("invalid_args", "shell.showItemInFolder: no such file `" + path + "`");
    gchar *uri = g_filename_to_uri(path.c_str(), nullptr, nullptr);
    std::string u = uri ? uri : "";
    g_free(uri);
    // org.freedesktop.FileManager1 selects the item (Nautilus, Dolphin, Nemo…);
    // without one, open the parent folder.
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
    const gchar *uris[] = {u.c_str(), nullptr};
    GVariant *r = bus ? g_dbus_connection_call_sync(bus, "org.freedesktop.FileManager1", "/org/freedesktop/FileManager1",
                                                    "org.freedesktop.FileManager1", "ShowItems", g_variant_new("(^ass)", uris, ""),
                                                    nullptr, G_DBUS_CALL_FLAGS_NONE, 2000, nullptr, nullptr)
                      : nullptr;
    if (bus) g_object_unref(bus);
    if (r) {
      g_variant_unref(r);
      return c->ok();
    }
    gchar *dir = g_path_get_dirname(path.c_str());
    gchar *duri = g_filename_to_uri(dir, nullptr, nullptr);
    launch_uri(c, duri ? duri : "");
    g_free(duri);
    g_free(dir);
  });
  reg("shell", "trashItem", [](CallPtr c) {
    std::string path = expand_home(c->str("path"));
    if (path.empty()) return c->fail("invalid_args", "shell.trashItem: `path` is required");
    GFile *f = g_file_new_for_path(path.c_str());
    GError *err = nullptr;
    bool ok = g_file_trash(f, nullptr, &err);
    g_object_unref(f);
    if (!ok) return c->fail("invalid_args", "shell.trashItem: " + gerror_message(err, "failed"));
    c->ok();
  });
  reg("shell", "beep", [](CallPtr c) {
    gdk_display_beep(gdk_display_get_default());
    c->ok();
  });
}

// ===========================================================================
// theme.* — GtkSettings gtk-application-prefer-dark-theme (+ a *-dark theme name).
// WebKitGTK derives prefers-color-scheme from the same settings.

static bool g_initial_prefer_dark = false;
static std::string g_initial_theme;
static std::string g_last_theme_key;

static bool ends_with(const std::string &s, const std::string &suffix) {
  return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

static json theme_info() {
  gboolean prefer = FALSE;
  gchar *name = nullptr;
  g_object_get(gtk_settings_get_default(), "gtk-application-prefer-dark-theme", &prefer, "gtk-theme-name", &name, nullptr);
  std::string n = name ? name : "";
  g_free(name);
  std::string lower = n;
  for (auto &ch : lower) ch = (char)g_ascii_tolower(ch);
  bool dark = prefer || ends_with(lower, "-dark") || ends_with(lower, ":dark");
  return json{{"appearance", dark ? "dark" : "light"}, {"dark", dark}};
}

static void on_theme_notify(GObject *, GParamSpec *, gpointer) {
  json info = theme_info();
  std::string key = info.dump();
  if (key == g_last_theme_key) return;
  g_last_theme_key = key;
  emit("appearanceChanged", info);
}

static void register_theme() {
  GtkSettings *s = gtk_settings_get_default();
  gboolean prefer = FALSE;
  gchar *name = nullptr;
  g_object_get(s, "gtk-application-prefer-dark-theme", &prefer, "gtk-theme-name", &name, nullptr);
  g_initial_prefer_dark = prefer;
  g_initial_theme = name ? name : "";
  g_free(name);
  g_last_theme_key = theme_info().dump();
  g_signal_connect(s, "notify::gtk-application-prefer-dark-theme", G_CALLBACK(on_theme_notify), nullptr);
  g_signal_connect(s, "notify::gtk-theme-name", G_CALLBACK(on_theme_notify), nullptr);

  reg_many("theme", {"get", "getAppearance"}, [](CallPtr c) { c->ok(theme_info()); });
  reg_many("theme", {"set", "setAppearance"}, [](CallPtr c) {
    std::string a = c->has("appearance") ? c->str("appearance") : "system";
    // vibrant* are macOS materials; on GTK they mean their light/dark base.
    if (a == "vibrantLight") a = "light";
    if (a == "vibrantDark") a = "dark";
    if (a != "system" && a != "light" && a != "dark")
      return c->fail("invalid_args", "theme.set: appearance must be system|light|dark|vibrantLight|vibrantDark");
    GtkSettings *s = gtk_settings_get_default();
    if (a == "system") {
      g_object_set(s, "gtk-theme-name", g_initial_theme.c_str(), "gtk-application-prefer-dark-theme", g_initial_prefer_dark, nullptr);
    } else {
      bool dark = a == "dark";
      std::string theme = g_initial_theme;
      std::string lower = theme;
      for (auto &ch : lower) ch = (char)g_ascii_tolower(ch);
      if (!dark && ends_with(lower, "-dark")) theme = theme.substr(0, theme.size() - 5); // e.g. Yaru-dark → Yaru
      g_object_set(s, "gtk-theme-name", theme.c_str(), "gtk-application-prefer-dark-theme", dark, nullptr);
    }
    c->ok(theme_info());
  });
  reg("theme", "shouldUseDarkColors", [](CallPtr c) { c->ok(theme_info()["dark"]); });
}

// ===========================================================================
// diagnostics.info + capabilities.describe

static const char *arch_name() {
#if defined(__aarch64__)
  return "aarch64";
#else
  return "x86_64";
#endif
}

static double uptime_seconds() {
  std::ifstream stat("/proc/self/stat"), up("/proc/uptime");
  std::string s((std::istreambuf_iterator<char>(stat)), {});
  auto close = s.rfind(')');
  if (close == std::string::npos) return 0;
  std::istringstream rest(s.substr(close + 2));
  std::string field;
  unsigned long long start = 0;
  for (int i = 3; i <= 22 && rest >> field; i++)
    if (i == 22) start = std::stoull(field);
  double sys = 0;
  up >> sys;
  double t = sys - (double)start / (double)sysconf(_SC_CLK_TCK);
  return t > 0 ? t : 0;
}

static std::string os_version() {
  std::ifstream f("/etc/os-release");
  std::string line;
  while (std::getline(f, line))
    if (line.rfind("PRETTY_NAME=", 0) == 0) {
      std::string v = line.substr(12);
      if (v.size() >= 2 && v.front() == '"') v = v.substr(1, v.size() - 2);
      return v;
    }
  struct utsname u;
  return uname(&u) == 0 ? std::string(u.sysname) + " " + u.release : "Linux";
}

static void register_diagnostics() {
  reg("diagnostics", "info", [](CallPtr c) {
    char ver[64];
    snprintf(ver, sizeof ver, "%u.%u.%u", webkit_get_major_version(), webkit_get_minor_version(), webkit_get_micro_version());
    struct utsname u;
    uname(&u);
    c->ok(json{{"pid", getpid()},
               {"uptimeSeconds", uptime_seconds()},
               {"os", "linux"},
               {"family", "unix"},
               {"arch", arch_name()},
               {"renderer", "webkitgtk"},
               {"rendererVersion", ver},
               {"osVersion", os_version()},
               {"kernel", u.release},
               {"gtkVersion", std::to_string(gtk_get_major_version()) + "." + std::to_string(gtk_get_minor_version()) + "." +
                                  std::to_string(gtk_get_micro_version())},
               {"display", gdk_display_get_name(gdk_display_get_default())}});
  });
  // Truth table from the live registry; ops whose library/daemon is missing here
  // are "unavailable" (see svc_optional.cc).
  reg("capabilities", "describe", [](CallPtr c) {
    json services = json::object();
    std::set<std::string> down(unavailable_ops().begin(), unavailable_ops().end());
    for (auto &key : registered_ops()) {
      auto dot = key.find('.');
      if (dot == std::string::npos || key.find("._") != std::string::npos) continue; // internal test hooks
      std::string svc = key.substr(0, dot), op = key.substr(dot + 1);
      services[svc][op] = down.count(key) || down.count(svc + ".*") ? "unavailable" : "implemented";
    }
    c->ok(json{{"platform", "linux"}, {"arch", arch_name()}, {"services", services}});
  });
}

// ===========================================================================
// power.* — sleep inhibition over org.freedesktop.ScreenSaver, battery from sysfs.

static std::map<int, guint32> g_inhibits; // our id → ScreenSaver cookie
static int g_next_inhibit = 1;

static void screensaver_call(const char *method, GVariant *params, std::function<void(GVariant *, GError *)> done) {
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
  if (!bus) {
    GError *e = g_error_new_literal(G_IO_ERROR, G_IO_ERROR_NOT_CONNECTED, "no D-Bus session bus");
    done(nullptr, e);
    g_error_free(e);
    if (params) g_variant_unref(g_variant_ref_sink(params));
    return;
  }
  auto *cb = new std::function<void(GVariant *, GError *)>(std::move(done));
  g_dbus_connection_call(bus, "org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver", method, params,
                         nullptr, G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, [](GObject *src, GAsyncResult *res, gpointer data) {
                           auto *f = static_cast<std::function<void(GVariant *, GError *)> *>(data);
                           GError *err = nullptr;
                           GVariant *v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, &err);
                           (*f)(v, err);
                           if (v) g_variant_unref(v);
                           if (err) g_error_free(err);
                           delete f;
                         }, cb);
  g_object_unref(bus);
}

static void get_battery(CallPtr c) {
  GDir *dir = g_dir_open("/sys/class/power_supply", 0, nullptr);
  json percent = nullptr;
  bool battery = false, discharging = false, charging = false, ac = false;
  auto read = [](const std::string &p) {
    gchar *s = nullptr;
    std::string out;
    if (g_file_get_contents(p.c_str(), &s, nullptr, nullptr)) out = g_strstrip(s);
    g_free(s);
    return out;
  };
  if (dir) {
    while (const char *name = g_dir_read_name(dir)) {
      std::string base = std::string("/sys/class/power_supply/") + name;
      std::string type = read(base + "/type");
      if (type == "Battery" && read(base + "/scope") != "Device") {
        battery = true;
        std::string cap = read(base + "/capacity"), status = read(base + "/status");
        if (!cap.empty()) percent = std::stoi(cap);
        discharging = discharging || status == "Discharging";
        charging = charging || status == "Charging";
      } else if (type == "Mains" && read(base + "/online") == "1") {
        ac = true;
      }
    }
    g_dir_close(dir);
  }
  c->ok(json{{"percent", percent}, {"charging", charging || (ac && battery && !discharging)}, {"external", !battery || ac || !discharging}});
}

static void register_power() {
  reg("power", "getBattery", get_battery);
  reg("power", "blockSleep", [](CallPtr c) {
    std::string type = c->str("type");
    if (type != "display" && type != "idle" && type != "system")
      return c->fail("invalid_args", "power.blockSleep: `type` must be display|idle|system");
    std::string reason = c->has("reason") ? c->str("reason") : app_name() + " is busy";
    // ScreenSaver.Inhibit blocks idle → screen blank/lock and (in GNOME, KDE,
    // XFCE) idle suspend, so all three types map onto it.
    screensaver_call("Inhibit", g_variant_new("(ss)", app_name().c_str(), reason.c_str()), [c](GVariant *v, GError *e) {
      if (!v) return c->fail("unavailable", std::string("power.blockSleep: org.freedesktop.ScreenSaver: ") + (e ? e->message : "no reply"));
      guint32 cookie = 0;
      g_variant_get(v, "(u)", &cookie);
      int id = g_next_inhibit++;
      g_inhibits[id] = cookie;
      c->ok(json{{"id", id}});
    });
  });
  reg("power", "unblockSleep", [](CallPtr c) {
    int id = (int)c->num("id", -1);
    auto it = g_inhibits.find(id);
    if (it == g_inhibits.end()) return c->fail("invalid_args", "power.unblockSleep: `id` must be an id returned by blockSleep (and not released yet)");
    guint32 cookie = it->second;
    g_inhibits.erase(it);
    screensaver_call("UnInhibit", g_variant_new("(u)", cookie), [c](GVariant *v, GError *e) {
      if (!v) return c->fail("internal", std::string("power.unblockSleep: ") + (e ? e->message : "no reply"));
      c->ok();
    });
  });
}

void register_misc() {
  register_screen();
  register_clipboard();
  register_shell();
  register_theme();
  register_diagnostics();
  register_power();
}

} // namespace lx
} // namespace sd
