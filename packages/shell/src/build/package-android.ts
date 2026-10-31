// Android packaging, called by packageApp (package.ts) when build.target is
// 'android'. Gradle-less: everything comes from the Android SDK build-tools and
// a JDK (Android Studio's bundled JBR works).
//
//   staged server (desktop-android.js) → bun build --compile
//     --target=bun-linux-<arm64|x64>-android → lib/<abi>/libappserver.so
//   AndroidManifest.xml (template) + icon + assets/sd-notifications.json
//     → aapt2 compile/link → base APK
//   native/android/src/**.java → javac → d8 → classes.dex
//   + classes*.dex + libs → zipalign -P 16 (16 KB pages) → apksigner
//
// push.fcm (google-services.json): Firebase Messaging and its closure (pinned AARs/JARs
// from Google Maven + Maven Central, cached in ~/.cache/svelte-desktop/maven) join the
// build — classes.jar on the javac classpath and into d8, AAR resources linked as
// overlays with R classes generated for their packages, library manifest entries merged,
// google-services.json turned into the plugin's string resources — together with
// native/android/fcm/**.java. Without it the APK has no Firebase code at all.
//
// Runtime contract (native/android): the host spawns libappserver.so from
// nativeLibraryDir (installer-extracted, exec-allowed under W^X) with
// SVELTE_DESKTOP_SECRET, reads the READY line and loads the gate's auth URL.
//
// Signing: sign.android {keystore, alias, password} or $ANDROID_KEYSTORE
// (+ $ANDROID_KEYSTORE_ALIAS, $ANDROID_KEYSTORE_PASSWORD); otherwise
// ~/.android/debug.keystore, created on first use like Android Studio does.
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedConfig } from "../config.ts";
import type { PackageResult } from "./package.ts";

const log = (s: string) => console.log(`  \x1b[36m▸\x1b[0m ${s}`);
const mb = (p: string) => `${(statSync(p).size / 1048576).toFixed(1)} MB`;
const hostDir = resolve(import.meta.dir, "../../native/android");
const ABI = { arm64: "arm64-v8a", x64: "x86_64" } as const;
const MIN_SDK = 26;
const TARGET_SDK = 35;

const byVersion = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

/** Locate the SDK, its newest build-tools and platform, and a JDK. */
export function androidToolchain() {
  const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library/Android/sdk"), join(homedir(), "Android/Sdk")].find(
    (p): p is string => !!p && existsSync(p),
  );
  if (!sdk) throw new Error("Android SDK not found: set ANDROID_HOME (Android Studio installs it in ~/Library/Android/sdk)");
  const bt = existsSync(join(sdk, "build-tools")) ? readdirSync(join(sdk, "build-tools")).sort(byVersion)[0] : undefined;
  if (!bt) throw new Error(`no build-tools in ${sdk}: sdkmanager "build-tools;36.0.0"`);
  const platform = existsSync(join(sdk, "platforms")) ? readdirSync(join(sdk, "platforms")).filter((p) => existsSync(join(sdk, "platforms", p, "android.jar"))).sort(byVersion)[0] : undefined;
  if (!platform) throw new Error(`no platform in ${sdk}: sdkmanager "platforms;android-35"`);
  const java = [
    process.env.JAVA_HOME,
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    join(homedir(), "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
    "/opt/android-studio/jbr",
  ].find((p): p is string => !!p && existsSync(join(p, "bin", "javac")));
  if (!java) throw new Error("no JDK found: set JAVA_HOME (Android Studio's bundled JBR works)");
  const tools = join(sdk, "build-tools", bt);
  return {
    sdk,
    buildTools: bt,
    androidJar: join(sdk, "platforms", platform, "android.jar"),
    aapt2: join(tools, "aapt2"),
    d8: join(tools, "d8"),
    zipalign: join(tools, "zipalign"),
    apksigner: join(tools, "apksigner"),
    javac: join(java, "bin", "javac"),
    keytool: join(java, "bin", "keytool"),
    javaHome: java,
  };
}

/** Reverse-DNS identifier → a valid Java package name ("dev.svelte-desktop.notes" → "dev.svelte_desktop.notes"). */
export function androidPackageName(identifier: string): string {
  const parts = identifier
    .split(".")
    .map((p) => p.replace(/[^A-Za-z0-9_]/g, "_"))
    .filter(Boolean)
    .map((p) => (/^[0-9]/.test(p) ? `_${p}` : p));
  if (parts.length < 2) parts.unshift("app");
  return parts.join(".");
}

