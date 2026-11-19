import { requireUser } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { brandOptions } from "@/lib/scope";
import { PageHeader } from "@/components/ui";
import { InvoiceForm } from "./invoice-form";

export const metadata = { title: "New invoice" };

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ inquiry?: string; brand?: string; customer?: string }> }) {
  const s = await requireUser();
  const sp = await searchParams;
  const brands = await brandOptions(s);
  const merchants = await sql<{ brand_id: string; id: string; name: string; provider: string; mode: string }[]>`
    select bm.brand_id, m.id, m.name, m.provider, m.mode from brand_merchants bm join merchants m on m.id = bm.merchant_id
     where bm.is_active and m.status = 'active' order by bm.priority`;
  let prefill: { name?: string; email?: string; phone?: string; brandId?: string; title?: string; inquiryId?: string } = {};
  if (sp.inquiry && /^[0-9a-f-]{36}$/.test(sp.inquiry)) {
    const [inq] = await sql<{ id: string; name: string | null; email: string | null; phone: string | null; brand_id: string | null; subject: string | null }[]>`
      select id, name, email, phone, brand_id, subject from inquiries where id = ${sp.inquiry}`;
    if (inq && (!inq.brand_id || brands.some((b) => b.id === inq.brand_id))) {
      prefill = { name: inq.name ?? undefined, email: inq.email ?? undefined, phone: inq.phone ?? undefined, brandId: inq.brand_id ?? undefined, title: inq.subject ?? undefined, inquiryId: inq.id };
    }
  }
  if (sp.customer && /^[0-9a-f-]{36}$/.test(sp.customer)) {
    const [c] = await sql<{ name: string; email: string; phone: string | null; brand_id: string }[]>`
      select name, email, phone, brand_id from customers where id = ${sp.customer}`;
    if (c && brands.some((b) => b.id === c.brand_id)) prefill = { ...prefill, name: c.name, email: c.email, phone: c.phone ?? undefined, brandId: c.brand_id };
  }
  return (
    <>
      <PageHeader title="New invoice" description="The customer receives a branded email with a secure payment link on the brand's own domain." />
      {brands.length === 0 ? (
        <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">You don&apos;t have access to any brand yet. Ask an admin to assign a brand to you or your department.</p>
      ) : (
        <InvoiceForm brands={brands} merchants={merchants} prefill={{ ...prefill, brandId: prefill.brandId ?? sp.brand }} />
      )}
    </>
  );
}
