// Website profiles, request schemes, content rules, scripts and input policy on WebView2, same ops and
// events as native/platform_sessions.mm, platform_web_content.mm and platform_input.mm:
//   sessions.capabilities · list · create · remove · setProxy · getProxy (cookies: svc_cookies.cc)
//   protocol.response · data · finish · fail
//   webview.setContentRules · removeContentRules · listContentRules
//   webview.registerScript · unregisterScript · listScripts
//   webview.setInputPolicy · getInputPolicy
// Events: beforeInput; protocolRequest and protocolCancel (Worker only).
//
// A session is a WebView2 profile of the app's environment, kept open by a hidden web view: without
// one a private profile's data goes, and no cookie manager can be reached. Files, under
// %LOCALAPPDATA%\<identifier>: sessions.json (which profile a persistent session is), WebView2\ (the
// profiles), WebView2-sessions\<guid>\ (the user data folder of a session with its own environment).
//
// Where WebView2 differs:
// - A proxy is a browser argument, so it's per environment. A session's first proxy moves it to an
//   environment of its own, for good: its cookies come along, its other storage is deleted. Changing a
//   proxy restarts that environment's browser process, so setProxy refuses while a view is open in the session.
// - WebView2 has no content blocker. Rules are matched here, from WebResourceRequested on every
//   resource, only while some rule exists. The regular expressions are WebKit's restricted subset,
//   compiled once to a small NFA: a long URL or a bad pattern can't make a request take long.
// - A scheme's response reaches the page whole, when it ends, and WebView2 doesn't say when a request
//   stops: see Resource.
// - Rules can't reach a WebSocket, or a request's cookies: WebResourceRequested isn't raised for the
//   first, and the second are added after it. Rules that ask for them are refused.
// - AcceleratorKeyPressed reports keys held with Control or Alt and keys that make no character. A rule
//   for anything else could never hold, so it's refused.
#include "win.hpp"

#include <shlwapi.h>

#include <algorithm>
#include <bitset>
#include <cwctype>
#include <set>

namespace sd::win {

static const char *const kGateCookie = "__kitop"; // src/gate.ts SESSION_COOKIE: the shell's, never exported

// Requests and cancellation tokens never go to untrusted page listeners.
static void worker_event(const char *name, const json &data) { emit_raw(json{{"type", "platform"}, {"name", name}, {"data", data}}); }

static bool worker_call(const CallPtr &c) {
  if (!c->caller) return true;
  c->fail("denied", "this operation belongs to server code");
  return false;
}

static std::string take(LPWSTR s) {
  std::string out = utf8(s);
  if (s) CoTaskMemFree(s);
  return out;
}

static std::string new_guid() {
  GUID g{};
  CoCreateGuid(&g);
  char text[33];
  snprintf(text, sizeof text, "%08lx%04x%04x%02x%02x%02x%02x%02x%02x%02x%02x", (unsigned long)g.Data1, g.Data2, g.Data3, g.Data4[0], g.Data4[1], g.Data4[2], g.Data4[3], g.Data4[4], g.Data4[5], g.Data4[6], g.Data4[7]);
  return text;
}

static void remove_tree(const std::wstring &path) {
  WIN32_FIND_DATAW found;
  HANDLE h = FindFirstFileW((path + L"\\*").c_str(), &found);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      std::wstring name = found.cFileName;
      if (name == L"." || name == L"..") continue;
      if (found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) remove_tree(path + L"\\" + name);
      else {
        SetFileAttributesW((path + L"\\" + name).c_str(), FILE_ATTRIBUTE_NORMAL);
        DeleteFileW((path + L"\\" + name).c_str());
      }
    } while (FindNextFileW(h, &found));
    FindClose(h);
  }
  RemoveDirectoryW(path.c_str());
}

// ===========================================================================
// Sessions

static std::map<std::string, SessionPtr> g_sessions;

std::map<std::string, SessionPtr> &sessions() {
  if (g_sessions.empty()) {
    auto s = std::make_shared<Session>();
    s->id = "default";
    g_sessions["default"] = s;
  }
  return g_sessions;
}

SessionPtr session_named(const std::string &id) {
  auto &all = sessions();
  auto it = all.find(id.empty() ? "default" : id);
  return it == all.end() || it->second->removing ? nullptr : it->second;
}

bool session_option(const json &options, std::string &session) {
  session.clear();
  if (!options.is_object() || !jhas(options, "session")) return true;
  const json &value = options["session"];
  if (!value.is_string() || !session_named(value.get<std::string>())) return false;
  session = value.get<std::string>() == "default" ? "" : value.get<std::string>();
  return true;
}

std::string session_environment_key(const std::string &session) {
  auto it = sessions().find(session);
  return it != sessions().end() && !it->second->folder.empty() ? session : "";
}

static std::string saved_path() { return local_file("sessions.json"); }

// Persistent sessions: their profile, and their folder once they have one. An id comes back to the
// same data across launches, and to none at all after a remove, even within a run: WebView2 won't
// reopen a profile it's deleting.
static json &saved() {
  static json all = read_json_file(saved_path(), json::object());
  if (!all.is_object()) all = json::object();
  return all;
}

static void save(const SessionPtr &s) {
  if (!s->persistent) return;
  saved()[s->id] = json{{"profile", s->profile}, {"folder", s->folder}};
  write_json_file(saved_path(), saved());
}

static std::wstring folders_root() { return wide(local_file("WebView2-sessions")); }

// What an earlier run left of private sessions, or couldn't delete. Once, before the first new folder.
static void sweep_folders() {
  static bool done = false;
  if (done) return;
  done = true;
  std::set<std::wstring> keep;
  for (auto &[id, record] : saved().items()) keep.insert(wide(jstr(record, "folder")));
  WIN32_FIND_DATAW found;
  HANDLE h = FindFirstFileW((folders_root() + L"\\*").c_str(), &found);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    std::wstring path = folders_root() + L"\\" + found.cFileName;
    if (found.cFileName[0] != L'.' && !keep.count(path)) remove_tree(path);
  } while (FindNextFileW(h, &found));
  FindClose(h);
}

// A private session that was never removed leaves its profile's empty folder in the app's environment.
// Once, before the first session of a run: nothing's using any of them yet.
static void sweep_profiles() {
  static bool done = false;
  if (done) return;
  done = true;
  std::set<std::wstring> keep;
  for (auto &[id, record] : saved().items()) keep.insert(wide("WV2Profile_" + jstr(record, "profile")));
  std::wstring root = user_data_folder() + L"\\EBWebView";
  WIN32_FIND_DATAW found;
  HANDLE h = FindFirstFileW((root + L"\\WV2Profile_*").c_str(), &found);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (!keep.count(found.cFileName)) remove_tree(root + L"\\" + found.cFileName);
  } while (FindNextFileW(h, &found));
  FindClose(h);
}

static std::wstring proxy_arguments(const json &p) {
  if (!p.is_object()) return L"";
  std::string host = jstr(p, "host");
  if (host.find(':') != std::string::npos) host = "[" + host + "]";
  std::string scheme = jstr(p, "type") == "socks" ? "socks5" : jbool(p, "tls", false) ? "https" : "http";
  // Chromium already leaves loopback hosts out, and never fails over to a direct connection.
  return wide("--proxy-server=" + scheme + "://" + host + ":" + std::to_string((int)jnum(p, "port", 0)));
}

static void close_store(const SessionPtr &s) {
  if (s->anchor) s->anchor->Close();
  release(s->cookies);
  release(s->web);
  release(s->anchor);
}

static void store_opened(const SessionPtr &s, const std::string &error) {
  s->opening = false;
  auto waiters = std::move(s->waiters);
  s->waiters.clear();
  for (auto &w : waiters) w(error);
}

static void store_lost(const SessionPtr &s) {
  close_store(s);
  release(s->env);
}

void sessions_environment_lost(const std::string &key) {
  for (auto &[ident, s] : sessions())
    if (ident != "default" && session_environment_key(ident) == key) store_lost(s);
}

/// The session's profile, for a new controller. nullptr on a runtime that has no profiles.
static ICoreWebView2ControllerOptions *profile_options(const SessionPtr &s, ICoreWebView2Environment *env) {
  auto *env10 = query<ICoreWebView2Environment10>(env, IID_ICoreWebView2Environment10);
  ICoreWebView2ControllerOptions *options = nullptr;
  if (env10) env10->CreateCoreWebView2ControllerOptions(&options);
  if (env10) env10->Release();
  if (!options) return nullptr;
  options->put_ProfileName(wide(s->profile).c_str());
  options->put_IsInPrivateModeEnabled(s->persistent ? FALSE : TRUE);
  return options;
}

static void open_anchor(const SessionPtr &s, ICoreWebView2Environment *env) {
  ICoreWebView2ControllerOptions *options = profile_options(s, env);
  if (!options) return store_opened(s, "sessions: needs a newer WebView2 runtime");
  auto *handler = new Cb<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT, ICoreWebView2Controller *>(
      IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, [s](HRESULT hr, ICoreWebView2Controller *ctl) -> HRESULT {
        if (FAILED(hr) || !ctl) {
          store_opened(s, "sessions: could not open the profile: " + hresult_message(FAILED(hr) ? hr : E_FAIL));
          return S_OK;
        }
        ctl->AddRef();
        s->anchor = ctl;
        ctl->put_IsVisible(FALSE);
        ctl->get_CoreWebView2(&s->web);
        auto *wv2 = s->web ? query<ICoreWebView2_2>(s->web, IID_ICoreWebView2_2) : nullptr;
        if (wv2) {
          wv2->get_CookieManager(&s->cookies);
          wv2->Release();
        }
        if (!s->cookies) {
          close_store(s);
          store_opened(s, "sessions: needs a newer WebView2 runtime");
          return S_OK;
        }
        auto *onFail = new Cb<ICoreWebView2ProcessFailedEventHandler, ICoreWebView2 *, ICoreWebView2ProcessFailedEventArgs *>(
            IID_ICoreWebView2ProcessFailedEventHandler, [s](ICoreWebView2 *sender, ICoreWebView2ProcessFailedEventArgs *args) -> HRESULT {
              COREWEBVIEW2_PROCESS_FAILED_KIND kind = COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
              args->get_ProcessFailedKind(&kind);
              // The next use opens it again; with views, their recovery comes to the same.
              if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED && sender == s->web) store_lost(s);
              return S_OK;
            });
        EventRegistrationToken token{};
        s->web->add_ProcessFailed(onFail, &token);
        onFail->Release();
        store_opened(s, "");
        return S_OK;
      });
  // The hidden window never shows, and this web view never loads anything.
  auto *env10 = query<ICoreWebView2Environment10>(env, IID_ICoreWebView2Environment10);
  HRESULT hr = env10->CreateCoreWebView2ControllerWithOptions(hidden_window(), options, handler);
  handler->Release();
  options->Release();
  env10->Release();
  if (FAILED(hr)) store_opened(s, "sessions: could not open the profile: " + hresult_message(hr));
}

