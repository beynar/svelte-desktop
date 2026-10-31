// Scriptable org.freedesktop.Notifications for the e2e (linux-notifications-fake.ts):
// records every Notify / CloseNotification as a JSON line in $FAKE_NOTIFY_LOG
// (default /tmp/fake-notify.log) and plays the user on demand through a second
// interface on the same object:
//   dev.svelte_desktop.FakeNotifications.Invoke(u id, s action) → ActionInvoked
//   dev.svelte_desktop.FakeNotifications.Close(u id, u reason)  → NotificationClosed
//   gcc fake-notifications.c $(pkg-config --cflags --libs gio-2.0) -o fake-notifications
#include <gio/gio.h>
#include <stdio.h>
#include <stdlib.h>

static const char *xml =
    "<node><interface name='org.freedesktop.Notifications'>"
    "<method name='GetCapabilities'><arg type='as' direction='out'/></method>"
    "<method name='Notify'><arg type='s' direction='in'/><arg type='u' direction='in'/><arg type='s' direction='in'/>"
    "<arg type='s' direction='in'/><arg type='s' direction='in'/><arg type='as' direction='in'/><arg type='a{sv}' direction='in'/>"
    "<arg type='i' direction='in'/><arg type='u' direction='out'/></method>"
    "<method name='CloseNotification'><arg type='u' direction='in'/></method>"
    "<method name='GetServerInformation'><arg type='s' direction='out'/><arg type='s' direction='out'/>"
    "<arg type='s' direction='out'/><arg type='s' direction='out'/></method>"
    "<signal name='NotificationClosed'><arg type='u'/><arg type='u'/></signal>"
    "<signal name='ActionInvoked'><arg type='u'/><arg type='s'/></signal>"
    "</interface><interface name='dev.svelte_desktop.FakeNotifications'>"
    "<method name='Invoke'><arg type='u' direction='in'/><arg type='s' direction='in'/></method>"
    "<method name='Close'><arg type='u' direction='in'/><arg type='u' direction='in'/></method>"
    "</interface></node>";

static guint32 next_id = 1;
static const char *log_path;

static void json_str(GString *out, const char *s) {
  g_string_append_c(out, '"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') g_string_append_printf(out, "\\%c", *p);
    else if (*p < 0x20) g_string_append_printf(out, "\\u%04x", *p);
    else g_string_append_c(out, (char)*p);
  }
  g_string_append_c(out, '"');
}

static void json_variant(GString *out, GVariant *v) {
  if (g_variant_is_of_type(v, G_VARIANT_TYPE_STRING)) json_str(out, g_variant_get_string(v, NULL));
  else if (g_variant_is_of_type(v, G_VARIANT_TYPE_BOOLEAN)) g_string_append(out, g_variant_get_boolean(v) ? "true" : "false");
  else if (g_variant_is_of_type(v, G_VARIANT_TYPE_BYTE)) g_string_append_printf(out, "%u", g_variant_get_byte(v));
  else if (g_variant_is_of_type(v, G_VARIANT_TYPE_INT32)) g_string_append_printf(out, "%d", g_variant_get_int32(v));
  else if (g_variant_is_of_type(v, G_VARIANT_TYPE_UINT32)) g_string_append_printf(out, "%u", g_variant_get_uint32(v));
  else {
    gchar *p = g_variant_print(v, TRUE);
    json_str(out, p);
    g_free(p);
  }
}

static void record(GString *line) {
  FILE *f = fopen(log_path, "a");
  if (!f) return;
  fprintf(f, "%s\n", line->str);
  fclose(f);
}

