// clipboard.* — text (CF_UNICODETEXT), html (CF_HTML), rtf, image (PNG / CF_DIBV5
// <-> PNG through WIC), paths (CF_HDROP), registered formats by name. Also the shared WIC image and icon helpers.
#include "win.hpp"

#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <wincodec.h>

#include <wininet.h>

#include <cstring>
#include <set>


namespace sd::win {

// ===========================================================================
// WIC

static IWICImagingFactory *wic() {
  static IWICImagingFactory *f = nullptr;
  if (!f) CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_IWICImagingFactory, reinterpret_cast<void **>(&f));
  return f;
}

static bool wic_decode_source(IWICBitmapSource *src, UINT maxSize, std::vector<uint8_t> &bgra, UINT &w, UINT &h) {
  IWICImagingFactory *f = wic();
  IWICBitmapSource *source = src;
  source->AddRef();
  UINT sw = 0, sh = 0;
  source->GetSize(&sw, &sh);
  if (maxSize && (sw > maxSize || sh > maxSize) && sw && sh) {
    IWICBitmapScaler *scaler = nullptr;
    double k = (double)maxSize / std::max(sw, sh);
    UINT tw = std::max(1u, (UINT)(sw * k)), th = std::max(1u, (UINT)(sh * k));
    if (SUCCEEDED(f->CreateBitmapScaler(&scaler)) && SUCCEEDED(scaler->Initialize(source, tw, th, WICBitmapInterpolationModeFant))) {
      source->Release();
      source = scaler;
    } else if (scaler) {
      scaler->Release();
    }
  }
  IWICFormatConverter *conv = nullptr;
  bool ok = SUCCEEDED(f->CreateFormatConverter(&conv)) &&
            SUCCEEDED(conv->Initialize(source, GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom)) &&
            SUCCEEDED(conv->GetSize(&w, &h));
  if (ok) {
    bgra.resize((size_t)w * h * 4);
    ok = SUCCEEDED(conv->CopyPixels(nullptr, w * 4, (UINT)bgra.size(), bgra.data()));
  }
  release(conv);
  source->Release();
  return ok;
}

static bool wic_decode_scaled(const std::string &bytes, UINT maxSize, std::vector<uint8_t> &bgra, UINT &w, UINT &h) {
  IWICImagingFactory *f = wic();
  if (!f || bytes.empty()) return false;
  IWICStream *stream = nullptr;
  IWICBitmapDecoder *dec = nullptr;
  IWICBitmapFrameDecode *frame = nullptr;
  bool ok = SUCCEEDED(f->CreateStream(&stream)) &&
            SUCCEEDED(stream->InitializeFromMemory(reinterpret_cast<BYTE *>(const_cast<char *>(bytes.data())), (DWORD)bytes.size())) &&
            SUCCEEDED(f->CreateDecoderFromStream(stream, nullptr, WICDecodeMetadataCacheOnLoad, &dec)) && SUCCEEDED(dec->GetFrame(0, &frame)) &&
            wic_decode_source(frame, maxSize, bgra, w, h);
  release(frame);
  release(dec);
  release(stream);
  return ok;
}

bool wic_decode(const std::string &bytes, std::vector<uint8_t> &bgra, UINT &w, UINT &h) { return wic_decode_scaled(bytes, 0, bgra, w, h); }

