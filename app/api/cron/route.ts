import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { safeEqual } from "@/lib/crypto/tokens";
import { getSetting } from "@/lib/settings";
import { sendInvoiceEmail } from "@/lib/invoices/service";
import { retryDueDeliveries } from "@/lib/webhooks/outbound";
import { raiseAlert } from "@/lib/logging/alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled maintenance (Vercel Cron / any scheduler, every 15–60 min):
 *   Authorization: Bearer <CRON_SECRET>
 * - overdue reminders, webhook retries, data retention cleanup, audit chain verification
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return new NextResponse("Unauthorized", { status: 401 });

  const out: Record<string, unknown> = {};
  const rem = await getSetting("reminders");
  if (rem.enabled) {
    const days = rem.days_after_due.length ? rem.days_after_due : [1];
    const due = await sql<{ id: string }[]>`
      select id from invoices
       where status = 'open' and due_date is not null and sent_at is not null
         and reminder_count < ${rem.max_reminders}
         and (current_date - due_date) >= (${days}::int[])[least(reminder_count + 1, ${days.length})]
         and (last_reminder_at is null or last_reminder_at < now() - interval '20 hours')
       limit 100`;
    let sent = 0;
    for (const inv of due) if ((await sendInvoiceEmail(inv.id, "reminder", null).catch(() => ({ ok: false }))).ok) sent++;
    out.reminders = sent;
  }
  out.webhookRetries = await retryDueDeliveries();

  await sql`delete from rate_limits where window_start < now() - interval '1 day'`;
  await sql`delete from api_nonces where created_at < now() - interval '1 hour'`;
  await sql`delete from login_attempts where created_at < now() - interval '180 days'`;

  const [{ broken }] = await sql<{ broken: number | null }[]>`select audit_logs_verify() as broken`;
  out.auditChainIntact = broken === null;
  if (broken !== null) {
    await raiseAlert({ severity: "critical", type: "audit_tamper", title: "Audit log chain broken", message: `First invalid row id ${broken}. Audit data may have been tampered with.` });
  }
  return NextResponse.json({ ok: true, ...out });
}
