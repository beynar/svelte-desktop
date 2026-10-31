// Notification work that must not open the activity: scheduled alarms, background
// actions (`foreground: false`, inline replies included), swipe-away (deleteIntent →
// kind "dismiss"), and re-arming schedules after a reboot or an app update.
package dev.sveltedesktop;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class NotificationReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        String action = String.valueOf(intent.getAction());
        switch (action) {
            case Notifier.ACTION_ALARM:
                Notifier.fire(c, intent.getStringExtra(Notifier.EXTRA_ID), intent.getLongExtra(Notifier.EXTRA_AT, 0));
                break;
            case Notifier.ACTION_RESPOND:
                Notifier.fromIntent(c, intent);
                break;
            case Intent.ACTION_BOOT_COMPLETED:
            case Intent.ACTION_MY_PACKAGE_REPLACED:
                Notifier.init(c);
                break;
            default:
        }
    }
}
