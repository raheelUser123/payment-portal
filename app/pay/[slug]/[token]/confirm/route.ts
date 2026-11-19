import { NextResponse } from "next/server";
import { z } from "zod";
import { CheckoutError, confirmCheckout } from "@/lib/payments/service";
import { metaFromRequest } from "@/lib/security/request";
import { isAllowedPayOrigin } from "@/lib/security/pay-origin";
import { rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const Body = z.object({ paymentId: z.uuid() });

export async function POST(req: Request, { params }: { params: Promise<{ slug: string; token: string }> }) {
  const { token } = await params;
  if (!(await isAllowedPayOrigin(req, token))) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const meta = metaFromRequest(req);
  if (!(await rateLimit(`confirm:${meta.ip ?? "unknown"}`, 300, 30))) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const p = await confirmCheckout(token, parsed.data.paymentId);
    return NextResponse.json({ status: p.status, message: p.failure_message });
  } catch (e) {
    if (e instanceof CheckoutError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[pay/confirm]", e);
    return NextResponse.json({ error: "Unable to confirm payment" }, { status: 500 });
  }
}
