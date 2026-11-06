// Cookies of every session, same shapes as native/platform_sessions.mm:
//   sessions.cookiesGet · cookiesSet · cookiesRemove · watchCookies
// The rest of sessions.* is in svc_web_sessions.cc. Any web view of the default session reaches its
// cookie manager, and a named one's hidden web view reaches its own.
#include "win.hpp"

#include <ctime>
#include <set>

namespace sd::win {

static const char *const kGateCookie = "__kitop"; // src/gate.ts SESSION_COOKIE: the shell's, never exported

ICoreWebView2CookieManager *session_cookie_manager(const SessionPtr &s) {
  if (s->id != "default") {
    if (s->cookies) s->cookies->AddRef();
    return s->cookies;
  }
  for (auto &[id, v] : views()) {
    if (!v->webview || !v->session.empty()) continue;
    auto *wv2 = query<ICoreWebView2_2>(v->webview, IID_ICoreWebView2_2);
    if (!wv2) continue;
    ICoreWebView2CookieManager *m = nullptr;
    HRESULT hr = wv2->get_CookieManager(&m);
    wv2->Release();
    if (SUCCEEDED(hr) && m) return m;
  }
  return nullptr;
}

static std::string take(LPWSTR s) {
  std::string out = utf8(s);
  if (s) CoTaskMemFree(s);
  return out;
}

static std::string cookie_name(ICoreWebView2Cookie *c) {
  LPWSTR s = nullptr;
  c->get_Name(&s);
  return take(s);
}

static json cookie_json(ICoreWebView2Cookie *c) {
  LPWSTR name = nullptr, value = nullptr, domain = nullptr, path = nullptr;
  c->get_Name(&name);
  c->get_Value(&value);
  c->get_Domain(&domain);
  c->get_Path(&path);
  BOOL secure = FALSE, httpOnly = FALSE, session = FALSE;
  c->get_IsSecure(&secure);
  c->get_IsHttpOnly(&httpOnly);
  c->get_IsSession(&session);
  json d = {{"name", take(name)}, {"value", take(value)}, {"domain", take(domain)}, {"path", take(path)},
            {"secure", secure != FALSE}, {"httpOnly", httpOnly != FALSE}, {"sessionOnly", session != FALSE}};
  double expires = -1;
  if (!session && SUCCEEDED(c->get_Expires(&expires)) && expires >= 0) d["expires"] = expires;
  COREWEBVIEW2_COOKIE_SAME_SITE_KIND same = COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX;
  if (SUCCEEDED(c->get_SameSite(&same)))
    d["sameSite"] = same == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE ? "None" : same == COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT ? "Strict" : "Lax";
  return d;
}

bool session_get_cookies(ICoreWebView2CookieManager *m, const std::string &uri, CookiesFn done) {
  auto *cb = new Cb<ICoreWebView2GetCookiesCompletedHandler, HRESULT, ICoreWebView2CookieList *>(
      IID_ICoreWebView2GetCookiesCompletedHandler, [done](HRESULT hr, ICoreWebView2CookieList *list) -> HRESULT {
        done(hr, list);
        return S_OK;
      });
  HRESULT hr = m->GetCookies(uri.empty() ? L"" : wide(uri).c_str(), cb);
  cb->Release();
  return SUCCEEDED(hr);
}

void session_read_cookies(const SessionPtr &s, std::function<void(const json &)> done) {
  ICoreWebView2CookieManager *m = session_cookie_manager(s);
  if (!m) return done(json::array());
  bool started = session_get_cookies(m, "", [done](HRESULT, ICoreWebView2CookieList *list) {
    json out = json::array();
    UINT n = 0;
    if (list) list->get_Count(&n);
    for (UINT i = 0; i < n; i++) {
      ICoreWebView2Cookie *c = nullptr;
      if (FAILED(list->GetValueAtIndex(i, &c)) || !c) continue;
      out.push_back(cookie_json(c));
      c->Release();
    }
    done(out);
  });
  m->Release();
  if (!started) done(json::array());
}

void session_write_cookies(const SessionPtr &s, const json &cookies) {
  ICoreWebView2CookieManager *m = session_cookie_manager(s);
  if (!m) return;
  for (const json &d : cookies) {
    ICoreWebView2Cookie *c = nullptr;
    if (FAILED(m->CreateCookie(wide(jstr(d, "name")).c_str(), wide(jstr(d, "value")).c_str(), wide(jstr(d, "domain")).c_str(), wide(jstr(d, "path")).c_str(), &c)) || !c) continue;
    c->put_IsSecure(jbool(d, "secure", false) ? TRUE : FALSE);
    c->put_IsHttpOnly(jbool(d, "httpOnly", false) ? TRUE : FALSE);
    std::string same = jstr(d, "sameSite");
    if (!same.empty()) c->put_SameSite(same == "None" ? COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE : same == "Strict" ? COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT : COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX);
    if (d.contains("expires")) c->put_Expires(jnum(d, "expires", -1));
    m->AddOrUpdateCookie(c);
    c->Release();
  }
  m->Release();
}

// ---------------------------------------------------------------------------
// Changes: WebView2 has no cookie event. While someone listens the profiles with a view open are
// compared once a second, as macOS does for what WebKit doesn't report; native changes compare at once.

static std::set<int> g_watchers; // pages listening (native ids), 0 = server code
static bool g_timer = false;

static void take_snapshot(const SessionPtr &s, std::function<void()> then = {}) {
  if (s->reading) {
    s->dirty = true;
    if (then) then();
    return;
  }
  ICoreWebView2CookieManager *m = session_cookie_manager(s);
  if (!m) {
    if (then) then();
    return;
  }
  s->reading = true;
  bool started = session_get_cookies(m, "", [s, then](HRESULT hr, ICoreWebView2CookieList *list) {
    s->reading = false;
    if (SUCCEEDED(hr) && list) {
      std::map<std::string, json> next;
      UINT n = 0;
      list->get_Count(&n);
      for (UINT i = 0; i < n; i++) {
        ICoreWebView2Cookie *c = nullptr;
        if (FAILED(list->GetValueAtIndex(i, &c)) || !c) continue;
        if (cookie_name(c) != kGateCookie) {
          json d = cookie_json(c);
          next[jstr(d, "domain") + "\n" + jstr(d, "path") + "\n" + jstr(d, "name")] = d;
        }
        c->Release();
      }
      if (s->hasSnapshot && !s->removing) {
        for (auto &[key, d] : s->snapshot)
          if (!next.count(key)) emit("sessionCookieChanged", json{{"session", s->id}, {"cookie", d}, {"removed", true}});
        for (auto &[key, d] : next) {
          auto it = s->snapshot.find(key);
          if (it == s->snapshot.end() || it->second != d) emit("sessionCookieChanged", json{{"session", s->id}, {"cookie", d}, {"removed", false}});
        }
      }
      s->snapshot = std::move(next);
      s->hasSnapshot = true;
    }
    if (then) then();
    if (s->dirty) {
      s->dirty = false;
      take_snapshot(s);
    }
  });
  if (!started) {
    s->reading = false;
    if (then) then();
  }
  m->Release();
}

static void refresh_cookies(const SessionPtr &s) {
  if (s->hasSnapshot || !g_watchers.empty()) take_snapshot(s); // otherwise nobody asked yet
}

void session_cookies_started(const SessionPtr &s, std::function<void()> done) {
  if (g_watchers.empty()) return done();
  take_snapshot(s, done);
}

static void poll_cookies() {
  for (auto it = g_watchers.begin(); it != g_watchers.end();) it = *it && !find_view(*it) ? g_watchers.erase(it) : std::next(it);
  if (g_watchers.empty()) {
    g_timer = false;
    return;
  }
  std::set<std::string> active{""};
  for (auto &[id, v] : views()) active.insert(v->session);
  for (auto &[ident, s] : sessions())
    if (!s->removing && active.count(ident == "default" ? "" : ident)) take_snapshot(s);
  run_after(1000, poll_cookies);
}

void sessions_page_unloaded(int native_id) { g_watchers.erase(native_id); }

// ---------------------------------------------------------------------------

static SessionPtr session_arg(const CallPtr &c) {
  SessionPtr s = !c->has("session") ? session_named("") : c->args["session"].is_string() ? session_named(c->str("session")) : nullptr;
  if (!s) c->fail("invalid_args", "sessions: unknown or removing session");
  return s;
}

/// Its store open, counted in `pending` from here to the operation's end (sessions.remove waits).
static void with_store(const CallPtr &c, const SessionPtr &s, std::function<void()> fn) {
  s->pending++;
  session_open(s, [c, s, fn](const std::string &error) {
    if (error.empty()) return fn();
    s->pending--;
    c->fail("unavailable", error);
  });
}

static bool filter(const CallPtr &c, std::string &url, std::string &name) {
  url.clear();
  name = c->str("name");
  if (c->has("name") && !c->args["name"].is_string()) return c->fail("invalid_args", "cookies: name must be a string"), false;
  if (c->has("url")) {
    url = c->str("url");
    std::string scheme = url_scheme(url);
    if ((scheme != "http" && scheme != "https") || url_host(url).empty()) return c->fail("invalid_args", "cookies: an HTTP(S) URL is required"), false;
  }
  if (name == kGateCookie) return c->fail("denied", "cookies: the shell authentication cookie is protected"), false;
  return true;
}

void clear_site_cookies(std::function<bool(const std::string &host)> keep, std::function<void(const std::set<std::string> &)> done) {
  SessionPtr main = session_named("");
  ICoreWebView2CookieManager *m = session_cookie_manager(main);
  if (!m) return done({});
  m->AddRef(); // kept by the completion
  bool started = session_get_cookies(m, "", [m, main, keep, done](HRESULT, ICoreWebView2CookieList *list) {
    std::set<std::string> hosts;
    UINT n = 0;
    if (list) list->get_Count(&n);
    for (UINT i = 0; i < n; i++) {
      ICoreWebView2Cookie *x = nullptr;
      if (FAILED(list->GetValueAtIndex(i, &x)) || !x) continue;
      std::string host = lower(jstr(cookie_json(x), "domain"));
      if (!host.empty() && host[0] == '.') host.erase(0, 1);
      if (!keep(host) && SUCCEEDED(m->DeleteCookie(x))) hosts.insert(host);
      x->Release();
    }
    m->Release();
    refresh_cookies(main);
    done(hosts);
  });
  m->Release();
  if (!started) {
    m->Release();
    done({});
  }
}

static bool has_any(const std::string &s, const char *chars) { return s.find_first_of(chars) != std::string::npos; }

void register_sessions() {
  reg("sessions", "watchCookies", [](CallPtr c) {
    if (c->flag("enabled", true)) g_watchers.insert(c->caller);
    else g_watchers.erase(c->caller);
    if (g_watchers.empty() || g_timer) return c->ok();
    g_timer = true;
    // The first comparison is against what's there now, not against nothing.
    for (auto &[ident, s] : sessions()) s->hasSnapshot = false;
    poll_cookies();
    c->ok();
  });
  reg("sessions", "cookiesGet", [](CallPtr c) {
    SessionPtr s = session_arg(c);
    if (!s) return;
    std::string url, name;
    if (!filter(c, url, name)) return;
    with_store(c, s, [c, s, url, name] {
      ICoreWebView2CookieManager *m = session_cookie_manager(s);
      if (!m) {
        s->pending--;
        return c->fail("unavailable", "sessions: no web view is ready yet");
      }
      bool started = session_get_cookies(m, url, [c, s, name](HRESULT hr, ICoreWebView2CookieList *list) {
        s->pending--;
        if (FAILED(hr) || !list) return c->fail("unavailable", "cookies.get: " + hresult_message(hr));
        json out = json::array();
        UINT n = 0;
        list->get_Count(&n);
        for (UINT i = 0; i < n; i++) {
          ICoreWebView2Cookie *cookie = nullptr;
          if (FAILED(list->GetValueAtIndex(i, &cookie)) || !cookie) continue;
          std::string found = cookie_name(cookie);
          if (found != kGateCookie && (name.empty() || found == name)) out.push_back(cookie_json(cookie));
          cookie->Release();
        }
        c->ok(out);
      });
      m->Release();
      if (!started) {
        s->pending--;
        c->fail("unavailable", "cookies.get: the cookie manager refused");
      }
    });
  });
  reg("sessions", "cookiesSet", [](CallPtr c) {
    SessionPtr s = session_arg(c);
    if (!s) return;
    std::string url, name;
    if (!filter(c, url, name)) return;
    for (const char *key : {"domain", "path", "sameSite"})
      if (c->has(key) && !c->args[key].is_string()) return c->fail("invalid_args", "cookies.set: domain, path and sameSite must be strings");
    for (const char *key : {"secure", "httpOnly"})
      if (c->has(key) && !c->args[key].is_boolean()) return c->fail("invalid_args", "cookies.set: secure and httpOnly must be booleans");
    std::string value = c->str("value"), path = c->str("path", "/"), host = lower(url_host(url)), domain = c->str("domain", host);
    if (url.empty() || name.empty() || !(c->has("value") && c->args["value"].is_string()) || domain.empty() || path[0] != '/' ||
        has_any(name, "=;\r\n\t ") || has_any(value, ";\r\n"))
      return c->fail("invalid_args", "cookies.set: url, name, value and a valid path/domain are required");
    std::string bare = lower(domain[0] == '.' ? domain.substr(1) : domain);
    bool suffix = host.size() > bare.size() + 1 && host.compare(host.size() - bare.size() - 1, std::string::npos, "." + bare) == 0;
    if (host != bare && !(domain[0] == '.' && suffix)) return c->fail("invalid_args", "cookies.set: domain does not match url");
    bool secure = c->flag("secure", false), https = url_scheme(url) == "https";
    std::string same = c->str("sameSite");
    if (!same.empty() && same != "Lax" && same != "Strict" && same != "None") return c->fail("invalid_args", "cookies.set: invalid sameSite");
    if (c->has("expires") && !c->args["expires"].is_number()) return c->fail("invalid_args", "cookies.set: expires must be seconds since epoch");
    if ((secure && !https) || (same == "None" && !secure)) return c->fail("invalid_args", "cookies.set: Secure requires HTTPS; SameSite=None requires Secure");
    with_store(c, s, [c, s, url, name, value, path, domain, secure, same] {
      ICoreWebView2CookieManager *m = session_cookie_manager(s);
      if (!m) {
        s->pending--;
        return c->fail("unavailable", "sessions: no web view is ready yet");
      }
      ICoreWebView2Cookie *cookie = nullptr;
      HRESULT hr = m->CreateCookie(wide(name).c_str(), wide(value).c_str(), wide(domain).c_str(), wide(path).c_str(), &cookie);
      if (FAILED(hr) || !cookie) {
        s->pending--;
        m->Release();
        return c->fail("invalid_args", "cookies.set: invalid cookie");
      }
      cookie->put_IsSecure(secure ? TRUE : FALSE);
      cookie->put_IsHttpOnly(c->flag("httpOnly", false) ? TRUE : FALSE);
      if (!same.empty()) cookie->put_SameSite(same == "None" ? COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE : same == "Strict" ? COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT : COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX);
      double expires = c->num("expires", -1);
      if (c->has("expires")) cookie->put_Expires(expires);
      hr = m->AddOrUpdateCookie(cookie);
      cookie->Release();
      if (FAILED(hr)) {
        s->pending--;
        m->Release();
        return c->fail("unavailable", "cookies.set: " + hresult_message(hr));
      }
      // Answered once it reads back, like the WebKit side.
      bool expired = c->has("expires") && expires <= (double)time(nullptr);
      bool started = session_get_cookies(m, url, [c, s, name, value, path, expired](HRESULT, ICoreWebView2CookieList *list) {
        s->pending--;
        bool found = false;
        UINT n = 0;
        if (list) list->get_Count(&n);
        for (UINT i = 0; list && i < n && !found; i++) {
          ICoreWebView2Cookie *x = nullptr;
          if (FAILED(list->GetValueAtIndex(i, &x)) || !x) continue;
          json d = cookie_json(x);
          found = jstr(d, "name") == name && jstr(d, "value") == value && jstr(d, "path") == path;
          x->Release();
        }
        refresh_cookies(s);
        found || expired ? c->ok() : c->fail("unavailable", "WebView2 did not retain the cookie");
      });
      m->Release();
      if (!started) {
        s->pending--;
        c->fail("unavailable", "cookies.set: the cookie manager refused");
      }
    });
  });
  reg("sessions", "cookiesRemove", [](CallPtr c) {
    SessionPtr s = session_arg(c);
    if (!s) return;
    std::string url, name;
    if (!filter(c, url, name)) return;
    if (url.empty() || name.empty()) return c->fail("invalid_args", "cookies.remove: url and name are required");
    with_store(c, s, [c, s, url, name] {
      ICoreWebView2CookieManager *m = session_cookie_manager(s);
      if (!m) {
        s->pending--;
        return c->fail("unavailable", "sessions: no web view is ready yet");
      }
      m->AddRef(); // kept by the completion
      bool started = session_get_cookies(m, url, [c, s, m, name](HRESULT hr, ICoreWebView2CookieList *list) {
        s->pending--;
        int count = 0;
        UINT n = 0;
        if (SUCCEEDED(hr) && list) list->get_Count(&n);
        for (UINT i = 0; i < n; i++) {
          ICoreWebView2Cookie *x = nullptr;
          if (FAILED(list->GetValueAtIndex(i, &x)) || !x) continue;
          if (cookie_name(x) == name && SUCCEEDED(m->DeleteCookie(x))) count++;
          x->Release();
        }
        m->Release();
        refresh_cookies(s);
        FAILED(hr) ? c->fail("unavailable", "cookies.remove: " + hresult_message(hr)) : c->ok(json{{"removed", count}});
      });
      m->Release();
      if (!started) {
        s->pending--;
        m->Release();
        c->fail("unavailable", "cookies.remove: the cookie manager refused");
      }
    });
  });
}

} // namespace sd::win
