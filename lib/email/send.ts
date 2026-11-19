import "server-only";
import { sql } from "../db";
import { renderSubject, renderTemplate, htmlToText, type TemplateVars } from "./render";
import { decryptBrandEmailConfig, formatFrom, sendViaSmtp, type OutgoingMail, type SendResult } from "./transport";
import type { BrandRow } from "../types";

export type TemplateType = "invoice" | "reminder" | "receipt" | "payment_failed" | "refund";

/** Brand template if present/active, else global default. */
export async function getTemplate(brandId: string, type: TemplateType) {
  const [t] = await sql<{ subject: string; html: string; brand_id: string | null }[]>`
    select subject, html, brand_id from email_templates
     where type = ${type} and is_active and (brand_id = ${brandId} or brand_id is null)
     order by brand_id nulls last limit 1`;
  if (!t) throw new Error(`No email template for ${type}`);
  return t;
}

export function brandVars(brand: BrandRow): TemplateVars {
  return {
    brand_name: brand.name,
    brand_logo_url: brand.logo_url,
    brand_color: brand.primary_color,
    brand_website: brand.website_url,
    support_email: brand.support_email,
    support_phone: brand.support_phone,
    year: new Date().getFullYear(),
  };
}

export async function deliverBrandMail(brand: BrandRow, mail: Omit<OutgoingMail, "from" | "replyTo" | "bcc">): Promise<SendResult> {
  if (brand.email_provider === "none" || !brand.from_email) return { ok: false, error: "Brand email is not configured" };
  const cfg = decryptBrandEmailConfig(brand.email_config_enc);
  const full: OutgoingMail = {
    ...mail,
    from: formatFrom(brand.from_name ?? brand.name, brand.from_email),
    replyTo: brand.reply_to ?? brand.support_email,
    bcc: brand.bcc_email,
  };
  if (brand.email_provider === "smtp" && cfg.smtp) return sendViaSmtp(cfg.smtp, full);
  return { ok: false, error: "Brand email credentials missing" };
}

/** Render a brand template with variables, send it and log the result. */
export async function sendTemplatedEmail(opts: {
  brand: BrandRow;
  type: TemplateType;
  to: string;
  vars: TemplateVars;
  invoiceId?: string | null;
  sentBy?: string | null;
}): Promise<SendResult> {
  const tpl = await getTemplate(opts.brand.id, opts.type);
  const vars = { ...brandVars(opts.brand), ...opts.vars };
  const subject = renderSubject(tpl.subject, vars);
  const html = renderTemplate(tpl.html, vars);
  const result = await deliverBrandMail(opts.brand, {
    to: opts.to,
    subject,
    html,
    text: htmlToText(html),
    headers: opts.invoiceId ? { "X-Entity-Ref-ID": opts.invoiceId } : undefined,
  });
  await sql`
    insert into email_logs (brand_id, invoice_id, template_type, to_email, subject, status, provider_message_id, error, sent_by)
    values (${opts.brand.id}, ${opts.invoiceId ?? null}, ${opts.type}, ${opts.to}, ${subject},
            ${result.ok ? "sent" : "failed"}, ${result.ok ? result.messageId : null}, ${result.ok ? null : result.error},
            ${opts.sentBy ?? null})`;
  return result;
}
