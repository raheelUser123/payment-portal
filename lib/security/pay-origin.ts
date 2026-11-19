import "server-only";
import { env } from "../env";
import { brandOriginHosts, getBrand } from "../brands/service";
import { invoiceByToken } from "../invoices/service";

/**
 * CSRF check for the public pay APIs. The browser may be on the portal domain
 * or on the brand's own website (which forwards /pay/* here), so the Origin
 * must be one of: the request host, an admin host, or this invoice's brand domain.
 */
export async function isAllowedPayOrigin(req: Request, token: string): Promise<boolean> {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").toLowerCase();
  if (originHost === host) return true;
  let admin: string[] = [];
  try { admin = env.adminHosts; } catch { /* APP_URL not set (dev) */ }
  if (admin.includes(originHost)) return true;
  const inv = await invoiceByToken(token);
  if (!inv) return false;
  const brand = await getBrand(inv.brand_id);
  return !!brand && brandOriginHosts(brand).includes(originHost);
}
