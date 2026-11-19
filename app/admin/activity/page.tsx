import { requireUser } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { dt, Empty, PageHeader, Pagination, TableWrap } from "@/components/ui";

export const metadata = { title: "Activity" };
const PAGE = 50;

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ user?: string; action?: string; from?: string; to?: string; page?: string }> }) {
  const s = await requireUser();
  const sp = await searchParams;
  const admin = s.user.role === "admin";
  const page = Math.max(1, Number(sp.page) || 1);
  const user = admin ? (/^[0-9a-f-]{36}$/i.test(sp.user ?? "") ? sp.user! : null) : s.user.id;
  const action = (sp.action ?? "").trim().slice(0, 80);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.from ?? "") ? sp.from! : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.to ?? "") ? sp.to! : null;
  const like = `%${action.replace(/[%_\\]/g, (c) => "\\" + c)}%`;

  const [users, rows] = await Promise.all([
    admin ? sql<{ id: string; name: string }[]>`select id, name from users order by name` : Promise.resolve([]),
    sql<{ id: number; user_name: string | null; action: string; entity_type: string | null; entity_id: string | null; description: string | null; ip: string | null; created_at: Date }[]>`
      select a.id, u.name as user_name, a.action, a.entity_type, a.entity_id, a.description, a.ip::text as ip, a.created_at
        from activity_logs a left join users u on u.id = a.user_id
       where (${user}::uuid is null or a.user_id = ${user}::uuid)
         and (${action} = '' or a.action ilike ${like})
         and (${from}::date is null or a.created_at >= ${from}::date)
         and (${to}::date is null or a.created_at < ${to}::date + 1)
       order by a.created_at desc limit ${PAGE + 1} offset ${(page - 1) * PAGE}`,
  ]);
  const params = new URLSearchParams();
  if (admin && user) params.set("user", user);
  if (action) params.set("action", action);
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  return (
    <>
      <PageHeader title="Activity" description={admin ? "Who did what across the portal (including system and customer events)." : "Your recent activity."} />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
        {admin && (
          <select className="input max-w-xs" name="user" defaultValue={user ?? ""}><option value="">All users &amp; system</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        )}
        <input className="input max-w-xs" name="action" defaultValue={action} placeholder="Action contains (e.g. payment)" />
        <input className="input w-40" type="date" name="from" defaultValue={from ?? ""} aria-label="From" />
        <input className="input w-40" type="date" name="to" defaultValue={to ?? ""} aria-label="To" />
        <button className="btn-secondary">Filter</button>
      </form>
      {rows.length === 0 ? <Empty>No activity.</Empty> : (
        <TableWrap>
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th><th>IP</th></tr></thead>
          <tbody>{rows.slice(0, PAGE).map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap">{dt(r.created_at)}</td>
              <td>{r.user_name ?? <span className="text-slate-500">system / customer</span>}</td>
              <td><code className="text-xs">{r.action}</code></td>
              <td className="text-slate-700">{r.description}{r.entity_type && <div className="text-xs text-slate-500">{r.entity_type} {r.entity_id}</div>}</td>
              <td className="text-xs text-slate-500">{r.ip ?? "—"}</td>
            </tr>
          ))}</tbody>
        </TableWrap>
      )}
      <Pagination page={page} hasMore={rows.length > PAGE} base={`/admin/activity?${params.toString()}`} />
    </>
  );
}
