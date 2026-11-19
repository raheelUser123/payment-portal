import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { brandOptions, brandScope } from "@/lib/scope";
import { formatMoney } from "@/lib/payments/money";
import { PageHeader, StatusBadge, TableWrap, dt, Pagination, Empty, Badge } from "@/components/ui";

export const metadata = { title: "Payments" };
const PER = 50;
const STATUSES = ["succeeded", "processing", "pending", "failed", "refunded", "partially_refunded", "disputed", "canceled"];

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireUser();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const status = STATUSES.includes(sp.status ?? "") ? sp.status! : null;
  const review = ["pending", "approved", "flagged"].includes(sp.review ?? "") ? sp.review! : null;
  const brand = /^[0-9a-f-]{36}$/.test(sp.brand ?? "") ? sp.brand! : null;
  const provider = ["stripe", "paypal"].includes(sp.provider ?? "") ? sp.provider! : null;
  const scope = (await brandScope(s, "p.brand_id")).where;
  const brands = await brandOptions(s);

  const rows = await sql<{ id: string; status: string; amount_minor: number; amount_refunded_minor: number; currency: string; provider: string; created_at: Date; number: string; invoice_id: string; brand: string; customer: string; merchant: string; card_last4: string | null; card_brand: string | null; review_status: string; risk_level: string | null; risk_score: number | null }[]>`
    select p.id, p.status, p.amount_minor, p.amount_refunded_minor, p.currency, p.provider, p.created_at, p.card_last4, p.card_brand, p.review_status, p.risk_level, p.risk_score,
           i.number, i.id as invoice_id, b.name as brand, c.name as customer, m.name as merchant
      from payments p join invoices i on i.id = p.invoice_id join brands b on b.id = p.brand_id
      join customers c on c.id = i.customer_id join merchants m on m.id = p.merchant_id
     where p.status <> 'canceled' ${scope}
       ${status ? sql`and p.status = ${status}` : sql`and p.status <> 'pending'`}
       ${review ? sql`and p.review_status = ${review} and p.status in ('succeeded','partially_refunded','disputed')` : sql``}
       ${brand ? sql`and p.brand_id = ${brand}` : sql``}
       ${provider ? sql`and p.provider = ${provider}` : sql``}
     order by p.created_at desc limit ${PER + 1} offset ${(page - 1) * PER}`;
  const qs = new URLSearchParams(Object.entries({ status: status ?? "", review: review ?? "", brand: brand ?? "", provider: provider ?? "" }).filter(([, v]) => v)).toString();

  return (
    <>
      <PageHeader title="Payments" description="Every payment attempt across brands and merchants." />
      <form className="mb-4 flex flex-wrap gap-2">
        <select className="input w-auto" name="status" defaultValue={status ?? ""}><option value="">All (excl. pending)</option>{STATUSES.map((x) => <option key={x} value={x}>{x.replace("_", " ")}</option>)}</select>
        <select className="input w-auto" name="review" defaultValue={review ?? ""}><option value="">Any review</option><option value="pending">Needs review</option><option value="approved">Approved</option><option value="flagged">Flagged</option></select>
        <select className="input w-auto" name="brand" defaultValue={brand ?? ""}><option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <select className="input w-auto" name="provider" defaultValue={provider ?? ""}><option value="">All providers</option><option value="stripe">Stripe</option><option value="paypal">PayPal</option></select>
        <button className="btn-secondary">Filter</button>
      </form>
      {rows.length === 0 ? <Empty>No payments found.</Empty> : (
        <TableWrap>
          <thead><tr><th>Date</th><th>Customer</th><th>Invoice</th><th>Brand / merchant</th><th>Method</th><th className="text-right">Amount</th><th>Status</th><th>Review</th></tr></thead>
          <tbody>
            {rows.slice(0, PER).map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="whitespace-nowrap"><Link className="text-indigo-600" href={`/admin/payments/${r.id}`}>{dt(r.created_at)}</Link></td>
                <td>{r.customer}</td>
                <td><Link className="text-indigo-600" href={`/admin/invoices/${r.invoice_id}`}>{r.number}</Link></td>
                <td>{r.brand}<br /><span className="text-xs text-slate-500">{r.merchant}</span></td>
                <td className="capitalize">{r.provider}{r.card_last4 && <><br /><span className="text-xs text-slate-500">{r.card_brand} •••• {r.card_last4}</span></>}</td>
                <td className="text-right tabular-nums">{formatMoney(r.amount_minor, r.currency)}{r.amount_refunded_minor > 0 && <><br /><span className="text-xs text-slate-500">−{formatMoney(r.amount_refunded_minor, r.currency)}</span></>}</td>
                <td><StatusBadge status={r.status} />{(r.risk_level === "elevated" || r.risk_level === "highest") && <span className="ml-1"><Badge tone="red">risk {r.risk_level}</Badge></span>}</td>
                <td>{["succeeded", "partially_refunded", "disputed", "refunded"].includes(r.status) ? <StatusBadge status={r.review_status === "pending" ? "unreviewed" : r.review_status} /> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <Pagination page={page} hasMore={rows.length > PER} base={`/admin/payments${qs ? "?" + qs : ""}`} />
    </>
  );
}
