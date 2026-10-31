import { afterEach, describe, expect, test } from "bun:test";
import { _forceWebCrypto, hasWebCryptoEd25519, privateKeyFromText, privateKeyToPem } from "./crypto.ts";
import { UpdateError } from "./errors.ts";
import { canonicalize, parseSignedManifest, signManifest, verifyManifestSignature, type UpdateManifest } from "./manifest.ts";
import { makeKeys, signedManifest } from "./test-utils.ts";

const artifact = {
	url: "MyApp-darwin-arm64.tar.zst",
	sha256: "a".repeat(64),
	size: 1234,
	format: "tar.zst" as const,
};

describe("canonicalize", () => {
	test("sorts keys recursively, drops undefined, no whitespace", () => {
		expect(canonicalize({ b: 1, a: { d: [1, "x", null], c: true }, z: undefined })).toBe('{"a":{"c":true,"d":[1,"x",null]},"b":1}');
	});
	test("is independent of insertion order", () => {
		expect(canonicalize({ x: 1, y: { q: 2, p: 3 } })).toBe(canonicalize({ y: { p: 3, q: 2 }, x: 1 }));
	});
	test("rejects non-finite numbers", () => {
		expect(() => canonicalize({ a: Number.NaN })).toThrow();
	});
});

describe("manifest signature", () => {
	afterEach(() => _forceWebCrypto(undefined));

	test("Bun supports WebCrypto Ed25519", async () => {
		expect(await hasWebCryptoEd25519()).toBe(true);
	});

	test("valid signature verifies, also after JSON round-trip with reordered keys", async () => {
		const { privateKey, publicKey } = await makeKeys();
		const m = await signedManifest(privateKey, { artifacts: { "darwin-arm64": artifact } });
		expect(await verifyManifestSignature(m as never, [publicKey])).toBe(true);
		// Re-serialize with a different key order and pretty-printing: still valid.
		const reordered = JSON.stringify(Object.fromEntries(Object.entries(m).reverse()), null, 4);
		const parsed = await parseSignedManifest(reordered, [publicKey]);
		expect(parsed.version).toBe("2.0.0");
	});

	test("tampered manifest is rejected", async () => {
		const { privateKey, publicKey } = await makeKeys();
		const m = await signedManifest(privateKey, { artifacts: { "darwin-arm64": artifact } });
		const tamperings: ((x: UpdateManifest) => void)[] = [
			(x) => (x.version = "9.9.9"),
			(x) => (x.artifacts["darwin-arm64"]!.sha256 = "b".repeat(64)),
			(x) => (x.artifacts["darwin-arm64"]!.url = "https://evil.example/x.tar.zst"),
			(x) => (x.channel = "beta"),
			(x) => ((x as unknown as Record<string, unknown>).extra = 1),
			(x) => (x.signature = x.signature.replace(/^./, (c) => (c === "A" ? "B" : "A"))),
		];
		for (const tamper of tamperings) {
			const copy = structuredClone(m);
			tamper(copy);
			expect(await verifyManifestSignature(copy as never, [publicKey])).toBe(false);
			const err = await parseSignedManifest(JSON.stringify(copy), [publicKey]).catch((e) => e);
			expect(err).toBeInstanceOf(UpdateError);
			expect((err as UpdateError).code).toBe("signature_invalid");
		}
	});

	test("wrong key is rejected; any key of a rotation set is accepted", async () => {
		const signer = await makeKeys();
		const other = await makeKeys();
		const m = await signedManifest(signer.privateKey, { artifacts: { "darwin-arm64": artifact } });
		expect(await verifyManifestSignature(m as never, [other.publicKey])).toBe(false);
		expect(await verifyManifestSignature(m as never, [other.publicKey, signer.publicKey])).toBe(true);
		expect(await verifyManifestSignature(m as never, ["not base64!!"])).toBe(false);
	});

	test("missing or garbage signature is rejected", async () => {
		const { privateKey, publicKey } = await makeKeys();
		const m = await signedManifest(privateKey, {});
		const { signature: _, ...unsigned } = m;
		expect((await parseSignedManifest(JSON.stringify(unsigned), [publicKey]).catch((e) => e)).code).toBe("signature_invalid");
		expect((await parseSignedManifest(JSON.stringify({ ...m, signature: "AAAA" }), [publicKey]).catch((e) => e)).code).toBe("signature_invalid");
		expect((await parseSignedManifest("not json", [publicKey]).catch((e) => e)).code).toBe("manifest_invalid");
	});

	test("node:crypto fallback interoperates with WebCrypto signatures", async () => {
		const { privateKey, publicKey } = await makeKeys();
		const m = await signedManifest(privateKey, { artifacts: { "darwin-arm64": artifact } });
		_forceWebCrypto(false);
		expect(await verifyManifestSignature(m as never, [publicKey])).toBe(true);
		const m2 = await signManifest({ ...m, version: "2.0.1" }, privateKey);
		_forceWebCrypto(true);
		expect(await verifyManifestSignature(m2 as never, [publicKey])).toBe(true);
	});

	test("signManifest refuses structurally invalid manifests", async () => {
		const { privateKey } = await makeKeys();
		await expect(signedManifest(privateKey, { version: "v2" })).rejects.toThrow(/semver/);
		await expect(signedManifest(privateKey, { artifacts: { "darwin-arm64": { ...artifact, sha256: "XYZ" } } })).rejects.toThrow(/sha256/);
		await expect(signedManifest(privateKey, { artifacts: { "darwin-arm64": { ...artifact, format: "zip" as never } } })).rejects.toThrow(/format/);
	});

	test("private key PEM round-trip", async () => {
		const { privateKey } = await makeKeys();
		expect(privateKeyFromText(privateKeyToPem(privateKey))).toEqual(privateKey);
	});
});
