// Smoke test of shell.dll's non-UI exports, run under Wine (no WebView2):
// loads the DLL, checks the ABI, then drives the platform dispatcher through
// shell_platform_call with a stub event sink and pumps the message loop.
//   x86_64-w64-mingw32-clang++ -std=c++17 smoke.cc -o smoke.exe
#include <windows.h>

#include <atomic>
#include <cstdio>
#include <cstring>
#include <string>

typedef void (*sink_fn)(const char *);
static void (*p_free)(void *);
static std::atomic<int> g_results{0};
static int g_failures = 0;
static std::string g_replies[64];
static std::string g_events;

static void sink(const char *json) {
  printf("  <- %s\n", json);
  std::string s(json);
  if (s.find("\"platformResult\"") != std::string::npos) {
    g_results++;
    for (int i = 1; i < 64; i++) {
      // Keys are sorted (nlohmann): ..."id":N,"ok":...
      if (s.find("\"id\":" + std::to_string(i) + ",\"ok\"") != std::string::npos) g_replies[i] = s;
    }
  } else {
    g_events += s + "\n";
  }
  p_free((void *)json);
}

static void expect(int id, const char *needle) {
  bool ok = g_replies[id].find(needle) != std::string::npos;
  printf("%s reply %d contains %s\n", ok ? "ok  " : "FAIL", id, needle);
  if (!ok) g_failures++;
}

static void pump(int ms, bool (*until)() = nullptr) {
  DWORD start = GetTickCount();
  while (GetTickCount() - start < (DWORD)ms && !(until && until())) {
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) g_events += "WM_QUIT\n";
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    Sleep(5);
  }
}

template <class T> static T sym(HMODULE m, const char *name) {
  FARPROC p = GetProcAddress(m, name);
  if (!p) {
    printf("FAIL missing export %s\n", name);
    g_failures++;
  }
  return reinterpret_cast<T>(reinterpret_cast<void *>(p));
}

