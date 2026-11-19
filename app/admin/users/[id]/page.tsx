import { notFound } from "next/navigation";
import { DangerZone } from "@/components/danger-zone";
import { deleteUserAction, userDeleteBlocker } from "../../delete-actions";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { listSessions, totpEnabledSql } from "@/lib/auth/session";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, dt, Field, PageHeader, StatusBadge } from "@/components/ui";
import {
  forcePasswordResetAction, resetTwoFactorAction, revokeAllUserSessionsAction, revokeUserSessionAction, unlockUserAction, updateUserAction,
} from "../actions";

export const metadata = { title: "Edit user" };

type U = { id: string; name: string; email: string; role: string; department_id: string | null; is_active: boolean; totp_enabled: boolean;
  locked_until: Date | null; failed_login_count: number; last_login_at: Date | null; last_login_ip: string | null;
  must_change_password: boolean; created_at: Date; password_changed_at: Date };

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [u] = await sql<U[]>`
    select u.id, name, email, role, department_id, is_active, ${totpEnabledSql("u.id")} as totp_enabled,
           locked_until, failed_login_count, last_login_at, last_login_ip::text as last_login_ip, must_change_password, created_at, password_changed_at
      from users u where u.id = ${id}`;
  if (!u) notFound();
  const [departments, brands, userBrands, sessions, attempts] = await Promise.all([
    sql<{ id: string; name: string }[]>`select id, name from departments order by name`,
    sql<{ id: string; name: string }[]>`select id, name from brands order by name`,
    sql<{ brand_id: string }[]>`select brand_id from user_brands where user_id = ${id}`,
    listSessions(id).then((rows) => rows.map((r) => ({ ...r, last_seen_at: r.refreshed_at ?? r.updated_at ?? r.created_at, mfa_verified: r.aal === "aal2" }))),
    sql<{ ip: string | null; user_agent: string | null; success: boolean; stage: string; reason: string | null; created_at: Date }[]>`
      select ip::text as ip, user_agent, success, stage, reason, created_at from login_attempts where user_id = ${id} order by created_at desc limit 20`,
  ]);
  const assigned = new Set(userBrands.map((b) => b.brand_id));
  const locked = u.locked_until && u.locked_until > new Date();
  const self = u.id === s.user.id;

  return (
    <>
      <PageHeader title={u.name} description={`${u.email} · created ${dt(u.created_at, false)}`} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Profile & access">
            <ActionForm action={updateUserAction} className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="id" value={u.id} />
              <Field label="Full name" name="name"><input className="input" id="name" name="name" defaultValue={u.name} required maxLength={120} /></Field>
              <Field label="Email"><input className="input" value={u.email} disabled /></Field>
              <Field label="Role" name="role">
                <select className="input" id="role" name="role" defaultValue={u.role} disabled={self}><option value="seller">Seller</option><option value="admin">Admin</option></select>
                {self && <input type="hidden" name="role" value={u.role} />}
              </Field>
              <Field label="Department" name="department_id">
                <select className="input" id="department_id" name="department_id" defaultValue={u.department_id ?? ""}><option value="">— None —</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
              </Field>
              <fieldset className="sm:col-span-2">
                <legend className="label">Direct brand access</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {brands.map((b) => <label key={b.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="brands" value={b.id} defaultChecked={assigned.has(b.id)} /> {b.name}</label>)}
                  {brands.length === 0 && <p className="text-sm text-slate-500">No brands yet.</p>}
                </div>
              </fieldset>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" name="is_active" defaultChecked={u.is_active} disabled={self} /> Active (deactivating signs the user out everywhere)
              </label>
              {self && <input type="hidden" name="is_active" value="on" />}
              <div className="sm:col-span-2"><SubmitButton>Save changes</SubmitButton></div>
            </ActionForm>
          </Card>

          <Card title={`Active sessions (${sessions.length})`} actions={sessions.length > 0 ? (
            <ActionForm action={revokeAllUserSessionsAction} confirm="Sign this user out of all sessions?"><input type="hidden" name="id" value={u.id} /><SubmitButton className="btn-secondary">Revoke all</SubmitButton></ActionForm>
          ) : undefined}>
            {sessions.length === 0 ? <p className="text-sm text-slate-500">No active sessions.</p> : (
              <ul className="divide-y divide-slate-100">
                {sessions.map((x) => (
                  <li key={x.id} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                    <div className="min-w-0"><p className="font-medium">{x.ip ?? "unknown IP"} {!x.mfa_verified && <Badge tone="amber">2FA pending</Badge>}</p>
                      <p className="truncate text-xs text-slate-500">{x.user_agent ?? ""}</p><p className="text-xs text-slate-500">Last seen {dt(x.last_seen_at)}</p></div>
                    <ActionForm action={revokeUserSessionAction}><input type="hidden" name="id" value={u.id} /><input type="hidden" name="session_id" value={x.id} /><SubmitButton className="btn-ghost">Revoke</SubmitButton></ActionForm>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Recent sign-in attempts">
            {attempts.length === 0 ? <p className="text-sm text-slate-500">None.</p> : (
              <table className="table"><thead><tr><th>When</th><th>Result</th><th>Stage</th><th>IP</th><th>Device</th></tr></thead>
                <tbody>{attempts.map((a, i) => (
                  <tr key={i}><td className="whitespace-nowrap">{dt(a.created_at)}</td><td>{a.success ? <Badge tone="green">success</Badge> : <Badge tone="red">{a.reason ?? "failed"}</Badge>}</td>
                    <td>{a.stage}</td><td>{a.ip ?? "—"}</td><td className="max-w-xs truncate text-xs text-slate-500">{a.user_agent}</td></tr>
                ))}</tbody></table>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Security status">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Status</dt><dd>{u.is_active ? <StatusBadge status="active" /> : <StatusBadge status="disabled" />}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">2FA</dt><dd>{u.totp_enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="amber">not set up</Badge>}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Locked</dt><dd>{locked ? <Badge tone="red">until {dt(u.locked_until)}</Badge> : "No"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Failed attempts</dt><dd>{u.failed_login_count}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Last login</dt><dd>{dt(u.last_login_at)}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Last IP</dt><dd>{u.last_login_ip ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Password changed</dt><dd>{dt(u.password_changed_at, false)}</dd></div>
              {u.must_change_password && <p><Badge tone="amber">must change password</Badge></p>}
            </dl>
          </Card>
          {locked && (
            <Card title="Unlock account">
              <ActionForm action={unlockUserAction}><input type="hidden" name="id" value={u.id} /><SubmitButton className="btn-secondary">Unlock now</SubmitButton></ActionForm>
            </Card>
          )}
          <Card title="Reset 2FA">
            <p className="mb-3 text-sm text-slate-600">Use when the user lost their device. They must re-enroll at next sign-in. This is logged as a high-risk action.</p>
            <ActionForm action={resetTwoFactorAction} confirm={`Reset 2FA for ${u.email}? All their sessions will be revoked.`}>
              <input type="hidden" name="id" value={u.id} /><SubmitButton className="btn-danger">Reset 2FA</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Force password reset">
            <ActionForm action={forcePasswordResetAction} resetOnSuccess className="space-y-3" confirm="Set a new temporary password and sign the user out?">
              <input type="hidden" name="id" value={u.id} />
              <Field label="New temporary password" name="password"><input className="input" id="password" name="password" autoComplete="new-password" required minLength={12} maxLength={128} /></Field>
              <SubmitButton className="btn-secondary">Set temporary password</SubmitButton>
            </ActionForm>
          </Card>
          <DangerZone title="Delete user" id={u.id} action={deleteUserAction} blockedReason={await userDeleteBlocker(u.id, s.user.id)}
            description="Permanently removes this user and their Supabase login. Invoices and logs they created are kept."
            confirm={`Delete ${u.email} permanently? They will be signed out immediately.`} label="Delete user" />
        </div>
      </div>
    </>
  );
}
