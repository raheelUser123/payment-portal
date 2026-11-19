import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiAuthError, authenticateApiRequest } from "@/lib/auth/api-keys";
import { createInvoice, sendInvoiceEmail } from "@/lib/invoices/service";
import { payUrl } from "@/lib/brands/service";
import { sql } from "@/lib/db";
import { toMinor } from "@/lib/payments/money";
import { audit } from "@/lib/logging/audit";
import { metaFromRequest } from "@/lib/security/request";
import type { BrandRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const Body = z.object({
  brand: z.string().min(1).max(100).optional(),            // brand slug (required for global keys)
  customer: z.object({
    name: z.string().trim().min(1).max(200),
    email: z.email().max(254),
    phone: z.string().max(40).optional(),
    company: z.string().max(200).optional(),
  }),
  currency: z.string().length(3).optional(),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(500),
    quantity: z.number().positive().max(100000).default(1),
    unit_amount: z.union([z.string(), z.number()]),          // decimal, e.g. "49.99"
  })).min(1).max(100),
  title: z.string().max(200).optional(),
  memo: z.string().max(2000).optional(),
  due_date: z.iso.date().optional(),
  send_email: z.boolean().default(false),
  metadata: z.record(z.string(), z.string().max(500)).optional(),
});

export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const auth = await authenticateApiRequest(req, raw, "invoices:write");
    const body = Body.parse(JSON.parse(raw));
    const [brand] = auth.brandId
      ? await sql<BrandRow[]>`select * from brands where id = ${auth.brandId} and is_active`
      : await sql<BrandRow[]>`select * from brands where slug = ${body.brand ?? ""} and is_active`;
    if (!brand) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    if (auth.brandId && body.brand && body.brand !== brand.slug) return NextResponse.json({ error: "Key not valid for this brand" }, { status: 403 });

    const currency = (body.currency ?? brand.default_currency).toUpperCase();
    const { invoice, token } = await createInvoice({
      brandId: brand.id,
      customer: body.customer,
      currency,
      items: body.items.map((i) => ({ description: i.description, quantity: i.quantity, unitAmountMinor: toMinor(i.unit_amount, currency) })),
      title: body.title,
      memo: body.memo,
      dueDate: body.due_date,
      metadata: { ...(body.metadata ?? {}), source: "api", api_key: auth.keyId },
    });
    const meta = metaFromRequest(req);
    await audit({ actor: { type: "api_key", id: auth.apiKeyId, label: auth.keyId }, action: "invoice.create", entityType: "invoice", entityId: invoice.id, after: { number: invoice.number, total_minor: invoice.total_minor }, ip: meta.ip, userAgent: meta.userAgent });
    let emailed = false;
    if (body.send_email) emailed = (await sendInvoiceEmail(invoice.id, "invoice", null)).ok;
    return NextResponse.json({ id: invoice.id, number: invoice.number, total_minor: invoice.total_minor, currency, pay_url: payUrl(brand, token), emailed }, { status: 201 });
  } catch (e) {
    if (e instanceof ApiAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof z.ZodError || e instanceof SyntaxError) return NextResponse.json({ error: "Invalid body", issues: e instanceof z.ZodError ? e.issues : undefined }, { status: 400 });
    console.error("[api/v1/invoices]", e);
    return NextResponse.json({ error: (e as Error).message.includes("amount") ? (e as Error).message : "Internal error" }, { status: 500 });
  }
}