void session_open(const SessionPtr &s, std::function<void(const std::string &)> done) {
  if (s->id == "default" || s->cookies) return done("");
  s->waiters.push_back(std::move(done));
  if (s->opening) return;
  s->opening = true;
  if (s->folder.empty()) return with_env([s](ICoreWebView2Environment *env) { open_anchor(s, env); });
  if (s->env) return open_anchor(s, s->env);
  CreateDirectoryW(folders_root().c_str(), nullptr);
  CreateDirectoryW(wide(s->folder).c_str(), nullptr);
  HRESULT hr = environment_create(wide(s->folder), proxy_arguments(s->proxy), [s](HRESULT hr, ICoreWebView2Environment *env) {
    if (FAILED(hr) || !env) return store_opened(s, "sessions: could not start the session's browser process: " + hresult_message(FAILED(hr) ? hr : E_FAIL));
    env->AddRef();
    s->env = env;
    open_anchor(s, env);
  });
  if (FAILED(hr)) store_opened(s, "sessions: could not start the session's browser process: " + hresult_message(hr));
}

void session_controller_options(const std::string &session, std::function<void(ICoreWebView2Environment *, ICoreWebView2ControllerOptions *, const std::string &)> fn) {
  auto it = session.empty() ? sessions().end() : sessions().find(session);
  if (it == sessions().end()) return with_env([fn](ICoreWebView2Environment *env) { fn(env, nullptr, ""); });
  SessionPtr s = it->second;
  session_open(s, [s, fn](const std::string &error) {
    if (!error.empty()) return fn(nullptr, nullptr, error);
    auto ready = [s, fn](ICoreWebView2Environment *env) {
      ICoreWebView2ControllerOptions *options = profile_options(s, env);
      if (!options) return fn(nullptr, nullptr, "sessions: needs a newer WebView2 runtime");
      fn(env, options, "");
      options->Release();
    };
    if (s->env) ready(s->env);
    else with_env(ready);
  });
}

// The app's server only answers its own session cookie, which is the default session's: a named one
// gets a copy, and nothing else. It's copied before each load: the server may have restarted since.
static void provision(const SessionPtr &s, std::function<void(const std::string &)> done) {
  wchar_t flag[8];
  if (GetEnvironmentVariableW(L"KITOP_DEV", flag, 8)) return done(""); // Vite serves dev pages directly, without the loopback gate
  std::string origin = app_origin();
  ICoreWebView2CookieManager *m = origin.empty() ? nullptr : session_cookie_manager(session_named(""));
  if (!m) return done("App authentication is not ready");
  bool started = session_get_cookies(m, origin + "/", [s, done](HRESULT, ICoreWebView2CookieList *list) {
    UINT n = 0;
    if (list) list->get_Count(&n);
    std::string value, domain, path;
    for (UINT i = 0; i < n && value.empty(); i++) {
      ICoreWebView2Cookie *c = nullptr;
      if (FAILED(list->GetValueAtIndex(i, &c)) || !c) continue;
      LPWSTR name = nullptr, text = nullptr, host = nullptr, where = nullptr;
      c->get_Name(&name);
      if (take(name) == kGateCookie) {
        c->get_Value(&text);
        c->get_Domain(&host);
        c->get_Path(&where);
        value = take(text);
        domain = take(host);
        path = take(where);
      }
      c->Release();
    }
    if (value.empty()) return done("App authentication is not ready");
    if (!s->cookies) return done("App authentication is not ready");
    ICoreWebView2Cookie *copy = nullptr;
    if (FAILED(s->cookies->CreateCookie(wide(kGateCookie).c_str(), wide(value).c_str(), wide(domain).c_str(), wide(path).c_str(), &copy)) || !copy) return done("WebView2 did not retain the app authentication cookie");
    copy->put_IsHttpOnly(TRUE);
    copy->put_SameSite(COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT);
    HRESULT hr = s->cookies->AddOrUpdateCookie(copy);
    copy->Release();
    if (FAILED(hr)) return done("WebView2 did not retain the app authentication cookie");
    bool reading = session_get_cookies(s->cookies, "", [value, done](HRESULT, ICoreWebView2CookieList *stored) {
      UINT count = 0;
      if (stored) stored->get_Count(&count);
      for (UINT i = 0; i < count; i++) {
        ICoreWebView2Cookie *c = nullptr;
        if (FAILED(stored->GetValueAtIndex(i, &c)) || !c) continue;
        LPWSTR name = nullptr, text = nullptr;
        c->get_Name(&name);
        c->get_Value(&text);
        std::string found = take(name), stored_value = take(text);
        c->Release();
        if (found == kGateCookie && stored_value == value) return done("");
      }
      done("WebView2 did not retain the app authentication cookie");
    });
    if (!reading) done("WebView2 did not retain the app authentication cookie");
  });
  m->Release();
  if (!started) done("App authentication is not ready");
}

void session_before_load(View *v, const std::string &url, std::function<void()> load) {
  std::string origin = app_origin();
  bool app = !origin.empty() && url.rfind(origin + "/", 0) == 0 && url.rfind(origin + "/__desktop/auth", 0) != 0;
  auto it = v->session.empty() || !app ? sessions().end() : sessions().find(v->session);
  if (it == sessions().end()) return load();
  SessionPtr s = it->second;
  int id = v->id;
  s->pending++;
  auto failed = [id, url](const std::string &error) {
    View *v = find_view(id);
    if (!v) return;
    json d = view_source(v);
    d.update(json{{"type", "failed"}, {"navigationId", nullptr}, {"url", url}, {"domain", "KitopSessionErrorDomain"}, {"code", 1}, {"message", error}, {"provisional", true}});
    emit("webviewLifecycle", d);
  };
  session_open(s, [s, load, failed](const std::string &error) {
    if (!error.empty()) {
      s->pending--;
      return failed(error);
    }
    provision(s, [s, load, failed](const std::string &error) {
      s->pending--;
      if (error.empty()) load();
      else failed(error);
    });
  });
}

static SessionPtr resolve_session(const CallPtr &c) {
  SessionPtr s = !c->has("session") ? session_named("") : c->args["session"].is_string() ? session_named(c->str("session")) : nullptr;
  if (!s) c->fail("invalid_args", "sessions: unknown or removing session");
  return s;
}

static json describe(const SessionPtr &s) { return json{{"id", s->id}, {"persistent", s->persistent}}; }

static bool session_in_use(const SessionPtr &s) {
  for (auto &[id, v] : views())
    if (v->session == s->id) return true;
  return false;
}

static void make_session(CallPtr c) {
  std::string ident = c->str("id");
  if (ident.empty() || ident == "default" || sessions().count(ident) || wide(ident).size() > 200 || !c->has("persistent") || !c->args["persistent"].is_boolean())
    return c->fail("invalid_args", "sessions.create: a unique non-default id and boolean persistent are required");
  sweep_profiles();
  auto s = std::make_shared<Session>();
  s->id = ident;
  s->persistent = c->flag("persistent", false);
  auto known = s->persistent ? saved().find(ident) : saved().end();
  // Profile names have few legal characters and a length limit.
  s->profile = known != saved().end() ? jstr(*known, "profile") : "s" + new_guid();
  if (known != saved().end()) s->folder = jstr(*known, "folder");
  // The id is reserved while it starts: no view can use a store without the app's cookie.
  s->removing = true;
  sessions()[ident] = s;
  auto failed = [c, s](const std::string &error) {
    sessions().erase(s->id);
    c->fail("unavailable", error);
    backend_run_on_main([s] { store_lost(s); }); // off the callback of what it closes
  };
  session_open(s, [c, s, failed](const std::string &error) {
    if (!error.empty()) return failed(error);
    provision(s, [c, s, failed](const std::string &error) {
      if (!error.empty()) return failed(error);
      save(s);
      session_cookies_started(s, [c, s] {
        s->removing = false;
        c->ok(describe(s));
      });
    });
  });
}

// Everything a persistent profile keeps goes now; what ClearBrowsingDataAll leaves, with the folder.
static void clear_profile_data(const SessionPtr &s, std::function<void(HRESULT)> done) {
  auto *wv13 = s->web ? query<ICoreWebView2_13>(s->web, IID_ICoreWebView2_13) : nullptr;
  ICoreWebView2Profile *profile = nullptr;
  if (wv13) wv13->get_Profile(&profile);
  if (wv13) wv13->Release();
  auto *profile2 = profile ? query<ICoreWebView2Profile2>(profile, IID_ICoreWebView2Profile2) : nullptr;
  if (profile) profile->Release();
  if (!profile2) return done(E_NOINTERFACE);
  auto *cb = new Cb<ICoreWebView2ClearBrowsingDataCompletedHandler, HRESULT>(IID_ICoreWebView2ClearBrowsingDataCompletedHandler, [done](HRESULT hr) -> HRESULT {
    done(hr);
    return S_OK;
  });
  HRESULT hr = profile2->ClearBrowsingDataAll(cb);
  cb->Release();
  profile2->Release();
  if (FAILED(hr)) done(hr);
}

