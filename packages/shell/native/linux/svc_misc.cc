// screen.*, clipboard.*, shell.*, theme.*, diagnostics.info,
// capabilities.describe, power.* on GTK/GIO.
#include <dlfcn.h>
#include <gdk/gdkx.h>
#include <sys/utsname.h>
#include <unistd.h>

#include <algorithm>
#include <fstream>
#include <map>
#include <memory>
#include <set>
#include <sstream>

#include "linux.hpp"

namespace sd {
namespace lx {

static std::string expand_home(const std::string &p) {
  if (p.rfind("~/", 0) == 0 || p == "~") return std::string(g_get_home_dir()) + p.substr(1);
  return p;
}
static std::string gerror_message(GError *e, const std::string &fallback) {
  std::string m = e ? e->message : fallback;
  if (e) g_error_free(e);
  return m;
}

// ===========================================================================
// screen.* — monitors in root coordinates (top-left origin, y down)

static json display_info(GdkMonitor *m, int index) {
  GdkRectangle g, wa;
  gdk_monitor_get_geometry(m, &g);
  gdk_monitor_get_workarea(m, &wa);
  const char *model = gdk_monitor_get_model(m), *maker = gdk_monitor_get_manufacturer(m);
  std::string uuid = std::string(maker ? maker : "display") + "-" + (model ? model : "") + "-" + std::to_string(index);
  return json{{"id", index + 1},
              {"uuid", uuid},
              {"label", model ? json(model) : json("Display " + std::to_string(index + 1))},
              {"bounds", rect_json(g.x, g.y, g.width, g.height)},
              {"workArea", rect_json(wa.x, wa.y, wa.width, wa.height)},
              {"scaleFactor", gdk_monitor_get_scale_factor(m)},
              {"isPrimary", m == primary_monitor()}};
}

static int monitor_index(GdkMonitor *m) {
  GdkDisplay *d = gdk_display_get_default();
  for (int i = 0; i < gdk_display_get_n_monitors(d); i++)
    if (gdk_display_get_monitor(d, i) == m) return i;
  return 0;
}

static void register_screen() {
  reg("screen", "getAllDisplays", [](CallPtr c) {
    GdkDisplay *d = gdk_display_get_default();
    json list = json::array();
    for (int i = 0; i < gdk_display_get_n_monitors(d); i++) list.push_back(display_info(gdk_display_get_monitor(d, i), i));
    c->ok(list);
  });
  reg("screen", "getPrimaryDisplay", [](CallPtr c) {
    GdkMonitor *m = primary_monitor();
    m ? c->ok(display_info(m, monitor_index(m))) : c->fail("unavailable", "no display");
  });
  reg("screen", "getDisplayNearestWindow", [](CallPtr c) {
    Window *w = find_window(resolve_window(*c));
    GdkWindow *g = w ? gtk_widget_get_window(w->window) : nullptr;
    GdkMonitor *m = g ? gdk_display_get_monitor_at_window(gdk_display_get_default(), g) : primary_monitor();
    m ? c->ok(display_info(m, monitor_index(m))) : c->fail("unavailable", "no display");
  });
  reg("screen", "getCursorScreenPoint", [](CallPtr c) {
    int x, y;
    pointer_position(&x, &y);
    c->ok(json{{"x", x}, {"y", y}});
  });
  reg("screen", "scaleFactor", [](CallPtr c) {
    GdkMonitor *m = primary_monitor();
    c->ok(m ? gdk_monitor_get_scale_factor(m) : 1);
  });
  GdkDisplay *d = gdk_display_get_default();
  auto changed = +[](GdkDisplay *, GdkMonitor *, gpointer) { emit("displaysChanged"); };
  g_signal_connect(d, "monitor-added", G_CALLBACK(changed), nullptr);
  g_signal_connect(d, "monitor-removed", G_CALLBACK(changed), nullptr);
}

// ===========================================================================
// clipboard.* — the CLIPBOARD selection: text, html, rtf, png images, file paths

static GtkClipboard *cb() { return gtk_clipboard_get(GDK_SELECTION_CLIPBOARD); }

struct ClipPayload {
  std::map<std::string, std::string> raw; // target name → bytes
  std::string text;                       // served for every text target when non-empty
  bool hasText = false;
};

static void clip_get(GtkClipboard *, GtkSelectionData *sel, guint, gpointer data) {
  auto *p = static_cast<ClipPayload *>(data);
  gchar *name = gdk_atom_name(gtk_selection_data_get_target(sel));
  std::string target = name ? name : "";
  g_free(name);
  auto it = p->raw.find(target);
  if (it != p->raw.end()) {
    gtk_selection_data_set(sel, gtk_selection_data_get_target(sel), 8, (const guchar *)it->second.data(), (gint)it->second.size());
    return;
  }
  if (p->hasText) gtk_selection_data_set_text(sel, p->text.c_str(), (gint)p->text.size());
}
static void clip_clear(GtkClipboard *, gpointer data) { delete static_cast<ClipPayload *>(data); }

// What clipboard.write and read report. X11 has no such count: it's this process's, from the owner
// changes it sees. Its own writes count once, when made, so a read just after can compare.
static double g_clip_changes = 0;

static void on_clip_owner(GtkClipboard *, GdkEvent *event, gpointer) {
  GdkWindow *owner = event->owner_change.owner;
  if (!owner || gdk_window_get_window_type(owner) == GDK_WINDOW_FOREIGN) g_clip_changes++;
}

static void clip_set(ClipPayload *p) {
  g_clip_changes++;
  GtkTargetList *list = gtk_target_list_new(nullptr, 0);
  for (auto &[target, _] : p->raw) gtk_target_list_add(list, gdk_atom_intern(target.c_str(), FALSE), 0, 0);
  if (p->hasText) gtk_target_list_add_text_targets(list, 0);
  int n = 0;
  GtkTargetEntry *entries = gtk_target_table_new_from_list(list, &n);
  if (!gtk_clipboard_set_with_data(cb(), entries, (guint)n, clip_get, clip_clear, p)) delete p;
  gtk_target_table_free(entries, n);
  gtk_target_list_unref(list);
}

static std::string strip_html(const std::string &html) {
  std::string out;
  bool tag = false;
  for (char ch : html) {
    if (ch == '<') tag = true;
    else if (ch == '>') tag = false;
    else if (!tag) out += ch;
  }
  static const std::pair<const char *, const char *> ents[] = {{"&amp;", "&"}, {"&lt;", "<"}, {"&gt;", ">"}, {"&quot;", "\""}, {"&#39;", "'"}, {"&nbsp;", " "}};
  for (auto &[from, to] : ents)
    for (size_t pos; (pos = out.find(from)) != std::string::npos;) out.replace(pos, strlen(from), to);
  return out;
}

static std::string read_target(const char *target) {
  GtkSelectionData *sel = gtk_clipboard_wait_for_contents(cb(), gdk_atom_intern(target, FALSE));
  if (!sel) return "";
  gint len = 0;
  const guchar *d = gtk_selection_data_get_data_with_length(sel, &len);
  std::string out = d && len > 0 ? std::string((const char *)d, (size_t)len) : "";
  gtk_selection_data_free(sel);
  while (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

static std::set<std::string> clip_targets() {
  std::set<std::string> out;
  GdkAtom *atoms = nullptr;
  gint n = 0;
  if (!gtk_clipboard_wait_for_targets(cb(), &atoms, &n)) return out;
  for (int i = 0; i < n; i++) {
    gchar *name = gdk_atom_name(atoms[i]);
    out.insert(name);
    g_free(name);
  }
  if (gtk_targets_include_text(atoms, n)) out.insert("text/plain");
  if (gtk_targets_include_image(atoms, n, FALSE)) out.insert("image/png");
  if (out.count("application/rtf")) out.insert("text/rtf");
  if (out.count("text/uri-list")) out.insert("files");
  g_free(atoms);
  return out;
}

static const size_t kClipLimit = 16 * 1024 * 1024;

// Contract format names ↔ selection targets; anything else is a target's own name.
static std::string clip_target(const std::string &name) { return name == "files" ? "text/uri-list" : name; }

static void clip_write(CallPtr c) {
  auto p = std::make_unique<ClipPayload>();
  size_t size = 0;
  auto add = [&](const std::string &name, std::string bytes) {
    size += bytes.size();
    if (name == "text/plain") {
      p->text = std::move(bytes);
      p->hasText = true;
    } else if (name == "text/rtf") {
      p->raw["text/rtf"] = p->raw["application/rtf"] = std::move(bytes);
    } else {
      p->raw[clip_target(name)] = std::move(bytes);
    }
  };
  for (auto [key, format] : {std::pair<const char *, const char *>{"text", "text/plain"}, {"html", "text/html"}, {"rtf", "text/rtf"}}) {
    if (!c->has(key)) continue;
    if (!c->args[key].is_string()) return c->fail("invalid_args", "clipboard.write: text, html and rtf must be strings");
    add(format, c->str(key));
  }
  if (c->has("image")) {
    const json &encoded = c->args["image"];
    if (!encoded.is_string() || encoded.get<std::string>().size() > kClipLimit * 4 / 3 + 4) return c->fail("invalid_args", "clipboard.write: invalid or oversized image");
    bool decoded = false;
    auto bytes = base64_decode(encoded, &decoded);
    GdkPixbufLoader *loader = gdk_pixbuf_loader_new();
    bool loaded = decoded && gdk_pixbuf_loader_write(loader, bytes.data(), bytes.size(), nullptr);
    loaded = gdk_pixbuf_loader_close(loader, nullptr) && loaded;
    GdkPixbuf *image = loaded ? gdk_pixbuf_loader_get_pixbuf(loader) : nullptr;
    gchar *png = nullptr;
    gsize length = 0;
    if (!image || !gdk_pixbuf_save_to_buffer(image, &png, &length, "png", nullptr, nullptr)) {
      g_object_unref(loader);
      return c->fail("invalid_args", "clipboard.write: image must be base64 image bytes");
    }
    add("image/png", std::string(png, length));
    g_free(png);
    g_object_unref(loader);
  }
  if (c->has("formats")) {
    const json &custom = c->args["formats"];
    if (!custom.is_object()) return c->fail("invalid_args", "clipboard.write: formats must map types to base64 bytes");
    for (auto &[name, encoded] : custom.items()) {
      if (name.empty() || !encoded.is_string() || encoded.get<std::string>().size() > kClipLimit * 4 / 3 + 4) return c->fail("invalid_args", "clipboard.write: invalid or oversized format");
      std::string value = encoded;
      bool decoded = value.empty();
      auto bytes = value.empty() ? std::vector<unsigned char>() : base64_decode(value, &decoded);
      bool taken = name == "text/plain" ? p->hasText : p->raw.count(clip_target(name)) > 0;
      if (!decoded || taken) return c->fail("invalid_args", "clipboard.write: invalid base64 or duplicate representation");
      add(name, std::string(bytes.begin(), bytes.end()));
    }
  }
  if (c->has("files")) {
    if (!c->args["files"].is_array()) return c->fail("invalid_args", "clipboard.write: files must be absolute paths");
    std::string list, gnome = "copy";
    for (auto &path : c->args["files"]) {
      gchar *uri = path.is_string() && g_path_is_absolute(path.get<std::string>().c_str()) ? g_filename_to_uri(path.get<std::string>().c_str(), nullptr, nullptr) : nullptr;
      if (!uri) return c->fail("invalid_args", "clipboard.write: files must be absolute paths");
      list += std::string(uri) + "\r\n";
      gnome += std::string("\n") + uri;
      g_free(uri);
    }
    if (!list.empty()) {
      if (p->raw.count("text/uri-list")) return c->fail("invalid_args", "clipboard.write: duplicate file URL representation");
      size += list.size();
      p->raw["text/uri-list"] = list;
      p->raw["x-special/gnome-copied-files"] = gnome;
    }
  }
  if (size > kClipLimit || (p->raw.empty() && !p->hasText)) return c->fail("invalid_args", "clipboard.write: supply representations totaling at most 16 MiB");
  double previous = g_clip_changes;
  clip_set(p.release());
  c->ok(json{{"changeCount", g_clip_changes}, {"previousChangeCount", previous}});
}

/// A target's bytes, as they are. false: the clipboard doesn't have it. Asked only of what's offered:
/// some owners answer any target with what they hold.
static bool read_raw(const std::string &target, std::string *out) {
  if (!clip_targets().count(target)) return false;
  GtkSelectionData *sel = gtk_clipboard_wait_for_contents(cb(), gdk_atom_intern(target.c_str(), FALSE));
  if (!sel) return false;
  gint length = 0;
  const guchar *d = gtk_selection_data_get_data_with_length(sel, &length);
  bool found = d && length >= 0 && gtk_selection_data_get_length(sel) >= 0;
  if (found) out->assign((const char *)d, (size_t)length);
  gtk_selection_data_free(sel);
  return found;
}

static void clip_read(CallPtr c) {
  double limit = c->has("maxBytes") && c->args["maxBytes"].is_number() ? c->num("maxBytes") : c->has("maxBytes") ? -1 : (double)kClipLimit;
  if (!c->args.contains("formats") || !c->args["formats"].is_array() || c->args["formats"].size() > 128 || limit < 1 || limit > (double)kClipLimit || limit != (double)(long long)limit)
    return c->fail("invalid_args", "clipboard.read: formats array and maxBytes between 1 and 16777216 required");
  for (auto &name : c->args["formats"])
    if (!name.is_string() || name.get<std::string>().empty()) return c->fail("invalid_args", "clipboard.read: formats must be nonempty strings");
  double changes = g_clip_changes;
  json out = json::object();
  size_t size = 0;
  for (auto &entry : c->args["formats"]) {
    std::string name = entry, bytes;
    if (out.contains(name)) continue;
    bool found = false;
    if (name == "text/plain") {
      if (gchar *text = gtk_clipboard_wait_for_text(cb())) {
        bytes = text;
        found = true;
        g_free(text);
      }
    } else if (name == "text/rtf") {
      found = read_raw("text/rtf", &bytes) || read_raw("application/rtf", &bytes);
    } else if (name == "image/png") {
      found = read_raw("image/png", &bytes);
      if (GdkPixbuf *image = found ? nullptr : gtk_clipboard_wait_for_image(cb())) { // another image type: converted, as on macOS
        gchar *png = nullptr;
        gsize length = 0;
        if ((found = gdk_pixbuf_save_to_buffer(image, &png, &length, "png", nullptr, nullptr))) bytes.assign(png, length);
        g_free(png);
        g_object_unref(image);
      }
    } else {
      found = read_raw(clip_target(name), &bytes);
    }
    if (bytes.size() > (size_t)limit - size) return c->fail("invalid_args", "clipboard.read: result exceeds maxBytes");
    size += bytes.size();
    out[name] = found ? json(base64_encode((const unsigned char *)bytes.data(), bytes.size())) : json(nullptr);
  }
  if (g_clip_changes != changes) return c->fail("unavailable", "clipboard changed during read; retry");
  c->ok(json{{"changeCount", changes}, {"formats", out}});
}

static void register_clipboard() {
  g_signal_connect(cb(), "owner-change", G_CALLBACK(on_clip_owner), nullptr);
  reg("clipboard", "write", clip_write);
  reg("clipboard", "read", clip_read);
  reg("clipboard", "readText", [](CallPtr c) {
    gchar *t = gtk_clipboard_wait_for_text(cb());
    if (!t) return c->ok(nullptr);
    std::string s = t;
    g_free(t);
    c->ok(s);
  });
  reg("clipboard", "writeText", [](CallPtr c) {
    if (!c->args.contains("text") || !c->args["text"].is_string()) return c->fail("invalid_args", "clipboard.writeText: `text` must be a string");
    auto *p = new ClipPayload;
    p->text = c->str("text");
    p->hasText = true;
    clip_set(p);
    c->ok();
  });
  reg("clipboard", "readHtml", [](CallPtr c) {
    std::string h = read_target("text/html");
    h.empty() ? c->ok(nullptr) : c->ok(h);
  });
  reg("clipboard", "writeHtml", [](CallPtr c) {
    if (!c->args.contains("html") || !c->args["html"].is_string()) return c->fail("invalid_args", "clipboard.writeHtml: `html` must be a string");
    auto *p = new ClipPayload;
    p->raw["text/html"] = c->str("html");
    p->text = strip_html(c->str("html"));
    p->hasText = !p->text.empty();
    clip_set(p);
    c->ok();
  });
  reg("clipboard", "readRtf", [](CallPtr c) {
    std::string r = read_target("text/rtf");
    if (r.empty()) r = read_target("application/rtf");
    r.empty() ? c->ok(nullptr) : c->ok(r);
  });
  reg("clipboard", "writeRtf", [](CallPtr c) {
    if (!c->args.contains("rtf") || !c->args["rtf"].is_string()) return c->fail("invalid_args", "clipboard.writeRtf: `rtf` must be a string");
    auto *p = new ClipPayload;
    p->raw["text/rtf"] = p->raw["application/rtf"] = c->str("rtf");
    clip_set(p);
    c->ok();
  });
  reg("clipboard", "clear", [](CallPtr c) {
    // Take ownership, then release it: the selection has no owner → nothing to read.
    g_clip_changes++;
    gtk_clipboard_set_text(cb(), "", 0);
    gtk_clipboard_clear(cb());
    c->ok();
  });
  reg("clipboard", "availableFormats", [](CallPtr c) {
    auto t = clip_targets();
    json out = json::array();
    std::set<std::string> known = {"files", "image/png", "text/html", "text/plain", "text/rtf"};
    // Everything else with a type's name is a custom format, as on macOS. Not what these stand for
    // (each of the text and image conversions GTK offers), nor X11's own targets (TARGETS, UTF8_STRING…).
    GtkTargetList *conversions = gtk_target_list_new(nullptr, 0);
    gtk_target_list_add_image_targets(conversions, 0, TRUE);
    for (auto &target : t) {
      guint info;
      if (known.count(target)) out.push_back(target);
      else if (target == "image/tiff") out.push_back(target);
      else if (target.find('/') != std::string::npos && target != "text/uri-list" && target != "application/rtf" && target != "x-special/gnome-copied-files" &&
               target.rfind("text/plain;", 0) != 0 && !gtk_target_list_find(conversions, gdk_atom_intern(target.c_str(), FALSE), &info))
        out.push_back(target);
    }
    gtk_target_list_unref(conversions);
    c->ok(out);
  });
  reg("clipboard", "has", [](CallPtr c) {
    std::string f = c->str("format");
    if (f.empty()) return c->fail("invalid_args", "clipboard.has: `format` is required");
    c->ok(clip_targets().count(f) > 0); // contract names, or raw target names
  });
  reg("clipboard", "readImage", [](CallPtr c) {
    GdkPixbuf *pb = gtk_clipboard_wait_for_image(cb());
    if (!pb) return c->ok(nullptr);
    gchar *buf = nullptr;
    gsize len = 0;
    bool ok = gdk_pixbuf_save_to_buffer(pb, &buf, &len, "png", nullptr, nullptr);
    g_object_unref(pb);
    if (!ok) return c->ok(nullptr);
    std::string b64 = base64_encode((const unsigned char *)buf, len);
    g_free(buf);
    c->ok(json{{"bytes", b64}, {"format", "png"}});
  });
  reg("clipboard", "writeImage", [](CallPtr c) {
    bool ok = false;
    auto bytes = base64_decode(c->str("bytes"), &ok);
    GdkPixbuf *pb = nullptr;
    if (ok) {
      GdkPixbufLoader *loader = gdk_pixbuf_loader_new();
      if (gdk_pixbuf_loader_write(loader, bytes.data(), bytes.size(), nullptr) && gdk_pixbuf_loader_close(loader, nullptr)) {
        pb = gdk_pixbuf_loader_get_pixbuf(loader);
        if (pb) g_object_ref(pb);
      } else {
        gdk_pixbuf_loader_close(loader, nullptr);
      }
      g_object_unref(loader);
    }
    if (!pb) return c->fail("invalid_args", "clipboard.writeImage: `bytes` must be base64 image data");
    gtk_clipboard_set_image(cb(), pb);
    g_object_unref(pb);
    c->ok();
  });
  reg("clipboard", "readPaths", [](CallPtr c) {
    gchar **uris = gtk_clipboard_wait_for_uris(cb());
    if (!uris || !uris[0]) {
      g_strfreev(uris);
      return c->ok(nullptr);
    }
    json out = json::array();
    for (int i = 0; uris[i]; i++)
      if (gchar *p = g_filename_from_uri(uris[i], nullptr, nullptr)) {
        out.push_back(p);
        g_free(p);
      }
    g_strfreev(uris);
    out.empty() ? c->ok(nullptr) : c->ok(out);
  });
  reg("clipboard", "writePaths", [](CallPtr c) {
    if (!c->args.contains("paths") || !c->args["paths"].is_array()) return c->fail("invalid_args", "clipboard.writePaths: `paths` must be an array");
    std::string list, gnome = "copy", plain;
    for (auto &p : c->args["paths"]) {
      if (!p.is_string()) continue;
      gchar *uri = g_filename_to_uri(p.get<std::string>().c_str(), nullptr, nullptr);
      if (!uri) continue;
      list += std::string(uri) + "\r\n";
      gnome += std::string("\n") + uri;
      plain += (plain.empty() ? "" : "\n") + p.get<std::string>();
      g_free(uri);
    }
    auto *payload = new ClipPayload;
    payload->raw["text/uri-list"] = list;
    payload->raw["x-special/gnome-copied-files"] = gnome;
    payload->text = plain;
    payload->hasText = !plain.empty();
    clip_set(payload);
    c->ok();
  });
}

// ===========================================================================
// shell.* — hand URLs and files to the desktop (GIO)

static void launch_uri(CallPtr c, const std::string &uri) {
  auto *holder = new CallPtr(c);
  g_app_info_launch_default_for_uri_async(uri.c_str(), nullptr, nullptr, [](GObject *, GAsyncResult *res, gpointer data) {
    auto *h = static_cast<CallPtr *>(data);
    GError *err = nullptr;
    if (g_app_info_launch_default_for_uri_finish(res, &err)) (*h)->ok();
    else (*h)->fail("internal", gerror_message(err, "no handler"));
    delete h;
  }, holder);
}

/// `list` as existing paths; false: it has failed `c`.
static bool file_paths(const std::string &op, const json &list, std::vector<std::string> *out, const CallPtr &c) {
  for (auto &f : list) {
    std::string path = f.is_string() ? expand_home(f.get<std::string>()) : "";
    if (path.empty() || !g_file_test(path.c_str(), G_FILE_TEST_EXISTS)) {
      c->fail("invalid_args", op + ": no such file `" + (f.is_string() ? f.get<std::string>() : f.dump()) + "`");
      return false;
    }
    out->push_back(path);
  }
  return true;
}

// Files dragged out of the page to a file manager or another app, as XDND offering their URIs. From a
// dragstart (after preventDefault) or mousedown handler, while the button is still down. The source is the
// window, not the web view: WebKit answers its own view's drags.
struct DragOut {
  CallPtr call;
  std::vector<std::string> uris;
  bool failed = false;
  GtkWidget *source = nullptr;
};
static DragOut *g_drag_out = nullptr;

static void on_drag_out_data(GtkWidget *, GdkDragContext *, GtkSelectionData *data, guint, guint, gpointer) {
  std::vector<gchar *> uris;
  for (auto &u : g_drag_out->uris) uris.push_back((gchar *)u.c_str());
  uris.push_back(nullptr);
  gtk_selection_data_set_uris(data, uris.data());
}

static gboolean on_drag_out_failed(GtkWidget *, GdkDragContext *, GtkDragResult, gpointer) {
  g_drag_out->failed = true;
  return FALSE;
}

static CallPtr drag_out_done(GtkWidget *source) {
  CallPtr call = g_drag_out->call;
  delete g_drag_out;
  g_drag_out = nullptr;
  g_signal_handlers_disconnect_by_func(source, (gpointer)on_drag_out_data, nullptr);
  g_signal_handlers_disconnect_by_func(source, (gpointer)on_drag_out_failed, nullptr);
  return call;
}

static void on_drag_out_end(GtkWidget *source, GdkDragContext *, gpointer) {
  bool dropped = !g_drag_out->failed;
  g_signal_handlers_disconnect_by_func(source, (gpointer)on_drag_out_end, nullptr);
  drag_out_done(source)->ok(json{{"dropped", dropped}});
}

static void start_drag(CallPtr c) {
  Window *w = find_window(resolve_window(*c));
  GdkWindow *gw = w ? gtk_widget_get_window(w->window) : nullptr;
  if (!gw) return c->fail("invalid_args", "shell.startDrag: no such window");
  std::vector<std::string> files;
  if (!file_paths("shell.startDrag", c->args.contains("files") && c->args["files"].is_array() ? c->args["files"] : json::array(), &files, c)) return;
  if (files.empty()) return c->fail("invalid_args", "shell.startDrag: `files` is required");
  if (g_drag_out) return c->fail("unavailable", "shell.startDrag: another drag is going on");
  GdkDevice *pointer = gdk_seat_get_pointer(gdk_display_get_default_seat(gdk_window_get_display(gw)));
  GdkModifierType state = (GdkModifierType)0;
  gdk_device_get_state(pointer, gw, nullptr, &state);
  if (!(state & GDK_BUTTON1_MASK)) return c->fail("not_dragging", "shell.startDrag: the mouse button isn't down — call it from a dragstart or mousedown handler");
  auto *d = new DragOut{c};
  for (auto &f : files) {
    gchar *uri = g_filename_to_uri(f.c_str(), nullptr, nullptr);
    d->uris.push_back(uri ? uri : "");
    g_free(uri);
  }
  g_drag_out = d;
  g_signal_connect(w->window, "drag-data-get", G_CALLBACK(on_drag_out_data), nullptr);
  g_signal_connect(w->window, "drag-failed", G_CALLBACK(on_drag_out_failed), nullptr);
  g_signal_connect(w->window, "drag-end", G_CALLBACK(on_drag_out_end), nullptr);
  GtkTargetList *targets = gtk_target_list_new(nullptr, 0);
  gtk_target_list_add_uri_targets(targets, 0);
  GdkDragContext *context = gtk_drag_begin_with_coordinates(w->window, targets, GDK_ACTION_COPY, 1, nullptr, -1, -1);
  gtk_target_list_unref(targets);
  if (!context) { // the display wouldn't start one (Wayland wants the press's own event)
    g_signal_handlers_disconnect_by_func(w->window, (gpointer)on_drag_out_end, nullptr);
    drag_out_done(w->window)->fail("unavailable", "shell.startDrag: the display refused the drag");
    return;
  }
  GdkPixbuf *icon = c->has("icon") ? gdk_pixbuf_new_from_file_at_size(expand_home(c->str("icon")).c_str(), 64, 64, nullptr) : nullptr;
  if (icon) {
    gtk_drag_set_icon_pixbuf(context, icon, 32, 32);
    g_object_unref(icon);
  } else gtk_drag_set_icon_name(context, "text-x-generic", 32, 32);
}

static void register_shell() {
  reg("shell", "openExternal", [](CallPtr c) {
    std::string url = c->str("url");
    gchar *scheme = g_uri_parse_scheme(url.c_str());
    std::string s = scheme ? scheme : "";
    g_free(scheme);
    for (auto &ch : s) ch = (char)g_ascii_tolower(ch);
    static const std::set<std::string> allowed = {"http", "https", "mailto", "tel", "sms"};
    if (!allowed.count(s)) return c->fail("invalid_args", "shell.openExternal: only http(s)/mailto/tel/sms URLs (use openPath for files)");
    launch_uri(c, url);
  });
  reg("shell", "openPath", [](CallPtr c) {
    std::string path = expand_home(c->str("path"));
    if (path.empty() || !g_file_test(path.c_str(), G_FILE_TEST_EXISTS)) return c->fail("invalid_args", "shell.openPath: no such file `" + path + "`");
    gchar *uri = g_filename_to_uri(path.c_str(), nullptr, nullptr);
    launch_uri(c, uri ? uri : "");
    g_free(uri);
  });
  reg("shell", "showItemInFolder", [](CallPtr c) {
    std::string path = expand_home(c->str("path"));
    if (path.empty() || !g_file_test(path.c_str(), G_FILE_TEST_EXISTS))
      return c->fail("invalid_args", "shell.showItemInFolder: no such file `" + path + "`");
    gchar *uri = g_filename_to_uri(path.c_str(), nullptr, nullptr);
    std::string u = uri ? uri : "";
    g_free(uri);
    // org.freedesktop.FileManager1 selects the item (Nautilus, Dolphin, Nemo…);
    // without one, open the parent folder.
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
    const gchar *uris[] = {u.c_str(), nullptr};
    GVariant *r = bus ? g_dbus_connection_call_sync(bus, "org.freedesktop.FileManager1", "/org/freedesktop/FileManager1",
                                                    "org.freedesktop.FileManager1", "ShowItems", g_variant_new("(^ass)", uris, ""),
                                                    nullptr, G_DBUS_CALL_FLAGS_NONE, 2000, nullptr, nullptr)
                      : nullptr;
    if (bus) g_object_unref(bus);
    if (r) {
      g_variant_unref(r);
      return c->ok();
    }
    gchar *dir = g_path_get_dirname(path.c_str());
    gchar *duri = g_filename_to_uri(dir, nullptr, nullptr);
    launch_uri(c, duri ? duri : "");
    g_free(duri);
    g_free(dir);
  });
  reg("shell", "trashItem", [](CallPtr c) {
    std::string path = expand_home(c->str("path"));
    if (path.empty()) return c->fail("invalid_args", "shell.trashItem: `path` is required");
    GFile *f = g_file_new_for_path(path.c_str());
    GError *err = nullptr;
    bool ok = g_file_trash(f, nullptr, &err);
    g_object_unref(f);
    if (!ok) return c->fail("invalid_args", "shell.trashItem: " + gerror_message(err, "failed"));
    c->ok();
  });
  reg("shell", "beep", [](CallPtr c) {
    gdk_display_beep(gdk_display_get_default());
    c->ok();
  });
  // GNOME's previewer (Sushi), the one Linux has a known way to ask. It shows one file: the first.
  reg("shell", "previewFile", [](CallPtr c) {
    json paths = !c->args.contains("paths") ? json::array() : c->args["paths"].is_string() ? json::array({c->args["paths"]}) : c->args["paths"];
    if (!paths.is_array() || paths.empty()) return c->fail("invalid_args", "shell.previewFile: `paths` is required");
    std::vector<std::string> files;
    if (!file_paths("shell.previewFile", paths, &files, c)) return;
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
    if (!bus) return c->fail("unavailable", "shell.previewFile: no session bus");
    gchar *uri = g_filename_to_uri(files[0].c_str(), nullptr, nullptr);
    Window *w = find_window(resolve_window(*c));
    GdkWindow *gw = w ? gtk_widget_get_window(w->window) : nullptr;
    gint32 xid = gw && GDK_IS_X11_WINDOW(gw) ? (gint32)GDK_WINDOW_XID(gw) : 0;
    g_dbus_connection_call(bus, "org.gnome.NautilusPreviewer", "/org/gnome/NautilusPreviewer", "org.gnome.NautilusPreviewer", "ShowFile",
                           g_variant_new("(sib)", uri ? uri : "", xid, FALSE), nullptr, G_DBUS_CALL_FLAGS_NONE, 5000, nullptr,
                           [](GObject *src, GAsyncResult *res, gpointer data) {
                             auto *h = static_cast<CallPtr *>(data);
                             GError *err = nullptr;
                             GVariant *v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, &err);
                             if (v) {
                               g_variant_unref(v);
                               (*h)->ok();
                             } else (*h)->fail("unavailable", "shell.previewFile: GNOME's previewer (org.gnome.NautilusPreviewer): " + gerror_message(err, "no reply"));
                             delete h;
                           }, new CallPtr(c));
    g_free(uri);
    g_object_unref(bus);
  });
  reg("shell", "startDrag", start_drag);
}

// ===========================================================================
// theme.* — GtkSettings gtk-application-prefer-dark-theme (+ a *-dark theme name).
// WebKitGTK derives prefers-color-scheme from the same settings.

static bool g_initial_prefer_dark = false;
static std::string g_initial_theme;
static std::string g_last_theme_key;
static std::string g_app_theme = "system";    // theme.set
static std::string g_window_theme = "system"; // the last window.setTheme: over the app's, while it isn't system

static bool ends_with(const std::string &s, const std::string &suffix) {
  return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

static std::string lowercase(std::string s) {
  for (auto &ch : s) ch = (char)g_ascii_tolower(ch);
  return s;
}

static bool settings_dark() {
  gboolean prefer = FALSE;
  gchar *name = nullptr;
  g_object_get(gtk_settings_get_default(), "gtk-application-prefer-dark-theme", &prefer, "gtk-theme-name", &name, nullptr);
  std::string lower = lowercase(name ? name : "");
  g_free(name);
  return prefer || ends_with(lower, "-dark") || ends_with(lower, ":dark");
}

// The app's own appearance, what a window's theme doesn't change (as on macOS and Windows).
bool theme_app_dark() {
  if (g_window_theme == "system") return settings_dark();
  if (g_app_theme != "system") return g_app_theme == "dark";
  std::string lower = lowercase(g_initial_theme);
  return g_initial_prefer_dark || ends_with(lower, "-dark") || ends_with(lower, ":dark");
}

static json theme_info() {
  bool dark = theme_app_dark();
  return json{{"appearance", dark ? "dark" : "light"}, {"dark", dark}};
}

static void on_theme_notify(GObject *, GParamSpec *, gpointer) {
  // GTK writes the settings' variant on every window, after this handler.
  g_idle_add([](gpointer) -> gboolean {
    window_themes_reapply();
    return G_SOURCE_REMOVE;
  }, nullptr);
  json info = theme_info();
  std::string key = info.dump();
  if (key == g_last_theme_key) return;
  g_last_theme_key = key;
  emit("appearanceChanged", info);
}

static void apply_theme_settings() {
  const std::string &a = g_window_theme != "system" ? g_window_theme : g_app_theme;
  GtkSettings *s = gtk_settings_get_default();
  if (a == "system") {
    g_object_set(s, "gtk-theme-name", g_initial_theme.c_str(), "gtk-application-prefer-dark-theme", g_initial_prefer_dark, nullptr);
  } else {
    bool dark = a == "dark";
    std::string theme = g_initial_theme;
    if (!dark && ends_with(lowercase(theme), "-dark")) theme = theme.substr(0, theme.size() - 5); // e.g. Yaru-dark → Yaru
    g_object_set(s, "gtk-theme-name", theme.c_str(), "gtk-application-prefer-dark-theme", dark, nullptr);
  }
}

void theme_window_changed(const std::string &theme) {
  g_window_theme = theme;
  apply_theme_settings();
}

static void register_theme() {
  GtkSettings *s = gtk_settings_get_default();
  gboolean prefer = FALSE;
  gchar *name = nullptr;
  g_object_get(s, "gtk-application-prefer-dark-theme", &prefer, "gtk-theme-name", &name, nullptr);
  g_initial_prefer_dark = prefer;
  g_initial_theme = name ? name : "";
  g_free(name);
  g_last_theme_key = theme_info().dump();
  g_signal_connect(s, "notify::gtk-application-prefer-dark-theme", G_CALLBACK(on_theme_notify), nullptr);
  g_signal_connect(s, "notify::gtk-theme-name", G_CALLBACK(on_theme_notify), nullptr);

  reg_many("theme", {"get", "getAppearance"}, [](CallPtr c) { c->ok(theme_info()); });
  reg_many("theme", {"set", "setAppearance"}, [](CallPtr c) {
    std::string a = c->has("appearance") ? c->str("appearance") : "system";
    // vibrant* are macOS materials; on GTK they mean their light/dark base.
    if (a == "vibrantLight") a = "light";
    if (a == "vibrantDark") a = "dark";
    if (a != "system" && a != "light" && a != "dark")
      return c->fail("invalid_args", "theme.set: appearance must be system|light|dark|vibrantLight|vibrantDark");
    g_app_theme = a;
    apply_theme_settings();
    // With a window's theme over it, the settings don't move: the app's own appearance still does.
    on_theme_notify(nullptr, nullptr, nullptr);
    c->ok(theme_info());
  });
  reg("theme", "shouldUseDarkColors", [](CallPtr c) { c->ok(theme_info()["dark"]); });
}

// ===========================================================================
// diagnostics.info + capabilities.describe

static const char *arch_name() {
#if defined(__aarch64__)
  return "aarch64";
#else
  return "x86_64";
#endif
}

static double uptime_seconds() {
  std::ifstream stat("/proc/self/stat"), up("/proc/uptime");
  std::string s((std::istreambuf_iterator<char>(stat)), {});
  auto close = s.rfind(')');
  if (close == std::string::npos) return 0;
  std::istringstream rest(s.substr(close + 2));
  std::string field;
  unsigned long long start = 0;
  for (int i = 3; i <= 22 && rest >> field; i++)
    if (i == 22) start = std::stoull(field);
  double sys = 0;
  up >> sys;
  double t = sys - (double)start / (double)sysconf(_SC_CLK_TCK);
  return t > 0 ? t : 0;
}

static std::string os_version() {
  std::ifstream f("/etc/os-release");
  std::string line;
  while (std::getline(f, line))
    if (line.rfind("PRETTY_NAME=", 0) == 0) {
      std::string v = line.substr(12);
      if (v.size() >= 2 && v.front() == '"') v = v.substr(1, v.size() - 2);
      return v;
    }
  struct utsname u;
  return uname(&u) == 0 ? std::string(u.sysname) + " " + u.release : "Linux";
}

static void register_diagnostics() {
  reg("diagnostics", "info", [](CallPtr c) {
    char ver[64];
    snprintf(ver, sizeof ver, "%u.%u.%u", webkit_get_major_version(), webkit_get_minor_version(), webkit_get_micro_version());
    struct utsname u;
    uname(&u);
    c->ok(json{{"pid", getpid()},
               {"uptimeSeconds", uptime_seconds()},
               {"os", "linux"},
               {"family", "unix"},
               {"arch", arch_name()},
               {"renderer", "webkitgtk"},
               {"rendererVersion", ver},
               {"osVersion", os_version()},
               {"kernel", u.release},
               {"gtkVersion", std::to_string(gtk_get_major_version()) + "." + std::to_string(gtk_get_minor_version()) + "." +
                                  std::to_string(gtk_get_micro_version())},
               {"display", gdk_display_get_name(gdk_display_get_default())}});
  });
  // Truth table from the live registry; ops whose library/daemon is missing here
  // are "unavailable" (see svc_optional.cc).
  reg("capabilities", "describe", [](CallPtr c) {
    json services = json::object();
    std::set<std::string> down(unavailable_ops().begin(), unavailable_ops().end());
    for (auto &key : registered_ops()) {
      auto dot = key.find('.');
      if (dot == std::string::npos || key.find("._") != std::string::npos) continue; // internal test hooks
      std::string svc = key.substr(0, dot), op = key.substr(dot + 1);
      bool off = down.count(key) || down.count(svc + ".*") || (key == "app.setLoginItem" && !packaged());
      services[svc][op] = off ? "unavailable" : "implemented";
    }
    c->ok(json{{"platform", "linux"}, {"arch", arch_name()}, {"services", services}});
  });
}

// ===========================================================================
// power.* — sleep inhibition over org.freedesktop.ScreenSaver, battery from sysfs.

static std::map<int, guint32> g_inhibits; // our id → ScreenSaver cookie
static int g_next_inhibit = 1;

static void screensaver_call(const char *method, GVariant *params, std::function<void(GVariant *, GError *)> done) {
  GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, nullptr, nullptr);
  if (!bus) {
    GError *e = g_error_new_literal(G_IO_ERROR, G_IO_ERROR_NOT_CONNECTED, "no D-Bus session bus");
    done(nullptr, e);
    g_error_free(e);
    if (params) g_variant_unref(g_variant_ref_sink(params));
    return;
  }
  auto *cb = new std::function<void(GVariant *, GError *)>(std::move(done));
  g_dbus_connection_call(bus, "org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver", method, params,
                         nullptr, G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, [](GObject *src, GAsyncResult *res, gpointer data) {
                           auto *f = static_cast<std::function<void(GVariant *, GError *)> *>(data);
                           GError *err = nullptr;
                           GVariant *v = g_dbus_connection_call_finish(G_DBUS_CONNECTION(src), res, &err);
                           (*f)(v, err);
                           if (v) g_variant_unref(v);
                           if (err) g_error_free(err);
                           delete f;
                         }, cb);
  g_object_unref(bus);
}

static void get_battery(CallPtr c) {
  GDir *dir = g_dir_open("/sys/class/power_supply", 0, nullptr);
  json percent = nullptr;
  bool battery = false, discharging = false, charging = false, ac = false;
  auto read = [](const std::string &p) {
    gchar *s = nullptr;
    std::string out;
    if (g_file_get_contents(p.c_str(), &s, nullptr, nullptr)) out = g_strstrip(s);
    g_free(s);
    return out;
  };
  if (dir) {
    while (const char *name = g_dir_read_name(dir)) {
      std::string base = std::string("/sys/class/power_supply/") + name;
      std::string type = read(base + "/type");
      if (type == "Battery" && read(base + "/scope") != "Device") {
        battery = true;
        std::string cap = read(base + "/capacity"), status = read(base + "/status");
        if (!cap.empty()) percent = std::stoi(cap);
        discharging = discharging || status == "Discharging";
        charging = charging || status == "Charging";
      } else if (type == "Mains" && read(base + "/online") == "1") {
        ac = true;
      }
    }
    g_dir_close(dir);
  }
  c->ok(json{{"percent", percent}, {"charging", charging || (ac && battery && !discharging)}, {"external", !battery || ac || !discharging}});
}

// Idle time: X11's XScreenSaver extension, dlopen()ed like the other optional libraries. Its struct is
// spelled out so that building doesn't need another -dev package; it's the extension's ABI.
struct XssInfo {
  ::Window window;
  int state, kind;
  unsigned long til_or_since, idle, event_mask;
};

static void get_idle_time(CallPtr c) {
  static XssInfo *(*alloc)();
  static int (*query)(Display *, Drawable, XssInfo *);
  static int (*has_extension)(Display *, int *, int *);
  static bool tried = false;
  if (!tried) {
    tried = true;
    if (void *h = dlopen("libXss.so.1", RTLD_NOW | RTLD_LOCAL)) {
      alloc = reinterpret_cast<XssInfo *(*)()>(dlsym(h, "XScreenSaverAllocInfo"));
      query = reinterpret_cast<int (*)(Display *, Drawable, XssInfo *)>(dlsym(h, "XScreenSaverQueryInfo"));
      has_extension = reinterpret_cast<int (*)(Display *, int *, int *)>(dlsym(h, "XScreenSaverQueryExtension"));
    }
  }
  GdkDisplay *display = gdk_display_get_default();
  if (!GDK_IS_X11_DISPLAY(display)) return c->fail("unavailable", "power.getSystemIdleTime: Wayland doesn't tell applications");
  if (!alloc || !query || !has_extension) return c->fail("unavailable", "power.getSystemIdleTime: libXss (libXss.so.1) is not installed");
  Display *dpy = GDK_DISPLAY_XDISPLAY(display);
  int event, error;
  if (!has_extension(dpy, &event, &error)) return c->fail("unavailable", "power.getSystemIdleTime: the X server has no XScreenSaver extension");
  XssInfo *info = alloc();
  bool ok = info && query(dpy, DefaultRootWindow(dpy), info);
  double seconds = ok ? (double)info->idle / 1000 : 0;
  if (info) XFree(info);
  if (!ok) return c->fail("unavailable", "power.getSystemIdleTime: the X server didn't answer");
  c->ok(seconds);
}

// Thermal state from the kernel's trip points, the temperatures a zone's firmware or driver names
// and acts at: an `active` trip turns a fan up (fair), a `passive` trip throttles the CPU (serious),
// `hot` and `critical` are the last warnings before a forced shutdown (critical). Below them all:
// nominal. A zone with no trips says nothing, and no zone with trips → the state isn't known.
static const char *const kThermalDefault = "/sys/class/thermal";

static std::string read_sys(const std::string &path) {
  gchar *text = nullptr;
  std::string out;
  if (g_file_get_contents(path.c_str(), &text, nullptr, nullptr)) out = g_strstrip(text);
  g_free(text);
  return out;
}

static std::string thermal_state() {
  const char *override = getenv("KITOP_THERMAL_DIR"); // the tests' zones: a container has what its host has
  std::string root = override && *override ? override : kThermalDefault;
  GDir *dir = g_dir_open(root.c_str(), 0, nullptr);
  if (!dir) return "";
  int worst = -1;
  while (const char *name = g_dir_read_name(dir)) {
    if (!g_str_has_prefix(name, "thermal_zone")) continue;
    std::string zone = root + "/" + name, temp = read_sys(zone + "/temp");
    if (temp.empty() || read_sys(zone + "/mode") == "disabled") continue; // a sensor that's off can't be read
    long long now = atoll(temp.c_str());
    for (int i = 0;; i++) {
      std::string type = read_sys(zone + "/trip_point_" + std::to_string(i) + "_type"), at = read_sys(zone + "/trip_point_" + std::to_string(i) + "_temp");
      if (type.empty() || at.empty()) break;
      worst = std::max(worst, 0);
      if (now < atoll(at.c_str())) continue;
      worst = std::max(worst, type == "active" ? 1 : type == "passive" ? 2 : type == "hot" || type == "critical" ? 3 : 0);
    }
  }
  g_dir_close(dir);
  static const char *const names[] = {"nominal", "fair", "serious", "critical"};
  return worst < 0 ? "" : names[worst];
}

static void register_power() {
  // The kernel's thermal events need a netlink socket and a privilege: read it now and then.
  static std::string last = thermal_state();
  g_timeout_add_seconds(5, [](gpointer) -> gboolean {
    std::string now = thermal_state();
    if (now != last) {
      last = now;
      emit("thermalStateChanged");
    }
    return G_SOURCE_CONTINUE;
  }, nullptr);
  reg_many("power", {"getThermalState", "thermalState"}, [](CallPtr c) {
    std::string state = thermal_state();
    if (state.empty()) return c->fail("unavailable", "power.getThermalState: no thermal zone with trip points on this machine");
    c->ok(json{{"state", state}});
  });
  reg("power", "getSystemIdleTime", get_idle_time);
  reg("power", "getBattery", get_battery);
  reg("power", "blockSleep", [](CallPtr c) {
    std::string type = c->str("type");
    if (type != "display" && type != "idle" && type != "system")
      return c->fail("invalid_args", "power.blockSleep: `type` must be display|idle|system");
    std::string reason = c->has("reason") ? c->str("reason") : app_name() + " is busy";
    // ScreenSaver.Inhibit blocks idle → screen blank/lock and (in GNOME, KDE,
    // XFCE) idle suspend, so all three types map onto it.
    screensaver_call("Inhibit", g_variant_new("(ss)", app_name().c_str(), reason.c_str()), [c](GVariant *v, GError *e) {
      if (!v) return c->fail("unavailable", std::string("power.blockSleep: org.freedesktop.ScreenSaver: ") + (e ? e->message : "no reply"));
      guint32 cookie = 0;
      g_variant_get(v, "(u)", &cookie);
      int id = g_next_inhibit++;
      g_inhibits[id] = cookie;
      c->ok(json{{"id", id}});
    });
  });
  reg("power", "unblockSleep", [](CallPtr c) {
    int id = (int)c->num("id", -1);
    auto it = g_inhibits.find(id);
    if (it == g_inhibits.end()) return c->fail("invalid_args", "power.unblockSleep: `id` must be an id returned by blockSleep (and not released yet)");
    guint32 cookie = it->second;
    g_inhibits.erase(it);
    screensaver_call("UnInhibit", g_variant_new("(u)", cookie), [c](GVariant *v, GError *e) {
      if (!v) return c->fail("internal", std::string("power.unblockSleep: ") + (e ? e->message : "no reply"));
      c->ok();
    });
  });
}

void register_misc() {
  register_screen();
  register_clipboard();
  register_shell();
  register_theme();
  register_diagnostics();
  register_power();
}

} // namespace lx
} // namespace sd
