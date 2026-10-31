import { expect, test } from "bun:test";
import { resolveConfig } from "../config.ts";
import { mergeLibraryManifests } from "../../scripts/fcm-pin.ts";
import {
  androidManifest,
  androidPackageName,
  androidVersionCode,
  defaultChannel,
  fcmArtifacts,
  googleServicesValues,
  fcmManifestEntries,
  notificationsAsset,
} from "./package-android.ts";

test("identifier → Java package", () => {
  expect(androidPackageName("dev.svelte-desktop.notes")).toBe("dev.svelte_desktop.notes");
  expect(androidPackageName("com.example.2fa")).toBe("com.example._2fa");
  expect(androidPackageName("single")).toBe("app.single");
});

test("version → versionCode", () => {
  expect(androidVersionCode("0.1.0")).toBe(100);
  expect(androidVersionCode("1.2.3")).toBe(10203);
  expect(androidVersionCode("2.0.0-beta.1")).toBe(20000);
  expect(androidVersionCode("0.0.0")).toBe(1);
});

test("manifest from config", () => {
  const c = resolveConfig("/tmp", { appName: 'A & "B"', identifier: "dev.x-y.app", schemes: ["notes", "x-app"] });
  const m = androidManifest(c, { icon: true });
  expect(m).toContain('package="dev.x_y.app"');
  expect(m).toContain('android:label="A &amp; &quot;B&quot;"');
  expect(m).toContain('android:value="dev.x-y.app"');
  expect(m).toContain('android:icon="@mipmap/ic_launcher"');
  expect(m).toContain('<data android:scheme="notes" />');
  expect(m).toContain('<data android:scheme="x-app" />');
  expect(m).toContain('android:extractNativeLibs="true"');
  expect(m).not.toMatch(/__[A-Z]+__/);
  expect(androidManifest(c, { icon: false })).not.toContain("android:icon");
  expect(m).not.toContain("sd.pagePermissions");
  expect(m).not.toContain("android.permission.CAMERA");
  const cam = androidManifest(resolveConfig("/tmp", { appName: "A", identifier: "a.b", usageDescriptions: { camera: "scan" } }), { icon: false });
  expect(cam).toContain('<uses-permission android:name="android.permission.CAMERA" />');
  const p = androidManifest(resolveConfig("/tmp", { appName: "A", identifier: "a.b", permissions: { pages: ["app.*", "clipboard.readText"] } }), { icon: false });
  expect(p).toContain('<meta-data android:name="sd.pagePermissions" android:value="app.*,clipboard.readText" />');
});

test("SVELTE_DESKTOP_TARGET overrides build.target", () => {
  process.env.SVELTE_DESKTOP_TARGET = "android";
  try {
    expect(resolveConfig("/tmp", { appName: "A", identifier: "a.b", build: { zip: true } }).build).toEqual({ zip: true, target: "android" });
  } finally {
    delete process.env.SVELTE_DESKTOP_TARGET;
  }
  expect(resolveConfig("/tmp", { appName: "A", identifier: "a.b" }).build).toBeUndefined();
});

test("sidecars per platform", async () => {
  const { sidecarEntries } = await import("../config.ts");
  const c = resolveConfig("/app", { appName: "A", identifier: "a.b", sidecars: { all: "bin/all", ff: { macos: "bin/ff-mac", android: "bin/ff-android" } } });
  expect(sidecarEntries(c, "android")).toEqual([["all", "/app/bin/all"], ["ff", "/app/bin/ff-android"]]);
  expect(sidecarEntries(c, "linux")).toEqual([["all", "/app/bin/all"]]);
  expect(sidecarEntries(c, "macos")).toEqual([["all", "/app/bin/all"], ["ff", "/app/bin/ff-mac"]]);
});

test("manifest: notification receiver, boot re-arm, no Firebase without push.fcm", () => {
  const m = androidManifest(resolveConfig("/tmp", { appName: "A", identifier: "a.b" }), { icon: false });
  expect(m).toContain('<receiver android:name="dev.sveltedesktop.NotificationReceiver" android:exported="false">');
  expect(m).toContain('<action android:name="android.intent.action.BOOT_COMPLETED" />');
  expect(m).toContain('<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />');
  expect(m).not.toContain("SCHEDULE_EXACT_ALARM");
  // UnifiedPush connector (default on): exported receiver, raise-to-foreground service, distributor visibility
  expect(m).toContain('<receiver android:name="dev.sveltedesktop.UnifiedPushReceiver" android:exported="true">');
  expect(m).toContain('<action android:name="org.unifiedpush.android.connector.MESSAGE" />');
  expect(m).toContain('<action android:name="org.unifiedpush.android.connector.RAISE_TO_FOREGROUND" />');
  expect(m).toMatch(/<queries>[\s\S]*org\.unifiedpush\.android\.distributor\.REGISTER[\s\S]*android:scheme="unifiedpush"[\s\S]*<\/queries>/);
  const off = androidManifest(resolveConfig("/tmp", { appName: "A", identifier: "a.b", push: { unifiedPush: false } }), { icon: false });
  expect(off).not.toMatch(/unifiedpush|UnifiedPush/i);
  expect(JSON.parse(notificationsAsset(resolveConfig("/tmp", { appName: "A", identifier: "a.b", push: { unifiedPush: false } }))).unifiedPush).toBe(false);
  expect(m).not.toMatch(/com\.google\.firebase|firebase_|sveltedesktop\.PushService/);
  expect(m).not.toMatch(/__[A-Z]+__/);
});

