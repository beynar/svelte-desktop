// webview.* controls every web view of the shell gets (windows, popovers, views). Same contracts as
// platform_webview.mm and linux/svc_web_control.cc:
//   find · clearFind · getDialog · respondToDialog · setFileDrop · clearData
//   setAudioMuted · pauseMedia · getMediaState · setBackgroundThrottling · setRecovery · _terminateForTesting
// Events: jsDialog, fileDragEnter, fileDragLeave, fileDrop, webviewLifecycle (`terminated` only).
//
// Where WebView2 differs:
// - A file drag reaches the host only through the page: the OS talks to the browser process's own
//   drop target. `fileDragEnter` has no paths, because a page doesn't get them before the drop.
// - ClearBrowsingData has no site filter, and clearData must keep the app's own data unless asked:
//   sites are cleared one by one over the DevTools protocol, from a record of the origins views loaded.
// - No call says what a page captures: getUserMedia is watched from the page.
#include "win.hpp"

#include <cmath>
#include <set>

namespace sd::win {

struct Control {
  std::string nonce;
  bool fileDrop = true, dragging = false;
  unsigned dragGeneration = 0;
  std::string recovery = "reload";
  std::string findText, findPage;
  bool findCase = false;
  unsigned findGeneration = 0;
  ICoreWebView2ScriptDialogOpeningEventArgs *dialog = nullptr;
  ICoreWebView2Deferral *dialogDeferral = nullptr;
  std::string dialogType, dialogMessage, dialogDefault;
  HWND dialogWindow = nullptr, dialogEdit = nullptr;
};

static std::map<int, Control> g_controls;
static bool g_file_drop_default = true;

static std::string take(LPWSTR s) {
  std::string out = utf8(s);
  if (s) CoTaskMemFree(s);
  return out;
}

static std::string view_page(View *v) {
  LPWSTR source = nullptr;
  v->webview->get_Source(&source);
  return take(source);
}

static void emit_for(View *v, const std::string &name, const json &data = json::object()) {
  json d = view_source(v);
  d.update(data);
  emit(name, d);
}

using ControlOp = std::function<void(CallPtr, View *, Control &)>;
static void op(const std::string &name, ControlOp body) {
  reg("webview", name, [body](CallPtr c) {
    View *v = view_for_call(c);
    if (!v) return;
    if (!v->webview) return c->fail("unavailable", "webview." + c->op + ": the web view is not ready yet");
    body(c, v, g_controls[v->id]);
  });
}

static void devtools(View *v, const wchar_t *method, const json &params, std::function<void(bool)> done) {
  auto *cb = new Cb<ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, HRESULT, LPCWSTR>(
      IID_ICoreWebView2CallDevToolsProtocolMethodCompletedHandler, [done](HRESULT hr, LPCWSTR) -> HRESULT {
        done(SUCCEEDED(hr));
        return S_OK;
      });
  HRESULT hr = v->webview->CallDevToolsProtocolMethod(method, wide(params.dump()).c_str(), cb);
  cb->Release();
  if (FAILED(hr)) done(false);
}

// ===========================================================================
// Find

static ICoreWebView2Find *find_of(View *v) {
  ICoreWebView2Find *find = nullptr;
  if (auto *wv28 = query<ICoreWebView2_28>(v->webview, IID_ICoreWebView2_28)) {
    wv28->get_Find(&find);
    wv28->Release();
  }
  return find;
}

static ICoreWebView2FindOptions *find_options(View *v) {
  auto *wv2 = query<ICoreWebView2_2>(v->webview, IID_ICoreWebView2_2);
  ICoreWebView2Environment *env = nullptr;
  if (wv2) wv2->get_Environment(&env);
  if (wv2) wv2->Release();
  auto *env15 = env ? query<ICoreWebView2Environment15>(env, IID_ICoreWebView2Environment15) : nullptr;
  if (env) env->Release();
  ICoreWebView2FindOptions *options = nullptr;
  if (env15) env15->CreateFindOptions(&options);
  if (env15) env15->Release();
  return options;
}

static void find_read(View *v, int &count, int &active) {
  count = 0, active = -1;
  if (ICoreWebView2Find *find = find_of(v)) {
    find->get_MatchCount(&count);
    find->get_ActiveMatchIndex(&active);
    find->Release();
  }
}

// The scan goes on after Start has answered, and no match changes nothing: only a wait can tell.
static void find_wait(int id, unsigned generation, int tries, std::function<bool(int count, int active)> settled, std::function<void(bool current, int count, int active)> done) {
  View *v = find_view(id);
  auto it = g_controls.find(id);
  if (!v || !v->webview || it == g_controls.end() || it->second.findGeneration != generation) return done(false, 0, -1);
  int count, active;
  find_read(v, count, active);
  if (tries <= 0 || settled(count, active)) return done(true, count, active);
  run_after(20, [=] { find_wait(id, generation, tries - 1, settled, done); });
}

static void find_step(CallPtr c, View *v, Control &s, ICoreWebView2Find *find, bool backwards, bool wraps, int count, int active) {
  if (count <= 0) return c->ok(json{{"matchFound", false}});
  if (!wraps && active == (backwards ? 1 : count)) return c->ok(json{{"matchFound", false}});
  if (count == 1) return c->ok(json{{"matchFound", true}});
  backwards ? find->FindPrevious() : find->FindNext();
  find_wait(v->id, s.findGeneration, 50, [active](int, int now) { return now != active; }, [c](bool, int, int) { c->ok(json{{"matchFound", true}}); });
}

static void find_text(CallPtr c, View *v, Control &s) {
  std::string text = c->str("text");
  if (text.empty()) return c->fail("invalid_args", "webview.find: `text` is required");
  bool backwards = c->flag("backwards", false), wraps = c->flag("wraps", true), matchCase = c->flag("caseSensitive", false);
  ICoreWebView2Find *find = find_of(v);
  ICoreWebView2FindOptions *options = find ? find_options(v) : nullptr;
  if (!options) {
    if (find) find->Release();
    return c->fail("unavailable", "webview.find: needs a newer WebView2 runtime");
  }
  // The same search again goes to its next match, as on macOS.
  std::string page = view_page(v);
  if (s.findText == text && s.findCase == matchCase && s.findPage == page) {
    int count, active;
    find_read(v, count, active);
    find_step(c, v, s, find, backwards, wraps, count, active);
    find->Release();
    options->Release();
    return;
  }
  s.findText = text, s.findCase = matchCase, s.findPage = page;
  unsigned generation = ++s.findGeneration;
  options->put_FindTerm(wide(text).c_str());
  options->put_IsCaseSensitive(matchCase ? TRUE : FALSE);
  options->put_SuppressDefaultFindDialog(TRUE);
  int id = v->id;
  auto *started = new Cb<ICoreWebView2FindStartCompletedHandler, HRESULT>(
      IID_ICoreWebView2FindStartCompletedHandler, [=](HRESULT hr) -> HRESULT {
        if (FAILED(hr)) {
          c->fail("unavailable", "webview.find: " + hresult_message(hr));
          return S_OK;
        }
        find_wait(id, generation, 50, [](int count, int active) { return count > 0 && active > 0; }, [=](bool current, int count, int active) {
          if (!current || count <= 0) return c->ok(json{{"matchFound", false}});
          if (!backwards) return c->ok(json{{"matchFound", true}}); // the first match
          // Backwards from the top of the page: nothing before it, or the last one.
          View *v = find_view(id);
          ICoreWebView2Find *find = v ? find_of(v) : nullptr;
          if (!find) return c->ok(json{{"matchFound", false}});
          find_step(c, v, g_controls[id], find, true, wraps, count, active);
          find->Release();
        });
        return S_OK;
      });
  HRESULT hr = find->Start(options, started);
  started->Release();
  options->Release();
  find->Release();
  if (FAILED(hr)) c->fail("unavailable", "webview.find: " + hresult_message(hr));
}

// ===========================================================================
// JavaScript dialogs: ours, not WebView2's, so that respondToDialog can answer them

static void finish_dialog(Control &s, bool accept, const std::string *text) {
  if (!s.dialog) return;
  ICoreWebView2ScriptDialogOpeningEventArgs *args = s.dialog;
  ICoreWebView2Deferral *deferral = s.dialogDeferral;
  HWND window = s.dialogWindow;
  if (accept) {
    if (s.dialogType == "prompt") args->put_ResultText(wide(text ? *text : s.dialogDefault).c_str());
    args->Accept();
  }
  s.dialog = nullptr;
  s.dialogDeferral = nullptr;
  s.dialogWindow = s.dialogEdit = nullptr;
  s.dialogType.clear();
  s.dialogMessage.clear();
  s.dialogDefault.clear();
  deferral->Complete();
  deferral->Release();
  args->Release();
  if (window) EndDialog(window, 0);
}

static std::string dialog_text(const Control &s) {
  if (!s.dialogEdit) return s.dialogDefault;
  std::wstring text((size_t)GetWindowTextLengthW(s.dialogEdit) + 1, L'\0');
  GetWindowTextW(s.dialogEdit, &text[0], (int)text.size());
  text.resize(text.size() - 1);
  return utf8(text);
}

static INT_PTR CALLBACK dialog_proc(HWND dialog, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_INITDIALOG) {
    SetWindowLongPtrW(dialog, DWLP_USER, lparam);
    Control &s = g_controls[(int)lparam];
    s.dialogWindow = dialog;
    const int unit = (int)GetDpiForWindow(dialog), margin = MulDiv(16, unit, 96), width = MulDiv(420, unit, 96), gap = MulDiv(12, unit, 96);
    const int buttonW = MulDiv(84, unit, 96), buttonH = MulDiv(26, unit, 96), editH = MulDiv(24, unit, 96);
    HFONT font = (HFONT)SendMessageW(dialog, WM_GETFONT, 0, 0);
    std::wstring text = wide(s.dialogMessage);
    RECT measured{0, 0, width - 2 * margin, 0};
    HDC dc = GetDC(dialog);
    HGDIOBJ old = SelectObject(dc, font);
    DrawTextW(dc, text.c_str(), (int)text.size(), &measured, DT_WORDBREAK | DT_CALCRECT | DT_NOPREFIX);
    SelectObject(dc, old);
    ReleaseDC(dialog, dc);
    MONITORINFO mi{sizeof mi};
    GetMonitorInfoW(MonitorFromWindow(GetParent(dialog), MONITOR_DEFAULTTONEAREST), &mi);
    const int textH = (int)std::min<LONG>(measured.bottom, (mi.rcWork.bottom - mi.rcWork.top) * 3 / 5);
    auto child = [&](const wchar_t *cls, const wchar_t *label, DWORD style, int x, int y, int w, int h, int ident) {
      HWND ctl = CreateWindowExW(wcscmp(cls, L"EDIT") == 0 ? WS_EX_CLIENTEDGE : 0, cls, label, WS_CHILD | WS_VISIBLE | style, x, y, w, h, dialog, (HMENU)(INT_PTR)ident, GetModuleHandleW(nullptr), nullptr);
      SendMessageW(ctl, WM_SETFONT, (WPARAM)font, TRUE);
      return ctl;
    };
    int y = margin;
    child(L"STATIC", text.c_str(), SS_LEFT | SS_NOPREFIX, margin, y, width - 2 * margin, textH, -1);
    y += textH + gap;
    if (s.dialogType == "prompt") {
      s.dialogEdit = child(L"EDIT", wide(s.dialogDefault).c_str(), WS_TABSTOP | ES_AUTOHSCROLL, margin, y, width - 2 * margin, editH, 100);
      y += editH + gap;
    }
    int x = width - margin - buttonW;
    if (s.dialogType != "alert") {
      child(L"BUTTON", L"Cancel", WS_TABSTOP | BS_PUSHBUTTON, x, y, buttonW, buttonH, IDCANCEL);
      x -= buttonW + MulDiv(8, unit, 96);
    }
    HWND ok = child(L"BUTTON", L"OK", WS_TABSTOP | BS_DEFPUSHBUTTON, x, y, buttonW, buttonH, IDOK);
    RECT outer{0, 0, width, y + buttonH + margin};
    AdjustWindowRectExForDpi(&outer, (DWORD)GetWindowLongPtrW(dialog, GWL_STYLE), FALSE, (DWORD)GetWindowLongPtrW(dialog, GWL_EXSTYLE), (UINT)unit);
    RECT owner{};
    GetWindowRect(GetParent(dialog), &owner);
    const int outerW = outer.right - outer.left, outerH = outer.bottom - outer.top;
    SetWindowPos(dialog, nullptr, (owner.left + owner.right - outerW) / 2, (owner.top + owner.bottom - outerH) / 2, outerW, outerH, SWP_NOZORDER);
    SetFocus(s.dialogEdit ? s.dialogEdit : ok);
    if (s.dialogEdit) SendMessageW(s.dialogEdit, EM_SETSEL, 0, -1);
    return FALSE; // the focus is set
  }
  if (message == WM_COMMAND && (LOWORD(wparam) == IDOK || LOWORD(wparam) == IDCANCEL)) {
    Control &s = g_controls[(int)GetWindowLongPtrW(dialog, DWLP_USER)];
    std::string text = dialog_text(s);
    // An alert has one answer: Escape or the close box dismiss it the same.
    finish_dialog(s, LOWORD(wparam) == IDOK || s.dialogType == "alert", &text);
    return TRUE;
  }
  return FALSE;
}

