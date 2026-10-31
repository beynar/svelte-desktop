// view.* — extra web views embedded in a window (Electron's BrowserView), same ops
// and events as native/platform_view.mm:
//   create {id?, windowId?, url|route, bounds:{x,y,width,height}, autoresize?, transparent?, debug?} → {id, windowId}
//   setBounds {id, x, y, width, height} · getBounds · navigate {id, url|route} · show · hide · reload
//   getInfo · executeJavaScript {id, code} → JSON · list · destroy
// Bounds are CSS px from the top-left of the window's page area. `autoresize`:
// "width" | "height" | "both" | "none" (default) — follow window resizes, keeping
// the right / bottom margins.
// Events: viewLoaded {id, url}, viewNavigated {id, url}, viewFailed {id, error}, viewTitle {id, title}.
// Any origin may load (it's a browser view); the platform bridge only answers the
// app origin's top frame, so third-party content can't call native. Views live in
// the window's GtkOverlay, above the page.
#include <map>

#include "linux.hpp"

namespace sd {
namespace lx {

struct View {
  std::string ident;
  int nativeId = 0;
  int window = 0; // native window id
  WebKitWebView *wv = nullptr;
  std::string autoresize = "none";
  int x = 0, y = 0, w = 0, h = 0;
  int right = 0, bottom = 0; // margins kept by autoresize
  gulong sizeHandler = 0;
};

static std::map<std::string, View *> g_views;
static int g_next_view = 2000;

static std::string url_from(const CallPtr &c) {
  std::string u = c->str("url");
  if (!u.empty()) return u;
  std::string route = c->str("route"), origin = app_origin();
  if (route.empty() || origin.empty()) return "";
  return origin + (route[0] == '/' ? route : "/" + route);
}

static void place(View *v) {
  GtkWidget *wid = GTK_WIDGET(v->wv);
  gtk_widget_set_margin_start(wid, v->x);
  gtk_widget_set_margin_top(wid, v->y);
  gtk_widget_set_size_request(wid, std::max(1, v->w), std::max(1, v->h));
}

static void on_overlay_size(GtkWidget *, GdkRectangle *alloc, gpointer data) {
  auto it = g_views.find(static_cast<const char *>(data));
  if (it == g_views.end()) return;
  View *v = it->second;
  bool width = v->autoresize == "width" || v->autoresize == "both", height = v->autoresize == "height" || v->autoresize == "both";
  int nw = width ? alloc->width - v->x - v->right : v->w, nh = height ? alloc->height - v->y - v->bottom : v->h;
  if (nw != v->w || nh != v->h) {
    v->w = std::max(1, nw);
    v->h = std::max(1, nh);
    place(v);
  }
}

static gboolean on_view_policy(WebKitWebView *, WebKitPolicyDecision *d, WebKitPolicyDecisionType type, gpointer) {
  if (type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
    // target=_blank / window.open → the default browser.
    WebKitNavigationAction *a = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(d));
    const char *uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(a));
    std::string u = uri ? uri : "";
    if (u.rfind("http", 0) == 0 || u.rfind("mailto:", 0) == 0) {
      const char *argv[] = {"xdg-open", u.c_str(), nullptr};
      g_spawn_async(nullptr, (char **)argv, nullptr, G_SPAWN_SEARCH_PATH, nullptr, nullptr, nullptr, nullptr);
    }
    webkit_policy_decision_ignore(d);
    return TRUE;
  }
  if (type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) {
    WebKitNavigationAction *a = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(d));
    const char *uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(a));
    std::string u = uri ? uri : "";
    bool ok = u.rfind("http:", 0) == 0 || u.rfind("https:", 0) == 0 || u.rfind("about:", 0) == 0 || u.rfind("data:", 0) == 0 || u.rfind("blob:", 0) == 0;
    if (!ok) {
      webkit_policy_decision_ignore(d);
      return TRUE;
    }
  }
  return FALSE;
}

