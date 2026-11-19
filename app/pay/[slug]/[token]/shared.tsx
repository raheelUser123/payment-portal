import "server-only";
import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { invoiceByToken } from "@/lib/invoices/service";
import { getBrand, payPath } from "@/lib/brands/service";
import type { BrandRow, CustomerRow, InvoiceRow } from "@/lib/types";

/**
 * Load invoice + brand for a public pay page at /pay/<brand-slug>/<token>.
 * If the slug doesn't match the invoice's brand (e.g. the brand slug was
 * renamed), redirect to the correct branded URL — an invoice is never shown
 * under another brand's name.
 */
export async function loadPublicInvoice(slug: string, token: string, suffix = "") {
  const inv = await invoiceByToken(token);
  if (!inv) notFound();
  const brand = await getBrand(inv.brand_id);
  if (!brand || !brand.is_active) notFound();
  if (brand.slug !== slug) redirect(`${payPath(brand, token)}${suffix}`);
  const [customer] = await sql<CustomerRow[]>`select * from customers where id = ${inv.customer_id}`;
  const items = await sql<{ description: string; quantity: string; unit_amount_minor: number; amount_minor: number }[]>`
    select description, quantity::text, unit_amount_minor, amount_minor from invoice_items where invoice_id = ${inv.id} order by sort_order`;
  return { inv, brand, customer, items };
}

export function BrandShell({ brand, children }: { brand: BrandRow; children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: `linear-gradient(180deg, ${brand.primary_color} 0 220px, #f6f7f9 220px)` }}>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <header className="mb-8 flex items-center justify-between text-white">
          <div className="flex items-center gap-3">
            {brand.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand.logo_url} alt={brand.name} className="h-10 max-w-[180px] rounded bg-white/95 object-contain p-1" />
            ) : (
              <span className="text-2xl font-bold tracking-tight">{brand.name}</span>
            )}
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5Zm-3 8V6a3 3 0 1 1 6 0v3H9Z"/></svg>
            Secure payment
          </span>
        </header>
        {children}
        <footer className="mt-10 space-y-1 text-center text-xs text-slate-500">
          {brand.footer_text && <p>{brand.footer_text}</p>}
          <p>
            {brand.support_email && <>Questions? <a className="underline" href={`mailto:${brand.support_email}`}>{brand.support_email}</a></>}
            {brand.support_phone && <> · {brand.support_phone}</>}
          </p>
          <p className="space-x-3">
            {brand.terms_url && <a className="underline" href={brand.terms_url} rel="noopener noreferrer" target="_blank">Terms</a>}
            {brand.privacy_url && <a className="underline" href={brand.privacy_url} rel="noopener noreferrer" target="_blank">Privacy</a>}
          </p>
          <p>© {new Date().getFullYear()} {brand.name}. Payments are encrypted and processed securely.</p>
        </footer>
      </div>
    </div>
  );
}

export type PublicInvoice = Awaited<ReturnType<typeof loadPublicInvoice>>;
export type { InvoiceRow };
