import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, PageHeader } from "@/components/ui";
import { createUserAction } from "../actions";

export const metadata = { title: "New user" };

export default async function NewUserPage() {
  await requireAdmin();
  const [departments, brands] = await Promise.all([
    sql<{ id: string; name: string }[]>`select id, name from departments order by name`,
    sql<{ id: string; name: string }[]>`select id, name from brands order by name`,
  ]);
  return (
    <>
      <PageHeader title="New user" />
      <Card>
        <ActionForm action={createUserAction} className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field label="Full name" name="name"><input className="input" id="name" name="name" required maxLength={120} /></Field>
          <Field label="Email" name="email"><input className="input" id="email" name="email" type="email" required maxLength={254} /></Field>
          <Field label="Role" name="role">
            <select className="input" id="role" name="role" defaultValue="seller"><option value="seller">Seller</option><option value="admin">Admin</option></select>
          </Field>
          <Field label="Department" name="department_id">
            <select className="input" id="department_id" name="department_id" defaultValue=""><option value="">— None —</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          </Field>
          <Field label="Temporary password" name="password" hint="12+ chars, 3 of upper/lower/number/symbol. Share it securely." className="sm:col-span-2">
            <input className="input" id="password" name="password" type="text" autoComplete="new-password" required minLength={12} maxLength={128} />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="must_change_password" defaultChecked /> Require password change at first sign-in
          </label>
          <input type="hidden" name="must_change_password" value="" />
          <fieldset className="sm:col-span-2">
            <legend className="label">Direct brand access (in addition to the department&apos;s brands)</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {brands.map((b) => <label key={b.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="brands" value={b.id} /> {b.name}</label>)}
              {brands.length === 0 && <p className="text-sm text-slate-500">No brands yet.</p>}
            </div>
          </fieldset>
          <div className="sm:col-span-2"><SubmitButton>Create user</SubmitButton></div>
        </ActionForm>
      </Card>
    </>
  );
}
