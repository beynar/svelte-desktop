// A stand-in for xdg-desktop-portal in the Wayland suite (linux-portal.ts), following the real request and
// response protocol: a call answers with the Request path built from the caller's handle_token, and the
// result comes later as that object's Response signal, to the caller only. It's not a portal: no dialog,
// no permission store. Every call goes as a JSON line to $FAKE_PORTAL_LOG (default /tmp/fake-portal.log).
//   org.freedesktop.portal.GlobalShortcuts, Screenshot (version properties), org.freedesktop.portal.Session,
//   org.freedesktop.host.portal.Registry
//   dev.kitop.FakePortal.SetResponse(u) · Drop(s id): what the user would answer, one left out of a bind
//   dev.kitop.FakePortal.Press(o session, s id) · Release(o session, s id): the user's key
// With --previewer it's GNOME's previewer instead: org.gnome.NautilusPreviewer.ShowFile(s uri, i xid, b close).
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <gio/gio.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static const char *xml =
    "<node>"
    "<interface name='org.freedesktop.portal.GlobalShortcuts'>"
    "<method name='CreateSession'><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>"
    "<method name='BindShortcuts'><arg type='o' direction='in'/><arg type='a(sa{sv})' direction='in'/><arg type='s' direction='in'/>"
    "<arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>"
    "<signal name='Activated'><arg type='o'/><arg type='s'/><arg type='t'/><arg type='a{sv}'/></signal>"
    "<signal name='Deactivated'><arg type='o'/><arg type='s'/><arg type='t'/><arg type='a{sv}'/></signal>"
    "<property name='version' type='u' access='read'/>"
    "</interface>"
    "<interface name='org.freedesktop.portal.Screenshot'>"
    "<method name='Screenshot'><arg type='s' direction='in'/><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>"
    "<property name='version' type='u' access='read'/>"
    "</interface>"
    "<interface name='org.freedesktop.host.portal.Registry'>"
    "<method name='Register'><arg type='s' direction='in'/><arg type='a{sv}' direction='in'/></method>"
    "</interface>"
    "<interface name='dev.kitop.FakePortal'>"
    "<method name='SetResponse'><arg type='u' direction='in'/></method>"
    "<method name='Drop'><arg type='s' direction='in'/></method>"
    "<method name='Press'><arg type='o' direction='in'/><arg type='s' direction='in'/></method>"
    "<method name='Release'><arg type='o' direction='in'/><arg type='s' direction='in'/></method>"
    "</interface>"
    "</node>";
static const char *session_xml = "<node><interface name='org.freedesktop.portal.Session'><method name='Close'/></interface></node>";
static const char *previewer_xml =
    "<node><interface name='org.gnome.NautilusPreviewer'><method name='ShowFile'><arg type='s' direction='in'/><arg type='i' direction='in'/><arg type='b' direction='in'/></method>"
    "</interface></node>";

static const char *log_path;
static guint32 next_response = 0;
static char *dropped;
static GDBusNodeInfo *session_info;
static GHashTable *owners; // session → its caller

static void log_line(const char *method, GVariant *params, const char *sender) {
  gchar *printed = params ? g_variant_print(params, FALSE) : g_strdup("");
  GString *line = g_string_new(NULL);
  g_string_append_printf(line, "{\"method\":\"%s\",\"sender\":\"%s\",\"params\":\"", method, sender);
  for (const char *p = printed; *p; p++) {
    if (*p == '"' || *p == '\\') g_string_append_c(line, '\\');
    g_string_append_c(line, *p);
  }
  g_string_append(line, "\"}\n");
  FILE *f = fopen(log_path, "a");
  if (f) {
    fputs(line->str, f);
    fclose(f);
  }
  g_string_free(line, TRUE);
  g_free(printed);
}

static char *request_path(const char *sender, GVariant *options) {
  const char *token = NULL;
  g_variant_lookup(options, "handle_token", "&s", &token);
  gchar *who = g_strdup(sender + 1);
  g_strdelimit(who, ".", '_');
  char *path = g_strdup_printf("/org/freedesktop/portal/desktop/request/%s/%s", who, token ? token : "none");
  g_free(who);
  return path;
}

