// Helper for linux-web-sessions.ts (not a suite of its own): two runs sharing their data directory.
// The first sets cookies in the default and a persistent session, the second finds them.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const url = "http://restart.example/";
  if (process.env.PHASE === "dev") {
    t.check("create without the shell's cookie", (await t.call("sessions", "create", { id: "dev", persistent: false })).ok);
    return;
  }
  await t.page(`document.cookie = '__kitop=gate; path=/'; return 1`);
  const created = await t.call("sessions", "create", { id: "kept", persistent: true });
  t.check("persistent session opens", created.value?.persistent === true, created);
  await t.call("sessions", "create", { id: "private", persistent: false });
  if (process.env.PHASE === "1") {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    for (const [session, name] of [["default", "main"], ["kept", "named"], ["private", "gone"]] as const) {
      t.check(`set ${name}`, (await t.call("sessions", "cookiesSet", { session, url, name, value: "1", expires })).ok);
      await t.call("sessions", "cookiesSet", { session, url, name: `${name}-session`, value: "1" });
    }
    await t.sleep(500); // WebKit writes its file a moment later
    return;
  }
  const names = async (session: string) => ((await t.call("sessions", "cookiesGet", { session, url })).value ?? []).map((c: any) => c.name);
  const main = await names("default");
  t.check("default: the cookie is still there, not the session cookie", main.includes("main") && !main.includes("main-session"), main);
  const named = await names("kept");
  t.check("persistent: same", named.includes("named") && !named.includes("named-session") && !named.includes("main"), named);
  t.check("private: nothing", (await names("private")).length === 0);
};