static void call(GDBusConnection *c, const gchar *sender, const gchar *path, const gchar *iface, const gchar *method,
                 GVariant *params, GDBusMethodInvocation *inv, gpointer data) {
  if (g_str_equal(method, "GetCapabilities")) {
    const char *caps[] = {"actions", "body", "body-markup", "persistence", "sound", NULL};
    g_dbus_method_invocation_return_value(inv, g_variant_new("(^as)", caps));
  } else if (g_str_equal(method, "GetServerInformation")) {
    g_dbus_method_invocation_return_value(inv, g_variant_new("(ssss)", "fake-notifications", "svelte-desktop", "1.0", "1.2"));
  } else if (g_str_equal(method, "Notify")) {
    const char *app, *icon, *summary, *body;
    guint32 replaces;
    gint32 timeout;
    GVariant *actions, *hints;
    g_variant_get(params, "(&su&s&s&s@as@a{sv}i)", &app, &replaces, &icon, &summary, &body, &actions, &hints, &timeout);
    guint32 id = replaces ? replaces : next_id++;
    GString *l = g_string_new("{\"op\":\"notify\",\"id\":");
    g_string_append_printf(l, "%u,\"replaces\":%u,\"timeout\":%d,\"app\":", id, replaces, timeout);
    json_str(l, app);
    g_string_append(l, ",\"icon\":");
    json_str(l, icon);
    g_string_append(l, ",\"summary\":");
    json_str(l, summary);
    g_string_append(l, ",\"body\":");
    json_str(l, body);
    g_string_append(l, ",\"actions\":[");
    GVariantIter it;
    const char *a;
    gboolean first = TRUE;
    g_variant_iter_init(&it, actions);
    while (g_variant_iter_next(&it, "&s", &a)) {
      if (!first) g_string_append_c(l, ',');
      json_str(l, a);
      first = FALSE;
    }
    g_string_append(l, "],\"hints\":{");
    const char *k;
    GVariant *v;
    first = TRUE;
    g_variant_iter_init(&it, hints);
    while (g_variant_iter_next(&it, "{&sv}", &k, &v)) {
      if (!first) g_string_append_c(l, ',');
      json_str(l, k);
      g_string_append_c(l, ':');
      json_variant(l, v);
      g_variant_unref(v);
      first = FALSE;
    }
    g_string_append(l, "}}");
    record(l);
    g_string_free(l, TRUE);
    g_variant_unref(actions);
    g_variant_unref(hints);
    g_dbus_method_invocation_return_value(inv, g_variant_new("(u)", id));
  } else if (g_str_equal(method, "CloseNotification")) {
    guint32 id;
    g_variant_get(params, "(u)", &id);
    GString *l = g_string_new(NULL);
    g_string_printf(l, "{\"op\":\"close\",\"id\":%u}", id);
    record(l);
    g_string_free(l, TRUE);
    g_dbus_connection_emit_signal(c, NULL, path, "org.freedesktop.Notifications", "NotificationClosed", g_variant_new("(uu)", id, 3), NULL);
    g_dbus_method_invocation_return_value(inv, NULL);
  } else if (g_str_equal(method, "Invoke")) {
    guint32 id;
    const char *action;
    g_variant_get(params, "(u&s)", &id, &action);
    g_dbus_connection_emit_signal(c, NULL, path, "org.freedesktop.Notifications", "ActionInvoked", g_variant_new("(us)", id, action), NULL);
    g_dbus_method_invocation_return_value(inv, NULL);
  } else { // Close
    guint32 id, reason;
    g_variant_get(params, "(uu)", &id, &reason);
    g_dbus_connection_emit_signal(c, NULL, path, "org.freedesktop.Notifications", "NotificationClosed", g_variant_new("(uu)", id, reason), NULL);
    g_dbus_method_invocation_return_value(inv, NULL);
  }
}

static const GDBusInterfaceVTable vtable = {call, NULL, NULL, {0}};

static void on_bus(GDBusConnection *c, const gchar *name, gpointer data) {
  GDBusNodeInfo *info = g_dbus_node_info_new_for_xml(xml, NULL);
  for (int i = 0; info->interfaces[i]; i++)
    g_dbus_connection_register_object(c, "/org/freedesktop/Notifications", info->interfaces[i], &vtable, NULL, NULL, NULL);
}

static void on_lost(GDBusConnection *c, const gchar *name, gpointer data) {
  fprintf(stderr, "fake-notifications: lost %s\n", name);
  exit(1);
}

int main(void) {
  log_path = g_getenv("FAKE_NOTIFY_LOG") ? g_getenv("FAKE_NOTIFY_LOG") : "/tmp/fake-notify.log";
  g_bus_own_name(G_BUS_TYPE_SESSION, "org.freedesktop.Notifications", G_BUS_NAME_OWNER_FLAGS_REPLACE, on_bus, NULL, on_lost, NULL, NULL);
  g_main_loop_run(g_main_loop_new(NULL, FALSE));
}
