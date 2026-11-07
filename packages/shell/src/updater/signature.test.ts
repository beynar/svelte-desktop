import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeFiles, hasCertificateTable, verifyMacUpdate, verifyWindowsUpdate, type Run } from "./signature.ts";

const said = (answers: Record<string, { code: number; out: string }>): Run => async (argv) => {
	const key = Object.keys(answers).find((k) => argv.join(" ").includes(k));
	return key ? answers[key]! : { code: 0, out: "" };
};
const refused = (p: Promise<void>) => expect(p).rejects.toMatchObject({ code: "signature_invalid" });

describe("a macOS update", () => {
	const signedBy = (team: string) => ({ code: 0, out: `Authority=x\nTeamIdentifier=${team}\n` });
	const mine = "/Applications/Mine.app";
	const update = "/staging/payload/Mine.app";

	test("from the same team passes, from another or none doesn't", async () => {
		await verifyMacUpdate(mine, update, said({ [`-dvv ${mine}`]: signedBy("ABC"), [`-dvv ${update}`]: signedBy("ABC") }));
		await refused(verifyMacUpdate(mine, update, said({ [`-dvv ${mine}`]: signedBy("ABC"), [`-dvv ${update}`]: signedBy("EVIL") })));
		await refused(verifyMacUpdate(mine, update, said({ [`-dvv ${mine}`]: signedBy("ABC"), [`-dvv ${update}`]: { code: 1, out: "code object is not signed at all" } })));
	});
	test("whose signature doesn't verify is refused, whoever it names", async () => {
		await refused(verifyMacUpdate(mine, update, said({ [`-dvv ${mine}`]: signedBy("ABC"), [`-dvv ${update}`]: signedBy("ABC"), "--verify": { code: 1, out: "a sealed resource is missing" } })));
	});
	test("for an app that isn't signed: nothing to compare to", async () => {
		await verifyMacUpdate(mine, update, said({ [`-dvv ${mine}`]: { code: 1, out: "code object is not signed at all" }, "--verify": { code: 1, out: "no" } }));
	});
	test("codesign not answering refuses it: nothing has said it's good", async () => {
		await refused(verifyMacUpdate(mine, update, async () => ({ code: -1, out: "ENOENT" })));
		await refused(verifyMacUpdate(mine, update, said({ [`-dvv ${mine}`]: signedBy("ABC"), [`-dvv ${update}`]: { code: -1, out: "killed" } })));
	});

	test.if(process.platform === "darwin")("for real, ad hoc: a tampered copy is refused", async () => {
		const dir = mkdtempSync(join(tmpdir(), "signature-"));
		const good = join(dir, "good");
		copyFileSync(process.execPath, good);
		expect(Bun.spawnSync(["/usr/bin/codesign", "--force", "-s", "-", good]).exitCode).toBe(0);
		await verifyMacUpdate(good, good);
		const bad = join(dir, "bad");
		copyFileSync(good, bad);
		appendFileSync(bad, "tampered");
		await refused(verifyMacUpdate(good, bad));
	}, 60_000);
});

describe("a Windows update", () => {
	const answers = (mine: string, theirs: string[]): Run => async (argv) => ({ code: 0, out: argv.join(" ").includes("Mine.exe") ? mine : theirs.join("\r\n") });
	const valid = (who: string) => `Valid|CN=${who}, O=A`;
	const staged = ["C:\\staged\\Mine2.exe", "C:\\staged\\shell.dll"];

	test("from the same publisher passes, from another or with a bad signature doesn't", async () => {
		await verifyWindowsUpdate("C:\\Mine.exe", staged, answers(valid("Me"), [valid("Me"), valid("Me")]));
		await refused(verifyWindowsUpdate("C:\\Mine.exe", staged, answers(valid("Me"), [valid("Evil"), valid("Me")])));
		await refused(verifyWindowsUpdate("C:\\Mine.exe", staged, answers(valid("Me"), [valid("Me"), "HashMismatch|CN=Me, O=A"])));
	});
	test("every file counts, not just the executable", async () => {
		await refused(verifyWindowsUpdate("C:\\Mine.exe", staged, answers(valid("Me"), [valid("Me"), "NotSigned|"])));
		// One file's answer missing is no answer.
		await refused(verifyWindowsUpdate("C:\\Mine.exe", staged, answers(valid("Me"), [valid("Me")])));
	});
	test("a large update is asked in parts, and all of them count", async () => {
		const many = Array.from({ length: 95 }, (_, i) => `C:\\staged\\${i}.dll`);
		let calls = 0;
		await refused(verifyWindowsUpdate("C:\\Mine.exe", many, async (argv) => {
			if (argv.join(" ").includes("Mine.exe")) return { code: 0, out: valid("Me") };
			const asked = argv.join(" ").split(".dll").length - 1;
			return { code: 0, out: Array.from({ length: asked }, (_, i) => (++calls === 90 ? valid("Evil") : valid("Me"))).join("\n") };
		}));
		expect(calls).toBe(95); // the last part was asked: that's where the bad one is
	});
	test("for an app that isn't signed: nothing to compare to", async () => {
		await verifyWindowsUpdate("C:\\Mine.exe", staged, answers("NotSigned|", ["NotSigned|", "NotSigned|"]));
	});

	const pe = (certificateTable: number) => {
		const file = join(mkdtempSync(join(tmpdir(), "signature-")), "app.exe");
		const head = Buffer.alloc(512);
		head.writeUInt32LE(0x80, 0x3c);
		head.writeUInt32LE(0x4550, 0x80);
		head.writeUInt16LE(0x20b, 0x80 + 24);
		head.writeUInt32LE(certificateTable, 0x80 + 24 + 144 + 4);
		writeFileSync(file, head);
		return file;
	};
	test("PowerShell not answering: refused for an app with a signature, nothing to compare to without one", async () => {
		const silent: Run = async () => ({ code: 1, out: "" });
		expect(hasCertificateTable(pe(0))).toBe(false);
		expect(hasCertificateTable(pe(4096))).toBe(true);
		await verifyWindowsUpdate(pe(0), staged, silent);
		await refused(verifyWindowsUpdate(pe(4096), staged, silent));
		await refused(verifyWindowsUpdate("C:\\Mine.exe", staged, silent));
	});
	test("PowerShell not answering about the update refuses it", async () => {
		await refused(verifyWindowsUpdate("C:\\Mine.exe", staged, async (argv) => (argv.join(" ").includes("Mine.exe") ? { code: 0, out: valid("Me") } : { code: 1, out: "" })));
	});
	test("what's checked: every .exe, .dll and addon, at any depth", () => {
		const dir = mkdtempSync(join(tmpdir(), "signature-"));
		mkdirSync(join(dir, "plugins/deep"), { recursive: true });
		mkdirSync(join(dir, "addons"));
		for (const f of ["App.exe", "shell.dll", "icon.png", "plugins/deep/a.DLL", "addons/b.node", "addons/readme.txt"]) writeFileSync(join(dir, f), "");
		expect(codeFiles([join(dir, "App.exe"), join(dir, "shell.dll"), join(dir, "icon.png"), join(dir, "plugins"), join(dir, "addons")]).map((f) => f.slice(dir.length + 1)).sort()).toEqual(["App.exe", "addons/b.node", "plugins/deep/a.DLL", "shell.dll"]);
	});
});
