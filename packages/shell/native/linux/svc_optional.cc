// notifications.* (libnotify), tray.* (libayatana-appindicator3, falling back to
// libappindicator3) and secureStorage.* (libsecret → the Secret Service:
// GNOME Keyring, KWallet, KeePassXC…).
//
// The three libraries are dlopen()ed on first use, so libshell.so only hard-
// depends on GTK and WebKitGTK: on a system without one of them (or without the
// daemon behind it) the service answers `unavailable` with the reason, and
// capabilities.describe reports it.
#include <dlfcn.h>
#include <libsecret/secret.h> // types only (SecretSchema); functions come from dlsym

#include <map>
#include <set>

#include "linux.hpp"

namespace sd {
namespace lx {

static void *open_lib(std::initializer_list<const char *> names) {
  for (const char *n : names)
    if (void *h = dlopen(n, RTLD_NOW | RTLD_LOCAL)) return h;
  return nullptr;
}
template <typename T> static bool sym(void *h, const char *name, T &out) {
  out = h ? reinterpret_cast<T>(dlsym(h, name)) : nullptr;
  return out != nullptr;
}

// ===========================================================================
// notifications.* — libnotify (org.freedesktop.Notifications)

namespace notify {
typedef void (*ActionCb)(GObject *, char *, gpointer);
static bool tried = false, loaded = false;
static gboolean (*init)(const char *);
static GObject *(*create)(const char *, const char *, const char *);
static gboolean (*show)(GObject *, GError **);
static gboolean (*close)(GObject *, GError **);
static void (*add_action)(GObject *, const char *, const char *, ActionCb, gpointer, GFreeFunc);
static gboolean (*server_info)(char **, char **, char **, char **);
static std::map<std::string, GObject *> live; // tag → notification

static bool load() {
  if (tried) return loaded;
  tried = true;
  void *h = open_lib({"libnotify.so.4", "libnotify.so"});
  loaded = sym(h, "notify_init", init) && sym(h, "notify_notification_new", create) && sym(h, "notify_notification_show", show) &&
           sym(h, "notify_notification_close", close) && sym(h, "notify_notification_add_action", add_action) &&
           sym(h, "notify_get_server_info", server_info) && init(app_name().c_str());
  return loaded;
}
/// "" when notifications can be shown, else why not.
static std::string unavailable() {
  if (!load()) return "libnotify (libnotify.so.4) is not installed";
  char *name = nullptr, *vendor = nullptr, *version = nullptr, *spec = nullptr;
  bool ok = server_info(&name, &vendor, &version, &spec);
  g_free(name), g_free(vendor), g_free(version), g_free(spec);
  return ok ? "" : "no notification server on the session bus (org.freedesktop.Notifications)";
}
} // namespace notify

static void register_notifications() {
  auto status = [](CallPtr c) {
    std::string why = notify::unavailable();
    if (!why.empty()) return c->fail("unavailable", "notifications: " + why);
    c->ok(json{{"status", "granted"}}); // freedesktop notifications have no permission model
  };
  reg("notifications", "getPermissionStatus", status);
  reg("notifications", "requestPermission", status);
  reg_many("notifications", {"show", "notify"}, [](CallPtr c) {
    if (!c->args.contains("title") || !c->args["title"].is_string()) return c->fail("invalid_args", "notifications.show: `title` must be a string");
    std::string why = notify::unavailable();
    if (!why.empty()) return c->fail("unavailable", "notifications: " + why);
    static int seq = 1;
    std::string tag = c->has("tag") ? c->str("tag") : "n" + std::to_string(seq++);
    auto old = notify::live.find(tag);
    if (old != notify::live.end()) { // same tag replaces
      notify::close(old->second, nullptr);
      g_object_unref(old->second);
      notify::live.erase(old);
    }
    std::string icon = exe_dir() + "/" + app_identifier() + ".png";
    GObject *n = notify::create(c->str("title").c_str(), c->has("body") ? c->str("body").c_str() : nullptr,
                                g_file_test(icon.c_str(), G_FILE_TEST_EXISTS) ? icon.c_str() : nullptr);
    auto respond = +[](GObject *, char *action, gpointer data) {
      std::string tag = (const char *)data, a = action ? action : "default";
      emit("notificationResponse", json{{"tag", tag}, {"actionId", a == "default" ? json(nullptr) : json(a)}});
    };
    notify::add_action(n, "default", "Open", respond, g_strdup(tag.c_str()), g_free);
    if (c->args.contains("actions") && c->args["actions"].is_array())
      for (auto &a : c->args["actions"])
        if (a.is_object() && a.contains("id") && a["id"].is_string())
          notify::add_action(n, a["id"].get<std::string>().c_str(), a.value("label", a["id"].get<std::string>()).c_str(), respond, g_strdup(tag.c_str()), g_free);
    GError *err = nullptr;
    if (!notify::show(n, &err)) {
      std::string m = err ? err->message : "failed";
      g_clear_error(&err);
      g_object_unref(n);
      return c->fail("internal", "notifications.show: " + m);
    }
    notify::live[tag] = n;
    c->ok(json{{"tag", tag}});
  });
  reg_many("notifications", {"dismiss", "close"}, [](CallPtr c) {
    if (!c->args.contains("tag") || !c->args["tag"].is_string()) return c->fail("invalid_args", "notifications.dismiss: `tag` must be a string");
    std::string why = notify::unavailable();
    if (!why.empty()) return c->fail("unavailable", "notifications: " + why);
    auto it = notify::live.find(c->str("tag"));
    if (it != notify::live.end()) {
      notify::close(it->second, nullptr);
      g_object_unref(it->second);
      notify::live.erase(it);
    }
    c->ok();
  });
}

// ===========================================================================
// tray.* — StatusNotifierItem via (ayatana-)appindicator

namespace ind {
static bool tried = false, loaded = false;
static GObject *(*create)(const char *, const char *, int);
static void (*set_status)(GObject *, int);
static void (*set_menu)(GObject *, GtkMenu *);
static void (*set_label)(GObject *, const char *, const char *);
static void (*set_title)(GObject *, const char *);
static void (*set_icon_full)(GObject *, const char *, const char *);
static void (*set_secondary_target)(GObject *, GtkWidget *);
static GObject *indicator = nullptr;
static GtkWidget *menu = nullptr;
static bool userMenu = false;
static std::string title, tooltip;

static bool load() {
  if (tried) return loaded;
  tried = true;
  void *h = open_lib({"libayatana-appindicator3.so.1", "libappindicator3.so.1"});
  loaded = sym(h, "app_indicator_new", create) && sym(h, "app_indicator_set_status", set_status) && sym(h, "app_indicator_set_menu", set_menu) &&
           sym(h, "app_indicator_set_label", set_label) && sym(h, "app_indicator_set_title", set_title) &&
           sym(h, "app_indicator_set_icon_full", set_icon_full);
  sym(h, "app_indicator_set_secondary_activate_target", set_secondary_target); // optional
  return loaded;
}
} // namespace ind

// The contract's AppKit icon vocabulary (NATIVE_ICON_NAMES) → freedesktop names.
static const std::map<std::string, std::string> &icon_names() {
  static const std::map<std::string, std::string> m = {
      {"actiontemplate", "system-run"}, {"add", "list-add"}, {"advanced", "preferences-other"}, {"bluetooth", "bluetooth"},
      {"bonjour", "network-workgroup"}, {"bookmarks", "user-bookmarks"}, {"caution", "dialog-warning"}, {"color", "applications-graphics"},
      {"colorpanel", "applications-graphics"}, {"columnview", "view-list"}, {"computer", "computer"}, {"enterfullscreen", "view-fullscreen"},
      {"everyone", "system-users"}, {"exitfullscreen", "view-restore"}, {"folder", "folder"}, {"folderburnable", "media-optical"},
      {"foldersmart", "folder-saved-search"}, {"followlinkfreestandingtemplate", "go-jump"}, {"fontpanel", "preferences-desktop-font"},
      {"freestandingtemplate", "emblem-default"}, {"goleft", "go-previous"}, {"goright", "go-next"}, {"home", "user-home"},
      {"ichattheater", "video-display"}, {"invaliddatafreestanding", "dialog-error"}, {"leftfacingtriangle", "pan-start"},
      {"listview", "view-list"}, {"locklocked", "changes-prevent"}, {"lockunlocked", "changes-allow"}, {"me", "avatar-default"},
      {"menumixedstate", "list-remove"}, {"mobileme", "weather-overcast"}, {"multipledocuments", "edit-copy"}, {"network", "network-workgroup"},
      {"noaccounts", "action-unavailable"}, {"openpanel", "document-open"}, {"preferencesgeneral", "preferences-system"},
      {"quicklook", "view-reveal"}, {"refresh", "view-refresh"}, {"refreshfreestanding", "view-refresh"}, {"remove", "list-remove"},
      {"reveal", "system-search"}, {"revealfreestanding", "system-search"}, {"rightfacingtriangle", "pan-end"}, {"share", "send-to"},
      {"slideshow", "media-playback-start"}, {"smartbadge", "emblem-default"}, {"statusavailable", "user-available"},
      {"statusnone", "user-offline"}, {"statuspartiallyavailable", "user-away"}, {"statusunavailable", "user-busy"},
      {"stopprogress", "process-stop"}, {"stopprogressfreestanding", "process-stop"}, {"trashempty", "user-trash"},
      {"trashfull", "user-trash-full"}, {"user", "avatar-default"}, {"useraccounts", "system-users"}, {"usergroup", "system-users"},
      {"userguest", "avatar-default"}};
  return m;
}

/// icon spec → freedesktop icon name or absolute path. "" + *code/*error on failure; "-" = none given.
static std::string resolve_icon(const json &icon, std::string *code, std::string *error) {
  auto native = [&](std::string n) -> std::string {
    for (auto &ch : n) ch = (char)g_ascii_tolower(ch);
    auto it = icon_names().find(n);
    if (it != icon_names().end()) return it->second;
    *code = "invalid_args", *error = "unknown native icon `" + n + "`";
    return "";
  };
  auto file = [&](const std::string &p) -> std::string {
    if (!g_file_test(p.c_str(), G_FILE_TEST_EXISTS)) {
      *code = "unavailable", *error = "icon file not found: " + p;
      return "";
    }
    return p;
  };
  if (icon.is_string()) {
    std::string s = icon.get<std::string>();
    if (s.find('/') != std::string::npos) return file(s);
    std::string lower = s;
    for (auto &ch : lower) ch = (char)g_ascii_tolower(ch);
    if (icon_names().count(lower)) return icon_names().at(lower);
    return s; // a freedesktop icon name ("mail-unread") or an SF Symbol name used as one
  }
  if (icon.is_object()) {
    if (icon.contains("native") && icon["native"].is_string()) {
      std::string n = icon["native"].get<std::string>();
      // "star.fill"-style SF Symbol names pass through as theme icon names.
      return n.find('.') != std::string::npos ? n : native(n);
    }
    if (icon.contains("symbol") && icon["symbol"].is_string()) return icon["symbol"].get<std::string>();
    if (icon.contains("path") && icon["path"].is_string()) return file(icon["path"].get<std::string>());
  }
  *code = "invalid_args", *error = "icon must be {native}, {symbol}, {path} or a string";
  return "";
}

static const std::set<std::string> kRoles = {"about", "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll", "delete",
                                             "minimize", "close", "quit", "hide", "hideOthers", "unhide", "reload", "toggleDevTools",
                                             "resetZoom", "zoomIn", "zoomOut", "toggleFullscreen", "front", "zoom", "window", "help",
                                             "separator", "services"};

static std::string role_label(const std::string &r) {
  if (r == "quit") return "Quit " + app_name();
  if (r == "about") return "About " + app_name();
  std::string out;
  for (char ch : r) {
    if (g_ascii_isupper(ch)) out += ' ';
    out += out.empty() ? (char)g_ascii_toupper(ch) : (char)g_ascii_tolower(ch);
  }
  return out;
}

static void on_item_activate(GtkMenuItem *item, gpointer) {
  const char *id = (const char *)g_object_get_data(G_OBJECT(item), "sd-id");
  const char *role = (const char *)g_object_get_data(G_OBJECT(item), "sd-role");
  if (role && std::string(role) == "quit") {
    emit("willQuit");
    request_quit();
  } else if (role && std::string(role) == "about") {
    dispatch(json{{"service", "app"}, {"op", "aboutPanel"}}, 0, [](const json &) {});
  } else if (id) {
    emit("menuAction", json{{"id", id}});
  }
}

/// MenuItemSpec[] → GtkMenu (nullptr + *error on invalid specs). validateOnly builds nothing.
static GtkWidget *build_menu(const json &items, std::string *error) {
  GtkWidget *menu = gtk_menu_new();
  for (auto &it : items) {
    if (!it.is_object()) {
      *error = "menu items must be objects";
      break;
    }
    std::string type = it.value("type", ""), role = it.value("role", ""), label = it.value("label", "");
    if (type == "separator" || role == "separator") {
      gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());
      continue;
    }
    if (!role.empty() && !kRoles.count(role)) {
      *error = "unknown menu role `" + role + "`";
      break;
    }
    if (it.contains("icon") && !it["icon"].is_null()) {
      std::string code, err;
      if (resolve_icon(it["icon"], &code, &err).empty()) {
        *error = "menu item icon: " + err;
        break;
      }
    }
    GtkWidget *item = nullptr;
    if (type == "submenu" || it.contains("submenu")) {
      if (!it.contains("submenu") || !it["submenu"].is_array() || it["submenu"].empty()) {
        *error = "submenu `" + label + "` has no items";
        break;
      }
      GtkWidget *sub = build_menu(it["submenu"], error);
      if (!sub) break;
      item = gtk_menu_item_new_with_label(label.c_str());
      gtk_menu_item_set_submenu(GTK_MENU_ITEM(item), sub);
    } else if (it.contains("checked") && it["checked"].is_boolean()) {
      item = gtk_check_menu_item_new_with_label(label.c_str());
      gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(item), it["checked"].get<bool>());
    } else {
      item = gtk_menu_item_new_with_label(label.empty() && !role.empty() ? role_label(role).c_str() : label.c_str());
    }
    if (it.contains("id")) g_object_set_data_full(G_OBJECT(item), "sd-id", g_strdup(it["id"].is_string() ? it["id"].get<std::string>().c_str() : it["id"].dump().c_str()), g_free);
    if (!role.empty()) g_object_set_data_full(G_OBJECT(item), "sd-role", g_strdup(role.c_str()), g_free);
    if (it.value("disabled", false) || (it.contains("enabled") && it["enabled"].is_boolean() && !it["enabled"].get<bool>())) gtk_widget_set_sensitive(item, FALSE);
    g_signal_connect(item, "activate", G_CALLBACK(on_item_activate), nullptr);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), item);
  }
  if (!error->empty()) {
    g_object_ref_sink(menu);
    g_object_unref(menu);
    return nullptr;
  }
  gtk_widget_show_all(menu);
  return menu;
}

