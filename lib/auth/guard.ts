import "server-only";
import { redirect } from "next/navigation";
import { sql } from "../db";
import { getSession, is2faRequired, type SessionInfo } from "./session";

export class ForbiddenError extends Error {
  constructor(msg = "You don't have permission to do that.") {
    super(msg);
  }
}

/**
 * Require a fully authenticated user (password + 2FA where required).
 * Redirects to the right step otherwise.
 */
export async function requireUser(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!s.mfaVerified) {
    if (s.user.totp_enabled) redirect("/login/2fa");
    if (await is2faRequired(s.user.role)) redirect("/setup-2fa");
  }
  if (s.user.must_change_password) redirect("/change-password");
  return s;
}

export async function requireAdmin(): Promise<SessionInfo> {
  const s = await requireUser();
  if (s.user.role !== "admin") redirect("/admin?denied=1");
  return s;
}

/** For server actions: throws instead of redirecting when not admin. */
export function assertAdmin(s: SessionInfo) {
  if (s.user.role !== "admin") throw new ForbiddenError();
}

/** Brand ids the user may access; null means "all" (admin). */
export async function accessibleBrandIds(s: SessionInfo): Promise<string[] | null> {
  if (s.user.role === "admin") return null;
  const rows = await sql<{ brand_id: string }[]>`
    select brand_id from user_brands where user_id = ${s.user.id}
    union
    select db.brand_id from department_brands db where db.department_id = ${s.user.department_id}`;
  return rows.map((r) => r.brand_id);
}

export async function assertBrandAccess(s: SessionInfo, brandId: string) {
  const ids = await accessibleBrandIds(s);
  if (ids !== null && !ids.includes(brandId)) throw new ForbiddenError("You don't have access to this brand.");
}
