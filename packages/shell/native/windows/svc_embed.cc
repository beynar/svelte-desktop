// view.* — extra WebView2 controllers embedded in a window (Electron's BrowserView),
// same ops and events as native/platform_view.mm and native/linux/svc_view.cc:
//   create {id?, windowId?, url|route, bounds:{x,y,width,height}, autoresize?, transparent?, debug?} → {id, windowId}
//   setBounds · getBounds · navigate {url|route} · show · hide · reload · getInfo
//   executeJavaScript {code} → JSON · list · destroy
// Each view is a child HWND of the window (DIP bounds × the monitor scale) hosting
// its own controller; navigation is browser-like (any web origin) and the bridge
// only answers the app origin's top-level document (on_bridge_message).
// Events: viewLoaded, viewNavigated, viewFailed (shell_win.cc handlers), viewTitle.
//
// capture.* — displays (EnumDisplayMonitors) and top-level windows (EnumWindows),
// PNG stills through GDI (BitBlt / PrintWindow) + WIC: {width, height, pngBase64}.
#include "win.hpp"

#include <dwmapi.h>

#include <set>

namespace sd::win {

/// A CoTaskMem string from WebView2 → UTF-8 (freed).
static std::string take_string(LPWSTR s) {
  std::string out = s ? utf8(s) : std::string();
  CoTaskMemFree(s);
  return out;
}

// ===========================================================================
// view.*

struct Embedded {
  std::string ident;
  int window = 0; // native window id
  HWND child = nullptr;
  View view;
  std::string autoresize = "none";
  double x = 0, y = 0, w = 0, h = 0;       // DIP
  double right = 0, bottom = 0;            // kept by autoresize
};

static std::map<std::string, Embedded *> g_embedded;
static int g_next_embed = 2000;
static const wchar_t *kEmbedClass = L"SvelteDesktopEmbeddedView";

static double scale_of(HWND hwnd) { return monitor_scale(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)); }

static void client_dip(Window *w, double &cw, double &ch) {
  RECT r{};
  GetClientRect(w->hwnd, &r);
  double s = scale_of(w->hwnd);
  cw = (r.right - r.left) / s;
  ch = (r.bottom - r.top) / s;
}

static void place(Embedded *e) {
  Window *w = find_window(e->window);
  if (!w || !e->child) return;
  double s = scale_of(w->hwnd);
  SetWindowPos(e->child, HWND_TOP, (int)(e->x * s), (int)(e->y * s), std::max(1, (int)(e->w * s)), std::max(1, (int)(e->h * s)), SWP_NOACTIVATE);
  view_resize(&e->view);
}

