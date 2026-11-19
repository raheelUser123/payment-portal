import "server-only";
import { sql } from "../db";
import { getAdapter } from "./registry";
import { checkoutOptions, loadMerchant } from "./merchants";
import { formatMoney } from "./money";
import type { LoadedMerchant, NormalizedEvent, PaymentSnapshot } from "./types";
import { ProviderError } from "./types";
import { getBrand, payUrl } from "../brands/service";
import { invoiceByToken, invoiceEmailVars } from "../invoices/service";
import { sendTemplatedEmail } from "../email/send";
import { emitEvent } from "../webhooks/outbound";
import { audit } from "../logging/audit";
import { logActivity } from "../logging/activity";
import { raiseAlert } from "../logging/alerts";
import { getSetting } from "../settings";
import { assessPaymentAttempt } from "../security/risk";
import { rateLimit } from "../security/rate-limit";
import type { RequestMeta } from "../security/request";
import type { InvoiceRow, PaymentRow, PaymentStatus, Provider } from "../types";

export class CheckoutError extends Error {}

const PAYABLE: InvoiceRow["status"][] = ["open"];

function amountDue(inv: InvoiceRow) {
  return Math.max(0, inv.total_minor - inv.amount_paid_minor);
}

/** Validate a public pay token and return the invoice if it can be paid now. */
export async function payableInvoice(token: string) {
  const inv = await invoiceByToken(token);
  if (!inv) throw new CheckoutError("This payment link is invalid.");
  if (inv.token_expires_at && inv.token_expires_at < new Date()) throw new CheckoutError("This payment link has expired. Please contact us for a new one.");
  if (!PAYABLE.includes(inv.status)) throw new CheckoutError(inv.status === "paid" ? "This invoice is already paid." : "This invoice can no longer be paid.");
  if (amountDue(inv) <= 0) throw new CheckoutError("Nothing is due on this invoice.");
  return inv;
}

/** Public data the browser needs to render a provider's checkout widget. */
function publicClientConfig(m: LoadedMerchant) {
  if (m.provider === "stripe") return { publishableKey: String(m.publicConfig.publishableKey ?? "") };
  if (m.provider === "paypal") return { clientId: String((m.credentials as { clientId: string }).clientId) };
  return {};
}

export async function availableProviders(inv: InvoiceRow) {
  const options = await checkoutOptions({ brandId: inv.brand_id, currency: inv.currency, amountMinor: amountDue(inv), pinnedMerchantId: inv.merchant_id });
  return options.map((m) => ({ provider: m.provider, mode: m.mode, ...publicClientConfig(m) }));
}

/**
 * Start (or resume) a payment for an invoice with the chosen provider.
 * The amount is ALWAYS taken from the database — never from the client.
 */
