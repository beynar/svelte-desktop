// Windows implementation of shell.h: Win32 windows hosting WebView2 controllers.
//
// - One WebView2 environment (user data in %LOCALAPPDATA%\<identifier>\WebView2)
//   shared by every window and popover, so the app's session cookie applies to
//   all of them. The runtime is located and started without WebView2Loader.dll
//   (same approach as webview/webview's built-in loader).
// - Any-thread exports queue a closure and wake a message-only window.
// - Page bridge: kBridgeScript (portable core) is installed with
//   AddScriptToExecuteOnDocumentCreated; messages arrive through
//   ICoreWebView2::add_WebMessageReceived (top-level document only) and are
//   origin-checked by the core against the source URI.
// - Navigation policy: NavigationStarting / NewWindowRequested keep the app
//   origin in the window and hand everything else to ShellExecute.
#include "win.hpp"

#include <dwmapi.h>
#include <shellapi.h>
#include <shlobj.h>

#include <algorithm>
#include <cstdio>
#include <deque>
#include <mutex>

#include "../shell.h"

namespace sd::win {

// ---------------------------------------------------------------------------
// Strings + JSON helpers

std::wstring wide(const std::string &s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring out((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &out[0], n);
  return out;
}

std::string utf8(const wchar_t *s, int len) {
  if (!s) return {};
  if (len < 0) len = (int)wcslen(s);
  if (len == 0) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, s, len, nullptr, 0, nullptr, nullptr);
  std::string out((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, s, len, &out[0], n, nullptr, nullptr);
  return out;
}

std::string lower(std::string s) {
  for (auto &c : s) c = (char)tolower((unsigned char)c);
  return s;
}

static const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64_encode(const void *data, size_t len) {
  const auto *p = static_cast<const unsigned char *>(data);
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  for (size_t i = 0; i < len; i += 3) {
    unsigned v = p[i] << 16 | (i + 1 < len ? p[i + 1] << 8 : 0) | (i + 2 < len ? p[i + 2] : 0);
    out += kB64[(v >> 18) & 63];
    out += kB64[(v >> 12) & 63];
    out += i + 1 < len ? kB64[(v >> 6) & 63] : '=';
    out += i + 2 < len ? kB64[v & 63] : '=';
  }
  return out;
}

bool base64_decode(const std::string &in, std::string &out) {
  int map[256];
  for (int &m : map) m = -1;
  for (int i = 0; i < 64; i++) map[(unsigned char)kB64[i]] = i;
  map[(unsigned char)'-'] = 62; // base64url too
  map[(unsigned char)'_'] = 63;
  out.clear();
  unsigned acc = 0;
  int bits = 0;
  for (unsigned char c : in) {
    if (c == '=' || c == '\r' || c == '\n' || c == ' ') continue;
    if (map[c] < 0) return false;
    acc = acc << 6 | (unsigned)map[c];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += (char)((acc >> bits) & 0xff);
    }
  }
  return true;
}

std::string url_scheme(const std::string &url) {
  auto colon = url.find(':');
  if (colon == std::string::npos || colon == 0) return "";
  for (size_t i = 0; i < colon; i++) {
    char c = url[i];
    if (!(isalnum((unsigned char)c) || c == '+' || c == '-' || c == '.')) return "";
  }
  return lower(url.substr(0, colon));
}

std::string url_origin(const std::string &url) {
  std::string scheme = url_scheme(url);
  if (scheme.empty() || url.compare(scheme.size(), 3, "://") != 0) return "";
  size_t start = scheme.size() + 3;
  size_t end = url.find_first_of("/?#", start);
  std::string authority = url.substr(start, end == std::string::npos ? std::string::npos : end - start);
  auto at = authority.rfind('@');
  if (at != std::string::npos) authority = authority.substr(at + 1);
  std::string host = authority, port;
  if (!authority.empty() && authority[0] == '[') { // [::1]:port
    auto close = authority.find(']');
    host = authority.substr(0, close == std::string::npos ? std::string::npos : close + 1);
    if (close != std::string::npos && close + 1 < authority.size() && authority[close + 1] == ':') port = authority.substr(close + 2);
  } else {
    auto colon = authority.rfind(':');
    if (colon != std::string::npos) {
      host = authority.substr(0, colon);
      port = authority.substr(colon + 1);
    }
  }
  if ((scheme == "http" && port == "80") || (scheme == "https" && port == "443")) port.clear();
  return scheme + "://" + lower(host) + (port.empty() ? "" : ":" + port);
}

std::string last_error_message(DWORD err) {
  wchar_t *buf = nullptr;
  DWORD n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, err, 0,
                           reinterpret_cast<LPWSTR>(&buf), 0, nullptr);
  std::string s = n ? utf8(buf, (int)n) : "error " + std::to_string(err);
  if (buf) LocalFree(buf);
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ' || s.back() == '.')) s.pop_back();
  return s;
}

std::string hresult_message(HRESULT hr) {
  char hex[16];
  snprintf(hex, sizeof hex, "0x%08lx", (unsigned long)hr);
  return last_error_message((DWORD)hr) + " (" + hex + ")";
}

bool jbool(const json &o, const char *k, bool f) {
  if (!o.is_object()) return f;
  auto it = o.find(k);
  return it != o.end() && it->is_boolean() ? it->get<bool>() : f;
}
double jnum(const json &o, const char *k, double f) {
  if (!o.is_object()) return f;
  auto it = o.find(k);
  return it != o.end() && it->is_number() ? it->get<double>() : f;
}
std::string jstr(const json &o, const char *k, const std::string &f) {
  if (!o.is_object()) return f;
  auto it = o.find(k);
  return it != o.end() && it->is_string() ? it->get<std::string>() : f;
}
bool jhas(const json &o, const char *k) {
  if (!o.is_object()) return false;
  auto it = o.find(k);
  return it != o.end() && !it->is_null();
}

// ---------------------------------------------------------------------------
// Main thread, queue, hidden windows

static std::atomic<DWORD> g_main_tid{0};
static std::atomic<HWND> g_msg{nullptr};
static HWND g_hidden = nullptr;
static std::mutex g_queue_mutex;
static std::deque<std::function<void()>> g_queue;
static std::vector<MsgHook> g_hidden_hooks;
static std::vector<std::function<void()>> g_quit_hooks;
static const UINT WM_SD_RUN = WM_APP + 1;
static const UINT_PTR kRevealTimer = 1;

static void drain_queue() {
  std::deque<std::function<void()>> batch;
  {
    std::lock_guard<std::mutex> lock(g_queue_mutex);
    batch.swap(g_queue);
  }
  for (auto &fn : batch) {
    try {
      fn();
    } catch (const std::exception &e) {
      fprintf(stderr, "[shell] main-thread task threw: %s\n", e.what());
    }
  }
}

HWND hidden_window() { return g_hidden; }
void add_hidden_hook(MsgHook hook) { g_hidden_hooks.push_back(std::move(hook)); }
void add_quit_hook(std::function<void()> hook) { g_quit_hooks.push_back(std::move(hook)); }

static bool g_quit_on_last_window = true; // desktop.config quitOnLastWindowClosed
static json g_main_opts;                    // the first window's options (recreate_main_window)
void request_quit() { PostQuitMessage(0); }

// ---------------------------------------------------------------------------
// Identity

static std::string g_app_name, g_app_identifier, g_app_version;

std::wstring exe_path() {
  std::wstring buf(MAX_PATH, L'\0');
  for (;;) {
    DWORD n = GetModuleFileNameW(nullptr, &buf[0], (DWORD)buf.size());
    if (n < buf.size()) {
      buf.resize(n);
      return buf;
    }
    buf.resize(buf.size() * 2);
  }
}

bool packaged() {
  std::wstring exe = exe_path();
  auto slash = exe.find_last_of(L"\\/");
  std::string name = lower(utf8(exe.substr(slash == std::wstring::npos ? 0 : slash + 1)));
  return name != "bun.exe" && name != "bun-debug.exe";
}

