// notifications.* — WinRT toasts through the ABI COM interfaces (no C++/WinRT),
// with tray balloons (svc_tray.cc) as the fallback when WinRT can't be used.
// Contract: ../NOTIFICATIONS.md; the shared half is ../portable/notifications.hpp.
//
// Identity (unpackaged app): the AUMID is the app identifier, registered under
// HKCU\Software\Classes\AppUserModelId\<aumid> (DisplayName, IconUri) and set as
// the process's explicit AUMID; the installer's Start Menu shortcut gets the same
// AUMID at startup so the taskbar keeps grouping the windows with it.
//
// - Tag = id (hashed above 64 chars), Group = group (or "sd"): same Tag+Group
//   replaces. renotify:false on a replacement → SuppressPopup.
// - Activated (launch/arguments carry {i: id, a: action, t: input id}) → click /
//   action / reply; Dismissed with UserCanceled → dismiss. Marshalled to the UI thread.
// - Scheduling: ScheduledToastNotification (survives the app quitting). The OS
//   can't repeat: the next 8 occurrences of a series are scheduled, topped up at
//   startup and while running; <userData>/scheduled-notifications.json keeps
//   the series and what `pending` reports.
// - Clicks after the app quit (packaged apps): a COM toast activator. Per-app CLSID
//   derived from the identifier (notif::activator_clsid), LocalServer32 = "<exe>"
//   -ToastActivated, CustomActivator on the AUMID key and ToastActivatorCLSID on the
//   shortcut; the class object is registered at startup, so Windows calls the running
//   app, or launches it and calls it once registered (→ claim queue: no page yet). A
//   second instance launched for it waits for the call and forwards it to the holder.
// - toastXml: used as is (Tag/Group/events still set); clicks map back by its launch
//   attribute / action arguments.
// - setBadge: a taskbar overlay icon with the count (ITaskbarList3).
// push.*: unsupported.
#include "win.hpp"

#include <shlobj.h>
#include <shobjidl.h>

// mingw-w64's windows.foundation.h specializes IReference<boolean> and IReference<BYTE>,
// the same type when `boolean` is `unsigned char`: a distinct 1-byte type (same ABI)
// for the WinRT headers of this file only.
enum sd_winrt_boolean : unsigned char {};
#define boolean sd_winrt_boolean
#include <notificationactivationcallback.h>
#include <roapi.h>
#include <windows.data.xml.dom.h>
#include <windows.ui.notifications.h>
#include <winstring.h>

#include <cmath>

#include "../portable/notifications.hpp"

namespace wun = ABI::Windows::UI::Notifications;
namespace wxd = ABI::Windows::Data::Xml::Dom;
namespace wf = ABI::Windows::Foundation;
namespace wfc = ABI::Windows::Foundation::Collections;

namespace sd {
namespace notif {

int target_window(int preferred) {
  auto ok = [](int id) { return id && win::find_window(id) && page_loaded(id); };
  if (ok(preferred)) return preferred;
  if (win::Window *fg = win::find_window_hwnd(GetForegroundWindow()))
    if (ok(fg->id)) return fg->id;
  for (int id : win::window_order())
    if (ok(id)) return id;
  return 0;
}

void bring_to_front(int native_id) {
  win::Window *w = win::find_window(native_id);
  if (!w) return;
  if (IsIconic(w->hwnd)) ShowWindow(w->hwnd, SW_RESTORE);
  else ShowWindow(w->hwnd, SW_SHOW);
  if (!SetForegroundWindow(w->hwnd) || GetForegroundWindow() != w->hwnd) {
    FLASHWINFO fi{sizeof fi, w->hwnd, FLASHW_ALL | FLASHW_TIMERNOFG, 0, 0}; // focus-stealing rules: ask instead
    FlashWindowEx(&fi);
  }
}

} // namespace notif

namespace win {

// ---------------------------------------------------------------------------
// WinRT plumbing: combase entry points resolved at run time (no import lib).

namespace rt {
static bool tried = false, ok = false;
static std::string why;
static HRESULT(WINAPI *ro_init)(RO_INIT_TYPE);
static HRESULT(WINAPI *get_factory)(HSTRING, REFIID, void **);
static HRESULT(WINAPI *activate)(HSTRING, IInspectable **);
static HRESULT(WINAPI *create_string)(PCNZWCH, UINT32, HSTRING *);
static HRESULT(WINAPI *delete_string)(HSTRING);
static PCWSTR(WINAPI *raw_buffer)(HSTRING, UINT32 *);

static bool load() {
  if (tried) return ok;
  tried = true;
  HMODULE h = LoadLibraryW(L"combase.dll");
  auto sym = [h](const char *n, auto &out) {
    out = h ? reinterpret_cast<std::remove_reference_t<decltype(out)>>(reinterpret_cast<void *>(GetProcAddress(h, n))) : nullptr;
    return out != nullptr;
  };
  ok = sym("RoInitialize", ro_init) && sym("RoGetActivationFactory", get_factory) && sym("RoActivateInstance", activate) &&
       sym("WindowsCreateString", create_string) && sym("WindowsDeleteString", delete_string) && sym("WindowsGetStringRawBuffer", raw_buffer);
  if (!ok) why = "WinRT (combase.dll) is not available";
  else ro_init(RO_INIT_SINGLETHREADED); // S_FALSE / RPC_E_CHANGED_MODE: COM is already up (OleInitialize)
  return ok;
}

struct HStr {
  HSTRING h = nullptr;
  explicit HStr(const std::wstring &s) { create_string(s.c_str(), (UINT32)s.size(), &h); }
  explicit HStr(const std::string &s) : HStr(wide(s)) {}
  ~HStr() {
    if (h) delete_string(h);
  }
  HStr(const HStr &) = delete;
  HStr &operator=(const HStr &) = delete;
  operator HSTRING() const { return h; }
};

/// Takes ownership of `h`.
static std::string take(HSTRING h) {
  if (!h) return "";
  UINT32 n = 0;
  PCWSTR p = raw_buffer(h, &n);
  std::string out = utf8(p, (int)n);
  delete_string(h);
  return out;
}
} // namespace rt

template <class T> struct Ptr {
  T *p = nullptr;
  Ptr() = default;
  Ptr(const Ptr &) = delete;
  Ptr &operator=(const Ptr &) = delete;
  ~Ptr() { release(p); }
  T **put() {
    release(p);
    return &p;
  }
  T *operator->() const { return p; }
  T *get() const { return p; }
  explicit operator bool() const { return p != nullptr; }
  template <class U> bool as(Ptr<U> &out) const { return p && SUCCEEDED(p->QueryInterface(__uuidof(U), reinterpret_cast<void **>(out.put()))); }
};

/// Agile TypedEventHandler: invoked on a WinRT worker thread.
template <class Iface, class Sender, class Args> class Handler final : public Iface {
public:
  using Fn = std::function<void(Sender *, Args *)>;
  explicit Handler(Fn fn) : fn_(std::move(fn)) {}
  ULONG STDMETHODCALLTYPE AddRef() override { return ++rc_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --rc_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **pp) override {
    if (!pp) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, __uuidof(Iface)) || IsEqualIID(riid, IID_IAgileObject)) {
      *pp = static_cast<Iface *>(this);
      AddRef();
      return S_OK;
    }
    *pp = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE Invoke(Sender *s, Args *a) override {
    if (fn_) fn_(s, a);
    return S_OK;
  }

private:
  std::atomic<ULONG> rc_{1};
  Fn fn_;
};
using ActivatedIface = wf::ITypedEventHandler<wun::ToastNotification *, IInspectable *>;
using DismissedIface = wf::ITypedEventHandler<wun::ToastNotification *, wun::ToastDismissedEventArgs *>;
using ActivatedHandler = Handler<ActivatedIface, wun::IToastNotification, IInspectable>;
using DismissedHandler = Handler<DismissedIface, wun::IToastNotification, wun::IToastDismissedEventArgs>;
using InputMap = wfc::IMap<HSTRING, IInspectable *>;
using ToastList = wfc::IVectorView<wun::ToastNotification *>;
using ScheduledList = wfc::IVectorView<wun::ScheduledToastNotification *>;

// ---------------------------------------------------------------------------
// State

static std::wstring aumid() { return wide(app_identifier()); }

static std::string user_data_dir() {
  PWSTR p = nullptr;
  std::wstring base;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &p)) && p) base = p;
  CoTaskMemFree(p);
  return utf8(base + L"\\" + aumid()); // same as app.getPath('userData')
}
static std::string local_dir() {
  PWSTR p = nullptr;
  std::wstring base;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p)) && p) base = p;
  CoTaskMemFree(p);
  return utf8(base + L"\\" + aumid());
}

