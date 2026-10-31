// Web Push message encryption, receiving side: RFC 8291 (aes128gcm, RFC 8188 records)
// with the device's P-256 key pair and auth secret. Plain JCA, no Android API, so
// package-android.test.ts also runs it on a desktop JVM against RFC 8291 Appendix A.
package dev.sveltedesktop;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class WebPushCrypto {
    private WebPushCrypto() {}

    static ECParameterSpec p256() throws Exception {
        AlgorithmParameters p = AlgorithmParameters.getInstance("EC");
        p.init(new ECGenParameterSpec("secp256r1"));
        return p.getParameterSpec(ECParameterSpec.class);
    }

    static KeyPair generate() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        return g.generateKeyPair();
    }

    private static byte[] fixed(BigInteger v) {
        byte[] b = v.toByteArray(), out = new byte[32];
        int n = Math.min(b.length, 32);
        System.arraycopy(b, b.length - n, out, 32 - n, n);
        return out;
    }

    /** The uncompressed point 0x04 ‖ X ‖ Y (65 bytes): Web Push's p256dh. */
    static byte[] publicRaw(ECPublicKey k) {
        byte[] out = new byte[65];
        out[0] = 4;
        System.arraycopy(fixed(k.getW().getAffineX()), 0, out, 1, 32);
        System.arraycopy(fixed(k.getW().getAffineY()), 0, out, 33, 32);
        return out;
    }

    static ECPublicKey publicFromRaw(byte[] raw) throws Exception {
        if (raw.length != 65 || raw[0] != 4) throw new IllegalArgumentException("not an uncompressed P-256 point");
        ECPoint w = new ECPoint(new BigInteger(1, Arrays.copyOfRange(raw, 1, 33)), new BigInteger(1, Arrays.copyOfRange(raw, 33, 65)));
        return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(w, p256()));
    }

    static ECPrivateKey privateFromScalar(byte[] d) throws Exception {
        return (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(new BigInteger(1, d), p256()));
    }

    private static byte[] hmac(byte[] key, byte[]... parts) throws Exception {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(key, "HmacSHA256"));
        for (byte[] p : parts) m.update(p);
        return m.doFinal();
    }

    /** HKDF-SHA-256 (RFC 5869), one expand block: every length here is ≤ 32. */
    static byte[] hkdf(byte[] salt, byte[] ikm, byte[] info, int length) throws Exception {
        byte[] prk = hmac(salt, ikm);
        return Arrays.copyOf(hmac(prk, info, new byte[] { 1 }), length);
    }

    private static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int at = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, out, at, p.length); at += p.length; }
        return out;
    }

    /** An aes128gcm body (salt ‖ rs ‖ idlen ‖ keyid ‖ records) → the plaintext. */
    static byte[] decrypt(byte[] body, ECPrivateKey uaPrivate, byte[] uaPublic, byte[] authSecret) throws Exception {
        if (body.length < 21) throw new IllegalArgumentException("aes128gcm: truncated header");
        byte[] salt = Arrays.copyOfRange(body, 0, 16);
        long rs = ((body[16] & 0xffL) << 24) | ((body[17] & 0xff) << 16) | ((body[18] & 0xff) << 8) | (body[19] & 0xff);
        int idlen = body[20] & 0xff;
        if (rs < 18 || body.length < 21 + idlen) throw new IllegalArgumentException("aes128gcm: bad header");
        byte[] asPublic = Arrays.copyOfRange(body, 21, 21 + idlen); // the sender's ephemeral key
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(uaPrivate);
        ka.doPhase(publicFromRaw(asPublic), true);
        byte[] ecdh = ka.generateSecret();
        byte[] ikm = hkdf(authSecret, ecdh, concat("WebPush: info\0".getBytes(StandardCharsets.US_ASCII), uaPublic, asPublic), 32);
        byte[] cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.US_ASCII), 16);
        byte[] nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0".getBytes(StandardCharsets.US_ASCII), 12);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        int at = 21 + idlen;
        for (long seq = 0; at < body.length; seq++) {
            int end = (int) Math.min(body.length, at + rs);
            byte[] iv = nonce.clone();
            for (int i = 0; i < 8; i++) iv[11 - i] ^= (byte) (seq >>> (8 * i));
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, iv));
            byte[] rec = c.doFinal(body, at, end - at);
            // Padding: content ‖ delimiter (0x02 last record, 0x01 others) ‖ 0x00*.
            int k = rec.length - 1;
            while (k >= 0 && rec[k] == 0) k--;
            if (k < 0 || (rec[k] != 1 && rec[k] != 2)) throw new IllegalArgumentException("aes128gcm: no record delimiter");
            boolean last = rec[k] == 2;
            out.write(rec, 0, k);
            at = end;
            if (last) break;
        }
        return out.toByteArray();
    }
}