std::string arch_name() {
#if defined(__aarch64__) || defined(_M_ARM64)
  return "arm64";
#else
  return "x64";
#endif
}

// Version resource of the executable (the packager writes ProductVersion).
static std::string exe_version() {
  std::wstring exe = exe_path();
  DWORD handle = 0, size = GetFileVersionInfoSizeW(exe.c_str(), &handle);
  if (!size) return "";
  std::vector<char> data(size);
  if (!GetFileVersionInfoW(exe.c_str(), 0, size, data.data())) return "";
  struct Lang {
    WORD lang, cp;
  } *langs = nullptr;
  UINT len = 0;
  if (VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void **>(&langs), &len) && len >= sizeof(Lang)) {
    wchar_t key[64];
    swprintf(key, 64, L"\\StringFileInfo\\%04x%04x\\ProductVersion", langs[0].lang, langs[0].cp);
    wchar_t *value = nullptr;
    if (VerQueryValueW(data.data(), key, reinterpret_cast<void **>(&value), &len) && value && len) return utf8(value);
  }
  return "";
}

std::string app_name() {
  if (!g_app_name.empty()) return g_app_name;
  std::wstring exe = exe_path();
  auto slash = exe.find_last_of(L"\\/");
  std::wstring name = exe.substr(slash == std::wstring::npos ? 0 : slash + 1);
  auto dot = name.rfind(L'.');
  return utf8(dot == std::wstring::npos ? name : name.substr(0, dot));
}
std::string app_identifier() { return g_app_identifier.empty() ? "dev.svelte-desktop.app" : g_app_identifier; }
std::string app_version() {
  if (g_app_version.empty()) {
    g_app_version = packaged() ? exe_version() : "";
    if (g_app_version.empty()) g_app_version = "0.0.0";
  }
  return g_app_version;
}
void set_app_name(const std::string &n) { g_app_name = n; }
void set_app_identifier(const std::string &i) { g_app_identifier = i; }

// ---------------------------------------------------------------------------
// DPI

using GetDpiForWindow_t = UINT(WINAPI *)(HWND);
using GetDpiForMonitor_t = HRESULT(WINAPI *)(HMONITOR, int, UINT *, UINT *);
using AdjustWindowRectExForDpi_t = BOOL(WINAPI *)(LPRECT, DWORD, BOOL, DWORD, UINT);

static FARPROC user32_proc(const char *name) { return GetProcAddress(GetModuleHandleW(L"user32.dll"), name); }

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-function-type"
double monitor_scale(HMONITOR mon) {
  static auto fn = reinterpret_cast<GetDpiForMonitor_t>([]() -> FARPROC {
    HMODULE shcore = LoadLibraryW(L"shcore.dll");
    return shcore ? GetProcAddress(shcore, "GetDpiForMonitor") : nullptr;
  }());
  UINT x = 96, y = 96;
  if (fn && mon && SUCCEEDED(fn(mon, 0 /*MDT_EFFECTIVE_DPI*/, &x, &y)) && x) return x / 96.0;
  HDC dc = GetDC(nullptr);
  int dpi = GetDeviceCaps(dc, LOGPIXELSX);
  ReleaseDC(nullptr, dc);
  return dpi > 0 ? dpi / 96.0 : 1.0;
}

double hwnd_scale(HWND hwnd) {
  static auto fn = reinterpret_cast<GetDpiForWindow_t>(user32_proc("GetDpiForWindow"));
  if (fn && hwnd) {
    UINT dpi = fn(hwnd);
    if (dpi) return dpi / 96.0;
  }
  return monitor_scale(MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY));
}

static void adjust_for_dpi(RECT *rc, DWORD style, BOOL menu, DWORD ex, UINT dpi) {
  static auto fn = reinterpret_cast<AdjustWindowRectExForDpi_t>(user32_proc("AdjustWindowRectExForDpi"));
  if (fn) fn(rc, style, menu, ex, dpi);
  else AdjustWindowRectEx(rc, style, menu, ex);
}

static void enable_dpi_awareness() {
  using SetCtx_t = BOOL(WINAPI *)(HANDLE);
  if (auto fn = reinterpret_cast<SetCtx_t>(user32_proc("SetProcessDpiAwarenessContext"))) {
    if (fn(reinterpret_cast<HANDLE>(-4) /*PER_MONITOR_AWARE_V2*/)) return;
  }
  if (HMODULE shcore = LoadLibraryW(L"shcore.dll")) {
    using SetAw_t = HRESULT(WINAPI *)(int);
    if (auto fn = reinterpret_cast<SetAw_t>(GetProcAddress(shcore, "SetProcessDpiAwareness")))
      if (SUCCEEDED(fn(2 /*PROCESS_PER_MONITOR_DPI_AWARE*/))) return;
  }
  SetProcessDPIAware();
}
#pragma GCC diagnostic pop

double point_scale(POINT pt) { return monitor_scale(MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST)); }

json rect_json(double x, double y, double w, double h) { return json{{"x", x}, {"y", y}, {"width", w}, {"height", h}}; }

json screen_rect_dip(const RECT &r) {
  double s = monitor_scale(MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST));
  return rect_json(r.left / s, r.top / s, (r.right - r.left) / s, (r.bottom - r.top) / s);
}

json window_bounds_json(HWND hwnd) {
  RECT r{};
  GetWindowRect(hwnd, &r);
  double s = hwnd_scale(hwnd);
  return rect_json(r.left / s, r.top / s, (r.right - r.left) / s, (r.bottom - r.top) / s);
}

void set_dark_title_bar(HWND hwnd, bool dark) {
  BOOL v = dark ? TRUE : FALSE;
  if (FAILED(DwmSetWindowAttribute(hwnd, 20 /*DWMWA_USE_IMMERSIVE_DARK_MODE*/, &v, sizeof v)))
    DwmSetWindowAttribute(hwnd, 19 /*pre-20H1*/, &v, sizeof v);
}

bool system_dark() {
  DWORD value = 1, size = sizeof value;
  if (RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"AppsUseLightTheme",
                   RRF_RT_REG_DWORD, nullptr, &value, &size) != ERROR_SUCCESS)
    return false;
  return value == 0;
}

// ---------------------------------------------------------------------------
// WebView2 runtime + environment (no WebView2Loader.dll)

struct Runtime {
  std::wstring dll;
  std::string version;
  int type = 0; // 0 installed, 1 fixed-version folder
};

static std::wstring runtime_dll(const std::wstring &dir) {
  std::wstring d = dir;
  if (!d.empty() && d.back() != L'\\' && d.back() != L'/') d += L'\\';
#if defined(__aarch64__) || defined(_M_ARM64)
  return d + L"EBWebView\\arm64\\EmbeddedBrowserWebView.dll";
#else
  return d + L"EBWebView\\x64\\EmbeddedBrowserWebView.dll";
#endif
}

static Runtime find_runtime() {
  // Fixed-version runtime shipped with the app (WebView2 convention).
  wchar_t fixed[MAX_PATH];
  DWORD n = GetEnvironmentVariableW(L"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", fixed, MAX_PATH);
  if (n && n < MAX_PATH) {
    std::wstring dll = runtime_dll(fixed);
    if (GetFileAttributesW(dll.c_str()) != INVALID_FILE_ATTRIBUTES) return {dll, "fixed", 1};
  }
  // Evergreen runtime: EdgeUpdate client state of the stable channel, per machine then per user.
  const wchar_t *sub = L"SOFTWARE\\Microsoft\\EdgeUpdate\\ClientState\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
  for (HKEY root : {HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER}) {
    HKEY key = nullptr;
    if (RegOpenKeyExW(root, sub, 0, KEY_READ | KEY_WOW64_32KEY, &key) != ERROR_SUCCESS) continue;
    wchar_t buf[2048];
    DWORD size = sizeof buf - sizeof(wchar_t), type = 0;
    LSTATUS st = RegQueryValueExW(key, L"EBWebView", nullptr, &type, reinterpret_cast<LPBYTE>(buf), &size);
    RegCloseKey(key);
    if (st != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ)) continue;
    buf[size / sizeof(wchar_t)] = 0;
    std::wstring dir = buf;
    while (!dir.empty() && (dir.back() == L'\\' || dir.back() == L'/')) dir.pop_back();
    auto slash = dir.find_last_of(L"\\/");
    std::string version = utf8(dir.substr(slash == std::wstring::npos ? 0 : slash + 1));
    // Our SDK needs a runtime build >= 1150 (third component), as webview/webview.
    int a = 0, b = 0, build = 0;
    if (sscanf(version.c_str(), "%d.%d.%d", &a, &b, &build) == 3 && build < 1150) continue;
    std::wstring dll = runtime_dll(dir);
    if (GetFileAttributesW(dll.c_str()) == INVALID_FILE_ATTRIBUTES) continue;
    return {dll, version, 0};
  }
  return {};
}