export async function startCheckout(token: string, provider: Provider, meta: RequestMeta) {
  if (!(await rateLimit(`checkout:ip:${meta.ip ?? "unknown"}`, 600, 30))) throw new CheckoutError("Too many attempts. Please wait a few minutes.");
  const inv = await payableInvoice(token);
  if (!(await rateLimit(`checkout:inv:${inv.id}`, 3600, 25))) throw new CheckoutError("Too many attempts on this invoice. Please contact support.");

  const due = amountDue(inv);
  const alertCfg = await getSetting("alerts");
  const risk = await assessPaymentAttempt(inv.id, meta.ip, due, alertCfg.large_payment_minor);
  if (risk.score >= 80) {
    await audit({ actor: { type: "public" }, action: "checkout.blocked", entityType: "invoice", entityId: inv.id, ip: meta.ip, userAgent: meta.userAgent, riskScore: risk.score, reasons: risk.reasons });
    await raiseAlert({ severity: "critical", type: "checkout_blocked", title: `Checkout blocked for ${inv.number}`, message: risk.reasons.join(", "), entityType: "invoice", entityId: inv.id });
    throw new CheckoutError("We couldn't start this payment. Please contact support.");
  }

  const options = await checkoutOptions({ brandId: inv.brand_id, currency: inv.currency, amountMinor: due, pinnedMerchantId: inv.merchant_id });
  const merchant = options.find((m) => m.provider === provider);
  if (!merchant) throw new CheckoutError("This payment method is not available.");
  const adapter = getAdapter(merchant);
  const brand = (await getBrand(inv.brand_id))!;

  // Resume an existing open attempt for the same merchant + amount (avoids piling up intents).
  const [existing] = await sql<PaymentRow[]>`
    select * from payments where invoice_id = ${inv.id} and merchant_id = ${merchant.id} and status = 'pending'
       and amount_minor = ${due} and provider_payment_id is not null
     order by created_at desc limit 1`;
  if (existing && adapter.resumePayment) {
    const resumed = await adapter.resumePayment(existing.provider_payment_id!, due).catch(() => null);
    if (resumed) return { paymentId: existing.id, provider, clientToken: resumed.clientToken, ...publicClientConfig(merchant) };
    await sql`update payments set status = 'canceled' where id = ${existing.id} and status = 'pending'`;
  }

  const [payment] = await sql<PaymentRow[]>`
    insert into payments (invoice_id, brand_id, merchant_id, provider, amount_minor, currency, status, ip, user_agent, risk_score)
    values (${inv.id}, ${inv.brand_id}, ${merchant.id}, ${merchant.provider}, ${due}, ${inv.currency}, 'pending', ${meta.ip}, ${meta.userAgent}, ${risk.score})
    returning *`;
  const { customer } = await invoiceEmailVars(inv, brand);

  try {
    const created = await adapter.createPayment({
      paymentId: payment.id,
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      amountMinor: due,
      currency: inv.currency,
      brandName: brand.name,
      brandSlug: brand.slug,
      descriptorSuffix: brand.statement_descriptor_suffix,
      customerEmail: customer.email,
      customerName: customer.name,
      description: `${brand.name} — Invoice ${inv.number}${inv.title ? ` (${inv.title})` : ""}`,
      returnUrl: `${payUrl(brand, token)}/complete?payment=${payment.id}`,
      cancelUrl: payUrl(brand, token),
      idempotencyKey: `create:${payment.id}`,
    });
    await sql`update payments set provider_payment_id = ${created.providerPaymentId} where id = ${payment.id}`;
    await logActivity({ action: "checkout.started", entityType: "invoice", entityId: inv.id, description: `${merchant.provider} checkout started for ${inv.number}`, ip: meta.ip, userAgent: meta.userAgent, metadata: { payment_id: payment.id, merchant_id: merchant.id } });
    return { paymentId: payment.id, provider, clientToken: created.clientToken, ...publicClientConfig(merchant) };
  } catch (e) {
    await sql`update payments set status = 'failed', failure_message = ${(e as Error).message.slice(0, 500)} where id = ${payment.id}`;
    console.error("[checkout] provider error", e);
    throw new CheckoutError(e instanceof ProviderError && e.userMessage ? e.userMessage : "Unable to start the payment. Please try again.");
  }
}

/**
 * Called by the browser after the provider widget finishes (Stripe confirm /
 * PayPal approve). Never trusts the browser: re-reads the state from the provider.
 */
export async function confirmCheckout(token: string, paymentId: string) {
  const inv = await invoiceByToken(token);
  if (!inv) throw new CheckoutError("Invalid link.");
  const [payment] = await sql<PaymentRow[]>`select * from payments where id = ${paymentId} and invoice_id = ${inv.id}`;
  if (!payment || !payment.provider_payment_id) throw new CheckoutError("Payment not found.");
  const merchant = await loadMerchant(payment.merchant_id);
  if (!merchant) throw new CheckoutError("Payment not found.");
  const adapter = getAdapter(merchant);
  const snapshot = adapter.capturePayment && payment.status === "pending"
    ? await adapter.capturePayment(payment.provider_payment_id, `capture:${payment.id}`)
    : await adapter.retrievePayment(payment.provider_payment_id);
  return applySnapshot(payment.id, snapshot, "client_confirm");
}

const SUCCESS_LIKE: PaymentStatus[] = ["succeeded", "partially_refunded", "refunded", "disputed"];

/**
 * Apply a provider snapshot to our payment row inside a transaction.
 * Idempotent: replays (webhook + redirect, duplicate webhooks) are no-ops.
 */