// An empty template: the controls depend on the message and the kind. Runs modal, from a posted
// task (svc_dialog.cc says why): it blocks its window, as a sheet does on macOS.
static void show_dialog(int id, ICoreWebView2ScriptDialogOpeningEventArgs *args) {
  auto it = g_controls.find(id);
  View *v = find_view(id);
  if (!v || it == g_controls.end() || it->second.dialog != args) return; // answered already
  std::wstring title = wide(app_name());
  std::vector<WORD> words(sizeof(DLGTEMPLATE) / sizeof(WORD), 0);
  auto *tmpl = reinterpret_cast<DLGTEMPLATE *>(words.data());
  tmpl->style = DS_SETFONT | DS_MODALFRAME | WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE;
  auto add = [&words](const std::wstring &s) {
    for (wchar_t ch : s) words.push_back((WORD)ch);
    words.push_back(0);
  };
  words.push_back(0); // no menu
  words.push_back(0); // the default class
  add(title);
  words.push_back(9);
  add(L"Segoe UI");
  std::vector<DWORD> aligned(words.size() / 2 + 1);
  memcpy(aligned.data(), words.data(), words.size() * sizeof(WORD));
  DialogBoxIndirectParamW(GetModuleHandleW(nullptr), reinterpret_cast<DLGTEMPLATE *>(aligned.data()), GetAncestor(v->host, GA_ROOT), dialog_proc, id);
}