static void on_view_load(WebKitWebView *wv, WebKitLoadEvent ev, gpointer data) {
  auto it = g_views.find(static_cast<const char *>(data));
  if (it == g_views.end()) return;
  const char *uri = webkit_web_view_get_uri(wv);
  if (ev == WEBKIT_LOAD_COMMITTED) {
    page_committed(it->second->nativeId, uri);
    emit("viewNavigated", json{{"id", it->second->ident}, {"url", uri ? uri : ""}});
  } else if (ev == WEBKIT_LOAD_FINISHED) {
    emit("viewLoaded", json{{"id", it->second->ident}, {"url", uri ? uri : ""}});
  }
}

static gboolean on_view_failed(WebKitWebView *, WebKitLoadEvent, gchar *, GError *err, gpointer data) {
  auto it = g_views.find(static_cast<const char *>(data));
  if (it != g_views.end() && !(err && err->domain == WEBKIT_POLICY_ERROR))
    emit("viewFailed", json{{"id", it->second->ident}, {"error", err ? err->message : "load failed"}});
  return FALSE;
}

static void on_view_title(GObject *obj, GParamSpec *, gpointer data) {
  auto it = g_views.find(static_cast<const char *>(data));
  const char *title = webkit_web_view_get_title(WEBKIT_WEB_VIEW(obj));
  if (it != g_views.end()) emit("viewTitle", json{{"id", it->second->ident}, {"title", title ? title : ""}});
}

static void destroy_view(View *v) {
  if (Window *w = find_window(v->window); w && v->sizeHandler) g_signal_handler_disconnect(w->overlay, v->sizeHandler);
  detach_webview(v->nativeId);
  if (v->wv) {
    g_signal_handlers_disconnect_matched(v->wv, G_SIGNAL_MATCH_DATA, 0, 0, nullptr, nullptr, (gpointer)v->ident.c_str());
    webkit_web_view_stop_loading(v->wv);
    if (find_window(v->window)) gtk_widget_destroy(GTK_WIDGET(v->wv));
  }
  g_views.erase(v->ident);
  delete v;
}

using ViewOp = std::function<void(CallPtr, View *)>;
static void op(const std::string &name, ViewOp body) {
  reg("view", name, [name, body](CallPtr c) {
    auto it = g_views.find(c->str("id"));
    if (it == g_views.end()) return c->fail("invalid_args", "view." + name + ": unknown view `" + c->str("id") + "`");
    if (!find_window(it->second->window)) {
      destroy_view(it->second);
      return c->fail("invalid_args", "view: its window is closed");
    }
    body(c, it->second);
  });
}

