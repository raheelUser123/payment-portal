"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, assertAdmin, assertBrandAccess } from "@/lib/auth/guard";
import { safeAction, UserError, type ActionResult } from "@/lib/actions";
import { sql } from "@/lib/db";
import { refundPayment } from "@/lib/payments/service";
import { toMinor } from "@/lib/payments/money";
import { audit } from "@/lib/logging/audit";
import { logActivity } from "@/lib/logging/activity";
import { requestMeta } from "@/lib/security/request";
import { rateLimit } from "@/lib/security/rate-limit";
import type { PaymentRow } from "@/lib/types";

const reviewPaymentActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  const id = z.uuid().parse(fd.get("id"));
  const status = z.enum(["pending", "approved", "flagged"]).parse(fd.get("review_status"));
  const note = z.string().trim().max(1000).parse(fd.get("note") ?? "");
  const [p] = await sql<PaymentRow[]>`select * from payments where id = ${id}`;
  if (!p) throw new UserError("Payment not found");
  await assertBrandAccess(s, p.brand_id);
  const meta = await requestMeta();
  await sql`update payments set review_status = ${status}, review_note = ${note || null}, reviewed_by = ${s.user.id}, reviewed_at = now() where id = ${id}`;
  await audit({ actor: { type: "user", id: s.user.id, label: s.user.email }, action: "payment.review", entityType: "payment", entityId: id, before: { review_status: p.review_status }, after: { review_status: status, note }, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: s.user.id, action: "payment.review", entityType: "payment", entityId: id, description: `Payment marked ${status}`, ip: meta.ip, userAgent: meta.userAgent });
  revalidatePath(`/admin/payments/${id}`);
  return { ok: true, message: "Review saved." };
});

const refundActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const meta = await requestMeta();
  if (!(await rateLimit(`refund:${s.user.id}`, 3600, 20))) throw new UserError("Refund rate limit reached. Try again later.");
  const id = z.uuid().parse(fd.get("id"));
  const reason = z.string().trim().min(3, "Give a reason").max(500).parse(fd.get("reason"));
  const [p] = await sql<PaymentRow[]>`select * from payments where id = ${id}`;
  if (!p) throw new UserError("Payment not found");
  let amount: number;
  try { amount = toMinor(String(fd.get("amount") ?? ""), p.currency); } catch (e) { throw new UserError((e as Error).message); }
  try {
    await refundPayment(id, amount, reason, { id: s.user.id, email: s.user.email }, meta);
  } catch (e) {
    throw new UserError(`Refund failed: ${(e as Error).message}`);
  }
  await logActivity({ userId: s.user.id, action: "payment.refund", entityType: "payment", entityId: id, description: `Refunded ${fd.get("amount")} ${p.currency}: ${reason}`, ip: meta.ip, userAgent: meta.userAgent });
  revalidatePath(`/admin/payments/${id}`);
  return { ok: true, message: "Refund issued." };
});

export async function reviewPaymentAction(prev: ActionResult | null, fd: FormData) {
  return reviewPaymentActionImpl(prev, fd);
}

export async function refundAction(prev: ActionResult | null, fd: FormData) {
  return refundActionImpl(prev, fd);
}
