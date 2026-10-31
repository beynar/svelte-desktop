// Notifications and push for the Android host — the contract is native/NOTIFICATIONS.md.
// Process-wide and Context-based: the activity (Services.java), NotificationReceiver
// (alarms, boot, background actions, swipes) and the FCM service (native/android/fcm,
// compiled only when desktop.config has push.fcm) all go through here, with or
// without a running activity.
//   show       → Notification (tag = id, id 0: same id = replaced), payload in extras
//   at/repeat  → SharedPreferences + AlarmManager (+ an in-process timer while we run),
//                re-armed at start, on BOOT_COMPLETED and MY_PACKAGE_REPLACED
//   responses  → seq'd, a ring of 64 (`responses`), live to a loaded page (target: true)
//                or queued for `claim` (persisted: a background action can outlive us)
package dev.sveltedesktop;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;

final class Notifier {
    static final String EXTRA_ID = "dev.sveltedesktop.notification.id";
    static final String EXTRA_KIND = "dev.sveltedesktop.notification.kind";
    static final String EXTRA_ACTION = "dev.sveltedesktop.notification.action";
    static final String EXTRA_PAYLOAD = "dev.sveltedesktop.notification.payload";
    static final String EXTRA_NONCE = "dev.sveltedesktop.notification.nonce";
    static final String EXTRA_AT = "dev.sveltedesktop.notification.at";
    static final String EXTRA_KEEP = "dev.sveltedesktop.notification.keep";
    static final String KEY_INPUT = "dev.sveltedesktop.notification.input";
    static final String ACTION_ALARM = "dev.sveltedesktop.NOTIFICATION_ALARM";
    static final String ACTION_RESPOND = "dev.sveltedesktop.NOTIFICATION_RESPOND";
    /** Tag prefix of the group summaries we post (never listed by `delivered`). */
    static final String SUMMARY = "sd.group:";
    private static final String TAG = MainActivity.TAG;

    /** The activity while it exists (events), and whether it is in the foreground. */
    static volatile MainActivity live;
    static volatile boolean resumed;
    /** `setForeground`; null = config `notifications.foreground` (default true). */
    static volatile Boolean foregroundDefault;

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static JSONObject config;
    private static boolean started;

    private Notifier() {}