struct Answer {
  GDBusConnection *bus;
  char *sender, *path;
  guint32 response;
  GVariant *results;
};

static gboolean send_answer(gpointer data) {
  struct Answer *a = data;
  g_dbus_connection_emit_signal(a->bus, a->sender, a->path, "org.freedesktop.portal.Request", "Response", g_variant_new("(u@a{sv})", a->response, a->results), NULL);
  g_free(a->sender);
  g_free(a->path);
  g_free(a);
  return G_SOURCE_REMOVE;
}

// The method's reply first: the answer is a signal, a moment later.
static void answer_later(GDBusConnection *bus, GDBusMethodInvocation *inv, const char *sender, GVariant *options, guint32 response, GVariant *results) {
  struct Answer *a = g_new0(struct Answer, 1);
  a->bus = bus;
  a->sender = g_strdup(sender);
  a->path = request_path(sender, options);
  a->response = response;
  a->results = g_variant_ref_sink(results);
  g_dbus_method_invocation_return_value(inv, g_variant_new("(o)", a->path));
  g_timeout_add(100, send_answer, a);
}

static void session_call(GDBusConnection *bus, const gchar *sender, const gchar *path, const gchar *iface, const gchar *method, GVariant *params, GDBusMethodInvocation *inv, gpointer reg) {
  log_line("Session.Close", g_variant_new("(s)", path), sender);
  g_hash_table_remove(owners, path); // a closed session's keys are dead, even if asked to press them
  g_dbus_method_invocation_return_value(inv, NULL);
  g_dbus_connection_unregister_object(bus, *(guint *)reg);
}
static const GDBusInterfaceVTable session_vtable = {session_call};

static void portal_call(GDBusConnection *bus, const gchar *sender, const gchar *path, const gchar *iface, const gchar *method, GVariant *params, GDBusMethodInvocation *inv, gpointer data) {
  if (g_str_equal(iface, "dev.kitop.FakePortal")) {
    if (g_str_equal(method, "SetResponse")) g_variant_get(params, "(u)", &next_response);
    else if (g_str_equal(method, "Drop")) {
      g_free(dropped);
      g_variant_get(params, "(s)", &dropped);
    } else {
      const char *session, *id;
      g_variant_get(params, "(&o&s)", &session, &id);
      const char *owner = g_hash_table_lookup(owners, session);
      if (owner) g_dbus_connection_emit_signal(bus, owner, path, "org.freedesktop.portal.GlobalShortcuts", g_str_equal(method, "Press") ? "Activated" : "Deactivated",
                                               g_variant_new("(ost@a{sv})", session, id, (guint64)1234, g_variant_new_array(G_VARIANT_TYPE("{sv}"), NULL, 0)), NULL);
    }
    return g_dbus_method_invocation_return_value(inv, NULL);
  }
  log_line(method, params, sender);
  GVariantBuilder r;
  g_variant_builder_init(&r, G_VARIANT_TYPE("a{sv}"));
  if (g_str_equal(method, "Register")) return g_dbus_method_invocation_return_value(inv, NULL);
  if (g_str_equal(method, "CreateSession")) {
    GVariant *options = g_variant_get_child_value(params, 0);
    const char *token = NULL;
    g_variant_lookup(options, "session_handle_token", "&s", &token);
    gchar *who = g_strdup(sender + 1);
    g_strdelimit(who, ".", '_');
    char *handle = g_strdup_printf("/org/freedesktop/portal/desktop/session/%s/%s", who, token ? token : "none");
    g_free(who);
    if (next_response == 0) {
      guint *reg = g_new0(guint, 1);
      *reg = g_dbus_connection_register_object(bus, handle, session_info->interfaces[0], &session_vtable, reg, NULL, NULL);
      g_hash_table_insert(owners, g_strdup(handle), g_strdup(sender));
      g_variant_builder_add(&r, "{sv}", "session_handle", g_variant_new_string(handle));
    }
    answer_later(bus, inv, sender, options, 0, g_variant_builder_end(&r));
    g_free(handle);
    g_variant_unref(options);
  } else if (g_str_equal(method, "BindShortcuts")) {
    GVariant *options = g_variant_get_child_value(params, 3), *list = g_variant_get_child_value(params, 1);
    GVariantBuilder bound;
    g_variant_builder_init(&bound, G_VARIANT_TYPE("a(sa{sv})"));
    GVariantIter it;
    g_variant_iter_init(&it, list);
    GVariant *entry;
    while ((entry = g_variant_iter_next_value(&it))) {
      const char *id;
      g_variant_get_child(entry, 0, "&s", &id);
      if (!dropped || !g_str_equal(dropped, id)) g_variant_builder_add_value(&bound, entry);
      g_variant_unref(entry);
    }
    g_variant_builder_add(&r, "{sv}", "shortcuts", g_variant_builder_end(&bound));
    answer_later(bus, inv, sender, options, next_response, g_variant_builder_end(&r));
    g_variant_unref(options);
    g_variant_unref(list);
  } else if (g_str_equal(method, "Screenshot")) {
    GVariant *options = g_variant_get_child_value(params, 1);
    if (next_response == 0) {
      // A real picture in a real file, which the portal leaves to the app.
      static int n = 0;
      char *file = g_strdup_printf("/tmp/fake-portal-shot-%d-%d.png", (int)getpid(), n++);
      GdkPixbuf *image = gdk_pixbuf_new(GDK_COLORSPACE_RGB, FALSE, 8, 64, 48);
      gdk_pixbuf_fill(image, 0xff0000ff);
      gdk_pixbuf_save(image, file, "png", NULL, NULL);
      g_object_unref(image);
      char *uri = g_filename_to_uri(file, NULL, NULL);
      g_variant_builder_add(&r, "{sv}", "uri", g_variant_new_string(uri));
      g_free(uri);
      g_free(file);
    }
    answer_later(bus, inv, sender, options, next_response, g_variant_builder_end(&r));
    g_variant_unref(options);
  }
}

