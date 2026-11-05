// webview.* downloads and host.downloads, same ops, records and events as native/webview_downloads.h:
//   setDownloadDirectory · getDownloadDirectory · download · setDownloadHandler · clearDownloadHandler
//   decideDownload · pauseDownload · resumeDownload · cancelDownload · getDownload · listDownloads
// Events: downloadRequested, downloadStarted, downloadProgress, downloadFinished, downloadFailed,
// downloadChanged. WebView2 keeps the bytes: a pause holds the operation, so only this run resumes.
#include "win.hpp"

#include <objbase.h>
#include <shlobj.h>

#include <algorithm>
#include <filesystem>

namespace sd::win {

namespace fs = std::filesystem;

struct Download {
  std::string id, url, path, explicitPath, filename, state = "requested", error, handlerId;
  std::string mime;
  bool hasMime = false;
  json source = json::object();
  ICoreWebView2DownloadOperation *op = nullptr; // this run, until it ends
  ICoreWebView2DownloadStartingEventArgs *starting = nullptr; // held while the handler decides
  ICoreWebView2Deferral *deferral = nullptr;
  EventRegistrationToken bytesToken{}, stateToken{};
  bool attached = false;
  int64_t received = 0, total = -1;
  double startedAt = 0, updatedAt = 0;
  ULONGLONG lastProgress = 0;
  CallPtr waiter; // pause / cancel with a final record to answer
};

// webview.download: the page starts it; DownloadStarting finds what it was asked for.
struct Start {
  int token, view;
  std::string url, path;
  CallPtr call;
};

static std::map<std::string, Download *> g_downloads;
static std::vector<Start> g_starts;
static std::string g_handler, g_dir;
static int g_next_start = 1;
static const size_t kHistory = 200;

static double now_ms() {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER t;
  t.LowPart = ft.dwLowDateTime;
  t.HighPart = ft.dwHighDateTime;
  return (double)((t.QuadPart - 116444736000000000ULL) / 10000);
}

static std::string new_id() {
  GUID g;
  wchar_t buf[64];
  CoCreateGuid(&g);
  StringFromGUID2(g, buf, 64);
  std::string s = utf8(buf);
  return "dl-" + s.substr(1, s.size() - 2);
}

static bool active(const Download *d) { return d->state == "requested" || d->state == "downloading" || d->state == "pausing" || d->state == "finishing"; }

static bool can_resume(const Download *d) {
  if (!d->op || (d->state != "paused" && d->state != "interrupted")) return false;
  BOOL can = FALSE;
  d->op->get_CanResume(&can);
  return can != FALSE;
}

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
  json m = with_source(d, json{{"state", d->state},
                               {"suggestedFilename", d->filename},
                               {"mimeType", d->hasMime ? json(d->mime) : json(nullptr)},
                               {"receivedBytes", d->received},
                               {"totalBytes", d->total},
                               {"fraction", fraction},
                               {"canResume", can_resume(d)},
                               {"startedAt", d->startedAt},
                               {"updatedAt", d->updatedAt}});
  if (!d->error.empty()) m["error"] = d->error;
  return m;
}

static std::string history_path() { return local_file("downloads.json"); }

static std::vector<Download *> newest_first() {
  std::vector<Download *> all;
  for (auto &[id, d] : g_downloads) all.push_back(d);
  std::sort(all.begin(), all.end(), [](auto *a, auto *b) { return a->startedAt > b->startedAt; });
  return all;
}

static void save_history() {
  json items = json::array();
  auto all = newest_first();
  for (size_t i = 0; i < all.size() && i < kHistory; i++) items.push_back(snapshot(all[i]));
  write_json_file(history_path(), items);
}

