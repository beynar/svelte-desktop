// screen.*, theme.*, power.*, shortcuts.*, shell.*, secureStorage.*
#include "win.hpp"

#include <shellapi.h>
#include <shlobj.h>
#include <wincred.h>
#include <wtsapi32.h>


namespace sd::win {

// ===========================================================================
// screen.* — monitors in DIPs (each scaled by its own factor). Events: displaysChanged.

static json display_info(HMONITOR mon) {
  MONITORINFOEXW mi{};
  mi.cbSize = sizeof mi;
  GetMonitorInfoW(mon, &mi);
  double s = monitor_scale(mon);
  auto dip = [s](const RECT &r) { return rect_json(r.left / s, r.top / s, (r.right - r.left) / s, (r.bottom - r.top) / s); };
  std::string device = utf8(mi.szDevice);
  std::string label = device;
  DISPLAY_DEVICEW dd{};
  dd.cb = sizeof dd;
  if (EnumDisplayDevicesW(mi.szDevice, 0, &dd, 0) && dd.DeviceString[0]) label = utf8(dd.DeviceString);
  // Stable numeric id from the GDI device name (\\.\DISPLAY1 -> 1).
  int id = 0;
  for (char ch : device)
    if (isdigit((unsigned char)ch)) id = id * 10 + (ch - '0');
  return json{{"id", id},
              {"uuid", device},
              {"label", label},
              {"bounds", dip(mi.rcMonitor)},
              {"workArea", dip(mi.rcWork)},
              {"scaleFactor", s},
              {"isPrimary", (mi.dwFlags & MONITORINFOF_PRIMARY) != 0}};
}

static BOOL CALLBACK collect_monitor(HMONITOR mon, HDC, LPRECT, LPARAM data) {
  reinterpret_cast<json *>(data)->push_back(display_info(mon));
  return TRUE;
}

void register_screen() {
  reg("screen", "getAllDisplays", [](CallPtr c) {
    json list = json::array();
    EnumDisplayMonitors(nullptr, nullptr, collect_monitor, reinterpret_cast<LPARAM>(&list));
    c->ok(list);
  });
  reg("screen", "getPrimaryDisplay", [](CallPtr c) {
    POINT origin{0, 0};
    c->ok(display_info(MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY)));
  });
  reg("screen", "getDisplayNearestWindow", [](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    POINT origin{0, 0};
    c->ok(display_info(w ? MonitorFromWindow(w->hwnd, MONITOR_DEFAULTTONEAREST) : MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY)));
  });
  reg("screen", "getCursorScreenPoint", [](CallPtr c) {
    POINT p;
    GetCursorPos(&p);
    double s = point_scale(p);
    c->ok(json{{"x", p.x / s}, {"y", p.y / s}});
  });
  reg("screen", "scaleFactor", [](CallPtr c) {
    POINT origin{0, 0};
    c->ok(monitor_scale(MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY)));
  });
  add_hidden_hook([](HWND, UINT msg, WPARAM, LPARAM, LRESULT *) {
    if (msg == WM_DISPLAYCHANGE) emit("displaysChanged", json::object());
    return false;
  });
}

// ===========================================================================
// theme.* — AppsUseLightTheme + an app-level override (theme.set) applied to
// title bars (DWM dark mode) and pages (prefers-color-scheme via the WebView2
// profile). Events: appearanceChanged {appearance, dark}.

static std::string g_pref = "system";
static bool g_last_dark = false;

bool app_dark() {
  if (g_pref == "dark") return true;
  if (g_pref == "light") return false;
  return system_dark();
}

static json theme_info() {
  bool dark = app_dark();
  return json{{"appearance", dark ? "dark" : "light"}, {"dark", dark}};
}

void theme_apply_window(Window *w) {
  bool dark = w->theme == "dark" ? true : w->theme == "light" ? false : app_dark();
  set_dark_title_bar(w->hwnd, dark);
  if (w->view.webview) theme_apply_view(&w->view);
}

