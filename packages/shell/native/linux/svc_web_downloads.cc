// webview.* downloads, printing and website data on WebKitGTK, same ops, records and events as
// native/webview_downloads.h and the print and clearData ops of platform_webview.mm:
//   setDownloadDirectory · getDownloadDirectory · download · setDownloadHandler · clearDownloadHandler
//   decideDownload · pauseDownload · resumeDownload · cancelDownload · getDownload · listDownloads
//   print · printToPDF · getPrinters · clearData
// Events: downloadRequested, downloadStarted, downloadProgress, downloadFinished, downloadFailed,
// downloadChanged, printFinished.
//
// Where WebKitGTK differs:
// - WebKitDownload can't pause, has no resume data, and takes no request headers: there's no way to
//   ask a server for the rest of a file. Pause cancels the transfer, WebKit deletes the partial file,
//   and resume downloads the whole file again to the same destination (a GET over http(s) only,
//   anything else ends `interrupted`). `resumeBytes` is always 0, `resumeData` is never set, and it
//   works after a relaunch, since all it needs is the URL.
// - An HTTP status from 400 up ends `interrupted`, as on Windows, instead of saving the error page.
//   A connection closed before the Content-Length ends `interrupted` too, which WebKit calls finished.
// - Printing goes through GTK's print backends: a PDF needs its "Print to File" printer, which
//   getPrinters doesn't list, since it isn't a printer anyone installed.
#include <algorithm>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <glib/gstdio.h>
#include <gtk/gtkunixprint.h>

#include "linux.hpp"