/** "1.2.3" → 10203 (major·10000 + minor·100 + patch). */
export function androidVersionCode(version: string): number {
  const [a = 0, b = 0, c = 0] = version.split(/[.+-]/).map((n) => Number.parseInt(n, 10) || 0);
  return Math.max(1, a * 10000 + b * 100 + c);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Library manifest entries merged into the app's (FCM builds): see fcmManifestEntries. */
export type MergedEntries = { permissions: string[]; application: string };

export function androidManifest(c: ResolvedConfig, opts: { icon: boolean; fcm?: MergedEntries }): string {
  const schemes = (c.schemes ?? [])
    .map(
      (s) => `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${xml(s)}" />
            </intent-filter>`,
    )
    .join("");
  // Runtime permissions follow `permissions`, as Info.plist usage strings do on macOS.
  const PERMISSIONS: Record<string, string[]> = {
    camera: ["android.permission.CAMERA"],
    microphone: ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"],
    location: ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"],
    contacts: ["android.permission.READ_CONTACTS"],
    calendars: ["android.permission.READ_CALENDAR"],
  };
  const declared = ["android.permission.INTERNET", "android.permission.POST_NOTIFICATIONS", "android.permission.RECEIVE_BOOT_COMPLETED"];
  const permissions = [...new Set([...Object.keys(c.osPermissions).flatMap((k) => PERMISSIONS[k] ?? []), ...(opts.fcm?.permissions ?? [])])]
    .filter((p) => !declared.includes(p))
    .map((p) => `\n    <uses-permission android:name="${p}" />`)
    .join("");
  // FCM: our PushService takes MESSAGING_EVENT (the SDK's own service sits at priority -500), no token
  // before push.register (auto-init off), FCM-displayed notifications use the default channel.
  // UnifiedPush (push.unifiedPush, default on): the connector's receiver (exported: distributors
  // are other apps; intents are checked against our token), the service a distributor binds to
  // raise us while it delivers, and package visibility of distributors (REGISTER receivers, link activity).
  const unifiedPush = c.push?.unifiedPush !== false;
  const upEntries = unifiedPush
    ? `
        <receiver android:name="dev.sveltedesktop.UnifiedPushReceiver" android:exported="true">
            <intent-filter>
                <action android:name="org.unifiedpush.android.connector.NEW_ENDPOINT" />
                <action android:name="org.unifiedpush.android.connector.MESSAGE" />
                <action android:name="org.unifiedpush.android.connector.REGISTRATION_FAILED" />
                <action android:name="org.unifiedpush.android.connector.UNREGISTERED" />
                <action android:name="org.unifiedpush.android.connector.TEMP_UNAVAILABLE" />
            </intent-filter>
        </receiver>
        <service android:name="dev.sveltedesktop.UnifiedPushService" android:exported="true">
            <intent-filter>
                <action android:name="org.unifiedpush.android.connector.RAISE_TO_FOREGROUND" />
            </intent-filter>
        </service>`
    : "";
  const queries = unifiedPush
    ? `
    <queries>
        <intent>
            <action android:name="org.unifiedpush.android.distributor.REGISTER" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="unifiedpush" android:host="link" />
        </intent>
    </queries>`
    : "";
  const application = upEntries + (opts.fcm
    ? `${opts.fcm.application}
        <service android:name="dev.sveltedesktop.PushService" android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
        <meta-data android:name="firebase_messaging_auto_init_enabled" android:value="false" />
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="${xml(defaultChannel(c))}" />`
    : "");
  return readFileSync(join(hostDir, "AndroidManifest.xml"), "utf8")
    .replace("__PERMISSIONS__", permissions)
    .replace("__QUERIES__", queries)
    .replaceAll("__PACKAGE__", androidPackageName(c.identifier))
    .replaceAll("__LABEL__", xml(c.appName))
    .replaceAll("__IDENTIFIER__", xml(c.identifier))
    .replace("__ICON__", opts.icon ? '\n        android:icon="@mipmap/ic_launcher"' : "")
    .replace("__SCHEMES__", schemes)
    .replace("__APPLICATION__", application)
    .replace(
      "__META__",
      c.bridgeAllow ? `\n        <meta-data android:name="sd.pagePermissions" android:value="${xml(c.bridgeAllow.join(","))}" />` : "",
    );
}

// ---------------------------------------------------------------- notifications + FCM

/** The first configured channel, else "default" (Notifier.defaultChannel on the device). */
export function defaultChannel(c: ResolvedConfig): string {
  return c.notifications?.channels?.[0]?.id ?? "default";
}

/** assets/sd-notifications.json, read by the host at startup (Notifier.config): channels to create,
 *  the foreground-banner default, whether FCM is in the build. */
export function notificationsAsset(c: ResolvedConfig): string {
  const channels = c.notifications?.channels ?? [];
  const ids = new Set<string>();
  for (const ch of channels) {
    if (!ch?.id || !ch.name) throw new Error("notifications.channels: every channel needs an `id` and a `name`");
    if (ids.has(ch.id)) throw new Error(`notifications.channels: duplicate id "${ch.id}"`);
    ids.add(ch.id);
  }
  return JSON.stringify({ channels, foreground: c.notifications?.foreground ?? true, fcm: !!c.push?.fcm, unifiedPush: c.push?.unifiedPush !== false });
}

const resString = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/^([@?])/, "\\$1");

/** google-services.json → the string resources the google-services Gradle plugin generates for
 *  `pkg` (FirebaseApp reads them at startup through FirebaseInitProvider). */