static void on_script_dialog(int id, ICoreWebView2ScriptDialogOpeningEventArgs *args) {
  View *v = find_view(id);
  COREWEBVIEW2_SCRIPT_DIALOG_KIND kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT;
  args->get_Kind(&kind);
  // macOS shows none: the page just leaves.
  if (kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD || !v) {
    args->Accept();
    return;
  }
  Control &s = g_controls[id];
  finish_dialog(s, false, nullptr); // one at a time
  if (FAILED(args->GetDeferral(&s.dialogDeferral)) || !s.dialogDeferral) return;
  args->AddRef();
  s.dialog = args;
  s.dialogType = kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT ? "alert" : kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM ? "confirm" : "prompt";
  LPWSTR message = nullptr, text = nullptr;
  args->get_Message(&message);
  s.dialogMessage = take(message);
  json event{{"type", s.dialogType}, {"message", s.dialogMessage}};
  if (kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT) {
    args->get_DefaultText(&text);
    s.dialogDefault = take(text);
    event["defaultValue"] = s.dialogDefault;
  }
  emit_for(v, "jsDialog", event);
  run_after(0, [id, args] { show_dialog(id, args); });
}

// ===========================================================================
// What runs in every document: the media a page plays and captures, and its file drags. The nonce
// keeps a page from forging a drag: it stays in this closure, as do the calls it's sent with.

