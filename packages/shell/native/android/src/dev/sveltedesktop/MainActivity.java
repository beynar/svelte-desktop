// Android host for a svelte-desktop app: spawns the compiled Bun server
// (lib/<abi>/libappserver.so, extracted to nativeLibraryDir which may execute),
// points a WebView at the loopback gate, and answers platform calls with the
// same wire format as the desktop shells: {id, service, op, args} → platformResult.
//   page   → a WebMessagePort posted to the app origin's main frame after each
//            load (postWebMessage with a target origin: other frames never see it)
//   server → the server's stdout (`SVELTE_DESKTOP_RPC {…}` lines); results and
//            events go back on its stdin. Server calls aren't permission-checked,
//            as on desktop.
// The services themselves live in Services.java.
package dev.sveltedesktop;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowInsets;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

public class MainActivity extends Activity {
    static final String TAG = "SvelteDesktop";
    WebView web;
    private Process server;
    private OutputStream serverIn;
    private WebMessagePort pagePort;
    volatile String origin = "";
    final Map<String, Op> ops = new TreeMap<>();
    private Services services;

    /** A reply, sent once: ok(value) or fail(code, message). */
    interface Reply {
        void ok(Object value);
        void fail(String code, String message);
    }

    /** Synchronous ops return their value (or throw OpError); async ops answer through the Reply. */
    interface Op { void call(JSONObject args, Reply reply) throws Exception; }
    interface SyncOp { Object call(JSONObject args) throws Exception; }

    static class OpError extends Exception {
        final String code;
        OpError(String code, String message) { super(message); this.code = code; }
    }

    void sync(String name, SyncOp op) { ops.put(name, (a, r) -> r.ok(op.call(a))); }
    void async(String name, Op op) { ops.put(name, op); }

