// The app on the desktop, same ops and replies as macOS where Windows has a meaning for them:
//   app.metrics: Toolhelp for this process and everything it started, WebView2 for which are pages and whose.
//   app.setDockIcon, setIcon, getDockIcon, defaultWindowIcon: the windows' icon, which the taskbar shows.
//   app.setActivationPolicy: `accessory` as tool windows, out of the taskbar and Alt+Tab.
//   files.*: no sandbox to get through. A bookmark is the path and the file's NTFS id, and OpenFileById finds
//     it wherever it moved on its volume.
//   power.getThermalState: answers `unavailable`. Windows has no public call that says this: ACPI thermal
//     zones are absent on most machines and carry no levels, and "% Passive Limit" isn't a state.
//   shell.startDrag: DoDragDrop over the shell's data object, while the press that reached the page lasts.
#include "win.hpp"

#include <objidl.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <tlhelp32.h>

#include <cmath>
#include <map>
#define PSAPI_VERSION 2
#include <psapi.h>

namespace sd::win {

// ---------------------------------------------------------------------------
// app.metrics

struct WebProcess {
  bool renderer = false;
  int window = -1; // public id of the window whose page it draws
};

// Every environment there is: the default one, and the ones of sessions with a proxy.
static std::vector<ICoreWebView2Environment *> web_environments(ICoreWebView2Environment *first) {
  std::vector<ICoreWebView2Environment *> out{first};
  for (auto &[id, s] : sessions())
    if (s->env) out.push_back(s->env);
  return out;
}

static void read_web_processes(ICoreWebView2Environment *env, std::function<void(std::map<int, WebProcess>)> done) {
  // No call says which web view a process draws: its frames, against the windows' own main frames.
  std::map<UINT32, int> frames;
  for (int id : window_order()) {
    Window *w = find_window(id);
    if (!w || !w->view.webview) continue;
    if (auto *wv20 = query<ICoreWebView2_20>(w->view.webview, IID_ICoreWebView2_20)) {
      UINT32 frame = 0;
      if (SUCCEEDED(wv20->get_FrameId(&frame))) frames[frame] = backend_public_window_id(id);
      wv20->Release();
    }
  }
  if (auto *env13 = query<ICoreWebView2Environment13>(env, IID_ICoreWebView2Environment13)) {
    auto *handler = new Cb<ICoreWebView2GetProcessExtendedInfosCompletedHandler, HRESULT, ICoreWebView2ProcessExtendedInfoCollection *>(
        IID_ICoreWebView2GetProcessExtendedInfosCompletedHandler, [frames, done](HRESULT, ICoreWebView2ProcessExtendedInfoCollection *list) -> HRESULT {
          std::map<int, WebProcess> out;
          UINT32 count = 0;
          if (list) list->get_Count(&count);
          for (UINT32 i = 0; i < count; i++) {
            ICoreWebView2ProcessExtendedInfo *info = nullptr;
            if (FAILED(list->GetValueAtIndex(i, &info)) || !info) continue;
            ICoreWebView2ProcessInfo *process = nullptr;
            INT32 pid = 0;
            COREWEBVIEW2_PROCESS_KIND kind = COREWEBVIEW2_PROCESS_KIND_BROWSER;
            if (SUCCEEDED(info->get_ProcessInfo(&process)) && process) {
              process->get_ProcessId(&pid);
              process->get_Kind(&kind);
              process->Release();
            }
            WebProcess row;
            row.renderer = kind == COREWEBVIEW2_PROCESS_KIND_RENDERER;
            ICoreWebView2FrameInfoCollection *infos = nullptr;
            ICoreWebView2FrameInfoCollectionIterator *it = nullptr;
            if (SUCCEEDED(info->get_AssociatedFrameInfos(&infos)) && infos && SUCCEEDED(infos->GetIterator(&it)) && it) {
              BOOL has = FALSE;
              for (it->get_HasCurrent(&has); has && row.window < 0; it->MoveNext(&has)) {
                ICoreWebView2FrameInfo *frame = nullptr;
                if (FAILED(it->GetCurrent(&frame)) || !frame) continue;
                if (auto *f2 = query<ICoreWebView2FrameInfo2>(frame, IID_ICoreWebView2FrameInfo2)) {
                  UINT32 id = 0;
                  auto found = SUCCEEDED(f2->get_FrameId(&id)) ? frames.find(id) : frames.end();
                  if (found != frames.end()) row.window = found->second;
                  f2->Release();
                }
                frame->Release();
              }
              it->Release();
            }
            if (infos) infos->Release();
            info->Release();
            out[pid] = row;
          }
          done(out);
          return S_OK;
        });
    HRESULT hr = env13->GetProcessExtendedInfos(handler);
    handler->Release();
    env13->Release();
    if (SUCCEEDED(hr)) return;
  }
  std::map<int, WebProcess> out;
  if (auto *env8 = query<ICoreWebView2Environment8>(env, IID_ICoreWebView2Environment8)) {
    ICoreWebView2ProcessInfoCollection *list = nullptr;
    UINT32 count = 0;
    if (SUCCEEDED(env8->GetProcessInfos(&list)) && list) list->get_Count(&count);
    for (UINT32 i = 0; i < count; i++) {
      ICoreWebView2ProcessInfo *process = nullptr;
      if (FAILED(list->GetValueAtIndex(i, &process)) || !process) continue;
      INT32 pid = 0;
      COREWEBVIEW2_PROCESS_KIND kind = COREWEBVIEW2_PROCESS_KIND_BROWSER;
      process->get_ProcessId(&pid);
      process->get_Kind(&kind);
      process->Release();
      out[pid].renderer = kind == COREWEBVIEW2_PROCESS_KIND_RENDERER;
    }
    if (list) list->Release();
    env8->Release();
  }
  done(out);
}

static double filetime_seconds(const FILETIME &t) {
  ULARGE_INTEGER v{{t.dwLowDateTime, t.dwHighDateTime}};
  return (double)v.QuadPart / 1e7;
}

static void metrics_reply(CallPtr c, const std::map<int, WebProcess> &web) {
  struct Row {
    std::wstring exe;
    DWORD parent = 0;
  };
  std::map<DWORD, Row> all;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return c->fail("internal", "app.metrics: " + last_error_message());
  PROCESSENTRY32W entry{sizeof entry};
  for (BOOL more = Process32FirstW(snapshot, &entry); more; more = Process32NextW(snapshot, &entry))
    all[entry.th32ProcessID] = Row{entry.szExeFile, entry.th32ParentProcessID};
  CloseHandle(snapshot);

  DWORD me = GetCurrentProcessId();
  std::wstring myExe = all.count(me) ? all[me].exe : L"";
  std::vector<DWORD> pids{me};
  // And what it started, and what those started. A parent id can be an old one a new process got since:
  // a child can't be older than its parent.
  auto started = [](DWORD pid, double &at) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    FILETIME created, a, b, d;
    bool ok = h && GetProcessTimes(h, &created, &a, &b, &d);
    if (ok) at = filetime_seconds(created);
    if (h) CloseHandle(h);
    return ok;
  };
  for (size_t i = 0; i < pids.size(); i++) {
    double parentAt = 0;
    if (!started(pids[i], parentAt)) continue;
    for (auto &[pid, row] : all) {
      double at = 0;
      if (row.parent == pids[i] && pid != pids[i] && started(pid, at) && at >= parentAt) pids.push_back(pid);
    }
  }

