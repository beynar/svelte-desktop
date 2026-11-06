// What the OS itself says about an update, on top of the update key: a staged app has to carry a
// valid signature from whoever signed the one that's running. A leaked update key then isn't enough
// to replace a signed app. An app that isn't signed (a development build) has nothing to compare to.
import { UpdateError } from "./errors.ts";
import { windowsPowerShell } from "./helper.ts";

export type Run = (argv: string[]) => Promise<{ code: number; out: string }>;

const run: Run = async (argv) => {
	const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, out: `${out}${err}` };
};

/** The Team ID, "adhoc", or null when it isn't signed. codesign writes this on stderr. */
async function macSigner(app: string, exec: Run): Promise<string | null> {
	const { code, out } = await exec(["/usr/bin/codesign", "-dvv", app]);
	if (code !== 0) return null;
	const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim();
	return team && team !== "not set" ? team : "adhoc";
}

export async function verifyMacUpdate(running: string, staged: string, exec: Run = run): Promise<void> {
	const signer = await macSigner(running, exec);
	if (!signer) return;
	const { code, out } = await exec(["/usr/bin/codesign", "--verify", "--deep", "--strict", staged]);
	if (code !== 0) throw new UpdateError("signature_invalid", `the update's code signature is invalid: ${out.trim()}`);
	if (signer === "adhoc") return;
	const theirs = await macSigner(staged, exec);
	if (theirs !== signer) throw new UpdateError("signature_invalid", `the update is signed by ${theirs ?? "nobody"}, this app by ${signer}`);
}

const authenticode = async (exe: string, exec: Run) => {
	const script = `$s = Get-AuthenticodeSignature -LiteralPath '${exe.replace(/'/g, "''")}'; $s.Status.ToString(); if ($s.SignerCertificate) { $s.SignerCertificate.Subject }`;
	const { code, out } = await exec([windowsPowerShell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`]);
	if (code !== 0) return null;
	const [status, subject] = out.trim().split(/\r?\n/);
	return { status: status?.trim() ?? "", subject: subject?.trim() ?? "" };
};

export async function verifyWindowsUpdate(running: string, staged: string, exec: Run = run): Promise<void> {
	const mine = await authenticode(running, exec);
	// PowerShell not answering says nothing about the update.
	if (!mine || mine.status === "NotSigned" || !mine.subject) return;
	const theirs = await authenticode(staged, exec);
	if (!theirs) return;
	if (theirs.status !== "Valid") throw new UpdateError("signature_invalid", `the update's signature is ${theirs.status}`);
	if (theirs.subject !== mine.subject) throw new UpdateError("signature_invalid", `the update is signed by ${theirs.subject}, this app by ${mine.subject}`);
}
