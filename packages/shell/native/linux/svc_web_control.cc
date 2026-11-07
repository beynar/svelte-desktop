// webview.* controls every WebKitWebView of the shell gets (windows, popovers, views):
//   setNavigationPolicy · navigationDecision
//   configurePolicy · respondPolicy · list/set/revokePermissionDecision · _permissionPolicyForTesting
//   allowCertificate · revokeCertificate
//   find · clearFind · setContextMenu · getContextMenu · getDialog · respondToDialog
//   setAudioMuted · pauseMedia · getMediaState · setBackgroundThrottling · setRecovery
//   _terminateForTesting · _contextMenuForTesting · setFileDrop
// Events: webContentNavigation, webPermissionRequest, webAuthChallenge (Worker only), jsDialog,
// contextMenu, fileDragEnter, fileDragLeave, fileDrop, webviewLifecycle (`terminated` only).
// Same contracts as platform_web_policy.mm, platform_web_content.mm and platform_webview.mm.
//
// Not registered (unsupported): listClientIdentities. Linux has no system store of client
// identities to list (each browser keeps its own), so a challenge offers none and {identity} cancels.
//
// Where WebKitGTK differs:
// - A navigation decision doesn't say which frame it targets: `isMainFrame` is null.
// - A permission request names neither its origin nor its frame: `origin` is the committed page's
//   (a frame can only ask if the page delegated with allow=), `frame` is null. WebKit has no prompt
//   of its own, so `prompt` shows ours.
// - TLS errors reach the app only for top-level loads, after the handshake failed: a pin takes
//   effect there. WebKit then trusts that certificate for the host until the app quits, whatever
//   revokeCertificate does after it.
//
// Signal handlers carry the Control, not the native id: svc_view.cc disconnects what carries the id.
#include <cmath>
#include <cstring>
#include <deque>
#include <map>
#include <set>

#include "linux.hpp"

