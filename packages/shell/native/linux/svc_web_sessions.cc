// Website profiles, request schemes, content rules, scripts and input policy on WebKitGTK, same ops
// and events as native/platform_sessions.mm, platform_web_content.mm and platform_input.mm:
//   sessions.capabilities · list · create · remove · setProxy · getProxy
//   sessions.cookiesGet · cookiesSet · cookiesRemove · watchCookies
//   protocol.response · data · finish · fail
//   webview.setContentRules · removeContentRules · listContentRules
//   webview.registerScript · unregisterScript · listScripts
//   webview.setInputPolicy · getInputPolicy
// Events: sessionCookieChanged, beforeInput; protocolRequest and protocolCancel (Worker only).
//
// A session is a WebKitWebContext around its own WebKitWebsiteDataManager: a web view chooses it when
// it's made, and each context has its own registered schemes and download signal. Files, under
// <XDG_DATA_HOME>/<identifier>: cookies.sqlite (default session), sessions/<sha256 of the id>/ (a
// persistent session), content-rules/ (only while a rule list compiles, as on macOS).
//
// Where WebKitGTK differs:
// - The cookie manager's `changed` signal reports what pages and servers do, so nothing is polled:
//   watchCookies has nothing to turn on.
// - A plain HTTP proxy gets the request itself for http:// URLs (GET http://host/), not a CONNECT. Over
//   TLS, and for https:// URLs, it's a CONNECT as on macOS.
// - WebKit passes on a scheme response with its first bytes or its end, not with protocol.response. It
//   only says a request stopped when it was reading its body: one stopped before it was answered
//   gets no protocolCancel, and what the handler sends is read and dropped.
// - "meta" in an input policy is the Super key, and `keyCode` an X11 or Wayland hardware key code.
#include <libsoup/soup.h>

#include <algorithm>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <set>
#include <glib/gstdio.h>

#include "linux.hpp"