static void tray_click() {
  popover_tray_click();
  emit("trayClick", json::object()); // no icon rect: SNI hosts don't report it
}

static GtkWidget *default_menu() {
  // StatusNotifierItem hosts only show an item that has a menu: without a user
  // menu, one entry stands for "click".
  GtkWidget *m = gtk_menu_new();
  std::string label = !ind::title.empty() ? ind::title : !ind::tooltip.empty() ? ind::tooltip : app_name();
  GtkWidget *item = gtk_menu_item_new_with_label(label.c_str());
  g_signal_connect(item, "activate", G_CALLBACK(+[](GtkMenuItem *, gpointer) { tray_click(); }), nullptr);
  gtk_menu_shell_append(GTK_MENU_SHELL(m), item);
  gtk_widget_show_all(m);
  if (ind::set_secondary_target) ind::set_secondary_target(ind::indicator, item); // middle click = click
  return m;
}

bool tray_is_set() { return ind::indicator != nullptr; }

static bool tray_remove() {
  if (!ind::indicator) return false;
  ind::set_status(ind::indicator, 0 /* PASSIVE */);
  g_object_unref(ind::indicator);
  ind::indicator = nullptr;
  ind::menu = nullptr;
  ind::userMenu = false;
  ind::title.clear();
  ind::tooltip.clear();
  tray_bind_popover("");
  return true;
}

