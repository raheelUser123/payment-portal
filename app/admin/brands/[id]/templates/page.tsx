import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Badge } from "@/components/ui";
import { TEMPLATE_VARIABLES } from "@/lib/email/render";
import { TemplateEditor } from "../../template-editor";
import { saveTemplate, resetTemplate } from "../../actions";

export const metadata = { title: "Email templates" };

const TYPES = [
  { type: "invoice", label: "Invoice" }, { type: "reminder", label: "Reminder" }, { type: "receipt", label: "Receipt" },
  { type: "payment_failed", label: "Payment failed" }, { type: "refund", label: "Refund" },
] as const;

export default async function BrandTemplatesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ type?: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const { type: q } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [brand] = await sql<{ id: string; name: string }[]>`select id, name from brands where id = ${id}`;
  if (!brand) notFound();
  const type = TYPES.find((t) => t.type === q)?.type ?? "invoice";
  const rows = await sql<{ brand_id: string | null; type: string; subject: string; html: string; is_active: boolean }[]>`
    select brand_id, type, subject, html, is_active from email_templates where brand_id = ${id} or brand_id is null`;
  const override = rows.find((r) => r.brand_id === id && r.type === type);
  const fallback = rows.find((r) => r.brand_id === null && r.type === type);
  const current = override ?? fallback;

  return (
    <>
      <PageHeader title={`${brand.name} — email templates`} description="Override any template for this brand. Without an override the global default is used."
        actions={<Link href={`/admin/brands/${id}`} className="btn-secondary">Back to brand</Link>} />
      <div className="mb-6 flex flex-wrap gap-2">
        {TYPES.map((t) => {
          const has = rows.some((r) => r.brand_id === id && r.type === t.type);
          return (
            <Link key={t.type} href={`?type=${t.type}`} className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${t.type === type ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white"}`}>
              {t.label} {has ? <Badge tone="blue">custom</Badge> : <Badge>default</Badge>}
            </Link>
          );
        })}
      </div>
      {override && (
        <ActionForm action={resetTemplate} className="mb-4" confirm="Delete this brand's custom template and use the global default?">
          <input type="hidden" name="brand_id" value={id} /><input type="hidden" name="type" value={type} />
          <SubmitButton className="btn-ghost text-rose-600">Reset to global default</SubmitButton>
        </ActionForm>
      )}
      <TemplateEditor key={`${type}-${override ? "o" : "d"}`} brandId={id} type={type} subject={current?.subject ?? ""} html={current?.html ?? ""}
        isActive={override?.is_active ?? true} save={saveTemplate} variables={TEMPLATE_VARIABLES} />
    </>
  );
}
