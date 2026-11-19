import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { OUTBOUND_EVENTS } from "@/lib/webhooks/outbound";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, dt, Empty, PageHeader, StatusBadge } from "@/components/ui";
import { createEndpointAction, deleteEndpointAction, retryDeliveryAction, rotateSecretAction, sendTestEventAction, updateEndpointAction } from "./actions";
import { CreateEndpointForm, RotateSecretForm } from "./secret-forms";

export const metadata = { title: "Webhooks" };

export default async function WebhooksPage() {
  await requireAdmin();
  const [endpoints, brands, deliveries, incoming] = await Promise.all([
    sql<{ id: string; url: string; brand: string | null; events: string[]; is_active: boolean; created_at: Date }[]>`
      select e.id, e.url, b.name as brand, e.events, e.is_active, e.created_at from webhook_endpoints e left join brands b on b.id = e.brand_id order by e.created_at desc`,
    sql<{ id: string; name: string }[]>`select id, name from brands order by name`,
    sql<{ id: string; url: string; event_type: string; status: string; attempts: number; response_code: number | null; last_error: string | null; created_at: Date; next_retry_at: Date | null }[]>`
      select d.id, e.url, d.event_type, d.status, d.attempts, d.response_code, d.last_error, d.created_at, d.next_retry_at
        from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id order by d.created_at desc limit 50`,
    sql<{ id: string; provider: string; type: string; signature_valid: boolean; processed_at: Date | null; error: string | null; received_at: Date; merchant: string | null }[]>`
      select w.id, w.provider, w.type, w.signature_valid, w.processed_at, w.error, w.received_at, m.name as merchant
        from webhook_events w left join merchants m on m.id = w.merchant_id order by w.received_at desc limit 50`,
  ]);

  return (
    <>
      <PageHeader title="Webhooks" description="Signed outbound notifications to your brand sites/CRMs, plus the log of incoming gateway webhooks." />
      <div className="space-y-6">
        <Card title="Add outbound endpoint">
          <CreateEndpointForm action={createEndpointAction as never} brands={brands} events={OUTBOUND_EVENTS} />
        </Card>

        <Card title="Endpoints">
          {endpoints.length === 0 ? <Empty>No outbound endpoints.</Empty> : (
            <div className="space-y-4">
              {endpoints.map((e) => (
                <div key={e.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0"><p className="break-all font-medium">{e.url}</p><p className="text-xs text-slate-500">{e.brand ?? "All brands"} · added {dt(e.created_at, false)}</p></div>
                    {e.is_active ? <Badge tone="green">active</Badge> : <Badge tone="gray">disabled</Badge>}
                  </div>
                  <ActionForm action={updateEndpointAction} className="space-y-3">
                    <input type="hidden" name="id" value={e.id} />
                    <div className="grid gap-2 sm:grid-cols-3">{OUTBOUND_EVENTS.map((ev) => (
                      <label key={ev} className="flex items-center gap-2 text-xs"><input type="checkbox" name="events" value={ev} defaultChecked={e.events.includes(ev)} /> <code>{ev}</code></label>
                    ))}</div>
                    <p className="text-xs text-slate-500">No events checked = receives all events.</p>
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_active" defaultChecked={e.is_active} /> Active</label>
                    <SubmitButton className="btn-secondary">Save</SubmitButton>
                  </ActionForm>
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                    <ActionForm action={sendTestEventAction}><input type="hidden" name="id" value={e.id} /><SubmitButton className="btn-secondary">Send test event</SubmitButton></ActionForm>
                    <RotateSecretForm action={rotateSecretAction as never} id={e.id} />
                    <ActionForm action={deleteEndpointAction} confirm="Delete this endpoint and its delivery history?"><input type="hidden" name="id" value={e.id} /><SubmitButton className="btn-ghost text-rose-600">Delete</SubmitButton></ActionForm>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Recent outbound deliveries">
          {deliveries.length === 0 ? <Empty>No deliveries yet.</Empty> : (
            <div className="overflow-x-auto"><table className="table">
              <thead><tr><th>When</th><th>Event</th><th>Endpoint</th><th>Status</th><th>Attempts</th><th>Response</th><th /></tr></thead>
              <tbody>{deliveries.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap">{dt(d.created_at)}</td><td><code className="text-xs">{d.event_type}</code></td>
                  <td className="max-w-xs truncate text-xs">{d.url}</td><td><StatusBadge status={d.status} /></td><td>{d.attempts}</td>
                  <td className="text-xs">{d.response_code ?? "—"}{d.last_error && <div className="text-rose-600">{d.last_error}</div>}{d.status === "pending" && d.next_retry_at && <div className="text-slate-500">next {dt(d.next_retry_at)}</div>}</td>
                  <td>{d.status !== "delivered" && <ActionForm action={retryDeliveryAction}><input type="hidden" name="id" value={d.id} /><SubmitButton className="btn-ghost">Retry</SubmitButton></ActionForm>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>

        <Card title="Incoming gateway webhooks">
          {incoming.length === 0 ? <Empty>No gateway events received yet.</Empty> : (
            <div className="overflow-x-auto"><table className="table">
              <thead><tr><th>Received</th><th>Provider</th><th>Merchant</th><th>Type</th><th>Signature</th><th>Processed</th></tr></thead>
              <tbody>{incoming.map((w) => (
                <tr key={w.id}>
                  <td className="whitespace-nowrap">{dt(w.received_at)}</td><td>{w.provider}</td><td>{w.merchant ?? "—"}</td><td><code className="text-xs">{w.type}</code></td>
                  <td>{w.signature_valid ? <Badge tone="green">valid</Badge> : <Badge tone="red">invalid</Badge>}</td>
                  <td>{w.processed_at ? dt(w.processed_at) : w.error ? <span className="text-xs text-rose-600">{w.error}</span> : <Badge tone="amber">pending</Badge>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