static LRESULT CALLBACK embed_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_SIZE) {
    if (auto *e = reinterpret_cast<Embedded *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) view_resize(&e->view);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

static void ensure_class() {
  static bool done = false;
  if (done) return;
  WNDCLASSEXW wc{sizeof wc};
  wc.lpfnWndProc = embed_proc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = kEmbedClass;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  RegisterClassExW(&wc);
  done = true;
}

void embedded_views_resized(Window *w) {
  double cw = 0, ch = 0;
  client_dip(w, cw, ch);
  for (auto &[id, e] : g_embedded) {
    if (e->window != w->id) continue;
    bool width = e->autoresize == "width" || e->autoresize == "both", height = e->autoresize == "height" || e->autoresize == "both";
    if (width) e->w = std::max(1.0, cw - e->x - e->right);
    if (height) e->h = std::max(1.0, ch - e->y - e->bottom);
    place(e);
  }
}

static std::string url_from(const CallPtr &c) {
  std::string u = c->str("url");
  if (!u.empty()) return u;
  std::string route = c->str("route"), origin = app_origin();
  if (route.empty() || origin.empty()) return "";
  return origin + (route[0] == '/' ? route : "/" + route);
}

static void destroy_embedded(Embedded *e) {
  if (e->view.webview) e->view.webview->remove_DocumentTitleChanged(e->view.tokens[7]);
  view_destroy(&e->view);
  if (e->child && IsWindow(e->child)) DestroyWindow(e->child);
  g_embedded.erase(e->ident);
  delete e;
}

using EmbedOp = std::function<void(CallPtr, Embedded *)>;
static void op(const std::string &name, EmbedOp body) {
  reg("view", name, [name, body](CallPtr c) {
    auto it = g_embedded.find(c->str("id"));
    if (it == g_embedded.end()) return c->fail("invalid_args", "view." + name + ": unknown view `" + c->str("id") + "`");
    if (!find_window(it->second->window)) {
      destroy_embedded(it->second);
      return c->fail("invalid_args", "view: its window is closed");
    }
    body(c, it->second);
  });
}

static void register_view_ops() {
  reg("view", "create", [](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    if (!w) return c->fail("invalid_args", "view.create: no such window");
    if (!c->args.contains("bounds") || !c->args["bounds"].is_object()) return c->fail("invalid_args", "view.create: `bounds` {x,y,width,height} is required");
    std::string url = url_from(c);
    if (url.empty()) return c->fail("invalid_args", "view.create: `url` or `route` is required");
    std::string ident = c->str("id", "view-" + std::to_string(g_next_embed));
    if (auto old = g_embedded.find(ident); old != g_embedded.end()) destroy_embedded(old->second);
    const json &b = c->args["bounds"];
    auto *e = new Embedded;
    e->ident = ident;
    e->window = w->id;
    e->autoresize = c->str("autoresize", "none");
    e->x = jnum(b, "x", 0), e->y = jnum(b, "y", 0), e->w = jnum(b, "width", 300), e->h = jnum(b, "height", 200);
    double cw = 0, ch = 0;
    client_dip(w, cw, ch);
    e->right = std::max(0.0, cw - e->x - e->w);
    e->bottom = std::max(0.0, ch - e->y - e->h);
    ensure_class();
    e->child = CreateWindowExW(0, kEmbedClass, L"", WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS, 0, 0, 1, 1, w->hwnd, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!e->child) {
      delete e;
      return c->fail("internal", "view.create: cannot create the child window");
    }
    SetWindowLongPtrW(e->child, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(e));
    g_embedded[ident] = e;
    e->view.id = g_next_embed++;
    e->view.host = e->child;
    e->view.debug = c->flag("debug", false);
    e->view.contextMenu = e->view.debug;
    e->view.transparent = c->flag("transparent", false);
    e->view.browserView = ident;
    views()[e->view.id] = &e->view;
    place(e);
    view_create(&e->view);
    view_when_ready(&e->view, [e]() {
      auto *onTitle = new Cb<ICoreWebView2DocumentTitleChangedEventHandler, ICoreWebView2 *, IUnknown *>(
          IID_ICoreWebView2DocumentTitleChangedEventHandler, [ident = e->ident](ICoreWebView2 *sender, IUnknown *) -> HRESULT {
            LPWSTR t = nullptr;
            sender->get_DocumentTitle(&t);
            emit("viewTitle", json{{"id", ident}, {"title", take_string(t)}});
            return S_OK;
          });
      e->view.webview->add_DocumentTitleChanged(onTitle, &e->view.tokens[7]);
      onTitle->Release();
    });
    view_navigate(&e->view, url);
    c->ok(json{{"id", ident}, {"windowId", backend_public_window_id(w->id)}});
  });
  op("setBounds", [](CallPtr c, Embedded *e) {
    e->x = c->num("x", e->x), e->y = c->num("y", e->y), e->w = c->num("width", e->w), e->h = c->num("height", e->h);
    if (Window *w = find_window(e->window)) {
      double cw = 0, ch = 0;
      client_dip(w, cw, ch);
      e->right = std::max(0.0, cw - e->x - e->w);
      e->bottom = std::max(0.0, ch - e->y - e->h);
    }
    place(e);
    c->ok();
  });
  op("getBounds", [](CallPtr c, Embedded *e) { c->ok(json{{"x", e->x}, {"y", e->y}, {"width", e->w}, {"height", e->h}}); });
  op("navigate", [](CallPtr c, Embedded *e) {
    std::string url = url_from(c);
    if (url.empty()) return c->fail("invalid_args", "view.navigate: `url` or `route` is required");
    view_navigate(&e->view, url);
    c->ok();
  });
  op("show", [](CallPtr c, Embedded *e) {
    ShowWindow(e->child, SW_SHOWNA);
    if (e->view.controller) e->view.controller->put_IsVisible(TRUE);
    c->ok();
  });
  op("hide", [](CallPtr c, Embedded *e) {
    ShowWindow(e->child, SW_HIDE);
    if (e->view.controller) e->view.controller->put_IsVisible(FALSE);
    c->ok();
  });
  op("reload", [](CallPtr c, Embedded *e) {
    view_when_ready(&e->view, [e]() { e->view.webview->Reload(); });
    c->ok();
  });
  op("getInfo", [](CallPtr c, Embedded *e) {
    json url = nullptr, title = "";
    if (e->view.webview) {
      LPWSTR src = nullptr, t = nullptr;
      e->view.webview->get_Source(&src);
      e->view.webview->get_DocumentTitle(&t);
      std::string u = take_string(src);
      if (!u.empty()) url = u;
      title = take_string(t);
    }
    c->ok(json{{"id", e->ident}, {"url", url}, {"title", title}, {"loading", !e->view.ready}, {"hidden", !IsWindowVisible(e->child)}});
  });
  op("executeJavaScript", [](CallPtr c, Embedded *e) {
    if (!c->has("code")) return c->fail("invalid_args", "view.executeJavaScript: `code` is required");
    view_execute(&e->view, c->str("code"), [c](bool ok, const json &value, const std::string &error) {
      ok ? c->ok(value) : c->fail("internal", "view.executeJavaScript: " + error);
    });
  });
  op("destroy", [](CallPtr c, Embedded *e) {
    destroy_embedded(e);
    c->ok(json{{"destroyed", true}});
  });
  reg("view", "list", [](CallPtr c) {
    json out = json::array();
    for (auto it = g_embedded.begin(); it != g_embedded.end();) {
      Embedded *e = (it++)->second;
      if (!find_window(e->window)) {
        destroy_embedded(e);
        continue;
      }
      json url = nullptr;
      if (e->view.webview) {
        LPWSTR src = nullptr;
        e->view.webview->get_Source(&src);
        std::string u = take_string(src);
        if (!u.empty()) url = u;
      }
      out.push_back(json{{"id", e->ident}, {"windowId", backend_public_window_id(e->window)}, {"url", url}});
    }
    c->ok(out);
  });
}

// ===========================================================================
// capture.*

static bool bitmap_png(HDC src, int x, int y, int w, int h, HWND printWindow, std::string &png) {
  if (w <= 0 || h <= 0) return false;
  HDC mem = CreateCompatibleDC(src);
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = w;
  bi.bmiHeader.biHeight = -h; // top-down
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void *bits = nullptr;
  HBITMAP bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bmp) {
    DeleteDC(mem);
    return false;
  }
  HGDIOBJ old = SelectObject(mem, bmp);
  bool ok = printWindow ? PrintWindow(printWindow, mem, 2 /* PW_RENDERFULLCONTENT */) != 0 : BitBlt(mem, 0, 0, w, h, src, x, y, SRCCOPY | CAPTUREBLT) != 0;
  if (ok) {
    auto *px = static_cast<uint8_t *>(bits);
    for (size_t i = 3; i < (size_t)w * h * 4; i += 4) px[i] = 255; // GDI leaves alpha undefined
    ok = wic_encode(px, (UINT)w, (UINT)h, (UINT)w * 4, false, 1, png);
  }
  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
  return ok;
}

