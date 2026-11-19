import { handleGatewayWebhook } from "@/lib/payments/service";
import { metaFromRequest } from "@/lib/security/request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** paypal webhook endpoint. Configure in the paypal dashboard as https://<admin-host>/api/webhooks/paypal/<merchantId> */
export async function POST(req: Request, { params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(merchantId)) return new Response("not found", { status: 404 });
  const raw = await req.text(); // raw body is required for signature verification
  if (raw.length > 1_000_000) return new Response("too large", { status: 413 });
  const r = await handleGatewayWebhook(merchantId, "paypal", raw, req.headers, metaFromRequest(req));
  return new Response(r.body, { status: r.status });
}