export async function applySnapshot(paymentId: string, snap: PaymentSnapshot, source: string): Promise<PaymentRow> {
  const result = await sql.begin(async (tx) => {
    const [p] = await tx<PaymentRow[]>`select * from payments where id = ${paymentId} for update`;
    if (!p) throw new Error("payment not found");

    // Integrity check: provider amount/currency must match what we charged.
    if (snap.amountMinor !== p.amount_minor || snap.currency.toUpperCase() !== p.currency.toUpperCase()) {
      return { p, prev: p.status, mismatch: true };
    }
    // Never move a settled payment back to pending/failed due to out-of-order events.
    let status = snap.status;
    if (SUCCESS_LIKE.includes(p.status) && !SUCCESS_LIKE.includes(status)) status = p.status;
    if (p.status === "disputed" && status !== "disputed" && status !== "refunded") status = "disputed";

    const [updated] = await tx<PaymentRow[]>`
      update payments set
        status = ${status},
        provider_charge_id = coalesce(${snap.providerChargeId ?? null}, provider_charge_id),
        amount_refunded_minor = greatest(amount_refunded_minor, ${snap.amountRefundedMinor ?? 0}),
        failure_code = ${snap.failureCode ?? null},
        failure_message = ${snap.failureMessage ?? null},
        payment_method_type = coalesce(${snap.paymentMethodType ?? null}, payment_method_type),
        card_brand = coalesce(${snap.cardBrand ?? null}, card_brand),
        card_last4 = coalesce(${snap.cardLast4 ?? null}, card_last4),
        card_country = coalesce(${snap.cardCountry ?? null}, card_country),
        payer_name = coalesce(${snap.payerName ?? null}, payer_name),
        payer_email = coalesce(${snap.payerEmail ?? null}, payer_email),
        risk_level = coalesce(${snap.riskLevel ?? null}, risk_level),
        risk_score = greatest(coalesce(risk_score, 0), coalesce(${snap.riskScore ?? null}, 0)),
        succeeded_at = case when ${SUCCESS_LIKE.includes(status)} then coalesce(succeeded_at, now()) else succeeded_at end
      where id = ${p.id}
      returning *`;
    await tx`select recalc_invoice(${p.invoice_id})`;
    return { p: updated, prev: p.status, mismatch: false };
  });

  if (result.mismatch) {
    await audit({ actor: { type: "system" }, action: "payment.amount_mismatch", entityType: "payment", entityId: paymentId, riskScore: 95, reasons: ["amount_or_currency_mismatch"], after: { snap_amount: snap.amountMinor, snap_currency: snap.currency, source } });
    await raiseAlert({ severity: "critical", type: "payment_amount_mismatch", title: "Payment amount mismatch", message: `Payment ${paymentId}: provider reported ${snap.amountMinor} ${snap.currency}`, entityType: "payment", entityId: paymentId });
    return result.p;
  }
  if (result.prev !== result.p.status) await onTransition(result.prev, result.p, source);
  return result.p;
}

