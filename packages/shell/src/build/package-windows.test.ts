import { expect, test } from "bun:test";
import { resolveConfig } from "../config.ts";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticodeIntact, nsisScript, peFiles, signedWith, signWithCommand, toastActivatorClsid, verifyAuthenticode } from "./package-windows.ts";

test("NSIS: Start Menu shortcut named after the app (shell.dll stamps its AUMID), uninstall drops the toast identity", () => {
  const c = resolveConfig("/tmp", { appName: "Notes", identifier: "dev.x.notes" });
  const nsi = nsisScript(c, { exe: "Notes.exe", srcDir: "/app", outFile: "/dist/setup.exe", icon: null, arch: "x64" });
  expect(nsi).toContain('CreateShortCut "$SMPROGRAMS\\Notes.lnk" "$INSTDIR\\Notes.exe"');
  const uninstall = nsi.slice(nsi.indexOf('Section "Uninstall"'));
  expect(uninstall).toContain('DeleteRegKey HKCU "Software\\Classes\\AppUserModelId\\dev.x.notes"');
  expect(uninstall).toContain('DeleteRegKey HKCU "Software\\Classes\\CLSID\\{B60436AD-F930-522F-B96A-F59E6D003A64}"');
});

test("toast activator CLSID: deterministic, matches notif::activator_clsid (native/portable/notifications.hpp)", () => {
  // Vectors printed by the C++ implementation (clang++ -I native/portable).
  expect(toastActivatorClsid("dev.x.notes")).toBe("{B60436AD-F930-522F-B96A-F59E6D003A64}");
  expect(toastActivatorClsid("dev.kitop.app")).toBe("{D6750297-FF40-520A-A9C5-9146BB5B7BAB}");
  expect(toastActivatorClsid("é.unicode")).toBe("{D99B2D6B-891F-5846-A226-92BA0079939F}");
  expect(toastActivatorClsid("dev.x.notes")).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
});

test("signing with the app's own tool: each file, in place; a failure stops the build and says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitop-sign-"));
  try {
    const tool = join(dir, "sign.sh");
    writeFileSync(tool, '#!/bin/sh\n[ "$1" = "--ok" ] || { echo "no key here" >&2; exit 3; }\necho signed >> "$2"\n');
    chmodSync(tool, 0o755);
    const a = join(dir, "a b.exe");
    const b = join(dir, "b.dll");
    writeFileSync(a, "");
    writeFileSync(b, "");
    await signWithCommand([a, b], [tool, "--ok", "{file}"]);
    expect(readFileSync(a, "utf8")).toBe("signed\n");
    expect(readFileSync(b, "utf8")).toBe("signed\n");
    await expect(signWithCommand([a], [tool, "--bad", "{file}"])).rejects.toThrow(/a b\.exe \(exit 3\):\nno key here/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the build's log names what signed it, with a tool or a certificate", () => {
  expect(signedWith({ command: ["AzureSignTool", "sign", "{file}"] })).toBe("AzureSignTool");
  expect(signedWith({ pfx: "/a/b/cert.pfx", password: "", timestamp: "" })).toBe("cert.pfx");
});

test("what osslsigncode says: a chain it doesn't trust isn't a damaged file", () => {
  const digests = (calculated: string) => `Current message digest    : AB \nCalculated message digest : ${calculated} \n`;
  expect(authenticodeIntact(`${digests("AB")}Signature verification: ok\n`)).toBe(true);
  expect(authenticodeIntact(`${digests("AB")}PKCS7_verify:certificate verify error:..: Verify error: self-signed certificate\nSignature verification: failed\n`)).toBe(true);
  expect(authenticodeIntact(`${digests("CD     MISMATCH!!!")}\nSignature verification: failed\n`)).toBe(false);
  expect(authenticodeIntact("No signature found\n\nFailed\n")).toBe(false);
});

test("everything in the folder that runs gets signed, at any depth", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitop-pe-"));
  try {
    mkdirSync(join(dir, "plugins"));
    mkdirSync(join(dir, "addons"));
    for (const f of ["App.exe", "shell.dll", "app.png", "plugins/a.dll", "addons/b.node", "tool.EXE"]) writeFileSync(join(dir, f), "");
    expect(peFiles(dir).map((f) => f.slice(dir.length + 1)).sort()).toEqual(["App.exe", "addons/b.node", "plugins/a.dll", "shell.dll", "tool.EXE"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// With the toolchain's osslsigncode and a certificate made here: KITOP_SIGN_TEST=<a PE to sign>.
test.if(!!process.env.KITOP_SIGN_TEST)("for real: a file just signed verifies, one damaged since or never signed doesn't", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kitop-sign-test-"));
  try {
    const good = join(dir, "good.dll");
    copyFileSync(process.env.KITOP_SIGN_TEST!, join(dir, "plain.dll"));
    const sh = `cd /w && openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 2 -subj /CN=test 2>/dev/null && openssl pkcs12 -export -inkey k.pem -in c.pem -out t.pfx -passout pass:x && osslsigncode sign -pkcs12 t.pfx -pass x -n n -h sha256 -in plain.dll -out good.dll`;
    const signed = Bun.spawnSync(["docker", "run", "--rm", "-v", `${dir}:/w`, "kitop-windows", "sh", "-c", sh]);
    expect(signed.exitCode).toBe(0);
    await verifyAuthenticode([good]);
    const bad = join(dir, "bad.dll");
    const bytes = readFileSync(good);
    bytes[4096] ^= 1;
    writeFileSync(bad, bytes);
    await expect(verifyAuthenticode([bad])).rejects.toThrow("doesn't verify after signing");
    await expect(verifyAuthenticode([join(dir, "plain.dll")])).rejects.toThrow("doesn't verify after signing");
  } finally {
    Bun.spawnSync(["docker", "run", "--rm", "-v", `${dir}:/w`, "kitop-windows", "sh", "-c", "rm -rf /w/*"]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
