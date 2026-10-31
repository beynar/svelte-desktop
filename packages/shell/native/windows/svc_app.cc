// app.* — identity, paths, lifecycle, single instance, taskbar progress/badge,
// login item; deepLink.register; system.*; diagnostics.info; capabilities.describe.
// Events: willQuit, willRestart, secondInstance {argv, cwd}, openUrls {urls},
// openFiles {paths} (argv of the first and of later instances).
#include "win.hpp"

#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <dwmapi.h>
#include <shlwapi.h>

#include <cmath>


namespace sd::win {

static std::wstring known_folder(REFKNOWNFOLDERID id) {
  wchar_t *p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &p)) && p) out = p;
  if (p) CoTaskMemFree(p);
  return out;
}

static std::wstring exe_dir() {
  std::wstring exe = exe_path();
  auto slash = exe.find_last_of(L"\\/");
  return slash == std::wstring::npos ? exe : exe.substr(0, slash);
}

static std::string get_path(const std::string &name) {
  std::wstring id = wide(app_identifier());
  std::wstring roaming = known_folder(FOLDERID_RoamingAppData), local = known_folder(FOLDERID_LocalAppData);
  if (name == "home") return utf8(known_folder(FOLDERID_Profile));
  if (name == "appPath") return utf8(exe_dir());
  if (name == "exe" || name == "module") return utf8(exe_path());
  if (name == "temp") {
    wchar_t buf[MAX_PATH + 1];
    DWORD n = GetTempPathW(MAX_PATH + 1, buf);
    std::wstring t(buf, n);
    while (!t.empty() && (t.back() == L'\\' || t.back() == L'/')) t.pop_back();
    return utf8(t);
  }
  // Same layout as src/os.ts appDirs (data in %APPDATA%, cache/logs in %LOCALAPPDATA%).
  if (name == "appData") return utf8(roaming);
  if (name == "userData") return utf8(roaming + L"\\" + id);
  if (name == "logs") return utf8(local + L"\\" + id + L"\\Logs");
  if (name == "caches") return utf8(local + L"\\" + id + L"\\Cache");
  if (name == "documents") return utf8(known_folder(FOLDERID_Documents));
  if (name == "downloads") return utf8(known_folder(FOLDERID_Downloads));
  if (name == "desktop") return utf8(known_folder(FOLDERID_Desktop));
  if (name == "music") return utf8(known_folder(FOLDERID_Music));
  if (name == "pictures") return utf8(known_folder(FOLDERID_Pictures));
  if (name == "videos") return utf8(known_folder(FOLDERID_Videos));
  return "";
}

static std::vector<std::wstring> command_line_args() {
  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::vector<std::wstring> out;
  for (int i = 0; i < argc; i++) out.push_back(argv[i]);
  if (argv) LocalFree(argv);
  return out;
}

static std::wstring current_dir() {
  wchar_t buf[MAX_PATH * 2];
  DWORD n = GetCurrentDirectoryW(MAX_PATH * 2, buf);
  return std::wstring(buf, n);
}

// ---------------------------------------------------------------------------
// Opened files / URLs from argv

static std::vector<std::string> g_opened_files;

void handle_open_args(const std::vector<std::wstring> &args) {
  json urls = json::array(), files = json::array();
  for (auto &a : args) {
    if (a.empty() || a[0] == L'-' || a[0] == L'/') continue;
    std::string s = utf8(a);
    std::string scheme = url_scheme(s);
    if (scheme.size() > 1 && scheme != "file") { // "C:\..." has a one-letter "scheme"
      urls.push_back(s);
      continue;
    }
    std::wstring path = a;
    if (scheme == "file") {
      wchar_t buf[MAX_PATH * 2];
      DWORD n = MAX_PATH * 2;
      if (FAILED(PathCreateFromUrlW(a.c_str(), buf, &n, 0))) continue;
      path.assign(buf, n);
    }
    wchar_t full[MAX_PATH * 2];
    DWORD n = GetFullPathNameW(path.c_str(), MAX_PATH * 2, full, nullptr);
    if (!n || GetFileAttributesW(full) == INVALID_FILE_ATTRIBUTES) continue;
    files.push_back(utf8(full, (int)n));
    g_opened_files.push_back(utf8(full, (int)n));
  }
  if (!urls.empty()) emit("openUrls", json{{"urls", urls}});
  if (!files.empty()) emit("openFiles", json{{"paths", files}});
}