static void load_history() {
  static bool loaded = false;
  if (loaded) return;
  loaded = true;
  json items = read_json_file(history_path(), json::array());
  if (!items.is_array()) return;
  for (auto &m : items) {
    if (!m.is_object() || !m.contains("id") || !m["id"].is_string() || !m.contains("url") || !m["url"].is_string()) continue;
    auto *d = new Download;
    d->id = m["id"];
    d->url = m["url"];
    d->path = jstr(m, "path");
    d->filename = jstr(m, "suggestedFilename");
    if (m.contains("mimeType") && m["mimeType"].is_string()) d->mime = m["mimeType"], d->hasMime = true;
    d->state = jstr(m, "state", "interrupted");
    // Its operation went with the last run.
    if (active(d) || d->state == "paused") d->state = "interrupted";
    d->received = (int64_t)jnum(m, "receivedBytes", 0);
    d->total = (int64_t)jnum(m, "totalBytes", -1);
    d->startedAt = jnum(m, "startedAt", 0);
    d->updatedAt = jnum(m, "updatedAt", 0);
    d->error = jstr(m, "error");
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

// ---------------------------------------------------------------------------
// Paths

static std::string known_downloads() {
  wchar_t *p = nullptr;
  std::string out;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Downloads, 0, nullptr, &p)) && p) out = utf8(p);
  if (p) CoTaskMemFree(p);
  return out;
}

static std::string download_dir() { return g_dir.empty() ? known_downloads() : g_dir; }

static std::string path_key(const std::string &path) {
  std::error_code ec;
  fs::path full = fs::absolute(fs::u8path(path), ec);
  return lower((ec ? fs::u8path(path) : full.lexically_normal()).u8string());
}

static bool path_busy(const std::string &path, const Download *except) {
  std::string key = path_key(path);
  for (auto &[id, other] : g_downloads)
    if (other != except && !other->path.empty() && (active(other) || other->state == "paused") && path_key(other->path) == key) return true;
  return false;
}

static std::string unique_path(const std::string &dir, const std::string &name) {
  fs::path base = fs::u8path(dir), file = fs::u8path(name);
  std::error_code ec;
  std::string candidate = (base / file).u8string();
  for (int i = 1; fs::exists(fs::u8path(candidate), ec) || path_busy(candidate, nullptr); i++)
    candidate = (base / fs::u8path(file.stem().u8string() + " (" + std::to_string(i) + ")" + file.extension().u8string())).u8string();
  return candidate;
}

// ---------------------------------------------------------------------------
// Transfers

static void update_bytes(Download *d) {
  if (!d->op) return;
  INT64 received = 0, total = -1;
  if (SUCCEEDED(d->op->get_BytesReceived(&received))) d->received = std::max<int64_t>(d->received, received);
  // Without a Content-Length it answers 0, not the -1 it documents: both mean unknown.
  if (SUCCEEDED(d->op->get_TotalBytesToReceive(&total)) && total > 0) d->total = total;
}

static void drop_operation(Download *d) {
  if (!d->op) return;
  if (d->attached) {
    d->op->remove_BytesReceivedChanged(d->bytesToken);
    d->op->remove_StateChanged(d->stateToken);
    d->attached = false;
  }
  release(d->op);
}

static void answer_waiter(Download *d) {
  if (!d->waiter) return;
  CallPtr c = std::move(d->waiter);
  d->waiter = nullptr;
  c->ok(snapshot(d));
}

static std::string interrupt_message(COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON reason) {
  switch (reason) {
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_ACCESS_DENIED: return "the destination cannot be written";
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE: return "no space left on the disk";
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NAME_TOO_LONG: return "the file name is too long";
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_FAILED:
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_TIMEOUT:
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_DISCONNECTED:
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_SERVER_DOWN: return "the network failed";
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FAILED:
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FORBIDDEN:
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_UNAUTHORIZED:
    case COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_BAD_CONTENT: return "the server refused the download";
    default: return "the download was interrupted (WebView2 reason " + std::to_string((int)reason) + ")";
  }
}