  static std::map<DWORD, std::pair<double, ULONGLONG>> last; // pid → CPU seconds, when
  std::map<DWORD, std::pair<double, ULONGLONG>> seen;
  json rows = json::array();
  unsigned long long total = 0;
  for (DWORD pid : pids) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) continue;
    PROCESS_MEMORY_COUNTERS_EX memory{};
    memory.cb = sizeof memory;
    FILETIME created, exited, kernel, user;
    bool ok = GetProcessMemoryInfo(h, reinterpret_cast<PROCESS_MEMORY_COUNTERS *>(&memory), sizeof memory) && GetProcessTimes(h, &created, &exited, &kernel, &user);
    CloseHandle(h);
    if (!ok) continue;
    double cpu = filetime_seconds(kernel) + filetime_seconds(user);
    ULONGLONG now = GetTickCount64();
    json percent = nullptr;
    auto prev = last.find(pid);
    if (prev != last.end() && now > prev->second.second) percent = std::max(0.0, (cpu - prev->second.first) / ((double)(now - prev->second.second) / 1000) * 100);
    seen[pid] = {cpu, now};
    const std::wstring &exe = all[pid].exe;
    auto w = web.find((int)pid);
    bool renderer = w != web.end() && w->second.renderer;
    const char *type = pid == me ? "main" : renderer ? "webview" : lower(utf8(exe)).rfind("python", 0) == 0 ? "python" : lstrcmpiW(exe.c_str(), myExe.c_str()) == 0 ? "helper" : "child";
    json row{{"pid", (int)pid}, {"type", type}, {"name", utf8(exe)}, {"memory", {{"footprint", (unsigned long long)memory.PrivateUsage}, {"resident", (unsigned long long)memory.WorkingSetSize}}}, {"cpu", {{"time", cpu}, {"percent", percent}}}};
    if (renderer && w->second.window >= 0) row["windowId"] = w->second.window;
    total += memory.PrivateUsage;
    rows.push_back(row);
  }
  last = seen;
  c->ok(json{{"processes", rows}, {"memory", {{"footprint", total}}}});
}

