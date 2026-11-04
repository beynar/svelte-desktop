// Server code's network, like the system's: the pages go through WebKit, which uses the system's
// certificates and proxy; server code goes through Bun's fetch, which by default uses neither. Behind
// a company proxy that inspects TLS (its root certificate installed on the machine), every server
// fetch would fail with a certificate error — remote functions, OAuth token exchanges, update
// checks — and a proxy set in the system settings would be ignored.
//
// At startup, before any request: NODE_USE_SYSTEM_CA=1 (Bun then trusts the system's certificates
// as well as its own), and the system proxy as HTTP_PROXY / HTTPS_PROXY / NO_PROXY — unless they're
// set already. The app's own server (localhost) is always in NO_PROXY.
//   macOS: `scutil --proxy` · Windows: the user's Internet Settings · Linux: GNOME's proxy settings.
// A proxy auto-configuration (PAC) script can't be followed: it's reported, not applied.

export interface NetworkConfig {
  /** Trust the system's certificates (and the ones installed on it), as well as Bun's. Default true. */
  systemCertificates?: boolean;
  /** Use the proxy set in the system settings when HTTP(S)_PROXY isn't set. Default true. */
  systemProxy?: boolean;
}

export interface SystemProxy {
  http?: string;
  https?: string;
  /** Hosts that go direct, comma-separated (NO_PROXY's format). */
  noProxy?: string;
  /** A proxy auto-configuration script's URL: not applied. */
  pac?: string;
}

const LOCAL = ["localhost", "127.0.0.1", "::1"];

const run = (cmd: string[]): string => {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : "";
  } catch {
    return "";
  }
};

/** `*.local` → `.local` (NO_PROXY suffixes), `<local>` (Windows: plain host names) dropped. */
const bypass = (entries: string[]) => entries.map((e) => e.trim().replace(/^\*\./, ".")).filter((e) => e && e !== "<local>");

export function parseScutil(out: string): SystemProxy {
  const value = (key: string) => new RegExp(`^\\s*${key} : (.+)$`, "m").exec(out)?.[1]?.trim();
  const proxy: SystemProxy = {};
  if (value("HTTPEnable") === "1" && value("HTTPProxy")) proxy.http = `http://${value("HTTPProxy")}:${value("HTTPPort") ?? "80"}`;
  if (value("HTTPSEnable") === "1" && value("HTTPSProxy")) proxy.https = `http://${value("HTTPSProxy")}:${value("HTTPSPort") ?? "443"}`;
  const list = /ExceptionsList : <array> \{([\s\S]*?)\}/.exec(out)?.[1];
  if (list) proxy.noProxy = bypass([...list.matchAll(/^\s*\d+ : (.+)$/gm)].map((m) => m[1]!)).join(",");
  if (value("ProxyAutoConfigEnable") === "1") proxy.pac = value("ProxyAutoConfigURLString");
  return proxy;
}

export function parseWindowsInternetSettings(out: string): SystemProxy {
  const value = (key: string) => new RegExp(`^\\s*${key}\\s+REG_\\w+\\s+(.*)$`, "m").exec(out)?.[1]?.trim();
  const proxy: SystemProxy = {};
  const server = value("ProxyServer");
  if (/^0x0*1$/.test(value("ProxyEnable") ?? "") && server) {
    // "host:port" for every protocol, or "http=host:port;https=host:port".
    const per = Object.fromEntries(server.split(";").map((p) => (p.includes("=") ? p.split("=", 2) : ["*", p])) as [string, string][]);
    const url = (s?: string) => (s ? (/^\w+:\/\//.test(s) ? s : `http://${s}`) : undefined);
    proxy.http = url(per.http ?? per["*"]);
    proxy.https = url(per.https ?? per["*"]);
  }
  const override = value("ProxyOverride");
  if (override) proxy.noProxy = bypass(override.split(";")).join(",");
  const pac = value("AutoConfigURL");
  if (pac) proxy.pac = pac;
  return proxy;
}

function linuxProxy(): SystemProxy {
  const get = (schema: string, key: string) => run(["gsettings", "get", schema, key]).trim().replace(/^'|'$/g, "");
  const mode = get("org.gnome.system.proxy", "mode");
  const proxy: SystemProxy = {};
  if (mode === "manual") {
    for (const scheme of ["http", "https"] as const) {
      const host = get(`org.gnome.system.proxy.${scheme}`, "host");
      const port = get(`org.gnome.system.proxy.${scheme}`, "port").replace(/^uint32 /, "");
      if (host) proxy[scheme] = `http://${host}:${port || 8080}`;
    }
    const ignore = get("org.gnome.system.proxy", "ignore-hosts");
    if (ignore) proxy.noProxy = bypass([...ignore.matchAll(/'([^']+)'/g)].map((m) => m[1]!)).join(",");
  } else if (mode === "auto") proxy.pac = get("org.gnome.system.proxy", "autoconfig-url") || "auto";
  return proxy;
}

/** The proxy set in the system settings. */
export function systemProxy(): SystemProxy {
  if (process.platform === "darwin") return parseScutil(run(["/usr/sbin/scutil", "--proxy"]));
  if (process.platform === "win32") return parseWindowsInternetSettings(run(["reg", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"]));
  return linuxProxy();
}

const env = (k: string) => process.env[k] ?? process.env[k.toLowerCase()];

/** Server code's network like the system's (see the top of this file). Synchronous: before the
 *  server starts, so before its first request. Child processes inherit it. */
export function applySystemNetwork(config: NetworkConfig = {}) {
  if (process.env.SVELTE_DESKTOP_NETWORK_APPLIED) return;
  process.env.SVELTE_DESKTOP_NETWORK_APPLIED = "1";
  if (config.systemCertificates !== false) process.env.NODE_USE_SYSTEM_CA ??= "1";
  if (config.systemProxy !== false && !env("HTTP_PROXY") && !env("HTTPS_PROXY") && !env("ALL_PROXY")) {
    const p = systemProxy();
    if (p.http) process.env.HTTP_PROXY = p.http;
    if (p.https) process.env.HTTPS_PROXY = p.https;
    if (p.pac && !p.http && !p.https) console.warn(`[desktop] the system uses a proxy auto-configuration script (${p.pac}): server code connects directly — set HTTPS_PROXY to use a proxy`);
    if (p.http || p.https) process.env.NO_PROXY = [...new Set([...(env("NO_PROXY") ?? "").split(","), ...(p.noProxy ?? "").split(","), ...LOCAL].map((s) => s.trim()).filter(Boolean))].join(",");
  }
  // The app's own server is never behind the proxy.
  if (env("HTTP_PROXY") || env("HTTPS_PROXY") || env("ALL_PROXY")) {
    const current = (env("NO_PROXY") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    process.env.NO_PROXY = [...new Set([...current, ...LOCAL])].join(",");
  }
}
