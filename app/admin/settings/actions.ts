"use server";

import type { ActionResult } from "@/lib/actions";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin, requireUser } from "@/lib/auth/guard";
import { getSetting, setSetting } from "@/lib/settings";
import { toMinor } from "@/lib/payments/money";
import { raiseAlert } from "@/lib/logging/alerts";
import { formObject, safeAction, UserError } from "@/lib/actions";
import { track } from "../users/track";

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const checkbox = (v: unknown) => v === "on" || v === "true";

const saveSecurityActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const o = formObject(fd);
  const next = {
    enforce_2fa_for_sellers: checkbox(o.enforce_2fa_for_sellers),
    ...z.object({ max_failed_logins: int(3, 20), lockout_minutes: int(5, 1440) }).parse(o),
  };
  const before = await getSetting("security");
  await setSetting("security", next, s.user.id);
  const weakened = (before.enforce_2fa_for_sellers && !next.enforce_2fa_for_sellers) || next.max_failed_logins > before.max_failed_logins;
  await track(s, "settings.security_update", { entityType: "settings", entityId: "security", description: "Updated security settings", before, after: next, riskScore: weakened ? 50 : 20, reasons: weakened ? ["security_policy_weakened"] : [] });
  await raiseAlert({ severity: "warning", type: "security_settings_changed", title: `Security settings changed by ${s.user.email}`,
    message: weakened ? "Policy was weakened (2FA enforcement / lockout / session length)." : "Security policy updated.", userId: s.user.id, metadata: { before, after: next } });
  revalidatePath("/admin/settings");
  return { ok: true, message: "Security settings saved." };
});

const saveAlertsActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const o = formObject(fd);
  let large: number;
  try {
    large = toMinor(String(o.large_payment ?? "0"), "USD");
  } catch {
    throw new UserError("Large payment threshold must be a valid amount, e.g. 5000.00");
  }
  if (large <= 0) throw new UserError("Large payment threshold must be greater than zero.");
  const url = String(o.slack_webhook_url ?? "").trim();
  if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new UserError("Slack/Discord webhook URL must start with https://");
  if (url) z.url().parse(url);
  const next = { large_payment_minor: large, email_admins: checkbox(o.email_admins), slack_webhook_url: url || null };
  const before = await getSetting("alerts");
  await setSetting("alerts", next, s.user.id);
  await track(s, "settings.alerts_update", { entityType: "settings", entityId: "alerts", description: "Updated alert settings", before, after: next });
  revalidatePath("/admin/settings");
  return { ok: true, message: "Alert settings saved." };
});

const saveRemindersActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const o = formObject(fd);
  const days = String(o.days_after_due ?? "").split(/[,\s]+/).filter(Boolean).map((d) => Number(d));
  if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 365)) throw new UserError("Days after due must be a list of whole numbers 0–365, e.g. 1, 3, 7");
  const next = { enabled: checkbox(o.enabled), days_after_due: [...new Set(days)].sort((a, b) => a - b), max_reminders: z.coerce.number().int().min(0).max(20).parse(o.max_reminders) };
  const before = await getSetting("reminders");
  await setSetting("reminders", next, s.user.id);
  await track(s, "settings.reminders_update", { entityType: "settings", entityId: "reminders", description: "Updated reminder settings", before, after: next });
  revalidatePath("/admin/settings");
  return { ok: true, message: "Reminder settings saved." };
});

export async function saveSecurityAction(prev: ActionResult | null, fd: FormData) {
  return saveSecurityActionImpl(prev, fd);
}

export async function saveAlertsAction(prev: ActionResult | null, fd: FormData) {
  return saveAlertsActionImpl(prev, fd);
}

export async function saveRemindersAction(prev: ActionResult | null, fd: FormData) {
  return saveRemindersActionImpl(prev, fd);
}
