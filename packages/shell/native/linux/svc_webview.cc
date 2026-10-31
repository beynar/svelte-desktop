// webview.* (a subset), popover.* and events.emit on WebKitGTK.
//
// webview: executeJavaScript (promises awaited, JSON result), setZoom/getZoom,
// reload/stop/goBack/goForward, getInfo, setUserAgent/getUserAgent,
// setInspectable, capturePage (webkit_web_view_get_snapshot → PNG/JPEG),
// getOpenedFiles. Target: popoverId, windowId (0 = primary), the calling page,
// the primary window. Other webview ops (find, context menu, downloads, print,
// file drop, JS dialogs) are not registered → `unsupported`.
//
// popover: a borderless GtkWindow holding a WebKitWebView, created (and loaded,
// unless preload:false) at popover.create and kept warm while unmapped, so the
// first show paints immediately. Both styles are the same undecorated window on
// Linux: `panel` is placed (tray|center|cursor|{x,y}), `popover` is placed under
// its anchor (no arrow). Light dismiss on focus loss, Escape closes.
// Events: popoverReady, popoverShown, popoverHidden, popoverResized {id}.
#include <cmath>
#include <map>

#include "linux.hpp"

namespace sd {
namespace lx {

// ===========================================================================
// JS evaluation

void eval_to_json(WebKitWebView *wv, const std::string &js, CallPtr c, const char *what) {
  struct Ctx {
    CallPtr c;
    std::string what;
  };
  webkit_web_view_evaluate_javascript(wv, js.c_str(), (gssize)js.size(), nullptr, nullptr, nullptr, [](GObject *src, GAsyncResult *res, gpointer data) {
    auto *x = static_cast<Ctx *>(data);
    GError *err = nullptr;
    JSCValue *v = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(src), res, &err);
    if (!v) {
      x->c->fail("internal", x->what + ": " + (err ? err->message : "JavaScript error"));
      if (err) g_error_free(err);
    } else {
      json out = nullptr;
      if (!jsc_value_is_undefined(v) && !jsc_value_is_null(v)) {
        char *s = jsc_value_to_json(v, 0);
        out = s ? json::parse(s, nullptr, false) : json();
        if (!s || out.is_discarded()) {
          char *t = jsc_value_to_string(v);
          out = t ? t : "";
          g_free(t);
        }
        g_free(s);
      }
      x->c->ok(out);
      g_object_unref(v);
    }
    delete x;
  }, new Ctx{c, what});
}

static void execute_js(WebKitWebView *wv, const std::string &code, CallPtr c) {
  // Awaits promises and returns a JSON value. Indirect eval keeps script
  // semantics (value of the last statement); a page CSP without 'unsafe-eval'
  // blocks it, then plain evaluation (no promise awaiting) is the fallback.
  static const char *body = "const v = await (0, eval)(__code); return v === undefined ? 'null' : (JSON.stringify(v) ?? 'null');";
  GVariantBuilder b;
  g_variant_builder_init(&b, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&b, "{sv}", "__code", g_variant_new_string(code.c_str()));
  struct Ctx {
    CallPtr c;
    std::string code;
    WebKitWebView *wv;
  };
  auto *ctx = new Ctx{c, code, wv};
  g_object_ref(wv);
  webkit_web_view_call_async_javascript_function(wv, body, -1, g_variant_builder_end(&b), nullptr, nullptr, nullptr, [](GObject *src, GAsyncResult *res, gpointer data) {
    auto *x = static_cast<Ctx *>(data);
    GError *err = nullptr;
    JSCValue *v = webkit_web_view_call_async_javascript_function_finish(WEBKIT_WEB_VIEW(src), res, &err);
    if (v) {
      char *s = jsc_value_is_string(v) ? jsc_value_to_string(v) : nullptr;
      json out = s ? json::parse(s, nullptr, false) : json();
      g_free(s);
      x->c->ok(out.is_discarded() ? json() : out);
      g_object_unref(v);
    } else {
      std::string msg = err ? err->message : "JavaScript error";
      if (err) g_error_free(err);
      if (msg.find("EvalError") != std::string::npos || msg.find("unsafe-eval") != std::string::npos) eval_to_json(x->wv, x->code, x->c, "webview.executeJavaScript");
      else x->c->fail("internal", "webview.executeJavaScript: " + msg);
    }
    g_object_unref(x->wv);
    delete x;
  }, ctx);
}

// ===========================================================================
// Popovers

struct Popover {
  std::string id;
  int nativeId = 0;
  std::string style, behavior, url;
  int width = 320, height = 240;
  bool closeOnEscape = true, activate = true, ready = false, loaded = false, shown = false;
  int edge = 0; // 0 bottom, 1 top, 2 left, 3 right
  json position = "tray";
  GtkWidget *win = nullptr;
  WebKitWebView *wv = nullptr;
  std::function<void()> pendingShow;
  bool hadFocus = false; // focused since the last show (light dismiss needs it)
};

static std::map<std::string, Popover *> g_popovers;
static std::string g_tray_popover;
static int g_next_native = 1000;

static Popover *find_native(int nativeId) {
  for (auto &[_, p] : g_popovers)
    if (p->nativeId == nativeId) return p;
  return nullptr;
}

std::string popover_ident(int nativeId) {
  Popover *p = find_native(nativeId);
  return p ? p->id : "";
}

static json describe(Popover *p) {
  bool appActive = false;
  for (int id : window_ids()) appActive = appActive || gtk_window_is_active(GTK_WINDOW(find_window(id)->window));
  return json{{"id", p->id}, {"style", p->style}, {"shown", p->shown}, {"width", p->width}, {"height", p->height},
              {"url", p->url.empty() ? json(nullptr) : json(p->url)}, {"ready", p->ready},
              {"key", (bool)gtk_window_is_active(GTK_WINDOW(p->win))}, {"appActive", appActive || gtk_window_is_active(GTK_WINDOW(p->win))}};
}

static void hide_popover(Popover *p) {
  if (!p->shown) return;
  p->shown = false;
  gtk_widget_hide(p->win);
  emit("popoverHidden", json{{"id", p->id}});
}

static gboolean on_popover_focus_in(GtkWidget *, GdkEventFocus *, gpointer data) {
  if (Popover *p = find_native(GPOINTER_TO_INT(data))) p->hadFocus = p->shown;
  return FALSE;
}
static gboolean on_popover_focus_out(GtkWidget *, GdkEventFocus *, gpointer data) {
  Popover *p = find_native(GPOINTER_TO_INT(data));
  // Light dismiss: it had focus since it was shown and lost it.
  if (p && p->shown && p->hadFocus && p->behavior != "manual") hide_popover(p);
  return FALSE;
}
static gboolean on_popover_key(GtkWidget *, GdkEventKey *ev, gpointer data) {
  Popover *p = find_native(GPOINTER_TO_INT(data));
  if (p && p->closeOnEscape && ev->keyval == GDK_KEY_Escape) {
    hide_popover(p);
    return TRUE;
  }
  return FALSE;
}
static gboolean on_popover_delete(GtkWidget *, GdkEvent *, gpointer data) {
  if (Popover *p = find_native(GPOINTER_TO_INT(data))) hide_popover(p);
  return TRUE; // keep the warm window
}

static Popover *build(CallPtr c, const std::string &ident, std::string *error) {
  std::string url = c->str("url");
  if (url.empty()) {
    std::string route = c->has("route") ? c->str("route") : "/";
    std::string origin = app_origin();
    if (origin.empty()) {
      *error = "popover.create: the app origin isn't known yet (create popovers after the shell is ready)";
      return nullptr;
    }
    url = origin + (route.rfind('/', 0) == 0 ? route : "/" + route);
  }
  auto *p = new Popover;
  p->id = ident;
  p->nativeId = g_next_native++;
  p->style = c->str("style") == "panel" ? "panel" : "popover";
  p->behavior = c->has("behavior") ? c->str("behavior") : "transient";
  p->url = url;
  p->width = std::max(40, (int)c->num("width", 320));
  p->height = std::max(24, (int)c->num("height", 240));
  p->closeOnEscape = c->flag("closeOnEscape", true);
  p->activate = c->flag("activate", true);
  if (c->has("position")) p->position = c->args["position"];
  std::string edge = c->str("edge");
  p->edge = edge == "top" ? 1 : edge == "left" ? 2 : edge == "right" ? 3 : 0;

  std::string script = "window.__shellPopover=Object.freeze({id:" + json(ident).dump() +
                       "});document.documentElement.setAttribute('data-shell-popover','');";
  p->wv = make_webview(p->nativeId, c->flag("debug", false), script);
  p->win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  GtkWindow *w = GTK_WINDOW(p->win);
  gtk_window_set_decorated(w, FALSE);
  gtk_window_set_skip_taskbar_hint(w, TRUE);
  gtk_window_set_skip_pager_hint(w, TRUE);
  gtk_window_set_keep_above(w, TRUE);
  gtk_window_set_type_hint(w, GDK_WINDOW_TYPE_HINT_UTILITY);
  gtk_window_set_title(w, ident.c_str());
  gtk_window_set_default_size(w, p->width, p->height);
  GdkScreen *screen = gtk_widget_get_screen(p->win);
  if (c->flag("transparent", true) && gdk_screen_is_composited(screen))
    if (GdkVisual *v = gdk_screen_get_rgba_visual(screen)) { // only with a compositor; black otherwise
      gtk_widget_set_visual(p->win, v);
      gtk_widget_set_app_paintable(p->win, TRUE);
      GdkRGBA clear{0, 0, 0, 0};
      webkit_web_view_set_background_color(p->wv, &clear);
    }
  gtk_container_add(GTK_CONTAINER(p->win), GTK_WIDGET(p->wv));
  gtk_widget_show(GTK_WIDGET(p->wv));
  gpointer nid = GINT_TO_POINTER(p->nativeId);
  g_signal_connect(p->win, "focus-in-event", G_CALLBACK(on_popover_focus_in), nid);
  g_signal_connect(p->win, "focus-out-event", G_CALLBACK(on_popover_focus_out), nid);
  g_signal_connect(p->win, "key-press-event", G_CALLBACK(on_popover_key), nid);
  g_signal_connect(p->win, "delete-event", G_CALLBACK(on_popover_delete), nid);
  gtk_widget_realize(p->win);
  if (c->flag("preload", true)) {
    p->loaded = true;
    webkit_web_view_load_uri(p->wv, url.c_str());
  }
  return p;
}

static void destroy_popover(Popover *p) {
  hide_popover(p);
  detach_webview(p->nativeId);
  if (g_tray_popover == p->id) g_tray_popover.clear();
  g_popovers.erase(p->id);
  gtk_widget_destroy(p->win);
  delete p;
}

static GdkRectangle workarea_at(int x, int y) {
  GdkRectangle wa{0, 0, 1920, 1080};
  GdkMonitor *m = monitor_at(x, y);
  if (!m) m = primary_monitor();
  if (m) gdk_monitor_get_workarea(m, &wa);
  return wa;
}

static void clamp(int *x, int *y, int w, int h) {
  GdkRectangle wa = workarea_at(*x + w / 2, *y + h / 2);
  *x = std::max(wa.x + 4, std::min(*x, wa.x + wa.width - w - 4));
  *y = std::max(wa.y, std::min(*y, wa.y + wa.height - h));
}

// Panel placement → top-left; "" on success.
static std::string panel_origin(Popover *p, const json &position, int *x, int *y) {
  if (position.is_object() && position.contains("x") && position.contains("y") && position["x"].is_number()) {
    *x = (int)position["x"].get<double>();
    *y = (int)position["y"].get<double>();
    return "";
  }
  std::string preset = position.is_string() ? position.get<std::string>() : "tray";
  // StatusNotifierItem hosts don't report the icon's position: tray presets
  // fall back to center (as on macOS when no tray item is placed).
  if (preset == "tray" || preset == "trayLeft" || preset == "trayRight") preset = "center";
  if (preset == "cursor") {
    int mx, my;
    pointer_position(&mx, &my);
    *x = mx - p->width / 2;
    *y = my + 8;
    clamp(x, y, p->width, p->height);
    return "";
  }
  if (preset == "center") { // Spotlight-ish: horizontally centered, upper third
    GdkMonitor *m = primary_monitor();
    GdkRectangle wa{0, 0, 1920, 1080};
    if (m) gdk_monitor_get_workarea(m, &wa);
    *x = wa.x + (wa.width - p->width) / 2;
    *y = wa.y + wa.height / 3 - p->height / 2;
    return "";
  }
  return "popover: unknown position `" + (position.is_string() ? preset : position.dump()) + "` (tray|trayLeft|trayRight|center|cursor|{x,y})";
}

// Anchor rect (root coordinates) for popover style; "" on success.
static std::string anchor_rect(Popover *p, const json &args, int caller, GdkRectangle *r) {
  json anchor = args.contains("anchor") && !args["anchor"].is_null() ? args["anchor"] : json("tray");
  if (anchor == "tray" || anchor == "cursor") {
    if (anchor == "tray" && !tray_is_set()) return "popover.show: anchor `tray` needs a tray item (tray.set)";
    int mx, my;
    pointer_position(&mx, &my); // tray: the indicator was just activated under the pointer
    *r = GdkRectangle{mx, my, 1, 1};
    return "";
  }
  if (anchor.is_object() && anchor.contains("screen") && anchor["screen"].is_object()) {
    json s = anchor["screen"];
    *r = GdkRectangle{(int)s.value("x", 0.0), (int)s.value("y", 0.0), std::max(1, (int)s.value("width", 1.0)), std::max(1, (int)s.value("height", 1.0))};
    return "";
  }
  if (anchor.is_object() && anchor.contains("x") && anchor.contains("y")) {
    // A rect in a window's page (CSS px): public windowId, else the calling page.
    WebKitWebView *wv = nullptr;
    if (anchor.contains("windowId")) {
      int wid = (int)anchor.value("windowId", 0.0);
      Window *w = find_window(wid == 0 ? primary_window() : wid);
      wv = w ? w->webview : nullptr;
    } else {
      wv = webview_for(caller);
      if (!wv) {
        Window *w = find_window(primary_window());
        wv = w ? w->webview : nullptr;
      }
    }
    if (!wv) return "popover.show: no window to anchor to";
    GtkWidget *top = gtk_widget_get_toplevel(GTK_WIDGET(wv));
    int ox = 0, oy = 0, tx = 0, ty = 0;
    if (GdkWindow *g = gtk_widget_get_window(top)) gdk_window_get_origin(g, &ox, &oy);
    gtk_widget_translate_coordinates(GTK_WIDGET(wv), top, 0, 0, &tx, &ty);
    double z = webkit_web_view_get_zoom_level(wv);
    *r = GdkRectangle{ox + tx + (int)(anchor.value("x", 0.0) * z), oy + ty + (int)(anchor.value("y", 0.0) * z),
                      std::max(1, (int)(anchor.value("width", 1.0) * z)), std::max(1, (int)(anchor.value("height", 1.0) * z))};
    return "";
  }
  return "popover.show: unknown anchor `" + anchor.dump() + "` (tray|cursor|{x,y,width,height[,windowId]}|{screen:{…}})";
}

static std::string show_now(Popover *p, const json &args, int caller) {
  int x = 0, y = 0;
  if (p->style == "panel") {
    json position = args.contains("position") && !args["position"].is_null() ? args["position"] : p->position;
    std::string e = panel_origin(p, position, &x, &y);
    if (!e.empty()) return e;
    if (args.contains("position")) p->position = args["position"];
  } else {
    GdkRectangle a{0, 0, 1, 1};
    std::string e = anchor_rect(p, args, caller, &a);
    if (!e.empty()) return e;
    switch (p->edge) {
    case 1: x = a.x + a.width / 2 - p->width / 2, y = a.y - p->height - 4; break;
    case 2: x = a.x - p->width - 4, y = a.y + a.height / 2 - p->height / 2; break;
    case 3: x = a.x + a.width + 4, y = a.y + a.height / 2 - p->height / 2; break;
    default: x = a.x + a.width / 2 - p->width / 2, y = a.y + a.height + 4;
    }
    clamp(&x, &y, p->width, p->height);
  }
  GtkWindow *w = GTK_WINDOW(p->win);
  gtk_window_resize(w, p->width, p->height);
  gtk_window_move(w, x, y);
  gtk_widget_show(p->win);
  if (p->activate) gtk_window_present(w);
  gtk_widget_grab_focus(GTK_WIDGET(p->wv));
  p->shown = true;
  p->hadFocus = gtk_window_is_active(w);
  emit("popoverShown", json{{"id", p->id}});
  return "";
}

// Lazy popovers load on first show and present once their page is ready (≤1.5 s).
static std::string show_popover(Popover *p, const json &args, int caller) {
  if (p->loaded) return show_now(p, args, caller);
  p->loaded = true;
  webkit_web_view_load_uri(p->wv, p->url.c_str());
  std::string id = p->id;
  auto fire = [id, args, caller] {
    auto it = g_popovers.find(id);
    if (it == g_popovers.end() || !it->second->pendingShow) return;
    it->second->pendingShow = nullptr;
    std::string e = show_now(it->second, args, caller);
    if (!e.empty()) g_warning("[shell] popover %s: %s", id.c_str(), e.c_str());
  };
  p->pendingShow = fire;
  auto *f = new std::function<void()>(fire);
  g_timeout_add_full(G_PRIORITY_DEFAULT, 1500, [](gpointer d) -> gboolean {
    (*static_cast<std::function<void()> *>(d))();
    return G_SOURCE_REMOVE;
  }, f, [](gpointer d) { delete static_cast<std::function<void()> *>(d); });
  return "";
}

bool popover_page_ready(int nativeId) {
  Popover *p = find_native(nativeId);
  if (!p) return false;
  p->ready = true;
  emit("popoverReady", json{{"id", p->id}});
  if (p->pendingShow) {
    auto f = p->pendingShow;
    f();
  }
  return true;
}

void tray_bind_popover(const std::string &id) { g_tray_popover = id; }

bool popover_tray_click() {
  auto it = g_popovers.find(g_tray_popover);
  if (g_tray_popover.empty() || it == g_popovers.end()) return false;
  Popover *p = it->second;
  if (p->shown) hide_popover(p);
  else {
    std::string e = show_popover(p, json{{"anchor", "tray"}}, 0);
    if (!e.empty()) g_warning("[shell] tray popover: %s", e.c_str());
  }
  return true;
}

using PopoverOp = std::function<void(CallPtr, Popover *)>;
static void pop(const std::string &name, PopoverOp body) {
  reg("popover", name, [name, body](CallPtr c) {
    std::string ident = c->has("id") ? c->str("id") : popover_ident(c->caller); // inside a popover page: itself
    auto it = g_popovers.find(ident);
    if (ident.empty() || it == g_popovers.end()) return c->fail("invalid_args", "popover." + name + ": unknown popover `" + ident + "`");
    body(c, it->second);
  });
}

static void register_popover() {
  reg("popover", "create", [](CallPtr c) {
    std::string ident = c->has("id") ? c->str("id") : "popover-" + std::to_string(g_next_native);
    auto old = g_popovers.find(ident);
    if (old != g_popovers.end()) destroy_popover(old->second); // re-create replaces
    std::string error;
    Popover *p = build(c, ident, &error);
    if (!p) return c->fail("unavailable", error);
    g_popovers[ident] = p;
    if (c->flag("tray", false)) tray_bind_popover(ident);
    c->ok(describe(p));
  });
  pop("show", [](CallPtr c, Popover *p) {
    std::string e = show_popover(p, c->args, c->caller);
    if (!e.empty()) return c->fail("invalid_args", e);
    c->ok(describe(p));
  });
  pop("hide", [](CallPtr c, Popover *p) {
    hide_popover(p);
    c->ok();
  });
  pop("toggle", [](CallPtr c, Popover *p) {
    if (p->shown) {
      hide_popover(p);
      return c->ok(json{{"shown", false}});
    }
    std::string e = show_popover(p, c->args, c->caller);
    if (!e.empty()) return c->fail("invalid_args", e);
    c->ok(json{{"shown", true}});
  });
  pop("setSize", [](CallPtr c, Popover *p) {
    p->width = std::max(40, (int)c->num("width", p->width));
    p->height = std::max(24, (int)c->num("height", p->height));
    gtk_window_resize(GTK_WINDOW(p->win), p->width, p->height);
    emit("popoverResized", json{{"id", p->id}, {"width", p->width}, {"height", p->height}});
    c->ok();
  });
  pop("setPosition", [](CallPtr c, Popover *p) {
    if (p->style != "panel") return c->fail("unsupported", "popover.setPosition: only for style `panel` (popovers follow their anchor)");
    json position = c->has("position") ? c->args["position"] : c->has("x") ? json{{"x", c->args["x"]}, {"y", c->args["y"]}} : json();
    int x, y;
    std::string e = panel_origin(p, position, &x, &y);
    if (!e.empty()) return c->fail("invalid_args", e);
    p->position = position;
    gtk_window_move(GTK_WINDOW(p->win), x, y);
    c->ok();
  });
  pop("isShown", [](CallPtr c, Popover *p) { c->ok(p->shown); });
  pop("get", [](CallPtr c, Popover *p) { c->ok(describe(p)); });
  pop("eval", [](CallPtr c, Popover *p) {
    if (!c->has("js")) return c->fail("invalid_args", "popover.eval: `js` is required");
    std::string js = c->str("js");
    webkit_web_view_evaluate_javascript(p->wv, js.c_str(), (gssize)js.size(), nullptr, nullptr, nullptr, nullptr, nullptr);
    c->ok();
  });
  pop("reload", [](CallPtr c, Popover *p) {
    webkit_web_view_reload(p->wv);
    c->ok();
  });
  pop("destroy", [](CallPtr c, Popover *p) {
    destroy_popover(p);
    c->ok(json{{"destroyed", true}});
  });
  reg("popover", "list", [](CallPtr c) {
    json out = json::array();
    for (auto &[_, p] : g_popovers) out.push_back(describe(p));
    c->ok(out);
  });
  // Page-to-page messages (popover ↔ windows): every page + the Worker.
  reg("events", "emit", [](CallPtr c) {
    std::string channel = c->str("channel");
    if (channel.empty()) return c->fail("invalid_args", "events.emit: `channel` is required");
    std::string pid = popover_ident(c->caller);
    emit("message", json{{"channel", channel}, {"data", c->args.value("data", json())}, {"from", pid.empty() ? json(public_id(c->caller)) : json(pid)}});
    c->ok();
  });
}

// ===========================================================================
// webview.*

struct Target {
  WebKitWebView *wv = nullptr;
  json source; // {windowId} | {popoverId}
};

static bool resolve_target(CallPtr c, Target *t) {
  if (c->has("popoverId")) {
    auto it = g_popovers.find(c->str("popoverId"));
    if (it == g_popovers.end()) {
      c->fail("invalid_args", "webview." + c->op + ": unknown popover `" + c->str("popoverId") + "`");
      return false;
    }
    *t = Target{it->second->wv, json{{"popoverId", it->first}}};
    return true;
  }
  if (!c->has("windowId") && c->caller && !find_window(c->caller))
    if (Popover *p = find_native(c->caller)) {
      *t = Target{p->wv, json{{"popoverId", p->id}}};
      return true;
    }
  Window *w = find_window(resolve_window(*c));
  if (!w) {
    c->fail("invalid_args", "webview." + c->op + ": no such window");
    return false;
  }
  *t = Target{w->webview, json{{"windowId", public_id(w->id)}}};
  return true;
}

using ViewOp = std::function<void(CallPtr, Target &)>;
static void view(const std::string &name, ViewOp body) {
  reg("webview", name, [body](CallPtr c) {
    Target t;
    if (resolve_target(c, &t)) body(c, t);
  });
}

static void capture(CallPtr c, Target &t) {
  struct Ctx {
    CallPtr c;
    WebKitWebView *wv;
  };
  g_object_ref(t.wv);
  webkit_web_view_get_snapshot(t.wv, WEBKIT_SNAPSHOT_REGION_VISIBLE, WEBKIT_SNAPSHOT_OPTIONS_NONE, nullptr, [](GObject *src, GAsyncResult *res, gpointer data) {
    auto *x = static_cast<Ctx *>(data);
    CallPtr c = x->c;
    GError *err = nullptr;
    cairo_surface_t *surface = webkit_web_view_get_snapshot_finish(WEBKIT_WEB_VIEW(src), res, &err);
    if (!surface) {
      c->fail("internal", std::string("webview.capturePage: ") + (err ? err->message : "no image"));
      if (err) g_error_free(err);
      g_object_unref(x->wv);
      delete x;
      return;
    }
    int sw = cairo_image_surface_get_width(surface), sh = cairo_image_surface_get_height(surface);
    int vw = std::max(1, gtk_widget_get_allocated_width(GTK_WIDGET(x->wv)));
    double scale = (double)sw / vw * webkit_web_view_get_zoom_level(x->wv); // CSS px → surface px
    int rx = 0, ry = 0, rw = sw, rh = sh;
    if (c->args.contains("rect") && c->args["rect"].is_object()) {
      json r = c->args["rect"];
      rx = std::max(0, (int)std::lround(r.value("x", 0.0) * scale));
      ry = std::max(0, (int)std::lround(r.value("y", 0.0) * scale));
      rw = std::min(sw - rx, (int)std::lround(r.value("width", (double)sw) * scale));
      rh = std::min(sh - ry, (int)std::lround(r.value("height", (double)sh) * scale));
    }
    GdkPixbuf *pb = rw > 0 && rh > 0 ? gdk_pixbuf_get_from_surface(surface, rx, ry, rw, rh) : nullptr;
    cairo_surface_destroy(surface);
    if (pb && c->has("width") && c->num("width", 0) > 0) {
      int w = (int)c->num("width", rw), h = std::max(1, (int)std::lround((double)rh * w / rw));
      GdkPixbuf *scaled = gdk_pixbuf_scale_simple(pb, w, h, GDK_INTERP_BILINEAR);
      g_object_unref(pb);
      pb = scaled;
    }
    if (!pb) {
      c->fail("invalid_args", "webview.capturePage: empty capture rect");
    } else {
      bool jpeg = c->str("format") == "jpeg";
      gchar *buf = nullptr;
      gsize len = 0;
      std::string q = std::to_string((int)std::lround(std::max(0.0, std::min(1.0, c->num("quality", 0.85))) * 100));
      bool ok = jpeg ? gdk_pixbuf_save_to_buffer(pb, &buf, &len, "jpeg", nullptr, "quality", q.c_str(), nullptr)
                     : gdk_pixbuf_save_to_buffer(pb, &buf, &len, "png", nullptr, nullptr);
      if (ok) c->ok(json{{"data", base64_encode((const unsigned char *)buf, len)}, {"format", jpeg ? "jpeg" : "png"},
                         {"width", gdk_pixbuf_get_width(pb)}, {"height", gdk_pixbuf_get_height(pb)}});
      else c->fail("internal", "webview.capturePage: encoding failed");
      g_free(buf);
      g_object_unref(pb);
    }
    g_object_unref(x->wv);
    delete x;
  }, new Ctx{c, t.wv});
}

void register_webview() {
  register_popover();
  view("setZoom", [](CallPtr c, Target &t) {
    double z = c->num("zoom", NAN);
    if (!(z > 0)) return c->fail("invalid_args", "webview.setZoom: `zoom` must be a positive number (1 = 100%)");
    webkit_web_view_set_zoom_level(t.wv, std::min(5.0, std::max(0.25, z)));
    c->ok(json{{"zoom", webkit_web_view_get_zoom_level(t.wv)}});
  });
  view("getZoom", [](CallPtr c, Target &t) { c->ok(json{{"zoom", webkit_web_view_get_zoom_level(t.wv)}}); });
  view("reload", [](CallPtr c, Target &t) {
    c->flag("ignoreCache", false) ? webkit_web_view_reload_bypass_cache(t.wv) : webkit_web_view_reload(t.wv);
    c->ok();
  });
  view("stop", [](CallPtr c, Target &t) {
    webkit_web_view_stop_loading(t.wv);
    c->ok();
  });
  view("goBack", [](CallPtr c, Target &t) {
    bool can = webkit_web_view_can_go_back(t.wv);
    if (can) webkit_web_view_go_back(t.wv);
    c->ok(json{{"navigated", can}});
  });
  view("goForward", [](CallPtr c, Target &t) {
    bool can = webkit_web_view_can_go_forward(t.wv);
    if (can) webkit_web_view_go_forward(t.wv);
    c->ok(json{{"navigated", can}});
  });
  view("getInfo", [](CallPtr c, Target &t) {
    WebKitSettings *s = webkit_web_view_get_settings(t.wv);
    const char *uri = webkit_web_view_get_uri(t.wv), *title = webkit_web_view_get_title(t.wv);
    json d = t.source;
    const char *ua = webkit_settings_get_user_agent(s);
    d.update(json{{"url", uri ? json(uri) : json(nullptr)}, {"title", title ? title : ""}, {"loading", (bool)webkit_web_view_is_loading(t.wv)},
                  {"canGoBack", (bool)webkit_web_view_can_go_back(t.wv)}, {"canGoForward", (bool)webkit_web_view_can_go_forward(t.wv)},
                  {"zoom", webkit_web_view_get_zoom_level(t.wv)}, {"userAgent", ua ? json(ua) : json(nullptr)},
                  {"debug", (bool)webkit_settings_get_enable_developer_extras(s)}, {"fileDrop", false}, {"contextMenu", "default"},
                  {"inspectable", (bool)webkit_settings_get_enable_developer_extras(s)}});
    c->ok(d);
  });
  view("setUserAgent", [](CallPtr c, Target &t) {
    std::string ua = c->str("userAgent");
    webkit_settings_set_user_agent(webkit_web_view_get_settings(t.wv), ua.empty() ? nullptr : ua.c_str()); // NULL → WebKit's default
    c->ok();
  });
  view("getUserAgent", [](CallPtr c, Target &t) {
    const char *ua = webkit_settings_get_user_agent(webkit_web_view_get_settings(t.wv));
    c->ok(ua ? json(ua) : json(nullptr));
  });
  view("setInspectable", [](CallPtr c, Target &t) {
    bool on = c->flag("enabled", true);
    webkit_settings_set_enable_developer_extras(webkit_web_view_get_settings(t.wv), on);
    c->ok(json{{"inspectable", on}});
  });
  view("executeJavaScript", [](CallPtr c, Target &t) {
    if (!c->args.contains("code") || !c->args["code"].is_string()) return c->fail("invalid_args", "webview.executeJavaScript: `code` is required");
    execute_js(t.wv, c->str("code"), c);
  });
  view("capturePage", capture);
  // Internal test hook: {action:"terminate"} kills the web process (crash recovery test).
  view("_test", [](CallPtr c, Target &t) {
    if (c->str("action") != "terminate") return c->fail("invalid_args", "webview._test: unknown action");
    webkit_web_view_terminate_web_process(t.wv);
    c->ok(true);
  });
  auto opened = [](CallPtr c) { c->ok(json{{"paths", json::array()}}); }; // no document-open handoff on Linux yet
  reg("webview", "getOpenedFiles", opened);
  reg("app", "getOpenedFiles", opened);
}

} // namespace lx
} // namespace sd
