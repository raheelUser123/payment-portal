"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, assertBrandAccess } from "@/lib/auth/guard";
import { safeAction, UserError, type ActionResult } from "@/lib/actions";
import { sql } from "@/lib/db";
import { createInvoice, getInvoice, rotateInvoiceToken, sendInvoiceEmail, updateInvoice } from "@/lib/invoices/service";
import { toMinor, CURRENCIES } from "@/lib/payments/money";
import { audit } from "@/lib/logging/audit";
import { logActivity } from "@/lib/logging/activity";
import { requestMeta } from "@/lib/security/request";
import { emitEvent } from "@/lib/webhooks/outbound";

const ItemSchema = z.object({
  description: z.string().trim().min(1, "Item description required").max(500),
  quantity: z.coerce.number().positive().max(100000),
  unitAmount: z.string().trim().min(1, "Item price required"),
});

const CreateSchema = z.object({
  brandId: z.uuid("Choose a brand"),
  customerName: z.string().trim().min(1, "Customer name required").max(200),
  customerEmail: z.email("Valid customer email required").max(254),
  customerPhone: z.string().trim().max(40).optional(),
  customerCompany: z.string().trim().max(200).optional(),
  currency: z.enum(CURRENCIES),
  title: z.string().trim().max(200).optional(),
  memo: z.string().trim().max(5000).optional(),
  dueDate: z.union([z.iso.date(), z.literal("")]).optional(),
  discount: z.string().trim().optional(),
  tax: z.string().trim().optional(),
  expiresInDays: z.union([z.coerce.number().int().min(1).max(365), z.literal("")]).optional(),
  merchantId: z.union([z.uuid(), z.literal("")]).optional(),
  items: z.string().transform((s, ctx) => {
    try { return JSON.parse(s); } catch { ctx.addIssue({ code: "custom", message: "Invalid items" }); return z.NEVER; }
  }).pipe(z.array(ItemSchema).min(1, "Add at least one item").max(100)),
  send: z.string().optional(),
  inquiryId: z.union([z.uuid(), z.literal("")]).optional(),
});

const createInvoiceActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  const d = CreateSchema.parse(Object.fromEntries(fd));
  await assertBrandAccess(s, d.brandId);
  if (d.merchantId) {
    const [link] = await sql`select 1 from brand_merchants where brand_id = ${d.brandId} and merchant_id = ${d.merchantId} and is_active`;
    if (!link) throw new UserError("That merchant is not linked to this brand.");
  }
  const money = (v?: string) => (v ? toMinor(v, d.currency) : 0);
  let items;
  try {
    items = d.items.map((i) => ({ description: i.description, quantity: i.quantity, unitAmountMinor: toMinor(i.unitAmount, d.currency) }));
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  const meta = await requestMeta();
  const { invoice } = await createInvoice({
    brandId: d.brandId,
    customer: { name: d.customerName, email: d.customerEmail, phone: d.customerPhone || null, company: d.customerCompany || null },
    currency: d.currency,
    items,
    discountMinor: money(d.discount),
    taxMinor: money(d.tax),
    title: d.title || null,
    memo: d.memo || null,
    dueDate: d.dueDate || null,
    expiresInDays: d.expiresInDays ? Number(d.expiresInDays) : null,
    merchantId: d.merchantId || null,
    departmentId: s.user.department_id,
    createdBy: s.user.id,
    metadata: d.inquiryId ? { inquiry_id: d.inquiryId } : {},
  });
  if (d.inquiryId) await sql`update inquiries set status = 'converted' where id = ${d.inquiryId}`;
  await audit({ actor: { type: "user", id: s.user.id, label: s.user.email }, action: "invoice.create", entityType: "invoice", entityId: invoice.id,
    after: { number: invoice.number, total_minor: invoice.total_minor, currency: invoice.currency, brand_id: invoice.brand_id }, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: s.user.id, action: "invoice.create", entityType: "invoice", entityId: invoice.id, description: `Created invoice ${invoice.number}`, ip: meta.ip, userAgent: meta.userAgent });

  if (d.send === "on") {
    const r = await sendInvoiceEmail(invoice.id, "invoice", s.user.id);
    redirect(`/admin/invoices/${invoice.id}?${r.ok ? "sent=1" : "sendError=" + encodeURIComponent(r.error)}`);
  }
  redirect(`/admin/invoices/${invoice.id}`);
});