namespace toast {
static bool tried = false;
static std::string why; // "" = toasts usable
static wun::IToastNotificationManagerStatics *statics = nullptr;
static wun::IToastNotifier *notifier = nullptr;
static wun::IToastNotificationFactory *factory = nullptr;
static wun::IScheduledToastNotificationFactory *schedFactory = nullptr;
static wun::IToastNotificationHistory *history = nullptr;
static wun::IToastNotificationHistory2 *history2 = nullptr;

struct Live {
  wun::IToastNotification *toast = nullptr;
  EventRegistrationToken activated{}, dismissed{};
  std::string tag, group;
  int gen = 0;
  std::string rawLaunch, rawXml;       // toastXml: its launch attribute, the XML
  std::vector<std::string> inputIds;   // toastXml: <input id> values
};
static std::map<std::string, Live> live; // id → toast on screen / in the Action Center
static int gen = 0;
static bool balloons = false; // the fallback is in use
} // namespace toast

static notif::Store &store() {
  static notif::Store s;
  return s;
}
static std::map<std::string, int> g_sched_window;
static std::map<std::string, notif::Show> g_keep; // autoCancel:false / ongoing: back to the Action Center after a click
static double g_started = 0;
static const UINT_PTR kTimer = 0x5d70;
static const int kAhead = 8; // occurrences of a series kept in the OS schedule

static std::string tag_for(const std::string &id) {
  if (id.size() <= 64) return id;
  unsigned long long h = 14695981039346656037ULL;
  for (unsigned char ch : id) h = (h ^ ch) * 1099511628211ULL;
  char buf[24];
  snprintf(buf, sizeof buf, "sd-%016llx", h);
  return buf;
}
static std::string group_for(const std::string &g) { return g.empty() ? "sd" : g.substr(0, 64); }

/// "" when toasts work; else why not (the balloon fallback is used then).
static std::string toast_unavailable() {
  using namespace toast;
  if (tried) return why;
  tried = true;
  if (!rt::load()) return why = rt::why;
  HRESULT hr = rt::get_factory(rt::HStr(RuntimeClass_Windows_UI_Notifications_ToastNotificationManager), __uuidof(wun::IToastNotificationManagerStatics),
                               reinterpret_cast<void **>(&statics));
  if (FAILED(hr)) return why = "ToastNotificationManager: " + hresult_message(hr);
  hr = statics->CreateToastNotifierWithId(rt::HStr(aumid()), &notifier);
  if (FAILED(hr)) return why = "CreateToastNotifierWithId: " + hresult_message(hr);
  hr = rt::get_factory(rt::HStr(RuntimeClass_Windows_UI_Notifications_ToastNotification), __uuidof(wun::IToastNotificationFactory),
                       reinterpret_cast<void **>(&factory));
  if (FAILED(hr)) return why = "ToastNotification factory: " + hresult_message(hr);
  rt::get_factory(rt::HStr(RuntimeClass_Windows_UI_Notifications_ScheduledToastNotification), __uuidof(wun::IScheduledToastNotificationFactory),
                  reinterpret_cast<void **>(&schedFactory));
  if (auto *s2 = query<wun::IToastNotificationManagerStatics2>(statics, __uuidof(wun::IToastNotificationManagerStatics2))) {
    s2->get_History(&history);
    s2->Release();
    if (history) history2 = query<wun::IToastNotificationHistory2>(history, __uuidof(wun::IToastNotificationHistory2));
  }
  return why;
}

// ---------------------------------------------------------------------------
// Identity: registry AUMID + icon + shortcut