bool wic_encode(const uint8_t *bgra, UINT w, UINT h, UINT stride, bool jpeg, double quality, std::string &out) {
  IWICImagingFactory *f = wic();
  if (!f) return false;
  IStream *mem = SHCreateMemStream(nullptr, 0);
  IWICBitmap *bmp = nullptr;
  IWICBitmapEncoder *enc = nullptr;
  IWICBitmapFrameEncode *frame = nullptr;
  IPropertyBag2 *props = nullptr;
  bool ok = mem && SUCCEEDED(f->CreateBitmapFromMemory(w, h, GUID_WICPixelFormat32bppBGRA, stride, stride * h, const_cast<BYTE *>(bgra), &bmp)) &&
            SUCCEEDED(f->CreateEncoder(jpeg ? GUID_ContainerFormatJpeg : GUID_ContainerFormatPng, nullptr, &enc)) &&
            SUCCEEDED(enc->Initialize(mem, WICBitmapEncoderNoCache)) && SUCCEEDED(enc->CreateNewFrame(&frame, &props));
  if (ok && jpeg && props) {
    PROPBAG2 opt{};
    opt.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
    VARIANT v;
    VariantInit(&v);
    v.vt = VT_R4;
    v.fltVal = (float)std::max(0.0, std::min(1.0, quality));
    props->Write(1, &opt, &v);
  }
  ok = ok && SUCCEEDED(frame->Initialize(props)) && SUCCEEDED(frame->SetSize(w, h)) && SUCCEEDED(frame->WriteSource(bmp, nullptr)) &&
       SUCCEEDED(frame->Commit()) && SUCCEEDED(enc->Commit());
  if (ok) {
    STATSTG st{};
    mem->Stat(&st, STATFLAG_NONAME);
    out.resize((size_t)st.cbSize.QuadPart);
    LARGE_INTEGER zero{};
    mem->Seek(zero, STREAM_SEEK_SET, nullptr);
    ULONG read = 0;
    ok = SUCCEEDED(mem->Read(&out[0], (ULONG)out.size(), &read)) && read == out.size();
  }
  release(props);
  release(frame);
  release(enc);
  release(bmp);
  release(mem);
  return ok;
}

// ===========================================================================
// Icons

HICON icon_from_bgra(const std::vector<uint8_t> &bgra, UINT w, UINT h) {
  BITMAPV5HEADER bi{};
  bi.bV5Size = sizeof bi;
  bi.bV5Width = (LONG)w;
  bi.bV5Height = -(LONG)h; // top-down
  bi.bV5Planes = 1;
  bi.bV5BitCount = 32;
  bi.bV5Compression = BI_BITFIELDS;
  bi.bV5RedMask = 0x00ff0000;
  bi.bV5GreenMask = 0x0000ff00;
  bi.bV5BlueMask = 0x000000ff;
  bi.bV5AlphaMask = 0xff000000;
  void *bits = nullptr;
  HDC dc = GetDC(nullptr);
  HBITMAP color = CreateDIBSection(dc, reinterpret_cast<BITMAPINFO *>(&bi), DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, dc);
  if (!color) return nullptr;
  memcpy(bits, bgra.data(), std::min(bgra.size(), (size_t)w * h * 4));
  HBITMAP mask = CreateBitmap((int)w, (int)h, 1, 1, nullptr);
  ICONINFO ii{TRUE, 0, 0, mask, color};
  HICON icon = CreateIconIndirect(&ii);
  DeleteObject(color);
  DeleteObject(mask);
  return icon;
}

HICON app_icon(bool small) {
  static HICON large = nullptr, smallIcon = nullptr;
  if (!large && !smallIcon) {
    std::wstring exe = exe_path();
    ExtractIconExW(exe.c_str(), 0, &large, &smallIcon, 1);
    if (!large) large = LoadIconW(nullptr, IDI_APPLICATION);
    if (!smallIcon) smallIcon = large;
  }
  return small ? smallIcon : large;
}

static bool read_file(const std::wstring &path, std::string &out) {
  HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  GetFileSizeEx(f, &size);
  if (size.QuadPart > 64 * 1024 * 1024) {
    CloseHandle(f);
    return false;
  }
  out.resize((size_t)size.QuadPart);
  DWORD read = 0;
  BOOL ok = out.empty() || ReadFile(f, &out[0], (DWORD)out.size(), &read, nullptr);
  CloseHandle(f);
  return ok && read == out.size();
}

static HICON stock_icon(const std::string &name, int size) {
  static const std::map<std::string, SHSTOCKICONID> ids = {
      {"folder", SIID_FOLDER}, {"openpanel", SIID_FOLDEROPEN}, {"trashempty", SIID_RECYCLER}, {"trashfull", SIID_RECYCLERFULL},
      {"caution", SIID_WARNING}, {"warning", SIID_WARNING}, {"info", SIID_INFO}, {"error", SIID_ERROR}, {"lock", SIID_LOCK},
      {"locklocked", SIID_LOCK}, {"share", SIID_SHARE}, {"network", SIID_WORLD}, {"computer", SIID_DESKTOPPC},
      {"user", SIID_USERS}, {"useraccounts", SIID_USERS}, {"usergroup", SIID_USERS}, {"everyone", SIID_USERS},
      {"preferencesgeneral", SIID_SETTINGS}, {"advanced", SIID_SETTINGS}, {"settings", SIID_SETTINGS}, {"help", SIID_HELP},
      {"reveal", SIID_FIND}, {"find", SIID_FIND}, {"application", SIID_APPLICATION}, {"multipledocuments", SIID_DOCASSOC},
      {"document", SIID_DOCNOASSOC}, {"delete", SIID_DELETE}, {"remove", SIID_DELETE}, {"shield", SIID_SHIELD},
  };
  auto it = ids.find(lower(name));
  if (it == ids.end()) return nullptr;
  SHSTOCKICONINFO info{sizeof info};
  if (FAILED(SHGetStockIconInfo(it->second, SHGSI_ICON | (size <= 16 ? SHGSI_SMALLICON : SHGSI_LARGEICON), &info))) return nullptr;
  return info.hIcon;
}

