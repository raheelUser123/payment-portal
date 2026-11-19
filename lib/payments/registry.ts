import "server-only";
import type { LoadedMerchant, PaymentProviderAdapter } from "./types";
import { stripeAdapter } from "./providers/stripe";
import { paypalAdapter } from "./providers/paypal";

/**
 * Provider registry. To add a gateway (Authorize.net, Square, NMI…):
 *  1. implement PaymentProviderAdapter in ./providers/<name>.ts
 *  2. register it here
 *  3. add its credential fields in app/admin/merchants/merchant-form.tsx
 *  4. add its client widget to app/pay/[slug]/[token]/checkout.tsx
 */
const factories: Partial<Record<LoadedMerchant["provider"], (m: LoadedMerchant) => PaymentProviderAdapter>> = {
  stripe: stripeAdapter,
  paypal: paypalAdapter,
};

export const SUPPORTED_PROVIDERS = Object.keys(factories) as LoadedMerchant["provider"][];

export function getAdapter(m: LoadedMerchant): PaymentProviderAdapter {
  const f = factories[m.provider];
  if (!f) throw new Error(`Provider ${m.provider} is not implemented yet`);
  return f(m);
}
