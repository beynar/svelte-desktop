// window.* — the macOS contract on Win32 windows.
// Coordinates: DIPs, top-left origin of the virtual screen (y down). `windowId`
// is the public id (0 = primary); absent -> the calling page's window.
// Events (shell_win.cc): focusChanged, boundsChanged, scaleFactorChanged,
// willClose, closed, created.
//
// A parent is an owner: Windows keeps the owned window above it, hides and minimizes it with it and
// destroys it with it, but doesn't move it along. Not registered, see limitations.mdx: the represented
// file and the traffic lights (macOS's own), setMovableByWindowBackground (the page covers the window),
// invalidateShadow (DWM keeps a shadow in step itself), setVisibleOnAllWorkspaces (no public call pins a
// window to every desktop), setMaterialRegions (a backdrop fills the window), testScroll.
#include "win.hpp"

#include <dwmapi.h>

#include <algorithm>
#include <cstring>

namespace sd::win {

using WindowOp = std::function<void(CallPtr, Window *)>;

static void wreg(const std::string &op, WindowOp body) {
  reg("window", op, [body](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    if (!w) return c->fail("invalid_args", "window." + c->op + ": no such window");
    body(c, w);
  });
}

static LONG_PTR style_of(Window *w) { return GetWindowLongPtrW(w->hwnd, GWL_STYLE); }
static void set_style_bit(Window *w, LONG_PTR bit, bool on) {
  LONG_PTR s = style_of(w);
  SetWindowLongPtrW(w->hwnd, GWL_STYLE, on ? (s | bit) : (s & ~bit));
  SetWindowPos(w->hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}
static void set_ex_bit(Window *w, LONG_PTR bit, bool on) {
  LONG_PTR s = GetWindowLongPtrW(w->hwnd, GWL_EXSTYLE);
  SetWindowLongPtrW(w->hwnd, GWL_EXSTYLE, on ? (s | bit) : (s & ~bit));
}

static std::string state_name(Window *w) {
  if (w->fullscreen) return "fullscreen";
  if (IsZoomed(w->hwnd)) return "maximized";
  if (IsIconic(w->hwnd)) return "minimized";
  return "normal";
}

static json size_json(double w, double h) { return json{{"width", w}, {"height", h}}; }

static json client_size(Window *w) {
  RECT r{};
  GetClientRect(w->hwnd, &r);
  double s = hwnd_scale(w->hwnd);
  return size_json((r.right - r.left) / s, (r.bottom - r.top) / s);
}

static Window *owner_of(Window *w) { return find_window_hwnd(GetWindow(w->hwnd, GW_OWNER)); }
static bool focusable(Window *w) { return !(GetWindowLongPtrW(w->hwnd, GWL_EXSTYLE) & WS_EX_NOACTIVATE); }

static json info_row(Window *w) {
  Window *owner = owner_of(w);
  return json{{"windowId", backend_public_window_id(w->id)},
              {"parentId", owner ? json(backend_public_window_id(owner->id)) : json(nullptr)},
              {"focusable", focusable(w)},
              {"label", w->label},
              {"focused", GetForegroundWindow() == w->hwnd},
              {"visible", IsWindowVisible(w->hwnd) != FALSE},
              {"session", w->view.session.empty() ? json(nullptr) : json(w->view.session)},
              {"bounds", window_bounds_json(w->hwnd)}};
}

static void set_frame_dip(Window *w, double x, double y, double width, double height) {
  double s = hwnd_scale(w->hwnd);
  SetWindowPos(w->hwnd, nullptr, (int)(x * s), (int)(y * s), (int)(width * s), (int)(height * s), SWP_NOZORDER | SWP_NOACTIVATE);
}

static void apply_layered(Window *w) {
  bool layered = w->opacity < 1.0 || w->ignoreMouse;
  set_ex_bit(w, WS_EX_LAYERED, layered);
  set_ex_bit(w, WS_EX_TRANSPARENT, w->ignoreMouse);
  if (layered) SetLayeredWindowAttributes(w->hwnd, 0, (BYTE)(std::max(0.0, std::min(1.0, w->opacity)) * 255), LWA_ALPHA);
}

// Borderless over its monitor, and back: both kinds of full screen. One at a time.
static void cover_monitor(Window *w, bool on) {
  if (on) {
    GetWindowRect(w->hwnd, &w->savedRect);
    w->savedStyle = style_of(w);
    if (IsZoomed(w->hwnd)) ShowWindow(w->hwnd, SW_RESTORE);
    MONITORINFO mi{sizeof mi};
    GetMonitorInfoW(MonitorFromWindow(w->hwnd, MONITOR_DEFAULTTONEAREST), &mi);
    SetWindowLongPtrW(w->hwnd, GWL_STYLE, (w->savedStyle & ~(WS_CAPTION | WS_THICKFRAME)) | WS_POPUP);
    SetMenu(w->hwnd, nullptr);
    SetWindowPos(w->hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right - mi.rcMonitor.left,
                 mi.rcMonitor.bottom - mi.rcMonitor.top, SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  } else {
    SetWindowLongPtrW(w->hwnd, GWL_STYLE, w->savedStyle);
    if (w->menu) SetMenu(w->hwnd, w->menu);
    RECT r = w->savedRect;
    SetWindowPos(w->hwnd, nullptr, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  }
}

static void set_simple_fullscreen(Window *w, bool on) {
  if (on == w->simpleFullscreen) return;
  if (on && w->fullscreen) set_fullscreen(w, false);
  cover_monitor(w, on);
  w->simpleFullscreen = on;
}

void set_fullscreen(Window *w, bool on) {
  if (on == w->fullscreen) return;
  if (on && w->simpleFullscreen) set_simple_fullscreen(w, false);
  cover_monitor(w, on);
  w->fullscreen = on;
}

// A window that can't take the keyboard comes up without it.
static void focus_window(Window *w) {
  bool can = focusable(w);
  if (IsIconic(w->hwnd)) ShowWindow(w->hwnd, can ? SW_RESTORE : SW_SHOWNOACTIVATE);
  else if (!IsWindowVisible(w->hwnd)) ShowWindow(w->hwnd, can ? SW_SHOW : SW_SHOWNOACTIVATE);
  w->shown = true;
  if (can) SetForegroundWindow(w->hwnd);
}

// To the next window in z-order that is not ours, like Alt+Tab.
void give_up_foreground(Window *w) {
  HWND next = GetWindow(w->hwnd, GW_HWNDNEXT);
  while (next && (!IsWindowVisible(next) || find_window_hwnd(next) == w)) next = GetWindow(next, GW_HWNDNEXT);
  if (next) SetForegroundWindow(next);
}

bool set_window_parent(Window *w, Window *parent) {
  for (Window *a = parent; a; a = owner_of(a))
    if (a == w) return false;
  SetWindowLongPtrW(w->hwnd, GWLP_HWNDPARENT, reinterpret_cast<LONG_PTR>(parent ? parent->hwnd : nullptr));
  return true;
}

// The prefix is only what the title bar shows: no native indicator for this on Windows.
static const char *const kEditedMark = "\xE2\x80\xA2 ";

void set_window_title(Window *w, const std::string &title) {
  SetWindowTextW(w->hwnd, wide((w->documentEdited ? kEditedMark : "") + title).c_str());
}

static std::string window_title(Window *w) {
  wchar_t buf[1024];
  std::string title = utf8(buf, GetWindowTextW(w->hwnd, buf, 1024));
  return w->documentEdited && title.rfind(kEditedMark, 0) == 0 ? title.substr(strlen(kEditedMark)) : title;
}

// macOS's materials on the backdrops DWM has. Long-lived surfaces get Mica, title bars and headers
// Mica Alt (what Windows gives tabbed title bars), and what comes and goes above others Acrylic.
static int backdrop_of(const std::string &material) {
  static const std::map<std::string, int> kinds = {
      {"window", DWMSBT_MAINWINDOW}, {"content", DWMSBT_MAINWINDOW}, {"underPage", DWMSBT_MAINWINDOW}, {"sidebar", DWMSBT_MAINWINDOW}, {"fullscreenUI", DWMSBT_MAINWINDOW},
      {"titlebar", DWMSBT_TABBEDWINDOW}, {"header", DWMSBT_TABBEDWINDOW},
      {"underWindow", DWMSBT_TRANSIENTWINDOW}, {"menu", DWMSBT_TRANSIENTWINDOW}, {"popover", DWMSBT_TRANSIENTWINDOW}, {"sheet", DWMSBT_TRANSIENTWINDOW},
      {"hud", DWMSBT_TRANSIENTWINDOW}, {"tooltip", DWMSBT_TRANSIENTWINDOW}, {"selection", DWMSBT_TRANSIENTWINDOW}};
  auto it = kinds.find(material);
  return it == kinds.end() ? DWMSBT_AUTO : it->second;
}

std::string set_window_vibrancy(Window *w, const std::string &material) {
  int kind = DWMSBT_NONE;
  if (!material.empty() && (kind = backdrop_of(material)) == DWMSBT_AUTO)
    return "unknown material `" + material + "`, expected one of window, content, underPage, sidebar, fullscreenUI, titlebar, header, underWindow, menu, popover, sheet, hud, tooltip, selection";
  // Windows 11 22H2 is the first to have the attribute.
  if (FAILED(DwmSetWindowAttribute(w->hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &kind, sizeof kind)) && !material.empty()) return "unavailable";
  w->vibrancy = material;
  // The backdrop is drawn in the frame: the frame goes under the whole client area, and the page lets it through.
  MARGINS margins{};
  if (!material.empty()) margins = MARGINS{-1, -1, -1, -1};
  DwmExtendFrameIntoClientArea(w->hwnd, &margins);
  paint_under_view(w);
  View *v = &w->view;
  bool clear = !material.empty() || v->transparent;
  view_when_ready(v, [v, clear] {
    if (auto *c2 = query<ICoreWebView2Controller2>(v->controller, IID_ICoreWebView2Controller2)) {
      COREWEBVIEW2_COLOR color{(BYTE)(clear ? 0 : 255), (BYTE)(clear ? 0 : 255), (BYTE)(clear ? 0 : 255), (BYTE)(clear ? 0 : 255)};
      c2->put_DefaultBackgroundColor(color);
      c2->Release();
    }
  });
  return "";
}

static void vibrancy_reply(CallPtr c, Window *w, const std::string &material, const json &answer) {
  std::string error = set_window_vibrancy(w, material);
  if (error == "unavailable") return c->fail("unavailable", "window." + c->op + ": system backdrops need Windows 11 22H2");
  if (!error.empty()) return c->fail("invalid_args", "window." + c->op + ": " + error);
  c->ok(answer);
}

static bool hex_color(const std::string &s) {
  if (s.size() != 4 && s.size() != 7 && s.size() != 9) return false;
  return s[0] == '#' && std::all_of(s.begin() + 1, s.end(), [](char ch) { return isxdigit((unsigned char)ch) != 0; });
}

static void flag_op(const std::string &setter, const std::string &getter, const std::string &key,
                    std::function<void(Window *, bool)> set, std::function<bool(Window *)> get) {
  wreg(setter, [set](CallPtr c, Window *w) {
    set(w, c->flag("enabled", true));
    c->ok();
  });
  if (!getter.empty()) wreg(getter, [key, get](CallPtr c, Window *w) { c->ok(json{{key, get(w)}}); });
}

void register_window() {
  // ── multi-window ──────────────────────────────────────────────────────
  reg("window", "create", [](CallPtr c) {
    int id = create_app_window(c->args);
    if (id == -4) return c->fail("invalid_args", "window.create: label `" + c->str("label") + "` is already used");
    if (id == -5) return c->fail("invalid_args", "window.create: unknown session or invalid recovery policy");
    if (id == -6) return c->fail("invalid_args", "window.create: invalid parent, modal, type or focusable option");
    if (id <= 0) return c->fail("internal", "window.create failed");
    Window *w = find_window(id);
    if (c->has("opacity")) {
      w->opacity = c->num("opacity", 1);
      apply_layered(w);
    }
    c->ok(json{{"windowId", backend_public_window_id(id)}, {"label", w->label}});
  });
  reg("window", "list", [](CallPtr c) {
    json rows = json::array();
    for (int id : window_order())
      if (Window *w = find_window(id)) rows.push_back(info_row(w));
    c->ok(rows);
  });
  reg("window", "get", [](CallPtr c) {
    std::string label = c->str("label");
    for (int id : window_order())
      if (Window *w = find_window(id))
        if (w->label == label) return c->ok(info_row(w));
    c->ok(nullptr);
  });

  // ── geometry ──────────────────────────────────────────────────────────
  wreg("setTitleBarStyle", [](CallPtr c, Window *w) {
    std::string style = c->str("style", "default");
    if (style != "default" && style != "transparent" && style != "hidden" && style != "hiddenInset")
      return c->fail("invalid_args", "window.setTitleBarStyle: style is default | transparent | hidden | hiddenInset");
    set_title_bar_style(w->id, style);
    c->ok();
  });
  wreg("getTitleBarStyle", [](CallPtr c, Window *w) {
    c->ok(json{{"style", title_bar_style(w->id)}, {"frameless", (GetWindowLongPtrW(w->hwnd, GWL_STYLE) & WS_CAPTION) != WS_CAPTION}});
  });
  // The calling page's own window (or windowId's): {windowId, label, focused, visible, bounds}.
  wreg("getInfo", [](CallPtr c, Window *w) { c->ok(info_row(w)); });
  wreg("setParent", [](CallPtr c, Window *w) {
    bool detach = c->args.contains("parentId") && c->args["parentId"].is_null();
    int pid = (int)c->num("parentId", -1);
    Window *parent = detach ? nullptr : pid == 0 ? find_window(primary_window()) : pid > 0 ? find_window(pid) : nullptr;
    if (!detach && !parent) return c->fail("invalid_args", "window.setParent: no such parent");
    if (!set_window_parent(w, parent)) return c->fail("invalid_args", "parent relationship cannot contain a cycle");
    c->ok();
  });
  wreg("getParent", [](CallPtr c, Window *w) {
    Window *owner = owner_of(w);
    c->ok(owner ? info_row(owner) : json(nullptr));
  });
  wreg("getChildren", [](CallPtr c, Window *w) {
    json rows = json::array();
    for (int id : window_order())
      if (Window *o = find_window(id); o && owner_of(o) == w) rows.push_back(info_row(o));
    c->ok(rows);
  });
  wreg("getBounds", [](CallPtr c, Window *w) { c->ok(json{{"bounds", window_bounds_json(w->hwnd)}, {"state", state_name(w)}}); });
  wreg("setBounds", [](CallPtr c, Window *w) {
    json b = window_bounds_json(w->hwnd);
    set_frame_dip(w, c->num("x", b["x"]), c->num("y", b["y"]), c->num("width", b["width"]), c->num("height", b["height"]));
    c->ok();
  });
  for (const char *op : {"getSize", "getContentSize", "innerSize"}) wreg(op, [](CallPtr c, Window *w) { c->ok(client_size(w)); });
  wreg("outerSize", [](CallPtr c, Window *w) {
    json b = window_bounds_json(w->hwnd);
    c->ok(size_json(b["width"], b["height"]));
  });
  wreg("setSize", [](CallPtr c, Window *w) {
    json cur = client_size(w);
    set_content_size(w, c->num("width", cur["width"].get<double>()), c->num("height", cur["height"].get<double>()));
    c->ok();
  });
  for (const char *op : {"getPosition", "outerPosition"})
    wreg(op, [](CallPtr c, Window *w) {
      json b = window_bounds_json(w->hwnd);
      c->ok(json{{"x", b["x"]}, {"y", b["y"]}});
    });
  wreg("innerPosition", [](CallPtr c, Window *w) {
    POINT p{0, 0};
    ClientToScreen(w->hwnd, &p);
    double s = hwnd_scale(w->hwnd);
    c->ok(json{{"x", p.x / s}, {"y", p.y / s}});
  });
  wreg("setPosition", [](CallPtr c, Window *w) {
    json b = window_bounds_json(w->hwnd);
    set_frame_dip(w, c->num("x", b["x"]), c->num("y", b["y"]), b["width"], b["height"]);
    c->ok();
  });
  wreg("center", [](CallPtr c, Window *w) {
    RECT r;
    GetWindowRect(w->hwnd, &r);
    MONITORINFO mi{sizeof mi};
    GetMonitorInfoW(MonitorFromWindow(w->hwnd, MONITOR_DEFAULTTONEAREST), &mi);
    int fw = r.right - r.left, fh = r.bottom - r.top;
    SetWindowPos(w->hwnd, nullptr, mi.rcWork.left + (mi.rcWork.right - mi.rcWork.left - fw) / 2,
                 mi.rcWork.top + (mi.rcWork.bottom - mi.rcWork.top - fh) / 2, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    c->ok();
  });
  wreg("positionTo", [](CallPtr c, Window *w) {
    std::string preset = c->str("preset");
    RECT r;
    GetWindowRect(w->hwnd, &r);
    int fw = r.right - r.left, fh = r.bottom - r.top;
    POINT m;
    GetCursorPos(&m);
    int x, y;
    if (preset == "center") {
      MONITORINFO mi{sizeof mi};
      GetMonitorInfoW(MonitorFromWindow(w->hwnd, MONITOR_DEFAULTTONEAREST), &mi);
      x = mi.rcWork.left + (mi.rcWork.right - mi.rcWork.left - fw) / 2;
      y = mi.rcWork.top + (mi.rcWork.bottom - mi.rcWork.top - fh) / 2;
    } else if (preset == "cursorTopLeft") {
      x = m.x;
      y = m.y;
    } else if (preset == "cursorBottomLeft") {
      x = m.x;
      y = m.y - fh;
    } else if (preset.rfind("tray", 0) == 0) {
      RECT t;
      if (!tray_rect(t)) return c->fail("unavailable", "window.positionTo: no tray item is placed");
      MONITORINFO mi{sizeof mi};
      GetMonitorInfoW(MonitorFromRect(&t, MONITOR_DEFAULTTONEAREST), &mi);
      // The taskbar is usually at the bottom: open above the icon unless there is no room.
      bool above = t.top - fh >= mi.rcWork.top || preset == "trayTop";
      int cx = (t.left + t.right) / 2;
      if (preset == "trayCenter" || preset == "trayBottom" || preset == "trayTop") x = cx - fw / 2;
      else if (preset == "trayLeft") x = t.left;
      else if (preset == "trayRight") x = t.right - fw;
      else return c->fail("invalid_args", "window.positionTo: unknown preset `" + preset + "`");
      y = above ? t.top - fh : t.bottom;
      x = std::max((int)mi.rcWork.left, std::min(x, (int)mi.rcWork.right - fw));
    } else {
      return c->fail("invalid_args", "window.positionTo: unknown preset `" + preset + "`");
    }
    SetWindowPos(w->hwnd, nullptr, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    c->ok();
  });
  wreg("setMinSize", [](CallPtr c, Window *w) {
    w->minW = c->num("width", 0);
    w->minH = c->num("height", 0);
    c->ok();
  });
  wreg("setMaxSize", [](CallPtr c, Window *w) {
    w->maxW = c->num("width", 0);
    w->maxH = c->num("height", 0);
    c->ok();
  });
  wreg("getMinSize", [](CallPtr c, Window *w) { c->ok(size_json(w->minW, w->minH)); });
  wreg("getMaxSize", [](CallPtr c, Window *w) { c->ok(size_json(w->maxW, w->maxH)); });
  wreg("getScaleFactor", [](CallPtr c, Window *w) { c->ok(hwnd_scale(w->hwnd)); });
  wreg("getCursorPoint", [](CallPtr c, Window *w) {
    POINT p;
    GetCursorPos(&p);
    ScreenToClient(w->hwnd, &p);
    double s = hwnd_scale(w->hwnd);
    c->ok(json{{"x", p.x / s}, {"y", p.y / s}});
  });

  // ── state ─────────────────────────────────────────────────────────────
  wreg("getTitle", [](CallPtr c, Window *w) { c->ok(window_title(w)); });
  wreg("setTitle", [](CallPtr c, Window *w) {
    set_window_title(w, c->str("title"));
    c->ok();
  });
  wreg("eval", [](CallPtr c, Window *w) {
    if (!c->has("js")) return c->fail("invalid_args", "window.eval: `js` is required");
    view_execute(&w->view, c->str("js"), [c](bool ok, const json &value, const std::string &error) {
      ok ? c->ok(value) : c->fail("internal", error);
    });
  });
  wreg("minimize", [](CallPtr c, Window *w) {
    ShowWindow(w->hwnd, SW_MINIMIZE);
    c->ok();
  });
  wreg("unminimize", [](CallPtr c, Window *w) {
    if (IsIconic(w->hwnd)) ShowWindow(w->hwnd, SW_RESTORE);
    c->ok();
  });
  wreg("isMinimized", [](CallPtr c, Window *w) { c->ok(json{{"minimized", IsIconic(w->hwnd) != 0}}); });
  wreg("maximize", [](CallPtr c, Window *w) {
    ShowWindow(w->hwnd, SW_MAXIMIZE);
    c->ok(json{{"maximized", IsZoomed(w->hwnd) != 0}});
  });
  wreg("unmaximize", [](CallPtr c, Window *w) {
    if (IsZoomed(w->hwnd)) ShowWindow(w->hwnd, SW_RESTORE);
    c->ok(json{{"maximized", IsZoomed(w->hwnd) != 0}});
  });
  wreg("toggleMaximize", [](CallPtr c, Window *w) {
    ShowWindow(w->hwnd, IsZoomed(w->hwnd) ? SW_RESTORE : SW_MAXIMIZE);
    c->ok(json{{"maximized", IsZoomed(w->hwnd) != 0}});
  });
  wreg("isMaximized", [](CallPtr c, Window *w) { c->ok(IsZoomed(w->hwnd) != 0); });
  wreg("isFullscreen", [](CallPtr c, Window *w) { c->ok(w->fullscreen); });
  wreg("setFullscreen", [](CallPtr c, Window *w) {
    bool on = c->flag("fullscreen", true);
    set_fullscreen(w, on);
    c->ok(json{{"fullscreen", on}});
  });
  wreg("toggleFullscreen", [](CallPtr c, Window *w) {
    set_fullscreen(w, !w->fullscreen);
    c->ok(json{{"fullscreen", w->fullscreen}});
  });
  wreg("setSimpleFullscreen", [](CallPtr c, Window *w) {
    set_simple_fullscreen(w, c->flag("enabled", true));
    c->ok();
  });
  wreg("isSimpleFullscreen", [](CallPtr c, Window *w) { c->ok(json{{"simpleFullscreen", w->simpleFullscreen}}); });
  wreg("restore", [](CallPtr c, Window *w) {
    if (w->fullscreen) set_fullscreen(w, false);
    else if (IsIconic(w->hwnd) || IsZoomed(w->hwnd)) ShowWindow(w->hwnd, SW_RESTORE);
    c->ok();
  });
  wreg("isFocused", [](CallPtr c, Window *w) { c->ok(GetForegroundWindow() == w->hwnd); });
  wreg("isActive", [](CallPtr c, Window *w) { c->ok(GetForegroundWindow() == w->hwnd); });
  wreg("focus", [](CallPtr c, Window *w) {
    if (!focusable(w)) return c->fail("unavailable", "window.focus: this window is not focusable");
    focus_window(w);
    c->ok();
  });
  wreg("blur", [](CallPtr c, Window *w) {
    give_up_foreground(w);
    c->ok();
  });
  wreg("isHovered", [](CallPtr c, Window *w) {
    POINT p;
    GetCursorPos(&p);
    RECT r;
    GetWindowRect(w->hwnd, &r);
    c->ok(json{{"hovered", PtInRect(&r, p) != 0}});
  });
  wreg("isVisible", [](CallPtr c, Window *w) { c->ok(IsWindowVisible(w->hwnd) != 0 && !IsIconic(w->hwnd)); });
  wreg("isOccluded", [](CallPtr c, Window *w) {
    BOOL cloaked = FALSE;
    DwmGetWindowAttribute(w->hwnd, 14 /*DWMWA_CLOAKED*/, &cloaked, sizeof cloaked);
    c->ok(!IsWindowVisible(w->hwnd) || IsIconic(w->hwnd) || cloaked);
  });
  wreg("show", [](CallPtr c, Window *w) {
    focus_window(w);
    c->ok();
  });
  wreg("hide", [](CallPtr c, Window *w) {
    ShowWindow(w->hwnd, SW_HIDE);
    c->ok();
  });
  wreg("close", [](CallPtr c, Window *w) {
    c->ok();
    w->veto = false; // programmatic close bypasses the veto
    w->closing = true;
    PostMessageW(w->hwnd, WM_CLOSE, 0, 0);
  });
  wreg("setCloseVeto", [](CallPtr c, Window *w) {
    w->veto = c->flag("enabled", true);
    c->ok(json{{"armed", w->veto}});
  });
  wreg("hasCloseVeto", [](CallPtr c, Window *w) { c->ok(w->veto); });
  auto flash = [](CallPtr c, Window *w) {
    FLASHWINFO fi{sizeof fi, w->hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0};
    FlashWindowEx(&fi);
    c->ok();
  };
  wreg("requestAttention", flash);
  wreg("flashFrame", flash);
  // The emoji panel has no call: it opens on Win+period, for the window in the foreground. Real input,
  // so only once that's this one: the keys would go to another app otherwise.
  wreg("showCharacterPalette", [](CallPtr c, Window *w) {
    if (!focusable(w)) return c->fail("unavailable", "window.showCharacterPalette: this window is not focusable");
    focus_window(w);
    if (GetForegroundWindow() != w->hwnd) return c->fail("unavailable", "window.showCharacterPalette: Windows keeps another window in front");
    INPUT keys[4]{};
    const WORD order[4] = {VK_LWIN, VK_OEM_PERIOD, VK_OEM_PERIOD, VK_LWIN};
    for (int i = 0; i < 4; i++) {
      keys[i].type = INPUT_KEYBOARD;
      keys[i].ki.wVk = order[i];
      keys[i].ki.dwFlags = i < 2 ? 0 : KEYEVENTF_KEYUP;
    }
    if (SendInput(4, keys, sizeof(INPUT)) != 4) return c->fail("unavailable", "window.showCharacterPalette: " + last_error_message());
    c->ok();
  });

  // ── z-order + chrome ──────────────────────────────────────────────────
  flag_op("setAlwaysOnTop", "", "", [](Window *w, bool on) {
    SetWindowPos(w->hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }, nullptr);
  wreg("isAlwaysOnTop", [](CallPtr c, Window *w) { c->ok((GetWindowLongPtrW(w->hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0); });
  flag_op("setAlwaysOnBottom", "", "", [](Window *w, bool on) {
    w->alwaysOnBottom = on;
    SetWindowPos(w->hwnd, on ? HWND_BOTTOM : HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }, nullptr);
  wreg("isAlwaysOnBottom", [](CallPtr c, Window *w) { c->ok(w->alwaysOnBottom); });
  // AppKit's numbers where they mean something here: 3 is its floating level, what always on top sets.
  wreg("getLevel", [](CallPtr c, Window *w) {
    bool top = (GetWindowLongPtrW(w->hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    c->ok(top ? 3 : w->alwaysOnBottom ? -1 : 0);
  });
  flag_op("setResizable", "isResizable", "resizable", [](Window *w, bool on) { set_style_bit(w, WS_THICKFRAME, on); },
          [](Window *w) { return (style_of(w) & WS_THICKFRAME) != 0; });
  flag_op("setMinimizable", "isMinimizable", "minimizable", [](Window *w, bool on) { set_style_bit(w, WS_MINIMIZEBOX, on); },
          [](Window *w) { return (style_of(w) & WS_MINIMIZEBOX) != 0; });
  flag_op("setMaximizable", "isMaximizable", "maximizable", [](Window *w, bool on) { set_style_bit(w, WS_MAXIMIZEBOX, on); },
          [](Window *w) { return (style_of(w) & WS_MAXIMIZEBOX) != 0; });
  flag_op("setClosable", "isClosable", "closable", [](Window *w, bool on) {
    EnableMenuItem(GetSystemMenu(w->hwnd, FALSE), SC_CLOSE, MF_BYCOMMAND | (on ? MF_ENABLED : MF_GRAYED));
  }, [](Window *w) {
    MENUITEMINFOW mii{sizeof mii};
    mii.fMask = MIIM_STATE;
    return !(GetMenuItemInfoW(GetSystemMenu(w->hwnd, FALSE), SC_CLOSE, FALSE, &mii) && (mii.fState & MFS_GRAYED));
  });
  // DWM draws the shadow with the rest of the frame: there's no switch for the shadow alone.
  flag_op("setHasShadow", "", "", [](Window *w, bool on) {
    DWMNCRENDERINGPOLICY policy = on ? DWMNCRP_ENABLED : DWMNCRP_DISABLED;
    DwmSetWindowAttribute(w->hwnd, DWMWA_NCRENDERING_POLICY, &policy, sizeof policy);
  }, nullptr);
  wreg("hasShadow", [](CallPtr c, Window *w) {
    BOOL enabled = FALSE;
    DwmGetWindowAttribute(w->hwnd, DWMWA_NCRENDERING_ENABLED, &enabled, sizeof enabled);
    c->ok(enabled != FALSE);
  });
  flag_op("setMovable", "", "", [](Window *w, bool on) { w->movable = on; }, nullptr);
  wreg("isMovable", [](CallPtr c, Window *w) { c->ok(w->movable); });
  wreg("setFocusable", [](CallPtr c, Window *w) {
    bool on = c->flag("enabled", true);
    set_ex_bit(w, WS_EX_NOACTIVATE, !on);
    if (!on && GetForegroundWindow() == w->hwnd) give_up_foreground(w);
    c->ok();
  });
  wreg("isFocusable", [](CallPtr c, Window *w) { c->ok(focusable(w)); });
  wreg("setAspectRatio", [](CallPtr c, Window *w) {
    w->aspect = std::max(0.0, c->num("ratio", 0));
    c->ok();
  });
  wreg("getAspectRatio", [](CallPtr c, Window *w) { c->ok(w->aspect > 0 ? json(w->aspect) : json(nullptr)); });
  // The buttons DWM draws, in the window: its frame's top-left corner, as on macOS. None on a window without a caption.
  wreg("controlsArea", [](CallPtr c, Window *w) {
    RECT area{}, frame{};
    GetWindowRect(w->hwnd, &frame);
    if ((style_of(w) & WS_CAPTION) != WS_CAPTION || FAILED(DwmGetWindowAttribute(w->hwnd, DWMWA_CAPTION_BUTTON_BOUNDS, &area, sizeof area)) || IsRectEmpty(&area)) return c->ok(nullptr);
    double s = hwnd_scale(w->hwnd);
    TITLEBARINFOEX bar{};
    bar.cbSize = sizeof bar;
    SendMessageW(w->hwnd, WM_GETTITLEBARINFOEX, 0, reinterpret_cast<LPARAM>(&bar));
    json buttons = json::object();
    // CCHILDREN_TITLEBAR's order: 2 minimize, 3 maximize, 5 close.
    for (auto [name, i] : {std::pair<const char *, int>{"minimize", 2}, {"zoom", 3}, {"close", 5}}) {
      const RECT &b = bar.rgrect[i];
      if (IsRectEmpty(&b)) continue;
      json row = rect_json((b.left - frame.left) / s, (b.top - frame.top) / s, (b.right - b.left) / s, (b.bottom - b.top) / s);
      row["visible"] = !(bar.rgstate[i] & STATE_SYSTEM_INVISIBLE);
      buttons[name] = row;
    }
    POINT client{0, 0};
    ClientToScreen(w->hwnd, &client);
    json out = rect_json(area.left / s, area.top / s, (area.right - area.left) / s, (area.bottom - area.top) / s);
    out["contentTop"] = (client.y - frame.top) / s;
    out["side"] = "right";
    out["buttons"] = buttons;
    c->ok(out);
  });
  wreg("hasDecorations", [](CallPtr c, Window *w) { c->ok((style_of(w) & WS_CAPTION) == WS_CAPTION); });
  flag_op("setDecorations", "", "", [](Window *w, bool on) {
    LONG_PTR s = style_of(w);
    if (on) s = (s & ~WS_POPUP) | WS_CAPTION | WS_SYSMENU;
    else s = (s & ~WS_CAPTION) | WS_POPUP;
    SetWindowLongPtrW(w->hwnd, GWL_STYLE, s);
    SetWindowPos(w->hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }, nullptr);

  // ── appearance + behavior ─────────────────────────────────────────────
  // Windows has one kind of backdrop per window, and dims it by itself when the window isn't active:
  // state can't be chosen, and getVibrancy says so.
  wreg("setVibrancy", [](CallPtr c, Window *w) { vibrancy_reply(c, w, c->str("material"), nullptr); });
  wreg("getVibrancy", [](CallPtr c, Window *w) {
    c->ok(w->vibrancy.empty() ? json(nullptr) : json{{"material", w->vibrancy}, {"state", "followsWindow"}});
  });
  // No Liquid Glass here: what macOS does before version 26, the underWindow material and { glass: false }.
  wreg("setGlass", [](CallPtr c, Window *w) {
    const json glass = c->args.value("glass", json());
    if (!glass.is_object()) return vibrancy_reply(c, w, w->vibrancy == "underWindow" ? "" : w->vibrancy, nullptr);
    std::string style = jstr(glass, "style", "regular"), tint = jstr(glass, "tint");
    if (style != "regular" && style != "clear") return c->fail("invalid_args", "window.setGlass: unknown style `" + style + "`, expected regular or clear");
    if (!tint.empty() && !hex_color(tint)) return c->fail("invalid_args", "window.setGlass: tint `" + tint + "` is not a #rgb, #rrggbb or #rrggbbaa color");
    vibrancy_reply(c, w, "underWindow", json{{"glass", false}});
  });
  wreg("getGlass", [](CallPtr c, Window *) { c->ok(nullptr); });
  wreg("setOpacity", [](CallPtr c, Window *w) {
    w->opacity = std::max(0.0, std::min(1.0, c->num("opacity", 1)));
    apply_layered(w);
    c->ok();
  });
  wreg("getOpacity", [](CallPtr c, Window *w) { c->ok(json{{"opacity", w->opacity}}); });
  flag_op("setIgnoresMouseEvents", "ignoresMouseEvents", "ignored", [](Window *w, bool on) {
    w->ignoreMouse = on;
    apply_layered(w);
  }, [](Window *w) { return w->ignoreMouse; });
  wreg("setContentProtected", [](CallPtr c, Window *w) {
    bool on = c->flag("enabled", true);
    // WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+), else WDA_MONITOR (black in captures).
    if (!SetWindowDisplayAffinity(w->hwnd, on ? 0x11 : WDA_NONE) && on && !SetWindowDisplayAffinity(w->hwnd, WDA_MONITOR))
      return c->fail("unavailable", "window.setContentProtected: " + last_error_message());
    w->contentProtected = on;
    c->ok();
  });
  wreg("isContentProtected", [](CallPtr c, Window *w) { c->ok(json{{"contentProtected", w->contentProtected}}); });
  wreg("setDocumentEdited", [](CallPtr c, Window *w) {
    std::string title = window_title(w);
    w->documentEdited = c->flag("edited", true);
    set_window_title(w, title);
    c->ok();
  });
  wreg("isDocumentEdited", [](CallPtr c, Window *w) { c->ok(json{{"edited", w->documentEdited}}); });
  // ShowCursor counts: hiding twice would need showing twice, and no one could read the state.
  static bool cursor_hidden = false;
  wreg("setCursorHidden", [](CallPtr c, Window *) {
    bool hidden = c->flag("hidden", true);
    if (hidden != cursor_hidden) ShowCursor(hidden ? FALSE : TRUE);
    cursor_hidden = hidden;
    c->ok();
  });
  wreg("isCursorHidden", [](CallPtr c, Window *) { c->ok(cursor_hidden); });
  wreg("setCursorPosition", [](CallPtr c, Window *w) {
    double s = hwnd_scale(w->hwnd);
    SetCursorPos((int)(c->num("x", 0) * s), (int)(c->num("y", 0) * s));
    c->ok();
  });
  wreg("setTheme", [](CallPtr c, Window *w) {
    std::string t = c->str("theme", "system");
    if (t != "system" && t != "light" && t != "dark") return c->fail("invalid_args", "window.setTheme: theme must be system|light|dark");
    w->theme = t;
    theme_apply_window(w);
    c->ok();
  });
  wreg("getTheme", [](CallPtr c, Window *w) { c->ok(w->theme); });
}

} // namespace sd::win
