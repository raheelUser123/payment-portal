import "server-only";
import { sql } from "../db";
import { getSession, is2faRequired } from "./session";
import { supabaseServer } from "../supabase/server";
import { getSetting } from "../settings";
import { rateLimit } from "../security/rate-limit";
import { assessLogin } from "../security/risk";
import { audit } from "../logging/audit";
import { logActivity } from "../logging/activity";
import { raiseAlert } from "../logging/alerts";
import type { RequestMeta } from "../security/request";
import type { UserRow } from "../types";

/**
 * Sign-in flow on Supabase Auth (passwords, sessions and TOTP 2FA live in Supabase).
 * The app adds: rate limits, account lockout, risk scoring, alerts and audit.
 */

const GENERIC_ERROR = "Invalid email or password.";

export type LoginResult =
  | { status: "ok" }
  | { status: "mfa" }
  | { status: "enroll" }
  | { status: "error"; message: string };

async function recordAttempt(email: string, userId: string | null, meta: RequestMeta, success: boolean, stage: string, reason?: string) {
  await sql`insert into login_attempts (email, user_id, ip, user_agent, success, stage, reason)
            values (${email}, ${userId}, ${meta.ip}, ${meta.userAgent}, ${success}, ${stage}, ${reason ?? null})`;
}

export async function passwordLogin(emailRaw: string, password: string, meta: RequestMeta): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase().slice(0, 254);
  if (!email || !password) return { status: "error", message: GENERIC_ERROR };

  const ipOk = await rateLimit(`login:ip:${meta.ip ?? "unknown"}`, 900, 30);
  const emailOk = await rateLimit(`login:email:${email}`, 900, 10);
  if (!ipOk || !emailOk) {
    await recordAttempt(email, null, meta, false, "password", "rate_limited");
    if (!ipOk) {
      await raiseAlert({ severity: "warning", type: "login_rate_limited", title: "Login rate limit hit",
        message: `IP ${meta.ip ?? "unknown"} exceeded login attempts`, metadata: { ip: meta.ip, email } });
    }
    return { status: "error", message: "Too many attempts. Please wait 15 minutes and try again." };
  }

  const sec = await getSetting("security");
  const [user] = await sql<UserRow[]>`select * from users where email = ${email}`;
  if (user?.locked_until && user.locked_until > new Date()) {
    await recordAttempt(email, user.id, meta, false, "password", "locked");
    return { status: "error", message: "Account temporarily locked due to failed attempts. Try again later." };
  }

  const sb = await supabaseServer();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.user || !user || user.id !== data.user.id || !user.is_active) {
    if (data?.user) await sb.auth.signOut({ scope: "local" });
    if (user) {
      const fails = user.failed_login_count + 1;
      const lock = fails >= sec.max_failed_logins;
      await sql`update users set failed_login_count = ${lock ? 0 : fails},
                       locked_until = ${lock ? new Date(Date.now() + sec.lockout_minutes * 60_000) : user.locked_until}
                 where id = ${user.id}`;
      if (lock) {
        await audit({ actor: { type: "public", label: email }, action: "auth.account_locked", entityType: "user", entityId: user.id,
          ip: meta.ip, userAgent: meta.userAgent, riskScore: 70, reasons: ["too_many_failed_logins"] });
        await raiseAlert({ severity: "warning", type: "account_locked", title: `Account locked: ${email}`,
          message: `${sec.max_failed_logins} failed logins. Last IP ${meta.ip ?? "unknown"}.`, entityType: "user", entityId: user.id });
      }
    }
    await recordAttempt(email, user?.id ?? null, meta, false, "password", !user ? "unknown_user" : user.is_active ? "bad_password" : "inactive");
    return { status: "error", message: GENERIC_ERROR };
  }

  await sql`update users set failed_login_count = 0, locked_until = null where id = ${user.id}`;
  const risk = await assessLogin(user.id, email, meta.ip, meta.userAgent);
  await recordAttempt(email, user.id, meta, true, "password");
  await audit({ actor: { type: "user", id: user.id, label: email }, action: "auth.password_ok", entityType: "user", entityId: user.id,
    ip: meta.ip, userAgent: meta.userAgent, riskScore: risk.score, reasons: risk.reasons });
  if (risk.score >= 50) {
    await raiseAlert({ severity: "critical", type: "suspicious_login", title: `Suspicious login: ${email}`,
      message: `Risk ${risk.score}: ${risk.reasons.join(", ")} from IP ${meta.ip ?? "unknown"}`, entityType: "user", entityId: user.id, userId: user.id });
  } else if (risk.reasons.includes("new_ip") || risk.reasons.includes("new_device")) {
    await raiseAlert({ severity: "info", type: "new_login_location", title: `New device/IP login: ${email}`,
      message: `IP ${meta.ip ?? "unknown"}`, userId: user.id, entityType: "user", entityId: user.id });
  }

  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") return { status: "mfa" };
  if (await is2faRequired(user.role)) return { status: "enroll" };
  await finalizeLogin(user.id, meta);
  return { status: "ok" };
}