// The folder goes when the runtime lets go of it, at the profile's next browser process exit.
static void delete_profile(const SessionPtr &s) {
  auto *wv13 = s->web ? query<ICoreWebView2_13>(s->web, IID_ICoreWebView2_13) : nullptr;
  ICoreWebView2Profile *profile = nullptr;
  if (wv13) wv13->get_Profile(&profile);
  if (wv13) wv13->Release();
  if (auto *profile8 = profile ? query<ICoreWebView2Profile8>(profile, IID_ICoreWebView2Profile8) : nullptr) {
    profile8->Delete();
    profile8->Release();
  }
  if (profile) profile->Release();
}

// With every web view of the environment closed its browser process goes, and only then can the
// folder be deleted or started again with other arguments.
static void when_browser_exited(const SessionPtr &s, std::function<void(bool)> done) {
  ICoreWebView2Environment *env = s->env;
  s->env = nullptr;
  auto *env5 = env ? query<ICoreWebView2Environment5>(env, IID_ICoreWebView2Environment5) : nullptr;
  if (!env5) {
    if (env) env->Release();
    return done(true);
  }
  auto settled = std::make_shared<bool>(false);
  auto token = std::make_shared<EventRegistrationToken>();
  auto finish = [settled, token, env5, done](bool exited) {
    if (*settled) return;
    *settled = true;
    env5->remove_BrowserProcessExited(*token);
    env5->Release();
    done(exited);
  };
  auto *handler = new Cb<ICoreWebView2BrowserProcessExitedEventHandler, ICoreWebView2Environment *, ICoreWebView2BrowserProcessExitedEventArgs *>(
      IID_ICoreWebView2BrowserProcessExitedEventHandler, [finish](ICoreWebView2Environment *, ICoreWebView2BrowserProcessExitedEventArgs *) -> HRESULT {
        // Off the event's own stack: this removes the handler.
        backend_run_on_main([finish] { finish(true); });
        return S_OK;
      });
  env5->add_BrowserProcessExited(handler, token.get());
  handler->Release();
  env->Release();
  UINT32 pid = 0;
  if (s->web) s->web->get_BrowserProcessId(&pid);
  close_store(s);
  // It usually goes within a couple of seconds, but it once hadn't after 15 on the test runner. Nothing
  // of the app's is left in it, and it's this session's alone: what's written is written.
  run_after(5000, [settled, pid] {
    if (*settled || !pid) return;
    fprintf(stderr, "[shell] a session's browser process didn't stop: ended\n");
    if (HANDLE process = OpenProcess(PROCESS_TERMINATE, FALSE, pid)) {
      TerminateProcess(process, 1);
      CloseHandle(process);
    }
  });
  run_after(12000, [finish] { finish(false); });
}

static void forget_session(CallPtr c, const SessionPtr &s) {
  if (s->persistent) {
    saved().erase(s->id);
    write_json_file(saved_path(), saved());
  }
  sessions().erase(s->id);
  c->ok();
}

static void drop_session(CallPtr c) {
  SessionPtr s = resolve_session(c);
  if (!s) return;
  if (s->id == "default") return c->fail("denied", "The default session belongs to the shell");
  if (s->pending) return c->fail("unavailable", "sessions.remove: cookie operations are still pending");
  if (session_in_use(s)) return c->fail("unavailable", "sessions.remove: destroy the session's windows, views and popovers first");
  s->removing = true;
  session_open(s, [c, s](const std::string &error) {
    auto refused = [c, s](const std::string &why) {
      s->removing = false;
      c->fail("unavailable", why);
    };
    if (!error.empty()) return refused(error);
    auto finish = [c, s] {
      if (s->folder.empty()) {
        delete_profile(s); // a private one has a folder too, with nothing in it
        close_store(s);
        return forget_session(c, s);
      }
      when_browser_exited(s, [c, s](bool) {
        remove_tree(wide(s->folder)); // what it can't delete now, sweep_folders does at a later launch
        forget_session(c, s);
      });
    };
    if (!s->persistent) return finish();
    clear_profile_data(s, [refused, finish](HRESULT hr) {
      if (FAILED(hr)) refused("sessions.remove: " + hresult_message(hr));
      else backend_run_on_main(finish); // off the callback of what it closes
    });
  });
}

// ---- proxies ----------------------------------------------------------------

static bool valid_proxy_host(const std::string &host) {
  // It ends up on a command line: nothing but what a host is made of.
  return !host.empty() && host.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:") == std::string::npos;
}

// Takes the session to `proxy`: the same folder and other arguments, or a first folder of its own.
static void restart_environment(CallPtr c, const SessionPtr &s, const json &proxy, const std::string &user, const std::string &password, const json &cookies) {
  auto restart = [c, s, proxy, user, password, cookies] {
    if (s->folder.empty()) {
      sweep_folders();
      s->folder = utf8(folders_root()) + "\\" + new_guid();
    }
    s->proxy = proxy;
    s->proxyUser = user;
    s->proxyPassword = password;
    s->proxyAnswers = 0;
    session_open(s, [c, s, cookies](const std::string &error) {
      s->removing = false;
      if (!error.empty()) return c->fail("unavailable", error);
      session_write_cookies(s, cookies);
      save(s);
      c->ok();
    });
  };
  if (!s->folder.empty()) {
    when_browser_exited(s, [c, s, restart](bool exited) {
      if (exited) return restart();
      s->removing = false;
      c->fail("unavailable", "sessions.setProxy: the session's browser process didn't stop");
    });
    return;
  }
  // It leaves the app's environment: what it had there, beyond cookies, is deleted with the profile.
  auto leave = [s, restart] {
    delete_profile(s);
    close_store(s);
    restart();
  };
  if (!s->persistent) return leave();
  clear_profile_data(s, [leave](HRESULT) { backend_run_on_main(leave); });
}

static void change_environment(CallPtr c, const SessionPtr &s, const json &proxy, const std::string &user, const std::string &password) {
  s->removing = true;
  session_read_cookies(s, [c, s, proxy, user, password](const json &cookies) {
    // Closing a web view from its own cookie manager's callback brings the runtime down.
    backend_run_on_main([c, s, proxy, user, password, cookies] { restart_environment(c, s, proxy, user, password, cookies); });
  });
}

static void set_proxy(CallPtr c) {
  SessionPtr s = resolve_session(c);
  if (!s) return;
  auto it = c->args.find("proxy");
  bool clearing = it != c->args.end() && it->is_null();
  if (!clearing && (it == c->args.end() || !it->is_object())) return c->fail("invalid_args", "sessions.setProxy: proxy configuration or null is required");
  json next = nullptr;
  std::string user, password;
  if (!clearing) {
    const json &p = *it;
    for (auto &[key, value] : p.items())
      if (key != "type" && key != "host" && key != "port" && key != "username" && key != "password" && key != "tls")
        return c->fail("unsupported", "Proxy PAC, bypass and other options are unsupported");
    std::string type = jstr(p, "type"), host = jstr(p, "host");
    double port = jnum(p, "port", 0);
    if ((type != "http" && type != "socks") || !valid_proxy_host(host) || port != (int)port || port < 1 || port > 65535)
      return c->fail("invalid_args", "sessions.setProxy: type, host and port 1–65535 are required");
    for (const char *k : {"username", "password"})
      if (p.contains(k) && !p[k].is_string()) return c->fail("invalid_args", "Proxy credentials must be strings");
    if (p.contains("tls") && !p["tls"].is_boolean()) return c->fail("invalid_args", "Proxy tls must be boolean");
    bool tls = jbool(p, "tls", false), authenticated = p.contains("username");
    if ((tls && type == "socks") || (p.contains("password") && !authenticated)) return c->fail("invalid_args", "TLS is HTTP-only; password requires username");
    if (authenticated && type == "socks") return c->fail("unsupported", "Chromium has no credentials for a SOCKS proxy");
    user = jstr(p, "username");
    password = jstr(p, "password");
    next = json{{"type", type}, {"host", host}, {"port", (int)port}, {"tls", tls}, {"authenticated", authenticated}};
  }
  if (next == s->proxy && user == s->proxyUser && password == s->proxyPassword) return c->ok();
  if (s->id == "default") return c->fail("unsupported", "sessions.setProxy: a proxy is fixed when a browser process starts, and the app's own pages run in the default session's: use a named session");
  if (s->pending) return c->fail("unavailable", "sessions.setProxy: cookie operations are still pending");
  if (session_in_use(s)) return c->fail("unavailable", "sessions.setProxy: a proxy is fixed when a browser process starts: destroy the session's windows, views and popovers first");
  // Only credentials: the same arguments, the browser process can stay.
  if (next.is_object() && s->proxy.is_object() && proxy_arguments(next) == proxy_arguments(s->proxy)) {
    s->proxy = next;
    s->proxyUser = user;
    s->proxyPassword = password;
    s->proxyAnswers = 0;
    return c->ok();
  }
  session_open(s, [c, s, next, user, password](const std::string &error) {
    if (!error.empty()) return c->fail("unavailable", error);
    change_environment(c, s, next, user, password);
  });
}

bool session_proxy_challenge(View *v, const std::string &uri, bool &has_credentials, std::string &user, std::string &password) {
  has_credentials = false;
  auto it = v && !v->session.empty() ? sessions().find(v->session) : sessions().end();
  if (it == sessions().end() || !it->second->proxy.is_object()) return false;
  const SessionPtr &s = it->second;
  std::string host = jstr(s->proxy, "host"), port = std::to_string((int)jnum(s->proxy, "port", 0));
  if (host.find(':') != std::string::npos) host = "[" + host + "]";
  // WebView2 gives the proxy's address as the URI of its challenge. A site's isn't that: it doesn't get these.
  std::string text = lower(uri), at = lower(host) + ":" + port;
  auto found = text.find(at);
  bool ours = found != std::string::npos && (found == 0 || text[found - 1] == '/') && (found + at.size() == text.size() || text[found + at.size()] == '/');
  if (!ours) return false;
  // Refused several times in a row: they aren't right, and asking again won't change it.
  ULONGLONG now = GetTickCount64();
  if (now - s->proxyAnswered > 10000) s->proxyAnswers = 0;
  if (jbool(s->proxy, "authenticated", false) && s->proxyAnswers < 3) {
    s->proxyAnswers++;
    s->proxyAnswered = now;
    has_credentials = true;
    user = s->proxyUser;
    password = s->proxyPassword;
  }
  return true;
}