HICON load_icon(const json &spec, int size, const std::string &ctx, std::string &error) {
  std::string native, path;
  if (spec.is_string()) {
    std::string s = spec.get<std::string>();
    if (s.find_first_of("/\\.:~") != std::string::npos) path = s;
    else native = s;
  } else if (spec.is_object()) {
    native = jstr(spec, "native", jstr(spec, "symbol"));
    path = jstr(spec, "path", jstr(spec, "file"));
  }
  if (!native.empty()) {
    if (lower(native) == "app" || lower(native) == "appicon") return CopyIcon(app_icon(size <= 16));
    HICON icon = stock_icon(native, size);
    if (!icon) error = ctx + ": unknown native icon `" + native + "` on Windows";
    return icon;
  }
  if (!path.empty()) {
    std::wstring p = wide(path);
    if (!p.empty() && p[0] == L'~') {
      wchar_t *home = nullptr;
      if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &home)) && home) p = std::wstring(home) + p.substr(1);
      if (home) CoTaskMemFree(home);
    }
    std::string ext = lower(path.substr(path.find_last_of('.') == std::string::npos ? path.size() : path.find_last_of('.')));
    if (ext == ".ico") {
      HICON icon = static_cast<HICON>(LoadImageW(nullptr, p.c_str(), IMAGE_ICON, size, size, LR_LOADFROMFILE));
      if (icon) return icon;
    }
    std::string bytes;
    std::vector<uint8_t> px;
    UINT w = 0, h = 0;
    if (read_file(p, bytes) && wic_decode_scaled(bytes, (UINT)size, px, w, h)) return icon_from_bgra(px, w, h);
    error = ctx + ": could not load image `" + path + "`";
    return nullptr;
  }
  error = ctx + ": icon needs `native` (stock icon name) or `path` (file)";
  return nullptr;
}

// ===========================================================================
// Clipboard

static UINT fmt_html() {
  static UINT f = RegisterClipboardFormatW(L"HTML Format");
  return f;
}
static UINT fmt_rtf() {
  static UINT f = RegisterClipboardFormatW(L"Rich Text Format");
  return f;
}
static UINT fmt_png() {
  static UINT f = RegisterClipboardFormatW(L"PNG");
  return f;
}

struct ClipboardLock {
  bool open = false;
  ClipboardLock() {
    for (int i = 0; i < 20 && !open; i++) {
      open = OpenClipboard(hidden_window()) != 0;
      if (!open) Sleep(10); // another process holds it
    }
  }
  ~ClipboardLock() {
    if (open) CloseClipboard();
  }
};

#define WITH_CLIPBOARD(c)                                                                                                    \
  ClipboardLock lock_;                                                                                                       \
  if (!lock_.open) return (c)->fail("unavailable", "clipboard." + (c)->op + ": the clipboard is busy (" + last_error_message() + ")")

static std::string get_bytes(UINT format) {
  HANDLE h = GetClipboardData(format);
  if (!h) return "";
  const char *p = static_cast<const char *>(GlobalLock(h));
  std::string out = p ? std::string(p, GlobalSize(h)) : "";
  GlobalUnlock(h);
  return out;
}

static bool set_bytes(UINT format, const void *data, size_t size) {
  HGLOBAL g = GlobalAlloc(GMEM_MOVEABLE, size);
  if (!g) return false;
  memcpy(GlobalLock(g), data, size);
  GlobalUnlock(g);
  if (!SetClipboardData(format, g)) {
    GlobalFree(g);
    return false;
  }
  return true;
}

