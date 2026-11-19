import "server-only";
import { sql } from "../db";
import { passwordProblems } from "./password";
import { revokeAllSessions, type SessionInfo } from "./session";
import { supabaseAdmin, supabaseStateless } from "../supabase/server";
import { audit } from "../logging/audit";
import { raiseAlert } from "../logging/alerts";
import { rateLimit } from "../security/rate-limit";
import type { RequestMeta } from "../security/request";
import { UserError } from "../actions";

/** Re-check a user's current password with Supabase Auth without touching their cookies. */
export async function verifyCurrentPassword(email: string, password: string): Promise<boolean> {
  const sb = supabaseStateless();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  await sb.auth.signOut({ scope: "local" }); // discard the throwaway session
  return true;
}

export async function changePassword(s: SessionInfo, current: string, next: string, meta: RequestMeta) {
  if (!(await rateLimit(`pwchange:${s.user.id}`, 900, 5))) throw new UserError("Too many attempts. Try again later.");
  if (!(await verifyCurrentPassword(s.user.email, current))) throw new UserError("Current password is incorrect.");
  const problems = passwordProblems(next, s.user.email);
  if (problems.length) throw new UserError(`New password needs: ${problems.join(", ")}`);
  if (next === current) throw new UserError("New password must differ from the current one.");
  const { error } = await supabaseAdmin().auth.admin.updateUserById(s.user.id, { password: next });
  if (error) throw new UserError(`Could not update password: ${error.message}`);
  await sql`update users set password_changed_at = now(), must_change_password = false where id = ${s.user.id}`;
  await revokeAllSessions(s.user.id, s.sessionId);
  await audit({ actor: { type: "user", id: s.user.id, label: s.user.email }, action: "auth.password_changed", entityType: "user", entityId: s.user.id, ip: meta.ip, userAgent: meta.userAgent });
  await raiseAlert({ severity: "info", type: "password_changed", title: `Password changed: ${s.user.email}`, userId: s.user.id });
}
