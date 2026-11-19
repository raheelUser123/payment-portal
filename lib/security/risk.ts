import "server-only";
import { sql } from "../db";

export type RiskResult = { score: number; reasons: string[] };

/** Heuristic risk scoring for a successful password login. */
export async function assessLogin(userId: string, email: string, ip: string | null, userAgent: string | null): Promise<RiskResult> {
  const reasons: string[] = [];
  let score = 0;

  const [{ prior_success, seen_ip, seen_ua }] = await sql<{ prior_success: number; seen_ip: boolean; seen_ua: boolean }[]>`
    select count(*)::int as prior_success,
           coalesce(bool_or(ip = ${ip}::inet), false) as seen_ip,
           coalesce(bool_or(user_agent = ${userAgent}), false) as seen_ua
      from login_attempts
     where user_id = ${userId} and success and created_at > now() - interval '90 days'`;

  if (prior_success > 0 && ip && !seen_ip) { score += 30; reasons.push("new_ip"); }
  if (prior_success > 0 && userAgent && !seen_ua) { score += 20; reasons.push("new_device"); }

  const [{ fails }] = await sql<{ fails: number }[]>`
    select count(*)::int as fails from login_attempts
     where email = ${email} and not success and created_at > now() - interval '1 hour'`;
  if (fails >= 3) { score += 25; reasons.push(`recent_failed_attempts:${fails}`); }

  if (ip) {
    const [{ accounts }] = await sql<{ accounts: number }[]>`
      select count(distinct email)::int as accounts from login_attempts
       where ip = ${ip}::inet and created_at > now() - interval '1 hour'`;
    if (accounts >= 4) { score += 30; reasons.push(`ip_tried_many_accounts:${accounts}`); }
  }

  return { score: Math.min(score, 100), reasons };
}

/** Risk scoring for a payment attempt on the public pay page. */
export async function assessPaymentAttempt(invoiceId: string, ip: string | null, amountMinor: number, largeThresholdMinor: number): Promise<RiskResult> {
  const reasons: string[] = [];
  let score = 0;
  if (amountMinor >= largeThresholdMinor) { score += 20; reasons.push("large_amount"); }

  const [{ failed_invoice }] = await sql<{ failed_invoice: number }[]>`
    select count(*)::int as failed_invoice from payments
     where invoice_id = ${invoiceId} and status = 'failed' and created_at > now() - interval '1 day'`;
  if (failed_invoice >= 3) { score += 30; reasons.push(`invoice_failed_attempts:${failed_invoice}`); }

  if (ip) {
    const [{ failed_ip, invoices_ip }] = await sql<{ failed_ip: number; invoices_ip: number }[]>`
      select count(*) filter (where status = 'failed')::int as failed_ip,
             count(distinct invoice_id)::int as invoices_ip
        from payments where ip = ${ip}::inet and created_at > now() - interval '1 day'`;
    if (failed_ip >= 5) { score += 35; reasons.push(`ip_failed_payments:${failed_ip}`); }
    if (invoices_ip >= 5) { score += 25; reasons.push(`ip_many_invoices:${invoices_ip}`); }
  }
  return { score: Math.min(score, 100), reasons };
}
