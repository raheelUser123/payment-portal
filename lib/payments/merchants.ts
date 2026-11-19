import "server-only";
import { sql } from "../db";
import { decryptJson, encryptJson } from "../crypto/aes";
import type { LoadedMerchant, MerchantCredentials } from "./types";
import type { MerchantRow, Provider } from "../types";
import { SUPPORTED_PROVIDERS } from "./registry";

export const MERCHANT_CREDENTIALS_CONTEXT = "merchant.credentials";

export function encryptCredentials(c: MerchantCredentials): string {
  return encryptJson(c, MERCHANT_CREDENTIALS_CONTEXT);
}

function load(row: MerchantRow): LoadedMerchant {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    mode: row.mode,
    publicConfig: row.public_config ?? {},
    credentials: decryptJson<MerchantCredentials>(row.credentials_enc, MERCHANT_CREDENTIALS_CONTEXT),
  };
}

export async function loadMerchant(id: string): Promise<LoadedMerchant | null> {
  const [row] = await sql<MerchantRow[]>`select * from merchants where id = ${id}`;
  return row ? load(row) : null;
}

/**
 * Merchants eligible to take a payment for an invoice, best first.
 * Rules: linked to the brand & active, merchant active, provider implemented,
 * currency supported, within per-transaction and monthly volume limits.
 * If the invoice pins a merchant, only that merchant is considered.
 */
export async function eligibleMerchants(opts: { brandId: string; currency: string; amountMinor: number; pinnedMerchantId: string | null }): Promise<LoadedMerchant[]> {
  const rows = await sql<(MerchantRow & { priority: number; month_volume: number })[]>`
    select m.*, bm.priority,
           coalesce((select sum(p.amount_minor) from payments p
                      where p.merchant_id = m.id and p.status in ('succeeded','partially_refunded','disputed')
                        and p.created_at >= date_trunc('month', now())), 0)::bigint as month_volume
      from merchants m
      join brand_merchants bm on bm.merchant_id = m.id and bm.brand_id = ${opts.brandId} and bm.is_active
     where m.status = 'active'
       and ${opts.currency.toUpperCase()} = any(m.supported_currencies)
       and (${opts.pinnedMerchantId}::uuid is null or m.id = ${opts.pinnedMerchantId}::uuid)
     order by bm.priority asc, m.created_at asc`;

  return rows
    .filter((r) => SUPPORTED_PROVIDERS.includes(r.provider))
    .filter((r) => !r.per_txn_limit_minor || opts.amountMinor <= r.per_txn_limit_minor)
    .filter((r) => !r.monthly_limit_minor || r.month_volume + opts.amountMinor <= r.monthly_limit_minor)
    .map(load);
}

/** First eligible merchant per provider (what the pay page offers). */
export async function checkoutOptions(opts: Parameters<typeof eligibleMerchants>[0]) {
  const list = await eligibleMerchants(opts);
  const byProvider = new Map<Provider, LoadedMerchant>();
  for (const m of list) if (!byProvider.has(m.provider)) byProvider.set(m.provider, m);
  return [...byProvider.values()];
}