void theme_apply_view(View *v) {
  if (!v->webview) return;
  auto *wv13 = query<ICoreWebView2_13>(v->webview, IID_ICoreWebView2_13);
  if (!wv13) return;
  ICoreWebView2Profile *profile = nullptr;
  if (SUCCEEDED(wv13->get_Profile(&profile)) && profile) {
    Window *w = find_window(v->id);
    std::string pref = w && w->theme != "system" ? w->theme : g_pref;
    profile->put_PreferredColorScheme(pref == "dark" ? COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK
                                      : pref == "light" ? COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT
                                                        : COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO);
    profile->Release();
  }
  wv13->Release();
}

static void theme_changed() {
  bool dark = app_dark();
  for (int id : window_order())
    if (Window *w = find_window(id)) theme_apply_window(w);
  if (dark == g_last_dark) return;
  g_last_dark = dark;
  emit("appearanceChanged", theme_info());
}

void register_theme() {
  g_last_dark = app_dark();
  reg_many("theme", {"get", "getAppearance"}, [](CallPtr c) { c->ok(theme_info()); });
  reg_many("theme", {"set", "setAppearance"}, [](CallPtr c) {
    std::string a = c->str("appearance", "system");
    if (a == "vibrantLight") a = "light";
    if (a == "vibrantDark") a = "dark";
    if (a != "system" && a != "light" && a != "dark")
      return c->fail("invalid_args", "theme.set: appearance must be system|light|dark|vibrantLight|vibrantDark");
    g_pref = a;
    for (auto &[id, v] : views()) theme_apply_view(v);
    theme_changed();
    c->ok(theme_info());
  });
  reg("theme", "shouldUseDarkColors", [](CallPtr c) { c->ok(app_dark()); });
  add_hidden_hook([](HWND, UINT msg, WPARAM, LPARAM lp, LRESULT *) {
    if (msg == WM_SETTINGCHANGE && lp && wcscmp(reinterpret_cast<const wchar_t *>(lp), L"ImmersiveColorSet") == 0) theme_changed();
    return false;
  });
}

// ===========================================================================
// power.* — idle time, battery, sleep blocks (SetThreadExecutionState on the UI
// thread). Events: systemSleep, systemWake, screenLocked, screenUnlocked,
// displaySleep, displayWake.

static std::map<int, std::string> g_blocks;
static int g_next_block = 1;

static void apply_execution_state() {
  EXECUTION_STATE flags = ES_CONTINUOUS;
  for (auto &[id, type] : g_blocks) {
    flags |= ES_SYSTEM_REQUIRED;
    if (type == "display") flags |= ES_DISPLAY_REQUIRED;
  }
  SetThreadExecutionState(flags);
}

