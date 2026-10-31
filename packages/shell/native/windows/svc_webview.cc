// webview.* — zoom (ZoomFactor), navigation, user agent, devtools, context
// menu on/off, executeJavaScript (DevTools Runtime.evaluate: awaits promises,
// returns JSON), capturePage (CapturePreview -> PNG/JPEG), print / printToPDF.
// Target: args.popoverId, args.windowId (public id), the calling page, or the
// primary window.
#include "win.hpp"

#include <shlwapi.h>


namespace sd::win {

static View *resolve_view(CallPtr c) {
  std::string pid = c->str("popoverId");
  if (!pid.empty()) {
    View *v = popover_view(pid);
    if (!v) c->fail("invalid_args", "webview." + c->op + ": unknown popover `" + pid + "`");
    return v;
  }
  if (!c->has("windowId") && c->caller && !find_window(c->caller))
    if (View *v = find_view(c->caller)) return v; // a popover page
  Window *w = find_window(resolve_window(*c));
  if (!w) {
    c->fail("invalid_args", "webview." + c->op + ": no such window");
    return nullptr;
  }
  return &w->view;
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

static void print_to_pdf(CallPtr c, View *v, const std::string &path, bool printReply) {
  auto *wv7 = query<ICoreWebView2_7>(v->webview, IID_ICoreWebView2_7);
  if (!wv7) return c->fail("unsupported", "webview.printToPDF: needs a newer WebView2 runtime");
  std::wstring p = wide(path);
  auto *cb = new Cb<ICoreWebView2PrintToPdfCompletedHandler, HRESULT, BOOL>(
      IID_ICoreWebView2PrintToPdfCompletedHandler, [c, path, printReply](HRESULT hr, BOOL ok) -> HRESULT {
        if (FAILED(hr) || !ok) c->fail("unavailable", "webview." + c->op + ": the PDF could not be written");
        else if (printReply) c->ok(json{{"success", true}, {"path", path}});
        else c->ok(json{{"path", path}});
        return S_OK;
      });
  HRESULT hr = wv7->PrintToPdf(p.c_str(), nullptr, cb);
  cb->Release();
  wv7->Release();
  if (FAILED(hr)) c->fail("unavailable", "webview." + c->op + ": " + hresult_message(hr));
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
    std::string popover = popover_id_of(v->id);
    if (!popover.empty()) d["popoverId"] = popover;
    else d["windowId"] = backend_public_window_id(v->id);
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
  vreg("printToPDF", [](CallPtr c, View *v) {
    std::string path = c->str("path");
    if (path.empty()) return c->fail("invalid_args", "webview.printToPDF: `path` is required");
    print_to_pdf(c, v, path, false);
  });
  vreg("print", [](CallPtr c, View *v) {
    std::string pdf = c->str("pdfPath");
    if (!pdf.empty()) return print_to_pdf(c, v, pdf, true);
    auto *wv16 = query<ICoreWebView2_16>(v->webview, IID_ICoreWebView2_16);
    if (!wv16) return c->fail("unsupported", "webview.print: needs a newer WebView2 runtime");
    HRESULT hr = wv16->ShowPrintUI(c->flag("silent", false) ? COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM : COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER);
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
