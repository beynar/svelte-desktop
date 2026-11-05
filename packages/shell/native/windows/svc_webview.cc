// webview.* — zoom (ZoomFactor), navigation, user agent, devtools, context
// menu on/off, executeJavaScript (DevTools Runtime.evaluate: awaits promises,
// returns JSON), capturePage (CapturePreview -> PNG/JPEG), print / printToPDF /
// getPrinters. Policy is in svc_web_policy.cc, downloads in svc_downloads.cc.
// Target: args.popoverId, args.viewId, args.windowId (public id), the calling
// page, or the primary window.
#include "win.hpp"

#include <shlwapi.h>
#include <winspool.h>

#include <algorithm>
#include <climits>
#include <cmath>

namespace sd::win {

static View *resolve_view(CallPtr c) {
  std::string pid = c->str("popoverId");
  if (!pid.empty()) {
    View *v = popover_view(pid);
    if (!v) c->fail("invalid_args", "webview." + c->op + ": unknown popover `" + pid + "`");
    return v;
  }
  std::string named = c->str("viewId");
  if (!named.empty()) {
    View *v = view_named(named);
    if (!v) c->fail("invalid_args", "webview." + c->op + ": unknown view `" + named + "`");
    return v;
  }
  if (!c->has("windowId") && c->caller && !find_window(c->caller))
    if (View *v = find_view(c->caller)) return v; // a popover page, a view's
  Window *w = find_window(resolve_window(*c));
  if (!w) {
    c->fail("invalid_args", "webview." + c->op + ": no such window");
    return nullptr;
  }
  return &w->view;
}

View *view_for_call(const CallPtr &c) { return resolve_view(c); }

json view_source(View *v) {
  json d = json::object();
  std::string popover = popover_id_of(v->id);
  if (!popover.empty()) d["popoverId"] = popover;
  else if (int owner = view_owner(v->id)) {
    d["windowId"] = backend_public_window_id(owner); // a view's page: its window
    d["viewId"] = v->browserView;
  } else d["windowId"] = backend_public_window_id(v->id);
  return d;
}

using ViewOp = std::function<void(CallPtr, View *)>;

static void vreg(const std::string &op, ViewOp body) {
  reg("webview", op, [body](CallPtr c) {
    View *v = resolve_view(c);
    if (!v) return;
    if (!v->webview) return c->fail("unavailable", "webview." + c->op + ": the web view is not ready yet");
    body(c, v);
  });
}

static ICoreWebView2Settings *settings_of(View *v) {
  ICoreWebView2Settings *s = nullptr;
  if (v->webview) v->webview->get_Settings(&s);
  return s;
}

static std::string default_user_agent(View *v) {
  std::string ua;
  if (ICoreWebView2Settings *s = settings_of(v)) {
    if (auto *s2 = query<ICoreWebView2Settings2>(s, IID_ICoreWebView2Settings2)) {
      LPWSTR p = nullptr;
      if (SUCCEEDED(s2->get_UserAgent(&p)) && p) ua = utf8(p);
      if (p) CoTaskMemFree(p);
      s2->Release();
    }
    s->Release();
  }
  return ua;
}

static void capture(CallPtr c, View *v) {
  IStream *stream = SHCreateMemStream(nullptr, 0);
  if (!stream) return c->fail("internal", "webview.capturePage: no memory stream");
  std::string format = c->str("format") == "jpeg" ? "jpeg" : "png";
  double quality = c->num("quality", 0.85);
  json rect = c->args.contains("rect") && c->args["rect"].is_object() ? c->args["rect"] : json();
  double zoom = view_zoom(v) * hwnd_scale(v->host);
  auto *cb = new Cb<ICoreWebView2CapturePreviewCompletedHandler, HRESULT>(
      IID_ICoreWebView2CapturePreviewCompletedHandler, [c, stream, format, quality, rect, zoom](HRESULT hr) -> HRESULT {
        std::string png;
        if (SUCCEEDED(hr)) {
          STATSTG st{};
          stream->Stat(&st, STATFLAG_NONAME);
          png.resize((size_t)st.cbSize.QuadPart);
          LARGE_INTEGER zero{};
          stream->Seek(zero, STREAM_SEEK_SET, nullptr);
          ULONG read = 0;
          stream->Read(&png[0], (ULONG)png.size(), &read);
        }
        stream->Release();
        std::vector<uint8_t> px;
        UINT w = 0, h = 0;
        if (FAILED(hr) || !wic_decode(png, px, w, h)) {
          c->fail("internal", "webview.capturePage: " + (FAILED(hr) ? hresult_message(hr) : std::string("no image")));
          return S_OK;
        }
        UINT x0 = 0, y0 = 0, cw = w, ch = h;
        if (rect.is_object()) { // CSS px -> device px
          x0 = (UINT)std::max(0.0, jnum(rect, "x", 0) * zoom);
          y0 = (UINT)std::max(0.0, jnum(rect, "y", 0) * zoom);
          cw = (UINT)std::max(1.0, jnum(rect, "width", w) * zoom);
          ch = (UINT)std::max(1.0, jnum(rect, "height", h) * zoom);
          if (x0 >= w || y0 >= h) {
            c->fail("invalid_args", "webview.capturePage: `rect` is outside the page");
            return S_OK;
          }
          cw = std::min(cw, w - x0);
          ch = std::min(ch, h - y0);
        }
        std::string out;
        if (!wic_encode(px.data() + ((size_t)y0 * w + x0) * 4, cw, ch, w * 4, format == "jpeg", quality, out)) {
          c->fail("internal", "webview.capturePage: encoding failed");
          return S_OK;
        }
        c->ok(json{{"data", base64_encode(out.data(), out.size())}, {"format", format}, {"width", cw}, {"height", ch}});
        return S_OK;
      });
  HRESULT hr = v->webview->CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream, cb);
  cb->Release();
  if (FAILED(hr)) c->fail("internal", "webview.capturePage: " + hresult_message(hr));
}