static bool write_file(const std::string &path, const std::string &bytes) {
  HANDLE f = CreateFileW(wide(path).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  DWORD n = 0;
  BOOL ok = WriteFile(f, bytes.data(), (DWORD)bytes.size(), &n, nullptr);
  CloseHandle(f);
  return ok && n == bytes.size();
}

/// A PNG of the app icon for IconUri: <exeDir>\<identifier>.png (shipped by the
/// packager), else the exe's icon rendered into %LOCALAPPDATA%\<id>.
static std::wstring icon_png() {
  std::wstring exe = exe_path();
  std::wstring dir = exe.substr(0, exe.find_last_of(L"\\/") + 1);
  std::wstring shipped = dir + aumid() + L".png";
  if (GetFileAttributesW(shipped.c_str()) != INVALID_FILE_ATTRIBUTES) return shipped;
  std::string out = local_dir() + "\\notification-icon.png";
  HICON icon = nullptr;
  if (FAILED(SHDefExtractIconW(exe.c_str(), 0, 0, &icon, nullptr, 256)) || !icon) icon = CopyIcon(app_icon(false));
  std::vector<uint8_t> px;
  int w = 0, h = 0;
  std::string png;
  bool ok = icon && icon_pixels(icon, px, w, h) && wic_encode(px.data(), (UINT)w, (UINT)h, (UINT)w * 4, false, 1, png);
  if (icon) DestroyIcon(icon);
  CreateDirectoryW(wide(local_dir()).c_str(), nullptr);
  return ok && write_file(out, png) ? wide(out) : L"";
}

static void set_reg(HKEY k, const wchar_t *name, const std::wstring &v) {
  RegSetValueExW(k, name, 0, REG_SZ, reinterpret_cast<const BYTE *>(v.c_str()), (DWORD)((v.size() + 1) * sizeof(wchar_t)));
}

static std::wstring activator_clsid() { return wide(notif::activator_clsid(app_identifier())); }

static void register_identity() {
  std::wstring id = aumid(), clsid = activator_clsid();
  SetCurrentProcessExplicitAppUserModelID(id.c_str()); // before the first window: taskbar grouping follows it
  HKEY k = nullptr;
  std::wstring key = L"Software\\Classes\\AppUserModelId\\" + id;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, key.c_str(), 0, nullptr, 0, KEY_SET_VALUE, nullptr, &k, nullptr) == ERROR_SUCCESS) {
    set_reg(k, L"DisplayName", wide(app_name()));
    std::wstring png = icon_png();
    if (!png.empty()) set_reg(k, L"IconUri", png);
    // The COM activator only makes sense for the app's own exe (not `bun` in dev).
    if (packaged()) set_reg(k, L"CustomActivator", clsid);
    else RegDeleteValueW(k, L"CustomActivator");
    RegCloseKey(k);
  }
  if (!packaged()) return;
  HKEY srv = nullptr;
  std::wstring srvKey = L"Software\\Classes\\CLSID\\" + clsid + L"\\LocalServer32";
  if (RegCreateKeyExW(HKEY_CURRENT_USER, srvKey.c_str(), 0, nullptr, 0, KEY_SET_VALUE, nullptr, &srv, nullptr) == ERROR_SUCCESS) {
    set_reg(srv, nullptr, L"\"" + exe_path() + L"\" -ToastActivated");
    RegCloseKey(srv);
  }
  // The installer's Start Menu shortcut (NSIS: $SMPROGRAMS\<name>.lnk) → same AUMID + activator.
  PWSTR programs = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_Programs, 0, nullptr, &programs)) || !programs) return;
  std::wstring lnk = std::wstring(programs) + L"\\" + wide(app_name()) + L".lnk";
  CoTaskMemFree(programs);
  if (GetFileAttributesW(lnk.c_str()) == INVALID_FILE_ATTRIBUTES) return;
  IShellLinkW *link = nullptr;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW, reinterpret_cast<void **>(&link)))) return;
  IPersistFile *file = query<IPersistFile>(link, IID_IPersistFile);
  IPropertyStore *props = query<IPropertyStore>(link, IID_IPropertyStore);
  wchar_t target[MAX_PATH * 2] = {0};
  static const GUID kAppUserModel = {0x9F4C2855, 0x9F79, 0x4B39, {0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3}};
  static const PROPERTYKEY kAumidKey = {kAppUserModel, 5};       // PKEY_AppUserModel_ID
  static const PROPERTYKEY kActivatorKey = {kAppUserModel, 26};  // PKEY_AppUserModel_ToastActivatorCLSID
  CLSID cls{};
  bool haveCls = SUCCEEDED(CLSIDFromString(clsid.c_str(), &cls));
  if (file && props && SUCCEEDED(file->Load(lnk.c_str(), STGM_READWRITE)) && SUCCEEDED(link->GetPath(target, MAX_PATH * 2, nullptr, 0)) &&
      lstrcmpiW(target, exe_path().c_str()) == 0) {
    PROPVARIANT cur;
    PropVariantInit(&cur);
    bool sameId = SUCCEEDED(props->GetValue(kAumidKey, &cur)) && cur.vt == VT_LPWSTR && cur.pwszVal && id == cur.pwszVal;
    PropVariantClear(&cur);
    bool sameCls = !haveCls || (SUCCEEDED(props->GetValue(kActivatorKey, &cur)) && cur.vt == VT_CLSID && cur.puuid && IsEqualGUID(*cur.puuid, cls));
    PropVariantClear(&cur);
    bool dirty = false;
    if (!sameId) {
      PROPVARIANT v;
      PropVariantInit(&v);
      v.vt = VT_LPWSTR;
      v.pwszVal = static_cast<wchar_t *>(CoTaskMemAlloc((id.size() + 1) * sizeof(wchar_t)));
      if (v.pwszVal) {
        memcpy(v.pwszVal, id.c_str(), (id.size() + 1) * sizeof(wchar_t));
        dirty = SUCCEEDED(props->SetValue(kAumidKey, v)) || dirty;
      }
      PropVariantClear(&v);
    }
    if (!sameCls) {
      PROPVARIANT v;
      PropVariantInit(&v);
      v.vt = VT_CLSID;
      v.puuid = static_cast<CLSID *>(CoTaskMemAlloc(sizeof(CLSID)));
      if (v.puuid) {
        *v.puuid = cls;
        dirty = SUCCEEDED(props->SetValue(kActivatorKey, v)) || dirty;
      }
      PropVariantClear(&v);
    }
    if (dirty && SUCCEEDED(props->Commit())) file->Save(nullptr, TRUE);
  }
  release(props);
  release(file);
  release(link);
}

// ---------------------------------------------------------------------------
// Toast XML

static std::string xesc(const std::string &s) {
  std::string out;
  out.reserve(s.size() + 16);
  for (unsigned char ch : s) {
    switch (ch) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&apos;"; break;
      default:
        if (ch < 0x20 && ch != '\t' && ch != '\n' && ch != '\r') break; // not allowed in XML 1.0
        out += (char)ch;
    }
  }
  return out;
}

static std::string file_uri(const std::string &path) {
  std::string out = "file:///";
  for (unsigned char ch : path) {
    if (ch == '\\') out += '/';
    else if (ch == ' ' || ch == '%' || ch == '#' || ch == '?' || ch < 0x20) {
      char b[4];
      snprintf(b, sizeof b, "%%%02X", ch);
      out += b;
    } else out += (char)ch;
  }
  return out;
}