std::string webview2_version() { return find_runtime().version; }

static ICoreWebView2Environment *g_env = nullptr;
static bool g_env_pending = false;
static bool g_env_failed_shown = false;
static std::vector<std::function<void(ICoreWebView2Environment *)>> g_env_waiters;

static std::wstring user_data_dir() {
  wchar_t *local = nullptr;
  std::wstring base;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local)) && local) base = local;
  if (local) CoTaskMemFree(local);
  std::wstring dir = base + L"\\" + wide(app_identifier());
  CreateDirectoryW(dir.c_str(), nullptr);
  dir += L"\\WebView2";
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}

static void env_failed(HRESULT hr) {
  fprintf(stderr, "[shell] WebView2 environment failed: %s\n", hresult_message(hr).c_str());
  g_env_waiters.clear();
  if (g_env_failed_shown) return;
  g_env_failed_shown = true;
  // Unattended runs (launch() tests, CI): no modal dialog, just quit.
  wchar_t flag[8];
  bool unattended = GetEnvironmentVariableW(L"SVELTE_DESKTOP_TEST", flag, 8) || GetEnvironmentVariableW(L"SVELTE_DESKTOP_NO_DIALOGS", flag, 8);
  if (unattended) {
    emit_raw(json{{"type", "signal"}, {"signal", "SIGTERM"}});
    request_quit();
    return;
  }
  std::wstring text = wide(app_name()) +
                      L" needs the Microsoft Edge WebView2 Runtime, which was not found or could not start.\n\n"
                      L"Open the download page now?";
  if (MessageBoxW(nullptr, text.c_str(), wide(app_name()).c_str(), MB_YESNO | MB_ICONERROR | MB_SETFOREGROUND) == IDYES)
    ShellExecuteW(nullptr, L"open", L"https://go.microsoft.com/fwlink/p/?LinkId=2124703", nullptr, nullptr, SW_SHOWNORMAL);
  emit_raw(json{{"type", "signal"}, {"signal", "SIGTERM"}});
  request_quit();
}

using CreateEnvInternal_t = HRESULT(STDMETHODCALLTYPE *)(bool, int, PCWSTR, IUnknown *,
                                                         ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);

static void with_env(std::function<void(ICoreWebView2Environment *)> fn) {
  if (g_env) return fn(g_env);
  g_env_waiters.push_back(std::move(fn));
  if (g_env_pending) return;
  g_env_pending = true;
  Runtime rt = find_runtime();
  if (rt.dll.empty()) {
    g_env_pending = false;
    return env_failed(HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND));
  }
  // Never unloaded: the runtime client must outlive every controller.
  HMODULE client = LoadLibraryW(rt.dll.c_str());
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wcast-function-type"
  auto create = client ? reinterpret_cast<CreateEnvInternal_t>(GetProcAddress(client, "CreateWebViewEnvironmentWithOptionsInternal")) : nullptr;
#pragma GCC diagnostic pop
  if (!create) {
    g_env_pending = false;
    return env_failed(HRESULT_FROM_WIN32(client ? ERROR_PROC_NOT_FOUND : GetLastError()));
  }
  auto *handler = new Cb<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT, ICoreWebView2Environment *>(
      IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, [](HRESULT hr, ICoreWebView2Environment *env) -> HRESULT {
        g_env_pending = false;
        if (FAILED(hr) || !env) {
          env_failed(FAILED(hr) ? hr : E_FAIL);
          return S_OK;
        }
        env->AddRef();
        g_env = env;
        auto waiters = std::move(g_env_waiters);
        g_env_waiters.clear();
        for (auto &w : waiters) w(env);
        return S_OK;
      });
  std::wstring dir = user_data_dir();
  HRESULT hr = create(true, rt.type, dir.c_str(), nullptr, handler);
  handler->Release();
  if (FAILED(hr)) {
    g_env_pending = false;
    env_failed(hr);
  }
}

// ---------------------------------------------------------------------------
// Views

static std::map<int, View *> g_views;
std::map<int, View *> &views() { return g_views; }
View *find_view(int id) {
  auto it = g_views.find(id);
  return it == g_views.end() ? nullptr : it->second;
}

static Window *find_window_unchecked(int id);
static void recover_after_browser_exit();

static bool is_internal_url(const std::string &url) {
  std::string scheme = url_scheme(url);
  if (scheme == "about" || scheme == "data" || scheme == "blob") return true;
  std::string app = app_origin();
  if (app.empty()) return true; // before the app origin is known (initial blank page, set_html)
  return url_origin(url) == app;
}