static std::vector<std::string> printer_names() {
  DWORD needed = 0, count = 0;
  const DWORD flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
  EnumPrintersW(flags, nullptr, 4, nullptr, 0, &needed, &count);
  std::vector<BYTE> buf(needed);
  std::vector<std::string> out;
  if (!needed || !EnumPrintersW(flags, nullptr, 4, buf.data(), needed, &needed, &count)) return out;
  auto *rows = reinterpret_cast<PRINTER_INFO_4W *>(buf.data());
  for (DWORD i = 0; i < count; i++) out.push_back(utf8(rows[i].pPrinterName));
  return out;
}

// Same validation and messages as native/webview_print.h, before anything starts. Points -> the
// inches WebView2 takes. `pdf`: printer and copies mean nothing there.
static bool print_number(const json &o, const char *key, double min, double max) {
  auto it = o.find(key);
  return it != o.end() && it->is_number() && std::isfinite(it->get<double>()) && it->get<double>() >= min && it->get<double>() <= max;
}

static bool print_settings(View *v, const json &o, bool pdf, ICoreWebView2PrintSettings **out, std::string &error, bool &unsupported) {
  double pageW = 612, pageH = 792; // WebView2's default paper: US Letter
  std::string ranges, printer;
  int copies = 0;
  if (o.contains("printer")) {
    printer = jstr(o, "printer");
    auto names = printer_names();
    if (printer.empty() || std::find(names.begin(), names.end(), printer) == names.end())
      return error = "printer must name an installed printer", false;
  }
  if (o.contains("copies")) {
    if (!print_number(o, "copies", 1, 9999) || std::floor(o["copies"].get<double>()) != o["copies"].get<double>())
      return error = "copies must be an integer from 1 to 9999", false;
    copies = (int)o["copies"].get<double>();
  }
  if (o.contains("paperSize")) {
    const json &p = o["paperSize"];
    if (!p.is_object() || !print_number(p, "width", 1, 14400) || !print_number(p, "height", 1, 14400))
      return error = "paperSize needs positive width and height in points (maximum 14400)", false;
    pageW = p["width"].get<double>();
    pageH = p["height"].get<double>();
  }
  std::string orientation = jstr(o, "orientation", "portrait");
  if (orientation != "portrait" && orientation != "landscape") return error = "orientation must be portrait or landscape", false;
  double margins[4] = {-1, -1, -1, -1};
  if (o.contains("margins")) {
    const json &m = o["margins"];
    if (!m.is_object()) return error = "margins must contain top, right, bottom and left in points", false;
    const char *keys[4] = {"top", "right", "bottom", "left"};
    for (int i = 0; i < 4; i++) {
      if (!print_number(m, keys[i], 0, 14400)) return error = "all margins must be nonnegative points", false;
      margins[i] = m[keys[i]].get<double>();
    }
    if (margins[3] + margins[1] >= pageW || margins[0] + margins[2] >= pageH) return error = "margins leave no printable area", false;
  }
  if (o.contains("pageRanges")) {
    const json &r = o["pageRanges"];
    if (!r.is_array() || r.empty()) return error = "pageRanges must be a nonempty array", false;
    double previous = 0;
    for (const json &range : r) {
      if (!range.is_object() || !print_number(range, "from", 1, INT_MAX) || !print_number(range, "to", 1, INT_MAX) ||
          std::floor(range["from"].get<double>()) != range["from"].get<double>() || std::floor(range["to"].get<double>()) != range["to"].get<double>() ||
          range["from"].get<double>() <= previous || range["to"].get<double>() < range["from"].get<double>())
        return error = "pageRanges must be ascending, nonoverlapping, one-based inclusive integer ranges", false;
      previous = range["to"].get<double>();
      if (!ranges.empty()) ranges += ",";
      ranges += std::to_string((int)range["from"].get<double>()) + "-" + std::to_string((int)range["to"].get<double>());
    }
    if (!pdf && r.size() != 1) return error = "physical printing accepts one contiguous page range", false;
  }
  auto *wv2 = query<ICoreWebView2_2>(v->webview, IID_ICoreWebView2_2);
  ICoreWebView2Environment *env = nullptr;
  if (wv2) wv2->get_Environment(&env);
  if (wv2) wv2->Release();
  auto *env6 = env ? query<ICoreWebView2Environment6>(env, IID_ICoreWebView2Environment6) : nullptr;
  if (env) env->Release();
  ICoreWebView2PrintSettings *settings = nullptr;
  HRESULT hr = env6 ? env6->CreatePrintSettings(&settings) : E_NOINTERFACE;
  if (env6) env6->Release();
  if (FAILED(hr) || !settings) return unsupported = true, error = "print options need a newer WebView2 runtime", false;
  settings->put_Orientation(orientation == "landscape" ? COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE : COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT);
  if (o.contains("paperSize")) {
    settings->put_PageWidth(pageW / 72);
    settings->put_PageHeight(pageH / 72);
  }
  if (margins[0] >= 0) {
    settings->put_MarginTop(margins[0] / 72);
    settings->put_MarginRight(margins[1] / 72);
    settings->put_MarginBottom(margins[2] / 72);
    settings->put_MarginLeft(margins[3] / 72);
  }
  if (!ranges.empty() || copies || !printer.empty()) {
    auto *s2 = query<ICoreWebView2PrintSettings2>(settings, IID_ICoreWebView2PrintSettings2);
    if (!s2) {
      settings->Release();
      return unsupported = true, error = "pageRanges, copies and printer need a newer WebView2 runtime", false;
    }
    if (!ranges.empty()) s2->put_PageRanges(wide(ranges).c_str());
    if (copies && !pdf) s2->put_Copies(copies);
    if (!printer.empty() && !pdf) s2->put_PrinterName(wide(printer).c_str());
    s2->Release();
  }
  *out = settings;
  return true;
}

