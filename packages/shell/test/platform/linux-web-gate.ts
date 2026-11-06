// Without the test channel, the ops made for tests refuse; server-owned ops refuse pages.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  for (const op of ["_terminateForTesting", "_contextMenuForTesting"]) {
    const r = await t.call("webview", op);
    t.check(`${op} → denied without KITOP_TEST`, r.error?.code === "denied", r);
  }
  const r = await t.call("webview", "_permissionPolicyForTesting", { permission: "camera" });
  t.check("_permissionPolicyForTesting → denied without KITOP_TEST", r.error?.code === "denied", r);
  t.check("the page still runs", (await t.page("return 1 + 1")) === 2);
  for (const [op, args] of [["configurePolicy", { kind: "permission", enabled: true }], ["respondPolicy", { requestId: "x" }], ["listPermissionDecisions", {}], ["setPermissionDecision", { origin: "https://a.example", permission: "camera", decision: "allow" }], ["revokePermissionDecision", { origin: "https://a.example", permission: "camera" }], ["allowCertificate", { host: "a.example", fingerprint: "0".repeat(64) }], ["revokeCertificate", { host: "a.example", fingerprint: "0".repeat(64) }], ["setNavigationPolicy", { enabled: true }], ["navigationDecision", { requestId: "x" }]] as const) {
    const out = (await t.pageCall("webview", op, args)) as any;
    t.check(`a page can't call webview.${op}`, out.ok === false && out.error?.code === "denied", out);
  }
};
