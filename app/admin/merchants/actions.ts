"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { sql } from "@/lib/db";
import { requireUser, assertAdmin } from "@/lib/auth/guard";
import { safeAction, formObject, UserError, type ActionResult } from "@/lib/actions";
import { audit } from "@/lib/logging/audit";
import { logActivity } from "@/lib/logging/activity";
import { raiseAlert } from "@/lib/logging/alerts";
import { requestMeta } from "@/lib/security/request";
import { decryptJson } from "@/lib/crypto/aes";
import { encryptCredentials, loadMerchant, MERCHANT_CREDENTIALS_CONTEXT } from "@/lib/payments/merchants";
import { getAdapter } from "@/lib/payments/registry";
import { CURRENCIES, toMinor } from "@/lib/payments/money";
import type { MerchantCredentials, PaypalCredentials, StripeCredentials } from "@/lib/payments/types";
import type { MerchantRow } from "@/lib/types";

async function admin() {
  const s = await requireUser();
  assertAdmin(s);
  return { actor: { type: "user" as const, id: s.user.id, label: s.user.email }, meta: await requestMeta() };
}

const Base = z.object({
  name: z.string().trim().min(1).max(120),
  mode: z.enum(["test", "live"]),
  status: z.enum(["active", "paused", "disabled"]).default("active"),
  supported_currencies: z.array(z.enum(CURRENCIES)).min(1, "Select at least one currency"),
  per_txn_limit: z.string().trim().default(""),
  monthly_limit: z.string().trim().default(""),
  notes: z.string().trim().max(2000).default(""),
  // stripe
  stripe_publishable_key: z.string().trim().default(""),
  stripe_secret_key: z.string().trim().default(""),
  stripe_webhook_secret: z.string().trim().default(""),
  stripe_payment_method_types: z.string().trim().default(""),
  // paypal
  paypal_client_id: z.string().trim().default(""),
  paypal_client_secret: z.string().trim().default(""),
  paypal_webhook_id: z.string().trim().default(""),
});
type BaseInput = z.infer<typeof Base>;

function limit(v: string, currency: string): number | null {
  if (!v) return null;
  try {
    const m = toMinor(v, currency);
    if (m <= 0) throw new Error();
    return m;
  } catch {
    throw new UserError(`Invalid limit amount "${v}"`);
  }
}

/** Build credentials + public config, merging blank fields with the existing ones. */
function buildCredentials(provider: "stripe" | "paypal", d: BaseInput, existing: MerchantCredentials | null, existingPublic: Record<string, unknown>) {
  const pre = d.mode === "live" ? "live" : "test";
  if (provider === "stripe") {
    const prev = (existing ?? {}) as Partial<StripeCredentials>;
    const secretKey = d.stripe_secret_key || prev.secretKey || "";
    const webhookSecret = d.stripe_webhook_secret || prev.webhookSecret || undefined;
    const publishableKey = d.stripe_publishable_key || String(existingPublic.publishableKey ?? "");
    if (!new RegExp(`^(sk|rk)_${pre}_[A-Za-z0-9]{10,}$`).test(secretKey)) throw new UserError(`Secret key must start with sk_${pre}_ or rk_${pre}_ for ${d.mode} mode.`);
    if (!new RegExp(`^pk_${pre}_[A-Za-z0-9]{10,}$`).test(publishableKey)) throw new UserError(`Publishable key must start with pk_${pre}_ for ${d.mode} mode.`);
    if (webhookSecret && !/^whsec_[A-Za-z0-9+/=]{10,}$/.test(webhookSecret)) throw new UserError("Webhook signing secret must start with whsec_.");
    const pmt = d.stripe_payment_method_types
      ? d.stripe_payment_method_types.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)
      : (existingPublic.paymentMethodTypes as string[] | undefined) ?? ["card"];
    if (pmt.some((x) => !/^[a-z_]{2,40}$/.test(x))) throw new UserError("Invalid payment method type list.");
    const creds: StripeCredentials = { secretKey, ...(webhookSecret ? { webhookSecret } : {}) };
    const changed = !!(d.stripe_secret_key || d.stripe_webhook_secret || (d.stripe_publishable_key && d.stripe_publishable_key !== existingPublic.publishableKey));
    return { creds, publicConfig: { publishableKey, paymentMethodTypes: pmt }, hint: secretKey.slice(-4), changed };
  }
  const prev = (existing ?? {}) as Partial<PaypalCredentials>;
  const clientId = d.paypal_client_id || prev.clientId || "";
  const clientSecret = d.paypal_client_secret || prev.clientSecret || "";
  const webhookId = d.paypal_webhook_id || prev.webhookId || undefined;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(clientId)) throw new UserError("Enter a valid PayPal client ID.");
  if (!/^[A-Za-z0-9_-]{20,}$/.test(clientSecret)) throw new UserError("Enter a valid PayPal client secret.");
  if (webhookId && !/^[A-Za-z0-9-]{5,64}$/.test(webhookId)) throw new UserError("Invalid PayPal webhook ID.");
  const creds: PaypalCredentials = { clientId, clientSecret, ...(webhookId ? { webhookId } : {}) };
  const changed = !!(d.paypal_client_secret || d.paypal_webhook_id || (d.paypal_client_id && d.paypal_client_id !== prev.clientId));
  return { creds, publicConfig: {}, hint: clientSecret.slice(-4), changed };
}

