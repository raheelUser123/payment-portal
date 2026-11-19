import { NextResponse } from "next/server";
import { z } from "zod";
import { CheckoutError, startCheckout } from "@/lib/payments/service";
import { metaFromRequest } from "@/lib/security/request";
import { isAllowedPayOrigin } from "@/lib/security/pay-origin";

export const dynamic = "force-dynamic";

const Body = z.object({ provider: z.enum(["stripe", "paypal"]) });

export async function POST(req: Request, { params }: { params: Promise<{ slug: string; token: string }> }) {
  const { token } = await params;
  if (!(await isAllowedPayOrigin(req, token))) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    const r = await startCheckout(token, parsed.data.provider, metaFromRequest(req));
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof CheckoutError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[pay/start]", e);
    return NextResponse.json({ error: "Unable to start payment" }, { status: 500 });
  }
}