export function googleServicesValues(json: any, pkg: string): string {
  const clients: any[] = Array.isArray(json?.client) ? json.client : [];
  const client = clients.find((x) => x?.client_info?.android_client_info?.package_name === pkg);
  if (!client) {
    const found = clients.map((x) => x?.client_info?.android_client_info?.package_name).filter(Boolean);
    throw new Error(`google-services.json has no Android app "${pkg}" (it has: ${found.join(", ") || "none"}): add one with that package name in the Firebase console`);
  }
  const p = json.project_info ?? {};
  const key = client.api_key?.find((k: any) => k?.current_key)?.current_key;
  const values: Record<string, string | undefined> = {
    google_app_id: client.client_info?.mobilesdk_app_id,
    gcm_defaultSenderId: p.project_number,
    google_api_key: key,
    google_crash_reporting_api_key: key,
    project_id: p.project_id,
    google_storage_bucket: p.storage_bucket,
    firebase_database_url: p.firebase_url,
    default_web_client_id: client.oauth_client?.find((o: any) => o?.client_type === 3)?.client_id,
  };
  for (const k of ["google_app_id", "gcm_defaultSenderId", "google_api_key", "project_id"]) {
    if (!values[k]) throw new Error(`google-services.json: no value for ${k}`);
  }
  const lines = Object.entries(values)
    .filter(([, v]) => v)
    .map(([k, v]) => `    <string name="${k}" translatable="false">${resString(String(v))}</string>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- generated from google-services.json by svelte-desktop -->\n<resources>\n${lines.join("\n")}\n</resources>\n`;
}

/** The library manifest entries FCM needs, merged once by scripts/fcm-pin.ts when the pins change
 *  (native/android/fcm/manifest-entries.json, with `${applicationId}` left in): a build only fills
 *  in the package. */
export function fcmManifestEntries(applicationId: string): MergedEntries {
  const file = join(hostDir, "fcm", "manifest-entries.json");
  const e = JSON.parse(readFileSync(file, "utf8")) as Partial<MergedEntries>;
  if (!Array.isArray(e.permissions) || typeof e.application !== "string") throw new Error(`${file}: run scripts/fcm-pin.ts`);
  return { permissions: e.permissions, application: e.application.replaceAll("${applicationId}", applicationId) };
}

// Firebase Cloud Messaging and its runtime closure, resolved once from the POMs of
// firebase-messaging 24.1.2 (highest version wins, as Gradle does) and pinned with
// their sha256. Downloaded from Google's Maven repository and Maven Central into
// ~/.cache/svelte-desktop/maven. (25.x+ pull androidx.datastore's Kotlin Multiplatform
// artifacts, whose Android variants need Gradle module metadata to select.)
const FCM_ARTIFACTS = `
  androidx.activity:activity:1.0.0@aar d1bc9842455c2e534415d88c44df4d52413b478db9093a1ba36324f705f44c3d
  androidx.annotation:annotation:1.5.0@jar 261fb7c0210858500bab66d34354972a75166ab4182add283780b05513d6ec4a
  androidx.arch.core:core-common:2.1.0@jar fe1237bf029d063e7f29fe39aeaf73ef74c8b0a3658486fc29d3c54326653889
  androidx.arch.core:core-runtime:2.0.0@aar 87e65fc767c712b437649c7cee2431ebb4bed6daef82e501d4125b3ed3f65f8e
  androidx.asynclayoutinflater:asynclayoutinflater:1.0.0@aar f7eab60c57addd94bb06275832fe7600611beaaae1a1ec597c231956faf96c8b
  androidx.collection:collection:1.1.0@jar 632a0e5407461de774409352940e292a291037724207a787820c77daf7d33b72
  androidx.concurrent:concurrent-futures:1.1.0@jar 0ce067c514a0d1049d1bebdf709e344ed3266fe9744275682937cdcb13334e9e
  androidx.coordinatorlayout:coordinatorlayout:1.0.0@aar e508c695489493374d942bf7b4ee02abf7571d25aac4c622e57d6cd5cd29eb73
  androidx.core:core:1.2.0@aar 524b8b88ceb6a74a7e44e6b567a135660f211799904cb218bfee5be1166820b2
  androidx.cursoradapter:cursoradapter:1.0.0@aar a81c8fe78815fa47df5b749deb52727ad11f9397da58b16017f4eb2c11e28564
  androidx.customview:customview:1.0.0@aar 20e5b8f6526a34595a604f56718da81167c0b40a7a94a57daa355663f2594df2
  androidx.documentfile:documentfile:1.0.0@aar 865a061ef2fad16522f8433536b8d47208c46ff7c7745197dfa1eeb481869487
  androidx.drawerlayout:drawerlayout:1.0.0@aar 9402442cdc5a43cf62fb14f8cf98c63342d4d9d9b805c8033c6cf7e802749ac1
  androidx.fragment:fragment:1.1.0@aar a14c8b8f2153f128e800fbd266a6beab1c283982a29ec570d2cc05d307d81496
  androidx.interpolator:interpolator:1.0.0@aar 33193135a64fe21fa2c35eec6688f1a76e512606c0fc83dc1b689e37add7732a
  androidx.legacy:legacy-support-core-ui:1.0.0@aar 0d1260c6e7e6a337f875df71b516931e703f716e90889817cd3a20fa5ac3d947
  androidx.legacy:legacy-support-core-utils:1.0.0@aar a7edcf01d5b52b3034073027bc4775b78a4764bb6202bb91d61c829add8dd1c7
  androidx.lifecycle:lifecycle-common:2.1.0@jar 76db6be533bd730fb361c2feb12a2c26d9952824746847da82601ef81f082643
  androidx.lifecycle:lifecycle-livedata:2.0.0@aar c82609ced8c498f0a701a30fb6771bb7480860daee84d82e0a81ee86edf7ba39
  androidx.lifecycle:lifecycle-livedata-core:2.0.0@aar fde334ec7e22744c0f5bfe7caf1a84c9d717327044400577bdf9bd921ec4f7bc
  androidx.lifecycle:lifecycle-runtime:2.1.0@aar e5173897b965e870651e83d9d5af1742d3f532d58863223a390ce3a194c8312b
  androidx.lifecycle:lifecycle-viewmodel:2.1.0@aar ba55fb7ac1b2828d5327cda8acf7085d990b2b4c43ef336caa67686249b8523d
  androidx.loader:loader:1.0.0@aar 11f735cb3b55c458d470bed9e25254375b518b4b1bad6926783a7026db0f5025
  androidx.localbroadcastmanager:localbroadcastmanager:1.0.0@aar e71c328ceef5c4a7d76f2d86df1b65d65fe2acf868b1a4efd84a3f34336186d8
  androidx.print:print:1.0.0@aar 1d5c7f3135a1bba661fc373fd72e11eb0a4adbb3396787826dd8e4190d5d9edd
  androidx.savedstate:savedstate:1.0.0@aar 2510a5619c37579c9ce1a04574faaf323cd0ffe2fc4e20fa8f8f01e5bb402e83
  androidx.slidingpanelayout:slidingpanelayout:1.0.0@aar 76bffb7cefbf780794d8817002dad1562f3e27c0a9f746d62401c8edb30aeede
  androidx.swiperefreshlayout:swiperefreshlayout:1.0.0@aar 9761b3a809c9b093fd06a3c4bbc645756dec0e95b5c9da419bc9f2a3f3026e8d
  androidx.versionedparcelable:versionedparcelable:1.1.0@aar 9a1d77140ac222b7866b5054ee7d159bc1800987ed2d46dd6afdd145abb710c1
  androidx.viewpager:viewpager:1.0.0@aar 147af4e14a1984010d8f155e5e19d781f03c1d70dfed02a8e0d18428b8fc8682
  com.google.android.datatransport:transport-api:3.1.0@aar 7dafc39f0ea835473366acc346f7e67fc8443f4c645d999c3e987bcad6b88c7b
  com.google.android.datatransport:transport-backend-cct:3.1.9@aar 07a32025a65b08ee7e11d14dc539a758b66713f0c1d13900a81599ceadbaf44d
  com.google.android.datatransport:transport-runtime:3.1.9@aar 41745c5b8f427d24439015b84f651ad420718991867d2afc262c264009b802c1
  com.google.android.gms:play-services-base:18.1.0@aar 4eca56ceecd4325a376cd843af56377e2376ce284d0c6f05a5d0a82f4c1bf8cd
  com.google.android.gms:play-services-basement:18.3.0@aar 6c11ae3eb2dd7f17373f919c4c557a70e4cf891bc0c9b66926a0a6445d654352
  com.google.android.gms:play-services-cloud-messaging:17.2.0@aar 27255e7fe9706483816b158db25cf319f6a26a0566feff41597ce8807a350e37
  com.google.android.gms:play-services-stats:17.0.2@aar dd4314a53f49a378ec146103d36232b96c75454d29526336ccbdf132941764d3
  com.google.android.gms:play-services-tasks:18.1.0@aar d60575eae39350e6234858bc9d7d775375707ae82a684e6caf7f3e41a12e25a2
  com.google.errorprone:error_prone_annotations:2.26.0@jar 53cdfc0beb2d766fe03b78f0b11d020554cd419879d20380c38fa1dcf2ba1b50
  com.google.firebase:firebase-annotations:16.2.0@jar 46f6d5dfdd2ccf3c40de897a14bd9779314c3319f44bfd31e7e0a20d935a5e3e
  com.google.firebase:firebase-common:21.0.0@aar 379287d7171371512493681b398e78c341b333cf974ee81a18b1d56e7c2e385d
  com.google.firebase:firebase-common-ktx:21.0.0@aar 25fc80c9bb9ecb1672908718c294afcc4ac1e47473677be060c795e04f120066
  com.google.firebase:firebase-components:18.0.0@aar c7c48a3a80f44a499ebd6473bcfc7dd5a45ef523fabe2414a62515ff3c640972
  com.google.firebase:firebase-datatransport:18.2.0@aar b2b28f6ba173f5e0c4fe3d36a2d7ee5239c7acbf4143b549ecf031a3485b35bb
  com.google.firebase:firebase-encoders:17.0.0@jar 282a5a703f9b7eb56508dde97ea918e95d73318b157050f457f7a86dca750150
  com.google.firebase:firebase-encoders-json:18.0.0@aar 80aece7e1ef58957ca2fc1957bc9208ec92a3a9528201331d3c63e3182570f97
  com.google.firebase:firebase-encoders-proto:16.0.0@jar 293db96a0d1d43f033167881b638d8fde844e4e5495f5101cf52295765295e0e
  com.google.firebase:firebase-iid-interop:17.1.0@aar 0b7c3721c84b62e70415307239ed4a7f998989084bf2833f90b9f5bea3095a05
  com.google.firebase:firebase-installations:17.2.0@aar de011e6a3b7961de638f172f2cb66ba304eaa989662a9e2b0f48dff774ccc166
  com.google.firebase:firebase-installations-interop:17.1.1@aar fac650680f7921f4ab92f0bb21a09234b12cdaefab2cf70188281d7ea52b8dad
  com.google.firebase:firebase-measurement-connector:19.0.0@aar dba74d6bf94647ee397bf7afb2ab07f6fe8d13157e56785fa540a2a13ed82c99
  com.google.firebase:firebase-messaging:24.1.2@aar 8d587f7f3724d5c3c912a95eecf72b01725462317cd3156dd222301956947661
  com.google.guava:listenablefuture:1.0@jar e4ad7607e5c0477c6f890ef26a49cb8d1bb4dffb650bab4502afee64644e3069
  javax.inject:javax.inject:1@jar 91c77044a50c481636c32d916fd89c9118a72195390452c81065080f957de7ff
  org.jetbrains.kotlin:kotlin-stdlib:1.8.22@jar 03a5c3965cc37051128e64e46748e394b6bd4c97fa81c6de6fc72bfd44e3421b
  org.jetbrains.kotlin:kotlin-stdlib-common:1.8.22@jar d0c2365e2437ef70f34586d50f055743f79716bcfe65e4bc7239cdd2669ef7c5
  org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.8.22@jar 055f5cb24287fa106100995a7b47ab92126b81e832e875f5fa2cf0bd55693d0b
  org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.8.22@jar 4198b0eaf090a4f25b6f7e5a59581f4314ba8c9f6cd1d13ee9d348e65ed8f707
  org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.6.4@jar c24c8bb27bb320c4a93871501a7e5e0c61607638907b197aef675513d4c820be
  org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.6.4@jar 4ee3784c3465caab86adcc4f93956d56ea662aac82e5c2c83ca3c1f0415fe397
  org.jetbrains:annotations:13.0@jar ace2a10dc8e2d5fd34925ecac03e4988b2c0f851650c94b8cef49ba1bd111478
`
  .trim()
  .split("\n")
  .map((l) => {
    const [coord, sha256] = l.trim().split(/\s+/) as [string, string];
    const [gav, ext] = coord.split("@") as [string, "aar" | "jar"];
    const [group, artifact, version] = gav.split(":") as [string, string, string];
    return { group, artifact, version, ext, sha256 };
  });
const GOOGLE_MAVEN = "https://dl.google.com/dl/android/maven2";
const MAVEN_CENTRAL = "https://repo1.maven.org/maven2";

export const fcmArtifacts = () => FCM_ARTIFACTS.map((a) => ({ ...a }));

export type AndroidLibrary = { name: string; jars: string[]; manifest?: string; res?: string; package?: string; hasR: boolean };

/** Downloads (once, checked against the pins) and unpacks the FCM libraries. */
export async function fcmLibraries(): Promise<AndroidLibrary[]> {
  const cache = process.env.SVELTE_DESKTOP_MAVEN_CACHE ?? join(homedir(), ".cache", "svelte-desktop", "maven");
  const out: AndroidLibrary[] = [];
  let fetched = 0;
  for (const a of FCM_ARTIFACTS) {
    const file = join(cache, a.group, `${a.artifact}-${a.version}.${a.ext}`);
    const sha = async () => existsSync(file) && new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex") === a.sha256;
    if (!(await sha())) {
      const repo = /^(androidx\.|com\.google\.android\.|com\.google\.firebase)/.test(a.group) ? GOOGLE_MAVEN : MAVEN_CENTRAL;
      const url = `${repo}/${a.group.replace(/\./g, "/")}/${a.artifact}/${a.version}/${a.artifact}-${a.version}.${a.ext}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FCM: download failed (${res.status}) ${url}`);
      mkdirSync(join(cache, a.group), { recursive: true });
      await Bun.write(file, res);
      if (!(await sha())) {
        rmSync(file, { force: true });
        throw new Error(`FCM: sha256 mismatch for ${url}`);
      }
      fetched++;
    }
    const name = `${a.group}:${a.artifact}`;
    if (a.ext === "jar") {
      out.push({ name, jars: [file], hasR: false });
      continue;
    }
    const dir = `${file}.d`;
    if (!existsSync(join(dir, ".ok"))) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      await run(`unzip ${a.artifact}`, $`unzip -q -o ${file} -d ${dir}`.nothrow().quiet());
      writeFileSync(join(dir, ".ok"), "");
    }
    const jars = [join(dir, "classes.jar"), ...(existsSync(join(dir, "libs")) ? readdirSync(join(dir, "libs")).filter((f) => f.endsWith(".jar")).map((f) => join(dir, "libs", f)) : [])].filter((f) => existsSync(f));
    const manifest = existsSync(join(dir, "AndroidManifest.xml")) ? readFileSync(join(dir, "AndroidManifest.xml"), "utf8") : undefined;
    const res = existsSync(join(dir, "res")) && readdirSync(join(dir, "res")).length ? join(dir, "res") : undefined;
    const rTxt = existsSync(join(dir, "R.txt")) ? readFileSync(join(dir, "R.txt"), "utf8").trim() : "";
    out.push({ name, jars, manifest, res, package: manifest ? /\bpackage="([^"]+)"/.exec(manifest)?.[1] : undefined, hasR: rTxt.length > 0 });
  }
  if (fetched) log(`FCM: fetched ${fetched} Maven artifacts into ${cache.replace(homedir(), "~")}`);
  return out;
}