static DWORD os_build() {
  static DWORD build = 0;
  if (!build) {
    using Fn = LONG(WINAPI *)(OSVERSIONINFOW *);
    OSVERSIONINFOW vi{sizeof vi};
    if (auto fn = reinterpret_cast<Fn>(reinterpret_cast<void *>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion")))) fn(&vi);
    build = vi.dwBuildNumber ? vi.dwBuildNumber : 1;
  }
  return build;
}

static std::string toast_xml(const notif::Show &s) {
  std::string cache = local_dir() + "\\notification-images", err;
  std::string icon = s.icon.empty() ? "" : notif::image_file(s.icon, cache, &err);
  std::string image = s.image.empty() ? "" : notif::image_file(s.image, cache, &err);
  json launch{{"i", s.id}};
  if (!s.payload.empty() && s.payload.size() <= 2048) launch["p"] = s.payload; // history entries of a previous run
  std::string x = "<toast launch=\"" + xesc(launch.dump()) + "\" activationType=\"foreground\"";
  for (auto &a : s.actions)
    if (a.destructive) {
      x += " useButtonStyle=\"true\""; // hint-buttonStyle is ignored without it
      break;
    }
  if (s.urgency == "critical") x += os_build() >= 22621 ? " scenario=\"urgent\"" : " scenario=\"reminder\"";
  else if (s.requireInteraction || s.ongoing) x += " scenario=\"reminder\"";
  if (s.hasTimestamp && s.timestamp > 0) {
    time_t t = (time_t)(s.timestamp / 1000);
    std::tm tm{};
    gmtime_s(&tm, &t);
    char buf[32];
    strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", &tm);
    x += std::string(" displayTimestamp=\"") + buf + "\"";
  }
  x += "><visual><binding template=\"ToastGeneric\"><text>" + xesc(s.title) + "</text>";
  if (!s.subtitle.empty()) x += "<text>" + xesc(s.subtitle) + "</text>";
  if (!s.body.empty()) x += "<text>" + xesc(s.body) + "</text>";
  if (!icon.empty()) x += "<image placement=\"appLogoOverride\" src=\"" + xesc(file_uri(icon)) + "\"/>";
  if (!image.empty()) x += "<image placement=\"hero\" src=\"" + xesc(file_uri(image)) + "\"/>";
  x += "</binding></visual>";
  if (s.silent) x += "<audio silent=\"true\"/>";
  else if (s.sound.rfind("ms-winsoundevent:", 0) == 0) x += "<audio src=\"" + xesc(s.sound) + "\"/>";
  bool needsButton = s.requireInteraction || s.ongoing || s.urgency == "critical"; // reminder/urgent toasts need one to stay up
  if (!s.actions.empty() || needsButton || !s.closeButtonText.empty()) {
    x += "<actions>";
    size_t n = std::min<size_t>(s.actions.size(), s.closeButtonText.empty() ? 5 : 4); // 5 buttons at most
    for (size_t i = 0; i < n; i++)
      if (s.actions[i].input)
        x += "<input id=\"t" + std::to_string(i) + "\" type=\"text\" placeHolderContent=\"" + xesc(s.actions[i].placeholder) + "\"/>";
    for (size_t i = 0; i < n; i++) {
      const notif::Action &a = s.actions[i];
      json args{{"i", s.id}, {"a", a.id}};
      if (a.input) args["t"] = "t" + std::to_string(i);
      if (!s.payload.empty() && s.payload.size() <= 1024) args["p"] = s.payload; // cold start: no record to take it from
      x += "<action content=\"" + xesc(a.input && !a.button.empty() ? a.button : a.title) + "\" arguments=\"" + xesc(args.dump()) +
           "\" activationType=\"" + (a.foreground ? "foreground" : "background") + "\"";
      if (a.input) x += " hint-inputId=\"t" + std::to_string(i) + "\"";
      if (a.destructive) x += " hint-buttonStyle=\"Critical\"";
      x += "/>";
    }
    if (!s.closeButtonText.empty()) x += "<action activationType=\"system\" arguments=\"dismiss\" content=\"" + xesc(s.closeButtonText) + "\"/>";
    else if (s.actions.empty()) x += "<action activationType=\"system\" arguments=\"dismiss\" content=\"\"/>";
    x += "</actions>";
  }
  return x + "</toast>";
}

static HRESULT load_xml(const std::string &xml, Ptr<wxd::IXmlDocument> &doc) {
  Ptr<IInspectable> inst;
  HRESULT hr = rt::activate(rt::HStr(RuntimeClass_Windows_Data_Xml_Dom_XmlDocument), inst.put());
  if (FAILED(hr)) return hr;
  Ptr<wxd::IXmlDocumentIO> io;
  if (!inst.as(io) || !inst.as(doc)) return E_NOINTERFACE;
  return io->LoadXml(rt::HStr(xml));
}

/// {i, p} from the toast's launch attribute + its text lines.
static json read_content(wxd::IXmlDocument *doc) {
  json out = json::object();
  if (!doc) return out;
  Ptr<wxd::IXmlElement> root;
  if (SUCCEEDED(doc->get_DocumentElement(root.put())) && root) {
    HSTRING v = nullptr;
    if (SUCCEEDED(root->GetAttribute(rt::HStr(std::wstring(L"launch")), &v))) {
      json l = json::parse(rt::take(v), nullptr, false);
      if (l.is_object()) out = l;
    }
  }
  Ptr<wxd::IXmlNodeList> texts;
  json lines = json::array();
  if (SUCCEEDED(doc->GetElementsByTagName(rt::HStr(std::wstring(L"text")), texts.put())) && texts) {
    UINT32 n = 0;
    texts->get_Length(&n);
    for (UINT32 i = 0; i < n; i++) {
      Ptr<wxd::IXmlNode> node;
      Ptr<wxd::IXmlNodeSerializer> ser;
      HSTRING t = nullptr;
      if (SUCCEEDED(texts->Item(i, node.put())) && node.as(ser) && SUCCEEDED(ser->get_InnerText(&t))) lines.push_back(rt::take(t));
    }
  }
  out["lines"] = lines;
  return out;
}

static std::string root_attr(wxd::IXmlDocument *doc, const wchar_t *name) {
  Ptr<wxd::IXmlElement> root;
  HSTRING v = nullptr;
  if (doc && SUCCEEDED(doc->get_DocumentElement(root.put())) && root && SUCCEEDED(root->GetAttribute(rt::HStr(std::wstring(name)), &v))) return rt::take(v);
  return "";
}

/// <input id="…"> values of a raw toast XML.
static std::vector<std::string> input_ids(const std::string &xml) {
  std::vector<std::string> out;
  for (size_t p = xml.find("<input"); p != std::string::npos; p = xml.find("<input", p + 6)) {
    size_t end = xml.find('>', p), id = xml.find("id=", p);
    if (id == std::string::npos || id > end || id + 4 >= xml.size()) continue;
    char q = xml[id + 3];
    size_t close = xml.find(q, id + 4);
    if (close != std::string::npos && close < end) out.push_back(xml.substr(id + 4, close - id - 4));
  }
  return out;
}

static std::string xml_for(const notif::Show &s) { return s.toastXml.empty() ? toast_xml(s) : s.toastXml; }

static wf::DateTime to_datetime(double ms) {
  wf::DateTime d;
  d.UniversalTime = (INT64)(ms * 10000.0) + 116444736000000000LL;
  return d;
}

// ---------------------------------------------------------------------------
// Live toasts and events

static void drop_live(const std::string &id) {
  auto it = toast::live.find(id);
  if (it == toast::live.end()) return;
  if (it->second.toast) {
    it->second.toast->remove_Activated(it->second.activated);
    it->second.toast->remove_Dismissed(it->second.dismissed);
    it->second.toast->Release();
  }
  toast::live.erase(it);
}

static void forget(const std::string &id) {
  drop_live(id);
  notif::records().erase(id);
  g_keep.erase(id);
}

static bool deliver(const notif::Show &s, int window, std::string *error, bool quiet);

/// A click / button from the Activated event or the COM activator (both can fire for
/// one click: deduplicated). `hintId`: the toast the event came from ("" = COM).
static void on_activated(const std::string &args, const json &inputs, const std::string &hintId) {
  static std::string lastKey;
  static ULONGLONG lastAt = 0;
  std::string key = args + "\x1f" + inputs.dump();
  ULONGLONG now = GetTickCount64();
  if (key == lastKey && now - lastAt < 3000) return;
  lastKey = key, lastAt = now;
  json a = json::parse(args, nullptr, false);
  std::string id, action, payload, kind;
  json input = nullptr;
  if (!a.is_object() && (args == "dismiss" || args == "snooze")) {
    // A system button (closeButtonText, the reminder's Dismiss): Windows reports it as an
    // activation of the toast. Dismiss = the user closed it; Dismissed may come too: once.
    if (args == "snooze" || hintId.empty() || !toast::live.count(hintId)) return;
    auto rec = notif::records().find(hintId);
    if (!(rec != notif::records().end() && rec->second.acted)) notif::respond(hintId, "dismiss", "", nullptr, "", 0);
    forget(hintId);
    return;
  }
  if (a.is_object() && a.contains("i") && a["i"].is_string()) {
    id = a["i"], action = notif::jstr(a, "a"), payload = notif::jstr(a, "p");
    if (action.empty()) kind = "click";
    else if (a.contains("t") && a["t"].is_string()) kind = "reply", input = inputs.value(a["t"].get<std::string>(), std::string());
    else kind = "action";
  } else { // toastXml: its launch attribute = a click, anything else = that action's arguments
    id = hintId;
    std::string launch;
    for (auto &[lid, l] : toast::live)
      if ((id.empty() && !l.rawXml.empty() && (l.rawLaunch == args || l.rawXml.find(xesc(args)) != std::string::npos)) || lid == id) {
        id = lid, launch = l.rawLaunch;
        break;
      }
    for (auto &[k, v] : inputs.items())
      if (v.is_string() && !v.get<std::string>().empty()) {
        input = v;
        break;
      }
    if (args == launch) kind = input.is_string() ? "reply" : "click";
    else kind = input.is_string() ? "reply" : "action", action = args;
  }
  auto rec = notif::records().find(id);
  int window = rec != notif::records().end() ? rec->second.window : 0;
  if (rec != notif::records().end()) rec->second.acted = rec->second.keep ? false : true;
  bool foreground = kind == "click" || kind == "reply";
  if (kind == "action" && rec != notif::records().end()) {
    auto f = rec->second.foreground.find(action);
    foreground = f == rec->second.foreground.end() || f->second;
  } else if (kind == "action") foreground = true;
  // No window (quitOnLastWindowClosed: false): reopen the main one; its page claims the response.
  if (foreground && window_order().empty()) recreate_main_window();
  notif::respond(id, kind, action, input, payload, 0);
  auto keep = g_keep.find(id);
  std::string err;
  if (keep != g_keep.end() && deliver(keep->second, window, &err, true)) return; // stays in the Action Center
  forget(id); // activation removes it from the Action Center
}

static void attach_events(const std::string &id, wun::IToastNotification *t, toast::Live &l) {
  int gen = l.gen;
  std::vector<std::string> rawInputs = l.inputIds;
  auto *act = new ActivatedHandler([id, rawInputs](wun::IToastNotification *, IInspectable *args) {
    std::string arguments;
    json inputs = json::object();
    if (auto *e = query<wun::IToastActivatedEventArgs>(args, __uuidof(wun::IToastActivatedEventArgs))) {
      HSTRING h = nullptr;
      if (SUCCEEDED(e->get_Arguments(&h))) arguments = rt::take(h);
      e->Release();
    }
    if (auto *e2 = query<wun::IToastActivatedEventArgs2>(args, __uuidof(wun::IToastActivatedEventArgs2))) {
      wfc::IPropertySet *set = nullptr;
      if (SUCCEEDED(e2->get_UserInput(&set)) && set) {
        json a = json::parse(arguments, nullptr, false);
        std::vector<std::string> keys = rawInputs;
        if (a.is_object() && a.contains("t") && a["t"].is_string()) keys = {a["t"].get<std::string>()};
        auto *map = query<InputMap>(set, __uuidof(InputMap));
        for (auto &key : keys) {
          IInspectable *v = nullptr;
          if (map && SUCCEEDED(map->Lookup(rt::HStr(key), &v)) && v) {
            if (auto *pv = query<wf::IPropertyValue>(v, __uuidof(wf::IPropertyValue))) {
              HSTRING s = nullptr;
              if (SUCCEEDED(pv->GetString(&s))) inputs[key] = rt::take(s);
              pv->Release();
            }
            v->Release();
          }
        }
        release(map);
        set->Release();
      }
      e2->Release();
    }
    backend_run_on_main([arguments, inputs, id] { on_activated(arguments, inputs, id); });
  });
  auto *dis = new DismissedHandler([id, gen](wun::IToastNotification *, wun::IToastDismissedEventArgs *e) {
    wun::ToastDismissalReason reason = wun::ToastDismissalReason_TimedOut;
    if (e) e->get_Reason(&reason);
    backend_run_on_main([id, gen, reason] {
      auto it = toast::live.find(id);
      if (it == toast::live.end() || it->second.gen != gen) return; // replaced since
      if (reason == wun::ToastDismissalReason_TimedOut) return;      // still in the Action Center
      auto rec = notif::records().find(id);
      if (reason == wun::ToastDismissalReason_UserCanceled && !(rec != notif::records().end() && rec->second.acted))
        notif::respond(id, "dismiss", "", nullptr, "", 0);
      forget(id);
    });
  });
  t->add_Activated(act, &l.activated);
  t->add_Dismissed(dis, &l.dismissed);
  act->Release();
  dis->Release();
}

// ---------------------------------------------------------------------------
// COM toast activator (clicks while the app isn't running, or routed to it)

static std::string g_com_activation; // last Activate call {args, inputs}: forwarded by a second instance
static bool g_forwarding = false;    // this process is a second instance about to exit: touch nothing
static DWORD g_com_cookie = 0;

class ActivationCallback final : public INotificationActivationCallback {
public:
  ULONG STDMETHODCALLTYPE AddRef() override { return ++rc_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --rc_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **pp) override {
    if (!pp) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, __uuidof(INotificationActivationCallback))) {
      *pp = static_cast<INotificationActivationCallback *>(this);
      AddRef();
      return S_OK;
    }
    *pp = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE Activate(LPCWSTR, LPCWSTR invoked, const NOTIFICATION_USER_INPUT_DATA *data, ULONG count) override {
    std::string args = invoked ? utf8(invoked) : "";
    json inputs = json::object();
    for (ULONG i = 0; data && i < count; i++)
      if (data[i].Key) inputs[utf8(data[i].Key)] = data[i].Value ? utf8(data[i].Value) : "";
    g_com_activation = json{{"args", args}, {"inputs", inputs}}.dump();
    if (!g_forwarding) backend_run_on_main([args, inputs] { on_activated(args, inputs, ""); });
    return S_OK;
  }

private:
  std::atomic<ULONG> rc_{1};
};

class ActivationFactory final : public IClassFactory {
public:
  ULONG STDMETHODCALLTYPE AddRef() override { return 2; } // static instance
  ULONG STDMETHODCALLTYPE Release() override { return 1; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **pp) override {
    if (!pp) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IClassFactory)) {
      *pp = static_cast<IClassFactory *>(this);
      return S_OK;
    }
    *pp = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown *outer, REFIID riid, void **pp) override {
    if (!pp) return E_POINTER;
    *pp = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    auto *cb = new ActivationCallback;
    HRESULT hr = cb->QueryInterface(riid, pp);
    cb->Release();
    return hr;
  }
  HRESULT STDMETHODCALLTYPE LockServer(BOOL) override { return S_OK; }
};

