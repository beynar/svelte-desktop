// Maintenance, when the pinned FCM artifacts (FCM_ARTIFACTS in src/build/package-android.ts)
// change: merge the library manifests the way Gradle's manifest merger would, once, into
// native/android/fcm/manifest-entries.json. Builds read that file; they never parse AAR manifests.
//   bun scripts/fcm-pin.ts
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fcmLibraries, type MergedEntries } from "../src/build/package-android.ts";

type XmlEl = { tag: string; attrs: [string, string][]; children: XmlEl[] };

/** Enough XML for AAR manifests: elements and attributes; comments, text and PIs dropped. */
function parseXml(src: string): XmlEl {
  const root: XmlEl = { tag: "#root", attrs: [], children: [] };
  const stack = [root];
  const clean = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  for (const m of clean.matchAll(/<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g)) {
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = [...m[3]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((a) => [a[1]!, a[2] ?? a[3] ?? ""] as [string, string]);
    const el: XmlEl = { tag: m[2]!, attrs, children: [] };
    stack.at(-1)!.children.push(el);
    if (!m[4]) stack.push(el);
  }
  return root.children[0] ?? root;
}

const attr = (e: XmlEl, k: string) => e.attrs.find(([n]) => n === k)?.[1];
const elKey = (e: XmlEl) => `${e.tag}|${attr(e, "android:name") ?? ""}`;

function writeXml(e: XmlEl, indent: string): string {
  const a = e.attrs.map(([k, v]) => ` ${k}="${v}"`).join("");
  if (!e.children.length) return `${indent}<${e.tag}${a} />`;
  return `${indent}<${e.tag}${a}>\n${e.children.map((x) => writeXml(x, `${indent}    `)).join("\n")}\n${indent}</${e.tag}>`;
}

/** What the Gradle manifest merger takes from library manifests, for the parts these libraries
 *  use: <uses-permission> and <application> children (components with the same name merge their
 *  attributes and meta-data, e.g. ComponentDiscoveryService registrars). tools:* attributes go,
 *  ${applicationId} becomes the package. Application attributes (appComponentFactory) are not
 *  carried over. */
export function mergeLibraryManifests(manifests: string[], applicationId: string): MergedEntries {
  const permissions = new Set<string>();
  const merged: XmlEl[] = [];
  const byKey = new Map<string, XmlEl>();
  const tidy = (e: XmlEl): XmlEl => ({
    tag: e.tag,
    attrs: e.attrs.filter(([k]) => !k.startsWith("tools:") && !k.startsWith("xmlns:")).map(([k, v]) => [k, v.replaceAll("${applicationId}", applicationId)]),
    children: e.children.filter((x) => attr(x, "tools:node") !== "remove").map(tidy),
  });
  for (const src of manifests) {
    const root = parseXml(src);
    for (const e of root.children) {
      if (e.tag === "uses-permission" || e.tag === "uses-permission-sdk-23") {
        const name = attr(e, "android:name");
        if (name && attr(e, "tools:node") !== "remove") permissions.add(name);
      }
      if (e.tag !== "application") continue;
      for (const raw of e.children) {
        if (attr(raw, "tools:node") === "remove") continue;
        const child = tidy(raw);
        const prev = byKey.get(elKey(child));
        if (!prev) {
          byKey.set(elKey(child), child);
          merged.push(child);
          continue;
        }
        for (const [k, v] of child.attrs) if (attr(prev, k) === undefined) prev.attrs.push([k, v]);
        for (const sub of child.children) {
          const same = prev.children.some((x) => (sub.tag === "meta-data" ? elKey(x) === elKey(sub) : writeXml(x, "") === writeXml(sub, "")));
          if (!same) prev.children.push(sub);
        }
      }
    }
  }
  return { permissions: [...permissions].sort(), application: merged.map((e) => `\n${writeXml(e, "        ")}`).join("") };
}

if (import.meta.main) {
  const libraries = await fcmLibraries();
  const entries = mergeLibraryManifests(libraries.flatMap((l) => (l.manifest ? [l.manifest] : [])), "${applicationId}");
  const file = resolve(import.meta.dir, "../native/android/fcm/manifest-entries.json");
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`${file}: ${entries.permissions.length} permissions, ${entries.application.split("\n").length} lines of <application> entries`);
}
