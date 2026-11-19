import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(secret: string | Buffer, input: string | Buffer): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Peppered hash for bearer tokens stored in the DB (session cookies, pay links, API keys). */
export function hashToken(token: string): string {
  const pepper = process.env.APP_SECRET;
  if (!pepper) throw new Error("Missing APP_SECRET");
  return hmacSha256Hex(pepper, token);
}