void on_first_page_ready() {
  if (!packaged()) return; // `bun vite dev` argv is not ours
  auto args = command_line_args();
  if (!args.empty()) args.erase(args.begin());
  handle_open_args(args);
}

// ---------------------------------------------------------------------------
// Single instance: a named mutex; later instances WM_COPYDATA their argv/cwd to
// the holder's hidden window (found by class + identifier title).

static HANDLE g_instance_mutex = nullptr;
static const ULONG_PTR kCopyDataTag = 0x53445349; // 'SDSI'

/// Take the single-instance mutex, or hand this process's arguments to the holder.
static bool acquire_single_instance() {
  if (g_instance_mutex) return true;
  std::wstring name = L"Local\\" + wide(app_identifier()) + L".singleInstance";
  HANDLE m = CreateMutexW(nullptr, TRUE, name.c_str());
  DWORD err = GetLastError();
  if (m && err != ERROR_ALREADY_EXISTS) {
    g_instance_mutex = m;
    return true;
  }
  if (m) CloseHandle(m);
  json argv = json::array();
  bool toastLaunch = false;
  for (auto &a : command_line_args()) {
    argv.push_back(utf8(a));
    toastLaunch = toastLaunch || lstrcmpiW(a.c_str(), L"-ToastActivated") == 0;
  }
  json msg{{"argv", argv}, {"cwd", utf8(current_dir())}};
  // Launched by the toast activator while another instance holds the lock (it hadn't
  // registered the class object yet): take the activation and hand it over.
  if (toastLaunch) {
    json t = json::parse(toast_activation_wait(5000), nullptr, false);
    if (t.is_object()) msg["toast"] = t;
  }
  std::string payload = msg.dump();
  // The holder's hidden window (this process has one with the same class + title: skip it).
  HWND holder = nullptr;
  DWORD pid = 0;
  std::wstring title = wide(app_identifier());
  for (HWND h = FindWindowExW(nullptr, nullptr, kHiddenClass, title.c_str()); h; h = FindWindowExW(nullptr, h, kHiddenClass, title.c_str())) {
    GetWindowThreadProcessId(h, &pid);
    if (pid != GetCurrentProcessId()) {
      holder = h;
      break;
    }
  }
  if (holder) {
    AllowSetForegroundWindow(pid); // let the holder bring its window forward
    COPYDATASTRUCT cds{kCopyDataTag, (DWORD)payload.size(), payload.data()};
    DWORD_PTR result = 0;
    SendMessageTimeoutW(holder, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&cds), SMTO_ABORTIFHUNG, 3000, &result);
  }
  return false;
}

static void request_single_instance(CallPtr c) { c->ok(json{{"acquired", acquire_single_instance()}}); }

bool claim_single_instance() { return acquire_single_instance(); }

// ---------------------------------------------------------------------------
// Taskbar (ITaskbarList3): progress (Dock progress) and overlay (Dock badge)

static ITaskbarList3 *taskbar() {
  static ITaskbarList3 *tb = nullptr;
  if (!tb && SUCCEEDED(CoCreateInstance(CLSID_TaskbarList, nullptr, CLSCTX_INPROC_SERVER, IID_ITaskbarList3, reinterpret_cast<void **>(&tb)))) {
    if (FAILED(tb->HrInit())) release(tb);
  }
  return tb;
}

static HICON badge_icon() {
  static HICON icon = nullptr;
  if (icon) return icon;
  const int s = 16;
  std::vector<uint8_t> px((size_t)s * s * 4, 0);
  for (int y = 0; y < s; y++)
    for (int x = 0; x < s; x++) {
      double dx = x + 0.5 - s / 2.0, dy = y + 0.5 - s / 2.0;
      double d = s / 2.0 - std::sqrt(dx * dx + dy * dy);
      double a = std::max(0.0, std::min(1.0, d));
      uint8_t *p = &px[((size_t)y * s + x) * 4];
      p[0] = 0x30; // straight-alpha BGRA: system red
      p[1] = 0x3b;
      p[2] = 0xff;
      p[3] = (uint8_t)(255 * a);
    }
  icon = icon_from_bgra(px, s, s);
  return icon;
}

static std::wstring run_key() { return L"Software\\Microsoft\\Windows\\CurrentVersion\\Run"; }

// ---------------------------------------------------------------------------

static std::string diag_arch() { return arch_name() == "arm64" ? "aarch64" : "x86_64"; }

