// WinRT through the ABI interfaces (no C++/WinRT), for the files that use it. Include before their
// windows.*.h, after win.hpp.
#pragma once
// mingw-w64's windows.foundation.h specializes IReference<boolean> and IReference<BYTE>,
// the same type when `boolean` is `unsigned char`: a distinct 1-byte type (same ABI)
// for the WinRT headers.
enum sd_winrt_boolean : unsigned char {};
#define boolean sd_winrt_boolean
#include <roapi.h>
#include <windows.foundation.h>
#include <winstring.h>

#include <type_traits>

namespace wf = ABI::Windows::Foundation;

namespace sd::win {

// ---------------------------------------------------------------------------
// WinRT plumbing: combase entry points resolved at run time (no import lib).

namespace rt {
inline bool tried = false, ok = false;
inline std::string why;
inline HRESULT(WINAPI *ro_init)(RO_INIT_TYPE);
inline HRESULT(WINAPI *get_factory)(HSTRING, REFIID, void **);
inline HRESULT(WINAPI *activate)(HSTRING, IInspectable **);
inline HRESULT(WINAPI *create_string)(PCNZWCH, UINT32, HSTRING *);
inline HRESULT(WINAPI *delete_string)(HSTRING);
inline PCWSTR(WINAPI *raw_buffer)(HSTRING, UINT32 *);

inline bool load() {
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
inline std::string take(HSTRING h) {
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
} // namespace sd::win
