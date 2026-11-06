// A real XDND drag source for the file drop tests (linux-web-control.ts): a small window that
// offers the file:// URIs on its command line when dragged with the first mouse button.
#include <gtk/gtk.h>

static char **g_uris;

static void on_get(GtkWidget *w, GdkDragContext *ctx, GtkSelectionData *data, guint info, guint time, gpointer u) {
  gtk_selection_data_set_uris(data, g_uris);
}

int main(int argc, char **argv) {
  gtk_init(&argc, &argv);
  g_uris = argv + 1;
  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(win), "fake-drag");
  gtk_window_set_default_size(GTK_WINDOW(win), 160, 120);
  gtk_window_move(GTK_WINDOW(win), 10, 10);
  GtkWidget *box = gtk_event_box_new();
  gtk_container_add(GTK_CONTAINER(win), box);
  GtkTargetEntry target = {(gchar *)"text/uri-list", 0, 0};
  gtk_drag_source_set(box, GDK_BUTTON1_MASK, &target, 1, GDK_ACTION_COPY);
  g_signal_connect(box, "drag-data-get", G_CALLBACK(on_get), NULL);
  g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
  gtk_widget_show_all(win);
  gtk_main();
  return 0;
}