static std::string os_version() {
  using RtlGetVersion_t = LONG(WINAPI *)(OSVERSIONINFOW *);
  OSVERSIONINFOW v{sizeof v};
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-function-type"
  if (auto fn = reinterpret_cast<RtlGetVersion_t>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"))) fn(&v);
#pragma GCC diagnostic pop
  return std::to_string(v.dwMajorVersion) + "." + std::to_string(v.dwMinorVersion) + "." + std::to_string(v.dwBuildNumber);
}

static double uptime_seconds() {
  FILETIME created, exited, kernel, user, now;
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return 0;
  GetSystemTimeAsFileTime(&now);
  ULARGE_INTEGER a{{created.dwLowDateTime, created.dwHighDateTime}}, b{{now.dwLowDateTime, now.dwHighDateTime}};
  return b.QuadPart > a.QuadPart ? (double)(b.QuadPart - a.QuadPart) / 1e7 : 0;
}

static std::string keyboard_layout() {
  wchar_t name[KL_NAMELENGTH];
  if (!GetKeyboardLayoutNameW(name)) return "";
  // KLID -> display name from the registry when available.
  std::wstring key = L"SYSTEM\\CurrentControlSet\\Control\\Keyboard Layouts\\" + std::wstring(name);
  wchar_t text[256];
  DWORD size = sizeof text;
  if (RegGetValueW(HKEY_LOCAL_MACHINE, key.c_str(), L"Layout Text", RRF_RT_REG_SZ, nullptr, text, &size) == ERROR_SUCCESS) return utf8(text);
  return utf8(name);
}

void register_app() {
  reg("app", "whenReady", [](CallPtr c) { c->ok(true); });
  reg("app", "getInfo", [](CallPtr c) {
    c->ok(json{{"name", app_name()},
               {"version", app_version()},
               {"identifier", app_identifier()},
               {"appPath", packaged() ? json(utf8(exe_dir())) : json(nullptr)},
               {"packaged", packaged()},
               {"platform", "win32"},
               {"arch", arch_name()}});
  });
  reg("app", "getName", [](CallPtr c) { c->ok(app_name()); });
  reg("app", "getVersion", [](CallPtr c) { c->ok(app_version()); });
  reg("app", "getPath", [](CallPtr c) {
    std::string name = c->str("name");
    std::string p = name.empty() ? "" : get_path(name);
    if (p.empty()) return c->fail("invalid_args", "app.getPath: unknown name `" + name + "`");
    c->ok(p);
  });
  reg("app", "setName", [](CallPtr c) {
    std::string name = c->str("name");
    if (name.empty()) return c->fail("invalid_args", "app.setName: `name` is required");
    set_app_name(name);
    c->ok();
  });
  reg("app", "setIdentity", [](CallPtr c) {
    std::string identifier = c->str("identifier");
    if (identifier.empty()) return c->fail("invalid_args", "app.setIdentity: `identifier` is required");
    set_app_identifier(identifier);
    if (c->has("name")) set_app_name(c->str("name"));
    c->ok();
  });
  reg("app", "quit", [](CallPtr c) {
    emit("willQuit", json::object());
    c->ok();
    request_quit();
  });
  reg("app", "relaunch", [](CallPtr c) {
    emit("willRestart", json::object());
    // A hidden PowerShell waits for this pid to exit, then starts a fresh copy.
    wchar_t sys[MAX_PATH];
    GetSystemDirectoryW(sys, MAX_PATH);
    std::wstring ps = std::wstring(sys) + L"\\WindowsPowerShell\\v1.0\\powershell.exe";
    std::wstring exe = exe_path();
    std::wstring quoted;
    for (wchar_t ch : exe) quoted += ch == L'\'' ? std::wstring(L"''") : std::wstring(1, ch);
    std::wstring cmd = L"\"" + ps + L"\" -NoProfile -NonInteractive -WindowStyle Hidden -Command \"Wait-Process -Id " +
                       std::to_wstring(GetCurrentProcessId()) + L" -ErrorAction SilentlyContinue; Start-Process -FilePath '" + quoted + L"'\"";
    STARTUPINFOW si{sizeof si};
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, &cmd[0], nullptr, nullptr, FALSE, CREATE_NO_WINDOW | DETACHED_PROCESS, nullptr, nullptr, &si, &pi))
      return c->fail("internal", "app.relaunch: " + last_error_message());
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    c->ok();
    request_quit();
  });
  reg("app", "exit", [](CallPtr c) { ExitProcess((UINT)c->num("code", 0)); });
  reg("app", "hide", [](CallPtr c) {
    for (int id : window_order())
      if (Window *w = find_window(id)) ShowWindow(w->hwnd, SW_HIDE);
    c->ok();
  });
  reg_many("app", {"show", "activate"}, [](CallPtr c) {
    for (int id : window_order())
      if (Window *w = find_window(id))
        if (w->shown) ShowWindow(w->hwnd, IsIconic(w->hwnd) ? SW_RESTORE : SW_SHOW);
    if (Window *w = find_window(primary_window())) SetForegroundWindow(w->hwnd);
    c->ok();
  });
  reg("app", "addRecentDocument", [](CallPtr c) {
    std::string path = c->str("path");
    if (path.empty()) return c->fail("invalid_args", "app.addRecentDocument: `path` is required");
    std::wstring p = wide(path);
    SHAddToRecentDocs(SHARD_PATHW, p.c_str());
    c->ok();
  });
  reg("app", "clearRecentDocuments", [](CallPtr c) {
    SHAddToRecentDocs(SHARD_PATHW, nullptr);
    c->ok();
  });
  reg("app", "bounceDock", [](CallPtr c) {
    Window *w = find_window(primary_window());
    if (!w) return c->ok(false);
    FLASHWINFO fi{sizeof fi, w->hwnd, c->str("type") == "critical" ? (UINT)(FLASHW_ALL | FLASHW_TIMERNOFG) : (UINT)FLASHW_TRAY, 3, 0};
    FlashWindowEx(&fi);
    c->ok(true);
  });
  reg("app", "setDockBadge", [](CallPtr c) {
    Window *w = find_window(primary_window());
    ITaskbarList3 *tb = taskbar();
    if (!w || !tb) return c->ok(false);
    std::string text = c->str("text");
    std::wstring desc = wide(text);
    tb->SetOverlayIcon(w->hwnd, text.empty() ? nullptr : badge_icon(), desc.c_str());
    c->ok(true);
  });
  reg("app", "setDockProgress", [](CallPtr c) {
    Window *w = find_window(primary_window());
    ITaskbarList3 *tb = taskbar();
    if (!w || !tb) return c->fail("unavailable", "app.setDockProgress: no taskbar button");
    std::string status = c->str("status", "normal");
    TBPFLAG flag = status == "none" ? TBPF_NOPROGRESS
                   : status == "indeterminate" ? TBPF_INDETERMINATE
                   : status == "paused" ? TBPF_PAUSED
                   : status == "error" ? TBPF_ERROR
                                       : TBPF_NORMAL;
    tb->SetProgressState(w->hwnd, flag);
    if (flag == TBPF_NORMAL || flag == TBPF_PAUSED || flag == TBPF_ERROR) {
      double total = c->num("total", 1), done = c->num("completed", 0);
      ULONGLONG t = 10000, d = total > 0 ? (ULONGLONG)(std::max(0.0, std::min(1.0, done / total)) * 10000) : 0;
      tb->SetProgressValue(w->hwnd, d, t);
    }
    c->ok();
  });
  reg("app", "setLoginItem", [](CallPtr c) {
    if (!packaged()) return c->fail("unavailable", "app.setLoginItem needs the packaged app (not `bun`)");
    bool want = c->flag("enabled", true);
    HKEY key = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, run_key().c_str(), 0, nullptr, 0, KEY_READ | KEY_WRITE, nullptr, &key, nullptr) != ERROR_SUCCESS)
      return c->fail("denied", "app.setLoginItem: cannot open the Run key");
    std::wstring name = wide(app_name());
    if (want) {
      std::wstring value = L"\"" + exe_path() + L"\"";
      RegSetValueExW(key, name.c_str(), 0, REG_SZ, reinterpret_cast<const BYTE *>(value.c_str()), (DWORD)((value.size() + 1) * sizeof(wchar_t)));
    } else {
      RegDeleteValueW(key, name.c_str());
    }
    bool enabled = RegQueryValueExW(key, name.c_str(), nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS;
    RegCloseKey(key);
    c->ok(json{{"enabled", enabled}});
  });
  reg("app", "requestSingleInstanceLock", [](CallPtr c) { request_single_instance(c); });
  reg("app", "getBundleType", [](CallPtr c) { c->ok(json{{"type", packaged() ? "app" : "binary"}}); });
  reg("app", "getOpenedFiles", [](CallPtr c) {
    json out = g_opened_files;
    g_opened_files.clear();
    c->ok(json{{"paths", out}});
  });
  reg("app", "aboutPanel", [](CallPtr c) {
    std::string text = c->str("name", app_name()) + "\nVersion " + c->str("version", app_version());
    if (c->has("copyright")) text += "\n" + c->str("copyright");
    if (c->has("credits")) text += "\n\n" + c->str("credits");
    Window *w = find_window(primary_window());
    std::wstring t = wide(text), title = wide("About " + c->str("name", app_name()));
    backend_run_on_main([t, title, w] { MessageBoxW(w ? w->hwnd : nullptr, t.c_str(), title.c_str(), MB_OK | MB_ICONINFORMATION); });
    c->ok();
  });

  // Second instances (WM_COPYDATA to the hidden window).
  add_hidden_hook([](HWND, UINT msg, WPARAM, LPARAM lp, LRESULT *result) {
    if (msg != WM_COPYDATA) return false;
    auto *cds = reinterpret_cast<COPYDATASTRUCT *>(lp);
    if (!cds || cds->dwData != kCopyDataTag) return false;
    json d = json::parse(std::string(static_cast<const char *>(cds->lpData), cds->cbData), nullptr, false);
    if (d.is_object()) {
      json argv = d.contains("argv") && d["argv"].is_array() ? d["argv"] : json::array();
      emit("secondInstance", json{{"argv", argv}, {"cwd", jstr(d, "cwd")}});
      std::vector<std::wstring> args;
      for (size_t i = 1; i < argv.size(); i++)
        if (argv[i].is_string()) args.push_back(wide(argv[i].get<std::string>()));
      std::wstring cwd = wide(jstr(d, "cwd")), prev = current_dir();
      if (!cwd.empty()) SetCurrentDirectoryW(cwd.c_str()); // resolve relative paths against the sender's cwd
      handle_open_args(args);
      SetCurrentDirectoryW(prev.c_str());
      if (d.contains("toast")) toast_activation_forwarded(d["toast"]);
      else if (window_order().empty()) recreate_main_window(); // quitOnLastWindowClosed: false
    }
    *result = TRUE;
    return true;
  });
}

