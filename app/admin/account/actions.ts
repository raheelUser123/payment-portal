"use server";

import type { ActionResult } from "@/lib/actions";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "@/lib/db";
import { requireUser } from "@/lib/auth/guard";
import { changePassword } from "@/lib/auth/password-change";
import { revokeAllSessions, revokeSession, is2faRequired } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/security/rate-limit";
import { requestMeta } from "@/lib/security/request";
import { raiseAlert } from "@/lib/logging/alerts";
import { formObject, safeAction, UserError } from "@/lib/actions";
import { track } from "../users/track";

const updateProfileActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(formObject(fd));
  await sql`update users set name = ${name} where id = ${s.user.id}`;
  await track(s, "account.profile_update", { entityType: "user", entityId: s.user.id, description: "Updated profile", before: { name: s.user.name }, after: { name } });
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Profile updated." };
});

const changePasswordActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  const d = z.object({ current: z.string().min(1).max(128), next: z.string().min(1).max(128), confirm: z.string() }).parse(formObject(fd));
  if (d.next !== d.confirm) throw new UserError("Passwords don't match.");
  await changePassword(s, d.current, d.next, await requestMeta());
  await track(s, "account.password_change", { entityType: "user", entityId: s.user.id, description: "Changed password (other sessions signed out)" });
  revalidatePath("/admin/account");
  return { ok: true, message: "Password updated. Your other sessions were signed out." };
});

const removeMfaDeviceActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  if (!(await rateLimit(`acct-mfa:${s.user.id}`, 900, 8))) throw new UserError("Too many attempts. Try again later.");
  const { factor_id } = z.object({ factor_id: z.uuid() }).parse(formObject(fd));
  if (s.aal !== "aal2") throw new UserError("Verify with 2FA first.");
  const sb = await supabaseServer();
  const { data } = await sb.auth.mfa.listFactors();
  const verified = data?.totp ?? [];
  if (!verified.some((f) => f.id === factor_id)) throw new UserError("Device not found.");
  if (verified.length === 1 && (await is2faRequired(s.user.role))) throw new UserError("2FA is required for your role. Add another device before removing this one.");
  const { error } = await sb.auth.mfa.unenroll({ factorId: factor_id });
  if (error) throw new UserError(error.message);
  await track(s, "account.mfa_device_removed", { entityType: "user", entityId: s.user.id, description: "Removed a 2FA device", riskScore: 40, reasons: ["mfa_device_removed"] });
  await raiseAlert({ severity: "warning", type: "mfa_device_removed", title: `2FA device removed by ${s.user.email}`, userId: s.user.id, entityType: "user", entityId: s.user.id });
  revalidatePath("/admin/account");
  return { ok: true, message: "Device removed." };
});

const revokeMySessionActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  const { session_id } = z.object({ session_id: z.uuid() }).parse(formObject(fd));
  if (session_id === s.sessionId) throw new UserError("Use Sign out to end your current session.");
  await revokeSession(session_id, s.user.id);
  await track(s, "account.session_revoke", { entityType: "session", entityId: session_id, description: "Revoked one of own sessions" });
  revalidatePath("/admin/account");
  return { ok: true, message: "Session revoked." };
});

const revokeOtherSessionsActionImpl = safeAction(async () => {
  const s = await requireUser();
  await revokeAllSessions(s.user.id, s.sessionId);
  await track(s, "account.sessions_revoke_others", { entityType: "user", entityId: s.user.id, description: "Signed out all other sessions" });
  revalidatePath("/admin/account");
  return { ok: true, message: "All other sessions were signed out." };
});

export async function updateProfileAction(prev: ActionResult | null, fd: FormData) {
  return updateProfileActionImpl(prev, fd);
}

export async function changePasswordAction(prev: ActionResult | null, fd: FormData) {
  return changePasswordActionImpl(prev, fd);
}

export async function removeMfaDeviceAction(prev: ActionResult | null, fd: FormData) {
  return removeMfaDeviceActionImpl(prev, fd);
}

export async function revokeMySessionAction(prev: ActionResult | null, fd: FormData) {
  return revokeMySessionActionImpl(prev, fd);
}

export async function revokeOtherSessionsAction(prev: ActionResult | null, fd: FormData) {
  return revokeOtherSessionsActionImpl(prev, fd);
}