static void open_external(int viewId, const std::string &url) {
  std::string scheme = url_scheme(url);
  if (scheme == "http" || scheme == "https" || scheme == "mailto")
    ShellExecuteW(nullptr, L"open", wide(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL);
  emit_raw(json{{"type", "external-navigation"}, {"window", viewId}, {"url", url}});
}

static std::string take_string(LPWSTR s) {
  std::string out = utf8(s);
  if (s) CoTaskMemFree(s);
  return out;
}

static void flush_pending(View *v) {
  v->ready = true;
  auto pending = std::move(v->pending);
  v->pending.clear();
  for (auto &fn : pending) fn();
}

static void setup_controller(View *v, ICoreWebView2Controller *ctl) {
  ctl->AddRef();
  v->controller = ctl;
  ctl->get_CoreWebView2(&v->webview);
  if (!v->webview) {
    v->failed = true;
    return;
  }
  int id = v->id;

  ICoreWebView2Settings *settings = nullptr;
  if (SUCCEEDED(v->webview->get_Settings(&settings)) && settings) {
    settings->put_AreDevToolsEnabled(v->debug ? TRUE : FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreDefaultContextMenusEnabled(v->contextMenu || v->debug ? TRUE : FALSE);
    settings->put_AreDefaultScriptDialogsEnabled(TRUE);
    settings->put_IsWebMessageEnabled(TRUE);
    settings->put_IsZoomControlEnabled(TRUE);
    // Browser shortcuts (F5, Ctrl+R, Ctrl+P, F12...) only in debug builds;
    // editing keys (Ctrl+C/V/X/Z/A) are unaffected.
    if (auto *s3 = query<ICoreWebView2Settings3>(settings, IID_ICoreWebView2Settings3)) {
      s3->put_AreBrowserAcceleratorKeysEnabled(v->debug ? TRUE : FALSE);
      s3->Release();
    }
    if (!v->userAgent.empty())
      if (auto *s2 = query<ICoreWebView2Settings2>(settings, IID_ICoreWebView2Settings2)) {
        s2->put_UserAgent(wide(v->userAgent).c_str());
        s2->Release();
      }
    settings->Release();
  }
  if (v->transparent)
    if (auto *c2 = query<ICoreWebView2Controller2>(ctl, IID_ICoreWebView2Controller2)) {
      COREWEBVIEW2_COLOR clear{0, 0, 0, 0};
      c2->put_DefaultBackgroundColor(clear);
      c2->Release();
    }

  // Page bridge: origin-checked by the core (on_bridge_message).
  auto *onMessage = new Cb<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *>(
      IID_ICoreWebView2WebMessageReceivedEventHandler, [id](ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT {
        LPWSTR src = nullptr, msg = nullptr;
        args->get_Source(&src);
        std::string source = take_string(src);
        if (SUCCEEDED(args->TryGetWebMessageAsString(&msg)) && msg) {
          std::string body = take_string(msg);
          // CoreWebView2.WebMessageReceived only carries top-level documents
          // (iframes raise ICoreWebView2Frame.WebMessageReceived instead).
          on_bridge_message(id, body, url_origin(source), true);
        }
        return S_OK;
      });
  v->webview->add_WebMessageReceived(onMessage, &v->tokens[0]);
  onMessage->Release();

  auto *onNav = new Cb<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *>(
      IID_ICoreWebView2NavigationStartingEventHandler, [id](ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *args) -> HRESULT {
        LPWSTR uri = nullptr;
        args->get_Uri(&uri);
        std::string url = take_string(uri);
        if (View *bv = find_view(id); bv && !bv->browserView.empty()) {
          // view.*: a browser view — web URLs load, anything else is refused.
          std::string sc = url_scheme(url);
          if (sc == "http" || sc == "https" || sc == "about" || sc == "data" || sc == "blob") emit("viewNavigated", json{{"id", bv->browserView}, {"url", url}});
          else args->put_Cancel(TRUE);
          return S_OK;
        }
        if (is_internal_url(url)) return S_OK;
        args->put_Cancel(TRUE);
        open_external(id, url);
        return S_OK;
      });
  v->webview->add_NavigationStarting(onNav, &v->tokens[1]);
  onNav->Release();

  auto *onNewWindow = new Cb<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *>(
      IID_ICoreWebView2NewWindowRequestedEventHandler, [id](ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *args) -> HRESULT {
        LPWSTR uri = nullptr;
        args->get_Uri(&uri);
        args->put_Handled(TRUE); // never a WebView2 popup window
        open_external(id, take_string(uri));
        return S_OK;
      });
  v->webview->add_NewWindowRequested(onNewWindow, &v->tokens[2]);
  onNewWindow->Release();

  auto *onDone = new Cb<ICoreWebView2NavigationCompletedEventHandler, ICoreWebView2 *, ICoreWebView2NavigationCompletedEventArgs *>(
      IID_ICoreWebView2NavigationCompletedEventHandler, [id](ICoreWebView2 *sender, ICoreWebView2NavigationCompletedEventArgs *done) -> HRESULT {
        LPWSTR src = nullptr;
        sender->get_Source(&src);
        std::string url = take_string(src);
        View *v = find_view(id);
        if (v && url_scheme(url) != "about") v->lastUrl = url;
        if (v && !v->browserView.empty()) {
          BOOL success = TRUE;
          done->get_IsSuccess(&success);
          COREWEBVIEW2_WEB_ERROR_STATUS status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
          if (!success) done->get_WebErrorStatus(&status);
          if (success) emit("viewLoaded", json{{"id", v->browserView}, {"url", url}});
          else emit("viewFailed", json{{"id", v->browserView}, {"error", "navigation failed (WebView2 status " + std::to_string((int)status) + ")"}});
          return S_OK;
        }
        // Fallback for hidden-until-ready when the bridge's DOMContentLoaded didn't arrive.
        if (Window *w = find_window_unchecked(id))
          if (!w->shown && url_scheme(url) != "about" && !url.empty()) reveal_window(w);
        return S_OK;
      });
  v->webview->add_NavigationCompleted(onDone, &v->tokens[3]);
  onDone->Release();

  auto *onFail = new Cb<ICoreWebView2ProcessFailedEventHandler, ICoreWebView2 *, ICoreWebView2ProcessFailedEventArgs *>(
      IID_ICoreWebView2ProcessFailedEventHandler, [id](ICoreWebView2 *sender, ICoreWebView2ProcessFailedEventArgs *args) -> HRESULT {
        COREWEBVIEW2_PROCESS_FAILED_KIND kind = COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
        args->get_ProcessFailedKind(&kind);
        if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED) {
          emit_raw(json{{"type", "webcontent-terminated"}, {"window", id}});
          backend_run_on_main(recover_after_browser_exit);
        } else if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED ||
                   kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE) {
          // Electrobun #550-style "frozen / web process died": reload instead of a dead view.
          emit_raw(json{{"type", "webcontent-terminated"}, {"window", id}});
          sender->Reload();
        }
        return S_OK;
      });
  v->webview->add_ProcessFailed(onFail, &v->tokens[4]);
  onFail->Release();

  auto *onPermission = new Cb<ICoreWebView2PermissionRequestedEventHandler, ICoreWebView2 *, ICoreWebView2PermissionRequestedEventArgs *>(
      IID_ICoreWebView2PermissionRequestedEventHandler, [](ICoreWebView2 *, ICoreWebView2PermissionRequestedEventArgs *args) -> HRESULT {
        LPWSTR uri = nullptr;
        args->get_Uri(&uri);
        bool app = url_origin(take_string(uri)) == app_origin() && !app_origin().empty();
        COREWEBVIEW2_PERMISSION_KIND kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
        args->get_PermissionKind(&kind);
        if (kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA ||
            kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE || kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS)
          args->put_State(app ? COREWEBVIEW2_PERMISSION_STATE_ALLOW : COREWEBVIEW2_PERMISSION_STATE_DENY);
        return S_OK;
      });
  v->webview->add_PermissionRequested(onPermission, &v->tokens[5]);
  onPermission->Release();

  // Menu accelerators while the page has keyboard focus (keys go to the browser process).
  auto *onKey = new Cb<ICoreWebView2AcceleratorKeyPressedEventHandler, ICoreWebView2Controller *, ICoreWebView2AcceleratorKeyPressedEventArgs *>(
      IID_ICoreWebView2AcceleratorKeyPressedEventHandler,
      [id](ICoreWebView2Controller *, ICoreWebView2AcceleratorKeyPressedEventArgs *args) -> HRESULT {
        COREWEBVIEW2_KEY_EVENT_KIND kind;
        args->get_KeyEventKind(&kind);
        if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) return S_OK;
        UINT vk = 0;
        args->get_VirtualKey(&vk);
        if (popover_key(id, vk) || handle_accelerator(vk, find_window_unchecked(id) ? id : 0)) args->put_Handled(TRUE);
        return S_OK;
      });
  ctl->add_AcceleratorKeyPressed(onKey, &v->tokens[6]);
  onKey->Release();

  // The bridge must be installed before the first navigation: queued
  // navigations run once the script is registered.
  std::string script = std::string("if(window.top===window){") + kBridgeScript + "}" + v->extraScript;
  auto *onScript = new Cb<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, HRESULT, LPCWSTR>(
      IID_ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, [id](HRESULT hr, LPCWSTR) -> HRESULT {
        View *v = find_view(id);
        if (!v || !v->controller) return S_OK;
        if (FAILED(hr)) fprintf(stderr, "[shell] bridge script failed: %s\n", hresult_message(hr).c_str());
        view_resize(v);
        v->controller->put_IsVisible(TRUE);
        theme_apply_view(v);
        flush_pending(v);
        return S_OK;
      });
  HRESULT hr = v->webview->AddScriptToExecuteOnDocumentCreated(wide(script).c_str(), onScript);
  onScript->Release();
  if (FAILED(hr)) {
    view_resize(v);
    v->controller->put_IsVisible(TRUE);
    flush_pending(v);
  }
}

