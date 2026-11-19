import Link from "next/link";
import { accessibleBrandIds, requireUser } from "@/lib/auth/guard";
import { deleteInquiryAction } from "../delete-actions";
import { sql } from "@/lib/db";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { dt, Empty, PageHeader, Pagination, StatusBadge } from "@/components/ui";
import { updateInquiryAction } from "./actions";

export const metadata = { title: "Inquiries" };
const PAGE = 30;

export default async function InquiriesPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const s = await requireUser();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const status = ["new", "contacted", "converted", "closed"].includes(sp.status ?? "") ? sp.status! : null;
  const ids = await accessibleBrandIds(s);
  const rows = await sql<{ id: string; brand: string | null; name: string | null; email: string | null; phone: string | null; subject: string | null; message: string | null;
    amount_text: string | null; source_url: string | null; status: string; assigned_to: string | null; assignee: string | null; created_at: Date }[]>`
    select i.id, b.name as brand, i.name, i.email, i.phone, i.subject, i.message, i.amount_text, i.source_url, i.status, i.assigned_to, u.name as assignee, i.created_at
      from inquiries i left join brands b on b.id = i.brand_id left join users u on u.id = i.assigned_to
     where (${ids === null} or i.brand_id = any(${ids ?? []}::uuid[]))
       and (${status}::text is null or i.status = ${status})
     order by i.created_at desc limit ${PAGE + 1} offset ${(page - 1) * PAGE}`;
  const users = s.user.role === "admin"
    ? await sql<{ id: string; name: string }[]>`select id, name from users where is_active order by name`
    : [{ id: s.user.id, name: s.user.name }];
  const hasMore = rows.length > PAGE;

  return (
    <>
      <PageHeader title="Inquiries" description="Contact and quote requests submitted from brand websites via the API." />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        {["all", "new", "contacted", "converted", "closed"].map((x) => (
          <Link key={x} href={x === "all" ? "/admin/inquiries" : `/admin/inquiries?status=${x}`}
            className={`rounded-full px-3 py-1 capitalize ${(status ?? "all") === x ? "bg-indigo-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>{x}</Link>
        ))}
      </div>
      {rows.length === 0 ? <Empty>No inquiries.</Empty> : (
        <div className="space-y-3">
          {rows.slice(0, PAGE).map((i) => (
            <div key={i.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{i.name ?? "Anonymous"} <span className="font-normal text-slate-500">{i.email}{i.phone && ` · ${i.phone}`}</span></p>
                  <p className="text-xs text-slate-500">{i.brand ?? "No brand"} · {dt(i.created_at)}{i.source_url && <> · <span className="break-all">{i.source_url}</span></>}</p>
                </div>
                <StatusBadge status={i.status === "new" ? "open" : i.status === "converted" ? "paid" : i.status === "closed" ? "void" : "pending"} />
              </div>
              {i.subject && <p className="mt-2 text-sm font-medium">{i.subject}</p>}
              {i.message && <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{i.message}</p>}
              {i.amount_text && <p className="mt-1 text-sm text-slate-600">Budget/amount: {i.amount_text}</p>}
              <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
                <ActionForm action={updateInquiryAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="id" value={i.id} />
                  <div><label className="label">Status</label>
                    <select name="status" className="input" defaultValue={i.status}>{["new", "contacted", "converted", "closed"].map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
                  <div><label className="label">Assigned to</label>
                    <select name="assigned_to" className="input" defaultValue={i.assigned_to ?? ""}><option value="">Unassigned</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      {i.assigned_to && !users.some((u) => u.id === i.assigned_to) && <option value={i.assigned_to}>{i.assignee}</option>}
                    </select></div>
                  <SubmitButton className="btn-secondary">Save</SubmitButton>
                </ActionForm>
                <Link href={`/admin/invoices/new?inquiry=${i.id}`} className="btn-primary">Create invoice</Link>
                {s.user.role === "admin" && (
                  <ActionForm action={deleteInquiryAction} confirm="Delete this inquiry permanently?">
                    <input type="hidden" name="id" value={i.id} /><SubmitButton className="btn-ghost text-rose-600">Delete</SubmitButton>
                  </ActionForm>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <Pagination page={page} hasMore={hasMore} base={status ? `/admin/inquiries?status=${status}` : "/admin/inquiries"} />
    </>
  );
}