/** The newest NDK: $ANDROID_NDK_HOME, else <sdk>/ndk/<version>. */
export function androidNdk(sdk: string): string | null {
  if (process.env.ANDROID_NDK_HOME && existsSync(process.env.ANDROID_NDK_HOME)) return process.env.ANDROID_NDK_HOME;
  const dir = join(sdk, "ndk");
  const v = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "toolchains"))).sort(byVersion)[0] : undefined;
  return v ? join(dir, v) : null;
}

/** native/addons/*.c|cc|cpp → <outDir>/<name>.so for one ABI. Prebuilt `addons` are host binaries: skipped. */
export async function buildAndroidAddons(c: ResolvedConfig, arch: "arm64" | "x64", outDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const dir = c.native ? join(c.native, "addons") : null;
  const sources = dir && existsSync(dir) ? readdirSync(dir).filter((f) => /\.(c|cc|cpp)$/.test(f)) : [];
  for (const name of Object.keys(c.addons ?? {})) console.log(`  \x1b[33m!\x1b[0m addon "${name}": prebuilt addons are host binaries, not packaged for Android`);
  if (!sources.length) return out;
  const ndk = androidNdk(androidToolchain().sdk);
  if (!ndk) {
    console.log(`  \x1b[33m!\x1b[0m addons ${sources.join(", ")}: no Android NDK (sdkmanager "ndk;30.0.16248370" or ANDROID_NDK_HOME), skipped`);
    return out;
  }
  const host = readdirSync(join(ndk, "toolchains/llvm/prebuilt"))[0]!;
  const bin = join(ndk, "toolchains/llvm/prebuilt", host, "bin");
  const triple = `${arch === "arm64" ? "aarch64" : "x86_64"}-linux-android${MIN_SDK}`;
  mkdirSync(outDir, { recursive: true });
  const napi = resolve(import.meta.dir, "../../native/vendor/node-api/include");
  for (const entry of sources) {
    const name = entry.replace(/\.[^.]+$/, "");
    const cpp = /\.(cc|cpp)$/.test(entry);
    const target = join(outDir, `${name}.so`);
    // napi_* symbols resolve against the Bun executable at dlopen time; 16 KB pages for Android 15+.
    await run(
      `addon ${entry}`,
      $`${join(bin, cpp ? "clang++" : "clang")} --target=${triple} -shared -fPIC -O2 -Wl,-z,max-page-size=16384 -Wl,--allow-shlib-undefined -I${napi} ${cpp ? ["-std=c++17", "-static-libstdc++"] : []} ${join(dir!, entry)} -o ${target}`
        .nothrow()
        .quiet(),
    );
    out[name] = target;
  }
  return out;
}