void view_create(View *v) {
  int id = v->id;
  with_env([id](ICoreWebView2Environment *env) {
    View *v = find_view(id);
    if (!v || !v->host || v->controller) return;
    auto *handler = new Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT, ICoreWebView2Controller *>(
        IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, [id](HRESULT hr, ICoreWebView2Controller *ctl) -> HRESULT {
          View *v = find_view(id);
          if (!v) {
            if (ctl) ctl->Close(); // the window went away meanwhile
            return S_OK;
          }
          if (FAILED(hr) || !ctl) {
            v->failed = true;
            fprintf(stderr, "[shell] WebView2 controller failed for view %d: %s\n", id, hresult_message(hr).c_str());
            return S_OK;
          }
          setup_controller(v, ctl);
          return S_OK;
        });
    HRESULT hr = env->CreateCoreWebView2Controller(v->host, handler);
    handler->Release();
    if (FAILED(hr)) {
      v->failed = true;
      fprintf(stderr, "[shell] CreateCoreWebView2Controller: %s\n", hresult_message(hr).c_str());
    }
  });
}

void view_when_ready(View *v, std::function<void()> fn) {
  if (v->ready && v->pending.empty()) return fn();
  v->pending.push_back(std::move(fn));
}

void view_navigate(View *v, const std::string &url) {
  v->lastUrl = url;
  view_when_ready(v, [v, url] { v->webview->Navigate(wide(url).c_str()); });
}

void view_set_html(View *v, const std::string &html) {
  view_when_ready(v, [v, html] { v->webview->NavigateToString(wide(html).c_str()); });
}

void view_eval(View *v, const std::string &js) {
  view_when_ready(v, [v, js] { v->webview->ExecuteScript(wide(js).c_str(), nullptr); });
}

void view_resize(View *v) {
  if (!v->controller || !v->host) return;
  RECT r{};
  GetClientRect(v->host, &r);
  v->controller->put_Bounds(r);
}

void view_destroy(View *v) {
  g_views.erase(v->id);
  v->pending.clear();
  v->ready = false;
  if (v->webview) {
    v->webview->remove_WebMessageReceived(v->tokens[0]);
    v->webview->remove_NavigationStarting(v->tokens[1]);
    v->webview->remove_NewWindowRequested(v->tokens[2]);
    v->webview->remove_NavigationCompleted(v->tokens[3]);
    v->webview->remove_ProcessFailed(v->tokens[4]);
    v->webview->remove_PermissionRequested(v->tokens[5]);
  }
  if (v->controller) {
    v->controller->remove_AcceleratorKeyPressed(v->tokens[6]);
    v->controller->Close();
  }
  release(v->webview);
  release(v->controller);
}

double view_zoom(View *v) {
  double z = 1;
  if (v && v->controller) v->controller->get_ZoomFactor(&z);
  return z;
}

void view_execute(View *v, const std::string &code,
                  std::function<void(bool ok, const json &value, const std::string &error)> done) {
  view_when_ready(v, [v, code, done] {
    // Runtime.evaluate: awaits promises, value of the last statement, unaffected by page CSP.
    json params = {{"expression", code}, {"awaitPromise", true}, {"returnByValue", true}, {"userGesture", true}};
    ICoreWebView2 *wv = v->webview;
    wv->AddRef();
    auto *cb = new Cb<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, HRESULT, LPCWSTR>(
        IID_ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, [wv, code, done](HRESULT hr, LPCWSTR result) -> HRESULT {
          json r = SUCCEEDED(hr) && result ? json::parse(utf8(result), nullptr, false) : json();
          if (r.is_object() && r.contains("result")) {
            wv->Release();
            if (r.contains("exceptionDetails")) {
              const json &ex = r["exceptionDetails"];
              std::string msg = ex.contains("exception") ? jstr(ex["exception"], "description", jstr(ex, "text", "JavaScript error"))
                                                          : jstr(ex, "text", "JavaScript error");
              done(false, nullptr, msg);
            } else {
              const json &res = r["result"];
              done(true, res.contains("value") ? res["value"] : json(nullptr), "");
            }
            return S_OK;
          }
          // DevTools protocol unavailable: plain ExecuteScript (no promise awaiting).
          auto *fallback = new Cb<ICoreWebView2ExecuteScriptCompletedHandler, HRESULT, LPCWSTR>(
              IID_ICoreWebView2ExecuteScriptCompletedHandler, [done](HRESULT hr2, LPCWSTR json2) -> HRESULT {
                if (FAILED(hr2)) done(false, nullptr, hresult_message(hr2));
                else {
                  json value = json2 ? json::parse(utf8(json2), nullptr, false) : json(nullptr);
                  done(true, value.is_discarded() ? json(nullptr) : value, "");
                }
                return S_OK;
              });
          wv->ExecuteScript(wide(code).c_str(), fallback);
          fallback->Release();
          wv->Release();
          return S_OK;
        });
    wv->CallDevToolsProtocolMethod(L"Runtime.evaluate", wide(params.dump()).c_str(), cb);
    cb->Release();
  });
}

// The browser process died: every controller is dead. Drop the environment and
// recreate each web view at its last URL.
static void recover_after_browser_exit() {
  release(g_env);
  std::vector<std::pair<View *, std::string>> todo;
  for (auto &[id, v] : g_views) todo.emplace_back(v, v->lastUrl);
  for (auto &[v, url] : todo) {
    if (v->controller) v->controller->Close();
    release(v->webview);
    release(v->controller);
    v->pending.clear();
    v->ready = false;
    view_create(v);
    if (!url.empty()) view_navigate(v, url);
  }
}

// ---------------------------------------------------------------------------
// Windows

static std::map<int, Window *> g_windows;
static std::vector<int> g_order;
static int g_next_id = 1;
static bool g_first_ready = false;

static Window *find_window_unchecked(int id) {
  auto it = g_windows.find(id);
  return it == g_windows.end() ? nullptr : it->second;
}
Window *find_window(int id) { return find_window_unchecked(id); }
Window *find_window_hwnd(HWND hwnd) {
  for (auto &[id, w] : g_windows)
    if (w->hwnd == hwnd) return w;
  return nullptr;
}
const std::vector<int> &window_order() { return g_order; }
int primary_window() { return g_order.empty() ? 0 : g_order.front(); }

int resolve_window(const Call &c) {
  if (c.has("windowId")) {
    int pid = (int)c.num("windowId", 0);
    if (pid == 0) return primary_window();
    return find_window(pid) ? pid : 0;
  }
  if (c.caller && find_window(c.caller)) return c.caller;
  if (Window *fg = find_window_hwnd(GetForegroundWindow())) return fg->id;
  return primary_window();
}

void reveal_window(Window *w) {
  if (w->shown) return;
  w->shown = true;
  KillTimer(w->hwnd, kRevealTimer);
  ShowWindow(w->hwnd, w->startMaximized ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
  w->startMaximized = false;
  SetForegroundWindow(w->hwnd);
}

static std::wstring autosave_key(const std::string &name) {
  return L"Software\\" + wide(app_identifier()) + L"\\WindowState\\" + wide(name);
}

static void save_placement(Window *w) {
  if (w->autosaveName.empty()) return;
  WINDOWPLACEMENT wp{sizeof wp};
  if (!GetWindowPlacement(w->hwnd, &wp)) return;
  HKEY key = nullptr;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, autosave_key(w->autosaveName).c_str(), 0, nullptr, 0, KEY_WRITE, nullptr, &key, nullptr) != ERROR_SUCCESS)
    return;
  RegSetValueExW(key, L"Placement", 0, REG_BINARY, reinterpret_cast<const BYTE *>(&wp), sizeof wp);
  RegCloseKey(key);
}

static bool restore_placement(Window *w) {
  if (w->autosaveName.empty()) return false;
  WINDOWPLACEMENT wp{};
  DWORD size = sizeof wp;
  if (RegGetValueW(HKEY_CURRENT_USER, autosave_key(w->autosaveName).c_str(), L"Placement", RRF_RT_REG_BINARY, nullptr, &wp, &size) != ERROR_SUCCESS ||
      size != sizeof wp || wp.length != sizeof wp)
    return false;
  // Only when the saved frame is still on a connected monitor.
  if (!MonitorFromRect(&wp.rcNormalPosition, MONITOR_DEFAULTTONULL)) return false;
  bool maximized = wp.showCmd == SW_SHOWMAXIMIZED || wp.showCmd == SW_MAXIMIZE || (wp.flags & WPF_RESTORETOMAXIMIZED);
  wp.showCmd = SW_HIDE; // revealed later (hidden-until-ready)
  SetWindowPlacement(w->hwnd, &wp);
  w->startMaximized = maximized;
  return true;
}

