// The UnifiedPush connector's receiver (exported: distributors are other apps; every
// intent must carry our registration token). Work runs off the main thread: decrypting
// and fetching a notification image.
package dev.sveltedesktop;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class UnifiedPushReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        PendingResult done = goAsync();
        new Thread(() -> {
            try {
                Notifier.ensureChannels(c);
                UnifiedPush.onReceive(c, intent);
            } finally {
                done.finish();
            }
        }, "unifiedpush").start();
    }
}
