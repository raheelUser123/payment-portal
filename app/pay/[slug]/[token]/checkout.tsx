"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";

type ProviderOption = { provider: "stripe" | "paypal" | string; mode: string; publishableKey?: string; clientId?: string };

type Props = {
  token: string;
  /** /pay/<brand-slug>/<token> */
  basePath: string;
  providers: ProviderOption[];
  brandName: string;
  brandColor: string;
  amountLabel: string;
  currency: string;
  customerName: string;
  customerEmail: string;
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Something went wrong. Please try again.");
  return json as T;
}

export function Checkout(props: Props) {
  const [tab, setTab] = useState(props.providers[0]?.provider);
  const labels: Record<string, string> = { stripe: "Card", paypal: "PayPal" };
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Amount due</p>
      <p className="mb-5 text-3xl font-bold">{props.amountLabel}</p>
      {props.providers.length > 1 && (
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1 text-sm font-medium">
          {props.providers.map((p) => (
            <button key={p.provider} type="button" onClick={() => setTab(p.provider)}
              className={`rounded-md py-2 transition ${tab === p.provider ? "bg-white shadow" : "text-slate-600"}`}>
              {labels[p.provider] ?? p.provider}
            </button>
          ))}
        </div>
      )}
      {props.providers.map((p) =>
        p.provider !== tab ? null : p.provider === "stripe" ? (
          <StripeCheckout key="stripe" {...props} option={p} />
        ) : p.provider === "paypal" ? (
          <PaypalCheckout key="paypal" {...props} option={p} />
        ) : null,
      )}
      <p className="mt-5 text-center text-xs text-slate-500">Your payment details are encrypted end-to-end and never stored on our servers.</p>
    </div>
  );
}

const stripeCache = new Map<string, Promise<Stripe | null>>();

function StripeCheckout(props: Props & { option: ProviderOption }) {
  const [session, setSession] = useState<{ clientToken: string; paymentId: string; publishableKey: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    post<{ clientToken: string; paymentId: string; publishableKey: string }>(`${props.basePath}/start`, { provider: "stripe" })
      .then((s) => !cancelled && setSession(s))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [props.token]);

  const stripePromise = useMemo(() => {
    if (!session?.publishableKey) return null;
    if (!stripeCache.has(session.publishableKey)) stripeCache.set(session.publishableKey, loadStripe(session.publishableKey));
    return stripeCache.get(session.publishableKey)!;
  }, [session?.publishableKey]);

  if (error) return <ErrorBox message={error} />;
  if (!session || !stripePromise) return <Skeleton />;

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: session.clientToken,
        appearance: {
          theme: "stripe",
          variables: { colorPrimary: props.brandColor, borderRadius: "8px", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" },
        },
      }}
    >
      <StripeForm {...props} paymentId={session.paymentId} />
    </Elements>
  );
}

function StripeForm(props: Props & { paymentId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(props.customerName);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const returnUrl = `${window.location.origin}${props.basePath}/complete?payment=${props.paymentId}`;
    const { error: err, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: {
        return_url: returnUrl,
        payment_method_data: { billing_details: { name, email: props.customerEmail } },
      },
    });
    if (err) {
      setError(err.message ?? "Your payment could not be completed.");
      setBusy(false);
      // let the server record the failed attempt
      post(`${props.basePath}/confirm`, { paymentId: props.paymentId }).catch(() => undefined);
      return;
    }
    if (paymentIntent) window.location.assign(returnUrl);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="cardholder">Name on card</label>
        <input id="cardholder" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="cc-name" />
      </div>
      <PaymentElement
        options={{
          layout: "tabs",
          business: { name: props.brandName },
          wallets: { applePay: "never", googlePay: "never", link: "never" },
          fields: { billingDetails: { name: "never", email: "never" } },
          terms: { card: "never" },
        }}
      />
      {error && <ErrorBox message={error} />}
      <button type="submit" disabled={!stripe || busy} className="btn w-full py-3 text-base text-white" style={{ background: props.brandColor }}>
        {busy ? "Processing…" : `Pay ${props.amountLabel}`}
      </button>
    </form>
  );
}

function PaypalCheckout(props: Props & { option: ProviderOption }) {
  const [error, setError] = useState<string | null>(null);
  const paymentIdRef = useRef<string | null>(null);
  if (!props.option.clientId) return <ErrorBox message="PayPal is not available." />;
  return (
    <PayPalScriptProvider options={{ clientId: props.option.clientId, currency: props.currency, intent: "capture", components: "buttons" }}>
      {error && <div className="mb-3"><ErrorBox message={error} /></div>}
      <PayPalButtons
        style={{ layout: "vertical", shape: "rect", label: "pay" }}
        createOrder={async () => {
          setError(null);
          const r = await post<{ clientToken: string; paymentId: string }>(`${props.basePath}/start`, { provider: "paypal" });
          paymentIdRef.current = r.paymentId;
          return r.clientToken;
        }}
        onApprove={async () => {
          const paymentId = paymentIdRef.current;
          if (!paymentId) return;
          try {
            await post(`${props.basePath}/confirm`, { paymentId });
            window.location.assign(`${props.basePath}/complete?payment=${paymentId}`);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
        onError={() => setError("PayPal could not process the payment. Please try again or use another method.")}
      />
    </PayPalScriptProvider>
  );
}

function ErrorBox({ message }: { message: string }) {
  return <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{message}</div>;
}

function Skeleton() {
  return (
    <div className="space-y-3" aria-busy>
      <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
      <div className="h-24 animate-pulse rounded-lg bg-slate-100" />
      <div className="h-11 animate-pulse rounded-lg bg-slate-200" />
    </div>
  );
}