static void register_activator() {
  if (!packaged()) return;
  static ActivationFactory factory;
  CLSID cls{};
  if (FAILED(CLSIDFromString(activator_clsid().c_str(), &cls))) return;
  HRESULT hr = CoRegisterClassObject(cls, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE, &g_com_cookie);
  if (FAILED(hr)) fprintf(stderr, "[shell] notifications: toast activator not registered (%s)\n", hresult_message(hr).c_str());
}

std::string toast_activation_wait(int ms) {
  g_forwarding = true;
  ULONGLONG until = GetTickCount64() + (ULONGLONG)ms;
  MSG msg;
  while (g_com_activation.empty() && GetTickCount64() < until) {
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    if (g_com_activation.empty()) MsgWaitForMultipleObjects(0, nullptr, FALSE, 50, QS_ALLINPUT);
  }
  return g_com_activation;
}

void toast_activation_forwarded(const json &activation) {
  if (!activation.is_object()) return;
  on_activated(notif::jstr(activation, "args"), activation.value("inputs", json::object()), "");
}

// ---------------------------------------------------------------------------
// Show / schedule

static bool show_balloon(const notif::Show &s, int window, std::string *error) {
  std::string err;
  std::string body = s.subtitle.empty() ? s.body : s.subtitle + (s.body.empty() ? "" : "\n" + s.body);
  if (!tray_balloon_show(s.id, s.title, body, s.silent, err)) return *error = "notifications.show: " + err, false;
  toast::balloons = true;
  notif::records()[s.id] = notif::make_record(s, window);
  return true;
}