static void register_session_ops() {
  reg("sessions", "create", make_session);
  reg("sessions", "remove", drop_session);
  reg("sessions", "list", [](CallPtr c) {
    json out = json::array();
    for (auto &[ident, s] : sessions())
      if (!s->removing) out.push_back(describe(s));
    c->ok(out);
  });
  reg("sessions", "capabilities", [](CallPtr c) {
    with_env([c](ICoreWebView2Environment *env) {
      auto *env10 = query<ICoreWebView2Environment10>(env, IID_ICoreWebView2Environment10);
      bool modern = env10 != nullptr;
      if (env10) env10->Release();
      c->ok(json{{"private", modern}, {"persistentNamed", modern}, {"proxy", modern}, {"proxyAuthentication", modern}, {"pac", false}, {"customBypass", false}});
    });
  });
  reg("sessions", "setProxy", set_proxy);
  reg("sessions", "getProxy", [](CallPtr c) {
    if (SessionPtr s = resolve_session(c)) c->ok(s->proxy);
  });
}

// ===========================================================================
// Custom resource schemes: requests go to the Worker, its answer streams to WebView2.

static std::vector<std::string> g_schemes;

void set_protocol_schemes(const json &input) {
  // Once at startup, before the first environment exists.
  static bool set = false;
  if (set) return;
  set = true;
  if (!input.is_array()) return;
  for (const json &value : input) {
    std::string name = value.is_string() ? value.get<std::string>() : "";
    bool valid = !name.empty() && name[0] >= 'a' && name[0] <= 'z' && name.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789+.-") == std::string::npos;
    // The last ones the runtime has for itself.
    for (const char *reserved : {"http", "https", "file", "data", "blob", "about", "javascript", "ws", "wss", "edge", "chrome", "devtools"}) valid = valid && name != reserved;
    if (valid && std::find(g_schemes.begin(), g_schemes.end(), name) == g_schemes.end()) g_schemes.push_back(name);
  }
}

const std::vector<std::string> &protocol_schemes() { return g_schemes; }
bool protocol_scheme(const std::string &scheme) { return std::find(g_schemes.begin(), g_schemes.end(), scheme) != g_schemes.end(); }

// A request in the Worker's hands, on a deferral until its response is whole. WebView2 can't take less:
// it reads a response's stream to the end before the page sees any of it (run on a real runtime: a
// stream that doesn't end never shows, and a fetch's promise waits for it), and it reads a document's
// on the UI thread, where a stream waiting for protocol.data would hold every web view's callbacks.
// So nothing is gained by a stream that blocks, and this is memory until protocol.finish.
//
// It can't fail one either: the deferral ends without a response, and with nothing for the network
// to do with this scheme the load fails. And it never says a request stopped, so one ends with its
// view and with the document that made it; a fetch aborted before that isn't noticed.
struct Resource {
  std::string id;
  int view = 0;
  unsigned navigation = 0;
  bool mainDocument = false; // the document of that navigation, which carries on past ContentLoading
  ICoreWebView2WebResourceRequestedEventArgs *args = nullptr;
  ICoreWebView2Deferral *deferral = nullptr;
  ICoreWebView2Environment *env = nullptr;
  bool responded = false;
  int status = 200;
  std::string headers, body;
  ~Resource() {
    if (deferral) deferral->Complete();
    if (deferral) deferral->Release();
    if (args) args->Release();
    if (env) env->Release();
  }
};
using ResourcePtr = std::shared_ptr<Resource>;
static std::map<std::string, ResourcePtr> g_resources;
static int g_next_resource = 1;
static const size_t kMaxResponse = 1u << 30; // WebView2 holds a copy too

static void cancel_resource(const std::string &id) {
  auto it = g_resources.find(id);
  if (it == g_resources.end()) return;
  g_resources.erase(it);
  worker_event("protocolCancel", json{{"requestId", id}});
}

static void serve_scheme(int view_id, ICoreWebView2 *sender, ICoreWebView2WebResourceRequestedEventArgs *args, ICoreWebView2WebResourceRequest *request, const std::string &url, COREWEBVIEW2_WEB_RESOURCE_CONTEXT context) {
  View *v = find_view(view_id);
  auto *wv2 = query<ICoreWebView2_2>(sender, IID_ICoreWebView2_2);
  auto r = std::make_shared<Resource>();
  if (!v || !wv2 || FAILED(wv2->get_Environment(&r->env)) || FAILED(args->GetDeferral(&r->deferral))) {
    if (wv2) wv2->Release();
    return;
  }
  wv2->Release();
  args->AddRef();
  r->args = args;
  r->id = "protocol-" + std::to_string(g_next_resource++);
  r->view = view_id;
  r->navigation = v->navigation;
  r->mainDocument = context == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT && url == v->pendingTop;
  g_resources[r->id] = r;
  LPWSTR method = nullptr;
  request->get_Method(&method);
  json headers = json::object();
  ICoreWebView2HttpRequestHeaders *list = nullptr;
  if (SUCCEEDED(request->get_Headers(&list)) && list) {
    ICoreWebView2HttpHeadersCollectionIterator *iterator = nullptr;
    if (SUCCEEDED(list->GetIterator(&iterator)) && iterator) {
      BOOL more = FALSE;
      iterator->get_HasCurrentHeader(&more);
      while (more) {
        LPWSTR name = nullptr, value = nullptr;
        iterator->GetCurrentHeader(&name, &value);
        std::string key = take(name);
        headers[key] = take(value);
        if (FAILED(iterator->MoveNext(&more))) more = FALSE;
      }
      iterator->Release();
    }
    list->Release();
  }
  json d{{"requestId", r->id}, {"url", url}, {"method", take(method)}, {"headers", headers}};
  IStream *content = nullptr;
  if (SUCCEEDED(request->get_Content(&content)) && content) {
    std::string body;
    char buffer[16384];
    ULONG n = 0;
    while (SUCCEEDED(content->Read(buffer, sizeof buffer, &n)) && n) body.append(buffer, n);
    content->Release();
    if (!body.empty()) d["body"] = base64_encode(body.data(), body.size());
  }
  worker_event("protocolRequest", d);
  std::string id = r->id;
  run_after(30000, [id] {
    auto it = g_resources.find(id);
    if (it != g_resources.end() && !it->second->responded) cancel_resource(id);
  });
}

static ResourcePtr resource_of(const CallPtr &c) {
  auto it = g_resources.find(c->str("requestId"));
  if (it != g_resources.end()) return it->second;
  c->fail("unavailable", "protocol task was cancelled or completed");
  return nullptr;
}

static void register_protocol() {
  reg("protocol", "response", [](CallPtr c) {
    if (!worker_call(c)) return;
    ResourcePtr r = resource_of(c);
    if (!r) return;
    int status = (int)c->num("status", 200);
    if (r->responded || status < 200 || status > 599 || !c->has("headers") || !c->args["headers"].is_object()) return c->fail("invalid_args", "invalid or duplicate protocol response");
    std::string headers;
    for (auto &[key, value] : c->args["headers"].items()) {
      if (!value.is_string() || key.find_first_of("\r\n:") != std::string::npos || value.get<std::string>().find_first_of("\r\n") != std::string::npos) return c->fail("invalid_args", "invalid response headers");
      headers += key + ": " + value.get<std::string>() + "\r\n";
    }
    r->responded = true;
    r->status = status;
    r->headers = std::move(headers);
    c->ok();
  });
  reg("protocol", "data", [](CallPtr c) {
    if (!worker_call(c)) return;
    ResourcePtr r = resource_of(c);
    if (!r) return;
    std::string encoded = c->str("data"), bytes;
    if (!r->responded || encoded.size() > 87384 || !c->has("data") || !base64_decode(encoded, bytes) || bytes.size() > 65536) return c->fail("invalid_args", "protocol data requires response headers and at most 64 KiB");
    if (r->body.size() + bytes.size() > kMaxResponse) {
      cancel_resource(r->id);
      return c->fail("unavailable", "protocol task was cancelled or completed: a response over 1 GiB can't be held for WebView2");
    }
    r->body += bytes;
    c->ok();
  });
  reg("protocol", "finish", [](CallPtr c) {
    if (!worker_call(c)) return;
    ResourcePtr r = resource_of(c);
    if (!r) return;
    if (!r->responded) return c->fail("invalid_args", "protocol response headers are missing");
    g_resources.erase(r->id);
    IStream *content = r->body.empty() ? nullptr : SHCreateMemStream(reinterpret_cast<const BYTE *>(r->body.data()), (UINT)r->body.size());
    ICoreWebView2WebResourceResponse *response = nullptr;
    HRESULT hr = r->env->CreateWebResourceResponse(content, r->status, r->status < 400 ? L"OK" : L"Error", wide(r->headers).c_str(), &response);
    if (content) content->Release();
    if (FAILED(hr) || !response) return c->fail("unavailable", "protocol.finish: " + hresult_message(FAILED(hr) ? hr : E_FAIL));
    r->args->put_Response(response);
    response->Release();
    c->ok();
  });
  reg("protocol", "fail", [](CallPtr c) {
    if (!worker_call(c)) return;
    ResourcePtr r = resource_of(c);
    if (!r) return;
    cancel_resource(r->id);
    c->ok();
  });
}

// ===========================================================================
// Content rules: matched here, on every resource, in WebKit's format and order.