async function loadAccessible(id: string) {
  const s = await requireUser();
  const inv = await getInvoice(id);
  if (!inv) throw new UserError("Invoice not found");
  await assertBrandAccess(s, inv.brand_id);
  return { s, inv, meta: await requestMeta() };
}

const sendInvoiceActionImpl = safeAction(async (fd) => {
  const id = z.uuid().parse(fd.get("id"));
  const type = z.enum(["invoice", "reminder"]).parse(fd.get("type"));
  const { s, inv, meta } = await loadAccessible(id);
  const r = await sendInvoiceEmail(inv.id, type, s.user.id);
  await logActivity({ userId: s.user.id, action: `invoice.email_${type}`, entityType: "invoice", entityId: inv.id, description: `${type === "invoice" ? "Sent" : "Reminded"} ${inv.number}: ${r.ok ? "ok" : r.error}`, ip: meta.ip, userAgent: meta.userAgent });
  revalidatePath(`/admin/invoices/${id}`);
  return r.ok ? { ok: true, message: type === "invoice" ? "Invoice emailed to the customer." : "Reminder sent." } : { ok: false, message: `Email failed: ${r.error}` };
});

const voidInvoiceActionImpl = safeAction(async (fd) => {
  const id = z.uuid().parse(fd.get("id"));
  const reason = z.string().trim().min(3, "Give a reason").max(500).parse(fd.get("reason"));
  const { s, inv, meta } = await loadAccessible(id);
  if (!["open", "draft"].includes(inv.status) || inv.amount_paid_minor > 0) throw new UserError("Only unpaid open/draft invoices can be voided.");
  await sql`update invoices set status = 'void', voided_at = now(), review_note = ${reason} where id = ${id}`;
  await sql`update payments set status = 'canceled' where invoice_id = ${id} and status = 'pending'`;
  await audit({ actor: { type: "user", id: s.user.id, label: s.user.email }, action: "invoice.void", entityType: "invoice", entityId: id, before: { status: inv.status }, after: { status: "void", reason }, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: s.user.id, action: "invoice.void", entityType: "invoice", entityId: id, description: `Voided ${inv.number}: ${reason}`, ip: meta.ip, userAgent: meta.userAgent });
  await emitEvent(inv.brand_id, "invoice.voided", { invoice_id: id, number: inv.number });
  revalidatePath(`/admin/invoices/${id}`);
  return { ok: true, message: "Invoice voided." };
});

const rotateLinkActionImpl = safeAction(async (fd) => {
  const id = z.uuid().parse(fd.get("id"));
  const { s, inv, meta } = await loadAccessible(id);
  await rotateInvoiceToken(id);
  await audit({ actor: { type: "user", id: s.user.id, label: s.user.email }, action: "invoice.link_rotated", entityType: "invoice", entityId: id, ip: meta.ip, userAgent: meta.userAgent, riskScore: 10 });
  await logActivity({ userId: s.user.id, action: "invoice.link_rotated", entityType: "invoice", entityId: id, description: `New payment link for ${inv.number}; old link disabled`, ip: meta.ip, userAgent: meta.userAgent });
  revalidatePath(`/admin/invoices/${id}`);
  return { ok: true, message: "New link generated — the old link no longer works." };
});

