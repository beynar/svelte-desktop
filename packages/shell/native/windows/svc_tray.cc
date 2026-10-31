// tray.* — one notification-area icon (Shell_NotifyIconW, NOTIFYICON_VERSION_4)
// with tooltip, icon, badge dot and a MenuItemSpec menu (TrackPopupMenu).
// Ops: set|create, remove|destroy, isSet|exists, getBounds, performClick.
// Events: trayClick {x,y,width,height} (icon rect, DIPs) on left click (and on
// right click when there is no menu); menu items emit menuAction {id}.
// Windows convention: the menu opens on right click, left click is trayClick
// (or toggles a bound popover).
//
// notifications.* — tray balloons (shown as toasts on Windows 10/11) through
// the tray icon, or a temporary icon when no tray item exists.
// Events: notificationResponse {tag, actionId: null} on click.
#include "win.hpp"

#include <shellapi.h>

#include <cmath>


namespace sd::win {

static const UINT WM_SD_TRAY = WM_APP + 10;
static const UINT kTrayId = 1, kNotifyId = 2;

static bool g_tray = false;
static HICON g_icon = nullptr;    // base icon (owned)
static HICON g_display = nullptr; // badged composite (owned) or nullptr
static bool g_has_badge = false;
static uint8_t g_badge[4] = {0, 0, 0, 0}; // r g b a
static std::wstring g_tip;
static HMENU g_menu = nullptr;
static bool g_temp_notify = false; // kNotifyId icon added for a notification
static std::string g_last_tag;
static int g_next_tag = 1;

static NOTIFYICONDATAW base_nid(UINT id) {
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof nid;
  nid.hWnd = hidden_window();
  nid.uID = id;
  return nid;
}

static void copy_tip(wchar_t *dst, size_t cap, const std::wstring &s) {
  wcsncpy(dst, s.c_str(), cap - 1);
  dst[cap - 1] = 0;
}

// ---------------------------------------------------------------------------
// Colors and badge

static bool parse_color(const std::string &text, uint8_t out[4]) {
  std::string s = lower(text);
  while (!s.empty() && s.front() == ' ') s.erase(s.begin());
  while (!s.empty() && s.back() == ' ') s.pop_back();
  static const std::map<std::string, std::string> named = {
      {"black", "000000"}, {"white", "ffffff"}, {"red", "ff0000"}, {"green", "008000"}, {"lime", "00ff00"}, {"blue", "0000ff"},
      {"yellow", "ffff00"}, {"orange", "ffa500"}, {"purple", "800080"}, {"pink", "ffc0cb"}, {"gray", "808080"}, {"grey", "808080"},
      {"silver", "c0c0c0"}, {"cyan", "00ffff"}, {"aqua", "00ffff"}, {"magenta", "ff00ff"}, {"fuchsia", "ff00ff"}, {"maroon", "800000"},
      {"navy", "000080"}, {"olive", "808000"}, {"teal", "008080"}, {"brown", "a52a2a"}, {"gold", "ffd700"}, {"crimson", "dc143c"},
      {"tomato", "ff6347"}, {"coral", "ff7f50"}, {"indigo", "4b0082"}, {"violet", "ee82ee"}, {"rebeccapurple", "663399"},
      {"transparent", "00000000"},
  };
  if (named.count(s)) s = "#" + named.at(s);
  if (!s.empty() && s[0] == '#') {
    std::string h = s.substr(1);
    if (h.size() == 3 || h.size() == 4) {
      std::string x;
      for (char ch : h) x += std::string(2, ch);
      h = x;
    }
    if (h.size() != 6 && h.size() != 8) return false;
    if (h.find_first_not_of("0123456789abcdef") != std::string::npos) return false;
    unsigned long long v = strtoull(h.c_str(), nullptr, 16);
    if (h.size() == 6) v = (v << 8) | 0xff;
    out[0] = (uint8_t)(v >> 24);
    out[1] = (uint8_t)(v >> 16);
    out[2] = (uint8_t)(v >> 8);
    out[3] = (uint8_t)v;
    return true;
  }
  if (s.rfind("rgb", 0) == 0) {
    auto open = s.find('('), close = s.rfind(')');
    if (open == std::string::npos || close == std::string::npos || close < open) return false;
    std::string inner = s.substr(open + 1, close - open - 1);
    for (auto &ch : inner)
      if (ch == ',' || ch == '/') ch = ' ';
    std::vector<std::string> parts;
    std::string cur;
    for (char ch : inner) {
      if (ch == ' ') {
        if (!cur.empty()) parts.push_back(cur);
        cur.clear();
      } else cur += ch;
    }
    if (!cur.empty()) parts.push_back(cur);
    if (parts.size() != 3 && parts.size() != 4) return false;
    double c[4] = {0, 0, 0, 1};
    for (size_t i = 0; i < parts.size(); i++) {
      char *end = nullptr;
      double v = strtod(parts[i].c_str(), &end);
      if (end == parts[i].c_str()) return false;
      bool pct = parts[i].back() == '%';
      c[i] = i < 3 ? (pct ? v / 100 : v / 255) : (pct ? v / 100 : v);
      c[i] = std::max(0.0, std::min(1.0, c[i]));
    }
    for (int i = 0; i < 4; i++) out[i] = (uint8_t)std::lround(c[i] * 255);
    return true;
  }
  return false;
}

static bool icon_pixels(HICON icon, std::vector<uint8_t> &px, int &w, int &h) {
  ICONINFO ii{};
  if (!GetIconInfo(icon, &ii)) return false;
  bool ok = false;
  if (ii.hbmColor) {
    BITMAP bm{};
    GetObject(ii.hbmColor, sizeof bm, &bm);
    w = bm.bmWidth;
    h = bm.bmHeight;
    BITMAPINFO bi{};
    bi.bmiHeader.biSize = sizeof bi.bmiHeader;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    px.assign((size_t)w * h * 4, 0);
    HDC dc = GetDC(nullptr);
    ok = GetDIBits(dc, ii.hbmColor, 0, (UINT)h, px.data(), &bi, DIB_RGB_COLORS) == h;
    ReleaseDC(nullptr, dc);
    bool anyAlpha = false;
    for (size_t i = 3; i < px.size(); i += 4) anyAlpha = anyAlpha || px[i];
    if (ok && !anyAlpha)
      for (size_t i = 3; i < px.size(); i += 4) px[i] = 255; // legacy icon: opaque (mask ignored)
  }
  if (ii.hbmColor) DeleteObject(ii.hbmColor);
  if (ii.hbmMask) DeleteObject(ii.hbmMask);
  return ok;
}

static HICON badged(HICON base, const uint8_t color[4]) {
  int w = GetSystemMetrics(SM_CXSMICON), h = GetSystemMetrics(SM_CYSMICON);
  std::vector<uint8_t> px;
  if (!base || !icon_pixels(base, px, w, h)) px.assign((size_t)w * h * 4, 0);
  double d = std::max(6.0, std::min(w, h) * 0.45), r = d / 2, cx = w - r, cy = r;
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      double dist = std::sqrt((x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - cy) * (y + 0.5 - cy));
      double a = std::max(0.0, std::min(1.0, r - dist + 0.5)) * color[3] / 255.0;
      if (a <= 0) continue;
      uint8_t *p = &px[((size_t)y * w + x) * 4];
      double da = p[3] / 255.0, oa = a + da * (1 - a);
      auto mix = [&](uint8_t src, uint8_t dst) { return (uint8_t)std::lround(oa > 0 ? (src * a + dst * da * (1 - a)) / oa : 0); };
      p[0] = mix(color[2], p[0]);
      p[1] = mix(color[1], p[1]);
      p[2] = mix(color[0], p[2]);
      p[3] = (uint8_t)std::lround(oa * 255);
    }
  return icon_from_bgra(px, (UINT)w, (UINT)h);
}

