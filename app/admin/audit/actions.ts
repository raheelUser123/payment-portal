"use server";

import type { ActionResult } from "@/lib/actions";

import { sql } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth/guard";
import { raiseAlert } from "@/lib/logging/alerts";
import { safeAction } from "@/lib/actions";
import { track } from "../users/track";

const verifyAuditChainActionImpl = safeAction(async () => {
  const s = await requireUser();
  assertAdmin(s);
  const [{ broken, total }] = await sql<{ broken: number | null; total: number }[]>`select audit_logs_verify() as broken, (select count(*)::int from audit_logs) as total`;
  await track(s, "audit.verify", { entityType: "audit_logs", description: broken === null ? "Audit chain verified intact" : `Audit chain broken at ${broken}`, after: { broken, total } });
  if (broken !== null) {
    await raiseAlert({ severity: "critical", type: "audit_tamper", title: "Audit log chain broken", message: `First invalid row id ${broken}.`, userId: s.user.id });
    return { ok: false, message: `Integrity check FAILED: first tampered/invalid row is #${broken}. Investigate immediately.` };
  }
  return { ok: true, message: `Integrity verified: all ${total} entries are intact and correctly chained.` };
});

export async function verifyAuditChainAction(prev: ActionResult | null, fd: FormData) {
  return verifyAuditChainActionImpl(prev, fd);
}
