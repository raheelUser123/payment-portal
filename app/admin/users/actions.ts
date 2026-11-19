"use server";

import type { ActionResult } from "@/lib/actions";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { sql } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth/guard";
import { passwordProblems } from "@/lib/auth/password";
import { supabaseAdmin } from "@/lib/supabase/server";
import { revokeAllSessions, revokeSession } from "@/lib/auth/session";
import { raiseAlert } from "@/lib/logging/alerts";
import { formObject, safeAction, UserError } from "@/lib/actions";
import { track } from "./track";

const zUuidOrNull = z.string().trim().transform((v) => (v === "" ? null : v)).pipe(z.uuid().nullable());

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().trim().toLowerCase().max(254),
  role: z.enum(["admin", "seller"]),
  department_id: zUuidOrNull,
  brands: z.array(z.uuid()),
  password: z.string().min(1).max(128),
  must_change_password: z.string().optional(),
});

const createUserActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const d = CreateSchema.parse(formObject(fd, ["brands"]));
  const problems = passwordProblems(d.password, d.email);
  if (problems.length) throw new UserError(`Temporary password needs: ${problems.join(", ")}`);
  const [exists] = await sql`select 1 from users where email = ${d.email}`;
  if (exists) throw new UserError("A user with this email already exists.");
  const mustChange = d.must_change_password !== undefined ? d.must_change_password === "on" : true;
  // Login + password live in Supabase Auth; profile/role in public.users (same id).
  const admin = supabaseAdmin();
  const { data: authUser, error } = await admin.auth.admin.createUser({ email: d.email, password: d.password, email_confirm: true, user_metadata: { name: d.name } });
  if (error || !authUser.user) throw new UserError(`Could not create login: ${error?.message ?? "unknown error"}`);
  let id: string;
  try {
    id = await sql.begin(async (tx) => {
      const [u] = await tx<{ id: string }[]>`
        insert into users (id, email, name, role, department_id, must_change_password, created_by)
        values (${authUser.user.id}, ${d.email}, ${d.name}, ${d.role}, ${d.department_id}, ${mustChange}, ${s.user.id})
        returning id`;
      if (d.brands.length) await tx`insert into user_brands ${tx(d.brands.map((b) => ({ user_id: u.id, brand_id: b })))} on conflict do nothing`;
      return u.id;
    });
  } catch (e) {
    await admin.auth.admin.deleteUser(authUser.user.id);
    throw e;
  }
  const isAdmin = d.role === "admin";
  await track(s, "user.create", {
    entityType: "user", entityId: id, description: `Created ${d.role} ${d.email}`,
    after: { email: d.email, name: d.name, role: d.role, department_id: d.department_id, brands: d.brands },
    riskScore: isAdmin ? 50 : 10, reasons: isAdmin ? ["privilege_escalation"] : [],
  });
  if (isAdmin) await raiseAlert({ severity: "critical", type: "admin_created", title: `New admin created: ${d.email}`, message: `By ${s.user.email}`, entityType: "user", entityId: id, userId: s.user.id });
  revalidatePath("/admin/users");
  redirect(`/admin/users/${id}`);
});