namespace sd {
namespace lx {

struct Control {
  int id = 0;
  WebKitWebView *wv = nullptr;
  std::string nonce;
  bool fileDrop = true, editMenu = true, throttling = true;
  std::string contextMode, recovery = "reload";
  json contextItems = json::array();
  json lastMenu; // test channel: what the policy made of WebKit's menu
  ReloadBudget budget;
  std::deque<CallPtr> finds; // answered in order by found-text / failed-to-find-text
  WebKitScriptDialog *dialog = nullptr;
  GtkWidget *dialogWidget = nullptr, *dialogEntry = nullptr;
  std::string dialogType, dialogMessage;
  bool dragging = false, dropWaiting = false;
  std::vector<std::string> dragPaths;
  int dragX = 0, dragY = 0;
  guint leaveTimer = 0;
  int tlsRetries = 0;
};

static bool g_file_drop_default = true;
static std::string g_context_mode_default; // empty: none, default when the view is in debug
static json g_context_items_default = json::array();
static int g_next_request = 1;

static Control *control_of(WebKitWebView *wv) { return wv ? static_cast<Control *>(g_object_get_data(G_OBJECT(wv), "sd-control")) : nullptr; }
static bool test_channel() { return g_test_channel && getenv("KITOP_TEST"); }
static std::string next_request_id(const char *kind) { return std::string(kind) + "-" + std::to_string(g_next_request++); }

static void run_after(guint ms, std::function<void()> fn) {
  g_timeout_add_full(G_PRIORITY_DEFAULT, ms, [](gpointer d) -> gboolean {
    (*static_cast<std::function<void()> *>(d))();
    return G_SOURCE_REMOVE;
  }, new std::function<void()>(std::move(fn)), [](gpointer d) { delete static_cast<std::function<void()> *>(d); });
}

json source_of(int id) {
  std::string popover = popover_ident(id);
  if (!popover.empty()) return json{{"popoverId", popover}};
  if (int owner = view_owner(id)) return json{{"viewId", view_ident(id)}, {"windowId", public_id(owner)}};
  return json{{"windowId", public_id(id)}};
}

static void emit_for(Control *s, const std::string &name, const json &data = json::object()) {
  json d = source_of(s->id);
  d.update(data);
  emit(name, d);
}

static std::string current_uri(WebKitWebView *wv) {
  const char *uri = wv ? webkit_web_view_get_uri(wv) : nullptr;
  return uri ? uri : "";
}

static GtkWindow *parent_of(WebKitWebView *wv) {
  GtkWidget *top = gtk_widget_get_toplevel(GTK_WIDGET(wv));
  return GTK_IS_WINDOW(top) ? GTK_WINDOW(top) : nullptr;
}

// Blocks its window, as a sheet does on macOS, and leaves the app's others alone.
static void modal_to_window(GtkWidget *dialog, GtkWindow *parent) {
  gtk_window_set_modal(GTK_WINDOW(dialog), TRUE);
  if (!parent) return;
  GtkWindowGroup *group = gtk_window_group_new();
  gtk_window_group_add_window(group, parent);
  gtk_window_group_add_window(group, GTK_WINDOW(dialog));
  g_object_unref(group);
}

// scheme://host[:port] for http(s), the default port dropped; "" for anything else.
static std::string http_origin(const std::string &url) {
  GUri *u = g_uri_parse(url.c_str(), G_URI_FLAGS_NONE, nullptr);
  if (!u) return "";
  std::string scheme = g_uri_get_scheme(u) ? g_uri_get_scheme(u) : "", host = g_uri_get_host(u) ? g_uri_get_host(u) : "";
  int port = g_uri_get_port(u);
  g_uri_unref(u);
  for (auto &ch : scheme) ch = (char)g_ascii_tolower(ch);
  for (auto &ch : host) ch = (char)g_ascii_tolower(ch);
  if ((scheme != "http" && scheme != "https") || host.empty()) return "";
  if (host.find(':') != std::string::npos) host = "[" + host + "]";
  bool standard = port < 0 || port == (scheme == "https" ? 443 : 80);
  return scheme + "://" + host + (standard ? "" : ":" + std::to_string(port));
}

static bool server_only(const CallPtr &c) {
  if (!c->caller) return true;
  c->fail("denied", "Web policy is owned by server code, not pages");
  return false;
}

using TargetOp = std::function<void(CallPtr, Target &, Control *)>;
static void op(const std::string &name, TargetOp body) {
  reg("webview", name, [body](CallPtr c) {
    Target t;
    if (resolve_target(c, &t)) body(c, t, control_of(t.wv));
  });
}

// ===========================================================================
// Navigation policy: a veto on what views load, after the shell's own checks

static bool g_navigation_policy = false;
static std::map<std::string, WebKitPolicyDecision *> g_navigations;

static bool answer_navigation(const std::string &ident, bool allow) {
  auto it = g_navigations.find(ident);
  if (it == g_navigations.end()) return false;
  WebKitPolicyDecision *d = it->second;
  g_navigations.erase(it);
  allow ? webkit_policy_decision_use(d) : webkit_policy_decision_ignore(d);
  g_object_unref(d);
  return true;
}

bool web_navigation_held(WebKitWebView *wv, WebKitPolicyDecision *d, const std::string &url) {
  // An app policy cannot sever its own origin or its bridge.
  Control *s = control_of(wv);
  if (!g_navigation_policy || !s || same_origin(url)) return false;
  std::string ident = next_request_id("nav");
  g_navigations[ident] = WEBKIT_POLICY_DECISION(g_object_ref(d));
  json source = source_of(s->id);
  std::string viewId = source.contains("viewId") ? source["viewId"].get<std::string>()
                       : source.contains("popoverId") ? source["popoverId"].get<std::string>()
                                                      : "window:" + std::to_string(source.value("windowId", 0));
  emit_raw(json{{"type", "platform"}, {"name", "webContentNavigation"},
                {"data", {{"requestId", ident}, {"url", url}, {"isMainFrame", nullptr}, {"viewId", viewId}}}});
  run_after(10000, [ident] { answer_navigation(ident, false); });
  return true;
}

// ===========================================================================
// Web policy: requests to the Worker only, answered by respondPolicy or the deadline

static bool g_permission_handler = false, g_auth_handler = false;
static guint g_permission_timeout = 15000, g_auth_timeout = 15000;
static std::map<std::string, std::function<void(const json &)>> g_pending;
static std::set<std::string> g_certificate_pins;

static void request_policy(const char *event, const json &data, std::function<void(const json &)> done) {
  if (g_pending.size() >= 256) return done(nullptr);
  std::string ident = next_request_id("policy");
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

static std::string pair_key(const std::string &a, const std::string &b) { return a + "\n" + b; }
static bool known_permission(const std::string &p) {
  return p == "camera" || p == "microphone" || p == "location" || p == "speech" || p == "screenRecording";
}
static bool known_decision(const std::string &d) { return d == "allow" || d == "deny" || d == "prompt"; }

// ---- saved decisions: app-owned, across launches ---------------------------

static std::string decisions_file() { return std::string(g_get_user_data_dir()) + "/" + app_identifier() + "/web-permissions.json"; }

static json read_decisions() {
  gchar *text = nullptr;
  json saved = json::object();
  if (g_file_get_contents(decisions_file().c_str(), &text, nullptr, nullptr)) saved = json::parse(text, nullptr, false);
  g_free(text);
  return saved.is_object() ? saved : json::object();
}

static void write_decisions(const json &saved) {
  std::string file = decisions_file();
  gchar *dir = g_path_get_dirname(file.c_str());
  g_mkdir_with_parents(dir, 0700);
  g_free(dir);
  g_file_set_contents_full(file.c_str(), saved.dump().c_str(), -1, G_FILE_SET_CONTENTS_CONSISTENT, 0600, nullptr);
}

// ---- permissions -----------------------------------------------------------

static void permission_policy(int id, const std::string &site, const std::string &permission, std::function<void(const std::string &)> done) {
  WebKitWebView *wv = webview_for(id);
  if (site.empty() || !wv) return done("deny");
  json saved = read_decisions();
  auto it = saved.find(pair_key(site, permission));
  if (it != saved.end() && it->is_object() && it->contains("decision") && (*it)["decision"].is_string() && known_decision((*it)["decision"].get<std::string>()))
    return done((*it)["decision"].get<std::string>());
  if (!g_permission_handler) return done(site == http_origin(app_origin()) ? "allow" : "deny");
  json d = source_of(id);
  d["origin"] = site;
  d["permission"] = permission;
  d["frame"] = nullptr;
  std::string navigation = current_uri(wv);
  request_policy("webPermissionRequest", d, [id, navigation, done](const json &answer) {
    // A handler answers for the page that asked: not for what the view shows since.
    WebKitWebView *now = webview_for(id);
    bool valid = now && current_uri(now) == navigation && answer.is_string() && known_decision(answer.get<std::string>());
    done(valid ? answer.get<std::string>() : "deny");
  });
}

static std::string permission_label(const std::vector<std::string> &names) {
  std::string out;
  for (auto &n : names) {
    if (!out.empty()) out += " and ";
    out += n == "screenRecording" ? "your screen" : n == "location" ? "your location" : "your " + n;
  }
  return out;
}

// `prompt`: WebKitGTK has no prompt of its own (unanswered means denied), so the shell asks.
static void prompt_permission(int id, const std::string &site, const std::vector<std::string> &names, std::function<void(bool)> done) {
  WebKitWebView *wv = webview_for(id);
  if (!wv) return done(false);
  GtkWindow *parent = parent_of(wv);
  GtkWidget *dialog = gtk_message_dialog_new(parent, GTK_DIALOG_DESTROY_WITH_PARENT, GTK_MESSAGE_QUESTION, GTK_BUTTONS_NONE, "%s", app_name().c_str());
  gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog), "%s wants to use %s.", site.c_str(), permission_label(names).c_str());
  gtk_dialog_add_buttons(GTK_DIALOG(dialog), "Deny", GTK_RESPONSE_REJECT, "Allow", GTK_RESPONSE_ACCEPT, nullptr);
  gtk_dialog_set_default_response(GTK_DIALOG(dialog), GTK_RESPONSE_REJECT);
  modal_to_window(dialog, parent);
  g_signal_connect_data(dialog, "response", G_CALLBACK(+[](GtkDialog *d, gint response, gpointer data) {
    (*static_cast<std::function<void(bool)> *>(data))(response == GTK_RESPONSE_ACCEPT);
    gtk_widget_destroy(GTK_WIDGET(d));
  }), new std::function<void(bool)>(std::move(done)), +[](gpointer data, GClosure *) { delete static_cast<std::function<void(bool)> *>(data); }, (GConnectFlags)0);
  gtk_widget_show_all(dialog);
}

// Each permission a request needs, one after the other; one refusal refuses it, one `prompt` asks once.
static void decide_permissions(int id, const std::string &site, const std::vector<std::string> &names, size_t i, bool prompt, std::function<void(bool)> done) {
  if (i == names.size()) {
    if (prompt) prompt_permission(id, site, names, done);
    else done(true);
    return;
  }
  permission_policy(id, site, names[i], [=](const std::string &decision) {
    if (decision == "deny") return done(false);
    decide_permissions(id, site, names, i + 1, prompt || decision == "prompt", done);
  });
}

static gboolean on_permission_request(WebKitWebView *, WebKitPermissionRequest *request, Control *s) {
  std::vector<std::string> names;
  if (WEBKIT_IS_USER_MEDIA_PERMISSION_REQUEST(request)) {
    auto *media = WEBKIT_USER_MEDIA_PERMISSION_REQUEST(request);
    if (webkit_user_media_permission_is_for_display_device(media)) names.push_back("screenRecording");
    else {
      if (webkit_user_media_permission_is_for_video_device(media)) names.push_back("camera");
      if (webkit_user_media_permission_is_for_audio_device(media)) names.push_back("microphone");
    }
  } else if (WEBKIT_IS_GEOLOCATION_PERMISSION_REQUEST(request)) names.push_back("location");
  if (names.empty()) return FALSE; // no WebPermission name: WebKit's answer stands
  g_object_ref(request);
  decide_permissions(s->id, http_origin(page_origin(s->id)), names, 0, false, [request](bool allow) {
    allow ? webkit_permission_request_allow(request) : webkit_permission_request_deny(request);
    g_object_unref(request);
  });
  return TRUE;
}

// ---- authentication and certificates ---------------------------------------

static const char *auth_method(WebKitAuthenticationScheme scheme) {
  switch (scheme) {
  case WEBKIT_AUTHENTICATION_SCHEME_HTTP_BASIC: return "basic";
  case WEBKIT_AUTHENTICATION_SCHEME_HTTP_DIGEST: return "digest";
  case WEBKIT_AUTHENTICATION_SCHEME_NTLM: return "ntlm";
  case WEBKIT_AUTHENTICATION_SCHEME_CLIENT_CERTIFICATE_REQUESTED: return "clientCertificate";
  default: return nullptr;
  }
}

// Goes on without a credential, so the page gets the server's own answer. Not WebKit's default:
// that's a login box the app never asked for, which macOS doesn't have either.
static void auth_default(WebKitAuthenticationRequest *request) { webkit_authentication_request_authenticate(request, nullptr); }

static gboolean on_authenticate(WebKitWebView *wv, WebKitAuthenticationRequest *request, Control *s) {
  const char *method = auth_method(webkit_authentication_request_get_scheme(request));
  if (!method) return FALSE;
  WebKitSecurityOrigin *so = webkit_authentication_request_get_security_origin(request);
  guint16 port = webkit_security_origin_get_port(so);
  std::string origin = http_origin(std::string(webkit_security_origin_get_protocol(so) ? webkit_security_origin_get_protocol(so) : "https") + "://" +
                                   (webkit_security_origin_get_host(so) ? webkit_security_origin_get_host(so) : "") + (port ? ":" + std::to_string(port) : ""));
  webkit_security_origin_unref(so);
  if (!g_auth_handler || origin == http_origin(app_origin())) {
    auth_default(request);
    return TRUE;
  }
  json d = source_of(s->id);
  const char *realm = webkit_authentication_request_get_realm(request);
  d.update(json{{"origin", origin}, {"host", webkit_authentication_request_get_host(request)}, {"port", webkit_authentication_request_get_port(request)},
                {"realm", realm ? realm : ""}, {"method", method}, {"proxy", (bool)webkit_authentication_request_is_for_proxy(request)},
                {"previousFailures", webkit_authentication_request_is_retry(request) ? 1 : 0}, {"identities", json::array()}});
  g_object_ref(request);
  int id = s->id;
  std::string navigation = current_uri(wv), kind = method;
  request_policy("webAuthChallenge", d, [=](const json &answer) {
    WebKitWebView *now = webview_for(id);
    if (!now || current_uri(now) != navigation) webkit_authentication_request_cancel(request);
    else if (answer.is_string() && answer.get<std::string>() == "default") auth_default(request);
    else if (kind != "clientCertificate" && answer.is_object() && answer.value("username", json()).is_string() && answer.value("password", json()).is_string()) {
      WebKitCredential *credential = webkit_credential_new(answer["username"].get<std::string>().c_str(), answer["password"].get<std::string>().c_str(), WEBKIT_CREDENTIAL_PERSISTENCE_NONE);
      webkit_authentication_request_authenticate(request, credential);
      webkit_credential_free(credential);
    } else webkit_authentication_request_cancel(request); // {identity} too: there's no store it could name
    g_object_unref(request);
  });
  return TRUE;
}

static std::string certificate_fingerprint(GTlsCertificate *certificate) {
  GByteArray *der = nullptr;
  g_object_get(certificate, "certificate", &der, nullptr);
  if (!der) return "";
  gchar *sum = g_compute_checksum_for_data(G_CHECKSUM_SHA256, der->data, der->len);
  std::string out = sum ? sum : "";
  g_free(sum);
  g_byte_array_unref(der);
  return out;
}

static std::string uri_host(const std::string &url) {
  GUri *u = g_uri_parse(url.c_str(), G_URI_FLAGS_NONE, nullptr);
  std::string host = u && g_uri_get_host(u) ? g_uri_get_host(u) : "";
  if (u) g_uri_unref(u);
  for (auto &ch : host) ch = (char)g_ascii_tolower(ch);
  return host;
}

static void trust_and_load(WebKitWebView *wv, GTlsCertificate *certificate, const std::string &host, const std::string &uri) {
  webkit_web_context_allow_tls_certificate_for_host(webkit_web_view_get_context(wv), certificate, host.c_str());
  webkit_web_view_load_uri(wv, uri.c_str());
}

// One refused handshake in a few ends in GIO's "Operation was cancelled" (not WebKit's own cancel,
// which is another error), without load-failed-with-tls-errors: nothing was sent, and the next
// attempt reports it. Without this, an allowed certificate fails at random.
static gboolean on_load_failed(WebKitWebView *, WebKitLoadEvent, const gchar *failing, GError *error, Control *s) {
  if (!g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED) || http_origin(failing).rfind("https:", 0) != 0) return FALSE;
  if (++s->tlsRetries > 3) return s->tlsRetries = 0, FALSE;
  int id = s->id;
  run_after(100, [id, uri = std::string(failing)] {
    if (WebKitWebView *now = webview_for(id)) webkit_web_view_load_uri(now, uri.c_str());
  });
  return TRUE;
}