int main() {
  SetEnvironmentVariableW(L"SVELTE_DESKTOP_NO_DIALOGS", L"1");
  HMODULE m = LoadLibraryW(L"shell.dll");
  if (!m) {
    printf("FAIL LoadLibrary(shell.dll): %lu\n", GetLastError());
    return 1;
  }
  printf("ok   LoadLibrary(shell.dll)\n");
  const char *exports[] = {"shell_abi_version", "shell_set_event_sink", "shell_free", "shell_window_create", "shell_run", "shell_quit",
                           "shell_window_navigate", "shell_window_eval", "shell_window_set_title", "shell_window_set_size",
                           "shell_window_show", "shell_window_hide", "shell_window_focus", "shell_window_close", "shell_set_app_origin",
                           "shell_menu_set", "shell_dialog", "shell_platform_call", "shell_load_plugin", "shell_set_page_permissions"};
  for (const char *e : exports) sym<void *>(m, e);
  auto abi = sym<int (*)()>(m, "shell_abi_version");
  auto set_sink = sym<void (*)(sink_fn)>(m, "shell_set_event_sink");
  p_free = sym<void (*)(void *)>(m, "shell_free");
  auto create = sym<int (*)(const char *)>(m, "shell_window_create");
  auto call = sym<int (*)(const char *)>(m, "shell_platform_call");
  auto origin = sym<int (*)(const char *)>(m, "shell_set_app_origin");
  auto perms = sym<int (*)(const char *)>(m, "shell_set_page_permissions");
  if (g_failures) return 1;
  int v = abi();
  printf("%s shell_abi_version() = %d\n", v == 2 ? "ok  " : "FAIL", v);
  if (v != 2) g_failures++;
  set_sink(sink);
  origin("http://127.0.0.1:4321");
  perms("[\"app.*\",\"window.getTitle\"]");
  int id = create("{\"appName\":\"Smoke\",\"identifier\":\"dev.svelte-desktop.smoke\",\"visible\":false,\"title\":\"Smoke\"}");
  printf("%s shell_window_create() = %d (WebView2 is absent under Wine: the controller never starts)\n", id > 0 ? "ok  " : "FAIL", id);
  if (id <= 0) g_failures++;
  const char *requests[] = {
      "{\"id\":1,\"service\":\"app\",\"op\":\"getInfo\"}",
      "{\"id\":2,\"service\":\"app\",\"op\":\"getPath\",\"args\":{\"name\":\"userData\"}}",
      "{\"id\":3,\"service\":\"diagnostics\",\"op\":\"info\"}",
      "{\"id\":4,\"service\":\"theme\",\"op\":\"get\"}",
      "{\"id\":5,\"service\":\"screen\",\"op\":\"getAllDisplays\"}",
      "{\"id\":6,\"service\":\"window\",\"op\":\"getTitle\"}",
      "{\"id\":7,\"service\":\"window\",\"op\":\"list\"}",
      "{\"id\":8,\"service\":\"secureStorage\",\"op\":\"setPassword\",\"args\":{\"service\":\"smoke\",\"account\":\"a\",\"password\":\"s3cret\"}}",
      "{\"id\":9,\"service\":\"secureStorage\",\"op\":\"getPassword\",\"args\":{\"service\":\"smoke\",\"account\":\"a\"}}",
      "{\"id\":10,\"service\":\"secureStorage\",\"op\":\"deletePassword\",\"args\":{\"service\":\"smoke\",\"account\":\"a\"}}",
      "{\"id\":11,\"service\":\"clipboard\",\"op\":\"writeText\",\"args\":{\"text\":\"h\\u00e9llo\"}}",
      "{\"id\":12,\"service\":\"clipboard\",\"op\":\"readText\"}",
      "{\"id\":13,\"service\":\"power\",\"op\":\"blockSleep\",\"args\":{\"type\":\"display\"}}",
      "{\"id\":14,\"service\":\"nope\",\"op\":\"x\"}",
      "{\"id\":15,\"service\":\"app\",\"op\":\"nope\"}",
      "{\"id\":16,\"service\":\"menu\",\"op\":\"setAppMenu\",\"args\":{\"menus\":[{\"name\":\"&File\",\"items\":[{\"label\":\"Hello\",\"id\":\"hello\",\"accelerator\":\"CmdOrCtrl+Shift+H\"},{\"type\":\"separator\"},{\"role\":\"quit\"}]}]}}",
      "{\"id\":17,\"service\":\"menu\",\"op\":\"items\"}",
      "{\"id\":18,\"service\":\"menu\",\"op\":\"update\",\"args\":{\"id\":\"hello\",\"label\":\"Hi\",\"checked\":true}}",
      "{\"id\":19,\"service\":\"menu\",\"op\":\"get\",\"args\":{\"id\":\"hello\"}}",
      "{\"id\":20,\"service\":\"window\",\"op\":\"setBounds\",\"args\":{\"x\":10,\"y\":20,\"width\":640,\"height\":480}}",
      "{\"id\":21,\"service\":\"window\",\"op\":\"getBounds\"}",
      "{\"id\":22,\"service\":\"window\",\"op\":\"setCloseVeto\",\"args\":{\"enabled\":true}}",
      "{\"id\":23,\"service\":\"shortcuts\",\"op\":\"register\",\"args\":{\"accelerator\":\"Ctrl+Alt+F9\",\"id\":\"k\"}}",
      "{\"id\":24,\"service\":\"system\",\"op\":\"info\"}",
      "{\"id\":25,\"service\":\"capabilities\",\"op\":\"describe\"}",
      "{\"id\":26,\"service\":\"window\",\"op\":\"setTitleBarStyle\",\"args\":{\"style\":\"hidden\"}}",
      "{\"id\":27,\"service\":\"window\",\"op\":\"getTitleBarStyle\"}",
      "{\"id\":28,\"service\":\"window\",\"op\":\"setTitleBarStyle\",\"args\":{\"style\":\"default\"}}",
      "{\"id\":29,\"service\":\"window\",\"op\":\"getTitleBarStyle\"}",
  };
  const int total = (int)(sizeof requests / sizeof requests[0]);
  for (const char *r : requests) {
    printf("  -> %s\n", r);
    if (call(r) != 0) {
      printf("FAIL shell_platform_call rejected %s\n", r);
      g_failures++;
    }
  }
  if (call("not json") != -3) {
    printf("FAIL shell_platform_call accepted invalid JSON\n");
    g_failures++;
  }
  // Pump the UI thread's message loop (what shell_run does) until every reply arrived.
  static int s_total;
  s_total = total;
  pump(10000, [] { return g_results >= s_total; });
  printf("%s %d/%d platformResult replies\n", g_results == total ? "ok  " : "FAIL", g_results.load(), total);
  if (g_results != total) g_failures++;
  expect(1, "\"platform\":\"win32\"");
  expect(9, "\"value\":\"s3cret\"");
  expect(10, "\"ok\":true");
  expect(12, "\"value\":\"h\xc3\xa9llo\"");
  expect(14, "\"code\":\"unknown\"");
  expect(15, "\"code\":\"unsupported\"");
  expect(17, "\"id\":\"hello\"");
  expect(19, "\"text\":\"Hi\"");
  expect(19, "\"checked\":true");
  expect(21, "\"width\":640.0");
  expect(22, "\"armed\":true");
  expect(25, "\"platform\":\"windows\"");
  expect(27, "\"frameless\":true");
  expect(27, "\"style\":\"hidden\"");
  expect(29, "\"frameless\":false");

  // Close veto: WM_CLOSE emits willClose and keeps the window; window.close bypasses it.
  auto close = sym<int (*)(int)>(m, "shell_window_close");
  // (WebView2 is missing, so the unattended shell already posted WM_QUIT; start fresh.)
  g_events.clear();
  close(id);
  pump(1500, [] { return g_events.find("willClose") != std::string::npos; });
  bool veto = g_events.find("\"name\":\"willClose\"") != std::string::npos;
  printf("%s close veto -> willClose event\n", veto ? "ok  " : "FAIL");
  if (!veto) g_failures++;
  call("{\"id\":30,\"service\":\"popover\",\"op\":\"create\",\"args\":{\"id\":\"p\",\"route\":\"/tray\",\"width\":300,\"height\":200}}");
  call("{\"id\":31,\"service\":\"events\",\"op\":\"emit\",\"args\":{\"channel\":\"ping\",\"data\":{\"n\":1}}}");
  call("{\"id\":32,\"service\":\"window\",\"op\":\"close\"}");
  pump(3000, [] { return g_events.find("WM_QUIT") != std::string::npos; });
  expect(30, "\"id\":\"p\"");
  expect(31, "\"ok\":true");
  bool message = g_events.find("\"name\":\"message\"") != std::string::npos;
  bool closed = g_events.find("\"type\":\"closed\"") != std::string::npos && g_events.find("\"name\":\"closed\"") != std::string::npos;
  bool quit = g_events.find("WM_QUIT") != std::string::npos;
  printf("%s events.emit -> message event\n", message ? "ok  " : "FAIL");
  printf("%s window.close (veto armed) -> closed events\n", closed ? "ok  " : "FAIL");
  printf("%s last window closed -> WM_QUIT (run loop ends)\n", quit ? "ok  " : "FAIL");
  g_failures += !message + !closed + !quit;
  printf(g_failures ? "SMOKE FAILED (%d)\n" : "SMOKE PASSED\n", g_failures);
  fflush(stdout);
  ExitProcess(g_failures ? 1 : 0);
}
