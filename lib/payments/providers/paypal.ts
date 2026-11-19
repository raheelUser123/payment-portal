import "server-only";
import type {
  CreatePaymentInput, CreatePaymentResult, LoadedMerchant, NormalizedEvent, PaymentProviderAdapter,
  PaymentSnapshot, PaypalCredentials,
} from "../types";
import { ProviderError } from "../types";
import { toDecimalString, toMinor } from "../money";
import type { PaymentStatus } from "../../types";

/**
 * PayPal Orders v2 adapter. White-label: `experience_context.brand_name`
 * shows the BRAND name inside the PayPal checkout window, and
 * `soft_descriptor` sets the per-brand statement text.
 */

const tokenCache = new Map<string, { token: string; exp: number }>();

function base(m: LoadedMerchant) {
  return m.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function accessToken(m: LoadedMerchant): Promise<string> {
  const creds = m.credentials as PaypalCredentials;
  const key = `${m.id}:${creds.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${base(m)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new ProviderError(`PayPal auth failed: ${body.error_description ?? res.status}`);
  tokenCache.set(key, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 300) * 1000 });
  return body.access_token;
}

async function api<T>(m: LoadedMerchant, path: string, init: { method?: string; body?: unknown; requestId?: string } = {}): Promise<T> {
  const token = await accessToken(m);
  const res = await fetch(`${base(m)}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string; details?: { issue?: string; description?: string }[] };
  if (!res.ok) {
    const issue = json.details?.[0]?.issue;
    throw new ProviderError(`PayPal ${path} ${res.status}: ${issue ?? json.message ?? "error"}`, issue,
      issue === "INSTRUMENT_DECLINED" ? "Your payment method was declined. Please try another." : "PayPal could not process the payment.");
  }
  return json;
}

type Money = { currency_code: string; value: string };
type Capture = { id: string; status: string; amount: Money; seller_receivable_breakdown?: unknown; supplementary_data?: { related_ids?: { order_id?: string } } };
type Order = {
  id: string;
  status: string;
  purchase_units?: { amount: Money; custom_id?: string; reference_id?: string; payments?: { captures?: Capture[]; refunds?: { amount: Money; status: string }[] } }[];
  payer?: { name?: { given_name?: string; surname?: string }; email_address?: string; address?: { country_code?: string } };
};

function orderSnapshot(o: Order): PaymentSnapshot {
  const pu = o.purchase_units?.[0];
  const capture = pu?.payments?.captures?.[0];
  const currency = (capture?.amount.currency_code ?? pu?.amount.currency_code ?? "USD").toUpperCase();
  const amount = toMinor(capture?.amount.value ?? pu?.amount.value ?? "0", currency);
  const refunded = (pu?.payments?.refunds ?? []).filter((r) => r.status === "COMPLETED").reduce((s, r) => s + toMinor(r.amount.value, currency), 0);
  let status: PaymentStatus = "pending";
  if (capture?.status === "COMPLETED") status = refunded > 0 ? (refunded >= amount ? "refunded" : "partially_refunded") : "succeeded";
  else if (capture?.status === "PENDING") status = "processing";
  else if (capture?.status === "DECLINED" || capture?.status === "FAILED") status = "failed";
  else if (capture?.status === "REFUNDED") status = "refunded";
  else if (o.status === "VOIDED") status = "canceled";
  return {
    providerPaymentId: o.id,
    providerChargeId: capture?.id ?? null,
    status,
    amountMinor: amount,
    amountRefundedMinor: refunded,
    currency,
    paymentMethodType: "paypal",
    payerName: [o.payer?.name?.given_name, o.payer?.name?.surname].filter(Boolean).join(" ") || null,
    payerEmail: o.payer?.email_address ?? null,
    cardCountry: o.payer?.address?.country_code ?? null,
    failureMessage: status === "failed" ? `Capture ${capture?.status}` : null,
    metadata: pu?.custom_id ? { payment_id: pu.custom_id } : {},
  };
}