static gboolean on_tls_errors(WebKitWebView *wv, const gchar *failing, GTlsCertificate *certificate, GTlsCertificateFlags, Control *s) {
  s->tlsRetries = 0;
  std::string uri = failing, host = uri_host(uri), origin = http_origin(uri), sha = certificate_fingerprint(certificate);
  if (origin == http_origin(app_origin())) return FALSE;
  // Pins apply to the challenged host and leaf certificate only, never an entire store or session.
  std::string pin = pair_key(host, sha);
  if (!sha.empty() && g_certificate_pins.count(pin)) {
    // After the signal: WebKit is still finishing the load that failed, and would take this one with it.
    g_object_ref(certificate);
    int id = s->id;
    run_after(0, [=] {
      if (WebKitWebView *now = webview_for(id)) trust_and_load(now, certificate, host, uri);
      g_object_unref(certificate);
    });
    return TRUE;
  }
  if (!g_auth_handler) return FALSE;
  json d = source_of(s->id);
  GUri *parsed = g_uri_parse(uri.c_str(), G_URI_FLAGS_NONE, nullptr);
  int port = parsed ? g_uri_get_port(parsed) : -1;
  if (parsed) g_uri_unref(parsed);
  d.update(json{{"origin", origin}, {"host", host}, {"port", port > 0 ? port : 443}, {"realm", ""}, {"method", "serverTrust"}, {"proxy", false},
                {"previousFailures", 0}, {"identities", json::array()}});
  if (!sha.empty()) d["fingerprint"] = sha;
  g_object_ref(certificate);
  int id = s->id;
  std::string navigation = current_uri(wv);
  request_policy("webAuthChallenge", d, [=](const json &answer) {
    WebKitWebView *now = webview_for(id);
    bool current = now && current_uri(now) == navigation;
    // A server may register this exact fingerprint while handling the challenge, then return default.
    if (current && answer == json("default") && g_certificate_pins.count(pin)) trust_and_load(now, certificate, host, uri);
    else if (current) {
      // The load was held by answering TRUE: it fails now, as it would have.
      GError *error = g_error_new_literal(G_TLS_ERROR, G_TLS_ERROR_BAD_CERTIFICATE, "The certificate was not accepted");
      gboolean handled = FALSE;
      g_signal_emit_by_name(now, "load-failed", WEBKIT_LOAD_STARTED, uri.c_str(), error, &handled);
      g_error_free(error);
    }
    g_object_unref(certificate);
  });
  return TRUE;
}

