// menu.* — Win32 menu bar on every app window, popup (context) menus, live item
// updates; shared MenuItemSpec builder for tray menus.
// MenuItemSpec: {type, id, label, submenu, checked, disabled, role, accelerator}.
// Items with an id (or label) emit menuAction {id}.
// Accelerators: WebView2 owns the keyboard while the page is focused, so menu
// accelerators are matched in the controller's AcceleratorKeyPressed event
// (handle_accelerator). Edit roles (copy/paste/...) are left to the web view.
#include "win.hpp"

#include <shlobj.h>


namespace sd::win {

struct MenuItem {
  std::string id;    // menuAction id ("" for roles)
  std::string role;  // lowercase role, "" for custom items
  std::string label; // without the accelerator text
  MenuOwner owner = MenuOwner::App;
  bool legacy = false; // shell_menu_set items emit the raw {"type":"menu"} event
  bool enabled = true, checked = false;
};

struct Accel {
  UINT vk, mods, cmd;
};

static const UINT kBase[3] = {0x1000, 0x6000, 0x7000};
static const UINT kLimit[3] = {0x5fff, 0x6fff, 0x7fff};
static UINT g_next[3] = {0x1000, 0x6000, 0x7000};
static std::map<UINT, MenuItem> g_cmds;
static std::map<std::string, UINT> g_ids;
static std::vector<Accel> g_accels;
static std::vector<HMENU> g_roots[3];
static json g_app_menus;       // current [{name, items}] (null = no menu bar)
static bool g_app_legacy = false;
static HMENU g_detached_bar = nullptr; // app menu built while no window exists

void reset_menu_owner(MenuOwner owner) {
  int o = (int)owner;
  for (auto it = g_cmds.begin(); it != g_cmds.end();)
    it = it->second.owner == owner ? g_cmds.erase(it) : std::next(it);
  for (auto it = g_ids.begin(); it != g_ids.end();)
    it = (it->second >= kBase[o] && it->second <= kLimit[o]) ? g_ids.erase(it) : std::next(it);
  if (owner == MenuOwner::App) g_accels.clear();
  g_roots[o].clear();
  g_next[o] = kBase[o];
}

void track_menu_root(MenuOwner owner, HMENU menu) { g_roots[(int)owner].push_back(menu); }

// ---------------------------------------------------------------------------
// Accelerators

bool parse_accelerator(const std::string &accel, UINT &vk, UINT &mods, std::string &display, std::string &error) {
  vk = 0;
  mods = 0;
  std::string a = accel;
  while (!a.empty() && a.back() == ' ') a.pop_back();
  if (a.empty()) {
    error = "accelerator must not be empty";
    return false;
  }
  // The key is the last `+` segment; a trailing `+` means the +/= key itself ("Ctrl++").
  std::vector<std::string> parts;
  std::string cur;
  for (size_t i = 0; i < a.size(); i++) {
    if (a[i] == '+' && !cur.empty()) {
      parts.push_back(cur);
      cur.clear();
    } else cur += a[i];
  }
  parts.push_back(cur);
  std::string key = lower(parts.back());
  parts.pop_back();
  std::string modsText;
  for (auto &raw : parts) {
    std::string p = lower(raw);
    while (!p.empty() && p.front() == ' ') p.erase(p.begin());
    while (!p.empty() && p.back() == ' ') p.pop_back();
    if (p == "cmd" || p == "command" || p == "cmdorctrl" || p == "commandorcontrol" || p == "ctrl" || p == "control") mods |= MOD_CONTROL;
    else if (p == "shift") mods |= MOD_SHIFT;
    else if (p == "alt" || p == "option" || p == "altgr") mods |= MOD_ALT;
    else if (p == "super" || p == "meta" || p == "win" || p == "windows") mods |= MOD_WIN;
    else {
      error = "unknown modifier `" + p + "` in `" + accel + "`";
      return false;
    }
  }
  while (!key.empty() && key.front() == ' ') key.erase(key.begin());
  static const std::map<std::string, UINT> named = {
      {"space", VK_SPACE}, {"spacebar", VK_SPACE}, {"tab", VK_TAB}, {"enter", VK_RETURN}, {"return", VK_RETURN},
      {"backspace", VK_BACK}, {"delete", VK_DELETE}, {"del", VK_DELETE}, {"forwarddelete", VK_DELETE}, {"insert", VK_INSERT},
      {"escape", VK_ESCAPE}, {"esc", VK_ESCAPE}, {"up", VK_UP}, {"down", VK_DOWN}, {"left", VK_LEFT}, {"right", VK_RIGHT},
      {"uparrow", VK_UP}, {"downarrow", VK_DOWN}, {"leftarrow", VK_LEFT}, {"rightarrow", VK_RIGHT}, {"home", VK_HOME},
      {"end", VK_END}, {"pageup", VK_PRIOR}, {"pagedown", VK_NEXT}, {"plus", VK_OEM_PLUS}, {"+", VK_OEM_PLUS},
      {"=", VK_OEM_PLUS}, {"equal", VK_OEM_PLUS}, {"-", VK_OEM_MINUS}, {"minus", VK_OEM_MINUS}, {",", VK_OEM_COMMA},
      {"comma", VK_OEM_COMMA}, {".", VK_OEM_PERIOD}, {"period", VK_OEM_PERIOD}, {"/", VK_OEM_2}, {"slash", VK_OEM_2},
      {";", VK_OEM_1}, {"semicolon", VK_OEM_1}, {"[", VK_OEM_4}, {"leftbracket", VK_OEM_4}, {"]", VK_OEM_6},
      {"rightbracket", VK_OEM_6}, {"\\", VK_OEM_5}, {"backslash", VK_OEM_5}, {"'", VK_OEM_7}, {"quote", VK_OEM_7},
      {"`", VK_OEM_3}, {"backquote", VK_OEM_3}, {"grave", VK_OEM_3}, {"printscreen", VK_SNAPSHOT},
      {"numadd", VK_ADD}, {"numsub", VK_SUBTRACT}, {"nummult", VK_MULTIPLY}, {"numdiv", VK_DIVIDE}, {"numdec", VK_DECIMAL},
      {"volumeup", VK_VOLUME_UP}, {"volumedown", VK_VOLUME_DOWN}, {"volumemute", VK_VOLUME_MUTE},
      {"medianexttrack", VK_MEDIA_NEXT_TRACK}, {"mediaprevioustrack", VK_MEDIA_PREV_TRACK}, {"mediaplaypause", VK_MEDIA_PLAY_PAUSE},
  };
  std::string keyText;
  if (key.size() == 1 && isalnum((unsigned char)key[0])) {
    vk = (UINT)toupper((unsigned char)key[0]);
    keyText = std::string(1, (char)vk);
  } else if (named.count(key)) {
    vk = named.at(key);
    keyText = parts.empty() && key.size() == 1 ? key : std::string(1, (char)toupper((unsigned char)key[0])) + key.substr(1);
    if (key == "+" || key == "=" || key == "plus" || key == "equal") keyText = "Plus";
    if (key == "-" || key == "minus") keyText = "-";
  } else if (key.size() > 1 && key[0] == 'f' && atoi(key.c_str() + 1) >= 1 && atoi(key.c_str() + 1) <= 24) {
    vk = VK_F1 + (UINT)atoi(key.c_str() + 1) - 1;
    keyText = "F" + key.substr(1);
  } else if (key.rfind("num", 0) == 0 && key.size() == 4 && isdigit((unsigned char)key[3])) {
    vk = VK_NUMPAD0 + (UINT)(key[3] - '0');
    keyText = "Num" + key.substr(3);
  } else {
    error = key.empty() ? "`" + accel + "` needs a non-modifier key" : "unknown key `" + key + "` in `" + accel + "`";
    return false;
  }
  if (mods & MOD_CONTROL) modsText += "Ctrl+";
  if (mods & MOD_ALT) modsText += "Alt+";
  if (mods & MOD_SHIFT) modsText += "Shift+";
  if (mods & MOD_WIN) modsText += "Win+";
  display = modsText + keyText;
  return true;
}

static UINT current_mods() {
  UINT m = 0;
  if (GetKeyState(VK_CONTROL) < 0) m |= MOD_CONTROL;
  if (GetKeyState(VK_SHIFT) < 0) m |= MOD_SHIFT;
  if (GetKeyState(VK_MENU) < 0) m |= MOD_ALT;
  if (GetKeyState(VK_LWIN) < 0 || GetKeyState(VK_RWIN) < 0) m |= MOD_WIN;
  return m;
}

bool handle_accelerator(UINT vk, int nativeWindow) {
  if (g_accels.empty()) return false;
  UINT mods = current_mods();
  for (auto &a : g_accels)
    if (a.vk == vk && a.mods == mods) {
      UINT cmd = a.cmd;
      // Off the WebView2 event stack.
      backend_run_on_main([cmd, nativeWindow] { handle_menu_command(cmd, nativeWindow); });
      return true;
    }
  return false;
}

// ---------------------------------------------------------------------------
// Roles

static bool is_edit_role(const std::string &r) {
  return r == "undo" || r == "redo" || r == "cut" || r == "copy" || r == "paste" || r == "pasteandmatchstyle" ||
         r == "pasteasplaintext" || r == "delete" || r == "selectall";
}

static std::string role_title(const std::string &r) {
  static const std::map<std::string, std::string> t = {
      {"undo", "Undo"}, {"redo", "Redo"}, {"cut", "Cut"}, {"copy", "Copy"}, {"paste", "Paste"},
      {"pasteandmatchstyle", "Paste and Match Style"}, {"pasteasplaintext", "Paste as Plain Text"}, {"delete", "Delete"},
      {"selectall", "Select All"}, {"minimize", "Minimize"}, {"zoom", "Maximize"}, {"maximize", "Maximize"},
      {"close", "Close"}, {"closewindow", "Close"}, {"togglefullscreen", "Toggle Full Screen"}, {"fullscreen", "Toggle Full Screen"},
      {"reload", "Reload"}, {"forcereload", "Force Reload"}, {"toggledevtools", "Toggle Developer Tools"},
      {"zoomin", "Zoom In"}, {"zoomout", "Zoom Out"}, {"resetzoom", "Actual Size"}, {"hide", "Hide"},
      {"hideothers", "Hide Others"}, {"showall", "Show All"}, {"unhide", "Show All"}, {"front", "Bring All to Front"},
  };
  if (r == "quit") return "Exit";
  if (r == "about") return "About " + app_name();
  auto it = t.find(r);
  return it == t.end() ? "" : it->second;
}

static bool known_role(const std::string &r) {
  return !role_title(r).empty() || r == "services" || r == "help";
}

static json preset(const std::string &r) {
  if (r == "appmenu") return json::array({{{"role", "about"}}, {{"type", "separator"}}, {{"role", "quit"}, {"accelerator", "Ctrl+Q"}}});
  if (r == "filemenu") return json::array({{{"role", "close"}, {"accelerator", "Ctrl+W"}}, {{"type", "separator"}}, {{"role", "quit"}}});
  if (r == "editmenu")
    return json::array({{{"role", "undo"}, {"accelerator", "Ctrl+Z"}}, {{"role", "redo"}, {"accelerator", "Ctrl+Y"}}, {{"type", "separator"}},
                        {{"role", "cut"}, {"accelerator", "Ctrl+X"}}, {{"role", "copy"}, {"accelerator", "Ctrl+C"}},
                        {{"role", "paste"}, {"accelerator", "Ctrl+V"}}, {{"role", "delete"}}, {{"type", "separator"}},
                        {{"role", "selectAll"}, {"accelerator", "Ctrl+A"}}});
  if (r == "viewmenu")
    return json::array({{{"role", "reload"}, {"accelerator", "Ctrl+R"}}, {{"role", "toggleDevTools"}, {"accelerator", "Ctrl+Shift+I"}},
                        {{"type", "separator"}}, {{"role", "resetZoom"}, {"accelerator", "Ctrl+0"}}, {{"role", "zoomIn"}, {"accelerator", "Ctrl+Plus"}},
                        {{"role", "zoomOut"}, {"accelerator", "Ctrl+-"}}, {{"type", "separator"}}, {{"role", "togglefullscreen"}, {"accelerator", "F11"}}});
  if (r == "windowmenu" || r == "window") return json::array({{{"role", "minimize"}}, {{"role", "zoom"}}, {{"role", "close"}, {"accelerator", "Ctrl+W"}}});
  return nullptr;
}

static std::string preset_title(const std::string &r) {
  if (r == "appmenu") return app_name();
  if (r == "filemenu") return "&File";
  if (r == "editmenu") return "&Edit";
  if (r == "viewmenu") return "&View";
  if (r == "windowmenu" || r == "window") return "&Window";
  if (r == "help") return "&Help";
  return "";
}

static void send_keys(std::vector<WORD> keys) {
  std::vector<INPUT> in;
  for (WORD k : keys) {
    INPUT i{};
    i.type = INPUT_KEYBOARD;
    i.ki.wVk = k;
    in.push_back(i);
  }
  for (auto it = keys.rbegin(); it != keys.rend(); ++it) {
    INPUT i{};
    i.type = INPUT_KEYBOARD;
    i.ki.wVk = *it;
    i.ki.dwFlags = KEYEVENTF_KEYUP;
    in.push_back(i);
  }
  SendInput((UINT)in.size(), in.data(), sizeof(INPUT));
}

static Window *role_window(int nativeWindow) {
  if (Window *w = find_window(nativeWindow)) return w;
  if (Window *w = find_window_hwnd(GetForegroundWindow())) return w;
  return find_window(primary_window());
}

static void perform_role(const std::string &r, int nativeWindow, bool legacy) {
  Window *w = role_window(nativeWindow);
  if (is_edit_role(r)) {
    if (!w || !w->view.controller) return;
    // The web view handles editing natively: give it focus and replay the key.
    w->view.controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    std::vector<WORD> keys = r == "undo" ? std::vector<WORD>{VK_CONTROL, 'Z'}
                             : r == "redo" ? std::vector<WORD>{VK_CONTROL, 'Y'}
                             : r == "cut" ? std::vector<WORD>{VK_CONTROL, 'X'}
                             : r == "copy" ? std::vector<WORD>{VK_CONTROL, 'C'}
                             : r == "paste" ? std::vector<WORD>{VK_CONTROL, 'V'}
                             : r == "selectall" ? std::vector<WORD>{VK_CONTROL, 'A'}
                             : r == "delete" ? std::vector<WORD>{VK_DELETE}
                                             : std::vector<WORD>{VK_CONTROL, VK_SHIFT, 'V'};
    backend_run_on_main([keys] { send_keys(keys); });
    return;
  }
  if (r == "quit") {
    if (legacy) emit_raw(json{{"type", "quit-requested"}});
    else emit("willQuit", json::object());
    request_quit();
    return;
  }
  if (r == "about") {
    std::wstring text = wide(app_name() + "\nVersion " + app_version());
    MessageBoxW(w ? w->hwnd : nullptr, text.c_str(), wide("About " + app_name()).c_str(), MB_OK | MB_ICONINFORMATION);
    return;
  }
  if (r == "hide") {
    for (int id : window_order())
      if (Window *x = find_window(id)) ShowWindow(x->hwnd, SW_HIDE);
    return;
  }
  if (r == "showall" || r == "unhide" || r == "front") {
    for (int id : window_order())
      if (Window *x = find_window(id)) ShowWindow(x->hwnd, IsIconic(x->hwnd) ? SW_RESTORE : SW_SHOW);
    return;
  }
  if (!w) return;
  if (r == "minimize") ShowWindow(w->hwnd, SW_MINIMIZE);
  else if (r == "zoom" || r == "maximize") ShowWindow(w->hwnd, IsZoomed(w->hwnd) ? SW_RESTORE : SW_MAXIMIZE);
  else if (r == "close" || r == "closewindow") PostMessageW(w->hwnd, WM_CLOSE, 0, 0);
  else if (r == "togglefullscreen" || r == "fullscreen") set_fullscreen(w, !w->fullscreen);
  else if (r == "reload" || r == "forcereload") {
    if (w->view.webview) w->view.webview->Reload();
  } else if (r == "toggledevtools") {
    if (w->view.webview) w->view.webview->OpenDevToolsWindow();
  } else if (r == "zoomin" || r == "zoomout" || r == "resetzoom") {
    if (!w->view.controller) return;
    double z = view_zoom(&w->view);
    z = r == "resetzoom" ? 1.0 : r == "zoomin" ? std::min(5.0, z + 0.1) : std::max(0.25, z - 0.1);
    w->view.controller->put_ZoomFactor(z);
  }
}

bool handle_menu_command(UINT cmd, int nativeWindow) {
  auto it = g_cmds.find(cmd);
  if (it == g_cmds.end()) return false;
  MenuItem item = it->second; // copy: handlers may rebuild menus
  if (!item.role.empty()) perform_role(item.role, nativeWindow, item.legacy);
  else if (item.legacy) emit_raw(json{{"type", "menu"}, {"id", item.id}});
  else emit("menuAction", json{{"id", item.id}});
  return true;
}

// ---------------------------------------------------------------------------
// Builder

static bool append_items(HMENU menu, const json &items, MenuOwner owner, const std::string &ctx, std::string &error, bool legacy);

static bool append_item(HMENU menu, const json &spec, MenuOwner owner, const std::string &ctx, std::string &error, bool legacy) {
  if (!spec.is_object()) {
    error = ctx + ": menu items must be objects";
    return false;
  }
  std::string type = lower(jstr(spec, "type", "action"));
  std::string role = lower(jstr(spec, "role"));
  if (type == "separator" || type == "divider" || role == "separator") return AppendMenuW(menu, MF_SEPARATOR, 0, nullptr) != 0;
  std::string label = jstr(spec, "label", jstr(spec, "text", jstr(spec, "title")));
  json children = spec.contains("submenu") && spec["submenu"].is_array() ? spec["submenu"] : json();
  json presetItems = role.empty() ? json() : preset(role);
  if (!presetItems.is_null() && children.is_null()) {
    children = presetItems;
    if (label.empty()) label = preset_title(role);
    role.clear();
  }
  if (role == "services") return true; // macOS only
  if (role == "help" && children.is_null()) children = json::array();
  bool disabled = jbool(spec, "disabled", false) || (spec.contains("enabled") && !jbool(spec, "enabled", true));
  if (!children.is_null()) {
    if (label.empty() && role == "help") label = "&Help";
    HMENU sub = CreatePopupMenu();
    if (!append_items(sub, children, owner, ctx, error, legacy)) {
      DestroyMenu(sub);
      return false;
    }
    return AppendMenuW(menu, MF_POPUP | MF_STRING | (disabled ? MF_GRAYED : 0), reinterpret_cast<UINT_PTR>(sub), wide(label).c_str()) != 0;
  }
  if (type == "submenu") {
    error = ctx + ": type `submenu` needs a `submenu` array";
    return false;
  }
  if (!role.empty() && !known_role(role)) {
    error = ctx + ": unknown menu item role `" + jstr(spec, "role") + "`";
    return false;
  }
  int o = (int)owner;
  if (g_next[o] > kLimit[o]) {
    error = ctx + ": too many menu items";
    return false;
  }
  UINT cmd = g_next[o]++;
  MenuItem item;
  item.owner = owner;
  item.legacy = legacy;
  item.role = role;
  item.id = role.empty() ? jstr(spec, "id", label) : "";
  item.label = label.empty() ? role_title(role) : label;
  item.enabled = !disabled;
  item.checked = jbool(spec, "checked", false);
  std::string text = item.label;
  std::string accel = jstr(spec, "accelerator");
  if (!accel.empty()) {
    UINT vk, mods;
    std::string display, e;
    if (parse_accelerator(accel, vk, mods, display, e)) {
      text += "\t" + display;
      if (owner == MenuOwner::App && !is_edit_role(role)) g_accels.push_back({vk, mods, cmd});
    }
  }
  g_cmds[cmd] = item;
  if (spec.contains("id") && spec["id"].is_string()) g_ids[spec["id"].get<std::string>()] = cmd;
  UINT flags = MF_STRING | (item.enabled ? 0 : MF_GRAYED) | (item.checked ? MF_CHECKED : 0);
  return AppendMenuW(menu, flags, cmd, wide(text).c_str()) != 0;
}

static bool append_items(HMENU menu, const json &items, MenuOwner owner, const std::string &ctx, std::string &error, bool legacy) {
  if (!items.is_array()) {
    error = ctx + ": `items` must be an array";
    return false;
  }
  for (auto &spec : items)
    if (!append_item(menu, spec, owner, ctx, error, legacy)) return false;
  return true;
}

HMENU build_menu(const json &items, MenuOwner owner, const std::string &ctx, std::string &error) {
  HMENU menu = CreatePopupMenu();
  if (!append_items(menu, items, owner, ctx, error, false)) {
    DestroyMenu(menu);
    return nullptr;
  }
  return menu;
}

// A menu bar for one window from g_app_menus. Command ids restart at the base
// for every window so all bars share the same ids.
static HMENU build_bar(std::string &error) {
  g_next[0] = kBase[0];
  g_accels.clear();
  HMENU bar = CreateMenu();
  for (auto &m : g_app_menus) {
    HMENU sub = CreatePopupMenu();
    json items = m.contains("items") ? m["items"] : json::array();
    if (!append_items(sub, items, MenuOwner::App, g_app_legacy ? "shell_menu_set" : "menu.setAppMenu", error, g_app_legacy)) {
      DestroyMenu(sub);
      DestroyMenu(bar);
      return nullptr;
    }
    AppendMenuW(bar, MF_POPUP | MF_STRING, reinterpret_cast<UINT_PTR>(sub), wide(jstr(m, "name")).c_str());
  }
  return bar;
}

void attach_app_menu(Window *w) {
  if (!g_app_menus.is_array() || g_app_menus.empty()) return;
  std::string error;
  HMENU bar = build_bar(error);
  if (!bar) return;
  HMENU old = w->menu;
  w->menu = bar;
  SetMenu(w->hwnd, bar);
  g_roots[0].push_back(bar);
  if (old) DestroyMenu(old);
}

static bool apply_app_menus(const json &menus, bool legacy, std::string &error) {
  json previous = g_app_menus;
  bool previousLegacy = g_app_legacy;
  reset_menu_owner(MenuOwner::App);
  g_app_menus = menus;
  g_app_legacy = legacy;
  // Validate once before touching any window.
  HMENU probe = build_bar(error);
  if (!probe) {
    g_app_menus = previous;
    g_app_legacy = previousLegacy;
    reset_menu_owner(MenuOwner::App);
    for (int id : window_order())
      if (Window *w = find_window(id)) attach_app_menu(w);
    return false;
  }
  DestroyMenu(probe);
  reset_menu_owner(MenuOwner::App);
  if (g_detached_bar) DestroyMenu(g_detached_bar);
  g_detached_bar = nullptr;
  if (window_order().empty() && !menus.empty()) {
    // No window yet: keep a detached bar so ids exist for menu.update/get.
    std::string unused;
    g_detached_bar = build_bar(unused);
    if (g_detached_bar) g_roots[0].push_back(g_detached_bar);
  }
  for (int id : window_order()) {
    Window *w = find_window(id);
    if (!w) continue;
    if (menus.empty()) {
      SetMenu(w->hwnd, nullptr);
      if (w->menu) DestroyMenu(w->menu);
      w->menu = nullptr;
    } else {
      attach_app_menu(w);
    }
  }
  return true;
}

bool set_app_menu(const json &menus, std::string &error) {
  if (!menus.is_array()) {
    error = "menu.setAppMenu: `menus` must be an array of {name, items}";
    return false;
  }
  for (auto &m : menus)
    if (!m.is_object()) {
      error = "menu.setAppMenu: each menu is {name, items}";
      return false;
    }
  return apply_app_menus(menus, false, error);
}

bool set_legacy_menu(const json &spec, std::string &error) {
  json menus = json::array();
  for (auto &top : spec) {
    if (!top.is_object()) continue;
    menus.push_back(json{{"name", jstr(top, "label")}, {"items", top.contains("submenu") ? top["submenu"] : json::array()}});
  }
  return apply_app_menus(menus, true, error);
}

// ---------------------------------------------------------------------------
// State readers

static std::string strip_accel(const std::wstring &text) {
  auto tab = text.find(L'\t');
  return utf8(tab == std::wstring::npos ? text : text.substr(0, tab));
}

static json item_state(HMENU menu, int pos) {
  wchar_t buf[512];
  MENUITEMINFOW mii{sizeof mii};
  mii.fMask = MIIM_FTYPE | MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_STRING;
  mii.dwTypeData = buf;
  mii.cch = 511;
  if (!GetMenuItemInfoW(menu, (UINT)pos, TRUE, &mii)) return nullptr;
  if (mii.fType & MFT_SEPARATOR) return json{{"separator", true}};
  json d = {{"text", strip_accel(std::wstring(buf, mii.cch))}, {"enabled", !(mii.fState & MFS_GRAYED)}, {"checked", (mii.fState & MFS_CHECKED) != 0}};
  auto it = g_cmds.find(mii.wID);
  if (!mii.hSubMenu && it != g_cmds.end() && !it->second.id.empty()) d["id"] = it->second.id;
  if (mii.hSubMenu) {
    json sub = json::array();
    for (int i = 0, n = GetMenuItemCount(mii.hSubMenu); i < n; i++) sub.push_back(item_state(mii.hSubMenu, i));
    d["submenu"] = sub;
  }
  return d;
}

static void redraw_bars() {
  for (int id : window_order())
    if (Window *w = find_window(id))
      if (w->menu) DrawMenuBar(w->hwnd);
}

static std::vector<HMENU> all_roots() {
  std::vector<HMENU> out;
  for (auto &list : g_roots)
    for (HMENU m : list)
      if (IsMenu(m)) out.push_back(m);
  return out;
}

void register_menu() {
  reg_many("menu", {"setAppMenu", "setApplicationMenu"}, [](CallPtr c) {
    std::string error;
    json menus = c->args.contains("menus") ? c->args["menus"] : json();
    if (!set_app_menu(menus, error)) return c->fail("invalid_args", error);
    c->ok();
  });
  reg("menu", "insert", [](CallPtr c) {
    std::string name = c->str("name");
    if (name.empty()) return c->fail("invalid_args", "menu.insert: `name` is required");
    json menus = g_app_menus.is_array() ? g_app_menus : json::array();
    json entry = {{"name", name}};
    if (c->args.contains("items") && c->args["items"].is_array()) entry["items"] = c->args["items"];
    else entry["items"] = json::array({{{"label", name}, {"id", c->str("id", name)}}});
    for (size_t i = 0; i < menus.size(); i++)
      if (jstr(menus[i], "name") == name) {
        menus.erase(menus.begin() + (long)i);
        break;
      }
    size_t idx = c->has("index") ? (size_t)std::max(0.0, c->num("index", 0)) : menus.size();
    if (idx > menus.size()) idx = menus.size();
    menus.insert(menus.begin() + (long)idx, entry);
    std::string error;
    if (!set_app_menu(menus, error)) return c->fail("invalid_args", error);
    c->ok(json{{"inserted", true}, {"name", name}});
  });
  reg("menu", "remove", [](CallPtr c) {
    std::string name = c->str("name");
    json menus = g_app_menus.is_array() ? g_app_menus : json::array();
    bool removed = false;
    for (size_t i = 0; i < menus.size(); i++)
      if (jstr(menus[i], "name") == name) {
        menus.erase(menus.begin() + (long)i);
        removed = true;
        break;
      }
    std::string error;
    if (removed) set_app_menu(menus, error);
    c->ok(json{{"removed", removed}, {"name", name}});
  });
  reg("menu", "popup", [](CallPtr c) {
    std::string error;
    reset_menu_owner(MenuOwner::Popup);
    HMENU m = build_menu(c->args.contains("items") ? c->args["items"] : json::array(), MenuOwner::Popup, "menu.popup", error);
    if (!m) return c->fail("invalid_args", error);
    POINT pt;
    GetCursorPos(&pt);
    if (c->has("x") && c->has("y")) {
      double s = point_scale(pt);
      pt = POINT{(LONG)(c->num("x", 0) * s), (LONG)(c->num("y", 0) * s)};
    }
    int caller = c->caller;
    // Off the current call stack: TrackPopupMenu runs a modal loop until dismissed.
    backend_run_on_main([c, m, pt, caller] {
      Window *w = find_window(caller) ? find_window(caller) : find_window_hwnd(GetForegroundWindow());
      HWND owner = w ? w->hwnd : hidden_window();
      SetForegroundWindow(owner);
      UINT cmd = (UINT)TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, pt.x, pt.y, 0, owner, nullptr);
      PostMessageW(owner, WM_NULL, 0, 0);
      DestroyMenu(m);
      if (cmd) handle_menu_command(cmd, w ? w->id : 0);
      c->ok(json{{"dismissed", true}});
    });
  });
  reg("menu", "update", [](CallPtr c) {
    std::string id = c->str("id");
    auto it = g_ids.find(id);
    if (id.empty() || it == g_ids.end() || !g_cmds.count(it->second))
      return c->fail("invalid_args", "menu.update: unknown item id `" + id + "`");
    UINT cmd = it->second;
    MenuItem &item = g_cmds[cmd];
    std::string text = c->str("text", c->str("label", item.label));
    item.label = text;
    if (c->has("enabled")) item.enabled = c->flag("enabled", true);
    if (c->has("checked")) item.checked = c->flag("checked", false);
    std::string display;
    std::string accel = c->str("accelerator");
    if (!accel.empty()) {
      UINT vk, mods;
      std::string e;
      if (parse_accelerator(accel, vk, mods, display, e) && item.owner == MenuOwner::App) {
        g_accels.erase(std::remove_if(g_accels.begin(), g_accels.end(), [cmd](const Accel &a) { return a.cmd == cmd; }), g_accels.end());
        if (!is_edit_role(item.role)) g_accels.push_back({vk, mods, cmd});
      }
    }
    for (HMENU root : all_roots()) {
      std::wstring full = wide(display.empty() ? text : text + "\t" + display);
      if (display.empty()) { // keep the existing accelerator text
        wchar_t buf[512];
        MENUITEMINFOW cur{sizeof cur};
        cur.fMask = MIIM_STRING;
        cur.dwTypeData = buf;
        cur.cch = 511;
        if (GetMenuItemInfoW(root, cmd, FALSE, &cur)) {
          std::wstring old(buf, cur.cch);
          auto tab = old.find(L'\t');
          if (tab != std::wstring::npos) full += old.substr(tab);
        }
      }
      MENUITEMINFOW mii{sizeof mii};
      mii.fMask = MIIM_STRING | MIIM_STATE;
      mii.dwTypeData = &full[0];
      mii.fState = (item.enabled ? MFS_ENABLED : MFS_GRAYED) | (item.checked ? MFS_CHECKED : MFS_UNCHECKED);
      SetMenuItemInfoW(root, cmd, FALSE, &mii);
    }
    redraw_bars();
    c->ok();
  });
  reg("menu", "get", [](CallPtr c) {
    auto it = g_ids.find(c->str("id"));
    if (it == g_ids.end() || !g_cmds.count(it->second)) return c->ok(nullptr);
    const MenuItem &item = g_cmds[it->second];
    c->ok(json{{"id", c->str("id")}, {"text", item.label}, {"enabled", item.enabled}, {"checked", item.checked}});
  });
  reg("menu", "items", [](CallPtr c) {
    json out = json::array();
    Window *w = find_window(primary_window());
    if (w && w->menu)
      for (int i = 0, n = GetMenuItemCount(w->menu); i < n; i++) out.push_back(item_state(w->menu, i));
    c->ok(out);
  });
  reg("menu", "addRecentDocument", [](CallPtr c) {
    std::string path = c->str("path");
    if (path.empty()) return c->fail("invalid_args", "menu.addRecentDocument: `path` is required");
    std::wstring p = wide(path);
    SHAddToRecentDocs(SHARD_PATHW, p.c_str());
    c->ok();
  });
}

} // namespace sd::win
