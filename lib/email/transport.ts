import "server-only";
import nodemailer from "nodemailer";
import { decryptJson } from "../crypto/aes";

export type SmtpConfig = { host: string; port: number; secure: boolean; user: string; pass: string };
export type BrandEmailConfig = { smtp?: SmtpConfig };

export const EMAIL_CONFIG_CONTEXT = "brand.email_config";

export type OutgoingMail = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  bcc?: string | null;
  headers?: Record<string, string>;
};

export type SendResult = { ok: true; messageId: string | null } | { ok: false; error: string };

export async function sendViaSmtp(cfg: SmtpConfig, mail: OutgoingMail): Promise<SendResult> {
  // Port 465 always means implicit TLS; 587/2525 use STARTTLS.
  const secure = cfg.secure || cfg.port === 465;
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure,
    auth: { user: cfg.user, pass: cfg.pass },
    requireTLS: !secure,
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  try {
    const info = await transporter.sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      replyTo: mail.replyTo ?? undefined,
      bcc: mail.bcc ?? undefined,
      headers: mail.headers,
    });
    return { ok: true, messageId: info.messageId ?? null };
  } catch (err) {
    return { ok: false, error: explainSmtpError((err as Error).message).slice(0, 500) };
  }
}

/** Add a plain-English hint to common SMTP failures. */
function explainSmtpError(msg: string): string {
  if (/Greeting never received|wrong version number|ECONNRESET/i.test(msg))
    return `${msg} — check the port/TLS pair: use 465 with "Implicit TLS" ticked, or 587 with it unticked.`;
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(msg))
    return `${msg} — the SMTP host or port can't be reached. Check the host name; port 25 is blocked on Vercel, use 465 or 587.`;
  if (/Invalid login|535|authentication/i.test(msg))
    return `${msg} — wrong SMTP username or password (some providers need an app password).`;
  return msg;
}

export function decryptBrandEmailConfig(enc: string | null): BrandEmailConfig {
  if (!enc) return {};
  return decryptJson<BrandEmailConfig>(enc, EMAIL_CONFIG_CONTEXT);
}

/** Format a safe RFC 5322 From header. */
export function formatFrom(name: string | null | undefined, email: string): string {
  const clean = (name ?? "").replace(/["\r\n<>]/g, "").trim();
  return clean ? `"${clean}" <${email}>` : email;
}

/** System mail (security alerts to admins) via SYSTEM_SMTP_URL. */
export async function sendSystemMail(to: string[], subject: string, html: string): Promise<void> {
  const from = process.env.SYSTEM_FROM_EMAIL;
  if (!from || to.length === 0) return;
  const text = html.replace(/<[^>]+>/g, " ");
  for (const recipient of to) {
    const mail: OutgoingMail = { from, to: recipient, subject: subject.replace(/[\r\n]/g, " "), html, text };
    if (process.env.SYSTEM_SMTP_URL) {
      const u = new URL(process.env.SYSTEM_SMTP_URL);
      await sendViaSmtp(
        {
          host: u.hostname,
          port: Number(u.port || (u.protocol === "smtps:" ? 465 : 587)),
          secure: u.protocol === "smtps:",
          user: decodeURIComponent(u.username),
          pass: decodeURIComponent(u.password),
        },
        mail,
      );
    }
  }
}