// ===========================================================================
// Find

static void find_answered(Control *s, bool found) {
  if (s->finds.empty()) return;
  CallPtr c = s->finds.front();
  s->finds.pop_front();
  c->ok(json{{"matchFound", found}});
}

static void fail_finds(Control *s) {
  for (auto &c : s->finds) c->fail("unavailable", "webview.find: the page went away");
  s->finds.clear();
}

// ===========================================================================
// Context menu (modes as in platform_webview.mm)

static bool is_edit_action(WebKitContextMenuAction a) {
  switch (a) {
  case WEBKIT_CONTEXT_MENU_ACTION_CUT:
  case WEBKIT_CONTEXT_MENU_ACTION_COPY:
  case WEBKIT_CONTEXT_MENU_ACTION_PASTE:
  case WEBKIT_CONTEXT_MENU_ACTION_PASTE_AS_PLAIN_TEXT:
  case WEBKIT_CONTEXT_MENU_ACTION_SPELLING_GUESS:
  case WEBKIT_CONTEXT_MENU_ACTION_NO_GUESSES_FOUND:
  case WEBKIT_CONTEXT_MENU_ACTION_IGNORE_SPELLING:
  case WEBKIT_CONTEXT_MENU_ACTION_LEARN_SPELLING:
  case WEBKIT_CONTEXT_MENU_ACTION_IGNORE_GRAMMAR: return true;
  default: return false;
  }
}

static json menu_snapshot(WebKitContextMenu *menu) {
  json out = json::array();
  for (GList *l = webkit_context_menu_get_items(menu); l; l = l->next) {
    auto *item = WEBKIT_CONTEXT_MENU_ITEM(l->data);
    if (webkit_context_menu_item_is_separator(item)) out.push_back("-");
    else if (webkit_context_menu_item_get_stock_action(item) == WEBKIT_CONTEXT_MENU_ACTION_CUSTOM) {
      GAction *action = webkit_context_menu_item_get_gaction(item);
      const char *name = action ? static_cast<const char *>(g_object_get_data(G_OBJECT(action), "sd-label")) : nullptr;
      out.push_back(name ? name : "custom");
    } else out.push_back((int)webkit_context_menu_item_get_stock_action(item));
  }
  return out;
}

static void append_custom(WebKitContextMenu *out, GtkWidget *menu, GtkWidget *root) {
  static int next_action = 1;
  GList *children = gtk_container_get_children(GTK_CONTAINER(menu));
  for (GList *l = children; l; l = l->next) {
    GtkWidget *item = GTK_WIDGET(l->data);
    if (GTK_IS_SEPARATOR_MENU_ITEM(item)) {
      webkit_context_menu_append(out, webkit_context_menu_item_new_separator());
      continue;
    }
    const char *label = gtk_menu_item_get_label(GTK_MENU_ITEM(item));
    if (GtkWidget *sub = gtk_menu_item_get_submenu(GTK_MENU_ITEM(item))) {
      WebKitContextMenu *inner = webkit_context_menu_new();
      append_custom(inner, sub, root);
      webkit_context_menu_append(out, webkit_context_menu_item_new_with_submenu(label ? label : "", inner));
      g_object_unref(inner);
      continue;
    }
    std::string name = "sd-context-" + std::to_string(next_action++);
    GSimpleAction *action = GTK_IS_CHECK_MENU_ITEM(item)
                                ? g_simple_action_new_stateful(name.c_str(), nullptr, g_variant_new_boolean(gtk_check_menu_item_get_active(GTK_CHECK_MENU_ITEM(item))))
                                : g_simple_action_new(name.c_str(), nullptr);
    g_simple_action_set_enabled(action, gtk_widget_get_sensitive(item));
    g_object_set_data_full(G_OBJECT(action), "sd-label", g_strdup(label ? label : ""), g_free);
    g_object_set_data_full(G_OBJECT(action), "sd-menu", g_object_ref(root), g_object_unref); // the menu item outlives the popup
    // Through the GTK item: same ids (menuAction) and roles as every other menu of the shell.
    g_signal_connect(action, "activate", G_CALLBACK(+[](GSimpleAction *, GVariant *, gpointer target) { gtk_menu_item_activate(GTK_MENU_ITEM(target)); }), item);
    webkit_context_menu_append(out, webkit_context_menu_item_new_from_gaction(G_ACTION(action), label ? label : "", nullptr));
    g_object_unref(action);
  }
  g_list_free(children);
}

static gboolean on_context_menu(WebKitWebView *wv, WebKitContextMenu *menu, GdkEvent *, WebKitHitTestResult *, Control *s) {
  json before = test_channel() ? menu_snapshot(menu) : json();
  gboolean none = FALSE;
  if (s->contextMode != "default") {
    bool debug = webkit_settings_get_enable_developer_extras(webkit_web_view_get_settings(wv));
    std::vector<WebKitContextMenuItem *> edit;
    WebKitContextMenuItem *inspect = nullptr;
    for (GList *l = webkit_context_menu_get_items(menu); l; l = l->next) {
      auto *item = WEBKIT_CONTEXT_MENU_ITEM(l->data);
      WebKitContextMenuAction action = webkit_context_menu_item_get_stock_action(item);
      if (s->editMenu && is_edit_action(action)) edit.push_back(WEBKIT_CONTEXT_MENU_ITEM(g_object_ref(item)));
      else if (debug && action == WEBKIT_CONTEXT_MENU_ACTION_INSPECT_ELEMENT) inspect = WEBKIT_CONTEXT_MENU_ITEM(g_object_ref(item));
    }
    webkit_context_menu_remove_all(menu);
    for (auto *item : edit) {
      webkit_context_menu_append(menu, item);
      g_object_unref(item);
    }
    if (s->contextMode == "custom" && !s->contextItems.empty()) {
      std::string error;
      if (GtkWidget *custom = build_gtk_menu(s->contextItems, &error)) {
        g_object_ref_sink(custom);
        if (webkit_context_menu_get_n_items(menu)) webkit_context_menu_append(menu, webkit_context_menu_item_new_separator());
        append_custom(menu, custom, custom);
        g_object_unref(custom);
      }
    }
    if (inspect) {
      if (webkit_context_menu_get_n_items(menu)) webkit_context_menu_append(menu, webkit_context_menu_item_new_separator());
      webkit_context_menu_append(menu, inspect);
      g_object_unref(inspect);
    }
    none = webkit_context_menu_get_n_items(menu) == 0; // an empty menu is not shown at all
  }
  if (test_channel()) s->lastMenu = json{{"before", before}, {"after", menu_snapshot(menu)}};
  return none;
}

