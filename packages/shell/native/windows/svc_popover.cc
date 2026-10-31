// popover.* — a route of the app in a borderless WS_POPUP window with its own
// WebView2 controller (same environment, so the session cookie applies),
// anchored to the tray icon rect, a rect of a window's page, the cursor or a
// screen rect. Both styles ("popover", "panel") are the same window on Windows
// (no arrow). Light dismiss on deactivation unless behavior is "manual".
//
// Ops: create, show, hide, toggle, setSize, setPosition, isShown, get, list,
// eval, reload, destroy; events.emit fans {channel, data} out to every page.
// Events: popoverReady, popoverShown, popoverHidden, popoverResized {id}.
#include "win.hpp"

#include <dwmapi.h>


namespace sd::win {

struct Popover {
  std::string id;
  std::string style = "popover", behavior = "transient", url;
  double width = 320, height = 240;
  bool closeOnEscape = true, activate = true, ready = false, loaded = false;
  json position = "tray";
  json pendingArgs;     // show requested before the page was ready (preload:false)
  bool pendingShow = false;
  int pendingCaller = 0;
  ULONGLONG lastHidden = 0;
  HWND hwnd = nullptr;
  View view;
};

static std::map<std::string, Popover *> g_popovers;
static std::string g_tray_popover;
static int g_next_native = 1000;
static const UINT_PTR kPendingTimer = 7;
static const wchar_t *kPopoverClass = L"SvelteDesktopPopover";

static Popover *find_native(int nativeId) {
  for (auto &[id, p] : g_popovers)
    if (p->view.id == nativeId) return p;
  return nullptr;
}

static bool shown(Popover *p) { return IsWindowVisible(p->hwnd) != 0; }

static json describe(Popover *p) {
  DWORD pid = 0;
  GetWindowThreadProcessId(GetForegroundWindow(), &pid);
  return json{{"id", p->id},       {"style", p->style}, {"shown", shown(p)},
              {"width", p->width}, {"height", p->height}, {"url", p->url.empty() ? json(nullptr) : json(p->url)},
              {"ready", p->ready}, {"key", GetForegroundWindow() == p->hwnd}, {"appActive", pid == GetCurrentProcessId()}};
}

static void hide(Popover *p) {
  if (!shown(p)) return;
  ShowWindow(p->hwnd, SW_HIDE);
  p->lastHidden = GetTickCount64();
  emit("popoverHidden", json{{"id", p->id}});
}

static LRESULT CALLBACK popover_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  Popover *p = reinterpret_cast<Popover *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  if (msg == WM_NCCREATE) {
    p = static_cast<Popover *>(reinterpret_cast<CREATESTRUCTW *>(lp)->lpCreateParams);
    p->hwnd = hwnd;
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(p));
  }
  if (!p) return DefWindowProcW(hwnd, msg, wp, lp);
  switch (msg) {
    case WM_SIZE:
      view_resize(&p->view);
      return 0;
    case WM_ACTIVATE:
      if (LOWORD(wp) == WA_INACTIVE) {
        if (p->behavior != "manual") hide(p);
      } else if (p->view.controller) {
        p->view.controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
      }
      return 0;
    case WM_MOUSEACTIVATE:
      return p->activate ? MA_ACTIVATE : MA_NOACTIVATE;
    case WM_CLOSE:
      hide(p);
      return 0;
    case WM_TIMER:
      if (wp == kPendingTimer) {
        KillTimer(hwnd, kPendingTimer);
        popover_page_ready(-p->view.id); // timeout: show anyway
        return 0;
      }
      break;
    case WM_ERASEBKGND: {
      RECT r;
      GetClientRect(hwnd, &r);
      HBRUSH b = CreateSolidBrush(app_dark() ? RGB(43, 43, 43) : RGB(249, 249, 249));
      FillRect(reinterpret_cast<HDC>(wp), &r, b);
      DeleteObject(b);
      return 1;
    }
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

static void ensure_class() {
  static bool done = false;
  if (done) return;
  done = true;
  WNDCLASSEXW wc{sizeof wc};
  wc.style = CS_DROPSHADOW;
  wc.lpfnWndProc = popover_proc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = kPopoverClass;
  RegisterClassExW(&wc);
}

static std::string js_string(const std::string &s) { return json(s).dump(); }

static Popover *build(CallPtr c, const std::string &id, std::string &error) {
  std::string url = c->str("url");
  if (url.empty()) {
    std::string route = c->str("route", "/");
    std::string origin = app_origin();
    if (origin.empty()) {
      error = "popover.create: the app origin isn't known yet (create popovers after the shell is ready)";
      return nullptr;
    }
    url = origin + (route.rfind('/', 0) == 0 ? route : "/" + route);
  }
  ensure_class();
  auto *p = new Popover;
  p->id = id;
  p->style = c->str("style") == "panel" ? "panel" : "popover";
  p->behavior = c->str("behavior", "transient");
  p->url = url;
  p->width = std::max(40.0, c->num("width", 320));
  p->height = std::max(24.0, c->num("height", 240));
  p->closeOnEscape = c->flag("closeOnEscape", true);
  p->activate = c->flag("activate", true);
  if (c->has("position")) p->position = c->args["position"];
  POINT origin{0, 0};
  double s = monitor_scale(MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY));
  HWND hwnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, kPopoverClass, wide(id).c_str(), WS_POPUP | WS_CLIPCHILDREN, 0, 0,
                              (int)(p->width * s), (int)(p->height * s), nullptr, nullptr, GetModuleHandleW(nullptr), p);
  if (!hwnd) {
    delete p;
    error = "popover.create: CreateWindow failed (" + last_error_message() + ")";
    return nullptr;
  }
  int corner = 2; // DWMWCP_ROUND (Windows 11)
  DwmSetWindowAttribute(hwnd, 33 /*DWMWA_WINDOW_CORNER_PREFERENCE*/, &corner, sizeof corner);
  set_dark_title_bar(hwnd, app_dark());
  p->view.id = g_next_native++;
  p->view.host = hwnd;
  p->view.debug = c->flag("debug", false);
  p->view.contextMenu = p->view.debug;
  p->view.extraScript = "window.__shellPopover=Object.freeze({id:" + js_string(id) +
                        "});document.addEventListener('DOMContentLoaded',()=>document.documentElement.setAttribute('data-shell-popover',''));";
  views()[p->view.id] = &p->view;
  view_create(&p->view);
  // preload (default): load now, keep warm for an instant first show.
  if (c->flag("preload", true)) {
    p->loaded = true;
    view_navigate(&p->view, url);
  }
  return p;
}