static void on_state_changed(const std::string &id) {
  auto it = g_downloads.find(id);
  if (it == g_downloads.end() || !it->second->op) return;
  Download *d = it->second;
  update_bytes(d);
  COREWEBVIEW2_DOWNLOAD_STATE state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
  d->op->get_State(&state);
  if (state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS) {
    d->state = "downloading";
    d->error.clear();
    changed(d);
    answer_waiter(d);
    return;
  }
  if (state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED) {
    std::error_code ec;
    auto size = fs::file_size(fs::u8path(d->path), ec);
    if (!ec) d->received = (int64_t)size;
    d->state = "completed";
    d->error.clear();
    drop_operation(d);
    changed(d);
    emit("downloadFinished", with_source(d, json{{"bytes", d->received}}));
    answer_waiter(d);
    return;
  }
  COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE;
  d->op->get_InterruptReason(&reason);
  bool paused = reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_PAUSED;
  bool canceled = reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED;
  d->state = paused ? "paused" : canceled ? "canceled" : "interrupted";
  d->error = paused || canceled ? "" : interrupt_message(reason);
  bool resumable = can_resume(d);
  if (canceled || !resumable) drop_operation(d);
  changed(d);
  emit("downloadFailed", with_source(d, json{{"error", paused ? "paused" : canceled ? "canceled" : d->error},
                                             {"canceled", paused || canceled},
                                             {"canResume", resumable}}));
  answer_waiter(d);
}

static void attach_operation(Download *d) {
  std::string id = d->id;
  auto *onBytes = new Cb<ICoreWebView2BytesReceivedChangedEventHandler, ICoreWebView2DownloadOperation *, IUnknown *>(
      IID_ICoreWebView2BytesReceivedChangedEventHandler, [id](ICoreWebView2DownloadOperation *, IUnknown *) -> HRESULT {
        auto it = g_downloads.find(id);
        if (it == g_downloads.end() || !it->second->op) return S_OK;
        Download *d = it->second;
        update_bytes(d);
        ULONGLONG now = GetTickCount64();
        if (now - d->lastProgress < 250) return S_OK; // the raw event comes with every chunk
        d->lastProgress = now;
        d->updatedAt = now_ms();
        json s = snapshot(d);
        emit("downloadProgress", s);
        emit("downloadChanged", s);
        return S_OK;
      });
  d->op->add_BytesReceivedChanged(onBytes, &d->bytesToken);
  onBytes->Release();
  auto *onState = new Cb<ICoreWebView2StateChangedEventHandler, ICoreWebView2DownloadOperation *, IUnknown *>(
      IID_ICoreWebView2StateChangedEventHandler, [id](ICoreWebView2DownloadOperation *, IUnknown *) -> HRESULT {
        // Off this event: it may end the operation raising it.
        backend_run_on_main([id] { on_state_changed(id); });
        return S_OK;
      });
  d->op->add_StateChanged(onState, &d->stateToken);
  onState->Release();
  d->attached = true;
}

static void finish_hold(Download *d) {
  if (d->deferral) {
    d->deferral->Complete();
    release(d->deferral);
  }
  release(d->starting);
}

/// Refuse the destination: the transfer doesn't begin.
static void refuse(Download *d, ICoreWebView2DownloadStartingEventArgs *args, const std::string &state, const std::string &error, bool canceled) {
  args->put_Cancel(TRUE);
  d->state = state;
  d->error = canceled ? "" : error;
  drop_operation(d);
  changed(d);
  emit("downloadFailed", with_source(d, json{{"error", error}, {"canceled", canceled}}));
}

static void choose(Download *d, ICoreWebView2DownloadStartingEventArgs *args, const json &decision) {
  if (decision.is_string() && decision.get<std::string>() == "cancel") return refuse(d, args, "canceled", "canceled before saving", true);
  std::string path = expand_home(decision.is_object() ? jstr(decision, "path") : d->explicitPath);
  if (path.empty()) {
    std::string name = fs::u8path(d->filename).filename().u8string();
    if (name.empty() || name[0] == '.') name = "download" + name;
    path = unique_path(download_dir(), name);
  }
  if (path_busy(path, d)) return refuse(d, args, "interrupted", "download destination is in use by another transfer", false);
  std::error_code ec;
  if (fs::is_directory(fs::u8path(path), ec)) return refuse(d, args, "interrupted", "download destination is a directory", false);
  HRESULT hr = args->put_ResultFilePath(wide(path).c_str());
  if (FAILED(hr)) return refuse(d, args, "interrupted", "destination unavailable: " + hresult_message(hr), false);
  d->path = path;
  attach_operation(d);
  d->state = "downloading";
  changed(d);
  emit("downloadStarted", snapshot(d));
}

