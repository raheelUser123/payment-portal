"use server";

import { redirect } from "next/navigation";
import { passwordLogin, verifySecondFactor, confirmTotpEnrollment } from "@/lib/auth/login";
import { requestMeta } from "@/lib/security/request";
import type { ActionResult } from "@/lib/actions";

export async function loginAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await passwordLogin(String(fd.get("email") ?? ""), String(fd.get("password") ?? ""), await requestMeta());
  if (r.status === "ok") redirect("/admin");
  if (r.status === "mfa") redirect("/login/2fa");
  if (r.status === "enroll") redirect("/setup-2fa");
  return { ok: false, message: r.message };
}

export async function mfaAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await verifySecondFactor(String(fd.get("code") ?? ""), await requestMeta());
  if (r.status === "ok") redirect("/admin");
  if (r.status === "enroll") redirect("/setup-2fa");
  return { ok: false, message: r.status === "error" ? r.message : "Try again." };
}

export async function enrollAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const factorId = String(fd.get("factorId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(factorId)) return { ok: false, message: "Start setup again." };
  const r = await confirmTotpEnrollment(factorId, String(fd.get("code") ?? ""), await requestMeta());
  if (!r.ok) return { ok: false, message: r.message };
  redirect(String(fd.get("next") ?? "") === "account" ? "/admin/account?mfa=added" : "/admin");
}
