// menu.*, shortcuts.*, capture.*, system.* on GTK 3 — same ops and replies as the
// macOS backend (native/platform_{menu,shortcuts,capture,system}.mm).
//   menu: an app menu bar on every window (GtkMenuBar above the page, accelerators
//         through the window's GtkAccelGroup), popup (context) menus, live item
//         updates (update/get/items), insert/remove, addRecentDocument (GtkRecentManager).
//         MenuItemSpec: {type, id, label, submenu, checked, disabled, role, accelerator};
//         items with an id emit menuAction {id}.
//   shortcuts: global hotkeys with XGrabKey on the root window (X11). Wayland has no
//         global hotkey API for applications: register answers `unsupported` there.
//   capture: displays (GDK monitors) and windows (_NET_CLIENT_LIST), PNG stills (X11).
//   system: info, keyboard layout (XKB group name), accent color (GTK theme),
//         accessibility (animations / high-contrast theme), permissions (Linux has no
//         per-app privacy prompts: device access is the user's/sandbox's business).
#include <gdk/gdkx.h>
#include <X11/XKBlib.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>

#include <set>
#include <sys/utsname.h>
#include <unistd.h>

#include "linux.hpp"

namespace sd {
namespace lx {

static bool is_x11() { return GDK_IS_X11_DISPLAY(gdk_display_get_default()); }

// ---------------------------------------------------------------------------
// menu

static json g_app_menus; // [{name, items}] or null (no menu bar)

/// "&File" (Windows-style mnemonic) → "_File" (GTK).
static std::string mnemonic(const std::string &name) {
  std::string out;
  for (size_t i = 0; i < name.size(); i++) {
    if (name[i] == '&' && i + 1 < name.size() && name[i + 1] != '&') out += '_';
    else if (name[i] == '_') out += "__";
    else out += name[i];
  }
  return out;
}

static GtkWidget *build_menubar(const json &menus, GtkAccelGroup *accel, std::string *error) {
  GtkWidget *bar = gtk_menu_bar_new();
  for (const auto &m : menus) {
    if (!m.is_object()) {
      *error = "menu.setAppMenu: menus are {name, items}";
      break;
    }
    GtkWidget *top = gtk_menu_item_new_with_mnemonic(mnemonic(m.value("name", "")).c_str());
    json items = m.contains("items") && m["items"].is_array() ? m["items"] : json::array();
    if (!items.empty()) {
      GtkWidget *sub = build_gtk_menu(items, error, accel);
      if (!sub) break;
      gtk_menu_item_set_submenu(GTK_MENU_ITEM(top), sub);
    }
    gtk_menu_shell_append(GTK_MENU_SHELL(bar), top);
  }
  if (!error->empty()) {
    g_object_ref_sink(bar);
    g_object_unref(bar);
    return nullptr;
  }
  gtk_widget_show_all(bar);
  return bar;
}

void attach_app_menu(Window *w) {
  if (w->menubar) {
    gtk_widget_destroy(w->menubar);
    w->menubar = nullptr;
  }
  // Rebuilding drops the old accelerators with their widgets: a fresh group.
  gtk_window_remove_accel_group(GTK_WINDOW(w->window), w->accel);
  g_object_unref(w->accel);
  w->accel = gtk_accel_group_new();
  gtk_window_add_accel_group(GTK_WINDOW(w->window), w->accel);
  if (!g_app_menus.is_array() || g_app_menus.empty()) return;
  std::string error;
  w->menubar = build_menubar(g_app_menus, w->accel, &error);
  if (!w->menubar) return;
  gtk_box_pack_start(GTK_BOX(w->box), w->menubar, FALSE, FALSE, 0);
}

static void rebuild_menubars() {
  for (int id : window_ids())
    if (Window *w = find_window(id)) attach_app_menu(w);
}

/// Depth-first visit of every item of the app menus.
static bool walk(json &items, const std::function<bool(json &)> &fn) {
  for (auto &it : items) {
    if (!it.is_object()) continue;
    if (fn(it)) return true;
    if (it.contains("submenu") && it["submenu"].is_array() && walk(it["submenu"], fn)) return true;
  }
  return false;
}

static json *find_item(const std::string &id) {
  json *found = nullptr;
  if (!g_app_menus.is_array()) return nullptr;
  for (auto &m : g_app_menus)
    if (m.contains("items") && m["items"].is_array() &&
        walk(m["items"], [&](json &it) {
          if (it.contains("id") && (it["id"].is_string() ? it["id"].get<std::string>() : it["id"].dump()) == id) return (found = &it), true;
          return false;
        }))
      break;
  return found;
}

static json item_state(const json &it) {
  if (it.value("type", "") == "separator" || it.value("role", "") == "separator") return json{{"separator", true}};
  json d = {{"text", it.value("label", it.value("role", ""))}, {"enabled", !it.value("disabled", false) && it.value("enabled", true)}, {"checked", it.value("checked", false)}};
  if (it.contains("id")) d["id"] = it["id"];
  if (it.contains("submenu") && it["submenu"].is_array()) {
    json sub = json::array();
    for (const auto &s : it["submenu"]) sub.push_back(item_state(s));
    d["submenu"] = sub;
  }
  return d;
}

static void register_menu() {
  reg_many("menu", {"setAppMenu", "setApplicationMenu"}, [](CallPtr c) {
    json menus = c->args.contains("menus") ? c->args["menus"] : json(nullptr);
    if (!menus.is_null() && !menus.is_array()) return c->fail("invalid_args", "menu.setAppMenu: `menus` is an array of {name, items} (or null)");
    std::string error;
    if (menus.is_array()) {
      GtkWidget *probe = build_menubar(menus, nullptr, &error); // validate before applying
      if (!probe) return c->fail("invalid_args", error);
      g_object_ref_sink(probe);
      g_object_unref(probe);
    }
    g_app_menus = menus;
    rebuild_menubars();
    c->ok();
  });
  reg("menu", "insert", [](CallPtr c) {
    std::string name = c->str("name");
    if (name.empty()) return c->fail("invalid_args", "menu.insert: `name` is required");
    json menus = g_app_menus.is_array() ? g_app_menus : json::array();
    json entry = {{"name", name}};
    if (c->args.contains("items") && c->args["items"].is_array()) entry["items"] = c->args["items"];
    else entry["items"] = json::array({{{"label", name}, {"id", c->str("id", name)}}});
    for (size_t i = 0; i < menus.size(); i++)
      if (menus[i].value("name", "") == name) {
        menus.erase(menus.begin() + (long)i);
        break;
      }
    size_t idx = c->has("index") ? (size_t)std::max(0.0, c->num("index", 0)) : menus.size();
    if (idx > menus.size()) idx = menus.size();
    menus.insert(menus.begin() + (long)idx, entry);
    g_app_menus = menus;
    rebuild_menubars();
    c->ok();
  });
  reg("menu", "remove", [](CallPtr c) {
    std::string name = c->str("name", c->str("id"));
    if (!g_app_menus.is_array()) return c->ok(json{{"removed", false}});
    for (size_t i = 0; i < g_app_menus.size(); i++)
      if (g_app_menus[i].value("name", "") == name) {
        g_app_menus.erase(g_app_menus.begin() + (long)i);
        rebuild_menubars();
        return c->ok(json{{"removed", true}});
      }
    c->ok(json{{"removed", false}});
  });
  reg("menu", "update", [](CallPtr c) {
    std::string id = c->str("id");
    json *it = id.empty() ? nullptr : find_item(id);
    if (!it) return c->fail("invalid_args", "menu.update: unknown item id `" + id + "`");
    if (c->has("text") || c->has("label")) (*it)["label"] = c->str("text", c->str("label"));
    if (c->has("enabled")) (*it)["disabled"] = !c->flag("enabled", true), it->erase("enabled");
    if (c->has("disabled")) (*it)["disabled"] = c->flag("disabled", false);
    if (c->has("checked")) (*it)["checked"] = c->flag("checked", false);
    if (c->has("accelerator")) (*it)["accelerator"] = c->str("accelerator");
    rebuild_menubars();
    c->ok();
  });
  reg("menu", "get", [](CallPtr c) {
    json *it = find_item(c->str("id"));
    if (!it) return c->ok(nullptr);
    json s = item_state(*it);
    c->ok(json{{"id", c->str("id")}, {"text", s["text"]}, {"enabled", s["enabled"]}, {"checked", s["checked"]}});
  });
  reg("menu", "items", [](CallPtr c) {
    json out = json::array();
    if (g_app_menus.is_array())
      for (const auto &m : g_app_menus) {
        json sub = json::array();
        for (const auto &it : m.value("items", json::array())) sub.push_back(item_state(it));
        out.push_back(json{{"text", m.value("name", "")}, {"enabled", true}, {"checked", false}, {"submenu", sub}});
      }
    c->ok(out);
  });
  reg("menu", "popup", [](CallPtr c) {
    std::string error;
    GtkWidget *menu = build_gtk_menu(c->args.contains("items") ? c->args["items"] : json::array(), &error);
    if (!menu) return c->fail("invalid_args", error);
    Window *w = find_window(c->caller) ? find_window(c->caller) : find_window(primary_window());
    if (!w) return c->fail("unavailable", "menu.popup: no window");
    // Anchored at {x, y} in the page (CSS px), or at the pointer over the window.
    GdkWindow *gw = gtk_widget_get_window(GTK_WIDGET(w->webview));
    GdkRectangle rect{0, 0, 1, 1};
    if (c->has("x") && c->has("y")) {
      rect.x = (int)c->num("x", 0);
      rect.y = (int)c->num("y", 0);
    } else if (gw) {
      GdkDevice *pointer = gdk_seat_get_pointer(gdk_display_get_default_seat(gdk_window_get_display(gw)));
      gdk_window_get_device_position(gw, pointer, &rect.x, &rect.y, nullptr);
    }
    g_signal_connect_data(menu, "deactivate", G_CALLBACK(+[](GtkMenuShell *, gpointer data) {
                            auto *call = static_cast<CallPtr *>(data);
                            (*call)->ok(json{{"dismissed", true}});
                          }),
                          new CallPtr(c), [](gpointer data, GClosure *) { delete static_cast<CallPtr *>(data); }, (GConnectFlags)0);
    g_object_ref_sink(menu);
    if (gw) gtk_menu_popup_at_rect(GTK_MENU(menu), gw, &rect, GDK_GRAVITY_NORTH_WEST, GDK_GRAVITY_NORTH_WEST, nullptr);
    else gtk_menu_popup_at_pointer(GTK_MENU(menu), nullptr);
  });
  reg("menu", "addRecentDocument", [](CallPtr c) {
    std::string path = c->str("path");
    if (path.empty()) return c->fail("invalid_args", "menu.addRecentDocument: `path` is required");
    gchar *uri = g_filename_to_uri(path.c_str(), nullptr, nullptr);
    if (!uri) return c->fail("invalid_args", "menu.addRecentDocument: `path` must be absolute");
    gtk_recent_manager_add_item(gtk_recent_manager_get_default(), uri);
    g_free(uri);
    c->ok();
  });
}

// ---------------------------------------------------------------------------
// shortcuts (X11 global hotkeys)

struct HotKey {
  std::string accel;
  KeyCode code = 0;
  unsigned mods = 0;
};
static std::map<std::string, HotKey> g_hotkeys;
static bool g_filter = false;
static const unsigned kIgnored[] = {0, LockMask, Mod2Mask, LockMask | Mod2Mask}; // CapsLock / NumLock

static unsigned x_mods(GdkModifierType m) {
  unsigned r = 0;
  if (m & GDK_SHIFT_MASK) r |= ShiftMask;
  if (m & GDK_CONTROL_MASK) r |= ControlMask;
  if (m & GDK_MOD1_MASK) r |= Mod1Mask;
  if (m & GDK_SUPER_MASK) r |= Mod4Mask;
  return r;
}

static std::map<unsigned, std::string> g_pressed; // keycode → id of the hotkey held down

static GdkFilterReturn hotkey_filter(GdkXEvent *xev, GdkEvent *, gpointer) {
  XEvent *e = static_cast<XEvent *>(xev);
  if (e->type == KeyPress) {
    unsigned state = e->xkey.state & (ShiftMask | ControlMask | Mod1Mask | Mod4Mask);
    for (auto &[id, h] : g_hotkeys)
      if (h.code == e->xkey.keycode && h.mods == state) {
        bool repeat = g_pressed.count(e->xkey.keycode) > 0; // X11 auto-repeat
        g_pressed[e->xkey.keycode] = id;
        if (!repeat) emit("shortcutPressed", json{{"id", id}, {"accelerator", h.accel}});
        return GDK_FILTER_REMOVE;
      }
  } else if (e->type == KeyRelease) {
    // Modifiers are often released first: match the key that was pressed.
    auto it = g_pressed.find(e->xkey.keycode);
    if (it == g_pressed.end()) return GDK_FILTER_CONTINUE;
    std::string id = it->second;
    g_pressed.erase(it);
    auto h = g_hotkeys.find(id);
    emit("shortcutReleased", json{{"id", id}, {"accelerator", h == g_hotkeys.end() ? json(nullptr) : json(h->second.accel)}});
    return GDK_FILTER_REMOVE;
  }
  return GDK_FILTER_CONTINUE;
}

static bool grab(const HotKey &h, bool on) {
  GdkDisplay *display = gdk_display_get_default();
  Display *dpy = GDK_DISPLAY_XDISPLAY(display);
  ::Window root = DefaultRootWindow(dpy);
  gdk_x11_display_error_trap_push(display);
  for (unsigned extra : kIgnored) {
    if (on) XGrabKey(dpy, h.code, h.mods | extra, root, False, GrabModeAsync, GrabModeAsync);
    else XUngrabKey(dpy, h.code, h.mods | extra, root);
  }
  XSync(dpy, False);
  return gdk_x11_display_error_trap_pop(display) == 0;
}

static void register_shortcuts() {
  reg("shortcuts", "register", [](CallPtr c) {
    std::string accel = c->str("accelerator", c->str("accel"));
    if (accel.empty()) return c->fail("invalid_args", "shortcuts.register: missing `accelerator`");
    if (!is_x11()) return c->fail("unsupported", "shortcuts.register: global hotkeys need X11 (Wayland has no global shortcut API for apps)");
    guint key;
    GdkModifierType mods;
    std::string error;
    if (!parse_accelerator(accel, &key, &mods, &error)) return c->fail("invalid_args", "shortcuts.register: " + error);
    std::string id = c->str("id", accel);
    if (g_hotkeys.count(id)) return c->fail("invalid_args", "shortcuts.register: id `" + id + "` is already registered");
    HotKey h;
    h.accel = accel;
    h.code = XKeysymToKeycode(GDK_DISPLAY_XDISPLAY(gdk_display_get_default()), (KeySym)key);
    h.mods = x_mods(mods);
    if (!h.code) return c->fail("invalid_args", "shortcuts.register: no key for `" + accel + "` on this keyboard");
    for (auto &[other, k] : g_hotkeys)
      if (k.code == h.code && k.mods == h.mods) return c->fail("invalid_args", "shortcuts.register: `" + accel + "` is already registered");
    if (!grab(h, true)) {
      grab(h, false);
      return c->fail("denied", "shortcuts.register: `" + accel + "` is taken by another application");
    }
    if (!g_filter) {
      gdk_window_add_filter(gdk_get_default_root_window(), hotkey_filter, nullptr); // grabs are delivered to the root window
      g_filter = true;
    }
    g_hotkeys[id] = h;
    c->ok(json{{"id", id}});
  });
  reg("shortcuts", "unregister", [](CallPtr c) {
    std::string id = c->str("id");
    if (id.empty()) return c->fail("invalid_args", "shortcuts.unregister: missing `id`");
    auto it = g_hotkeys.find(id);
    if (it == g_hotkeys.end()) return c->ok(json{{"unregistered", false}});
    grab(it->second, false);
    g_hotkeys.erase(it);
    c->ok(json{{"unregistered", true}});
  });
  reg_many("shortcuts", {"unregisterAll", "unregister_all"}, [](CallPtr c) {
    int n = (int)g_hotkeys.size();
    for (auto &[id, h] : g_hotkeys) grab(h, false);
    g_hotkeys.clear();
    c->ok(json{{"unregistered", n}});
  });
  reg("shortcuts", "isRegistered", [](CallPtr c) {
    std::string id = c->str("id");
    if (id.empty()) return c->fail("invalid_args", "shortcuts.isRegistered: missing `id`");
    c->ok((bool)g_hotkeys.count(id));
  });
}

// ---------------------------------------------------------------------------
// capture (X11)

static std::string x11_window_name(Display *dpy, ::Window xid) {
  Atom utf8 = XInternAtom(dpy, "UTF8_STRING", False), net_name = XInternAtom(dpy, "_NET_WM_NAME", False);
  Atom type;
  int format;
  unsigned long n, after;
  unsigned char *data = nullptr;
  std::string out;
  if (XGetWindowProperty(dpy, xid, net_name, 0, 1024, False, utf8, &type, &format, &n, &after, &data) == Success && data) {
    out.assign(reinterpret_cast<char *>(data), n);
    XFree(data);
  } else {
    char *name = nullptr;
    if (XFetchName(dpy, xid, &name) && name) {
      out = name;
      XFree(name);
    }
  }
  return out;
}

static std::vector<::Window> x11_client_windows(Display *dpy) {
  std::vector<::Window> out;
  Atom list = XInternAtom(dpy, "_NET_CLIENT_LIST", False), type;
  int format;
  unsigned long n, after;
  unsigned char *data = nullptr;
  if (XGetWindowProperty(dpy, DefaultRootWindow(dpy), list, 0, 4096, False, XA_WINDOW, &type, &format, &n, &after, &data) == Success && data) {
    auto *ids = reinterpret_cast<::Window *>(data);
    out.assign(ids, ids + n);
    XFree(data);
  }
  return out;
}

static json png_reply(GdkPixbuf *pb) {
  gchar *buf = nullptr;
  gsize len = 0;
  json out = nullptr;
  if (pb && gdk_pixbuf_save_to_buffer(pb, &buf, &len, "png", nullptr, nullptr)) {
    gchar *b64 = g_base64_encode(reinterpret_cast<guchar *>(buf), len);
    out = json{{"width", gdk_pixbuf_get_width(pb)}, {"height", gdk_pixbuf_get_height(pb)}, {"pngBase64", b64}};
    g_free(b64);
    g_free(buf);
  }
  if (pb) g_object_unref(pb);
  return out;
}

static void register_capture() {
  reg("capture", "isSupported", [](CallPtr c) { c->ok(json{{"supported", is_x11()}}); });
  reg("capture", "getSources", [](CallPtr c) {
    if (!is_x11()) return c->fail("unsupported", "capture: X11 only (Wayland screen capture goes through the desktop portal)");
    std::set<std::string> types;
    if (c->args.contains("types") && c->args["types"].is_array())
      for (const auto &t : c->args["types"])
        if (t.is_string()) types.insert(t.get<std::string>());
    bool all = types.empty();
    json out = json::array();
    GdkDisplay *display = gdk_display_get_default();
    if (all || types.count("display") || types.count("screen")) {
      GdkMonitor *primary = gdk_display_get_primary_monitor(display);
      for (int i = 0, n = gdk_display_get_n_monitors(display); i < n; i++) {
        GdkMonitor *m = gdk_display_get_monitor(display, i);
        GdkRectangle g;
        gdk_monitor_get_geometry(m, &g);
        int s = gdk_monitor_get_scale_factor(m);
        const char *model = gdk_monitor_get_model(m);
        out.push_back(json{{"id", i + 1}, {"type", "display"}, {"label", model && *model ? model : "Display " + std::to_string(i + 1)},
                           {"isMain", m == primary || (!primary && i == 0)}, {"resolution", {{"width", g.width * s}, {"height", g.height * s}}}});
      }
    }
    if (all || types.count("window")) {
      Display *dpy = GDK_DISPLAY_XDISPLAY(display);
      for (::Window xid : x11_client_windows(dpy)) {
        XWindowAttributes a;
        if (!XGetWindowAttributes(dpy, xid, &a) || a.map_state != IsViewable) continue;
        std::string name = x11_window_name(dpy, xid);
        out.push_back(json{{"id", (double)xid}, {"type", "window"}, {"label", name.empty() ? json(nullptr) : json(name)}, {"isMain", nullptr},
                           {"resolution", {{"width", a.width}, {"height", a.height}}}});
      }
    }
    c->ok(out);
  });
  reg("capture", "captureSource", [](CallPtr c) {
    if (!c->has("id")) return c->fail("invalid_args", "capture.captureSource: `id` is required");
    if (!is_x11()) return c->fail("unsupported", "capture: X11 only");
    GdkDisplay *display = gdk_display_get_default();
    std::string type = c->str("type", "");
    double ident = c->num("id", 0);
    GdkPixbuf *pb = nullptr;
    int n = gdk_display_get_n_monitors(display);
    if (type == "display" || (type.empty() && ident >= 1 && ident <= n)) {
      int i = (int)ident - 1;
      if (i < 0 || i >= n) return c->fail("invalid_args", "capture.captureSource: unknown display");
      GdkRectangle g;
      gdk_monitor_get_geometry(gdk_display_get_monitor(display, i), &g);
      pb = gdk_pixbuf_get_from_window(gdk_get_default_root_window(), g.x, g.y, g.width, g.height);
    } else {
      GdkWindow *foreign = gdk_x11_window_foreign_new_for_display(display, (::Window)ident);
      if (!foreign) return c->fail("invalid_args", "capture.captureSource: unknown window");
      pb = gdk_pixbuf_get_from_window(foreign, 0, 0, gdk_window_get_width(foreign), gdk_window_get_height(foreign));
      g_object_unref(foreign);
    }
    json r = png_reply(pb);
    if (r.is_null()) return c->fail("internal", "capture.captureSource: the X server returned no image");
    c->ok(r);
  });
}

// ---------------------------------------------------------------------------
// system

static json keyboard_layout() {
  json out{{"name", ""}, {"id", ""}};
  if (!is_x11()) return out;
  Display *dpy = GDK_DISPLAY_XDISPLAY(gdk_display_get_default());
  XkbStateRec state;
  if (XkbGetState(dpy, XkbUseCoreKbd, &state) != Success) return out;
  XkbDescPtr desc = XkbGetKeyboard(dpy, XkbAllComponentsMask, XkbUseCoreKbd);
  if (!desc) return out;
  if (desc->names && desc->names->groups[state.group]) {
    char *name = XGetAtomName(dpy, desc->names->groups[state.group]);
    if (name) {
      out["name"] = name;
      XFree(name);
    }
  }
  if (desc->names && desc->names->symbols) {
    char *sym = XGetAtomName(dpy, desc->names->symbols);
    if (sym) {
      out["id"] = sym;
      XFree(sym);
    }
  }
  XkbFreeKeyboard(desc, 0, True);
  return out;
}

static void register_system() {
  reg("system", "info", [](CallPtr c) {
    struct utsname u {};
    uname(&u);
    std::string arch = u.machine;
    if (arch == "x86_64") arch = "x64";
    else if (arch == "aarch64") arch = "arm64";
    c->ok(json{{"os", "linux"}, {"family", "unix"}, {"arch", arch},
               {"keyboardLayout", keyboard_layout()["name"]}, {"kernel", u.release},
               {"session", is_x11() ? "x11" : "wayland"}});
  });
  reg("system", "getKeyboardLayout", [](CallPtr c) { c->ok(keyboard_layout()); });
  reg("system", "getAccentColor", [](CallPtr c) {
    Window *w = find_window(primary_window());
    GtkWidget *probe = w ? w->window : gtk_window_new(GTK_WINDOW_TOPLEVEL);
    GdkRGBA rgba;
    bool found = gtk_style_context_lookup_color(gtk_widget_get_style_context(probe), "theme_selected_bg_color", &rgba);
    if (!w) gtk_widget_destroy(probe);
    if (!found) return c->fail("unavailable", "system.getAccentColor: the GTK theme defines no selection color");
    c->ok(json{{"r", rgba.red}, {"g", rgba.green}, {"b", rgba.blue}, {"a", rgba.alpha}});
  });
  reg("system", "getAccessibility", [](CallPtr c) {
    GtkSettings *s = gtk_settings_get_default();
    gboolean animations = TRUE;
    gchar *theme = nullptr;
    g_object_get(s, "gtk-enable-animations", &animations, "gtk-theme-name", &theme, nullptr);
    bool contrast = theme && (g_strrstr(theme, "HighContrast") || g_strrstr(theme, "Contrast"));
    g_free(theme);
    c->ok(json{{"reduceMotion", !animations}, {"highContrast", contrast}, {"differentiateWithoutColor", false}, {"reduceTransparency", false}});
  });
  // No per-app privacy prompts on a classic Linux desktop: devices are reachable or not.
  auto status = [](const std::string &name) -> std::string {
    if (name == "camera") return g_file_test("/dev/video0", G_FILE_TEST_EXISTS) ? (access("/dev/video0", R_OK) == 0 ? "granted" : "denied") : "denied";
    if (name == "screenRecording") return is_x11() ? "granted" : "denied";
    if (name == "notifications") return notifications_unavailable().empty() ? "granted" : "unavailable";
    return "granted";
  };
  reg("system", "checkPermission", [status](CallPtr c) { c->ok(json{{"status", status(c->str("name"))}}); });
  reg("system", "requestPermission", [status](CallPtr c) { c->ok(json{{"status", status(c->str("name"))}}); });
  reg("system", "openSettings", [](CallPtr c) {
    const char *argv[] = {"gnome-control-center", nullptr};
    GError *err = nullptr;
    if (!g_spawn_async(nullptr, (char **)argv, nullptr, G_SPAWN_SEARCH_PATH, nullptr, nullptr, nullptr, &err)) {
      std::string m = err ? err->message : "no settings application";
      g_clear_error(&err);
      return c->fail("unavailable", "system.openSettings: " + m);
    }
    c->ok();
  });
}

void register_extra() {
  register_menu();
  register_shortcuts();
  register_capture();
  register_system();
}

} // namespace lx
} // namespace sd
