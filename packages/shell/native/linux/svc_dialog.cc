// dialog.* — message boxes (GtkMessageDialog) and file choosers
// (GtkFileChooserNative: the xdg-desktop-portal dialog when a portal is running,
// GTK's own otherwise). All asynchronous: the reply arrives when the user
// answers; nothing blocks the GTK loop. Transient for the calling window.
//
// dialog.sheet {route, width?, height?, style?, top?, title?} → {result}: a route of the app in a
// transient modal window, its page alone (window.__desktopView, X-Desktop-View), shown once loaded.
// `close {result?}` from that page ends it; Escape cancels (result null). Only its parent is blocked.
// style "sheet" (default): a borderless dialog, centered on the parent. "attached": borderless, its
// top under the title bar or `top` px down the content. "window": a titled dialog, centered, whose
// close button cancels. The window manager has the last word on all of this, on Wayland the only one.
//
// dialog._test (internal, like webview._test on macOS): inspect / answer the open
// dialog without synthetic input — {action:"state"|"respond"|"cancel"}.
#include <map>

#include "linux.hpp"

namespace sd {
namespace lx {

static GtkWidget *g_message = nullptr;               // open message box
static GtkFileChooserNative *g_chooser = nullptr;    // open file chooser
static CallPtr g_chooser_call;

static GtkWindow *parent_for(const Call &c) {
  Window *w = find_window(resolve_window(c));
  return w && gtk_widget_get_visible(w->window) ? GTK_WINDOW(w->window) : nullptr;
}

static void message_box(CallPtr c, bool confirm) {
  std::string type = c->str("type");
  GtkMessageType mt = (type == "critical" || type == "error") ? GTK_MESSAGE_ERROR : type == "warning" ? GTK_MESSAGE_WARNING
                                                                                  : type == "question" ? GTK_MESSAGE_QUESTION
                                                                                                       : GTK_MESSAGE_INFO;
  std::string text = c->has("message") ? c->str("message") : c->str("title");
  GtkWidget *d = gtk_message_dialog_new(parent_for(*c), GTK_DIALOG_DESTROY_WITH_PARENT, mt, GTK_BUTTONS_NONE, "%s", text.c_str());
  if (c->has("message") && c->has("title")) gtk_window_set_title(GTK_WINDOW(d), c->str("title").c_str());
  if (c->has("detail")) gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(d), "%s", c->str("detail").c_str());
  json buttons = c->args.contains("buttons") && c->args["buttons"].is_array() ? c->args["buttons"]
                 : confirm ? json::array({"OK", "Cancel"}) : json::array({"OK"});
  int i = 0;
  for (auto &b : buttons) gtk_dialog_add_button(GTK_DIALOG(d), b.is_string() ? b.get<std::string>().c_str() : b.dump().c_str(), i++);
  int n = (int)buttons.size();
  int cancelId = (int)c->num("cancelId", n > 1 ? n - 1 : -1);
  if (n > 0) gtk_dialog_set_default_response(GTK_DIALOG(d), 0);
  struct Ctx {
    CallPtr c;
    bool confirm;
    int cancelId;
  };
  g_signal_connect_data(d, "response", G_CALLBACK(+[](GtkDialog *dlg, gint response, gpointer data) {
    auto *x = static_cast<Ctx *>(data);
    // Escape / window close → the cancel button (or the first one).
    int r = response >= 0 ? response : (x->cancelId >= 0 ? x->cancelId : 0);
    if (x->confirm) x->c->ok(r == 0);
    else x->c->ok(json{{"response", r}, {"canceled", r == x->cancelId}});
    if (g_message == GTK_WIDGET(dlg)) g_message = nullptr;
    gtk_widget_destroy(GTK_WIDGET(dlg));
  }), new Ctx{c, confirm, cancelId}, [](gpointer data, GClosure *) { delete static_cast<Ctx *>(data); }, (GConnectFlags)0);
  g_message = d;
  gtk_window_present(GTK_WINDOW(d));
}

static void add_filters(GtkFileChooser *fc, const json &filters) {
  if (!filters.is_array()) return;
  for (auto &f : filters) {
    if (!f.is_object() || !f.contains("extensions") || !f["extensions"].is_array()) continue;
    GtkFileFilter *ff = gtk_file_filter_new();
    gtk_file_filter_set_name(ff, f.value("name", std::string("Files")).c_str());
    bool all = false;
    for (auto &e : f["extensions"]) {
      if (!e.is_string()) continue;
      std::string ext = e.get<std::string>();
      if (ext == "*") all = true;
      std::string lower = ext, upper = ext;
      for (auto &ch : lower) ch = (char)g_ascii_tolower(ch);
      for (auto &ch : upper) ch = (char)g_ascii_toupper(ch);
      gtk_file_filter_add_pattern(ff, ("*." + lower).c_str());
      if (upper != lower) gtk_file_filter_add_pattern(ff, ("*." + upper).c_str());
    }
    if (all) { // "all files" disables filtering
      g_object_unref(g_object_ref_sink(ff));
      return;
    }
    gtk_file_chooser_add_filter(fc, ff);
  }
}

static std::string expand(const std::string &p) {
  return p.rfind("~/", 0) == 0 ? std::string(g_get_home_dir()) + p.substr(1) : p;
}

static void run_chooser(CallPtr c, GtkFileChooserNative *n, bool save) {
  if (g_chooser) { // one at a time, like a sheet
    g_object_unref(n);
    return c->fail("unavailable", "dialog: another file dialog is already open");
  }
  g_chooser = n;
  g_chooser_call = c;
  g_signal_connect(n, "response", G_CALLBACK(+[](GtkNativeDialog *d, gint response, gpointer save_flag) {
    CallPtr call = g_chooser_call;
    g_chooser_call.reset();
    g_chooser = nullptr;
    bool ok = response == GTK_RESPONSE_ACCEPT;
    if (GPOINTER_TO_INT(save_flag)) {
      gchar *f = ok ? gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(d)) : nullptr;
      call->ok(json{{"canceled", !f}, {"path", f ? json(f) : json(nullptr)}});
      g_free(f);
    } else {
      json paths = json::array();
      if (ok) {
        GSList *list = gtk_file_chooser_get_filenames(GTK_FILE_CHOOSER(d));
        for (GSList *l = list; l; l = l->next) {
          paths.push_back((const char *)l->data);
          g_free(l->data);
        }
        g_slist_free(list);
      }
      call->ok(json{{"canceled", !ok || paths.empty()}, {"paths", paths}});
    }
    g_object_unref(d);
  }), GINT_TO_POINTER(save ? 1 : 0));
  gtk_native_dialog_show(GTK_NATIVE_DIALOG(n));
}

