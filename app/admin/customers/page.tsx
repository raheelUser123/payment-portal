import Link from "next/link";
import { accessibleBrandIds, requireUser } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { formatMoney } from "@/lib/payments/money";
import { dt, Empty, PageHeader, Pagination, TableWrap } from "@/components/ui";

export const metadata = { title: "Customers" };
const PAGE = 50;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; brand?: string; page?: string }> }) {
  const s = await requireUser();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const q = (sp.q ?? "").trim().slice(0, 100);
  const brand = /^[0-9a-f-]{36}$/i.test(sp.brand ?? "") ? sp.brand! : null;
  const ids = await accessibleBrandIds(s);
  const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
  const [brands, rows] = await Promise.all([
    sql<{ id: string; name: string }[]>`select id, name from brands where (${ids === null} or id = any(${ids ?? []}::uuid[])) order by name`,
    sql<{ id: string; name: string; email: string; company: string | null; brand: string; created_at: Date; invoices: number; paid_minor: number; currency: string | null }[]>`
      select c.id, c.name, c.email, c.company, b.name as brand, c.created_at,
             (select count(*)::int from invoices i where i.customer_id = c.id) as invoices,
             (select coalesce(sum(i.amount_paid_minor - i.amount_refunded_minor), 0)::bigint from invoices i where i.customer_id = c.id) as paid_minor,
             (select i.currency from invoices i where i.customer_id = c.id order by i.created_at desc limit 1) as currency
        from customers c join brands b on b.id = c.brand_id
       where (${ids === null} or c.brand_id = any(${ids ?? []}::uuid[]))
         and (${brand}::uuid is null or c.brand_id = ${brand}::uuid)
         and (${q} = '' or c.name ilike ${like} or c.email::text ilike ${like} or c.company ilike ${like})
       order by c.created_at desc limit ${PAGE + 1} offset ${(page - 1) * PAGE}`,
  ]);
  const base = `/admin/customers?${new URLSearchParams({ ...(q ? { q } : {}), ...(brand ? { brand } : {}) }).toString()}`;
  return (
    <>
      <PageHeader title="Customers" description="Customers are created automatically when you invoice a new email for a brand." />
      <form className="mb-4 flex flex-wrap gap-2" method="get">
        <input className="input max-w-xs" name="q" defaultValue={q} placeholder="Search name, email, company" />
        <select className="input max-w-xs" name="brand" defaultValue={brand ?? ""}><option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <button className="btn-secondary">Filter</button>
      </form>
      {rows.length === 0 ? <Empty>No customers found.</Empty> : (
        <TableWrap>
          <thead><tr><th>Customer</th><th>Brand</th><th>Invoices</th><th>Net paid</th><th>Since</th></tr></thead>
          <tbody>{rows.slice(0, PAGE).map((c) => (
            <tr key={c.id}>
              <td><Link href={`/admin/customers/${c.id}`} className="font-medium text-indigo-700 hover:underline">{c.name}</Link><div className="text-xs text-slate-500">{c.email}{c.company && ` · ${c.company}`}</div></td>
              <td>{c.brand}</td><td>{c.invoices}</td>
              <td>{c.currency ? formatMoney(c.paid_minor, c.currency) : "—"}</td>
              <td className="whitespace-nowrap text-slate-600">{dt(c.created_at, false)}</td>
            </tr>
          ))}</tbody>
        </TableWrap>
      )}
      <Pagination page={page} hasMore={rows.length > PAGE} base={base} />
    </>
  );
}
