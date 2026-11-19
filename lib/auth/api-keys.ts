import "server-only";
import { sql } from "../db";
import { decrypt, encrypt } from "../crypto/aes";
import { hashToken, hmacSha256Hex, randomToken, safeEqual, sha256Hex } from "../crypto/tokens";
import { metaFromRequest } from "../security/request";
import { rateLimit } from "../security/rate-limit";
import { raiseAlert } from "../logging/alerts";
import { audit } from "../logging/audit";

/**
 * Brand-website API authentication (server-to-server).
 *
 * Every request must carry:
 *   X-PP-Key:        key id            (e.g. "ppk_9f3a...")
 *   X-PP-Timestamp:  unix seconds      (must be within ±300s)
 *   X-PP-Nonce:      random string     (single use, 16-64 chars)
 *   X-PP-Signature:  hex(HMAC_SHA256(secret, `${ts}.${nonce}.${METHOD}.${path}.${sha256hex(body)}`))
 *
 * The secret never travels over the wire, requests can't be replayed or
 * modified, and keys can be scoped, IP-restricted, expired and revoked.
 */

export const API_SECRET_CONTEXT = "api_key.secret";
export const API_SCOPES = ["invoices:write", "invoices:read", "inquiries:write", "customers:write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export async function createApiKey(input: { brandId: string | null; name: string; scopes: ApiScope[]; allowedIps: string[]; expiresAt: Date | null; createdBy: string }) {
  const keyId = `ppk_${randomToken(12)}`;
  const secret = `pps_${randomToken(32)}`;
  const [row] = await sql<{ id: string }[]>`
    insert into api_keys (brand_id, name, key_id, secret_hash, secret_enc, scopes, allowed_ips, expires_at, created_by)
    values (${input.brandId}, ${input.name}, ${keyId}, ${hashToken(secret)}, ${encrypt(secret, API_SECRET_CONTEXT)},
            ${input.scopes}, ${input.allowedIps}::inet[], ${input.expiresAt}, ${input.createdBy})
    returning id`;
  return { id: row.id, keyId, secret };
}

export type ApiAuth = { keyId: string; apiKeyId: string; brandId: string | null; scopes: string[] };

export class ApiAuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function signApiRequest(secret: string, ts: string, nonce: string, method: string, path: string, body: string) {
  return hmacSha256Hex(secret, `${ts}.${nonce}.${method.toUpperCase()}.${path}.${sha256Hex(body)}`);
}

export async function authenticateApiRequest(req: Request, rawBody: string, scope: ApiScope): Promise<ApiAuth> {
  const meta = metaFromRequest(req);
  const keyId = req.headers.get("x-pp-key") ?? "";
  const ts = req.headers.get("x-pp-timestamp") ?? "";
  const nonce = req.headers.get("x-pp-nonce") ?? "";
  const sig = (req.headers.get("x-pp-signature") ?? "").toLowerCase();

  if (!(await rateLimit(`api:ip:${meta.ip ?? "unknown"}`, 60, 120))) throw new ApiAuthError(429, "Rate limit exceeded");
  if (!/^ppk_[A-Za-z0-9_-]{8,40}$/.test(keyId) || !/^\d{9,11}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(sig)) {
    throw new ApiAuthError(401, "Missing or malformed authentication headers");
  }
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new ApiAuthError(401, "Timestamp outside allowed window");

  const [key] = await sql<{ id: string; brand_id: string | null; secret_enc: string; scopes: string[]; allowed_ips: string[]; expires_at: Date | null; revoked_at: Date | null; name: string }[]>`
    select id, brand_id, secret_enc, scopes, allowed_ips::text[] as allowed_ips, expires_at, revoked_at, name from api_keys where key_id = ${keyId}`;
  if (!key || key.revoked_at || (key.expires_at && key.expires_at < new Date())) throw new ApiAuthError(401, "Invalid API key");

  const url = new URL(req.url);
  const expected = signApiRequest(decrypt(key.secret_enc, API_SECRET_CONTEXT), ts, nonce, req.method, url.pathname, rawBody);
  if (!safeEqual(expected, sig)) {
    await audit({ actor: { type: "api_key", id: key.id, label: key.name }, action: "api.bad_signature", ip: meta.ip, userAgent: meta.userAgent, riskScore: 60, reasons: ["invalid_hmac"] });
    if (!(await rateLimit(`api:badsig:${keyId}`, 600, 5))) {
      await raiseAlert({ severity: "critical", type: "api_signature_failures", title: `Repeated bad API signatures for key "${key.name}"`, message: `IP ${meta.ip ?? "unknown"}` });
    }
    throw new ApiAuthError(401, "Invalid signature");
  }
  if (key.allowed_ips.length > 0 && (!meta.ip || !key.allowed_ips.some((ip) => ip.split("/")[0] === meta.ip))) {
    await audit({ actor: { type: "api_key", id: key.id, label: key.name }, action: "api.ip_blocked", ip: meta.ip, riskScore: 70, reasons: ["ip_not_allowed"] });
    throw new ApiAuthError(403, "IP not allowed");
  }
  if (!key.scopes.includes(scope)) throw new ApiAuthError(403, `Missing scope ${scope}`);

  const res = await sql`insert into api_nonces (key_id, nonce) values (${keyId}, ${nonce}) on conflict do nothing`;
  if (res.count === 0) throw new ApiAuthError(401, "Replay detected");
  await sql`update api_keys set last_used_at = now(), last_used_ip = ${meta.ip} where id = ${key.id}`;
  // opportunistic cleanup
  if (Math.random() < 0.02) await sql`delete from api_nonces where created_at < now() - interval '1 hour'`;

  return { keyId, apiKeyId: key.id, brandId: key.brand_id, scopes: key.scopes };
}