// WebKit's restricted regular expressions: `.`, `[...]`, groups, `*`, `+`, `?`, `\x`, and `^` and `$` at the
// ends. A Thompson NFA: its time is the URL's length times its own size, whatever the pattern. Its
// compilation refuses what WebKit's refuses, so a rule list means the same everywhere.
class Pattern {
public:
  using CharClass = std::bitset<256>;
  static bool compile(const std::string &source, bool caseSensitive, Pattern &out, std::string &error) {
    Parser p{source, caseSensitive, out};
    out.anchored_ = !source.empty() && source[0] == '^';
    p.at = out.anchored_ ? 1 : 0;
    if (p.at == source.size() || source.size() > 4096) {
      error = "an empty or very long url-filter";
      return false;
    }
    if (!p.sequence(false)) {
      error = p.error + " in the filter `" + source + "`";
      return false;
    }
    if (p.at < source.size()) {
      error = "unbalanced parenthesis in the filter `" + source + "`";
      return false;
    }
    out.program_.push_back(Inst{Inst::Match, 0, 0, 0});
    out.endAnchored_ = p.endAnchor;
    return true;
  }

  bool search(const std::string &text) const {
    static thread_local std::vector<int> current, next, seen;
    if (seen.size() < program_.size()) seen.assign(program_.size(), -1);
    std::fill(seen.begin(), seen.begin() + program_.size(), -1);
    current.clear();
    add(current, seen, 0, 0);
    for (size_t i = 0; i <= text.size(); i++) {
      if (!anchored_ && i > 0) add(current, seen, 0, (int)i);
      if (current.empty()) return false; // anchored, and nothing left that can match
      next.clear();
      for (int pc : current) {
        const Inst &inst = program_[pc];
        if (inst.op == Inst::Match) {
          if (!endAnchored_ || i == text.size()) return true;
          continue;
        }
        if (i < text.size() && classes_[inst.a][(unsigned char)text[i]]) add(next, seen, inst.x, (int)i + 1);
      }
      current.swap(next);
    }
    return false;
  }

private:
  struct Inst {
    enum Op { Char, Split, Jump, Match } op;
    int a, x, y; // Char: a class, x next. Split: x, y. Jump: x.
  };
  void add(std::vector<int> &list, std::vector<int> &seen, int pc, int position) const {
    if (seen[pc] == position) return;
    seen[pc] = position;
    const Inst &inst = program_[pc];
    if (inst.op == Inst::Jump) return add(list, seen, inst.x, position);
    if (inst.op == Inst::Split) {
      add(list, seen, inst.x, position);
      add(list, seen, inst.y, position);
      return;
    }
    list.push_back(pc);
  }

  struct Parser {
    const std::string &s;
    bool sensitive;
    Pattern &out;
    size_t at = 0;
    bool endAnchor = false;
    std::string error;

    bool fail(const char *why) { return error = why, false; }

    void add_char(CharClass &c, unsigned char ch) {
      c[ch] = true;
      if (!sensitive) {
        if (ch >= 'a' && ch <= 'z') c[ch - 32] = true;
        if (ch >= 'A' && ch <= 'Z') c[ch + 32] = true;
      }
    }
    void emit_class(const CharClass &c) {
      auto &all = out.classes_;
      size_t i = (size_t)(std::find(all.begin(), all.end(), c) - all.begin());
      if (i == all.size()) all.push_back(c);
      out.program_.push_back(Inst{Inst::Char, (int)i, (int)out.program_.size() + 1, 0});
    }

    bool bracket() {
      CharClass c{};
      bool negate = at < s.size() && s[at] == '^';
      if (negate) at++;
      bool any = false;
      while (at < s.size() && s[at] != ']') {
        unsigned char low = (unsigned char)s[at];
        if (low >= 128) return fail("a character that isn't ASCII");
        if (low == '\\') {
          if (++at >= s.size()) break;
          low = (unsigned char)s[at];
          if (isalnum(low)) return fail("an unsupported escape");
        }
        at++;
        unsigned char high = low;
        if (at + 1 < s.size() && s[at] == '-' && s[at + 1] != ']') {
          high = (unsigned char)s[at + 1];
          if (high >= 128) return fail("a character that isn't ASCII");
          at += 2;
          if (high < low) return fail("an inverted range");
        }
        for (int ch = low; ch <= high; ch++) add_char(c, (unsigned char)ch);
        any = true;
      }
      if (at >= s.size() || !any) return fail("an unterminated or empty character class");
      at++;
      if (negate) c.flip();
      emit_class(c);
      return true;
    }

    bool sequence(bool nested) {
      bool some = false;
      while (at < s.size()) {
        char ch = s[at];
        if (ch == ')') {
          if (!nested) return fail("unbalanced parenthesis");
          break;
        }
        if (ch == '$') {
          if (at + 1 != s.size() || nested) return fail("`$` anywhere but at the end");
          endAnchor = true;
          at++;
          break;
        }
        size_t start = out.program_.size();
        if (ch == '(') {
          at++;
          if (at < s.size() && s[at] == '?') return fail("a group modifier");
          if (!sequence(true)) return false;
          if (at >= s.size() || s[at] != ')') return fail("unbalanced parenthesis");
          at++;
        } else if (ch == '[') {
          at++;
          if (!bracket()) return false;
        } else if (ch == '.') {
          at++;
          CharClass c;
          c.set();
          emit_class(c);
        } else if (ch == '|' || ch == '{' || ch == '}' || ch == '^' || ch == ']') {
          return fail(ch == '|' ? "alternation" : ch == '^' ? "`^` anywhere but at the start" : "an unsupported character");
        } else if (ch == '*' || ch == '+' || ch == '?') {
          return fail("a quantifier with nothing before it");
        } else {
          unsigned char literal = (unsigned char)ch;
          if (literal >= 128) return fail("a character that isn't ASCII");
          if (ch == '\\') {
            if (++at >= s.size()) return fail("a lone backslash");
            literal = (unsigned char)s[at];
            if (literal >= 128 || isalnum(literal)) return fail("an unsupported escape");
          }
          at++;
          CharClass c{};
          add_char(c, literal);
          emit_class(c);
        }
        some = true;
        if (at < s.size() && (s[at] == '*' || s[at] == '+' || s[at] == '?')) {
          char q = s[at++];
          if (at < s.size() && (s[at] == '*' || s[at] == '+' || s[at] == '?' || s[at] == '{')) return fail("a quantifier on a quantifier");
          if (!quantify(start, q)) return false;
        } else if (at < s.size() && s[at] == '{') return fail("a counted repetition");
      }
      return some || !nested ? true : fail("an empty group");
    }

    bool quantify(size_t start, char q) {
      auto &prog = out.program_;
      // A piece's jumps are absolute, so what's inserted before it moves them.
      auto shift = [&](size_t from, int by) {
        for (size_t i = from; i < prog.size(); i++) {
          prog[i].x += by;
          if (prog[i].op == Inst::Split) prog[i].y += by;
        }
      };
      if (q == '+') {
        int end = (int)prog.size() + 1;
        prog.push_back(Inst{Inst::Split, 0, (int)start, end});
        return true;
      }
      prog.insert(prog.begin() + (long)start, Inst{Inst::Split, 0, 0, 0});
      shift(start + 1, 1);
      if (q == '*') {
        prog.push_back(Inst{Inst::Jump, 0, (int)start, 0});
      }
      prog[start].x = (int)start + 1;
      prog[start].y = (int)prog.size();
      return true;
    }
  };

  std::vector<Inst> program_;
  std::vector<CharClass> classes_;
  bool anchored_ = false, endAnchored_ = false;
};

struct DomainMatch {
  std::string domain;
  bool subdomains = false;
};
enum class RuleAction { Block, MakeHttps, IgnorePrevious };
struct Rule {
  Pattern url;
  unsigned contexts = 0; // a bit per COREWEBVIEW2_WEB_RESOURCE_CONTEXT, 0: every one
  bool firstParty = true, thirdParty = true;
  std::vector<DomainMatch> ifDomain, unlessDomain;
  std::vector<Pattern> ifTop, unlessTop;
  RuleAction action = RuleAction::Block;
};
struct RuleList {
  std::vector<Rule> rules;
  std::vector<json> hide; // css-display-none: for the script of every document
  json spec;              // as the app gave them
};
static std::map<std::string, RuleList> g_lists;

static unsigned context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT c) { return 1u << (unsigned)c; }

// What WebKit calls a resource type, in WebView2's words. `popup` and `svg-document` have none: a
// popup never opens in a web view here, and an SVG document's request looks like any other's.
// `websocket` has one, which is never raised: a real socket went past a rule for it.
static unsigned contexts_of(const std::string &type) {
  const unsigned fetch = context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH) | context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST) | context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_EVENT_SOURCE);
  const unsigned ping = context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING) | context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT);
  const unsigned other = context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER) | context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MANIFEST) | context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SIGNED_EXCHANGE);
  if (type == "document") return context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT);
  if (type == "image") return context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE);
  if (type == "style-sheet") return context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET);
  if (type == "script") return context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT);
  if (type == "font") return context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT);
  if (type == "media") return context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA) | context_bit(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_TEXT_TRACK);
  if (type == "fetch") return fetch;
  if (type == "ping") return ping;
  if (type == "other") return other;
  if (type == "raw") return fetch | ping | other;
  return 0;
}

// Lowercase ASCII or punycode, `*` in front for subdomains too: WebKit's rule.
static bool parse_domains(const json &value, std::vector<DomainMatch> &out) {
  if (!value.is_array() || value.empty()) return false;
  for (const json &d : value) {
    std::string text = d.is_string() ? d.get<std::string>() : "";
    if (text.empty()) return false;
    for (unsigned char ch : text)
      if (ch >= 128 || isupper(ch)) return false;
    DomainMatch m;
    m.subdomains = text[0] == '*';
    m.domain = m.subdomains ? text.substr(1) : text;
    if (m.domain.empty()) return false;
    out.push_back(std::move(m));
  }
  return true;
}

