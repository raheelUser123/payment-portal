import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, accessibleBrandIds } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { formatMoney, toDecimalString } from "@/lib/payments/money";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, PageHeader, StatusBadge, dt, Badge } from "@/components/ui";
import { refundAction, reviewPaymentAction } from "../actions";
import type { PaymentRow } from "@/lib/types";

export const metadata = { title: "Payment" };

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const [p] = await sql<(PaymentRow & { number: string; brand: string; merchant: string; merchant_mode: string; customer: string; email: string; reviewer: string | null })[]>`
    select p.*, i.number, b.name as brand, m.name as merchant, m.mode as merchant_mode, c.name as customer, c.email, u.name as reviewer
      from payments p join invoices i on i.id = p.invoice_id join brands b on b.id = p.brand_id join merchants m on m.id = p.merchant_id
      join customers c on c.id = i.customer_id left join users u on u.id = p.reviewed_by
     where p.id = ${id}`;
  if (!p) notFound();
  const ids = await accessibleBrandIds(s);
  if (ids !== null && !ids.includes(p.brand_id)) notFound();
  const refunds = await sql<{ id: string; amount_minor: number; reason: string | null; status: string; created_at: Date; name: string | null; provider_refund_id: string | null }[]>`
    select r.id, r.amount_minor, r.reason, r.status, r.created_at, r.provider_refund_id, u.name from refunds r left join users u on u.id = r.created_by where r.payment_id = ${id} order by r.created_at desc`;
  const disputes = await sql<{ provider_dispute_id: string; amount_minor: number | null; reason: string | null; status: string | null; evidence_due_by: Date | null }[]>`
    select provider_dispute_id, amount_minor, reason, status, evidence_due_by from disputes where payment_id = ${id}`;

  const refundable = p.amount_minor - p.amount_refunded_minor;
  const canRefund = s.user.role === "admin" && ["succeeded", "partially_refunded"].includes(p.status) && refundable > 0;
  const dashboard = p.provider === "stripe" && p.provider_payment_id
    ? `https://dashboard.stripe.com/${p.merchant_mode === "test" ? "test/" : ""}payments/${p.provider_payment_id}` : null;

  return (
    <>
      <PageHeader title={`${formatMoney(p.amount_minor, p.currency)} · ${p.customer}`} description={`${p.brand} · invoice ${p.number} · ${dt(p.created_at)}`} actions={<StatusBadge status={p.status} />} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Details">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Item k="Invoice"><Link className="text-indigo-600" href={`/admin/invoices/${p.invoice_id}`}>{p.number}</Link></Item>
              <Item k="Customer">{p.customer} · {p.email}</Item>
              <Item k="Provider / merchant"><span className="capitalize">{p.provider}</span> · {p.merchant} <Badge tone={p.merchant_mode === "live" ? "green" : "amber"}>{p.merchant_mode}</Badge></Item>
              <Item k="Provider reference"><code className="text-xs">{p.provider_payment_id ?? "—"}</code>{dashboard && s.user.role === "admin" && <> · <a className="text-indigo-600" href={dashboard} target="_blank" rel="noopener noreferrer">open in Stripe</a></>}</Item>
              <Item k="Method">{p.payment_method_type ?? "—"}{p.card_last4 ? ` · ${p.card_brand} •••• ${p.card_last4}` : ""}{p.card_country ? ` (${p.card_country})` : ""}</Item>
              <Item k="Payer">{p.payer_name ?? "—"}{p.payer_email ? ` · ${p.payer_email}` : ""}</Item>
              <Item k="Refunded">{formatMoney(p.amount_refunded_minor, p.currency)}</Item>
              <Item k="Succeeded at">{dt(p.succeeded_at)}</Item>
              <Item k="Risk">{p.risk_level ?? "—"} {p.risk_score != null && <span className="text-slate-500">(score {p.risk_score})</span>}</Item>
              <Item k="Customer IP">{p.ip ?? "—"}</Item>
              {p.failure_message && <Item k="Failure">{p.failure_code ? `${p.failure_code}: ` : ""}{p.failure_message}</Item>}
            </dl>
          </Card>
          <Card title="Refunds">
            {refunds.length === 0 ? <p className="text-sm text-slate-500">No refunds.</p> : (
              <ul className="divide-y divide-slate-100 text-sm">{refunds.map((r) => <li key={r.id} className="flex justify-between py-2"><span>{r.reason ?? "—"}<br /><span className="text-xs text-slate-400">{dt(r.created_at)}{r.name ? ` · ${r.name}` : ""}</span></span><span className="flex items-center gap-2">{formatMoney(r.amount_minor, p.currency)}<StatusBadge status={r.status} /></span></li>)}</ul>
            )}
          </Card>
          {disputes.length > 0 && (
            <Card title="Disputes / chargebacks">
              <ul className="text-sm">{disputes.map((d) => <li key={d.provider_dispute_id} className="flex justify-between py-1"><span>{d.reason ?? "—"} <code className="text-xs text-slate-500">{d.provider_dispute_id}</code></span><span>{d.status} · evidence due {dt(d.evidence_due_by)}</span></li>)}</ul>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Review">
            <p className="mb-3 text-xs text-slate-500">{p.reviewed_at ? `Last reviewed by ${p.reviewer ?? "unknown"} ${dt(p.reviewed_at)}` : "Not reviewed yet."}</p>
            <ActionForm action={reviewPaymentAction} className="space-y-3">
              <input type="hidden" name="id" value={p.id} />
              <select name="review_status" className="input" defaultValue={p.review_status}><option value="pending">Pending</option><option value="approved">Approved</option><option value="flagged">Flagged</option></select>
              <textarea name="note" className="input min-h-20" defaultValue={p.review_note ?? ""} placeholder="Note" maxLength={1000} />
              <SubmitButton className="btn-secondary w-full">Save review</SubmitButton>
            </ActionForm>
          </Card>
          {canRefund && (
            <Card title="Refund">
              <ActionForm action={refundAction} confirm="Issue this refund? This cannot be undone." className="space-y-3">
                <input type="hidden" name="id" value={p.id} />
                <div><label className="label" htmlFor="amount">Amount ({p.currency}) — max {formatMoney(refundable, p.currency)}</label><input id="amount" name="amount" className="input" defaultValue={toDecimalString(refundable, p.currency)} inputMode="decimal" required /></div>
                <input name="reason" className="input" placeholder="Reason (internal + customer email)" required minLength={3} maxLength={500} />
                <SubmitButton className="btn-danger w-full" pendingText="Refunding…">Issue refund</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Item({ k, children }: { k: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-0.5">{children}</dd></div>;
}