static bool take_start(int view, const std::string &url, Start &out) {
  int sole = -1, count = 0;
  for (size_t i = 0; i < g_starts.size(); i++) {
    if (g_starts[i].view != view) continue;
    if (g_starts[i].url == url) {
      sole = (int)i, count = 1;
      break;
    }
    sole = (int)i, count++; // a redirect changes the URL: only if it can't be another one's
  }
  if (count != 1) return false;
  out = g_starts[(size_t)sole];
  g_starts.erase(g_starts.begin() + sole);
  return true;
}

static void on_download_starting(View *v, ICoreWebView2DownloadStartingEventArgs *args) {
  load_history();
  ICoreWebView2DownloadOperation *op = nullptr;
  if (FAILED(args->get_DownloadOperation(&op)) || !op) return;
  auto *d = new Download;
  d->id = new_id();
  d->op = op;
  d->source = view_source(v);
  d->startedAt = now_ms();
  LPWSTR s = nullptr;
  if (SUCCEEDED(op->get_Uri(&s)) && s) d->url = utf8(s);
  if (s) CoTaskMemFree(s);
  s = nullptr;
  if (SUCCEEDED(op->get_MimeType(&s)) && s && *s) d->mime = utf8(s), d->hasMime = true;
  if (s) CoTaskMemFree(s);
  s = nullptr;
  if (SUCCEEDED(args->get_ResultFilePath(&s)) && s) d->filename = fs::u8path(utf8(s)).filename().u8string();
  if (s) CoTaskMemFree(s);
  update_bytes(d);
  args->put_Handled(TRUE); // no WebView2 download bubble
  Start start{};
  bool asked = take_start(v->id, d->url, start);
  if (asked) d->explicitPath = start.path;
  g_downloads[d->id] = d;
  changed(d);
  if (asked) start.call->ok(json{{"id", d->id}, {"url", d->url}});
  if (g_handler.empty()) return choose(d, args, json("default"));
  if (FAILED(args->GetDeferral(&d->deferral)) || !d->deferral) return refuse(d, args, "canceled", "canceled before saving", true);
  args->AddRef();
  d->starting = args;
  d->handlerId = g_handler;
  changed(d);
  emit("downloadRequested", with_source(d, json{{"handlerId", d->handlerId},
                                                {"suggestedFilename", d->filename},
                                                {"mimeType", d->hasMime ? json(d->mime) : json(nullptr)},
                                                {"size", d->total}}));
  // A lost page or handler must never silently authorize a destination.
  run_after(30000, [id = d->id] {
    auto it = g_downloads.find(id);
    if (it == g_downloads.end() || !it->second->starting) return;
    Download *held = it->second;
    choose(held, held->starting, json("cancel"));
    finish_hold(held);
  });
}

void downloads_attach(View *v) {
  auto *wv4 = query<ICoreWebView2_4>(v->webview, IID_ICoreWebView2_4);
  if (!wv4) return;
  int id = v->id;
  auto *on = new Cb<ICoreWebView2DownloadStartingEventHandler, ICoreWebView2 *, ICoreWebView2DownloadStartingEventArgs *>(
      IID_ICoreWebView2DownloadStartingEventHandler, [id](ICoreWebView2 *, ICoreWebView2DownloadStartingEventArgs *args) -> HRESULT {
        if (View *v = find_view(id)) on_download_starting(v, args);
        return S_OK;
      });
  wv4->add_DownloadStarting(on, &v->tokens[9]);
  on->Release();
  wv4->Release();
}

