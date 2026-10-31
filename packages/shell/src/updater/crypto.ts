/**
 * Ed25519 primitives. WebCrypto Ed25519 is used when the runtime supports it
 * (Bun >= 1.1 does); otherwise we fall back to node:crypto. Keys travel as:
 *   - public key: raw 32 bytes, base64 (what the app embeds)
 *   - private key: PKCS#8 DER (48 bytes), stored as a PEM "PRIVATE KEY" file
 *     (interoperable with `openssl pkey`).
 */
import * as nodeCrypto from "node:crypto";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

let webCryptoSupport: Promise<boolean> | undefined;

/** TS 5.7+ types WebCrypto inputs as ArrayBuffer-backed views; ours always are. */
const bs = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

/** True when crypto.subtle supports Ed25519 in this runtime (cached). */
export function hasWebCryptoEd25519(): Promise<boolean> {
	webCryptoSupport ??= (async () => {
		try {
			if (!globalThis.crypto?.subtle) return false;
			const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
				"sign",
				"verify",
			])) as unknown as CryptoKeyPair;
			const msg = new Uint8Array([1, 2, 3]);
			const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, msg);
			return await crypto.subtle.verify("Ed25519", kp.publicKey, sig, msg);
		} catch {
			return false;
		}
	})();
	return webCryptoSupport;
}

/** Test hook: force the node:crypto fallback path (or reset with undefined). */
export function _forceWebCrypto(value: boolean | undefined): void {
	webCryptoSupport = value === undefined ? undefined : Promise.resolve(value);
}

export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

export function fromBase64(text: string): Uint8Array {
	const trimmed = text.trim();
	if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(trimmed)) throw new Error("invalid base64");
	return new Uint8Array(Buffer.from(trimmed, trimmed.includes("-") || trimmed.includes("_") ? "base64url" : "base64"));
}

export interface KeyPair {
	/** PKCS#8 DER private key. */
	privateKey: Uint8Array;
	/** Raw 32-byte public key. */
	publicKey: Uint8Array;
}

export async function generateKeyPair(): Promise<KeyPair> {
	if (await hasWebCryptoEd25519()) {
		const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
			"sign",
			"verify",
		])) as CryptoKeyPair;
		return {
			privateKey: new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)),
			publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)),
		};
	}
	const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync("ed25519");
	return {
		privateKey: new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" })),
		publicKey: new Uint8Array(publicKey.export({ format: "der", type: "spki" })).slice(SPKI_PREFIX.length),
	};
}

export async function publicKeyFromPrivate(pkcs8: Uint8Array): Promise<Uint8Array> {
	if (await hasWebCryptoEd25519()) {
		const key = await crypto.subtle.importKey("pkcs8", bs(pkcs8), { name: "Ed25519" }, true, ["sign"]);
		const jwk = await crypto.subtle.exportKey("jwk", key);
		if (!jwk.x) throw new Error("cannot derive public key");
		return new Uint8Array(Buffer.from(jwk.x, "base64url"));
	}
	const priv = nodeCrypto.createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" });
	const spki = nodeCrypto.createPublicKey(priv).export({ format: "der", type: "spki" });
	return new Uint8Array(spki).slice(SPKI_PREFIX.length);
}

export async function sign(pkcs8: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	if (await hasWebCryptoEd25519()) {
		const key = await crypto.subtle.importKey("pkcs8", bs(pkcs8), { name: "Ed25519" }, false, ["sign"]);
		return new Uint8Array(await crypto.subtle.sign("Ed25519", key, bs(data)));
	}
	const key = nodeCrypto.createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" });
	return new Uint8Array(nodeCrypto.sign(null, data, key));
}

export async function verify(publicKeyRaw: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
	if (publicKeyRaw.length !== 32 || signature.length !== 64) return false;
	try {
		if (await hasWebCryptoEd25519()) {
			const key = await crypto.subtle.importKey("raw", bs(publicKeyRaw), { name: "Ed25519" }, false, ["verify"]);
			return await crypto.subtle.verify("Ed25519", key, bs(signature), bs(data));
		}
		const key = nodeCrypto.createPublicKey({
			key: Buffer.concat([SPKI_PREFIX, publicKeyRaw]),
			format: "der",
			type: "spki",
		});
		return nodeCrypto.verify(null, data, key, signature);
	} catch {
		return false;
	}
}

export function privateKeyToPem(pkcs8: Uint8Array): string {
	const b64 = toBase64(pkcs8).replace(/(.{64})/g, "$1\n").trimEnd();
	return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** Accepts a PEM "PRIVATE KEY" block or bare base64 PKCS#8. */
export function privateKeyFromText(text: string): Uint8Array {
	const pem = text.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
	const der = fromBase64((pem ? pem[1]! : text).replace(/\s+/g, ""));
	if (der.length !== 48) throw new Error("not an Ed25519 PKCS#8 private key");
	return der;
}
