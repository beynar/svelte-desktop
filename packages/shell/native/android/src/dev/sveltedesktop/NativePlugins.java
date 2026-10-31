// The app's C/C++ plugin (native/*.c|cc|cpp + native/android/, the sd_host ABI of
// native/include/svelte_desktop.h), loaded through libsdhost.so (jni/sd_host_android.c).
// Its ops become regular platform ops: callable from pages (`nativeModule()`) and
// from server code, with the same permission checks as the built-in ones.
package dev.sveltedesktop;

import android.util.Log;

import org.json.JSONTokener;

import java.io.File;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

final class NativePlugins {
    private static MainActivity activity;
    private static final Map<Long, MainActivity.Reply> pending = new ConcurrentHashMap<>();
    private static final AtomicLong nextId = new AtomicLong(1);

    private static native String load(String path);
    private static native boolean call(String name, String args, long id);

    /** Loads libapp-native.so when the APK ships one. Main thread. */
    static void init(MainActivity a) {
        activity = a;
        File plugin = new File(a.getApplicationInfo().nativeLibraryDir, "libapp-native.so");
        if (!plugin.exists()) return;
        try {
            System.loadLibrary("sdhost");
            String err = load(plugin.getAbsolutePath());
            if (err != null) Log.e(MainActivity.TAG, "native plugin: " + err);
        } catch (Throwable t) {
            Log.e(MainActivity.TAG, "native plugin", t);
        }
    }

    // ---- called from C (any thread for resolve/reject/emit)

    static boolean registered(String service, String op) {
        String name = service + "." + op;
        if (activity.ops.containsKey(name)) return false; // built-in ops win
        activity.async(name, (args, reply) -> {
            long id = nextId.getAndIncrement();
            pending.put(id, reply);
            if (!call(name, args.toString(), id)) {
                pending.remove(id);
                reply.fail("internal", name + ": not registered");
            }
        });
        return true;
    }

    static void resolve(long id, String json) {
        MainActivity.Reply r = pending.remove(id);
        if (r == null) return;
        try {
            Object v = new JSONTokener(json).nextValue();
            r.ok(v);
        } catch (Exception e) {
            r.fail("internal", "plugin replied with invalid JSON: " + json);
        }
    }

    static void reject(long id, String code, String message) {
        MainActivity.Reply r = pending.remove(id);
        if (r != null) r.fail(code, message);
    }

    static void emit(String event, String json) {
        try {
            Object v = new JSONTokener(json).nextValue();
            activity.emit(event, v);
        } catch (Exception e) {
            Log.w(MainActivity.TAG, "plugin event " + event, e);
        }
    }
}