static bool parse_patterns(const json &value, bool sensitive, std::vector<Pattern> &out, std::string &error) {
  if (!value.is_array() || value.empty()) return error = "top-url conditions must be a nonempty array", false;
  for (const json &text : value) {
    Pattern p;
    if (!text.is_string()) return error = "a top-url condition must be a string", false;
    if (!Pattern::compile(text.get<std::string>(), sensitive, p, error)) return false;
    out.push_back(std::move(p));
  }
  return true;
}

/// One rule of a list. error: what to tell the caller; what WebView2 can't do is said, not ignored.
static bool parse_rule(const json &raw, RuleList &list, std::string &error) {
  if (!raw.is_object() || !raw.contains("trigger") || !raw["trigger"].is_object() || !raw.contains("action") || !raw["action"].is_object() || !raw["action"].contains("type") || !raw["action"]["type"].is_string())
    return error = "invalid content blocker rule or unsupported action", false;
  const json &trigger = raw["trigger"];
  std::string type = raw["action"]["type"];
  bool hide = type == "css-display-none";
  // WebView2 adds a request's cookies after it has been shown here: taking them away has no effect.
  if (type == "block-cookies") return error = "content rules: WebView2 can't keep cookies from a request, so block-cookies is refused", false;
  if (!hide && type != "block" && type != "make-https" && type != "ignore-previous-rules") return error = "invalid content blocker rule or unsupported action", false;
  for (auto &[key, value] : trigger.items()) {
    (void)value;
    if (key != "url-filter" && key != "url-filter-is-case-sensitive" && key != "resource-type" && key != "load-type" && key != "if-domain" && key != "unless-domain" && key != "if-top-url" && key != "unless-top-url")
      return error = "content rules: WebView2 can't honor the trigger `" + key + "`", false;
  }
  if (!trigger.contains("url-filter") || !trigger["url-filter"].is_string()) return error = "content rules: a url-filter is required", false;
  bool sensitive = jbool(trigger, "url-filter-is-case-sensitive", false);
  Rule rule;
  std::string filter = trigger["url-filter"];
  if (!Pattern::compile(filter, sensitive, rule.url, error)) return error = "content rules: " + error, false;
  int conditions = (int)trigger.contains("if-domain") + (int)trigger.contains("unless-domain") + (int)trigger.contains("if-top-url") + (int)trigger.contains("unless-top-url");
  if (conditions > 1) return error = "content rules: one domain or top-url condition per rule", false;
  if (trigger.contains("resource-type")) {
    if (!trigger["resource-type"].is_array() || trigger["resource-type"].empty()) return error = "content rules: resource-type must be a nonempty array", false;
    for (const json &t : trigger["resource-type"]) {
      unsigned bits = t.is_string() ? contexts_of(t.get<std::string>()) : 0;
      if (!bits) return error = "content rules: WebView2 can't tell the resource type " + t.dump(), false;
      rule.contexts |= bits;
    }
  }
  if (trigger.contains("load-type")) {
    if (!trigger["load-type"].is_array() || trigger["load-type"].empty()) return error = "content rules: load-type must be a nonempty array", false;
    rule.firstParty = rule.thirdParty = false;
    for (const json &t : trigger["load-type"]) {
      if (t == "first-party") rule.firstParty = true;
      else if (t == "third-party") rule.thirdParty = true;
      else return error = "content rules: load-type is first-party or third-party", false;
    }
  }
  if (trigger.contains("if-domain") && !parse_domains(trigger["if-domain"], rule.ifDomain)) return error = "content rules: domains must be nonempty lowercase ASCII or punycode", false;
  if (trigger.contains("unless-domain") && !parse_domains(trigger["unless-domain"], rule.unlessDomain)) return error = "content rules: domains must be nonempty lowercase ASCII or punycode", false;
  if (trigger.contains("if-top-url") && !parse_patterns(trigger["if-top-url"], sensitive, rule.ifTop, error)) return error = "content rules: " + error, false;
  if (trigger.contains("unless-top-url") && !parse_patterns(trigger["unless-top-url"], sensitive, rule.unlessTop, error)) return error = "content rules: " + error, false;
  if (hide) {
    // CSS can bypass ignore-previous-rules: same conditions as WebKit's for an app-origin exclusion.
    if (trigger.contains("if-domain") || trigger.contains("if-top-url")) return error = "css-display-none requires an app-origin exclusion; use unless-domain or unless-top-url instead of positive/frame conditions", false;
    // Here it's a script in the document, which only knows its own URL.
    if (trigger.contains("resource-type") || trigger.contains("load-type")) return error = "css-display-none: on Windows a rule looks at the page's own URL, not its resources: no resource-type or load-type", false;
    std::string selector = jstr(raw["action"], "selector");
    if (selector.empty() || selector.find_first_of("{}") != std::string::npos) return error = "css-display-none needs a selector", false;
    json domains = json::array();
    for (const DomainMatch &d : rule.unlessDomain) domains.push_back(json::array({d.domain, d.subdomains}));
    list.hide.push_back(json::array({filter, sensitive, selector, domains, trigger.contains("unless-top-url") ? trigger["unless-top-url"] : json::array()}));
    return true;
  }
  rule.action = type == "block" ? RuleAction::Block : type == "make-https" ? RuleAction::MakeHttps : RuleAction::IgnorePrevious;
  list.rules.push_back(std::move(rule));
  return true;
}

// A rough registrable domain: there's no public suffix list to hand. `a.co.uk` and `b.co.uk` stay
// apart by the usual guess at country suffixes; two sites under another shared suffix don't.
static std::string site_of(const std::string &host) {
  if (host.empty() || host[0] == '[' || isdigit((unsigned char)host.back())) return host;
  auto last = host.rfind('.');
  if (last == std::string::npos || last == 0) return host;
  auto second = host.rfind('.', last - 1);
  if (second == std::string::npos) return host;
  bool country = host.size() - last - 1 == 2 && last - second - 1 <= 3;
  if (!country) return host.substr(second + 1);
  auto third = host.rfind('.', second - 1);
  return second == 0 || third == std::string::npos ? host : host.substr(third + 1);
}

static bool domain_matches(const std::vector<DomainMatch> &list, const std::string &host) {
  for (const DomainMatch &d : list) {
    if (host == d.domain) return true;
    if (d.subdomains && host.size() > d.domain.size() + 1 && host.compare(host.size() - d.domain.size() - 1, std::string::npos, "." + d.domain) == 0) return true;
  }
  return false;
}

struct Verdict {
  bool block = false, makeHttps = false;
};

// Cheapest checks first: most rules leave at the resource type or the URL.
static Verdict judge(const std::string &url, const std::string &top, unsigned context) {
  Verdict out;
  std::string topHost, requestHost;
  bool hosts = false;
  for (auto &[ident, list] : g_lists) {
    Verdict v;
    for (const Rule &rule : list.rules) {
      if (rule.contexts && !(rule.contexts & context)) continue;
      if (!rule.url.search(url)) continue;
      if (!hosts) {
        hosts = true;
        topHost = lower(url_host(top));
        requestHost = lower(url_host(url));
      }
      if (!(rule.firstParty && rule.thirdParty)) {
        bool first = site_of(requestHost) == site_of(topHost);
        if (first ? !rule.firstParty : !rule.thirdParty) continue;
      }
      if (!rule.ifDomain.empty() && !domain_matches(rule.ifDomain, topHost)) continue;
      if (!rule.unlessDomain.empty() && domain_matches(rule.unlessDomain, topHost)) continue;
      auto matches_top = [&top](const std::vector<Pattern> &patterns) {
        for (const Pattern &p : patterns)
          if (p.search(top)) return true;
        return false;
      };
      if (!rule.ifTop.empty() && !matches_top(rule.ifTop)) continue;
      if (!rule.unlessTop.empty() && matches_top(rule.unlessTop)) continue;
      switch (rule.action) {
        case RuleAction::Block: v.block = true; break;
        case RuleAction::MakeHttps: v.makeHttps = true; break;
        case RuleAction::IgnorePrevious: v = Verdict{}; break;
      }
    }
    out.block = out.block || v.block;
    out.makeHttps = out.makeHttps || v.makeHttps;
  }
  return out;
}

// Final exceptions protect the app document, its resources and the event WebSocket.
static bool app_exempt(const std::string &url) {
  std::string app = app_origin();
  if (app.empty()) return false;
  std::string origin = url_origin(url);
  if (origin == app) return true;
  return app.rfind("http", 0) == 0 && (origin == "ws" + app.substr(4) || origin == "wss" + app.substr(4));
}

static bool network_rules() {
  for (auto &[ident, list] : g_lists)
    if (!list.rules.empty()) return true;
  return false;
}

static void answer_request(ICoreWebView2 *sender, ICoreWebView2WebResourceRequestedEventArgs *args, int status, const wchar_t *reason, const std::string &headers) {
  auto *wv2 = query<ICoreWebView2_2>(sender, IID_ICoreWebView2_2);
  ICoreWebView2Environment *env = nullptr;
  ICoreWebView2WebResourceResponse *response = nullptr;
  if (wv2 && SUCCEEDED(wv2->get_Environment(&env)) && env && SUCCEEDED(env->CreateWebResourceResponse(nullptr, status, reason, wide(headers).c_str(), &response)) && response) {
    args->put_Response(response);
    response->Release();
  }
  if (env) env->Release();
  if (wv2) wv2->Release();
}

