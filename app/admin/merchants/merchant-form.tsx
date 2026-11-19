import { ActionForm, SubmitButton, type ActionResult } from "@/components/action-form";
import { Field, Badge } from "@/components/ui";
import { CURRENCIES, toDecimalString } from "@/lib/payments/money";
import type { MerchantRow } from "@/lib/types";

type Action = (p: ActionResult | null, fd: FormData) => Promise<ActionResult>;

export function MerchantForm({ action, provider, merchant }: { action: Action; provider: "stripe" | "paypal"; merchant?: MerchantRow }) {
  const m = merchant;
  const cur = m?.supported_currencies[0] ?? "USD";
  const saved = (label: string) => (m ? <Badge tone="green">{label}</Badge> : null);
  const keepHint = m ? "Leave blank to keep the saved value." : undefined;
  const pub = (m?.public_config ?? {}) as { publishableKey?: string; paymentMethodTypes?: string[] };
  return (
    <ActionForm action={action} className="space-y-5">
      {m ? <input type="hidden" name="id" value={m.id} /> : <input type="hidden" name="provider" value={provider} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" name="name" hint="Internal only — customers never see it."><input className="input" id="name" name="name" defaultValue={m?.name} required maxLength={120} /></Field>
        <Field label="Mode" name="mode">
          <select className="input" id="mode" name="mode" defaultValue={m?.mode ?? "test"}><option value="test">Test / sandbox</option><option value="live">Live</option></select>
        </Field>
        <Field label="Status" name="status">
          <select className="input" id="status" name="status" defaultValue={m?.status ?? "active"}><option value="active">Active</option><option value="paused">Paused (not offered at checkout)</option><option value="disabled">Disabled</option></select>
        </Field>
        <Field label={`Per-transaction limit (${cur})`} name="per_txn_limit" hint="Optional. Larger invoices route to another merchant.">
          <input className="input" id="per_txn_limit" name="per_txn_limit" inputMode="decimal" defaultValue={m?.per_txn_limit_minor ? toDecimalString(m.per_txn_limit_minor, cur) : ""} placeholder="e.g. 5000" />
        </Field>
        <Field label={`Monthly volume limit (${cur})`} name="monthly_limit" hint="Optional. Once reached, payments fall back to the next merchant.">
          <input className="input" id="monthly_limit" name="monthly_limit" inputMode="decimal" defaultValue={m?.monthly_limit_minor ? toDecimalString(m.monthly_limit_minor, cur) : ""} placeholder="e.g. 100000" />
        </Field>
        <Field label="Supported currencies" name="supported_currencies" className="sm:col-span-2" hint="Limits use the first selected currency.">
          <div className="grid grid-cols-4 gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-7">
            {CURRENCIES.map((c) => (
              <label key={c} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="supported_currencies" value={c} defaultChecked={m ? m.supported_currencies.includes(c) : c === "USD"} /> {c}</label>
            ))}
          </div>
        </Field>
      </div>

      {provider === "stripe" ? (
        <fieldset className="rounded-lg border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold text-slate-600">Stripe API keys</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Publishable key" name="stripe_publishable_key" hint={m ? `Current: ${pub.publishableKey ? pub.publishableKey.slice(0, 12) + "…" + pub.publishableKey.slice(-4) : "—"}` : "pk_test_… / pk_live_…"}>
              <input className="input font-mono" id="stripe_publishable_key" name="stripe_publishable_key" autoComplete="off" required={!m} />
            </Field>
            <Field label="Secret or restricted key" name="stripe_secret_key" hint={keepHint ?? "sk_… or rk_… (restricted key recommended: PaymentIntents write, Refunds write, Balance read)"}>
              <div className="flex items-center gap-2"><input className="input font-mono" id="stripe_secret_key" name="stripe_secret_key" type="password" autoComplete="new-password" required={!m} placeholder={m ? `••••${m.credential_hint ?? ""}` : ""} />{saved("saved")}</div>
            </Field>
            <Field label="Webhook signing secret" name="stripe_webhook_secret" hint={keepHint ?? "whsec_… (create the endpoint after saving — URL shown on the next page)"}>
              <input className="input font-mono" id="stripe_webhook_secret" name="stripe_webhook_secret" type="password" autoComplete="new-password" placeholder={m ? "•••• (leave blank to keep)" : "whsec_…"} />
            </Field>
            <Field label="Payment method types" name="stripe_payment_method_types" hint="Comma separated. Default: card. Redirect methods (klarna, ideal…) may show the account name.">
              <input className="input font-mono" id="stripe_payment_method_types" name="stripe_payment_method_types" defaultValue={(pub.paymentMethodTypes ?? ["card"]).join(",")} />
            </Field>
          </div>
        </fieldset>
      ) : (
        <fieldset className="rounded-lg border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold text-slate-600">PayPal REST app</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client ID" name="paypal_client_id" hint={keepHint}>
              <input className="input font-mono" id="paypal_client_id" name="paypal_client_id" autoComplete="off" required={!m} placeholder={m ? "•••• (leave blank to keep)" : ""} />
            </Field>
            <Field label="Client secret" name="paypal_client_secret" hint={keepHint}>
              <div className="flex items-center gap-2"><input className="input font-mono" id="paypal_client_secret" name="paypal_client_secret" type="password" autoComplete="new-password" required={!m} placeholder={m ? `••••${m.credential_hint ?? ""}` : ""} />{saved("saved")}</div>
            </Field>
            <Field label="Webhook ID" name="paypal_webhook_id" hint={keepHint ?? "From the PayPal developer dashboard after adding the webhook URL."}>
              <input className="input font-mono" id="paypal_webhook_id" name="paypal_webhook_id" autoComplete="off" />
            </Field>
          </div>
        </fieldset>
      )}
      <Field label="Notes" name="notes"><textarea className="input" id="notes" name="notes" rows={2} defaultValue={m?.notes ?? ""} maxLength={2000} /></Field>
      <p className="text-xs text-slate-500">Secrets are encrypted with AES-256-GCM before they reach the database and are never displayed again. Every change is audited and alerts admins.</p>
      <SubmitButton>{m ? "Save merchant" : "Create merchant"}</SubmitButton>
    </ActionForm>
  );
}