static GVariant *portal_get(GDBusConnection *bus, const gchar *sender, const gchar *path, const gchar *iface, const gchar *prop, GError **error, gpointer data) {
  return g_variant_new_uint32(g_str_equal(iface, "org.freedesktop.portal.Screenshot") ? 2 : 1);
}

static const GDBusInterfaceVTable portal_vtable = {portal_call, portal_get};

static void previewer_call(GDBusConnection *bus, const gchar *sender, const gchar *path, const gchar *iface, const gchar *method, GVariant *params, GDBusMethodInvocation *inv, gpointer data) {
  log_line(method, params, sender);
  g_dbus_method_invocation_return_value(inv, NULL);
}
static const GDBusInterfaceVTable previewer_vtable = {previewer_call};

static void on_bus(GDBusConnection *bus, const gchar *name, gpointer data) {
  gboolean previewer = GPOINTER_TO_INT(data);
  GDBusNodeInfo *info = g_dbus_node_info_new_for_xml(previewer ? previewer_xml : xml, NULL);
  if (previewer) g_dbus_connection_register_object(bus, "/org/gnome/NautilusPreviewer", info->interfaces[0], &previewer_vtable, NULL, NULL, NULL);
  else
    for (int i = 0; info->interfaces[i]; i++) g_dbus_connection_register_object(bus, "/org/freedesktop/portal/desktop", info->interfaces[i], &portal_vtable, NULL, NULL, NULL);
}

int main(int argc, char **argv) {
  gboolean previewer = argc > 1 && g_str_equal(argv[1], "--previewer");
  log_path = g_getenv("FAKE_PORTAL_LOG");
  if (!log_path) log_path = "/tmp/fake-portal.log";
  owners = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  session_info = g_dbus_node_info_new_for_xml(session_xml, NULL);
  g_bus_own_name(G_BUS_TYPE_SESSION, previewer ? "org.gnome.NautilusPreviewer" : "org.freedesktop.portal.Desktop", G_BUS_NAME_OWNER_FLAGS_NONE, on_bus, NULL, NULL, GINT_TO_POINTER(previewer), NULL);
  g_main_loop_run(g_main_loop_new(NULL, FALSE));
  return 0;
}
