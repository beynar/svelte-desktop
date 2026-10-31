// Self-hosted push on Android: a UnifiedPush connector (spec AND_3, intents only, no
// library). A distributor app (ntfy, NextPush, Sunup…) holds the connection to its push
// server and hands us a Web Push endpoint; we publish `{provider: 'webpush', endpoint,
// keys}`, so `createPush({ webpush })` sends to it like to a browser. Messages arrive
// RFC 8291-encrypted to our P-256 key and are decrypted here (WebPushCrypto).
//   connector → distributor: REGISTER / UNREGISTER / MESSAGE_ACK (to its package; the
//     sender is identified by share-identity on Android 14+, by `pi` below)
//   distributor → connector: NEW_ENDPOINT / MESSAGE / REGISTRATION_FAILED / UNREGISTERED /
//     TEMP_UNAVAILABLE (UnifiedPushReceiver, checked against our token)
//   several distributors → the user's default one through its unifiedpush://link activity
package dev.sveltedesktop;

import android.app.Activity;
import android.app.BroadcastOptions;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class UnifiedPush {
    static final String REGISTER = "org.unifiedpush.android.distributor.REGISTER";
    static final String UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER";
    static final String MESSAGE_ACK = "org.unifiedpush.android.distributor.MESSAGE_ACK";
    static final String NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT";
    static final String MESSAGE = "org.unifiedpush.android.connector.MESSAGE";
    static final String REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED";
    static final String UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED";
    static final String TEMP_UNAVAILABLE = "org.unifiedpush.android.connector.TEMP_UNAVAILABLE";
    private static final String TAG = MainActivity.TAG;
    private static final String KEY_ALIAS = "svelte-desktop.webpush";

    private static final Handler main = new Handler(Looper.getMainLooper());
    /** The register call waiting for NEW_ENDPOINT / REGISTRATION_FAILED. */
    private static MainActivity.Reply pending;
    private static Runnable pendingTimeout;

    private UnifiedPush() {}

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("svelte-desktop.unifiedpush", Context.MODE_PRIVATE); }

    /** Off with push.unifiedPush: false in desktop.config.ts (the build then also leaves the receiver out). */
    static boolean enabled(Context c) { return Notifier.config(c).optBoolean("unifiedPush", true); }

    /** Installed distributors: packages with a receiver for REGISTER. */
    static List<String> distributors(Context c) {
        List<String> out = new ArrayList<>();
        for (ResolveInfo ri : c.getPackageManager().queryBroadcastReceivers(new Intent(REGISTER), 0)) {
            String p = ri.activityInfo == null ? null : ri.activityInfo.packageName;
            if (p != null && !p.equals(c.getPackageName()) && !out.contains(p)) out.add(p);
        }
        return out;
    }

    static boolean available(Context c) { return enabled(c) && !distributors(c).isEmpty(); }

    static boolean registered(Context c) { return prefs(c).getString("endpoint", null) != null || prefs(c).getString("token", null) != null; }

    // ------------------------------------------------------------------ keys

    /** The private key is stored wrapped by a non-exportable Android Keystore AES key. */
    private static SecretKey wrapKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return g.generateKey();
    }

    private static String b64(byte[] b) { return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }
    private static byte[] unb64(String s) { return Base64.decode(s, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }

    /** The P-256 pair + 16-byte auth secret, created once per install. */
    private static synchronized void ensureKeys(Context c) throws Exception {
        if (prefs(c).getString("p256dh", null) != null) return;
        KeyPair kp = WebPushCrypto.generate();
        byte[] d = scalar((ECPrivateKey) kp.getPrivate());
        Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
        ci.init(Cipher.ENCRYPT_MODE, wrapKey());
        byte[] iv = ci.getIV(), ct = ci.doFinal(d);
        byte[] auth = new byte[16];
        new SecureRandom().nextBytes(auth);
        prefs(c).edit()
                .putString("p256dh", b64(WebPushCrypto.publicRaw((ECPublicKey) kp.getPublic())))
                .putString("auth", b64(auth))
                .putString("private", b64(iv) + "." + b64(ct))
                .commit();
    }

    private static byte[] scalar(ECPrivateKey k) {
        byte[] b = k.getS().toByteArray(), out = new byte[32];
        int n = Math.min(b.length, 32);
        System.arraycopy(b, b.length - n, out, 32 - n, n);
        return out;
    }

    private static ECPrivateKey privateKey(Context c) throws Exception {
        String[] p = prefs(c).getString("private", "").split("\\.");
        Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
        ci.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, unb64(p[0])));
        return WebPushCrypto.privateFromScalar(ci.doFinal(unb64(p[1])));
    }

    /** `{provider: 'webpush', endpoint, keys: {p256dh, auth}}`, or null before an endpoint. */
    static JSONObject target(Context c) throws Exception {
        String endpoint = prefs(c).getString("endpoint", null);
        if (endpoint == null) return null;
        return new JSONObject().put("provider", "webpush").put("endpoint", endpoint)
                .put("keys", new JSONObject().put("p256dh", prefs(c).getString("p256dh", "")).put("auth", prefs(c).getString("auth", "")));
    }

    // ------------------------------------------------------------------ connector → distributor

    /** The distributor gets our identity: share-identity (Android 14+) and `pi`, a PendingIntent
     *  to the spec's dummy package whose creator is us (older distributors read `application`). */
    private static void send(Context c, String action, String distributor, Intent extras) {
        // A distributor installed but never opened is "stopped": include it anyway.
        Intent i = new Intent(action).setPackage(distributor).addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES).putExtras(extras)
                .putExtra("application", c.getPackageName())
                .putExtra("pi", PendingIntent.getBroadcast(c, 0, new Intent("org.unifiedpush.dummy_app").setPackage("org.unifiedpush.dummy_app"), PendingIntent.FLAG_IMMUTABLE));
        if (Build.VERSION.SDK_INT >= 34) c.sendBroadcast(i, null, BroadcastOptions.makeBasic().setShareIdentityEnabled(true).toBundle());
        else c.sendBroadcast(i);
    }

    /** push.register: → the Web Push target once the distributor sends NEW_ENDPOINT. */
    static void register(MainActivity a, JSONObject args, MainActivity.Reply r) throws Exception {
        Context c = a.getApplicationContext();
        ensureKeys(c);
        List<String> found = distributors(c);
        String saved = prefs(c).getString("distributor", null);
        if (saved != null && found.contains(saved)) { doRegister(c, saved, args, r); return; }
        if (found.size() == 1) { doRegister(c, found.get(0), args, r); return; }
        // Several: ask for the default one (its link activity answers with a PendingIntent it created).
        try {
            a.startForResult(new Intent(Intent.ACTION_VIEW, Uri.parse("unifiedpush://link")), (code, data) -> {
                PendingIntent pi = data == null ? null : data.getParcelableExtra("pi");
                String pick = code == Activity.RESULT_OK && pi != null && found.contains(pi.getCreatorPackage()) ? pi.getCreatorPackage() : found.get(0);
                try { doRegister(c, pick, args, r); } catch (Exception e) { r.fail("internal", "push.register: " + e.getMessage()); }
            });
        } catch (Exception e) {
            doRegister(c, found.get(0), args, r);
        }
    }

    private static synchronized void doRegister(Context c, String distributor, JSONObject args, MainActivity.Reply r) throws Exception {
        String token = prefs(c).getString("token", null);
        if (token == null || !distributor.equals(prefs(c).getString("distributor", null))) {
            token = UUID.randomUUID().toString();
            prefs(c).edit().putString("token", token).putString("distributor", distributor).remove("endpoint").commit();
        }
        if (pending != null) pending.fail("unavailable", "push.register: superseded by a newer call");
        pending = r;
        if (pendingTimeout != null) main.removeCallbacks(pendingTimeout);
        pendingTimeout = () -> settle(null, "unavailable", "push.register: no endpoint from the UnifiedPush distributor " + distributor + " within 30 s (is it connected to its server?)");
        main.postDelayed(pendingTimeout, 30_000);
        Intent extras = new Intent().putExtra("token", token)
                .putExtra("features", new String[] { "org.unifiedpush.android.distributor.feature.BYTES_MESSAGE" })
                .putExtra("message", String.valueOf(c.getApplicationInfo().loadLabel(c.getPackageManager())));
        String vapid = Notifier.str(args, "vapidPublicKey");
        if (vapid != null) extras.putExtra("vapid", vapid);
        send(c, REGISTER, distributor, extras);
    }

    private static synchronized void settle(JSONObject target, String code, String message) {
        MainActivity.Reply r = pending;
        pending = null;
        if (pendingTimeout != null) { main.removeCallbacks(pendingTimeout); pendingTimeout = null; }
        if (r == null) return;
        if (target != null) r.ok(target); else r.fail(code, message);
    }

    static void unregister(Context c) {
        String token = prefs(c).getString("token", null), distributor = prefs(c).getString("distributor", null);
        if (token != null && distributor != null) send(c, UNREGISTER, distributor, new Intent().putExtra("token", token));
        prefs(c).edit().remove("token").remove("endpoint").remove("distributor").commit();
        settle(null, "unavailable", "push.register: unregistered");
    }

    // ------------------------------------------------------------------ distributor → connector

    /** UnifiedPushReceiver: anything not carrying our token is ignored. */
    static void onReceive(Context c, Intent i) {
        String token = prefs(c).getString("token", null);
        if (token == null || !token.equals(i.getStringExtra("token"))) { Log.w(TAG, "UnifiedPush " + i.getAction() + " with an unknown token: ignored"); return; }
        String action = String.valueOf(i.getAction());
        try {
            switch (action) {
                case NEW_ENDPOINT: {
                    String endpoint = i.getStringExtra("endpoint");
                    if (endpoint == null) return;
                    boolean changed = !endpoint.equals(prefs(c).getString("endpoint", null));
                    prefs(c).edit().putString("endpoint", endpoint).commit();
                    JSONObject t = target(c);
                    settle(t, null, null);
                    if (changed) Notifier.emit("pushToken", t);
                    break;
                }
                case REGISTRATION_FAILED: {
                    // The spec: a new token for the next attempt.
                    prefs(c).edit().remove("token").remove("endpoint").commit();
                    settle(null, "unavailable", "push.register: the UnifiedPush distributor refused the registration (" + i.getStringExtra("reason") + ")");
                    break;
                }
                case UNREGISTERED: {
                    prefs(c).edit().remove("token").remove("endpoint").commit();
                    settle(null, "unavailable", "push.register: unregistered by the distributor");
                    break;
                }
                case MESSAGE: {
                    String id = i.getStringExtra("id");
                    String distributor = prefs(c).getString("distributor", null);
                    if (id != null && distributor != null) send(c, MESSAGE_ACK, distributor, new Intent().putExtra("token", token).putExtra("id", id));
                    byte[] body = i.getByteArrayExtra("bytesMessage");
                    if (body == null && i.getStringExtra("message") != null) body = i.getStringExtra("message").getBytes(StandardCharsets.UTF_8);
                    if (body == null) return;
                    byte[] plain = WebPushCrypto.decrypt(body, privateKey(c), unb64(prefs(c).getString("p256dh", "")), unb64(prefs(c).getString("auth", "")));
                    JSONObject msg = new JSONObject(new String(plain, StandardCharsets.UTF_8));
                    Notifier.webPushMessage(c, msg, id);
                    break;
                }
                default: // TEMP_UNAVAILABLE: the distributor keeps the registration
                    Log.i(TAG, "UnifiedPush " + action);
            }
        } catch (Exception e) {
            Log.w(TAG, "UnifiedPush " + action, e);
        }
    }
}
