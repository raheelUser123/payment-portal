import { requireUser } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { listSessions } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, dt, Field, PageHeader } from "@/components/ui";
import {
  changePasswordAction, removeMfaDeviceAction, revokeMySessionAction, revokeOtherSessionsAction, updateProfileAction,
} from "./actions";

export const metadata = { title: "My account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ mfa?: string }> }) {
  const s = await requireUser();
  const { mfa } = await searchParams;
  const sb = await supabaseServer();
  const { data: factorData } = await sb.auth.mfa.listFactors();
  const devices = factorData?.totp ?? [];
  const [sessions, attempts] = await Promise.all([
    listSessions(s.user.id).then((rows) => rows.map((r) => ({ ...r, last_seen_at: r.refreshed_at ?? r.updated_at ?? r.created_at }))),
    sql<{ ip: string | null; user_agent: string | null; success: boolean; stage: string; reason: string | null; created_at: Date }[]>`
      select ip::text as ip, user_agent, success, stage, reason, created_at from login_attempts
       where user_id = ${s.user.id} order by created_at desc limit 15`,
  ]);

  return (
    <>
      <PageHeader title="My account" description={`${s.user.email} · ${s.user.role}`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Profile">
          <ActionForm action={updateProfileAction} className="space-y-4">
            <Field label="Full name" name="name"><input className="input" id="name" name="name" defaultValue={s.user.name} required maxLength={120} /></Field>
            <Field label="Email" hint="Contact an admin to change your email."><input className="input" value={s.user.email} disabled /></Field>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
        </Card>

        <Card title="Change password">
          <p className="mb-3 text-xs text-slate-500">Last changed {dt(s.user.password_changed_at, false)}. Changing it signs out your other sessions.</p>
          <ActionForm action={changePasswordAction} resetOnSuccess className="space-y-3">
            <Field label="Current password" name="current"><input className="input" id="current" name="current" type="password" required autoComplete="current-password" /></Field>
            <Field label="New password" name="next"><input className="input" id="next" name="next" type="password" required minLength={12} autoComplete="new-password" /></Field>
            <Field label="Confirm new password" name="confirm"><input className="input" id="confirm" name="confirm" type="password" required minLength={12} autoComplete="new-password" /></Field>
            <SubmitButton>Update password</SubmitButton>
          </ActionForm>
        </Card>

        <Card title="Two-factor authentication">
          {mfa === "added" && <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">New 2FA device added.</p>}
          {devices.length > 0 ? (
            <div className="space-y-4">
              <p className="text-sm">Status: <Badge tone="green">enabled</Badge> · {devices.length} device{devices.length > 1 ? "s" : ""} (Supabase MFA)</p>
              <ul className="divide-y divide-slate-100 text-sm">
                {devices.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-3 py-2">
                    <span>{f.friendly_name || "Authenticator app"}<br /><span className="text-xs text-slate-500">added {dt(new Date(f.created_at))}</span></span>
                    <ActionForm action={removeMfaDeviceAction} confirm="Remove this 2FA device?"><input type="hidden" name="factor_id" value={f.id} /><SubmitButton className="btn-ghost">Remove</SubmitButton></ActionForm>
                  </li>
                ))}
              </ul>
              <a href="/setup-2fa?add=1" className="btn-secondary">Add another device</a>
              <p className="text-xs text-slate-500">Keep a second device (e.g. a password manager) as a backup. If you lose all devices, an admin can reset your 2FA.</p>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p>Status: <Badge tone="amber">not enabled</Badge></p>
              <a href="/setup-2fa" className="btn-primary">Set up 2FA</a>
            </div>
          )}
        </Card>

        <Card title={`Active sessions (${sessions.length})`} actions={
          <ActionForm action={revokeOtherSessionsAction} confirm="Sign out all other sessions?"><SubmitButton className="btn-secondary">Sign out others</SubmitButton></ActionForm>
        }>
          <ul className="divide-y divide-slate-100">
            {sessions.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{x.ip ?? "unknown IP"} {x.id === s.sessionId && <Badge tone="blue">this device</Badge>}</p>
                  <p className="truncate text-xs text-slate-500">{x.user_agent}</p>
                  <p className="text-xs text-slate-500">Signed in {dt(x.created_at)} · last seen {dt(x.last_seen_at)}</p>
                </div>
                {x.id !== s.sessionId && (
                  <ActionForm action={revokeMySessionAction}><input type="hidden" name="session_id" value={x.id} /><SubmitButton className="btn-ghost">Revoke</SubmitButton></ActionForm>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Recent sign-in activity" className="lg:col-span-2">
          <table className="table"><thead><tr><th>When</th><th>Result</th><th>Stage</th><th>IP</th><th>Device</th></tr></thead>
            <tbody>{attempts.map((a, i) => (
              <tr key={i}><td className="whitespace-nowrap">{dt(a.created_at)}</td><td>{a.success ? <Badge tone="green">success</Badge> : <Badge tone="red">{a.reason ?? "failed"}</Badge>}</td>
                <td>{a.stage}</td><td>{a.ip ?? "—"}</td><td className="max-w-xs truncate text-xs text-slate-500">{a.user_agent}</td></tr>
            ))}</tbody></table>
          <p className="mt-3 text-xs text-slate-500">Don&apos;t recognise an entry? Change your password, remove unknown 2FA devices, then tell an admin.</p>
        </Card>
      </div>
    </>
  );
}
