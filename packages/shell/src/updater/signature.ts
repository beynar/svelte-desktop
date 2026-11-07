// What the OS itself says about an update, on top of the update key: a staged app has to carry a
// valid signature from whoever signed the one that's running. A leaked update key then isn't enough
// to replace a signed app. An app that isn't signed (a development build) has nothing to compare to.
// On one that is, a tool that doesn't answer refuses the update: nothing has said it's good.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { UpdateError } from "./errors.ts";
import { psQuote, windowsPowerShell } from "./helper.ts";

export type Run = (argv: string[]) => Promise<{ code: number; out: string }>;

// One that's stuck doesn't hold the update forever. The kill makes it a failure like any other.
const TOOL_TIMEOUT_MS = 120_000;

const run: Run = async (argv) => {
	try {
		const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: TOOL_TIMEOUT_MS });
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out: `${out}${err}` };
	} catch (err) {
		return { code: -1, out: (err as Error).message }; // it isn't there
	}
};

const unanswered = (tool: string, out: string) => new UpdateError("signature_invalid", `${tool} can't check the update's signature, so it isn't applied: ${out.trim() || "no answer"}`);

/** The Team ID, "adhoc", or null when it isn't signed. codesign writes this on stderr. */
async function macSigner(app: string, exec: Run): Promise<string | null> {
	const { code, out } = await exec(["/usr/bin/codesign", "-dvv", app]);
	if (code !== 0) {
		if (/not signed at all|No such file/.test(out)) return null;
		throw unanswered("codesign", out);
	}
	const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim();
	return team && team !== "not set" ? team : "adhoc";
}

export async function verifyMacUpdate(running: string, staged: string, exec: Run = run): Promise<void> {
	const signer = await macSigner(running, exec);
	if (!signer) return;
	// --deep: the whole bundle, what's nested in it included.
	const { code, out } = await exec(["/usr/bin/codesign", "--verify", "--deep", "--strict", staged]);
	if (code !== 0) throw new UpdateError("signature_invalid", `the update's code signature is invalid: ${out.trim()}`);
	if (signer === "adhoc") return;
	const theirs = await macSigner(staged, exec);
	if (theirs !== signer) throw new UpdateError("signature_invalid", `the update is signed by ${theirs ?? "nobody"}, this app by ${signer}`);
}

/** Status and subject of each file, in order, or null if PowerShell didn't say. */
async function authenticode(files: string[], exec: Run): Promise<{ status: string; subject: string }[] | null> {
	const script = `foreach ($f in @(${files.map(psQuote).join(",")})) { $s = Get-AuthenticodeSignature -LiteralPath $f; "$($s.Status)|$($s.SignerCertificate.Subject)" }`;
	const { code, out } = await exec([windowsPowerShell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`]);
	const lines = out.split(/\r?\n/).filter((line) => /^[A-Za-z]+\|/.test(line));
	if (code !== 0 || lines.length !== files.length) return null;
	return lines.map((line) => {
		const at = line.indexOf("|");
		return { status: line.slice(0, at).trim(), subject: line.slice(at + 1).trim() };
	});
}

/** Whether a PE file has a certificate table: what's left to go by when PowerShell doesn't answer. */
export function hasCertificateTable(file: string): boolean {
	const head = Buffer.alloc(4096);
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return true; // nothing says it isn't
	}
	try {
		readSync(fd, head, 0, head.length, 0);
	} finally {
		closeSync(fd);
	}
	const pe = head.readUInt32LE(0x3c);
	if (pe + 24 + 152 > head.length || head.readUInt32LE(pe) !== 0x4550) return true;
	const optional = pe + 24;
	// The security entry of the data directories, its offset depending on PE32 or PE32+.
	const entry = optional + (head.readUInt16LE(optional) === 0x20b ? 144 : 128);
	return head.readUInt32LE(entry + 4) !== 0;
}

const isCode = (name: string) => /\.(exe|dll|node)$/i.test(name);

/** Every .exe, .dll and native addon under what an update puts in place. */
export function codeFiles(paths: string[]): string[] {
	return paths.flatMap((path) => {
		if (!statSync(path).isDirectory()) return isCode(path) ? [path] : [];
		return codeFiles(readdirSync(path).map((name) => join(path, name)));
	});
}

// PowerShell's command line has a limit: this many paths stay well under it.
const FILES_PER_CALL = 40;

export async function verifyWindowsUpdate(running: string, staged: string[], exec: Run = run): Promise<void> {
	const mine = (await authenticode([running], exec))?.[0];
	if (!mine) {
		if (hasCertificateTable(running)) throw unanswered("PowerShell", "");
		return;
	}
	if (mine.status === "NotSigned" || !mine.subject) return;
	for (let i = 0; i < staged.length; i += FILES_PER_CALL) {
		const files = staged.slice(i, i + FILES_PER_CALL);
		const theirs = await authenticode(files, exec);
		if (!theirs) throw unanswered("PowerShell", "");
		theirs.forEach(({ status, subject }, n) => {
			if (status !== "Valid") throw new UpdateError("signature_invalid", `the update's ${files[n]} has a signature that is ${status}`);
			if (subject !== mine.subject) throw new UpdateError("signature_invalid", `the update's ${files[n]} is signed by ${subject}, this app by ${mine.subject}`);
		});
	}
}