static void tray_set(CallPtr c) {
  // Validate everything before touching the indicator.
  std::string icon = "-", code, error;
  for (const char *k : {"imageName", "icon", "imagePath"}) {
    if (!c->has(k)) continue;
    json spec = std::string(k) == "imageName" ? json{{"native", c->args[k]}} : c->args[k];
    if (std::string(k) == "imageName" && !c->args[k].is_string()) return c->fail("invalid_args", "tray.set: `imageName` must be a string");
    icon = resolve_icon(spec, &code, &error);
    if (icon.empty()) return c->fail(code, "tray.set: " + error);
  }
  if (c->has("badgeColor")) {
    GdkRGBA rgba;
    if (!c->args["badgeColor"].is_string() || !gdk_rgba_parse(&rgba, c->str("badgeColor").c_str()))
      return c->fail("invalid_args", "tray.set: `badgeColor` must be a CSS color");
  }
  GtkWidget *menu = nullptr;
  bool menuGiven = c->args.contains("menu"), menuNull = menuGiven && c->args["menu"].is_null();
  if (menuGiven && !menuNull) {
    json items = c->args["menu"].is_array() ? c->args["menu"] : c->args["menu"].is_object() ? c->args["menu"].value("items", json()) : json();
    if (!items.is_array()) return c->fail("invalid_args", "tray.set: `menu` must be {items:[…]} or an array of items");
    menu = build_menu(items, &error);
    if (!menu) return c->fail("invalid_args", "tray.set: " + error);
  }
  if (!ind::load()) {
    if (menu) g_object_unref(g_object_ref_sink(menu));
    return c->fail("unavailable", "tray: libayatana-appindicator3 is not installed");
  }
  if (!ind::indicator) {
    std::string id = app_identifier();
    for (auto &ch : id)
      if (!g_ascii_isalnum(ch)) ch = '_';
    ind::indicator = ind::create(id.c_str(), "application-x-executable", 0 /* APPLICATION_STATUS */);
    ind::title = app_name();
  }
  if (c->has("title")) {
    ind::title = c->str("title");
    ind::set_label(ind::indicator, ind::title.c_str(), ind::title.c_str());
  }
  if (c->has("tooltip")) {
    ind::tooltip = c->str("tooltip");
    ind::set_title(ind::indicator, ind::tooltip.c_str());
  }
  if (icon != "-") ind::set_icon_full(ind::indicator, icon.c_str(), ind::tooltip.empty() ? app_name().c_str() : ind::tooltip.c_str());
  else if ((c->args.contains("imageName") && c->args["imageName"].is_null()) || (c->args.contains("icon") && c->args["icon"].is_null()))
    ind::set_icon_full(ind::indicator, "application-x-executable", app_name().c_str());
  if (c->args.contains("popover")) tray_bind_popover(c->args["popover"].is_string() ? c->str("popover") : "");
  if (menu) {
    ind::menu = menu;
    ind::userMenu = true;
    ind::set_menu(ind::indicator, GTK_MENU(menu));
  } else if (menuNull || !ind::menu || !ind::userMenu) {
    ind::menu = default_menu();
    ind::userMenu = false;
    ind::set_menu(ind::indicator, GTK_MENU(ind::menu));
  }
  ind::set_status(ind::indicator, 1 /* ACTIVE */);
  c->ok(json{{"set", true}});
}