async function onTransition(prev: PaymentStatus, p: PaymentRow, source: string) {
  const [inv] = await sql<InvoiceRow[]>`select * from invoices where id = ${p.invoice_id}`;
  const brand = (await getBrand(p.brand_id))!;
  const money = formatMoney(p.amount_minor, p.currency);
  await audit({ actor: { type: source === "webhook" ? "webhook" : "system", label: source }, action: `payment.${p.status}`, entityType: "payment", entityId: p.id, before: { status: prev }, after: { status: p.status, amount_minor: p.amount_minor, currency: p.currency } });
  await logActivity({ action: `payment.${p.status}`, entityType: "payment", entityId: p.id, description: `${inv.number}: payment ${p.status} (${money}) via ${p.provider}` });

  if (p.status === "succeeded" && !SUCCESS_LIKE.includes(prev)) {
    const { customer, vars } = await invoiceEmailVars(inv, brand);
    await sendTemplatedEmail({
      brand, type: "receipt", to: customer.email, invoiceId: inv.id,
      vars: { ...vars, paid_amount: money, paid_date: new Date().toLocaleDateString("en-US", { dateStyle: "medium" }), card_last4: p.card_last4 },
    }).catch((e) => console.error("[receipt] failed", e));
    await emitEvent(brand.id, "payment.succeeded", { payment_id: p.id, invoice_id: inv.id, invoice_number: inv.number, amount_minor: p.amount_minor, currency: p.currency, provider: p.provider });
    if (inv.status === "paid") await emitEvent(brand.id, "invoice.paid", { invoice_id: inv.id, number: inv.number });
    const cfg = await getSetting("alerts");
    const highRisk = p.risk_level === "elevated" || p.risk_level === "highest" || (p.risk_score ?? 0) >= 65;
    if (p.amount_minor >= cfg.large_payment_minor || highRisk) {
      await raiseAlert({ severity: highRisk ? "critical" : "warning", type: highRisk ? "high_risk_payment" : "large_payment",
        title: `${highRisk ? "High-risk" : "Large"} payment ${money} — ${brand.name}`, message: `Invoice ${inv.number}, risk ${p.risk_level ?? "n/a"} (${p.risk_score ?? 0})`, entityType: "payment", entityId: p.id });
    } else {
      await raiseAlert({ severity: "info", type: "payment_succeeded", title: `Payment received ${money} — ${brand.name}`, message: `Invoice ${inv.number}`, entityType: "payment", entityId: p.id });
    }
  }
  if (p.status === "failed" && prev !== "failed") {
    const { customer, vars } = await invoiceEmailVars(inv, brand);
    await sendTemplatedEmail({ brand, type: "payment_failed", to: customer.email, invoiceId: inv.id, vars: { ...vars, failure_reason: p.failure_message } }).catch(() => undefined);
    await emitEvent(brand.id, "payment.failed", { payment_id: p.id, invoice_id: inv.id, failure_code: p.failure_code });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from payments where status = 'failed' and created_at > now() - interval '15 minutes'`;
    if (n >= 10) await raiseAlert({ severity: "critical", type: "failure_spike", title: "Spike in failed payments", message: `${n} failed payments in 15 minutes — possible card testing.` });
  }
  if (p.status === "disputed") {
    await raiseAlert({ severity: "critical", type: "dispute", title: `Chargeback opened — ${money} (${brand.name})`, message: `Invoice ${inv.number}`, entityType: "payment", entityId: p.id });
    await emitEvent(brand.id, "dispute.created", { payment_id: p.id, invoice_id: inv.id });
  }
}

/** Process a verified gateway webhook. Returns HTTP status to answer with. */
export async function handleGatewayWebhook(merchantId: string, provider: Provider, rawBody: string, headers: Headers, meta: RequestMeta): Promise<{ status: number; body: string }> {
  const merchant = await loadMerchant(merchantId);
  if (!merchant || merchant.provider !== provider) return { status: 404, body: "unknown merchant" };
  const adapter = getAdapter(merchant);

  let event: NormalizedEvent;
  try {
    event = await adapter.parseWebhook(rawBody, headers);
  } catch (e) {
    await audit({ actor: { type: "webhook", label: provider }, action: "webhook.signature_invalid", entityType: "merchant", entityId: merchantId, ip: meta.ip, userAgent: meta.userAgent, riskScore: 70, reasons: ["invalid_signature"], after: { error: (e as Error).message.slice(0, 200) } });
    if (!(await rateLimit(`whfail:${merchantId}`, 3600, 3))) {
      await raiseAlert({ severity: "critical", type: "webhook_signature_invalid", title: `Invalid ${provider} webhook signatures (${merchant.name})`, message: `From IP ${meta.ip ?? "unknown"}. Check the webhook secret, or someone is forging events.`, entityType: "merchant", entityId: merchantId });
    }
    return { status: 400, body: "invalid signature" };
  }

  const ins = await sql`
    insert into webhook_events (merchant_id, provider, event_id, type, signature_valid, payload)
    values (${merchantId}, ${provider}, ${event.id}, ${event.type}, true, ${sql.json(JSON.parse(rawBody) as never)})
    on conflict (provider, event_id) do nothing`;
  if (ins.count === 0) {
    const [prev] = await sql<{ processed_at: Date | null }[]>`select processed_at from webhook_events where provider = ${provider} and event_id = ${event.id}`;
    if (prev?.processed_at) return { status: 200, body: "duplicate" };
  }

  try {
    await processEvent(merchant, event);
    await sql`update webhook_events set processed_at = now(), error = null where provider = ${provider} and event_id = ${event.id}`;
    return { status: 200, body: "ok" };
  } catch (e) {
    await sql`update webhook_events set error = ${(e as Error).message.slice(0, 500)} where provider = ${provider} and event_id = ${event.id}`;
    console.error("[webhook] processing failed", event.type, e);
    return { status: 500, body: "processing error" }; // provider will retry
  }
}

async function findPayment(merchantId: string, providerPaymentId: string | null, providerChargeId: string | null, metaPaymentId?: string) {
  const [p] = await sql<PaymentRow[]>`
    select * from payments where merchant_id = ${merchantId} and (
      (${providerPaymentId}::text is not null and provider_payment_id = ${providerPaymentId}) or
      (${providerChargeId}::text is not null and provider_charge_id = ${providerChargeId}) or
      (${metaPaymentId ?? null}::uuid is not null and id = ${metaPaymentId ?? null}::uuid))
    limit 1`;
  return p ?? null;
}

async function processEvent(merchant: LoadedMerchant, event: NormalizedEvent) {
  if (event.kind === "ignored") return;
  if (event.kind === "payment") {
    const p = await findPayment(merchant.id, event.snapshot.providerPaymentId, event.snapshot.providerChargeId ?? null, event.snapshot.metadata?.payment_id);
    if (!p) return; // payment created outside the portal
    await applySnapshot(p.id, event.snapshot, "webhook");
    return;
  }
  if (event.kind === "refund") {
    const p = await findPayment(merchant.id, event.providerPaymentId, event.providerChargeId);
    if (!p) return;
    if (!event.providerRefundId.startsWith("charge:")) {
      await sql`insert into refunds (payment_id, provider_refund_id, amount_minor, status)
                values (${p.id}, ${event.providerRefundId}, ${event.amountMinor}, ${event.status})
                on conflict (payment_id, provider_refund_id) do update set status = excluded.status`;
    }
    const snap = await getAdapter(merchant).retrievePayment(p.provider_payment_id!);
    await applySnapshot(p.id, snap, "webhook");
    return;
  }
  if (event.kind === "dispute") {
    const p = await findPayment(merchant.id, event.providerPaymentId, event.providerChargeId);
    await sql`insert into disputes (payment_id, merchant_id, provider_dispute_id, amount_minor, currency, reason, status, evidence_due_by)
              values (${p?.id ?? null}, ${merchant.id}, ${event.providerDisputeId}, ${event.amountMinor}, ${event.currency}, ${event.reason}, ${event.status}, ${event.evidenceDueBy})
              on conflict (provider_dispute_id) do update set status = excluded.status, evidence_due_by = excluded.evidence_due_by`;
    if (p && !["won", "WON", "RESOLVED"].includes(event.status) && p.status !== "disputed") {
      await sql`update payments set status = 'disputed' where id = ${p.id}`;
      await onTransition(p.status, { ...p, status: "disputed" }, "webhook");
    }
  }
}

/** Admin refund (full or partial). */
export async function refundPayment(paymentId: string, amountMinor: number, reason: string, actor: { id: string; email: string }, meta: RequestMeta) {
  const [p] = await sql<PaymentRow[]>`select * from payments where id = ${paymentId}`;
  if (!p) throw new Error("Payment not found");
  if (!["succeeded", "partially_refunded"].includes(p.status)) throw new Error(`Cannot refund a ${p.status} payment`);
  const refundable = p.amount_minor - p.amount_refunded_minor;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > refundable) throw new Error(`Refund must be between 0 and ${formatMoney(refundable, p.currency)}`);

  const merchant = (await loadMerchant(p.merchant_id))!;
  const adapter = getAdapter(merchant);
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from refunds where payment_id = ${p.id}`;
  const r = await adapter.refund({ providerPaymentId: p.provider_payment_id!, providerChargeId: p.provider_charge_id, amountMinor, currency: p.currency, reason, idempotencyKey: `refund:${p.id}:${n + 1}:${amountMinor}` });
  await sql`insert into refunds (payment_id, provider_refund_id, amount_minor, reason, status, created_by)
            values (${p.id}, ${r.providerRefundId}, ${amountMinor}, ${reason}, ${r.status}, ${actor.id})
            on conflict (payment_id, provider_refund_id) do nothing`;
  const snap = await adapter.retrievePayment(p.provider_payment_id!);
  const updated = await applySnapshot(p.id, snap, "admin_refund");

  const money = formatMoney(amountMinor, p.currency);
  await audit({ actor: { type: "user", id: actor.id, label: actor.email }, action: "payment.refund", entityType: "payment", entityId: p.id, before: { refunded: p.amount_refunded_minor }, after: { refunded: updated.amount_refunded_minor, amount: amountMinor, reason }, ip: meta.ip, userAgent: meta.userAgent, riskScore: amountMinor >= refundable ? 40 : 20, reasons: ["refund_issued"] });
  await raiseAlert({ severity: "warning", type: "refund_issued", title: `Refund ${money} issued by ${actor.email}`, message: reason, entityType: "payment", entityId: p.id, userId: actor.id });

  const [inv] = await sql<InvoiceRow[]>`select * from invoices where id = ${p.invoice_id}`;
  const brand = (await getBrand(p.brand_id))!;
  const { customer, vars } = await invoiceEmailVars(inv, brand);
  await sendTemplatedEmail({ brand, type: "refund", to: customer.email, invoiceId: inv.id, vars: { ...vars, refund_amount: money }, sentBy: actor.id }).catch(() => undefined);
  await emitEvent(brand.id, "payment.refunded", { payment_id: p.id, amount_minor: amountMinor, currency: p.currency });
  return updated;
}
