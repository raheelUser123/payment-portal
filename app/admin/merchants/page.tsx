import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { PageHeader, TableWrap, Badge, StatusBadge, Empty, LinkButton, dt } from "@/components/ui";
import { formatMoney } from "@/lib/payments/money";

export const metadata = { title: "Merchants" };

export default async function MerchantsPage() {
  await requireAdmin();
  const rows = await sql<{ id: string; name: string; provider: string; mode: string; status: string; supported_currencies: string[]; brands: string[] | null; volume: { currency: string; amount: number }[]; last_verified_at: Date | null; monthly_limit_minor: number | null }[]>`
    select m.id, m.name, m.provider, m.mode, m.status, m.supported_currencies, m.last_verified_at, m.monthly_limit_minor,
           (select array_agg(b.name order by b.name) from brand_merchants bm join brands b on b.id = bm.brand_id where bm.merchant_id = m.id and bm.is_active) as brands,
           coalesce((select json_agg(json_build_object('currency', v.currency, 'amount', v.amount)) from (
              select p.currency, sum(p.amount_minor - p.amount_refunded_minor)::bigint as amount from payments p
               where p.merchant_id = m.id and p.status in ('succeeded','partially_refunded','disputed') and p.created_at >= date_trunc('month', now())
               group by p.currency) v), '[]'::json) as volume
      from merchants m order by m.status, m.name`;
  return (
    <>
      <PageHeader title="Merchants" description="Gateway accounts (Stripe, PayPal…). One merchant can serve many brands; customers only ever see the brand."
        actions={<><LinkButton href="/admin/merchants/new?provider=stripe">Add Stripe</LinkButton><LinkButton href="/admin/merchants/new?provider=paypal" variant="secondary">Add PayPal</LinkButton></>} />
      {rows.length === 0 ? <Empty>No merchants yet. Add your Stripe account to start accepting payments.</Empty> : (
        <TableWrap>
          <thead><tr><th>Merchant</th><th>Provider</th><th>Mode</th><th>Status</th><th>Currencies</th><th>Brands</th><th>Net volume this month</th><th>Verified</th><th></th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td><Link href={`/admin/merchants/${m.id}`} className="font-medium text-indigo-700 hover:underline">{m.name}</Link></td>
                <td><Badge tone="blue">{m.provider}</Badge></td>
                <td><StatusBadge status={m.mode} /></td>
                <td><StatusBadge status={m.status} /></td>
                <td className="text-xs">{m.supported_currencies.join(", ")}</td>
                <td className="text-xs">{m.brands?.join(", ") ?? <span className="text-slate-400">none</span>}</td>
                <td className="text-xs">{m.volume.length ? m.volume.map((v) => formatMoney(v.amount, v.currency)).join(" · ") : "—"}
                  {m.monthly_limit_minor ? <div className="text-slate-400">limit {formatMoney(m.monthly_limit_minor, m.supported_currencies[0] ?? "USD")}</div> : null}</td>
                <td className="text-xs">{m.last_verified_at ? dt(m.last_verified_at) : <Badge tone="amber">never</Badge>}</td>
                <td><Link href={`/admin/merchants/${m.id}`} className="btn-secondary px-2.5 py-1 text-xs">Edit / delete</Link></td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </>
  );
}
