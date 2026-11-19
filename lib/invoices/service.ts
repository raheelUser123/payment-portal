import "server-only";
import { sql } from "../db";
import { decrypt, encrypt } from "../crypto/aes";
import { hashToken, randomToken } from "../crypto/tokens";
import { formatMoney } from "../payments/money";
import { getBrand, payUrl } from "../brands/service";
import { sendTemplatedEmail, type TemplateType } from "../email/send";
import { emitEvent } from "../webhooks/outbound";
import type { BrandRow, CustomerRow, InvoiceRow } from "../types";

export const INVOICE_TOKEN_CONTEXT = "invoice.token";

export type InvoiceItemInput = { description: string; quantity: number; unitAmountMinor: number };

export type CreateInvoiceInput = {
  brandId: string;
  customer: { name: string; email: string; phone?: string | null; company?: string | null; address?: string | null };
  currency: string;
  items: InvoiceItemInput[];
  discountMinor?: number;
  taxMinor?: number;
  title?: string | null;
  memo?: string | null;
  dueDate?: string | null;
  merchantId?: string | null;
  departmentId?: string | null;
  createdBy?: string | null;
  status?: "draft" | "open";
  expiresInDays?: number | null;
  metadata?: Record<string, unknown>;
};

export function computeTotals(items: InvoiceItemInput[], discountMinor = 0, taxMinor = 0) {
  const lines = items.map((i) => ({ ...i, amountMinor: Math.round(i.quantity * i.unitAmountMinor) }));
  const subtotal = lines.reduce((s, l) => s + l.amountMinor, 0);
  const discount = Math.min(Math.max(0, discountMinor), subtotal);
  const tax = Math.max(0, taxMinor);
  return { lines, subtotal, discount, tax, total: subtotal - discount + tax };
}

/** Create (or reuse) customer + invoice + items atomically. All amounts computed server-side. */
export async function createInvoice(input: CreateInvoiceInput): Promise<{ invoice: InvoiceRow; token: string }> {
  const brand = await getBrand(input.brandId);
  if (!brand || !brand.is_active) throw new Error("Brand not found or inactive");
  if (input.items.length === 0) throw new Error("Add at least one line item");
  const t = computeTotals(input.items, input.discountMinor, input.taxMinor);
  if (t.total <= 0) throw new Error("Invoice total must be greater than zero");

  const token = randomToken(32);
  const expires = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null;

  const invoice = await sql.begin(async (tx) => {
    const [customer] = await tx<CustomerRow[]>`
      insert into customers (brand_id, name, email, phone, company, address, created_by)
      values (${brand.id}, ${input.customer.name}, ${input.customer.email.toLowerCase()}, ${input.customer.phone ?? null},
              ${input.customer.company ?? null}, ${input.customer.address ?? null}, ${input.createdBy ?? null})
      on conflict (brand_id, email) do update set
        name = excluded.name,
        phone = coalesce(excluded.phone, customers.phone),
        company = coalesce(excluded.company, customers.company),
        address = coalesce(excluded.address, customers.address)
      returning *`;
    const [{ n }] = await tx<{ n: string }[]>`select next_invoice_number(${brand.invoice_prefix}) as n`;
    const [inv] = await tx<InvoiceRow[]>`
      insert into invoices (number, brand_id, customer_id, merchant_id, department_id, created_by, currency,
                            subtotal_minor, discount_minor, tax_minor, total_minor, status, title, memo, due_date,
                            token_hash, token_enc, token_expires_at, metadata)
      values (${n}, ${brand.id}, ${customer.id}, ${input.merchantId ?? null}, ${input.departmentId ?? null}, ${input.createdBy ?? null},
              ${input.currency.toUpperCase()}, ${t.subtotal}, ${t.discount}, ${t.tax}, ${t.total}, ${input.status ?? "open"},
              ${input.title ?? null}, ${input.memo ?? null}, ${input.dueDate ?? null},
              ${hashToken(token)}, ${encrypt(token, INVOICE_TOKEN_CONTEXT)}, ${expires}, ${tx.json((input.metadata ?? {}) as never)})
      returning *`;
    await tx`insert into invoice_items ${tx(t.lines.map((l, i) => ({
      invoice_id: inv.id, description: l.description, quantity: l.quantity, unit_amount_minor: l.unitAmountMinor, amount_minor: l.amountMinor, sort_order: i,
    })))}`;
    return inv;
  });

  await emitEvent(brand.id, "invoice.created", { invoice_id: invoice.id, number: invoice.number, total_minor: invoice.total_minor, currency: invoice.currency });
  return { invoice, token };
}

export async function getInvoice(id: string) {
  const [inv] = await sql<InvoiceRow[]>`select * from invoices where id = ${id}`;
  return inv ?? null;
}

export async function invoiceByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  const [inv] = await sql<InvoiceRow[]>`select * from invoices where token_hash = ${hashToken(token)}`;
  return inv ?? null;
}

export function invoicePayUrl(inv: Pick<InvoiceRow, "token_enc">, brand: BrandRow) {
  return payUrl(brand, decrypt(inv.token_enc, INVOICE_TOKEN_CONTEXT));
}

