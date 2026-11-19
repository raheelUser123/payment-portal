import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { TEMPLATE_VARIABLES } from "@/lib/email/render";
import { TemplateEditor } from "../template-editor";
import { saveTemplate } from "../actions";

export const metadata = { title: "Default email templates" };

const TYPES = [
  { type: "invoice", label: "Invoice" }, { type: "reminder", label: "Reminder" }, { type: "receipt", label: "Receipt" },
  { type: "payment_failed", label: "Payment failed" }, { type: "refund", label: "Refund" },
] as const;

export default async function DefaultTemplatesPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  await requireAdmin();
  const { type: q } = await searchParams;
  const type = TYPES.find((t) => t.type === q)?.type ?? "invoice";
  const [tpl] = await sql<{ subject: string; html: string; is_active: boolean }[]>`select subject, html, is_active from email_templates where brand_id is null and type = ${type}`;
  return (
    <>
      <PageHeader title="Default email templates" description="Used by every brand that has no custom template. Brand name, colors and logo are filled in automatically."
        actions={<Link href="/admin/brands" className="btn-secondary">Back to brands</Link>} />
      <div className="mb-6 flex flex-wrap gap-2">
        {TYPES.map((t) => (
          <Link key={t.type} href={`?type=${t.type}`} className={`rounded-lg border px-3 py-1.5 text-sm ${t.type === type ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white"}`}>{t.label}</Link>
        ))}
      </div>
      <TemplateEditor key={type} brandId={null} type={type} subject={tpl?.subject ?? ""} html={tpl?.html ?? ""} isActive={tpl?.is_active ?? true} save={saveTemplate} variables={TEMPLATE_VARIABLES} />
    </>
  );
}
