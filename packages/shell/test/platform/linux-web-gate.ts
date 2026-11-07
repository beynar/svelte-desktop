// A build without the test channel, started with KITOP_TEST all the same (run-platform-linux.sh):
// the ops made for tests refuse, there are no mock capture devices, the tests' thermal zones aren't
// read. A build for distribution isn't driven by an environment variable. Server-owned ops refuse pages.
import type { Harness } from "../harness-worker.ts";

export default async (t: Harness) => {
  t.check("KITOP_TEST is set for this suite", !!process.env.KITOP_TEST);
  for (const op of ["_terminateForTesting", "_contextMenuForTesting"]) {
    const r = await t.call("webview", op);
    t.check(`${op} → denied without the test channel`, r.error?.code === "denied", r);
  }
  const r = await t.call("webview", "_permissionPolicyForTesting", { permission: "camera" });
  t.check("_permissionPolicyForTesting → denied without the test channel", r.error?.code === "denied", r);
  const devices = await t.page<string[]>("return (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind)");
  t.check("no mock capture devices", Array.isArray(devices) && !devices.includes("videoinput"), devices);
  t.check("the page still runs", (await t.page("return 1 + 1")) === 2);
  for (const [op, args] of [["configurePolicy", { kind: "permission", enabled: true }], ["respondPolicy", { requestId: "x" }], ["listPermissionDecisions", {}], ["setPermissionDecision", { origin: "https://a.example", permission: "camera", decision: "allow" }], ["revokePermissionDecision", { origin: "https://a.example", permission: "camera" }], ["allowCertificate", { host: "a.example", fingerprint: "0".repeat(64) }], ["revokeCertificate", { host: "a.example", fingerprint: "0".repeat(64) }], ["setNavigationPolicy", { enabled: true }], ["navigationDecision", { requestId: "x" }]] as const) {
    const out = (await t.pageCall("webview", op, args)) as any;
    t.check(`a page can't call webview.${op}`, out.ok === false && out.error?.code === "denied", out);
  }
};