    // Services that only make sense on desktop answer `unsupported`, not `unknown`.
    private static final String[] DESKTOP_ONLY = { "menu", "tray", "popover", "dock", "shortcuts", "view", "capture", "webview", "screen", "power", "windows", "plugins" };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageReady = false; // until the new document's bridge says ready
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                if (!origin.isEmpty() && originOf(url).equals(origin)) connectPage();
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (originOf(u.toString()).equals(origin)) return false; // the app stays in the WebView
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                Log.w(TAG, "web process gone, recreating the activity");
                recreate();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // getUserMedia: the app origin only, after the matching runtime permission
            // (declared from usageDescriptions.camera / .microphone).
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (!originOf(request.getOrigin().toString()).equals(origin)) { request.deny(); return; }
                List<String> wanted = new ArrayList<>();
                for (String res : request.getResources()) {
                    if (res.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) wanted.add(android.Manifest.permission.CAMERA);
                    else if (res.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) wanted.add(android.Manifest.permission.RECORD_AUDIO);
                    else { request.deny(); return; }
                }
                grantAll(wanted, 0, ok -> { if (ok) request.grant(request.getResources()); else request.deny(); });
            }
            // <input type=file>
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                try {
                    startForResult(params.createIntent(), (code, data) -> callback.onReceiveValue(FileChooserParams.parseResult(code, data)));
                } catch (Exception e) {
                    callback.onReceiveValue(null);
                }
                return true;
            }
        });
        web.loadData("<html><body style='background:#fff'></body></html>", "text/html", "utf-8");

        // targetSdk 35 draws edge to edge. A WebView ignores its own padding, so a
        // container keeps the page clear of the system bars, the cutout and the keyboard.
        FrameLayout root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(b.left, b.top, b.right, b.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(root);

        Notifier.live = this;
        services = new Services(this);
        services.register();
        NativePlugins.init(this);
        startServer();
        handleIntent(getIntent());
    }

    // Back walks the page history first, like a browser; at the first page it leaves the app.
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        Notifier.resumed = true;
    }

    @Override
    protected void onPause() {
        Notifier.resumed = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (Notifier.live == this) Notifier.live = null;
        if (server != null) server.destroy();
        serverWriter.shutdownNow();
        if (pagePort != null) pagePort.close();
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        try { emit("appearanceChanged", services.themeInfo()); } catch (Exception ignored) {}
    }

    // ---------------------------------------------------------------- intents

    // Deep links (intent filters from `schemes`) → `openUrls {urls}`, as on desktop.
    // Notification taps and actions → Notifier (→ deliverResponse, or the claim queue).
    final List<String> pendingUrls = new ArrayList<>();
    /** The current document's bridge has connected (its `ready`): responses can go to it live. */
    private boolean pageReady;

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        // Reopened from Recents: the original intent comes back — not a new tap.
        boolean history = (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        if (!history && Notifier.fromIntent(this, intent)) {
            // handled: live to the page, or queued for notifications.claim
        } else if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            pendingUrls.add(intent.getData().toString());
        }
        flushPending();
    }

    private void flushPending() {
        if (origin.isEmpty()) return;
        try {
            if (!pendingUrls.isEmpty()) emit("openUrls", new JSONObject().put("urls", new JSONArray(pendingUrls)));
        } catch (Exception ignored) {}
        pendingUrls.clear();
    }

    /** A notification response (UI thread): always to server code; to the page with `target: true`
     *  when one is loaded (it then counts as claimed). false → the caller queues it for `claim`. */
    boolean deliverResponse(JSONObject r) {
        try { toServer(new JSONObject().put("t", "platform").put("name", "notificationResponse").put("data", r)); } catch (Exception ignored) {}
        if (!pageReady || pagePort == null) return false;
        try {
            deliverPage("notificationResponse", new JSONObject(r.toString()).put("target", true));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ---------------------------------------------------------------- activity results

    interface ResultCallback { void done(int resultCode, Intent data); }
    interface PermissionCallback { void done(boolean granted); }
    private final Map<Integer, ResultCallback> results = new HashMap<>();
    private final Map<Integer, PermissionCallback> permissionResults = new HashMap<>();
    private int nextRequest = 100;

    void startForResult(Intent intent, ResultCallback cb) {
        int code = nextRequest++;
        results.put(code, cb);
        startActivityForResult(intent, code);
    }

    void requestPermission(String permission, PermissionCallback cb) {
        if (Build.VERSION.SDK_INT < 23 || checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) { cb.done(true); return; }
        int code = nextRequest++;
        permissionResults.put(code, cb);
        requestPermissions(new String[] { permission }, code);
    }

    private void grantAll(List<String> permissions, int i, PermissionCallback cb) {
        if (i >= permissions.size()) { cb.done(true); return; }
        requestPermission(permissions.get(i), ok -> { if (ok) grantAll(permissions, i + 1, cb); else cb.done(false); });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        ResultCallback cb = results.remove(requestCode);
        if (cb != null) cb.done(resultCode, data);
        else super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grants) {
        PermissionCallback cb = permissionResults.remove(requestCode);
        if (cb != null) cb.done(grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED);
    }

    // ---------------------------------------------------------------- server

    private void startServer() {
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        StringBuilder secret = new StringBuilder();
        for (byte x : b) secret.append(String.format("%02x", x));
        File exe = new File(getApplicationInfo().nativeLibraryDir, "libappserver.so");
        try {
            ProcessBuilder pb = new ProcessBuilder(exe.getAbsolutePath());
            Map<String, String> env = pb.environment();
            env.put("SVELTE_DESKTOP_SECRET", secret.toString());
            env.put("SVELTE_DESKTOP_ANDROID_HOST", "1");
            env.put("HOME", getFilesDir().getAbsolutePath());
            env.put("TMPDIR", getCacheDir().getAbsolutePath());
            // appDirs() uses the Linux layout on Android: data/cache/logs inside the app sandbox.
            env.put("XDG_DATA_HOME", getFilesDir().getAbsolutePath());
            env.put("XDG_STATE_HOME", getFilesDir().getAbsolutePath());
            env.put("XDG_CACHE_HOME", getCacheDir().getAbsolutePath());
            // E2E (`launch({ android })` from @svelte-desktop/shell/test): debuggable builds
            // only. The server then accepts the runner on /__desktop/test?t=<token> (adb forward).
            String test = getIntent() == null ? null : getIntent().getStringExtra("dev.sveltedesktop.test");
            if (test != null && (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0 && test.matches("listen:[0-9a-f]{32,128}"))
                env.put("SVELTE_DESKTOP_TEST_LISTEN", test.substring(7));
            pb.redirectErrorStream(true);
            server = pb.start();
            serverIn = server.getOutputStream();
        } catch (Exception e) {
            Log.e(TAG, "cannot start the app server " + exe, e);
            return;
        }
        new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(server.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    if (line.startsWith("SVELTE_DESKTOP_RPC ")) {
                        String body = line.substring(19);
                        runOnUiThread(() -> handleServer(body));
                    } else if (line.startsWith("SVELTE_DESKTOP_ANDROID_READY ")) {
                        JSONObject ready = new JSONObject(line.substring(29));
                        String auth = ready.getString("auth");
                        String o = ready.getString("origin");
                        runOnUiThread(() -> {
                            origin = o;
                            web.loadUrl(auth);
                            flushPending();
                        });
                        Log.i(TAG, "server ready at " + o);
                    } else {
                        Log.i(TAG, "[server] " + line);
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "server output", e);
            }
            Log.w(TAG, "app server exited");
        }, "app-server").start();
    }

    // Writes to the server go through one writer thread, in order: a large reply
    // (a screenshot is megabytes) must never block the UI thread on the pipe.
    private final java.util.concurrent.ExecutorService serverWriter = java.util.concurrent.Executors.newSingleThreadExecutor();

    private void toServer(JSONObject m) {
        if (serverIn == null) return;
        byte[] line = (m.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        serverWriter.execute(() -> {
            try {
                serverIn.write(line);
                serverIn.flush();
            } catch (Exception e) {
                Log.w(TAG, "server stdin", e);
            }
        });
    }

    private void handleServer(String body) {
        try {
            JSONObject req = new JSONObject(body);
            JSONObject reply = new JSONObject().put("t", "result").put("id", req.opt("id") == null ? 0 : req.opt("id"));
            dispatch(req.optString("service"), req.optString("op"), req.optJSONObject("args"), reply, () -> toServer(reply));
        } catch (Exception e) {
            Log.e(TAG, "server bridge", e);
        }
    }

    // ---------------------------------------------------------------- page bridge

    static String originOf(String url) {
        try {
            Uri u = Uri.parse(url);
            return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return "";
        }
    }

    /** A channel per load. onPageFinished can fire more than once for a document, so an
     *  earlier port stays usable: requests are answered on the port they came from, and
     *  events go to the newest one. Ports die with their page. */
    private void connectPage() {
        WebMessagePort[] ports = web.createWebMessageChannel();
        pagePort = ports[0];
        pagePort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort port, WebMessage message) {
                handlePage(port, message.getData());
            }
        });
        web.postWebMessage(new WebMessage("__shell_port__", new WebMessagePort[] { ports[1] }), Uri.parse(origin));
    }

    private void handlePage(WebMessagePort from, String body) {
        try {
            JSONObject msg = new JSONObject(body);
            if ("ready".equals(msg.optString("t"))) {
                if (from == pagePort) pageReady = true;
                flushPending();
                return;
            }
            if (!"call".equals(msg.optString("t"))) return;
            JSONObject req = msg.getJSONObject("req");
            JSONObject reply = new JSONObject().put("id", req.opt("id") == null ? 0 : req.opt("id"));
            String service = req.optString("service"), op = req.optString("op");
            if (!pageAllowed(service, op)) {
                fail(reply, "denied", service + "." + op + " is not in permissions.pages");
                deliverTo(from, "platformResult", reply);
                return;
            }
            dispatch(service, op, req.optJSONObject("args"), reply, () -> deliverTo(from, "platformResult", reply));
        } catch (Exception e) {
            Log.e(TAG, "page bridge", e);
        }
    }

    /** `permissions.pages` from desktop.config.ts (manifest meta-data sd.pagePermissions); absent → everything. */
    private List<String> pagePermissions;

    private boolean pageAllowed(String service, String op) {
        if (pagePermissions == null) {
            String raw = meta("sd.pagePermissions", null);
            pagePermissions = new ArrayList<>();
            if (raw == null) pagePermissions.add("*");
            else for (String p : raw.split(",")) if (!p.trim().isEmpty()) pagePermissions.add(p.trim());
        }
        for (String p : pagePermissions) {
            if (p.equals("*") || p.equals(service + "." + op) || p.equals(service + ".*")) return true;
        }
        return false;
    }

    private void deliverPage(String name, Object data) {
        deliverTo(pagePort, name, data);
    }

    private void deliverTo(WebMessagePort port, String name, Object data) {
        if (port == null) return;
        try {
            port.postMessage(new WebMessage(new JSONObject().put("n", name).put("d", data).toString()));
        } catch (Exception e) {
            Log.w(TAG, "page deliver", e);
        }
    }

    /** Events go to the page and to server code, as on desktop. Any thread. */
    void emit(String name, Object data) {
        runOnUiThread(() -> {
            deliverPage(name, data);
            try { toServer(new JSONObject().put("t", "platform").put("name", name).put("data", data)); } catch (Exception ignored) {}
        });
    }

    // ---------------------------------------------------------------- dispatch

    private void dispatch(String service, String op, JSONObject args, JSONObject reply, Runnable done) throws Exception {
        Op h = ops.get(service + "." + op);
        if (h == null) {
            boolean known = false;
            for (String k : ops.keySet()) if (k.startsWith(service + ".")) known = true;
            for (String d : DESKTOP_ONLY) if (d.equals(service)) known = true;
            if (known) fail(reply, "unsupported", service + "." + op + " is not available on Android");
            else fail(reply, "unknown", "unknown platform service `" + service + "`");
            done.run();
            return;
        }
        final boolean[] sent = { false };
        Reply r = new Reply() {
            public void ok(Object value) {
                runOnUiThread(() -> {
                    if (sent[0]) return;
                    sent[0] = true;
                    try {
                        reply.put("ok", true);
                        reply.put("value", value == null ? JSONObject.NULL : value);
                    } catch (Exception ignored) {}
                    done.run();
                });
            }
            public void fail(String code, String message) {
                runOnUiThread(() -> {
                    if (sent[0]) return;
                    sent[0] = true;
                    try { MainActivity.fail(reply, code, message); } catch (Exception ignored) {}
                    done.run();
                });
            }
        };
        try {
            h.call(args == null ? new JSONObject() : args, r);
        } catch (OpError e) {
            r.fail(e.code, e.getMessage());
        } catch (Exception e) {
            Log.w(TAG, service + "." + op, e);
            r.fail("internal", String.valueOf(e.getMessage()));
        }
    }

    static void fail(JSONObject reply, String code, String message) throws Exception {
        reply.put("ok", false);
        reply.put("error", new JSONObject().put("code", code).put("message", message));
    }

    String meta(String key, String fallback) {
        try {
            ApplicationInfo ai = getPackageManager().getApplicationInfo(getPackageName(), PackageManager.GET_META_DATA);
            String v = ai.metaData == null ? null : ai.metaData.getString(key);
            return v == null ? fallback : v;
        } catch (Exception e) {
            return fallback;
        }
    }
}