export function paypalAdapter(m: LoadedMerchant): PaymentProviderAdapter {
  const creds = m.credentials as PaypalCredentials;
  return {
    provider: "paypal",

    async verifyCredentials() {
      try {
        await accessToken(m);
        return { ok: true, label: `PayPal ${m.mode} credentials valid` };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },

    async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
      const order = await api<Order>(m, "/v2/checkout/orders", {
        method: "POST",
        requestId: input.idempotencyKey,
        body: {
          intent: "CAPTURE",
          purchase_units: [{
            reference_id: input.invoiceId,
            custom_id: input.paymentId,
            // PayPal requires invoice_id to be unique per account; suffix with payment id.
            invoice_id: `${input.invoiceNumber}-${input.paymentId.slice(0, 8)}`,
            description: input.description.slice(0, 127),
            soft_descriptor: input.descriptorSuffix?.slice(0, 22) || undefined,
            amount: { currency_code: input.currency.toUpperCase(), value: toDecimalString(input.amountMinor, input.currency) },
          }],
          payment_source: {
            paypal: {
              experience_context: {
                brand_name: input.brandName.slice(0, 127),
                shipping_preference: "NO_SHIPPING",
                user_action: "PAY_NOW",
                return_url: input.returnUrl,
                cancel_url: input.cancelUrl,
              },
            },
          },
        },
      });
      return { providerPaymentId: order.id, clientToken: order.id, status: "pending" };
    },

    async capturePayment(orderId, idempotencyKey) {
      try {
        const o = await api<Order>(m, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", requestId: idempotencyKey, body: {} });
        return orderSnapshot(o);
      } catch (e) {
        if (e instanceof ProviderError && e.code === "ORDER_ALREADY_CAPTURED") return this.retrievePayment(orderId);
        throw e;
      }
    },

    async retrievePayment(orderId) {
      return orderSnapshot(await api<Order>(m, `/v2/checkout/orders/${encodeURIComponent(orderId)}`));
    },

    async refund({ providerChargeId, amountMinor, currency, idempotencyKey }) {
      if (!providerChargeId) throw new ProviderError("PayPal capture id missing — cannot refund");
      const r = await api<{ id: string; status: string }>(m, `/v2/payments/captures/${encodeURIComponent(providerChargeId)}/refund`, {
        method: "POST",
        requestId: idempotencyKey,
        body: { amount: { currency_code: currency.toUpperCase(), value: toDecimalString(amountMinor, currency) } },
      });
      return { providerRefundId: r.id, status: r.status.toLowerCase() };
    },

    async parseWebhook(rawBody, headers): Promise<NormalizedEvent> {
      if (!creds.webhookId) throw new ProviderError("PayPal webhook id not configured");
      const event = JSON.parse(rawBody) as { id: string; event_type: string; resource: Record<string, unknown> };
      const verify = await api<{ verification_status: string }>(m, "/v1/notifications/verify-webhook-signature", {
        method: "POST",
        body: {
          auth_algo: headers.get("paypal-auth-algo"),
          cert_url: headers.get("paypal-cert-url"),
          transmission_id: headers.get("paypal-transmission-id"),
          transmission_sig: headers.get("paypal-transmission-sig"),
          transmission_time: headers.get("paypal-transmission-time"),
          webhook_id: creds.webhookId,
          webhook_event: event,
        },
      });
      if (verify.verification_status !== "SUCCESS") throw new ProviderError("Invalid PayPal webhook signature");

      const r = event.resource;
      if (event.event_type.startsWith("PAYMENT.CAPTURE.")) {
        const cap = r as unknown as Capture & { links?: { rel: string; href: string }[] };
        const orderId = cap.supplementary_data?.related_ids?.order_id;
        if (event.event_type === "PAYMENT.CAPTURE.REFUNDED" || event.event_type === "PAYMENT.CAPTURE.REVERSED") {
          const amount = cap.amount ? toMinor(cap.amount.value, cap.amount.currency_code) : 0;
          // For refund events the resource is the refund; the capture id is in links.
          const upLink = cap.links?.find((l) => l.rel === "up")?.href ?? "";
          const captureId = upLink.split("/captures/")[1]?.split("/")[0] ?? null;
          return { kind: "refund", id: event.id, type: event.event_type, providerPaymentId: orderId ?? null, providerChargeId: captureId,
            providerRefundId: cap.id, amountMinor: amount, status: "succeeded" };
        }
        if (orderId) {
          const snap = await this.retrievePayment(orderId);
          return { kind: "payment", id: event.id, type: event.event_type, snapshot: snap };
        }
      }
      if (event.event_type.startsWith("CUSTOMER.DISPUTE.")) {
        const d = r as { dispute_id: string; reason?: string; status?: string; dispute_amount?: Money; seller_response_due_date?: string;
          disputed_transactions?: { seller_transaction_id?: string }[] };
        const currency = d.dispute_amount?.currency_code ?? "USD";
        return { kind: "dispute", id: event.id, type: event.event_type, providerDisputeId: d.dispute_id, providerPaymentId: null,
          providerChargeId: d.disputed_transactions?.[0]?.seller_transaction_id ?? null,
          amountMinor: d.dispute_amount ? toMinor(d.dispute_amount.value, currency) : 0, currency, reason: d.reason ?? null,
          status: d.status ?? "OPEN", evidenceDueBy: d.seller_response_due_date ? new Date(d.seller_response_due_date) : null };
      }
      return { kind: "ignored", id: event.id, type: event.event_type };
    },
  };
}
