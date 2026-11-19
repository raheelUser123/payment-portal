import Link from "next/link";
import { DangerZone } from "@/components/danger-zone";
import { deleteBrandAction, brandDeleteBlocker } from "../../delete-actions";
import { appBaseUrl, brandPayBase } from "@/lib/brands/service";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Card, Field, Badge, StatusBadge, Empty } from "@/components/ui";
import { decryptBrandEmailConfig } from "@/lib/email/transport";
import type { BrandRow } from "@/lib/types";
import { BrandGeneralForm } from "../brand-form";
import { PayDomainCard } from "../pay-domain-card";
import { updateBrandGeneral, updateBrandEmail, sendTestEmail, addBrandMerchant, updateBrandMerchant, setBrandDepartments } from "../actions";

export const metadata = { title: "Edit brand" };

export default async function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [brand] = await sql<BrandRow[]>`select * from brands where id = ${id}`;
  if (!brand) notFound();
  const deleteBlocked = await brandDeleteBlocker(id);
  const base = appBaseUrl();

  let cfg: ReturnType<typeof decryptBrandEmailConfig> = {};
  let cfgError = false;
  try { cfg = decryptBrandEmailConfig(brand.email_config_enc); } catch { cfgError = true; }

  const linked = await sql<{ merchant_id: string; name: string; provider: string; mode: string; status: string; priority: number; is_active: boolean }[]>`
    select bm.merchant_id, m.name, m.provider, m.mode, m.status, bm.priority, bm.is_active
      from brand_merchants bm join merchants m on m.id = bm.merchant_id where bm.brand_id = ${id} order by bm.priority, m.name`;
  const allMerchants = await sql<{ id: string; name: string; provider: string; mode: string }[]>`
    select id, name, provider, mode from merchants where status <> 'disabled' and id not in (select merchant_id from brand_merchants where brand_id = ${id}) order by name`;
  const depts = await sql<{ id: string; name: string; linked: boolean }[]>`
    select d.id, d.name, exists(select 1 from department_brands db where db.department_id = d.id and db.brand_id = ${id}) as linked
      from departments d order by d.name`;

  return (
    <>
      <PageHeader title={brand.name} description={`Payment links: ${brandPayBase(brand)}/pay/${brand.slug}/…`}
        actions={<><Link className="btn-secondary" href={`/admin/brands/${id}/templates`}>Email templates</Link><Link className="btn-secondary" href="/admin/brands">All brands</Link></>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="General"><BrandGeneralForm action={updateBrandGeneral} brand={brand} appUrl={base} /></Card>
          <PayDomainCard brand={brand} portal={base} />

          <Card title="Email sending" actions={brand.email_provider !== "none" ? (
            <ActionForm action={sendTestEmail}><input type="hidden" name="id" value={id} /><SubmitButton className="btn-secondary" pendingText="Sending…">Send test email</SubmitButton></ActionForm>
          ) : undefined}>
            <p className="mb-4 text-sm text-slate-500">Invoices and receipts are sent from this brand&apos;s own mailbox. Configure SPF, DKIM and DMARC on the sending domain for good deliverability. Credentials are stored AES-256-GCM encrypted and are never shown again.</p>
            {cfgError && <p className="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">Saved credentials could not be decrypted (encryption key changed?). Re-enter them.</p>}
            <ActionForm action={updateBrandEmail} className="space-y-4">
              <input type="hidden" name="id" value={id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="From name" name="from_name"><input className="input" id="from_name" name="from_name" defaultValue={brand.from_name ?? ""} placeholder={brand.name} /></Field>
                <Field label="From email" name="from_email"><input className="input" id="from_email" name="from_email" type="email" defaultValue={brand.from_email ?? ""} placeholder="billing@brand.com" /></Field>
                <Field label="Reply-to" name="reply_to"><input className="input" id="reply_to" name="reply_to" type="email" defaultValue={brand.reply_to ?? ""} /></Field>
                <Field label="BCC (copy of every email)" name="bcc_email"><input className="input" id="bcc_email" name="bcc_email" type="email" defaultValue={brand.bcc_email ?? ""} /></Field>
                <Field label="Provider" name="email_provider" className="sm:col-span-2">
                  <select className="input" id="email_provider" name="email_provider" defaultValue={brand.email_provider}>
                    <option value="none">Not configured</option><option value="smtp">SMTP (any mailbox / Gmail / Outlook / SES)</option>
                  </select>
                </Field>
              </div>
              <fieldset className="rounded-lg border border-slate-200 p-4">
                <legend className="px-1 text-xs font-semibold text-slate-600">SMTP {cfg.smtp && <Badge tone="green">•••• saved</Badge>}</legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Host" name="smtp_host"><input className="input" id="smtp_host" name="smtp_host" defaultValue={cfg.smtp?.host ?? ""} placeholder="smtp.brand.com" /></Field>
                  <Field label="Port" name="smtp_port"><input className="input" id="smtp_port" name="smtp_port" inputMode="numeric" defaultValue={cfg.smtp?.port ?? 587} /></Field>
                  <Field label="Username" name="smtp_user"><input className="input" id="smtp_user" name="smtp_user" defaultValue={cfg.smtp?.user ?? ""} autoComplete="off" /></Field>
                  <Field label="Password" name="smtp_pass" hint={cfg.smtp ? "Leave blank to keep the saved password." : undefined}>
                    <input className="input" id="smtp_pass" name="smtp_pass" type="password" autoComplete="new-password" placeholder={cfg.smtp ? "••••••••" : ""} />
                  </Field>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="smtp_secure" defaultChecked={cfg.smtp?.secure ?? false} className="h-4 w-4" /> Implicit TLS (port 465). Otherwise STARTTLS is required.</label>
                </div>
              </fieldset>
              <SubmitButton>Save email settings</SubmitButton>
            </ActionForm>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Merchants (payment routing)">
            <p className="mb-3 text-xs text-slate-500">The pay page offers the first active, eligible merchant per provider (lowest priority number first). Limits and currencies are checked automatically, so a second merchant acts as fallback.</p>
            {linked.length === 0 ? <Empty>No merchants linked — customers can&apos;t pay yet.</Empty> : (
              <ul className="space-y-3">
                {linked.map((m) => (
                  <li key={m.merchant_id} className="rounded-lg border border-slate-200 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <Link href={`/admin/merchants/${m.merchant_id}`} className="font-medium text-indigo-700 hover:underline">{m.name}</Link>
                      <span className="flex gap-1"><Badge tone="blue">{m.provider}</Badge><StatusBadge status={m.mode} />{m.status !== "active" && <StatusBadge status={m.status} />}</span>
                    </div>
                    <ActionForm action={updateBrandMerchant} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="brand_id" value={id} /><input type="hidden" name="merchant_id" value={m.merchant_id} />
                      <div className="w-24"><label className="label">Priority</label><input className="input" name="priority" type="number" min={0} max={10000} defaultValue={m.priority} /></div>
                      <label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" name="is_active" defaultChecked={m.is_active} /> Active</label>
                      <button name="op" value="save" className="btn-secondary">Save</button>
                      <button name="op" value="remove" className="btn-ghost text-rose-600">Remove</button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
            {allMerchants.length > 0 && (
              <ActionForm action={addBrandMerchant} className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
                <input type="hidden" name="brand_id" value={id} />
                <div className="min-w-0 flex-1"><label className="label">Add merchant</label>
                  <select className="input" name="merchant_id" required>{allMerchants.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.provider}, {m.mode})</option>)}</select></div>
                <div className="w-24"><label className="label">Priority</label><input className="input" name="priority" type="number" defaultValue={100} min={0} /></div>
                <SubmitButton className="btn-secondary">Link</SubmitButton>
              </ActionForm>
            )}
          </Card>

          <Card title="Department access">
            <p className="mb-3 text-xs text-slate-500">Sellers in these departments can create invoices and review payments for this brand.</p>
            {depts.length === 0 ? <Empty>No departments yet.</Empty> : (
              <ActionForm action={setBrandDepartments} className="space-y-2">
                <input type="hidden" name="brand_id" value={id} />
                {depts.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="department_ids" value={d.id} defaultChecked={d.linked} className="h-4 w-4" /> {d.name}</label>
                ))}
                <div className="pt-2"><SubmitButton className="btn-secondary">Save access</SubmitButton></div>
              </ActionForm>
            )}
          </Card>
          <DangerZone title="Delete brand" id={id} action={deleteBrandAction} blockedReason={deleteBlocked}
            description="Permanently removes this brand, its customers, email templates, merchant links, API keys and webhooks."
            confirm={`Delete brand "${brand.name}" permanently? This cannot be undone.`} label="Delete brand" />
        </div>
      </div>
    </>
  );
}
