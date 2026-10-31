// Platform services of the Android host. Op names, arguments and reply shapes
// follow the desktop backends (native/platform_*.mm) so the same
// @svelte-desktop/shell/platform calls work unchanged; Android-only additions
// are marked. Desktop-shaped services without an Android equivalent answer
// `unsupported` (MainActivity.DESKTOP_ONLY).
package dev.sveltedesktop;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.FileObserver;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class Services {
    private static final String KEY_ALIAS = "svelte-desktop.secureStorage";

    private final MainActivity a;
    private final List<FileObserver> saveObservers = new ArrayList<>();

    Services(MainActivity activity) { a = activity; }

    void register() {
        app();
        clipboard();
        theme();
        shell();
        system();
        dialog();
        notifications();
        secureStorage();
        haptics();
        webview();
        a.sync("events.emit", args -> {
            a.emit("message", new JSONObject().put("channel", args.optString("channel")).put("data", args.opt("data")).put("from", 0));
            return null;
        });
        a.sync("deepLink.getInitialUrls", args -> new JSONArray(a.pendingUrls));
        a.sync("diagnostics.info", args -> new JSONObject().put("pid", android.os.Process.myPid()).put("os", "android").put("renderer", "android.webkit.WebView"));
        a.sync("window.getTitle", args -> String.valueOf(a.getTitle()));
        a.sync("window.setTitle", args -> { a.setTitle(args.optString("title")); return null; });
        a.sync("capabilities.describe", args -> {
            JSONObject services = new JSONObject();
            for (String k : a.ops.keySet()) {
                String[] p = k.split("\\.", 2);
                if (!services.has(p[0])) services.put(p[0], new JSONObject());
                services.getJSONObject(p[0]).put(p[1], "implemented");
            }
            return new JSONObject().put("platform", "android").put("services", services);
        });
    }

    // ------------------------------------------------------------------ app

    private String appName() { return a.meta("sd.appName", a.getPackageName()); }

    private String version() {
        try {
            PackageInfo p = a.getPackageManager().getPackageInfo(a.getPackageName(), 0);
            return p.versionName;
        } catch (Exception e) {
            return "0.0.0";
        }
    }

    private void app() {
        a.sync("app.whenReady", args -> true);
        a.sync("app.getInfo", args -> new JSONObject()
                .put("name", appName())
                .put("version", version())
                .put("identifier", a.meta("sd.identifier", a.getPackageName()))
                .put("appPath", a.getApplicationInfo().sourceDir)
                .put("packaged", true)
                .put("platform", "android")
                .put("arch", Build.SUPPORTED_ABIS[0].startsWith("arm64") ? "arm64" : Build.SUPPORTED_ABIS[0].startsWith("x86_64") ? "x64" : Build.SUPPORTED_ABIS[0]));
        a.sync("app.getName", args -> appName());
        a.sync("app.getVersion", args -> version());
        a.sync("app.getPath", args -> {
            switch (args.optString("name")) {
                case "home": case "userData": case "appData": return a.getFilesDir().getAbsolutePath();
                case "temp": case "caches": case "cache": return a.getCacheDir().getAbsolutePath();
                case "documents": case "downloads": {
                    File d = a.getExternalFilesDir(null);
                    return d == null ? a.getFilesDir().getAbsolutePath() : d.getAbsolutePath();
                }
                case "exe": return new File(a.getApplicationInfo().nativeLibraryDir, "libappserver.so").getAbsolutePath();
                default: throw new MainActivity.OpError("invalid_args", "app.getPath: unknown name `" + args.optString("name") + "`");
            }
        });
        a.sync("app.quit", args -> { a.finishAndRemoveTask(); return null; });
        a.sync("app.getBundleType", args -> new JSONObject().put("type", "app"));
    }

    // ------------------------------------------------------------------ clipboard

    private void clipboard() {
        a.sync("clipboard.readText", args -> {
            ClipboardManager cm = (ClipboardManager) a.getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData c = cm.getPrimaryClip();
            return c == null || c.getItemCount() == 0 ? JSONObject.NULL : String.valueOf(c.getItemAt(0).coerceToText(a));
        });
        a.sync("clipboard.writeText", args -> {
            ClipboardManager cm = (ClipboardManager) a.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("text", args.optString("text")));
            return null;
        });
        a.sync("clipboard.clear", args -> {
            ClipboardManager cm = (ClipboardManager) a.getSystemService(Context.CLIPBOARD_SERVICE);
            if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip();
            else cm.setPrimaryClip(ClipData.newPlainText("", ""));
            return null;
        });
    }

    // ------------------------------------------------------------------ theme

    JSONObject themeInfo() throws Exception {
        boolean dark = (a.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        return new JSONObject().put("appearance", dark ? "dark" : "light").put("dark", dark);
    }

    private void theme() {
        a.sync("theme.get", args -> themeInfo());
        a.sync("theme.getAppearance", args -> themeInfo());
        a.sync("theme.shouldUseDarkColors", args -> themeInfo().getBoolean("dark"));
    }

    // ------------------------------------------------------------------ shell

    private void shell() {
        a.sync("shell.openExternal", args -> {
            Uri u = Uri.parse(args.optString("url"));
            String scheme = String.valueOf(u.getScheme()).toLowerCase();
            if (!(scheme.equals("http") || scheme.equals("https") || scheme.equals("mailto") || scheme.equals("tel") || scheme.equals("sms") || scheme.equals("geo")))
                throw new MainActivity.OpError("invalid_args", "shell.openExternal: only http(s)/mailto/tel/sms/geo URLs");
            a.startActivity(new Intent(Intent.ACTION_VIEW, u));
            return null;
        });
        // Android-only: the system share sheet. {text, title?}
        a.sync("shell.share", args -> {
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, args.optString("text"));
            if (args.has("title")) send.putExtra(Intent.EXTRA_SUBJECT, args.optString("title"));
            a.startActivity(Intent.createChooser(send, args.optString("title", null)));
            return null;
        });
    }

    // ------------------------------------------------------------------ system

    private void system() {
        a.sync("system.info", args -> new JSONObject()
                .put("os", "android").put("family", "android").put("version", Build.VERSION.RELEASE)
                .put("sdk", Build.VERSION.SDK_INT).put("arch", Build.SUPPORTED_ABIS[0]).put("model", Build.MODEL)
                .put("manufacturer", Build.MANUFACTURER));
        // The app's page in Android settings (permissions), or its notification settings.
        a.sync("system.openSettings", args -> {
            Intent i;
            if ("notifications".equals(args.optString("pane")) && Build.VERSION.SDK_INT >= 26)
                i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, a.getPackageName());
            else
                i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + a.getPackageName()));
            a.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return new JSONObject().put("opened", true);
        });
        a.async("system.checkPermission", (args, r) -> r.ok(new JSONObject().put("status", permissionStatus(args.optString("name")))));
        a.async("system.requestPermission", (args, r) -> {
            String p = androidPermission(args.optString("name"));
            if (p == null) throw new MainActivity.OpError("unsupported", "system.requestPermission: `" + args.optString("name") + "` has no Android runtime permission");
            markAsked(p);
            a.requestPermission(p, granted -> {
                try { r.ok(new JSONObject().put("status", granted ? "granted" : "denied")); } catch (Exception ignored) {}
            });
        });
    }

    private static String androidPermission(String name) {
        switch (name) {
            case "camera": return Manifest.permission.CAMERA;
            case "microphone": return Manifest.permission.RECORD_AUDIO;
            case "location": return Manifest.permission.ACCESS_FINE_LOCATION;
            case "contacts": return Manifest.permission.READ_CONTACTS;
            case "calendars": return Manifest.permission.READ_CALENDAR;
            case "notifications": return Build.VERSION.SDK_INT >= 33 ? Manifest.permission.POST_NOTIFICATIONS : null;
            default: return null;
        }
    }

    private String permissionStatus(String name) throws MainActivity.OpError {
        if (name.equals("notifications")) return notificationStatus();
        String p = androidPermission(name);
        if (p == null) throw new MainActivity.OpError("unsupported", "system.checkPermission: `" + name + "` has no Android runtime permission");
        if (a.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) return "granted";
        return asked(p) ? "denied" : "notDetermined";
    }

    private boolean asked(String permission) {
        return a.getSharedPreferences("svelte-desktop.permissions", Context.MODE_PRIVATE).getBoolean(permission, false);
    }

    private void markAsked(String permission) {
        a.getSharedPreferences("svelte-desktop.permissions", Context.MODE_PRIVATE).edit().putBoolean(permission, true).apply();
    }

    // ------------------------------------------------------------------ dialog

    private void dialog() {
        a.async("dialog.showMessageBox", (args, r) -> messageBox(args, r, false));
        a.async("dialog.showConfirm", (args, r) -> messageBox(args, r, true));
        // Picked documents are copied into the cache (content URIs aren't paths) so
        // server code can read them like on desktop; `uris` carries the originals.
        a.async("dialog.showOpenDialog", (args, r) -> {
            boolean dirs = args.optBoolean("directories", false) && !args.optBoolean("files", true);
            Intent i;
            if (dirs) {
                i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            } else {
                i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] mimes = mimeTypes(args.optJSONArray("filters"));
                if (mimes.length > 0) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.optBoolean("multiple", false));
            }
            a.startForResult(i, (code, data) -> {
                List<Uri> uris = new ArrayList<>();
                if (code == Activity.RESULT_OK && data != null) {
                    if (data.getClipData() != null) for (int k = 0; k < data.getClipData().getItemCount(); k++) uris.add(data.getClipData().getItemAt(k).getUri());
                    else if (data.getData() != null) uris.add(data.getData());
                }
                if (uris.isEmpty()) {
                    try { r.ok(new JSONObject().put("canceled", true).put("paths", new JSONArray()).put("uris", new JSONArray())); } catch (Exception ignored) {}
                    return;
                }
                new Thread(() -> {
                    try {
                        JSONArray paths = new JSONArray(), out = new JSONArray();
                        for (Uri u : uris) {
                            out.put(u.toString());
                            if (!dirs) paths.put(copyToCache(u).getAbsolutePath());
                        }
                        r.ok(new JSONObject().put("canceled", false).put("paths", paths).put("uris", out));
                    } catch (Exception e) {
                        r.fail("internal", "dialog.showOpenDialog: " + e.getMessage());
                    }
                }, "dialog-open").start();
            });
        });
        // The reply's `path` is a cache file mirrored into the chosen document each
        // time it is closed after writing, so `Bun.write(path, …)` works as on desktop.
        a.async("dialog.showSaveDialog", (args, r) -> {
            String name = args.optString("suggestedName", "");
            if (name.isEmpty() && args.has("defaultPath")) name = new File(args.optString("defaultPath")).getName();
            if (name.isEmpty()) name = "untitled";
            String[] mimes = mimeTypes(args.optJSONArray("filters"));
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mimes.length == 1 ? mimes[0] : guessMime(name))
                    .putExtra(Intent.EXTRA_TITLE, name);
            final String fileName = name;
            a.startForResult(i, (code, data) -> {
                try {
                    if (code != Activity.RESULT_OK || data == null || data.getData() == null) {
                        r.ok(new JSONObject().put("canceled", true).put("path", JSONObject.NULL));
                        return;
                    }
                    Uri target = data.getData();
                    File dir = new File(a.getCacheDir(), "save/" + UUID.randomUUID());
                    if (!dir.mkdirs()) throw new Exception("cannot create " + dir);
                    File f = new File(dir, fileName);
                    if (!f.createNewFile()) throw new Exception("cannot create " + f);
                    mirror(f, target);
                    r.ok(new JSONObject().put("canceled", false).put("path", f.getAbsolutePath()).put("uri", target.toString()));
                } catch (Exception e) {
                    r.fail("internal", "dialog.showSaveDialog: " + e.getMessage());
                }
            });
        });
    }

    private void messageBox(JSONObject args, MainActivity.Reply r, boolean confirm) {
        JSONArray b = args.optJSONArray("buttons");
        List<String> buttons = new ArrayList<>();
        if (b != null) for (int i = 0; i < b.length(); i++) buttons.add(b.optString(i));
        if (buttons.isEmpty()) { buttons.add("OK"); if (confirm) buttons.add("Cancel"); }
        int cancelId = args.optInt("cancelId", buttons.size() > 1 ? buttons.size() - 1 : -1);
        String message = args.optString("message", args.optString("title", ""));
        String detail = args.optString("detail", "");
        final int[] picked = { cancelId };
        AlertDialog.Builder d = new AlertDialog.Builder(a).setTitle(message);
        if (buttons.size() <= 3) {
            if (!detail.isEmpty()) d.setMessage(detail);
            // Button 0 is the default (positive); then negative, then neutral.
            d.setPositiveButton(buttons.get(0), (x, w) -> picked[0] = 0);
            if (buttons.size() > 1) d.setNegativeButton(buttons.get(1), (x, w) -> picked[0] = 1);
            if (buttons.size() > 2) d.setNeutralButton(buttons.get(2), (x, w) -> picked[0] = 2);
        } else {
            d.setItems(buttons.toArray(new String[0]), (x, w) -> picked[0] = w);
        }
        d.setOnDismissListener(x -> {
            try {
                if (confirm) r.ok(picked[0] == 0);
                else r.ok(new JSONObject().put("response", picked[0]).put("canceled", picked[0] == cancelId));
            } catch (Exception ignored) {}
        });
        d.show();
    }

    private static String guessMime(String name) {
        int dot = name.lastIndexOf('.');
        String m = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
        return m == null ? "application/octet-stream" : m;
    }

    /** filters [{name, extensions:[…]}] → MIME types ("*" or unknown extensions → no filter). */
    private static String[] mimeTypes(JSONArray filters) {
        Set<String> out = new LinkedHashSet<>();
        if (filters == null) return new String[0];
        for (int i = 0; i < filters.length(); i++) {
            JSONArray ext = filters.optJSONObject(i) == null ? null : filters.optJSONObject(i).optJSONArray("extensions");
            if (ext == null) continue;
            for (int k = 0; k < ext.length(); k++) {
                String e = ext.optString(k).replaceFirst("^\\.", "").toLowerCase();
                if (e.equals("*")) return new String[0];
                String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(e);
                if (m == null && (e.equals("md") || e.equals("markdown"))) m = "text/markdown";
                if (m == null) return new String[0]; // can't express it: show everything
                out.add(m);
            }
        }
        return out.toArray(new String[0]);
    }

    private File copyToCache(Uri u) throws Exception {
        String name = "file";
        try (Cursor c = a.getContentResolver().query(u, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) name = c.getString(0);
        }
        File dir = new File(a.getCacheDir(), "picked/" + UUID.randomUUID());
        if (!dir.mkdirs()) throw new Exception("cannot create " + dir);
        File f = new File(dir, name.replace('/', '_'));
        try (InputStream in = a.getContentResolver().openInputStream(u); OutputStream out = new FileOutputStream(f)) {
            if (in == null) throw new Exception("cannot read " + u);
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        }
        return f;
    }

    @SuppressWarnings("deprecation")
    private void mirror(File f, Uri target) {
        FileObserver o = new FileObserver(f.getAbsolutePath(), FileObserver.CLOSE_WRITE) {
            @Override
            public void onEvent(int event, String path) {
                try (InputStream in = new FileInputStream(f); OutputStream out = a.getContentResolver().openOutputStream(target, "wt")) {
                    if (out == null) throw new Exception("cannot write " + target);
                    byte[] buf = new byte[65536];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                } catch (Exception e) {
                    Log.w(MainActivity.TAG, "save mirror " + target, e);
                }
            }
        };
        o.startWatching();
        saveObservers.add(o);
    }

    // ------------------------------------------------------------------ notifications + push

    // The implementation is Notifier.java (shared with NotificationReceiver and the FCM service).
    private NotificationManager nm() { return Notifier.nm(a); }

    private String notificationStatus() {
        if (nm().areNotificationsEnabled()) return "granted";
        if (Build.VERSION.SDK_INT >= 33) return asked(Manifest.permission.POST_NOTIFICATIONS) ? "denied" : "notDetermined";
        return "denied";
    }

    private void notifications() {
        Notifier.init(a);
        MainActivity.SyncOp show = args -> Notifier.show(a, args);
        a.sync("notifications.show", show);
        a.sync("notifications.notify", show);
        MainActivity.SyncOp dismiss = args -> {
            String id = Notifier.str(args, "id");
            if (id == null) id = Notifier.str(args, "tag");
            if (id == null) throw new MainActivity.OpError("invalid_args", "notifications.dismiss: `id` must be a string");
            Notifier.dismiss(a, id);
            return null;
        };
        a.sync("notifications.dismiss", dismiss);
        a.sync("notifications.close", dismiss);
        a.sync("notifications.dismissAll", args -> { Notifier.dismissAll(a); return null; });
        a.sync("notifications.delivered", args -> Notifier.delivered(a));
        a.sync("notifications.pending", args -> Notifier.pending(a));
        a.sync("notifications.claim", args -> Notifier.claim(a));
        a.sync("notifications.responses", args -> Notifier.responses(a));
        // setBadge: not registered → `unsupported` (launchers derive badges from notifications).
        a.sync("notifications.setForeground", args -> {
            Notifier.foregroundDefault = args.has("show") ? args.optBoolean("show", true) : null;
            return null;
        });
        a.sync("notifications.createChannel", args -> { Notifier.createAppChannel(a, args); return null; });
        a.sync("notifications.deleteChannel", args -> {
            String id = Notifier.str(args, "id");
            if (id == null) throw new MainActivity.OpError("invalid_args", "notifications.deleteChannel: `id` must be a string");
            nm().deleteNotificationChannel(id);
            return null;
        });
        a.sync("notifications.channels", args -> Notifier.channels(a));
        a.sync("notifications.getPermissionStatus", args -> new JSONObject().put("status", notificationStatus()));
        a.async("notifications.requestPermission", (args, r) -> {
            if (Build.VERSION.SDK_INT < 33 || nm().areNotificationsEnabled()) { r.ok(new JSONObject().put("status", notificationStatus())); return; }
            markAsked(Manifest.permission.POST_NOTIFICATIONS);
            a.requestPermission(Manifest.permission.POST_NOTIFICATIONS, granted -> {
                try { r.ok(new JSONObject().put("status", granted ? "granted" : "denied")); } catch (Exception ignored) {}
            });
        });

        // Push: Firebase Cloud Messaging when the build has it (push.fcm in desktop.config.ts).
        a.async("push.register", (args, r) -> {
            Notifier.Push p = Notifier.push();
            if (p == null) throw new MainActivity.OpError("unavailable", "push.register: this build has no Firebase Cloud Messaging (set push.fcm.googleServices in desktop.config.ts to your google-services.json)");
            Runnable go = () -> {
                try { p.register(a.getApplicationContext(), r); } catch (Throwable t) { r.fail("unavailable", "push.register: " + t); }
            };
            // Ask for the notification permission first; a refusal still gets a token (data messages).
            if (Build.VERSION.SDK_INT >= 33 && !nm().areNotificationsEnabled()) {
                markAsked(Manifest.permission.POST_NOTIFICATIONS);
                a.requestPermission(Manifest.permission.POST_NOTIFICATIONS, granted -> go.run());
            } else {
                go.run();
            }
        });
        a.async("push.unregister", (args, r) -> {
            Notifier.Push p = Notifier.push();
            if (p == null) { r.ok(null); return; }
            try { p.unregister(a.getApplicationContext(), r); } catch (Throwable t) { r.fail("unavailable", "push.unregister: " + t); }
        });
        a.sync("push.token", args -> {
            JSONObject t = Notifier.push() == null ? null : Notifier.storedToken(a);
            return t == null ? JSONObject.NULL : t;
        });
    }

    // ------------------------------------------------------------------ secure storage

    // Secrets are AES-GCM encrypted with a non-exportable Android Keystore key and
    // stored in private SharedPreferences, keyed by (service, account).
    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return g.generateKey();
    }

    private SharedPreferences vault() { return a.getSharedPreferences("svelte-desktop.secureStorage", Context.MODE_PRIVATE); }

    private static String entry(JSONObject args, String op, boolean needAccount) throws MainActivity.OpError {
        String service = args.optString("service", "");
        String account = args.optString("account", "");
        if (service.isEmpty()) throw new MainActivity.OpError("invalid_args", "secureStorage." + op + ": `service` must be a non-empty string");
        if (needAccount && account.isEmpty()) throw new MainActivity.OpError("invalid_args", "secureStorage." + op + ": `account` must be a non-empty string");
        return service + "\u001f" + account;
    }

    private void secureStorage() {
        a.sync("secureStorage.setPassword", args -> {
            String k = entry(args, "setPassword", true);
            if (!(args.opt("password") instanceof String)) throw new MainActivity.OpError("invalid_args", "secureStorage.setPassword: `password` must be a string");
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(args.getString("password").getBytes(StandardCharsets.UTF_8));
            byte[] blob = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, blob, 0, iv.length);
            System.arraycopy(ct, 0, blob, iv.length, ct.length);
            vault().edit().putString(k, Base64.encodeToString(blob, Base64.NO_WRAP)).apply();
            return null;
        });
        a.sync("secureStorage.getPassword", args -> {
            String stored = vault().getString(entry(args, "getPassword", true), null);
            if (stored == null) return JSONObject.NULL;
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, blob, 0, 12));
            return new String(c.doFinal(blob, 12, blob.length - 12), StandardCharsets.UTF_8);
        });
        // account omitted → every entry of the service.
        a.sync("secureStorage.deletePassword", args -> {
            String k = entry(args, "deletePassword", false);
            SharedPreferences.Editor e = vault().edit();
            if (args.optString("account", "").isEmpty()) {
                for (String name : vault().getAll().keySet()) if (name.startsWith(k)) e.remove(name);
            } else {
                e.remove(k);
            }
            e.apply();
            return null;
        });
        a.async("secureStorage.authenticate", (args, r) -> {
            KeyguardManager km = (KeyguardManager) a.getSystemService(Context.KEYGUARD_SERVICE);
            if (!km.isDeviceSecure()) { r.ok(new JSONObject().put("authenticated", false).put("reason", "no screen lock is set")); return; }
            @SuppressWarnings("deprecation")
            Intent i = km.createConfirmDeviceCredentialIntent(appName(), args.optString("reason", "authenticate to continue"));
            if (i == null) { r.ok(new JSONObject().put("authenticated", false).put("reason", "owner authentication unavailable")); return; }
            a.startForResult(i, (code, data) -> {
                try {
                    if (code == Activity.RESULT_OK) r.ok(new JSONObject().put("authenticated", true));
                    else r.ok(new JSONObject().put("authenticated", false).put("reason", "authentication canceled"));
                } catch (Exception ignored) {}
            });
        });
    }

    // ------------------------------------------------------------------ webview (subset)

    private int nextEval = 1;

    private void webview() {
        // {code} → JSON value; promises are awaited. evaluateJavascript doesn't await,
        // so the result is parked on window and polled.
        a.async("webview.executeJavaScript", (args, r) -> {
            String code = args.optString("code", null);
            if (code == null) throw new MainActivity.OpError("invalid_args", "webview.executeJavaScript: `code` is required");
            String slot = "__sdEval" + (nextEval++);
            String js = "(()=>{const s=" + JSONObject.quote(slot) + ";Promise.resolve().then(()=>(0,eval)(" + JSONObject.quote(code) + "))"
                    + ".then(v=>{window[s]={ok:true,v:v===undefined?null:v};},e=>{window[s]={ok:false,e:String(e&&e.message||e)};});})()";
            a.web.evaluateJavascript(js, ignored -> poll(slot, r, 0));
        });
        a.async("webview.capturePage", (args, r) -> {
            android.view.View v = a.web;
            android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(Math.max(1, v.getWidth()), Math.max(1, v.getHeight()), android.graphics.Bitmap.Config.ARGB_8888);
            v.draw(new android.graphics.Canvas(bmp));
            // Drawing needs the UI thread; encoding doesn't.
            new Thread(() -> {
                try {
                    java.io.ByteArrayOutputStream png = new java.io.ByteArrayOutputStream();
                    bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, png);
                    r.ok(new JSONObject().put("data", Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP)).put("width", bmp.getWidth()).put("height", bmp.getHeight()));
                } catch (Exception e) {
                    r.fail("internal", "webview.capturePage: " + e.getMessage());
                }
            }, "capture").start();
        });
        a.sync("webview.reload", args -> { a.web.reload(); return null; });
        a.sync("webview.getURL", args -> a.web.getUrl());
    }

    private void poll(String slot, MainActivity.Reply r, int attempt) {
        String read = "(()=>{const s=" + JSONObject.quote(slot) + ";const v=window[s];if(!v)return null;delete window[s];return JSON.stringify(v);})()";
        a.web.evaluateJavascript(read, raw -> {
            try {
                // raw is the JSON encoding of the returned string (or "null").
                if (raw == null || raw.equals("null")) {
                    if (attempt > 3000) { r.fail("internal", "webview.executeJavaScript: timed out"); return; }
                    a.web.postDelayed(() -> poll(slot, r, attempt + 1), 10);
                    return;
                }
                JSONObject res = new JSONObject(new org.json.JSONTokener(raw).nextValue().toString());
                if (res.getBoolean("ok")) r.ok(res.opt("v"));
                else r.fail("internal", res.optString("e"));
            } catch (Exception e) {
                r.fail("internal", "webview.executeJavaScript: " + e.getMessage());
            }
        });
    }

    // ------------------------------------------------------------------ haptics (Android-only)

    private void haptics() {
        // {style: "light" | "medium" | "heavy" | "selection" | "success" | "warning" | "error"} → performed
        a.sync("haptics.impact", args -> {
            int fx;
            switch (args.optString("style", "medium")) {
                case "light": case "selection": fx = HapticFeedbackConstants.CLOCK_TICK; break;
                case "heavy": fx = HapticFeedbackConstants.LONG_PRESS; break;
                case "success": fx = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY; break;
                case "warning": case "error": fx = Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS; break;
                default: fx = HapticFeedbackConstants.VIRTUAL_KEY;
            }
            return a.web.performHapticFeedback(fx);
        });
    }
}
