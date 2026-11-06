// A real XDND drop target for the drag-out test (linux-drag-out.ts): a small window that takes
// text/uri-list and prints what it got, one URI per line.
#include <gtk/gtk.h>
#include <stdio.h>

static void on_data(GtkWidget *w, GdkDragContext *ctx, gint x, gint y, GtkSelectionData *data, guint info, guint time, gpointer u) { // GTK_DEST_DEFAULT_ALL finishes the drop
  gchar **uris = gtk_selection_data_get_uris(data);
  for (int i = 0; uris && uris[i]; i++) printf("%s\n", uris[i]);
  fflush(stdout);
  g_strfreev(uris);
}

int main(int argc, char **argv) {
  gtk_init(&argc, &argv);
  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(win), "fake-drop");
  gtk_window_set_default_size(GTK_WINDOW(win), 160, 120);
  gtk_window_move(GTK_WINDOW(win), 10, 10);
  GtkWidget *box = gtk_event_box_new();
  gtk_container_add(GTK_CONTAINER(win), box);
  GtkTargetEntry target = {(gchar *)"text/uri-list", 0, 0};
  gtk_drag_dest_set(box, GTK_DEST_DEFAULT_ALL, &target, 1, GDK_ACTION_COPY);
  g_signal_connect(box, "drag-data-received", G_CALLBACK(on_data), NULL);
  g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
  gtk_widget_show_all(win);
  gtk_main();
  return 0;
}