static void on_resource_requested(int id, ICoreWebView2 *sender, ICoreWebView2WebResourceRequestedEventArgs *args) {
  View *v = find_view(id);
  ICoreWebView2WebResourceRequest *request = nullptr;
  if (!v || FAILED(args->get_Request(&request)) || !request) return;
  LPWSTR uri = nullptr;
  request->get_Uri(&uri);
  std::string url = take(uri);
  COREWEBVIEW2_WEB_RESOURCE_CONTEXT context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER;
  args->get_ResourceContext(&context);
  if (network_rules() && !app_exempt(url)) {
    std::string top = url;
    // A top-level navigation's own request is first party to itself.
    if (context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT || url != v->pendingTop) {
      LPWSTR source = nullptr;
      sender->get_Source(&source);
      top = take(source);
    }
    Verdict verdict = judge(url, top, context_bit(context));
    if (verdict.block) {
      answer_request(sender, args, 403, L"Blocked", "");
      request->Release();
      return;
    }
    if (verdict.makeHttps && url.rfind("http://", 0) == 0) {
      answer_request(sender, args, 307, L"Upgraded", "Location: https://" + url.substr(7));
      request->Release();
      return;
    }
  }
  if (protocol_scheme(url_scheme(url))) serve_scheme(id, sender, args, request, url, context);
  request->Release();
}

static void set_request_filter(View *v, const std::wstring &uri, bool on) {
  // Workers' requests too, where the runtime can.
  if (auto *wv22 = query<ICoreWebView2_22>(v->webview, IID_ICoreWebView2_22)) {
    if (on) wv22->AddWebResourceRequestedFilterWithRequestSourceKinds(uri.c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL);
    else wv22->RemoveWebResourceRequestedFilterWithRequestSourceKinds(uri.c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL);
    wv22->Release();
  } else if (on) v->webview->AddWebResourceRequestedFilter(uri.c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
  else v->webview->RemoveWebResourceRequestedFilter(uri.c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
}

// Every request of a filtered web view makes a round trip to this thread, and an every-resource filter
// slows down every page: it's only on while rules that look at requests exist. Schemes only cost their own requests.
static void sync_requests(View *v) {
  if (!v->webview) return;
  bool rules = network_rules();
  if (!v->watchesRequests && (rules || !g_schemes.empty())) {
    auto *handler = new Cb<ICoreWebView2WebResourceRequestedEventHandler, ICoreWebView2 *, ICoreWebView2WebResourceRequestedEventArgs *>(
        IID_ICoreWebView2WebResourceRequestedEventHandler, [id = v->id](ICoreWebView2 *sender, ICoreWebView2WebResourceRequestedEventArgs *args) -> HRESULT {
          on_resource_requested(id, sender, args);
          return S_OK;
        });
    v->webview->add_WebResourceRequested(handler, &v->tokens[12]);
    handler->Release();
    v->watchesRequests = true;
    for (const std::string &scheme : g_schemes) set_request_filter(v, wide(scheme) + L"://*", true);
  }
  if (rules != v->ruleFilter) {
    set_request_filter(v, L"*", rules);
    v->ruleFilter = rules;
  }
}

// ===========================================================================
// Registered scripts, and the page's end of css-display-none. On a change every web view's are
// removed and added again: order is registration order, and WebView2 keeps its own.

static std::map<std::string, json> g_scripts;
static std::vector<std::string> g_script_order;

struct InstalledScripts {
  unsigned generation = 0;
  bool pageAgent = false;
  std::vector<std::wstring> page;
  std::vector<std::string> isolated;
};
static std::map<int, InstalledScripts> g_installed;

static bool valid_id(const std::string &s) { return !s.empty() && wide(s).size() <= 256; }

static std::string hide_script() {
  json rules = json::array();
  for (auto &[ident, list] : g_lists)
    for (const json &rule : list.hide) rules.push_back(rule);
  if (rules.empty()) return "";
  // Constructed sheets are out of the page's own Content-Security-Policy and need no element to go in.
  return "(()=>{try{const app=" + json(app_origin()).dump() + ",rules=" + rules.dump() + R"(,anc=location.ancestorOrigins,top=anc&&anc.length?anc[anc.length-1]:location.href,topUrl=new URL(top);
if(topUrl.origin===app)return;
const hide=[];
for(const [filter,sensitive,selector,domains,tops] of rules){
if(!new RegExp(filter,sensitive?'':'i').test(location.href))continue;
if(domains.some(([d,sub])=>topUrl.hostname===d||(sub&&topUrl.hostname.endsWith('.'+d))))continue;
if(tops.some((t)=>new RegExp(t,sensitive?'':'i').test(top)))continue;
hide.push(selector+'{display:none!important}');
}
if(!hide.length)return;
const sheet=new CSSStyleSheet();
sheet.replaceSync(hide.join('\n'));
document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
}catch{}})())";
}

static std::string script_text(const json &spec) {
  std::string text = jstr(spec, "source");
  if (jstr(spec, "timing") == "end") text = "(()=>{const run=function(){\n" + text + "\n};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();})()";
  return jbool(spec, "mainFrameOnly", true) ? "if(window.top===window){\n" + text + "\n}" : text;
}

static bool script_applies(const json &spec, View *v) {
  if (!spec.contains("target")) return true;
  json actual = view_source(v);
  for (const char *key : {"windowId", "popoverId", "viewId"})
    if (spec["target"].contains(key) && (!actual.contains(key) || actual[key] != spec["target"][key])) return false;
  return true;
}

static void devtools_call(View *v, const wchar_t *method, const json &params, std::function<void(HRESULT, const std::string &)> done) {
  auto *cb = new Cb<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, HRESULT, LPCWSTR>(
      IID_ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, [done](HRESULT hr, LPCWSTR result) -> HRESULT {
        done(hr, utf8(result));
        return S_OK;
      });
  HRESULT hr = v->webview->CallDevToolsProtocolMethod(method, wide(params.dump()).c_str(), cb);
  cb->Release();
  if (FAILED(hr)) done(hr, "");
}

static void apply_scripts(View *v, std::function<void()> done) {
  if (!v->webview) return done();
  int id = v->id;
  InstalledScripts &installed = g_installed[id];
  for (const std::wstring &handle : installed.page) v->webview->RemoveScriptToExecuteOnDocumentCreated(handle.c_str());
  for (const std::string &handle : installed.isolated) devtools_call(v, L"Page.removeScriptToEvaluateOnNewDocument", json{{"identifier", handle}}, [](HRESULT, const std::string &) {});
  installed.page.clear();
  installed.isolated.clear();
  unsigned generation = ++installed.generation;
  auto left = std::make_shared<int>(1);
  auto one_done = [left, done] {
    if (!--*left) done();
  };
  auto add_page = [&](const std::string &text) {
    ++*left;
    auto *cb = new Cb<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, HRESULT, LPCWSTR>(
        IID_ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler, [id, generation, one_done](HRESULT hr, LPCWSTR handle) -> HRESULT {
          View *now = find_view(id);
          if (SUCCEEDED(hr) && handle && now && now->webview) {
            // Replaced since: it's already out of date.
            if (g_installed[id].generation != generation) now->webview->RemoveScriptToExecuteOnDocumentCreated(handle);
            else g_installed[id].page.push_back(handle);
          }
          one_done();
          return S_OK;
        });
    HRESULT hr = v->webview->AddScriptToExecuteOnDocumentCreated(wide(text).c_str(), cb);
    cb->Release();
    if (FAILED(hr)) one_done();
  };
  std::string hide = hide_script();
  if (!hide.empty()) add_page(hide);
  for (const std::string &ident : g_script_order) {
    const json &spec = g_scripts[ident];
    if (!script_applies(spec, v)) continue;
    std::string world = jstr(spec, "world");
    if (world == "page") {
      add_page(script_text(spec));
      continue;
    }
    // A named world: only the DevTools protocol has them. The agent needs turning on once.
    if (!installed.pageAgent) {
      installed.pageAgent = true;
      devtools_call(v, L"Page.enable", json::object(), [](HRESULT, const std::string &) {});
    }
    ++*left;
    devtools_call(v, L"Page.addScriptToEvaluateOnNewDocument", json{{"source", script_text(spec)}, {"worldName", world}}, [id, generation, one_done](HRESULT hr, const std::string &result) {
      View *now = find_view(id);
      json reply = SUCCEEDED(hr) ? json::parse(result, nullptr, false) : json();
      std::string handle = reply.is_object() ? jstr(reply, "identifier") : "";
      if (now && now->webview && !handle.empty()) {
        if (g_installed[id].generation != generation) devtools_call(now, L"Page.removeScriptToEvaluateOnNewDocument", json{{"identifier", handle}}, [](HRESULT, const std::string &) {});
        else g_installed[id].isolated.push_back(handle);
      }
      one_done();
    });
  }
  one_done();
}

// Answers once every web view has what's new: the next navigation sees it.
static void apply_scripts_everywhere(std::function<void()> done) {
  auto left = std::make_shared<size_t>(1);
  auto one_done = [left, done] {
    if (!--*left) done();
  };
  std::vector<View *> all;
  for (auto &[id, v] : views())
    if (v->webview) all.push_back(v);
  *left += all.size();
  for (View *v : all) apply_scripts(v, one_done);
  one_done();
}

void web_sessions_attach(View *v, std::function<void()> done) {
  g_installed.erase(v->id); // a new controller, after a browser crash: nothing of the old one is left
  sync_requests(v);
  if (g_script_order.empty() && hide_script().empty()) return done();
  apply_scripts(v, std::move(done));
}

void web_sessions_navigating(View *v, const std::string &url) {
  v->pendingTop = url;
  v->navigation++;
}

void web_sessions_content_loading(View *v) {
  std::vector<std::string> gone;
  for (auto &[id, r] : g_resources)
    if (r->view == v->id && !(r->mainDocument && r->navigation == v->navigation)) gone.push_back(id);
  for (const std::string &id : gone) cancel_resource(id);
}

// ===========================================================================
// Input policy: AcceleratorKeyPressed comes before the page and the menus, and put_Handled keeps it from both.

struct InputRule {
  std::string key;
  UINT vk = 0;       // a named key
  wchar_t ch = 0;    // or what it types in the active layout, unshifted
  UINT mods = 0;
  json modifiers;
};
struct InputPolicy {
  std::vector<InputRule> rules;
  bool menuShortcuts = true;
};
static std::map<int, InputPolicy> g_policies; // by native window

