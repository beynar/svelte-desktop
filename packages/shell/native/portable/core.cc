#include "core.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <set>
#include <thread>

#include "../include/svelte_desktop.h"
#include "../shell.h"

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace sd {

// ---------------------------------------------------------------------------
// Call

void Call::ok(const json &value) {
  if (done.exchange(true)) return;
  reply(json{{"ok", true}, {"value", value}});
}
void Call::fail(const std::string &code, const std::string &message) {
  if (done.exchange(true)) return;
  reply(json{{"ok", false}, {"error", {{"code", code}, {"message", message}}}});
}
std::string Call::str(const char *k, const std::string &f) const {
  auto it = args.find(k);
  return it != args.end() && it->is_string() ? it->get<std::string>() : f;
}
double Call::num(const char *k, double f) const {
  auto it = args.find(k);
  return it != args.end() && it->is_number() ? it->get<double>() : f;
}
bool Call::flag(const char *k, bool f) const {
  auto it = args.find(k);
  return it != args.end() && it->is_boolean() ? it->get<bool>() : f;
}
bool Call::has(const char *k) const {
  auto it = args.find(k);
  return it != args.end() && !it->is_null();
}

// ---------------------------------------------------------------------------
// Registry + dispatch (main thread)

static std::map<std::string, Handler> &handlers() {
  static std::map<std::string, Handler> h;
  return h;
}
static bool g_services_ready = false;

static void ensure_services() {
  if (g_services_ready) return;
  g_services_ready = true;
  backend_init_services();
}

void reg(const std::string &s, const std::string &op, Handler h) { handlers()[s + "." + op] = std::move(h); }
void reg_many(const std::string &s, const std::vector<std::string> &ops, Handler h) {
  for (auto &op : ops) reg(s, op, h);
}
std::vector<std::string> registered_ops() {
  std::vector<std::string> out;
  for (auto &[k, _] : handlers()) out.push_back(k);
  return out;
}

void dispatch(const json &req, int caller, std::function<void(const json &)> reply) {
  ensure_services();
  auto call = std::make_shared<Call>();
  call->service = req.value("service", "");
  call->op = req.value("op", "");
  if (req.contains("args") && req["args"].is_object()) call->args = req["args"];
  call->caller = caller;
  call->reply = std::move(reply);
  auto it = handlers().find(call->service + "." + call->op);
  if (it == handlers().end()) {
    bool known = false;
    for (auto &[k, _] : handlers())
      if (k.rfind(call->service + ".", 0) == 0) known = true;
    if (known) call->fail("unsupported", call->service + "." + call->op + " is not implemented on this platform");
    else call->fail("unknown", "unknown platform service `" + call->service + "`");
    return;
  }
  try {
    it->second(call);
  } catch (const std::exception &e) {
    call->fail("internal", e.what());
  }
}

// ---------------------------------------------------------------------------
// Events

static std::atomic<shell_event_fn> g_sink{nullptr};

void emit_raw(const json &event) {
  shell_event_fn fn = g_sink.load();
  if (!fn) return;
  std::string s = event.dump();
  char *buf = static_cast<char *>(malloc(s.size() + 1));
  memcpy(buf, s.c_str(), s.size() + 1);
  fn(buf); // receiver frees with shell_free
}

std::string deliver_js(const std::string &name, const json &data) {
  return "window.__shell&&window.__shell.deliver(" + json(name).dump() + "," + data.dump() + ")";
}

void emit(const std::string &name, const json &data) {
  auto send = [name, data] {
    emit_raw(json{{"type", "platform"}, {"name", name}, {"data", data}});
    std::string js = deliver_js(name, data);
    for (int id : backend_page_ids()) backend_eval_in_page(id, js);
  };
  if (backend_is_main_thread()) send();
  else backend_run_on_main(send);
}

// ---------------------------------------------------------------------------
// Origin + permissions

static std::mutex g_mutex;
static std::string g_origin;
static bool g_restricted = false;
static std::vector<std::string> g_rules;

std::string app_origin() {
  std::lock_guard<std::mutex> lock(g_mutex);
  return g_origin;
}

bool page_may_call(const std::string &service, const std::string &op) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_restricted) return true;
  std::string full = service + "." + op;
  for (auto &r : g_rules)
    if (r == "*" || r == full || (r.size() > 2 && r.compare(r.size() - 2, 2, ".*") == 0 && r.substr(0, r.size() - 2) == service)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Bridge

const char *const kBridgeScript =
    "(()=>{if(window.__shell)return;const q=[];let sink=null;"
    "const raw=(m)=>{const s=JSON.stringify(m);"
    "if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.__shell__)window.webkit.messageHandlers.__shell__.postMessage(s);"
    "else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(s);};"
    "window.__shell=Object.freeze({"
    "post:(req)=>raw({t:'call',req:typeof req==='string'?JSON.parse(req):req}),"
    "setSink:(fn)=>{sink=fn;for(const [n,d] of q.splice(0))fn(n,d);},"
    "deliver:(n,d)=>{sink?sink(n,d):q.push([n,d]);}});"
    "document.addEventListener('DOMContentLoaded',()=>raw({t:'ready'}));})();";

void on_bridge_message(int native_id, const std::string &body, const std::string &origin, bool main_frame) {
  json msg = json::parse(body, nullptr, false);
  if (!msg.is_object()) return;
  std::string t = msg.value("t", "");
  if (t == "ready") {
    if (main_frame) backend_page_ready(native_id);
    return;
  }
  if (t != "call" || !msg.contains("req") || !msg["req"].is_object()) return;
  json req = msg["req"];
  json id = req.contains("id") ? req["id"] : json(0);
  auto reply = [native_id, id](const json &r) {
    json out = r;
    out["id"] = id;
    std::string js = deliver_js("platformResult", out);
    if (backend_is_main_thread()) backend_eval_in_page(native_id, js);
    else backend_run_on_main([native_id, js] { backend_eval_in_page(native_id, js); });
  };
  std::string appOrigin = app_origin();
  if (!main_frame || appOrigin.empty() || origin != appOrigin)
    return reply(json{{"ok", false}, {"error", {{"code", "denied"}, {"message", "platform calls are only accepted from the app origin's main frame"}}}});
  std::string service = req.value("service", ""), op = req.value("op", "");
  if (!page_may_call(service, op))
    return reply(json{{"ok", false}, {"error", {{"code", "denied"}, {"message", service + "." + op + " is not in permissions.pages (desktop.config)"}}}});
  dispatch(req, native_id, reply);
}

// ---------------------------------------------------------------------------
// Plugin host (include/svelte_desktop.h)

struct PluginCall {
  CallPtr call;
};

static int host_register(const char *service, const char *op, sd_op_fn fn, void *user) {
  ensure_services();
  std::string key = std::string(service) + "." + op;
  if (handlers().count(key)) return -1;
  reg(service, op, [fn, user](CallPtr c) {
    auto *h = new PluginCall{c};
    std::string args = c->args.dump();
    fn(reinterpret_cast<sd_call *>(h), args.c_str(), user);
  });
  return 0;
}
static void host_resolve(sd_call *h, const char *value_json) {
  auto *p = reinterpret_cast<PluginCall *>(h);
  json v = value_json ? json::parse(value_json, nullptr, false) : json(nullptr);
  if (v.is_discarded()) v = std::string(value_json);
  backend_run_on_main([p, v] {
    p->call->ok(v);
    delete p;
  });
}
static void host_reject(sd_call *h, const char *code, const char *message) {
  auto *p = reinterpret_cast<PluginCall *>(h);
  std::string c = code ? code : "internal", m = message ? message : "";
  backend_run_on_main([p, c, m] {
    p->call->fail(c, m);
    delete p;
  });
}
static void host_emit(const char *event, const char *data_json) {
  json d = data_json ? json::parse(data_json, nullptr, false) : json::object();
  if (d.is_discarded() || !d.is_object()) d = json{{"value", d.is_discarded() ? json(data_json) : d}};
  emit(event, d);
}
static void *host_window(int wid) { return backend_native_window(backend_native_window_id(wid)); }
static void *host_webview(int wid) { return backend_native_webview(backend_native_window_id(wid)); }
static int host_caller(sd_call *h) {
  auto *p = reinterpret_cast<PluginCall *>(h);
  return p->call->caller ? backend_public_window_id(p->call->caller) : -1;
}
static void host_log(const char *m) { fprintf(stderr, "[native plugin] %s\n", m); }

static const sd_host kHost = {SD_ABI_VERSION, host_register, host_resolve, host_reject, host_emit,
                              host_window, host_webview, host_caller, host_log};

} // namespace sd

