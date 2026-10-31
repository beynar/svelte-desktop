// secureStorage.*: Keychain roundtrip under a throwaway service, cleaned up.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  const service = `dev.svelte-desktop.harness-test.${process.pid}.${Date.now()}`;
  const account = "alice";
  const secret = `s3cr3t-${crypto.randomUUID()}`;
  const secret2 = `rotated-${crypto.randomUUID()} é ✓`;
  try {
    const none = await t.call("secureStorage", "getPassword", { service, account });
    t.check("getPassword before set → null", none.ok && none.value === null, none);

    const set = await t.call("secureStorage", "setPassword", { service, account, password: secret });
    t.check("setPassword → null", set.ok && set.value === null, set);
    const got = await t.call("secureStorage", "getPassword", { service, account });
    t.check("getPassword reads it back", got.ok && got.value === secret, got.ok ? "(match hidden)" : got);

    const upd = await t.call("secureStorage", "setPassword", { service, account, password: secret2 });
    const got2 = await t.call("secureStorage", "getPassword", { service, account });
    t.check("setPassword again updates in place (UTF-8)", upd.ok && got2.ok && got2.value === secret2, upd.ok ? "(hidden)" : upd);

    const other = await t.call("secureStorage", "getPassword", { service, account: "bob" });
    t.check("other account → null", other.ok && other.value === null, other);

    const viaPage = (await t.pageCall("secureStorage", "getPassword", { service, account })) as any;
    t.check("page bridge: secureStorage.getPassword", viaPage.ok && viaPage.value === secret2, viaPage.ok ? "(hidden)" : viaPage);

    const del = await t.call("secureStorage", "deletePassword", { service, account });
    const gone = await t.call("secureStorage", "getPassword", { service, account });
    t.check("deletePassword removes it", del.ok && del.value === null && gone.ok && gone.value === null, { del, gone });
    const delAgain = await t.call("secureStorage", "deletePassword", { service, account });
    t.check("deletePassword is idempotent", delAgain.ok, delAgain);

    // account omitted on delete → every entry of the service.
    await t.call("secureStorage", "setPassword", { service, account: "a1", password: "x" });
    await t.call("secureStorage", "setPassword", { service, account: "a2", password: "y" });
    const delAll = await t.call("secureStorage", "deletePassword", { service });
    const a1 = await t.call("secureStorage", "getPassword", { service, account: "a1" });
    const a2 = await t.call("secureStorage", "getPassword", { service, account: "a2" });
    t.check("deletePassword without account clears the service", delAll.ok && a1.value === null && a2.value === null, { delAll, a1, a2 });

    for (const [name, args] of [
      ["missing service", { account, password: "x" }],
      ["empty service", { service: "", account, password: "x" }],
      ["missing account", { service, password: "x" }],
      ["missing password", { service, account }],
    ] as const) {
      const r = await t.call("secureStorage", "setPassword", args);
      t.check(`setPassword ${name} → invalid_args`, r.error?.code === "invalid_args", r);
    }
    const getNoAcct = await t.call("secureStorage", "getPassword", { service });
    t.check("getPassword missing account → invalid_args", getNoAcct.error?.code === "invalid_args", getNoAcct);

    const leaked = [...t.events.values()].flat().some((d) => JSON.stringify(d).includes(secret) || JSON.stringify(d).includes(secret2));
    t.check("no secret ever appeared in a platform event", !leaked);
  } finally {
    await t.call("secureStorage", "deletePassword", { service });
  }
  t.skip("secureStorage.authenticate", "LAContext owner-authentication prompt needs a human (Touch ID / password)");
};
