// window.* — the common subset of the window contract on GTK 3.
// Coordinates: root window (top-left origin, y down), the same convention as
// the macOS backend. Bounds/position are the window-manager frame; size is the
// client area. `windowId` is the public id (0 = primary); absent → the calling
// page's window, the active window, the primary window.
// Events (shell_linux.cc): focusChanged, boundsChanged, scaleFactorChanged,
// willClose, closed, created.
//
// X11 is asynchronous: geometry and state requests are acknowledged by the window
// manager later, so those ops reply once the new state is observed (or after
// 800 ms if the WM refuses), and a getter right after a setter sees the result.
#include <cmath>

#include "linux.hpp"

namespace sd {
namespace lx {

using WindowOp = std::function<void(CallPtr, Window *)>;

static void op(const std::string &name, WindowOp body) {
  reg("window", name, [name, body](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    if (!w) return c->fail("invalid_args", "window." + name + ": no such window");
    body(c, w);
  });
}

static bool near(int a, int b) { return std::abs(a - b) <= 2; }

/// Reply `value` once `done(w)` holds (polled on the main loop) or after a timeout.
static void settle(CallPtr c, int id, std::function<bool(Window *)> done, std::function<json(Window *)> value, int timeout_ms = 800) {
  struct S {
    CallPtr c;
    int id;
    std::function<bool(Window *)> done;
    std::function<json(Window *)> value;
    gint64 deadline;
  };
  auto *s = new S{c, id, std::move(done), std::move(value), g_get_monotonic_time() + timeout_ms * 1000};
  g_timeout_add_full(
      G_PRIORITY_DEFAULT, 10,
      [](gpointer d) -> gboolean {
        auto *s = static_cast<S *>(d);
        Window *w = find_window(s->id);
        if (!w) {
          s->c->ok();
          return G_SOURCE_REMOVE;
        }
        if (s->done(w) || g_get_monotonic_time() > s->deadline) {
          s->c->ok(s->value(w));
          return G_SOURCE_REMOVE;
        }
        return G_SOURCE_CONTINUE;
      },
      s, [](gpointer d) { delete static_cast<S *>(d); });
}

static bool has_state(Window *w, int bit) { return (w->state & bit) != 0; }

static std::string state_name(Window *w) {
  if (has_state(w, GDK_WINDOW_STATE_FULLSCREEN)) return "fullscreen";
  if (has_state(w, GDK_WINDOW_STATE_MAXIMIZED)) return "maximized";
  return "normal";
}

static json bounds_json(Window *w) {
  GdkRectangle f = frame_rect(w);
  return rect_json(f.x, f.y, f.width, f.height);
}

static json info_row(int id) {
  Window *w = find_window(id);
  return json{{"windowId", public_id(id)}, {"label", w->label}, {"focused", (bool)gtk_window_is_active(GTK_WINDOW(w->window))}, {"visible", (bool)gtk_widget_get_visible(w->window)}, {"bounds", bounds_json(w)}};
}

/// Decoration size (frame − client area); 0 before the window is mapped.
static void decoration(Window *w, int *dw, int *dh) {
  GdkRectangle f = frame_rect(w);
  int cw = 0, ch = 0;
  gtk_window_get_size(GTK_WINDOW(w->window), &cw, &ch);
  *dw = gtk_widget_get_mapped(w->window) ? std::max(0, f.width - cw) : 0;
  *dh = gtk_widget_get_mapped(w->window) ? std::max(0, f.height - ch) : 0;
}

static void move_frame(Window *w, int x, int y) { gtk_window_move(GTK_WINDOW(w->window), x, y); }

static GdkRectangle workarea_of(Window *w) {
  GdkRectangle f = frame_rect(w), wa{0, 0, 0, 0};
  GdkMonitor *m = monitor_at(f.x + f.width / 2, f.y + f.height / 2);
  if (!m) m = primary_monitor();
  if (m) gdk_monitor_get_workarea(m, &wa);
  return wa;
}

static void set_state_flag(CallPtr c, Window *w, bool on, int bit, std::function<void()> apply, const char *key) {
  apply();
  bool want = on;
  settle(c, w->id, [bit, want](Window *x) { return has_state(x, bit) == want; },
         [bit, key](Window *x) { return json{{key, has_state(x, bit)}}; });
}

void register_window() {
  // ── multi-window ──────────────────────────────────────────────────────
  reg("window", "create", [](CallPtr c) {
    int id = create_window_from_platform(c->args);
    if (id == -4) return c->fail("invalid_args", "window.create: label `" + c->str("label") + "` is already used");
    if (id <= 0) return c->fail("internal", "window.create failed");
    Window *w = find_window(id);
    if (c->has("opacity")) gtk_widget_set_opacity(w->window, c->num("opacity", 1));
    c->ok(json{{"windowId", public_id(id)}, {"label", w->label}});
  });
  reg("window", "list", [](CallPtr c) {
    json rows = json::array();
    for (int id : window_ids()) rows.push_back(info_row(id));
    c->ok(rows);
  });
  reg("window", "get", [](CallPtr c) {
    std::string label = c->str("label");
    for (int id : window_ids())
      if (find_window(id)->label == label) return c->ok(info_row(id));
    c->ok(nullptr);
  });

  // ── geometry ──────────────────────────────────────────────────────────
  // The calling page's own window (or windowId's): {windowId, label, focused, visible, bounds}.
  op("getInfo", [](CallPtr c, Window *w) { c->ok(info_row(w->id)); });
  op("getBounds", [](CallPtr c, Window *w) { c->ok(json{{"bounds", bounds_json(w)}, {"state", state_name(w)}}); });
  op("setBounds", [](CallPtr c, Window *w) {
    GdkRectangle f = frame_rect(w);
    int x = (int)c->num("x", f.x), y = (int)c->num("y", f.y), width = (int)c->num("width", f.width), height = (int)c->num("height", f.height);
    int dw, dh;
    decoration(w, &dw, &dh);
    gtk_window_resize(GTK_WINDOW(w->window), std::max(1, width - dw), std::max(1, height - dh));
    move_frame(w, x, y);
    settle(c, w->id, [=](Window *x2) {
      GdkRectangle r = frame_rect(x2);
      return near(r.x, x) && near(r.y, y) && near(r.width, width) && near(r.height, height);
    }, [](Window *) { return json(nullptr); });
  });
  auto size = [](CallPtr c, Window *w) {
    int cw = 0, ch = 0;
    gtk_window_get_size(GTK_WINDOW(w->window), &cw, &ch);
    c->ok(json{{"width", cw}, {"height", ch}});
  };
  op("getSize", size);
  op("getContentSize", size);
  op("innerSize", size);
  op("outerSize", [](CallPtr c, Window *w) {
    GdkRectangle f = frame_rect(w);
    c->ok(json{{"width", f.width}, {"height", f.height}});
  });
  op("setSize", [](CallPtr c, Window *w) {
    int cw = 0, ch = 0;
    gtk_window_get_size(GTK_WINDOW(w->window), &cw, &ch);
    int width = std::max(1, (int)c->num("width", cw)), height = std::max(1, (int)c->num("height", ch));
    gtk_window_resize(GTK_WINDOW(w->window), width, height);
    settle(c, w->id, [=](Window *x) {
      int a, b;
      gtk_window_get_size(GTK_WINDOW(x->window), &a, &b);
      return near(a, width) && near(b, height);
    }, [](Window *) { return json(nullptr); });
  });
  auto pos = [](CallPtr c, Window *w) {
    GdkRectangle f = frame_rect(w);
    c->ok(json{{"x", f.x}, {"y", f.y}});
  };
  op("getPosition", pos);
  op("outerPosition", pos);
  op("innerPosition", [](CallPtr c, Window *w) {
    GdkRectangle r = content_rect(w);
    c->ok(json{{"x", r.x}, {"y", r.y}});
  });
  op("setPosition", [](CallPtr c, Window *w) {
    GdkRectangle f = frame_rect(w);
    int x = (int)c->num("x", f.x), y = (int)c->num("y", f.y);
    move_frame(w, x, y);
    settle(c, w->id, [=](Window *x2) {
      GdkRectangle r = frame_rect(x2);
      return near(r.x, x) && near(r.y, y);
    }, [](Window *) { return json(nullptr); });
  });
  auto center = [](Window *w) {
    GdkRectangle f = frame_rect(w), wa = workarea_of(w);
    int x = wa.x + (wa.width - f.width) / 2, y = wa.y + (wa.height - f.height) / 2;
    move_frame(w, x, y);
    return std::make_pair(x, y);
  };
  op("center", [center](CallPtr c, Window *w) {
    auto [x, y] = center(w);
    settle(c, w->id, [x = x, y = y](Window *w2) {
      GdkRectangle r = frame_rect(w2);
      return near(r.x, x) && near(r.y, y);
    }, [](Window *) { return json(nullptr); });
  });
  op("positionTo", [center](CallPtr c, Window *w) {
    std::string preset = c->str("preset");
    GdkRectangle f = frame_rect(w);
    int mx, my;
    pointer_position(&mx, &my);
    if (preset == "center") center(w);
    else if (preset == "cursorTopLeft") move_frame(w, mx, my);
    else if (preset == "cursorBottomLeft") move_frame(w, mx, my - f.height);
    else if (preset.rfind("tray", 0) == 0)
      return c->fail("unavailable", "window.positionTo: the tray item's position isn't exposed on Linux (StatusNotifierItem)");
    else return c->fail("invalid_args", "window.positionTo: unknown preset `" + preset + "`");
    c->ok();
  });
  op("setMinSize", [](CallPtr c, Window *w) {
    w->minW = (int)c->num("width", 0);
    w->minH = (int)c->num("height", 0);
    GdkGeometry g{};
    int mask = 0;
    if (w->minW || w->minH) g.min_width = std::max(1, w->minW), g.min_height = std::max(1, w->minH), mask |= GDK_HINT_MIN_SIZE;
    if (w->maxW || w->maxH) g.max_width = w->maxW ? w->maxW : G_MAXINT16, g.max_height = w->maxH ? w->maxH : G_MAXINT16, mask |= GDK_HINT_MAX_SIZE;
    gtk_window_set_geometry_hints(GTK_WINDOW(w->window), nullptr, mask ? &g : nullptr, (GdkWindowHints)mask);
    c->ok();
  });
  op("setMaxSize", [](CallPtr c, Window *w) {
    w->maxW = (int)c->num("width", 0);
    w->maxH = (int)c->num("height", 0);
    GdkGeometry g{};
    int mask = 0;
    if (w->minW || w->minH) g.min_width = std::max(1, w->minW), g.min_height = std::max(1, w->minH), mask |= GDK_HINT_MIN_SIZE;
    if (w->maxW || w->maxH) g.max_width = w->maxW ? w->maxW : G_MAXINT16, g.max_height = w->maxH ? w->maxH : G_MAXINT16, mask |= GDK_HINT_MAX_SIZE;
    gtk_window_set_geometry_hints(GTK_WINDOW(w->window), nullptr, mask ? &g : nullptr, (GdkWindowHints)mask);
    c->ok();
  });
  op("getScaleFactor", [](CallPtr c, Window *w) { c->ok(gtk_widget_get_scale_factor(w->window)); });
  op("getCursorPoint", [](CallPtr c, Window *w) {
    int mx, my;
    pointer_position(&mx, &my);
    GdkRectangle r = content_rect(w);
    c->ok(json{{"x", mx - r.x}, {"y", my - r.y}});
  });
  op("isHovered", [](CallPtr c, Window *w) {
    int mx, my;
    pointer_position(&mx, &my);
    GdkRectangle f = frame_rect(w);
    c->ok(json{{"hovered", mx >= f.x && my >= f.y && mx < f.x + f.width && my < f.y + f.height}});
  });
  op("controlsArea", [](CallPtr c, Window *) { c->ok(nullptr); }); // server-side decorations: not ours to measure

  // ── state ─────────────────────────────────────────────────────────────
  op("getTitle", [](CallPtr c, Window *w) {
    const char *t = gtk_window_get_title(GTK_WINDOW(w->window));
    c->ok(t ? t : "");
  });
  op("setTitle", [](CallPtr c, Window *w) {
    gtk_window_set_title(GTK_WINDOW(w->window), c->str("title").c_str());
    c->ok();
  });
  op("eval", [](CallPtr c, Window *w) {
    if (!c->has("js")) return c->fail("invalid_args", "window.eval: `js` is required");
    eval_to_json(w->webview, c->str("js"), c, "window.eval");
  });
  op("minimize", [](CallPtr c, Window *w) {
    gtk_window_iconify(GTK_WINDOW(w->window));
    settle(c, w->id, [](Window *x) { return has_state(x, GDK_WINDOW_STATE_ICONIFIED); }, [](Window *) { return json(nullptr); });
  });
  op("unminimize", [](CallPtr c, Window *w) {
    gtk_window_deiconify(GTK_WINDOW(w->window));
    gtk_window_present(GTK_WINDOW(w->window));
    settle(c, w->id, [](Window *x) { return !has_state(x, GDK_WINDOW_STATE_ICONIFIED); }, [](Window *) { return json(nullptr); });
  });
  op("isMinimized", [](CallPtr c, Window *w) { c->ok(json{{"minimized", has_state(w, GDK_WINDOW_STATE_ICONIFIED)}}); });
  op("maximize", [](CallPtr c, Window *w) {
    set_state_flag(c, w, true, GDK_WINDOW_STATE_MAXIMIZED, [w] { gtk_window_maximize(GTK_WINDOW(w->window)); }, "maximized");
  });
  op("unmaximize", [](CallPtr c, Window *w) {
    set_state_flag(c, w, false, GDK_WINDOW_STATE_MAXIMIZED, [w] { gtk_window_unmaximize(GTK_WINDOW(w->window)); }, "maximized");
  });
  op("toggleMaximize", [](CallPtr c, Window *w) {
    bool on = !has_state(w, GDK_WINDOW_STATE_MAXIMIZED);
    set_state_flag(c, w, on, GDK_WINDOW_STATE_MAXIMIZED, [w, on] {
      on ? gtk_window_maximize(GTK_WINDOW(w->window)) : gtk_window_unmaximize(GTK_WINDOW(w->window));
    }, "maximized");
  });
  op("isMaximized", [](CallPtr c, Window *w) { c->ok(has_state(w, GDK_WINDOW_STATE_MAXIMIZED)); });
  op("setFullscreen", [](CallPtr c, Window *w) {
    bool on = c->flag("fullscreen", true);
    set_state_flag(c, w, on, GDK_WINDOW_STATE_FULLSCREEN, [w, on] {
      on ? gtk_window_fullscreen(GTK_WINDOW(w->window)) : gtk_window_unfullscreen(GTK_WINDOW(w->window));
    }, "fullscreen");
  });
  op("toggleFullscreen", [](CallPtr c, Window *w) {
    bool on = !has_state(w, GDK_WINDOW_STATE_FULLSCREEN);
    set_state_flag(c, w, on, GDK_WINDOW_STATE_FULLSCREEN, [w, on] {
      on ? gtk_window_fullscreen(GTK_WINDOW(w->window)) : gtk_window_unfullscreen(GTK_WINDOW(w->window));
    }, "fullscreen");
  });
  op("isFullscreen", [](CallPtr c, Window *w) { c->ok(has_state(w, GDK_WINDOW_STATE_FULLSCREEN)); });
  op("restore", [](CallPtr c, Window *w) {
    GtkWindow *win = GTK_WINDOW(w->window);
    gtk_window_deiconify(win);
    if (has_state(w, GDK_WINDOW_STATE_FULLSCREEN)) gtk_window_unfullscreen(win);
    else if (has_state(w, GDK_WINDOW_STATE_MAXIMIZED)) gtk_window_unmaximize(win);
    settle(c, w->id, [](Window *x) { return !has_state(x, GDK_WINDOW_STATE_ICONIFIED | GDK_WINDOW_STATE_MAXIMIZED | GDK_WINDOW_STATE_FULLSCREEN); },
           [](Window *) { return json(nullptr); });
  });
  op("isFocused", [](CallPtr c, Window *w) { c->ok((bool)gtk_window_is_active(GTK_WINDOW(w->window))); });
  op("isActive", [](CallPtr c, Window *w) { c->ok((bool)gtk_window_is_active(GTK_WINDOW(w->window))); });
  op("focus", [](CallPtr c, Window *w) {
    reveal(w);
    gtk_window_present(GTK_WINDOW(w->window));
    c->ok();
  });
  op("blur", [](CallPtr c, Window *w) {
    for (int id : window_ids()) {
      Window *o = find_window(id);
      if (o != w && gtk_widget_get_visible(o->window)) {
        gtk_window_present(GTK_WINDOW(o->window));
        break;
      }
    }
    c->ok();
  });
  op("isVisible", [](CallPtr c, Window *w) {
    c->ok(gtk_widget_get_visible(w->window) && !has_state(w, GDK_WINDOW_STATE_ICONIFIED) && gtk_widget_get_opacity(w->window) > 0);
  });
  op("isOccluded", [](CallPtr c, Window *w) {
    c->ok(!gtk_widget_get_mapped(w->window) || has_state(w, GDK_WINDOW_STATE_ICONIFIED) || has_state(w, GDK_WINDOW_STATE_WITHDRAWN));
  });
  op("show", [](CallPtr c, Window *w) {
    if (gtk_widget_get_opacity(w->window) == 0) gtk_widget_set_opacity(w->window, 1);
    w->shown = true;
    gtk_widget_show(w->window);
    gtk_window_present(GTK_WINDOW(w->window));
    settle(c, w->id, [](Window *x) { return (bool)gtk_widget_get_mapped(x->window); }, [](Window *) { return json(nullptr); });
  });
  op("hide", [](CallPtr c, Window *w) {
    gtk_widget_hide(w->window);
    c->ok();
  });
  op("close", [](CallPtr c, Window *w) {
    c->ok();
    w->closing = true; // programmatic close bypasses the veto
    gtk_window_close(GTK_WINDOW(w->window));
  });
  op("setCloseVeto", [](CallPtr c, Window *w) {
    w->veto = c->flag("enabled", true);
    c->ok(json{{"armed", w->veto}});
  });
  auto attention = [](CallPtr c, Window *w) {
    gtk_window_set_urgency_hint(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  };
  op("requestAttention", attention);
  op("flashFrame", attention);

  // ── z-order + chrome ──────────────────────────────────────────────────
  op("setAlwaysOnTop", [](CallPtr c, Window *w) {
    gtk_window_set_keep_above(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });
  op("setAlwaysOnBottom", [](CallPtr c, Window *w) {
    gtk_window_set_keep_below(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });
  op("setResizable", [](CallPtr c, Window *w) {
    gtk_window_set_resizable(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });
  op("isResizable", [](CallPtr c, Window *w) { c->ok(json{{"resizable", (bool)gtk_window_get_resizable(GTK_WINDOW(w->window))}}); });
  op("setClosable", [](CallPtr c, Window *w) {
    gtk_window_set_deletable(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });
  op("isClosable", [](CallPtr c, Window *w) { c->ok(json{{"closable", (bool)gtk_window_get_deletable(GTK_WINDOW(w->window))}}); });
  op("setTitleBarStyle", [](CallPtr c, Window *w) {
    std::string style = c->str("style", "default");
    if (style != "default" && style != "transparent" && style != "hidden" && style != "hiddenInset")
      return c->fail("invalid_args", "window.setTitleBarStyle: style is default | transparent | hidden | hiddenInset");
    set_title_bar_style(w->id, style);
    c->ok();
  });
  op("getTitleBarStyle", [](CallPtr c, Window *w) {
    std::string style = title_bar_style(w->id);
    c->ok(json{{"style", style}, {"frameless", !gtk_window_get_decorated(GTK_WINDOW(w->window))}});
  });
  op("setDecorations", [](CallPtr c, Window *w) {
    gtk_window_set_decorated(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });
  op("setSkipTaskbar", [](CallPtr c, Window *w) {
    gtk_window_set_skip_taskbar_hint(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });
  op("setVisibleOnAllWorkspaces", [](CallPtr c, Window *w) {
    c->flag("enabled", true) ? gtk_window_stick(GTK_WINDOW(w->window)) : gtk_window_unstick(GTK_WINDOW(w->window));
    c->ok();
  });
  op("setFocusable", [](CallPtr c, Window *w) {
    gtk_window_set_accept_focus(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });

  // ── appearance + input ────────────────────────────────────────────────
  op("setOpacity", [](CallPtr c, Window *w) {
    gtk_widget_set_opacity(w->window, std::max(0.0, std::min(1.0, c->num("opacity", 1))));
    c->ok();
  });
  op("getOpacity", [](CallPtr c, Window *w) { c->ok(json{{"opacity", gtk_widget_get_opacity(w->window)}}); });
  op("setIgnoresMouseEvents", [](CallPtr c, Window *w) {
    w->ignoreMouse = c->flag("enabled", true);
    GdkWindow *g = gtk_widget_get_window(w->window);
    if (g) {
      if (w->ignoreMouse) {
        cairo_region_t *empty = cairo_region_create();
        gdk_window_input_shape_combine_region(g, empty, 0, 0);
        cairo_region_destroy(empty);
      } else {
        gdk_window_input_shape_combine_region(g, nullptr, 0, 0);
      }
    }
    c->ok();
  });
  op("ignoresMouseEvents", [](CallPtr c, Window *w) { c->ok(json{{"ignored", w->ignoreMouse}}); });
  op("setCursorPosition", [](CallPtr c, Window *w) {
    GdkSeat *seat = gdk_display_get_default_seat(gdk_display_get_default());
    if (GdkDevice *dev = seat ? gdk_seat_get_pointer(seat) : nullptr)
      gdk_device_warp(dev, gtk_widget_get_screen(w->window), (int)c->num("x", 0), (int)c->num("y", 0));
    c->ok();
  });
}

} // namespace lx
} // namespace sd