// ---------------------------------------------------------------------------
// deepLink.register: HKCU\Software\Classes\<scheme> -> this executable.

void register_deep_link() {
  reg_many("deepLink", {"register", "registerScheme"}, [](CallPtr c) {
    std::string scheme = lower(c->str("scheme"));
    if (scheme.empty() || url_scheme(scheme + ":") != scheme) return c->fail("invalid_args", "deepLink.register: `scheme` must be a URL scheme");
    if (!packaged()) return c->fail("unavailable", "deepLink.register needs the packaged app (not `bun`)");
    std::wstring base = L"Software\\Classes\\" + wide(scheme);
    auto set = [](const std::wstring &key, const wchar_t *name, const std::wstring &value) {
      HKEY k = nullptr;
      if (RegCreateKeyExW(HKEY_CURRENT_USER, key.c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr) != ERROR_SUCCESS) return false;
      RegSetValueExW(k, name, 0, REG_SZ, reinterpret_cast<const BYTE *>(value.c_str()), (DWORD)((value.size() + 1) * sizeof(wchar_t)));
      RegCloseKey(k);
      return true;
    };
    bool ok = set(base, nullptr, L"URL:" + wide(scheme)) && set(base, L"URL Protocol", L"") &&
              set(base + L"\\shell\\open\\command", nullptr, L"\"" + exe_path() + L"\" \"%1\"");
    if (!ok) return c->fail("denied", "deepLink.register: cannot write HKCU\\Software\\Classes");
    c->ok(json{{"scheme", scheme}});
  });
}

