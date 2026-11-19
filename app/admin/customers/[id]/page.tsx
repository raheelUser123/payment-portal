import Link from "next/link";
import { DangerZone } from "@/components/danger-zone";
import { deleteCustomerAction, customerDeleteBlocker } from "../../delete-actions";
import { notFound } from "next/navigation";
import { accessibleBrandIds, requireUser } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { formatMoney } from "@/lib/payments/money";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, dt, Empty, Field, PageHeader, StatusBadge } from "@/components/ui";
import type { CustomerRow } from "@/lib/types";
import { updateCustomerAction } from "../actions";

export const metadata = { title: "Customer" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [c] = await sql<(CustomerRow & { brand: string })[]>`select c.*, b.name as brand from customers c join brands b on b.id = c.brand_id where c.id = ${id}`;
  if (!c) notFound();
  const ids = await accessibleBrandIds(s);
  if (ids !== null && !ids.includes(c.brand_id)) notFound();
  const invoices = await sql<{ id: string; number: string; title: string | null; status: string; currency: string; total_minor: number; amount_paid_minor: number; amount_refunded_minor: number; created_at: Date }[]>`
    select id, number, title, status, currency, total_minor, amount_paid_minor, amount_refunded_minor, created_at from invoices where customer_id = ${id} order by created_at desc`;
  const totals = new Map<string, { billed: number; paid: number }>();
  for (const i of invoices) {
    const t = totals.get(i.currency) ?? { billed: 0, paid: 0 };
    if (i.status !== "void" && i.status !== "draft") t.billed += i.total_minor;
    t.paid += i.amount_paid_minor - i.amount_refunded_minor;
    totals.set(i.currency, t);
  }
  return (
    <>
      <PageHeader title={c.name} description={`${c.email} · ${c.brand} · customer since ${dt(c.created_at, false)}`}
        actions={<Link href={`/admin/invoices/new?customer=${c.id}`} className="btn-primary">New invoice</Link>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-1">
          <ActionForm action={updateCustomerAction} className="space-y-3">
            <input type="hidden" name="id" value={c.id} />
            <Field label="Name" name="name"><input className="input" id="name" name="name" defaultValue={c.name} required maxLength={200} /></Field>
            <Field label="Email" hint="Email is the customer's identity per brand."><input className="input" value={c.email} disabled /></Field>
            <Field label="Phone" name="phone"><input className="input" id="phone" name="phone" defaultValue={c.phone ?? ""} maxLength={40} /></Field>
            <Field label="Company" name="company"><input className="input" id="company" name="company" defaultValue={c.company ?? ""} maxLength={200} /></Field>
            <Field label="Address" name="address"><textarea className="input" id="address" name="address" rows={2} defaultValue={c.address ?? ""} maxLength={1000} /></Field>
            <Field label="Internal notes" name="notes"><textarea className="input" id="notes" name="notes" rows={3} defaultValue={c.notes ?? ""} maxLength={5000} /></Field>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </Card>
        <div className="space-y-6 lg:col-span-2">
          <Card title="Totals">
            {totals.size === 0 ? <p className="text-sm text-slate-500">No invoices yet.</p> : (
              <dl className="grid gap-4 sm:grid-cols-3">{[...totals.entries()].map(([cur, t]) => (
                <div key={cur} className="rounded-lg bg-slate-50 p-3"><dt className="text-xs text-slate-500">{cur}</dt>
                  <dd className="text-sm">Billed <b>{formatMoney(t.billed, cur)}</b></dd><dd className="text-sm">Net paid <b>{formatMoney(t.paid, cur)}</b></dd></div>
              ))}</dl>
            )}
          </Card>
          <Card title="Invoices">
            {invoices.length === 0 ? <Empty>No invoices.</Empty> : (
              <table className="table"><thead><tr><th>Number</th><th>Status</th><th>Total</th><th>Paid</th><th>Created</th></tr></thead>
                <tbody>{invoices.map((i) => (
                  <tr key={i.id}>
                    <td><Link href={`/admin/invoices/${i.id}`} className="font-medium text-indigo-700 hover:underline">{i.number}</Link>{i.title && <div className="text-xs text-slate-500">{i.title}</div>}</td>
                    <td><StatusBadge status={i.status} /></td><td>{formatMoney(i.total_minor, i.currency)}</td>
                    <td>{formatMoney(i.amount_paid_minor, i.currency)}</td><td className="whitespace-nowrap">{dt(i.created_at, false)}</td>
                  </tr>
                ))}</tbody></table>
            )}
          </Card>
          {s.user.role === "admin" && (
            <DangerZone title="Delete customer" id={c.id} action={deleteCustomerAction} blockedReason={await customerDeleteBlocker(c.id)}
              description="Permanently removes this customer record." confirm="Delete this customer permanently?" label="Delete customer" />
          )}
        </div>
      </div>
    </>
  );
}
