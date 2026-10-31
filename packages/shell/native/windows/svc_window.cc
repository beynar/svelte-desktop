// window.* — the common op subset of the macOS contract on Win32 windows.
// Coordinates: DIPs, top-left origin of the virtual screen (y down). `windowId`
// is the public id (0 = primary); absent -> the calling page's window.
// Events (shell_win.cc): focusChanged, boundsChanged, scaleFactorChanged,
// willClose, closed, created.
#include "win.hpp"

#include <dwmapi.h>


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

static json info_row(Window *w) {
  return json{{"windowId", backend_public_window_id(w->id)},
              {"label", w->label},
              {"focused", GetForegroundWindow() == w->hwnd},
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

void set_fullscreen(Window *w, bool on) {
  if (on == w->fullscreen) return;
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
  w->fullscreen = on;
}

static void focus_window(Window *w) {
  if (IsIconic(w->hwnd)) ShowWindow(w->hwnd, SW_RESTORE);
  else if (!IsWindowVisible(w->hwnd)) ShowWindow(w->hwnd, SW_SHOW);
  w->shown = true;
  SetForegroundWindow(w->hwnd);
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
  wreg("getScaleFactor", [](CallPtr c, Window *w) { c->ok(hwnd_scale(w->hwnd)); });
  wreg("getCursorPoint", [](CallPtr c, Window *w) {
    POINT p;
    GetCursorPos(&p);
    ScreenToClient(w->hwnd, &p);
    double s = hwnd_scale(w->hwnd);
    c->ok(json{{"x", p.x / s}, {"y", p.y / s}});
  });

  // ── state ─────────────────────────────────────────────────────────────
  wreg("getTitle", [](CallPtr c, Window *w) {
    wchar_t buf[1024];
    int n = GetWindowTextW(w->hwnd, buf, 1024);
    c->ok(utf8(buf, n));
  });
  wreg("setTitle", [](CallPtr c, Window *w) {
    SetWindowTextW(w->hwnd, wide(c->str("title")).c_str());
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
  wreg("restore", [](CallPtr c, Window *w) {
    if (w->fullscreen) set_fullscreen(w, false);
    else if (IsIconic(w->hwnd) || IsZoomed(w->hwnd)) ShowWindow(w->hwnd, SW_RESTORE);
    c->ok();
  });
  wreg("isFocused", [](CallPtr c, Window *w) { c->ok(GetForegroundWindow() == w->hwnd); });
  wreg("isActive", [](CallPtr c, Window *w) { c->ok(GetForegroundWindow() == w->hwnd); });
  wreg("focus", [](CallPtr c, Window *w) {
    focus_window(w);
    c->ok();
  });
  wreg("blur", [](CallPtr c, Window *w) {
    // Next window in z-order that is not ours, like Alt+Tab.
    HWND next = GetWindow(w->hwnd, GW_HWNDNEXT);
    while (next && (!IsWindowVisible(next) || find_window_hwnd(next) == w)) next = GetWindow(next, GW_HWNDNEXT);
    if (next) SetForegroundWindow(next);
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
    PostMessageW(w->hwnd, WM_CLOSE, 0, 0);
  });
  wreg("setCloseVeto", [](CallPtr c, Window *w) {
    w->veto = c->flag("enabled", true);
    c->ok(json{{"armed", w->veto}});
  });
  auto flash = [](CallPtr c, Window *w) {
    FLASHWINFO fi{sizeof fi, w->hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0};
    FlashWindowEx(&fi);
    c->ok();
  };
  wreg("requestAttention", flash);
  wreg("flashFrame", flash);

  // ── z-order + chrome ──────────────────────────────────────────────────
  flag_op("setAlwaysOnTop", "", "", [](Window *w, bool on) {
    SetWindowPos(w->hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }, nullptr);
  flag_op("setAlwaysOnBottom", "", "", [](Window *w, bool on) {
    SetWindowPos(w->hwnd, on ? HWND_BOTTOM : HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }, nullptr);
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
  flag_op("setDecorations", "", "", [](Window *w, bool on) {
    LONG_PTR s = style_of(w);
    if (on) s = (s & ~WS_POPUP) | WS_CAPTION | WS_SYSMENU;
    else s = (s & ~WS_CAPTION) | WS_POPUP;
    SetWindowLongPtrW(w->hwnd, GWL_STYLE, s);
    SetWindowPos(w->hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }, nullptr);

  // ── appearance + behavior ─────────────────────────────────────────────
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
    w->documentEdited = c->flag("edited", true); // no native indicator on Windows; state only
    c->ok();
  });
  wreg("isDocumentEdited", [](CallPtr c, Window *w) { c->ok(json{{"edited", w->documentEdited}}); });
  wreg("setCursorHidden", [](CallPtr c, Window *) {
    ShowCursor(c->flag("hidden", true) ? FALSE : TRUE);
    c->ok();
  });
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
}

} // namespace sd::win
