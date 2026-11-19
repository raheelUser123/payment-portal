"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, type ActionResult } from "@/components/action-form";

type Action = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn-secondary px-2 py-1 text-xs"
      onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function CreateApiKeyForm({ action, brands, scopes, appUrl }: { action: Action; brands: { id: string; name: string; slug: string }[]; scopes: readonly string[]; appUrl: string }) {
  const [created, setCreated] = useState<{ keyId: string; secret: string } | null>(null);

  if (created) {
    const snippet = `// Node 18+ — server side only. Never expose the secret in a browser.
import crypto from "node:crypto";

const KEY_ID = process.env.PP_KEY_ID;      // ${created.keyId}
const SECRET = process.env.PP_KEY_SECRET;  // pps_...

async function createInvoice(payload) {
  const path = "/api/v1/invoices";
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const signature = crypto.createHmac("sha256", SECRET)
    .update(\`\${ts}.\${nonce}.POST.\${path}.\${bodyHash}\`).digest("hex");

  const res = await fetch("${appUrl}" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PP-Key": KEY_ID,
      "X-PP-Timestamp": ts,
      "X-PP-Nonce": nonce,
      "X-PP-Signature": signature,
    },
    body,
  });
  return res.json(); // { id, number, pay_url, ... }
}

await createInvoice({
  customer: { name: "Jane Doe", email: "jane@example.com" },
  items: [{ description: "Website package", quantity: 1, unit_amount: "499.00" }],
  send_email: true,
});`;
    return (
      <div className="space-y-4">
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Copy the secret now and store it in your brand website&apos;s server environment. It will never be shown again.</p>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2"><span className="w-20 text-slate-500">Key ID</span><code className="flex-1 break-all rounded bg-slate-100 px-2 py-1">{created.keyId}</code><Copy value={created.keyId} /></div>
          <div className="flex items-center gap-2"><span className="w-20 text-slate-500">Secret</span><code className="flex-1 break-all rounded bg-slate-100 px-2 py-1">{created.secret}</code><Copy value={created.secret} /></div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between"><p className="text-sm font-medium">Integration example</p><Copy value={snippet} /></div>
          <pre className="max-h-96 overflow-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">{snippet}</pre>
        </div>
        <button type="button" className="btn-secondary" onClick={() => setCreated(null)}>Done</button>
      </div>
    );
  }

  return (
    <ActionForm action={action} className="grid gap-4 sm:grid-cols-2"
      onResult={(r) => { const d = r.data as { keyId: string; secret: string } | undefined; if (r.ok && d) setCreated(d); }}>
      <div><label className="label" htmlFor="k-name">Name</label><input id="k-name" className="input" name="name" required maxLength={100} placeholder="brand-one.com website" /></div>
      <div><label className="label" htmlFor="k-brand">Brand</label>
        <select id="k-brand" className="input" name="brand_id" defaultValue=""><option value="">All brands (must pass &quot;brand&quot; slug)</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.slug})</option>)}</select></div>
      <fieldset className="sm:col-span-2"><legend className="label">Scopes</legend>
        <div className="flex flex-wrap gap-4">{scopes.map((sc) => <label key={sc} className="flex items-center gap-2 text-sm"><input type="checkbox" name="scopes" value={sc} defaultChecked={sc === "invoices:write"} /> <code>{sc}</code></label>)}</div>
      </fieldset>
      <div><label className="label" htmlFor="k-ips">Allowed IPs (optional)</label><input id="k-ips" className="input" name="allowed_ips" placeholder="203.0.113.10, 2001:db8::1" />
        <p className="mt-1 text-xs text-slate-500">Leave empty to allow any IP. Strongly recommended for production.</p></div>
      <div><label className="label" htmlFor="k-exp">Expires in (days, optional)</label><input id="k-exp" className="input" name="expires_days" type="number" min={1} max={3650} placeholder="365" /></div>
      <div className="sm:col-span-2"><SubmitButton>Create API key</SubmitButton></div>
    </ActionForm>
  );
}