static json read_text() {
  HANDLE h = GetClipboardData(CF_UNICODETEXT);
  if (!h) return nullptr;
  const wchar_t *p = static_cast<const wchar_t *>(GlobalLock(h));
  std::string s = p ? utf8(p, (int)wcsnlen(p, GlobalSize(h) / sizeof(wchar_t))) : "";
  GlobalUnlock(h);
  return s;
}

static bool write_text(const std::string &text) {
  std::wstring w = wide(text);
  return set_bytes(CF_UNICODETEXT, w.c_str(), (w.size() + 1) * sizeof(wchar_t));
}

static std::string html_fragment(const std::string &cf) {
  auto field = [&](const char *name) -> long {
    auto p = cf.find(name);
    return p == std::string::npos ? -1 : atol(cf.c_str() + p + strlen(name));
  };
  long start = field("StartFragment:"), end = field("EndFragment:");
  if (start >= 0 && end > start && (size_t)end <= cf.size()) return cf.substr((size_t)start, (size_t)(end - start));
  long hs = field("StartHTML:"), he = field("EndHTML:");
  if (hs >= 0 && he > hs && (size_t)he <= cf.size()) return cf.substr((size_t)hs, (size_t)(he - hs));
  return cf;
}

static std::string make_cf_html(const std::string &fragment) {
  const char *header = "Version:0.9\r\nStartHTML:%010d\r\nEndHTML:%010d\r\nStartFragment:%010d\r\nEndFragment:%010d\r\n";
  std::string pre = "<html><body>\r\n<!--StartFragment-->", post = "<!--EndFragment-->\r\n</body></html>";
  char buf[256];
  int headerLen = snprintf(buf, sizeof buf, header, 0, 0, 0, 0);
  int startHtml = headerLen, startFrag = startHtml + (int)pre.size(), endFrag = startFrag + (int)fragment.size(),
      endHtml = endFrag + (int)post.size();
  snprintf(buf, sizeof buf, header, startHtml, endHtml, startFrag, endFrag);
  return std::string(buf) + pre + fragment + post;
}

static std::string strip_tags(const std::string &html) {
  std::string out;
  bool tag = false;
  for (char ch : html) {
    if (ch == '<') tag = true;
    else if (ch == '>') tag = false;
    else if (!tag) out += ch;
  }
  return out;
}

// CF_DIB -> top-down BGRA (straight alpha; all-zero alpha means opaque).
static bool dib_to_bgra(const std::string &dib, std::vector<uint8_t> &out, UINT &w, UINT &h) {
  if (dib.size() < sizeof(BITMAPINFOHEADER)) return false;
  BITMAPINFOHEADER bi;
  memcpy(&bi, dib.data(), sizeof bi);
  if (bi.biBitCount != 32 && bi.biBitCount != 24) return false;
  if (bi.biCompression != BI_RGB && bi.biCompression != BI_BITFIELDS) return false;
  w = (UINT)bi.biWidth;
  h = (UINT)std::abs(bi.biHeight);
  bool bottomUp = bi.biHeight > 0;
  size_t offset = bi.biSize + (bi.biCompression == BI_BITFIELDS && bi.biSize == sizeof(BITMAPINFOHEADER) ? 12 : 0) + bi.biClrUsed * 4;
  size_t stride = ((size_t)w * bi.biBitCount / 8 + 3) & ~(size_t)3;
  if (dib.size() < offset + stride * h) return false;
  out.assign((size_t)w * h * 4, 0);
  bool anyAlpha = false;
  for (UINT y = 0; y < h; y++) {
    const uint8_t *row = reinterpret_cast<const uint8_t *>(dib.data()) + offset + stride * (bottomUp ? h - 1 - y : y);
    for (UINT x = 0; x < w; x++) {
      uint8_t *d = &out[((size_t)y * w + x) * 4];
      const uint8_t *s = row + x * (bi.biBitCount / 8);
      d[0] = s[0];
      d[1] = s[1];
      d[2] = s[2];
      d[3] = bi.biBitCount == 32 ? s[3] : 255;
      anyAlpha = anyAlpha || d[3] != 0;
    }
  }
  if (!anyAlpha)
    for (size_t i = 3; i < out.size(); i += 4) out[i] = 255;
  return true;
}

