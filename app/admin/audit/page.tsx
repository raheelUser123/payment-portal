import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, dt, Empty, PageHeader, Pagination } from "@/components/ui";
import { verifyAuditChainAction } from "./actions";

export const metadata = { title: "Audit log" };
const PAGE = 50;

function RiskBadge({ score }: { score: number }) {
  const tone = score >= 70 ? "red" : score >= 40 ? "amber" : score > 0 ? "blue" : "gray";
  return <Badge tone={tone}>{score}</Badge>;
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ suspicious?: string; action?: string; actor?: string; entity?: string; page?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const suspicious = sp.suspicious === "1";
  const esc = (v: string) => v.replace(/[%_\\]/g, (c) => "\\" + c);
  const action = (sp.action ?? "").trim().slice(0, 80);
  const actor = (sp.actor ?? "").trim().slice(0, 120);
  const entity = (sp.entity ?? "").trim().slice(0, 120);

  const rows = await sql<{ id: number; actor_type: string; actor_id: string | null; actor_label: string | null; action: string; entity_type: string | null; entity_id: string | null;
    before_data: unknown; after_data: unknown; ip: string | null; user_agent: string | null; risk_score: number; is_suspicious: boolean; reasons: string[]; hash: string | null; created_at: Date }[]>`
    select id, actor_type, actor_id, actor_label, action, entity_type, entity_id, before_data, after_data, ip::text as ip, user_agent,
           risk_score, is_suspicious, reasons, hash, created_at
      from audit_logs
     where (${!suspicious} or is_suspicious)
       and (${action} = '' or action ilike ${`%${esc(action)}%`})
       and (${actor} = '' or actor_label ilike ${`%${esc(actor)}%`} or actor_id = ${actor})
       and (${entity} = '' or entity_id = ${entity} or entity_type = ${entity})
     order by id desc limit ${PAGE + 1} offset ${(page - 1) * PAGE}`;
  const params = new URLSearchParams();
  if (suspicious) params.set("suspicious", "1");
  if (action) params.set("action", action);
  if (actor) params.set("actor", actor);
  if (entity) params.set("entity", entity);

  return (
    <>
      <PageHeader title="Audit log" description="Append-only, hash-chained record of every security-relevant change. Rows cannot be edited or deleted, and tampering is detectable."
        actions={<ActionForm action={verifyAuditChainAction}><SubmitButton className="btn-secondary" pendingText="Verifying…">Verify integrity</SubmitButton></ActionForm>} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        <input className="input max-w-[200px]" name="action" defaultValue={action} placeholder="Action (e.g. auth.)" />
        <input className="input max-w-[200px]" name="actor" defaultValue={actor} placeholder="Actor email / id" />
        <input className="input max-w-[220px]" name="entity" defaultValue={entity} placeholder="Entity id or type" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="suspicious" value="1" defaultChecked={suspicious} /> Suspicious only</label>
        <button className="btn-secondary">Filter</button>
      </form>
      {rows.length === 0 ? <Empty>No audit entries.</Empty> : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Risk</th><th>Details</th></tr></thead>
            <tbody>{rows.slice(0, PAGE).map((r) => (
              <tr key={r.id} className={r.is_suspicious ? "bg-rose-50/60" : undefined}>
                <td className="text-xs text-slate-500">{r.id}</td>
                <td className="whitespace-nowrap">{dt(r.created_at)}</td>
                <td><span className="text-xs uppercase text-slate-500">{r.actor_type}</span><div className="max-w-[200px] truncate">{r.actor_label ?? r.actor_id ?? "—"}</div><div className="text-xs text-slate-500">{r.ip}</div></td>
                <td><code className="text-xs">{r.action}</code></td>
                <td className="text-xs">{r.entity_type}<div className="max-w-[160px] truncate text-slate-500">{r.entity_id}</div></td>
                <td><RiskBadge score={r.risk_score} />{r.is_suspicious && <div className="mt-1"><Badge tone="red">suspicious</Badge></div>}
                  {r.reasons.length > 0 && <div className="mt-1 text-xs text-slate-600">{r.reasons.join(", ")}</div>}</td>
                <td className="min-w-[200px]">
                  {(r.before_data != null || r.after_data != null || r.user_agent) ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-indigo-700">View</summary>
                      {r.before_data != null && <><p className="mt-2 text-xs font-semibold">Before</p><pre className="max-w-md overflow-auto rounded bg-slate-50 p-2 text-[11px]">{JSON.stringify(r.before_data, null, 2)}</pre></>}
                      {r.after_data != null && <><p className="mt-2 text-xs font-semibold">After</p><pre className="max-w-md overflow-auto rounded bg-slate-50 p-2 text-[11px]">{JSON.stringify(r.after_data, null, 2)}</pre></>}
                      {r.user_agent && <p className="mt-2 max-w-md break-all text-[11px] text-slate-500">{r.user_agent}</p>}
                      <p className="mt-2 break-all font-mono text-[10px] text-slate-400">hash {r.hash}</p>
                    </details>
                  ) : <span className="text-xs text-slate-400">—</span>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <Pagination page={page} hasMore={rows.length > PAGE} base={`/admin/audit?${params.toString()}`} />
    </>
  );
}
