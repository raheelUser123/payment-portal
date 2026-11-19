import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { PageHeader, Card, Empty, Badge } from "@/components/ui";
import { DepartmentForm } from "../department-form";
import { updateDepartment, deleteDepartment } from "../actions";

export const metadata = { title: "Department" };

export default async function DepartmentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [dept] = await sql<{ id: string; name: string; description: string | null }[]>`select id, name, description from departments where id = ${id}`;
  if (!dept) notFound();
  const brands = await sql<{ id: string; name: string }[]>`select id, name from brands order by name`;
  const linked = (await sql<{ brand_id: string }[]>`select brand_id from department_brands where department_id = ${id}`).map((r) => r.brand_id);
  const members = await sql<{ id: string; name: string; email: string; role: string; is_active: boolean }[]>`
    select id, name, email, role, is_active from users where department_id = ${id} order by name`;
  return (
    <>
      <PageHeader title={dept.name} actions={<Link href="/admin/departments" className="btn-secondary">All departments</Link>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2"><Card title="Details"><DepartmentForm action={updateDepartment} brands={brands} dept={dept} linked={linked} /></Card></div>
        <div className="space-y-6">
          <Card title={`Members (${members.length})`}>
            {members.length === 0 ? <Empty>No members.</Empty> : (
              <ul className="space-y-2 text-sm">{members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span><span className="font-medium">{m.name}</span><span className="block text-xs text-slate-500">{m.email}</span></span>
                  <span className="flex gap-1"><Badge tone={m.role === "admin" ? "blue" : "gray"}>{m.role}</Badge>{!m.is_active && <Badge tone="red">inactive</Badge>}</span>
                </li>
              ))}</ul>
            )}
          </Card>
          <Card title="Danger zone">
            <ActionForm action={deleteDepartment} confirm={`Delete department "${dept.name}"?`}>
              <input type="hidden" name="id" value={id} />
              <p className="mb-3 text-xs text-slate-500">Only possible when the department has no members.</p>
              <SubmitButton className="btn-danger">Delete department</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    </>
  );
}
