import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMacUpdate, verifyWindowsUpdate, type Run } from "./signature.ts";

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
	const answers = (mine: string, theirs: string): Run => async (argv) => ({ code: 0, out: argv.join(" ").includes("Mine.exe") ? mine : theirs });
	const valid = (who: string) => `Valid\r\nCN=${who}\r\n`;

	test("from the same publisher passes, from another or with a bad signature doesn't", async () => {
		await verifyWindowsUpdate("C:\\Mine.exe", "C:\\staged.exe", answers(valid("Me"), valid("Me")));
		await refused(verifyWindowsUpdate("C:\\Mine.exe", "C:\\staged.exe", answers(valid("Me"), valid("Evil"))));
		await refused(verifyWindowsUpdate("C:\\Mine.exe", "C:\\staged.exe", answers(valid("Me"), "HashMismatch\r\nCN=Me\r\n")));
		await refused(verifyWindowsUpdate("C:\\Mine.exe", "C:\\staged.exe", answers(valid("Me"), "NotSigned\r\n")));
	});
	test("for an app that isn't signed: nothing to compare to", async () => {
		await verifyWindowsUpdate("C:\\Mine.exe", "C:\\staged.exe", answers("NotSigned\r\n", "NotSigned\r\n"));
	});
	test("PowerShell not answering refuses nothing", async () => {
		await verifyWindowsUpdate("C:\\Mine.exe", "C:\\staged.exe", async () => ({ code: 1, out: "" }));
	});
});
