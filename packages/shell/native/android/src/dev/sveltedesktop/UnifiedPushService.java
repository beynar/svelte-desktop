// UnifiedPush AND_3: a distributor binds this (action RAISE_TO_FOREGROUND) and messages it
// while it delivers a MESSAGE; being bound raises the app to foreground importance for a
// few seconds (network, starting work). A Messenger: distributors talk to it as one.
package dev.sveltedesktop;

import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Messenger;

public class UnifiedPushService extends Service {
    private final Messenger messenger = new Messenger(new Handler(Looper.getMainLooper(), msg -> true));

    @Override
    public IBinder onBind(Intent intent) { return messenger.getBinder(); }
}