test("notifications asset: config channels, foreground default, fcm flag", () => {
  const plain = resolveConfig("/tmp", { appName: "A", identifier: "a.b" });
  expect(JSON.parse(notificationsAsset(plain))).toEqual({ channels: [], foreground: true, fcm: false, unifiedPush: true });
  expect(defaultChannel(plain)).toBe("default");
  const c = resolveConfig("/tmp", {
    appName: "A",
    identifier: "a.b",
    notifications: { channels: [{ id: "messages", name: "Messages", importance: "high" }, { id: "news", name: "News", sound: false }], foreground: false },
    push: { fcm: { googleServices: "google-services.json" } },
  });
  expect(JSON.parse(notificationsAsset(c))).toEqual({
    channels: [{ id: "messages", name: "Messages", importance: "high" }, { id: "news", name: "News", sound: false }],
    foreground: false,
    fcm: true,
    unifiedPush: true,
  });
  expect(defaultChannel(c)).toBe("messages");
  const dup = resolveConfig("/tmp", { appName: "A", identifier: "a.b", notifications: { channels: [{ id: "x", name: "X" }, { id: "x", name: "Y" }] } });
  expect(() => notificationsAsset(dup)).toThrow(/duplicate/);
});

const services = {
  project_info: { project_number: "123456789012", project_id: "notes-e2e", storage_bucket: "notes-e2e.appspot.com" },
  client: [
    { client_info: { mobilesdk_app_id: "1:123456789012:android:other", android_client_info: { package_name: "com.other" } }, api_key: [{ current_key: "AIzaOther" }] },
    {
      client_info: { mobilesdk_app_id: "1:123456789012:android:0123456789abcdef", android_client_info: { package_name: "dev.svelte_desktop.notes" } },
      oauth_client: [{ client_id: "web.apps.googleusercontent.com", client_type: 3 }],
      api_key: [{ current_key: "AIzaSyFakeKey'quoted" }],
    },
  ],
};

test("google-services.json → the plugin's string resources for the package", () => {
  const x = googleServicesValues(services, "dev.svelte_desktop.notes");
  expect(x).toContain('<string name="google_app_id" translatable="false">1:123456789012:android:0123456789abcdef</string>');
  expect(x).toContain('<string name="gcm_defaultSenderId" translatable="false">123456789012</string>');
  expect(x).toContain("<string name=\"google_api_key\" translatable=\"false\">AIzaSyFakeKey\\'quoted</string>");
  expect(x).toContain('<string name="project_id" translatable="false">notes-e2e</string>');
  expect(x).toContain('<string name="google_storage_bucket" translatable="false">notes-e2e.appspot.com</string>');
  expect(x).toContain('<string name="default_web_client_id" translatable="false">web.apps.googleusercontent.com</string>');
  expect(x).not.toContain("firebase_database_url");
  expect(() => googleServicesValues(services, "dev.nope")).toThrow(/no Android app "dev.nope" \(it has: com.other, dev.svelte_desktop.notes\)/);
});