const _create = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const provider = z.enum(["stripe", "paypal"]).parse(fd.get("provider"));
  const d = Base.parse(formObject(fd, ["supported_currencies"]));
  const { creds, publicConfig, hint } = buildCredentials(provider, d, null, {});
  const cur = d.supported_currencies[0];
  const [m] = await sql<{ id: string }[]>`
    insert into merchants (name, provider, mode, status, credentials_enc, public_config, credential_hint, supported_currencies,
                           per_txn_limit_minor, monthly_limit_minor, notes, created_by)
    values (${d.name}, ${provider}, ${d.mode}, ${d.status}, ${encryptCredentials(creds)}, ${sql.json(publicConfig as never)}, ${hint},
            ${d.supported_currencies}, ${limit(d.per_txn_limit, cur)}, ${limit(d.monthly_limit, cur)}, ${d.notes || null}, ${actor.id})
    returning id`;
  await audit({ actor, action: "merchant.create", entityType: "merchant", entityId: m.id, after: { name: d.name, provider, mode: d.mode, credential_hint: hint },
    ip: meta.ip, userAgent: meta.userAgent, riskScore: 40, reasons: ["credentials_changed"] });
  await raiseAlert({ severity: "warning", type: "merchant_credentials_changed", title: `Merchant created: ${d.name} (${provider} ${d.mode})`, message: `By ${actor.label}`, entityType: "merchant", entityId: m.id, userId: actor.id });
  await logActivity({ userId: actor.id, action: "merchant.create", entityType: "merchant", entityId: m.id, description: `Created merchant ${d.name}`, ip: meta.ip });
  revalidatePath("/admin/merchants");
  redirect(`/admin/merchants/${m.id}`);
});
export async function createMerchant(p: ActionResult | null, fd: FormData) { return _create(p, fd); }

const _update = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const id = z.uuid().parse(fd.get("id"));
  const d = Base.parse(formObject(fd, ["supported_currencies"]));
  const [before] = await sql<MerchantRow[]>`select * from merchants where id = ${id}`;
  if (!before) throw new UserError("Merchant not found");
  if (before.provider !== "stripe" && before.provider !== "paypal") throw new UserError("Provider not supported yet");
  let existing: MerchantCredentials | null = null;
  try { existing = decryptJson<MerchantCredentials>(before.credentials_enc, MERCHANT_CREDENTIALS_CONTEXT); } catch { existing = null; }
  if (before.mode !== d.mode && !(d.stripe_secret_key || d.paypal_client_secret)) {
    if (before.provider === "stripe") throw new UserError("Changing mode requires entering the new keys.");
  }
  const { creds, publicConfig, hint, changed } = buildCredentials(before.provider, d, existing, before.public_config ?? {});
  const cur = d.supported_currencies[0];
  await sql`update merchants set name = ${d.name}, mode = ${d.mode}, status = ${d.status}, credentials_enc = ${encryptCredentials(creds)},
            public_config = ${sql.json(publicConfig as never)}, credential_hint = ${hint}, supported_currencies = ${d.supported_currencies},
            per_txn_limit_minor = ${limit(d.per_txn_limit, cur)}, monthly_limit_minor = ${limit(d.monthly_limit, cur)}, notes = ${d.notes || null},
            last_verified_at = case when ${changed} then null else last_verified_at end
            where id = ${id}`;
  const modeChanged = before.mode !== d.mode;
  await audit({
    actor, action: changed ? "merchant.credentials_update" : "merchant.update", entityType: "merchant", entityId: id,
    before: { name: before.name, mode: before.mode, status: before.status, credential_hint: before.credential_hint, currencies: before.supported_currencies, per_txn: before.per_txn_limit_minor, monthly: before.monthly_limit_minor },
    after: { name: d.name, mode: d.mode, status: d.status, credential_hint: hint, currencies: d.supported_currencies },
    ip: meta.ip, userAgent: meta.userAgent, riskScore: changed || modeChanged ? 40 : 10, reasons: changed || modeChanged ? ["credentials_changed"] : [],
  });
  if (changed || modeChanged) {
    await raiseAlert({ severity: "warning", type: "merchant_credentials_changed", title: `Merchant credentials changed: ${d.name}`, message: `By ${actor.label}${modeChanged ? ` (mode ${before.mode} → ${d.mode})` : ""}`, entityType: "merchant", entityId: id, userId: actor.id });
  }
  if (before.status !== d.status) {
    await raiseAlert({ severity: "info", type: "merchant_status", title: `Merchant ${d.name} is now ${d.status}`, entityType: "merchant", entityId: id, userId: actor.id });
  }
  await logActivity({ userId: actor.id, action: "merchant.update", entityType: "merchant", entityId: id, description: `Updated merchant ${d.name}`, ip: meta.ip });
  revalidatePath(`/admin/merchants/${id}`);
  revalidatePath("/admin/merchants");
  return { ok: true, message: changed ? "Saved. Credentials updated — run Verify connection." : "Saved." };
});
export async function updateMerchant(p: ActionResult | null, fd: FormData) { return _update(p, fd); }

const _verify = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const id = z.uuid().parse(fd.get("id"));
  const m = await loadMerchant(id);
  if (!m) throw new UserError("Merchant not found");
  const r = await getAdapter(m).verifyCredentials();
  if (r.ok) await sql`update merchants set last_verified_at = now() where id = ${id}`;
  await logActivity({ userId: actor.id, action: "merchant.verify", entityType: "merchant", entityId: id, description: `Verify ${m.name}: ${r.ok ? "ok" : "failed"}`, ip: meta.ip });
  revalidatePath(`/admin/merchants/${id}`);
  return r.ok ? { ok: true, message: r.label ?? "Connection verified." } : { ok: false, message: `Verification failed: ${r.error}` };
});
export async function verifyMerchant(p: ActionResult | null, fd: FormData) { return _verify(p, fd); }