static void print_finished(int id, bool success, const std::string &path) {
  View *v = find_view(id);
  json d = v ? view_source(v) : json::object();
  d["success"] = success;
  if (!path.empty()) d["path"] = path;
  emit("printFinished", d);
}

static void print_to_pdf(CallPtr c, View *v, const std::string &path, bool printReply) {
  ICoreWebView2PrintSettings *settings = nullptr;
  std::string error;
  bool unsupported = false;
  if (!print_settings(v, c->args, true, &settings, error, unsupported))
    return c->fail(unsupported ? "unsupported" : "invalid_args", "webview." + c->op + ": " + error);
  auto *wv7 = query<ICoreWebView2_7>(v->webview, IID_ICoreWebView2_7);
  if (!wv7) {
    settings->Release();
    return c->fail("unsupported", "webview.printToPDF: needs a newer WebView2 runtime");
  }
  std::wstring p = wide(path);
  int id = v->id;
  auto *cb = new Cb<ICoreWebView2PrintToPdfCompletedHandler, HRESULT, BOOL>(
      IID_ICoreWebView2PrintToPdfCompletedHandler, [c, path, printReply, id](HRESULT hr, BOOL ok) -> HRESULT {
        bool done = SUCCEEDED(hr) && ok;
        print_finished(id, done, path);
        if (!done) c->fail("unavailable", "webview." + c->op + ": the PDF could not be written");
        else if (printReply) c->ok(json{{"success", true}, {"path", path}});
        else c->ok(json{{"path", path}});
        return S_OK;
      });
  HRESULT hr = wv7->PrintToPdf(p.c_str(), settings, cb);
  cb->Release();
  settings->Release();
  wv7->Release();
  if (FAILED(hr)) c->fail("unavailable", "webview." + c->op + ": " + hresult_message(hr));
}

