/**
 * AES-256-GCM authenticated encryption for secrets at rest.
 *
 * Format: "enc:v1:<keyId>:<iv>:<tag>:<ciphertext>" (base64url parts)
 *  - keyId: first 8 hex chars of sha256(key) → supports key rotation
 *  - iv:    12 random bytes per message
 *  - AAD:   optional context string (e.g. "merchant.credentials") binding the
 *           ciphertext to its purpose so it can't be swapped into another column.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1";

type Key = { id: string; key: Buffer };

function parseKey(b64: string): Key {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes (base64 encoded)");
  return { id: createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}

let cache: { active: Key; all: Map<string, Key>; src: string } | null = null;

function keys() {
  const activeB64 = process.env.ENCRYPTION_KEY;
  if (!activeB64) throw new Error("Missing ENCRYPTION_KEY");
  const prev = process.env.ENCRYPTION_KEYS_PREVIOUS ?? "";
  const src = activeB64 + "|" + prev;
  if (cache && cache.src === src) return cache;
  const active = parseKey(activeB64);
  const all = new Map<string, Key>([[active.id, active]]);
  for (const p of prev.split(",").map((s) => s.trim()).filter(Boolean)) {
    const k = parseKey(p);
    all.set(k.id, k);
  }
  cache = { active, all, src };
  return cache;
}

export function encrypt(plaintext: string, context = ""): string {
  const { active } = keys();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", active.key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, active.id, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

export function decrypt(payload: string, context = ""): string {
  const parts = payload.split(":");
  if (parts.length !== 6 || `${parts[0]}:${parts[1]}` !== PREFIX) throw new Error("Invalid encrypted payload");
  const [, , keyId, ivB64, tagB64, ctB64] = parts;
  const key = keys().all.get(keyId);
  if (!key) throw new Error("Unknown encryption key id — was ENCRYPTION_KEY rotated without ENCRYPTION_KEYS_PREVIOUS?");
  const decipher = createDecipheriv("aes-256-gcm", key.key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

export function encryptJson(value: unknown, context = ""): string {
  return encrypt(JSON.stringify(value), context);
}

export function decryptJson<T>(payload: string, context = ""): T {
  return JSON.parse(decrypt(payload, context)) as T;
}

/** True when the payload was encrypted with an older key and should be re-encrypted. */
export function needsReEncryption(payload: string): boolean {
  return payload.split(":")[2] !== keys().active.id;
}