function ndkClang(ndk: string, arch: "arm64" | "x64", cpp: boolean) {
  const host = readdirSync(join(ndk, "toolchains/llvm/prebuilt"))[0]!;
  return {
    cc: join(ndk, "toolchains/llvm/prebuilt", host, "bin", cpp ? "clang++" : "clang"),
    target: `--target=${arch === "arm64" ? "aarch64" : "x86_64"}-linux-android${MIN_SDK}`,
  };
}

/** native/*.c|cc|cpp (+ native/android/) → libapp-native.so, and the JNI plugin host → libsdhost.so. */
export async function buildAndroidPlugin(c: ResolvedConfig, arch: "arm64" | "x64", outDir: string): Promise<{ plugin: string; host: string } | null> {
  if (!c.native) return null;
  const { pluginSources } = await import("./native.ts");
  const all = pluginSources(c.native, "android");
  const sources = all.filter((f) => /\.(c|cc|cpp)$/.test(f));
  const skipped = all.filter((f) => !sources.includes(f));
  if (skipped.length) console.log(`  \x1b[33m!\x1b[0m native plugin: ${skipped.map((f) => f.replace(`${c.root}/`, "")).join(", ")} skipped on Android (Swift / Objective-C are Apple-only)`);
  if (!sources.length) return null;
  const ndk = androidNdk(androidToolchain().sdk);
  if (!ndk) {
    console.log(`  \x1b[33m!\x1b[0m native plugin: no Android NDK (sdkmanager "ndk;30.0.16248370" or ANDROID_NDK_HOME), skipped`);
    return null;
  }
  mkdirSync(outDir, { recursive: true });
  const include = resolve(import.meta.dir, "../../native/include");
  const cpp = sources.some((f) => /\.(cc|cpp)$/.test(f));
  const { cc, target } = ndkClang(ndk, arch, cpp);
  const plugin = join(outDir, "libapp-native.so");
  const page = "-Wl,-z,max-page-size=16384";
  await run(
    "native plugin",
    $`${cc} ${target} -shared -fPIC -O2 ${page} -I${include} ${cpp ? ["-std=c++17", "-static-libstdc++"] : []} ${sources} -o ${plugin}`.nothrow().quiet(),
  );
  const shim = ndkClang(ndk, arch, false);
  const host = join(outDir, "libsdhost.so");
  await run(
    "plugin host",
    $`${shim.cc} ${shim.target} -shared -fPIC -O2 ${page} -I${include} ${join(hostDir, "jni", "sd_host_android.c")} -llog -ldl -o ${host}`.nothrow().quiet(),
  );
  return { plugin, host };
}