// CF_DIBV5, for readers that take its alpha. Windows makes CF_DIB and CF_BITMAP out of it.
static std::string bgra_to_dibv5(const std::vector<uint8_t> &px, UINT w, UINT h) {
  BITMAPV5HEADER bi{};
  bi.bV5Size = sizeof bi;
  bi.bV5Width = (LONG)w;
  bi.bV5Height = (LONG)h;
  bi.bV5Planes = 1;
  bi.bV5BitCount = 32;
  bi.bV5Compression = BI_BITFIELDS;
  bi.bV5SizeImage = w * h * 4;
  bi.bV5RedMask = 0x00ff0000;
  bi.bV5GreenMask = 0x0000ff00;
  bi.bV5BlueMask = 0x000000ff;
  bi.bV5AlphaMask = 0xff000000;
  bi.bV5CSType = LCS_sRGB;
  bi.bV5Intent = LCS_GM_IMAGES;
  std::string out(reinterpret_cast<const char *>(&bi), sizeof bi);
  out.resize(sizeof bi + (size_t)w * h * 4);
  for (UINT y = 0; y < h; y++) memcpy(&out[sizeof bi + (size_t)(h - 1 - y) * w * 4], &px[(size_t)y * w * 4], (size_t)w * 4);
  return out;
}

static std::string make_hdrop(const std::vector<std::wstring> &paths) {
  std::wstring list;
  for (auto &p : paths) {
    list += p;
    list.push_back(L'\0');
  }
  list.push_back(L'\0');
  std::string buf(sizeof(DROPFILES) + list.size() * sizeof(wchar_t), '\0');
  auto *df = reinterpret_cast<DROPFILES *>(&buf[0]);
  df->pFiles = sizeof(DROPFILES);
  df->fWide = TRUE;
  memcpy(&buf[sizeof(DROPFILES)], list.data(), list.size() * sizeof(wchar_t));
  return buf;
}

static std::vector<std::wstring> read_hdrop() {
  std::vector<std::wstring> paths;
  HDROP drop = static_cast<HDROP>(GetClipboardData(CF_HDROP));
  if (!drop) return paths;
  UINT n = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
  for (UINT i = 0; i < n; i++) {
    UINT len = DragQueryFileW(drop, i, nullptr, 0);
    std::wstring p(len + 1, L'\0');
    DragQueryFileW(drop, i, &p[0], len + 1);
    p.resize(len);
    paths.push_back(p);
  }
  return paths;
}

// The PNG on the clipboard, else one made from a bitmap (what most programs put there), "" with neither.
static std::string read_png() {
  std::string png = get_bytes(fmt_png());
  if (!png.empty()) return png;
  std::vector<uint8_t> px;
  UINT w = 0, h = 0;
  std::string dib = get_bytes(CF_DIBV5);
  if (dib.empty()) dib = get_bytes(CF_DIB);
  if (dib.empty() || !dib_to_bgra(dib, px, w, h) || !wic_encode(px.data(), w, h, w * 4, false, 1, png)) return "";
  return png;
}

static const size_t kClipLimit = 16 * 1024 * 1024;

static std::string file_url(const std::wstring &path) {
  wchar_t url[INTERNET_MAX_URL_LENGTH];
  DWORD n = INTERNET_MAX_URL_LENGTH;
  return SUCCEEDED(UrlCreateFromPathW(path.c_str(), url, &n, 0)) ? utf8(url, (int)n) : "";
}

