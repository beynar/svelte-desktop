// Firebase Cloud Messaging for `push.*` — compiled only into builds with push.fcm in
// desktop.config.ts (package-android.ts adds the Firebase artifacts, the merged
// manifest entries and the google-services.json values). Notifier finds it by name.
// Auto-init is off in the manifest: no token, no network until the app registers.
package dev.sveltedesktop;

import android.content.Context;

import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

final class FcmPush implements Notifier.Push {
    private static FirebaseMessaging messaging(Context c, MainActivity.Reply r, String op) {
        if (FirebaseApp.getApps(c).isEmpty() && FirebaseApp.initializeApp(c) == null) {
            r.fail("unavailable", op + ": Firebase is not configured (google-services.json values missing from the build)");
            return null;
        }
        GoogleApiAvailability gms = GoogleApiAvailability.getInstance();
        int status = gms.isGooglePlayServicesAvailable(c);
        if (status != ConnectionResult.SUCCESS) {
            r.fail("unavailable", op + ": Google Play services unavailable (" + gms.getErrorString(status) + ")");
            return null;
        }
        return FirebaseMessaging.getInstance();
    }

    @Override
    public void register(Context c, MainActivity.Reply r) {
        FirebaseMessaging m = messaging(c, r, "push.register");
        if (m == null) return;
        m.setAutoInitEnabled(true); // persisted by the SDK: token refreshes reach onNewToken from now on
        m.getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful() || task.getResult() == null) {
                Exception e = task.getException();
                r.fail("unavailable", "push.register: no FCM token (" + (e == null ? "unknown error" : e.getMessage()) + ")");
                return;
            }
            Notifier.pushToken(c, "fcm", task.getResult());
            try { r.ok(new JSONObject().put("provider", "fcm").put("token", task.getResult())); } catch (Exception ignored) {}
        });
    }

    @Override
    public void unregister(Context c, MainActivity.Reply r) {
        FirebaseMessaging m = messaging(c, r, "push.unregister");
        if (m == null) return;
        m.setAutoInitEnabled(false);
        m.deleteToken().addOnCompleteListener(task -> {
            Notifier.pushToken(c, "fcm", null);
            if (task.isSuccessful()) r.ok(null);
            else r.fail("unavailable", "push.unregister: " + (task.getException() == null ? "failed" : task.getException().getMessage()));
        });
    }
}
