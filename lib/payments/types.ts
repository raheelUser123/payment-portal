import type { Provider, PaymentStatus } from "../types";

export type StripeCredentials = { secretKey: string; webhookSecret?: string };
export type PaypalCredentials = { clientId: string; clientSecret: string; webhookId?: string };
export type MerchantCredentials = StripeCredentials | PaypalCredentials;

export type LoadedMerchant = {
  id: string;
  name: string;
  provider: Provider;
  mode: "test" | "live";
  publicConfig: Record<string, unknown>;
  credentials: MerchantCredentials;
};

/** What the brand/invoice context passes to a provider when creating a payment. */
export type CreatePaymentInput = {
  paymentId: string;          // our payments.id
  invoiceId: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  brandName: string;
  brandSlug: string;
  descriptorSuffix: string | null;
  customerEmail: string;
  customerName: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
};

export type CreatePaymentResult = {
  providerPaymentId: string;
  /** Stripe: PaymentIntent client_secret. PayPal: order id. */
  clientToken: string;
  status: PaymentStatus;
};

/** Normalised state of a payment at the provider. */
export type PaymentSnapshot = {
  providerPaymentId: string;
  providerChargeId?: string | null;
  status: PaymentStatus;
  amountMinor: number;
  amountRefundedMinor?: number;
  currency: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  paymentMethodType?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  cardCountry?: string | null;
  payerName?: string | null;
  payerEmail?: string | null;
  riskLevel?: string | null;
  riskScore?: number | null;
  metadata?: Record<string, string>;
};

export type NormalizedEvent =
  | { kind: "payment"; id: string; type: string; snapshot: PaymentSnapshot }
  | { kind: "refund"; id: string; type: string; providerPaymentId: string | null; providerChargeId: string | null; providerRefundId: string; amountMinor: number; status: string; totalRefundedMinor?: number }
  | { kind: "dispute"; id: string; type: string; providerDisputeId: string; providerPaymentId: string | null; providerChargeId: string | null; amountMinor: number; currency: string; reason: string | null; status: string; evidenceDueBy: Date | null }
  | { kind: "ignored"; id: string; type: string };

export interface PaymentProviderAdapter {
  readonly provider: Provider;
  verifyCredentials(): Promise<{ ok: boolean; label?: string; error?: string }>;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Re-use an existing provider payment if possible (amount unchanged). */
  resumePayment?(providerPaymentId: string, amountMinor: number): Promise<CreatePaymentResult | null>;
  /** PayPal-style explicit capture after buyer approval. */
  capturePayment?(providerPaymentId: string, idempotencyKey: string): Promise<PaymentSnapshot>;
  retrievePayment(providerPaymentId: string): Promise<PaymentSnapshot>;
  refund(args: { providerPaymentId: string; providerChargeId: string | null; amountMinor: number; currency: string; reason?: string; idempotencyKey: string }): Promise<{ providerRefundId: string; status: string }>;
  /** Verify signature and normalise. Throws on invalid signature. */
  parseWebhook(rawBody: string, headers: Headers): Promise<NormalizedEvent>;
}

export class ProviderError extends Error {
  constructor(message: string, public code?: string, public userMessage?: string) {
    super(message);
  }
}