// Keys that make no character, which WebView2 reports held or not. On a real runtime Enter, Tab,
// Space and Backspace on their own aren't reported, nor is a character key with Shift only.
static UINT silent_key(const std::string &name) {
  static const std::map<std::string, UINT> keys = {{"escape", VK_ESCAPE}, {"delete", VK_DELETE}, {"arrowup", VK_UP}, {"arrowdown", VK_DOWN}, {"arrowleft", VK_LEFT}, {"arrowright", VK_RIGHT}, {"home", VK_HOME}, {"end", VK_END}, {"pageup", VK_PRIOR}, {"pagedown", VK_NEXT}, {"insert", VK_INSERT}};
  auto it = keys.find(name);
  if (it != keys.end()) return it->second;
  if (name.size() >= 2 && name[0] == 'f') {
    int n = atoi(name.c_str() + 1);
    if (n >= 1 && n <= 24 && name == "f" + std::to_string(n)) return VK_F1 + (UINT)n - 1;
  }
  return 0;
}

static UINT typing_key(const std::string &name) {
  return name == "enter" || name == "return" ? VK_RETURN : name == "tab" ? VK_TAB : name == "space" ? VK_SPACE : name == "backspace" ? VK_BACK : 0;
}

bool input_policy_key(int native_id, UINT vk, ICoreWebView2AcceleratorKeyPressedEventArgs *args, bool &menus) {
  int window = find_window(native_id) ? native_id : view_owner(native_id);
  auto it = g_policies.find(window);
  if (it == g_policies.end()) return false;
  menus = it->second.menuShortcuts;
  UINT mods = current_key_mods();
  wchar_t typed = (wchar_t)towlower((wint_t)(MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR) & 0x7fffffff));
  for (const InputRule &rule : it->second.rules) {
    if (rule.mods != mods || (rule.vk ? rule.vk != vk : rule.ch != typed)) continue;
    COREWEBVIEW2_KEY_EVENT_KIND kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
    args->get_KeyEventKind(&kind);
    COREWEBVIEW2_PHYSICAL_KEY_STATUS status{};
    args->get_PhysicalKeyStatus(&status);
    bool down = kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;
    json d{{"windowId", backend_public_window_id(window)}, {"key", rule.key}, {"keyCode", vk}, {"type", down ? "keyDown" : "keyUp"}, {"isAutoRepeat", down && status.WasKeyDown}, {"modifiers", rule.modifiers}, {"intercepted", true}};
    // Off the WebView2 event stack. A decision was made without waiting: this only reports it.
    backend_run_on_main([window, d]() mutable {
      emit_raw(json{{"type", "platform"}, {"name", "beforeInput"}, {"data", d}});
      for (int page : backend_page_ids()) {
        d["target"] = page == window;
        backend_eval_in_page(page, deliver_js("beforeInput", d));
      }
    });
    return true;
  }
  return false;
}

static void register_input() {
  reg("webview", "setInputPolicy", [](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    if (!w) return c->fail("unavailable", "input policy window is not open");
    if ((c->has("intercept") && !c->args["intercept"].is_array()) || (c->has("menuShortcuts") && !c->args["menuShortcuts"].is_boolean()))
      return c->fail("invalid_args", "intercept must be an array and menuShortcuts a boolean");
    InputPolicy next;
    next.menuShortcuts = c->flag("menuShortcuts", true);
    for (const json &raw : c->has("intercept") ? c->args["intercept"] : json::array()) {
      if (!raw.is_object() || !raw.contains("key") || !raw["key"].is_string() || raw["key"].get<std::string>().empty() || (raw.contains("modifiers") && !raw["modifiers"].is_array()))
        return c->fail("invalid_args", "each input shortcut needs key and optional modifiers array");
      InputRule rule;
      rule.key = raw["key"];
      rule.modifiers = raw.contains("modifiers") ? raw["modifiers"] : json::array();
      for (const json &m : rule.modifiers) {
        std::string name = m.is_string() ? m.get<std::string>() : "";
        if (name != "meta" && name != "control" && name != "alt" && name != "shift") return c->fail("invalid_args", "input modifiers: meta, control, alt, shift");
        rule.mods |= name == "meta" ? MOD_WIN : name == "control" ? MOD_CONTROL : name == "alt" ? MOD_ALT : MOD_SHIFT;
      }
      std::string name = lower(rule.key);
      std::wstring chars = wide(rule.key);
      rule.vk = silent_key(name);
      UINT typing = rule.vk ? 0 : typing_key(name);
      if (!rule.vk && !typing && chars.size() != 1) return c->fail("invalid_args", "input shortcut: unknown key `" + rule.key + "`");
      // WebView2 only reports what's held with Control or Alt, and keys that make no character.
      // Anything else reaches the page without this code hearing of it: better said than a rule that never holds.
      if (!rule.vk && !(rule.mods & (MOD_CONTROL | MOD_ALT))) return c->fail("invalid_args", "input shortcut `" + rule.key + "`: on Windows a key that makes a character can only be intercepted with control or alt");
      if (typing) rule.vk = typing;
      else if (!rule.vk) rule.ch = (wchar_t)towlower((wint_t)chars[0]);
      next.rules.push_back(std::move(rule));
    }
    size_t count = next.rules.size();
    bool menus = next.menuShortcuts;
    g_policies[w->id] = std::move(next);
    c->ok(json{{"monitorInstalled", true}, {"interceptCount", count}, {"menuShortcuts", menus}});
  });
  reg("webview", "getInputPolicy", [](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    if (!w) return c->fail("unavailable", "input policy window is not open");
    auto it = g_policies.find(w->id);
    json rules = json::array();
    if (it != g_policies.end())
      for (const InputRule &rule : it->second.rules) rules.push_back(json{{"key", rule.key}, {"modifiers", rule.modifiers}});
    c->ok(json{{"monitorInstalled", true}, {"intercept", rules}, {"menuShortcuts", it == g_policies.end() ? true : it->second.menuShortcuts}});
  });
}

// ===========================================================================

void web_sessions_detach(View *v) {
  std::vector<std::string> gone;
  for (auto &[id, r] : g_resources)
    if (r->view == v->id) gone.push_back(id);
  for (const std::string &id : gone) cancel_resource(id);
  if (v->webview && v->watchesRequests) v->webview->remove_WebResourceRequested(v->tokens[12]);
  g_installed.erase(v->id);
  g_policies.erase(v->id);
}

static void rules_changed(CallPtr c) {
  for (auto &[id, v] : views()) sync_requests(v);
  apply_scripts_everywhere([c] { c->ok(); });
}

static void register_content() {
  reg("webview", "setContentRules", [](CallPtr c) {
    std::string ident = c->str("id");
    if (!valid_id(ident) || !c->has("rules") || !c->args["rules"].is_array() || c->args["rules"].empty()) return c->fail("invalid_args", "id and a nonempty rules array are required");
    if (app_origin().empty()) return c->fail("unavailable", "the app origin is not ready");
    RuleList list;
    list.spec = c->args["rules"];
    for (const json &raw : c->args["rules"]) {
      std::string error;
      if (!parse_rule(raw, list, error)) return c->fail("invalid_args", error);
    }
    bool hides = !list.hide.empty();
    auto it = g_lists.find(ident);
    hides = hides || (it != g_lists.end() && !it->second.hide.empty());
    g_lists[ident] = std::move(list);
    if (hides) return rules_changed(c);
    for (auto &[id, v] : views()) sync_requests(v);
    c->ok();
  });
  reg("webview", "removeContentRules", [](CallPtr c) {
    std::string ident = c->str("id");
    if (!valid_id(ident)) return c->fail("invalid_args", "id is required");
    auto it = g_lists.find(ident);
    bool hides = it != g_lists.end() && !it->second.hide.empty();
    if (it != g_lists.end()) g_lists.erase(it);
    if (hides) return rules_changed(c);
    for (auto &[id, v] : views()) sync_requests(v);
    c->ok();
  });
  reg("webview", "listContentRules", [](CallPtr c) {
    json out = json::array();
    for (auto &[ident, list] : g_lists) out.push_back(json{{"id", ident}, {"rules", list.spec}});
    c->ok(out);
  });
  reg("webview", "registerScript", [](CallPtr c) {
    std::string ident = c->str("id"), world = c->str("world"), timing = c->str("timing");
    if (!valid_id(ident) || !c->has("source") || !c->args["source"].is_string() || !valid_id(world) || (timing != "start" && timing != "end"))
      return c->fail("invalid_args", "script requires id, source, world and start/end timing");
    if (c->has("target") && !c->args["target"].is_object()) return c->fail("invalid_args", "target must be an object");
    if (c->has("target"))
      for (auto &[key, value] : c->args["target"].items())
        if (!(key == "windowId" ? value.is_number() : ((key == "popoverId" || key == "viewId") && value.is_string()))) return c->fail("invalid_args", "invalid script target");
    json spec{{"id", ident}, {"source", c->str("source")}, {"world", world}, {"timing", timing}, {"mainFrameOnly", c->flag("mainFrameOnly", true)}};
    if (c->has("target")) spec["target"] = c->args["target"];
    if (!g_scripts.count(ident)) g_script_order.push_back(ident);
    g_scripts[ident] = spec;
    apply_scripts_everywhere([c] { c->ok(); });
  });
  reg("webview", "unregisterScript", [](CallPtr c) {
    std::string ident = c->str("id");
    if (!valid_id(ident)) return c->fail("invalid_args", "id is required");
    g_scripts.erase(ident);
    g_script_order.erase(std::remove(g_script_order.begin(), g_script_order.end(), ident), g_script_order.end());
    apply_scripts_everywhere([c] { c->ok(); });
  });
  reg("webview", "listScripts", [](CallPtr c) {
    json out = json::array();
    for (const std::string &ident : g_script_order) out.push_back(g_scripts[ident]);
    c->ok(out);
  });
}

void register_web_sessions() {
  register_session_ops();
  register_protocol();
  register_content();
  register_input();
}

} // namespace sd::win