// The page's own record of the click (what the menu signal can't say: the selection, a page that
// prevents the menu), and its media. Top frame only; the nonce keeps a subframe from forging a click.
static std::string page_script(const std::string &nonce) {
  return "(()=>{const N=" + json(nonce).dump() + ";const h=window.webkit.messageHandlers.__shellwv__;const send=h.postMessage.bind(h);const S=JSON.stringify;"
         "const EDIT='textarea,select,input:not([type]),input[type=text],input[type=search],input[type=email],"
         "input[type=url],input[type=tel],input[type=password],input[type=number],input[type=date],input[type=time]';"
         "addEventListener('contextmenu',(e)=>{let t=e.target;if(t&&!(t instanceof Element))t=t.parentElement;"
         "const a=t&&t.closest('a[href]'),img=t&&t.closest('img[src]');"
         "send(S({n:N,t:'contextmenu',x:e.clientX,y:e.clientY,linkURL:a?a.href:null,srcURL:img?img.src:null,"
         "selectionText:String(getSelection()||''),editable:!!(t&&(t.isContentEditable||t.closest(EDIT)))}));},true);"
         // WebKitGTK has no call to pause a page: the elements it can reach, and `new Audio()` playing
         // outside the document, which only play() gives away.
         "const loose=new Set();const P=HTMLMediaElement.prototype,play=P.play;"
         "P.play=function(){if(!this.isConnected){loose.add(this);this.addEventListener('ended',()=>loose.delete(this),{once:true});}return play.apply(this,arguments);};"
         "const all=()=>{const out=[...loose];const walk=(r)=>{for(const e of r.querySelectorAll('*')){"
         "if(e.tagName==='VIDEO'||e.tagName==='AUDIO')out.push(e);if(e.shadowRoot)walk(e.shadowRoot);"
         "if(e.tagName==='IFRAME'){try{if(e.contentDocument)walk(e.contentDocument);}catch(_){}}}};walk(document);return out;};"
         "Object.defineProperty(window,'__shellMedia',{value:Object.freeze({pause(){for(const m of all())m.pause();},"
         "playback(){const a=all();return a.some((m)=>!m.paused&&!m.ended)?'playing':a.length?'paused':'none';}})});})();";
}

static void on_page_message(WebKitUserContentManager *, WebKitJavascriptResult *r, Control *s) {
  JSCValue *v = webkit_javascript_result_get_js_value(r);
  if (!jsc_value_is_string(v)) return;
  char *text = jsc_value_to_string(v);
  json m = json::parse(text ? text : "", nullptr, false);
  g_free(text);
  // What a frame posted straight to the handler can be anything: nothing is read before the nonce.
  if (!m.is_object() || !m.contains("n") || !m["n"].is_string() || m["n"].get<std::string>() != s->nonce) return;
  json d{{"x", m.value("x", json(0))}, {"y", m.value("y", json(0))}, {"editable", m.value("editable", false)}, {"mode", s->contextMode}};
  for (const char *k : {"linkURL", "srcURL"})
    if (m.contains(k) && m[k].is_string()) d[k] = m[k];
  if (m.contains("selectionText") && m["selectionText"].is_string() && !m["selectionText"].get<std::string>().empty()) d["selectionText"] = m["selectionText"];
  emit_for(s, "contextMenu", d);
}

// ===========================================================================
// JavaScript dialogs: ours, not WebKit's, so that respondToDialog can answer them

static void finish_dialog(Control *s, bool accept, const char *text) {
  if (!s->dialog) return;
  WebKitScriptDialog *dialog = s->dialog;
  GtkWidget *widget = s->dialogWidget;
  s->dialog = nullptr;
  s->dialogWidget = s->dialogEntry = nullptr;
  s->dialogType.clear();
  s->dialogMessage.clear();
  switch (webkit_script_dialog_get_dialog_type(dialog)) {
  case WEBKIT_SCRIPT_DIALOG_CONFIRM: webkit_script_dialog_confirm_set_confirmed(dialog, accept); break;
  case WEBKIT_SCRIPT_DIALOG_PROMPT:
    if (accept) webkit_script_dialog_prompt_set_text(dialog, text ? text : ""); // unset: prompt() answers null
    break;
  default: break;
  }
  webkit_script_dialog_close(dialog);
  webkit_script_dialog_unref(dialog);
  gtk_widget_destroy(widget);
}

static void on_dialog_response(GtkDialog *, gint response, Control *s) {
  finish_dialog(s, response == GTK_RESPONSE_OK, s->dialogEntry ? gtk_entry_get_text(GTK_ENTRY(s->dialogEntry)) : nullptr);
}

static gboolean on_script_dialog(WebKitWebView *wv, WebKitScriptDialog *dialog, Control *s) {
  WebKitScriptDialogType type = webkit_script_dialog_get_dialog_type(dialog);
  if (type == WEBKIT_SCRIPT_DIALOG_BEFORE_UNLOAD_CONFIRM) {
    // macOS shows none: the page just leaves.
    webkit_script_dialog_confirm_set_confirmed(dialog, TRUE);
    return TRUE;
  }
  finish_dialog(s, false, nullptr); // one at a time
  const char *message = webkit_script_dialog_get_message(dialog);
  s->dialog = webkit_script_dialog_ref(dialog);
  s->dialogType = type == WEBKIT_SCRIPT_DIALOG_ALERT ? "alert" : type == WEBKIT_SCRIPT_DIALOG_CONFIRM ? "confirm" : "prompt";
  s->dialogMessage = message ? message : "";
  GtkWindow *parent = parent_of(wv);
  s->dialogWidget = gtk_message_dialog_new(parent, (GtkDialogFlags)0, type == WEBKIT_SCRIPT_DIALOG_ALERT ? GTK_MESSAGE_INFO : GTK_MESSAGE_QUESTION,
                                           type == WEBKIT_SCRIPT_DIALOG_ALERT ? GTK_BUTTONS_OK : GTK_BUTTONS_OK_CANCEL, "%s", app_name().c_str());
  gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(s->dialogWidget), "%s", s->dialogMessage.c_str());
  gtk_dialog_set_default_response(GTK_DIALOG(s->dialogWidget), GTK_RESPONSE_OK);
  json event{{"type", s->dialogType}, {"message", s->dialogMessage}};
  if (type == WEBKIT_SCRIPT_DIALOG_PROMPT) {
    const char *text = webkit_script_dialog_prompt_get_default_text(dialog);
    s->dialogEntry = gtk_entry_new();
    gtk_entry_set_text(GTK_ENTRY(s->dialogEntry), text ? text : "");
    gtk_entry_set_activates_default(GTK_ENTRY(s->dialogEntry), TRUE);
    gtk_box_pack_end(GTK_BOX(gtk_dialog_get_content_area(GTK_DIALOG(s->dialogWidget))), s->dialogEntry, FALSE, FALSE, 0);
    event["defaultValue"] = text ? text : "";
  }
  modal_to_window(s->dialogWidget, parent);
  g_signal_connect(s->dialogWidget, "response", G_CALLBACK(on_dialog_response), s);
  gtk_widget_show_all(s->dialogWidget);
  emit_for(s, "jsDialog", event);
  return TRUE;
}

