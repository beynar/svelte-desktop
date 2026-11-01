// notifications.* — libnotify (org.freedesktop.Notifications), dlopen()ed on first
// use. Contract: ../NOTIFICATIONS.md; the shared half is ../portable/notifications.hpp.
//
// - Same id = the same NotifyNotification, updated and re-shown: the server
//   replaces it in place (renotify:false → suppress-sound on the update).
// - Responses: "default" action → click, others → action (no inline reply in
//   libnotify: input actions are plain actions), `closed` reason 2 → dismiss.
// - No OS scheduler: a GLib timer while running + <userData>/scheduled-notifications.json,
//   re-armed at startup (missed ones are delivered right away).
// - setBadge: the Unity LauncherEntry D-Bus signal (Ubuntu dock, KDE, Plank…).
// - delivered: what this process showed and wasn't closed (the shade can't be read).
// push.*: unsupported (no push service on Linux desktops).
#include <dlfcn.h>

#include "../portable/notifications.hpp"
#include "linux.hpp"

namespace sd {
namespace notif {

int target_window(int preferred) {
  auto ok = [](int id) { return id && lx::find_window(id) && page_loaded(id); };
  if (ok(preferred)) return preferred;
  for (int id : lx::window_ids())
    if (ok(id) && gtk_window_is_active(GTK_WINDOW(lx::find_window(id)->window))) return id;
  for (int id : lx::window_ids())
    if (ok(id)) return id;
  return 0;
}

static std::string g_activation_token; // xdg-activation token of the action being handled

void bring_to_front(int native_id) {
  lx::Window *w = lx::find_window(native_id);
  if (!w) return;
  GtkWindow *gw = GTK_WINDOW(w->window);
  if (!g_activation_token.empty()) gtk_window_set_startup_id(gw, g_activation_token.c_str()); // Wayland focus
  gtk_window_deiconify(gw);
  gtk_widget_show(w->window);
  gtk_window_present_with_time(gw, GDK_CURRENT_TIME);
}

} // namespace notif

namespace lx {

namespace notify {
typedef void (*ActionCb)(GObject *, char *, gpointer);
static bool tried = false, loaded = false, markup = false;
static gboolean (*init)(const char *);
static GObject *(*create)(const char *, const char *, const char *);
static gboolean (*update)(GObject *, const char *, const char *, const char *);
static gboolean (*show)(GObject *, GError **);
static gboolean (*close)(GObject *, GError **);
static void (*add_action)(GObject *, const char *, const char *, ActionCb, gpointer, GFreeFunc);
static void (*clear_actions)(GObject *);
static void (*clear_hints)(GObject *);
static void (*set_hint)(GObject *, const char *, GVariant *);
static void (*set_timeout)(GObject *, int);
static void (*set_urgency)(GObject *, int);
static int (*closed_reason)(GObject *);
static const char *(*activation_token)(GObject *); // libnotify ≥ 0.8
static gboolean (*server_info)(char **, char **, char **, char **);
static GList *(*server_caps)();
static std::map<std::string, GObject *> live; // id → notification on screen

static bool load() {
  if (tried) return loaded;
  tried = true;
  void *h = nullptr;
  for (const char *n : {"libnotify.so.4", "libnotify.so"})
    if ((h = dlopen(n, RTLD_NOW | RTLD_LOCAL))) break;
  auto sym = [h](const char *name, auto &out) {
    out = h ? reinterpret_cast<std::remove_reference_t<decltype(out)>>(dlsym(h, name)) : nullptr;
    return out != nullptr;
  };
  loaded = sym("notify_init", init) && sym("notify_notification_new", create) && sym("notify_notification_update", update) &&
           sym("notify_notification_show", show) && sym("notify_notification_close", close) &&
           sym("notify_notification_add_action", add_action) && sym("notify_notification_clear_actions", clear_actions) &&
           sym("notify_notification_clear_hints", clear_hints) && sym("notify_notification_set_hint", set_hint) &&
           sym("notify_notification_set_timeout", set_timeout) && sym("notify_notification_set_urgency", set_urgency) &&
           sym("notify_notification_get_closed_reason", closed_reason) && sym("notify_get_server_info", server_info) &&
           sym("notify_get_server_caps", server_caps) && init(app_name().c_str());
  sym("notify_notification_get_activation_token", activation_token); // optional
  return loaded;
}

/// "" when notifications can be shown, else why not.
static std::string unavailable() {
  if (!load()) return "libnotify (libnotify.so.4) is not installed";
  char *name = nullptr, *vendor = nullptr, *version = nullptr, *spec = nullptr;
  bool ok = server_info(&name, &vendor, &version, &spec);
  g_free(name), g_free(vendor), g_free(version), g_free(spec);
  if (!ok) return "no notification server on the session bus (org.freedesktop.Notifications)";
  static bool capsRead = false;
  if (!capsRead) {
    capsRead = true;
    GList *caps = server_caps();
    for (GList *l = caps; l; l = l->next)
      if (g_strcmp0((const char *)l->data, "body-markup") == 0) markup = true;
    g_list_free_full(caps, g_free);
  }
  return "";
}
} // namespace notify

std::string notifications_unavailable() { return notify::unavailable(); }

static std::string data_dir() { return std::string(g_get_user_data_dir()) + "/" + app_identifier(); }
static std::string cache_dir() { return std::string(g_get_user_cache_dir()) + "/" + app_identifier() + "/notification-images"; }

static notif::Store &store() {
  static notif::Store s;
  return s;
}
static std::map<std::string, int> g_sched_window; // id → window that scheduled it (this run)
static guint g_timer = 0;
static void rearm();

// ---------------------------------------------------------------------------
// Responses

static void forget(const std::string &id) {
  auto it = notify::live.find(id);
  if (it != notify::live.end()) {
    GObject *n = it->second;
    notify::live.erase(it);
    g_idle_add([](gpointer p) -> gboolean { return g_object_unref(p), G_SOURCE_REMOVE; }, n); // not inside its own signal
  }
  notif::records().erase(id);
}

static void close_live(const std::string &id);

static void on_action(GObject *n, char *action, gpointer data) {
  std::string id = (const char *)data, a = action ? action : "default";
  auto rec = notif::records().find(id);
  // Resident ones stay up after an action: a later close is the user's.
  if (rec != notif::records().end()) rec->second.acted = !rec->second.keep || a == "sd:close";
  if (a == "sd:close") { // closeButtonText: a dismiss button
    notif::respond(id, "dismiss", "", nullptr, "", 0);
    return close_live(id);
  }
  if (notify::activation_token)
    if (const char *t = notify::activation_token(n)) notif::g_activation_token = t;
  if (a == "default") notif::respond(id, "click", "", nullptr, "", 0);
  else notif::respond(id, "action", a.rfind("a:", 0) == 0 ? a.substr(2) : a, nullptr, "", 0);
  notif::g_activation_token.clear();
}

static void on_closed(GObject *n, gpointer data) {
  std::string id = (const char *)data;
  auto it = notify::live.find(id);
  if (it == notify::live.end() || it->second != n) return; // replaced or already dismissed by us
  auto rec = notif::records().find(id);
  bool acted = rec != notif::records().end() && rec->second.acted;
  if (notify::closed_reason(n) == 2 && !acted) notif::respond(id, "dismiss", "", nullptr, "", 0); // 2 = dismissed by the user
  forget(id);
}

// ---------------------------------------------------------------------------
// Showing

static std::string escape_markup(const std::string &s) {
  gchar *e = g_markup_escape_text(s.c_str(), -1);
  std::string out = e;
  g_free(e);
  return out;
}

/// Puts `s` on screen now (replacing a live notification with the same id).
static bool deliver(const notif::Show &s, int window, std::string *error) {
  std::string why = notify::unavailable();
  if (!why.empty()) return *error = "notifications: " + why, false;
  std::string icon, image, err;
  if (!s.icon.empty()) {
    icon = notif::image_file(s.icon, cache_dir(), &err);
    if (!icon.empty() && icon.find('/') != std::string::npos && !g_file_test(icon.c_str(), G_FILE_TEST_EXISTS)) icon.clear();
  }
  if (icon.empty()) {
    std::string appIcon = exe_dir() + "/" + app_identifier() + ".png";
    if (g_file_test(appIcon.c_str(), G_FILE_TEST_EXISTS)) icon = appIcon;
  }
  if (!s.image.empty()) {
    std::string p = notif::image_file(s.image, cache_dir(), &err);
    if (!p.empty() && g_file_test(p.c_str(), G_FILE_TEST_EXISTS))
      if (gchar *uri = g_filename_to_uri(p.c_str(), nullptr, nullptr)) image = uri, g_free(uri);
  }
  std::string body;
  if (notify::markup) {
    if (!s.subtitle.empty()) body = "<b>" + escape_markup(s.subtitle) + "</b>" + (s.body.empty() ? "" : "\n");
    body += escape_markup(s.body);
  } else body = s.subtitle.empty() ? s.body : s.subtitle + (s.body.empty() ? "" : "\n" + s.body);

  auto old = notify::live.find(s.id);
  bool replacing = old != notify::live.end();
  GObject *n;
  if (replacing) {
    n = old->second;
    notify::update(n, s.title.c_str(), body.empty() ? nullptr : body.c_str(), icon.empty() ? nullptr : icon.c_str());
    notify::clear_hints(n);
    notify::clear_actions(n);
  } else {
    n = notify::create(s.title.c_str(), body.empty() ? nullptr : body.c_str(), icon.empty() ? nullptr : icon.c_str());
    g_signal_connect_data(n, "closed", G_CALLBACK(on_closed), g_strdup(s.id.c_str()), (GClosureNotify)(void (*)(void))g_free, (GConnectFlags)0);
  }
  notify::set_hint(n, "desktop-entry", g_variant_new_string(app_identifier().c_str()));
  if (!image.empty()) notify::set_hint(n, "image-path", g_variant_new_string(image.c_str()));
  notify::set_urgency(n, s.urgency == "low" ? 0 : s.urgency == "critical" ? 2 : 1);
  notify::set_timeout(n, s.requireInteraction || s.ongoing ? 0 /* NOTIFY_EXPIRES_NEVER */ : -1 /* NOTIFY_EXPIRES_DEFAULT */);
  if (s.ongoing || !s.autoCancel) notify::set_hint(n, "resident", g_variant_new_boolean(TRUE)); // not removed by an action
  if (s.silent || (replacing && !s.renotify)) notify::set_hint(n, "suppress-sound", g_variant_new_boolean(TRUE));
  else if (!s.sound.empty() && s.sound != "default") {
    if (s.sound.find('/') != std::string::npos) notify::set_hint(n, "sound-file", g_variant_new_string(s.sound.c_str()));
    else notify::set_hint(n, "sound-name", g_variant_new_string(s.sound.c_str()));
  } else notify::set_hint(n, "sound-name", g_variant_new_string("message-new-instant"));
  notify::add_action(n, "default", "Open", on_action, g_strdup(s.id.c_str()), g_free);
  for (auto &a : s.actions) notify::add_action(n, ("a:" + a.id).c_str(), a.title.c_str(), on_action, g_strdup(s.id.c_str()), g_free);
  if (!s.closeButtonText.empty()) notify::add_action(n, "sd:close", s.closeButtonText.c_str(), on_action, g_strdup(s.id.c_str()), g_free);

  GError *gerr = nullptr;
  if (!notify::show(n, &gerr)) {
    *error = std::string("notifications.show: ") + (gerr ? gerr->message : "failed");
    g_clear_error(&gerr);
    if (!replacing) g_object_unref(n);
    else forget(s.id);
    return false;
  }
  notify::live[s.id] = n;
  notif::Record r = notif::make_record(s, window);
  if (replacing) {
    auto prev = notif::records().find(s.id);
    if (prev != notif::records().end() && !window) r.window = prev->second.window;
  }
  notif::records()[s.id] = r;
  return true;
}

static void close_live(const std::string &id) {
  auto it = notify::live.find(id);
  if (it == notify::live.end()) return notif::records().erase(id), void();
  GObject *n = it->second;
  notify::live.erase(it); // first: on_closed ignores it
  notify::close(n, nullptr);
  g_object_unref(n);
  notif::records().erase(id);
}

// ---------------------------------------------------------------------------
// Schedule

static gboolean tick(gpointer) {
  g_timer = 0;
  double now = notif::now_ms();
  bool changed = false;
  std::vector<json> due;
  for (auto &e : store().items)
    if (e["at"].get<double>() <= now + 500) due.push_back(e);
  for (auto &e : due) {
    std::string id = e["id"], repeat = e.value("repeat", ""), err;
    notif::Show s;
    if (notif::parse_show(e["args"], s, &err)) {
      s.id = id;
      int window = g_sched_window.count(id) ? g_sched_window[id] : 0;
      if (deliver(s, window, &err)) notif::shown_event(id, s.payload);
      else fprintf(stderr, "[shell] scheduled notification %s: %s\n", id.c_str(), err.c_str());
    }
    double next = repeat.empty() ? 0 : notif::next_occurrence(e["at"].get<double>(), repeat, now + 500);
    if (json *cur = store().find(id)) {
      if (next > 0) (*cur)["at"] = (long long)next;
      else store().erase(id), g_sched_window.erase(id);
    }
    changed = true;
  }
  if (changed) store().save();
  rearm();
  return G_SOURCE_REMOVE;
}

/// One timer for the earliest entry, at most 60 s ahead (wall clock rechecked: suspend).
static void rearm() {
  if (g_timer) g_source_remove(g_timer), g_timer = 0;
  if (store().items.empty()) return;
  double first = 0;
  for (auto &e : store().items) {
    double at = e["at"].get<double>();
    if (first == 0 || at < first) first = at;
  }
  double delay = std::max(0.0, std::min(60000.0, first - notif::now_ms()));
  g_timer = g_timeout_add((guint)delay, tick, nullptr);
}

static void cancel_pending(const std::string &id) {
  if (store().erase(id)) store().save(), rearm();
  g_sched_window.erase(id);
}

// ---------------------------------------------------------------------------
// Badge: com.canonical.Unity.LauncherEntry.Update(app_uri, {count, count-visible})

static std::string badge_error(long long count) {
  GError *err = nullptr;
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, &err);
  if (!bus) {
    std::string m = err ? err->message : "no session bus";
    g_clear_error(&err);
    return m;
  }
  std::string uri = "application://" + app_identifier() + ".desktop";
  std::string path = "/com/canonical/unity/launcherentry/" + std::to_string(g_str_hash(uri.c_str()));
  GVariantBuilder b;
  g_variant_builder_init(&b, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&b, "{sv}", "count", g_variant_new_int64(count));
  g_variant_builder_add(&b, "{sv}", "count-visible", g_variant_new_boolean(count > 0));
  bool ok = g_dbus_connection_emit_signal(bus, nullptr, path.c_str(), "com.canonical.Unity.LauncherEntry", "Update",
                                          g_variant_new("(sa{sv})", uri.c_str(), &b), &err);
  if (ok) g_dbus_connection_flush_sync(bus, nullptr, nullptr);
  std::string m = ok ? "" : err ? err->message : "emit failed";
  g_clear_error(&err);
  g_object_unref(bus);
  return m;
}

// ---------------------------------------------------------------------------

void register_notifications() {
  store().path = data_dir() + "/scheduled-notifications.json";
  store().load();
  if (!store().items.empty()) g_idle_add([](gpointer) -> gboolean { return rearm(), G_SOURCE_REMOVE; }, nullptr); // missed ones fire now

  auto status = [](CallPtr c) { c->ok(json{{"status", notify::unavailable().empty() ? "granted" : "unavailable"}}); };
  reg("notifications", "getPermissionStatus", status);
  reg("notifications", "requestPermission", status); // freedesktop notifications have no permission model

  reg_many("notifications", {"show", "notify"}, [](CallPtr c) {
    notif::Show s;
    std::string err;
    if (!notif::parse_show(c->args, s, &err)) return c->fail("invalid_args", err);
    int window = find_window(c->caller) ? c->caller : 0;
    double now = notif::now_ms();
    if (s.hasAt && s.at > now + 1000) {
      json args = c->args;
      args["id"] = s.id;
      store().put(s.id, s.at, s.repeat, args);
      std::string saved = store().save();
      if (!saved.empty()) {
        store().erase(s.id);
        return c->fail("internal", "notifications.show: the schedule could not be saved: " + saved);
      }
      close_live(s.id); // one id = one notification: the scheduled one replaces the shown one
      g_sched_window[s.id] = window;
      rearm();
      return c->ok(json{{"id", s.id}, {"scheduled", true}});
    }
    cancel_pending(s.id); // dedupe: a pending one with this id is replaced
    if (!deliver(s, window, &err)) return c->fail(err.find("notifications: ") == 0 ? "unavailable" : "internal", err);
    bool scheduled = false;
    if (!s.repeat.empty()) { // a series whose start is now/past: the next occurrence waits
      double next = notif::next_occurrence(s.at, s.repeat, now + 500);
      if (next > 0) {
        json args = c->args;
        args["id"] = s.id;
        store().put(s.id, next, s.repeat, args);
        store().save();
        g_sched_window[s.id] = window;
        rearm();
        scheduled = true;
      }
    }
    c->ok(json{{"id", s.id}, {"scheduled", scheduled}});
  });

  reg_many("notifications", {"dismiss", "close"}, [](CallPtr c) {
    std::string id = c->str("id", c->str("tag"));
    if (id.empty()) return c->fail("invalid_args", "notifications.dismiss: `id` must be a string");
    cancel_pending(id);
    if (notify::loaded) close_live(id);
    c->ok();
  });
  reg("notifications", "dismissAll", [](CallPtr c) {
    store().items = json::array();
    store().save();
    g_sched_window.clear();
    rearm();
    std::vector<std::string> ids;
    for (auto &[id, _] : notify::live) ids.push_back(id);
    for (auto &id : ids) close_live(id);
    notif::records().clear();
    c->ok();
  });
  reg("notifications", "delivered", [](CallPtr c) {
    json out = json::array();
    for (auto &[id, r] : notif::records())
      if (notify::live.count(id)) out.push_back(notif::record_json(r));
    c->ok(out);
  });
  reg("notifications", "pending", [](CallPtr c) {
    json out = json::array();
    for (auto &e : store().items) out.push_back(notif::pending_json(e));
    c->ok(out);
  });
  reg("notifications", "claim", [](CallPtr c) { c->ok(notif::take_claims()); });
  reg("notifications", "responses", [](CallPtr c) { c->ok(notif::ring()); });
  reg("notifications", "setBadge", [](CallPtr c) {
    long long count = 0;
    if (c->has("count")) {
      if (!c->args["count"].is_number() || c->num("count") < 0) return c->fail("invalid_args", "notifications.setBadge: `count` must be a number ≥ 0 or null");
      count = (long long)c->num("count");
    }
    std::string err = badge_error(count);
    if (!err.empty()) return c->fail("unavailable", "notifications.setBadge: " + err);
    c->ok();
  });
  reg("notifications", "setForeground", [](CallPtr c) { c->ok(); }); // banners always show on Linux
  reg_many("push", {"register", "unregister", "token"}, [](CallPtr c) {
    c->fail("unsupported", "push." + c->op + ": Linux desktops have no push notification service; use push.server (your own push server)");
  });
}

} // namespace lx
} // namespace sd
