"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, type ActionResult } from "@/components/action-form";

type Action = (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;

function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm">
      <p className="text-amber-800">Signing secret (shown once). Verify <code>X-PP-Signature: t=…,v1=HMAC_SHA256(secret, &quot;t.rawBody&quot;)</code> on your receiver.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-white px-2 py-1">{secret}</code>
        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => navigator.clipboard?.writeText(secret)}>Copy</button>
      </div>
      <button type="button" className="btn-ghost" onClick={onDone}>Done</button>
    </div>
  );
}

export function CreateEndpointForm({ action, brands, events }: { action: Action; brands: { id: string; name: string }[]; events: readonly string[] }) {
  const [secret, setSecret] = useState<string | null>(null);
  if (secret) return <SecretReveal secret={secret} onDone={() => setSecret(null)} />;
  return (
    <ActionForm action={action} className="grid gap-4 sm:grid-cols-2"
      onResult={(r) => { const d = r.data as { secret?: string } | undefined; if (r.ok && d?.secret) setSecret(d.secret); }}>
      <div className="sm:col-span-2"><label className="label" htmlFor="w-url">HTTPS URL</label><input id="w-url" className="input" name="url" type="url" required placeholder="https://brand-one.com/hooks/payments" /></div>
      <div><label className="label" htmlFor="w-brand">Brand</label>
        <select id="w-brand" className="input" name="brand_id" defaultValue=""><option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
      <fieldset className="sm:col-span-2"><legend className="label">Events (none selected = all events)</legend>
        <div className="grid gap-2 sm:grid-cols-3">{events.map((e) => <label key={e} className="flex items-center gap-2 text-sm"><input type="checkbox" name="events" value={e} /> <code>{e}</code></label>)}</div>
      </fieldset>
      <div className="sm:col-span-2"><SubmitButton>Add endpoint</SubmitButton></div>
    </ActionForm>
  );
}

export function RotateSecretForm({ action, id }: { action: Action; id: string }) {
  const [secret, setSecret] = useState<string | null>(null);
  if (secret) return <SecretReveal secret={secret} onDone={() => setSecret(null)} />;
  return (
    <ActionForm action={action} confirm="Rotate the signing secret? The old secret stops working immediately."
      onResult={(r) => { const d = r.data as { secret?: string } | undefined; if (r.ok && d?.secret) setSecret(d.secret); }}>
      <input type="hidden" name="id" value={id} /><SubmitButton className="btn-secondary">Rotate secret</SubmitButton>
    </ActionForm>
  );
}