// ---------------------------------------------------------------------------
// Sheets with a route of the app

struct Sheet {
  int nativeId = 0, parent = 0;
  CallPtr call;
  GtkWidget *window = nullptr;
  WebKitWebView *wv = nullptr;
  bool presented = false, done = false, attached = false, titled = false;
  double top = -1;
};
static std::map<int, Sheet *> g_sheets;
static int g_next_sheet = 3000;

static Sheet *sheet_of(gpointer id) {
  auto it = g_sheets.find(GPOINTER_TO_INT(id));
  return it == g_sheets.end() ? nullptr : it->second;
}

static void present_sheet(Sheet *s) {
  if (s->presented || s->done) return;
  s->presented = true;
  Window *parent = find_window(s->parent);
  if (parent && s->attached) {
    int width = 0, height = 0;
    gtk_window_get_size(GTK_WINDOW(s->window), &width, &height);
    GdkRectangle content = content_rect(parent);
    gtk_window_move(GTK_WINDOW(s->window), content.x + (content.width - width) / 2, content.y + (s->top >= 0 ? (int)s->top : 0));
  }
  gtk_widget_show(s->window);
  gtk_window_present(GTK_WINDOW(s->window));
  gtk_widget_grab_focus(GTK_WIDGET(s->wv));
  // Loaded out of sight, the page's autofocus didn't take.
  webkit_web_view_evaluate_javascript(s->wv, "document.querySelector('[autofocus]')?.focus()", -1, nullptr, nullptr, nullptr, nullptr, nullptr);
}