async function activeAdminCountExcluding(userId: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users where role = 'admin' and is_active and id <> ${userId}`;
  return n;
}

const UpdateSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(["admin", "seller"]),
  department_id: zUuidOrNull,
  brands: z.array(z.uuid()),
  is_active: z.string().optional(),
});

const updateUserActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const d = UpdateSchema.parse(formObject(fd, ["brands"]));
  const isActive = d.is_active === "on";
  const [before] = await sql<{ name: string; role: string; department_id: string | null; is_active: boolean; email: string }[]>`
    select name, role, department_id, is_active, email from users where id = ${d.id}`;
  if (!before) throw new UserError("User not found.");
  const beforeBrands = (await sql<{ brand_id: string }[]>`select brand_id from user_brands where user_id = ${d.id}`).map((r) => r.brand_id);

  if (d.id === s.user.id && (d.role !== "admin" || !isActive)) throw new UserError("You can't demote or deactivate your own account.");
  if (before.role === "admin" && (d.role !== "admin" || !isActive) && (await activeAdminCountExcluding(d.id)) === 0) {
    throw new UserError("This is the last active admin. Promote another admin first.");
  }

  await sql.begin(async (tx) => {
    await tx`update users set name = ${d.name}, role = ${d.role}, department_id = ${d.department_id}, is_active = ${isActive} where id = ${d.id}`;
    await tx`delete from user_brands where user_id = ${d.id}`;
    if (d.brands.length) await tx`insert into user_brands ${tx(d.brands.map((b) => ({ user_id: d.id, brand_id: b })))}`;
  });
  if (before.is_active !== isActive) {
    // Block / unblock the login in Supabase Auth too.
    await supabaseAdmin().auth.admin.updateUserById(d.id, { ban_duration: isActive ? "none" : "876000h" });
    if (!isActive) await revokeAllSessions(d.id);
  }

  const escalation = before.role !== "admin" && d.role === "admin";
  await track(s, "user.update", {
    entityType: "user", entityId: d.id, description: `Updated user ${before.email}`,
    before: { ...before, brands: beforeBrands },
    after: { name: d.name, role: d.role, department_id: d.department_id, is_active: isActive, brands: d.brands },
    riskScore: escalation ? 50 : 10, reasons: escalation ? ["privilege_escalation"] : [],
  });
  if (escalation) {
    await raiseAlert({ severity: "critical", type: "privilege_escalation", title: `User promoted to admin: ${before.email}`, message: `By ${s.user.email}`, entityType: "user", entityId: d.id, userId: s.user.id });
  }
  if (before.is_active && !isActive) {
    await raiseAlert({ severity: "warning", type: "user_deactivated", title: `User deactivated: ${before.email}`, message: `By ${s.user.email}`, entityType: "user", entityId: d.id });
  }
  revalidatePath(`/admin/users/${d.id}`);
  revalidatePath("/admin/users");
  return { ok: true, message: "User updated." };
});

const IdSchema = z.object({ id: z.uuid() });

const resetTwoFactorActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const { id } = IdSchema.parse(formObject(fd));
  const [u] = await sql<{ email: string; totp_enabled?: boolean }[]>`select email from users where id = ${id}`;
  if (!u) throw new UserError("User not found.");
  const admin = supabaseAdmin();
  const { data: factors, error } = await admin.auth.admin.mfa.listFactors({ userId: id });
  if (error) throw new UserError(`Could not load 2FA devices: ${error.message}`);
  for (const f of factors?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: id });
  await revokeAllSessions(id, id === s.user.id ? s.sessionId : undefined);
  u.totp_enabled = (factors?.factors ?? []).some((f) => f.status === "verified");
  await track(s, "user.mfa_reset", { entityType: "user", entityId: id, description: `Reset 2FA for ${u.email}`, before: { totp_enabled: u.totp_enabled }, after: { totp_enabled: false }, riskScore: 75, reasons: ["mfa_reset_by_admin"] });
  await raiseAlert({ severity: "warning", type: "mfa_reset", title: `2FA reset for ${u.email}`, message: `By ${s.user.email}. User must re-enroll at next sign-in.`, entityType: "user", entityId: id, userId: s.user.id });
  revalidatePath(`/admin/users/${id}`);
  return { ok: true, message: "2FA reset. The user must set it up again at next sign-in." };
});

const forcePasswordResetActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const d = z.object({ id: z.uuid(), password: z.string().min(1).max(128) }).parse(formObject(fd));
  const [u] = await sql<{ email: string }[]>`select email from users where id = ${d.id}`;
  if (!u) throw new UserError("User not found.");
  const problems = passwordProblems(d.password, u.email);
  if (problems.length) throw new UserError(`Temporary password needs: ${problems.join(", ")}`);
  const { error } = await supabaseAdmin().auth.admin.updateUserById(d.id, { password: d.password });
  if (error) throw new UserError(`Could not set password: ${error.message}`);
  await sql`update users set must_change_password = true, password_changed_at = now(),
            failed_login_count = 0, locked_until = null where id = ${d.id}`;
  await revokeAllSessions(d.id, d.id === s.user.id ? s.sessionId : undefined);
  await track(s, "user.password_reset", { entityType: "user", entityId: d.id, description: `Forced password reset for ${u.email}`, riskScore: 40, reasons: ["password_reset_by_admin"] });
  await raiseAlert({ severity: "warning", type: "password_reset_by_admin", title: `Password reset for ${u.email}`, message: `By ${s.user.email}`, entityType: "user", entityId: d.id });
  revalidatePath(`/admin/users/${d.id}`);
  return { ok: true, message: "Temporary password set. Share it securely; the user must change it at next sign-in." };
});

const unlockUserActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const { id } = IdSchema.parse(formObject(fd));
  const [u] = await sql<{ email: string; locked_until: Date | null }[]>`select email, locked_until from users where id = ${id}`;
  if (!u) throw new UserError("User not found.");
  await sql`update users set failed_login_count = 0, locked_until = null where id = ${id}`;
  await track(s, "user.unlock", { entityType: "user", entityId: id, description: `Unlocked ${u.email}`, before: { locked_until: u.locked_until }, after: { locked_until: null } });
  revalidatePath(`/admin/users/${id}`);
  return { ok: true, message: "Account unlocked." };
});

const revokeUserSessionActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const d = z.object({ id: z.uuid(), session_id: z.uuid() }).parse(formObject(fd));
  await revokeSession(d.session_id, d.id);
  await track(s, "user.session_revoke", { entityType: "user", entityId: d.id, description: "Revoked a session", after: { session_id: d.session_id } });
  revalidatePath(`/admin/users/${d.id}`);
  return { ok: true, message: "Session revoked." };
});

const revokeAllUserSessionsActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const { id } = IdSchema.parse(formObject(fd));
  await revokeAllSessions(id, id === s.user.id ? s.sessionId : undefined);
  await track(s, "user.sessions_revoke_all", { entityType: "user", entityId: id, description: "Revoked all sessions" });
  revalidatePath(`/admin/users/${id}`);
  return { ok: true, message: "All sessions revoked." };
});

export async function createUserAction(prev: ActionResult | null, fd: FormData) {
  return createUserActionImpl(prev, fd);
}

export async function updateUserAction(prev: ActionResult | null, fd: FormData) {
  return updateUserActionImpl(prev, fd);
}

export async function resetTwoFactorAction(prev: ActionResult | null, fd: FormData) {
  return resetTwoFactorActionImpl(prev, fd);
}

export async function forcePasswordResetAction(prev: ActionResult | null, fd: FormData) {
  return forcePasswordResetActionImpl(prev, fd);
}

export async function unlockUserAction(prev: ActionResult | null, fd: FormData) {
  return unlockUserActionImpl(prev, fd);
}

export async function revokeUserSessionAction(prev: ActionResult | null, fd: FormData) {
  return revokeUserSessionActionImpl(prev, fd);
}

export async function revokeAllUserSessionsAction(prev: ActionResult | null, fd: FormData) {
  return revokeAllUserSessionsActionImpl(prev, fd);
}
