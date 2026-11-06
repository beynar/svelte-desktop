// window.* — the window contract on GTK 3.
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
//
// A parent is what a window is transient for: the window manager keeps it above and GTK closes it
// with it, but it doesn't move along. Not registered, see limitations.mdx: the represented file and
// the traffic lights (macOS's own), materials (the compositor's), content protection and the shadow
// (X11 has neither), setMovableByWindowBackground (the page covers the window), showCharacterPalette
// (no call opens the desktop's emoji picker), testScroll.
#include <gdk/gdkx.h>

#include <cmath>
#include <cstring>

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

static Window *parent_of(Window *w) {
  GtkWindow *t = gtk_window_get_transient_for(GTK_WINDOW(w->window));
  for (int id : window_ids())
    if (GTK_WINDOW(find_window(id)->window) == t) return find_window(id);
  return nullptr;
}

bool set_window_parent(Window *w, Window *parent) {
  for (Window *a = parent; a; a = parent_of(a))
    if (a == w) return false;
  gtk_window_set_transient_for(GTK_WINDOW(w->window), parent ? GTK_WINDOW(parent->window) : nullptr);
  gtk_window_set_destroy_with_parent(GTK_WINDOW(w->window), parent != nullptr);
  return true;
}

// The prefix is only what the title bar shows: X11 has no hint for this.
static const char *const kEditedMark = "\xE2\x80\xA2 ";

void set_window_title(Window *w, const std::string &title) {
  gtk_window_set_title(GTK_WINDOW(w->window), ((w->documentEdited ? kEditedMark : "") + title).c_str());
}

static std::string window_title(Window *w) {
  const char *t = gtk_window_get_title(GTK_WINDOW(w->window));
  std::string title = t ? t : "";
  return w->documentEdited && title.rfind(kEditedMark, 0) == 0 ? title.substr(strlen(kEditedMark)) : title;
}

// GTK's settings belong to the screen, and WebKit's prefers-color-scheme comes from them: a window's
// theme moves every window's widgets and page, the last one set wins (Windows: WebView2's profile has
// the same limit). What each window has of its own is the hint its title bar is drawn from. X11 only.
static void apply_window_theme(Window *w) {
  GdkWindow *g = gtk_widget_get_window(w->window);
  if (!g || !GDK_IS_X11_WINDOW(g)) return;
  gdk_x11_window_set_theme_variant(g, const_cast<char *>(w->theme != "system" ? w->theme.c_str() : theme_app_dark() ? "dark" : nullptr));
}

void window_themes_reapply() {
  for (int id : window_ids()) apply_window_theme(find_window(id));
}

// A cursor belongs to a GdkWindow, and the web view has its own: WebKit sets the page's there each
// time the pointer meets a new one, so it's taken back as it comes. Every window has it, as ShowCursor
// does on Windows and NSCursor on macOS.
static bool g_cursor_hidden = false;

static GdkCursor *blank_cursor() {
  static GdkCursor *blank = gdk_cursor_new_for_display(gdk_display_get_default(), GDK_BLANK_CURSOR);
  return blank;
}

static void on_cursor_changed(GdkWindow *g, GParamSpec *, gpointer) {
  if (g_cursor_hidden && gdk_window_get_cursor(g) != blank_cursor()) gdk_window_set_cursor(g, blank_cursor());
}

static void apply_cursor(GdkWindow *g) {
  if (g_cursor_hidden && !g_object_get_data(G_OBJECT(g), "sd-cursor-watch")) {
    g_object_set_data(G_OBJECT(g), "sd-cursor-watch", g);
    g_signal_connect(g, "notify::cursor", G_CALLBACK(on_cursor_changed), nullptr);
  }
  gdk_window_set_cursor(g, g_cursor_hidden ? blank_cursor() : nullptr);
  for (GList *c = gdk_window_peek_children(g); c; c = c->next) apply_cursor(GDK_WINDOW(c->data));
}

