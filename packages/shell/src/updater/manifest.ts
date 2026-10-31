/**
 * update.json: schema, canonical serialization and Ed25519 signature.
 *
 * Signed bytes = UTF-8( SIGNATURE_CONTEXT + canonicalize(manifest without "signature") )
 *
 * canonicalize() is JSON with object keys sorted (JS default string order,
 * i.e. UTF-16 code units), no whitespace, `undefined` members dropped, and
 * non-finite numbers rejected. Every field except `signature` is covered,
 * including unknown/future fields such as `patches`.
 */
import { UpdateError } from "./errors.ts";
import { fromBase64, sign, toBase64, verify } from "./crypto.ts";

export type OS = "darwin" | "linux" | "windows";
export type Arch = "arm64" | "x64";
export type PlatformKey = `${OS}-${Arch}`;
export type ArchiveFormat = "tar.zst" | "tar.gz";

export const PLATFORM_KEYS: readonly PlatformKey[] = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"windows-arm64",
	"windows-x64",
];
export const ARCHIVE_FORMATS: readonly ArchiveFormat[] = ["tar.zst", "tar.gz"];

/** Domain separation: a signature over a manifest can't be replayed as anything else. */
export const SIGNATURE_CONTEXT = "svelte-desktop/update-manifest/v1\n";

export interface Artifact {
	/** Absolute, or relative to the manifest URL. */
	url: string;
	/** Lowercase hex SHA-256 of the archive bytes. */
	sha256: string;
	/** Archive size in bytes. */
	size: number;
	format: ArchiveFormat;
}

export interface UpdateManifest {
	name: string;
	version: string;
	channel: string;
	/** ISO-8601 timestamp. */
	releasedAt: string;
	notes?: string;
	artifacts: Partial<Record<PlatformKey, Artifact>>;
	/** Installs older than this are told the update is mandatory. */
	minimumVersion?: string;
	/**
	 * RESERVED for binary delta updates (bsdiff chain, Electrobun-style). Not
	 * interpreted by this client; it is covered by the signature so a future
	 * client can trust it. See README "Extension point: patches".
	 */
	patches?: unknown;
	/** base64 Ed25519 signature; see module doc. */
	signature: string;
}

export type UnsignedManifest = Omit<UpdateManifest, "signature"> & { signature?: never };

// semver.org 2.0.0 regex (no leading "v").
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isSemver(v: unknown): v is string {
	return typeof v === "string" && v.length <= 256 && SEMVER.test(v);
}

export function canonicalize(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
		case "boolean":
			return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) throw new TypeError("canonicalize: non-finite number");
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) {
				return `[${value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`;
			}
			const obj = value as Record<string, unknown>;
			const parts: string[] = [];
			for (const key of Object.keys(obj).sort()) {
				if (obj[key] === undefined) continue;
				parts.push(`${JSON.stringify(key)}:${canonicalize(obj[key])}`);
			}
			return `{${parts.join(",")}}`;
		}
		default:
			throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
	}
}

export function signingPayload(manifest: object): Uint8Array {
	const { signature: _omit, ...rest } = manifest as Record<string, unknown>;
	return new TextEncoder().encode(SIGNATURE_CONTEXT + canonicalize(rest));
}

export async function signManifest(
	manifest: Omit<UpdateManifest, "signature"> | UpdateManifest,
	privateKeyPkcs8: Uint8Array,
): Promise<UpdateManifest> {
	const { signature: _old, ...rest } = manifest as UpdateManifest;
	validateManifest(rest, { unsigned: true });
	const sig = await sign(privateKeyPkcs8, signingPayload(rest));
	return { ...rest, signature: toBase64(sig) } as UpdateManifest;
}

/** True if any of the given base64 raw public keys verifies the manifest. */
export async function verifyManifestSignature(
	manifest: Record<string, unknown>,
	publicKeys: readonly string[],
): Promise<boolean> {
	if (typeof manifest.signature !== "string") return false;
	let sig: Uint8Array;
	try {
		sig = fromBase64(manifest.signature);
	} catch {
		return false;
	}
	let payload: Uint8Array;
	try {
		payload = signingPayload(manifest);
	} catch {
		return false;
	}
	for (const key of publicKeys) {
		let raw: Uint8Array;
		try {
			raw = fromBase64(key);
		} catch {
			continue;
		}
		if (await verify(raw, sig, payload)) return true;
	}
	return false;
}

function fail(msg: string): never {
	throw new UpdateError("manifest_invalid", `update manifest: ${msg}`);
}

/** Structural validation. Throws UpdateError("manifest_invalid"). */
export function validateManifest(m: unknown, opts: { unsigned?: boolean } = {}): asserts m is UpdateManifest {
	if (!m || typeof m !== "object" || Array.isArray(m)) fail("not an object");
	const o = m as Record<string, unknown>;
	if (typeof o.name !== "string" || !o.name) fail("name must be a non-empty string");
	if (!isSemver(o.version)) fail(`version ${JSON.stringify(o.version)} is not semver`);
	if (typeof o.channel !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(o.channel)) fail("invalid channel");
	if (typeof o.releasedAt !== "string" || Number.isNaN(Date.parse(o.releasedAt))) fail("releasedAt must be an ISO date");
	if (o.notes !== undefined && typeof o.notes !== "string") fail("notes must be a string");
	if (o.minimumVersion !== undefined && !isSemver(o.minimumVersion)) fail("minimumVersion is not semver");
	if (!opts.unsigned && (typeof o.signature !== "string" || !o.signature)) fail("missing signature");
	if (!o.artifacts || typeof o.artifacts !== "object" || Array.isArray(o.artifacts)) fail("artifacts must be an object");
	for (const [key, a] of Object.entries(o.artifacts as Record<string, unknown>)) {
		// Unknown platform keys are tolerated (forward compatibility) but must still be well-formed.
		if (!/^[a-z0-9]+-[a-z0-9]+$/.test(key)) fail(`bad artifact key ${key}`);
		if (!a || typeof a !== "object") fail(`artifact ${key} is not an object`);
		const art = a as Record<string, unknown>;
		if (typeof art.url !== "string" || !art.url) fail(`artifact ${key}: url missing`);
		if (typeof art.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(art.sha256)) fail(`artifact ${key}: sha256 must be 64 lowercase hex chars`);
		if (typeof art.size !== "number" || !Number.isSafeInteger(art.size) || art.size <= 0) fail(`artifact ${key}: size must be a positive integer`);
		if (!ARCHIVE_FORMATS.includes(art.format as ArchiveFormat)) fail(`artifact ${key}: format must be one of ${ARCHIVE_FORMATS.join(", ")}`);
	}
}

/** Parse + verify signature + validate. Signature is checked before anything is trusted. */
export async function parseSignedManifest(text: string, publicKeys: readonly string[]): Promise<UpdateManifest> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		fail("not valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("not an object");
	if (!(await verifyManifestSignature(parsed as Record<string, unknown>, publicKeys))) {
		throw new UpdateError("signature_invalid", "update manifest signature is invalid (or signed by an unknown key)");
	}
	validateManifest(parsed);
	return parsed;
}
