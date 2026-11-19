import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { totpEnabledSql } from "@/lib/auth/session";
import { Badge, dt, Empty, LinkButton, PageHeader, TableWrap } from "@/components/ui";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  await requireAdmin();
  const users = await sql<{ id: string; name: string; email: string; role: string; department: string | null; totp_enabled: boolean; is_active: boolean; locked_until: Date | null; last_login_at: Date | null }[]>`
    select u.id, u.name, u.email, u.role, d.name as department, ${totpEnabledSql("u.id")} as totp_enabled, u.is_active, u.locked_until, u.last_login_at
      from users u left join departments d on d.id = u.department_id
     order by u.is_active desc, u.role, u.name`;
  return (
    <>
      <PageHeader title="Users" description="Admins manage everything; sellers see only their department's and assigned brands." actions={<LinkButton href="/admin/users/new">New user</LinkButton>} />
      {users.length === 0 ? <Empty>No users.</Empty> : (
        <TableWrap>
          <thead><tr><th>Name</th><th>Role</th><th>Department</th><th>2FA</th><th>Status</th><th>Last login</th></tr></thead>
          <tbody>
            {users.map((u) => {
              const locked = u.locked_until && u.locked_until > new Date();
              return (
                <tr key={u.id}>
                  <td><Link href={`/admin/users/${u.id}`} className="font-medium text-indigo-700 hover:underline">{u.name}</Link><div className="text-xs text-slate-500">{u.email}</div></td>
                  <td><Badge tone={u.role === "admin" ? "blue" : "gray"}>{u.role}</Badge></td>
                  <td>{u.department ?? "—"}</td>
                  <td>{u.totp_enabled ? <Badge tone="green">on</Badge> : <Badge tone="amber">off</Badge>}</td>
                  <td className="space-x-1">{u.is_active ? <Badge tone="green">active</Badge> : <Badge tone="red">inactive</Badge>}{locked && <Badge tone="red">locked</Badge>}</td>
                  <td className="text-slate-600">{dt(u.last_login_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </>
  );
}