// As on macOS, all at once, and read back as bytes: text in UTF-8, CF_HTML's fragment.
static void clip_write(CallPtr c) {
  std::vector<std::pair<UINT, std::string>> out;
  size_t size = 0;
  std::set<UINT> taken;
  auto add = [&](UINT format, std::string bytes) {
    taken.insert(format);
    out.emplace_back(format, std::move(bytes));
  };
  auto add_text = [&](const std::string &text) {
    size += text.size();
    std::wstring w = wide(text);
    add(CF_UNICODETEXT, std::string(reinterpret_cast<const char *>(w.c_str()), (w.size() + 1) * sizeof(wchar_t)));
  };
  auto add_html = [&](const std::string &html) {
    size += html.size();
    std::string cf = make_cf_html(html);
    add(fmt_html(), std::string(cf.c_str(), cf.size() + 1));
  };
  auto add_rtf = [&](const std::string &rtf) {
    size += rtf.size();
    add(fmt_rtf(), std::string(rtf.c_str(), rtf.size() + 1));
  };
  auto add_image = [&](const std::string &bytes) {
    std::vector<uint8_t> px;
    UINT w = 0, h = 0;
    std::string png;
    if (!wic_decode(bytes, px, w, h) || !wic_encode(px.data(), w, h, w * 4, false, 1, png)) return false;
    size += png.size();
    add(fmt_png(), png);
    add(CF_DIBV5, bgra_to_dibv5(px, w, h));
    return true;
  };
  for (const char *key : {"text", "html", "rtf"}) {
    if (!c->has(key)) continue;
    if (!c->args[key].is_string()) return c->fail("invalid_args", "clipboard.write: text, html and rtf must be strings");
    std::string v = c->args[key].get<std::string>();
    if (!strcmp(key, "text")) add_text(v);
    else if (!strcmp(key, "html")) add_html(v);
    else add_rtf(v);
  }
  if (c->has("image")) {
    const json &encoded = c->args["image"];
    std::string bytes;
    if (!encoded.is_string() || encoded.get<std::string>().size() > kClipLimit * 4 / 3 + 4) return c->fail("invalid_args", "clipboard.write: invalid or oversized image");
    if (!base64_decode(encoded.get<std::string>(), bytes) || !add_image(bytes)) return c->fail("invalid_args", "clipboard.write: image must be base64 image bytes");
  }
  if (c->has("formats")) {
    const json &custom = c->args["formats"];
    if (!custom.is_object()) return c->fail("invalid_args", "clipboard.write: formats must map types to base64 bytes");
    for (auto &[name, encoded] : custom.items()) {
      if (name.empty() || !encoded.is_string() || encoded.get<std::string>().size() > kClipLimit * 4 / 3 + 4) return c->fail("invalid_args", "clipboard.write: invalid or oversized format");
      std::string bytes;
      if (!base64_decode(encoded.get<std::string>(), bytes)) return c->fail("invalid_args", "clipboard.write: invalid base64 or duplicate representation");
      UINT format = name == "text/plain" ? CF_UNICODETEXT : name == "text/html" ? fmt_html() : name == "text/rtf" ? fmt_rtf() : name == "image/png" ? fmt_png() : name == "files" ? CF_HDROP : RegisterClipboardFormatW(wide(name).c_str());
      if (!format) return c->fail("invalid_args", "clipboard.write: invalid clipboard format `" + name + "`");
      if (taken.count(format)) return c->fail("invalid_args", "clipboard.write: invalid base64 or duplicate representation");
      if (format == CF_HDROP) return c->fail("invalid_args", "clipboard.write: give file paths in `files`");
      if (format == CF_UNICODETEXT) add_text(bytes);
      else if (format == fmt_html()) add_html(bytes);
      else if (format == fmt_rtf()) add_rtf(bytes);
      else if (format == fmt_png()) {
        if (!add_image(bytes)) return c->fail("invalid_args", "clipboard.write: image must be base64 image bytes");
      } else {
        size += bytes.size();
        add(format, std::move(bytes));
      }
    }
  }
  if (c->has("files")) {
    if (!c->args["files"].is_array()) return c->fail("invalid_args", "clipboard.write: files must be absolute paths");
    std::vector<std::wstring> paths;
    for (auto &f : c->args["files"]) {
      std::wstring p = f.is_string() ? wide(f.get<std::string>()) : L"";
      for (auto &ch : p)
        if (ch == L'/') ch = L'\\';
      if (p.empty() || PathIsRelativeW(p.c_str())) return c->fail("invalid_args", "clipboard.write: files must be absolute paths");
      paths.push_back(p);
    }
    if (!paths.empty()) {
      std::string hdrop = make_hdrop(paths);
      size += hdrop.size();
      add(CF_HDROP, hdrop);
    }
  }
  if (size > kClipLimit || out.empty()) return c->fail("invalid_args", "clipboard.write: supply representations totaling at most 16 MiB");
  WITH_CLIPBOARD(c);
  double previous = GetClipboardSequenceNumber();
  if (!EmptyClipboard()) return c->fail("unavailable", "clipboard.write: " + last_error_message());
  for (auto &[format, bytes] : out)
    if (!set_bytes(format, bytes.data(), bytes.size())) return c->fail("unavailable", "clipboard.write: " + last_error_message());
  // The count that's there once they're all published: another program opens it after this.
  CloseClipboard();
  lock_.open = false;
  c->ok(json{{"changeCount", (double)GetClipboardSequenceNumber()}, {"previousChangeCount", previous}});
}