static void destroy(Popover *p) {
  if (g_tray_popover == p->id) g_tray_popover.clear();
  g_popovers.erase(p->id);
  view_destroy(&p->view);
  DestroyWindow(p->hwnd);
  delete p;
}

// ---------------------------------------------------------------------------
// Placement (physical pixels)

static RECT work_area_for(const RECT &r) {
  MONITORINFO mi{sizeof mi};
  GetMonitorInfoW(MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST), &mi);
  return mi.rcWork;
}

// Below the anchor if it fits, else above; centered, clamped to the work area.
static RECT place_near(const RECT &anchor, int w, int h) {
  RECT work = work_area_for(anchor);
  int x = (anchor.left + anchor.right) / 2 - w / 2;
  int y = anchor.bottom + 4;
  if (y + h > work.bottom) y = anchor.top - h - 4;
  x = std::max((int)work.left + 4, std::min(x, (int)work.right - w - 4));
  y = std::max((int)work.top + 4, std::min(y, (int)work.bottom - h - 4));
  return RECT{x, y, x + w, y + h};
}

static bool anchor_rect(Popover *p, const json &args, int caller, RECT &out, std::string &error) {
  json anchor = args.contains("anchor") ? args["anchor"] : json("tray");
  if (anchor.is_string() && anchor == "tray") {
    if (!tray_rect(out)) {
      error = "popover.show: anchor `tray` needs a tray item (tray.set)";
      return false;
    }
    return true;
  }
  if (anchor.is_string() && anchor == "cursor") {
    POINT m;
    GetCursorPos(&m);
    out = RECT{m.x, m.y, m.x + 1, m.y + 1};
    return true;
  }
  if (anchor.is_object() && anchor.contains("screen") && anchor["screen"].is_object()) {
    const json &r = anchor["screen"];
    POINT pt{(LONG)jnum(r, "x", 0), (LONG)jnum(r, "y", 0)};
    double s = point_scale(pt);
    out = RECT{(LONG)(jnum(r, "x", 0) * s), (LONG)(jnum(r, "y", 0) * s), (LONG)((jnum(r, "x", 0) + std::max(1.0, jnum(r, "width", 1))) * s),
               (LONG)((jnum(r, "y", 0) + std::max(1.0, jnum(r, "height", 1))) * s)};
    return true;
  }
  if (anchor.is_object()) {
    // A rect in a page (CSS px, e.g. getBoundingClientRect()).
    View *v = nullptr;
    if (anchor.contains("windowId")) {
      Window *w = find_window(backend_native_window_id((int)jnum(anchor, "windowId", 0)));
      v = w ? &w->view : nullptr;
    } else {
      v = find_view(caller);
      if (!v) {
        Window *w = find_window(primary_window());
        v = w ? &w->view : nullptr;
      }
    }
    if (!v || !v->host) {
      error = "popover.show: no window to anchor to";
      return false;
    }
    double k = view_zoom(v) * hwnd_scale(v->host);
    POINT o{0, 0};
    ClientToScreen(v->host, &o);
    out = RECT{o.x + (LONG)(jnum(anchor, "x", 0) * k), o.y + (LONG)(jnum(anchor, "y", 0) * k),
               o.x + (LONG)((jnum(anchor, "x", 0) + std::max(1.0, jnum(anchor, "width", 1))) * k),
               o.y + (LONG)((jnum(anchor, "y", 0) + std::max(1.0, jnum(anchor, "height", 1))) * k)};
    return true;
  }
  error = "popover.show: unknown anchor (tray|cursor|{x,y,width,height[,windowId]}|{screen:{...}})";
  return false;
}