static std::string page_script(const std::string &nonce) {
  return "(()=>{const N=" + json(nonce + ":").dump() + ";"
         "const loose=new Set(),tracks=new Set();const P=HTMLMediaElement.prototype,play=P.play;"
         "P.play=function(){if(!this.isConnected){loose.add(this);this.addEventListener('ended',()=>loose.delete(this),{once:true});}return play.apply(this,arguments);};"
         "if(window.MediaDevices){const D=MediaDevices.prototype,get=D.getUserMedia;"
         "D.getUserMedia=function(){return get.apply(this,arguments).then((s)=>{for(const t of s.getTracks())tracks.add(t);return s;});};}"
         "const collect=()=>{const media=[...loose],live=[...tracks];const walk=(r)=>{for(const e of r.querySelectorAll('*')){"
         "if(e.tagName==='VIDEO'||e.tagName==='AUDIO')media.push(e);if(e.shadowRoot)walk(e.shadowRoot);"
         "if(e.tagName==='IFRAME'){try{const m=e.contentWindow.__shellMedia;if(m){const c=m.collect();media.push(...c.media);live.push(...c.live);}}catch(_){}}}};"
         "walk(document);return{media,live};};"
         "const capture=(all,kind)=>{const t=all.filter((x)=>x.kind===kind&&x.readyState==='live');return t.some((x)=>x.enabled)?'active':t.length?'muted':'none';};"
         "Object.defineProperty(window,'__shellMedia',{value:Object.freeze({collect,pause(){for(const m of collect().media)m.pause();},"
         "state(){const{media,live}=collect();return{playback:media.some((m)=>!m.paused&&!m.ended)?'playing':media.length?'paused':'none',"
         "camera:capture(live,'video'),microphone:capture(live,'audio')};}})});"
         "const W=window.chrome&&chrome.webview;if(!W||!W.postMessageWithAdditionalObjects)return;"
         "const send=W.postMessage.bind(W),sendFiles=W.postMessageWithAdditionalObjects.bind(W),S=JSON.stringify;"
         "const files=(e)=>e.isTrusted&&e.dataTransfer&&[...e.dataTransfer.types].includes('Files');"
         "addEventListener('dragenter',(e)=>{if(files(e))send(N+S(['enter',e.clientX,e.clientY]));},true);"
         // Without this a page that doesn't take the drag gets no drop, and there would be no paths.
         "addEventListener('dragover',(e)=>{if(files(e))e.preventDefault();},true);"
         "addEventListener('dragleave',(e)=>{if(files(e)&&!e.relatedTarget)send(N+S(['leave',0,0]));},true);"
         "addEventListener('drop',(e)=>{if(files(e))sendFiles(N+S(['drop',e.clientX,e.clientY]),e.dataTransfer.files);},true);"
         "})();";
}

// ===========================================================================
// File drop