/** ELF machine of a file (183 = aarch64, 62 = x86_64), or null when it isn't ELF. */
function elfMachine(file: string): number | null {
  const b = readFileSync(file).subarray(0, 20);
  if (b.length < 20 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46) return null;
  return b.readUInt16LE(18);
}

/** Sidecars for one ABI: prebuilt `sidecars` entries for android (checked: ELF of the
 *  right machine), plus C/C++ sources in native/sidecars/ and native/android/sidecars/
 *  compiled with the NDK as position-independent executables. */
export async function androidSidecars(c: ResolvedConfig, arch: "arm64" | "x64", outDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const want = arch === "arm64" ? 183 : 62;
  const { sidecarEntries } = await import("../config.ts");
  for (const [name, from] of sidecarEntries(c, "android")) {
    if (!existsSync(from)) throw new Error(`sidecar "${name}": ${from} not found`);
    const m = elfMachine(from);
    if (m !== want) {
      console.log(`  \x1b[33m!\x1b[0m sidecar "${name}": ${from.replace(`${c.root}/`, "")} is not an Android ${arch} executable (skipped; use sidecars.${name}.android)`);
      continue;
    }
    out[name] = from;
  }
  const dirs = c.native ? [join(c.native, "sidecars"), join(c.native, "android", "sidecars")].filter((d) => existsSync(d)) : [];
  const sources = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.(c|cc|cpp)$/.test(f)).map((f) => join(d, f)));
  if (!sources.length) return out;
  const ndk = androidNdk(androidToolchain().sdk);
  if (!ndk) {
    console.log(`  \x1b[33m!\x1b[0m sidecar sources: no Android NDK (sdkmanager "ndk;30.0.16248370" or ANDROID_NDK_HOME), skipped`);
    return out;
  }
  mkdirSync(outDir, { recursive: true });
  for (const src of sources) {
    const name = src.split("/").pop()!.replace(/\.[^.]+$/, "");
    const cpp = /\.(cc|cpp)$/.test(src);
    const { cc, target } = ndkClang(ndk, arch, cpp);
    const exe = join(outDir, name);
    await run(`sidecar ${name}`, $`${cc} ${target} -fPIE -pie -O2 -Wl,-z,max-page-size=16384 ${cpp ? ["-std=c++17", "-static-libstdc++"] : []} ${src} -o ${exe}`.nothrow().quiet());
    out[name] = exe;
  }
  return out;
}

// bundletool is not part of the SDK: $BUNDLETOOL_JAR, or this pinned release
// downloaded once into ~/.cache/svelte-desktop and checked against its sha256.
const BUNDLETOOL = {
  version: "1.18.3",
  url: "https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar",
  sha256: "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29",
};

export async function bundletoolJar(): Promise<string> {
  if (process.env.BUNDLETOOL_JAR) return process.env.BUNDLETOOL_JAR;
  const jar = join(homedir(), ".cache", "svelte-desktop", `bundletool-all-${BUNDLETOOL.version}.jar`);
  const ok = async () => existsSync(jar) && new Bun.CryptoHasher("sha256").update(await Bun.file(jar).arrayBuffer()).digest("hex") === BUNDLETOOL.sha256;
  if (await ok()) return jar;
  log(`downloading bundletool ${BUNDLETOOL.version}`);
  mkdirSync(join(homedir(), ".cache", "svelte-desktop"), { recursive: true });
  const res = await fetch(BUNDLETOOL.url);
  if (!res.ok) throw new Error(`bundletool download failed: ${res.status} (set BUNDLETOOL_JAR)`);
  await Bun.write(jar, res);
  if (!(await ok())) {
    rmSync(jar, { force: true });
    throw new Error("bundletool download: sha256 mismatch");
  }
  return jar;
}

/** The same module as the APK, in bundle form: proto resources, dex/, lib/ — then bundletool + jarsigner. */
async function buildAab(o: {
  tc: ReturnType<typeof androidToolchain>;
  env: Record<string, string | undefined>;
  linkArgs: string[];
  work: string;
  libs: string[];
  dexes: string[];
  aab: string;
  key: { keystore: string; alias: string; password: string };
}) {
  const { tc, env, work } = o;
  const java = join(tc.javaHome, "bin", "java");
  const proto = join(work, "base-proto.apk");
  await run("aapt2 link (proto)", $`${tc.aapt2} link --proto-format ${o.linkArgs} -o ${proto}`.nothrow().quiet());
  const mod = join(work, "aab-base");
  rmSync(mod, { recursive: true, force: true });
  mkdirSync(join(mod, "manifest"), { recursive: true });
  mkdirSync(join(mod, "dex"), { recursive: true });
  await run("unzip", $`unzip -q -o ${proto} -d ${mod}`.nothrow().quiet());
  await $`mv ${join(mod, "AndroidManifest.xml")} ${join(mod, "manifest", "AndroidManifest.xml")}`.quiet();
  for (const dex of o.dexes) copyFileSync(join(work, dex), join(mod, "dex", dex));
  for (const lib of o.libs) {
    mkdirSync(join(mod, lib, ".."), { recursive: true });
    copyFileSync(join(work, lib), join(mod, lib));
  }
  const base = join(work, "base.zip");
  rmSync(base, { force: true });
  await run("zip", $`zip -q -r ${base} .`.cwd(mod).nothrow().quiet());
  // The server executable must be extracted to nativeLibraryDir: keep native libraries compressed.
  const config = join(work, "BundleConfig.json");
  writeFileSync(config, JSON.stringify({ optimizations: { uncompressNativeLibraries: { enabled: false } } }));
  rmSync(o.aab, { force: true });
  const jar = await bundletoolJar();
  await run("bundletool build-bundle", $`${java} -jar ${jar} build-bundle --modules=${base} --config=${config} --output=${o.aab}`.env(env).nothrow().quiet());
  await run(
    "jarsigner",
    $`${join(tc.javaHome, "bin", "jarsigner")} -sigalg SHA256withRSA -digestalg SHA-256 -keystore ${o.key.keystore} -storepass ${o.key.password} -keypass ${o.key.password} ${o.aab} ${o.key.alias}`
      .env(env)
      .nothrow()
      .quiet(),
  );
  await run("bundletool validate", $`${java} -jar ${jar} validate --bundle=${o.aab}`.env(env).nothrow().quiet());
}