static gboolean sheet_teardown(gpointer id) {
  Sheet *s = sheet_of(id);
  if (!s) return G_SOURCE_REMOVE;
  if (s->window) gtk_widget_destroy(s->window);
  Window *parent = find_window(s->parent);
  g_sheets.erase(s->nativeId);
  if (parent && gtk_widget_get_visible(parent->window)) gtk_window_present(GTK_WINDOW(parent->window));
  delete s;
  return G_SOURCE_REMOVE;
}

static void finish_sheet(Sheet *s, const json &result) {
  if (s->done) return;
  s->done = true;
  s->call->ok(json{{"result", result}});
  // After this turn: `close` comes from the sheet's own page, its web view still in that call.
  g_idle_add(sheet_teardown, GINT_TO_POINTER(s->nativeId));
}

static void on_sheet_load(WebKitWebView *, WebKitLoadEvent ev, gpointer id) {
  if (ev != WEBKIT_LOAD_FINISHED) return;
  // A frame later, painted.
  g_timeout_add(30, [](gpointer id) -> gboolean {
    if (Sheet *s = sheet_of(id)) present_sheet(s);
    return G_SOURCE_REMOVE;
  }, id);
}

static gboolean on_sheet_failed(WebKitWebView *, WebKitLoadEvent, gchar *, GError *, gpointer id) {
  if (Sheet *s = sheet_of(id)) present_sheet(s);
  return FALSE;
}

static void on_sheet_title(GObject *wv, GParamSpec *, gpointer id) {
  Sheet *s = sheet_of(id);
  const char *title = webkit_web_view_get_title(WEBKIT_WEB_VIEW(wv));
  if (s && !s->titled && s->window) gtk_window_set_title(GTK_WINDOW(s->window), title ? title : "");
}

// The titled style's close button, or the window manager's way to close it: canceled.
static gboolean on_sheet_delete(GtkWidget *, GdkEvent *, gpointer id) {
  if (Sheet *s = sheet_of(id)) finish_sheet(s, nullptr);
  return TRUE;
}

// Before the page has it, as a cancel key on macOS.
static gboolean on_sheet_key(GtkWidget *, GdkEventKey *event, gpointer id) {
  Sheet *s = sheet_of(id);
  if (!s || !s->presented || event->keyval != GDK_KEY_Escape) return FALSE;
  finish_sheet(s, nullptr);
  return TRUE;
}

// The parent can go first (destroy-with-parent): the opener gets its answer all the same.
static void on_sheet_destroy(GtkWidget *, gpointer id) {
  Sheet *s = sheet_of(id);
  if (!s) return;
  s->window = nullptr;
  detach_webview(s->nativeId);
  finish_sheet(s, nullptr);
}

void sheets_window_closing(int window) {
  for (auto it = g_sheets.begin(); it != g_sheets.end();) {
    Sheet *s = (it++)->second;
    if (s->parent == window && s->window) gtk_widget_destroy(s->window); // answers its opener
  }
}

