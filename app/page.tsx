import { notFound, redirect } from "next/navigation";
import { invoiceByToken } from "@/lib/invoices/service";
import { getBrand, payPath } from "@/lib/brands/service";

export const dynamic = "force-dynamic";

/** Old-style link /pay/<token> → /pay/<brand-slug>/<token>. */
export default async function LegacyPayRedirect({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: token } = await params;
  const inv = await invoiceByToken(token);
  if (!inv) notFound();
  const brand = await getBrand(inv.brand_id);
  if (!brand) notFound();
  redirect(payPath(brand, token));
}
