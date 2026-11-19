"use server";

import type { ActionResult } from "@/lib/actions";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth/guard";
import { formObject, safeAction } from "@/lib/actions";
import { track } from "../users/track";

const ackAlertActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const { id } = z.object({ id: z.uuid() }).parse(formObject(fd));
  const [a] = await sql<{ title: string }[]>`update alerts set acknowledged_by = ${s.user.id}, acknowledged_at = now() where id = ${id} and acknowledged_at is null returning title`;
  if (a) await track(s, "alert.acknowledge", { entityType: "alert", entityId: id, description: `Acknowledged alert: ${a.title}` });
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Acknowledged." };
});

const ackAllAlertsActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const sev = String(fd.get("severity") ?? "");
  const severity = ["info", "warning", "critical"].includes(sev) ? sev : null;
  const res = await sql`update alerts set acknowledged_by = ${s.user.id}, acknowledged_at = now()
                         where acknowledged_at is null and (${severity}::text is null or severity = ${severity}::alert_severity)`;
  await track(s, "alert.acknowledge_all", { entityType: "alert", description: `Acknowledged ${res.count} alerts`, after: { count: res.count, severity } });
  revalidatePath("/admin", "layout");
  return { ok: true, message: `Acknowledged ${res.count} alerts.` };
});

export async function ackAlertAction(prev: ActionResult | null, fd: FormData) {
  return ackAlertActionImpl(prev, fd);
}

export async function ackAllAlertsAction(prev: ActionResult | null, fd: FormData) {
  return ackAllAlertsActionImpl(prev, fd);
}
