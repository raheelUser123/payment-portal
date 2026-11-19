import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { PageHeader, TableWrap, Empty, LinkButton } from "@/components/ui";

export const metadata = { title: "Departments" };

export default async function DepartmentsPage() {
  await requireAdmin();
  const rows = await sql<{ id: string; name: string; description: string | null; members: number; brands: string[] | null }[]>`
    select d.id, d.name, d.description,
           (select count(*)::int from users u where u.department_id = d.id) as members,
           (select array_agg(b.name order by b.name) from department_brands db join brands b on b.id = db.brand_id where db.department_id = d.id) as brands
      from departments d order by d.name`;
  return (
    <>
      <PageHeader title="Departments" description="Sellers see invoices and payments for the brands assigned to their department."
        actions={<LinkButton href="/admin/departments/new">New department</LinkButton>} />
      {rows.length === 0 ? <Empty>No departments yet.</Empty> : (
        <TableWrap>
          <thead><tr><th>Department</th><th>Members</th><th>Brands</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td><Link href={`/admin/departments/${d.id}`} className="font-medium text-indigo-700 hover:underline">{d.name}</Link>{d.description && <div className="text-xs text-slate-500">{d.description}</div>}</td>
                <td>{d.members}</td>
                <td className="text-xs">{d.brands?.join(", ") ?? <span className="text-slate-400">none</span>}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </>
  );
}