async function run(what: string, p: Promise<{ exitCode: number; stderr: Buffer; stdout: Buffer }>) {
  const r = await p;
  if (r.exitCode !== 0) throw new Error(`${what} failed:\n${r.stderr.toString()}${r.stdout.toString().slice(-2000)}`);
  return r;
}

async function signingKey(c: ResolvedConfig, keytool: string) {
  const a = c.sign?.android;
  const keystore = a?.keystore ? resolve(c.root, a.keystore) : process.env.ANDROID_KEYSTORE;
  if (keystore) {
    const password = a?.password ?? process.env.ANDROID_KEYSTORE_PASSWORD;
    if (!password) throw new Error("Android keystore set without a password (sign.android.password or $ANDROID_KEYSTORE_PASSWORD)");
    return { keystore, alias: a?.alias ?? process.env.ANDROID_KEYSTORE_ALIAS ?? "release", password, debug: false };
  }
  const debug = join(homedir(), ".android", "debug.keystore");
  if (!existsSync(debug)) {
    mkdirSync(join(homedir(), ".android"), { recursive: true });
    log("creating ~/.android/debug.keystore");
    await run(
      "keytool",
      $`${keytool} -genkeypair -v -keystore ${debug} -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname ${"CN=Android Debug,O=Android,C=US"}`.nothrow().quiet(),
    );
  }
  return { keystore: debug, alias: "androiddebugkey", password: "android", debug: true };
}

