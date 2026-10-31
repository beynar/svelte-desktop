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

    @Override
    public void onMessageReceived(RemoteMessage m) {
        Notifier.ensureChannels(getApplicationContext());
        RemoteMessage.Notification n = m.getNotification();
        Notifier.pushMessage(getApplicationContext(), m.getData(),
                n == null ? null : n.getTitle(), n == null ? null : n.getBody(), n == null ? null : n.getChannelId(),
                n == null ? null : n.getTag(), n == null || n.getImageUrl() == null ? null : n.getImageUrl().toString(), m.getMessageId());
    }
}