static void history_remove(const std::string &tag, const std::string &group);

/// The shown toast with this id, wherever it is (popup, Action Center, balloon).
static void remove_delivered(const std::string &id) {
  auto it = toast::live.find(id);
  std::string tag = it != toast::live.end() ? it->second.tag : tag_for(id);
  std::string group = it != toast::live.end() ? it->second.group : group_for(notif::records().count(id) ? notif::records()[id].group : "");
  if (it != toast::live.end() && it->second.toast && toast::notifier) toast::notifier->Hide(it->second.toast);
  history_remove(tag, group);
  if (toast::balloons) tray_balloon_hide(id);
  forget(id);
}

static void history_remove(const std::string &tag, const std::string &group) {
  if (toast::history) toast::history->RemoveGroupedTagWithId(rt::HStr(tag), rt::HStr(group), rt::HStr(aumid()));
}

/// Shows `s` now; replaces a toast with the same id. `quiet`: straight to the Action
/// Center (replacing the copy the OS scheduler just showed, to get its events).
static bool deliver(const notif::Show &s, int window, std::string *error, bool quiet) {
  if (!toast_unavailable().empty()) return show_balloon(s, window, error);
  Ptr<wxd::IXmlDocument> doc;
  HRESULT hr = load_xml(xml_for(s), doc);
  if (FAILED(hr)) return *error = "notifications.show: toast XML: " + hresult_message(hr), false;
  Ptr<wun::IToastNotification> t;
  hr = toast::factory->CreateToastNotification(doc.get(), t.put());
  if (FAILED(hr)) return show_balloon(s, window, error);
  std::string tag = tag_for(s.id), group = group_for(s.group);
  auto old = toast::live.find(s.id);
  bool replacing = old != toast::live.end();
  int prevWindow = 0;
  if (auto r = notif::records().find(s.id); r != notif::records().end()) prevWindow = r->second.window;
  if (replacing && old->second.group != group) history_remove(old->second.tag, old->second.group); // another Group won't replace it
  Ptr<wun::IToastNotification2> t2;
  if (t.as(t2)) {
    t2->put_Tag(rt::HStr(tag));
    t2->put_Group(rt::HStr(group));
    if ((replacing && !s.renotify) || quiet) t2->put_SuppressPopup((boolean)1);
  }
  drop_live(s.id);
  toast::Live &l = toast::live[s.id];
  l.tag = tag, l.group = group, l.gen = ++toast::gen;
  if (!s.toastXml.empty()) l.rawXml = s.toastXml, l.rawLaunch = root_attr(doc.get(), L"launch"), l.inputIds = input_ids(s.toastXml);
  attach_events(s.id, t.get(), l);
  hr = toast::notifier->Show(t.get());
  if (FAILED(hr)) {
    drop_live(s.id);
    return show_balloon(s, window, error);
  }
  l.toast = t.p;
  t.p = nullptr; // owned by live
  notif::Record r = notif::make_record(s, window);
  if (!window) r.window = prevWindow;
  notif::records()[s.id] = r;
  if (r.keep) g_keep[s.id] = s;
  else g_keep.erase(s.id);
  return true;
}

/// Every OS-scheduled toast with `tag` (all of them when tag is empty) → removed.
static void unschedule(const std::string &tag) {
  if (!toast::notifier) return;
  Ptr<ScheduledList> list;
  if (FAILED(toast::notifier->GetScheduledToastNotifications(list.put())) || !list) return;
  UINT32 n = 0;
  list->get_Size(&n);
  std::vector<wun::IScheduledToastNotification *> drop;
  for (UINT32 i = 0; i < n; i++) {
    wun::IScheduledToastNotification *st = nullptr;
    if (FAILED(list->GetAt(i, &st)) || !st) continue;
    std::string t;
    if (auto *s2 = query<wun::IScheduledToastNotification2>(st, __uuidof(wun::IScheduledToastNotification2))) {
      HSTRING h = nullptr;
      if (SUCCEEDED(s2->get_Tag(&h))) t = rt::take(h);
      s2->Release();
    }
    if (tag.empty() || t == tag) drop.push_back(st);
    else st->Release();
  }
  for (auto *st : drop) {
    toast::notifier->RemoveFromSchedule(st);
    st->Release();
  }
}

/// OS schedule for a stored entry: its next occurrence (and the following ones of a series).
static bool os_schedule(const json &e, std::string *error) {
  if (!toast_unavailable().empty() || !toast::schedFactory) return true; // fallback: our timer delivers it
  notif::Show s;
  if (!notif::parse_show(e["args"], s, error)) return false;
  s.id = e["id"];
  Ptr<wxd::IXmlDocument> doc;
  HRESULT hr = load_xml(xml_for(s), doc);
  if (FAILED(hr)) return *error = "notifications.show: toast XML: " + hresult_message(hr), false;
  std::string tag = tag_for(s.id), group = group_for(s.group);
  unschedule(tag);
  double at = e["at"].get<double>(), now = notif::now_ms();
  std::string repeat = e.value("repeat", "");
  for (int i = 0; i < (repeat.empty() ? 1 : kAhead) && at > 0; i++) {
    if (at > now + 1000) {
      Ptr<wun::IScheduledToastNotification> st;
      hr = toast::schedFactory->CreateScheduledToastNotification(doc.get(), to_datetime(at), st.put());
      if (FAILED(hr)) return *error = "notifications.show: ScheduledToastNotification: " + hresult_message(hr), false;
      Ptr<wun::IScheduledToastNotification2> s2;
      if (st.as(s2)) s2->put_Tag(rt::HStr(tag)), s2->put_Group(rt::HStr(group));
      hr = toast::notifier->AddToSchedule(st.get());
      if (FAILED(hr)) return *error = "notifications.show: AddToSchedule: " + hresult_message(hr), false;
    }
    at = repeat.empty() ? 0 : notif::next_occurrence(at, repeat, at);
  }
  return true;
}

static void rearm_timer();