export async function invoiceEmailVars(inv: InvoiceRow, brand: BrandRow) {
  const [c] = await sql<CustomerRow[]>`select * from customers where id = ${inv.customer_id}`;
  const due = Math.max(0, inv.total_minor - inv.amount_paid_minor);
  return {
    customer: c,
    vars: {
      customer_name: c.name,
      customer_email: c.email,
      invoice_number: inv.number,
      invoice_title: inv.title,
      invoice_amount: formatMoney(inv.total_minor, inv.currency),
      amount_due: formatMoney(due, inv.currency),
      currency: inv.currency,
      due_date: inv.due_date ? new Date(inv.due_date).toLocaleDateString("en-US", { dateStyle: "medium" }) : "Upon receipt",
      pay_url: invoicePayUrl(inv, brand),
      memo: inv.memo,
    },
  };
}

/** Send invoice / reminder email from the brand's own mailbox. */
export async function sendInvoiceEmail(invoiceId: string, type: Extract<TemplateType, "invoice" | "reminder">, sentBy: string | null) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new Error("Invoice not found");
  if (!["open", "draft"].includes(inv.status)) throw new Error(`Cannot email a ${inv.status} invoice`);
  const brand = (await getBrand(inv.brand_id))!;
  const { customer, vars } = await invoiceEmailVars(inv, brand);
  const res = await sendTemplatedEmail({ brand, type, to: customer.email, vars, invoiceId: inv.id, sentBy });
  if (res.ok) {
    if (type === "invoice") {
      await sql`update invoices set sent_at = now(), status = case when status = 'draft' then 'open'::invoice_status else status end where id = ${inv.id}`;
      await emitEvent(brand.id, "invoice.sent", { invoice_id: inv.id, number: inv.number });
    } else {
      await sql`update invoices set last_reminder_at = now(), reminder_count = reminder_count + 1 where id = ${inv.id}`;
    }
  }
  return res;
}

export async function rotateInvoiceToken(invoiceId: string) {
  const token = randomToken(32);
  await sql`update invoices set token_hash = ${hashToken(token)}, token_enc = ${encrypt(token, INVOICE_TOKEN_CONTEXT)} where id = ${invoiceId}`;
  return token;
}

/** Why an invoice can't be edited, or null if it can. */
export async function invoiceEditBlocker(id: string): Promise<string | null> {
  const [inv] = await sql<{ status: string; amount_paid_minor: number }[]>`select status, amount_paid_minor from invoices where id = ${id}`;
  if (!inv) return "Invoice not found.";
  if (!["draft", "open"].includes(inv.status)) return `A ${inv.status.replace("_", " ")} invoice can't be edited.`;
  if (inv.amount_paid_minor > 0) return "This invoice already has a payment, so it can't be edited. Void it and create a new one.";
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from payments
    where invoice_id = ${id} and status in ('processing','succeeded','partially_refunded','refunded','disputed')`;
  return n > 0 ? "A payment is processing or completed on this invoice, so it can't be edited." : null;
}

export type UpdateInvoiceInput = Omit<CreateInvoiceInput, "brandId" | "createdBy" | "departmentId" | "status" | "metadata">;

/**
 * Edit an unpaid invoice (items, amounts, customer, dates). The payment link stays
 * the same; any half-started checkout is cancelled so the customer pays the new amount.
 */
export async function updateInvoice(id: string, input: UpdateInvoiceInput): Promise<InvoiceRow> {
  if (input.items.length === 0) throw new Error("Add at least one line item");
  const t = computeTotals(input.items, input.discountMinor, input.taxMinor);
  if (t.total <= 0) throw new Error("Invoice total must be greater than zero");
  return sql.begin(async (tx) => {
    const [cur] = await tx<InvoiceRow[]>`select * from invoices where id = ${id} for update`;
    if (!cur) throw new Error("Invoice not found");
    const blocked = await invoiceEditBlocker(id);
    if (blocked) throw new Error(blocked);
    const [customer] = await tx<CustomerRow[]>`
      insert into customers (brand_id, name, email, phone, company, address)
      values (${cur.brand_id}, ${input.customer.name}, ${input.customer.email.toLowerCase()}, ${input.customer.phone ?? null},
              ${input.customer.company ?? null}, ${input.customer.address ?? null})
      on conflict (brand_id, email) do update set
        name = excluded.name, phone = coalesce(excluded.phone, customers.phone), company = coalesce(excluded.company, customers.company)
      returning *`;
    const [inv] = await tx<InvoiceRow[]>`
      update invoices set customer_id = ${customer.id}, currency = ${input.currency.toUpperCase()},
        subtotal_minor = ${t.subtotal}, discount_minor = ${t.discount}, tax_minor = ${t.tax}, total_minor = ${t.total},
        title = ${input.title ?? null}, memo = ${input.memo ?? null}, due_date = ${input.dueDate ?? null},
        merchant_id = ${input.merchantId ?? null},
        token_expires_at = ${input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : cur.token_expires_at}
      where id = ${id} returning *`;
    await tx`delete from invoice_items where invoice_id = ${id}`;
    await tx`insert into invoice_items ${tx(t.lines.map((l, i) => ({
      invoice_id: id, description: l.description, quantity: l.quantity, unit_amount_minor: l.unitAmountMinor, amount_minor: l.amountMinor, sort_order: i,
    })))}`;
    await tx`update payments set status = 'canceled' where invoice_id = ${id} and status = 'pending'`;
    return inv;
  });
}