// ===========================================================================
// Lifecycle: the web process died

static gboolean reload_after_crash(gpointer data) {
  WebKitWebView *wv = WEBKIT_WEB_VIEW(data);
  if (!gtk_widget_in_destruction(GTK_WIDGET(wv))) webkit_web_view_reload(wv);
  return G_SOURCE_REMOVE;
}

static gboolean on_web_process_terminated(WebKitWebView *wv, WebKitWebProcessTerminationReason, Control *s) {
  finish_dialog(s, false, nullptr);
  fail_finds(s);
  std::string uri = current_uri(wv);
  json event = source_of(s->id);
  event.update(json{{"type", "terminated"}, {"url", uri}, {"navigationId", nullptr}, {"recovery", s->recovery}, {"reason", "unknown"}});
  bool gaveUp = false;
  if (s->recovery == "reload") {
    int delay = s->budget.next(g_get_monotonic_time() / 1e6);
    gaveUp = delay < 0;
    event["gaveUp"] = gaveUp;
    if (!gaveUp) g_timeout_add_full(G_PRIORITY_DEFAULT, delay, reload_after_crash, g_object_ref(wv), g_object_unref);
    else {
      std::string page = crashed_page_url(app_origin(), uri);
      if (!page.empty()) webkit_web_view_load_uri(wv, page.c_str());
    }
  }
  emit_raw(json{{"type", "webcontent-terminated"}, {"window", s->id}, {"gaveUp", gaveUp}});
  emit("webviewLifecycle", event);
  return FALSE;
}

// Hidden-page timers, animations and process suppression: WebKit's own switches. Same list as
// platform_webview_set_throttling on macOS; on: back to WebKit's default.
static void set_throttling(WebKitWebView *wv, bool enabled) {
  static const std::set<std::string> kThrottling = {"HiddenPageDOMTimerThrottling", "HiddenPageDOMTimerThrottlingAutoIncreases", "HiddenPageCSSAnimationSuspension",
                                                    "DOMTimersThrottling", "PageVisibilityBasedProcessSuppression"};
  WebKitSettings *settings = webkit_web_view_get_settings(wv);
  WebKitFeatureList *features = webkit_settings_get_all_features();
  for (gsize i = 0; i < webkit_feature_list_get_length(features); i++) {
    WebKitFeature *feature = webkit_feature_list_get(features, i);
    if (kThrottling.count(webkit_feature_get_identifier(feature)))
      webkit_settings_set_feature_enabled(settings, feature, enabled && webkit_feature_get_default_value(feature));
  }
  webkit_feature_list_unref(features);
}

// ===========================================================================
// File drop. WebKit fetches the drag's data itself on the first motion: the paths are read from
// that, without another request, which would throw its count of expected replies off. These
// handlers run before WebKit's and leave the drag to it: the page still gets its DOM events.

static void emit_drop(Control *s) {
  s->dropWaiting = false;
  s->dragging = false;
  double zoom = webkit_web_view_get_zoom_level(s->wv);
  if (s->fileDrop && !s->dragPaths.empty()) emit_for(s, "fileDrop", json{{"paths", s->dragPaths}, {"x", std::round(s->dragX / zoom)}, {"y", std::round(s->dragY / zoom)}});
  s->dragPaths.clear();
}

static gboolean on_drag_motion(GtkWidget *, GdkDragContext *, gint x, gint y, guint, Control *s) {
  s->dragX = x, s->dragY = y;
  s->dropWaiting = false; // the last drop was no file drag, then: it never got any
  if (s->leaveTimer) g_source_remove(s->leaveTimer), s->leaveTimer = 0;
  return FALSE;
}

static void on_drag_data(GtkWidget *, GdkDragContext *, gint, gint, GtkSelectionData *data, guint, guint, Control *s) {
  gchar **uris = gtk_selection_data_get_uris(data);
  if (!uris) return;
  s->dragPaths.clear();
  for (gchar **u = uris; *u; u++)
    if (gchar *path = g_filename_from_uri(*u, nullptr, nullptr)) {
      s->dragPaths.push_back(path);
      g_free(path);
    }
  g_strfreev(uris);
  if (s->dropWaiting) return emit_drop(s);
  double zoom = webkit_web_view_get_zoom_level(s->wv);
  if (s->fileDrop && !s->dragging && !s->dragPaths.empty()) {
    s->dragging = true;
    emit_for(s, "fileDragEnter", json{{"paths", s->dragPaths}, {"x", std::round(s->dragX / zoom)}, {"y", std::round(s->dragY / zoom)}});
  }
}

// GTK also says it left right before a drop: only a leave nothing follows is one.
static void on_drag_leave(GtkWidget *, GdkDragContext *, guint, Control *s) {
  if (s->leaveTimer) g_source_remove(s->leaveTimer);
  s->leaveTimer = g_timeout_add(0, [](gpointer data) -> gboolean {
    auto *c = static_cast<Control *>(data);
    c->leaveTimer = 0;
    bool was = c->dragging;
    c->dragging = false;
    c->dragPaths.clear();
    if (was) emit_for(c, "fileDragLeave");
    return G_SOURCE_REMOVE;
  }, s);
}

static gboolean on_drag_drop(GtkWidget *, GdkDragContext *, gint x, gint y, guint, Control *s) {
  if (s->leaveTimer) g_source_remove(s->leaveTimer), s->leaveTimer = 0;
  s->dragX = x, s->dragY = y;
  if (s->dragPaths.empty()) s->dropWaiting = true; // the data is on its way
  else emit_drop(s);
  return FALSE;
}

// ===========================================================================
// Every web view