static void register_tray() {
  reg_many("tray", {"set", "create"}, tray_set);
  reg_many("tray", {"remove", "destroy"}, [](CallPtr c) { c->ok(json{{"removed", tray_remove()}}); });
  reg_many("tray", {"isSet", "exists"}, [](CallPtr c) { c->ok(tray_is_set()); });
  reg("tray", "getBounds", [](CallPtr c) { c->ok(nullptr); }); // StatusNotifierItem doesn't expose the icon's geometry
  reg("tray", "performClick", [](CallPtr c) {
    if (!tray_is_set()) return c->fail("unavailable", "tray.performClick: no tray item (tray.set)");
    if (ind::userMenu) return c->fail("unsupported", "tray.performClick: the tray item has a menu (clicking would open it)");
    tray_click();
    c->ok(json{{"clicked", true}});
  });
}

// ===========================================================================
// secureStorage.* — libsecret

namespace secret {
static bool tried = false, loaded = false;
static gboolean (*storev)(const SecretSchema *, GHashTable *, const gchar *, const gchar *, const gchar *, GCancellable *, GError **);
static gchar *(*lookupv)(const SecretSchema *, GHashTable *, GCancellable *, GError **);
static gboolean (*clearv)(const SecretSchema *, GHashTable *, GCancellable *, GError **);
static void (*pw_free)(gchar *);

static const SecretSchema schema = {
    "dev.svelte-desktop.Password", SECRET_SCHEMA_NONE, {{"service", SECRET_SCHEMA_ATTRIBUTE_STRING}, {"account", SECRET_SCHEMA_ATTRIBUTE_STRING}, {nullptr, (SecretSchemaAttributeType)0}}};

static bool load() {
  if (tried) return loaded;
  tried = true;
  void *h = open_lib({"libsecret-1.so.0", "libsecret-1.so"});
  loaded = sym(h, "secret_password_storev_sync", storev) && sym(h, "secret_password_lookupv_sync", lookupv) &&
           sym(h, "secret_password_clearv_sync", clearv) && sym(h, "secret_password_free", pw_free);
  return loaded;
}

static GHashTable *attrs(const std::string &service, const std::string *account) {
  GHashTable *t = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  g_hash_table_insert(t, g_strdup("service"), g_strdup(service.c_str()));
  if (account) g_hash_table_insert(t, g_strdup("account"), g_strdup(account->c_str()));
  return t;
}

static void fail(CallPtr c, const char *op, GError *e) {
  std::string m = e ? e->message : "failed";
  bool down = e && (e->domain == G_DBUS_ERROR || g_strstr_len(e->message, -1, "org.freedesktop.secrets"));
  bool denied = e && ((e->domain == G_IO_ERROR && (e->code == G_IO_ERROR_PERMISSION_DENIED || e->code == G_IO_ERROR_CANCELLED)));
  if (e) g_error_free(e);
  c->fail(denied ? "denied" : down ? "unavailable" : "internal", std::string("secureStorage.") + op + ": " + m);
}
} // namespace secret

