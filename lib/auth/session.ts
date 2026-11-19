import "server-only";
import { cache } from "react";
import { sql } from "../db";
import { getSetting } from "../settings";
import { sessionIdFromJwt, supabaseServer } from "../supabase/server";
import type { SafeUser, UserRow } from "../types";

/**
 * Sessions and 2FA are handled by Supabase Auth:
 *  - session  = Supabase Auth session (httpOnly cookies, refreshed in middleware)
 *  - 2FA      = Supabase MFA TOTP factors; a session is "aal2" once a code was verified
 * This module maps that onto the app's user/role model (public.users).
 */

export type SessionInfo = {
  sessionId: string | null;
  /** true when the session satisfies the 2FA policy */
  mfaVerified: boolean;
  aal: "aal1" | "aal2";
  user: SafeUser;
};

/** Whether this user must have 2FA turned on. Admins always; sellers per setting. */
export async function is2faRequired(role: string): Promise<boolean> {
  if (role === "admin") return true;
  return (await getSetting("security")).enforce_2fa_for_sellers;
}

/** Current signed-in user, or null. Cached per request. */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const sb = await supabaseServer();
  // getUser() validates the token with Supabase Auth (revoked sessions fail here).
  const { data: userData, error } = await sb.auth.getUser();
  if (error || !userData.user) return null;

  const [row] = await sql<UserRow[]>`
    select id, email, name, role, department_id, is_active, failed_login_count, locked_until, password_changed_at,
           must_change_password, last_login_at, last_login_ip::text as last_login_ip, created_at
      from users where id = ${userData.user.id}`;
  if (!row || !row.is_active) return null;

  const { data: aalData } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  const { data: sessionData } = await sb.auth.getSession();
  const aal = aalData?.currentLevel === "aal2" ? "aal2" : "aal1";
  const totpEnabled = aalData?.nextLevel === "aal2";
  const required = await is2faRequired(row.role);

  return {
    sessionId: sessionIdFromJwt(sessionData.session?.access_token),
    aal,
    mfaVerified: aal === "aal2" || (!totpEnabled && !required),
    user: { ...row, totp_enabled: totpEnabled },
  };
});

/** Revoke one Supabase Auth session of a user. */
export async function revokeSession(sessionId: string, userId: string) {
  await sql`delete from auth.sessions where id = ${sessionId} and user_id = ${userId}`;
}

/** Revoke all Supabase Auth sessions of a user (optionally keeping one). */
export async function revokeAllSessions(userId: string, exceptSessionId?: string | null) {
  if (exceptSessionId) await sql`delete from auth.sessions where user_id = ${userId} and id <> ${exceptSessionId}`;
  else await sql`delete from auth.sessions where user_id = ${userId}`;
}

export type AuthSessionRow = { id: string; ip: string | null; user_agent: string | null; aal: string | null; created_at: Date; refreshed_at: Date | null; updated_at: Date | null };

export async function listSessions(userId: string) {
  return sql<AuthSessionRow[]>`
    select id, ip::text as ip, user_agent, aal::text as aal, created_at, refreshed_at, updated_at
      from auth.sessions where user_id = ${userId} and (not_after is null or not_after > now())
     order by coalesce(refreshed_at, updated_at, created_at) desc`;
}

/** SQL used in admin lists to show whether a user has 2FA set up. */
export function totpEnabledSql(userIdColumn = "u.id") {
  return sql`exists(select 1 from auth.mfa_factors f where f.user_id = ${sql(userIdColumn)} and f.factor_type = 'totp' and f.status = 'verified')`;
}