static bool panel_rect(Popover *p, const json &position, int w, int h, RECT &out, std::string &error) {
  if (position.is_object() && position.contains("x") && position.contains("y")) {
    POINT pt{(LONG)jnum(position, "x", 0), (LONG)jnum(position, "y", 0)};
    double s = point_scale(pt);
    LONG x = (LONG)(jnum(position, "x", 0) * s), y = (LONG)(jnum(position, "y", 0) * s);
    out = RECT{x, y, x + w, y + h};
    return true;
  }
  std::string preset = position.is_string() ? position.get<std::string>() : "tray";
  if (preset.rfind("tray", 0) == 0) {
    RECT t;
    if (tray_rect(t)) {
      out = place_near(t, w, h);
      int shift = preset == "trayLeft" ? (int)(t.left - out.left) : preset == "trayRight" ? (int)(t.right - out.right) : 0;
      RECT work = work_area_for(t);
      int x = std::max((int)work.left + 4, std::min((int)out.left + shift, (int)work.right - w - 4));
      out = RECT{x, out.top, x + w, out.bottom};
      return true;
    }
    preset = "center"; // no tray (programmatic open): don't strand it offscreen
  }
  if (preset == "cursor") {
    POINT m;
    GetCursorPos(&m);
    out = place_near(RECT{m.x, m.y, m.x + 1, m.y + 1}, w, h);
    return true;
  }
  if (preset == "center") {
    POINT m;
    GetCursorPos(&m);
    RECT work = work_area_for(RECT{m.x, m.y, m.x + 1, m.y + 1});
    int x = work.left + (work.right - work.left - w) / 2;
    int y = work.top + (work.bottom - work.top) / 3 - h / 2; // Spotlight-ish: upper third
    out = RECT{x, y, x + w, y + h};
    return true;
  }
  error = "popover: unknown position `" + preset + "` (tray|trayLeft|trayRight|center|cursor|{x,y})";
  return false;
}