namespace sd {
namespace lx {

static void run_after(guint ms, std::function<void()> fn) {
  g_timeout_add_full(G_PRIORITY_DEFAULT, ms, [](gpointer d) -> gboolean {
    (*static_cast<std::function<void()> *>(d))();
    return G_SOURCE_REMOVE;
  }, new std::function<void()>(std::move(fn)), [](gpointer d) { delete static_cast<std::function<void()> *>(d); });
}

static std::string expand_home(const std::string &p) {
  if (p == "~") return g_get_home_dir();
  if (p.rfind("~/", 0) == 0) return std::string(g_get_home_dir()) + p.substr(1);
  return p;
}

static int native_id_of(WebKitWebView *wv) {
  for (int id : backend_page_ids())
    if (webview_for(id) == wv) return id;
  return 0;
}

// A history file or a caller can hold anything: json::value() would throw on the wrong type.
static std::string text_of(const json &o, const char *key) {
  auto it = o.find(key);
  return it != o.end() && it->is_string() ? it->get<std::string>() : "";
}
static double number_of(const json &o, const char *key, double fallback) {
  auto it = o.find(key);
  return it != o.end() && it->is_number() ? it->get<double>() : fallback;
}

static std::string scheme_of_url(const std::string &url) {
  char *s = g_uri_parse_scheme(url.c_str());
  std::string out = s ? s : "";
  g_free(s);
  return out;
}

using TargetOp = std::function<void(CallPtr, Target &)>;
static void target_op(const std::string &name, TargetOp body) {
  reg("webview", name, [body](CallPtr c) {
    Target t;
    if (resolve_target(c, &t)) body(c, t);
  });
}

// ===========================================================================
// Downloads

struct Download {
  std::string id, url, path, explicitPath, filename, state = "requested", error, handlerId, mime, failure;
  std::string stopAs; // pause or cancel asked: what the end of the transfer means
  bool hasMime = false, holding = false, failed = false;
  bool encoded = false;     // Content-Encoding: the length is the server's, what's saved is decoded
  bool restarted = false;   // resumed: the destination is already chosen
  bool restartable = false; // a GET over http(s): downloading it again is the same download
  json source = json::object();
  WebKitDownload *op = nullptr; // this run, until it ends
  int64_t received = 0, total = -1;
  double startedAt = 0, updatedAt = 0;
  gint64 lastProgress = 0;
  CallPtr waiter; // pause / cancel with a final record to answer
};

static std::map<std::string, Download *> g_downloads;
static std::string g_handler, g_dir;
static const size_t kHistory = 200;

static double now_ms() { return std::floor((double)g_get_real_time() / 1000); }
static bool active(const Download *d) { return d->state == "requested" || d->state == "downloading" || d->state == "pausing" || d->state == "finishing"; }
static bool can_resume(const Download *d) { return !d->op && d->restartable && !d->path.empty() && (d->state == "paused" || d->state == "interrupted"); }

static json with_source(const Download *d, json extra = json::object()) {
  json m = d->source;
  m["id"] = d->id;
  m["url"] = d->url;
  if (!d->path.empty()) m["path"] = d->path;
  for (auto &[k, v] : extra.items()) m[k] = v;
  return m;
}

static json snapshot(const Download *d) {
  double fraction = d->state == "completed" ? 1 : d->total > 0 ? std::min(1.0, (double)d->received / (double)d->total) : -1;
  bool resumable = can_resume(d);
  json m = with_source(d, json{{"state", d->state},
                               {"suggestedFilename", d->filename},
                               {"mimeType", d->hasMime ? json(d->mime) : json(nullptr)},
                               {"receivedBytes", d->received},
                               {"totalBytes", d->total},
                               {"fraction", fraction},
                               {"canResume", resumable},
                               {"startedAt", d->startedAt},
                               {"updatedAt", d->updatedAt}});
  if (resumable) m["resumeBytes"] = 0; // resuming starts the file over
  if (!d->error.empty()) m["error"] = d->error;
  return m;
}

static std::string history_path() { return std::string(g_get_user_data_dir()) + "/" + app_identifier() + "/downloads.json"; }

static std::vector<Download *> newest_first() {
  std::vector<Download *> all;
  for (auto &[id, d] : g_downloads) all.push_back(d);
  std::sort(all.begin(), all.end(), [](auto *a, auto *b) { return a->startedAt > b->startedAt; });
  return all;
}

static void save_history() {
  json items = json::array();
  auto all = newest_first();
  for (size_t i = 0; i < all.size() && i < kHistory; i++) {
    json item = snapshot(all[i]);
    item["restartable"] = all[i]->restartable;
    items.push_back(item);
  }
  std::string file = history_path();
  gchar *dir = g_path_get_dirname(file.c_str());
  g_mkdir_with_parents(dir, 0700);
  g_free(dir);
  // URLs can carry tokens.
  g_file_set_contents_full(file.c_str(), items.dump().c_str(), -1, G_FILE_SET_CONTENTS_CONSISTENT, 0600, nullptr);
}

static void load_history() {
  static bool loaded = false;
  if (loaded) return;
  loaded = true;
  gchar *text = nullptr;
  json items = json::array();
  if (g_file_get_contents(history_path().c_str(), &text, nullptr, nullptr)) items = json::parse(text, nullptr, false);
  g_free(text);
  if (!items.is_array()) return;
  for (auto &m : items) {
    if (!m.is_object() || !m.contains("id") || !m["id"].is_string() || !m.contains("url") || !m["url"].is_string()) continue;
    auto *d = new Download;
    d->id = m["id"];
    d->url = m["url"];
    d->path = text_of(m, "path");
    d->filename = text_of(m, "suggestedFilename");
    if (m.contains("mimeType") && m["mimeType"].is_string()) d->mime = m["mimeType"], d->hasMime = true;
    d->state = m.contains("state") ? text_of(m, "state") : "interrupted";
    d->restartable = m.contains("restartable") && m["restartable"].is_boolean() && m["restartable"].get<bool>();
    // Its transfer went with the last run, and what it had written with it.
    if (active(d)) {
      d->state = "interrupted";
      if (!d->path.empty()) g_unlink((d->path + ".wkdownload").c_str());
    }
    d->received = (int64_t)number_of(m, "receivedBytes", 0);
    d->total = (int64_t)number_of(m, "totalBytes", -1);
    d->startedAt = number_of(m, "startedAt", 0);
    d->updatedAt = number_of(m, "updatedAt", 0);
    d->error = text_of(m, "error");
    for (const char *key : {"windowId", "popoverId", "viewId"})
      if (m.contains(key)) d->source[key] = m[key];
    g_downloads[d->id] = d;
  }
}

static void changed(Download *d) {
  d->updatedAt = now_ms();
  save_history();
  emit("downloadChanged", snapshot(d));
}

static Download *find_download(const CallPtr &c) {
  load_history();
  auto it = g_downloads.find(c->str("id"));
  return it == g_downloads.end() ? nullptr : it->second;
}

// ---- paths -----------------------------------------------------------------

static std::string download_dir() { return g_dir.empty() ? user_dir(G_USER_DIRECTORY_DOWNLOAD, "Downloads") : g_dir; }

static std::string path_key(const std::string &path) {
  gchar *full = g_canonicalize_filename(path.c_str(), nullptr);
  gchar *dir = g_path_get_dirname(full), *base = g_path_get_basename(full);
  char real[PATH_MAX];
  std::string out = std::string(realpath(dir, real) ? real : dir) + "/" + base;
  g_free(full);
  g_free(dir);
  g_free(base);
  return out;
}

static bool path_busy(const std::string &path, const Download *except) {
  std::string key = path_key(path);
  for (auto &[id, other] : g_downloads)
    if (other != except && !other->path.empty() && active(other) && path_key(other->path) == key) return true;
  return false;
}

static std::string unique_path(const std::string &dir, const std::string &name) {
  std::string candidate = dir + "/" + name;
  auto dot = name.rfind('.');
  std::string stem = dot == std::string::npos || dot == 0 ? name : name.substr(0, dot), ext = stem.size() == name.size() ? "" : name.substr(dot);
  for (int i = 1; g_file_test(candidate.c_str(), G_FILE_TEST_EXISTS) || path_busy(candidate, nullptr); i++)
    candidate = dir + "/" + stem + " (" + std::to_string(i) + ")" + ext;
  return candidate;
}

// ---- transfers -------------------------------------------------------------

static void drop_operation(Download *d) {
  if (!d->op) return;
  g_signal_handlers_disconnect_by_data(d->op, d);
  g_clear_object(&d->op);
}

static void answer_waiter(Download *d) {
  if (!d->waiter) return;
  CallPtr c = std::move(d->waiter);
  d->waiter = nullptr;
  c->ok(snapshot(d));
}

/// Refuse the destination: the transfer doesn't begin. WebKit may still report on it: not to us.
static void refuse(Download *d, const std::string &state, const std::string &error, bool canceled) {
  d->holding = false;
  d->state = state;
  d->error = canceled ? "" : error;
  WebKitDownload *op = d->op;
  g_signal_handlers_disconnect_by_data(op, d);
  d->op = nullptr;
  g_signal_connect(op, "finished", G_CALLBACK(+[](WebKitDownload *o, gpointer) { g_object_unref(o); }), nullptr);
  webkit_download_cancel(op);
  changed(d);
  emit("downloadFailed", with_source(d, json{{"error", error}, {"canceled", canceled}, {"canResume", can_resume(d)}}));
  answer_waiter(d);
}

static void set_destination(Download *d, const std::string &path, bool replace) {
  gchar *uri = g_filename_to_uri(path.c_str(), nullptr, nullptr);
  webkit_download_set_allow_overwrite(d->op, replace);
  webkit_download_set_destination(d->op, uri);
  g_free(uri);
}

static void choose(Download *d, const json &decision) {
  d->holding = false;
  if (decision.is_string() && decision.get<std::string>() == "cancel") return refuse(d, "canceled", "canceled before saving", true);
  std::string path = expand_home(decision.is_object() ? text_of(decision, "path") : d->explicitPath);
  bool replace = !path.empty();
  if (path.empty()) {
    gchar *base = g_path_get_basename(d->filename.empty() ? "download" : d->filename.c_str());
    std::string name = base;
    g_free(base);
    if (name.empty() || name[0] == '.' || name == "/") name = "download" + (name == "/" ? "" : name);
    path = unique_path(download_dir(), name);
  }
  if (path_busy(path, d)) return refuse(d, "interrupted", "download destination is in use by another transfer", false);
  if (g_file_test(path.c_str(), G_FILE_TEST_IS_DIR)) return refuse(d, "interrupted", "download destination is a directory", false);
  gchar *dir = g_path_get_dirname(path.c_str());
  int made = g_mkdir_with_parents(dir, 0755), why = errno;
  g_free(dir);
  if (made != 0) return refuse(d, "interrupted", std::string("destination unavailable: ") + g_strerror(why), false);
  d->path = path;
  d->state = "downloading";
  set_destination(d, path, replace);
  changed(d);
  emit("downloadStarted", snapshot(d));
}

static gboolean on_decide_destination(WebKitDownload *op, gchar *suggested, Download *d) {
  if (!d->stopAs.empty()) return TRUE; // canceled on its way here: it ends in `failed`
  WebKitURIResponse *response = webkit_download_get_response(op);
  guint status = response ? webkit_uri_response_get_status_code(response) : 0;
  guint64 length = response ? webkit_uri_response_get_content_length(response) : 0;
  const char *mime = response ? webkit_uri_response_get_mime_type(response) : nullptr;
  d->total = length > 0 ? (int64_t)length : -1; // 0 is what it says when it doesn't know
  SoupMessageHeaders *headers = response ? webkit_uri_response_get_http_headers(response) : nullptr;
  d->encoded = headers && soup_message_headers_get_one(headers, "Content-Encoding");
  d->filename = suggested ? suggested : "";
  d->hasMime = mime && *mime;
  d->mime = d->hasMime ? mime : "";
  // WebKit would save the error page as the file.
  if (status >= 400) {
    refuse(d, "interrupted", "the server answered " + std::to_string(status), false);
    return TRUE;
  }
  if (d->restarted) {
    d->restarted = false;
    set_destination(d, d->path, true);
    changed(d);
    return TRUE;
  }
  if (g_handler.empty()) {
    choose(d, json("default"));
    return TRUE;
  }
  d->holding = true;
  d->handlerId = g_handler;
  changed(d);
  emit("downloadRequested", with_source(d, json{{"handlerId", d->handlerId},
                                                {"suggestedFilename", d->filename},
                                                {"mimeType", d->hasMime ? json(d->mime) : json(nullptr)},
                                                {"size", d->total}}));
  // A lost page or handler must never silently authorize a destination.
  std::string id = d->id, handler = d->handlerId;
  run_after(30000, [id, handler] {
    auto it = g_downloads.find(id);
    if (it != g_downloads.end() && it->second->holding && it->second->handlerId == handler) choose(it->second, json("cancel"));
  });
  return TRUE; // WebKit waits for webkit_download_set_destination
}

static void on_received(WebKitDownload *op, guint64, Download *d) {
  d->received = (int64_t)webkit_download_get_received_data_length(op);
  gint64 now = g_get_monotonic_time();
  if (now - d->lastProgress < 250000 || d->state != "downloading") return; // the raw signal comes with every chunk
  d->lastProgress = now;
  d->updatedAt = now_ms();
  json s = snapshot(d);
  emit("downloadProgress", s);
  emit("downloadChanged", s);
}

static void on_failed(WebKitDownload *, GError *error, Download *d) {
  d->failed = true;
  d->failure = error && error->message ? error->message : "download failed";
}

// Comes after `failed` too, so that's where a transfer ends either way.
static void on_finished(WebKitDownload *op, Download *d) {
  d->received = std::max<int64_t>(d->received, (int64_t)webkit_download_get_received_data_length(op));
  bool failed = d->failed;
  std::string failure = d->failure, stop = d->stopAs;
  d->failed = false;
  d->failure.clear();
  d->stopAs.clear();
  drop_operation(d);
  GStatBuf st;
  if (!failed && g_stat(d->path.c_str(), &st) == 0) d->received = (int64_t)st.st_size;
  // A server that hangs up early with a Content-Length still ends in `finished` here.
  if (!failed && d->total > 0 && d->received < d->total && !d->encoded) {
    g_unlink(d->path.c_str());
    failed = true;
    failure = "the connection closed after " + std::to_string(d->received) + " of " + std::to_string(d->total) + " bytes";
  }
  if (!failed) {
    d->state = "completed";
    d->error.clear();
    changed(d);
    emit("downloadFinished", with_source(d, json{{"bytes", d->received}}));
    return answer_waiter(d);
  }
  if (stop == "canceled") {
    d->state = "canceled";
    d->error.clear();
  } else if (stop == "paused") {
    d->state = d->restartable && !d->path.empty() ? "paused" : "interrupted";
    d->error = d->state == "paused" ? "" : d->restartable ? "paused before it had a destination" : "only a GET over http(s) can start again";
  } else {
    d->state = "interrupted";
    d->error = failure;
  }
  bool canceled = !stop.empty();
  std::string reported = !d->error.empty() ? d->error : stop;
  changed(d);
  emit("downloadFailed", with_source(d, json{{"error", reported}, {"canceled", canceled}, {"canResume", can_resume(d)}}));
  answer_waiter(d);
}

static void attach_operation(Download *d, WebKitDownload *op) {
  d->op = op;
  g_object_set_data(G_OBJECT(op), "sd-download", d);
  g_signal_connect(op, "decide-destination", G_CALLBACK(on_decide_destination), d);
  g_signal_connect(op, "received-data", G_CALLBACK(on_received), d);
  g_signal_connect(op, "failed", G_CALLBACK(on_failed), d);
  g_signal_connect(op, "finished", G_CALLBACK(on_finished), d);
}

/// Takes `op`'s reference.
static Download *adopt(WebKitDownload *op, const json &source, const std::string &explicitPath) {
  load_history();
  auto *d = new Download;
  gchar *uuid = g_uuid_string_random();
  d->id = std::string("dl-") + uuid;
  g_free(uuid);
  WebKitURIRequest *request = webkit_download_get_request(op);
  const char *uri = request ? webkit_uri_request_get_uri(request) : nullptr;
  const char *method = request ? webkit_uri_request_get_http_method(request) : nullptr;
  d->url = uri ? uri : "";
  std::string scheme = scheme_of_url(d->url);
  d->restartable = (scheme == "http" || scheme == "https") && (!method || strcmp(method, "GET") == 0);
  d->source = source;
  d->explicitPath = explicitPath;
  d->startedAt = now_ms();
  attach_operation(d, op);
  g_downloads[d->id] = d;
  changed(d);
  return d;
}

static void on_download_started(WebKitWebContext *, WebKitDownload *op, gpointer) {
  if (g_object_get_data(G_OBJECT(op), "sd-download")) return; // webview.download, a resume: ours already
  WebKitWebView *wv = webkit_download_get_web_view(op);
  int id = wv ? native_id_of(wv) : 0;
  adopt(WEBKIT_DOWNLOAD(g_object_ref(op)), id ? source_of(id) : json::object(), "");
}

bool web_response_download(WebKitPolicyDecision *d) {
  // What a view can't show is a download on the other platforms; WebKit's default ignores it.
  if (webkit_response_policy_decision_is_mime_type_supported(WEBKIT_RESPONSE_POLICY_DECISION(d))) return false;
  webkit_policy_decision_download(d);
  return true;
}

static void cancel_download(CallPtr c, bool pause) {
  Download *d = find_download(c);
  if (!d) return c->fail("invalid_args", "unknown download id");
  bool wantSnapshot = pause || c->flag("snapshot", false);
  if (d->holding) {
    choose(d, json("cancel"));
    return wantSnapshot ? c->ok(snapshot(d)) : c->ok();
  }
  if (!d->op || !d->stopAs.empty()) return c->fail("unavailable", "download is not transferring");
  d->stopAs = pause ? "paused" : "canceled";
  d->state = "pausing";
  changed(d);
  if (wantSnapshot) {
    d->waiter = c;
    run_after(5000, [id = d->id] {
      auto it = g_downloads.find(id);
      if (it != g_downloads.end()) answer_waiter(it->second); // the record as it stands
    });
  } else c->ok();
  webkit_download_cancel(d->op);
}

static void cancel_held() {
  for (auto &[id, d] : g_downloads)
    if (d->holding) choose(d, json("cancel"));
}

static void register_downloads() {
  reg("webview", "setDownloadDirectory", [](CallPtr c) {
    std::string path = expand_home(c->str("path"));
    if (path.empty()) {
      g_dir.clear();
      return c->ok(json{{"path", download_dir()}});
    }
    if (g_mkdir_with_parents(path.c_str(), 0755) != 0) return c->fail("denied", std::string("webview.setDownloadDirectory: ") + g_strerror(errno));
    g_dir = path;
    c->ok(json{{"path", path}});
  });
  reg("webview", "getDownloadDirectory", [](CallPtr c) { c->ok(json{{"path", download_dir()}}); });
  target_op("download", [](CallPtr c, Target &t) {
    std::string raw = c->str("url"), path = expand_home(c->str("path")), url = raw;
    // Relative URLs mean what they mean in the page.
    if (!raw.empty() && scheme_of_url(raw).empty()) {
      const char *base = webkit_web_view_get_uri(t.wv);
      gchar *full = base ? g_uri_resolve_relative(base, raw.c_str(), G_URI_FLAGS_NONE, nullptr) : nullptr;
      url = full ? full : "";
      g_free(full);
    }
    std::string scheme = scheme_of_url(url);
    if (scheme != "http" && scheme != "https" && scheme != "blob" && scheme != "data")
      return c->fail("invalid_args", "webview.download: `url` must be an http(s), blob: or data: URL");
    if (!path.empty() && !g_path_is_absolute(path.c_str())) return c->fail("invalid_args", "download path must be absolute");
    Download *d = adopt(webkit_web_view_download_uri(t.wv, url.c_str()), t.source, path);
    c->ok(json{{"id", d->id}, {"url", d->url}});
  });
  reg("webview", "setDownloadHandler", [](CallPtr c) {
    std::string ident = c->str("handlerId");
    if (ident.empty()) return c->fail("invalid_args", "handlerId required");
    load_history();
    cancel_held();
    g_handler = ident;
    c->ok();
  });
  reg("webview", "clearDownloadHandler", [](CallPtr c) {
    if (g_handler == c->str("handlerId")) {
      g_handler.clear();
      cancel_held();
    }
    c->ok();
  });
  reg("webview", "decideDownload", [](CallPtr c) {
    Download *d = find_download(c);
    if (!d || !d->holding || d->handlerId != c->str("handlerId")) return c->fail("unavailable", "download request expired");
    json decision = c->args.contains("decision") ? c->args["decision"] : json();
    bool valid = decision.is_string() && (decision.get<std::string>() == "default" || decision.get<std::string>() == "cancel");
    if (decision.is_object()) {
      std::string path = expand_home(text_of(decision, "path"));
      valid = !path.empty() && g_path_is_absolute(path.c_str());
    }
    choose(d, valid ? decision : json("cancel"));
    valid ? c->ok() : c->fail("invalid_args", "decision must be default, cancel or an absolute path");
  });
  reg("webview", "pauseDownload", [](CallPtr c) { cancel_download(c, true); });
  reg("webview", "cancelDownload", [](CallPtr c) { cancel_download(c, false); });
  target_op("resumeDownload", [](CallPtr c, Target &t) {
    Download *d = find_download(c);
    if (!d) return c->fail("invalid_args", "unknown download id");
    if (!can_resume(d)) return c->fail("unavailable", "download is active or cannot start again (a GET over http(s) with a destination)");
    if (path_busy(d->path, d)) return c->fail("unavailable", "download destination is in use by another transfer");
    d->restarted = true;
    d->received = 0;
    d->error.clear();
    d->source = t.source;
    d->state = "downloading";
    attach_operation(d, webkit_web_view_download_uri(t.wv, d->url.c_str()));
    changed(d);
    c->ok(snapshot(d));
  });
  reg("webview", "getDownload", [](CallPtr c) {
    Download *d = find_download(c);
    c->ok(d ? snapshot(d) : json(nullptr));
  });
  reg("webview", "listDownloads", [](CallPtr c) {
    load_history();
    json items = json::array();
    for (Download *d : newest_first()) items.push_back(snapshot(d));
    c->ok(items);
  });
}

// ===========================================================================
// Printing: options validated as in webview_print.h

static bool print_number(const json &o, const char *key, double min, double max) {
  auto it = o.find(key);
  if (it == o.end() || !it->is_number()) return false;
  double v = it->get<double>();
  return std::isfinite(v) && v >= min && v <= max;
}

static bool whole(const json &o, const char *key) {
  double v = o[key].get<double>();
  return v == std::floor(v);
}

struct PrintSpec {
  GtkPrintSettings *settings = nullptr;
  GtkPageSetup *setup = nullptr;
  std::string printer;
  int expectedPages = 0; // what pageRanges asked for
  ~PrintSpec() {
    g_clear_object(&settings);
    g_clear_object(&setup);
  }
};

static bool print_spec(const json &o, bool pdf, PrintSpec *s, std::string *error) {
  s->settings = gtk_print_settings_new();
  s->setup = gtk_page_setup_new();
  if (o.contains("printer")) {
    if (!o["printer"].is_string() || o["printer"].get<std::string>().empty()) return *error = "printer must name an installed printer", false;
    s->printer = o["printer"].get<std::string>();
  }
  if (o.contains("copies")) {
    if (!print_number(o, "copies", 1, 9999) || !whole(o, "copies")) return *error = "copies must be an integer from 1 to 9999", false;
    if (!pdf) gtk_print_settings_set_n_copies(s->settings, (int)o["copies"].get<double>());
  }
  if (o.contains("paperSize")) {
    const json &paper = o["paperSize"];
    if (!paper.is_object() || !print_number(paper, "width", 1, 14400) || !print_number(paper, "height", 1, 14400))
      return *error = "paperSize needs positive width and height in points (maximum 14400)", false;
    GtkPaperSize *size = gtk_paper_size_new_custom("kitop", "kitop", paper["width"].get<double>(), paper["height"].get<double>(), GTK_UNIT_POINTS);
    gtk_page_setup_set_paper_size(s->setup, size);
    gtk_paper_size_free(size);
  }
  if (o.contains("orientation")) {
    std::string orientation = o["orientation"].is_string() ? o["orientation"].get<std::string>() : "";
    if (orientation != "portrait" && orientation != "landscape") return *error = "orientation must be portrait or landscape", false;
    gtk_page_setup_set_orientation(s->setup, orientation == "landscape" ? GTK_PAGE_ORIENTATION_LANDSCAPE : GTK_PAGE_ORIENTATION_PORTRAIT);
  }
  if (o.contains("margins")) {
    const json &margins = o["margins"];
    if (!margins.is_object()) return *error = "margins must contain top, right, bottom and left in points", false;
    for (const char *key : {"top", "right", "bottom", "left"})
      if (!print_number(margins, key, 0, 14400)) return *error = "all margins must be nonnegative points", false;
    gtk_page_setup_set_top_margin(s->setup, margins["top"].get<double>(), GTK_UNIT_POINTS);
    gtk_page_setup_set_right_margin(s->setup, margins["right"].get<double>(), GTK_UNIT_POINTS);
    gtk_page_setup_set_bottom_margin(s->setup, margins["bottom"].get<double>(), GTK_UNIT_POINTS);
    gtk_page_setup_set_left_margin(s->setup, margins["left"].get<double>(), GTK_UNIT_POINTS);
  }
  if (gtk_page_setup_get_page_width(s->setup, GTK_UNIT_POINTS) <= 0 || gtk_page_setup_get_page_height(s->setup, GTK_UNIT_POINTS) <= 0)
    return *error = "margins leave no printable area", false;
  if (o.contains("pageRanges")) {
    const json &ranges = o["pageRanges"];
    if (!ranges.is_array() || ranges.empty()) return *error = "pageRanges must be a nonempty array", false;
    std::vector<GtkPageRange> pages;
    int previous = 0;
    for (const json &range : ranges) {
      if (!range.is_object() || !print_number(range, "from", 1, INT_MAX) || !print_number(range, "to", 1, INT_MAX) || !whole(range, "from") || !whole(range, "to") ||
          (int)range["from"].get<double>() <= previous || range["to"].get<double>() < range["from"].get<double>())
        return *error = "pageRanges must be ascending, nonoverlapping, one-based inclusive integer ranges", false;
      int from = (int)range["from"].get<double>(), to = (int)range["to"].get<double>();
      previous = to;
      pages.push_back(GtkPageRange{from - 1, to - 1});
      s->expectedPages += to - from + 1;
    }
    if (!pdf && pages.size() != 1) return *error = "physical printing accepts one contiguous page range", false;
    gtk_print_settings_set_print_pages(s->settings, GTK_PRINT_PAGES_RANGES);
    gtk_print_settings_set_page_ranges(s->settings, pages.data(), (int)pages.size());
  }
  return true;
}

using PrinterList = std::function<void(const std::vector<std::string> &, const std::string &)>;

/// The printers GTK's backends know, and the default one. Not "Print to File": nobody installed it.
static void list_printers(PrinterList done) {
  struct Listing {
    std::vector<GtkPrinter *> printers;
    PrinterList done;
  };
  gtk_enumerate_printers(+[](GtkPrinter *p, gpointer data) -> gboolean {
    if (!gtk_printer_is_virtual(p)) static_cast<Listing *>(data)->printers.push_back(GTK_PRINTER(g_object_ref(p)));
    return FALSE;
  }, new Listing{{}, std::move(done)}, +[](gpointer data) {
    auto *l = static_cast<Listing *>(data);
    std::vector<std::string> names;
    std::string preferred;
    for (GtkPrinter *p : l->printers) {
      names.push_back(gtk_printer_get_name(p));
      if (gtk_printer_is_default(p)) preferred = names.back(); // known only once the list is done
      g_object_unref(p);
    }
    l->done(names, preferred);
    delete l;
  }, FALSE);
}

// Pages a PDF has: the page objects Skia and cairo's older files write in the clear. 0: can't tell.
static int pdf_pages(const std::string &bytes) {
  static const std::string key = "/Type /Page";
  int pages = 0;
  for (size_t at = bytes.find(key); at != std::string::npos; at = bytes.find(key, at + key.size()))
    if (bytes.compare(at + key.size(), 1, "s") != 0) pages++;
  return pages;
}

static void print_finished(int id, bool success, const std::string &path) {
  json d = id && webview_for(id) ? source_of(id) : json::object();
  d["success"] = success;
  if (!path.empty()) d["path"] = path;
  emit("printFinished", d);
}

struct PrintJob {
  CallPtr c;
  int id = 0;
  std::string pdf, temp, error;
  int expectedPages = 0;
  bool failed = false;
};

static bool settle_pdf(PrintJob *job) {
  gchar *bytes = nullptr;
  gsize size = 0;
  bool ok = g_file_get_contents(job->temp.c_str(), &bytes, &size, nullptr) && size > 4 && memcmp(bytes, "%PDF", 4) == 0;
  if (!ok) job->error = "no PDF was written";
  if (ok && job->expectedPages) {
    // WebKit quietly drops what's past the end of the document.
    int pages = pdf_pages(std::string(bytes, size));
    if (pages && pages < job->expectedPages) ok = false, job->error = "pageRanges go past the end of the document";
  }
  g_free(bytes);
  if (ok && g_rename(job->temp.c_str(), job->pdf.c_str()) != 0) ok = false, job->error = g_strerror(errno);
  g_unlink(job->temp.c_str());
  return ok;
}

static void on_print_done(WebKitPrintOperation *op, PrintJob *job) {
  g_signal_handlers_disconnect_by_data(op, job); // a job past the end of the document says so more than once
  bool ok = !job->failed;
  if (!job->pdf.empty()) ok = settle_pdf(job) && ok;
  print_finished(job->id, ok, job->pdf);
  CallPtr c = job->c;
  if (!ok) c->fail("unavailable", "webview." + c->op + ": the print job failed" + (job->error.empty() ? "" : ": " + job->error));
  else if (c->op == "printToPDF") c->ok(json{{"path", job->pdf}});
  else if (!job->pdf.empty()) c->ok(json{{"success", true}, {"path", job->pdf}});
  else c->ok(json{{"success", true}});
  delete job;
  g_object_unref(op);
}

static void run_job(CallPtr c, Target &t, PrintSpec &spec, const std::string &pdf, const std::string &temp) {
  auto *job = new PrintJob{c, native_id_of(t.wv), pdf, temp, "", spec.expectedPages};
  WebKitPrintOperation *op = webkit_print_operation_new(t.wv);
  webkit_print_operation_set_print_settings(op, spec.settings);
  webkit_print_operation_set_page_setup(op, spec.setup);
  g_signal_connect(op, "failed", G_CALLBACK(+[](WebKitPrintOperation *, GError *error, PrintJob *j) {
    j->failed = true;
    if (error) j->error = error->message;
  }), job);
  g_signal_connect(op, "finished", G_CALLBACK(on_print_done), job);
  webkit_print_operation_print(op);
}

static void print_pdf(CallPtr c, Target &t, const std::string &path, const json &options) {
  PrintSpec spec;
  std::string error;
  if (!print_spec(options, true, &spec, &error)) return c->fail("invalid_args", error);
  // Written beside the destination, moved there once it's known to be good.
  gchar *dir = g_path_get_dirname(path.c_str()), *uuid = g_uuid_string_random();
  std::string temp = std::string(dir) + "/.sd-print-" + uuid + ".pdf";
  g_free(dir);
  g_free(uuid);
  gchar *uri = g_filename_to_uri(temp.c_str(), nullptr, nullptr);
  if (!uri) return c->fail("invalid_args", "webview." + c->op + ": the path must be absolute");
  gtk_print_settings_set_printer(spec.settings, "Print to File");
  gtk_print_settings_set(spec.settings, GTK_PRINT_SETTINGS_OUTPUT_FILE_FORMAT, "pdf");
  gtk_print_settings_set(spec.settings, GTK_PRINT_SETTINGS_OUTPUT_URI, uri);
  g_free(uri);
  run_job(c, t, spec, path, temp);
}

static std::set<WebKitWebView *> g_print_dialogs; // a view shows one at a time, as a sheet does

struct DialogJob {
  int id = 0;
  bool failed = false;
};

static void on_dialog_failed(WebKitPrintOperation *, GError *, DialogJob *job) { job->failed = true; }

static void on_dialog_finished(WebKitPrintOperation *op, DialogJob *job) {
  g_signal_handlers_disconnect_by_data(op, job);
  print_finished(job->id, !job->failed, "");
  delete job;
  g_object_unref(op);
}

// The print dialog blocks in a main loop of its own, and only its window, as a sheet does.
static void run_dialog(WebKitWebView *wv, WebKitPrintOperation *op) {
  g_print_dialogs.insert(wv);
  g_object_ref(wv);
  GtkWidget *top = gtk_widget_get_toplevel(GTK_WIDGET(wv));
  GtkWindow *parent = GTK_IS_WINDOW(top) ? GTK_WINDOW(top) : nullptr;
  if (parent) {
    GtkWindowGroup *group = gtk_window_group_new();
    gtk_window_group_add_window(group, parent);
    g_object_unref(group);
  }
  auto *job = new DialogJob{native_id_of(wv)};
  g_signal_connect(op, "failed", G_CALLBACK(on_dialog_failed), job);
  g_signal_connect(op, "finished", G_CALLBACK(on_dialog_finished), job);
  g_object_ref(op);
  if (webkit_print_operation_run_dialog(op, parent) == WEBKIT_PRINT_OPERATION_RESPONSE_CANCEL) {
    // Nothing was printed: no `finished` comes.
    g_signal_handlers_disconnect_by_data(op, job);
    print_finished(job->id, false, "");
    delete job;
    g_object_unref(op);
  }
  g_print_dialogs.erase(wv);
  g_object_unref(wv);
}

void web_print_dialogs_close() {
  GList *windows = gtk_window_list_toplevels();
  for (GList *l = windows; l; l = l->next)
    if (GTK_IS_PRINT_UNIX_DIALOG(l->data)) gtk_dialog_response(GTK_DIALOG(l->data), GTK_RESPONSE_CANCEL);
  g_list_free(windows);
}

// window.print(): the signal's default handler would run the same dialog without reporting a cancel.
static gboolean on_print(WebKitWebView *wv, WebKitPrintOperation *op, gpointer) {
  if (!g_print_dialogs.count(wv)) run_dialog(wv, op);
  return TRUE;
}

static void register_print() {
  reg("webview", "getPrinters", [](CallPtr c) {
    list_printers([c](const std::vector<std::string> &names, const std::string &) { c->ok(names); });
  });
  target_op("printToPDF", [](CallPtr c, Target &t) {
    std::string path = expand_home(c->str("path"));
    if (path.empty()) return c->fail("invalid_args", "webview.printToPDF: `path` is required");
    print_pdf(c, t, path, c->args);
  });
  target_op("print", [](CallPtr c, Target &t) {
    std::string pdf = expand_home(c->str("pdfPath"));
    if (!pdf.empty()) return print_pdf(c, t, pdf, c->args);
    auto spec = std::make_shared<PrintSpec>();
    std::string error;
    bool silent = c->flag("silent", false);
    if (!print_spec(c->args, false, spec.get(), &error)) return c->fail("invalid_args", error);
    WebKitWebView *wv = WEBKIT_WEB_VIEW(g_object_ref(t.wv));
    if (!silent && g_print_dialogs.count(wv)) {
      g_object_unref(wv);
      return c->fail("unavailable", "webview.print: the view already shows a print dialog");
    }
    list_printers([c, spec, silent, wv](const std::vector<std::string> &names, const std::string &preferred) {
      if (!spec->printer.empty() && std::find(names.begin(), names.end(), spec->printer) == names.end()) {
        g_object_unref(wv);
        return c->fail("invalid_args", "printer must name an installed printer");
      }
      if (!spec->printer.empty()) gtk_print_settings_set_printer(spec->settings, spec->printer.c_str());
      if (silent) {
        std::string printer = !spec->printer.empty() ? spec->printer : preferred;
        if (printer.empty()) {
          g_object_unref(wv);
          return c->fail("unavailable", "webview.print: no default printer");
        }
        gtk_print_settings_set_printer(spec->settings, printer.c_str());
        Target target{wv, json()};
        run_job(c, target, *spec, "", "");
        g_object_unref(wv);
        return;
      }
      c->ok(json{{"started", true}});
      WebKitPrintOperation *op = webkit_print_operation_new(wv);
      webkit_print_operation_set_print_settings(op, spec->settings);
      webkit_print_operation_set_page_setup(op, spec->setup);
      run_after(0, [wv, op] {
        if (!g_print_dialogs.count(wv)) run_dialog(wv, op);
        g_object_unref(op);
        g_object_unref(wv);
      });
    });
  });
}

// ===========================================================================
// Website data: other sites' by default, the app's too with `app`, its cookies never

static bool data_types(const json &args, WebKitWebsiteDataTypes *out, std::string *bad) {
  static const std::map<std::string, int> known = {
      {"cookies", WEBKIT_WEBSITE_DATA_COOKIES},
      {"localStorage", WEBKIT_WEBSITE_DATA_LOCAL_STORAGE},
      {"sessionStorage", WEBKIT_WEBSITE_DATA_SESSION_STORAGE},
      {"indexedDB", WEBKIT_WEBSITE_DATA_INDEXEDDB_DATABASES},
      {"cache", WEBKIT_WEBSITE_DATA_DISK_CACHE | WEBKIT_WEBSITE_DATA_MEMORY_CACHE | WEBKIT_WEBSITE_DATA_DOM_CACHE | WEBKIT_WEBSITE_DATA_OFFLINE_APPLICATION_CACHE},
      {"serviceWorkers", WEBKIT_WEBSITE_DATA_SERVICE_WORKER_REGISTRATIONS},
  };
  json names = args.contains("types") && args["types"].is_array() ? args["types"] : json::array({"all"});
  int types = 0;
  for (const json &n : names) {
    std::string name = n.is_string() ? n.get<std::string>() : n.dump();
    if (name == "all") {
      *out = WEBKIT_WEBSITE_DATA_ALL;
      return true;
    }
    auto it = known.find(name);
    if (it == known.end()) return *bad = name, false;
    types |= it->second;
  }
  *out = (WebKitWebsiteDataTypes)types;
  return true;
}

struct ClearData {
  CallPtr c;
  WebKitWebsiteDataManager *manager;
  WebKitWebsiteDataTypes types;
  bool app;
  GList *own = nullptr;
  json names = json::array();
};

static void clear_done(ClearData *x) {
  x->c->ok(json{{"cleared", x->names}});
  g_list_free_full(x->own, (GDestroyNotify)webkit_website_data_unref);
  delete x;
}

static void clear_own(ClearData *x) {
  auto ownTypes = (WebKitWebsiteDataTypes)(x->types & ~WEBKIT_WEBSITE_DATA_COOKIES);
  if (!x->app || !x->own || !ownTypes) return clear_done(x);
  webkit_website_data_manager_remove(x->manager, ownTypes, x->own, nullptr, +[](GObject *, GAsyncResult *, gpointer data) {
    clear_done(static_cast<ClearData *>(data));
  }, x);
}

static void on_data_fetched(GObject *, GAsyncResult *res, gpointer data) {
  auto *x = static_cast<ClearData *>(data);
  GList *records = webkit_website_data_manager_fetch_finish(x->manager, res, nullptr);
  std::string appHost;
  if (GUri *u = g_uri_parse(app_origin().c_str(), G_URI_FLAGS_NONE, nullptr)) {
    appHost = g_uri_get_host(u) ? g_uri_get_host(u) : "";
    g_uri_unref(u);
  }
  GList *sites = nullptr;
  for (GList *l = records; l; l = l->next) {
    auto *record = static_cast<WebKitWebsiteData *>(l->data);
    std::string name = webkit_website_data_get_name(record);
    bool mine = name == appHost || name == "localhost" || name == "127.0.0.1";
    if (mine) x->own = g_list_prepend(x->own, record);
    else sites = g_list_prepend(sites, record);
    if (!mine || x->app) x->names.push_back(name);
  }
  g_list_free(records); // the two lists own them now
  if (!sites) return clear_own(x);
  struct Step {
    ClearData *x;
    GList *sites;
  };
  webkit_website_data_manager_remove(x->manager, x->types, sites, nullptr, +[](GObject *, GAsyncResult *, gpointer data) {
    auto *step = static_cast<Step *>(data);
    g_list_free_full(step->sites, (GDestroyNotify)webkit_website_data_unref);
    clear_own(step->x);
    delete step;
  }, new Step{x, sites});
}

static void register_clear_data() {
  reg("webview", "clearData", [](CallPtr c) {
    std::string bad;
    WebKitWebsiteDataTypes types;
    if (!data_types(c->args, &types, &bad)) return c->fail("invalid_args", "webview.clearData: unknown type `" + bad + "` (cookies, localStorage, sessionStorage, indexedDB, cache, serviceWorkers, all)");
    WebKitWebsiteDataManager *manager = webkit_web_context_get_website_data_manager(webkit_web_context_get_default());
    webkit_website_data_manager_fetch(manager, types, nullptr, on_data_fetched, new ClearData{c, manager, types, c->flag("app", false)});
  });
}

// ===========================================================================

void web_downloads_attach(WebKitWebView *wv) {
  // A signal of the context, and each session has its own.
  WebKitWebContext *context = webkit_web_view_get_context(wv);
  if (!g_object_get_data(G_OBJECT(context), "sd-downloads")) {
    g_object_set_data(G_OBJECT(context), "sd-downloads", GINT_TO_POINTER(1));
    g_signal_connect(context, "download-started", G_CALLBACK(on_download_started), nullptr);
  }
  // Not the view's native id as data: svc_view.cc disconnects what carries it.
  g_signal_connect(wv, "print", G_CALLBACK(on_print), nullptr);
}

void register_web_downloads() {
  register_downloads();
  register_print();
  register_clear_data();
}

} // namespace lx
} // namespace sd