static void app_metrics(CallPtr c) {
  with_env([c](ICoreWebView2Environment *first) {
    auto envs = std::make_shared<std::vector<ICoreWebView2Environment *>>(web_environments(first));
    auto web = std::make_shared<std::map<int, WebProcess>>();
    auto next = std::make_shared<std::function<void(size_t)>>();
    *next = [c, envs, web, next](size_t i) {
      if (i == envs->size()) {
        metrics_reply(c, *web);
        *next = nullptr; // it holds itself
        return;
      }
      read_web_processes((*envs)[i], [web, next, i](std::map<int, WebProcess> found) {
        web->insert(found.begin(), found.end());
        (*next)(i + 1);
      });
    };
    (*next)(0);
  });
}

// ---------------------------------------------------------------------------
// The icon and the activation policy

static HICON g_icon_big = nullptr, g_icon_small = nullptr;
static json g_dock_icon;
static std::string g_activation_policy = "regular";

static void apply_icon(Window *w) {
  SendMessageW(w->hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(g_icon_big ? g_icon_big : app_icon(false)));
  SendMessageW(w->hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(g_icon_small ? g_icon_small : app_icon(true)));
}

static void set_icon(CallPtr c) {
  HICON big = nullptr, small = nullptr;
  bool restore = !c->has("icon") || c->args["icon"].is_null();
  if (!restore) {
    std::string error;
    big = load_icon(c->args["icon"], GetSystemMetrics(SM_CXICON), "app.setDockIcon", error);
    small = big ? load_icon(c->args["icon"], GetSystemMetrics(SM_CXSMICON), "app.setDockIcon", error) : nullptr;
    if (!small) {
      if (big) DestroyIcon(big);
      return c->fail("invalid_args", error);
    }
  }
  HICON oldBig = g_icon_big, oldSmall = g_icon_small;
  g_icon_big = big;
  g_icon_small = small;
  for (int id : window_order())
    if (Window *w = find_window(id)) apply_icon(w);
  if (oldBig) DestroyIcon(oldBig);
  if (oldSmall) DestroyIcon(oldSmall);
  g_dock_icon = restore ? json(nullptr) : c->args["icon"];
  c->ok();
}

