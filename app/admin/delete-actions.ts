"use server";

/**
 * Delete actions for every admin section, in one place so the safety rules are
 * consistent: financial records (invoices with payment attempts, payments,
 * refunds, audit logs) are never deleted — those are voided/disabled instead.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { sql } from "@/lib/db";
import { requireUser, assertAdmin } from "@/lib/auth/guard";
import { safeAction, UserError, type ActionResult } from "@/lib/actions";
import { supabaseAdmin } from "@/lib/supabase/server";
import { revokeAllSessions } from "@/lib/auth/session";
import { audit } from "@/lib/logging/audit";
import { logActivity } from "@/lib/logging/activity";
import { raiseAlert } from "@/lib/logging/alerts";
import { requestMeta } from "@/lib/security/request";

async function adminCtx(fd: FormData) {
  const s = await requireUser();
  assertAdmin(s);
  const id = z.uuid().parse(fd.get("id"));
  return { s, id, meta: await requestMeta(), actor: { type: "user" as const, id: s.user.id, label: s.user.email } };
}

async function record(ctx: Awaited<ReturnType<typeof adminCtx>>, entity: string, before: unknown, label: string, risk = 20) {
  await audit({ actor: ctx.actor, action: `${entity}.delete`, entityType: entity, entityId: ctx.id, before, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, riskScore: risk, reasons: ["record_deleted"] });
  await logActivity({ userId: ctx.s.user.id, action: `${entity}.delete`, entityType: entity, entityId: ctx.id, description: `Deleted ${entity} ${label}`, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent });
}

// ---------- Brand ----------
export async function brandDeleteBlocker(id: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from invoices where brand_id = ${id}`;
  return n > 0 ? `This brand has ${n} invoice(s), which are kept for your records. Untick "Active" in General to hide it and stop new payments instead.` : null;
}
const _brand = safeAction(async (fd) => {
  const ctx = await adminCtx(fd);
  const [b] = await sql<{ name: string; slug: string }[]>`select name, slug from brands where id = ${ctx.id}`;
  if (!b) throw new UserError("Brand not found.");
  const blocked = await brandDeleteBlocker(ctx.id);
  if (blocked) throw new UserError(blocked);
  await sql.begin(async (tx) => {
    await tx`delete from customers where brand_id = ${ctx.id}`;
    await tx`delete from brands where id = ${ctx.id}`; // cascades merchant links, departments, templates, API keys, webhooks
  });
  await record(ctx, "brand", b, b.name, 40);
  await raiseAlert({ severity: "warning", type: "brand_deleted", title: `Brand deleted: ${b.name}`, message: `By ${ctx.s.user.email}`, userId: ctx.s.user.id });
  revalidatePath("/admin/brands");
  redirect("/admin/brands");
});
export async function deleteBrandAction(p: ActionResult | null, fd: FormData) { return _brand(p, fd); }

// ---------- Merchant ----------
export async function merchantDeleteBlocker(id: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from payments where merchant_id = ${id}`;
  return n > 0 ? `This merchant has ${n} payment record(s), which must be kept. Set its status to "disabled" instead.` : null;
}
const _merchant = safeAction(async (fd) => {
  const ctx = await adminCtx(fd);
  const [m] = await sql<{ name: string; provider: string; mode: string }[]>`select name, provider, mode from merchants where id = ${ctx.id}`;
  if (!m) throw new UserError("Merchant not found.");
  const blocked = await merchantDeleteBlocker(ctx.id);
  if (blocked) throw new UserError(blocked);
  await sql`delete from merchants where id = ${ctx.id}`; // encrypted credentials are deleted with it
  await record(ctx, "merchant", m, m.name, 50);
  await raiseAlert({ severity: "warning", type: "merchant_deleted", title: `Merchant deleted: ${m.name} (${m.provider} ${m.mode})`, message: `By ${ctx.s.user.email}`, userId: ctx.s.user.id });
  revalidatePath("/admin/merchants");
  redirect("/admin/merchants");
});
export async function deleteMerchantAction(p: ActionResult | null, fd: FormData) { return _merchant(p, fd); }

// ---------- Invoice ----------
export async function invoiceDeleteBlocker(id: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from payments where invoice_id = ${id}`;
  return n > 0 ? "A payment was already attempted on this invoice, so it's kept for your records. Void it instead." : null;
}
const _invoice = safeAction(async (fd) => {
  const ctx = await adminCtx(fd);
  const [inv] = await sql<{ number: string; status: string; total_minor: number; currency: string }[]>`select number, status, total_minor, currency from invoices where id = ${ctx.id}`;
  if (!inv) throw new UserError("Invoice not found.");
  const blocked = await invoiceDeleteBlocker(ctx.id);
  if (blocked) throw new UserError(blocked);
  await sql`delete from invoices where id = ${ctx.id}`; // items cascade; email log keeps a copy with invoice unlinked
  await record(ctx, "invoice", inv, inv.number, 30);
  revalidatePath("/admin/invoices");
  redirect("/admin/invoices");
});
export async function deleteInvoiceAction(p: ActionResult | null, fd: FormData) { return _invoice(p, fd); }

// ---------- Customer ----------
export async function customerDeleteBlocker(id: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from invoices where customer_id = ${id}`;
  return n > 0 ? `This customer has ${n} invoice(s). Delete or keep those first.` : null;
}
const _customer = safeAction(async (fd) => {
  const ctx = await adminCtx(fd);
  const [c] = await sql<{ name: string; email: string }[]>`select name, email from customers where id = ${ctx.id}`;
  if (!c) throw new UserError("Customer not found.");
  const blocked = await customerDeleteBlocker(ctx.id);
  if (blocked) throw new UserError(blocked);
  await sql`delete from customers where id = ${ctx.id}`;
  await record(ctx, "customer", c, c.email);
  revalidatePath("/admin/customers");
  redirect("/admin/customers");
});
export async function deleteCustomerAction(p: ActionResult | null, fd: FormData) { return _customer(p, fd); }

// ---------- User ----------
export async function userDeleteBlocker(id: string, currentUserId: string) {
  if (id === currentUserId) return "You can't delete your own account.";
  const [u] = await sql<{ role: string; is_active: boolean }[]>`select role, is_active from users where id = ${id}`;
  if (u?.role === "admin") {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users where role = 'admin' and is_active and id <> ${id}`;
    if (n === 0) return "This is the last active admin. Promote another admin first.";
  }
  return null;
}
const _user = safeAction(async (fd) => {
  const ctx = await adminCtx(fd);
  const [u] = await sql<{ email: string; name: string; role: string }[]>`select email, name, role from users where id = ${ctx.id}`;
  if (!u) throw new UserError("User not found.");
  const blocked = await userDeleteBlocker(ctx.id, ctx.s.user.id);
  if (blocked) throw new UserError(blocked);
  await revokeAllSessions(ctx.id);
  // Deleting the Supabase Auth user cascades to the app profile; their invoices/logs stay (author set to empty).
  const { error } = await supabaseAdmin().auth.admin.deleteUser(ctx.id);
  if (error) throw new UserError(`Could not delete the login: ${error.message}`);
  await sql`delete from users where id = ${ctx.id}`;
  await record(ctx, "user", u, u.email, u.role === "admin" ? 60 : 30);
  await raiseAlert({ severity: "warning", type: "user_deleted", title: `User deleted: ${u.email} (${u.role})`, message: `By ${ctx.s.user.email}`, userId: ctx.s.user.id });
  revalidatePath("/admin/users");
  redirect("/admin/users");
});
export async function deleteUserAction(p: ActionResult | null, fd: FormData) { return _user(p, fd); }

// ---------- Inquiry ----------
const _inquiry = safeAction(async (fd) => {
  const ctx = await adminCtx(fd);
  const [q] = await sql<{ name: string | null; email: string | null }[]>`select name, email from inquiries where id = ${ctx.id}`;
  if (!q) throw new UserError("Inquiry not found.");
  await sql`delete from inquiries where id = ${ctx.id}`;
  await record(ctx, "inquiry", q, q.email ?? q.name ?? ctx.id, 10);
  revalidatePath("/admin/inquiries");
  return { ok: true, message: "Inquiry deleted." };
});
export async function deleteInquiryAction(p: ActionResult | null, fd: FormData) { return _inquiry(p, fd); }