static std::vector<std::string> message_paths(ICoreWebView2WebMessageReceivedEventArgs *args) {
  std::vector<std::string> paths;
  auto *args2 = query<ICoreWebView2WebMessageReceivedEventArgs2>(args, IID_ICoreWebView2WebMessageReceivedEventArgs2);
  ICoreWebView2ObjectCollectionView *objects = nullptr;
  if (args2) args2->get_AdditionalObjects(&objects);
  if (args2) args2->Release();
  if (!objects) return paths;
  UINT32 count = 0;
  objects->get_Count(&count);
  for (UINT32 i = 0; i < count; i++) {
    IUnknown *object = nullptr;
    if (FAILED(objects->GetValueAtIndex(i, &object)) || !object) continue;
    if (auto *file = query<ICoreWebView2File>(object, IID_ICoreWebView2File)) {
      LPWSTR path = nullptr;
      file->get_Path(&path);
      paths.push_back(take(path));
      file->Release();
    }
    object->Release();
  }
  objects->Release();
  return paths;
}

bool web_control_message(int id, const std::string &body, ICoreWebView2WebMessageReceivedEventArgs *args, bool top) {
  auto it = g_controls.find(id);
  View *v = find_view(id);
  if (!v || it == g_controls.end() || body.rfind(it->second.nonce + ":", 0) != 0) return false;
  json m = json::parse(body.substr(it->second.nonce.size() + 1), nullptr, false);
  if (!m.is_array() || m.size() != 3 || !m[0].is_string() || !m[1].is_number() || !m[2].is_number()) return true;
  Control &s = it->second;
  std::string kind = m[0].get<std::string>();
  double x = m[1].get<double>(), y = m[2].get<double>();
  if (!top) { // a frame's are its own: the page's, from where the pointer is
    POINT p{};
    GetCursorPos(&p);
    ScreenToClient(v->host, &p);
    const double scale = hwnd_scale(v->host) * view_zoom(v);
    x = p.x / scale, y = p.y / scale;
  }
  unsigned generation = ++s.dragGeneration;
  if (kind == "enter") {
    if (s.dragging || !s.fileDrop) return true;
    s.dragging = true;
    emit_for(v, "fileDragEnter", json{{"paths", json::array()}, {"x", std::round(x)}, {"y", std::round(y)}});
  } else if (kind == "leave") {
    // Going from a page into its frame looks the same, with an enter right after.
    run_after(60, [id, generation] {
      auto it = g_controls.find(id);
      View *v = find_view(id);
      if (!v || it == g_controls.end() || it->second.dragGeneration != generation || !it->second.dragging) return;
      it->second.dragging = false;
      emit_for(v, "fileDragLeave");
    });
  } else if (kind == "drop") {
    s.dragging = false;
    auto paths = message_paths(args);
    if (s.fileDrop && !paths.empty()) emit_for(v, "fileDrop", json{{"paths", paths}, {"x", std::round(x)}, {"y", std::round(y)}});
  }
  return true;
}

