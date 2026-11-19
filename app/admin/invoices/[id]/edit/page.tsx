import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, accessibleBrandIds } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { getInvoice, invoiceEditBlocker } from "@/lib/invoices/service";
import { toDecimalString } from "@/lib/payments/money";
import { PageHeader } from "@/components/ui";
import { InvoiceForm } from "../../new/invoice-form";
import type { CustomerRow } from "@/lib/types";

export const metadata = { title: "Edit invoice" };

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const inv = await getInvoice(id);
  if (!inv) notFound();
  const ids = await accessibleBrandIds(s);
  if (ids !== null && !ids.includes(inv.brand_id)) notFound();

  const blocked = await invoiceEditBlocker(id);
  if (blocked) {
    return (
      <>
        <PageHeader title={`Edit invoice ${inv.number}`} />
        <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">{blocked}</p>
        <Link href={`/admin/invoices/${id}`} className="btn-secondary mt-4">Back to invoice</Link>
      </>
    );
  }

  const [brand] = await sql<{ id: string; name: string; default_currency: string }[]>`select id, name, default_currency from brands where id = ${inv.brand_id}`;
  const merchants = await sql<{ brand_id: string; id: string; name: string; provider: string; mode: string }[]>`
    select bm.brand_id, m.id, m.name, m.provider, m.mode from brand_merchants bm join merchants m on m.id = bm.merchant_id
     where bm.is_active and m.status = 'active' and bm.brand_id = ${inv.brand_id} order by bm.priority`;
  const [c] = await sql<CustomerRow[]>`select * from customers where id = ${inv.customer_id}`;
  const items = await sql<{ description: string; quantity: string; unit_amount_minor: number }[]>`
    select description, quantity::text, unit_amount_minor from invoice_items where invoice_id = ${id} order by sort_order`;
  const money = (m: number) => (m ? toDecimalString(m, inv.currency) : "");

  return (
    <>
      <PageHeader title={`Edit invoice ${inv.number}`} description="The payment link stays the same. Any checkout the customer had open is cancelled, so they'll pay the new amount."
        actions={<Link href={`/admin/invoices/${id}`} className="btn-secondary">Cancel</Link>} />
      <InvoiceForm
        brands={[brand]}
        merchants={merchants}
        prefill={{ name: c.name, email: c.email, phone: c.phone ?? undefined, brandId: inv.brand_id, title: inv.title ?? undefined }}
        edit={{
          invoiceId: id,
          currency: inv.currency,
          items: items.map((i) => ({ description: i.description, quantity: String(Number(i.quantity)), unitAmount: toDecimalString(i.unit_amount_minor, inv.currency) })),
          discount: money(inv.discount_minor),
          tax: money(inv.tax_minor),
          company: c.company ?? "",
          dueDate: inv.due_date ? new Date(inv.due_date).toISOString().slice(0, 10) : "",
          memo: inv.memo ?? "",
          merchantId: inv.merchant_id ?? "",
        }}
      />
    </>
  );
}