test("library manifests merge: permissions, components, registrars, ${applicationId}", () => {
  const a = `<?xml version="1.0"?><!-- c --><manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools" package="com.a">
    <uses-sdk android:minSdkVersion="21" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <application>
      <provider android:name="com.a.Init" android:authorities="\${applicationId}.init" android:exported="false" tools:targetApi="n" />
      <service android:name="com.google.firebase.components.ComponentDiscoveryService" android:exported="false">
        <meta-data android:name="reg:A" android:value="com.google.firebase.components.ComponentRegistrar" />
      </service>
    </application></manifest>`;
  const b = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.b">
    <uses-permission android:name="android.permission.WAKE_LOCK" /><uses-permission android:name="com.google.android.c2dm.permission.RECEIVE" />
    <application>
      <service android:name="com.google.firebase.components.ComponentDiscoveryService" android:directBootAware="true" android:exported="false">
        <meta-data android:name="reg:B" android:value="com.google.firebase.components.ComponentRegistrar" />
        <meta-data android:name="reg:A" android:value="com.google.firebase.components.ComponentRegistrar" />
      </service>
      <receiver android:name="com.b.R" android:exported="true"><intent-filter><action android:name="x" /></intent-filter></receiver>
    </application></manifest>`;
  const m = mergeLibraryManifests([a, b], "dev.app");
  expect(m.permissions).toEqual(["android.permission.WAKE_LOCK", "com.google.android.c2dm.permission.RECEIVE"]);
  expect(m.application).toContain('<provider android:name="com.a.Init" android:authorities="dev.app.init" android:exported="false" />');
  expect(m.application).not.toContain("tools:");
  expect(m.application.match(/ComponentDiscoveryService/g)?.length).toBe(1);
  expect(m.application).toContain('android:directBootAware="true"');
  expect(m.application.match(/reg:A/g)?.length).toBe(1);
  expect(m.application).toContain("reg:B");
  expect(m.application).toContain('<action android:name="x" />');
  const c = resolveConfig("/tmp", { appName: "A", identifier: "a.b", notifications: { channels: [{ id: "chat", name: "Chat" }] }, push: { fcm: { googleServices: "g.json" } } });
  const full = androidManifest(c, { icon: false, fcm: m });
  expect(full).toContain('<service android:name="dev.sveltedesktop.PushService" android:exported="false">');
  expect(full).toContain('<meta-data android:name="firebase_messaging_auto_init_enabled" android:value="false" />');
  expect(full).toContain('<meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="chat" />');
  expect(full).toContain('<uses-permission android:name="com.google.android.c2dm.permission.RECEIVE" />');
  expect(full.match(/android.permission.INTERNET/g)?.length).toBe(1);
});

test("FCM artifacts are pinned (exact versions + sha256)", () => {
  const all = fcmArtifacts();
  expect(all.find((a) => a.artifact === "firebase-messaging")).toMatchObject({ group: "com.google.firebase", version: "24.1.2", ext: "aar" });
  for (const a of all) {
    expect(a.version).toMatch(/^[0-9][\w.-]*$/);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(new Set(all.map((a) => `${a.group}:${a.artifact}`)).size).toBe(all.length);
});

test("Web Push decryption in the Android host (WebPushCrypto.java on a JVM): RFC 8291 appendix A + encryptWebPush interop", async () => {
  const { androidToolchain } = await import("./package-android.ts");
  let javac: string;
  try {
    javac = androidToolchain().javac;
  } catch {
    return; // no JDK / SDK on this machine
  }
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { encryptWebPush } = await import("../push/server.ts");
  const { b64url } = await import("../push/protocol.ts");
  const dir = mkdtempSync(join(tmpdir(), "sd-webpush-"));
  try {
    const main = join(dir, "Main.java");
    writeFileSync(
      main,
      `package dev.sveltedesktop;
public class Main {
  public static void main(String[] a) throws Exception {
    java.util.Base64.Decoder d = java.util.Base64.getUrlDecoder();
    byte[] out = WebPushCrypto.decrypt(d.decode(a[3]), WebPushCrypto.privateFromScalar(d.decode(a[0])), d.decode(a[1]), d.decode(a[2]));
    System.out.print(new String(out, java.nio.charset.StandardCharsets.UTF_8));
  }
}`,
    );
    const src = resolve(import.meta.dir, "../../native/android/src/dev/sveltedesktop/WebPushCrypto.java");
    const c = await Bun.$`${javac} --release 11 -d ${dir} ${src} ${main}`.quiet().nothrow();
    expect(c.exitCode).toBe(0);
    const java = javac.replace(/javac$/, "java");
    const decrypt = async (d: string, pub: string, auth: string, body: string) => (await Bun.$`${java} -cp ${dir} dev.sveltedesktop.Main ${d} ${pub} ${auth} ${body}`.quiet()).text();
    // RFC 8291 appendix A
    expect(
      await decrypt(
        "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        "BTBZMqHH6r4Tts7J_aSIgg",
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
      ),
    ).toBe("When I grow up, I want to be a watermelon");
    // what @svelte-desktop/shell/push sends, to a fresh device key
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const d = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d!;
    const p256dh = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
    const auth = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const message = JSON.stringify({ id: "m1", title: "Héllo ✓", body: "x".repeat(3000), payload: '{"url":"/a"}' });
    const body = await encryptWebPush(new TextEncoder().encode(message), { p256dh, auth });
    expect(await decrypt(d, p256dh, auth, b64url(body))).toBe(message);
    // Malformed bodies are refused: a header with no record, bytes after the last record.
    const refused = async (b: Uint8Array) => (await Bun.$`${java} -cp ${dir} dev.sveltedesktop.Main ${d} ${p256dh} ${auth} ${b64url(b)}`.quiet().nothrow()).exitCode !== 0;
    expect(await refused(body.subarray(0, 21 + 65))).toBe(true);
    expect(await refused(new Uint8Array([...body, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("FCM manifest entries: merged once (scripts/fcm-pin.ts), the build only fills in the package", () => {
  const e = fcmManifestEntries("dev.example.app");
  expect(e.permissions).toContain("com.google.android.c2dm.permission.RECEIVE");
  expect(e.application).toContain("com.google.firebase.components.ComponentDiscoveryService");
  expect(e.application).not.toContain("${applicationId}");
  expect(e.application).toContain("dev.example.app");
});