static bool show_now(Popover *p, const json &args, int caller, std::string &error) {
  RECT anchorProbe{0, 0, 1, 1};
  tray_rect(anchorProbe);
  double s = monitor_scale(MonitorFromRect(&anchorProbe, MONITOR_DEFAULTTONEAREST));
  int w = (int)(p->width * s), h = (int)(p->height * s);
  RECT r;
  if (p->style == "panel") {
    json position = args.contains("position") ? args["position"] : p->position;
    if (!panel_rect(p, position, w, h, r, error)) return false;
    if (args.contains("position")) p->position = args["position"];
  } else {
    RECT anchor;
    if (!anchor_rect(p, args, caller, anchor, error)) return false;
    s = monitor_scale(MonitorFromRect(&anchor, MONITOR_DEFAULTTONEAREST));
    r = place_near(anchor, (int)(p->width * s), (int)(p->height * s));
  }
  SetWindowPos(p->hwnd, HWND_TOPMOST, r.left, r.top, r.right - r.left, r.bottom - r.top,
               SWP_SHOWWINDOW | (p->activate ? 0 : SWP_NOACTIVATE));
  if (p->activate) {
    SetForegroundWindow(p->hwnd);
    if (p->view.controller) p->view.controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
  }
  emit("popoverShown", json{{"id", p->id}});
  return true;
}

// preload:false popovers load on first show and present once the page is ready (<= 1.5 s).
static bool show(Popover *p, const json &args, int caller, std::string &error) {
  if (p->loaded) return show_now(p, args, caller, error);
  p->loaded = true;
  p->pendingShow = true;
  p->pendingArgs = args;
  p->pendingCaller = caller;
  view_navigate(&p->view, p->url);
  SetTimer(p->hwnd, kPendingTimer, 1500, nullptr);
  return true;
}

void popover_page_ready(int nativeId) {
  bool timeout = nativeId < 0;
  Popover *p = find_native(timeout ? -nativeId : nativeId);
  if (!p) return;
  if (!timeout && !p->ready) {
    p->ready = true;
    emit("popoverReady", json{{"id", p->id}});
  }
  if (p->pendingShow) {
    p->pendingShow = false;
    KillTimer(p->hwnd, kPendingTimer);
    std::string error;
    if (!show_now(p, p->pendingArgs, p->pendingCaller, error)) fprintf(stderr, "[shell] popover %s: %s\n", p->id.c_str(), error.c_str());
  }
}

void popover_bind_tray(const std::string &id) { g_tray_popover = id; }

bool popover_tray_click() {
  auto it = g_popovers.find(g_tray_popover);
  if (g_tray_popover.empty() || it == g_popovers.end()) return false;
  Popover *p = it->second;
  if (shown(p)) {
    hide(p);
    return true;
  }
  // The click on the icon already deactivated (and hid) a transient popover:
  // that click means "close", not "reopen".
  if (GetTickCount64() - p->lastHidden < 350) return true;
  std::string error;
  if (!show(p, json{{"anchor", "tray"}}, 0, error)) fprintf(stderr, "[shell] tray popover: %s\n", error.c_str());
  return true;
}

std::string popover_id_of(int nativeId) {
  Popover *p = find_native(nativeId);
  return p ? p->id : "";
}

View *popover_view(const std::string &id) {
  auto it = g_popovers.find(id);
  return it == g_popovers.end() ? nullptr : &it->second->view;
}

bool popover_key(int nativeId, UINT vk) {
  if (vk != VK_ESCAPE) return false;
  Popover *p = find_native(nativeId);
  if (!p || !p->closeOnEscape || !shown(p)) return false;
  backend_run_on_main([id = p->id] {
    auto it = g_popovers.find(id);
    if (it != g_popovers.end()) hide(it->second);
  });
  return true;
}

// ---------------------------------------------------------------------------

using PopoverOp = std::function<void(CallPtr, Popover *)>;

static void preg(const std::string &op, PopoverOp body) {
  reg("popover", op, [body](CallPtr c) {
    // Inside a popover page, `id` defaults to that popover.
    std::string id = c->str("id");
    if (id.empty()) id = popover_id_of(c->caller);
    auto it = g_popovers.find(id);
    if (id.empty() || it == g_popovers.end()) return c->fail("invalid_args", "popover." + c->op + ": unknown popover `" + id + "`");
    body(c, it->second);
  });
}

