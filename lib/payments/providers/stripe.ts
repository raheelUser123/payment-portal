import "server-only";
import Stripe from "stripe";
import type {
  CreatePaymentInput, CreatePaymentResult, LoadedMerchant, NormalizedEvent, PaymentProviderAdapter,
  PaymentSnapshot, StripeCredentials,
} from "../types";
import { ProviderError } from "../types";
import type { PaymentStatus } from "../../types";

/**
 * Stripe adapter — white-label by design:
 *  - Payments are collected with the Payment Element embedded on the BRAND's
 *    own domain (no Stripe-hosted checkout / invoice pages, which show the
 *    Stripe account's business name).
 *  - `receipt_email` is never set, so Stripe never emails the customer; the
 *    portal sends its own brand-styled receipts.
 *  - Per-brand `statement_descriptor_suffix` (card statements show
 *    "<ACCOUNT PREFIX>* <BRAND SUFFIX>").
 *  - Card-only by default: redirect-based methods (Klarna, bank redirects…) and
 *    Link can surface the account name, so they are opt-in per merchant via
 *    public_config.paymentMethodTypes.
 */

const clients = new Map<string, Stripe>();

function client(m: LoadedMerchant): Stripe {
  const creds = m.credentials as StripeCredentials;
  const cacheKey = `${m.id}:${creds.secretKey.slice(-6)}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = new Stripe(creds.secretKey, { maxNetworkRetries: 2, timeout: 20000, appInfo: { name: "PaymentPortal" } });
    clients.set(cacheKey, c);
  }
  return c;
}

function mapStatus(s: string): PaymentStatus {
  switch (s) {
    case "succeeded": return "succeeded";
    case "processing": return "processing";
    case "canceled": return "canceled";
    case "requires_payment_method": return "pending";
    default: return "pending"; // requires_confirmation / requires_action / requires_capture
  }
}

function snapshotFromIntent(pi: Stripe.PaymentIntent): PaymentSnapshot {
  const charge = typeof pi.latest_charge === "object" && pi.latest_charge ? (pi.latest_charge as Stripe.Charge) : null;
  const card = charge?.payment_method_details?.card;
  let status = mapStatus(pi.status);
  const refunded = charge?.amount_refunded ?? 0;
  if (status === "succeeded" && refunded > 0) status = refunded >= pi.amount_received ? "refunded" : "partially_refunded";
  if (charge?.disputed) status = "disputed";
  const lastError = pi.last_payment_error;
  if (pi.status === "requires_payment_method" && lastError) status = "failed";
  return {
    providerPaymentId: pi.id,
    providerChargeId: charge?.id ?? (typeof pi.latest_charge === "string" ? pi.latest_charge : null),
    status,
    amountMinor: pi.amount,
    amountRefundedMinor: refunded,
    currency: pi.currency.toUpperCase(),
    failureCode: lastError?.decline_code ?? lastError?.code ?? null,
    failureMessage: lastError?.message ?? null,
    paymentMethodType: charge?.payment_method_details?.type ?? pi.payment_method_types?.[0] ?? null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    cardCountry: card?.country ?? null,
    payerName: charge?.billing_details?.name ?? null,
    payerEmail: charge?.billing_details?.email ?? null,
    riskLevel: charge?.outcome?.risk_level ?? null,
    riskScore: charge?.outcome?.risk_score ?? null,
    metadata: (pi.metadata ?? {}) as Record<string, string>,
  };
}

function sanitizeSuffix(s: string | null): string | undefined {
  if (!s) return undefined;
  const clean = s.replace(/[<>\\'"*]/g, "").trim().slice(0, 22);
  return clean.length >= 1 ? clean : undefined;
}

export function stripeAdapter(m: LoadedMerchant): PaymentProviderAdapter {
  const stripe = client(m);
  const creds = m.credentials as StripeCredentials;
  const methodTypes = Array.isArray(m.publicConfig.paymentMethodTypes) && m.publicConfig.paymentMethodTypes.length
    ? (m.publicConfig.paymentMethodTypes as string[])
    : ["card"];

  return {
    provider: "stripe",

    async verifyCredentials() {
      try {
        const bal = await stripe.balance.retrieve();
        const livemode = bal.livemode;
        if ((m.mode === "live") !== livemode) return { ok: false, error: `Key is ${livemode ? "LIVE" : "TEST"} but merchant mode is ${m.mode}` };
        return { ok: true, label: `Stripe ${livemode ? "live" : "test"} account reachable` };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      try {
        const pi = await stripe.paymentIntents.create(
          {
            amount: input.amountMinor,
            currency: input.currency.toLowerCase(),
            allowed_payment_method_types: methodTypes as never,
            description: input.description.slice(0, 1000),
            statement_descriptor_suffix: sanitizeSuffix(input.descriptorSuffix),
            metadata: {
              payment_id: input.paymentId,
              invoice_id: input.invoiceId,
              invoice_number: input.invoiceNumber,
              brand: input.brandSlug,
              customer_email: input.customerEmail.slice(0, 200),
            },
          },
          { idempotencyKey: input.idempotencyKey },
        );
        return { providerPaymentId: pi.id, clientToken: pi.client_secret!, status: mapStatus(pi.status) };
      } catch (e) {
        throw new ProviderError((e as Error).message, (e as { code?: string }).code, "Unable to start the payment. Please try again.");
      }
    },

    async resumePayment(id, amountMinor) {
      const pi = await stripe.paymentIntents.retrieve(id);
      if (pi.amount !== amountMinor) {
        if (["requires_payment_method", "requires_confirmation"].includes(pi.status)) await stripe.paymentIntents.cancel(id).catch(() => undefined);
        return null;
      }
      if (!["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status)) return null;
      return { providerPaymentId: pi.id, clientToken: pi.client_secret!, status: mapStatus(pi.status) };
    },

    async retrievePayment(id) {
      const pi = await stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] });
      return snapshotFromIntent(pi);
    },

    async refund({ providerPaymentId, amountMinor, reason, idempotencyKey }) {
      const r = await stripe.refunds.create(
        {
          payment_intent: providerPaymentId,
          amount: amountMinor,
          reason: reason === "duplicate" || reason === "fraudulent" ? reason : "requested_by_customer",
        },
        { idempotencyKey },
      );
      return { providerRefundId: r.id, status: r.status ?? "pending" };
    },

    async parseWebhook(rawBody, headers): Promise<NormalizedEvent> {
      const sig = headers.get("stripe-signature");
      if (!sig || !creds.webhookSecret) throw new ProviderError("Missing Stripe signature or webhook secret");
      // Throws if the signature is invalid or older than 5 minutes.
      const event = stripe.webhooks.constructEvent(rawBody, sig, creds.webhookSecret, 300);
      const obj = event.data.object as unknown as Record<string, unknown>;

      if (event.type.startsWith("payment_intent.")) {
        // Always re-fetch: the event payload may be stale/out of order.
        const snap = await this.retrievePayment(obj.id as string);
        if (event.type === "payment_intent.payment_failed" && snap.status === "pending") snap.status = "failed";
        return { kind: "payment", id: event.id, type: event.type, snapshot: snap };
      }
      if (event.type === "charge.refunded" || event.type === "charge.refund.updated" || event.type === "refund.updated" || event.type === "refund.created") {
        if (event.type === "charge.refunded") {
          const ch = obj as unknown as Stripe.Charge;
          const pid = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id ?? null;
          return { kind: "refund", id: event.id, type: event.type, providerPaymentId: pid, providerChargeId: ch.id,
            providerRefundId: `charge:${ch.id}`, amountMinor: ch.amount_refunded, status: "succeeded", totalRefundedMinor: ch.amount_refunded };
        }
        const r = obj as unknown as Stripe.Refund;
        const pid = typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent?.id ?? null;
        const cid = typeof r.charge === "string" ? r.charge : r.charge?.id ?? null;
        return { kind: "refund", id: event.id, type: event.type, providerPaymentId: pid, providerChargeId: cid,
          providerRefundId: r.id, amountMinor: r.amount, status: r.status ?? "pending" };
      }
      if (event.type.startsWith("charge.dispute.")) {
        const d = obj as unknown as Stripe.Dispute;
        const pid = typeof d.payment_intent === "string" ? d.payment_intent : d.payment_intent?.id ?? null;
        const cid = typeof d.charge === "string" ? d.charge : d.charge?.id ?? null;
        return { kind: "dispute", id: event.id, type: event.type, providerDisputeId: d.id, providerPaymentId: pid, providerChargeId: cid,
          amountMinor: d.amount, currency: d.currency.toUpperCase(), reason: d.reason ?? null, status: d.status,
          evidenceDueBy: d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000) : null };
      }
      return { kind: "ignored", id: event.id, type: event.type };
    },
  };
}
