import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Problem, requireCondition } from "./security";

// RFC 6238: SHA-1, 30-second steps, six digits; enrollment URI declares each value.
export function totpAt(secret: Buffer, timeMs: number, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits)
    .toString()
    .padStart(digits, "0");
}
export function matchingCounter(
  secret: Buffer,
  code: string,
  last: number,
  now = Date.now(),
) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  for (const counter of [current, current - 1, current + 1]) {
    if (
      counter >= 0 &&
      counter > last &&
      timingSafeEqual(
        Buffer.from(totpAt(secret, counter * 30_000)),
        Buffer.from(code),
      )
    )
      return counter;
  }
  return null;
}
export function base32(value: Buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    buffer = 0,
    output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}
export function mfaKeyAvailable() {
  return /^[a-fA-F0-9]{64}$/.test(process.env.MFA_ENCRYPTION_KEY ?? "");
}
function key() {
  requireCondition(
    mfaKeyAvailable(),
    503,
    "Authenticator setup is unavailable. Contact the application administrator.",
  );
  return Buffer.from(process.env.MFA_ENCRYPTION_KEY!, "hex");
}
export function encryptFactor(secret: Buffer, identity: string) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(identity));
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}
export function decryptFactor(value: string, identity: string) {
  const secretKey = key();
  try {
    const [version, nonce, encrypted, tag] = value.split(".");
    if (version !== "v1") throw new Error("Unsupported encryption version");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      secretKey,
      Buffer.from(nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from(identity));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]);
  } catch {
    throw new Problem(
      503,
      "Authenticator verification is unavailable. Contact the application administrator.",
    );
  }
}
