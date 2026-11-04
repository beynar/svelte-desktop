import { expect, test } from "bun:test";
import { parseScutil, parseWindowsInternetSettings } from "./system-network.ts";

test("macOS: scutil --proxy", () => {
  const out = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : intranet.example.com
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 3128
  HTTPProxy : proxy.corp
  HTTPSEnable : 1
  HTTPSPort : 3129
  HTTPSProxy : proxy.corp
  ProxyAutoConfigEnable : 0
}`;
  expect(parseScutil(out)).toEqual({ http: "http://proxy.corp:3128", https: "http://proxy.corp:3129", noProxy: ".local,169.254/16,intranet.example.com" });
  expect(parseScutil(`<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad/proxy.pac\n}`)).toEqual({ pac: "http://wpad/proxy.pac" });
  expect(parseScutil("")).toEqual({});
});

test("Windows: Internet Settings", () => {
  const out = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=proxy.corp:8080;https=proxy.corp:8443
    ProxyOverride    REG_SZ    *.corp.local;<local>
`;
  expect(parseWindowsInternetSettings(out)).toEqual({ http: "http://proxy.corp:8080", https: "http://proxy.corp:8443", noProxy: ".corp.local" });
  expect(parseWindowsInternetSettings("    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    proxy:3128\n")).toEqual({ http: "http://proxy:3128", https: "http://proxy:3128" });
  expect(parseWindowsInternetSettings("    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    proxy:3128\n")).toEqual({});
});
