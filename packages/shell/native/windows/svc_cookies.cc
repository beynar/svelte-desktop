// sessions.* on the default profile, same shapes as native/platform_sessions.mm:
//   list · capabilities · getProxy · cookiesGet · cookiesSet · cookiesRemove · watchCookies
// Named profiles and proxies aren't implemented: sessions.create, remove and setProxy stay
// unregistered (`unsupported`), and any other session id is unknown. Every web view here shares one
// profile, so any of them reaches its cookie manager.
#include "win.hpp"

#include <ctime>
#include <set>

namespace sd::win {

static const char *const kGateCookie = "__kitop"; // src/gate.ts SESSION_COOKIE: the shell's, never exported

static ICoreWebView2CookieManager *cookie_manager() {
  for (auto &[id, v] : views()) {
    if (!v->webview) continue;
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

using CookiesFn = std::function<void(HRESULT, ICoreWebView2CookieList *)>;

/// Empty uri: every cookie of the profile.
static bool get_cookies(ICoreWebView2CookieManager *m, const std::string &uri, CookiesFn done) {
  auto *cb = new Cb<ICoreWebView2GetCookiesCompletedHandler, HRESULT, ICoreWebView2CookieList *>(
      IID_ICoreWebView2GetCookiesCompletedHandler, [done](HRESULT hr, ICoreWebView2CookieList *list) -> HRESULT {
        done(hr, list);
        return S_OK;
      });
  HRESULT hr = m->GetCookies(uri.empty() ? L"" : wide(uri).c_str(), cb);
  cb->Release();
  return SUCCEEDED(hr);
}

// ---------------------------------------------------------------------------
// Changes: WebView2 has no cookie event. While someone listens the profile is compared once a
// second, as macOS does for what WebKit doesn't report; native changes compare at once.

static std::set<int> g_watchers; // pages listening (native ids), 0 = server code
static bool g_timer = false, g_reading = false, g_dirty = false;
static bool g_has_snapshot = false;
static std::map<std::string, json> g_snapshot;

static void refresh_cookies() {
  if (!g_has_snapshot && g_watchers.empty()) return; // nobody asked yet
  if (g_reading) {
    g_dirty = true;
    return;
  }
  ICoreWebView2CookieManager *m = cookie_manager();
  if (!m) return;
  g_reading = true;
  bool started = get_cookies(m, "", [](HRESULT hr, ICoreWebView2CookieList *list) {
    g_reading = false;
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
      if (g_has_snapshot) {
        for (auto &[key, d] : g_snapshot)
          if (!next.count(key)) emit("sessionCookieChanged", json{{"session", "default"}, {"cookie", d}, {"removed", true}});
        for (auto &[key, d] : next) {
          auto it = g_snapshot.find(key);
          if (it == g_snapshot.end() || it->second != d) emit("sessionCookieChanged", json{{"session", "default"}, {"cookie", d}, {"removed", false}});
        }
      }
      g_snapshot = std::move(next);
      g_has_snapshot = true;
    }
    if (g_dirty) {
      g_dirty = false;
      refresh_cookies();
    }
  });
  if (!started) g_reading = false;
  m->Release();
}

static void poll_cookies() {
  for (auto it = g_watchers.begin(); it != g_watchers.end();) it = *it && !find_view(*it) ? g_watchers.erase(it) : std::next(it);
  if (g_watchers.empty()) {
    g_timer = false;
    return;
  }
  refresh_cookies();
  run_after(1000, poll_cookies);
}

void sessions_page_unloaded(int native_id) { g_watchers.erase(native_id); }

// ---------------------------------------------------------------------------

/// The default profile or an error reply: the only one there is here.
static bool default_session(const CallPtr &c) {
  if (!c->has("session") || c->str("session") == "default") return true;
  c->fail("invalid_args", "sessions: unknown or removing session");
  return false;
}

static std::string url_host(const std::string &url) {
  std::string origin = url_origin(url);
  auto start = origin.find("://");
  if (start == std::string::npos) return "";
  std::string authority = origin.substr(start + 3);
  if (!authority.empty() && authority[0] == '[') return authority.substr(0, authority.find(']') + 1);
  return authority.substr(0, authority.find(':'));
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
  ICoreWebView2CookieManager *m = cookie_manager();
  if (!m) return done({});
  m->AddRef(); // kept by the completion
  bool started = get_cookies(m, "", [m, keep, done](HRESULT, ICoreWebView2CookieList *list) {
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
    refresh_cookies();
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
  reg("sessions", "list", [](CallPtr c) { c->ok(json::array({json{{"id", "default"}, {"persistent", true}}})); });
  reg("sessions", "capabilities", [](CallPtr c) {
    c->ok(json{{"private", false}, {"persistentNamed", false}, {"proxy", false}, {"proxyAuthentication", false}, {"pac", false}, {"customBypass", false}});
  });
  reg("sessions", "getProxy", [](CallPtr c) {
    if (default_session(c)) c->ok(nullptr);
  });
  reg("sessions", "watchCookies", [](CallPtr c) {
    if (c->flag("enabled", true)) g_watchers.insert(c->caller);
    else g_watchers.erase(c->caller);
    if (g_watchers.empty() || g_timer) return c->ok();
    g_timer = true;
    // The first comparison is against what's there now, not against nothing.
    g_has_snapshot = false;
    poll_cookies();
    c->ok();
  });
  reg("sessions", "cookiesGet", [](CallPtr c) {
    if (!default_session(c)) return;
    std::string url, name;
    if (!filter(c, url, name)) return;
    ICoreWebView2CookieManager *m = cookie_manager();
    if (!m) return c->fail("unavailable", "sessions: no web view is ready yet");
    bool started = get_cookies(m, url, [c, name](HRESULT hr, ICoreWebView2CookieList *list) {
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
    if (!started) c->fail("unavailable", "cookies.get: the cookie manager refused");
  });
  reg("sessions", "cookiesSet", [](CallPtr c) {
    if (!default_session(c)) return;
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
    ICoreWebView2CookieManager *m = cookie_manager();
    if (!m) return c->fail("unavailable", "sessions: no web view is ready yet");
    ICoreWebView2Cookie *cookie = nullptr;
    HRESULT hr = m->CreateCookie(wide(name).c_str(), wide(value).c_str(), wide(domain).c_str(), wide(path).c_str(), &cookie);
    if (FAILED(hr) || !cookie) {
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
      m->Release();
      return c->fail("unavailable", "cookies.set: " + hresult_message(hr));
    }
    // Answered once it reads back, like the WebKit side.
    bool expired = c->has("expires") && expires <= (double)time(nullptr);
    bool started = get_cookies(m, url, [c, name, value, path, expired](HRESULT, ICoreWebView2CookieList *list) {
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
      refresh_cookies();
      found || expired ? c->ok() : c->fail("unavailable", "WebView2 did not retain the cookie");
    });
    m->Release();
    if (!started) c->fail("unavailable", "cookies.set: the cookie manager refused");
  });
  reg("sessions", "cookiesRemove", [](CallPtr c) {
    if (!default_session(c)) return;
    std::string url, name;
    if (!filter(c, url, name)) return;
    if (url.empty() || name.empty()) return c->fail("invalid_args", "cookies.remove: url and name are required");
    ICoreWebView2CookieManager *m = cookie_manager();
    if (!m) return c->fail("unavailable", "sessions: no web view is ready yet");
    m->AddRef(); // kept by the completion
    bool started = get_cookies(m, url, [c, m, name](HRESULT hr, ICoreWebView2CookieList *list) {
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
      refresh_cookies();
      FAILED(hr) ? c->fail("unavailable", "cookies.remove: " + hresult_message(hr)) : c->ok(json{{"removed", count}});
    });
    m->Release();
    if (!started) {
      m->Release();
      c->fail("unavailable", "cookies.remove: the cookie manager refused");
    }
  });
}

} // namespace sd::win
