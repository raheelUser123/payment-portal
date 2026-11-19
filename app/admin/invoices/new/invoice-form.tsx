"use client";

import { useMemo, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CURRENCIES, formatMoney, toMinor } from "@/lib/payments/money";
import { createInvoiceAction, updateInvoiceAction } from "../actions";

type Brand = { id: string; name: string; default_currency: string };
type Merchant = { brand_id: string; id: string; name: string; provider: string; mode: string };
type Item = { description: string; quantity: string; unitAmount: string };
export type InvoiceEditData = {
  invoiceId: string; currency: string; items: Item[]; discount: string; tax: string; company: string;
  dueDate: string; memo: string; merchantId: string;
};

function safeMinor(v: string, c: string) {
  try { return v ? toMinor(v, c) : 0; } catch { return 0; }
}

export function InvoiceForm({ brands, merchants, prefill, edit }: { brands: Brand[]; merchants: Merchant[]; prefill: { name?: string; email?: string; phone?: string; brandId?: string; title?: string; inquiryId?: string }; edit?: InvoiceEditData }) {
  const initialBrand = brands.find((b) => b.id === prefill.brandId) ?? brands[0];
  const [brandId, setBrandId] = useState(initialBrand.id);
  const [currency, setCurrency] = useState(edit?.currency ?? initialBrand.default_currency);
  const [items, setItems] = useState<Item[]>(edit?.items ?? [{ description: prefill.title ?? "", quantity: "1", unitAmount: "" }]);
  const [discount, setDiscount] = useState(edit?.discount ?? "");
  const [tax, setTax] = useState(edit?.tax ?? "");

  const totals = useMemo(() => {
    const subtotal = items.reduce((s, i) => s + Math.round((Number(i.quantity) || 0) * safeMinor(i.unitAmount, currency)), 0);
    const d = Math.min(safeMinor(discount, currency), subtotal);
    const t = safeMinor(tax, currency);
    return { subtotal, d, t, total: subtotal - d + t };
  }, [items, discount, tax, currency]);

  const brandMerchants = merchants.filter((m) => m.brand_id === brandId);
  const update = (i: number, patch: Partial<Item>) => setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  return (
    <ActionForm action={edit ? updateInvoiceAction : createInvoiceAction} className="grid gap-6 lg:grid-cols-3">
      {edit && <input type="hidden" name="invoiceId" value={edit.invoiceId} />}
      {edit && <input type="hidden" name="brandId" value={brandId} />}
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      {prefill.inquiryId && <input type="hidden" name="inquiryId" value={prefill.inquiryId} />}
      <div className="space-y-6 lg:col-span-2">
        <section className="card p-5">
          <h2 className="mb-4 text-sm font-semibold">Brand &amp; customer</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="brandId">Brand</label>
              <select id="brandId" name={edit ? undefined : "brandId"} disabled={!!edit} className="input" value={brandId} onChange={(e) => { setBrandId(e.target.value); setCurrency(brands.find((b) => b.id === e.target.value)?.default_currency ?? currency); }}>
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="currency">Currency</label>
              <select id="currency" name="currency" className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div><label className="label" htmlFor="customerName">Customer name</label><input id="customerName" name="customerName" className="input" required maxLength={200} defaultValue={prefill.name} /></div>
            <div><label className="label" htmlFor="customerEmail">Customer email</label><input id="customerEmail" name="customerEmail" type="email" className="input" required maxLength={254} defaultValue={prefill.email} /></div>
            <div><label className="label" htmlFor="customerPhone">Phone (optional)</label><input id="customerPhone" name="customerPhone" className="input" maxLength={40} defaultValue={prefill.phone} /></div>
            <div><label className="label" htmlFor="customerCompany">Company (optional)</label><input id="customerCompany" name="customerCompany" className="input" maxLength={200} defaultValue={edit?.company} /></div>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="mb-4 text-sm font-semibold">Line items</h2>
          <div className="space-y-3">
            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-12 gap-2">
                <input className="input col-span-12 sm:col-span-6" placeholder="Description" value={it.description} onChange={(e) => update(i, { description: e.target.value })} required maxLength={500} aria-label="Description" />
                <input className="input col-span-3 sm:col-span-2" placeholder="Qty" inputMode="decimal" value={it.quantity} onChange={(e) => update(i, { quantity: e.target.value })} required aria-label="Quantity" />
                <input className="input col-span-6 sm:col-span-3" placeholder="Unit price" inputMode="decimal" value={it.unitAmount} onChange={(e) => update(i, { unitAmount: e.target.value })} required aria-label="Unit price" />
                <button type="button" className="btn-ghost col-span-3 sm:col-span-1" disabled={items.length === 1} onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} aria-label="Remove item">✕</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn-secondary mt-3" onClick={() => setItems((p) => [...p, { description: "", quantity: "1", unitAmount: "" }])}>+ Add item</button>
        </section>

        <section className="card p-5">
          <h2 className="mb-4 text-sm font-semibold">Details</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><label className="label" htmlFor="title">Title (shown in email)</label><input id="title" name="title" className="input" maxLength={200} defaultValue={prefill.title} placeholder="e.g. Website design — milestone 1" /></div>
            <div><label className="label" htmlFor="dueDate">Due date</label><input id="dueDate" name="dueDate" type="date" className="input" defaultValue={edit?.dueDate} /></div>
            <div><label className="label" htmlFor="expiresInDays">Link expires after (days, optional)</label><input id="expiresInDays" name="expiresInDays" type="number" min={1} max={365} className="input" /></div>
            <div className="sm:col-span-2"><label className="label" htmlFor="memo">Note to customer</label><textarea id="memo" name="memo" className="input min-h-24" maxLength={5000} defaultValue={edit?.memo} /></div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="merchantId">Merchant routing</label>
              <select id="merchantId" name="merchantId" className="input" defaultValue={edit?.merchantId ?? ""}>
                <option value="">Automatic (brand priority, limits &amp; currency)</option>
                {brandMerchants.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.provider} ({m.mode})</option>)}
              </select>
              {brandMerchants.length === 0 && <p className="mt-1 text-xs text-amber-700">No active merchant is linked to this brand — customers won&apos;t be able to pay until an admin links one.</p>}
            </div>
          </div>
        </section>
      </div>

      <aside className="space-y-4">
        <section className="card sticky top-6 p-5">
          <h2 className="mb-4 text-sm font-semibold">Summary</h2>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="tabular-nums">{formatMoney(totals.subtotal, currency)}</span></div>
            <div className="flex items-center justify-between gap-2"><label htmlFor="discount" className="text-slate-500">Discount</label><input id="discount" name="discount" className="input w-32 text-right" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0.00" /></div>
            <div className="flex items-center justify-between gap-2"><label htmlFor="tax" className="text-slate-500">Tax</label><input id="tax" name="tax" className="input w-32 text-right" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="0.00" /></div>
            <div className="flex justify-between border-t border-slate-200 pt-3 text-base font-semibold"><span>Total</span><span className="tabular-nums">{formatMoney(totals.total, currency)}</span></div>
          </div>
          <label className="mt-5 flex items-center gap-2 text-sm"><input type="checkbox" name="send" defaultChecked={!edit} /> {edit ? "Email the updated invoice to the customer" : "Email invoice to customer now"}</label>
          <SubmitButton className="btn-primary mt-4 w-full" pendingText={edit ? "Saving…" : "Creating…"}>{edit ? "Save changes" : "Create invoice"}</SubmitButton>
        </section>
      </aside>
    </ActionForm>
  );
}