async function finalizeLogin(userId: string, meta: RequestMeta) {
  await sql`update users set last_login_at = now(), last_login_ip = ${meta.ip} where id = ${userId}`;
  await logActivity({ userId, action: "auth.login", description: "Signed in", ip: meta.ip, userAgent: meta.userAgent });
}

/** Verify a TOTP code against the user's Supabase MFA factors (upgrades the session to aal2). */
export async function verifySecondFactor(code: string, meta: RequestMeta): Promise<LoginResult> {
  const s = await getSession();
  if (!s) return { status: "error", message: "Session expired. Please sign in again." };
  if (s.aal === "aal2") return { status: "ok" };
  if (!(await rateLimit(`mfa:${s.user.id}`, 900, 8))) {
    await raiseAlert({ severity: "warning", type: "mfa_rate_limited", title: `2FA brute force suspected: ${s.user.email}`,
      message: `IP ${meta.ip ?? "unknown"}`, userId: s.user.id, entityType: "user", entityId: s.user.id });
    return { status: "error", message: "Too many attempts. Please wait 15 minutes." };
  }
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return { status: "error", message: "Enter the 6-digit code from your authenticator app." };

  const sb = await supabaseServer();
  const { data: factors } = await sb.auth.mfa.listFactors();
  const totp = factors?.totp ?? [];
  if (totp.length === 0) return { status: "enroll" };

  let ok = false;
  for (const f of totp) {
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: normalized });
    if (!error) { ok = true; break; }
  }
  await sql`insert into login_attempts (email, user_id, ip, user_agent, success, stage, reason)
            values (${s.user.email}, ${s.user.id}, ${meta.ip}, ${meta.userAgent}, ${ok}, 'mfa', ${ok ? null : "bad_code"})`;
  if (!ok) return { status: "error", message: "Invalid authentication code." };

  await finalizeLogin(s.user.id, meta);
  await audit({ actor: { type: "user", id: s.user.id, label: s.user.email }, action: "auth.mfa_ok", entityType: "user", entityId: s.user.id, ip: meta.ip, userAgent: meta.userAgent });
  return { status: "ok" };
}

/**
 * Start enrolling a TOTP device with Supabase MFA. Returns the QR code (SVG) and secret.
 * A password-only session can never replace an existing 2FA device: adding a
 * device when one already exists requires an aal2 session (enforced by Supabase too).
 */
export async function beginTotpEnrollment() {
  const s = await getSession();
  if (!s) throw new Error("Not signed in");
  if (s.user.totp_enabled && s.aal !== "aal2") throw new Error("2FA verification required");
  const sb = await supabaseServer();
  // clean up abandoned, never-verified enrolments
  const { data: list } = await sb.auth.mfa.listFactors();
  for (const f of list?.all ?? []) {
    if (f.factor_type === "totp" && f.status !== "verified") await sb.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await sb.auth.mfa.enroll({
    factorType: "totp",
    issuer: process.env.TOTP_ISSUER || "Payment Portal",
    friendlyName: `Authenticator ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  });
  if (error || !data) throw new Error(error?.message ?? "Could not start 2FA setup");
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

/** Confirm a new TOTP device with a code from the app. */
export async function confirmTotpEnrollment(factorId: string, code: string, meta: RequestMeta): Promise<{ ok: true } | { ok: false; message: string }> {
  const s = await getSession();
  if (!s) return { ok: false, message: "Session expired." };
  if (!(await rateLimit(`mfa-enroll:${s.user.id}`, 900, 10))) return { ok: false, message: "Too many attempts." };
  const sb = await supabaseServer();
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s+/g, "") });
  if (error) return { ok: false, message: "That code didn't match. Check your device time and try again." };
  if (s.aal !== "aal2") await finalizeLogin(s.user.id, meta);
  await audit({ actor: { type: "user", id: s.user.id, label: s.user.email }, action: "auth.mfa_device_added", entityType: "user", entityId: s.user.id, ip: meta.ip, userAgent: meta.userAgent });
  if (s.user.totp_enabled) {
    await raiseAlert({ severity: "info", type: "mfa_device_added", title: `New 2FA device added: ${s.user.email}`, userId: s.user.id, entityType: "user", entityId: s.user.id });
  }
  return { ok: true };
}
