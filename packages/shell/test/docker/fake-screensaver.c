// Minimal org.freedesktop.ScreenSaver for the headless test session (a desktop
// provides the real one): Inhibit / UnInhibit, plus ListInhibitors() → a(uss)
// so tests can verify what libshell registered over D-Bus.
//   gcc fake-screensaver.c $(pkg-config --cflags --libs gio-2.0) -o fake-screensaver
#include <gio/gio.h>

static const char *xml =
    "<node><interface name='org.freedesktop.ScreenSaver'>"
    "<method name='Inhibit'><arg type='s' direction='in'/><arg type='s' direction='in'/><arg type='u' direction='out'/></method>"
    "<method name='UnInhibit'><arg type='u' direction='in'/></method>"
    "<method name='ListInhibitors'><arg type='a(uss)' direction='out'/></method>"
    "</interface></node>";

typedef struct { guint32 cookie; char *app, *reason; } Inhibitor;
static GList *inhibitors;
static guint32 next_cookie = 41;

static void call(GDBusConnection *c, const gchar *sender, const gchar *path, const gchar *iface, const gchar *method,
                 GVariant *params, GDBusMethodInvocation *inv, gpointer data) {
  if (g_str_equal(method, "Inhibit")) {
    Inhibitor *i = g_new0(Inhibitor, 1);
    g_variant_get(params, "(ss)", &i->app, &i->reason);
    i->cookie = next_cookie++;
    inhibitors = g_list_append(inhibitors, i);
    g_dbus_method_invocation_return_value(inv, g_variant_new("(u)", i->cookie));
  } else if (g_str_equal(method, "UnInhibit")) {
    guint32 cookie;
    g_variant_get(params, "(u)", &cookie);
    for (GList *l = inhibitors; l; l = l->next)
      if (((Inhibitor *)l->data)->cookie == cookie) { inhibitors = g_list_delete_link(inhibitors, l); break; }
    g_dbus_method_invocation_return_value(inv, NULL);
  } else {
    GVariantBuilder b;
    g_variant_builder_init(&b, G_VARIANT_TYPE("a(uss)"));
    for (GList *l = inhibitors; l; l = l->next) {
      Inhibitor *i = l->data;
      g_variant_builder_add(&b, "(uss)", i->cookie, i->app, i->reason);
    }
    g_dbus_method_invocation_return_value(inv, g_variant_new("(a(uss))", &b));
  }
}

static void acquired(GDBusConnection *c, const gchar *name, gpointer data) {
  static const GDBusInterfaceVTable vt = {call, NULL, NULL};
  GDBusNodeInfo *info = g_dbus_node_info_new_for_xml(xml, NULL);
  g_dbus_connection_register_object(c, "/org/freedesktop/ScreenSaver", info->interfaces[0], &vt, NULL, NULL, NULL);
}

int main(void) {
  g_bus_own_name(G_BUS_TYPE_SESSION, "org.freedesktop.ScreenSaver", G_BUS_NAME_OWNER_FLAGS_NONE, acquired, NULL, NULL, NULL, NULL);
  g_main_loop_run(g_main_loop_new(NULL, FALSE));
}