void web_control_attach(int native_id, WebKitWebView *wv) {
  auto *s = new Control;
  s->id = native_id;
  s->wv = wv;
  gchar *nonce = g_uuid_string_random();
  s->nonce = nonce;
  g_free(nonce);
  WebKitSettings *settings = webkit_web_view_get_settings(wv);
  s->fileDrop = g_file_drop_default;
  s->contextMode = !g_context_mode_default.empty() ? g_context_mode_default : webkit_settings_get_enable_developer_extras(settings) ? "default" : "none";
  s->contextItems = g_context_items_default;
  g_object_set_data_full(G_OBJECT(wv), "sd-control", s, [](gpointer data) { delete static_cast<Control *>(data); });
  // Off by default in WebKitGTK: getUserMedia wouldn't exist, nor the permission that goes with it.
  webkit_settings_set_enable_media_stream(settings, TRUE);
  if (test_channel()) webkit_settings_set_enable_mock_capture_devices(settings, TRUE);
  g_signal_connect(wv, "permission-request", G_CALLBACK(on_permission_request), s);
  g_signal_connect(wv, "authenticate", G_CALLBACK(on_authenticate), s);
  g_signal_connect(wv, "load-failed-with-tls-errors", G_CALLBACK(on_tls_errors), s);
  g_signal_connect(wv, "load-failed", G_CALLBACK(on_load_failed), s);
  g_signal_connect(wv, "context-menu", G_CALLBACK(on_context_menu), s);
  g_signal_connect(wv, "script-dialog", G_CALLBACK(on_script_dialog), s);
  g_signal_connect(wv, "web-process-terminated", G_CALLBACK(on_web_process_terminated), s);
  g_signal_connect(wv, "drag-motion", G_CALLBACK(on_drag_motion), s);
  g_signal_connect(wv, "drag-data-received", G_CALLBACK(on_drag_data), s);
  g_signal_connect(wv, "drag-leave", G_CALLBACK(on_drag_leave), s);
  g_signal_connect(wv, "drag-drop", G_CALLBACK(on_drag_drop), s);
  WebKitFindController *find = webkit_web_view_get_find_controller(wv);
  g_signal_connect(find, "found-text", G_CALLBACK(+[](WebKitFindController *, guint, Control *c) { find_answered(c, true); }), s);
  g_signal_connect(find, "failed-to-find-text", G_CALLBACK(+[](WebKitFindController *, Control *c) { find_answered(c, false); }), s);
  WebKitUserContentManager *ucm = webkit_web_view_get_user_content_manager(wv);
  g_signal_connect(ucm, "script-message-received::__shellwv__", G_CALLBACK(on_page_message), s);
  webkit_user_content_manager_register_script_message_handler(ucm, "__shellwv__");
  std::string script = page_script(s->nonce);
  WebKitUserScript *us = webkit_user_script_new(script.c_str(), WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, nullptr, nullptr);
  webkit_user_content_manager_add_script(ucm, us);
  webkit_user_script_unref(us);
}

void web_control_detach(WebKitWebView *wv) {
  Control *s = control_of(wv);
  if (!s) return;
  finish_dialog(s, false, nullptr);
  fail_finds(s);
  if (s->leaveTimer) g_source_remove(s->leaveTimer), s->leaveTimer = 0;
  WebKitUserContentManager *ucm = webkit_web_view_get_user_content_manager(wv);
  g_signal_handlers_disconnect_by_func(ucm, (gpointer)on_page_message, s);
  webkit_user_content_manager_unregister_script_message_handler(ucm, "__shellwv__");
}

json web_control_info(WebKitWebView *wv) {
  Control *s = control_of(wv);
  return json{{"fileDrop", s->fileDrop}, {"contextMenu", s->contextMode}, {"backgroundThrottling", s->throttling}, {"recovery", s->recovery}};
}

static std::vector<Control *> all_controls() {
  std::vector<Control *> out;
  for (int id : backend_page_ids())
    if (Control *s = control_of(webview_for(id))) out.push_back(s);
  return out;
}

// ===========================================================================

