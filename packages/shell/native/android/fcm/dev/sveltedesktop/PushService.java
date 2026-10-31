// Receives FCM messages and token rotations (declared in the manifest with the
// MESSAGING_EVENT filter, ahead of the SDK's own service). Runs on the SDK's
// background thread, with or without the activity.
package dev.sveltedesktop;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public class PushService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        Notifier.pushToken(getApplicationContext(), "fcm", token);
    }

    /** createPush sends data-only messages (`sd_*` keys): we display them ourselves, so every tap is
     *  authenticated like a local notification's. A message with a notification part (sent by other
     *  tools) is shown by the SDK and its taps open the app without an event. */
    @Override
    public void onMessageReceived(RemoteMessage m) {
        Notifier.ensureChannels(getApplicationContext());
        java.util.Map<String, String> d = m.getData();
        org.json.JSONObject msg = new org.json.JSONObject();
        try {
            for (String[] k : new String[][] { { "sd_id", "id" }, { "sd_title", "title" }, { "sd_body", "body" }, { "sd_subtitle", "subtitle" },
                    { "sd_image", "image" }, { "sd_channel", "channel" }, { "sd_group", "group" }, { "sd", "payload" } })
                if (d.get(k[0]) != null) msg.put(k[1], d.get(k[0]));
            if ("true".equals(d.get("sd_silent"))) msg.put("silent", true);
        } catch (org.json.JSONException ignored) {}
        Notifier.received(getApplicationContext(), msg, m.getMessageId());
    }
}