static void clip_read(CallPtr c) {
  double limit = c->has("maxBytes") && c->args["maxBytes"].is_number() ? c->num("maxBytes") : c->has("maxBytes") ? -1 : (double)kClipLimit;
  if (!c->args.contains("formats") || !c->args["formats"].is_array() || c->args["formats"].size() > 128 || limit < 1 || limit > (double)kClipLimit || limit != (double)(long long)limit)
    return c->fail("invalid_args", "clipboard.read: formats array and maxBytes between 1 and 16777216 required");
  for (auto &name : c->args["formats"])
    if (!name.is_string() || name.get<std::string>().empty()) return c->fail("invalid_args", "clipboard.read: formats must be nonempty strings");
  WITH_CLIPBOARD(c); // nobody can change it while it's open
  double changes = GetClipboardSequenceNumber();
  json result = json::object();
  size_t size = 0;
  auto terminated = [](std::string s) {
    while (!s.empty() && s.back() == '\0') s.pop_back();
    return s;
  };
  for (auto &entry : c->args["formats"]) {
    std::string name = entry, bytes;
    if (result.contains(name)) continue;
    bool found = false;
    if (name == "text/plain") {
      json text = read_text();
      if ((found = text.is_string())) bytes = text.get<std::string>();
    } else if (name == "text/html") {
      std::string cf = terminated(get_bytes(fmt_html()));
      if ((found = !cf.empty())) bytes = html_fragment(cf);
    } else if (name == "text/rtf") {
      bytes = terminated(get_bytes(fmt_rtf()));
      found = !bytes.empty();
    } else if (name == "image/png") {
      bytes = read_png();
      found = !bytes.empty();
    } else if (name == "files") { // file URLs, one a line, what the other platforms have
      for (auto &p : read_hdrop()) {
        bytes += file_url(p) + "\r\n";
        found = true;
      }
    } else if (UINT format = RegisterClipboardFormatW(wide(name).c_str()); format && IsClipboardFormatAvailable(format)) {
      bytes = get_bytes(format);
      found = true;
    }
    if (bytes.size() > (size_t)limit - size) return c->fail("invalid_args", "clipboard.read: result exceeds maxBytes");
    size += bytes.size();
    result[name] = found ? json(base64_encode(bytes.data(), bytes.size())) : json(nullptr);
  }
  c->ok(json{{"changeCount", changes}, {"formats", result}});
}

static const std::map<std::string, std::function<bool()>> &formats() {
  static const std::map<std::string, std::function<bool()>> m = {
      {"text/plain", [] { return IsClipboardFormatAvailable(CF_UNICODETEXT) != 0; }},
      {"text/html", [] { return IsClipboardFormatAvailable(fmt_html()) != 0; }},
      {"text/rtf", [] { return IsClipboardFormatAvailable(fmt_rtf()) != 0; }},
      {"image/png", [] { return IsClipboardFormatAvailable(fmt_png()) || IsClipboardFormatAvailable(CF_DIB) || IsClipboardFormatAvailable(CF_DIBV5); }},
      {"files", [] { return IsClipboardFormatAvailable(CF_HDROP) != 0; }},
  };
  return m;
}

static void write_string(CallPtr c, const char *key, UINT format, bool html) {
  if (!(c->args.contains(key) && c->args[key].is_string()))
    return c->fail("invalid_args", "clipboard." + c->op + ": `" + key + "` must be a string");
  std::string v = c->args[key].get<std::string>();
  WITH_CLIPBOARD(c);
  EmptyClipboard();
  if (html) {
    std::string cf = make_cf_html(v);
    set_bytes(format, cf.c_str(), cf.size() + 1);
    write_text(strip_tags(v));
  } else {
    set_bytes(format, v.c_str(), v.size() + 1);
  }
  c->ok();
}

