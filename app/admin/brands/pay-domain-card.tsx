import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field } from "@/components/ui";
import type { BrandRow } from "@/lib/types";
import { domainStatus, vercelConfigured, type DomainStatus } from "@/lib/vercel/domains";
import { checkPayDomain, removePayDomain, setPayDomain } from "./actions";

/** Payment subdomain per brand, e.g. pay.graphicwolves.com → this portal. */
export async function PayDomainCard({ brand, portal }: { brand: BrandRow; portal: string }) {
  const apex = brand.website_url ? brand.website_url.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "") : "yourbrand.com";
  const live = !!(brand.pay_domain && brand.pay_domain_verified_at);
  const auto = vercelConfigured();
  let status: DomainStatus | null = null;
  if (brand.pay_domain && auto) status = await domainStatus(brand.pay_domain).catch(() => null);
  const label = brand.pay_domain ? (brand.pay_domain.split(".").length > 2 ? brand.pay_domain.split(".").slice(0, -2).join(".") : "@") : "pay";
  const records = status?.records.length ? status.records : brand.pay_domain && !live ? [{ type: "CNAME", name: label, value: "cname.vercel-dns.com", reason: "Points the subdomain at the payment portal" }] : [];

  return (
    <Card title="Payment subdomain" actions={live ? <Badge tone="green">live</Badge> : brand.pay_domain ? <Badge tone="amber">waiting for DNS</Badge> : <Badge>not set</Badge>}>
      <p className="mb-3 text-sm text-slate-600">
        Give this brand its own payment address, e.g. <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">pay.{apex}</code>. Customers&apos; links become{" "}
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">https://{brand.pay_domain ?? `pay.${apex}`}/pay/{brand.slug}/…</code>. Your main website is not touched.
      </p>

      <ActionForm action={setPayDomain} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={brand.id} />
        <Field label="Subdomain" name="pay_domain" className="min-w-56 flex-1">
          <input className="input" id="pay_domain" name="pay_domain" defaultValue={brand.pay_domain ?? `pay.${apex}`} placeholder={`pay.${apex}`} required />
        </Field>
        <SubmitButton className="btn-primary" pendingText="Connecting…">{brand.pay_domain ? "Save & connect" : "Connect subdomain"}</SubmitButton>
      </ActionForm>

      {brand.pay_domain && (
        <div className="mt-5 space-y-3 text-sm">
          <ol className="space-y-2">
            <Step done={auto ? !!status?.added : true} n={1} text={auto ? "Added to the portal's Vercel project" : <>Add <b>{brand.pay_domain}</b> in Vercel → payment-portal → Settings → Domains</>} />
            <Step done={live || !!status?.dnsOk} n={2} text="DNS record created at your domain provider" />
            <Step done={live} n={3} text="Live with HTTPS — new payment links use this subdomain" />
          </ol>

          {!live && records.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="mb-2 font-medium text-amber-900">Create this DNS record where you manage {apex}&apos;s DNS (GoDaddy, Namecheap, Cloudflare, Hostinger…):</p>
              <table className="w-full text-xs">
                <thead><tr className="text-left text-amber-800"><th className="pb-1 pr-3">Type</th><th className="pb-1 pr-3">Name / Host</th><th className="pb-1 pr-3">Value / Points to</th></tr></thead>
                <tbody>{records.map((r, i) => (
                  <tr key={i} className="align-top"><td className="pr-3 font-mono">{r.type}</td><td className="pr-3 font-mono">{r.name}</td><td className="break-all font-mono">{r.value}<div className="font-sans text-amber-700">{r.reason}</div></td></tr>
                ))}</tbody>
              </table>
              <p className="mt-2 text-xs text-amber-800">On Cloudflare, set the record to <b>DNS only</b> (grey cloud). Changes usually take 5–30 minutes.</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {!live && (
              <ActionForm action={checkPayDomain}><input type="hidden" name="id" value={brand.id} /><SubmitButton className="btn-secondary" pendingText="Checking…">Check again</SubmitButton></ActionForm>
            )}
            <ActionForm action={removePayDomain} confirm={`Disconnect ${brand.pay_domain}? New links will use ${portal.replace(/^https?:\/\//, "")} again (old links on the subdomain stop working once DNS is removed).`}>
              <input type="hidden" name="id" value={brand.id} /><SubmitButton className="btn-ghost text-rose-600">Disconnect</SubmitButton>
            </ActionForm>
          </div>
          {!auto && <p className="text-xs text-slate-500">Tip: add a <code>VERCEL_API_TOKEN</code> to the portal&apos;s environment and the subdomain is added to Vercel automatically.</p>}
        </div>
      )}
    </Card>
  );
}

function Step({ done, n, text }: { done: boolean; n: number; text: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${done ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-600"}`}>{done ? "✓" : n}</span>
      <span className={done ? "text-slate-700" : "text-slate-500"}>{text}</span>
    </li>
  );
}
