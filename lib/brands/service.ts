import "server-only";
import { sql } from "../db";
import { hmacSha256Hex } from "../crypto/tokens";
import type { BrandRow } from "../types";

export async function getBrand(id: string): Promise<BrandRow | null> {
  const [b] = await sql<BrandRow[]>`select * from brands where id = ${id}`;
  return b ?? null;
}

/** Base URL of the platform (your main domain), e.g. https://payments.yourcompany.com */
export function appBaseUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Path of a brand's payment page: /pay/<brand-slug>/<token> */
export function payPath(brand: Pick<BrandRow, "slug">, token: string): string {
  return `/pay/${brand.slug}/${token}`;
}

/** Where this brand's payment pages are served: its own verified website, or the portal. */
export function brandPayBase(brand: Pick<BrandRow, "pay_domain" | "pay_domain_verified_at">): string {
  if (brand.pay_domain && brand.pay_domain_verified_at) return `https://${brand.pay_domain}`;
  return appBaseUrl();
}

/** Full payment link, e.g. https://graphicwolves.com/pay/graphic-wolves/<token> */
export function payUrl(brand: Pick<BrandRow, "slug" | "pay_domain" | "pay_domain_verified_at">, token: string): string {
  return `${brandPayBase(brand)}${payPath(brand, token)}`;
}

/** Marker proving a /pay/healthcheck response comes from THIS portal. */
export function portalMarker(): string {
  return hmacSha256Hex(process.env.APP_SECRET ?? "dev", "pay-healthcheck").slice(0, 24);
}

/** Hosts allowed to call the pay APIs for this brand (CSRF origin check). */
export function brandOriginHosts(brand: Pick<BrandRow, "pay_domain">): string[] {
  if (!brand.pay_domain) return [];
  const d = brand.pay_domain.toLowerCase().replace(/^www\./, "");
  return [d, `www.${d}`];
}

/**
 * Check that https://<domain>/pay/healthcheck reaches this portal over HTTPS. Follows redirects such as example.com →
 * www.example.com and reports the final host, so links skip the extra hop.
 */
export async function verifyPayDomain(domain: string): Promise<{ ok: true; host: string } | { ok: false; problem: string }> {
  const url = `https://${domain}/pay/healthcheck`;
  try {
    const res = await fetch(url, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(10000) });
    const body = (await res.json().catch(() => null)) as { app?: string; marker?: string } | null;
    if (!res.ok || body?.app !== "payment-portal") return { ok: false, problem: `${url} did not answer as the payment portal (HTTP ${res.status}). Check the DNS record and that the subdomain is added to the portal's Vercel project (DNS and HTTPS can take a few minutes).` };
    if (body.marker !== portalMarker()) return { ok: false, problem: `${url} forwards to a different portal installation.` };
    const finalHost = new URL(res.url || url).host.toLowerCase();
    const base = domain.toLowerCase().replace(/^www\./, "");
    // only accept a redirect within the same site (example.com <-> www.example.com)
    const host = finalHost.replace(/^www\./, "") === base ? finalHost : domain.toLowerCase();
    return { ok: true, host };
  } catch (e) {
    return { ok: false, problem: `Could not reach ${url}: ${(e as Error).message}` };
  }
}