void register_power() {
  reg("power", "getSystemIdleTime", [](CallPtr c) {
    LASTINPUTINFO li{sizeof li};
    GetLastInputInfo(&li);
    c->ok((GetTickCount() - li.dwTime) / 1000.0);
  });
  reg("power", "getBattery", [](CallPtr c) {
    SYSTEM_POWER_STATUS ps;
    if (!GetSystemPowerStatus(&ps)) return c->fail("unavailable", "power.getBattery: " + last_error_message());
    bool noBattery = ps.BatteryFlag == 128 || ps.BatteryFlag == 255;
    bool onAC = ps.ACLineStatus == 1;
    c->ok(json{{"percent", noBattery || ps.BatteryLifePercent == 255 ? json(nullptr) : json((double)ps.BatteryLifePercent)},
               {"charging", (ps.BatteryFlag & 8) != 0 || onAC},
               {"external", noBattery || onAC}});
  });
  reg("power", "blockSleep", [](CallPtr c) {
    std::string type = c->str("type");
    if (type != "system" && type != "display" && type != "idle")
      return c->fail("invalid_args", "power.blockSleep: unknown type `" + type + "`, expected system|display|idle");
    int id = g_next_block++;
    g_blocks[id] = type;
    apply_execution_state();
    c->ok(json{{"id", id}});
  });
  reg("power", "unblockSleep", [](CallPtr c) {
    int id = (int)c->num("id", -1);
    if (!g_blocks.count(id)) return c->fail("invalid_args", "power.unblockSleep: no live sleep block with id " + std::to_string(id));
    g_blocks.erase(id);
    apply_execution_state();
    c->ok();
  });
  WTSRegisterSessionNotification(hidden_window(), NOTIFY_FOR_THIS_SESSION);
  static HPOWERNOTIFY displayNotify = RegisterPowerSettingNotification(hidden_window(), &GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_WINDOW_HANDLE);
  (void)displayNotify;
  add_hidden_hook([](HWND, UINT msg, WPARAM wp, LPARAM lp, LRESULT *result) {
    if (msg == WM_POWERBROADCAST) {
      if (wp == PBT_APMSUSPEND) emit("systemSleep", json::object());
      else if (wp == PBT_APMRESUMEAUTOMATIC) {
        emit("systemWake", json::object());
        emit_raw(json{{"type", "wake"}});
      } else if (wp == PBT_POWERSETTINGCHANGE) {
        auto *ps = reinterpret_cast<POWERBROADCAST_SETTING *>(lp);
        if (ps && IsEqualGUID(ps->PowerSetting, GUID_CONSOLE_DISPLAY_STATE) && ps->DataLength >= sizeof(DWORD)) {
          DWORD state = *reinterpret_cast<DWORD *>(ps->Data);
          emit(state == 0 ? "displaySleep" : "displayWake", json::object());
        }
      }
      *result = TRUE;
      return true;
    }
    if (msg == WM_WTSSESSION_CHANGE) {
      if (wp == WTS_SESSION_LOCK) emit("screenLocked", json::object());
      else if (wp == WTS_SESSION_UNLOCK) emit("screenUnlocked", json::object());
    }
    return false;
  });
  add_quit_hook([] {
    g_blocks.clear();
    SetThreadExecutionState(ES_CONTINUOUS);
  });
}

// ===========================================================================
// shortcuts.* — global hotkeys (RegisterHotKey on the hidden window).
// Events: shortcutPressed {id}. (Windows reports no key-up for hotkeys.)

struct HotKey {
  int numeric;
  UINT vk, mods;
};
static std::map<std::string, HotKey> g_keys;
static int g_next_hotkey = 1;

void register_shortcuts() {
  reg("shortcuts", "register", [](CallPtr c) {
    std::string accel = c->str("accelerator", c->str("accel"));
    if (accel.empty()) return c->fail("invalid_args", "shortcuts.register: missing `accelerator`");
    std::string id = c->str("id");
    if (id.empty()) id = accel;
    UINT vk = 0, mods = 0;
    std::string display, error;
    if (!parse_accelerator(accel, vk, mods, display, error)) return c->fail("invalid_args", "shortcuts.register: " + error);
    if (g_keys.count(id)) return c->fail("invalid_args", "shortcuts.register: id `" + id + "` is already registered");
    for (auto &[k, h] : g_keys)
      if (h.vk == vk && h.mods == mods) return c->fail("invalid_args", "shortcuts.register: `" + accel + "` is already registered");
    int numeric = g_next_hotkey++;
    if (!RegisterHotKey(hidden_window(), numeric, mods | MOD_NOREPEAT, vk))
      return c->fail("denied", "shortcuts.register: `" + accel + "` could not be registered (" + last_error_message() +
                                   "); it may collide with another app or a system shortcut");
    g_keys[id] = HotKey{numeric, vk, mods};
    c->ok(json{{"id", id}});
  });
  reg("shortcuts", "unregister", [](CallPtr c) {
    std::string id = c->str("id");
    if (id.empty()) return c->fail("invalid_args", "shortcuts.unregister: missing `id`");
    auto it = g_keys.find(id);
    if (it == g_keys.end()) return c->ok(json{{"unregistered", false}});
    UnregisterHotKey(hidden_window(), it->second.numeric);
    g_keys.erase(it);
    c->ok(json{{"unregistered", true}});
  });
  reg_many("shortcuts", {"unregisterAll", "unregister_all"}, [](CallPtr c) {
    size_t n = g_keys.size();
    for (auto &[id, h] : g_keys) UnregisterHotKey(hidden_window(), h.numeric);
    g_keys.clear();
    c->ok(json{{"unregistered", n}});
  });
  reg("shortcuts", "isRegistered", [](CallPtr c) {
    std::string id = c->str("id");
    if (id.empty()) return c->fail("invalid_args", "shortcuts.isRegistered: missing `id`");
    c->ok(g_keys.count(id) > 0);
  });
  add_hidden_hook([](HWND, UINT msg, WPARAM wp, LPARAM, LRESULT *) {
    if (msg != WM_HOTKEY) return false;
    for (auto &[id, h] : g_keys)
      if (h.numeric == (int)wp) emit("shortcutPressed", json{{"id", id}});
    return true;
  });
  add_quit_hook([] {
    for (auto &[id, h] : g_keys) UnregisterHotKey(hidden_window(), h.numeric);
    g_keys.clear();
  });
}