namespace sd {
namespace lx {

static const char *const kGateCookie = "__kitop"; // src/gate.ts SESSION_COOKIE: the shell's, never exported

static void run_after(guint ms, std::function<void()> fn) {
  g_timeout_add_full(G_PRIORITY_DEFAULT, ms, [](gpointer d) -> gboolean {
    (*static_cast<std::function<void()> *>(d))();
    return G_SOURCE_REMOVE;
  }, new std::function<void()>(std::move(fn)), [](gpointer d) { delete static_cast<std::function<void()> *>(d); });
}

static std::string lower(std::string s) {
  for (auto &ch : s) ch = (char)g_ascii_tolower(ch);
  return s;
}
static bool has_any(const std::string &s, const char *chars) { return s.find_first_of(chars) != std::string::npos; }
static std::string data_dir() { return std::string(g_get_user_data_dir()) + "/" + app_identifier(); }

// Requests and cancellation tokens never go to untrusted page listeners.
static void worker_event(const char *name, const json &data) { emit_raw(json{{"type", "platform"}, {"name", name}, {"data", data}}); }

static bool worker_call(const CallPtr &c) {
  if (!c->caller) return true;
  c->fail("denied", "this operation belongs to server code");
  return false;
}

static void register_schemes(WebKitWebContext *context); // protocols, below

// ===========================================================================
// Sessions

struct Session : std::enable_shared_from_this<Session> {
  std::string id;
  bool persistent = false, owned = false;
  WebKitWebContext *context = nullptr;
  WebKitWebsiteDataManager *manager = nullptr;
  WebKitCookieManager *cookies = nullptr;
  std::string dataDir, cacheDir;
  json proxy; // what getProxy answers, null: system defaults
  std::map<std::string, json> snapshot;
  bool hasSnapshot = false, reading = false, dirty = false, removing = false;
  gulong changedHandler = 0;
  int pending = 0;
  ~Session() {
    if (!owned) return;
    g_object_unref(context);
    g_object_unref(manager);
  }
};
using SessionPtr = std::shared_ptr<Session>;
static std::map<std::string, SessionPtr> g_sessions;

static json cookie_json(SoupCookie *c) {
  GDateTime *expires = soup_cookie_get_expires(c);
  json d{{"name", soup_cookie_get_name(c)}, {"value", soup_cookie_get_value(c)}, {"domain", soup_cookie_get_domain(c)}, {"path", soup_cookie_get_path(c)},
         {"secure", (bool)soup_cookie_get_secure(c)}, {"httpOnly", (bool)soup_cookie_get_http_only(c)}, {"sessionOnly", expires == nullptr}};
  if (expires) d["expires"] = (double)g_date_time_to_unix(expires);
  switch (soup_cookie_get_same_site_policy(c)) {
  case SOUP_SAME_SITE_POLICY_NONE: d["sameSite"] = "None"; break;
  case SOUP_SAME_SITE_POLICY_LAX: d["sameSite"] = "Lax"; break;
  case SOUP_SAME_SITE_POLICY_STRICT: d["sameSite"] = "Strict"; break;
  }
  return d;
}

using CookiesFn = std::function<void(GList *, GError *)>;
static void all_cookies(const SessionPtr &s, CookiesFn done) {
  struct Ctx {
    SessionPtr s;
    CookiesFn done;
  };
  webkit_cookie_manager_get_all_cookies(s->cookies, nullptr, [](GObject *, GAsyncResult *res, gpointer data) {
    auto *x = static_cast<Ctx *>(data);
    GError *err = nullptr;
    GList *list = webkit_cookie_manager_get_all_cookies_finish(x->s->cookies, res, &err);
    x->done(list, err);
    g_list_free_full(list, (GDestroyNotify)soup_cookie_free);
    if (err) g_error_free(err);
    delete x;
  }, new Ctx{s, std::move(done)});
}

static void add_cookie(const SessionPtr &s, SoupCookie *cookie, std::function<void(GError *)> done) {
  struct Ctx {
    SessionPtr s;
    std::function<void(GError *)> done;
  };
  webkit_cookie_manager_add_cookie(s->cookies, cookie, nullptr, [](GObject *, GAsyncResult *res, gpointer data) {
    auto *x = static_cast<Ctx *>(data);
    GError *err = nullptr;
    webkit_cookie_manager_add_cookie_finish(x->s->cookies, res, &err);
    x->done(err);
    if (err) g_error_free(err);
    delete x;
  }, new Ctx{s, std::move(done)});
}

static std::string cookie_key(SoupCookie *c) { return std::string(soup_cookie_get_domain(c)) + "\n" + soup_cookie_get_path(c) + "\n" + soup_cookie_get_name(c); }

static std::map<std::string, json> exported(GList *list) {
  std::map<std::string, json> out;
  for (GList *l = list; l; l = l->next) {
    auto *c = static_cast<SoupCookie *>(l->data);
    if (strcmp(soup_cookie_get_name(c), kGateCookie) != 0) out[cookie_key(c)] = cookie_json(c); // nor in events
  }
  return out;
}

static void refresh(const SessionPtr &s) {
  if (s->removing) return;
  if (s->reading) {
    s->dirty = true;
    return;
  }
  s->reading = true;
  all_cookies(s, [s](GList *list, GError *err) {
    s->reading = false;
    if (s->removing) {
      s->dirty = false;
      return;
    }
    if (!err) {
      auto next = exported(list);
      if (s->hasSnapshot) {
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
    if (s->dirty) {
      s->dirty = false;
      refresh(s);
    }
  });
}

static void on_cookies_changed(WebKitCookieManager *, gpointer data) { refresh(static_cast<Session *>(data)->shared_from_this()); }

static void observe(const SessionPtr &s) { s->changedHandler = g_signal_connect(s->cookies, "changed", G_CALLBACK(on_cookies_changed), s.get()); }

static void ensure_sessions() {
  if (!g_sessions.empty()) return;
  auto s = std::make_shared<Session>();
  s->id = "default";
  s->persistent = true;
  s->context = webkit_web_context_get_default();
  s->manager = webkit_web_context_get_website_data_manager(s->context);
  s->cookies = webkit_website_data_manager_get_cookie_manager(s->manager);
  // WebKitGTK keeps cookies in memory unless it's given a file. Session cookies stay there anyway.
  std::string dir = data_dir();
  g_mkdir_with_parents(dir.c_str(), 0700);
  webkit_cookie_manager_set_persistent_storage(s->cookies, (dir + "/cookies.sqlite").c_str(), WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE);
  g_sessions["default"] = s;
  register_schemes(s->context);
  observe(s);
}

static SessionPtr session_named(const std::string &ident) {
  ensure_sessions();
  auto it = g_sessions.find(ident.empty() ? "default" : ident);
  return it == g_sessions.end() || it->second->removing ? nullptr : it->second;
}

WebKitWebContext *session_context(const json &options, bool *valid) {
  auto it = options.find("session");
  *valid = true;
  if (it == options.end() || it->is_null()) return session_named("")->context;
  SessionPtr s = it->is_string() ? session_named(it->get<std::string>()) : nullptr;
  *valid = s != nullptr;
  return s ? s->context : nullptr;
}

json session_of(WebKitWebView *wv) {
  WebKitWebContext *context = webkit_web_view_get_context(wv);
  for (auto &[ident, s] : g_sessions)
    if (ident != "default" && s->context == context) return ident;
  return nullptr;
}

// The app's server only answers its own session cookie, which is the default session's: a named one
// gets a copy, and nothing else. It's copied before each load: the server may have restarted since.
static void provision(const SessionPtr &s, std::function<void(const std::string &)> done) {
  if (getenv("KITOP_DEV")) return done(""); // Vite serves dev pages directly, without the loopback gate
  GUri *uri = g_uri_parse(app_origin().c_str(), G_URI_FLAGS_NONE, nullptr);
  std::string host = uri && g_uri_get_host(uri) ? g_uri_get_host(uri) : "";
  if (uri) g_uri_unref(uri);
  all_cookies(g_sessions["default"], [s, host, done](GList *list, GError *) {
    SoupCookie *gate = nullptr;
    for (GList *l = list; l && !gate; l = l->next) {
      auto *c = static_cast<SoupCookie *>(l->data);
      if (!strcmp(soup_cookie_get_name(c), kGateCookie) && host == soup_cookie_get_domain(c)) gate = c;
    }
    if (!gate) return done("App authentication is not ready");
    std::string key = cookie_key(gate), value = soup_cookie_get_value(gate);
    add_cookie(s, gate, [s, key, value, done](GError *) {
      all_cookies(s, [key, value, done](GList *stored, GError *) {
        for (GList *l = stored; l; l = l->next) {
          auto *c = static_cast<SoupCookie *>(l->data);
          if (cookie_key(c) == key && value == soup_cookie_get_value(c)) return done("");
        }
        done("WebKit did not retain the app authentication cookie");
      });
    });
  });
}

static void load_as(WebKitWebView *wv, const std::string &url, const std::string &view) {
  if (view.empty()) return webkit_web_view_load_uri(wv, url.c_str());
  WebKitURIRequest *request = webkit_uri_request_new(url.c_str());
  soup_message_headers_replace(webkit_uri_request_get_http_headers(request), "X-Desktop-View", view.c_str());
  webkit_web_view_load_request(wv, request);
  g_object_unref(request);
}

void session_load(WebKitWebView *wv, const std::string &url, const std::string &view) {
  SessionPtr s;
  WebKitWebContext *context = webkit_web_view_get_context(wv);
  for (auto &[ident, x] : g_sessions)
    if (ident != "default" && x->context == context) s = x;
  std::string origin = app_origin();
  bool app = !origin.empty() && url.rfind(origin + "/", 0) == 0 && url.rfind(origin + "/__desktop/auth", 0) != 0;
  if (!s || !app) return load_as(wv, url, view);
  s->pending++;
  g_object_ref(wv);
  provision(s, [s, wv, url, view](const std::string &error) {
    s->pending--;
    int id = 0;
    for (int page : backend_page_ids())
      if (webview_for(page) == wv) id = page;
    if (id && error.empty()) load_as(wv, url, view);
    else if (id) {
      json d = source_of(id);
      d.update(json{{"type", "failed"}, {"navigationId", nullptr}, {"url", url}, {"domain", "KitopSessionErrorDomain"}, {"code", 1}, {"message", error}, {"provisional", true}});
      emit("webviewLifecycle", d);
    }
    g_object_unref(wv);
  });
}

static SessionPtr resolve_session(const CallPtr &c) {
  ensure_sessions();
  SessionPtr s = !c->has("session") ? session_named("") : c->args["session"].is_string() ? session_named(c->str("session")) : nullptr;
  if (!s) c->fail("invalid_args", "sessions: unknown or removing session");
  return s;
}

static json describe(const SessionPtr &s) { return json{{"id", s->id}, {"persistent", s->persistent}}; }

static std::string hashed(const std::string &ident) {
  gchar *hash = g_compute_checksum_for_string(G_CHECKSUM_SHA256, ident.c_str(), -1);
  std::string out = hash;
  g_free(hash);
  return out;
}

static void remove_tree(const std::string &path) {
  if (GDir *dir = g_dir_open(path.c_str(), 0, nullptr)) {
    while (const char *name = g_dir_read_name(dir)) remove_tree(path + "/" + name);
    g_dir_close(dir);
    g_rmdir(path.c_str());
  } else g_remove(path.c_str());
}

static void make_session(CallPtr c) {
  std::string ident = c->str("id");
  ensure_sessions();
  if (ident.empty() || ident == "default" || g_sessions.count(ident) || g_utf8_strlen(ident.c_str(), -1) > 200 || !c->has("persistent") || !c->args["persistent"].is_boolean())
    return c->fail("invalid_args", "sessions.create: a unique non-default id and boolean persistent are required");
  auto s = std::make_shared<Session>();
  s->id = ident;
  s->owned = true;
  s->persistent = c->flag("persistent", false);
  if (s->persistent) {
    std::string name = "/sessions/" + hashed(app_identifier() + "/" + ident);
    s->dataDir = data_dir() + name;
    s->cacheDir = std::string(g_get_user_cache_dir()) + "/" + app_identifier() + name;
    g_mkdir_with_parents(s->dataDir.c_str(), 0700);
    s->manager = webkit_website_data_manager_new("base-data-directory", s->dataDir.c_str(), "base-cache-directory", s->cacheDir.c_str(), nullptr);
  } else s->manager = webkit_website_data_manager_new_ephemeral();
  s->context = webkit_web_context_new_with_website_data_manager(s->manager);
  s->cookies = webkit_website_data_manager_get_cookie_manager(s->manager);
  if (s->persistent) webkit_cookie_manager_set_persistent_storage(s->cookies, (s->dataDir + "/cookies.sqlite").c_str(), WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE);
  register_schemes(s->context);
  // The id is reserved while it starts: no view can use a store without the app's cookie.
  s->removing = true;
  g_sessions[ident] = s;
  provision(s, [c, s](const std::string &error) {
    if (!error.empty()) {
      g_sessions.erase(s->id);
      return c->fail("unavailable", error);
    }
    all_cookies(s, [c, s](GList *list, GError *) {
      s->snapshot = exported(list);
      s->hasSnapshot = true;
      s->removing = false;
      observe(s);
      c->ok(describe(s));
    });
  });
}

static void drop_session(CallPtr c) {
  SessionPtr s = resolve_session(c);
  if (!s) return;
  if (s->id == "default") return c->fail("denied", "The default session belongs to the shell");
  if (s->pending) return c->fail("unavailable", "sessions.remove: cookie operations are still pending");
  for (int id : backend_page_ids())
    if (WebKitWebView *wv = webview_for(id); wv && webkit_web_view_get_context(wv) == s->context)
      return c->fail("unavailable", "sessions.remove: destroy the session's windows, views and popovers first");
  s->removing = true;
  g_signal_handler_disconnect(s->cookies, s->changedHandler);
  struct Ctx {
    CallPtr c;
    SessionPtr s;
  };
  webkit_website_data_manager_clear(s->manager, WEBKIT_WEBSITE_DATA_ALL, 0, nullptr, [](GObject *, GAsyncResult *res, gpointer data) {
    auto *x = static_cast<Ctx *>(data);
    GError *err = nullptr;
    if (!webkit_website_data_manager_clear_finish(x->s->manager, res, &err)) {
      x->s->removing = false;
      observe(x->s);
      x->c->fail("unavailable", err ? err->message : "could not clear the session's data");
      if (err) g_error_free(err);
    } else {
      if (x->s->persistent) {
        remove_tree(x->s->dataDir);
        remove_tree(x->s->cacheDir);
      }
      g_sessions.erase(x->s->id);
      x->c->ok();
    }
    delete x;
  }, new Ctx{c, s});
}

// ---- proxies ----------------------------------------------------------------

static void set_proxy(CallPtr c) {
  SessionPtr s = resolve_session(c);
  if (!s) return;
  auto it = c->args.find("proxy");
  if (it != c->args.end() && it->is_null()) {
    webkit_website_data_manager_set_network_proxy_settings(s->manager, WEBKIT_NETWORK_PROXY_MODE_DEFAULT, nullptr);
    s->proxy = nullptr;
    return c->ok();
  }
  if (it == c->args.end() || !it->is_object()) return c->fail("invalid_args", "sessions.setProxy: proxy configuration or null is required");
  const json &p = *it;
  for (auto &[key, value] : p.items())
    if (key != "type" && key != "host" && key != "port" && key != "username" && key != "password" && key != "tls")
      return c->fail("unsupported", "Proxy PAC, bypass and other options are unsupported");
  std::string type = p.contains("type") && p["type"].is_string() ? p["type"].get<std::string>() : "";
  std::string host = p.contains("host") && p["host"].is_string() ? p["host"].get<std::string>() : "";
  double port = p.contains("port") && p["port"].is_number() ? p["port"].get<double>() : 0;
  // It ends up in a URI: nothing but what a host is made of, or `a@b/` would be another host.
  bool valid_host = !host.empty() && host.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-:") == std::string::npos;
  if ((type != "http" && type != "socks") || !valid_host || port != (int)port || port < 1 || port > 65535)
    return c->fail("invalid_args", "sessions.setProxy: type, host and port 1–65535 are required");
  for (const char *k : {"username", "password"})
    if (p.contains(k) && !p[k].is_string()) return c->fail("invalid_args", "Proxy credentials must be strings");
  if (p.contains("tls") && !p["tls"].is_boolean()) return c->fail("invalid_args", "Proxy tls must be boolean");
  bool tls = p.value("tls", false), user = p.contains("username");
  if ((tls && type == "socks") || (p.contains("password") && !user)) return c->fail("invalid_args", "TLS is HTTP-only; password requires username");
  std::string uri = type == "socks" ? "socks5://" : tls ? "https://" : "http://";
  if (user) {
    gchar *name = g_uri_escape_string(p["username"].get<std::string>().c_str(), nullptr, FALSE);
    uri += name;
    g_free(name);
    if (p.contains("password")) {
      gchar *secret = g_uri_escape_string(p["password"].get<std::string>().c_str(), nullptr, FALSE);
      uri += std::string(":") + secret;
      g_free(secret);
    }
    uri += "@";
  }
  uri += (host.find(':') != std::string::npos ? "[" + host + "]" : host) + ":" + std::to_string((int)port);
  // Local app traffic must stay reachable; callers cannot override this authentication boundary.
  const char *const local[] = {"127.0.0.1", "localhost", "::1", nullptr};
  WebKitNetworkProxySettings *settings = webkit_network_proxy_settings_new(uri.c_str(), local);
  webkit_website_data_manager_set_network_proxy_settings(s->manager, WEBKIT_NETWORK_PROXY_MODE_CUSTOM, settings);
  webkit_network_proxy_settings_free(settings);
  s->proxy = json{{"type", type}, {"host", host}, {"port", (int)port}, {"tls", tls}, {"authenticated", user}};
  c->ok();
}

// ---- cookies ----------------------------------------------------------------

struct CookieUrl {
  bool set = false;
  std::string scheme, host, path;
};

// URL filtering follows cookie domain, path-boundary and secure matching rules.
static bool cookie_matches_url(SoupCookie *cookie, const CookieUrl &url) {
  std::string domain = lower(soup_cookie_get_domain(cookie)), cp = soup_cookie_get_path(cookie);
  bool domainMatch = url.host == domain;
  if (domain[0] == '.') {
    domain = domain.substr(1);
    std::string suffix = "." + domain;
    domainMatch = url.host == domain || (url.host.size() > suffix.size() && url.host.compare(url.host.size() - suffix.size(), std::string::npos, suffix) == 0);
  }
  const std::string &path = url.path;
  bool pathMatch = path == cp || (path.rfind(cp, 0) == 0 && (cp.back() == '/' || (path.size() > cp.size() && path[cp.size()] == '/')));
  return domainMatch && pathMatch && (!soup_cookie_get_secure(cookie) || url.scheme == "https");
}

static bool matches(SoupCookie *cookie, const CookieUrl &url, const std::string &name) {
  std::string found = soup_cookie_get_name(cookie);
  return found != kGateCookie && (name.empty() || found == name) && (!url.set || cookie_matches_url(cookie, url));
}

static bool filter(const CallPtr &c, CookieUrl *url, std::string *name) {
  *name = c->str("name");
  if (c->has("name") && !c->args["name"].is_string()) return c->fail("invalid_args", "cookies: name must be a string"), false;
  if (c->has("url")) {
    GUri *u = g_uri_parse(c->str("url").c_str(), G_URI_FLAGS_NONE, nullptr);
    if (u) {
      url->scheme = lower(g_uri_get_scheme(u) ? g_uri_get_scheme(u) : "");
      url->host = lower(g_uri_get_host(u) ? g_uri_get_host(u) : "");
      url->path = g_uri_get_path(u) && *g_uri_get_path(u) ? g_uri_get_path(u) : "/";
      g_uri_unref(u);
    }
    if ((url->scheme != "http" && url->scheme != "https") || url->host.empty()) return c->fail("invalid_args", "cookies: an HTTP(S) URL is required"), false;
    url->set = true;
  }
  if (*name == kGateCookie) return c->fail("denied", "cookies: the shell authentication cookie is protected"), false;
  return true;
}

static void cookies_get(CallPtr c) {
  SessionPtr s = resolve_session(c);
  CookieUrl url;
  std::string name;
  if (!s || !filter(c, &url, &name)) return;
  s->pending++;
  all_cookies(s, [c, s, url, name](GList *list, GError *err) {
    s->pending--;
    if (err) return c->fail("unavailable", std::string("cookies.get: ") + err->message);
    json out = json::array();
    for (GList *l = list; l; l = l->next)
      if (matches(static_cast<SoupCookie *>(l->data), url, name)) out.push_back(cookie_json(static_cast<SoupCookie *>(l->data)));
    c->ok(out);
  });
}

static void cookies_set(CallPtr c) {
  SessionPtr s = resolve_session(c);
  CookieUrl url;
  std::string name;
  if (!s || !filter(c, &url, &name)) return;
  for (const char *key : {"domain", "path", "sameSite"})
    if (c->has(key) && !c->args[key].is_string()) return c->fail("invalid_args", "cookies.set: domain, path and sameSite must be strings");
  for (const char *key : {"secure", "httpOnly"})
    if (c->has(key) && !c->args[key].is_boolean()) return c->fail("invalid_args", "cookies.set: secure and httpOnly must be booleans");
  std::string value = c->str("value"), path = c->str("path", "/"), domain = c->str("domain", url.host);
  if (!url.set || name.empty() || !c->has("value") || !c->args["value"].is_string() || domain.empty() || path[0] != '/' || has_any(name, "=;\r\n\t ") || has_any(value, ";\r\n"))
    return c->fail("invalid_args", "cookies.set: url, name, value and a valid path/domain are required");
  std::string bare = lower(domain[0] == '.' ? domain.substr(1) : domain), suffix = "." + bare;
  bool sub = url.host.size() > suffix.size() && url.host.compare(url.host.size() - suffix.size(), std::string::npos, suffix) == 0;
  if (url.host != bare && !(domain[0] == '.' && sub)) return c->fail("invalid_args", "cookies.set: domain does not match url");
  std::string same = c->str("sameSite");
  if (!same.empty() && same != "Lax" && same != "Strict" && same != "None") return c->fail("invalid_args", "cookies.set: invalid sameSite");
  if (c->has("expires") && !c->args["expires"].is_number()) return c->fail("invalid_args", "cookies.set: expires must be seconds since epoch");
  bool secure = c->flag("secure", false);
  if ((secure && url.scheme != "https") || (same == "None" && !secure)) return c->fail("invalid_args", "cookies.set: Secure requires HTTPS; SameSite=None requires Secure");
  SoupCookie *cookie = soup_cookie_new(name.c_str(), value.c_str(), domain.c_str(), path.c_str(), -1);
  soup_cookie_set_secure(cookie, secure);
  soup_cookie_set_http_only(cookie, c->flag("httpOnly", false));
  if (!same.empty()) soup_cookie_set_same_site_policy(cookie, same == "None" ? SOUP_SAME_SITE_POLICY_NONE : same == "Strict" ? SOUP_SAME_SITE_POLICY_STRICT : SOUP_SAME_SITE_POLICY_LAX);
  bool expired = false;
  if (c->has("expires")) {
    double expires = c->num("expires");
    GDateTime *at = g_date_time_new_from_unix_utc((gint64)expires);
    if (!at) {
      soup_cookie_free(cookie);
      return c->fail("invalid_args", "cookies.set: expires must be seconds since epoch");
    }
    soup_cookie_set_expires(cookie, at);
    g_date_time_unref(at);
    expired = expires <= (double)(g_get_real_time() / G_USEC_PER_SEC);
  }
  std::string key = cookie_key(cookie);
  s->pending++;
  add_cookie(s, cookie, [c, s, key, value, expired](GError *) {
    refresh(s);
    all_cookies(s, [c, s, key, value, expired](GList *stored, GError *) {
      s->pending--;
      bool found = false;
      for (GList *l = stored; l && !found; l = l->next) {
        auto *x = static_cast<SoupCookie *>(l->data);
        found = cookie_key(x) == key && value == soup_cookie_get_value(x);
      }
      found || expired ? c->ok() : c->fail("unavailable", "WebKit did not retain the cookie");
    });
  });
  soup_cookie_free(cookie);
}

struct RemoveGroup {
  CallPtr c;
  SessionPtr s;
  int count, left;
};
static void removed_all(RemoveGroup *g) {
  g->s->pending--;
  refresh(g->s);
  g->c->ok(json{{"removed", g->count}});
  delete g;
}

static void cookies_remove(CallPtr c) {
  SessionPtr s = resolve_session(c);
  CookieUrl url;
  std::string name;
  if (!s || !filter(c, &url, &name)) return;
  if (!url.set || name.empty()) return c->fail("invalid_args", "cookies.remove: url and name are required");
  s->pending++;
  all_cookies(s, [c, s, url, name](GList *list, GError *err) {
    if (err) {
      s->pending--;
      return c->fail("unavailable", std::string("cookies.remove: ") + err->message);
    }
    std::vector<SoupCookie *> found;
    for (GList *l = list; l; l = l->next)
      if (matches(static_cast<SoupCookie *>(l->data), url, name)) found.push_back(static_cast<SoupCookie *>(l->data));
    auto *group = new RemoveGroup{c, s, (int)found.size(), (int)found.size()};
    if (found.empty()) return removed_all(group);
    for (SoupCookie *cookie : found)
      webkit_cookie_manager_delete_cookie(s->cookies, cookie, nullptr, [](GObject *, GAsyncResult *res, gpointer data) {
        auto *g = static_cast<RemoveGroup *>(data);
        webkit_cookie_manager_delete_cookie_finish(g->s->cookies, res, nullptr);
        if (!--g->left) removed_all(g);
      }, group);
  });
}

static void register_sessions() {
  reg("sessions", "create", make_session);
  reg("sessions", "remove", drop_session);
  reg("sessions", "list", [](CallPtr c) {
    ensure_sessions();
    json out = json::array();
    for (auto &[ident, s] : g_sessions)
      if (!s->removing) out.push_back(describe(s));
    c->ok(out);
  });
  reg("sessions", "capabilities", [](CallPtr c) {
    c->ok(json{{"private", true}, {"persistentNamed", true}, {"proxy", true}, {"proxyAuthentication", true}, {"pac", false}, {"customBypass", false}});
  });
  reg("sessions", "setProxy", set_proxy);
  reg("sessions", "getProxy", [](CallPtr c) {
    if (SessionPtr s = resolve_session(c)) c->ok(s->proxy);
  });
  reg("sessions", "cookiesGet", cookies_get);
  reg("sessions", "cookiesSet", cookies_set);
  reg("sessions", "cookiesRemove", cookies_remove);
  // The `changed` signal already says what pages and servers do: there's nothing to turn on.
  reg("sessions", "watchCookies", [](CallPtr c) { c->ok(); });
}

// ===========================================================================
// Custom resource schemes: requests go to the Worker, its answer streams to WebKit.

static std::vector<std::string> g_schemes;

void set_protocol_schemes(const json &input) {
  // Once at startup, before the first web view exists.
  static bool set = false;
  if (set) return;
  set = true;
  if (!input.is_array()) return;
  GRegex *pattern = g_regex_new("^[a-z][a-z0-9+.-]*$", (GRegexCompileFlags)0, (GRegexMatchFlags)0, nullptr);
  for (auto &value : input) {
    std::string name = value.is_string() ? value.get<std::string>() : "";
    bool reserved = false; // the last ones WebKitGTK itself handles or refuses to register
    for (const char *r : {"http", "https", "file", "data", "blob", "about", "javascript", "ws", "wss", "ftp", "resource", "webkit-pdfjs-viewer"}) reserved = reserved || name == r;
    if (g_regex_match(pattern, name.c_str(), (GRegexMatchFlags)0, nullptr) && !reserved && std::find(g_schemes.begin(), g_schemes.end(), name) == g_schemes.end()) g_schemes.push_back(name);
  }
  g_regex_unref(pattern);
}

bool protocol_scheme(const std::string &scheme) { return std::find(g_schemes.begin(), g_schemes.end(), scheme) != g_schemes.end(); }

// WebKit reads a response's body from a GInputStream: this one gets it from protocol.data. A chunk's
// call answers once WebKit has read it, which is what bounds the queue (protocol.ts waits for it).
struct Chunk {
  std::vector<unsigned char> bytes;
  size_t offset = 0;
  CallPtr ack;
};
struct StreamState {
  std::string id;
  std::deque<Chunk> queue;
  bool eof = false;
  GError *error = nullptr;
  GTask *reading = nullptr;
  void *buffer = nullptr;
  gsize count = 0;
  GCancellable *cancellable = nullptr;
  gulong cancelHandler = 0;
};
typedef struct {
  GInputStream parent_instance;
  StreamState *state;
} SdResourceStream;
typedef struct {
  GInputStreamClass parent_class;
} SdResourceStreamClass;
G_DEFINE_TYPE(SdResourceStream, sd_resource_stream, G_TYPE_INPUT_STREAM)

struct Resource {
  std::string id;
  WebKitURISchemeRequest *request = nullptr;
  SdResourceStream *stream = nullptr; // after protocol.response
  ~Resource() {
    g_object_unref(request);
    if (stream) g_object_unref(stream);
  }
};
static std::map<std::string, std::shared_ptr<Resource>> g_resources;
static int g_next_resource = 1;

static void pump(StreamState *st) {
  if (!st->reading || (st->queue.empty() && !st->eof && !st->error)) return;
  GTask *task = st->reading;
  st->reading = nullptr;
  if (!st->queue.empty()) {
    Chunk &chunk = st->queue.front();
    gsize n = std::min(st->count, chunk.bytes.size() - chunk.offset);
    memcpy(st->buffer, chunk.bytes.data() + chunk.offset, n);
    chunk.offset += n;
    if (chunk.offset == chunk.bytes.size()) {
      chunk.ack->ok();
      st->queue.pop_front();
    }
    g_task_return_int(task, (gssize)n);
  } else if (st->error) g_task_return_error(task, g_error_copy(st->error));
  else g_task_return_int(task, 0);
  g_object_unref(task);
}

static void stream_cancelled(GCancellable *, gpointer data) {
  auto *st = static_cast<StreamState *>(data);
  if (st->reading) {
    GTask *task = st->reading;
    st->reading = nullptr;
    g_task_return_new_error(task, G_IO_ERROR, G_IO_ERROR_CANCELLED, "cancelled");
    g_object_unref(task);
  }
  for (Chunk &chunk : st->queue) chunk.ack->fail("unavailable", "protocol task was cancelled or completed");
  st->queue.clear();
  if (g_resources.erase(st->id)) worker_event("protocolCancel", json{{"requestId", st->id}});
}

static gssize stream_read(GInputStream *, void *, gsize, GCancellable *, GError **error) {
  g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_NOT_SUPPORTED, "read asynchronously");
  return -1;
}

static void stream_read_async(GInputStream *in, void *buffer, gsize count, int, GCancellable *cancellable, GAsyncReadyCallback callback, gpointer user_data) {
  StreamState *st = ((SdResourceStream *)in)->state;
  GTask *task = g_task_new(in, cancellable, callback, user_data);
  st->reading = task;
  st->buffer = buffer;
  st->count = count;
  if (cancellable && !st->cancellable) {
    st->cancellable = G_CANCELLABLE(g_object_ref(cancellable));
    st->cancelHandler = g_signal_connect(cancellable, "cancelled", G_CALLBACK(stream_cancelled), st);
  }
  if (cancellable && g_cancellable_is_cancelled(cancellable)) stream_cancelled(cancellable, st);
  else pump(st);
}

static gssize stream_read_finish(GInputStream *, GAsyncResult *result, GError **error) { return g_task_propagate_int(G_TASK(result), error); }

static void stream_finalize(GObject *object) {
  StreamState *st = ((SdResourceStream *)object)->state;
  if (st->cancellable) {
    g_signal_handler_disconnect(st->cancellable, st->cancelHandler);
    g_object_unref(st->cancellable);
  }
  for (Chunk &chunk : st->queue) chunk.ack->fail("unavailable", "protocol task was cancelled or completed");
  g_clear_error(&st->error);
  delete st;
  G_OBJECT_CLASS(sd_resource_stream_parent_class)->finalize(object);
}

static void sd_resource_stream_class_init(SdResourceStreamClass *klass) {
  G_OBJECT_CLASS(klass)->finalize = stream_finalize;
  GInputStreamClass *in = G_INPUT_STREAM_CLASS(klass);
  in->read_fn = stream_read;
  in->read_async = stream_read_async;
  in->read_finish = stream_read_finish;
}
static void sd_resource_stream_init(SdResourceStream *self) { self->state = new StreamState; }

static void finish_with_error(Resource *r, GQuark domain, int code, const std::string &message) {
  if (r->stream) {
    StreamState *st = r->stream->state;
    g_set_error_literal(&st->error, domain, code, message.c_str());
    pump(st);
  } else {
    GError *error = g_error_new_literal(domain, code, message.c_str());
    webkit_uri_scheme_request_finish_error(r->request, error);
    g_error_free(error);
  }
}

static void send_request(const std::string &ident, WebKitURISchemeRequest *request, const std::string *body) {
  const char *method = webkit_uri_scheme_request_get_http_method(request);
  json headers = json::object();
  if (SoupMessageHeaders *h = webkit_uri_scheme_request_get_http_headers(request))
    soup_message_headers_foreach(h, [](const char *name, const char *value, gpointer data) { (*static_cast<json *>(data))[name] = value; }, &headers);
  json d{{"requestId", ident}, {"url", webkit_uri_scheme_request_get_uri(request)}, {"method", method ? method : "GET"}, {"headers", headers}};
  if (body) d["body"] = *body;
  worker_event("protocolRequest", d);
  run_after(30000, [ident] {
    auto it = g_resources.find(ident);
    if (it == g_resources.end() || it->second->stream) return;
    auto r = it->second;
    g_resources.erase(it);
    finish_with_error(r.get(), G_IO_ERROR, G_IO_ERROR_TIMED_OUT, "protocol handler did not answer");
    worker_event("protocolCancel", json{{"requestId", ident}});
  });
}

static void on_scheme_request(WebKitURISchemeRequest *request, gpointer) {
  auto r = std::make_shared<Resource>();
  r->id = "protocol-" + std::to_string(g_next_resource++);
  r->request = WEBKIT_URI_SCHEME_REQUEST(g_object_ref(request));
  g_resources[r->id] = r;
  GInputStream *body = webkit_uri_scheme_request_get_http_body(request);
  if (!body) return send_request(r->id, request, nullptr);
  GOutputStream *memory = g_memory_output_stream_new_resizable();
  g_output_stream_splice_async(memory, body, (GOutputStreamSpliceFlags)(G_OUTPUT_STREAM_SPLICE_CLOSE_SOURCE | G_OUTPUT_STREAM_SPLICE_CLOSE_TARGET), G_PRIORITY_DEFAULT, nullptr, [](GObject *source, GAsyncResult *res, gpointer data) {
    auto *x = static_cast<std::shared_ptr<Resource> *>(data);
    GError *err = nullptr;
    GOutputStream *out = G_OUTPUT_STREAM(source);
    gssize n = g_output_stream_splice_finish(out, res, &err);
    if (n < 0) {
      g_resources.erase((*x)->id);
      finish_with_error(x->get(), G_IO_ERROR, G_IO_ERROR_FAILED, err ? err->message : "could not read the request's body");
      if (err) g_error_free(err);
    } else {
      GMemoryOutputStream *memory = G_MEMORY_OUTPUT_STREAM(out);
      std::string encoded = base64_encode((const unsigned char *)g_memory_output_stream_get_data(memory), g_memory_output_stream_get_data_size(memory));
      send_request((*x)->id, (*x)->request, n ? &encoded : nullptr);
    }
    g_object_unref(out);
    delete x;
  }, new std::shared_ptr<Resource>(r));
  g_object_unref(body);
}

static void register_schemes(WebKitWebContext *context) {
  for (const std::string &scheme : g_schemes) webkit_web_context_register_uri_scheme(context, scheme.c_str(), on_scheme_request, nullptr, nullptr);
}

static std::shared_ptr<Resource> resource_of(const CallPtr &c) {
  auto it = g_resources.find(c->str("requestId"));
  if (it != g_resources.end()) return it->second;
  c->fail("unavailable", "protocol task was cancelled or completed");
  return nullptr;
}

static void register_protocol() {
  reg("protocol", "response", [](CallPtr c) {
    if (!worker_call(c)) return;
    auto r = resource_of(c);
    if (!r) return;
    int status = (int)c->num("status", 200);
    bool valid = !r->stream && status >= 200 && status <= 599 && c->has("headers") && c->args["headers"].is_object();
    if (!valid) return c->fail("invalid_args", "invalid or duplicate protocol response");
    for (auto &[key, value] : c->args["headers"].items())
      if (!value.is_string()) return c->fail("invalid_args", "invalid response headers");
    r->stream = (SdResourceStream *)g_object_new(sd_resource_stream_get_type(), nullptr);
    r->stream->state->id = r->id;
    WebKitURISchemeResponse *response = webkit_uri_scheme_response_new(G_INPUT_STREAM(r->stream), -1);
    webkit_uri_scheme_response_set_status(response, (guint)status, nullptr);
    SoupMessageHeaders *headers = soup_message_headers_new(SOUP_MESSAGE_HEADERS_RESPONSE);
    for (auto &[key, value] : c->args["headers"].items()) {
      soup_message_headers_append(headers, key.c_str(), value.get<std::string>().c_str());
      if (lower(key) == "content-type") webkit_uri_scheme_response_set_content_type(response, value.get<std::string>().c_str());
    }
    webkit_uri_scheme_response_set_http_headers(response, headers);
    webkit_uri_scheme_request_finish_with_response(r->request, response);
    g_object_unref(response);
    c->ok();
  });
  reg("protocol", "data", [](CallPtr c) {
    if (!worker_call(c)) return;
    auto r = resource_of(c);
    if (!r) return;
    std::string encoded = c->str("data");
    bool ok = true;
    std::vector<unsigned char> bytes;
    if (encoded.size() > 87384 || !c->has("data")) ok = false;
    else if (!encoded.empty()) bytes = base64_decode(encoded, &ok);
    if (!r->stream || !ok || bytes.size() > 65536) return c->fail("invalid_args", "protocol data requires response headers and at most 64 KiB");
    if (bytes.empty()) return c->ok();
    r->stream->state->queue.push_back(Chunk{std::move(bytes), 0, c});
    pump(r->stream->state);
  });
  reg("protocol", "finish", [](CallPtr c) {
    if (!worker_call(c)) return;
    auto r = resource_of(c);
    if (!r) return;
    if (!r->stream) return c->fail("invalid_args", "protocol response headers are missing");
    g_resources.erase(r->id);
    r->stream->state->eof = true;
    pump(r->stream->state);
    c->ok();
  });
  reg("protocol", "fail", [](CallPtr c) {
    if (!worker_call(c)) return;
    auto r = resource_of(c);
    if (!r) return;
    g_resources.erase(r->id);
    finish_with_error(r.get(), G_IO_ERROR, G_IO_ERROR_FAILED, c->str("message", "protocol handler failed"));
    worker_event("protocolCancel", json{{"requestId", r->id}});
    c->ok();
  });
}

// ===========================================================================
// Content rules and registered scripts: global, each web view has its own content manager.

static std::map<std::string, WebKitUserContentFilter *> g_filters;
static std::map<std::string, json> g_rule_specs; // as the app gave them: WebKit's compiled lists can't be read
static std::map<std::string, unsigned long long> g_rule_versions;
static std::map<std::string, json> g_scripts;
static std::vector<std::string> g_script_order;

static bool valid_id(const std::string &s) { return !s.empty() && g_utf8_strlen(s.c_str(), -1) <= 256; }

static std::vector<WebKitWebView *> all_views() {
  std::vector<WebKitWebView *> out;
  for (int id : backend_page_ids())
    if (WebKitWebView *wv = webview_for(id)) out.push_back(wv);
  return out;
}

static WebKitUserContentFilterStore *rule_store() {
  static WebKitUserContentFilterStore *store = webkit_user_content_filter_store_new((data_dir() + "/content-rules").c_str());
  return store;
}

// Lists are process-owned; avoid persisting a cache entry for every launch. WebKit keeps what it mapped,
// and leaves a temporary file behind when a list doesn't compile, so all of it goes once none is compiling.
static int g_compiling = 0;
static void compiled() {
  if (--g_compiling) return;
  std::string dir = data_dir() + "/content-rules";
  if (GDir *d = g_dir_open(dir.c_str(), 0, nullptr)) {
    while (const char *name = g_dir_read_name(d)) g_remove((dir + "/" + name).c_str());
    g_dir_close(d);
  }
}

static std::string escaped(const std::string &s) {
  gchar *e = g_regex_escape_string(s.c_str(), -1);
  std::string out = e;
  g_free(e);
  return out;
}

static void apply_scripts(int native_id, WebKitWebView *wv) {
  WebKitUserContentManager *ucm = webkit_web_view_get_user_content_manager(wv);
  auto *installed = static_cast<std::vector<WebKitUserScript *> *>(g_object_get_data(G_OBJECT(wv), "sd-scripts"));
  if (!installed) {
    installed = new std::vector<WebKitUserScript *>;
    g_object_set_data_full(G_OBJECT(wv), "sd-scripts", installed, [](gpointer data) {
      auto *v = static_cast<std::vector<WebKitUserScript *> *>(data);
      for (WebKitUserScript *s : *v) webkit_user_script_unref(s);
      delete v;
    });
  }
  for (WebKitUserScript *s : *installed) {
    webkit_user_content_manager_remove_script(ucm, s);
    webkit_user_script_unref(s);
  }
  installed->clear();
  json actual = source_of(native_id);
  for (const std::string &ident : g_script_order) {
    const json &spec = g_scripts[ident];
    if (spec.contains("target")) {
      bool applies = true;
      for (const char *key : {"windowId", "popoverId", "viewId"})
        if (spec["target"].contains(key) && (!actual.contains(key) || actual[key] != spec["target"][key])) applies = false;
      if (!applies) continue;
    }
    std::string source = spec["source"], world = spec["world"];
    auto frames = spec["mainFrameOnly"].get<bool>() ? WEBKIT_USER_CONTENT_INJECT_TOP_FRAME : WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES;
    auto time = spec["timing"] == "start" ? WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START : WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_END;
    WebKitUserScript *script = world == "page" ? webkit_user_script_new(source.c_str(), frames, time, nullptr, nullptr)
                                               : webkit_user_script_new_for_world(source.c_str(), frames, time, world.c_str(), nullptr, nullptr);
    webkit_user_content_manager_add_script(ucm, script);
    installed->push_back(script);
  }
}

static void apply_scripts_everywhere() {
  for (int id : backend_page_ids())
    if (WebKitWebView *wv = webview_for(id)) apply_scripts(id, wv);
}

void web_sessions_attach(int native_id, WebKitWebView *wv) {
  WebKitUserContentManager *ucm = webkit_web_view_get_user_content_manager(wv);
  for (auto &[ident, filter] : g_filters) webkit_user_content_manager_add_filter(ucm, filter);
  apply_scripts(native_id, wv);
}

static void set_content_rules(CallPtr c) {
  std::string ident = c->str("id");
  if (!valid_id(ident) || !c->has("rules") || !c->args["rules"].is_array() || c->args["rules"].empty()) return c->fail("invalid_args", "id and a nonempty rules array are required");
  std::string origin = app_origin();
  if (origin.empty()) return c->fail("unavailable", "the app origin is not ready");
  // Final exceptions protect the app document, its resources and the event WebSocket.
  // WebKit rejects alternation and interior anchors; network URLs have a canonical slash.
  std::string appFilter = "^" + escaped(origin) + "/";
  GUri *app = g_uri_parse(origin.c_str(), G_URI_FLAGS_NONE, nullptr);
  std::string bridgeFilter = "^wss?://" + escaped(app && g_uri_get_host(app) ? g_uri_get_host(app) : "") + ":" + std::to_string(app && g_uri_get_port(app) > 0 ? g_uri_get_port(app) : 80) + "/";
  if (app) g_uri_unref(app);
  json safe = json::array();
  for (const json &raw : c->args["rules"]) {
    bool valid = raw.is_object() && raw.contains("trigger") && raw["trigger"].is_object() && raw.contains("action") && raw["action"].is_object() && raw["action"].contains("type") && raw["action"]["type"].is_string();
    std::string type = valid ? raw["action"]["type"].get<std::string>() : "";
    if (type != "block" && type != "block-cookies" && type != "css-display-none" && type != "make-https" && type != "ignore-previous-rules")
      return c->fail("invalid_args", "invalid content blocker rule or unsupported action");
    if (type != "css-display-none") {
      safe.push_back(raw);
      continue;
    }
    // CSS can bypass ignore-previous-rules. Its exclusion must be in the trigger.
    // WebKit permits one domain/top/frame condition, so reject incompatible ones.
    json trigger = raw["trigger"];
    if (trigger.contains("if-domain") || trigger.contains("if-top-url") || trigger.contains("if-frame-url") || trigger.contains("unless-frame-url"))
      return c->fail("invalid_args", "css-display-none requires an app-origin exclusion; use unless-domain or unless-top-url instead of positive/frame conditions");
    bool hasTop = trigger.contains("unless-top-url"), hasDomains = trigger.contains("unless-domain");
    if ((hasTop && (!trigger["unless-top-url"].is_array() || trigger["unless-top-url"].empty())) || (hasDomains && (!trigger["unless-domain"].is_array() || trigger["unless-domain"].empty())) || (hasTop && hasDomains))
      return c->fail("invalid_args", "invalid CSS exclusion conditions");
    json excluded = hasTop ? trigger["unless-top-url"] : json::array();
    if (hasDomains)
      for (const json &value : trigger["unless-domain"]) {
        if (!value.is_string() || value.get<std::string>().empty()) return c->fail("invalid_args", "invalid CSS domain");
        std::string domain = value;
        bool ascii = true;
        for (unsigned char ch : domain) ascii = ascii && ch < 128 && !g_ascii_isupper(ch);
        if (!ascii) return c->fail("invalid_args", "CSS domains must be lowercase ASCII or punycode");
        bool subdomains = domain[0] == '*';
        if (subdomains) domain = domain.substr(1);
        // The same domain-to-top-URL conversion used by WebKit's public rule parser.
        excluded.push_back(std::string("[a-z][a-z+.-]*://") + (subdomains ? "([^/]*\\.)*" : "") + escaped(domain) + "[:/]");
      }
    trigger.erase("unless-domain");
    excluded.push_back(appFilter);
    trigger["unless-top-url"] = excluded;
    safe.push_back(json{{"trigger", trigger}, {"action", raw["action"]}});
  }
  safe.push_back(json{{"trigger", {{"url-filter", appFilter}}}, {"action", {{"type", "ignore-previous-rules"}}}});
  safe.push_back(json{{"trigger", {{"url-filter", bridgeFilter}}}, {"action", {{"type", "ignore-previous-rules"}}}});
  unsigned long long version = ++g_rule_versions[ident];
  gchar *uuid = g_uuid_string_random();
  std::string storeId = std::string("sd-") + uuid;
  g_free(uuid);
  std::string text = safe.dump();
  GBytes *source = g_bytes_new(text.data(), text.size());
  struct Ctx {
    CallPtr c;
    std::string ident;
    unsigned long long version;
  };
  g_compiling++;
  webkit_user_content_filter_store_save(rule_store(), storeId.c_str(), source, nullptr, [](GObject *, GAsyncResult *res, gpointer data) {
    auto *x = static_cast<Ctx *>(data);
    GError *err = nullptr;
    WebKitUserContentFilter *filter = webkit_user_content_filter_store_save_finish(rule_store(), res, &err);
    compiled();
    if (g_rule_versions[x->ident] != x->version) {
      if (filter) webkit_user_content_filter_unref(filter);
      x->c->fail("unavailable", "content rules were replaced during compilation");
    } else if (!filter) x->c->fail("invalid_args", err ? err->message : "WebKit could not compile content rules");
    else {
      auto previous = g_filters.find(x->ident);
      for (WebKitWebView *wv : all_views()) {
        WebKitUserContentManager *ucm = webkit_web_view_get_user_content_manager(wv);
        if (previous != g_filters.end()) webkit_user_content_manager_remove_filter(ucm, previous->second);
        webkit_user_content_manager_add_filter(ucm, filter);
      }
      if (previous != g_filters.end()) webkit_user_content_filter_unref(previous->second);
      g_filters[x->ident] = filter;
      g_rule_specs[x->ident] = x->c->args["rules"];
      x->c->ok();
    }
    if (err) g_error_free(err);
    delete x;
  }, new Ctx{c, ident, version});
  g_bytes_unref(source);
}

static void register_content() {
  reg("webview", "setContentRules", set_content_rules);
  reg("webview", "removeContentRules", [](CallPtr c) {
    std::string ident = c->str("id");
    if (!valid_id(ident)) return c->fail("invalid_args", "id is required");
    g_rule_versions[ident]++;
    auto it = g_filters.find(ident);
    if (it != g_filters.end()) {
      for (WebKitWebView *wv : all_views()) webkit_user_content_manager_remove_filter(webkit_web_view_get_user_content_manager(wv), it->second);
      webkit_user_content_filter_unref(it->second);
      g_filters.erase(it);
    }
    g_rule_specs.erase(ident);
    c->ok();
  });
  reg("webview", "listContentRules", [](CallPtr c) {
    json out = json::array();
    for (auto &[ident, rules] : g_rule_specs) out.push_back(json{{"id", ident}, {"rules", rules}});
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
    apply_scripts_everywhere();
    c->ok();
  });
  reg("webview", "unregisterScript", [](CallPtr c) {
    std::string ident = c->str("id");
    if (!valid_id(ident)) return c->fail("invalid_args", "id is required");
    g_scripts.erase(ident);
    g_script_order.erase(std::remove(g_script_order.begin(), g_script_order.end(), ident), g_script_order.end());
    apply_scripts_everywhere();
    c->ok();
  });
  reg("webview", "listScripts", [](CallPtr c) {
    json out = json::array();
    for (const std::string &ident : g_script_order) out.push_back(g_scripts[ident]);
    c->ok(out);
  });
}

// ===========================================================================
// Input policy: a handler on the window runs before GTK's own, which tries accelerators and then
// gives the key to the focused web view.

struct InputRule {
  std::string key;
  guint keyval = GDK_KEY_VoidSymbol;
  guint mask = 0;
  json modifiers;
};
struct InputPolicy {
  std::vector<InputRule> rules;
  bool menuShortcuts = true;
  std::set<guint16> down; // GDK3 doesn't mark auto-repeat
};

static const guint kInputMods = GDK_CONTROL_MASK | GDK_MOD1_MASK | GDK_SHIFT_MASK | GDK_SUPER_MASK;

static guint input_keyval(const std::string &key) {
  std::string k = lower(key);
  static const std::map<std::string, guint> names = {{"enter", GDK_KEY_Return}, {"return", GDK_KEY_Return}, {"escape", GDK_KEY_Escape}, {"tab", GDK_KEY_Tab}, {"space", GDK_KEY_space}, {"backspace", GDK_KEY_BackSpace},
                                                     {"arrowup", GDK_KEY_Up}, {"arrowdown", GDK_KEY_Down}, {"arrowleft", GDK_KEY_Left}, {"arrowright", GDK_KEY_Right}, {"delete", GDK_KEY_Delete}};
  auto it = names.find(k);
  if (it != names.end()) return it->second;
  if (g_utf8_strlen(key.c_str(), -1) == 1) return gdk_keyval_to_lower(gdk_unicode_to_keyval(g_utf8_get_char(key.c_str())));
  return gdk_keyval_from_name(key.c_str()); // F5, Home…
}

static gboolean on_window_key(GtkWidget *widget, GdkEventKey *ev, gpointer) {
  auto *policy = static_cast<InputPolicy *>(g_object_get_data(G_OBJECT(widget), "sd-input-policy"));
  bool press = ev->type == GDK_KEY_PRESS, repeat = false;
  if (press) repeat = !policy->down.insert(ev->hardware_keycode).second;
  else policy->down.erase(ev->hardware_keycode);
  guint keyval = gdk_keyval_to_lower(ev->keyval), state = ev->state;
  if (keyval == GDK_KEY_KP_Enter) keyval = GDK_KEY_Return;
  if (keyval == GDK_KEY_ISO_Left_Tab) keyval = GDK_KEY_Tab;
  GdkModifierType mods = (GdkModifierType)state;
  gdk_keymap_add_virtual_modifiers(gdk_keymap_get_for_display(gtk_widget_get_display(widget)), &mods); // Super is one of Mod2-5
  for (const InputRule &rule : policy->rules) {
    if (rule.keyval != keyval || ((guint)mods & kInputMods) != rule.mask) continue;
    int id = 0;
    for (int w : window_ids())
      if (find_window(w)->window == widget) id = w;
    json d{{"windowId", public_id(id)}, {"key", rule.key}, {"keyCode", ev->hardware_keycode}, {"type", press ? "keyDown" : "keyUp"}, {"isAutoRepeat", repeat}, {"modifiers", rule.modifiers}, {"intercepted", true}};
    emit_raw(json{{"type", "platform"}, {"name", "beforeInput"}, {"data", d}});
    for (int page : backend_page_ids()) {
      d["target"] = page == id;
      backend_eval_in_page(page, deliver_js("beforeInput", d));
    }
    return TRUE;
  }
  if (policy->menuShortcuts) return FALSE;
  // No accelerators nor mnemonics: straight to the focused widget.
  gtk_window_propagate_key_event(GTK_WINDOW(widget), ev);
  return TRUE;
}

static void register_input() {
  reg("webview", "setInputPolicy", [](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    if (!w) return c->fail("unavailable", "input policy window is not open");
    if ((c->has("intercept") && !c->args["intercept"].is_array()) || (c->has("menuShortcuts") && !c->args["menuShortcuts"].is_boolean()))
      return c->fail("invalid_args", "intercept must be an array and menuShortcuts a boolean");
    auto *next = new InputPolicy;
    next->menuShortcuts = c->flag("menuShortcuts", true);
    for (const json &rule : c->has("intercept") ? c->args["intercept"] : json::array()) {
      bool valid = rule.is_object() && rule.contains("key") && rule["key"].is_string() && !rule["key"].get<std::string>().empty() && (!rule.contains("modifiers") || rule["modifiers"].is_array());
      if (!valid) {
        delete next;
        return c->fail("invalid_args", "each input shortcut needs key and optional modifiers array");
      }
      InputRule r;
      r.key = rule["key"];
      r.keyval = input_keyval(r.key);
      r.modifiers = rule.contains("modifiers") ? rule["modifiers"] : json::array();
      for (const json &m : r.modifiers) {
        std::string name = m.is_string() ? m.get<std::string>() : "";
        if (name != "meta" && name != "control" && name != "alt" && name != "shift") {
          delete next;
          return c->fail("invalid_args", "input modifiers: meta, control, alt, shift");
        }
        r.mask |= name == "meta" ? GDK_SUPER_MASK : name == "control" ? GDK_CONTROL_MASK : name == "alt" ? GDK_MOD1_MASK : GDK_SHIFT_MASK;
      }
      next->rules.push_back(std::move(r));
    }
    if (!g_object_get_data(G_OBJECT(w->window), "sd-input-policy")) {
      g_signal_connect(w->window, "key-press-event", G_CALLBACK(on_window_key), nullptr);
      g_signal_connect(w->window, "key-release-event", G_CALLBACK(on_window_key), nullptr);
    }
    size_t count = next->rules.size();
    bool menus = next->menuShortcuts;
    g_object_set_data_full(G_OBJECT(w->window), "sd-input-policy", next, [](gpointer data) { delete static_cast<InputPolicy *>(data); });
    c->ok(json{{"monitorInstalled", true}, {"interceptCount", count}, {"menuShortcuts", menus}});
  });
  reg("webview", "getInputPolicy", [](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    if (!w) return c->fail("unavailable", "input policy window is not open");
    auto *policy = static_cast<InputPolicy *>(g_object_get_data(G_OBJECT(w->window), "sd-input-policy"));
    json rules = json::array();
    if (policy)
      for (const InputRule &rule : policy->rules) rules.push_back(json{{"key", rule.key}, {"modifiers", rule.modifiers}});
    c->ok(json{{"monitorInstalled", true}, {"intercept", rules}, {"menuShortcuts", policy ? policy->menuShortcuts : true}});
  });
}

void register_web_sessions() {
  ensure_sessions();
  // The first read is what changes compare to, and it needs the network process: not before a view.
  refresh(g_sessions["default"]);
  register_sessions();
  register_protocol();
  register_content();
  register_input();
}

} // namespace lx
} // namespace sd