/// Entries whose time comes. While the app runs it delivers them itself (the OS copy
/// would have no Activated/Dismissed handlers in this process): the OS-scheduled copy
/// is removed first, or replaced quietly if the OS already showed it. Series advance
/// and get topped up. Missed while closed: the OS showed them, nothing to do.
static void reconcile() {
  if (g_forwarding) return;
  double now = notif::now_ms();
  bool changed = false;
  std::vector<json> due;
  for (auto &e : store().items)
    if (e["at"].get<double>() <= now + 1500) due.push_back(e);
  bool viaOs = toast_unavailable().empty() && toast::schedFactory;
  for (auto &e : due) {
    std::string id = e["id"], repeat = e.value("repeat", ""), err;
    double at = e["at"].get<double>();
    notif::Show s;
    bool parsed = notif::parse_show(e["args"], s, &err);
    s.id = id;
    int window = g_sched_window.count(id) ? g_sched_window[id] : 0;
    if (viaOs) unschedule(tag_for(id));
    if (parsed && (!viaOs || at >= g_started - 1000)) {
      if (deliver(s, window, &err, viaOs && at < now - 500)) notif::shown_event(id, s.payload);
      else fprintf(stderr, "[shell] scheduled notification %s: %s\n", id.c_str(), err.c_str());
    }
    double next = repeat.empty() ? 0 : notif::next_occurrence(at, repeat, std::max(now, at) + 500);
    if (json *cur = store().find(id)) {
      if (next > 0) {
        (*cur)["at"] = (long long)next;
        if (viaOs && !os_schedule(*cur, &err)) fprintf(stderr, "[shell] notifications: %s\n", err.c_str());
      } else {
        store().erase(id);
        g_sched_window.erase(id);
      }
    }
    changed = true;
  }
  if (changed) store().save();
  rearm_timer();
}

static void rearm_timer() {
  HWND h = hidden_window();
  if (!h) return;
  if (store().items.empty()) return (void)KillTimer(h, kTimer);
  double first = 0;
  for (auto &e : store().items) {
    double at = e["at"].get<double>();
    if (first == 0 || at < first) first = at;
  }
  double delay = std::max(50.0, std::min(30000.0, first - notif::now_ms() - 1000)); // a moment before the OS would
  SetTimer(h, kTimer, (UINT)delay, nullptr);
}

static void cancel_pending(const std::string &id) {
  toast_unavailable();
  if (toast::notifier) unschedule(tag_for(id));
  if (store().erase(id)) store().save(), rearm_timer();
  g_sched_window.erase(id);
}

// ---------------------------------------------------------------------------
// Badge: taskbar overlay icon with the count

static int g_badge = 0;
static HICON g_badge_icon = nullptr;

static HICON badge_icon(int count) {
  int size = GetSystemMetrics(SM_CXSMICON);
  std::string text = count > 99 ? "99+" : std::to_string(count);
  std::vector<uint8_t> px((size_t)size * size * 4, 0);
  double r = size / 2.0;
  for (int y = 0; y < size; y++)
    for (int x = 0; x < size; x++) {
      double d = std::sqrt((x + 0.5 - r) * (x + 0.5 - r) + (y + 0.5 - r) * (y + 0.5 - r));
      double a = std::max(0.0, std::min(1.0, r - d + 0.5));
      uint8_t *p = &px[((size_t)y * size + x) * 4];
      p[0] = (uint8_t)std::lround(0x30 * a), p[1] = (uint8_t)std::lround(0x3b * a), p[2] = (uint8_t)std::lround(0xe5 * a), p[3] = (uint8_t)std::lround(255 * a);
    }
  // Text as a coverage mask: white on black into a 32-bit DIB, then blended white.
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof bi.bmiHeader;
  bi.bmiHeader.biWidth = size;
  bi.bmiHeader.biHeight = -size;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  void *bits = nullptr;
  HDC dc = CreateCompatibleDC(nullptr);
  HBITMAP bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (bmp && bits) {
    HGDIOBJ oldBmp = SelectObject(dc, bmp);
    memset(bits, 0, (size_t)size * size * 4);
    std::wstring w = wide(text);
    int fontPx = text.size() == 1 ? size * 3 / 4 : text.size() == 2 ? size * 5 / 8 : size / 2;
    HFONT font = CreateFontW(-fontPx, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, ANTIALIASED_QUALITY, 0, L"Segoe UI");
    HGDIOBJ oldFont = SelectObject(dc, font);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(255, 255, 255));
    RECT rc{0, 0, size, size};
    DrawTextW(dc, w.c_str(), (int)w.size(), &rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOCLIP);
    GdiFlush();
    const uint8_t *m = static_cast<const uint8_t *>(bits);
    for (size_t i = 0; i < (size_t)size * size; i++) {
      double a = m[i * 4 + 1] / 255.0; // green channel ≈ coverage
      uint8_t *p = &px[i * 4];
      if (a <= 0 || p[3] == 0) continue;
      for (int c = 0; c < 3; c++) p[c] = (uint8_t)std::lround(p[c] * (1 - a) + p[3] * a); // premultiplied white
    }
    SelectObject(dc, oldFont);
    DeleteObject(font);
    SelectObject(dc, oldBmp);
  }
  if (bmp) DeleteObject(bmp);
  DeleteDC(dc);
  // icon_from_bgra expects straight alpha
  for (size_t i = 0; i < px.size(); i += 4)
    if (px[i + 3] && px[i + 3] < 255)
      for (int c = 0; c < 3; c++) px[i + c] = (uint8_t)std::min(255L, std::lround(px[i + c] * 255.0 / px[i + 3]));
  return icon_from_bgra(px, (UINT)size, (UINT)size);
}

static void apply_badge(HWND hwnd) {
  ITaskbarList3 *tb = nullptr;
  if (FAILED(CoCreateInstance(CLSID_TaskbarList, nullptr, CLSCTX_INPROC_SERVER, IID_ITaskbarList3, reinterpret_cast<void **>(&tb))) || !tb) return;
  if (SUCCEEDED(tb->HrInit())) {
    std::wstring desc = g_badge > 0 ? wide(std::to_string(g_badge) + " notifications") : L"";
    tb->SetOverlayIcon(hwnd, g_badge > 0 ? g_badge_icon : nullptr, desc.c_str());
  }
  tb->Release();
}

void taskbar_button_created(HWND hwnd) {
  if (g_badge > 0) apply_badge(hwnd);
}

void notification_balloon_clicked(const std::string &id) {
  auto rec = notif::records().find(id);
  if (rec != notif::records().end()) rec->second.acted = true;
  notif::respond(id, "click", "", nullptr, "", 0);
  notif::records().erase(id);
}

// ---------------------------------------------------------------------------

