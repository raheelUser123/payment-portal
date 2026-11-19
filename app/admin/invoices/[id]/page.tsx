import Link from "next/link";
import { DangerZone } from "@/components/danger-zone";
import { deleteInvoiceAction, invoiceDeleteBlocker } from "../../delete-actions";
import { notFound } from "next/navigation";
import { requireUser, accessibleBrandIds } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { getInvoice, invoicePayUrl } from "@/lib/invoices/service";
import { getBrand } from "@/lib/brands/service";
import { formatMoney } from "@/lib/payments/money";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, PageHeader, StatusBadge, dt } from "@/components/ui";
import { CopyButton } from "./copy-button";
import { reviewInvoiceAction, rotateLinkAction, sendInvoiceAction, voidInvoiceAction } from "../actions";
import type { CustomerRow } from "@/lib/types";

export const metadata = { title: "Invoice" };

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string; sendError?: string; updated?: string }> }) {
  const s = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const inv = await getInvoice(id);
  if (!inv) notFound();
  const ids = await accessibleBrandIds(s);
  if (ids !== null && !ids.includes(inv.brand_id)) notFound();

  const brand = (await getBrand(inv.brand_id))!;
  const deleteBlocked = s.user.role === "admin" ? await invoiceDeleteBlocker(id) : null;
  const [customer] = await sql<CustomerRow[]>`select * from customers where id = ${inv.customer_id}`;
  const items = await sql<{ description: string; quantity: string; unit_amount_minor: number; amount_minor: number }[]>`
    select description, quantity::text, unit_amount_minor, amount_minor from invoice_items where invoice_id = ${id} order by sort_order`;
  const payments = await sql<{ id: string; provider: string; status: string; amount_minor: number; amount_refunded_minor: number; card_brand: string | null; card_last4: string | null; failure_message: string | null; created_at: Date; merchant: string }[]>`
    select p.id, p.provider, p.status, p.amount_minor, p.amount_refunded_minor, p.card_brand, p.card_last4, p.failure_message, p.created_at, m.name as merchant
      from payments p join merchants m on m.id = p.merchant_id where p.invoice_id = ${id} and p.status <> 'canceled' order by p.created_at desc`;
  const emails = await sql<{ template_type: string; to_email: string; status: string; error: string | null; created_at: Date }[]>`
    select template_type, to_email, status, error, created_at from email_logs where invoice_id = ${id} order by created_at desc limit 20`;
  const activity = await sql<{ action: string; description: string | null; created_at: Date; name: string | null }[]>`
    select a.action, a.description, a.created_at, u.name from activity_logs a left join users u on u.id = a.user_id
     where a.entity_type = 'invoice' and a.entity_id = ${id} order by a.created_at desc limit 20`;
  const [creator] = inv.created_by ? await sql<{ name: string }[]>`select name from users where id = ${inv.created_by}` : [];

  const link = invoicePayUrl(inv, brand);
  const due = Math.max(0, inv.total_minor - inv.amount_paid_minor);
  const unpaid = ["open", "draft"].includes(inv.status);

  return (
    <>
      <PageHeader
        title={`Invoice ${inv.number}`}
        description={`${brand.name} · created ${dt(inv.created_at)}${creator ? ` by ${creator.name}` : ""}`}
        actions={<><StatusBadge status={inv.status} /><StatusBadge status={inv.review_status === "pending" ? "unreviewed" : inv.review_status} /></>}
      />
      {sp.updated && !sp.sent && <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Invoice updated.</p>}
      {sp.sent && <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Invoice {sp.updated ? "updated" : "created"} and emailed to {customer.email}.</p>}
      {sp.sendError && <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">Invoice created, but the email failed: {sp.sendError}. Check the brand&apos;s email settings, then resend.</p>}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Payment link">
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-slate-100 px-3 py-2 text-sm">{link}</code>
              <CopyButton text={link} />
              <a className="btn-secondary" href={link} target="_blank" rel="noopener noreferrer">Open</a>
            </div>
            <p className="mt-2 text-xs text-slate-500">Viewed {inv.view_count} time(s){inv.viewed_at ? `, first ${dt(inv.viewed_at)}` : ""}. {inv.token_expires_at ? `Expires ${dt(inv.token_expires_at)}.` : "No expiry."}</p>
            {unpaid && (
              <div className="mt-4 flex flex-wrap gap-2">
                <ActionForm action={sendInvoiceAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="type" value="invoice" /><SubmitButton className="btn-primary" pendingText="Sending…">{inv.sent_at ? "Resend invoice" : "Send invoice"}</SubmitButton></ActionForm>
                {inv.sent_at && <ActionForm action={sendInvoiceAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="type" value="reminder" /><SubmitButton className="btn-secondary" pendingText="Sending…">Send reminder</SubmitButton></ActionForm>}
                <ActionForm action={rotateLinkAction} confirm="Generate a new link? The current link will stop working."><input type="hidden" name="id" value={id} /><SubmitButton className="btn-secondary">New link</SubmitButton></ActionForm>
                {inv.amount_paid_minor === 0 && <Link href={`/admin/invoices/${id}/edit`} className="btn-secondary">Edit invoice</Link>}
              </div>
            )}
          </Card>

          <Card title="Items">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="pb-2">Description</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Unit</th><th className="pb-2 text-right">Amount</th></tr></thead>
              <tbody>{items.map((i, idx) => <tr key={idx} className="border-t border-slate-100"><td className="py-2">{i.description}</td><td className="py-2 text-right">{Number(i.quantity)}</td><td className="py-2 text-right">{formatMoney(i.unit_amount_minor, inv.currency)}</td><td className="py-2 text-right">{formatMoney(i.amount_minor, inv.currency)}</td></tr>)}</tbody>
            </table>
            <dl className="ml-auto mt-4 max-w-xs space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Subtotal</dt><dd>{formatMoney(inv.subtotal_minor, inv.currency)}</dd></div>
              {inv.discount_minor > 0 && <div className="flex justify-between"><dt className="text-slate-500">Discount</dt><dd>−{formatMoney(inv.discount_minor, inv.currency)}</dd></div>}
              {inv.tax_minor > 0 && <div className="flex justify-between"><dt className="text-slate-500">Tax</dt><dd>{formatMoney(inv.tax_minor, inv.currency)}</dd></div>}
              <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{formatMoney(inv.total_minor, inv.currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Paid</dt><dd>{formatMoney(inv.amount_paid_minor, inv.currency)}</dd></div>
              {inv.amount_refunded_minor > 0 && <div className="flex justify-between"><dt className="text-slate-500">Refunded</dt><dd>{formatMoney(inv.amount_refunded_minor, inv.currency)}</dd></div>}
              <div className="flex justify-between font-semibold"><dt>Due</dt><dd>{formatMoney(due, inv.currency)}</dd></div>
            </dl>
            {inv.memo && <p className="mt-4 whitespace-pre-line rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{inv.memo}</p>}
          </Card>

          <Card title="Payment attempts">
            {payments.length === 0 ? <p className="text-sm text-slate-500">No payment attempts yet.</p> : (
              <ul className="divide-y divide-slate-100 text-sm">
                {payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                    <Link href={`/admin/payments/${p.id}`} className="min-w-0 hover:underline">
                      <span className="font-medium capitalize">{p.provider}</span> <span className="text-slate-500">via {p.merchant}{p.card_last4 ? ` · ${p.card_brand} •••• ${p.card_last4}` : ""}</span>
                      <br /><span className="text-xs text-slate-400">{dt(p.created_at)}{p.failure_message ? ` · ${p.failure_message}` : ""}</span>
                    </Link>
                    <span className="flex items-center gap-2"><span className="tabular-nums">{formatMoney(p.amount_minor, inv.currency)}</span><StatusBadge status={p.status} /></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Timeline">
            <ul className="space-y-2 text-sm">
              {[...emails.map((e) => ({ at: e.created_at, text: `Email "${e.template_type}" to ${e.to_email}: ${e.status}${e.error ? ` (${e.error})` : ""}` })),
                ...activity.map((a) => ({ at: a.created_at, text: `${a.description ?? a.action}${a.name ? ` — ${a.name}` : ""}` }))]
                .sort((a, b) => b.at.getTime() - a.at.getTime())
                .map((e, i) => <li key={i} className="flex gap-3"><span className="w-40 shrink-0 text-xs text-slate-400">{dt(e.at)}</span><span>{e.text}</span></li>)}
            </ul>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Customer">
            <p className="font-medium">{customer.name}</p>
            <p className="text-sm text-slate-600">{customer.email}</p>
            {customer.phone && <p className="text-sm text-slate-600">{customer.phone}</p>}
            {customer.company && <p className="text-sm text-slate-600">{customer.company}</p>}
            <Link className="mt-3 inline-block text-sm text-indigo-600" href={`/admin/customers/${customer.id}`}>Customer profile →</Link>
          </Card>

          <Card title="Review">
            <ActionForm action={reviewInvoiceAction} className="space-y-3">
              <input type="hidden" name="id" value={id} />
              <select name="review_status" className="input" defaultValue={inv.review_status}>
                <option value="pending">Pending review</option><option value="approved">Approved</option><option value="flagged">Flagged</option>
              </select>
              <textarea name="note" className="input min-h-20" placeholder="Review note" defaultValue={inv.review_note ?? ""} maxLength={1000} />
              <SubmitButton className="btn-secondary w-full">Save review</SubmitButton>
            </ActionForm>
          </Card>

          {unpaid && inv.amount_paid_minor === 0 && (
            <Card title="Void invoice">
              <ActionForm action={voidInvoiceAction} confirm="Void this invoice? The customer will no longer be able to pay it." className="space-y-3">
                <input type="hidden" name="id" value={id} />
                <input name="reason" className="input" placeholder="Reason" required minLength={3} maxLength={500} />
                <SubmitButton className="btn-danger w-full">Void</SubmitButton>
              </ActionForm>
            </Card>
          )}
          {s.user.role === "admin" && (
            <DangerZone title="Delete invoice" id={id} action={deleteInvoiceAction} blockedReason={deleteBlocked}
              description="Permanently removes this invoice and its payment link. Only possible if no payment was ever attempted."
              confirm={`Delete invoice ${inv.number} permanently?`} label="Delete invoice" />
          )}
        </div>
      </div>
    </>
  );
}
