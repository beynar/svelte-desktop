// dialog.* — message boxes (GtkMessageDialog) and file choosers
// (GtkFileChooserNative: the xdg-desktop-portal dialog when a portal is running,
// GTK's own otherwise). All asynchronous: the reply arrives when the user
// answers; nothing blocks the GTK loop. Transient for the calling window.
//
// dialog._test (internal, like webview._test on macOS): inspect / answer the open
// dialog without synthetic input — {action:"state"|"respond"|"cancel"}.
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

void register_dialog() {
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
