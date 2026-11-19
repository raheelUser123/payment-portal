"use server";

import type { ActionResult } from "@/lib/actions";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "@/lib/db";
import { assertBrandAccess, requireUser } from "@/lib/auth/guard";
import { formObject, safeAction, UserError } from "@/lib/actions";
import { track } from "../users/track";

const opt = (max: number) => z.string().trim().max(max).transform((v) => (v === "" ? null : v));

const updateCustomerActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  const d = z.object({
    id: z.uuid(), name: z.string().trim().min(1).max(200), phone: opt(40), company: opt(200), address: opt(1000), notes: opt(5000),
  }).parse(formObject(fd));
  const [before] = await sql<{ brand_id: string; name: string; phone: string | null; company: string | null; address: string | null; notes: string | null }[]>`
    select brand_id, name, phone, company, address, notes from customers where id = ${d.id}`;
  if (!before) throw new UserError("Customer not found.");
  await assertBrandAccess(s, before.brand_id);
  await sql`update customers set name = ${d.name}, phone = ${d.phone}, company = ${d.company}, address = ${d.address}, notes = ${d.notes} where id = ${d.id}`;
  const { brand_id: _b, ...prev } = before;
  await track(s, "customer.update", { entityType: "customer", entityId: d.id, description: `Updated customer ${d.name}`, before: prev, after: { name: d.name, phone: d.phone, company: d.company, address: d.address, notes: d.notes } });
  revalidatePath(`/admin/customers/${d.id}`);
  return { ok: true, message: "Customer updated." };
});

export async function updateCustomerAction(prev: ActionResult | null, fd: FormData) {
  return updateCustomerActionImpl(prev, fd);
}
