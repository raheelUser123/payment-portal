import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, dt, Empty, PageHeader, Pagination, StatusBadge } from "@/components/ui";
import { ackAlertAction, ackAllAlertsAction } from "./actions";

export const metadata = { title: "Alerts" };
const PAGE = 50;

const ENTITY_LINKS: Record<string, string> = { payment: "/admin/payments/", invoice: "/admin/invoices/", user: "/admin/users/", merchant: "/admin/merchants/", inquiry: "/admin/inquiries" };

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ severity?: string; type?: string; state?: string; page?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const severity = ["info", "warning", "critical"].includes(sp.severity ?? "") ? sp.severity! : null;
  const type = /^[a-z0-9_]{1,60}$/.test(sp.type ?? "") ? sp.type! : null;
  const state = sp.state === "open" ? "open" : sp.state === "acknowledged" ? "acknowledged" : "all";
  const [types, rows] = await Promise.all([
    sql<{ type: string }[]>`select distinct type from alerts order by type`,
    sql<{ id: string; severity: string; type: string; title: string; message: string | null; entity_type: string | null; entity_id: string | null;
      acknowledged_at: Date | null; ack_by: string | null; created_at: Date }[]>`
      select a.id, a.severity, a.type, a.title, a.message, a.entity_type, a.entity_id, a.acknowledged_at, u.name as ack_by, a.created_at
        from alerts a left join users u on u.id = a.acknowledged_by
       where (${severity}::text is null or a.severity = ${severity}::alert_severity)
         and (${type}::text is null or a.type = ${type})
         and (${state} = 'all' or (${state} = 'open' and a.acknowledged_at is null) or (${state} = 'acknowledged' and a.acknowledged_at is not null))
       order by (a.acknowledged_at is null) desc, a.created_at desc
       limit ${PAGE + 1} offset ${(page - 1) * PAGE}`,
  ]);
  const params = new URLSearchParams();
  if (severity) params.set("severity", severity);
  if (type) params.set("type", type);
  if (state !== "all") params.set("state", state);

  return (
    <>
      <PageHeader title="Alerts" description="Security and payment alerts. Warning/critical alerts are also emailed to admins and posted to Slack/Discord when configured in Settings."
        actions={
          <ActionForm action={ackAllAlertsAction} confirm="Acknowledge all open alerts matching the severity filter?">
            <input type="hidden" name="severity" value={severity ?? ""} />
            <SubmitButton className="btn-secondary">Acknowledge all{severity ? ` ${severity}` : ""}</SubmitButton>
          </ActionForm>
        } />
      <form method="get" className="mb-4 flex flex-wrap gap-2">
        <select name="severity" className="input max-w-[160px]" defaultValue={severity ?? ""}><option value="">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select>
        <select name="type" className="input max-w-[220px]" defaultValue={type ?? ""}><option value="">All types</option>{types.map((t) => <option key={t.type} value={t.type}>{t.type}</option>)}</select>
        <select name="state" className="input max-w-[160px]" defaultValue={state}><option value="all">Open &amp; acknowledged</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option></select>
        <button className="btn-secondary">Filter</button>
      </form>
      {rows.length === 0 ? <Empty>No alerts. 🎉</Empty> : (
        <ul className="space-y-2">
          {rows.slice(0, PAGE).map((a) => {
            const link = a.entity_type && ENTITY_LINKS[a.entity_type] ? `${ENTITY_LINKS[a.entity_type]}${a.entity_type === "inquiry" ? "" : a.entity_id ?? ""}` : null;
            return (
              <li key={a.id} className={`card flex flex-wrap items-start justify-between gap-3 p-4 ${a.acknowledged_at ? "opacity-60" : ""}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><StatusBadge status={a.severity} /><Badge>{a.type}</Badge><span className="text-xs text-slate-500">{dt(a.created_at)}</span></div>
                  <p className="mt-1 font-medium">{a.title}</p>
                  {a.message && <p className="text-sm text-slate-600">{a.message}</p>}
                  {link && <Link href={link} className="text-xs text-indigo-700 hover:underline">View {a.entity_type}</Link>}
                  {a.acknowledged_at && <p className="mt-1 text-xs text-slate-500">Acknowledged by {a.ack_by ?? "—"} {dt(a.acknowledged_at)}</p>}
                </div>
                {!a.acknowledged_at && (
                  <ActionForm action={ackAlertAction}><input type="hidden" name="id" value={a.id} /><SubmitButton className="btn-secondary">Acknowledge</SubmitButton></ActionForm>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Pagination page={page} hasMore={rows.length > PAGE} base={`/admin/alerts?${params.toString()}`} />
    </>
  );
}