static bool check_args(CallPtr c, bool needAccount) {
  if (!c->args.contains("service") || !c->args["service"].is_string() || c->str("service").empty()) {
    c->fail("invalid_args", "secureStorage." + c->op + ": `service` must be a non-empty string");
    return false;
  }
  if (needAccount && (!c->args.contains("account") || !c->args["account"].is_string())) {
    c->fail("invalid_args", "secureStorage." + c->op + ": `account` must be a string");
    return false;
  }
  if (!secret::load()) {
    c->fail("unavailable", "secureStorage: libsecret (libsecret-1.so.0) is not installed");
    return false;
  }
  return true;
}

static void register_secure_storage() {
  reg("secureStorage", "setPassword", [](CallPtr c) {
    if (!c->args.contains("service") || !c->args["service"].is_string() || c->str("service").empty())
      return c->fail("invalid_args", "secureStorage.setPassword: `service` must be a non-empty string");
    if (!c->args.contains("account") || !c->args["account"].is_string()) return c->fail("invalid_args", "secureStorage.setPassword: `account` must be a string");
    if (!c->args.contains("password") || !c->args["password"].is_string()) return c->fail("invalid_args", "secureStorage.setPassword: `password` must be a string");
    if (!check_args(c, true)) return;
    std::string service = c->str("service"), account = c->str("account");
    GHashTable *a = secret::attrs(service, &account);
    GError *err = nullptr;
    std::string label = service + " (" + account + ")";
    bool ok = secret::storev(&secret::schema, a, SECRET_COLLECTION_DEFAULT, label.c_str(), c->str("password").c_str(), nullptr, &err);
    g_hash_table_unref(a);
    ok ? c->ok() : secret::fail(c, "setPassword", err);
  });
  reg("secureStorage", "getPassword", [](CallPtr c) {
    if (!check_args(c, true)) return;
    std::string service = c->str("service"), account = c->str("account");
    GHashTable *a = secret::attrs(service, &account);
    GError *err = nullptr;
    gchar *pw = secret::lookupv(&secret::schema, a, nullptr, &err);
    g_hash_table_unref(a);
    if (err) return secret::fail(c, "getPassword", err);
    if (!pw) return c->ok(nullptr);
    std::string out = pw;
    secret::pw_free(pw);
    c->ok(out);
  });
  reg("secureStorage", "deletePassword", [](CallPtr c) {
    if (!check_args(c, false)) return;
    std::string service = c->str("service"), account = c->str("account");
    bool hasAccount = c->args.contains("account") && c->args["account"].is_string();
    GHashTable *a = secret::attrs(service, hasAccount ? &account : nullptr); // no account → every entry of the service
    GError *err = nullptr;
    secret::clearv(&secret::schema, a, nullptr, &err);
    g_hash_table_unref(a);
    if (err) return secret::fail(c, "deletePassword", err);
    c->ok();
  });
}

// ===========================================================================

const std::vector<std::string> &unavailable_ops() {
  static std::vector<std::string> out;
  out.clear();
  if (!notify::unavailable().empty()) out.push_back("notifications.*");
  if (!ind::load()) out.push_back("tray.*");
  if (!secret::load()) out.push_back("secureStorage.*");
  return out;
}

void register_optional() {
  register_notifications();
  register_tray();
  register_secure_storage();
}

} // namespace lx
} // namespace sd
