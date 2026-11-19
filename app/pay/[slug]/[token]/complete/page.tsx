import { CheckoutError, confirmCheckout } from "@/lib/payments/service";
import { formatMoney } from "@/lib/payments/money";
import { BrandShell, loadPublicInvoice } from "../shared";

export const dynamic = "force-dynamic";

export default async function CompletePage({ params, searchParams }: { params: Promise<{ slug: string; token: string }>; searchParams: Promise<{ payment?: string }> }) {
  const { slug, token } = await params;
  const { payment } = await searchParams;
  const { inv, brand } = await loadPublicInvoice(slug, token, `/complete${payment ? `?payment=${payment}` : ""}`);

  let status: string = "unknown";
  let message: string | null = null;
  let amount = 0;
  if (payment && /^[0-9a-f-]{36}$/i.test(payment)) {
    try {
      const p = await confirmCheckout(token, payment);
      status = p.status;
      message = p.failure_message;
      amount = p.amount_minor;
    } catch (e) {
      message = e instanceof CheckoutError ? e.message : "We couldn't verify the payment yet.";
    }
  }

  const success = ["succeeded", "partially_refunded", "refunded"].includes(status);
  return (
    <BrandShell brand={brand}>
      <div className="card mx-auto max-w-lg p-8 text-center">
        <div className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full text-2xl ${success ? "bg-emerald-100 text-emerald-700" : status === "processing" ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"}`}>
          {success ? "✓" : status === "processing" ? "…" : "!"}
        </div>
        <h1 className="text-xl font-semibold">
          {success ? "Payment successful" : status === "processing" ? "Payment processing" : "Payment not completed"}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {success
            ? `Thank you! We received ${formatMoney(amount, inv.currency)} for invoice ${inv.number}. A receipt is on its way to your inbox.`
            : status === "processing"
              ? "Your payment is being processed. You'll receive an email as soon as it completes."
              : message ?? "Your payment did not go through. No charge was made."}
        </p>
        {!success && status !== "processing" && (
          <a href={`/pay/${brand.slug}/${token}`} className="btn mt-6 text-white" style={{ background: brand.accent_color }}>Try again</a>
        )}
      </div>
    </BrandShell>
  );
}