void cursor_window_mapped(GtkWidget *window) {
  if (GdkWindow *g = gtk_widget_get_window(window); g && g_cursor_hidden) apply_cursor(g);
}

static json info_row(int id) {
  Window *w = find_window(id);
  Window *parent = parent_of(w);
  return json{{"windowId", public_id(id)}, {"parentId", parent ? json(public_id(parent->id)) : json(nullptr)}, {"focusable", (bool)gtk_window_get_accept_focus(GTK_WINDOW(w->window))}, {"label", w->label}, {"focused", (bool)gtk_window_is_active(GTK_WINDOW(w->window))}, {"visible", (bool)gtk_widget_get_visible(w->window)}, {"bounds", bounds_json(w)}, {"session", session_of(w->webview)}};
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
    if (id == -5) return c->fail("invalid_args", "window.create: unknown session or invalid recovery policy");
    if (id == -6) return c->fail("invalid_args", "window.create: invalid parent, modal, type or focusable option");
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
  op("setParent", [](CallPtr c, Window *w) {
    bool detach = c->args.contains("parentId") && c->args["parentId"].is_null();
    int pid = (int)c->num("parentId", -1);
    Window *parent = detach ? nullptr : pid == 0 ? find_window(primary_window()) : pid > 0 ? find_window(pid) : nullptr;
    if (!detach && !parent) return c->fail("invalid_args", "window.setParent: no such parent");
    if (!set_window_parent(w, parent)) return c->fail("invalid_args", "parent relationship cannot contain a cycle");
    c->ok();
  });
  op("getParent", [](CallPtr c, Window *w) {
    Window *parent = parent_of(w);
    c->ok(parent ? info_row(parent->id) : json(nullptr));
  });
  op("getChildren", [](CallPtr c, Window *w) {
    json rows = json::array();
    for (int id : window_ids())
      if (parent_of(find_window(id)) == w) rows.push_back(info_row(id));
    c->ok(rows);
  });
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
    apply_geometry(w);
    c->ok();
  });
  op("setMaxSize", [](CallPtr c, Window *w) {
    w->maxW = (int)c->num("width", 0);
    w->maxH = (int)c->num("height", 0);
    apply_geometry(w);
    c->ok();
  });
  // The window manager and GTK both hold it, for every size: setSize too, and at once.
  op("setAspectRatio", [](CallPtr c, Window *w) {
    w->aspect = std::max(0.0, c->num("ratio", 0));
    apply_geometry(w);
    settle(c, w->id, [](Window *x) {
      int a = 0, b = 1;
      gtk_window_get_size(GTK_WINDOW(x->window), &a, &b);
      return x->aspect <= 0 || !gtk_widget_get_mapped(x->window) || std::abs(a / (double)b - x->aspect) < 0.02;
    }, [](Window *) { return json(nullptr); });
  });
  op("getAspectRatio", [](CallPtr c, Window *w) { c->ok(w->aspect > 0 ? json(w->aspect) : json(nullptr)); });
  op("getMinSize", [](CallPtr c, Window *w) { c->ok(json{{"width", w->minW}, {"height", w->minH}}); });
  op("getMaxSize", [](CallPtr c, Window *w) { c->ok(json{{"width", w->maxW}, {"height", w->maxH}}); });
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
  op("getTitle", [](CallPtr c, Window *w) { c->ok(window_title(w)); });
  op("setTitle", [](CallPtr c, Window *w) {
    set_window_title(w, c->str("title"));
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
  // Not the window manager's full screen, which isFullscreen reports: borderless over the monitor, as on macOS.
  op("setSimpleFullscreen", [](CallPtr c, Window *w) {
    bool on = c->flag("enabled", true);
    if (on == w->simpleFullscreen) return c->ok();
    GtkWindow *win = GTK_WINDOW(w->window);
    GdkRectangle to;
    if (on) {
      GdkRectangle f = frame_rect(w);
      w->simpleSaved = f;
      gtk_window_get_size(win, &w->simpleSaved.width, &w->simpleSaved.height);
      w->simpleDecorated = gtk_window_get_decorated(win);
      w->simpleResizable = gtk_window_get_resizable(win);
      GdkMonitor *m = monitor_at(f.x + f.width / 2, f.y + f.height / 2);
      gdk_monitor_get_geometry(m ? m : primary_monitor(), &to);
      gtk_window_unfullscreen(win);
      gtk_window_unmaximize(win);
    } else {
      to = w->simpleSaved;
    }
    w->simpleFullscreen = on;
    if (w->menubar) gtk_widget_set_visible(w->menubar, !on);
    gtk_window_set_resizable(win, on || w->simpleResizable);
    gtk_window_set_decorated(win, !on && w->simpleDecorated);
    apply_geometry(w);
    gtk_window_resize(win, to.width, to.height);
    move_frame(w, to.x, to.y);
    settle(c, w->id, [on, to](Window *x) {
      if (!x->simpleFullscreen != !on) return true;
      int cw = 0, ch = 0;
      gtk_window_get_size(GTK_WINDOW(x->window), &cw, &ch);
      GdkRectangle f = frame_rect(x);
      return near(f.x, to.x) && near(f.y, to.y) && near(cw, to.width) && near(ch, to.height);
    }, [](Window *) { return json(nullptr); });
  });
  op("isSimpleFullscreen", [](CallPtr c, Window *w) { c->ok(json{{"simpleFullscreen", w->simpleFullscreen}}); });
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
    if (!gtk_window_get_accept_focus(GTK_WINDOW(w->window))) return c->fail("unavailable", "window.focus: this window is not focusable");
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
    sheets_window_closing(w->id); // GTK drops a delete event for a window blocked by a modal one
    gtk_window_close(GTK_WINDOW(w->window));
  });
  op("setCloseVeto", [](CallPtr c, Window *w) {
    w->veto = c->flag("enabled", true);
    c->ok(json{{"armed", w->veto}});
  });
  op("hasCloseVeto", [](CallPtr c, Window *w) { c->ok(w->veto); });
  auto attention = [](CallPtr c, Window *w) {
    gtk_window_set_urgency_hint(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  };
  op("requestAttention", attention);
  op("flashFrame", attention);

  // ── z-order + chrome ──────────────────────────────────────────────────
  op("setAlwaysOnTop", [](CallPtr c, Window *w) {
    w->alwaysOnTop = c->flag("enabled", true);
    gtk_window_set_keep_above(GTK_WINDOW(w->window), w->alwaysOnTop);
    c->ok();
  });
  op("isAlwaysOnTop", [](CallPtr c, Window *w) { c->ok(w->alwaysOnTop); });
  op("setAlwaysOnBottom", [](CallPtr c, Window *w) {
    w->alwaysOnBottom = c->flag("enabled", true);
    gtk_window_set_keep_below(GTK_WINDOW(w->window), w->alwaysOnBottom);
    c->ok();
  });
  op("isAlwaysOnBottom", [](CallPtr c, Window *w) { c->ok(w->alwaysOnBottom); });
  // AppKit's numbers where they mean something here: 3 is its floating level, what always on top sets.
  op("getLevel", [](CallPtr c, Window *w) { c->ok(w->alwaysOnTop ? 3 : w->alwaysOnBottom ? -1 : 0); });
  op("setResizable", [](CallPtr c, Window *w) {
    gtk_window_set_resizable(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });
  op("isResizable", [](CallPtr c, Window *w) { c->ok(json{{"resizable", (bool)gtk_window_get_resizable(GTK_WINDOW(w->window))}}); });
  op("setClosable", [](CallPtr c, Window *w) {
    gtk_window_set_deletable(GTK_WINDOW(w->window), c->flag("enabled", true));
    apply_functions(w); // GTK's own call writes every function back
    c->ok();
  });
  op("isClosable", [](CallPtr c, Window *w) { c->ok(json{{"closable", (bool)gtk_window_get_deletable(GTK_WINDOW(w->window))}}); });
  op("setMovable", [](CallPtr c, Window *w) {
    w->movable = c->flag("enabled", true);
    apply_functions(w);
    c->ok();
  });
  op("isMovable", [](CallPtr c, Window *w) { c->ok(w->movable); });
  op("setMinimizable", [](CallPtr c, Window *w) {
    w->minimizable = c->flag("enabled", true);
    apply_functions(w);
    c->ok();
  });
  op("isMinimizable", [](CallPtr c, Window *w) { c->ok(json{{"minimizable", w->minimizable}}); });
  op("setMaximizable", [](CallPtr c, Window *w) {
    w->maximizable = c->flag("enabled", true);
    apply_functions(w);
    c->ok();
  });
  op("isMaximizable", [](CallPtr c, Window *w) { c->ok(json{{"maximizable", w->maximizable}}); });
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
  op("hasDecorations", [](CallPtr c, Window *w) { c->ok((bool)gtk_window_get_decorated(GTK_WINDOW(w->window))); });
  op("setSkipTaskbar", [](CallPtr c, Window *w) {
    gtk_window_set_skip_taskbar_hint(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });
  op("setVisibleOnAllWorkspaces", [](CallPtr c, Window *w) {
    w->onAllWorkspaces = c->flag("enabled", true);
    w->onAllWorkspaces ? gtk_window_stick(GTK_WINDOW(w->window)) : gtk_window_unstick(GTK_WINDOW(w->window));
    c->ok();
  });
  op("isVisibleOnAllWorkspaces", [](CallPtr c, Window *w) { c->ok(w->onAllWorkspaces); });
  op("setFocusable", [](CallPtr c, Window *w) {
    gtk_window_set_accept_focus(GTK_WINDOW(w->window), c->flag("enabled", true));
    c->ok();
  });
  op("isFocusable", [](CallPtr c, Window *w) { c->ok((bool)gtk_window_get_accept_focus(GTK_WINDOW(w->window))); });

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
  op("setDocumentEdited", [](CallPtr c, Window *w) {
    std::string title = window_title(w);
    w->documentEdited = c->flag("edited", true);
    set_window_title(w, title);
    c->ok();
  });
  op("isDocumentEdited", [](CallPtr c, Window *w) { c->ok(json{{"edited", w->documentEdited}}); });
  op("setCursorHidden", [](CallPtr c, Window *) {
    g_cursor_hidden = c->flag("hidden", true);
    GList *all = gtk_window_list_toplevels();
    for (GList *l = all; l; l = l->next)
      if (GdkWindow *g = gtk_widget_get_window(GTK_WIDGET(l->data))) apply_cursor(g);
    g_list_free(all);
    c->ok();
  });
  op("isCursorHidden", [](CallPtr c, Window *) { c->ok(g_cursor_hidden); });
  op("setTheme", [](CallPtr c, Window *w) {
    std::string t = c->str("theme", "system");
    if (t != "system" && t != "light" && t != "dark") return c->fail("invalid_args", "window.setTheme: theme must be system|light|dark");
    w->theme = t;
    theme_window_changed(t);
    apply_window_theme(w);
    c->ok();
  });
  op("getTheme", [](CallPtr c, Window *w) { c->ok(w->theme); });
  op("setCursorPosition", [](CallPtr c, Window *w) {
    GdkSeat *seat = gdk_display_get_default_seat(gdk_display_get_default());
    if (GdkDevice *dev = seat ? gdk_seat_get_pointer(seat) : nullptr)
      gdk_device_warp(dev, gtk_widget_get_screen(w->window), (int)c->num("x", 0), (int)c->num("y", 0));
    c->ok();
  });
}

} // namespace lx
} // namespace sd