static void print_silently(CallPtr c, View *v) {
  ICoreWebView2PrintSettings *settings = nullptr;
  std::string error;
  bool unsupported = false;
  if (!print_settings(v, c->args, false, &settings, error, unsupported))
    return c->fail(unsupported ? "unsupported" : "invalid_args", "webview.print: " + error);
  auto *wv16 = query<ICoreWebView2_16>(v->webview, IID_ICoreWebView2_16);
  if (!wv16) {
    settings->Release();
    return c->fail("unsupported", "webview.print: needs a newer WebView2 runtime");
  }
  int id = v->id;
  auto *cb = new Cb<ICoreWebView2PrintCompletedHandler, HRESULT, COREWEBVIEW2_PRINT_STATUS>(
      IID_ICoreWebView2PrintCompletedHandler, [c, id](HRESULT hr, COREWEBVIEW2_PRINT_STATUS status) -> HRESULT {
        bool done = SUCCEEDED(hr) && status == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED;
        print_finished(id, done, "");
        if (done) c->ok(json{{"success", true}});
        else c->fail("unavailable", status == COREWEBVIEW2_PRINT_STATUS_PRINTER_UNAVAILABLE ? "webview.print: the printer is unavailable" : "webview.print: the print job failed");
        return S_OK;
      });
  HRESULT hr = wv16->Print(settings, cb);
  cb->Release();
  settings->Release();
  wv16->Release();
  if (FAILED(hr)) c->fail("unavailable", "webview.print: " + hresult_message(hr));
}

