import { ActionForm, SubmitButton, type ActionResult } from "./action-form";
import { Card } from "./ui";

type Action = (p: ActionResult | null, fd: FormData) => Promise<ActionResult>;

/** Standard "Delete" box used on detail pages. Shows why deletion is blocked, if it is. */
export function DangerZone({
  title = "Delete", description, action, id, label = "Delete", confirm, blockedReason,
}: {
  title?: string;
  description: string;
  action: Action;
  id: string;
  label?: string;
  confirm: string;
  blockedReason?: string | null;
}) {
  return (
    <Card title={title} className="border-rose-200">
      <p className="mb-3 text-sm text-slate-600">{description}</p>
      {blockedReason ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{blockedReason}</p>
      ) : (
        <ActionForm action={action} confirm={confirm}>
          <input type="hidden" name="id" value={id} />
          <SubmitButton className="btn-danger w-full" pendingText="Deleting…">{label}</SubmitButton>
        </ActionForm>
      )}
    </Card>
  );
}
