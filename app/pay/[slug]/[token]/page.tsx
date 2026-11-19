import type { Metadata } from "next";
import { sql } from "@/lib/db";
import { formatMoney } from "@/lib/payments/money";
import { availableProviders } from "@/lib/payments/service";
import { logActivity } from "@/lib/logging/activity";
import { requestMeta } from "@/lib/security/request";
import { BrandShell, loadPublicInvoice } from "./shared";
import { Checkout } from "./checkout";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string; token: string }> }): Promise<Metadata> {
  const { slug, token } = await params;
  const { inv, brand } = await loadPublicInvoice(slug, token);
  return { title: { absolute: `Invoice ${inv.number} · ${brand.name}` }, robots: { index: false, follow: false } };
}

export default async function PayPage({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  const { inv, brand, customer, items } = await loadPublicInvoice(slug, token);
  const due = Math.max(0, inv.total_minor - inv.amount_paid_minor);
  const expired = inv.token_expires_at && inv.token_expires_at < new Date();

  // view tracking (first view is logged)
  await sql`update invoices set view_count = view_count + 1, viewed_at = coalesce(viewed_at, now()) where id = ${inv.id}`;
  if (!inv.viewed_at) {
    const meta = await requestMeta();
    await logActivity({ action: "invoice.viewed", entityType: "invoice", entityId: inv.id, description: `${inv.number} opened by customer`, ip: meta.ip, userAgent: meta.userAgent });
  }

  const payable = inv.status === "open" && due > 0 && !expired;
  const providers = payable ? await availableProviders(inv) : [];

  return (
    <BrandShell brand={brand}>
      <div className="grid gap-6 md:grid-cols-5">
        <section className="card p-6 md:col-span-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Invoice</p>
              <h1 className="text-xl font-semibold">{inv.number}</h1>
              {inv.title && <p className="mt-1 text-slate-600">{inv.title}</p>}
            </div>
            <StatusPill status={inv.status} expired={!!expired} />
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
            <div><dt className="text-slate-500">Billed to</dt><dd className="font-medium">{customer.name}</dd><dd className="text-slate-500">{customer.email}</dd></div>
            <div><dt className="text-slate-500">Due date</dt><dd className="font-medium">{inv.due_date ? new Date(inv.due_date).toLocaleDateString("en-US", { dateStyle: "medium" }) : "Upon receipt"}</dd></div>
          </dl>
          <table className="mt-6 w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500"><th className="py-2">Description</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Amount</th></tr></thead>
            <tbody>
              {items.map((i, idx) => (
                <tr key={idx} className="border-b border-slate-100">
                  <td className="py-2.5 pr-2">{i.description}</td>
                  <td className="py-2.5 text-right text-slate-600">{Number(i.quantity)}</td>
                  <td className="py-2.5 text-right">{formatMoney(i.amount_minor, inv.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="mt-4 space-y-1 text-sm">
            <Row label="Subtotal" value={formatMoney(inv.subtotal_minor, inv.currency)} />
            {inv.discount_minor > 0 && <Row label="Discount" value={`−${formatMoney(inv.discount_minor, inv.currency)}`} />}
            {inv.tax_minor > 0 && <Row label="Tax" value={formatMoney(inv.tax_minor, inv.currency)} />}
            {inv.amount_paid_minor > 0 && <Row label="Paid" value={`−${formatMoney(inv.amount_paid_minor, inv.currency)}`} />}
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold"><dt>Amount due</dt><dd>{formatMoney(due, inv.currency)}</dd></div>
          </dl>
          {inv.memo && <p className="mt-6 whitespace-pre-line rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{inv.memo}</p>}
        </section>

        <section className="card h-fit p-6 md:col-span-2">
          {payable ? (
            providers.length > 0 ? (
              <Checkout token={token} basePath={`/pay/${brand.slug}/${token}`} providers={providers} brandName={brand.name} brandColor={brand.accent_color}
                amountLabel={formatMoney(due, inv.currency)} currency={inv.currency} customerName={customer.name} customerEmail={customer.email} />
            ) : (
              <p className="text-sm text-slate-600">Online payment is temporarily unavailable for this invoice. Please contact {brand.support_email ?? "support"}.</p>
            )
          ) : (
            <div className="text-center">
              <p className="text-lg font-semibold">{inv.status === "paid" || inv.status === "partially_refunded" ? "Paid — thank you!" : expired ? "Link expired" : "Not payable"}</p>
              <p className="mt-2 text-sm text-slate-600">
                {inv.status === "paid" ? `Paid on ${inv.paid_at ? new Date(inv.paid_at).toLocaleDateString("en-US", { dateStyle: "medium" }) : ""}.` : "Please contact us if you have questions."}
              </p>
            </div>
          )}
        </section>
      </div>
    </BrandShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-slate-600"><dt>{label}</dt><dd>{value}</dd></div>;
}

function StatusPill({ status, expired }: { status: string; expired: boolean }) {
  const map: Record<string, string> = { open: "bg-amber-100 text-amber-800", paid: "bg-emerald-100 text-emerald-800", void: "bg-slate-200 text-slate-700", refunded: "bg-slate-200 text-slate-700", partially_refunded: "bg-emerald-100 text-emerald-800" };
  const label = expired && status === "open" ? "Expired" : status === "open" ? "Due" : status.replace("_", " ");
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${map[status] ?? "bg-slate-100 text-slate-700"}`}>{label}</span>;
}
