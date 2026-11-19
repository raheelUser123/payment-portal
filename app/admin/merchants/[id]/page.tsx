import Link from "next/link";
import { DangerZone } from "@/components/danger-zone";
import { deleteMerchantAction, merchantDeleteBlocker } from "../../delete-actions";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Card, Badge, StatusBadge, dt, Empty } from "@/components/ui";
import type { MerchantRow } from "@/lib/types";
import { MerchantForm } from "../merchant-form";
import { updateMerchant, verifyMerchant } from "../actions";

export const metadata = { title: "Merchant" };

const EVENTS = {
  stripe: ["payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.processing", "payment_intent.canceled", "charge.refunded", "refund.updated", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"],
  paypal: ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED"],
} as const;

export default async function MerchantPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [m] = await sql<MerchantRow[]>`select * from merchants where id = ${id}`;
  if (!m) notFound();
  if (m.provider !== "stripe" && m.provider !== "paypal") notFound();
  const deleteBlocked = await merchantDeleteBlocker(id);
  const brands = await sql<{ id: string; name: string; priority: number; is_active: boolean }[]>`
    select b.id, b.name, bm.priority, bm.is_active from brand_merchants bm join brands b on b.id = bm.brand_id where bm.merchant_id = ${id} order by b.name`;
  const events = await sql<{ type: string; received_at: Date; processed_at: Date | null; error: string | null }[]>`
    select type, received_at, processed_at, error from webhook_events where merchant_id = ${id} order by received_at desc limit 10`;
  let appUrl = "";
  try { appUrl = env.appUrl; } catch { appUrl = "https://YOUR-ADMIN-HOST"; }
  const webhookUrl = `${appUrl}/api/webhooks/${m.provider}/${m.id}`;

  return (
    <>
      <PageHeader title={m.name} description={`${m.provider} · ${m.mode} mode`}
        actions={<>
          <ActionForm action={verifyMerchant}><input type="hidden" name="id" value={id} /><SubmitButton className="btn-secondary" pendingText="Checking…">Verify connection</SubmitButton></ActionForm>
          <Link href="/admin/merchants" className="btn-secondary">All merchants</Link>
        </>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2"><Card title="Settings"><MerchantForm action={updateMerchant} provider={m.provider} merchant={m} /></Card></div>
        <div className="space-y-6">
          <Card title="Status">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Status</dt><dd><StatusBadge status={m.status} /></dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Mode</dt><dd><StatusBadge status={m.mode} /></dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Secret</dt><dd className="font-mono">••••{m.credential_hint}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Last verified</dt><dd>{m.last_verified_at ? dt(m.last_verified_at) : <Badge tone="amber">never</Badge>}</dd></div>
            </dl>
          </Card>
          <Card title="Webhook setup">
            <p className="mb-2 text-xs text-slate-500">Add this endpoint in your {m.provider === "stripe" ? "Stripe Dashboard → Developers → Webhooks" : "PayPal Developer Dashboard → your app → Webhooks"}, then paste the {m.provider === "stripe" ? "signing secret (whsec_…)" : "webhook ID"} into the form.</p>
            <code className="block select-all break-all rounded-lg bg-slate-900 p-3 text-xs text-emerald-300">{webhookUrl}</code>
            <p className="mb-1 mt-3 text-xs font-semibold text-slate-600">Events to subscribe</p>
            <ul className="space-y-0.5 font-mono text-xs text-slate-700">{EVENTS[m.provider].map((e) => <li key={e}>{e}</li>)}</ul>
            <p className="mt-3 text-xs text-slate-500">Every webhook is verified with its signature; invalid ones are rejected, logged and raise an alert.</p>
          </Card>
          <Card title="Linked brands">
            {brands.length === 0 ? <Empty>Not linked to any brand. Link it from a brand&apos;s page.</Empty> : (
              <ul className="space-y-1 text-sm">{brands.map((b) => (
                <li key={b.id} className="flex justify-between"><Link href={`/admin/brands/${b.id}`} className="text-indigo-700 hover:underline">{b.name}</Link><span className="text-xs text-slate-500">priority {b.priority}{!b.is_active && " · inactive"}</span></li>
              ))}</ul>
            )}
          </Card>
          <Card title="Recent webhook events">
            {events.length === 0 ? <Empty>No events received yet.</Empty> : (
              <ul className="space-y-1.5 text-xs">{events.map((e, i) => (
                <li key={i} className="flex items-center justify-between gap-2"><span className="font-mono">{e.type}</span>
                  <span>{e.error ? <Badge tone="red">error</Badge> : e.processed_at ? <Badge tone="green">ok</Badge> : <Badge tone="amber">pending</Badge>} <span className="text-slate-400">{dt(e.received_at)}</span></span></li>
              ))}</ul>
            )}
          </Card>
          <DangerZone title="Delete merchant" id={id} action={deleteMerchantAction} blockedReason={deleteBlocked}
            description="Permanently removes this merchant and its encrypted API keys, and unlinks it from all brands."
            confirm={`Delete merchant "${m.name}" and its stored keys? This cannot be undone.`} label="Delete merchant" />
        </div>
      </div>
    </>
  );
}