static json delivered_list() {
  json out = json::array();
  if (toast_unavailable().empty() && toast::history2) {
    Ptr<ToastList> list;
    if (SUCCEEDED(toast::history2->GetHistoryWithId(rt::HStr(aumid()), list.put())) && list) {
      UINT32 n = 0;
      list->get_Size(&n);
      for (UINT32 i = 0; i < n; i++) {
        Ptr<wun::IToastNotification> t;
        if (FAILED(list->GetAt(i, t.put())) || !t) continue;
        Ptr<wxd::IXmlDocument> doc;
        t->get_Content(doc.put());
        json c = read_content(doc.get());
        std::string id = notif::jstr(c, "i");
        Ptr<wun::IToastNotification2> t2;
        std::string group;
        if (t.as(t2)) {
          HSTRING h = nullptr;
          if (id.empty() && SUCCEEDED(t2->get_Tag(&h))) id = rt::take(h);
          if (SUCCEEDED(t2->get_Group(&h))) group = rt::take(h);
        }
        if (id.empty()) continue;
        auto rec = notif::records().find(id);
        if (rec != notif::records().end()) {
          out.push_back(notif::record_json(rec->second));
          continue;
        }
        json lines = c.value("lines", json::array());
        json o{{"id", id}, {"title", lines.size() > 0 ? lines[0] : json("")}, {"body", lines.size() > 1 ? lines.back() : json("")}};
        if (lines.size() > 2) o["subtitle"] = lines[1];
        if (!group.empty() && group != "sd") o["group"] = group;
        if (c.contains("p") && c["p"].is_string()) o["payload"] = c["p"];
        out.push_back(o);
      }
      return out;
    }
  }
  for (auto &[id, r] : notif::records()) out.push_back(notif::record_json(r)); // fallback: what this process showed
  return out;
}

static std::string permission() {
  if (!toast_unavailable().empty()) return "granted"; // balloons need no permission
  wun::NotificationSetting setting = wun::NotificationSetting_Enabled;
  if (FAILED(toast::notifier->get_Setting(&setting))) return "granted";
  return setting == wun::NotificationSetting_Enabled ? "granted" : "denied";
}

void register_notifications() {
  g_started = notif::now_ms();
  register_identity();
  register_activator(); // early: a launch by COM (-ToastActivated) waits for it
  store().path = user_data_dir() + "\\scheduled-notifications.json";
  store().load();
  add_hidden_hook([](HWND h, UINT msg, WPARAM wp, LPARAM, LRESULT *) {
    if (msg != WM_TIMER || wp != kTimer) return false;
    KillTimer(h, kTimer);
    reconcile();
    return true;
  });
  // Startup: series whose occurrences ran out while the app was closed get topped up.
  backend_run_on_main([] {
    if (g_forwarding) return;
    toast_unavailable();
    std::string err;
    if (toast::notifier)
      for (auto &e : store().items)
        if (e.contains("repeat") && !os_schedule(e, &err)) fprintf(stderr, "[shell] notifications: %s\n", err.c_str());
    reconcile();
  });
  add_quit_hook([] {
    if (g_com_cookie) CoRevokeClassObject(g_com_cookie), g_com_cookie = 0;
    if (toast::balloons) tray_balloon_hide("");
    for (auto &[id, l] : toast::live) // the toasts stay in the Action Center; just drop our handlers
      if (l.toast) l.toast->remove_Activated(l.activated), l.toast->remove_Dismissed(l.dismissed), l.toast->Release(), l.toast = nullptr;
    toast::live.clear();
  });

  auto status = [](CallPtr c) { c->ok(json{{"status", permission()}}); };
  reg("notifications", "getPermissionStatus", status);
  reg("notifications", "requestPermission", status); // no prompt on Windows: the user toggles it in Settings

  reg_many("notifications", {"show", "notify"}, [](CallPtr c) {
    notif::Show s;
    std::string err;
    if (!notif::parse_show(c->args, s, &err)) return c->fail("invalid_args", err);
    int window = find_window(c->caller) ? c->caller : 0;
    double now = notif::now_ms();
    bool future = s.hasAt && s.at > now + 1000;
    if (!future) {
      cancel_pending(s.id); // dedupe: a pending one with this id is replaced
      if (!deliver(s, window, &err, false)) return c->fail("internal", err);
    }
    double at = future ? s.at : (!s.repeat.empty() ? notif::next_occurrence(s.at, s.repeat, now + 500) : 0);
    if (at <= 0) return c->ok(json{{"id", s.id}, {"scheduled", false}});
    json args = c->args;
    args["id"] = s.id;
    store().put(s.id, at, s.repeat, args);
    std::string saved = store().save();
    if (!saved.empty() || !os_schedule(*store().find(s.id), &err)) {
      if (saved.empty()) unschedule(tag_for(s.id)); // partial OS occurrences go with the record
      store().erase(s.id);
      store().save();
      return c->fail("internal", saved.empty() ? err : "notifications.show: the schedule could not be saved: " + saved);
    }
    if (future) remove_delivered(s.id); // one id = one notification: the scheduled one replaces the shown one
    g_sched_window[s.id] = window;
    rearm_timer();
    c->ok(json{{"id", s.id}, {"scheduled", true}});
  });

  reg_many("notifications", {"dismiss", "close"}, [](CallPtr c) {
    std::string id = c->str("id", c->str("tag"));
    if (id.empty()) return c->fail("invalid_args", "notifications.dismiss: `id` must be a string");
    toast_unavailable();
    cancel_pending(id);
    remove_delivered(id);
    c->ok();
  });
  reg("notifications", "dismissAll", [](CallPtr c) {
    toast_unavailable();
    unschedule("");
    store().items = json::array();
    store().save();
    g_sched_window.clear();
    rearm_timer();
    for (auto &[id, l] : toast::live)
      if (l.toast && toast::notifier) toast::notifier->Hide(l.toast);
    if (toast::history) toast::history->ClearWithId(rt::HStr(aumid()));
    if (toast::balloons) tray_balloon_hide("");
    std::vector<std::string> ids;
    for (auto &[id, _] : toast::live) ids.push_back(id);
    for (auto &id : ids) drop_live(id);
    notif::records().clear();
    c->ok();
  });
  reg("notifications", "delivered", [](CallPtr c) { c->ok(delivered_list()); });
  reg("notifications", "pending", [](CallPtr c) {
    reconcile();
    json out = json::array();
    for (auto &e : store().items) out.push_back(notif::pending_json(e));
    c->ok(out);
  });
  reg("notifications", "claim", [](CallPtr c) { c->ok(notif::take_claims()); });
  reg("notifications", "responses", [](CallPtr c) { c->ok(notif::ring()); });
  reg("notifications", "setBadge", [](CallPtr c) {
    int count = 0;
    if (c->has("count")) {
      if (!c->args["count"].is_number() || c->num("count") < 0) return c->fail("invalid_args", "notifications.setBadge: `count` must be a number ≥ 0 or null");
      count = (int)std::min(1e9, c->num("count"));
    }
    if (g_badge_icon) DestroyIcon(g_badge_icon);
    g_badge_icon = count > 0 ? badge_icon(count) : nullptr;
    g_badge = count;
    for (int id : window_order())
      if (Window *w = find_window(id)) apply_badge(w->hwnd);
    c->ok();
  });
  reg("notifications", "setForeground", [](CallPtr c) { c->ok(); }); // toasts always show on Windows
  reg_many("notifications", {"createChannel", "deleteChannel", "channels"}, [](CallPtr c) {
    c->fail("unsupported", "notifications." + c->op + ": notification channels are Android-only");
  });
  reg_many("push", {"register", "unregister", "token"}, [](CallPtr c) {
    c->fail("unsupported", "push." + c->op + ": no push service for unpackaged Windows apps (WNS needs a packaged app); use your own connection");
  });
}

} // namespace win
} // namespace sd