const reviewInvoiceActionImpl = safeAction(async (fd) => {
  const id = z.uuid().parse(fd.get("id"));
  const status = z.enum(["approved", "flagged", "pending"]).parse(fd.get("review_status"));
  const note = z.string().trim().max(1000).parse(fd.get("note") ?? "");
  const { s, inv, meta } = await loadAccessible(id);
  await sql`update invoices set review_status = ${status}, review_note = ${note || null}, reviewed_by = ${s.user.id}, reviewed_at = now() where id = ${id}`;
  await audit({ actor: { type: "user", id: s.user.id, label: s.user.email }, action: "invoice.review", entityType: "invoice", entityId: id, before: { review_status: inv.review_status }, after: { review_status: status, note }, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: s.user.id, action: "invoice.review", entityType: "invoice", entityId: id, description: `Marked ${inv.number} as ${status}`, ip: meta.ip, userAgent: meta.userAgent });
  revalidatePath(`/admin/invoices/${id}`);
  return { ok: true, message: "Review saved." };
});

export async function createInvoiceAction(prev: ActionResult | null, fd: FormData) {
  return createInvoiceActionImpl(prev, fd);
}

export async function sendInvoiceAction(prev: ActionResult | null, fd: FormData) {
  return sendInvoiceActionImpl(prev, fd);
}

export async function voidInvoiceAction(prev: ActionResult | null, fd: FormData) {
  return voidInvoiceActionImpl(prev, fd);
}

export async function rotateLinkAction(prev: ActionResult | null, fd: FormData) {
  return rotateLinkActionImpl(prev, fd);
}

export async function reviewInvoiceAction(prev: ActionResult | null, fd: FormData) {
  return reviewInvoiceActionImpl(prev, fd);
}

const updateInvoiceActionImpl = safeAction(async (fd) => {
  const invoiceId = z.uuid().parse(fd.get("invoiceId"));
  const { s, inv: before, meta } = await loadAccessible(invoiceId);
  const d = CreateSchema.parse(Object.fromEntries(fd));
  if (d.brandId !== before.brand_id) throw new UserError("The brand of an existing invoice can't be changed.");
  if (d.merchantId) {
    const [link] = await sql`select 1 from brand_merchants where brand_id = ${d.brandId} and merchant_id = ${d.merchantId} and is_active`;
    if (!link) throw new UserError("That merchant is not linked to this brand.");
  }
  const money = (v?: string) => (v ? toMinor(v, d.currency) : 0);
  let items;
  try {
    items = d.items.map((i) => ({ description: i.description, quantity: i.quantity, unitAmountMinor: toMinor(i.unitAmount, d.currency) }));
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  let inv;
  try {
    inv = await updateInvoice(invoiceId, {
      customer: { name: d.customerName, email: d.customerEmail, phone: d.customerPhone || null, company: d.customerCompany || null },
      currency: d.currency, items, discountMinor: money(d.discount), taxMinor: money(d.tax),
      title: d.title || null, memo: d.memo || null, dueDate: d.dueDate || null,
      expiresInDays: d.expiresInDays ? Number(d.expiresInDays) : null, merchantId: d.merchantId || null,
    });
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  await audit({ actor: { type: "user", id: s.user.id, label: s.user.email }, action: "invoice.update", entityType: "invoice", entityId: invoiceId,
    before: { total_minor: before.total_minor, currency: before.currency, customer_id: before.customer_id, due_date: before.due_date },
    after: { total_minor: inv.total_minor, currency: inv.currency, customer_id: inv.customer_id, due_date: inv.due_date },
    ip: meta.ip, userAgent: meta.userAgent, riskScore: inv.total_minor !== before.total_minor ? 20 : 0, reasons: inv.total_minor !== before.total_minor ? ["amount_changed"] : [] });
  await logActivity({ userId: s.user.id, action: "invoice.update", entityType: "invoice", entityId: invoiceId, description: `Edited invoice ${inv.number}`, ip: meta.ip, userAgent: meta.userAgent });
  revalidatePath(`/admin/invoices/${invoiceId}`);
  if (d.send === "on") {
    const r = await sendInvoiceEmail(invoiceId, "invoice", s.user.id);
    redirect(`/admin/invoices/${invoiceId}?${r.ok ? "updated=1&sent=1" : "sendError=" + encodeURIComponent(r.error)}`);
  }
  redirect(`/admin/invoices/${invoiceId}?updated=1`);
});

export async function updateInvoiceAction(prev: ActionResult | null, fd: FormData) {
  return updateInvoiceActionImpl(prev, fd);
}