void register_clipboard() {
  reg("clipboard", "write", clip_write);
  reg("clipboard", "read", clip_read);
  reg("clipboard", "readText", [](CallPtr c) {
    WITH_CLIPBOARD(c);
    c->ok(read_text());
  });
  reg("clipboard", "writeText", [](CallPtr c) {
    if (!(c->args.contains("text") && c->args["text"].is_string())) return c->fail("invalid_args", "clipboard.writeText: `text` must be a string");
    WITH_CLIPBOARD(c);
    EmptyClipboard();
    write_text(c->args["text"].get<std::string>());
    c->ok();
  });
  reg("clipboard", "readHtml", [](CallPtr c) {
    WITH_CLIPBOARD(c);
    std::string cf = get_bytes(fmt_html());
    while (!cf.empty() && cf.back() == '\0') cf.pop_back();
    c->ok(cf.empty() ? json(nullptr) : json(html_fragment(cf)));
  });
  reg("clipboard", "writeHtml", [](CallPtr c) { write_string(c, "html", fmt_html(), true); });
  reg("clipboard", "readRtf", [](CallPtr c) {
    WITH_CLIPBOARD(c);
    std::string rtf = get_bytes(fmt_rtf());
    while (!rtf.empty() && rtf.back() == '\0') rtf.pop_back();
    c->ok(rtf.empty() ? json(nullptr) : json(rtf));
  });
  reg("clipboard", "writeRtf", [](CallPtr c) { write_string(c, "rtf", fmt_rtf(), false); });
  reg("clipboard", "clear", [](CallPtr c) {
    WITH_CLIPBOARD(c);
    EmptyClipboard();
    c->ok();
  });
  reg("clipboard", "availableFormats", [](CallPtr c) {
    json out = json::array();
    for (auto &[name, test] : formats())
      if (test()) out.push_back(name);
    // Other programs' and the app's registered formats, by name. The numbered ones are the system's own,
    // which the contract's names above stand for.
    WITH_CLIPBOARD(c);
    for (UINT f = EnumClipboardFormats(0); f; f = EnumClipboardFormats(f)) {
      wchar_t name[256];
      int n = f >= 0xC000 && f != fmt_html() && f != fmt_rtf() && f != fmt_png() ? GetClipboardFormatNameW(f, name, 256) : 0;
      if (n > 0) out.push_back(utf8(name, n));
    }
    c->ok(out);
  });
  reg("clipboard", "has", [](CallPtr c) {
    std::string f = c->str("format");
    if (f.empty()) return c->fail("invalid_args", "clipboard.has: `format` is required");
    auto it = formats().find(f);
    if (it != formats().end()) return c->ok(it->second());
    UINT raw = RegisterClipboardFormatW(wide(f).c_str()); // raw clipboard format names pass through
    c->ok(raw && IsClipboardFormatAvailable(raw));
  });
  reg("clipboard", "readImage", [](CallPtr c) {
    WITH_CLIPBOARD(c);
    std::string png = read_png();
    if (png.empty()) return c->ok(nullptr);
    c->ok(json{{"bytes", base64_encode(png.data(), png.size())}, {"format", "png"}});
  });
  reg("clipboard", "writeImage", [](CallPtr c) {
    std::string bytes, png;
    std::vector<uint8_t> px;
    UINT w = 0, h = 0;
    if (!base64_decode(c->str("bytes"), bytes) || !wic_decode(bytes, px, w, h) || !wic_encode(px.data(), w, h, w * 4, false, 1, png))
      return c->fail("invalid_args", "clipboard.writeImage: `bytes` must be base64 image data");
    WITH_CLIPBOARD(c);
    EmptyClipboard();
    set_bytes(fmt_png(), png.data(), png.size());
    std::string dib = bgra_to_dibv5(px, w, h);
    set_bytes(CF_DIBV5, dib.data(), dib.size());
    c->ok();
  });
  reg("clipboard", "readPaths", [](CallPtr c) {
    WITH_CLIPBOARD(c);
    json paths = json::array();
    for (auto &p : read_hdrop()) paths.push_back(utf8(p));
    c->ok(paths.empty() ? json(nullptr) : paths);
  });
  reg("clipboard", "writePaths", [](CallPtr c) {
    if (!(c->args.contains("paths") && c->args["paths"].is_array())) return c->fail("invalid_args", "clipboard.writePaths: `paths` must be an array");
    std::vector<std::wstring> paths;
    for (auto &p : c->args["paths"])
      if (p.is_string()) paths.push_back(wide(p.get<std::string>()));
    std::string buf = make_hdrop(paths);
    WITH_CLIPBOARD(c);
    EmptyClipboard();
    set_bytes(CF_HDROP, buf.data(), buf.size());
    c->ok();
  });
}

} // namespace sd::win
