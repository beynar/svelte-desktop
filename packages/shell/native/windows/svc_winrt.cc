// What only WinRT has here:
//   shell.share: the Windows share sheet (IDataTransferManagerInterop) for text, a URL and files. Answers
//     the app chosen, or null when it's dismissed. It opens where Windows puts it: `anchor` has no meaning.
//   system.biometrics, secureStorage.authenticate: Windows Hello (UserConsentVerifier). It can't be held to
//     biometrics, the PIN always being a way in, so `biometricsOnly` answers not authenticated.
// A WinRT operation is awaited by looking at it from the UI thread: a completion handler would run on
// another one, only to come back here.
#include "win.hpp"

#include <shobjidl.h>

#include "winrt.hpp"
#include <asyncinfo.h>
#include <windows.applicationmodel.datatransfer.h>
#include <windows.security.credentials.ui.h>
#include <windows.storage.h>

namespace dt = ABI::Windows::ApplicationModel::DataTransfer;
namespace st = ABI::Windows::Storage;
namespace cu = ABI::Windows::Security::Credentials::UI;
namespace wfc = ABI::Windows::Foundation::Collections;

// Not in mingw-w64's headers: only what's called, in the order of the SDK's. windows-desktop.test.ts asks
// the runner's factories for these ids.
MIDL_INTERFACE("39E050C3-4E74-441A-8DC0-B81104DF949C")
ISdUserConsentVerifierInterop : public IInspectable {
public:
  virtual HRESULT STDMETHODCALLTYPE RequestVerificationForWindowAsync(HWND window, HSTRING message, REFIID riid, void **operation) = 0;
};
MIDL_INTERFACE("5984C710-DAF2-43C8-8BB4-A4D3EACFD03F")
ISdStorageFileStatics : public IInspectable {
public:
  virtual HRESULT STDMETHODCALLTYPE GetFileFromPathAsync(HSTRING path, ABI::Windows::Foundation::IAsyncOperation<ABI::Windows::Storage::StorageFile *> **operation) = 0;
};
MIDL_INTERFACE("08F327FF-85D5-48B9-AEE9-28511E339F9F")
ISdStorageFolderStatics : public IInspectable {
public:
  virtual HRESULT STDMETHODCALLTYPE GetFolderFromPathAsync(HSTRING path, ABI::Windows::Foundation::IAsyncOperation<ABI::Windows::Storage::StorageFolder *> **operation) = 0;
};
__CRT_UUID_DECL(ISdUserConsentVerifierInterop, 0x39e050c3, 0x4e74, 0x441a, 0x8d,0xc0, 0xb8,0x11,0x04,0xdf,0x94,0x9c)
__CRT_UUID_DECL(ISdStorageFileStatics, 0x5984c710, 0xdaf2, 0x43c8, 0x8b,0xb4, 0xa4,0xd3,0xea,0xcf,0xd0,0x3f)
__CRT_UUID_DECL(ISdStorageFolderStatics, 0x08f327ff, 0x85d5, 0x48b9, 0xae,0xe9, 0x28,0x51,0x1e,0x33,0x9f,0x9f)