static json window_event_id(int id) { return json(backend_public_window_id(id)); }

static void emit_bounds(Window *w) {
  json b = window_bounds_json(w->hwnd);
  b["windowId"] = window_event_id(w->id);
  emit("boundsChanged", b);
}

static void destroy_window_state(Window *w) {
  int id = w->id;
  int publicId = backend_public_window_id(id);
  save_placement(w);
  view_destroy(&w->view);
  g_windows.erase(id);
  g_order.erase(std::remove(g_order.begin(), g_order.end(), id), g_order.end());
  if (w->menu) DestroyMenu(w->menu);
  delete w;
  emit_raw(json{{"type", "closed"}, {"window", id}});
  emit("closed", json{{"windowId", publicId}});
  // Same as macOS: closing the last window ends the run loop (graceful quit).
  if (g_order.empty() && g_quit_on_last_window) request_quit();
}

static LRESULT CALLBACK window_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  Window *w = reinterpret_cast<Window *>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  if (msg == WM_NCCREATE) {
    auto *cs = reinterpret_cast<CREATESTRUCTW *>(lp);
    w = static_cast<Window *>(cs->lpCreateParams);
    w->hwnd = hwnd;
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(w));
  }
  if (!w) return DefWindowProcW(hwnd, msg, wp, lp);
  static const UINT taskbarButtonCreated = RegisterWindowMessageW(L"TaskbarButtonCreated");
  if (msg == taskbarButtonCreated) taskbar_button_created(hwnd); // badge overlay (svc_notifications.cc)
  switch (msg) {
    case WM_SIZE:
      view_resize(&w->view);
      embedded_views_resized(w);
      if (wp != SIZE_MINIMIZED) emit_bounds(w);
      return 0;
    case WM_MOVE:
      emit_bounds(w);
      return 0;
    case WM_ACTIVATE: {
      bool active = LOWORD(wp) != WA_INACTIVE;
      if (active && w->view.controller) w->view.controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
      emit_raw(json{{"type", active ? "focus" : "blur"}, {"window", w->id}});
      emit("focusChanged", json{{"focused", active}, {"windowId", window_event_id(w->id)}});
      return 0;
    }
    case WM_GETMINMAXINFO: {
      auto *mmi = reinterpret_cast<MINMAXINFO *>(lp);
      double s = hwnd_scale(hwnd);
      DWORD style = (DWORD)GetWindowLongPtrW(hwnd, GWL_STYLE), ex = (DWORD)GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
      auto frame = [&](double cw, double ch, LONG &outW, LONG &outH) {
        RECT r{0, 0, (LONG)(cw * s), (LONG)(ch * s)};
        adjust_for_dpi(&r, style, GetMenu(hwnd) != nullptr, ex, (UINT)(s * 96));
        outW = r.right - r.left;
        outH = r.bottom - r.top;
      };
      if (w->minW > 0 || w->minH > 0) frame(w->minW, w->minH, mmi->ptMinTrackSize.x, mmi->ptMinTrackSize.y);
      if (w->maxW > 0 || w->maxH > 0) {
        LONG mw, mh;
        frame(w->maxW > 0 ? w->maxW : 100000, w->maxH > 0 ? w->maxH : 100000, mw, mh);
        mmi->ptMaxTrackSize.x = mw;
        mmi->ptMaxTrackSize.y = mh;
      }
      return 0;
    }
    case 0x02E0: { // WM_DPICHANGED
      auto *r = reinterpret_cast<RECT *>(lp);
      SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      emit("scaleFactorChanged", json{{"scaleFactor", HIWORD(wp) / 96.0}, {"windowId", window_event_id(w->id)}});
      return 0;
    }
    case WM_COMMAND:
      if (HIWORD(wp) == 0 && lp == 0 && handle_menu_command(LOWORD(wp), w->id)) return 0;
      break;
    case WM_TIMER:
      if (wp == kRevealTimer) {
        KillTimer(hwnd, kRevealTimer);
        reveal_window(w);
        return 0;
      }
      break;
    case WM_CLOSE:
      if (w->veto) {
        emit("willClose", json{{"windowId", window_event_id(w->id)}});
        return 0;
      }
      // quitOnLastWindowClosed: false — the last visible window hides instead (as on macOS and
      // Linux): the app, its page and its push connection live on; a toast click or a second
      // launch shows it again (show_main_window).
      if (!g_quit_on_last_window) {
        bool other = false;
        for (int id : g_order)
          if (Window *o = find_window(id); o && o != w && IsWindowVisible(o->hwnd)) other = true;
        if (!other) {
          ShowWindow(hwnd, SW_HIDE);
          return 0;
        }
      }
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      KillTimer(hwnd, kRevealTimer);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
      destroy_window_state(w);
      return 0;
    case WM_ERASEBKGND: {
      // Paint the theme background under the web view (no white flash in dark mode).
      RECT r;
      GetClientRect(hwnd, &r);
      HBRUSH b = CreateSolidBrush(app_dark() ? RGB(32, 32, 32) : RGB(255, 255, 255));
      FillRect(reinterpret_cast<HDC>(wp), &r, b);
      DeleteObject(b);
      return 1;
    }
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

static LRESULT CALLBACK msg_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_SD_RUN) {
    drain_queue();
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

static LRESULT CALLBACK hidden_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  for (auto &hook : g_hidden_hooks) {
    LRESULT result = 0;
    if (hook(hwnd, msg, wp, lp, &result)) return result;
  }
  switch (msg) {
    case WM_QUERYENDSESSION:
      // Logoff / shutdown / restart: same graceful path as Cmd+Q on macOS.
      emit("willQuit", json::object());
      request_quit();
      return TRUE;
    case WM_ENDSESSION:
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

static const wchar_t *kWindowClass = L"SvelteDesktopWindow";
const wchar_t *const kHiddenClass = L"SvelteDesktopHidden";

static void register_classes() {
  HINSTANCE inst = GetModuleHandleW(nullptr);
  WNDCLASSEXW wc{sizeof wc};
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = window_proc;
  wc.hInstance = inst;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hIcon = app_icon(false);
  wc.hIconSm = app_icon(true);
  wc.lpszClassName = kWindowClass;
  RegisterClassExW(&wc);

  WNDCLASSEXW mc{sizeof mc};
  mc.lpfnWndProc = msg_proc;
  mc.hInstance = inst;
  mc.lpszClassName = L"SvelteDesktopMessage";
  RegisterClassExW(&mc);

  WNDCLASSEXW hc{sizeof hc};
  hc.lpfnWndProc = hidden_proc;
  hc.hInstance = inst;
  hc.lpszClassName = kHiddenClass;
  RegisterClassExW(&hc);
}

static void init_main_thread(const json &o) {
  g_main_tid = GetCurrentThreadId();
  if (g_app_name.empty()) g_app_name = jstr(o, "appName");
  if (g_app_identifier.empty()) g_app_identifier = jstr(o, "identifier");
  HRESULT hr = OleInitialize(nullptr); // STA: required by WebView2, clipboard, shell dialogs
  if (FAILED(hr) && hr != S_FALSE)
    fprintf(stderr, "[shell] OleInitialize failed (%s); WebView2 needs an STA main thread\n", hresult_message(hr).c_str());
  enable_dpi_awareness();
  register_classes();
  HINSTANCE inst = GetModuleHandleW(nullptr);
  HWND msgWnd = CreateWindowExW(0, L"SvelteDesktopMessage", nullptr, 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, inst, nullptr);
  g_msg.store(msgWnd);
  // Title = identifier: second instances find the holder with FindWindow (svc_app.cc).
  g_hidden = CreateWindowExW(WS_EX_TOOLWINDOW, kHiddenClass, wide(app_identifier()).c_str(), WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, inst, nullptr);
  // Register the service modules now so their system hooks (theme, power,
  // displays) are live before the first platform call.
  dispatch(json{{"service", ""}, {"op", ""}}, 0, [](const json &) {});
  PostMessageW(msgWnd, WM_SD_RUN, 0, 0); // drain anything queued before the window existed
}

static int create_window(const json &o) {
  // Opening a document or a link from Explorer starts a new process: hand it to the
  // running instance (openUrls / openFiles there) and leave before any window.
  if (g_order.empty() && jbool(o, "singleInstance", false) && !claim_single_instance()) ExitProcess(0);
  if (g_order.empty() && o.contains("quitOnLastWindowClosed")) g_quit_on_last_window = jbool(o, "quitOnLastWindowClosed", true);
  auto *w = new Window;
  w->id = g_next_id++;
  w->label = jstr(o, "label", g_order.empty() ? "main" : "window-" + std::to_string(w->id));
  w->autosaveName = jstr(o, "autosaveName");
  w->minW = jnum(o, "minWidth", 0);
  w->minH = jnum(o, "minHeight", 0);
  w->maxW = jnum(o, "maxWidth", 0);
  w->maxH = jnum(o, "maxHeight", 0);

  DWORD style = WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN;
  if (!jbool(o, "resizable", true)) style &= ~(WS_THICKFRAME | WS_MAXIMIZEBOX);
  if (!jbool(o, "minimizable", true)) style &= ~WS_MINIMIZEBOX;
  if (!jbool(o, "maximizable", true)) style &= ~WS_MAXIMIZEBOX;
  if (!jbool(o, "decorations", true)) style = WS_POPUP | WS_CLIPCHILDREN | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | (jbool(o, "resizable", true) ? WS_THICKFRAME : 0);
  DWORD ex = WS_EX_APPWINDOW;
  if (jbool(o, "alwaysOnTop", false)) ex |= WS_EX_TOPMOST;

  // Size in DIPs at the target monitor's scale.
  POINT origin{0, 0};
  HMONITOR mon = MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
  double ps = monitor_scale(mon);
  bool positioned = jhas(o, "x") && jhas(o, "y");
  if (positioned) {
    POINT p{(LONG)(jnum(o, "x", 0) * ps), (LONG)(jnum(o, "y", 0) * ps)};
    mon = MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST);
  }
  double s = monitor_scale(mon);
  double width = jnum(o, "width", 1024), height = jnum(o, "height", 720);
  RECT frame{0, 0, (LONG)(width * s), (LONG)(height * s)};
  adjust_for_dpi(&frame, style, FALSE, ex, (UINT)(s * 96));
  int fw = frame.right - frame.left, fh = frame.bottom - frame.top;
  MONITORINFO mi{sizeof mi};
  GetMonitorInfoW(mon, &mi);
  int x, y;
  if (positioned) {
    x = (int)(jnum(o, "x", 0) * s);
    y = (int)(jnum(o, "y", 0) * s);
  } else {
    x = mi.rcWork.left + ((mi.rcWork.right - mi.rcWork.left) - fw) / 2;
    y = mi.rcWork.top + ((mi.rcWork.bottom - mi.rcWork.top) - fh) / 2;
  }
  std::wstring title = wide(jstr(o, "title", app_name()));
  HWND hwnd = CreateWindowExW(ex, kWindowClass, title.c_str(), style, x, y, fw, fh, nullptr, nullptr, GetModuleHandleW(nullptr), w);
  if (!hwnd) {
    delete w;
    return -1;
  }
  g_windows[w->id] = w;
  g_order.push_back(w->id);
  restore_placement(w);

  w->view.id = w->id;
  w->view.host = hwnd;
  w->view.debug = jbool(o, "debug", false);
  w->view.contextMenu = w->view.debug;
  w->view.transparent = jbool(o, "transparent", false);
  g_views[w->id] = &w->view;
  attach_app_menu(w);
  theme_apply_window(w);
  view_create(&w->view);
  if (!jstr(o, "titleBarStyle", "").empty()) set_title_bar_style(w->id, jstr(o, "titleBarStyle", ""));

  bool hidden = jbool(o, "hiddenUntilReady", true);
  bool visible = jbool(o, "visible", jbool(o, "show", true));
  if (!visible) w->shown = true; // never auto-reveal; window.show() does
  else if (!hidden) reveal_window(w);
  else SetTimer(hwnd, kRevealTimer, (UINT)jnum(o, "readyTimeoutMs", 3000), nullptr);

  if (jhas(o, "url")) view_navigate(&w->view, jstr(o, "url"));
  else if (jhas(o, "html")) view_set_html(&w->view, jstr(o, "html"));
  return w->id;
}

// quitOnLastWindowClosed: false and no window left: a toast click / second instance
// reopens the main one (like a Dock click on macOS), at the app's origin.
static int recreate_main_window() {
  if (!g_order.empty() || !g_main_opts.is_object()) return 0;
  json o = g_main_opts;
  for (const char *k : {"args", "cwd", "singleInstance", "url", "html"}) o.erase(k);
  o["label"] = "main";
  return create_app_window(o);
}

// quitOnLastWindowClosed: false: with no visible window, a toast click or a second launch shows
// the hidden main window again (page and state kept), or recreates it if it was destroyed.
int show_main_window() {
  for (int id : g_order)
    if (Window *w = find_window(id); w && IsWindowVisible(w->hwnd)) return 0;
  if (g_order.empty()) return recreate_main_window();
  Window *w = find_window(g_order.front());
  if (!w) return 0;
  ShowWindow(w->hwnd, IsIconic(w->hwnd) ? SW_RESTORE : SW_SHOW);
  SetForegroundWindow(w->hwnd);
  return w->id;
}

int create_app_window(const json &opts) {
  std::string label = jstr(opts, "label");
  if (!label.empty())
    for (auto &[id, w] : g_windows)
      if (w->label == label) return -4;
  json o = opts.is_object() ? opts : json::object();
  std::string origin = app_origin();
  if (!origin.empty() && !jhas(o, "url") && !jhas(o, "html")) {
    std::string path = jstr(o, "path", "/");
    o["url"] = origin + (path.rfind('/', 0) == 0 ? path : "/" + path);
  }
  int id = create_window(o);
  if (id > 0) emit("created", json{{"windowId", backend_public_window_id(id)}, {"label", find_window(id)->label}});
  return id;
}

// Called by the bridge's DOMContentLoaded.
static void page_ready(int id) {
  if (Window *w = find_window(id)) {
    reveal_window(w);
    emit_raw(json{{"type", "ready"}, {"window", id}});
  } else {
    popover_page_ready(id);
  }
  if (!g_first_ready) {
    g_first_ready = true;
    on_first_page_ready();
  }
}

static BOOL WINAPI console_handler(DWORD type) {
  const char *sig = type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT ? "SIGINT" : type == CTRL_CLOSE_EVENT ? "SIGHUP" : "SIGTERM";
  emit_raw(json{{"type", "signal"}, {"signal", sig}});
  shell_quit();
  // The process is terminated as soon as these return: leave time for the graceful path.
  if (type == CTRL_CLOSE_EVENT || type == CTRL_LOGOFF_EVENT || type == CTRL_SHUTDOWN_EVENT) Sleep(4000);
  return TRUE;
}

static int run_loop() {
  SetConsoleCtrlHandler(console_handler, TRUE);
  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  for (auto &hook : g_quit_hooks) hook();
  // The Worker gets a bounded graceful shutdown after this returns; don't leave
  // frozen windows on screen meanwhile.
  for (int id : g_order)
    if (Window *w = find_window(id)) ShowWindow(w->hwnd, SW_HIDE);
  return 0;
}

static int with_window(int id, std::function<void(Window *)> fn) {
  backend_run_on_main([id, fn] {
    if (Window *w = find_window(id)) fn(w);
  });
  return 0;
}

void set_content_size(Window *w, double width, double height) {
  double s = hwnd_scale(w->hwnd);
  RECT r{0, 0, (LONG)(width * s), (LONG)(height * s)};
  adjust_for_dpi(&r, (DWORD)GetWindowLongPtrW(w->hwnd, GWL_STYLE), GetMenu(w->hwnd) != nullptr, (DWORD)GetWindowLongPtrW(w->hwnd, GWL_EXSTYLE),
                 (UINT)(s * 96));
  SetWindowPos(w->hwnd, nullptr, 0, 0, r.right - r.left, r.bottom - r.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

static std::string copy_str(const char *s) { return s ? std::string(s) : std::string(); }

} // namespace sd::win

// ---------------------------------------------------------------------------
// Backend hooks (core.hpp)

namespace sd {
using namespace sd::win;

void backend_run_on_main(std::function<void()> fn) {
  {
    std::lock_guard<std::mutex> lock(g_queue_mutex);
    g_queue.push_back(std::move(fn));
  }
  if (HWND h = g_msg.load()) PostMessageW(h, WM_SD_RUN, 0, 0);
}

bool backend_is_main_thread() {
  DWORD tid = g_main_tid.load();
  return tid != 0 && GetCurrentThreadId() == tid;
}

void backend_eval_in_page(int nativeId, const std::string &js) {
  View *v = find_view(nativeId);
  if (v && v->webview) v->webview->ExecuteScript(wide(js).c_str(), nullptr);
}

std::vector<int> backend_page_ids() {
  std::vector<int> ids;
  for (auto &[id, v] : g_views)
    if (v->webview) ids.push_back(id);
  return ids;
}

void backend_page_ready(int nativeId) { page_ready(nativeId); }

int backend_public_window_id(int nativeId) { return (!g_order.empty() && g_order.front() == nativeId) ? 0 : nativeId; }
int backend_native_window_id(int publicId) { return publicId == 0 ? primary_window() : publicId; }

// Hidden title bar: no caption (WS_POPUP + resizable frame); the page draws its own
// controls and drags the window through its drag regions.
void backend_set_frameless(int nativeId, bool frameless) {
  Window *w = find_window(nativeId);
  if (!w) return;
  LONG_PTR style = GetWindowLongPtrW(w->hwnd, GWL_STYLE);
  const LONG_PTR keep = WS_VISIBLE | WS_CLIPCHILDREN | (style & (WS_MINIMIZE | WS_MAXIMIZE));
  style = frameless ? (keep | WS_POPUP | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX) : (keep | WS_OVERLAPPEDWINDOW);
  SetWindowLongPtrW(w->hwnd, GWL_STYLE, style);
  SetWindowPos(w->hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

void backend_window_drag(int nativeId, bool doubleClick) {
  Window *w = find_window(nativeId);
  if (!w) return;
  if (doubleClick) {
    ShowWindow(w->hwnd, IsZoomed(w->hwnd) ? SW_RESTORE : SW_MAXIMIZE);
    return;
  }
  // The classic move loop: as if the caption had been pressed.
  ReleaseCapture();
  SendMessageW(w->hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
}

void *backend_native_window(int nativeId) {
  if (Window *w = find_window(nativeId)) return w->hwnd;
  View *v = find_view(nativeId);
  return v ? v->host : nullptr;
}

void *backend_native_webview(int nativeId) {
  View *v = find_view(nativeId);
  return v ? v->webview : nullptr;
}

void backend_init_services() {
  register_app();
  register_window();
  register_embed();
  register_screen();
  register_clipboard();
  register_shell();
  register_dialog();
  register_theme();
  register_menu();
  register_system();
  register_power();
  register_secure_storage();
  register_notifications();
  register_tray();
  register_shortcuts();
  register_diagnostics();
  register_popover();
  register_webview();
  register_deep_link();
}
} // namespace sd

// ---------------------------------------------------------------------------
// C exports (window + run loop half of shell.h; the rest is in portable/core.cc)

using sd::json;
using namespace sd::win;

extern "C" {

SHELL_API int shell_window_create(const char *opts_json) {
  json o = opts_json ? json::parse(opts_json, nullptr, false) : json::object();
  if (!o.is_object()) o = json::object();
  if (g_main_tid.load() == 0) init_main_thread(o);
  else if (GetCurrentThreadId() != g_main_tid.load()) return -2;
  if (g_main_opts.is_null()) g_main_opts = o;
  return create_window(o);
}

SHELL_API int shell_run(void) {
  if (!sd::backend_is_main_thread()) return -2;
  if (g_order.empty()) return -1;
  return run_loop();
}

SHELL_API int shell_quit(void) {
  sd::backend_run_on_main([] { request_quit(); });
  return 0;
}

SHELL_API int shell_window_navigate(int id, const char *url) {
  if (!url) return -3;
  std::string s = copy_str(url);
  return with_window(id, [s](Window *w) { view_navigate(&w->view, s); });
}

SHELL_API int shell_window_eval(int id, const char *js) {
  if (!js) return -3;
  std::string s = copy_str(js);
  return with_window(id, [s](Window *w) { view_eval(&w->view, s); });
}

SHELL_API int shell_window_set_title(int id, const char *title) {
  if (!title) return -3;
  std::string s = copy_str(title);
  return with_window(id, [s](Window *w) { SetWindowTextW(w->hwnd, wide(s).c_str()); });
}

SHELL_API int shell_window_set_size(int id, int width, int height) {
  return with_window(id, [width, height](Window *w) { set_content_size(w, width, height); });
}

SHELL_API int shell_window_show(int id) {
  return with_window(id, [](Window *w) {
    w->shown = false;
    reveal_window(w);
  });
}

SHELL_API int shell_window_hide(int id) {
  return with_window(id, [](Window *w) { ShowWindow(w->hwnd, SW_HIDE); });
}

SHELL_API int shell_window_focus(int id) {
  return with_window(id, [](Window *w) {
    if (IsIconic(w->hwnd)) ShowWindow(w->hwnd, SW_RESTORE);
    else if (!IsWindowVisible(w->hwnd)) ShowWindow(w->hwnd, SW_SHOW);
    SetForegroundWindow(w->hwnd);
  });
}

SHELL_API int shell_window_close(int id) {
  return with_window(id, [](Window *w) { PostMessageW(w->hwnd, WM_CLOSE, 0, 0); });
}

SHELL_API int shell_menu_set(const char *spec_json) {
  json spec = spec_json ? json::parse(spec_json, nullptr, false) : json();
  if (!spec.is_array()) return -3;
  sd::backend_run_on_main([spec] {
    std::string error;
    if (!set_legacy_menu(spec, error)) fprintf(stderr, "[shell] shell_menu_set: %s\n", error.c_str());
  });
  return 0;
}

SHELL_API int shell_dialog(int request_id, const char *opts_json) {
  json o = opts_json ? json::parse(opts_json, nullptr, false) : json();
  if (!o.is_object()) return -3;
  sd::backend_run_on_main([request_id, o] {
    HWND parent = nullptr;
    if (Window *w = find_window_hwnd(GetForegroundWindow())) parent = w->hwnd;
    std::string kind = jstr(o, "kind");
    if (kind == "message") {
      run_message_box(o, parent, [request_id](int button) {
        sd::emit_raw(json{{"type", "dialog"}, {"requestId", request_id}, {"button", button}});
      });
      return;
    }
    run_file_dialog(o, kind == "save", parent, [request_id](bool canceled, std::vector<std::string> paths) {
      sd::emit_raw(json{{"type", "dialog"}, {"requestId", request_id}, {"canceled", canceled}, {"paths", paths}});
    });
  });
  return 0;
}

} // extern "C"