void downloads_detach(View *v) {
  if (auto *wv4 = query<ICoreWebView2_4>(v->webview, IID_ICoreWebView2_4)) {
    wv4->remove_DownloadStarting(v->tokens[9]);
    wv4->Release();
  }
  for (auto it = g_starts.begin(); it != g_starts.end();) {
    if (it->view != v->id) {
      ++it;
      continue;
    }
    it->call->fail("unavailable", "webview.download: the view closed");
    it = g_starts.erase(it);
  }
}

// ---------------------------------------------------------------------------
// webview.download: WebView2 has no call that starts a download, the page does it.

static void start_in_page(CallPtr c, View *v, const std::string &url, const std::string &path) {
  LPWSTR source = nullptr;
  v->webview->get_Source(&source);
  std::string pageOrigin = url_origin(utf8(source));
  if (source) CoTaskMemFree(source);
  std::string scheme = url_scheme(url);
  bool sameOrigin = scheme == "blob" || scheme == "data" || url_origin(url) == pageOrigin;
  int token = g_next_start++;
  g_starts.push_back(Start{token, v->id, url, path, c});
  // `download` only counts on the page's own origin; elsewhere a link would navigate the page
  // away from it, a hidden frame takes what isn't an attachment and leaves the page where it is.
  std::string u = json(url).dump();
  std::string script = sameOrigin ? "(()=>{const a=document.createElement('a');a.href=" + u + ";a.download='';a.style.display='none';(document.body||document.documentElement).append(a);a.click();a.remove();return true})()"
                                  : "(()=>{const f=document.createElement('iframe');f.style.display='none';f.src=" + u + ";(document.body||document.documentElement).append(f);setTimeout(()=>f.remove(),60000);return true})()";
  view_execute(v, script, [token](bool ok, const json &, const std::string &error) {
    if (ok) return;
    for (auto it = g_starts.begin(); it != g_starts.end(); ++it)
      if (it->token == token) {
        it->call->fail("unavailable", "webview.download: " + error);
        g_starts.erase(it);
        return;
      }
  });
  run_after(15000, [token] {
    for (auto it = g_starts.begin(); it != g_starts.end(); ++it)
      if (it->token == token) {
        it->call->fail("unavailable", "webview.download: no download started (from another origin, the response must be an attachment)");
        g_starts.erase(it);
        return;
      }
  });
}

static void cancel_download(CallPtr c, bool pause) {
  Download *d = find_download(c);
  if (!d) return c->fail("invalid_args", "unknown download id");
  bool wantSnapshot = pause || c->flag("snapshot", false);
  if (d->starting) {
    ICoreWebView2DownloadStartingEventArgs *args = d->starting;
    choose(d, args, json("cancel"));
    finish_hold(d);
    return wantSnapshot ? c->ok(snapshot(d)) : c->ok();
  }
  if (!d->op || d->state == "pausing") return c->fail("unavailable", "download is not transferring");
  if (pause && d->state != "downloading") return c->fail("unavailable", "download is not transferring");
  if (!pause && d->state != "downloading") {
    // Paused or interrupted: nothing is running, and no state change comes.
    d->op->Cancel();
    d->state = "canceled";
    d->error.clear();
    drop_operation(d);
    changed(d);
    emit("downloadFailed", with_source(d, json{{"error", "canceled"}, {"canceled", true}, {"canResume", false}}));
    return wantSnapshot ? c->ok(snapshot(d)) : c->ok();
  }
  d->state = "pausing";
  changed(d);
  if (wantSnapshot) {
    d->waiter = c;
    run_after(5000, [id = d->id] {
      auto it = g_downloads.find(id);
      if (it != g_downloads.end()) answer_waiter(it->second); // the record as it stands
    });
  } else c->ok();
  HRESULT hr = pause ? d->op->Pause() : d->op->Cancel();
  if (FAILED(hr)) {
    d->state = "downloading";
    changed(d);
    answer_waiter(d);
  }
}