struct MonitorEntry {
  HMONITOR mon;
  RECT rect;
  bool primary;
  std::wstring device;
};

static std::vector<MonitorEntry> monitors() {
  std::vector<MonitorEntry> out;
  EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR m, HDC, LPRECT, LPARAM lp) -> BOOL {
    MONITORINFOEXW mi{};
    mi.cbSize = sizeof mi;
    GetMonitorInfoW(m, &mi);
    reinterpret_cast<std::vector<MonitorEntry> *>(lp)->push_back({m, mi.rcMonitor, (mi.dwFlags & MONITORINFOF_PRIMARY) != 0, mi.szDevice});
    return TRUE;
  }, reinterpret_cast<LPARAM>(&out));
  return out;
}

static bool capturable(HWND h) {
  if (!IsWindowVisible(h) || GetWindow(h, GW_OWNER) || (GetWindowLongPtrW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW)) return false;
  BOOL cloaked = FALSE;
  DwmGetWindowAttribute(h, DWMWA_CLOAKED, &cloaked, sizeof cloaked);
  return !cloaked && GetWindowTextLengthW(h) > 0;
}

static void register_capture_ops() {
  reg("capture", "isSupported", [](CallPtr c) { c->ok(json{{"supported", true}}); });
  reg("capture", "getSources", [](CallPtr c) {
    std::set<std::string> types;
    if (c->args.contains("types") && c->args["types"].is_array())
      for (const auto &t : c->args["types"])
        if (t.is_string()) types.insert(t.get<std::string>());
    bool all = types.empty();
    json out = json::array();
    if (all || types.count("display") || types.count("screen")) {
      int i = 0;
      for (auto &m : monitors()) {
        i++;
        out.push_back(json{{"id", i}, {"type", "display"}, {"label", utf8(m.device)}, {"isMain", m.primary},
                           {"resolution", {{"width", m.rect.right - m.rect.left}, {"height", m.rect.bottom - m.rect.top}}}});
      }
    }
    if (all || types.count("window")) {
      std::vector<HWND> wins;
      EnumWindows([](HWND h, LPARAM lp) -> BOOL {
        if (capturable(h)) reinterpret_cast<std::vector<HWND> *>(lp)->push_back(h);
        return TRUE;
      }, reinterpret_cast<LPARAM>(&wins));
      for (HWND h : wins) {
        wchar_t title[512];
        int n = GetWindowTextW(h, title, 511);
        RECT r{};
        GetWindowRect(h, &r);
        out.push_back(json{{"id", (double)(uintptr_t)h}, {"type", "window"}, {"label", utf8(std::wstring(title, n))}, {"isMain", nullptr},
                           {"resolution", {{"width", r.right - r.left}, {"height", r.bottom - r.top}}}});
      }
    }
    c->ok(out);
  });
  reg("capture", "captureSource", [](CallPtr c) {
    if (!c->has("id")) return c->fail("invalid_args", "capture.captureSource: `id` is required");
    std::string type = c->str("type", "");
    double ident = c->num("id", 0);
    auto mons = monitors();
    std::string png;
    int w = 0, h = 0;
    if (type == "display" || (type.empty() && ident >= 1 && ident <= (double)mons.size())) {
      int i = (int)ident - 1;
      if (i < 0 || i >= (int)mons.size()) return c->fail("invalid_args", "capture.captureSource: unknown display");
      RECT r = mons[i].rect;
      w = r.right - r.left, h = r.bottom - r.top;
      HDC screen = GetDC(nullptr);
      bool ok = bitmap_png(screen, r.left, r.top, w, h, nullptr, png);
      ReleaseDC(nullptr, screen);
      if (!ok) return c->fail("internal", "capture.captureSource: screen capture failed");
    } else {
      HWND hwnd = reinterpret_cast<HWND>((uintptr_t)ident);
      if (!IsWindow(hwnd)) return c->fail("invalid_args", "capture.captureSource: unknown window");
      RECT r{};
      GetWindowRect(hwnd, &r);
      w = r.right - r.left, h = r.bottom - r.top;
      HDC screen = GetDC(nullptr);
      bool ok = bitmap_png(screen, 0, 0, w, h, hwnd, png);
      ReleaseDC(nullptr, screen);
      if (!ok) return c->fail("internal", "capture.captureSource: window capture failed");
    }
    c->ok(json{{"width", w}, {"height", h}, {"pngBase64", base64_encode(png.data(), png.size())}});
  });
}

void register_embed() {
  register_view_ops();
  register_capture_ops();
}

} // namespace sd::win