static void open_sheet(CallPtr c) {
  std::string route = c->str("route"), origin = app_origin();
  if (route.empty() || origin.empty()) return c->fail("invalid_args", "dialog.sheet: `route` is required");
  std::string style = c->str("style", "sheet");
  auto *s = new Sheet;
  s->nativeId = g_next_sheet++;
  s->call = c;
  s->attached = style == "attached";
  s->top = c->has("top") ? c->num("top") : -1;
  GtkWindow *parent = parent_for(*c);
  s->parent = parent ? resolve_window(*c) : 0;
  std::string ident = "sheet-" + std::to_string(s->nativeId);
  gpointer id = GINT_TO_POINTER(s->nativeId);
  Window *from = find_window(s->parent ? s->parent : primary_window());
  s->wv = make_webview(s->nativeId, false, "window.__desktopView=" + json(ident).dump() + ";", from ? webkit_web_view_get_context(from->webview) : nullptr);
  gtk_widget_show(GTK_WIDGET(s->wv));

  s->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  GtkWindow *win = GTK_WINDOW(s->window);
  gtk_window_set_default_size(win, (int)c->num("width", 440), (int)c->num("height", 280));
  gtk_window_set_type_hint(win, GDK_WINDOW_TYPE_HINT_DIALOG);
  gtk_window_set_skip_taskbar_hint(win, TRUE);
  gtk_window_set_skip_pager_hint(win, TRUE);
  gtk_window_set_resizable(win, FALSE);
  if (style != "window") gtk_window_set_decorated(win, FALSE);
  if (c->has("title")) {
    gtk_window_set_title(win, c->str("title").c_str());
    s->titled = true;
  }
  if (parent) {
    gtk_window_set_transient_for(win, parent);
    gtk_window_set_destroy_with_parent(win, TRUE);
    gtk_window_set_modal(win, TRUE);
    // A modal window blocks its group. The app's other windows aren't this one's business.
    if (!gtk_window_has_group(parent)) {
      GtkWindowGroup *group = gtk_window_group_new();
      gtk_window_group_add_window(group, parent);
      g_object_unref(group);
    }
    gtk_window_group_add_window(gtk_window_get_group(parent), win);
  }
  gtk_window_set_position(win, parent ? GTK_WIN_POS_CENTER_ON_PARENT : GTK_WIN_POS_CENTER);
  gtk_container_add(GTK_CONTAINER(s->window), GTK_WIDGET(s->wv));
  g_sheets[s->nativeId] = s;
  g_signal_connect(s->wv, "load-changed", G_CALLBACK(on_sheet_load), id);
  g_signal_connect(s->wv, "load-failed", G_CALLBACK(on_sheet_failed), id);
  g_signal_connect(s->wv, "notify::title", G_CALLBACK(on_sheet_title), id);
  g_signal_connect(s->window, "delete-event", G_CALLBACK(on_sheet_delete), id);
  g_signal_connect(s->window, "key-press-event", G_CALLBACK(on_sheet_key), id);
  g_signal_connect(s->window, "destroy", G_CALLBACK(on_sheet_destroy), id);
  session_load(s->wv, origin + (route[0] == '/' ? route : "/" + route), ident);
  g_timeout_add(1500, [](gpointer id) -> gboolean {
    if (Sheet *s = sheet_of(id)) present_sheet(s);
    return G_SOURCE_REMOVE;
  }, id);
}