export async function packageAndroid(c: ResolvedConfig, stage: string): Promise<PackageResult> {
  const t0 = performance.now();
  const tc = androidToolchain();
  const dist = resolve(c.root, c.build?.outDir ?? ".desktop/dist");
  const work = join(resolve(dist, ".."), "work", "android");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(dist, { recursive: true });
  // One ABI, or several (`targetArch: ['arm64', 'x64']`): one APK carrying both, and an AAB that Play splits per device.
  const wanted = c.build?.androidArch ?? c.build?.targetArch ?? "arm64";
  const arches = [...new Set(Array.isArray(wanted) ? wanted : [wanted])] as ("arm64" | "x64")[];
  const env = { ...process.env, JAVA_HOME: tc.javaHome, PATH: `${join(tc.javaHome, "bin")}:${process.env.PATH}` };
  log(`Android SDK ${tc.sdk} (build-tools ${tc.buildTools}, ${tc.androidJar.split("/").at(-2)})`);

  // 1. server executables → lib/<abi>/libappserver.so
  const bun = c.build?.bun ?? process.env.SVELTE_DESKTOP_BUN ?? process.execPath;
  const trim = c.build?.trim ? ["--trim", "--trim-locales=en"] : [];
  const libs: string[] = [];
  for (const arch of arches) {
    const out = join(work, "lib", ABI[arch], "libappserver.so");
    mkdirSync(join(work, "lib", ABI[arch]), { recursive: true });
    log(`bun build --compile --target=bun-linux-${arch}-android`);
    await run(
      "bun build --compile",
      $`${bun} build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv ${trim} --target=bun-linux-${arch}-android ${join(stage, "desktop-android.js")} --outfile ${out}`
        .cwd(stage)
        .nothrow()
        .quiet(),
    );
    log(`lib/${ABI[arch]}/libappserver.so ${mb(out)}`);
    libs.push(`lib/${ABI[arch]}/libappserver.so`);
  }

  // 1b. Node-API addons (native/addons/*.c|cc|cpp) → lib/<abi>/libaddon_<name>.so with the NDK
  for (const arch of arches) {
    for (const [name, file] of Object.entries(await buildAndroidAddons(c, arch, join(work, "addons", arch)))) {
      const dest = `lib/${ABI[arch]}/libaddon_${name}.so`;
      copyFileSync(file, join(work, dest));
      libs.push(dest);
      log(`addon ${name} → ${dest}`);
    }
  }
  // 1c. C/C++ plugin (sd_host ABI) → lib/<abi>/libapp-native.so + the JNI host libsdhost.so
  for (const arch of arches) {
    const plugin = await buildAndroidPlugin(c, arch, join(work, "plugin", arch));
    if (!plugin) continue;
    for (const [file, name] of [[plugin.plugin, "libapp-native.so"], [plugin.host, "libsdhost.so"]] as const) {
      copyFileSync(file, join(work, "lib", ABI[arch], name));
      libs.push(`lib/${ABI[arch]}/${name}`);
    }
    log(`native plugin → lib/${ABI[arch]}/libapp-native.so`);
  }
  // 1d. sidecars → lib/<abi>/libsidecar_<name>.so (executables; extracted to nativeLibraryDir)
  for (const arch of arches) {
    for (const [name, file] of Object.entries(await androidSidecars(c, arch, join(work, "sidecars", arch)))) {
      const dest = `lib/${ABI[arch]}/libsidecar_${name}.so`;
      copyFileSync(file, join(work, dest));
      libs.push(dest);
      log(`sidecar ${name} → ${dest}`);
    }
  }

  // 2. manifest + resources + assets → base APK. FCM builds (push.fcm) add the Firebase
  // libraries: their manifest entries, their resources (and R classes for their code), and
  // the google-services.json values.
  const pkg = androidPackageName(c.identifier);
  const googleServices = c.push?.fcm?.googleServices ? resolve(c.root, c.push.fcm.googleServices) : null;
  if (googleServices && !existsSync(googleServices)) throw new Error(`push.fcm.googleServices: ${googleServices} not found`);
  const libraries = googleServices ? await fcmLibraries() : [];
  if (googleServices) log(`FCM: Firebase Messaging + ${libraries.length - 1} libraries, ${googleServices.replace(`${c.root}/`, "")}`);
  const res = join(work, "res");
  const icon = c.icon && existsSync(c.icon) && c.icon.endsWith(".png");
  if (icon) {
    mkdirSync(join(res, "mipmap-xxxhdpi"), { recursive: true });
    // 192 px is the xxxhdpi launcher size; sips is macOS-only, otherwise ship the source PNG.
    const dest = join(res, "mipmap-xxxhdpi", "ic_launcher.png");
    const sized = process.platform === "darwin" && (await $`sips -z 192 192 ${c.icon} --out ${dest}`.nothrow().quiet()).exitCode === 0;
    if (!sized) copyFileSync(c.icon!, dest);
  }
  if (googleServices) {
    mkdirSync(join(res, "values"), { recursive: true });
    writeFileSync(join(res, "values", "google-services.xml"), googleServicesValues(JSON.parse(readFileSync(googleServices, "utf8")), pkg));
  }
  const fcmEntries = googleServices ? fcmManifestEntries(pkg) : undefined;
  writeFileSync(join(work, "AndroidManifest.xml"), androidManifest(c, { icon: !!icon, fcm: fcmEntries }));
  const assets = join(work, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "sd-notifications.json"), notificationsAsset(c));
  const linkArgs = ["-I", tc.androidJar, "--manifest", join(work, "AndroidManifest.xml"), "--min-sdk-version", String(MIN_SDK), "--target-sdk-version", String(TARGET_SDK)];
  linkArgs.push("--version-code", String(androidVersionCode(c.version)), "--version-name", c.version, "-A", assets);
  if (existsSync(res)) {
    await run("aapt2 compile", $`${tc.aapt2} compile --dir ${res} -o ${join(work, "res.zip")}`.nothrow().quiet());
    linkArgs.push(join(work, "res.zip"));
  }
  // Library resources are overlays, as in the Gradle build; compiled once per build-tools version.
  for (const lib of libraries) {
    if (!lib.res) continue;
    const flat = join(lib.res, "..", `res-${tc.buildTools}.zip`);
    if (!existsSync(flat)) await run(`aapt2 compile ${lib.name}`, $`${tc.aapt2} compile --dir ${lib.res} -o ${flat}`.nothrow().quiet());
    linkArgs.push("-R", flat);
  }
  if (libraries.length) linkArgs.push("--auto-add-overlay");
  // Debug-key builds are debuggable, as in Android Studio: WebView inspection
  // (chrome://inspect) and the e2e test channel. Release-key builds are not.
  const key = await signingKey(c, tc.keytool);
  if (key.debug) linkArgs.push("--debug-mode");
  const unsigned = join(work, "app-unaligned.apk");
  const gen = join(work, "gen");
  const rPackages = [...new Set(libraries.filter((l) => l.hasR && l.package).map((l) => l.package!))];
  const javaArgs = libraries.length ? ["--java", gen, ...(rPackages.length ? ["--extra-packages", rPackages.join(":")] : [])] : [];
  await run("aapt2 link", $`${tc.aapt2} link ${linkArgs} ${javaArgs} -o ${unsigned}`.nothrow().quiet());

  // 3. host classes (+ FcmPush/PushService and the libraries' R classes) → classes*.dex
  const classes = join(work, "classes");
  mkdirSync(classes, { recursive: true });
  const files = (dir: string, ext: string) =>
    (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(ext)).map((f) => join(dir, f));
  const sources = files(join(hostDir, "src"), ".java");
  if (googleServices) sources.push(...files(join(hostDir, "fcm"), ".java"), ...files(gen, ".java"));
  const jars = libraries.flatMap((l) => l.jars);
  const classpath = [tc.androidJar, ...jars].join(":");
  await run("javac", $`${tc.javac} --release 11 -nowarn -Xlint:-options -classpath ${classpath} -d ${classes} ${sources}`.env(env).nothrow().quiet());
  const classFiles = files(classes, ".class");
  // min-api ≥ 21: d8 splits into classes2.dex… by itself when the libraries need it.
  await run("d8", $`${tc.d8} --release --min-api ${MIN_SDK} --lib ${tc.androidJar} --output ${work} ${classFiles} ${jars}`.env(env).nothrow().quiet());
  const dexes = readdirSync(work).filter((f) => /^classes\d*\.dex$/.test(f)).sort();

  // 4. + classes*.dex + libs. Executables stay compressed: extractNativeLibs=true
  // makes the installer unpack them into nativeLibraryDir.
  await run("zip", $`zip -q -9 ${unsigned} ${dexes} ${libs}`.cwd(work).nothrow().quiet());

  // 5. align (16 KB pages, Android 15+) + sign
  const suffix = arches.length > 1 ? "-universal" : arches[0] !== "arm64" ? `-${arches[0]}` : "";
  const apkName = `${c.appName.replace(/[^A-Za-z0-9_-]/g, "") || "App"}-${c.version}${suffix}.apk`;
  const apk = join(dist, apkName);
  rmSync(apk, { force: true });
  await run("zipalign", $`${tc.zipalign} -P 16 -f 4 ${unsigned} ${apk}`.nothrow().quiet());
  await run(
    "apksigner",
    $`${tc.apksigner} sign --ks ${key.keystore} --ks-key-alias ${key.alias} --ks-pass ${`pass:${key.password}`} --key-pass ${`pass:${key.password}`} ${apk}`.env(env).nothrow().quiet(),
  );
  rmSync(`${apk}.idsig`, { force: true });
  log(`${apkName} ${mb(apk)} (${key.debug ? "debug key" : "release key"}, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  const artifacts = [apk];

  // 6. Android App Bundle for Play (build.aab or $SVELTE_DESKTOP_AAB)
  if (c.build?.aab || process.env.SVELTE_DESKTOP_AAB) {
    const aab = join(dist, apkName.replace(/\.apk$/, ".aab"));
    await buildAab({ tc, env, linkArgs, work, libs, dexes, aab, key });
    if (key.debug) console.log(`  \x1b[33m!\x1b[0m ${aab.split("/").pop()} is signed with the debug key: Play needs your upload key (sign.android)`);
    log(`${aab.split("/").pop()} ${mb(aab)}`);
    artifacts.push(aab);
  }
  return { app: apk, artifacts, signed: key.debug ? "ad-hoc" : "identity", notarized: false, arches };
}
