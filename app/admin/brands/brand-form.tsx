import { ActionForm, SubmitButton, type ActionResult } from "@/components/action-form";
import { Field } from "@/components/ui";
import { CURRENCIES } from "@/lib/payments/money";
import type { BrandRow } from "@/lib/types";

type Action = (p: ActionResult | null, fd: FormData) => Promise<ActionResult>;

export function BrandGeneralForm({ action, brand, submitLabel = "Save", appUrl }: { action: Action; brand?: BrandRow; submitLabel?: string; appUrl: string }) {
  const b = brand;
  return (
    <ActionForm action={action} className="space-y-5">
      {b && <input type="hidden" name="id" value={b.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Brand name" name="name"><input className="input" id="name" name="name" defaultValue={b?.name} required maxLength={120} /></Field>
        <Field label="Slug" name="slug" hint={`Shown in payment links: …/pay/${b?.slug || "your-brand"}/… (lowercase letters, numbers, dashes). Changing it later keeps old links working.`}>
          <input className="input" id="slug" name="slug" defaultValue={b?.slug} required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="your-brand" />
        </Field>
        <Field label="Website URL" name="website_url"><input className="input" id="website_url" name="website_url" type="url" defaultValue={b?.website_url ?? ""} /></Field>
        <Field label="Logo URL (https)" name="logo_url" className="sm:col-span-2"><input className="input" id="logo_url" name="logo_url" type="url" defaultValue={b?.logo_url ?? ""} /></Field>
        <Field label="Primary color" name="primary_color"><input className="input h-10 p-1" id="primary_color" name="primary_color" type="color" defaultValue={b?.primary_color ?? "#111827"} /></Field>
        <Field label="Accent / button color" name="accent_color"><input className="input h-10 p-1" id="accent_color" name="accent_color" type="color" defaultValue={b?.accent_color ?? "#2563eb"} /></Field>
        <Field label="Support email" name="support_email"><input className="input" id="support_email" name="support_email" type="email" defaultValue={b?.support_email ?? ""} /></Field>
        <Field label="Support phone" name="support_phone"><input className="input" id="support_phone" name="support_phone" defaultValue={b?.support_phone ?? ""} maxLength={40} /></Field>
        <Field label="Address" name="address" className="sm:col-span-2"><textarea className="input" id="address" name="address" rows={2} defaultValue={b?.address ?? ""} maxLength={500} /></Field>
        <Field label="Footer text (pay page)" name="footer_text" className="sm:col-span-2"><input className="input" id="footer_text" name="footer_text" defaultValue={b?.footer_text ?? ""} maxLength={500} /></Field>
        <Field label="Terms URL" name="terms_url"><input className="input" id="terms_url" name="terms_url" type="url" defaultValue={b?.terms_url ?? ""} /></Field>
        <Field label="Privacy URL" name="privacy_url"><input className="input" id="privacy_url" name="privacy_url" type="url" defaultValue={b?.privacy_url ?? ""} /></Field>
        <Field label="Invoice prefix" name="invoice_prefix" hint="e.g. ACME → ACME-2026-001001"><input className="input uppercase" id="invoice_prefix" name="invoice_prefix" defaultValue={b?.invoice_prefix ?? "INV"} required maxLength={8} pattern="[A-Za-z0-9]{1,8}" /></Field>
        <Field label="Default currency" name="default_currency">
          <select className="input" id="default_currency" name="default_currency" defaultValue={b?.default_currency ?? "USD"}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Card statement suffix" name="statement_descriptor_suffix" hint="Max 22 chars. Shown on card statements after the account prefix (e.g. ACCT* BRANDNAME).">
          <input className="input" id="statement_descriptor_suffix" name="statement_descriptor_suffix" defaultValue={b?.statement_descriptor_suffix ?? ""} maxLength={22} pattern="[A-Za-z0-9 .\-]{1,22}" />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" name="is_active" defaultChecked={b ? b.is_active : true} className="h-4 w-4" /> Active
        </label>
      </div>
      <SubmitButton>{submitLabel}</SubmitButton>
    </ActionForm>
  );
}
