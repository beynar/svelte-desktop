// The pages of a website as a reader sees them, one line each: status and text, without scripts,
// styles or asset names, which a build may name differently. Waits for the server to answer.
//   bun init-pages.ts http://localhost:4190 / /about
const [base, ...paths] = process.argv.slice(2);
for (let i = 0; ; i++) {
  if (await fetch(base!).then(() => true, () => false)) break;
  if (i === 100) throw new Error(`${base} doesn't answer`);
  await Bun.sleep(200);
}
for (const path of paths) {
  const r = await fetch(base + path);
  const text = (await r.text()).replace(/<(script|style)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  console.log(`${path} ${r.status} ${text}`);
}