void register_view() {
  reg("view", "create", [](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    if (!w) return c->fail("invalid_args", "view.create: no such window");
    if (!c->args.contains("bounds") || !c->args["bounds"].is_object()) return c->fail("invalid_args", "view.create: `bounds` {x,y,width,height} is required");
    std::string url = url_from(c);
    if (url.empty()) return c->fail("invalid_args", "view.create: `url` or `route` is required");
    std::string ident = c->str("id", "view-" + std::to_string(g_next_view));
    if (auto old = g_views.find(ident); old != g_views.end()) destroy_view(old->second);
    const json &b = c->args["bounds"];
    auto *v = new View;
    v->ident = ident;
    v->nativeId = g_next_view++;
    v->window = w->id;
    v->autoresize = c->str("autoresize", "none");
    v->x = b.value("x", 0), v->y = b.value("y", 0), v->w = b.value("width", 300), v->h = b.value("height", 200);
    GtkAllocation alloc;
    gtk_widget_get_allocation(w->overlay, &alloc);
    v->right = std::max(0, alloc.width - v->x - v->w);
    v->bottom = std::max(0, alloc.height - v->y - v->h);
    g_views[ident] = v;
    // The shell's web view (bridge, origin tracking), with browser-style navigation.
    v->wv = make_webview(v->nativeId, c->flag("debug", false), "");
    g_signal_handlers_disconnect_matched(v->wv, G_SIGNAL_MATCH_DATA, 0, 0, nullptr, nullptr, GINT_TO_POINTER(v->nativeId));
    gpointer key = (gpointer)v->ident.c_str();
    g_signal_connect(v->wv, "decide-policy", G_CALLBACK(on_view_policy), key);
    g_signal_connect(v->wv, "load-changed", G_CALLBACK(on_view_load), key);
    g_signal_connect(v->wv, "load-failed", G_CALLBACK(on_view_failed), key);
    g_signal_connect(v->wv, "notify::title", G_CALLBACK(on_view_title), key);
    if (c->flag("transparent", false)) {
      GdkRGBA clear{0, 0, 0, 0};
      webkit_web_view_set_background_color(v->wv, &clear);
    }
    GtkWidget *wid = GTK_WIDGET(v->wv);
    gtk_widget_set_halign(wid, GTK_ALIGN_START);
    gtk_widget_set_valign(wid, GTK_ALIGN_START);
    place(v);
    gtk_overlay_add_overlay(GTK_OVERLAY(w->overlay), wid);
    gtk_widget_show(wid);
    if (v->autoresize != "none") v->sizeHandler = g_signal_connect(w->overlay, "size-allocate", G_CALLBACK(on_overlay_size), key);
    webkit_web_view_load_uri(v->wv, url.c_str());
    c->ok(json{{"id", ident}, {"windowId", public_id(w->id)}});
  });
  op("setBounds", [](CallPtr c, View *v) {
    v->x = (int)c->num("x", v->x), v->y = (int)c->num("y", v->y), v->w = (int)c->num("width", v->w), v->h = (int)c->num("height", v->h);
    if (Window *w = find_window(v->window)) {
      GtkAllocation alloc;
      gtk_widget_get_allocation(w->overlay, &alloc);
      v->right = std::max(0, alloc.width - v->x - v->w);
      v->bottom = std::max(0, alloc.height - v->y - v->h);
    }
    place(v);
    c->ok();
  });
  op("getBounds", [](CallPtr c, View *v) { c->ok(json{{"x", v->x}, {"y", v->y}, {"width", v->w}, {"height", v->h}}); });
  op("navigate", [](CallPtr c, View *v) {
    std::string url = url_from(c);
    if (url.empty()) return c->fail("invalid_args", "view.navigate: `url` or `route` is required");
    webkit_web_view_load_uri(v->wv, url.c_str());
    c->ok();
  });
  op("show", [](CallPtr c, View *v) {
    gtk_widget_show(GTK_WIDGET(v->wv));
    c->ok();
  });
  op("hide", [](CallPtr c, View *v) {
    gtk_widget_hide(GTK_WIDGET(v->wv));
    c->ok();
  });
  op("reload", [](CallPtr c, View *v) {
    webkit_web_view_reload(v->wv);
    c->ok();
  });
  op("getInfo", [](CallPtr c, View *v) {
    const char *uri = webkit_web_view_get_uri(v->wv), *title = webkit_web_view_get_title(v->wv);
    c->ok(json{{"id", v->ident}, {"url", uri ? json(uri) : json(nullptr)}, {"title", title ? title : ""},
               {"loading", (bool)webkit_web_view_is_loading(v->wv)}, {"hidden", !gtk_widget_get_visible(GTK_WIDGET(v->wv))}});
  });
  op("executeJavaScript", [](CallPtr c, View *v) {
    if (!c->has("code")) return c->fail("invalid_args", "view.executeJavaScript: `code` is required");
    execute_js(v->wv, c->str("code"), c);
  });
  op("destroy", [](CallPtr c, View *v) {
    destroy_view(v);
    c->ok(json{{"destroyed", true}});
  });
  reg("view", "list", [](CallPtr c) {
    json out = json::array();
    for (auto it = g_views.begin(); it != g_views.end();) {
      View *v = (it++)->second;
      if (!find_window(v->window)) {
        destroy_view(v);
        continue;
      }
      const char *uri = webkit_web_view_get_uri(v->wv);
      out.push_back(json{{"id", v->ident}, {"windowId", public_id(v->window)}, {"url", uri ? json(uri) : json(nullptr)}});
    }
    c->ok(out);
  });
}

} // namespace lx
} // namespace sd
