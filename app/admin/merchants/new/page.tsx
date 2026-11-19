import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { PageHeader, Card } from "@/components/ui";
import { MerchantForm } from "../merchant-form";
import { createMerchant } from "../actions";

export const metadata = { title: "New merchant" };

const PROVIDERS = [
  { id: "stripe", label: "Stripe", enabled: true },
  { id: "paypal", label: "PayPal", enabled: true },
  { id: "authorize_net", label: "Authorize.net", enabled: false },
  { id: "square", label: "Square", enabled: false },
];

export default async function NewMerchantPage({ searchParams }: { searchParams: Promise<{ provider?: string }> }) {
  await requireAdmin();
  const { provider: q } = await searchParams;
  const provider = q === "paypal" ? "paypal" : "stripe";
  return (
    <>
      <PageHeader title="New merchant" description="Connect a gateway account. You can link it to any number of brands afterwards." />
      <div className="mb-6 flex flex-wrap gap-2">
        {PROVIDERS.map((p) => p.enabled ? (
          <Link key={p.id} href={`?provider=${p.id}`} className={`rounded-lg border px-4 py-2 text-sm font-medium ${p.id === provider ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white"}`}>{p.label}</Link>
        ) : (
          <span key={p.id} className="cursor-not-allowed rounded-lg border border-dashed border-slate-200 px-4 py-2 text-sm text-slate-400" title="Coming soon">{p.label} · coming soon</span>
        ))}
      </div>
      <Card><MerchantForm key={provider} action={createMerchant} provider={provider} /></Card>
    </>
  );
}