namespace sd::win {

/// Calls `done` on the UI thread once the operation has ended (true: it completed).
template <class Op> static void when_finished(Op *op, std::function<void(bool completed, HRESULT error)> done) {
  ::IAsyncInfo *info = nullptr;
  if (FAILED(op->QueryInterface(__uuidof(::IAsyncInfo), reinterpret_cast<void **>(&info))) || !info) return done(false, E_NOINTERFACE);
  ::AsyncStatus status = ::Started;
  info->get_Status(&status);
  HRESULT error = S_OK;
  if (status == ::Error) info->get_ErrorCode(&error);
  info->Release();
  if (status != ::Started) return done(status == ::Completed, error);
  op->AddRef();
  run_after(30, [op, done] {
    when_finished(op, done);
    op->Release();
  });
}

// ---------------------------------------------------------------------------
// Windows Hello

using Availability = cu::UserConsentVerifierAvailability;

static std::string availability_reason(Availability a) {
  switch (a) {
    case cu::UserConsentVerifierAvailability_DeviceNotPresent: return "this device has no Windows Hello";
    case cu::UserConsentVerifierAvailability_NotConfiguredForUser: return "Windows Hello isn't set up for this user";
    case cu::UserConsentVerifierAvailability_DisabledByPolicy: return "Windows Hello is turned off by policy";
    case cu::UserConsentVerifierAvailability_DeviceBusy: return "Windows Hello is busy";
    default: return "";
  }
}

/// `error` is "" when `a` is what Windows says.
static void check_hello(std::function<void(Availability a, const std::string &error)> done) {
  auto none = cu::UserConsentVerifierAvailability_DeviceNotPresent;
  if (!rt::load()) return done(none, rt::why);
  Ptr<cu::IUserConsentVerifierStatics> statics;
  rt::HStr name(std::string("Windows.Security.Credentials.UI.UserConsentVerifier"));
  HRESULT hr = rt::get_factory(name, __uuidof(cu::IUserConsentVerifierStatics), reinterpret_cast<void **>(statics.put()));
  if (FAILED(hr)) return done(none, hresult_message(hr));
  wf::IAsyncOperation<Availability> *op = nullptr;
  hr = statics->CheckAvailabilityAsync(&op);
  if (FAILED(hr) || !op) return done(none, hresult_message(hr));
  when_finished(op, [op, done, none](bool completed, HRESULT error) {
    Availability a = none;
    HRESULT hr = completed ? op->GetResults(&a) : (FAILED(error) ? error : E_ABORT);
    op->Release();
    done(a, FAILED(hr) ? hresult_message(hr) : "");
  });
}

static void biometrics(CallPtr c) {
  check_hello([c](Availability a, const std::string &error) {
    if (!error.empty()) return c->fail("unavailable", "system.biometrics: " + error);
    bool available = a == cu::UserConsentVerifierAvailability_Available;
    c->ok(json{{"available", available},
               {"type", a == cu::UserConsentVerifierAvailability_DeviceNotPresent ? "none" : "windowsHello"},
               {"enrolled", available || a == cu::UserConsentVerifierAvailability_DeviceBusy}});
  });
}

static void authenticate(CallPtr c) {
  auto refuse = [c](const std::string &reason) { c->ok(json{{"authenticated", false}, {"reason", reason}}); };
  if (c->flag("biometricsOnly", false)) return refuse("Windows Hello can't be limited to biometrics");
  std::string reason = c->str("reason", "authenticate to continue");
  check_hello([c, refuse, reason](Availability a, const std::string &error) {
    if (!error.empty()) return refuse(error);
    if (a != cu::UserConsentVerifierAvailability_Available) return refuse(availability_reason(a));
    Window *w = find_window(resolve_window(*c));
    if (!w) return refuse("no window to ask from");
    Ptr<ISdUserConsentVerifierInterop> interop;
    rt::HStr name(std::string("Windows.Security.Credentials.UI.UserConsentVerifier")), message(reason);
    HRESULT hr = rt::get_factory(name, __uuidof(ISdUserConsentVerifierInterop), reinterpret_cast<void **>(interop.put()));
    wf::IAsyncOperation<cu::UserConsentVerificationResult> *op = nullptr;
    if (SUCCEEDED(hr)) hr = interop->RequestVerificationForWindowAsync(w->hwnd, message, __uuidof(wf::IAsyncOperation<cu::UserConsentVerificationResult>), reinterpret_cast<void **>(&op));
    if (FAILED(hr) || !op) return refuse(hresult_message(hr));
    when_finished(op, [op, c, refuse](bool completed, HRESULT error) {
      cu::UserConsentVerificationResult result = cu::UserConsentVerificationResult_Canceled;
      HRESULT hr = completed ? op->GetResults(&result) : (FAILED(error) ? error : E_ABORT);
      op->Release();
      if (FAILED(hr)) return refuse(hresult_message(hr));
      switch (result) {
        case cu::UserConsentVerificationResult_Verified: return c->ok(json{{"authenticated", true}});
        case cu::UserConsentVerificationResult_Canceled: return refuse("canceled by the user");
        case cu::UserConsentVerificationResult_RetriesExhausted: return refuse("too many failed attempts");
        case cu::UserConsentVerificationResult_DeviceBusy: return refuse("Windows Hello is busy");
        case cu::UserConsentVerificationResult_DisabledByPolicy: return refuse("Windows Hello is turned off by policy");
        case cu::UserConsentVerificationResult_NotConfiguredForUser: return refuse("Windows Hello isn't set up for this user");
        default: return refuse("this device has no Windows Hello");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// The share sheet

// The files, as what SetStorageItems takes. WinRT has nothing to make one of these from.
class ItemIterator final : public wfc::IIterator<st::IStorageItem *> {
public:
  explicit ItemIterator(std::vector<st::IStorageItem *> items) : items_(std::move(items)) {
    for (auto *i : items_) i->AddRef();
  }
  ~ItemIterator() {
    for (auto *i : items_) i->Release();
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++rc_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --rc_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **pp) override {
    if (!pp) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, __uuidof(IInspectable)) || IsEqualIID(riid, __uuidof(wfc::IIterator<st::IStorageItem *>)) || IsEqualIID(riid, IID_IAgileObject)) {
      *pp = static_cast<wfc::IIterator<st::IStorageItem *> *>(this);
      AddRef();
      return S_OK;
    }
    *pp = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE GetIids(ULONG *, IID **) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetRuntimeClassName(HSTRING *) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetTrustLevel(TrustLevel *level) override { return *level = BaseTrust, S_OK; }
  HRESULT STDMETHODCALLTYPE get_Current(st::IStorageItem **out) override {
    if (at_ >= items_.size()) return E_BOUNDS;
    *out = items_[at_];
    (*out)->AddRef();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE get_HasCurrent(sd_winrt_boolean *out) override { return *out = (sd_winrt_boolean)(at_ < items_.size()), S_OK; }
  HRESULT STDMETHODCALLTYPE MoveNext(sd_winrt_boolean *out) override {
    if (at_ < items_.size()) at_++;
    *out = (sd_winrt_boolean)(at_ < items_.size());
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetMany(UINT32 capacity, st::IStorageItem **out, UINT32 *count) override {
    *count = 0;
    while (at_ < items_.size() && *count < capacity) {
      out[*count] = items_[at_++];
      out[(*count)++]->AddRef();
    }
    return S_OK;
  }

private:
  std::atomic<ULONG> rc_{1};
  std::vector<st::IStorageItem *> items_;
  size_t at_ = 0;
};

class ItemList final : public wfc::IIterable<st::IStorageItem *> {
public:
  explicit ItemList(std::vector<st::IStorageItem *> items) : items_(std::move(items)) {
    for (auto *i : items_) i->AddRef();
  }
  ~ItemList() {
    for (auto *i : items_) i->Release();
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++rc_; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = --rc_;
    if (r == 0) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **pp) override {
    if (!pp) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, __uuidof(IInspectable)) || IsEqualIID(riid, __uuidof(wfc::IIterable<st::IStorageItem *>)) || IsEqualIID(riid, IID_IAgileObject)) {
      *pp = static_cast<wfc::IIterable<st::IStorageItem *> *>(this);
      AddRef();
      return S_OK;
    }
    *pp = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE GetIids(ULONG *, IID **) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetRuntimeClassName(HSTRING *) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetTrustLevel(TrustLevel *level) override { return *level = BaseTrust, S_OK; }
  HRESULT STDMETHODCALLTYPE First(wfc::IIterator<st::IStorageItem *> **out) override {
    *out = new ItemIterator(items_);
    return S_OK;
  }

private:
  std::atomic<ULONG> rc_{1};
  std::vector<st::IStorageItem *> items_;
};

using DataRequestedIface = wf::ITypedEventHandler<dt::DataTransferManager *, dt::DataRequestedEventArgs *>;
using ChosenIface = wf::ITypedEventHandler<dt::DataTransferManager *, dt::TargetApplicationChosenEventArgs *>;
using CanceledIface = wf::ITypedEventHandler<dt::DataPackage *, IInspectable *>;

struct Share {
  CallPtr call;
  HWND hwnd = nullptr;
  std::string text, url, title;
  std::vector<st::IStorageItem *> items;
  dt::IDataTransferManager *manager = nullptr;
  EventRegistrationToken requested{}, chosen{};
  bool answered = false;
  ~Share() {
    for (auto *i : items) i->Release();
    release(manager);
  }
};
static std::map<HWND, std::shared_ptr<Share>> g_shares; // Windows has one per window at a time

static std::shared_ptr<Share> share_end(HWND hwnd) {
  auto it = g_shares.find(hwnd);
  if (it == g_shares.end()) return nullptr;
  auto share = it->second;
  g_shares.erase(it);
  if (share->manager) {
    share->manager->remove_DataRequested(share->requested);
    share->manager->remove_TargetApplicationChosen(share->chosen);
  }
  return share;
}

static void share_answer(HWND hwnd, const json &service) {
  if (auto share = share_end(hwnd)) share->call->ok(json{{"service", service}});
}

static HRESULT fill_package(Share &share, dt::IDataRequestedEventArgs *args) {
  Ptr<dt::IDataRequest> request;
  Ptr<dt::IDataPackage> package;
  Ptr<dt::IDataPackagePropertySet> properties;
  HRESULT hr = args->get_Request(request.put());
  if (SUCCEEDED(hr)) hr = request->get_Data(package.put());
  if (SUCCEEDED(hr)) hr = package->get_Properties(properties.put());
  if (FAILED(hr)) return hr;
  rt::HStr title(share.title); // nothing shows without one
  if (FAILED(hr = properties->put_Title(title))) return hr;
  if (!share.text.empty()) {
    rt::HStr text(share.text);
    if (FAILED(hr = package->SetText(text))) return hr;
  }
  if (!share.url.empty()) {
    Ptr<wf::IUriRuntimeClassFactory> factory;
    Ptr<wf::IUriRuntimeClass> uri;
    Ptr<dt::IDataPackage2> package2;
    rt::HStr uriClass(std::string("Windows.Foundation.Uri")), value(share.url);
    hr = rt::get_factory(uriClass, __uuidof(wf::IUriRuntimeClassFactory), reinterpret_cast<void **>(factory.put()));
    if (SUCCEEDED(hr)) hr = factory->CreateUri(value, uri.put());
    if (SUCCEEDED(hr) && package.as(package2)) hr = package2->SetWebLink(uri.get());
    if (FAILED(hr)) return hr;
  }
  if (!share.items.empty()) {
    auto *list = new ItemList(share.items);
    hr = package->SetStorageItems(list, (sd_winrt_boolean) true);
    list->Release();
    if (FAILED(hr)) return hr;
  }
  HWND hwnd = share.hwnd;
  Ptr<dt::IDataPackage4> package4;
  if (!package.as(package4)) { // before Windows 10 2004 nothing says it was dismissed
    backend_run_on_main([hwnd] { share_answer(hwnd, nullptr); });
    return S_OK;
  }
  auto *canceled = new Handler<CanceledIface, dt::IDataPackage, IInspectable>([hwnd](dt::IDataPackage *, IInspectable *) {
    backend_run_on_main([hwnd] { share_answer(hwnd, nullptr); });
  });
  EventRegistrationToken token{};
  hr = package4->add_ShareCanceled(canceled, &token);
  canceled->Release();
  if (FAILED(hr)) return hr;
  // A sheet that fails on its own says nothing, it just lets go of the data. After what a choice has to say.
  auto *destroyed = new Handler<CanceledIface, dt::IDataPackage, IInspectable>([hwnd](dt::IDataPackage *, IInspectable *) {
    backend_run_on_main([hwnd] { run_after(500, [hwnd] { share_answer(hwnd, nullptr); }); });
  });
  hr = package->add_Destroyed(destroyed, &token);
  destroyed->Release();
  return hr;
}

static void share_show(const std::shared_ptr<Share> &share) {
  auto fail = [&share](const std::string &message) {
    share_end(share->hwnd);
    share->call->fail("unavailable", "shell.share: " + message);
  };
  Ptr<IDataTransferManagerInterop> interop;
  rt::HStr name(std::string("Windows.ApplicationModel.DataTransfer.DataTransferManager"));
  HRESULT hr = rt::get_factory(name, IID_IDataTransferManagerInterop, reinterpret_cast<void **>(interop.put()));
  if (SUCCEEDED(hr)) hr = interop->GetForWindow(share->hwnd, __uuidof(dt::IDataTransferManager), reinterpret_cast<void **>(&share->manager));
  if (FAILED(hr)) return fail(hresult_message(hr));
  Share *raw = share.get();
  auto *requested = new Handler<DataRequestedIface, dt::IDataTransferManager, dt::IDataRequestedEventArgs>([raw](dt::IDataTransferManager *, dt::IDataRequestedEventArgs *args) {
    HRESULT hr = fill_package(*raw, args);
    if (FAILED(hr)) backend_run_on_main([hwnd = raw->hwnd, hr] {
      if (auto share = share_end(hwnd)) share->call->fail("internal", "shell.share: " + hresult_message(hr));
    });
  });
  hr = share->manager->add_DataRequested(requested, &share->requested);
  requested->Release();
  if (FAILED(hr)) return fail(hresult_message(hr));
  HWND hwnd = share->hwnd;
  auto *chosen = new Handler<ChosenIface, dt::IDataTransferManager, dt::ITargetApplicationChosenEventArgs>([hwnd](dt::IDataTransferManager *, dt::ITargetApplicationChosenEventArgs *args) {
    HSTRING name = nullptr;
    args->get_ApplicationName(&name);
    std::string service = rt::take(name);
    backend_run_on_main([hwnd, service] { share_answer(hwnd, service); });
  });
  hr = share->manager->add_TargetApplicationChosen(chosen, &share->chosen);
  chosen->Release();
  if (FAILED(hr)) return fail(hresult_message(hr));
  hr = interop->ShowShareUIForWindow(share->hwnd);
  if (FAILED(hr)) fail(hresult_message(hr));
}

static void share_next_file(const std::shared_ptr<Share> &share, std::vector<std::wstring> files, size_t i) {
  if (i == files.size()) return share_show(share);
  auto fail = [&share](const std::string &message) {
    g_shares.erase(share->hwnd);
    share->call->fail("unavailable", "shell.share: " + message);
  };
  rt::HStr path(files[i]);
  bool folder = GetFileAttributesW(files[i].c_str()) & FILE_ATTRIBUTE_DIRECTORY;
  auto finish = [share, files, i](IInspectable *item, HRESULT hr) {
    st::IStorageItem *storage = nullptr;
    if (SUCCEEDED(hr) && item) hr = item->QueryInterface(__uuidof(st::IStorageItem), reinterpret_cast<void **>(&storage));
    if (item) item->Release();
    if (FAILED(hr) || !storage) {
      g_shares.erase(share->hwnd);
      return share->call->fail("unavailable", "shell.share: `" + utf8(files[i]) + "`: " + hresult_message(hr));
    }
    share->items.push_back(storage);
    share_next_file(share, files, i + 1);
  };
  HRESULT hr;
  if (folder) {
    Ptr<ISdStorageFolderStatics> statics;
    rt::HStr name(std::string("Windows.Storage.StorageFolder"));
    wf::IAsyncOperation<st::StorageFolder *> *op = nullptr;
    hr = rt::get_factory(name, __uuidof(ISdStorageFolderStatics), reinterpret_cast<void **>(statics.put()));
    if (SUCCEEDED(hr)) hr = statics->GetFolderFromPathAsync(path, &op);
    if (FAILED(hr) || !op) return fail(hresult_message(hr));
    when_finished(op, [op, finish](bool completed, HRESULT error) {
      st::IStorageFolder *result = nullptr;
      HRESULT hr = completed ? op->GetResults(&result) : (FAILED(error) ? error : E_ABORT);
      op->Release();
      finish(result, hr);
    });
  } else {
    Ptr<ISdStorageFileStatics> statics;
    rt::HStr name(std::string("Windows.Storage.StorageFile"));
    wf::IAsyncOperation<st::StorageFile *> *op = nullptr;
    hr = rt::get_factory(name, __uuidof(ISdStorageFileStatics), reinterpret_cast<void **>(statics.put()));
    if (SUCCEEDED(hr)) hr = statics->GetFileFromPathAsync(path, &op);
    if (FAILED(hr) || !op) return fail(hresult_message(hr));
    when_finished(op, [op, finish](bool completed, HRESULT error) {
      st::IStorageFile *result = nullptr;
      HRESULT hr = completed ? op->GetResults(&result) : (FAILED(error) ? error : E_ABORT);
      op->Release();
      finish(result, hr);
    });
  }
}

static void share(CallPtr c) {
  Window *w = find_window(resolve_window(*c));
  if (!w) return c->fail("invalid_args", "shell.share: no such window");
  std::string text = c->str("text"), url = c->str("url");
  if (!url.empty() && url_scheme(url).empty()) return c->fail("invalid_args", "shell.share: `url` must be an absolute URL");
  std::vector<std::wstring> files;
  if (c->args.contains("files") && c->args["files"].is_array())
    for (auto &f : c->args["files"]) {
      std::string given = f.is_string() ? f.get<std::string>() : f.dump();
      std::wstring path = wide(expand_home(given));
      for (auto &ch : path)
        if (ch == L'/') ch = L'\\';
      if (!f.is_string() || GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES) return c->fail("invalid_args", "shell.share: no such file `" + given + "`");
      files.push_back(path);
    }
  if (text.empty() && url.empty() && files.empty()) return c->fail("invalid_args", "shell.share: give `text`, `url` or `files`");
  if (!rt::load()) return c->fail("unavailable", "shell.share: " + rt::why);
  if (g_shares.count(w->hwnd)) return c->fail("unavailable", "shell.share: a share sheet is already open on this window");
  auto s = std::make_shared<Share>();
  s->call = c;
  s->hwnd = w->hwnd;
  s->text = text;
  s->url = url;
  s->title = c->str("title", app_name());
  g_shares[w->hwnd] = s;
  share_next_file(s, files, 0);
}

void register_winrt() {
  reg("shell", "share", share);
  reg("system", "biometrics", biometrics);
  reg("secureStorage", "authenticate", authenticate);
}

} // namespace sd::win
