// webview.* policy, server-owned as in native/platform_web_policy.mm and platform_web_content.mm:
//   configurePolicy (kind permission) · respondPolicy · list/set/revokePermissionDecision
//   setNavigationPolicy · navigationDecision · _permissionPolicyForTesting
// Requests go to the Worker only (emit_raw), never to page listeners. Permission events are held
// with a deferral until the answer or the deadline; navigations, which have none, by a bounded wait.
// Not here (unsupported): kind `auth`, certificates and client identities.
#include "win.hpp"

namespace sd::win {

static bool g_permission_handler = false;
static UINT g_permission_timeout = 15000;
static std::map<std::string, std::function<void(const json &)>> g_pending;
static int g_next_request = 1;

static bool server_only(const CallPtr &c) {
  if (!c->caller) return true;
  c->fail("denied", "Web policy is owned by server code, not pages");
  return false;
}

static std::string next_request_id() { return "policy-" + std::to_string(g_next_request++); }

static std::string http_origin(const std::string &url) {
  std::string scheme = url_scheme(url);
  return scheme == "http" || scheme == "https" ? url_origin(url) : "";
}

static std::string view_url(View *v) {
  LPWSTR source = nullptr;
  if (!v || !v->webview) return "";
  v->webview->get_Source(&source);
  std::string out = utf8(source);
  if (source) CoTaskMemFree(source);
  return out;
}

static bool known_permission(const std::string &p) {
  return p == "camera" || p == "microphone" || p == "location" || p == "speech" || p == "screenRecording";
}
static bool known_decision(const std::string &d) { return d == "allow" || d == "deny" || d == "prompt"; }

// ---------------------------------------------------------------------------
// Saved decisions: app-owned, across launches

static json &decisions() {
  static json saved = read_json_file(local_file("web-permissions.json"), json::object());
  if (!saved.is_object()) saved = json::object();
  return saved;
}
static std::string decision_key(const std::string &origin, const std::string &permission) { return origin + "\n" + permission; }

static void request_policy(const json &data, std::function<void(const json &)> done) {
  if (g_pending.size() >= 256) return done(nullptr);
  std::string ident = next_request_id();
  g_pending[ident] = std::move(done);
  json d = data;
  d["requestId"] = ident;
  emit_raw(json{{"type", "platform"}, {"name", "webPermissionRequest"}, {"data", d}});
  run_after(g_permission_timeout, [ident] {
    auto it = g_pending.find(ident);
    if (it == g_pending.end()) return;
    auto cb = std::move(it->second);
    g_pending.erase(it);
    cb(nullptr);
  });
}

static void permission_policy(View *v, const std::string &site, const json &frame, const std::string &permission,
                              std::function<void(const std::string &)> done) {
  if (site.empty() || !v) return done("deny");
  const json &saved = decisions();
  auto it = saved.find(decision_key(site, permission));
  if (it != saved.end()) {
    std::string decision = jstr(*it, "decision");
    if (known_decision(decision)) return done(decision);
  }
  if (!g_permission_handler) return done(site == app_origin() ? "allow" : "deny");
  json d = view_source(v);
  d["origin"] = site;
  d["permission"] = permission;
  d["frame"] = frame;
  int id = v->id;
  std::string navigation = view_url(v);
  request_policy(d, [id, navigation, done](const json &answer) {
    // A handler answers for the page that asked: not for what the view shows since.
    View *now = find_view(id);
    bool valid = now && view_url(now) == navigation && answer.is_string() && known_decision(answer.get<std::string>());
    done(valid ? answer.get<std::string>() : "deny");
  });
}

static std::string permission_name(COREWEBVIEW2_PERMISSION_KIND kind) {
  switch (kind) {
    case COREWEBVIEW2_PERMISSION_KIND_CAMERA: return "camera";
    case COREWEBVIEW2_PERMISSION_KIND_MICROPHONE: return "microphone";
    case COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION: return "location";
    default: return "";
  }
}

void web_permission_requested(View *v, ICoreWebView2PermissionRequestedEventArgs *args) {
  LPWSTR uri = nullptr;
  args->get_Uri(&uri);
  std::string url = utf8(uri);
  if (uri) CoTaskMemFree(uri);
  std::string site = http_origin(url);
  // WebView2 saves an answer in the profile and stops asking: a revoked decision, or the next
  // handler, would never hear of this origin again.
  if (auto *a3 = query<ICoreWebView2PermissionRequestedEventArgs3>(args, IID_ICoreWebView2PermissionRequestedEventArgs3)) {
    a3->put_SavesInProfile(FALSE);
    a3->Release();
  }
  COREWEBVIEW2_PERMISSION_KIND kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
  args->get_PermissionKind(&kind);
  std::string name = permission_name(kind);
  bool app = !site.empty() && site == app_origin();
  if (name.empty()) {
    // No WebPermission name: the app's own pages only, as before; the rest keeps WebView2's prompt.
    if (kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ || kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS)
      args->put_State(app ? COREWEBVIEW2_PERMISSION_STATE_ALLOW : COREWEBVIEW2_PERMISSION_STATE_DENY);
    else if (kind == COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS && app)
      args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
    return;
  }
  ICoreWebView2Deferral *deferral = nullptr;
  if (FAILED(args->GetDeferral(&deferral)) || !deferral) {
    args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
    return;
  }
  args->AddRef();
  // The event names the requesting origin, not its frame: `frame` stays null.
  permission_policy(v, site, nullptr, name, [args, deferral](const std::string &decision) {
    args->put_State(decision == "allow" ? COREWEBVIEW2_PERMISSION_STATE_ALLOW
                    : decision == "deny" ? COREWEBVIEW2_PERMISSION_STATE_DENY
                                         : COREWEBVIEW2_PERMISSION_STATE_DEFAULT);
    deferral->Complete();
    deferral->Release();
    args->Release();
  });
}

void web_screen_capture_starting(View *v, ICoreWebView2ScreenCaptureStartingEventArgs *args) {
  std::string url;
  json frame = nullptr;
  ICoreWebView2FrameInfo *info = nullptr;
  if (SUCCEEDED(args->get_OriginalSourceFrameInfo(&info)) && info) {
    LPWSTR source = nullptr;
    info->get_Source(&source);
    url = utf8(source);
    if (source) CoTaskMemFree(source);
    info->Release();
  }
  std::string site = http_origin(url);
  if (!site.empty()) frame = json{{"origin", site}, {"url", url}, {"main", url == view_url(v)}};
  ICoreWebView2Deferral *deferral = nullptr;
  if (FAILED(args->GetDeferral(&deferral)) || !deferral) {
    args->put_Cancel(TRUE);
    return;
  }
  args->AddRef();
  permission_policy(v, site, frame, "screenRecording", [args, deferral](const std::string &decision) {
    if (decision == "deny") args->put_Cancel(TRUE);
    deferral->Complete();
    deferral->Release();
    args->Release();
  });
}

// ---------------------------------------------------------------------------
// Navigation policy: a veto on what views load, after the shell's own checks

static bool g_navigation_policy = false;
static std::map<std::string, std::function<void(bool)>> g_navigations;

void web_navigation_policy(View *v, const std::string &url, bool main_frame, ICoreWebView2NavigationStartingEventArgs *args) {
  // An app policy cannot sever its own origin or its bridge.
  if (!g_navigation_policy || (!app_origin().empty() && url_origin(url) == app_origin())) return;
  std::string ident = next_request_id();
  bool answered = false, allow = false, quit = false;
  g_navigations[ident] = [&](bool a) {
    answered = true;
    allow = a;
  };
  emit_raw(json{{"type", "platform"},
                {"name", "webContentNavigation"},
                {"data", {{"requestId", ident}, {"url", url}, {"isMainFrame", main_frame}, {"viewId", v->browserView}}}});
  // NavigationStarting has no deferral, and cancelling to navigate again would lose a POST and can't
  // reach a frame: the answer is awaited here. The Worker's reply comes through the run queue;
  // WebView2 holds its own callbacks until this returns, so nothing re-enters, and a policy that
  // waits on the web view runs into the deadline.
  const ULONGLONG deadline = GetTickCount64() + 10000;
  while (!answered && !quit) {
    ULONGLONG now = GetTickCount64();
    if (now >= deadline) break;
    MsgWaitForMultipleObjectsEx(0, nullptr, (DWORD)(deadline - now), QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    MSG msg;
    while (!answered && PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) { // for the real loop
        PostQuitMessage((int)msg.wParam);
        quit = true;
        break;
      }
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
  }
  g_navigations.erase(ident);
  if (!allow) args->put_Cancel(TRUE);
}

// ---------------------------------------------------------------------------

void register_web_policy() {
  reg("webview", "configurePolicy", [](CallPtr c) {
    if (!server_only(c)) return;
    std::string kind = c->str("kind");
    if (kind == "auth") return c->fail("unsupported", "webview.configurePolicy: authentication challenges are not implemented on Windows");
    if (kind != "permission") return c->fail("invalid_args", "Unknown policy kind");
    double ms = c->num("timeoutMs", 15000);
    if (!(ms >= 50 && ms <= 30000)) return c->fail("invalid_args", "timeoutMs must be 50–30000");
    g_permission_timeout = (UINT)ms;
    g_permission_handler = c->flag("enabled", false);
    c->ok();
  });
  reg("webview", "respondPolicy", [](CallPtr c) {
    if (!server_only(c)) return;
    auto it = g_pending.find(c->str("requestId"));
    if (it == g_pending.end()) return c->fail("unavailable", "Policy request expired or was already answered");
    auto cb = std::move(it->second);
    g_pending.erase(it);
    cb(c->args.contains("answer") ? c->args["answer"] : json(nullptr));
    c->ok();
  });
  reg("webview", "listPermissionDecisions", [](CallPtr c) {
    if (!server_only(c)) return;
    json out = json::array();
    for (auto &[key, record] : decisions().items()) out.push_back(record);
    c->ok(out);
  });
  reg_many("webview", {"setPermissionDecision", "revokePermissionDecision"}, [](CallPtr c) {
    if (!server_only(c)) return;
    std::string site = http_origin(c->str("origin")), permission = c->str("permission");
    if (site.empty() || !known_permission(permission)) return c->fail("invalid_args", "An HTTP(S) origin and web permission are required");
    std::string key = decision_key(site, permission);
    if (c->op == "revokePermissionDecision") decisions().erase(key);
    else {
      std::string decision = c->str("decision");
      if (!known_decision(decision)) return c->fail("invalid_args", "Expected allow, deny or prompt");
      decisions()[key] = json{{"origin", site}, {"permission", permission}, {"decision", decision}};
    }
    write_json_file(local_file("web-permissions.json"), decisions());
    c->ok();
  });
  // What a request from the target's page would get, without one (the test channel only).
  reg("webview", "_permissionPolicyForTesting", [](CallPtr c) {
    wchar_t flag[8];
    if (!GetEnvironmentVariableW(L"KITOP_TEST", flag, 8)) return c->fail("denied", "Only available to the test channel");
    std::string permission = c->str("permission");
    if (!known_permission(permission)) return c->fail("invalid_args", "Expected a web permission");
    View *v = view_for_call(c);
    if (!v) return;
    permission_policy(v, http_origin(view_url(v)), nullptr, permission, [c](const std::string &decision) { c->ok(decision); });
  });
  reg("webview", "setNavigationPolicy", [](CallPtr c) {
    if (c->caller) return c->fail("denied", "this operation belongs to server code");
    g_navigation_policy = c->flag("enabled", false);
    auto pending = std::move(g_navigations);
    g_navigations.clear();
    for (auto &[ident, done] : pending) done(false);
    c->ok();
  });
  reg("webview", "navigationDecision", [](CallPtr c) {
    if (c->caller) return c->fail("denied", "this operation belongs to server code");
    auto it = g_navigations.find(c->str("requestId"));
    if (it == g_navigations.end()) return c->fail("unavailable", "navigation decision expired");
    auto done = std::move(it->second);
    g_navigations.erase(it);
    done(c->flag("allow", false));
    c->ok();
  });
}

} // namespace sd::win
