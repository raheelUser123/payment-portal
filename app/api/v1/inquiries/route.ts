import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiAuthError, authenticateApiRequest } from "@/lib/auth/api-keys";
import { sql } from "@/lib/db";
import { emitEvent } from "@/lib/webhooks/outbound";
import { raiseAlert } from "@/lib/logging/alerts";

export const dynamic = "force-dynamic";

/** Contact / quote form submissions from brand websites (replaces old quotes + leads forms). */
const Body = z.object({
  brand: z.string().optional(),
  name: z.string().trim().max(200).optional(),
  email: z.email().max(254).optional(),
  phone: z.string().max(40).optional(),
  subject: z.string().max(300).optional(),
  message: z.string().max(5000).optional(),
  amount: z.string().max(50).optional(),
  source_url: z.string().max(500).optional(),
  visitor_ip: z.string().max(45).optional(),
});

export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const auth = await authenticateApiRequest(req, raw, "inquiries:write");
    const b = Body.parse(JSON.parse(raw));
    const [brand] = auth.brandId
      ? await sql<{ id: string; name: string }[]>`select id, name from brands where id = ${auth.brandId}`
      : await sql<{ id: string; name: string }[]>`select id, name from brands where slug = ${b.brand ?? ""}`;
    const ip = b.visitor_ip && /^[0-9a-fA-F:.]{3,45}$/.test(b.visitor_ip) ? b.visitor_ip : null;
    const [row] = await sql<{ id: string }[]>`
      insert into inquiries (brand_id, name, email, phone, subject, message, amount_text, source_url, ip)
      values (${brand?.id ?? null}, ${b.name ?? null}, ${b.email ?? null}, ${b.phone ?? null}, ${b.subject ?? null},
              ${b.message ?? null}, ${b.amount ?? null}, ${b.source_url ?? null}, ${ip})
      returning id`;
    await raiseAlert({ severity: "info", type: "inquiry", title: `New inquiry${brand ? ` — ${brand.name}` : ""}`, message: `${b.name ?? ""} ${b.email ?? ""}`.trim(), entityType: "inquiry", entityId: row.id });
    await emitEvent(brand?.id ?? null, "inquiry.created", { inquiry_id: row.id });
    return NextResponse.json({ id: row.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ApiAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof z.ZodError || e instanceof SyntaxError) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    console.error("[api/v1/inquiries]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