// ---------------------------------------------------------------------------
// system.*

// Windows privacy settings: desktop apps have no per-app prompt; camera,
// microphone and location are allowed or denied for desktop apps as a whole
// (CapabilityAccessManager consent store). The rest has no gate on Windows.
static std::string consent(const wchar_t *capability) {
  std::wstring base = std::wstring(L"Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\") + capability;
  auto read = [](const std::wstring &key) -> std::wstring {
    wchar_t buf[32];
    DWORD size = sizeof buf;
    if (RegGetValueW(HKEY_CURRENT_USER, key.c_str(), L"Value", RRF_RT_REG_SZ, nullptr, buf, &size) != ERROR_SUCCESS) return L"";
    return buf;
  };
  if (read(base) == L"Deny" || read(base + L"\\NonPackaged") == L"Deny") return "denied";
  return "granted";
}

static std::string permission_status(const std::string &name) {
  if (name == "camera") return consent(L"webcam");
  if (name == "microphone") return consent(L"microphone");
  if (name == "location") return consent(L"location");
  return "granted";
}

void register_system() {
  reg("system", "checkPermission", [](CallPtr c) { c->ok(json{{"status", permission_status(c->str("name"))}}); });
  reg("system", "requestPermission", [](CallPtr c) { c->ok(json{{"status", permission_status(c->str("name"))}}); });
  reg("system", "openSettings", [](CallPtr c) {
    static const std::map<std::string, const wchar_t *> kPages = {
        {"privacy-camera", L"ms-settings:privacy-webcam"}, {"privacy-microphone", L"ms-settings:privacy-microphone"},
        {"privacy-location", L"ms-settings:privacy-location"}, {"notifications", L"ms-settings:notifications"},
        {"privacy-screenCapture", L"ms-settings:privacy-graphicsCaptureProgrammatic"}, {"privacy", L"ms-settings:privacy"}};
    auto it = kPages.find(c->str("pane"));
    const wchar_t *page = it == kPages.end() ? L"ms-settings:privacy" : it->second;
    bool opened = (INT_PTR)ShellExecuteW(nullptr, L"open", page, nullptr, nullptr, SW_SHOWNORMAL) > 32;
    c->ok(json{{"opened", opened}});
  });
  reg("system", "info", [](CallPtr c) {
    c->ok(json{{"os", "windows"}, {"family", "windows"}, {"arch", diag_arch()}, {"keyboardLayout", keyboard_layout()}});
  });
  reg("system", "getKeyboardLayout", [](CallPtr c) { c->ok(json{{"name", keyboard_layout()}}); });
  reg("system", "getAccentColor", [](CallPtr c) {
    DWORD argb = 0;
    BOOL opaque = FALSE;
    if (FAILED(DwmGetColorizationColor(&argb, &opaque))) return c->fail("unavailable", "system.getAccentColor: DWM colorization unavailable");
    c->ok(json{{"r", ((argb >> 16) & 0xff) / 255.0}, {"g", ((argb >> 8) & 0xff) / 255.0}, {"b", (argb & 0xff) / 255.0}, {"a", 1.0}});
  });
  reg("system", "getAccessibility", [](CallPtr c) {
    BOOL anim = TRUE;
    SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &anim, 0);
    HIGHCONTRASTW hc{sizeof hc};
    SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof hc, &hc, 0);
    DWORD transparency = 1, size = sizeof transparency;
    RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"EnableTransparency", RRF_RT_REG_DWORD,
                 nullptr, &transparency, &size);
    c->ok(json{{"reduceMotion", !anim},
               {"highContrast", (hc.dwFlags & HCF_HIGHCONTRASTON) != 0},
               {"differentiateWithoutColor", false},
               {"reduceTransparency", transparency == 0}});
  });
}

// ---------------------------------------------------------------------------
// diagnostics.info / capabilities.describe

void register_diagnostics() {
  reg("diagnostics", "info", [](CallPtr c) {
    c->ok(json{{"pid", (int)GetCurrentProcessId()},
               {"uptimeSeconds", uptime_seconds()},
               {"os", "windows"},
               {"family", "windows"},
               {"arch", diag_arch()},
               {"renderer", "webview2"},
               {"rendererVersion", webview2_version()},
               {"osVersion", os_version()}});
  });
  // Truth table from the live registry: registered ops are "implemented",
  // except those that need the packaged app ("unavailable" under `bun`).
  reg("capabilities", "describe", [](CallPtr c) {
    json services = json::object();
    for (auto &key : registered_ops()) {
      auto dot = key.find('.');
      if (dot == std::string::npos) continue;
      std::string service = key.substr(0, dot), op = key.substr(dot + 1);
      std::string status = "implemented";
      if (!packaged() && (service == "deepLink" || key == "app.setLoginItem")) status = "unavailable";
      services[service][op] = status;
    }
    c->ok(json{{"platform", "windows"}, {"arch", diag_arch()}, {"services", services}});
  });
}

} // namespace sd::win
