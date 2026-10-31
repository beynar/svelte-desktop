// deepLink.register: needs a bundle that declares the scheme in Info.plist.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  for (const [name, scheme] of [
    ["empty", ""],
    ["starts with digit", "1abc"],
    ["has space", "my app"],
    ["has slash", "a/b"],
  ] as const) {
    const r = await t.call("deepLink", "register", { scheme });
    t.check(`deepLink.register ${name} → invalid_args`, r.error?.code === "invalid_args", r);
  }
  const missing = await t.call("deepLink", "register");
  t.check("deepLink.register missing scheme → invalid_args", missing.error?.code === "invalid_args", missing);

  const r = await t.call("deepLink", "register", { scheme: "sdharness" });
  if (r.ok) {
    t.check("deepLink.register (bundled) → {scheme}", r.value.scheme === "sdharness", r);
  } else {
    t.check("deepLink.register unbundled/undeclared → unavailable with guidance", r.error?.code === "unavailable" && /CFBundleURLTypes/.test(r.error.message), r);
  }
  const alias = await t.call("deepLink", "registerScheme", { scheme: "sdharness://" });
  t.check("deepLink.registerScheme alias, accepts `scheme://`", alias.ok ? alias.value.scheme === "sdharness" : alias.error?.code === "unavailable", alias);

  const viaPage = (await t.pageCall("deepLink", "register", { scheme: "sdharness" })) as any;
  t.check("page bridge: deepLink.register", viaPage.ok || viaPage.error?.code === "unavailable", viaPage);

  t.skip("deepLink.register success + openUrls delivery", "needs the packaged .app declaring the scheme, then a URL opened from outside");
};