    static NotificationManager nm(Context c) { return (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE); }

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("svelte-desktop.notifications", Context.MODE_PRIVATE); }
    private static SharedPreferences scheduled(Context c) { return c.getSharedPreferences("svelte-desktop.notifications.scheduled", Context.MODE_PRIVATE); }

    /** A string member, or null when absent / JSON null (optString would say "null"). */
    static String str(JSONObject o, String k) {
        Object v = o == null ? null : o.opt(k);
        return v == null || v == JSONObject.NULL ? null : String.valueOf(v);
    }

    private static Object orNull(Object v) { return v == null ? JSONObject.NULL : v; }

    /** Once per process: config channels, the claim queue, scheduled alarms. */
    static synchronized void init(Context c) {
        if (started) return;
        started = true;
        Context app = c.getApplicationContext();
        ensureChannels(app);
        loadUnclaimed(app);
        rearm(app);
    }

    // ------------------------------------------------------------------ config + channels

    /** assets/sd-notifications.json, written by package-android.ts: {channels, foreground, fcm}. */
    static synchronized JSONObject config(Context c) {
        if (config != null) return config;
        try (InputStream in = c.getAssets().open("sd-notifications.json")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            config = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            config = new JSONObject();
        }
        return config;
    }

    /** The first configured channel, else "default". */
    static String defaultChannel(Context c) {
        JSONArray ch = config(c).optJSONArray("channels");
        JSONObject first = ch == null ? null : ch.optJSONObject(0);
        String id = first == null ? null : str(first, "id");
        return id == null || id.isEmpty() ? "default" : id;
    }

    private static boolean channelsReady;

    static synchronized void ensureChannels(Context c) {
        if (channelsReady) return;
        channelsReady = true;
        try {
            JSONArray ch = config(c).optJSONArray("channels");
            if (ch == null || ch.length() == 0) {
                createChannel(c, new JSONObject().put("id", "default").put("name", "Notifications"));
            } else {
                boolean configured = false;
                for (int i = 0; i < ch.length(); i++) {
                    if (ch.optJSONObject(i) == null) continue;
                    createChannel(c, ch.getJSONObject(i));
                    if ("default".equals(str(ch.optJSONObject(i), "id"))) configured = true;
                }
                // The implicit "default" of a build without config channels goes away (unless the app made it).
                if (!configured && !prefs(c).getBoolean("explicitDefault", false) && nm(c).getNotificationChannel("default") != null)
                    nm(c).deleteNotificationChannel("default");
            }
        } catch (Exception e) {
            Log.w(TAG, "notification channels", e);
        }
    }

    private static int importance(String s) throws MainActivity.OpError {
        switch (s) {
            case "none": return NotificationManager.IMPORTANCE_NONE;
            case "min": return NotificationManager.IMPORTANCE_MIN;
            case "low": return NotificationManager.IMPORTANCE_LOW;
            case "default": return NotificationManager.IMPORTANCE_DEFAULT;
            case "high": return NotificationManager.IMPORTANCE_HIGH;
            case "max": return NotificationManager.IMPORTANCE_MAX;
            default: throw new MainActivity.OpError("invalid_args", "notifications.createChannel: importance must be min|low|default|high|max");
        }
    }

    private static String importanceName(int i) {
        switch (i) {
            case NotificationManager.IMPORTANCE_NONE: return "none";
            case NotificationManager.IMPORTANCE_MIN: return "min";
            case NotificationManager.IMPORTANCE_LOW: return "low";
            case NotificationManager.IMPORTANCE_HIGH: return "high";
            case NotificationManager.IMPORTANCE_MAX: return "max";
            default: return "default";
        }
    }

    /** notifications.createChannel (the app's own channels, never cleaned up at start). */
    static void createAppChannel(Context c, JSONObject o) throws Exception {
        createChannel(c, o);
        if ("default".equals(str(o, "id"))) prefs(c).edit().putBoolean("explicitDefault", true).apply();
    }

    /** {id, name, description?, importance?, sound?, vibrate?, lights?, badge?, visibility?}. Android keeps
     *  importance and sound as first created (the user owns them); name and description update. */
    static void createChannel(Context c, JSONObject o) throws Exception {
        String id = str(o, "id"), name = str(o, "name");
        if (id == null || id.isEmpty() || name == null || name.isEmpty()) throw new MainActivity.OpError("invalid_args", "notifications.createChannel: `id` and `name` are required");
        NotificationChannel ch = new NotificationChannel(id, name, importance(o.optString("importance", "default")));
        if (str(o, "description") != null) ch.setDescription(str(o, "description"));
        Object sound = o.opt("sound");
        if (Boolean.FALSE.equals(sound)) ch.setSound(null, null);
        else if (sound instanceof String && !"default".equals(sound)) {
            // A sound shipped with the app: res/raw/<name>.
            int res = c.getResources().getIdentifier(((String) sound).replaceFirst("\\.[^.]+$", ""), "raw", c.getPackageName());
            if (res != 0) ch.setSound(Uri.parse("android.resource://" + c.getPackageName() + "/" + res),
                    new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        }
        if (o.has("vibrate")) ch.enableVibration(o.optBoolean("vibrate"));
        if (o.has("lights")) ch.enableLights(o.optBoolean("lights"));
        if (o.has("badge")) ch.setShowBadge(o.optBoolean("badge", true));
        String vis = o.optString("visibility", "");
        if (!vis.isEmpty()) ch.setLockscreenVisibility(vis.equals("public") ? Notification.VISIBILITY_PUBLIC : vis.equals("secret") ? Notification.VISIBILITY_SECRET : Notification.VISIBILITY_PRIVATE);
        nm(c).createNotificationChannel(ch);
    }

    static JSONArray channels(Context c) throws Exception {
        JSONArray out = new JSONArray();
        for (NotificationChannel ch : nm(c).getNotificationChannels()) {
            int v = ch.getLockscreenVisibility();
            out.put(new JSONObject().put("id", ch.getId()).put("name", String.valueOf(ch.getName()))
                    .put("description", orNull(ch.getDescription())).put("importance", importanceName(ch.getImportance()))
                    .put("sound", ch.getSound() != null).put("vibrate", ch.shouldVibrate()).put("lights", ch.shouldShowLights())
                    .put("badge", ch.canShowBadge())
                    .put("visibility", v == Notification.VISIBILITY_PUBLIC ? "public" : v == Notification.VISIBILITY_SECRET ? "secret" : "private"));
        }
        return out;
    }

    // ------------------------------------------------------------------ show

    private static boolean showInForeground(Context c, JSONObject s) {
        if (s != null && s.has("foreground") && s.opt("foreground") instanceof Boolean) return s.optBoolean("foreground");
        Boolean d = foregroundDefault;
        return d != null ? d : config(c).optBoolean("foreground", true);
    }

    /** `notifications.show`: → {id, scheduled}. A pending notification with the same id is replaced. */
    static JSONObject show(Context c, JSONObject s) throws Exception {
        // The wire contract (native/notifications.fixtures.json), checked before any effect.
        if (!(s.opt("title") instanceof String)) throw new MainActivity.OpError("invalid_args", "notifications.show: `title` must be a string");
        if (s.has("repeat") && !s.has("at")) throw new MainActivity.OpError("invalid_args", "notifications.show: `repeat` needs `at`");
        JSONArray acts = s.optJSONArray("actions");
        for (int i = 0; acts != null && i < acts.length(); i++) {
            JSONObject a = acts.optJSONObject(i);
            if (a == null || !(a.opt("id") instanceof String) || a.optString("id").isEmpty() || !(a.opt("title") instanceof String || a.opt("label") instanceof String))
                throw new MainActivity.OpError("invalid_args", "notifications.show: each action needs string `id` and `title`");
        }
        String id = str(s, "id");
        if (id == null || id.isEmpty()) id = str(s, "tag");
        if (id == null || id.isEmpty()) id = "default";
        s.put("id", id);
        String repeat = str(s, "repeat");
        if (repeat != null && period(repeat) < 0) throw new MainActivity.OpError("invalid_args", "notifications.show: repeat must be minute|hour|day|week|month|year");
        if (!nm(c).areNotificationsEnabled()) throw new MainActivity.OpError("denied", "notifications.show: notifications are not allowed (notifications.requestPermission)");
        channelFor(c, s); // fail now on an unknown channel or color, not when an alarm fires
        color(s);
        cancelScheduled(c, id);
        long at = s.optLong("at", 0), now = System.currentTimeMillis();
        if (at > now || (repeat != null && at > 0)) {
            // A repeating schedule whose start is past begins at its next occurrence.
            while (at <= now) at = advance(at, repeat);
            s.put("at", at);
            keepImages(c, s);
            synchronized (Notifier.class) {
                if (!scheduled(c).edit().putString(id, s.toString()).commit())
                    throw new MainActivity.OpError("internal", "notifications.show: the schedule could not be saved");
            }
            removeDelivered(c, id); // one id = one notification: the new one replaces the shown one
            arm(c, id, at);
            return new JSONObject().put("id", id).put("tag", id).put("scheduled", true);
        }
        post(c, s, false);
        return new JSONObject().put("id", id).put("tag", id).put("scheduled", false);
    }

    /** `color`: "#rrggbb" (or anything Color.parseColor takes, e.g. "#aarrggbb"). */
    private static Integer color(JSONObject s) throws MainActivity.OpError {
        String v = str(s, "color");
        if (v == null || v.isEmpty()) return null;
        try {
            return android.graphics.Color.parseColor(v);
        } catch (IllegalArgumentException e) {
            throw new MainActivity.OpError("invalid_args", "notifications.show: color must be \"#rrggbb\"");
        }
    }

    private static String channelFor(Context c, JSONObject s) throws MainActivity.OpError {
        ensureChannels(c);
        String channel = str(s, "channel");
        if (channel == null || channel.isEmpty()) channel = defaultChannel(c);
        if (nm(c).getNotificationChannel(channel) == null)
            throw new MainActivity.OpError("invalid_args", "notifications.show: no channel `" + channel + "` (notifications.channels in desktop.config.ts, or notifications.createChannel)");
        return channel;
    }

    private static int smallIcon(Context c) {
        int icon = c.getApplicationInfo().icon;
        return icon != 0 ? icon : android.R.drawable.ic_dialog_info;
    }

    /** Builds and posts a notification from show's arguments. Any thread. */
    @SuppressWarnings("deprecation")
    static void post(Context c, JSONObject s, boolean push) throws Exception {
        String id = s.getString("id");
        String channel = channelFor(c, s);
        String title = str(s, "title"), body = str(s, "body"), subtitle = str(s, "subtitle"), group = str(s, "group"), payload = str(s, "payload");
        String summary = str(s, "summary");
        // ongoing: can't be swiped away, and acting on it doesn't remove it; autoCancel false: a click keeps it.
        boolean ongoing = s.optBoolean("ongoing", false), autoCancel = s.optBoolean("autoCancel", true);
        Notification.Builder n = new Notification.Builder(c, channel)
                .setSmallIcon(smallIcon(c))
                .setContentTitle(title)
                .setAutoCancel(autoCancel && !ongoing)
                .setOngoing(ongoing)
                .setShowWhen(true)
                .setContentIntent(responseIntent(c, true, id, "click", null, payload, "click", false, !autoCancel || ongoing))
                .setDeleteIntent(responseIntent(c, false, id, "dismiss", null, payload, "dismiss", false, false));
        Integer color = color(s);
        if (color != null) n.setColor(color);
        String vis = s.optString("visibility", "");
        if (!vis.isEmpty()) n.setVisibility(vis.equals("public") ? Notification.VISIBILITY_PUBLIC : vis.equals("secret") ? Notification.VISIBILITY_SECRET : Notification.VISIBILITY_PRIVATE);
        if (body != null) n.setContentText(body);
        if (subtitle != null) n.setSubText(subtitle);
        if (group != null && !group.isEmpty()) n.setGroup(group);
        if (s.has("badge") && s.optInt("badge", 0) > 0) n.setNumber(s.optInt("badge"));
        // Android drops (not just mis-dates) a notification whose `when` is over ~14 days old.
        long when = s.optLong("timestamp", 0);
        if (when > 0 && when > System.currentTimeMillis() - 13L * 24 * 3600 * 1000) n.setWhen(when);
        if (s.has("renotify") && !s.optBoolean("renotify", true)) n.setOnlyAlertOnce(true);
        switch (s.optString("urgency", "normal")) {
            case "low": n.setPriority(Notification.PRIORITY_LOW); break;
            case "critical": n.setPriority(Notification.PRIORITY_MAX).setCategory(Notification.CATEGORY_REMINDER); break;
            default: n.setPriority(Notification.PRIORITY_DEFAULT);
        }
        // Sound comes from the channel on Android 8+; silent (or "not while frontmost") mutes this one.
        boolean quiet = s.optBoolean("silent", false) || (resumed && !showInForeground(c, s));
        // (What NotificationCompat.setSilent does: a group child that only lets its summary alert.)
        if (quiet) {
            n.setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY);
            if (group == null || group.isEmpty()) n.setGroup("sd.silent." + id);
        }
        Bitmap icon = bitmap(str(s, "icon"), 256);
        Bitmap image = bitmap(str(s, "image"), 1024);
        if (icon != null) n.setLargeIcon(icon);
        JSONArray lines = s.optJSONArray("lines");
        if (image != null) {
            Notification.BigPictureStyle st = new Notification.BigPictureStyle().bigPicture(image);
            if (summary != null || body != null) st.setSummaryText(summary != null ? summary : body);
            if (icon == null) { n.setLargeIcon(image); st.bigLargeIcon((Bitmap) null); }
            n.setStyle(st);
        } else if (lines != null && lines.length() > 0) {
            Notification.InboxStyle st = new Notification.InboxStyle();
            for (int i = 0; i < lines.length(); i++) st.addLine(lines.optString(i));
            if (summary != null) st.setSummaryText(summary);
            n.setStyle(st);
        } else if (summary != null || (body != null && (body.length() > 40 || body.contains("\n")))) {
            Notification.BigTextStyle st = new Notification.BigTextStyle().bigText(body != null ? body : "");
            if (summary != null) st.setSummaryText(summary);
            n.setStyle(st);
        }
        JSONArray actions = s.optJSONArray("actions");
        if (actions != null) {
            for (int i = 0, k = 0; i < actions.length() && k < 3; i++) {
                JSONObject act = actions.optJSONObject(i);
                if (act == null) continue;
                String aid = str(act, "id");
                if (aid == null) aid = String.valueOf(i);
                String label = str(act, "title");
                if (label == null) label = str(act, "label");
                if (label == null) label = aid;
                Object in = act.opt("input");
                boolean input = in instanceof JSONObject || Boolean.TRUE.equals(in);
                boolean fg = !(act.opt("foreground") instanceof Boolean) || act.optBoolean("foreground");
                PendingIntent pi = responseIntent(c, fg, id, input ? "reply" : "action", aid, payload, "action-" + k, input, ongoing);
                Notification.Action.Builder b = new Notification.Action.Builder(null, label, pi);
                if (input) {
                    String ph = in instanceof JSONObject ? str((JSONObject) in, "placeholder") : null;
                    b.addRemoteInput(new RemoteInput.Builder(KEY_INPUT).setLabel(ph != null ? ph : label).build());
                    if (Build.VERSION.SDK_INT >= 28) b.setSemanticAction(Notification.Action.SEMANTIC_ACTION_REPLY);
                } else if (act.optBoolean("destructive") && Build.VERSION.SDK_INT >= 28) {
                    b.setSemanticAction(Notification.Action.SEMANTIC_ACTION_DELETE);
                }
                n.addAction(b.build());
                k++;
            }
        }
        Bundle extras = new Bundle();
        extras.putString("sd.id", id);
        if (payload != null) extras.putString("sd.payload", payload);
        n.addExtras(extras);
        nm(c).notify(id, 0, n.build());
        updateSummary(c, group, channel, id, true);
        if (live != null) emit("notificationShown", new JSONObject().put("id", id).put("payload", orNull(payload)).put("push", push));
    }

    /** A group gets a summary once it has two notifications (Android bundles them under it). */
    private static void updateSummary(Context c, String group, String channel, String id, boolean adding) {
        if (group == null || group.isEmpty() || group.startsWith("sd.silent.")) return;
        try {
            int count = adding ? 1 : 0;
            for (StatusBarNotification sbn : nm(c).getActiveNotifications()) {
                String tag = sbn.getTag();
                if (tag == null || tag.startsWith(SUMMARY) || tag.equals(id) || (sbn.getNotification().flags & Notification.FLAG_GROUP_SUMMARY) != 0
                        || !group.equals(sbn.getNotification().getGroup())) continue;
                count++;
                if (channel == null) channel = sbn.getNotification().getChannelId();
            }
            if (count < 2 || channel == null) { nm(c).cancel(SUMMARY + group, 0); return; }
            Intent open = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
            Notification.Builder sum = new Notification.Builder(c, channel)
                    .setSmallIcon(smallIcon(c))
                    .setGroup(group)
                    .setGroupSummary(true)
                    .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
                    .setAutoCancel(true)
                    .setStyle(new Notification.InboxStyle().setSummaryText(count + " notifications"));
            if (open != null) sum.setContentIntent(PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
            nm(c).notify(SUMMARY + group, 0, sum.build());
        } catch (Exception e) {
            Log.w(TAG, "group summary", e);
        }
    }

    // A per-install secret in our PendingIntents: the launcher activity is exported, so
    // another app could otherwise start it with forged notification extras.
    private static String nonce;

    private static synchronized String nonce(Context c) {
        if (nonce != null) return nonce;
        nonce = prefs(c).getString("nonce", null);
        if (nonce == null) {
            byte[] b = new byte[16];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            nonce = sb.toString();
            prefs(c).edit().putString("nonce", nonce).apply();
        }
        return nonce;
    }

    /** foreground: the activity (click, foreground actions); else NotificationReceiver (background
     *  actions, swipe-away) — no activity is opened. The data URI keeps PendingIntents distinct. */
    private static PendingIntent responseIntent(Context c, boolean foreground, String id, String kind, String actionId, String payload, String slot, boolean mutable, boolean keep) {
        Intent i = new Intent(c, foreground ? MainActivity.class : NotificationReceiver.class)
                .setData(Uri.parse("sd-notification://n/" + Uri.encode(id) + "/" + slot))
                .putExtra(EXTRA_ID, id).putExtra(EXTRA_KIND, kind).putExtra(EXTRA_NONCE, nonce(c));
        if (actionId != null) i.putExtra(EXTRA_ACTION, actionId);
        if (payload != null) i.putExtra(EXTRA_PAYLOAD, payload);
        if (keep) i.putExtra(EXTRA_KEEP, true);
        // RemoteInput fills the reply into the intent: that PendingIntent must be mutable.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (mutable && Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : PendingIntent.FLAG_IMMUTABLE);
        if (!foreground) return PendingIntent.getBroadcast(c, 0, i.setAction(ACTION_RESPOND), flags);
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(c, 0, i, flags);
    }

    /** A local path, a file:// URL or a data: URL (base64), downsampled to `max` px. */
    static Bitmap bitmap(String src, int max) {
        if (src == null || src.isEmpty()) return null;
        try {
            byte[] data = null;
            String path = null;
            if (src.startsWith("data:")) {
                int comma = src.indexOf(',');
                String head = src.substring(0, Math.max(comma, 0));
                String body = src.substring(comma + 1);
                data = head.endsWith(";base64") ? Base64.decode(body, Base64.DEFAULT) : Uri.decode(body).getBytes(StandardCharsets.ISO_8859_1);
            } else {
                path = src.startsWith("file:") ? Uri.parse(src).getPath() : src;
            }
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            if (data != null) BitmapFactory.decodeByteArray(data, 0, data.length, o); else BitmapFactory.decodeFile(path, o);
            int sample = 1;
            while (Math.max(o.outWidth, o.outHeight) / sample > max) sample *= 2;
            o = new BitmapFactory.Options();
            o.inSampleSize = sample;
            return data != null ? BitmapFactory.decodeByteArray(data, 0, data.length, o) : BitmapFactory.decodeFile(path, o);
        } catch (Exception e) {
            Log.w(TAG, "notification image", e);
            return null;
        }
    }

    /** Scheduled specs are persisted: data: images go to files rather than into SharedPreferences. */
    private static void keepImages(Context c, JSONObject s) throws Exception {
        for (String k : new String[] { "image", "icon" }) {
            String v = str(s, k);
            if (v == null || !v.startsWith("data:") || v.indexOf(',') < 0) continue;
            File f = imageFile(c, s.getString("id"), k);
            f.getParentFile().mkdirs();
            String head = v.substring(0, v.indexOf(','));
            byte[] bytes = head.endsWith(";base64") ? Base64.decode(v.substring(v.indexOf(',') + 1), Base64.DEFAULT) : Uri.decode(v.substring(v.indexOf(',') + 1)).getBytes(StandardCharsets.ISO_8859_1);
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(bytes); }
            s.put(k, f.getAbsolutePath());
        }
    }

    private static String sha256(String text) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (int i = 0; i < 16; i++) b.append(String.format("%02x", d[i]));
            return b.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static File imageFile(Context c, String id, String kind) {
        return new File(c.getFilesDir(), "sd-notifications/" + sha256(id) + "-" + kind);
    }

    // ------------------------------------------------------------------ scheduling

    private static int period(String repeat) {
        switch (repeat) {
            case "minute": return Calendar.MINUTE;
            case "hour": return Calendar.HOUR_OF_DAY;
            case "day": return Calendar.DAY_OF_YEAR;
            case "week": return Calendar.WEEK_OF_YEAR;
            case "month": return Calendar.MONTH;
            case "year": return Calendar.YEAR;
            default: return -1;
        }
    }

    private static long advance(long at, String repeat) {
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(at);
        cal.add(period(repeat), 1);
        return cal.getTimeInMillis();
    }

    private static final Map<String, Object> timers = new HashMap<>();

    private static synchronized Object timer(String id) {
        Object t = timers.get(id);
        if (t == null) timers.put(id, t = new Object());
        return t;
    }

    private static PendingIntent alarmIntent(Context c, String id, long at, int flags) {
        Intent i = new Intent(c, NotificationReceiver.class).setAction(ACTION_ALARM)
                .setData(Uri.parse("sd-notification://n/" + Uri.encode(id) + "/alarm"))
                .putExtra(EXTRA_ID, id).putExtra(EXTRA_AT, at);
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_IMMUTABLE | flags);
    }

    /** Exact when allowed (SCHEDULE_EXACT_ALARM granted, or Android < 12), else a doze-proof inexact
     *  alarm; while the process lives a timer also fires on time. Whichever comes first delivers. */
    private static void arm(Context c, String id, long at) {
        Context app = c.getApplicationContext();
        AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = alarmIntent(app, id, at, PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
        Object token = timer(id);
        main.removeCallbacksAndMessages(token);
        main.postAtTime(() -> fire(app, id, at), token, SystemClock.uptimeMillis() + Math.max(0, at - System.currentTimeMillis()));
    }

    /** An alarm (or the timer) for `id` scheduled at `at`: post it, then re-arm a repeat or forget it. */
    static void fire(Context c, String id, long at) {
        if (id == null) return;
        JSONObject s;
        synchronized (Notifier.class) {
            String raw = scheduled(c).getString(id, null);
            if (raw == null) return;
            try { s = new JSONObject(raw); } catch (Exception e) { scheduled(c).edit().remove(id).apply(); return; }
            if (s.optLong("at") != at) return; // already delivered by the other path, or rescheduled
            String repeat = str(s, "repeat");
            if (repeat != null && period(repeat) >= 0) {
                long next = at, now = System.currentTimeMillis();
                while (next <= now) next = advance(next, repeat);
                try { scheduled(c).edit().putString(id, new JSONObject(raw).put("at", next).toString()).commit(); } catch (Exception ignored) {}
                arm(c, id, next);
            } else {
                scheduled(c).edit().remove(id).commit();
                main.removeCallbacksAndMessages(timer(id));
                cancelAlarm(c, id); // when the timer came first
            }
        }
        try {
            post(c, s, false);
        } catch (Exception e) {
            Log.w(TAG, "scheduled notification " + id, e);
        }
        // A one-shot is done with its images once posted (the notification holds the bitmaps).
        if (str(s, "repeat") == null) for (String k : new String[] { "image", "icon" }) imageFile(c, id, k).delete();
    }

    /** At start, on boot and after an update (force-stop and reboots drop alarms): re-arm, deliver missed ones. */
    static void rearm(Context c) {
        long now = System.currentTimeMillis();
        for (Map.Entry<String, ?> e : scheduled(c).getAll().entrySet()) {
            try {
                long at = new JSONObject(String.valueOf(e.getValue())).optLong("at");
                if (at <= now) fire(c, e.getKey(), at);
                else arm(c, e.getKey(), at);
            } catch (Exception ex) {
                Log.w(TAG, "rearm " + e.getKey(), ex);
            }
        }
    }

    private static void cancelScheduled(Context c, String id) {
        synchronized (Notifier.class) {
            if (!scheduled(c).contains(id)) return;
            scheduled(c).edit().remove(id).commit();
        }
        main.removeCallbacksAndMessages(timer(id));
        cancelAlarm(c, id);
        for (String k : new String[] { "image", "icon" }) imageFile(c, id, k).delete();
    }

    private static void cancelAlarm(Context c, String id) {
        PendingIntent pi = alarmIntent(c.getApplicationContext(), id, 0, PendingIntent.FLAG_NO_CREATE);
        if (pi == null) return;
        ((AlarmManager) c.getSystemService(Context.ALARM_SERVICE)).cancel(pi);
        pi.cancel();
    }

    static JSONArray pending(Context c) throws Exception {
        JSONArray out = new JSONArray();
        for (Map.Entry<String, ?> e : scheduled(c).getAll().entrySet()) {
            JSONObject s = new JSONObject(String.valueOf(e.getValue()));
            JSONObject p = new JSONObject().put("id", e.getKey()).put("title", s.optString("title")).put("body", s.optString("body", "")).put("at", s.optLong("at"));
            if (str(s, "repeat") != null) p.put("repeat", str(s, "repeat"));
            if (str(s, "payload") != null) p.put("payload", str(s, "payload"));
            out.put(p);
        }
        return out;
    }

    // ------------------------------------------------------------------ delivered / dismiss

    static JSONArray delivered(Context c) throws Exception {
        JSONArray out = new JSONArray();
        for (StatusBarNotification sbn : nm(c).getActiveNotifications()) {
            String tag = sbn.getTag();
            Notification n = sbn.getNotification();
            // Group summaries: ours (sd.group:…) and the ones Android adds when it auto-groups.
            if (tag == null || tag.startsWith(SUMMARY) || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) continue;
            Bundle x = n.extras;
            JSONObject d = new JSONObject().put("id", tag)
                    .put("title", String.valueOf(x.getCharSequence(Notification.EXTRA_TITLE, "")))
                    .put("body", String.valueOf(x.getCharSequence(Notification.EXTRA_TEXT, "")))
                    .put("date", n.when != 0 ? n.when : sbn.getPostTime());
            CharSequence sub = x.getCharSequence(Notification.EXTRA_SUB_TEXT);
            if (sub != null) d.put("subtitle", sub.toString());
            if (n.getGroup() != null && !n.getGroup().startsWith("sd.silent.")) d.put("group", n.getGroup());
            if (x.getString("sd.payload") != null) d.put("payload", x.getString("sd.payload"));
            out.put(d);
        }
        return out;
    }

    /** After an inline reply Android 15+ keeps the notification (FLAG_LIFETIME_EXTENDED_BY_DIRECT_REPLY)
     *  and ignores a plain cancel until the app reposts it: repost it quietly with the reply first. */
    private static void acknowledgeReply(Context c, String id, CharSequence input) {
        try {
            for (StatusBarNotification sbn : nm(c).getActiveNotifications()) {
                if (!id.equals(sbn.getTag())) continue;
                Notification.Builder b = Notification.Builder.recoverBuilder(c, sbn.getNotification()).setOnlyAlertOnce(true);
                if (input != null) b.setRemoteInputHistory(new CharSequence[] { input });
                nm(c).notify(id, 0, b.build());
            }
        } catch (Exception e) {
            Log.w(TAG, "reply acknowledgement", e);
        }
    }

    /** Removes the delivered notification (and re-counts its group). */
    private static void removeDelivered(Context c, String id) {
        String group = null, channel = null;
        try {
            for (StatusBarNotification sbn : nm(c).getActiveNotifications()) {
                if (id.equals(sbn.getTag())) { group = sbn.getNotification().getGroup(); channel = sbn.getNotification().getChannelId(); }
            }
        } catch (Exception ignored) {}
        nm(c).cancel(id, 0);
        updateSummary(c, group, channel, id, false);
    }

    static void dismiss(Context c, String id) {
        cancelScheduled(c, id);
        removeDelivered(c, id);
    }

    static void dismissAll(Context c) {
        for (String id : scheduled(c).getAll().keySet()) cancelScheduled(c, id);
        nm(c).cancelAll();
    }

    // ------------------------------------------------------------------ responses

    private static long seq;
    private static final ArrayDeque<JSONObject> ring = new ArrayDeque<>();
    private static JSONArray unclaimed;

    /** The claim queue survives the process (a background action may run without the activity);
     *  restored responses count as new ones of this launch (fresh seq, in `responses`). */
    private static synchronized void loadUnclaimed(Context c) {
        if (unclaimed != null) return;
        unclaimed = new JSONArray();
        try {
            JSONArray saved = new JSONArray(prefs(c).getString("unclaimed", "[]"));
            for (int i = 0; i < saved.length(); i++) {
                JSONObject r = saved.getJSONObject(i).put("seq", ++seq);
                unclaimed.put(r);
                ring.addLast(r);
            }
        } catch (Exception ignored) {}
        while (ring.size() > 64) ring.removeFirst();
    }

    private static synchronized void queue(Context c, JSONObject r) {
        loadUnclaimed(c);
        unclaimed.put(r);
        while (unclaimed.length() > 64) unclaimed.remove(0);
        prefs(c).edit().putString("unclaimed", unclaimed.toString()).commit();
    }

    static synchronized JSONArray claim(Context c) {
        loadUnclaimed(c);
        JSONArray out = unclaimed;
        unclaimed = new JSONArray();
        prefs(c).edit().remove("unclaimed").commit();
        return out;
    }

    static synchronized JSONArray responses(Context c) {
        loadUnclaimed(c);
        return new JSONArray(ring);
    }

    /** Records a response; the activity hands it to server code and to the page if one is loaded
     *  (that counts as claimed), else it waits for `claim`. */
    static void respond(Context c, String id, String kind, String actionId, String input, String payload) {
        JSONObject r;
        synchronized (Notifier.class) {
            loadUnclaimed(c);
            try {
                r = new JSONObject().put("seq", ++seq).put("id", id).put("tag", id).put("kind", kind)
                        .put("actionId", orNull(actionId)).put("input", orNull(input)).put("payload", orNull(payload));
            } catch (Exception e) {
                return;
            }
            ring.addLast(r);
            while (ring.size() > 64) ring.removeFirst();
        }
        Context app = c.getApplicationContext();
        MainActivity m = live;
        if (m == null) { queue(app, r); return; }
        m.runOnUiThread(() -> { if (!m.deliverResponse(r)) queue(app, r); });
    }

    /** Notification intents: ours (activity or receiver) and FCM-displayed taps (launcher intent
     *  with the push's data as extras). → true when the intent was a notification response. */
    static boolean fromIntent(Context c, Intent i) {
        String id = i.getStringExtra(EXTRA_ID);
        if (id != null) {
            boolean ok = nonce(c).equals(i.getStringExtra(EXTRA_NONCE));
            String kind = i.getStringExtra(EXTRA_KIND), action = i.getStringExtra(EXTRA_ACTION), payload = i.getStringExtra(EXTRA_PAYLOAD);
            boolean keep = i.getBooleanExtra(EXTRA_KEEP, false);
            Bundle ri = RemoteInput.getResultsFromIntent(i);
            CharSequence input = ri == null ? null : ri.getCharSequence(KEY_INPUT);
            for (String k : new String[] { EXTRA_ID, EXTRA_KIND, EXTRA_ACTION, EXTRA_PAYLOAD, EXTRA_NONCE, EXTRA_KEEP }) i.removeExtra(k);
            if (!ok) { Log.w(TAG, "notification intent without our nonce: ignored"); return true; }
            if (kind == null) kind = "click";
            if ("reply".equals(kind)) acknowledgeReply(c, id, input);
            // An action consumed the notification; a click auto-cancels it; both re-count the group.
            // Not when it asked to stay (ongoing, or autoCancel: false for a click).
            if (!keep || "dismiss".equals(kind)) removeDelivered(c, id);
            respond(c, id, kind, action, input == null ? null : input.toString(), payload);
            return true;
        }
        return false;
    }

    static void emit(String name, Object data) {
        MainActivity m = live;
        if (m != null) m.emit(name, data);
    }

    // ------------------------------------------------------------------ push

    /** Implemented by FcmPush (native/android/fcm), present only in FCM builds. */
    interface Push {
        void register(Context c, MainActivity.Reply r);
        void unregister(Context c, MainActivity.Reply r);
    }

    static Push push() {
        try {
            return (Push) Class.forName("dev.sveltedesktop.FcmPush").getDeclaredConstructor().newInstance();
        } catch (Throwable t) {
            return null;
        }
    }

    static JSONObject storedToken(Context c) throws Exception {
        String t = prefs(c).getString("pushToken", null);
        return t == null ? null : new JSONObject().put("provider", prefs(c).getString("pushProvider", "fcm")).put("token", t);
    }

    /** A token from register or the provider's rotation: stored; `pushToken` when it changed. */
    static void pushToken(Context c, String provider, String token) {
        String old = prefs(c).getString("pushToken", null);
        if (token == null) { prefs(c).edit().remove("pushToken").remove("pushProvider").apply(); return; }
        prefs(c).edit().putString("pushToken", token).putString("pushProvider", provider).apply();
        if (!token.equals(old)) {
            try { emit("pushToken", new JSONObject().put("provider", provider).put("token", token)); } catch (Exception ignored) {}
        }
    }

    /** A push, from FCM or UnifiedPush, as createPush sends it — `{id, title, body, subtitle, image,
     *  silent, payload, channel}`, no title for a background push. Every push is displayed here (FCM
     *  messages are data-only), so its taps carry our nonce like local notifications. The message is
     *  emitted whether or not displaying it worked. */
    static void received(Context c, JSONObject m, String fallbackId) {
        String id = str(m, "id");
        if (id == null) id = fallbackId;
        String title = str(m, "title"), payload = str(m, "payload");
        boolean fg = resumed;
        if (title != null && (!fg || showInForeground(c, null))) {
            try {
                JSONObject s = new JSONObject().put("id", id != null ? id : "push").put("title", title);
                for (String k : new String[] { "body", "subtitle", "payload", "group", "channel" }) if (str(m, k) != null) s.put(k, str(m, k));
                if (m.optBoolean("silent", false)) s.put("silent", true);
                if (s.has("channel") && nm(c).getNotificationChannel(s.getString("channel")) == null) s.remove("channel");
                String image = str(m, "image");
                if (image != null) s.put("image", image.startsWith("https://") ? download(c, image) : image.startsWith("data:") ? image : null);
                post(c, s, true);
            } catch (Exception e) {
                Log.w(TAG, "push not displayed", e);
            }
        }
        try {
            JSONObject msg = new JSONObject().put("data", m).put("foreground", fg).put("payload", orNull(payload));
            if (id != null) msg.put("id", id);
            if (title != null) msg.put("notification", new JSONObject().put("title", title).put("body", orNull(str(m, "body"))));
            emit("pushMessage", msg);
        } catch (Exception e) {
            Log.w(TAG, "push message", e);
        }
    }

    /** A push image (https): fetched on the messaging thread into the cache. */
    private static String download(Context c, String url) {
        if (!url.startsWith("https://")) return null;
        try {
            HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
            h.setConnectTimeout(5000);
            h.setReadTimeout(5000);
            File f = new File(c.getCacheDir(), "sd-push-image");
            try (InputStream in = h.getInputStream(); FileOutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[65536];
                int total = 0;
                for (int n; (n = in.read(buf)) > 0 && total < 8 << 20; total += n) out.write(buf, 0, n);
            } finally {
                h.disconnect();
            }
            return f.getAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

}