void register_dialog() {
  reg("dialog", "sheet", open_sheet);
  reg("dialog", "close", [](CallPtr c) {
    auto it = g_sheets.find(c->caller);
    if (it == g_sheets.end()) return c->fail("invalid_args", "dialog.close: not called from a sheet's page");
    finish_sheet(it->second, c->args.contains("result") ? c->args["result"] : json(nullptr));
    c->ok();
  });
  reg("dialog", "showMessageBox", [](CallPtr c) { message_box(c, false); });
  reg("dialog", "showConfirm", [](CallPtr c) { message_box(c, true); });
  reg("dialog", "showOpenDialog", [](CallPtr c) {
    bool files = c->flag("files", true), dirs = c->flag("directories", false);
    GtkFileChooserAction action = dirs && !files ? GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER : GTK_FILE_CHOOSER_ACTION_OPEN;
    std::string title = c->has("title") ? c->str("title") : (dirs && !files ? "Choose a folder" : "Open");
    GtkFileChooserNative *n = gtk_file_chooser_native_new(title.c_str(), parent_for(*c), action,
                                                          c->has("prompt") ? c->str("prompt").c_str() : nullptr, nullptr);
    GtkFileChooser *fc = GTK_FILE_CHOOSER(n);
    gtk_file_chooser_set_select_multiple(fc, c->flag("multiple", false));
    if (c->has("defaultPath")) gtk_file_chooser_set_current_folder(fc, expand(c->str("defaultPath")).c_str());
    add_filters(fc, c->args.value("filters", json()));
    run_chooser(c, n, false);
  });
  reg("dialog", "showSaveDialog", [](CallPtr c) {
    GtkFileChooserNative *n = gtk_file_chooser_native_new(c->has("title") ? c->str("title").c_str() : "Save", parent_for(*c),
                                                          GTK_FILE_CHOOSER_ACTION_SAVE, nullptr, nullptr);
    GtkFileChooser *fc = GTK_FILE_CHOOSER(n);
    gtk_file_chooser_set_do_overwrite_confirmation(fc, TRUE);
    std::string def = expand(c->str("defaultPath"));
    if (!def.empty() && g_file_test(def.c_str(), G_FILE_TEST_IS_DIR)) {
      gtk_file_chooser_set_current_folder(fc, def.c_str());
    } else if (!def.empty()) {
      gchar *dir = g_path_get_dirname(def.c_str()), *base = g_path_get_basename(def.c_str());
      gtk_file_chooser_set_current_folder(fc, dir);
      gtk_file_chooser_set_current_name(fc, base);
      g_free(dir);
      g_free(base);
    }
    if (c->has("suggestedName")) gtk_file_chooser_set_current_name(fc, c->str("suggestedName").c_str());
    add_filters(fc, c->args.value("filters", json()));
    run_chooser(c, n, true);
  });
  reg("dialog", "_test", [](CallPtr c) {
    std::string action = c->str("action");
    if (action == "state") {
      json m = nullptr;
      if (g_message) {
        GtkWidget *area = gtk_message_dialog_get_message_area(GTK_MESSAGE_DIALOG(g_message));
        json labels = json::array();
        GList *kids = gtk_container_get_children(GTK_CONTAINER(area));
        for (GList *l = kids; l; l = l->next)
          if (GTK_IS_LABEL(l->data)) labels.push_back(gtk_label_get_text(GTK_LABEL(l->data)));
        g_list_free(kids);
        GtkWindow *parent = gtk_window_get_transient_for(GTK_WINDOW(g_message));
        m = json{{"labels", labels}, {"transient", parent != nullptr}};
      }
      json f = g_chooser ? json{{"title", gtk_native_dialog_get_title(GTK_NATIVE_DIALOG(g_chooser))},
                                {"action", (int)gtk_file_chooser_get_action(GTK_FILE_CHOOSER(g_chooser))},
                                {"multiple", (bool)gtk_file_chooser_get_select_multiple(GTK_FILE_CHOOSER(g_chooser))}}
                         : json(nullptr);
      return c->ok(json{{"message", m}, {"file", f}});
    }
    if (action == "respond" && g_message) {
      gtk_dialog_response(GTK_DIALOG(g_message), (int)c->num("response", 0));
      return c->ok(true);
    }
    if (action == "cancel" && g_chooser) {
      // A native chooser can't be answered programmatically; hide it and
      // deliver what a cancel delivers.
      gtk_native_dialog_hide(GTK_NATIVE_DIALOG(g_chooser));
      g_signal_emit_by_name(g_chooser, "response", GTK_RESPONSE_CANCEL);
      return c->ok(true);
    }
    c->ok(false);
  });
}

void dialog_legacy(int request_id, const json &o) {
  std::string kind = o.value("kind", "open");
  json args = json::object(), req;
  auto copy = [&](const char *from, const char *to) {
    if (o.contains(from)) args[to] = o[from];
  };
  if (o.contains("extensions") && o["extensions"].is_array()) args["filters"] = json::array({json{{"name", "Files"}, {"extensions", o["extensions"]}}});
  copy("title", "title");
  copy("defaultPath", "defaultPath");
  if (kind == "message") {
    copy("message", "message");
    copy("detail", "detail");
    copy("style", "type");
    copy("buttons", "buttons");
    req = json{{"service", "dialog"}, {"op", "showMessageBox"}, {"args", args}};
  } else if (kind == "save") {
    copy("defaultName", "suggestedName");
    req = json{{"service", "dialog"}, {"op", "showSaveDialog"}, {"args", args}};
  } else {
    copy("multiple", "multiple");
    copy("directories", "directories");
    copy("files", "files");
    req = json{{"service", "dialog"}, {"op", "showOpenDialog"}, {"args", args}};
  }
  dispatch(req, 0, [request_id, kind](const json &r) {
    json ev{{"type", "dialog"}, {"requestId", request_id}};
    json v = r.value("value", json::object());
    if (kind == "message") ev["button"] = v.value("response", 0);
    else {
      ev["canceled"] = v.value("canceled", true);
      if (kind == "save") ev["paths"] = v.contains("path") && v["path"].is_string() ? json::array({v["path"]}) : json::array();
      else ev["paths"] = v.value("paths", json::array());
    }
    emit_raw(ev);
  });
}

} // namespace lx
} // namespace sd
