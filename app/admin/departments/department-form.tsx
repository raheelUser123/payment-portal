import { ActionForm, SubmitButton, type ActionResult } from "@/components/action-form";
import { Field, Empty } from "@/components/ui";

type Action = (p: ActionResult | null, fd: FormData) => Promise<ActionResult>;

export function DepartmentForm({ action, brands, dept, linked = [] }: {
  action: Action; brands: { id: string; name: string }[]; dept?: { id: string; name: string; description: string | null }; linked?: string[];
}) {
  return (
    <ActionForm action={action} className="space-y-4">
      {dept && <input type="hidden" name="id" value={dept.id} />}
      <Field label="Name" name="name"><input className="input" id="name" name="name" defaultValue={dept?.name} required maxLength={120} /></Field>
      <Field label="Description" name="description"><textarea className="input" id="description" name="description" rows={2} defaultValue={dept?.description ?? ""} maxLength={1000} /></Field>
      <div>
        <p className="label">Brands this department can access</p>
        {brands.length === 0 ? <Empty>No brands yet.</Empty> : (
          <div className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-2">
            {brands.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="brand_ids" value={b.id} defaultChecked={linked.includes(b.id)} className="h-4 w-4" /> {b.name}</label>
            ))}
          </div>
        )}
      </div>
      <SubmitButton>{dept ? "Save department" : "Create department"}</SubmitButton>
    </ActionForm>
  );
}