void register_popover() {
  reg("popover", "create", [](CallPtr c) {
    std::string id = c->str("id");
    if (id.empty()) id = "popover-" + std::to_string(g_next_native);
    auto it = g_popovers.find(id);
    if (it != g_popovers.end()) destroy(it->second); // re-create replaces
    std::string error;
    Popover *p = build(c, id, error);
    if (!p) return c->fail("unavailable", error);
    g_popovers[id] = p;
    if (c->flag("tray", false)) popover_bind_tray(id);
    c->ok(describe(p));
  });
  preg("show", [](CallPtr c, Popover *p) {
    std::string error;
    if (!show(p, c->args, c->caller, error)) return c->fail("invalid_args", error);
    c->ok(describe(p));
  });
  preg("hide", [](CallPtr c, Popover *p) {
    hide(p);
    c->ok();
  });
  preg("toggle", [](CallPtr c, Popover *p) {
    if (shown(p)) {
      hide(p);
      return c->ok(json{{"shown", false}});
    }
    std::string error;
    if (!show(p, c->args, c->caller, error)) return c->fail("invalid_args", error);
    c->ok(json{{"shown", true}});
  });
  preg("setSize", [](CallPtr c, Popover *p) {
    p->width = std::max(40.0, c->num("width", p->width));
    p->height = std::max(24.0, c->num("height", p->height));
    double s = hwnd_scale(p->hwnd);
    RECT r;
    GetWindowRect(p->hwnd, &r);
    int w = (int)(p->width * s), h = (int)(p->height * s);
    int y = r.top;
    RECT t;
    if (tray_rect(t) && r.bottom <= t.top + 8) y = r.bottom - h; // opened above the tray: keep the bottom edge
    SetWindowPos(p->hwnd, nullptr, r.left, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
    emit("popoverResized", json{{"id", p->id}, {"width", p->width}, {"height", p->height}});
    c->ok();
  });
  preg("setPosition", [](CallPtr c, Popover *p) {
    if (p->style != "panel") return c->fail("unsupported", "popover.setPosition: only for style `panel` (popovers follow their anchor)");
    json position = c->args.contains("position") ? c->args["position"]
                    : c->has("x")                ? json{{"x", c->args["x"]}, {"y", c->args["y"]}}
                                                 : json();
    RECT r;
    std::string error;
    double s = hwnd_scale(p->hwnd);
    if (!panel_rect(p, position, (int)(p->width * s), (int)(p->height * s), r, error)) return c->fail("invalid_args", error);
    p->position = position;
    SetWindowPos(p->hwnd, nullptr, r.left, r.top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    c->ok();
  });
  preg("isShown", [](CallPtr c, Popover *p) { c->ok(shown(p)); });
  preg("get", [](CallPtr c, Popover *p) { c->ok(describe(p)); });
  preg("eval", [](CallPtr c, Popover *p) {
    if (!c->has("js")) return c->fail("invalid_args", "popover.eval: `js` is required");
    view_eval(&p->view, c->str("js"));
    c->ok();
  });
  preg("reload", [](CallPtr c, Popover *p) {
    if (p->view.webview) p->view.webview->Reload();
    c->ok();
  });
  preg("destroy", [](CallPtr c, Popover *p) {
    destroy(p);
    c->ok(json{{"destroyed", true}});
  });
  reg("popover", "list", [](CallPtr c) {
    json out = json::array();
    for (auto &[id, p] : g_popovers) out.push_back(describe(p));
    c->ok(out);
  });
  // Page-to-page messages (popover <-> windows): every page + the Worker.
  reg("events", "emit", [](CallPtr c) {
    std::string channel = c->str("channel");
    if (channel.empty()) return c->fail("invalid_args", "events.emit: `channel` is required");
    std::string from = popover_id_of(c->caller);
    emit("message", json{{"channel", channel},
                         {"data", c->args.contains("data") ? c->args["data"] : json(nullptr)},
                         {"from", from.empty() ? json(backend_public_window_id(c->caller)) : json(from)}});
    c->ok();
  });
}

} // namespace sd::win