void register_webview() {
  vreg("setZoom", [](CallPtr c, View *v) {
    double z = c->num("zoom", 0);
    if (!(z > 0)) return c->fail("invalid_args", "webview.setZoom: `zoom` must be a positive number (1 = 100%)");
    v->controller->put_ZoomFactor(std::min(5.0, std::max(0.25, z)));
    c->ok(json{{"zoom", view_zoom(v)}});
  });
  vreg("getZoom", [](CallPtr c, View *v) { c->ok(json{{"zoom", view_zoom(v)}}); });
  vreg("reload", [](CallPtr c, View *v) {
    if (c->flag("ignoreCache", false))
    {
      auto *done = new Cb<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, HRESULT, LPCWSTR>(
          IID_ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, [](HRESULT, LPCWSTR) -> HRESULT { return S_OK; });
      v->webview->CallDevToolsProtocolMethod(L"Page.reload", L"{\"ignoreCache\":true}", done);
      done->Release();
    }
    else v->webview->Reload();
    c->ok();
  });
  vreg("stop", [](CallPtr c, View *v) {
    v->webview->Stop();
    c->ok();
  });
  vreg("goBack", [](CallPtr c, View *v) {
    BOOL can = FALSE;
    v->webview->get_CanGoBack(&can);
    if (can) v->webview->GoBack();
    c->ok(json{{"navigated", can != FALSE}});
  });
  vreg("goForward", [](CallPtr c, View *v) {
    BOOL can = FALSE;
    v->webview->get_CanGoForward(&can);
    if (can) v->webview->GoForward();
    c->ok(json{{"navigated", can != FALSE}});
  });
  vreg("getInfo", [](CallPtr c, View *v) {
    LPWSTR src = nullptr, title = nullptr;
    v->webview->get_Source(&src);
    v->webview->get_DocumentTitle(&title);
    BOOL back = FALSE, fwd = FALSE, devtools = FALSE;
    v->webview->get_CanGoBack(&back);
    v->webview->get_CanGoForward(&fwd);
    if (ICoreWebView2Settings *s = settings_of(v)) {
      s->get_AreDevToolsEnabled(&devtools);
      s->Release();
    }
    json d = {{"url", src ? json(utf8(src)) : json(nullptr)},
              {"title", utf8(title)},
              {"loading", false},
              {"canGoBack", back != FALSE},
              {"canGoForward", fwd != FALSE},
              {"zoom", view_zoom(v)},
              {"userAgent", v->userAgent.empty() ? json(nullptr) : json(v->userAgent)},
              {"debug", v->debug},
              {"inspectable", devtools != FALSE},
              {"contextMenu", v->contextMenu || v->debug ? "default" : "none"}};
    d.update(view_source(v));
    if (src) CoTaskMemFree(src);
    if (title) CoTaskMemFree(title);
    c->ok(d);
  });
  vreg("setUserAgent", [](CallPtr c, View *v) {
    v->userAgent = c->str("userAgent");
    ICoreWebView2Settings *s = settings_of(v);
    auto *s2 = s ? query<ICoreWebView2Settings2>(s, IID_ICoreWebView2Settings2) : nullptr;
    if (s) s->Release();
    if (!s2) return c->fail("unsupported", "webview.setUserAgent: needs a newer WebView2 runtime");
    // Empty -> back to the runtime's default (captured on first change).
    static std::string original;
    if (original.empty()) original = default_user_agent(v);
    s2->put_UserAgent(wide(v->userAgent.empty() ? original : v->userAgent).c_str());
    s2->Release();
    c->ok();
  });
  vreg("getUserAgent", [](CallPtr c, View *v) {
    view_execute(v, "navigator.userAgent", [c, v](bool ok, const json &value, const std::string &) {
      c->ok(ok && value.is_string() ? value : json(default_user_agent(v)));
    });
  });
  vreg("setInspectable", [](CallPtr c, View *v) {
    bool on = c->flag("enabled", true);
    if (ICoreWebView2Settings *s = settings_of(v)) {
      s->put_AreDevToolsEnabled(on ? TRUE : FALSE);
      s->Release();
    }
    c->ok(json{{"inspectable", on}});
  });
  vreg("openDevTools", [](CallPtr c, View *v) {
    v->webview->OpenDevToolsWindow();
    c->ok();
  });
  vreg("executeJavaScript", [](CallPtr c, View *v) {
    if (!(c->args.contains("code") && c->args["code"].is_string()))
      return c->fail("invalid_args", "webview.executeJavaScript: `code` is required");
    view_execute(v, c->str("code"), [c](bool ok, const json &value, const std::string &error) {
      ok ? c->ok(value) : c->fail("internal", "webview.executeJavaScript: " + error);
    });
  });
  vreg("capturePage", [](CallPtr c, View *v) { capture(c, v); });
  reg("webview", "setContextMenu", [](CallPtr c) {
    std::string mode = c->str("mode");
    if (mode != "default" && mode != "none" && mode != "custom")
      return c->fail("invalid_args", "webview.setContextMenu: `mode` must be default | none | custom");
    if (mode == "custom") return c->fail("unsupported", "webview.setContextMenu: mode `custom` is not implemented on Windows");
    std::vector<View *> targets;
    if (c->flag("all", false)) {
      for (auto &[id, v] : views()) targets.push_back(v);
    } else {
      View *v = resolve_view(c);
      if (!v) return;
      targets.push_back(v);
    }
    for (View *v : targets) {
      v->contextMenu = mode == "default";
      if (ICoreWebView2Settings *s = settings_of(v)) {
        s->put_AreDefaultContextMenusEnabled(v->contextMenu ? TRUE : FALSE);
        s->Release();
      }
    }
    c->ok(json{{"mode", mode}});
  });
  vreg("getContextMenu", [](CallPtr c, View *v) {
    c->ok(json{{"mode", v->contextMenu ? "default" : "none"}, {"editMenu", true}, {"debug", v->debug}, {"items", json::array()}});
  });
  reg("webview", "getPrinters", [](CallPtr c) { c->ok(printer_names()); });
  vreg("printToPDF", [](CallPtr c, View *v) {
    std::string path = expand_home(c->str("path"));
    if (path.empty()) return c->fail("invalid_args", "webview.printToPDF: `path` is required");
    print_to_pdf(c, v, path, false);
  });
  vreg("print", [](CallPtr c, View *v) {
    std::string pdf = expand_home(c->str("pdfPath"));
    if (!pdf.empty()) return print_to_pdf(c, v, pdf, true);
    if (c->flag("silent", false)) return print_silently(c, v);
    // The dialog takes no settings: what the options ask is for the user to pick there.
    ICoreWebView2PrintSettings *settings = nullptr;
    std::string error;
    bool unsupported = false;
    if (!print_settings(v, c->args, false, &settings, error, unsupported)) return c->fail(unsupported ? "unsupported" : "invalid_args", "webview.print: " + error);
    settings->Release();
    auto *wv16 = query<ICoreWebView2_16>(v->webview, IID_ICoreWebView2_16);
    if (!wv16) return c->fail("unsupported", "webview.print: needs a newer WebView2 runtime");
    HRESULT hr = wv16->ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER);
    wv16->Release();
    if (FAILED(hr)) return c->fail("unavailable", "webview.print: " + hresult_message(hr));
    c->ok(json{{"started", true}});
  });
  reg("webview", "getOpenedFiles", [](CallPtr c) {
    // Same queue as app.getOpenedFiles.
    sd::dispatch(json{{"service", "app"}, {"op", "getOpenedFiles"}}, c->caller, [c](const json &r) {
      jbool(r, "ok", false) ? c->ok(r["value"]) : c->fail("internal", "getOpenedFiles failed");
    });
  });
}

} // namespace sd::win
