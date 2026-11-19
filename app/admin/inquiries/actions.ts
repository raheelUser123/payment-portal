"use server";

import type { ActionResult } from "@/lib/actions";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "@/lib/db";
import { accessibleBrandIds, ForbiddenError, requireUser } from "@/lib/auth/guard";
import { formObject, safeAction, UserError } from "@/lib/actions";
import { track } from "../users/track";

const updateInquiryActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  const d = z.object({
    id: z.uuid(),
    status: z.enum(["new", "contacted", "converted", "closed"]),
    assigned_to: z.string().trim().transform((v) => (v === "" ? null : v)).pipe(z.uuid().nullable()),
  }).parse(formObject(fd));
  const [before] = await sql<{ brand_id: string | null; status: string; assigned_to: string | null }[]>`select brand_id, status, assigned_to from inquiries where id = ${d.id}`;
  if (!before) throw new UserError("Inquiry not found.");
  const ids = await accessibleBrandIds(s);
  if (ids !== null && (!before.brand_id || !ids.includes(before.brand_id))) throw new ForbiddenError();
  // sellers may only assign to themselves or unassign
  const assignee = s.user.role === "admin" ? d.assigned_to : d.assigned_to && d.assigned_to !== s.user.id ? before.assigned_to : d.assigned_to;
  if (assignee) {
    const [u] = await sql`select 1 from users where id = ${assignee} and is_active`;
    if (!u) throw new UserError("Assignee not found.");
  }
  await sql`update inquiries set status = ${d.status}, assigned_to = ${assignee} where id = ${d.id}`;
  await track(s, "inquiry.update", { entityType: "inquiry", entityId: d.id, description: `Inquiry marked ${d.status}`, before: { status: before.status, assigned_to: before.assigned_to }, after: { status: d.status, assigned_to: assignee } });
  revalidatePath("/admin/inquiries");
  return { ok: true, message: "Saved." };
});

export async function updateInquiryAction(prev: ActionResult | null, fd: FormData) {
  return updateInquiryActionImpl(prev, fd);
}
