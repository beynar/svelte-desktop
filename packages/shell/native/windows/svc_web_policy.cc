// webview.* policy, server-owned as in native/platform_web_policy.mm and platform_web_content.mm:
//   configurePolicy · respondPolicy · list/set/revokePermissionDecision · allow/revokeCertificate
//   listClientIdentities · setNavigationPolicy · navigationDecision · _permissionPolicyForTesting
// Requests go to the Worker only (emit_raw), never to page listeners. Permission and authentication
// events are held with a deferral until the answer or the deadline; navigations, which have none, by
// a bounded wait.
#include "win.hpp"

#include <wincrypt.h>

#include <set>

namespace sd::win {

static bool g_permission_handler = false, g_auth_handler = false;
static UINT g_permission_timeout = 15000, g_auth_timeout = 15000;
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

static void request_policy(const char *event, const json &data, std::function<void(const json &)> done) {
  if (g_pending.size() >= 256) return done(nullptr);
  std::string ident = next_request_id();
  g_pending[ident] = std::move(done);
  json d = data;
  d["requestId"] = ident;
  emit_raw(json{{"type", "platform"}, {"name", event}, {"data", d}});
  run_after(strcmp(event, "webPermissionRequest") == 0 ? g_permission_timeout : g_auth_timeout, [ident] {
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
  request_policy("webPermissionRequest", d, [id, navigation, done](const json &answer) {
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
// Authentication and certificates

static std::set<std::string> g_certificate_pins;
static std::map<std::string, int> g_auth_answers; // origin + realm: credentials given, none of which held

static std::string take(LPWSTR s) {
  std::string out = utf8(s);
  if (s) CoTaskMemFree(s);
  return out;
}

static std::string hex(const BYTE *bytes, DWORD size) {
  static const char *const digits = "0123456789abcdef";
  std::string out;
  for (DWORD i = 0; i < size; i++) {
    out += digits[bytes[i] >> 4];
    out += digits[bytes[i] & 15];
  }
  return out;
}

// SHA-256 of the DER certificate, lowercase hex.
static std::string pem_fingerprint(const std::string &pem) {
  DWORD size = 0;
  if (!CryptStringToBinaryA(pem.c_str(), 0, CRYPT_STRING_BASE64HEADER, nullptr, &size, nullptr, nullptr)) return "";
  std::vector<BYTE> der(size);
  if (!CryptStringToBinaryA(pem.c_str(), 0, CRYPT_STRING_BASE64HEADER, der.data(), &size, nullptr, nullptr)) return "";
  BYTE hash[32];
  DWORD length = sizeof hash;
  if (!CryptHashCertificate2(L"SHA256", 0, nullptr, der.data(), size, hash, &length)) return "";
  return hex(hash, length);
}

static void split_origin(const std::string &origin, std::string &host, int &port) {
  auto start = origin.find("://");
  std::string scheme = origin.substr(0, start), authority = origin.substr(start + 3);
  auto close = authority.rfind(']');
  auto colon = authority.rfind(':');
  bool hasPort = colon != std::string::npos && (close == std::string::npos || colon > close);
  host = hasPort ? authority.substr(0, colon) : authority;
  port = hasPort ? atoi(authority.c_str() + colon + 1) : scheme == "https" ? 443 : 80;
}

static std::string challenge_realm(const std::string &challenge) {
  std::string low = lower(challenge);
  auto at = low.find("realm=");
  if (at == std::string::npos) return "";
  at += 6;
  if (at < challenge.size() && challenge[at] == '"') {
    auto end = challenge.find('"', at + 1);
    return challenge.substr(at + 1, end == std::string::npos ? std::string::npos : end - at - 1);
  }
  return challenge.substr(at, challenge.find_first_of(", ", at) - at);
}

static json challenge_event(View *v, const std::string &origin, const std::string &realm, const std::string &method, bool proxy, int failures) {
  std::string host;
  int port = 0;
  split_origin(origin, host, port);
  json d = view_source(v);
  d.update(json{{"origin", origin}, {"host", host}, {"port", port}, {"realm", realm}, {"method", method}, {"proxy", proxy}, {"previousFailures", failures}, {"identities", json::array()}});
  return d;
}

// Cancelling goes on without a credential, so the page gets the server's own answer. Not WebView2's
// default: that's a login box the app never asked for, which macOS doesn't have either.
static void on_basic_auth(int id, ICoreWebView2BasicAuthenticationRequestedEventArgs *args) {
  LPWSTR uri = nullptr, text = nullptr;
  args->get_Uri(&uri);
  args->get_Challenge(&text);
  std::string site = http_origin(take(uri)), challenge = take(text);
  std::string method = lower(challenge.substr(0, challenge.find(' ')));
  View *v = find_view(id);
  ICoreWebView2Deferral *deferral = nullptr;
  bool known = method == "basic" || method == "digest" || method == "ntlm";
  if (!v || !g_auth_handler || !known || site.empty() || site == app_origin() || FAILED(args->GetDeferral(&deferral)) || !deferral) {
    args->put_Cancel(TRUE);
    return;
  }
  std::string realm = challenge_realm(challenge), key = site + "\n" + realm, navigation = view_url(v);
  args->AddRef();
  // A credential is kept for the origin and realm once it works: asked again, the last one didn't.
  // The event doesn't say whether it's for a proxy.
  request_policy("webAuthChallenge", challenge_event(v, site, realm, method, false, g_auth_answers[key]), [=](const json &answer) {
    View *now = find_view(id);
    ICoreWebView2BasicAuthenticationResponse *response = nullptr;
    bool credential = now && view_url(now) == navigation && answer.is_object() && jhas(answer, "username") && answer["username"].is_string() && jhas(answer, "password") && answer["password"].is_string();
    if (credential && SUCCEEDED(args->get_Response(&response)) && response) {
      response->put_UserName(wide(jstr(answer, "username")).c_str());
      response->put_Password(wide(jstr(answer, "password")).c_str());
      response->Release();
      g_auth_answers[key]++;
    } else {
      args->put_Cancel(TRUE);
      g_auth_answers.erase(key);
    }
    deferral->Complete();
    deferral->Release();
    args->Release();
  });
}

static std::string pin_key(const std::string &host, const std::string &fingerprint) { return host + "\n" + fingerprint; }

// Cancelled rather than left to WebView2's default: that's an error page with a way past it, which
// the app didn't offer.
static void on_certificate_error(int id, ICoreWebView2ServerCertificateErrorDetectedEventArgs *args) {
  LPWSTR uri = nullptr, pem = nullptr;
  args->get_RequestUri(&uri);
  std::string site = http_origin(take(uri)), fingerprint;
  ICoreWebView2Certificate *certificate = nullptr;
  if (SUCCEEDED(args->get_ServerCertificate(&certificate)) && certificate) {
    if (SUCCEEDED(certificate->ToPemEncoding(&pem))) fingerprint = pem_fingerprint(take(pem));
    certificate->Release();
  }
  args->put_Action(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL);
  View *v = find_view(id);
  if (!v || site.empty() || site == app_origin()) return;
  std::string host;
  int port = 0;
  split_origin(site, host, port);
  // Pins apply to the challenged host and leaf certificate only, never an entire store or session.
  std::string pin = pin_key(host, fingerprint);
  if (!fingerprint.empty() && g_certificate_pins.count(pin)) {
    args->put_Action(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW);
    return;
  }
  ICoreWebView2Deferral *deferral = nullptr;
  if (!g_auth_handler || FAILED(args->GetDeferral(&deferral)) || !deferral) return;
  json d = challenge_event(v, site, "", "serverTrust", false, 0);
  if (!fingerprint.empty()) d["fingerprint"] = fingerprint;
  args->AddRef();
  std::string navigation = view_url(v);
  request_policy("webAuthChallenge", d, [=](const json &answer) {
    // A server may register this exact fingerprint while handling the challenge, then return default.
    View *now = find_view(id);
    if (now && view_url(now) == navigation && answer == json("default") && g_certificate_pins.count(pin)) args->put_Action(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW);
    deferral->Complete();
    deferral->Release();
    args->Release();
  });
}

static std::string client_fingerprint(ICoreWebView2ClientCertificate *certificate) {
  LPWSTR pem = nullptr;
  return SUCCEEDED(certificate->ToPemEncoding(&pem)) ? pem_fingerprint(take(pem)) : "";
}

// Handled with no certificate goes on without one. WebView2's default would be its own picker.
static void on_client_certificate(int id, ICoreWebView2ClientCertificateRequestedEventArgs *args) {
  LPWSTR hostText = nullptr;
  int port = 443;
  BOOL proxy = FALSE;
  args->get_Host(&hostText);
  args->get_Port(&port);
  args->get_IsProxy(&proxy);
  std::string host = lower(take(hostText));
  std::string site = "https://" + host + (port == 443 ? "" : ":" + std::to_string(port));
  View *v = find_view(id);
  ICoreWebView2Deferral *deferral = nullptr;
  if (!v || !g_auth_handler || site == app_origin() || FAILED(args->GetDeferral(&deferral)) || !deferral) {
    args->put_Handled(TRUE);
    return;
  }
  json d = challenge_event(v, site, "", "clientCertificate", proxy != FALSE, 0);
  ICoreWebView2ClientCertificateCollection *offered = nullptr;
  UINT32 count = 0;
  if (SUCCEEDED(args->get_MutuallyTrustedCertificates(&offered)) && offered) offered->get_Count(&count);
  for (UINT32 i = 0; i < count; i++) {
    ICoreWebView2ClientCertificate *certificate = nullptr;
    if (FAILED(offered->GetValueAtIndex(i, &certificate)) || !certificate) continue;
    LPWSTR name = nullptr;
    certificate->get_DisplayName(&name);
    std::string fingerprint = client_fingerprint(certificate);
    d["identities"].push_back(json{{"identity", fingerprint}, {"fingerprint", fingerprint}, {"label", take(name)}});
    certificate->Release();
  }
  args->AddRef();
  std::string navigation = view_url(v);
  request_policy("webAuthChallenge", d, [=](const json &answer) {
    View *now = find_view(id);
    bool current = now && view_url(now) == navigation;
    ICoreWebView2ClientCertificate *chosen = nullptr;
    if (current && answer.is_object() && jhas(answer, "identity"))
      for (UINT32 i = 0; i < count && !chosen; i++) {
        ICoreWebView2ClientCertificate *certificate = nullptr;
        if (FAILED(offered->GetValueAtIndex(i, &certificate)) || !certificate) continue;
        if (client_fingerprint(certificate) == jstr(answer, "identity")) chosen = certificate;
        else certificate->Release();
      }
    if (chosen) {
      args->put_SelectedCertificate(chosen);
      args->put_Handled(TRUE);
      chosen->Release();
    } else if (current && answer == json("default")) args->put_Handled(TRUE);
    else args->put_Cancel(TRUE);
    if (offered) offered->Release();
    deferral->Complete();
    deferral->Release();
    args->Release();
  });
}

void web_auth_attach(View *v) {
  int id = v->id;
  EventRegistrationToken token{};
  if (auto *wv10 = query<ICoreWebView2_10>(v->webview, IID_ICoreWebView2_10)) {
    auto *onBasic = new Cb<ICoreWebView2BasicAuthenticationRequestedEventHandler, ICoreWebView2 *, ICoreWebView2BasicAuthenticationRequestedEventArgs *>(
        IID_ICoreWebView2BasicAuthenticationRequestedEventHandler, [id](ICoreWebView2 *, ICoreWebView2BasicAuthenticationRequestedEventArgs *args) -> HRESULT {
          on_basic_auth(id, args);
          return S_OK;
        });
    wv10->add_BasicAuthenticationRequested(onBasic, &token);
    onBasic->Release();
    wv10->Release();
  }
  if (auto *wv14 = query<ICoreWebView2_14>(v->webview, IID_ICoreWebView2_14)) {
    auto *onCertificate = new Cb<ICoreWebView2ServerCertificateErrorDetectedEventHandler, ICoreWebView2 *, ICoreWebView2ServerCertificateErrorDetectedEventArgs *>(
        IID_ICoreWebView2ServerCertificateErrorDetectedEventHandler, [id](ICoreWebView2 *, ICoreWebView2ServerCertificateErrorDetectedEventArgs *args) -> HRESULT {
          on_certificate_error(id, args);
          return S_OK;
        });
    wv14->add_ServerCertificateErrorDetected(onCertificate, &token);
    onCertificate->Release();
    wv14->Release();
  }
  if (auto *wv5 = query<ICoreWebView2_5>(v->webview, IID_ICoreWebView2_5)) {
    auto *onClient = new Cb<ICoreWebView2ClientCertificateRequestedEventHandler, ICoreWebView2 *, ICoreWebView2ClientCertificateRequestedEventArgs *>(
        IID_ICoreWebView2ClientCertificateRequestedEventHandler, [id](ICoreWebView2 *, ICoreWebView2ClientCertificateRequestedEventArgs *args) -> HRESULT {
          on_client_certificate(id, args);
          return S_OK;
        });
    wv5->add_ClientCertificateRequested(onClient, &token);
    onClient->Release();
    wv5->Release();
  }
}

// What WebView2 allowed stays allowed until this: every view shares it. Pins left bring theirs back.
static void forget_allowed_certificates(std::function<void()> done) {
  ICoreWebView2_14 *wv14 = nullptr;
  for (auto &[id, v] : views())
    if (!wv14 && v->webview) wv14 = query<ICoreWebView2_14>(v->webview, IID_ICoreWebView2_14);
  if (!wv14) return done();
  auto *cb = new Cb<ICoreWebView2ClearServerCertificateErrorActionsCompletedHandler, HRESULT>(
      IID_ICoreWebView2ClearServerCertificateErrorActionsCompletedHandler, [done](HRESULT) -> HRESULT {
        done();
        return S_OK;
      });
  HRESULT hr = wv14->ClearServerCertificateErrorActions(cb);
  cb->Release();
  wv14->Release();
  if (FAILED(hr)) done();
}

// The personal store, the one WebView2 offers from: what has a private key, in date.
static json client_identities() {
  json out = json::array();
  HCERTSTORE store = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0, CERT_SYSTEM_STORE_CURRENT_USER | CERT_STORE_READONLY_FLAG, L"MY");
  if (!store) return out;
  PCCERT_CONTEXT certificate = nullptr;
  while ((certificate = CertEnumCertificatesInStore(store, certificate))) {
    DWORD size = 0;
    if (!CertGetCertificateContextProperty(certificate, CERT_KEY_PROV_INFO_PROP_ID, nullptr, &size)) continue;
    if (CertVerifyTimeValidity(nullptr, certificate->pCertInfo) != 0) continue;
    BYTE hash[32];
    DWORD length = sizeof hash;
    if (!CertGetCertificateContextProperty(certificate, CERT_SHA256_HASH_PROP_ID, hash, &length)) continue;
    wchar_t name[256] = L"";
    CertGetNameStringW(certificate, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nullptr, name, 256);
    std::string fingerprint = hex(hash, length);
    out.push_back(json{{"identity", fingerprint}, {"fingerprint", fingerprint}, {"label", utf8(name)}});
  }
  CertCloseStore(store, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Navigation policy: a veto on what views load, after the shell's own checks

static bool g_navigation_policy = false;
static std::map<std::string, std::function<void(bool)>> g_navigations;

// What the policy refused, by view and address, for the request that comes after. See web_policy_attach.
static std::map<int, std::set<std::string>> g_refused;

static std::string without_fragment(const std::string &url) { return url.substr(0, url.find('#')); }

// NavigationStarting doesn't hold the request: it reaches the server while the answer is awaited,
// and cancelling doesn't stop it either. A handler on document requests holds it, because WebView2
// waits for that handler and keeps it until the navigation's has returned. So it runs knowing the
// answer, and a refused request gets a response of its own instead of going out.
void web_policy_forget(int view) { g_refused.erase(view); }

void web_policy_attach(View *v) {
  if (!g_navigation_policy || v->browserView.empty() || !v->webview || v->holdsRequests) return;
  auto *onRequest = new Cb<ICoreWebView2WebResourceRequestedEventHandler, ICoreWebView2 *, ICoreWebView2WebResourceRequestedEventArgs *>(
      IID_ICoreWebView2WebResourceRequestedEventHandler, [id = v->id](ICoreWebView2 *sender, ICoreWebView2WebResourceRequestedEventArgs *args) -> HRESULT {
        ICoreWebView2WebResourceRequest *request = nullptr;
        LPWSTR uri = nullptr;
        if (FAILED(args->get_Request(&request)) || !request) return S_OK;
        request->get_Uri(&uri);
        request->Release();
        std::string url = utf8(uri);
        if (uri) CoTaskMemFree(uri);
        if (!g_refused[id].erase(without_fragment(url))) return S_OK;
        auto *wv2 = query<ICoreWebView2_2>(sender, IID_ICoreWebView2_2);
        if (!wv2) return S_OK;
        ICoreWebView2Environment *env = nullptr;
        ICoreWebView2WebResourceResponse *response = nullptr;
        if (SUCCEEDED(wv2->get_Environment(&env)) && env && SUCCEEDED(env->CreateWebResourceResponse(nullptr, 403, L"Refused", L"", &response)) && response) {
          args->put_Response(response);
          response->Release();
        }
        if (env) env->Release();
        wv2->Release();
        return S_OK;
      });
  v->webview->add_WebResourceRequested(onRequest, &v->tokens[11]);
  onRequest->Release();
  v->webview->AddWebResourceRequestedFilter(L"*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT);
  v->holdsRequests = true;
}

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
  auto &refused = g_refused[v->id];
  if (allow) {
    refused.erase(without_fragment(url));
    return;
  }
  refused.insert(without_fragment(url));
  args->put_Cancel(TRUE);
}

// ---------------------------------------------------------------------------

void register_web_policy() {
  reg("webview", "configurePolicy", [](CallPtr c) {
    if (!server_only(c)) return;
    std::string kind = c->str("kind");
    if (kind != "permission" && kind != "auth") return c->fail("invalid_args", "Unknown policy kind");
    double ms = c->num("timeoutMs", 15000);
    if (!(ms >= 50 && ms <= 30000)) return c->fail("invalid_args", "timeoutMs must be 50–30000");
    (kind == "permission" ? g_permission_timeout : g_auth_timeout) = (UINT)ms;
    (kind == "permission" ? g_permission_handler : g_auth_handler) = c->flag("enabled", false);
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
  reg_many("webview", {"allowCertificate", "revokeCertificate"}, [](CallPtr c) {
    if (!server_only(c)) return;
    std::string host = lower(c->str("host")), fingerprint = lower(c->str("fingerprint"));
    bool isHex = fingerprint.size() == 64 && fingerprint.find_first_not_of("0123456789abcdef") == std::string::npos;
    if (host.empty() || host.find_first_of("/*") != std::string::npos || !isHex) return c->fail("invalid_args", "An exact host and 64-character SHA-256 fingerprint are required");
    if (c->op == "allowCertificate") {
      g_certificate_pins.insert(pin_key(host, fingerprint));
      return c->ok();
    }
    g_certificate_pins.erase(pin_key(host, fingerprint));
    forget_allowed_certificates([c] { c->ok(); });
  });
  reg("webview", "listClientIdentities", [](CallPtr c) {
    if (server_only(c)) c->ok(client_identities());
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
    for (auto &[id, v] : views()) web_policy_attach(v);
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