void register_web_control() {
  // -- navigation policy
  reg("webview", "setNavigationPolicy", [](CallPtr c) {
    if (c->caller) return c->fail("denied", "this operation belongs to server code");
    g_navigation_policy = c->flag("enabled", false);
    while (!g_navigations.empty()) answer_navigation(g_navigations.begin()->first, false);
    c->ok();
  });
  reg("webview", "navigationDecision", [](CallPtr c) {
    if (c->caller) return c->fail("denied", "this operation belongs to server code");
    if (!answer_navigation(c->str("requestId"), c->flag("allow", false))) return c->fail("unavailable", "navigation decision expired");
    c->ok();
  });

  // -- permissions, authentication, certificates
  reg("webview", "configurePolicy", [](CallPtr c) {
    if (!server_only(c)) return;
    std::string kind = c->str("kind");
    if (kind != "permission" && kind != "auth") return c->fail("invalid_args", "Unknown policy kind");
    double ms = c->num("timeoutMs", 15000);
    if (!(ms >= 50 && ms <= 30000)) return c->fail("invalid_args", "timeoutMs must be 50–30000");
    (kind == "permission" ? g_permission_timeout : g_auth_timeout) = (guint)ms;
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
    json out = json::array(), saved = read_decisions();
    for (auto &[key, record] : saved.items()) out.push_back(record);
    c->ok(out);
  });
  reg_many("webview", {"setPermissionDecision", "revokePermissionDecision"}, [](CallPtr c) {
    if (!server_only(c)) return;
    std::string site = http_origin(c->str("origin")), permission = c->str("permission");
    if (site.empty() || !known_permission(permission)) return c->fail("invalid_args", "An HTTP(S) origin and web permission are required");
    json saved = read_decisions();
    std::string key = pair_key(site, permission);
    if (c->op == "revokePermissionDecision") saved.erase(key);
    else {
      std::string decision = c->str("decision");
      if (!known_decision(decision)) return c->fail("invalid_args", "Expected allow, deny or prompt");
      saved[key] = json{{"origin", site}, {"permission", permission}, {"decision", decision}};
    }
    write_decisions(saved);
    c->ok();
  });
  reg_many("webview", {"allowCertificate", "revokeCertificate"}, [](CallPtr c) {
    if (!server_only(c)) return;
    std::string host = c->str("host"), sha = c->str("fingerprint");
    for (auto &ch : host) ch = (char)g_ascii_tolower(ch);
    for (auto &ch : sha) ch = (char)g_ascii_tolower(ch);
    bool hex = sha.size() == 64 && sha.find_first_not_of("0123456789abcdef") == std::string::npos;
    if (host.empty() || host.find_first_of("/*") != std::string::npos || !hex) return c->fail("invalid_args", "An exact host and 64-character SHA-256 fingerprint are required");
    if (c->op == "allowCertificate") g_certificate_pins.insert(pair_key(host, sha));
    else g_certificate_pins.erase(pair_key(host, sha));
    c->ok();
  });
  // What a request from the target's page would get, without one (the test channel only).
  op("_permissionPolicyForTesting", [](CallPtr c, Target &, Control *s) {
    if (!test_channel()) return c->fail("denied", "Only available to the test channel");
    std::string permission = c->str("permission");
    if (!known_permission(permission)) return c->fail("invalid_args", "Expected a web permission");
    permission_policy(s->id, http_origin(page_origin(s->id)), permission, [c](const std::string &decision) { c->ok(decision); });
  });

  // -- find
  op("find", [](CallPtr c, Target &t, Control *s) {
    std::string text = c->str("text");
    if (text.empty()) return c->fail("invalid_args", "webview.find: `text` is required");
    guint32 options = WEBKIT_FIND_OPTIONS_NONE;
    if (!c->flag("caseSensitive", false)) options |= WEBKIT_FIND_OPTIONS_CASE_INSENSITIVE;
    if (c->flag("backwards", false)) options |= WEBKIT_FIND_OPTIONS_BACKWARDS;
    if (c->flag("wraps", true)) options |= WEBKIT_FIND_OPTIONS_WRAP_AROUND;
    s->finds.push_back(c);
    webkit_find_controller_search(webkit_web_view_get_find_controller(t.wv), text.c_str(), options, G_MAXUINT);
  });
  op("clearFind", [](CallPtr c, Target &t, Control *) {
    webkit_find_controller_search_finish(webkit_web_view_get_find_controller(t.wv));
    eval_to_json(t.wv, "getSelection().removeAllRanges();null", c, "webview.clearFind"); // the match is the selection
  });

  // -- context menu
  reg("webview", "setContextMenu", [](CallPtr c) {
    std::string mode = c->str("mode");
    if (mode != "default" && mode != "none" && mode != "custom") return c->fail("invalid_args", "webview.setContextMenu: `mode` must be default | none | custom");
    json items = c->args.contains("items") && c->args["items"].is_array() ? c->args["items"] : json::array();
    if (mode == "custom") {
      if (!c->args.contains("items") || !c->args["items"].is_array()) return c->fail("invalid_args", "webview.setContextMenu: mode `custom` needs `items` (MenuItemSpec[])");
      std::string error;
      GtkWidget *menu = build_gtk_menu(items, &error);
      if (!menu) return c->fail("invalid_args", error.empty() ? "invalid items" : error);
      g_object_ref_sink(menu);
      g_object_unref(menu);
    }
    std::vector<Control *> targets;
    if (c->flag("all", false)) {
      g_context_mode_default = mode;
      g_context_items_default = items;
      targets = all_controls();
    } else {
      Target t;
      if (!resolve_target(c, &t)) return;
      targets.push_back(control_of(t.wv));
    }
    for (Control *s : targets) {
      s->contextMode = mode;
      s->contextItems = items;
      if (c->has("editMenu")) s->editMenu = c->flag("editMenu", true);
    }
    c->ok(json{{"mode", mode}});
  });
  op("getContextMenu", [](CallPtr c, Target &t, Control *s) {
    c->ok(json{{"mode", s->contextMode}, {"editMenu", s->editMenu}, {"debug", (bool)webkit_settings_get_enable_developer_extras(webkit_web_view_get_settings(t.wv))}, {"items", s->contextItems}});
  });
  // The last menu, before and after the policy: WebKit's stock actions by number, custom items by label.
  op("_contextMenuForTesting", [](CallPtr c, Target &, Control *s) {
    if (!test_channel()) return c->fail("denied", "Only available to the test channel");
    c->ok(s->lastMenu);
  });

  // -- JavaScript dialogs
  op("respondToDialog", [](CallPtr c, Target &, Control *s) {
    if (!s->dialog) return c->fail("unavailable", "webview.respondToDialog: no JavaScript dialog is open");
    std::string type = s->dialogType;
    if (c->has("text") && s->dialogEntry) gtk_entry_set_text(GTK_ENTRY(s->dialogEntry), c->str("text").c_str());
    gtk_dialog_response(GTK_DIALOG(s->dialogWidget), c->flag("accept", true) ? GTK_RESPONSE_OK : GTK_RESPONSE_CANCEL);
    c->ok(json{{"type", type}});
  });
  op("getDialog", [](CallPtr c, Target &, Control *s) { c->ok(s->dialog ? json{{"type", s->dialogType}, {"message", s->dialogMessage}} : json(nullptr)); });

  // -- media and lifecycle
  op("setAudioMuted", [](CallPtr c, Target &t, Control *) {
    webkit_web_view_set_is_muted(t.wv, c->flag("muted", true));
    c->ok();
  });
  op("pauseMedia", [](CallPtr c, Target &t, Control *) { eval_to_json(t.wv, "window.__shellMedia&&window.__shellMedia.pause();null", c, "webview.pauseMedia"); });
  op("getMediaState", [](CallPtr c, Target &t, Control *) {
    static const auto capture = [](WebKitMediaCaptureState st) { return st == WEBKIT_MEDIA_CAPTURE_STATE_ACTIVE ? "active" : st == WEBKIT_MEDIA_CAPTURE_STATE_MUTED ? "muted" : "none"; };
    bool muted = webkit_web_view_get_is_muted(t.wv), playing = webkit_web_view_is_playing_audio(t.wv);
    struct Ctx {
      CallPtr c;
      json out;
      bool playing;
    };
    auto *x = new Ctx{c, json{{"camera", capture(webkit_web_view_get_camera_capture_state(t.wv))}, {"microphone", capture(webkit_web_view_get_microphone_capture_state(t.wv))},
                              {"muted", muted}, {"audible", playing && !muted}}, playing};
    static const char *js = "window.__shellMedia?window.__shellMedia.playback():'none'";
    webkit_web_view_evaluate_javascript(t.wv, js, -1, nullptr, nullptr, nullptr, [](GObject *src, GAsyncResult *res, gpointer data) {
      auto *x = static_cast<Ctx *>(data);
      JSCValue *v = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(src), res, nullptr);
      char *playback = v && jsc_value_is_string(v) ? jsc_value_to_string(v) : nullptr;
      x->out["playback"] = x->playing ? "playing" : playback ? playback : "none";
      g_free(playback);
      if (v) g_object_unref(v);
      x->c->ok(x->out);
      delete x;
    }, x);
  });
  op("setBackgroundThrottling", [](CallPtr c, Target &t, Control *s) {
    s->throttling = c->flag("enabled", true);
    set_throttling(t.wv, s->throttling);
    c->ok();
  });
  op("setRecovery", [](CallPtr c, Target &, Control *s) {
    std::string policy = c->str("recovery");
    if (policy != "reload" && policy != "manual") return c->fail("invalid_args", "recovery must be reload or manual");
    s->recovery = policy;
    c->ok();
  });
  op("_terminateForTesting", [](CallPtr c, Target &t, Control *) {
    if (!test_channel()) return c->fail("denied", "Only available to the test channel");
    webkit_web_view_terminate_web_process(t.wv);
    c->ok();
  });

  // -- file drop
  reg("webview", "setFileDrop", [](CallPtr c) {
    if (!c->has("enabled")) return c->fail("invalid_args", "webview.setFileDrop: `enabled` is required");
    bool enabled = c->flag("enabled", true);
    std::vector<Control *> targets;
    if (c->flag("all", false)) {
      g_file_drop_default = enabled;
      targets = all_controls();
    } else {
      Target t;
      if (!resolve_target(c, &t)) return;
      targets.push_back(control_of(t.wv));
    }
    for (Control *s : targets) s->fileDrop = enabled;
    c->ok(json{{"enabled", enabled}});
  });
}

} // namespace lx
} // namespace sd
