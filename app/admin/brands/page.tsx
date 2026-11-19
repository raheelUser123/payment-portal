import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { appBaseUrl } from "@/lib/brands/service";
import { PageHeader, TableWrap, Badge, Empty, LinkButton } from "@/components/ui";

export const metadata = { title: "Brands" };

export default async function BrandsPage() {
  await requireAdmin();
  const brands = await sql<{ id: string; name: string; slug: string; pay_domain: string | null; pay_domain_verified_at: Date | null; is_active: boolean; email_provider: string; merchants: number; invoices: number }[]>`
    select b.id, b.name, b.slug, b.pay_domain, b.pay_domain_verified_at, b.is_active, b.email_provider,
           (select count(*)::int from brand_merchants bm where bm.brand_id = b.id and bm.is_active) as merchants,
           (select count(*)::int from invoices i where i.brand_id = b.id) as invoices
      from brands b order by b.name`;
  const base = appBaseUrl().replace(/^https?:\/\//, "");
  return (
    <>
      <PageHeader title="Brands" description="Each brand has its own payment-link slug, colors, logo, SMTP mailbox and email templates — all sharing your merchant accounts."
        actions={<><LinkButton href="/admin/brands/templates-default" variant="secondary">Default email templates</LinkButton><LinkButton href="/admin/brands/new">New brand</LinkButton></>} />
      {brands.length === 0 ? <Empty>No brands yet. Create your first brand to start sending invoices.</Empty> : (
        <TableWrap>
          <thead><tr><th>Brand</th><th>Payment links</th><th>Email</th><th>Merchants</th><th>Invoices</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {brands.map((b) => (
              <tr key={b.id}>
                <td><Link href={`/admin/brands/${b.id}`} className="font-medium text-indigo-700 hover:underline">{b.name}</Link><div className="text-xs text-slate-500">{b.slug}</div></td>
                <td className="font-mono text-xs text-slate-600">{b.pay_domain && b.pay_domain_verified_at ? b.pay_domain : base}/pay/{b.slug}/…</td>
                <td>{b.email_provider === "none" ? <Badge tone="amber">not set</Badge> : <Badge tone="blue">{b.email_provider}</Badge>}</td>
                <td>{b.merchants === 0 ? <Badge tone="red">none</Badge> : b.merchants}</td>
                <td>{b.invoices}</td>
                <td>{b.is_active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</td>
                <td><Link href={`/admin/brands/${b.id}`} className="btn-secondary px-2.5 py-1 text-xs">Edit / delete</Link></td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </>
  );
}
