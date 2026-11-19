import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sql } from "../db";
import { decrypt, encrypt } from "../crypto/aes";
import { hmacSha256Hex, randomToken } from "../crypto/tokens";

/**
 * Outbound webhooks to brand websites / CRMs.
 * Signature header (Stripe-style):  X-PP-Signature: t=<unix>,v1=<hex hmac>
 *   v1 = HMAC_SHA256(endpoint_secret, `${t}.${rawBody}`)
 * Receivers must verify the HMAC with a constant-time compare and reject t older than 5 minutes.
 */

export const WEBHOOK_SECRET_CONTEXT = "webhook_endpoint.secret";
export const OUTBOUND_EVENTS = [
  "invoice.created", "invoice.sent", "invoice.paid", "invoice.voided",
  "payment.succeeded", "payment.failed", "payment.refunded", "dispute.created", "inquiry.created",
] as const;
export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

export function newWebhookSecret() {
  const secret = `whsec_${randomToken(32)}`;
  return { secret, enc: encrypt(secret, WEBHOOK_SECRET_CONTEXT) };
}

export function signPayload(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  return `t=${ts},v1=${hmacSha256Hex(secret, `${ts}.${body}`)}`;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") ||
    (v6.startsWith("::ffff:") && isPrivateAddress(v6.slice(7)));
}

/** SSRF guard: https only, no credentials, and host must resolve to public IPs only. */
export async function assertSafeUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Webhook URL must use https");
  if (url.username || url.password) throw new Error("Credentials in URL are not allowed");
  if (url.port && !["443", "8443"].includes(url.port)) throw new Error("Only ports 443/8443 are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new Error("Webhook URL resolves to a private address");
  return url;
}

/** Queue an event for all matching endpoints of a brand (and global endpoints) and try delivery now. */
export async function emitEvent(brandId: string | null, type: OutboundEvent, data: Record<string, unknown>) {
  try {
    const endpoints = await sql<{ id: string }[]>`
      select id from webhook_endpoints
       where is_active and (brand_id is null or brand_id = ${brandId})
         and (cardinality(events) = 0 or ${type} = any(events))`;
    if (endpoints.length === 0) return;
    const payload = { id: `evt_${randomToken(12)}`, type, created: Math.floor(Date.now() / 1000), data };
    const rows = await sql<{ id: string }[]>`
      insert into webhook_deliveries ${sql(endpoints.map((e) => ({ endpoint_id: e.id, event_type: type, payload: sql.json(payload as never) })))}
      returning id`;
    await Promise.all(rows.map((r) => deliver(r.id)));
  } catch (err) {
    console.error("[webhooks] emit failed", type, err);
  }
}

const BACKOFF_MIN = [1, 5, 30, 120, 360, 720];

export async function deliver(deliveryId: string): Promise<void> {
  const [d] = await sql<{ id: string; payload: unknown; attempts: number; url: string; secret_enc: string; event_type: string }[]>`
    select d.id, d.payload, d.attempts, d.event_type, e.url, e.secret_enc
      from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
     where d.id = ${deliveryId} and d.status = 'pending' and e.is_active`;
  if (!d) return;
  const body = JSON.stringify(d.payload);
  let code: number | null = null;
  let error: string | null = null;
  try {
    const url = await assertSafeUrl(d.url);
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PaymentPortal-Webhooks/1.0",
        "X-PP-Event": d.event_type,
        "X-PP-Delivery": d.id,
        "X-PP-Signature": signPayload(decrypt(d.secret_enc, WEBHOOK_SECRET_CONTEXT), body),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    code = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message.slice(0, 300);
  }
  const attempts = d.attempts + 1;
  if (!error) {
    await sql`update webhook_deliveries set status = 'delivered', attempts = ${attempts}, response_code = ${code}, delivered_at = now(), last_error = null where id = ${d.id}`;
  } else if (attempts >= BACKOFF_MIN.length) {
    await sql`update webhook_deliveries set status = 'failed', attempts = ${attempts}, response_code = ${code}, last_error = ${error} where id = ${d.id}`;
  } else {
    await sql`update webhook_deliveries set attempts = ${attempts}, response_code = ${code}, last_error = ${error},
              next_retry_at = now() + make_interval(mins => ${BACKOFF_MIN[attempts]}) where id = ${d.id}`;
  }
}

export async function retryDueDeliveries(limit = 50) {
  const due = await sql<{ id: string }[]>`
    select id from webhook_deliveries where status = 'pending' and next_retry_at <= now() order by next_retry_at limit ${limit}`;
  for (const d of due) await deliver(d.id);
  return due.length;
}
