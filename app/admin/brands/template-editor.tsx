"use client";

import { useEffect, useState, useTransition } from "react";
import { ActionForm, SubmitButton, type ActionResult } from "@/components/action-form";
import { previewTemplate } from "./actions";

type Action = (p: ActionResult | null, fd: FormData) => Promise<ActionResult>;

export function TemplateEditor({ brandId, type, subject, html, isActive, save, variables }: {
  brandId: string | null; type: string; subject: string; html: string; isActive: boolean; save: Action; variables: readonly string[];
}) {
  const [s, setS] = useState(subject);
  const [h, setH] = useState(html);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [, start] = useTransition();

  useEffect(() => {
    const t = setTimeout(() => start(async () => setPreview(await previewTemplate(brandId, s, h))), 400);
    return () => clearTimeout(t);
  }, [brandId, s, h]);

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <ActionForm action={save} className="space-y-4">
        <input type="hidden" name="brand_id" value={brandId ?? ""} />
        <input type="hidden" name="type" value={type} />
        <div><label className="label" htmlFor="subject">Subject</label>
          <input className="input" id="subject" name="subject" value={s} onChange={(e) => setS(e.target.value)} required maxLength={300} /></div>
        <div><label className="label" htmlFor="html">HTML body</label>
          <textarea className="input font-mono text-xs" id="html" name="html" rows={22} value={h} onChange={(e) => setH(e.target.value)} required spellCheck={false} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_active" defaultChecked={isActive} className="h-4 w-4" /> Active</label>
        <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          <p className="mb-1 font-semibold">Variables</p>
          <p className="flex flex-wrap gap-1">{variables.map((v) => <code key={v} className="rounded bg-white px-1.5 py-0.5 ring-1 ring-slate-200">{`{{${v}}}`}</code>)}</p>
          <p className="mt-2">Sections: <code>{"{{#var}}…{{/var}}"}</code> shows only when set, <code>{"{{^var}}…{{/var}}"}</code> only when empty. Values are HTML-escaped automatically.</p>
        </div>
        <SubmitButton>Save template</SubmitButton>
      </ActionForm>
      <div>
        <p className="label">Preview (sample data)</p>
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm"><span className="text-slate-500">Subject: </span>{preview?.subject ?? "…"}</div>
          <iframe title="Email preview" sandbox="" className="h-[640px] w-full bg-white" srcDoc={preview?.html ?? ""} />
        </div>
      </div>
    </div>
  );
}