static void apply_policy(Window *w) {
  LONG_PTR ex = GetWindowLongPtrW(w->hwnd, GWL_EXSTYLE);
  LONG_PTR want = g_activation_policy == "accessory" ? (ex & ~(LONG_PTR)WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW : (ex & ~(LONG_PTR)WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW;
  if (want == ex) return;
  // The taskbar only looks at this when a window shows.
  bool visible = IsWindowVisible(w->hwnd), front = GetForegroundWindow() == w->hwnd;
  if (visible) ShowWindow(w->hwnd, SW_HIDE);
  SetWindowLongPtrW(w->hwnd, GWL_EXSTYLE, want);
  SetWindowPos(w->hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  if (visible) ShowWindow(w->hwnd, front ? SW_SHOW : SW_SHOWNA);
}

void apply_app_look(Window *w) {
  if (g_icon_big) apply_icon(w);
  apply_policy(w);
}

// ---------------------------------------------------------------------------
// files.*: {path, volume, id}, the id in hex. The file at its path with the same identity: not stale.
// Anywhere else on its volume: that's where it is now, stale. Gone from the volume, or a copy on another
// one, which is a new file: what's at the old path if anything is, stale. Else it can't be found.

struct FileIdentity {
  ULONGLONG volume = 0;
  FILE_ID_128 id{};
  bool same(const FileIdentity &o) const { return volume == o.volume && memcmp(id.Identifier, o.id.Identifier, sizeof id.Identifier) == 0; }
};

static const DWORD kAnyShare = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

/// FILE_FLAG_BACKUP_SEMANTICS: a folder opens too. No access asked: only its identity is read.
static HANDLE open_for_identity(const std::wstring &path) {
  return CreateFileW(path.c_str(), 0, kAnyShare, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
}

static bool read_identity(HANDLE h, FileIdentity &out) {
  FILE_ID_INFO info{};
  if (!GetFileInformationByHandleEx(h, FileIdInfo, &info, sizeof info)) return false;
  out.volume = info.VolumeSerialNumber;
  out.id = info.FileId;
  return true;
}

static std::string hex_of(const void *data, size_t size) {
  static const char digits[] = "0123456789abcdef";
  std::string out;
  for (size_t i = 0; i < size; i++) {
    unsigned char b = static_cast<const unsigned char *>(data)[i];
    out += digits[b >> 4];
    out += digits[b & 15];
  }
  return out;
}

static bool from_hex(const std::string &s, void *out, size_t size) {
  if (s.size() != size * 2) return false;
  auto digit = [](char ch) { return ch >= '0' && ch <= '9' ? ch - '0' : ch >= 'a' && ch <= 'f' ? ch - 'a' + 10 : -1; };
  for (size_t i = 0; i < size; i++) {
    int hi = digit(s[i * 2]), lo = digit(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    static_cast<unsigned char *>(out)[i] = (unsigned char)(hi << 4 | lo);
  }
  return true;
}

/// Its path, without the \\?\ GetFinalPathNameByHandle puts in front.
static std::wstring final_path(HANDLE h) {
  std::wstring buf(MAX_PATH, L'\0');
  DWORD n = GetFinalPathNameByHandleW(h, &buf[0], (DWORD)buf.size(), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (n >= buf.size()) {
    buf.resize(n + 1);
    n = GetFinalPathNameByHandleW(h, &buf[0], (DWORD)buf.size(), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  }
  buf.resize(n);
  if (buf.rfind(L"\\\\?\\UNC\\", 0) == 0) return L"\\" + buf.substr(7);
  if (buf.rfind(L"\\\\?\\", 0) == 0) return buf.substr(4);
  return buf;
}

/// The volume with this serial number, from the drive it was on, else any: letters change.
static HANDLE open_volume(const std::wstring &lastRoot, ULONGLONG serial) {
  auto matches = [serial](const std::wstring &root, HANDLE &out) {
    HANDLE h = open_for_identity(root);
    if (h == INVALID_HANDLE_VALUE) return false;
    FileIdentity i;
    if (read_identity(h, i) && i.volume == serial) {
      out = h;
      return true;
    }
    CloseHandle(h);
    return false;
  };
  HANDLE found = INVALID_HANDLE_VALUE;
  if (!lastRoot.empty() && matches(lastRoot, found)) return found;
  DWORD drives = GetLogicalDrives();
  for (int i = 0; i < 26; i++) {
    std::wstring root = std::wstring(1, (wchar_t)(L'A' + i)) + L":\\";
    // Not removable media that isn't in: opening it can ask the user to insert it.
    if ((drives >> i & 1) && GetDriveTypeW(root.c_str()) != DRIVE_NO_ROOT_DIR && matches(root, found)) return found;
  }
  return INVALID_HANDLE_VALUE;
}

static void create_bookmark(CallPtr c) {
  std::wstring path = wide(expand_home(c->str("path")));
  for (auto &ch : path)
    if (ch == L'/') ch = L'\\';
  if (path.size() < 3 || !((path[1] == L':' && path[2] == L'\\') || path.rfind(L"\\\\", 0) == 0)) return c->fail("invalid_args", "files.createBookmark: absolute path required");
  HANDLE h = open_for_identity(path);
  if (h == INVALID_HANDLE_VALUE) return c->fail("unavailable", "files.createBookmark: `" + utf8(path) + "`: " + last_error_message());
  FileIdentity identity;
  bool known = read_identity(h, identity);
  std::wstring full = final_path(h);
  DWORD flags = 0;
  GetVolumeInformationByHandleW(h, nullptr, 0, nullptr, nullptr, &flags, nullptr, 0);
  CloseHandle(h);
  json b{{"path", utf8(full.empty() ? path : full)}};
  // FAT has no ids that last: such a bookmark is its path.
  if (known && (flags & FILE_SUPPORTS_OPEN_BY_FILE_ID)) {
    b["volume"] = hex_of(&identity.volume, sizeof identity.volume);
    b["id"] = hex_of(identity.id.Identifier, sizeof identity.id.Identifier);
  }
  std::string data = b.dump();
  c->ok(json{{"bookmark", base64_encode(data.data(), data.size())}});
}

static void open_bookmark(CallPtr c) {
  std::string bytes;
  json b = base64_decode(c->str("bookmark"), bytes) ? json::parse(bytes, nullptr, false) : json();
  if (!b.is_object() || !b.contains("path") || !b["path"].is_string()) return c->fail("invalid_args", "files.openBookmark: invalid bookmark");
  std::wstring path = wide(b["path"].get<std::string>()), found;
  FileIdentity wanted;
  bool hasId = from_hex(jstr(b, "volume"), &wanted.volume, sizeof wanted.volume) && from_hex(jstr(b, "id"), wanted.id.Identifier, sizeof wanted.id.Identifier);
  if (!hasId && (b.contains("volume") || b.contains("id"))) return c->fail("invalid_args", "files.openBookmark: invalid bookmark");
  bool stale = false;
  HANDLE at = open_for_identity(path);
  FileIdentity there;
  if (at != INVALID_HANDLE_VALUE && (!hasId || (read_identity(at, there) && there.same(wanted)))) found = path;
  if (at != INVALID_HANDLE_VALUE) CloseHandle(at);
  if (found.empty() && hasId) {
    stale = true;
    wchar_t root[MAX_PATH] = L"";
    GetVolumePathNameW(path.c_str(), root, MAX_PATH);
    HANDLE volume = open_volume(root, wanted.volume);
    if (volume != INVALID_HANDLE_VALUE) {
      FILE_ID_DESCRIPTOR descriptor{};
      descriptor.dwSize = sizeof descriptor;
      descriptor.Type = ExtendedFileIdType;
      memcpy(&descriptor.ExtendedFileId, &wanted.id, sizeof wanted.id);
      HANDLE file = OpenFileById(volume, &descriptor, 0, kAnyShare, nullptr, FILE_FLAG_BACKUP_SEMANTICS);
      if (file != INVALID_HANDLE_VALUE) {
        found = final_path(file);
        CloseHandle(file);
      }
      CloseHandle(volume);
    }
    if (found.empty() && GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) found = path; // something else in its place
  }
  if (found.empty()) return c->fail("unavailable", "files.openBookmark: the file is gone from `" + utf8(path) + "`");
  // Nothing to hold on to here: an id for release, which has nothing to do.
  static unsigned handles = 0;
  c->ok(json{{"id", "bookmark-" + std::to_string(++handles)}, {"path", utf8(found)}, {"stale", stale}});
}

// ---------------------------------------------------------------------------
// shell.startDrag

class DropSource final : public IDropSource {
public:
  ULONG STDMETHODCALLTYPE AddRef() override { return ++rc_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --rc_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **pp) override {
    if (!pp) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IDropSource)) {
      *pp = static_cast<IDropSource *>(this);
      AddRef();
      return S_OK;
    }
    *pp = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escape, DWORD keys) override {
    // Asked as well: the keyboard is the web view's, in its own process, and OLE doesn't always see it.
    if (escape || GetAsyncKeyState(VK_ESCAPE)) return DRAGDROP_S_CANCEL;
    return keys & (MK_LBUTTON | MK_RBUTTON) ? S_OK : DRAGDROP_S_DROP;
  }
  HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD) override { return DRAGDROP_S_USEDEFAULTCURSORS; }

private:
  std::atomic<ULONG> rc_{1};
};

static bool g_drag_out = false;

/// What follows the pointer: the icon asked for, else the file's. The shell owns the bitmap afterwards.
static void set_drag_image(IDataObject *data, const std::wstring &file, const std::string &iconPath) {
  HICON icon = nullptr;
  if (!iconPath.empty()) {
    std::string error;
    icon = load_icon(json{{"path", iconPath}}, 64, "shell.startDrag", error);
  }
  if (!icon) {
    SHFILEINFOW info{};
    if (SHGetFileInfoW(file.c_str(), 0, &info, sizeof info, SHGFI_ICON | SHGFI_LARGEICON)) icon = info.hIcon;
  }
  if (!icon) return;
  std::vector<uint8_t> px;
  int w = 0, h = 0;
  bool ok = icon_pixels(icon, px, w, h);
  DestroyIcon(icon);
  if (!ok) return;
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof bi.bmiHeader;
  bi.bmiHeader.biWidth = w;
  bi.bmiHeader.biHeight = -h;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  void *bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(nullptr, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bitmap) return;
  auto *out = static_cast<uint8_t *>(bits);
  for (size_t i = 0; i < px.size(); i += 4) { // the helper takes premultiplied alpha
    for (int k = 0; k < 3; k++) out[i + k] = (uint8_t)(px[i + k] * px[i + 3] / 255);
    out[i + 3] = px[i + 3];
  }
  IDragSourceHelper *helper = nullptr;
  bool taken = false;
  if (SUCCEEDED(CoCreateInstance(CLSID_DragDropHelper, nullptr, CLSCTX_INPROC_SERVER, IID_IDragSourceHelper, reinterpret_cast<void **>(&helper)))) {
    SHDRAGIMAGE image{};
    image.sizeDragImage = SIZE{w, h};
    image.ptOffset = POINT{w / 2, h / 2};
    image.hbmpDragImage = bitmap;
    image.crColorKey = CLR_NONE;
    taken = SUCCEEDED(helper->InitializeFromBitmap(&image, data));
    helper->Release();
  }
  if (!taken) DeleteObject(bitmap);
}

static void start_drag(CallPtr c) {
  Window *w = find_window(resolve_window(*c));
  if (!w) return c->fail("invalid_args", "shell.startDrag: no such window");
  std::vector<std::wstring> files;
  if (c->args.contains("files") && c->args["files"].is_array())
    for (auto &f : c->args["files"]) {
      std::string given = f.is_string() ? f.get<std::string>() : f.dump();
      std::wstring path = wide(expand_home(given));
      for (auto &ch : path)
        if (ch == L'/') ch = L'\\';
      if (!f.is_string() || GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES) return c->fail("invalid_args", "shell.startDrag: no such file `" + given + "`");
      files.push_back(path);
    }
  if (files.empty()) return c->fail("invalid_args", "shell.startDrag: `files` is required");
  if (g_drag_out) return c->fail("unavailable", "shell.startDrag: another drag is going on");
  if (!(GetAsyncKeyState(GetSystemMetrics(SM_SWAPBUTTON) ? VK_RBUTTON : VK_LBUTTON) & 0x8000))
    return c->fail("not_dragging", "shell.startDrag: the mouse button isn't down — call it from a dragstart or mousedown handler");
  std::string icon = c->has("icon") ? expand_home(c->str("icon")) : "";
  g_drag_out = true;
  // Off the call's stack: DoDragDrop runs a modal loop until it's dropped.
  backend_run_on_main([c, files, icon] {
    IDataObject *data = nullptr;
    // The shell's data object, with no items: it takes the files as CF_HDROP, which every drop target reads
    // and which can come from several folders, and it's what the drag image helper needs under it.
    HRESULT hr = SHCreateDataObject(nullptr, 0, nullptr, nullptr, IID_IDataObject, reinterpret_cast<void **>(&data));
    if (SUCCEEDED(hr)) {
      std::wstring list;
      for (auto &f : files) list += f + L'\0';
      list += L'\0';
      size_t bytes = sizeof(DROPFILES) + list.size() * sizeof(wchar_t);
      HGLOBAL global = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes);
      auto *drop = static_cast<DROPFILES *>(GlobalLock(global));
      drop->pFiles = sizeof(DROPFILES);
      drop->fWide = TRUE;
      memcpy(drop + 1, list.data(), list.size() * sizeof(wchar_t));
      GlobalUnlock(global);
      FORMATETC format{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
      STGMEDIUM medium{};
      medium.tymed = TYMED_HGLOBAL;
      medium.hGlobal = global;
      hr = data->SetData(&format, &medium, TRUE);
      if (FAILED(hr)) GlobalFree(global);
    }
    if (FAILED(hr) || !data) {
      if (data) data->Release();
      g_drag_out = false;
      return c->fail("internal", "shell.startDrag: " + hresult_message(hr));
    }
    set_drag_image(data, files[0], icon);
    auto *source = new DropSource;
    DWORD effect = DROPEFFECT_NONE;
    ReleaseCapture(); // the press's: the drag takes it from here
    GetAsyncKeyState(VK_ESCAPE); // forget a press from before
    hr = DoDragDrop(data, source, DROPEFFECT_COPY, &effect);
    source->Release();
    data->Release();
    g_drag_out = false;
    if (FAILED(hr)) return c->fail("internal", "shell.startDrag: " + hresult_message(hr));
    json reply{{"dropped", hr == DRAGDROP_S_DROP && effect != DROPEFFECT_NONE}};
    // What a test needs when a drag ends with nothing dropped: canceled, or dropped on nothing.
    if (test_channel()) reply["_ended"] = hr == DRAGDROP_S_DROP ? "drop" : hr == DRAGDROP_S_CANCEL ? "cancel" : "other";
    c->ok(reply);
  });
}

// ---------------------------------------------------------------------------

void register_desktop() {
  reg("app", "metrics", app_metrics);
  reg_many("app", {"setDockIcon", "setIcon"}, set_icon);
  reg("app", "getDockIcon", [](CallPtr c) { c->ok(g_dock_icon); });
  // The icon the executable carries, not what setDockIcon put on the windows.
  reg("app", "defaultWindowIcon", [](CallPtr c) {
    if (!packaged()) return c->ok(nullptr);
    std::vector<uint8_t> px;
    int w = 0, h = 0;
    std::string png;
    if (!icon_pixels(app_icon(false), px, w, h) || !wic_encode(px.data(), (UINT)w, (UINT)h, (UINT)w * 4, false, 1, png)) return c->ok(nullptr);
    c->ok(json{{"pngBase64", base64_encode(png.data(), png.size())}});
  });
  reg("app", "setActivationPolicy", [](CallPtr c) {
    std::string policy = c->str("policy");
    if (policy != "regular" && policy != "accessory" && policy != "prohibited") return c->fail("invalid_args", "app.setActivationPolicy: policy must be regular|accessory|prohibited");
    if (policy == "prohibited") return c->ok(false); // nothing stops a Windows app from having windows
    g_activation_policy = policy;
    for (int id : window_order())
      if (Window *w = find_window(id)) apply_policy(w);
    c->ok(true);
  });
  reg("app", "getActivationPolicy", [](CallPtr c) { c->ok(g_activation_policy); });
  reg("files", "createBookmark", create_bookmark);
  reg("files", "openBookmark", open_bookmark);
  reg("files", "releaseBookmark", [](CallPtr c) { c->ok(); });
  reg_many("power", {"getThermalState", "thermalState"}, [](CallPtr c) { c->fail("unavailable", "power.getThermalState: Windows has no public call that says this"); });
  reg("shell", "startDrag", start_drag);
}

} // namespace sd::win
