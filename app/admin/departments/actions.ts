"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { sql } from "@/lib/db";
import { requireUser, assertAdmin } from "@/lib/auth/guard";
import { safeAction, UserError, type ActionResult } from "@/lib/actions";
import { audit } from "@/lib/logging/audit";
import { logActivity } from "@/lib/logging/activity";
import { requestMeta } from "@/lib/security/request";

async function admin() {
  const s = await requireUser();
  assertAdmin(s);
  return { actor: { type: "user" as const, id: s.user.id, label: s.user.email }, meta: await requestMeta() };
}

const Schema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).transform((v) => v || null),
  brand_ids: z.array(z.uuid()),
});

function parse(fd: FormData) {
  return Schema.parse({ name: fd.get("name") ?? "", description: fd.get("description") ?? "", brand_ids: fd.getAll("brand_ids").map(String) });
}

function dup(e: unknown): never {
  if ((e as { code?: string })?.code === "23505") throw new UserError("A department with that name already exists.");
  throw e;
}

const _create = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const d = parse(fd);
  const id = await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`insert into departments (name, description) values (${d.name}, ${d.description}) returning id`;
    if (d.brand_ids.length) await tx`insert into department_brands ${tx(d.brand_ids.map((b) => ({ department_id: row.id, brand_id: b })))}`;
    return row.id;
  }).catch(dup);
  await audit({ actor, action: "department.create", entityType: "department", entityId: id, after: d, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: actor.id, action: "department.create", entityType: "department", entityId: id, description: `Created department ${d.name}`, ip: meta.ip });
  revalidatePath("/admin/departments");
  redirect("/admin/departments");
});
export async function createDepartment(p: ActionResult | null, fd: FormData) { return _create(p, fd); }

const _update = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const id = z.uuid().parse(fd.get("id"));
  const d = parse(fd);
  const [before] = await sql<{ name: string; description: string | null }[]>`select name, description from departments where id = ${id}`;
  if (!before) throw new UserError("Department not found");
  const beforeBrands = await sql<{ brand_id: string }[]>`select brand_id from department_brands where department_id = ${id}`;
  await sql.begin(async (tx) => {
    await tx`update departments set name = ${d.name}, description = ${d.description} where id = ${id}`;
    await tx`delete from department_brands where department_id = ${id}`;
    if (d.brand_ids.length) await tx`insert into department_brands ${tx(d.brand_ids.map((b) => ({ department_id: id, brand_id: b })))}`;
  }).catch(dup);
  await audit({ actor, action: "department.update", entityType: "department", entityId: id, before: { ...before, brand_ids: beforeBrands.map((b) => b.brand_id) }, after: d, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: actor.id, action: "department.update", entityType: "department", entityId: id, description: `Updated department ${d.name}`, ip: meta.ip });
  revalidatePath("/admin/departments");
  revalidatePath(`/admin/departments/${id}`);
  return { ok: true, message: "Department saved." };
});
export async function updateDepartment(p: ActionResult | null, fd: FormData) { return _update(p, fd); }

const _delete = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const id = z.uuid().parse(fd.get("id"));
  const [before] = await sql<{ name: string }[]>`select name from departments where id = ${id}`;
  if (!before) throw new UserError("Department not found");
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users where department_id = ${id}`;
  if (n > 0) throw new UserError(`Move the ${n} member(s) to another department first.`);
  await sql`delete from departments where id = ${id}`;
  await audit({ actor, action: "department.delete", entityType: "department", entityId: id, before, ip: meta.ip, userAgent: meta.userAgent, riskScore: 10 });
  await logActivity({ userId: actor.id, action: "department.delete", entityType: "department", entityId: id, description: `Deleted department ${before.name}`, ip: meta.ip });
  revalidatePath("/admin/departments");
  redirect("/admin/departments");
});
export async function deleteDepartment(p: ActionResult | null, fd: FormData) { return _delete(p, fd); }