void register_downloads() {
  reg("webview", "setDownloadDirectory", [](CallPtr c) {
    std::string path = expand_home(c->str("path"));
    if (path.empty()) {
      g_dir.clear();
      return c->ok(json{{"path", download_dir()}});
    }
    std::error_code ec;
    fs::create_directories(fs::u8path(path), ec);
    if (ec || !fs::is_directory(fs::u8path(path), ec)) return c->fail("denied", "webview.setDownloadDirectory: " + (ec ? ec.message() : std::string("not a directory")));
    g_dir = path;
    c->ok(json{{"path", path}});
  });
  reg("webview", "getDownloadDirectory", [](CallPtr c) { c->ok(json{{"path", download_dir()}}); });
  reg("webview", "download", [](CallPtr c) {
    View *v = view_for_call(c);
    if (!v) return;
    if (!v->webview) return c->fail("unavailable", "webview.download: the web view is not ready yet");
    std::string raw = c->str("url"), path = expand_home(c->str("path"));
    if (raw.empty()) return c->fail("invalid_args", "webview.download: `url` must be an http(s), blob: or data: URL");
    if (!path.empty() && !fs::u8path(path).is_absolute()) return c->fail("invalid_args", "download path must be absolute");
    // Relative URLs mean what they mean in the page.
    int id = v->id;
    view_execute(v, "new URL(" + json(raw).dump() + ",location.href).href", [c, id, path](bool ok, const json &value, const std::string &) {
      std::string url = ok && value.is_string() ? value.get<std::string>() : "";
      std::string scheme = url_scheme(url);
      if (scheme != "http" && scheme != "https" && scheme != "blob" && scheme != "data")
        return c->fail("invalid_args", "webview.download: `url` must be an http(s), blob: or data: URL");
      View *now = find_view(id);
      if (!now || !now->webview) return c->fail("unavailable", "webview.download: the view closed");
      start_in_page(c, now, url, path);
    });
  });
  reg("webview", "setDownloadHandler", [](CallPtr c) {
    std::string ident = c->str("handlerId");
    if (ident.empty()) return c->fail("invalid_args", "handlerId required");
    load_history();
    for (auto &[id, d] : g_downloads)
      if (d->starting) {
        choose(d, d->starting, json("cancel"));
        finish_hold(d);
      }
    g_handler = ident;
    c->ok();
  });
  reg("webview", "clearDownloadHandler", [](CallPtr c) {
    if (g_handler == c->str("handlerId")) {
      g_handler.clear();
      for (auto &[id, d] : g_downloads)
        if (d->starting) {
          choose(d, d->starting, json("cancel"));
          finish_hold(d);
        }
    }
    c->ok();
  });
  reg("webview", "decideDownload", [](CallPtr c) {
    Download *d = find_download(c);
    if (!d || !d->starting || d->handlerId != c->str("handlerId")) return c->fail("unavailable", "download request expired");
    json decision = c->args.contains("decision") ? c->args["decision"] : json();
    bool valid = decision.is_string() && (decision.get<std::string>() == "default" || decision.get<std::string>() == "cancel");
    if (decision.is_object()) {
      std::string path = expand_home(jstr(decision, "path"));
      valid = !path.empty() && fs::u8path(path).is_absolute();
    }
    ICoreWebView2DownloadStartingEventArgs *args = d->starting;
    choose(d, args, valid ? decision : json("cancel"));
    finish_hold(d);
    valid ? c->ok() : c->fail("invalid_args", "decision must be default, cancel or an absolute path");
  });
  reg("webview", "pauseDownload", [](CallPtr c) { cancel_download(c, true); });
  reg("webview", "cancelDownload", [](CallPtr c) { cancel_download(c, false); });
  reg("webview", "resumeDownload", [](CallPtr c) {
    Download *d = find_download(c);
    if (!d) return c->fail("invalid_args", "unknown download id");
    if (!can_resume(d)) return c->fail("unavailable", "download is active or cannot resume (its transfer has to belong to this run)");
    if (path_busy(d->path, d)) return c->fail("unavailable", "download destination is in use by another transfer");
    HRESULT hr = d->op->Resume();
    if (FAILED(hr)) return c->fail("unavailable", "webview.resumeDownload: " + hresult_message(hr));
    d->state = "downloading";
    d->error.clear();
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

} // namespace sd::win