// Frames have their own message event, and each frame its own children.
static void attach_frame(int id, ICoreWebView2Frame *frame) {
  auto *frame2 = query<ICoreWebView2Frame2>(frame, IID_ICoreWebView2Frame2);
  if (!frame2) return;
  auto *onMessage = new Cb<ICoreWebView2FrameWebMessageReceivedEventHandler, ICoreWebView2Frame *, ICoreWebView2WebMessageReceivedEventArgs *>(
      IID_ICoreWebView2FrameWebMessageReceivedEventHandler, [id](ICoreWebView2Frame *, ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT {
        LPWSTR message = nullptr;
        if (SUCCEEDED(args->TryGetWebMessageAsString(&message)) && message) web_control_message(id, take(message), args, false);
        return S_OK;
      });
  EventRegistrationToken token{};
  frame2->add_WebMessageReceived(onMessage, &token);
  onMessage->Release();
  frame2->Release();
  if (auto *frame7 = query<ICoreWebView2Frame7>(frame, IID_ICoreWebView2Frame7)) {
    auto *onChild = new Cb<ICoreWebView2FrameChildFrameCreatedEventHandler, ICoreWebView2Frame *, ICoreWebView2FrameCreatedEventArgs *>(
        IID_ICoreWebView2FrameChildFrameCreatedEventHandler, [id](ICoreWebView2Frame *, ICoreWebView2FrameCreatedEventArgs *args) -> HRESULT {
          ICoreWebView2Frame *child = nullptr;
          if (SUCCEEDED(args->get_Frame(&child)) && child) {
            attach_frame(id, child);
            child->Release();
          }
          return S_OK;
        });
    frame7->add_FrameCreated(onChild, &token);
    onChild->Release();
    frame7->Release();
  }
  // Its handlers live as long as this object: until the frame goes.
  frame->AddRef();
  auto *onGone = new Cb<ICoreWebView2FrameDestroyedEventHandler, ICoreWebView2Frame *, IUnknown *>(
      IID_ICoreWebView2FrameDestroyedEventHandler, [frame](ICoreWebView2Frame *, IUnknown *) -> HRESULT {
        frame->Release();
        return S_OK;
      });
  frame->add_Destroyed(onGone, &token);
  onGone->Release();
}

// ===========================================================================
// clearData

static std::set<std::string> &loaded_sites() {
  static std::set<std::string> sites = [] {
    std::set<std::string> out;
    json saved = read_json_file(local_file("web-sites.json"), json::array());
    if (saved.is_array())
      for (const json &site : saved)
        if (site.is_string()) out.insert(site.get<std::string>());
    return out;
  }();
  return sites;
}

void web_site_seen(const std::string &url) {
  std::string scheme = url_scheme(url);
  if ((scheme != "http" && scheme != "https") || !loaded_sites().insert(url_origin(url)).second) return;
  write_json_file(local_file("web-sites.json"), json(loaded_sites()));
}

static std::string origin_host(const std::string &origin) {
  auto start = origin.find("://");
  std::string authority = start == std::string::npos ? origin : origin.substr(start + 3);
  if (!authority.empty() && authority[0] == '[') return authority.substr(0, authority.find(']') + 1);
  return authority.substr(0, authority.find(':'));
}

// As on the other platforms: what's the app's goes by host, whatever the port.
static bool is_app_host(const std::string &host) { return host == origin_host(app_origin()) || host == "localhost" || host == "127.0.0.1"; }

struct ClearRun {
  CallPtr c;
  bool app = false;
  std::string storage; // Storage.clearDataForOrigin's types
  int kinds = 0;       // ClearBrowsingData's, for `app`
  bool cookies = false, session = false, cache = false, all = false;
  std::vector<std::string> origins;
  std::set<std::string> names;
  size_t next = 0;
};

static View *any_view() {
  for (auto &[id, v] : views())
    if (v->webview) return v;
  return nullptr;
}

static void clear_finish(std::shared_ptr<ClearRun> run) {
  if (run->all) {
    // A site left behind isn't looked at again until a view goes back to it.
    std::set<std::string> shown;
    for (auto &[id, v] : views())
      if (v->webview) shown.insert(url_origin(view_page(v)));
    auto &sites = loaded_sites();
    for (auto it = sites.begin(); it != sites.end();) it = !shown.count(*it) && (run->app || !is_app_host(origin_host(*it))) ? sites.erase(it) : std::next(it);
    write_json_file(local_file("web-sites.json"), json(sites));
  }
  run->c->ok(json{{"cleared", run->names}});
}

// ClearBrowsingData is for the whole profile: the disk cache, which is the same whoever filled it,
// and with `app` all that was asked for, whichever site's it is.
static void clear_profile(std::shared_ptr<ClearRun> run) {
  int kinds = run->app ? run->kinds : run->cache ? (int)COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE : 0;
  if (!kinds) return clear_finish(run);
  View *v = any_view();
  auto *wv13 = v ? query<ICoreWebView2_13>(v->webview, IID_ICoreWebView2_13) : nullptr;
  ICoreWebView2Profile *profile = nullptr;
  if (wv13) wv13->get_Profile(&profile);
  if (wv13) wv13->Release();
  auto *profile2 = profile ? query<ICoreWebView2Profile2>(profile, IID_ICoreWebView2Profile2) : nullptr;
  if (profile) profile->Release();
  if (!profile2) return run->c->fail("unavailable", "webview.clearData: needs a newer WebView2 runtime");
  auto *done = new Cb<ICoreWebView2ClearBrowsingDataCompletedHandler, HRESULT>(
      IID_ICoreWebView2ClearBrowsingDataCompletedHandler, [run](HRESULT hr) -> HRESULT {
        if (FAILED(hr)) run->c->fail("unavailable", "webview.clearData: " + hresult_message(hr));
        else clear_finish(run);
        return S_OK;
      });
  HRESULT hr = profile2->ClearBrowsingData((COREWEBVIEW2_BROWSING_DATA_KINDS)kinds, done);
  done->Release();
  profile2->Release();
  if (FAILED(hr)) run->c->fail("unavailable", "webview.clearData: " + hresult_message(hr));
}

// One call at a time, each site's data and, in every view, its sessionStorage: that lives in the
// view, and only for what the view shows. A view that doesn't show the origin answers an error.
static void clear_sites(std::shared_ptr<ClearRun> run) {
  auto queue = std::make_shared<std::vector<std::function<void(std::function<void()>)>>>();
  for (const std::string &origin : run->origins) {
    if (!run->storage.empty())
      queue->push_back([run, origin](std::function<void()> next) {
        View *v = any_view();
        if (!v) return next();
        devtools(v, L"Storage.clearDataForOrigin", json{{"origin", origin}, {"storageTypes", run->storage}}, [next](bool) { next(); });
      });
    if (run->session)
      for (auto &[id, view] : views())
        queue->push_back([id = id, origin](std::function<void()> next) {
          View *v = find_view(id);
          if (!v || !v->webview) return next();
          devtools(v, L"DOMStorage.clear", json{{"storageId", {{"securityOrigin", origin}, {"isLocalStorage", false}}}}, [next](bool) { next(); });
        });
  }
  auto step = std::make_shared<std::function<void(size_t)>>();
  *step = [run, queue, step](size_t i) {
    if (i < queue->size()) return (*queue)[i]([step, i] { (*step)(i + 1); });
    auto last = run;
    *step = nullptr; // it holds itself; this very closure goes with it
    clear_profile(last);
  };
  (*step)(0);
}

static void clear_data(CallPtr c) {
  json names = c->args.contains("types") && c->args["types"].is_array() ? c->args["types"] : json::array({"all"});
  auto run = std::make_shared<ClearRun>();
  run->c = c;
  run->app = c->flag("app", false);
  std::set<std::string> storage;
  for (const json &n : names) {
    std::string name = n.is_string() ? n.get<std::string>() : n.dump();
    if (name == "all") {
      run->all = run->cookies = run->session = run->cache = true;
      storage.insert({"local_storage", "indexeddb", "cache_storage", "service_workers", "file_systems"});
      run->kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_LOCAL_STORAGE | COREWEBVIEW2_BROWSING_DATA_KINDS_INDEXED_DB | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE |
                    COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS | COREWEBVIEW2_BROWSING_DATA_KINDS_FILE_SYSTEMS | COREWEBVIEW2_BROWSING_DATA_KINDS_WEB_SQL |
                    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE;
    } else if (name == "cookies") run->cookies = true;
    else if (name == "sessionStorage") run->session = true;
    else if (name == "localStorage") {
      storage.insert("local_storage");
      run->kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_LOCAL_STORAGE;
    } else if (name == "indexedDB") {
      storage.insert("indexeddb");
      run->kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_INDEXED_DB;
    } else if (name == "cache") {
      run->cache = true;
      storage.insert("cache_storage");
      run->kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE | COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE;
    } else if (name == "serviceWorkers") {
      storage.insert("service_workers");
      run->kinds |= COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS;
    } else return c->fail("invalid_args", "webview.clearData: unknown type `" + name + "` (cookies, localStorage, sessionStorage, indexedDB, cache, serviceWorkers, all)");
  }
  if (!any_view()) return c->fail("unavailable", "webview.clearData: no web view is ready yet");
  for (const std::string &type : storage) run->storage += (run->storage.empty() ? "" : ",") + type;
  std::set<std::string> origins = loaded_sites();
  if (run->app) origins.insert(app_origin());
  for (const std::string &origin : origins) {
    if (origin.empty() || (!run->app && is_app_host(origin_host(origin)))) continue;
    run->origins.push_back(origin);
    run->names.insert(origin_host(origin));
  }
  if (!run->cookies) return clear_sites(run);
  // Never the app's: they hold its session with its server.
  clear_site_cookies(is_app_host, [run](const std::set<std::string> &hosts) {
    run->names.insert(hosts.begin(), hosts.end());
    clear_sites(run);
  });
}

// ===========================================================================
// Every web view

json web_control_info(View *v) {
  Control &s = g_controls[v->id];
  return json{{"fileDrop", s.fileDrop}, {"backgroundThrottling", v->throttling}, {"recovery", s.recovery}};
}

std::string web_control_recovery(int id) { return g_controls[id].recovery; }

void web_control_navigating(int id) {
  auto it = g_controls.find(id);
  if (it != g_controls.end()) finish_dialog(it->second, false, nullptr);
}

void web_control_detach(int id) {
  auto it = g_controls.find(id);
  if (it == g_controls.end()) return;
  finish_dialog(it->second, false, nullptr);
  g_controls.erase(it);
}

void web_control_attach(View *v) {
  int id = v->id;
  bool known = g_controls.count(id) != 0; // again, after the browser process died
  Control &s = g_controls[id];
  finish_dialog(s, false, nullptr);
  if (!known) {
    s.fileDrop = g_file_drop_default;
    GUID guid{};
    CoCreateGuid(&guid);
    s.nonce = base64_encode(&guid, sizeof guid);
  }
  v->webview->AddScriptToExecuteOnDocumentCreated(wide(page_script(s.nonce)).c_str(), nullptr);
  auto *onDialog = new Cb<ICoreWebView2ScriptDialogOpeningEventHandler, ICoreWebView2 *, ICoreWebView2ScriptDialogOpeningEventArgs *>(
      IID_ICoreWebView2ScriptDialogOpeningEventHandler, [id](ICoreWebView2 *, ICoreWebView2ScriptDialogOpeningEventArgs *args) -> HRESULT {
        on_script_dialog(id, args);
        return S_OK;
      });
  EventRegistrationToken token{};
  v->webview->add_ScriptDialogOpening(onDialog, &token);
  onDialog->Release();
  if (auto *wv4 = query<ICoreWebView2_4>(v->webview, IID_ICoreWebView2_4)) {
    auto *onFrame = new Cb<ICoreWebView2FrameCreatedEventHandler, ICoreWebView2 *, ICoreWebView2FrameCreatedEventArgs *>(
        IID_ICoreWebView2FrameCreatedEventHandler, [id](ICoreWebView2 *, ICoreWebView2FrameCreatedEventArgs *args) -> HRESULT {
          ICoreWebView2Frame *frame = nullptr;
          if (SUCCEEDED(args->get_Frame(&frame)) && frame) {
            attach_frame(id, frame);
            frame->Release();
          }
          return S_OK;
        });
    wv4->add_FrameCreated(onFrame, &token);
    onFrame->Release();
    wv4->Release();
  }
}

void register_web_control() {
  op("find", find_text);
  op("clearFind", [](CallPtr c, View *v, Control &s) {
    s.findText.clear();
    s.findGeneration++;
    if (ICoreWebView2Find *find = find_of(v)) {
      find->Stop();
      find->Release();
    }
    c->ok();
  });

  op("respondToDialog", [](CallPtr c, View *, Control &s) {
    if (!s.dialog) return c->fail("unavailable", "webview.respondToDialog: no JavaScript dialog is open");
    std::string type = s.dialogType, text = c->has("text") ? c->str("text") : dialog_text(s);
    finish_dialog(s, c->flag("accept", true), &text);
    c->ok(json{{"type", type}});
  });
  op("getDialog", [](CallPtr c, View *, Control &s) { c->ok(s.dialog ? json{{"type", s.dialogType}, {"message", s.dialogMessage}} : json(nullptr)); });

  op("setAudioMuted", [](CallPtr c, View *v, Control &) {
    auto *wv8 = query<ICoreWebView2_8>(v->webview, IID_ICoreWebView2_8);
    if (!wv8) return c->fail("unavailable", "webview.setAudioMuted: needs a newer WebView2 runtime");
    wv8->put_IsMuted(c->flag("muted", true) ? TRUE : FALSE);
    wv8->Release();
    c->ok();
  });
  op("pauseMedia", [](CallPtr c, View *v, Control &) {
    view_execute(v, "window.__shellMedia&&window.__shellMedia.pause();null", [c](bool ok, const json &, const std::string &error) {
      ok ? c->ok() : c->fail("unavailable", "webview.pauseMedia: " + error);
    });
  });
  op("getMediaState", [](CallPtr c, View *v, Control &) {
    auto *wv8 = query<ICoreWebView2_8>(v->webview, IID_ICoreWebView2_8);
    if (!wv8) return c->fail("unavailable", "webview.getMediaState: needs a newer WebView2 runtime");
    BOOL muted = FALSE, playing = FALSE;
    wv8->get_IsMuted(&muted);
    wv8->get_IsDocumentPlayingAudio(&playing);
    wv8->Release();
    view_execute(v, "window.__shellMedia?window.__shellMedia.state():null", [c, muted, playing](bool ok, const json &state, const std::string &error) {
      if (!ok) return c->fail("unavailable", "webview.getMediaState: " + error);
      c->ok(json{{"muted", muted != FALSE}, {"audible", playing && !muted}, {"playback", playing ? "playing" : jstr(state, "playback", "none")},
                 {"camera", jstr(state, "camera", "none")}, {"microphone", jstr(state, "microphone", "none")}});
    });
  });
  op("setBackgroundThrottling", [](CallPtr c, View *v, Control &) {
    v->throttling = c->flag("enabled", true);
    view_apply_visibility(v);
    c->ok();
  });
  op("setRecovery", [](CallPtr c, View *, Control &s) {
    std::string policy = c->str("recovery");
    if (policy != "reload" && policy != "manual") return c->fail("invalid_args", "recovery must be reload or manual");
    s.recovery = policy;
    c->ok();
  });
  op("_terminateForTesting", [](CallPtr c, View *v, Control &) {
    wchar_t flag[8];
    if (!GetEnvironmentVariableW(L"KITOP_TEST", flag, 8)) return c->fail("denied", "Only available to the test channel");
    // A real crash of its render process. It never answers.
    devtools(v, L"Page.crash", json::object(), [](bool) {});
    c->ok();
  });

  reg("webview", "setFileDrop", [](CallPtr c) {
    if (!c->has("enabled")) return c->fail("invalid_args", "webview.setFileDrop: `enabled` is required");
    bool enabled = c->flag("enabled", true);
    if (c->flag("all", false)) {
      g_file_drop_default = enabled;
      for (auto &[id, v] : views()) g_controls[id].fileDrop = enabled;
    } else {
      View *v = view_for_call(c);
      if (!v) return;
      g_controls[v->id].fileDrop = enabled;
    }
    c->ok(json{{"enabled", enabled}});
  });

  reg("webview", "clearData", clear_data);
}

} // namespace sd::win