// ---------------------------------------------------------------------------
// C exports shared by the portable backends

using sd::json;

extern "C" {
SHELL_API int shell_abi_version(void) { return 2; }
SHELL_API void shell_set_event_sink(shell_event_fn fn) { sd::g_sink.store(fn); }
SHELL_API void shell_free(void *p) { free(p); }

SHELL_API int shell_set_app_origin(const char *origin) {
  std::lock_guard<std::mutex> lock(sd::g_mutex);
  sd::g_origin = origin ? origin : "";
  return 0;
}

SHELL_API int shell_set_page_permissions(const char *rules_json) {
  json rules = rules_json ? json::parse(rules_json, nullptr, false) : json(nullptr);
  std::lock_guard<std::mutex> lock(sd::g_mutex);
  sd::g_restricted = rules.is_array();
  sd::g_rules.clear();
  if (rules.is_array())
    for (auto &r : rules)
      if (r.is_string()) sd::g_rules.push_back(r.get<std::string>());
  return 0;
}

SHELL_API int shell_platform_call(const char *request_json) {
  if (!request_json) return -3;
  json req = json::parse(request_json, nullptr, false);
  if (!req.is_object()) return -3;
  sd::backend_run_on_main([req] {
    json id = req.contains("id") ? req["id"] : json(0);
    sd::dispatch(req, 0, [id](const json &r) {
      json out = r;
      out["type"] = "platformResult";
      out["id"] = id;
      sd::emit_raw(out);
    });
  });
  return 0;
}

SHELL_API int shell_load_plugin(const char *path) {
  if (!sd::backend_is_main_thread()) return -2;
  sd::ensure_services();
#if defined(_WIN32)
  // UTF-8 path → UTF-16: LoadLibraryA would fail on non-ASCII paths (e.g. accented user names).
  int n = MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
  std::wstring wide(n > 0 ? n : 1, L'\0');
  if (n > 0) MultiByteToWideChar(CP_UTF8, 0, path, -1, wide.data(), n);
  HMODULE h = LoadLibraryW(wide.c_str());
  if (!h) return -1;
  auto init = reinterpret_cast<sd_plugin_init_fn>(GetProcAddress(h, "sd_plugin_init"));
#else
  void *h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!h) {
    fprintf(stderr, "[shell] native plugin: %s\n", dlerror());
    return -1;
  }
  auto init = reinterpret_cast<sd_plugin_init_fn>(dlsym(h, "sd_plugin_init"));
#endif
  if (!init) return -3;
  return init(&sd::kHost);
}
}