static HICON current_icon() {
  if (g_display) DestroyIcon(g_display);
  g_display = nullptr;
  HICON base = g_icon ? g_icon : app_icon(true);
  if (g_has_badge) g_display = badged(base, g_badge);
  return g_display ? g_display : base;
}

// ---------------------------------------------------------------------------

static bool add_tray_icon() {
  NOTIFYICONDATAW nid = base_nid(kTrayId);
  nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
  nid.uCallbackMessage = WM_SD_TRAY;
  nid.hIcon = current_icon();
  copy_tip(nid.szTip, ARRAYSIZE(nid.szTip), g_tip);
  if (!Shell_NotifyIconW(NIM_ADD, &nid)) return false;
  nid.uVersion = NOTIFYICON_VERSION_4;
  Shell_NotifyIconW(NIM_SETVERSION, &nid);
  return true;
}

static void update_tray_icon() {
  NOTIFYICONDATAW nid = base_nid(kTrayId);
  nid.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP;
  nid.hIcon = current_icon();
  copy_tip(nid.szTip, ARRAYSIZE(nid.szTip), g_tip);
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

bool tray_rect(RECT &out) {
  if (!g_tray) return false;
  NOTIFYICONIDENTIFIER id{};
  id.cbSize = sizeof id;
  id.hWnd = hidden_window();
  id.uID = kTrayId;
  return SUCCEEDED(Shell_NotifyIconGetRect(&id, &out));
}

static json tray_rect_json() {
  RECT r;
  if (!tray_rect(r)) return nullptr;
  return screen_rect_dip(r);
}

static void tray_click() {
  popover_tray_click(); // a bound popover toggles natively, no JS round trip
  json r = tray_rect_json();
  emit("trayClick", r.is_null() ? json::object() : r);
}

static void show_tray_menu(POINT pt) {
  HWND owner = hidden_window();
  SetForegroundWindow(owner); // otherwise the menu doesn't close when clicking elsewhere
  UINT cmd = (UINT)TrackPopupMenu(g_menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY | TPM_BOTTOMALIGN, pt.x, pt.y, 0, owner, nullptr);
  PostMessageW(owner, WM_NULL, 0, 0);
  if (cmd) handle_menu_command(cmd, 0);
}

static void remove_temp_notify() {
  if (!g_temp_notify) return;
  NOTIFYICONDATAW nid = base_nid(kNotifyId);
  Shell_NotifyIconW(NIM_DELETE, &nid);
  g_temp_notify = false;
}

static void tray_set(CallPtr c) {
  const json &a = c->args;
  std::string error;
  bool iconGiven = false;
  HICON icon = nullptr;
  int size = GetSystemMetrics(SM_CXSMICON);
  if (a.contains("imageName") && a["imageName"].is_string()) {
    iconGiven = true;
    icon = load_icon(json{{"native", a["imageName"]}}, size, "tray.set", error);
    if (!icon) return c->fail("invalid_args", error);
  } else if ((a.contains("imagePath") && a["imagePath"].is_string()) || (a.contains("image") && a["image"].is_string())) {
    iconGiven = true;
    icon = load_icon(json{{"path", a.contains("imagePath") ? a["imagePath"] : a["image"]}}, size, "tray.set", error);
    if (!icon) return c->fail("unavailable", error);
  } else if (a.contains("icon") && !a["icon"].is_null()) {
    iconGiven = true;
    icon = load_icon(a["icon"], size, "tray.set", error);
    if (!icon) return c->fail("invalid_args", error);
  } else if ((a.contains("imageName") && a["imageName"].is_null()) || (a.contains("imagePath") && a["imagePath"].is_null()) ||
             (a.contains("icon") && a["icon"].is_null())) {
    iconGiven = true; // explicit null: back to the app icon
  }
  bool badgeGiven = a.contains("badgeColor");
  uint8_t badge[4] = {0, 0, 0, 0};
  if (badgeGiven && !a["badgeColor"].is_null()) {
    if (!a["badgeColor"].is_string()) {
      if (icon) DestroyIcon(icon);
      return c->fail("invalid_args", "tray.set: `badgeColor` needs a color string");
    }
    if (!parse_color(a["badgeColor"].get<std::string>(), badge)) {
      if (icon) DestroyIcon(icon);
      return c->fail("invalid_args", "tray.set: unknown `badgeColor` `" + a["badgeColor"].get<std::string>() + "`");
    }
  }
  HMENU menu = nullptr;
  bool menuGiven = a.contains("menu");
  if (menuGiven && !a["menu"].is_null()) {
    json items = a["menu"].is_object() && a["menu"].contains("items") ? a["menu"]["items"] : a["menu"];
    if (!items.is_array()) {
      if (icon) DestroyIcon(icon);
      return c->fail("invalid_args", "tray.set: `menu` needs an `items` array");
    }
    reset_menu_owner(MenuOwner::Tray);
    menu = build_menu(items, MenuOwner::Tray, "tray.set", error);
    if (!menu) {
      if (icon) DestroyIcon(icon);
      return c->fail("invalid_args", error);
    }
  }

  if (iconGiven) {
    if (g_icon) DestroyIcon(g_icon);
    g_icon = icon;
  }
  if (badgeGiven) {
    g_has_badge = !a["badgeColor"].is_null();
    memcpy(g_badge, badge, 4);
  }
  if (a.contains("tooltip")) g_tip = wide(c->str("tooltip"));
  else if (a.contains("title") && g_tip.empty()) g_tip = wide(c->str("title")); // no title text in the notification area
  if (g_tip.empty()) g_tip = wide(app_name());
  if (menuGiven) {
    if (g_menu) DestroyMenu(g_menu);
    g_menu = menu;
    if (menu) track_menu_root(MenuOwner::Tray, menu);
  }
  if (!g_tray) {
    if (!add_tray_icon()) return c->fail("unavailable", "tray.set: Shell_NotifyIcon failed (" + last_error_message() + ")");
    g_tray = true;
  } else {
    update_tray_icon();
  }
  if (a.contains("popover")) popover_bind_tray(c->str("popover"));
  c->ok(json{{"set", true}});
}

static void tray_remove(CallPtr c) {
  if (!g_tray) return c->ok(json{{"removed", false}});
  NOTIFYICONDATAW nid = base_nid(kTrayId);
  Shell_NotifyIconW(NIM_DELETE, &nid);
  g_tray = false;
  popover_bind_tray("");
  if (g_icon) DestroyIcon(g_icon);
  if (g_display) DestroyIcon(g_display);
  if (g_menu) DestroyMenu(g_menu);
  g_icon = g_display = nullptr;
  g_menu = nullptr;
  g_has_badge = false;
  g_tip.clear();
  c->ok(json{{"removed", true}});
}

// ---------------------------------------------------------------------------
// notifications

static void show_notification(CallPtr c) {
  if (!(c->args.contains("title") && c->args["title"].is_string()))
    return c->fail("invalid_args", "notifications.show: `title` must be a string");
  std::string tag = c->str("tag");
  if (tag.empty()) tag = "notification-" + std::to_string(g_next_tag++);
  UINT id = kTrayId;
  if (!g_tray) {
    id = kNotifyId;
    if (!g_temp_notify) {
      NOTIFYICONDATAW nid = base_nid(kNotifyId);
      nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
      nid.uCallbackMessage = WM_SD_TRAY;
      nid.hIcon = app_icon(true);
      copy_tip(nid.szTip, ARRAYSIZE(nid.szTip), wide(app_name()));
      if (!Shell_NotifyIconW(NIM_ADD, &nid)) return c->fail("unavailable", "notifications.show: Shell_NotifyIcon failed");
      nid.uVersion = NOTIFYICON_VERSION_4;
      Shell_NotifyIconW(NIM_SETVERSION, &nid);
      g_temp_notify = true;
    }
  }
  NOTIFYICONDATAW nid = base_nid(id);
  nid.uFlags = NIF_INFO;
  copy_tip(nid.szInfoTitle, ARRAYSIZE(nid.szInfoTitle), wide(c->str("title")));
  std::string body = c->str("body", c->str("message"));
  copy_tip(nid.szInfo, ARRAYSIZE(nid.szInfo), wide(body.empty() ? " " : body));
  nid.dwInfoFlags = NIIF_USER | NIIF_LARGE_ICON | NIIF_RESPECT_QUIET_TIME | (c->flag("silent", false) ? NIIF_NOSOUND : 0);
  nid.hBalloonIcon = app_icon(false);
  if (!Shell_NotifyIconW(NIM_MODIFY, &nid)) return c->fail("unavailable", "notifications.show: the balloon could not be shown");
  g_last_tag = tag;
  c->ok(json{{"tag", tag}});
}

void register_notifications() {
  reg_many("notifications", {"show", "notify"}, [](CallPtr c) { show_notification(c); });
  reg_many("notifications", {"dismiss", "close"}, [](CallPtr c) {
    std::string tag = c->str("tag");
    if (tag.empty()) return c->fail("invalid_args", "notifications.dismiss: `tag` must be a string");
    if (tag == g_last_tag) {
      NOTIFYICONDATAW nid = base_nid(g_tray ? kTrayId : kNotifyId);
      nid.uFlags = NIF_INFO; // empty text hides the balloon
      Shell_NotifyIconW(NIM_MODIFY, &nid);
      remove_temp_notify();
      g_last_tag.clear();
    }
    c->ok();
  });
  reg("notifications", "getPermissionStatus", [](CallPtr c) { c->ok(json{{"status", "granted"}}); });
  reg("notifications", "requestPermission", [](CallPtr c) { c->ok(json{{"status", "granted"}}); });
}

// ---------------------------------------------------------------------------

void register_tray() {
  static UINT taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
  reg_many("tray", {"set", "create"}, [](CallPtr c) { tray_set(c); });
  reg_many("tray", {"remove", "destroy"}, [](CallPtr c) { tray_remove(c); });
  reg_many("tray", {"isSet", "exists"}, [](CallPtr c) { c->ok(g_tray); });
  reg("tray", "getBounds", [](CallPtr c) { c->ok(tray_rect_json()); });
  reg("tray", "performClick", [](CallPtr c) {
    if (!g_tray) return c->fail("unavailable", "tray.performClick: no tray icon is set");
    tray_click();
    c->ok(json{{"clicked", true}});
  });
  add_hidden_hook([](HWND, UINT msg, WPARAM wp, LPARAM lp, LRESULT *) {
    if (msg == taskbarCreated) { // Explorer restarted: icons must be re-added
      if (g_tray) add_tray_icon();
      g_temp_notify = false;
      return false;
    }
    if (msg != WM_SD_TRAY) return false;
    UINT event = LOWORD(lp), id = HIWORD(lp);
    POINT pt{(short)LOWORD(wp), (short)HIWORD(wp)};
    switch (event) {
      case NIN_SELECT:
      case NIN_KEYSELECT:
        if (id == kTrayId) tray_click();
        break;
      case WM_CONTEXTMENU:
        if (id != kTrayId) break;
        if (g_menu) show_tray_menu(pt);
        else tray_click();
        break;
      case NIN_BALLOONUSERCLICK:
        if (!g_last_tag.empty()) emit("notificationResponse", json{{"tag", g_last_tag}, {"actionId", nullptr}});
        g_last_tag.clear();
        if (id == kNotifyId) remove_temp_notify();
        break;
      case NIN_BALLOONTIMEOUT:
      case NIN_BALLOONHIDE:
        if (id == kNotifyId) remove_temp_notify();
        break;
    }
    return true;
  });
  add_quit_hook([] {
    if (g_tray) {
      NOTIFYICONDATAW nid = base_nid(kTrayId);
      Shell_NotifyIconW(NIM_DELETE, &nid);
      g_tray = false;
    }
    remove_temp_notify();
  });
}

} // namespace sd::win
