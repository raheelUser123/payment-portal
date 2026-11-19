import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { brandOptions, brandScope } from "@/lib/scope";
import { formatMoney } from "@/lib/payments/money";
import { PageHeader, StatusBadge, TableWrap, dt, Pagination, Empty } from "@/components/ui";

export const metadata = { title: "Invoices" };
const PER = 50;
const STATUSES = ["draft", "open", "paid", "partially_refunded", "refunded", "void", "uncollectible"];

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const s = await requireUser();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const status = STATUSES.includes(sp.status ?? "") ? sp.status! : null;
  const brand = /^[0-9a-f-]{36}$/.test(sp.brand ?? "") ? sp.brand! : null;
  const q = (sp.q ?? "").trim().slice(0, 100);
  const scope = (await brandScope(s, "i.brand_id")).where;
  const brands = await brandOptions(s);

  const rows = await sql<{ id: string; number: string; status: string; total_minor: number; amount_paid_minor: number; currency: string; due_date: Date | null; created_at: Date; brand: string; customer: string; email: string; review_status: string; view_count: number }[]>`
    select i.id, i.number, i.status, i.total_minor, i.amount_paid_minor, i.currency, i.due_date, i.created_at, i.review_status, i.view_count,
           b.name as brand, c.name as customer, c.email
      from invoices i join brands b on b.id = i.brand_id join customers c on c.id = i.customer_id
     where true ${scope}
       ${status ? sql`and i.status = ${status}` : sql``}
       ${brand ? sql`and i.brand_id = ${brand}` : sql``}
       ${q ? sql`and (i.number ilike ${"%" + q + "%"} or c.email ilike ${"%" + q + "%"} or c.name ilike ${"%" + q + "%"})` : sql``}
     order by i.created_at desc limit ${PER + 1} offset ${(page - 1) * PER}`;
  const qs = new URLSearchParams(Object.entries({ status: status ?? "", brand: brand ?? "", q }).filter(([, v]) => v)).toString();

  return (
    <>
      <PageHeader title="Invoices" description="Create, send and track invoices for all your brands." actions={<Link className="btn-primary" href="/admin/invoices/new">New invoice</Link>} />
      <form className="mb-4 flex flex-wrap gap-2">
        <input className="input max-w-xs" name="q" defaultValue={q} placeholder="Search number, name or email" />
        <select className="input w-auto" name="status" defaultValue={status ?? ""}><option value="">All statuses</option>{STATUSES.map((x) => <option key={x} value={x}>{x.replace("_", " ")}</option>)}</select>
        <select className="input w-auto" name="brand" defaultValue={brand ?? ""}><option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <button className="btn-secondary">Filter</button>
      </form>
      {rows.length === 0 ? <Empty>No invoices found.</Empty> : (
        <TableWrap>
          <thead><tr><th>Number</th><th>Customer</th><th>Brand</th><th className="text-right">Total</th><th>Status</th><th>Due</th><th>Created</th></tr></thead>
          <tbody>
            {rows.slice(0, PER).map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td><Link className="font-medium text-indigo-600" href={`/admin/invoices/${r.id}`}>{r.number}</Link>{r.review_status === "flagged" && <span className="ml-1 text-rose-600" title="Flagged">⚑</span>}</td>
                <td>{r.customer}<br /><span className="text-xs text-slate-500">{r.email}</span></td>
                <td>{r.brand}</td>
                <td className="text-right tabular-nums">{formatMoney(r.total_minor, r.currency)}{r.amount_paid_minor > 0 && r.amount_paid_minor < r.total_minor && <><br /><span className="text-xs text-slate-500">paid {formatMoney(r.amount_paid_minor, r.currency)}</span></>}</td>
                <td><StatusBadge status={r.status} />{r.status === "open" && r.view_count > 0 && <span className="ml-1 text-xs text-slate-400">viewed</span>}</td>
                <td className="text-slate-600">{r.due_date ? dt(r.due_date, false) : "—"}</td>
                <td className="text-slate-500">{dt(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <Pagination page={page} hasMore={rows.length > PER} base={`/admin/invoices${qs ? "?" + qs : ""}`} />
    </>
  );
}