// ===========================================================================
// shell.* — ShellExecute, recycle bin, Explorer selection.

static bool exists(const std::wstring &p) { return GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES; }

static std::wstring expand_path(const std::string &path) {
  std::wstring p = wide(path);
  if (!p.empty() && p[0] == L'~') {
    wchar_t *home = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &home)) && home) p = std::wstring(home) + p.substr(1);
    if (home) CoTaskMemFree(home);
  }
  for (auto &ch : p)
    if (ch == L'/') ch = L'\\';
  wchar_t full[MAX_PATH * 2];
  DWORD n = GetFullPathNameW(p.c_str(), MAX_PATH * 2, full, nullptr);
  return n ? std::wstring(full, n) : p;
}

void register_shell() {
  reg("shell", "openExternal", [](CallPtr c) {
    std::string url = c->str("url");
    std::string scheme = url_scheme(url);
    if (scheme != "http" && scheme != "https" && scheme != "mailto" && scheme != "tel" && scheme != "sms")
      return c->fail("invalid_args", "shell.openExternal: only http(s)/mailto/tel/sms URLs (use openPath for files)");
    auto rc = (INT_PTR)ShellExecuteW(nullptr, L"open", wide(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    if (rc <= 32) return c->fail("internal", "shell.openExternal: ShellExecute failed (" + std::to_string((long long)rc) + ")");
    c->ok();
  });
  reg("shell", "openPath", [](CallPtr c) {
    std::wstring path = expand_path(c->str("path"));
    if (c->str("path").empty() || !exists(path)) return c->fail("invalid_args", "shell.openPath: no such file `" + c->str("path") + "`");
    auto rc = (INT_PTR)ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    if (rc <= 32) return c->fail("internal", "shell.openPath: ShellExecute failed (" + std::to_string((long long)rc) + ")");
    c->ok();
  });
  reg("shell", "showItemInFolder", [](CallPtr c) {
    std::wstring path = expand_path(c->str("path"));
    if (c->str("path").empty() || !exists(path)) return c->fail("invalid_args", "shell.showItemInFolder: no such file `" + c->str("path") + "`");
    PIDLIST_ABSOLUTE pidl = nullptr;
    HRESULT hr = SHParseDisplayName(path.c_str(), nullptr, &pidl, 0, nullptr);
    if (SUCCEEDED(hr)) {
      hr = SHOpenFolderAndSelectItems(pidl, 0, nullptr, 0);
      CoTaskMemFree(pidl);
    }
    if (FAILED(hr)) return c->fail("internal", "shell.showItemInFolder: " + hresult_message(hr));
    c->ok();
  });
  reg("shell", "trashItem", [](CallPtr c) {
    std::wstring path = expand_path(c->str("path"));
    if (c->str("path").empty() || !exists(path)) return c->fail("invalid_args", "shell.trashItem: no such file `" + c->str("path") + "`");
    std::wstring from = path;
    from.push_back(L'\0'); // double-NUL terminated list
    SHFILEOPSTRUCTW op{};
    op.wFunc = FO_DELETE;
    op.pFrom = from.c_str();
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI;
    int rc = SHFileOperationW(&op);
    if (rc != 0 || op.fAnyOperationsAborted) return c->fail("internal", "shell.trashItem: SHFileOperation failed (" + std::to_string(rc) + ")");
    c->ok();
  });
  reg("shell", "beep", [](CallPtr c) {
    MessageBeep(MB_OK);
    c->ok();
  });
}

// ===========================================================================
// secureStorage.* — Windows Credential Manager, generic credentials with
// target "<service>/<account>" and UserName = account. Secrets never appear
// in events or error messages.

static std::wstring target_of(const std::string &service, const std::string &account) { return wide(service + "/" + account); }

static bool read_key(CallPtr c, const std::string &op, bool needAccount, std::string &service, std::string &account) {
  service = c->str("service");
  if (service.empty()) {
    c->fail("invalid_args", "secureStorage." + op + ": `service` must be a non-empty string");
    return false;
  }
  if (needAccount && !(c->args.contains("account") && c->args["account"].is_string())) {
    c->fail("invalid_args", "secureStorage." + op + ": `account` must be a string");
    return false;
  }
  account = c->str("account");
  return true;
}

void register_secure_storage() {
  reg("secureStorage", "setPassword", [](CallPtr c) {
    std::string service, account;
    if (!read_key(c, "setPassword", true, service, account)) return;
    if (!(c->args.contains("password") && c->args["password"].is_string()))
      return c->fail("invalid_args", "secureStorage.setPassword: `password` must be a string");
    std::string secret = c->args["password"].get<std::string>();
    if (secret.size() > CRED_MAX_CREDENTIAL_BLOB_SIZE) return c->fail("invalid_args", "secureStorage.setPassword: password too long");
    std::wstring target = target_of(service, account), user = wide(account);
    CREDENTIALW cred{};
    cred.Type = CRED_TYPE_GENERIC;
    cred.TargetName = &target[0];
    cred.UserName = &user[0];
    cred.CredentialBlobSize = (DWORD)secret.size();
    cred.CredentialBlob = reinterpret_cast<LPBYTE>(&secret[0]);
    cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
    BOOL ok = CredWriteW(&cred, 0);
    SecureZeroMemory(&secret[0], secret.size());
    if (!ok) return c->fail("internal", "secureStorage.setPassword: " + last_error_message());
    c->ok();
  });
  reg("secureStorage", "getPassword", [](CallPtr c) {
    std::string service, account;
    if (!read_key(c, "getPassword", true, service, account)) return;
    PCREDENTIALW cred = nullptr;
    if (!CredReadW(target_of(service, account).c_str(), CRED_TYPE_GENERIC, 0, &cred)) {
      DWORD err = GetLastError();
      if (err == ERROR_NOT_FOUND) return c->ok(nullptr);
      return c->fail("internal", "secureStorage.getPassword: " + last_error_message(err));
    }
    std::string value(reinterpret_cast<const char *>(cred->CredentialBlob), cred->CredentialBlobSize);
    CredFree(cred);
    c->ok(value);
  });
  reg("secureStorage", "deletePassword", [](CallPtr c) {
    std::string service, account;
    if (!read_key(c, "deletePassword", false, service, account)) return;
    if (c->args.contains("account") && c->args["account"].is_string()) {
      if (!CredDeleteW(target_of(service, account).c_str(), CRED_TYPE_GENERIC, 0) && GetLastError() != ERROR_NOT_FOUND)
        return c->fail("internal", "secureStorage.deletePassword: " + last_error_message());
      return c->ok();
    }
    // No account: every entry of the service.
    DWORD count = 0;
    PCREDENTIALW *creds = nullptr;
    std::wstring filter = wide(service + "/*");
    if (CredEnumerateW(filter.c_str(), 0, &count, &creds)) {
      for (DWORD i = 0; i < count; i++)
        if (creds[i]->Type == CRED_TYPE_GENERIC) CredDeleteW(creds[i]->TargetName, CRED_TYPE_GENERIC, 0);
      CredFree(creds);
    }
    c->ok();
  });
}

} // namespace sd::win
