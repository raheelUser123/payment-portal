import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { PageHeader, Card } from "@/components/ui";
import { DepartmentForm } from "../department-form";
import { createDepartment } from "../actions";

export const metadata = { title: "New department" };

export default async function NewDepartmentPage() {
  await requireAdmin();
  const brands = await sql<{ id: string; name: string }[]>`select id, name from brands order by name`;
  return (
    <>
      <PageHeader title="New department" />
      <Card><DepartmentForm action={createDepartment} brands={brands} /></Card>
    </>
  );
}
