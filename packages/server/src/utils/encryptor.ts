import crypto from "node:crypto";
import { config } from "../config/index.js";

// AES-256-GCM at-rest encryption for datasource credentials.
// Key is a 32-byte hex string (CREDENTIAL_ENC_KEY). Output format:
//   <iv-hex>:<authTag-hex>:<ciphertext-hex>
const ALGO = "aes-256-gcm";

function key(): Buffer {
  const k = Buffer.from(config.credentialEncKey, "hex");
  if (k.length !== 32) {
    throw new Error("CREDENTIAL_ENC_KEY must be 32 bytes (64 hex chars)");
  }
  return k;
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed ciphertext");
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * The same AES-256-GCM under the same key, for bytes rather than text — an
 * uploaded SQLite file is up to 50 MB, and hex-encoding it through `encrypt`
 * would double it. Layout: iv (12) | tag (16) | ciphertext.
 */
export function encryptBytes(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptBytes(payload: Buffer): Buffer {
  if (payload.length < 28) throw new Error("Malformed ciphertext");
  const decipher = crypto.createDecipheriv(ALGO, key(), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}
