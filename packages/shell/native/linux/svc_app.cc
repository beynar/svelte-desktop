// app.* — identity, XDG paths, lifecycle, single instance, login item (autostart),
// About dialog. Events: willQuit, willRestart, secondInstance.
// macOS-only ops (Dock badge/bounce/progress, activation policy, recent
// documents, hideOthers/showAll) are not registered → `unsupported`.
#include <fcntl.h>
#include <gio/gunixsocketaddress.h>
#include <sys/file.h>
#include <unistd.h>

#include <fstream>
#include <sstream>

#include "linux.hpp"

namespace sd {
namespace lx {

static const char *arch_name() {
#if defined(__aarch64__)
  return "arm64";
#else
  return "x64";
#endif
}

static std::string env_or(const char *k, const std::string &fallback) {
  const char *v = getenv(k);
  return v && *v == '/' ? v : fallback;
}

static std::string get_path(const std::string &name) {
  std::string home = g_get_home_dir();
  std::string data = g_get_user_data_dir();
  std::string state = env_or("XDG_STATE_HOME", home + "/.local/state");
  std::string id = app_identifier();
  // Same layout as src/os.ts appDirs (the TS runtime writes logs there).
  if (name == "home") return home;
  if (name == "appPath") return exe_dir();
  if (name == "exe" || name == "module") return exe_path();
  if (name == "temp") return g_get_tmp_dir();
  if (name == "appData") return data;
  if (name == "userData") return data + "/" + id;
  if (name == "logs") return state + "/" + id + "/logs";
  if (name == "caches") return std::string(g_get_user_cache_dir()) + "/" + id;
  if (name == "documents") return user_dir(G_USER_DIRECTORY_DOCUMENTS, "Documents");
  if (name == "downloads") return user_dir(G_USER_DIRECTORY_DOWNLOAD, "Downloads");
  if (name == "desktop") return user_dir(G_USER_DIRECTORY_DESKTOP, "Desktop");
  if (name == "music") return user_dir(G_USER_DIRECTORY_MUSIC, "Music");
  if (name == "pictures") return user_dir(G_USER_DIRECTORY_PICTURES, "Pictures");
  if (name == "videos") return user_dir(G_USER_DIRECTORY_VIDEOS, "Videos");
  return "";
}

/// What a relaunch / autostart entry should execute: the AppImage when running
/// from one, else this executable.
static std::string launch_target() {
  const char *appimage = getenv("APPIMAGE");
  return appimage && *appimage ? appimage : exe_path();
}

static json own_argv() {
  json argv = json::array();
  std::ifstream f("/proc/self/cmdline", std::ios::binary);
  std::string arg;
  while (std::getline(f, arg, '\0')) argv.push_back(arg);
  return argv;
}

// ---------------------------------------------------------------------------
// Single instance: flock on <caches>/instance.lock. The holder listens on a unix
// socket next to it; later instances send {argv, cwd} there → `secondInstance`.

static int g_lock_fd = -1;
static GSocketService *g_instance_service = nullptr;

static gboolean on_instance_connection(GSocketService *, GSocketConnection *conn, GObject *, gpointer) {
  GInputStream *in = g_io_stream_get_input_stream(G_IO_STREAM(conn));
  std::string body;
  char buf[4096];
  for (int i = 0; i < 256; i++) { // ≤1 MB
    gssize n = g_input_stream_read(in, buf, sizeof buf, nullptr, nullptr);
    if (n <= 0) break;
    body.append(buf, (size_t)n);
  }
  json msg = json::parse(body, nullptr, false);
  if (msg.is_object())
    emit("secondInstance", json{{"argv", msg.value("argv", json::array())}, {"cwd", msg.value("cwd", std::string())}});
  return FALSE;
}

static void request_single_instance(CallPtr c) {
  if (g_lock_fd >= 0) return c->ok(json{{"acquired", true}});
  std::string dir = get_path("caches");
  g_mkdir_with_parents(dir.c_str(), 0700);
  std::string lock = dir + "/instance.lock", sock = dir + "/instance.sock";
  int fd = open(lock.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) return c->fail("internal", "cannot open " + lock);
  gchar *cwd = g_get_current_dir();
  std::string here = cwd;
  g_free(cwd);
  if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
    g_lock_fd = fd;
    unlink(sock.c_str()); // stale socket of a crashed holder (we hold the lock now)
    g_instance_service = g_socket_service_new();
    GSocketAddress *addr = g_unix_socket_address_new(sock.c_str());
    GError *err = nullptr;
    if (!g_socket_listener_add_address(G_SOCKET_LISTENER(g_instance_service), addr, G_SOCKET_TYPE_STREAM, G_SOCKET_PROTOCOL_DEFAULT,
                                       nullptr, nullptr, &err)) {
      g_warning("[shell] single instance socket: %s", err->message);
      g_clear_error(&err);
    }
    g_object_unref(addr);
    g_signal_connect(g_instance_service, "incoming", G_CALLBACK(on_instance_connection), nullptr);
    g_socket_service_start(g_instance_service);
    return c->ok(json{{"acquired", true}});
  }
  close(fd);
  // Tell the holder (best effort), then report that we didn't get the lock.
  GSocketClient *client = g_socket_client_new();
  GSocketAddress *addr = g_unix_socket_address_new(sock.c_str());
  GSocketConnection *conn = g_socket_client_connect(client, G_SOCKET_CONNECTABLE(addr), nullptr, nullptr);
  if (conn) {
    std::string msg = json{{"argv", own_argv()}, {"cwd", here}}.dump();
    g_output_stream_write_all(g_io_stream_get_output_stream(G_IO_STREAM(conn)), msg.data(), msg.size(), nullptr, nullptr, nullptr);
    g_io_stream_close(G_IO_STREAM(conn), nullptr, nullptr);
    g_object_unref(conn);
  }
  g_object_unref(addr);
  g_object_unref(client);
  c->ok(json{{"acquired", false}});
}

// ---------------------------------------------------------------------------

static void set_login_item(CallPtr c) {
  if (!packaged()) return c->fail("unavailable", "app.setLoginItem needs the packaged app (an app directory or AppImage)");
  std::string dir = std::string(g_get_user_config_dir()) + "/autostart";
  std::string file = dir + "/" + app_identifier() + ".desktop";
  bool want = c->flag("enabled", true);
  if (want) {
    g_mkdir_with_parents(dir.c_str(), 0700);
    gchar *quoted = g_shell_quote(launch_target().c_str());
    std::ostringstream s;
    s << "[Desktop Entry]\nType=Application\nName=" << app_name() << "\nExec=" << quoted << "\nX-GNOME-Autostart-enabled=true\n";
    g_free(quoted);
    GError *err = nullptr;
    if (!g_file_set_contents(file.c_str(), s.str().c_str(), -1, &err)) {
      std::string m = err->message;
      g_clear_error(&err);
      return c->fail("internal", "app.setLoginItem: " + m);
    }
  } else {
    unlink(file.c_str());
  }
  c->ok(json{{"enabled", g_file_test(file.c_str(), G_FILE_TEST_EXISTS) == TRUE}});
}

static std::string icon_file() {
  std::string p = exe_dir() + "/" + app_identifier() + ".png";
  return g_file_test(p.c_str(), G_FILE_TEST_EXISTS) ? p : "";
}

void register_app() {
  reg("app", "whenReady", [](CallPtr c) { c->ok(true); });
  reg("app", "getInfo", [](CallPtr c) {
    bool pkg = packaged();
    c->ok(json{{"name", app_name()},
               {"version", app_version()},
               {"identifier", app_identifier()},
               {"appPath", pkg ? json(exe_dir()) : json(nullptr)},
               {"packaged", pkg},
               {"platform", "linux"},
               {"arch", arch_name()}});
  });
  reg("app", "getName", [](CallPtr c) { c->ok(app_name()); });
  reg("app", "getVersion", [](CallPtr c) { c->ok(app_version()); });
  reg("app", "getPath", [](CallPtr c) {
    std::string name = c->str("name"), p = name.empty() ? "" : get_path(name);
    if (p.empty()) return c->fail("invalid_args", "app.getPath: unknown name `" + name + "`");
    c->ok(p);
  });
  reg("app", "setName", [](CallPtr c) {
    std::string name = c->str("name");
    if (name.empty()) return c->fail("invalid_args", "app.setName: `name` is required");
    set_app_name_override(name);
    c->ok();
  });
  reg("app", "setIdentity", [](CallPtr c) {
    std::string id = c->str("identifier");
    if (id.empty()) return c->fail("invalid_args", "app.setIdentity: `identifier` is required");
    set_app_identifier_override(id);
    if (c->has("name")) set_app_name_override(c->str("name"));
    c->ok();
  });
  reg("app", "quit", [](CallPtr c) {
    emit("willQuit");
    c->ok();
    request_quit();
  });
  reg("app", "relaunch", [](CallPtr c) {
    emit("willRestart");
    // A detached shell waits for this pid to exit, then starts a fresh copy.
    std::string cmd = "while kill -0 " + std::to_string(getpid()) + " 2>/dev/null; do sleep 0.1; done; \"$0\" &";
    std::string target = launch_target();
    const char *argv[] = {"/bin/sh", "-c", cmd.c_str(), target.c_str(), nullptr};
    GError *err = nullptr;
    if (!g_spawn_async(nullptr, (char **)argv, nullptr, G_SPAWN_DEFAULT, nullptr, nullptr, nullptr, &err)) {
      std::string m = err->message;
      g_clear_error(&err);
      return c->fail("internal", m);
    }
    c->ok();
    request_quit();
  });
  reg("app", "exit", [](CallPtr c) { exit((int)c->num("code", 0)); });
  reg("app", "hide", [](CallPtr c) {
    for (int id : window_ids()) gtk_widget_hide(find_window(id)->window);
    c->ok();
  });
  reg_many("app", {"show", "activate"}, [](CallPtr c) {
    for (int id : window_ids()) {
      Window *w = find_window(id);
      if (!w->visible && !gtk_widget_get_visible(w->window)) continue; // never-shown hidden windows stay hidden
      gtk_widget_show(w->window);
      gtk_window_present(GTK_WINDOW(w->window));
    }
    c->ok();
  });
  reg("app", "requestSingleInstanceLock", request_single_instance);
  reg("app", "setLoginItem", set_login_item);
  reg("app", "getBundleType", [](CallPtr c) { c->ok(json{{"type", packaged() ? "app" : "binary"}}); });
  reg("app", "defaultWindowIcon", [](CallPtr c) {
    std::string f = icon_file();
    gchar *data = nullptr;
    gsize len = 0;
    if (f.empty() || !g_file_get_contents(f.c_str(), &data, &len, nullptr)) return c->ok(nullptr);
    std::string b64 = base64_encode((const unsigned char *)data, len);
    g_free(data);
    c->ok(json{{"pngBase64", b64}});
  });
  reg("app", "aboutPanel", [](CallPtr c) {
    GtkWidget *d = gtk_about_dialog_new();
    GtkAboutDialog *a = GTK_ABOUT_DIALOG(d);
    gtk_about_dialog_set_program_name(a, (c->has("name") ? c->str("name") : app_name()).c_str());
    gtk_about_dialog_set_version(a, (c->has("version") ? c->str("version") : app_version()).c_str());
    if (c->has("copyright")) gtk_about_dialog_set_copyright(a, c->str("copyright").c_str());
    if (c->has("credits")) gtk_about_dialog_set_comments(a, c->str("credits").c_str());
    std::string icon = icon_file();
    if (!icon.empty())
      if (GdkPixbuf *pb = gdk_pixbuf_new_from_file_at_size(icon.c_str(), 128, 128, nullptr)) {
        gtk_about_dialog_set_logo(a, pb);
        g_object_unref(pb);
      }
    g_signal_connect(d, "response", G_CALLBACK(gtk_widget_destroy), nullptr);
    gtk_widget_show(d);
    c->ok();
  });
}

} // namespace lx
} // namespace sd
