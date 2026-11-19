"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { sql } from "@/lib/db";
import { requireUser, assertAdmin } from "@/lib/auth/guard";
import { safeAction, formObject, zCheckbox, zEmptyToNull, zOptionalEmail, zOptionalUrl, UserError, type ActionResult } from "@/lib/actions";
import { audit } from "@/lib/logging/audit";
import { logActivity } from "@/lib/logging/activity";
import { requestMeta } from "@/lib/security/request";
import { encryptJson } from "@/lib/crypto/aes";
import { decryptBrandEmailConfig, EMAIL_CONFIG_CONTEXT, type BrandEmailConfig } from "@/lib/email/transport";
import { deliverBrandMail, brandVars } from "@/lib/email/send";
import { renderSubject, renderTemplate, htmlToText } from "@/lib/email/render";
import { CURRENCIES } from "@/lib/payments/money";
import type { BrandRow } from "@/lib/types";
import { SAMPLE_VARS } from "./sample";

async function admin() {
  const s = await requireUser();
  assertAdmin(s);
  return { s, actor: { type: "user" as const, id: s.user.id, label: s.user.email }, meta: await requestMeta() };
}

const GeneralSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, numbers and dashes"),
  website_url: zOptionalUrl,
  logo_url: zOptionalUrl,
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  support_email: zOptionalEmail,
  support_phone: zEmptyToNull.pipe(z.string().max(40).nullable()),
  address: zEmptyToNull.pipe(z.string().max(500).nullable()),
  footer_text: zEmptyToNull.pipe(z.string().max(500).nullable()),
  terms_url: zOptionalUrl,
  privacy_url: zOptionalUrl,
  invoice_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, "1-8 letters/numbers"),
  default_currency: z.enum(CURRENCIES),
  statement_descriptor_suffix: zEmptyToNull.pipe(z.string().regex(/^[A-Za-z0-9 .\-]{1,22}$/, "max 22 chars: letters, numbers, space . -").nullable()),
  is_active: zCheckbox,
});

async function uniqueCheck(e: unknown) {
  const msg = (e as { code?: string; constraint_name?: string })?.code === "23505" ? (e as { constraint_name?: string }).constraint_name : null;
  if (msg?.includes("slug")) throw new UserError("That slug is already used by another brand.");
  throw e;
}

const _create = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const d = GeneralSchema.parse(formObject(fd));
  const [b] = await sql<{ id: string }[]>`insert into brands ${sql(d)} returning id`.catch(uniqueCheck) as { id: string }[];
  await audit({ actor, action: "brand.create", entityType: "brand", entityId: b.id, after: d, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: actor.id, action: "brand.create", entityType: "brand", entityId: b.id, description: `Created brand ${d.name}`, ip: meta.ip });
  revalidatePath("/admin/brands");
  redirect(`/admin/brands/${b.id}`);
});
export async function createBrand(p: ActionResult | null, fd: FormData) { return _create(p, fd); }

const _general = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const id = z.uuid().parse(fd.get("id"));
  const d = GeneralSchema.parse(formObject(fd));
  const [before] = await sql<BrandRow[]>`select * from brands where id = ${id}`;
  if (!before) throw new UserError("Brand not found");
  await sql`update brands set ${sql(d)} where id = ${id}`.catch(uniqueCheck);
  await audit({ actor, action: "brand.update", entityType: "brand", entityId: id, before: pick(before, Object.keys(d)), after: d, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: actor.id, action: "brand.update", entityType: "brand", entityId: id, description: `Updated brand ${d.name}`, ip: meta.ip });
  revalidatePath(`/admin/brands/${id}`);
  revalidatePath("/admin/brands");
  return { ok: true, message: "Brand saved." };
});
export async function updateBrandGeneral(p: ActionResult | null, fd: FormData) { return _general(p, fd); }

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, o[k]]));
}

const EmailSchema = z.object({
  from_name: zEmptyToNull.pipe(z.string().max(120).nullable()),
  from_email: zOptionalEmail,
  reply_to: zOptionalEmail,
  bcc_email: zOptionalEmail,
  email_provider: z.enum(["none", "smtp"]),
  smtp_host: z.string().trim().max(255).optional().default(""),
  smtp_port: z.string().trim().optional().default(""),
  smtp_secure: zCheckbox,
  smtp_user: z.string().trim().max(255).optional().default(""),
  smtp_pass: z.string().max(500).optional().default(""),
});

const _email = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const id = z.uuid().parse(fd.get("id"));
  const d = EmailSchema.parse(formObject(fd));
  const [brand] = await sql<BrandRow[]>`select * from brands where id = ${id}`;
  if (!brand) throw new UserError("Brand not found");
  const cfg: BrandEmailConfig = decryptBrandEmailConfig(brand.email_config_enc);
  let secretChanged = false;

  if (d.email_provider === "smtp") {
    const host = d.smtp_host || cfg.smtp?.host || "";
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new UserError("Enter a valid SMTP host.");
    const port = Number(d.smtp_port || cfg.smtp?.port || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError("Invalid SMTP port.");
    const user = d.smtp_user || cfg.smtp?.user || "";
    const pass = d.smtp_pass || cfg.smtp?.pass || "";
    if (!user || !pass) throw new UserError("SMTP username and password are required.");
    secretChanged = !!d.smtp_pass || host !== cfg.smtp?.host || user !== cfg.smtp?.user;
    cfg.smtp = { host, port, secure: d.smtp_secure, user, pass };
  }
  if (d.email_provider !== "none" && !d.from_email) throw new UserError("From email is required to send mail.");

  const enc = cfg.smtp ? encryptJson({ smtp: cfg.smtp }, EMAIL_CONFIG_CONTEXT) : null;
  await sql`update brands set from_name = ${d.from_name}, from_email = ${d.from_email}, reply_to = ${d.reply_to}, bcc_email = ${d.bcc_email},
            email_provider = ${d.email_provider}, email_config_enc = ${enc} where id = ${id}`;
  await audit({
    actor, action: "brand.email_settings", entityType: "brand", entityId: id,
    before: { from_email: brand.from_email, email_provider: brand.email_provider },
    after: { from_email: d.from_email, email_provider: d.email_provider, secret_changed: secretChanged },
    ip: meta.ip, userAgent: meta.userAgent, riskScore: secretChanged ? 30 : 0, reasons: secretChanged ? ["email_credentials_changed"] : [],
  });
  await logActivity({ userId: actor.id, action: "brand.email_settings", entityType: "brand", entityId: id, description: `Updated email settings for ${brand.name}`, ip: meta.ip });
  revalidatePath(`/admin/brands/${id}`);
  return { ok: true, message: "Email settings saved." };
});
export async function updateBrandEmail(p: ActionResult | null, fd: FormData) { return _email(p, fd); }

const _test = safeAction(async (fd) => {
  const { s, actor, meta } = await admin();
  const id = z.uuid().parse(fd.get("id"));
  const [brand] = await sql<BrandRow[]>`select * from brands where id = ${id}`;
  if (!brand) throw new UserError("Brand not found");
  const html = `<div style="font-family:Arial,sans-serif;padding:24px"><h2 style="color:${brand.primary_color}">${brand.name}</h2><p>This is a test email from your payment portal. Email sending for this brand works.</p></div>`;
  const r = await deliverBrandMail(brand, { to: s.user.email, subject: `Test email — ${brand.name}`, html, text: htmlToText(html) });
  await logActivity({ userId: actor.id, action: "brand.test_email", entityType: "brand", entityId: id, description: `Test email ${r.ok ? "sent" : "failed"} for ${brand.name}`, ip: meta.ip });
  return r.ok ? { ok: true, message: `Test email sent to ${s.user.email}.` } : { ok: false, message: `Send failed: ${r.error}` };
});
export async function sendTestEmail(p: ActionResult | null, fd: FormData) { return _test(p, fd); }

const _addMerchant = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const brandId = z.uuid().parse(fd.get("brand_id"));
  const merchantId = z.uuid().parse(fd.get("merchant_id"));
  const priority = z.coerce.number().int().min(0).max(10000).parse(fd.get("priority") || 100);
  await sql`insert into brand_merchants (brand_id, merchant_id, priority) values (${brandId}, ${merchantId}, ${priority})
            on conflict (brand_id, merchant_id) do update set priority = excluded.priority, is_active = true`;
  await audit({ actor, action: "brand.merchant_link", entityType: "brand", entityId: brandId, after: { merchant_id: merchantId, priority }, ip: meta.ip, userAgent: meta.userAgent, riskScore: 20, reasons: ["payment_routing_changed"] });
  await logActivity({ userId: actor.id, action: "brand.merchant_link", entityType: "brand", entityId: brandId, description: "Linked merchant to brand", ip: meta.ip, metadata: { merchant_id: merchantId } });
  revalidatePath(`/admin/brands/${brandId}`);
  return { ok: true, message: "Merchant linked." };
});
export async function addBrandMerchant(p: ActionResult | null, fd: FormData) { return _addMerchant(p, fd); }

const _updMerchant = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const brandId = z.uuid().parse(fd.get("brand_id"));
  const merchantId = z.uuid().parse(fd.get("merchant_id"));
  const op = z.enum(["save", "remove"]).parse(fd.get("op"));
  if (op === "remove") {
    await sql`delete from brand_merchants where brand_id = ${brandId} and merchant_id = ${merchantId}`;
  } else {
    const priority = z.coerce.number().int().min(0).max(10000).parse(fd.get("priority") || 100);
    const active = fd.get("is_active") === "on";
    await sql`update brand_merchants set priority = ${priority}, is_active = ${active} where brand_id = ${brandId} and merchant_id = ${merchantId}`;
  }
  await audit({ actor, action: `brand.merchant_${op}`, entityType: "brand", entityId: brandId, after: { merchant_id: merchantId, priority: fd.get("priority"), is_active: fd.get("is_active") === "on" }, ip: meta.ip, userAgent: meta.userAgent, riskScore: 20, reasons: ["payment_routing_changed"] });
  await logActivity({ userId: actor.id, action: `brand.merchant_${op}`, entityType: "brand", entityId: brandId, description: op === "remove" ? "Unlinked merchant" : "Updated merchant routing", ip: meta.ip });
  revalidatePath(`/admin/brands/${brandId}`);
  return { ok: true, message: op === "remove" ? "Merchant removed." : "Saved." };
});
export async function updateBrandMerchant(p: ActionResult | null, fd: FormData) { return _updMerchant(p, fd); }

const _depts = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const brandId = z.uuid().parse(fd.get("brand_id"));
  const ids = z.array(z.uuid()).parse(fd.getAll("department_ids").map(String));
  const before = await sql<{ department_id: string }[]>`select department_id from department_brands where brand_id = ${brandId}`;
  await sql.begin(async (tx) => {
    await tx`delete from department_brands where brand_id = ${brandId}`;
    if (ids.length) await tx`insert into department_brands ${tx(ids.map((d) => ({ department_id: d, brand_id: brandId })))}`;
  });
  await audit({ actor, action: "brand.departments", entityType: "brand", entityId: brandId, before: before.map((b) => b.department_id), after: ids, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: actor.id, action: "brand.departments", entityType: "brand", entityId: brandId, description: "Updated brand department access", ip: meta.ip });
  revalidatePath(`/admin/brands/${brandId}`);
  return { ok: true, message: "Department access saved." };
});
export async function setBrandDepartments(p: ActionResult | null, fd: FormData) { return _depts(p, fd); }

const TYPES = ["invoice", "reminder", "receipt", "payment_failed", "refund"] as const;

const _saveTpl = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const brandId = z.union([z.uuid(), z.literal("")]).parse(fd.get("brand_id") ?? "") || null;
  const type = z.enum(TYPES).parse(fd.get("type"));
  const subject = z.string().trim().min(1).max(300).parse(fd.get("subject"));
  const html = z.string().min(1).max(200_000).parse(fd.get("html"));
  const isActive = fd.get("is_active") !== null ? fd.get("is_active") === "on" : true;
  const [existing] = brandId
    ? await sql<{ id: string; subject: string }[]>`select id, subject from email_templates where brand_id = ${brandId} and type = ${type}`
    : await sql<{ id: string; subject: string }[]>`select id, subject from email_templates where brand_id is null and type = ${type}`;
  if (existing) {
    await sql`update email_templates set subject = ${subject}, html = ${html}, is_active = ${isActive}, updated_by = ${actor.id} where id = ${existing.id}`;
  } else {
    await sql`insert into email_templates (brand_id, type, subject, html, is_active, updated_by) values (${brandId}, ${type}, ${subject}, ${html}, ${isActive}, ${actor.id})`;
  }
  await audit({ actor, action: "email_template.save", entityType: "email_template", entityId: `${brandId ?? "global"}:${type}`, before: existing ? { subject: existing.subject } : null, after: { subject, length: html.length }, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: actor.id, action: "email_template.save", entityType: "brand", entityId: brandId, description: `Saved ${type} template (${brandId ? "brand" : "global default"})`, ip: meta.ip });
  revalidatePath(brandId ? `/admin/brands/${brandId}/templates` : "/admin/brands/templates-default");
  return { ok: true, message: "Template saved." };
});
export async function saveTemplate(p: ActionResult | null, fd: FormData) { return _saveTpl(p, fd); }

const _resetTpl = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const brandId = z.uuid().parse(fd.get("brand_id"));
  const type = z.enum(TYPES).parse(fd.get("type"));
  await sql`delete from email_templates where brand_id = ${brandId} and type = ${type}`;
  await audit({ actor, action: "email_template.reset", entityType: "email_template", entityId: `${brandId}:${type}`, ip: meta.ip, userAgent: meta.userAgent });
  await logActivity({ userId: actor.id, action: "email_template.reset", entityType: "brand", entityId: brandId, description: `Reset ${type} template to default`, ip: meta.ip });
  revalidatePath(`/admin/brands/${brandId}/templates`);
  return { ok: true, message: "Reverted to the global default." };
});
export async function resetTemplate(p: ActionResult | null, fd: FormData) { return _resetTpl(p, fd); }

/** Render a preview (no DB writes). Returns rendered subject + html. */
export async function previewTemplate(brandId: string | null, subject: string, html: string): Promise<{ subject: string; html: string }> {
  const s = await requireUser();
  assertAdmin(s);
  let vars: Record<string, string | number | null | undefined> = { ...SAMPLE_VARS, brand_name: "Your Brand", brand_color: "#4f46e5", support_email: "support@example.com", year: new Date().getFullYear() };
  if (brandId) {
    const [brand] = await sql<BrandRow[]>`select * from brands where id = ${z.uuid().parse(brandId)}`;
    if (brand) vars = { ...SAMPLE_VARS, ...brandVars(brand) };
  }
  return { subject: renderSubject(subject.slice(0, 300), vars), html: renderTemplate(html.slice(0, 200_000), vars) };
}

// ---------- Payment subdomain per brand (e.g. pay.brand.com) ----------
const DomainSchema = z.object({
  id: z.uuid(),
  pay_domain: z.string().trim().toLowerCase()
    .transform((v) => v.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .pipe(z.string().regex(/^([a-z0-9-]+\.)+[a-z0-9-]+\.[a-z]{2,}$/, "Enter a subdomain like pay.yourbrand.com")),
});

/** Attach the subdomain to Vercel (if an API token is set), then check it serves this portal over HTTPS. */
async function connectAndCheck(brandId: string, domain: string) {
  const { verifyPayDomain } = await import("@/lib/brands/service");
  const { vercelConfigured, connectDomain } = await import("@/lib/vercel/domains");
  let vercelNote = "";
  if (vercelConfigured()) {
    const st = await connectDomain(domain);
    if (st.error && !st.added) vercelNote = ` Vercel: ${st.error}`;
  }
  const r = await verifyPayDomain(domain);
  const verifiedAt = r.ok ? new Date() : null;
  await sql`update brands set pay_domain = ${domain}, pay_domain_verified_at = ${verifiedAt} where id = ${brandId}`.catch((e) => {
    if ((e as { code?: string }).code === "23505") throw new UserError("That subdomain is already used by another brand.");
    throw e;
  });
  return { live: r.ok, message: r.ok
    ? `Connected! New payment links use https://${domain}/pay/… — use "Resend invoice" to send customers the new link.`
    : `Subdomain saved. Next: create the DNS record shown below at your domain provider, wait a few minutes, then click "Check again".${vercelNote}` };
}

const _payDomain = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const d = DomainSchema.parse(formObject(fd));
  const [before] = await sql<BrandRow[]>`select * from brands where id = ${d.id}`;
  if (!before) throw new UserError("Brand not found");
  if (before.pay_domain && before.pay_domain !== d.pay_domain) {
    const { vercelConfigured, disconnectDomain } = await import("@/lib/vercel/domains");
    if (vercelConfigured()) await disconnectDomain(before.pay_domain);
  }
  const r = await connectAndCheck(d.id, d.pay_domain);
  await audit({ actor, action: "brand.pay_domain", entityType: "brand", entityId: d.id, before: { pay_domain: before.pay_domain }, after: { pay_domain: d.pay_domain, live: r.live }, ip: meta.ip, userAgent: meta.userAgent, riskScore: 20 });
  await logActivity({ userId: actor.id, action: "brand.pay_domain", entityType: "brand", entityId: d.id, description: `Payment subdomain for ${before.name}: ${d.pay_domain}${r.live ? " (live)" : " (waiting for DNS)"}`, ip: meta.ip });
  revalidatePath(`/admin/brands/${d.id}`);
  revalidatePath("/admin/brands");
  return { ok: r.live, message: r.message };
});
export async function setPayDomain(p: ActionResult | null, fd: FormData) { return _payDomain(p, fd); }

const _checkDomain = safeAction(async (fd) => {
  await admin();
  const id = z.uuid().parse(fd.get("id"));
  const [b] = await sql<BrandRow[]>`select * from brands where id = ${id}`;
  if (!b?.pay_domain) throw new UserError("No subdomain set.");
  const r = await connectAndCheck(id, b.pay_domain);
  revalidatePath(`/admin/brands/${id}`);
  return { ok: r.live, message: r.message };
});
export async function checkPayDomain(p: ActionResult | null, fd: FormData) { return _checkDomain(p, fd); }

const _removeDomain = safeAction(async (fd) => {
  const { actor, meta } = await admin();
  const id = z.uuid().parse(fd.get("id"));
  const [b] = await sql<BrandRow[]>`select * from brands where id = ${id}`;
  if (!b) throw new UserError("Brand not found");
  if (b.pay_domain) {
    const { vercelConfigured, disconnectDomain } = await import("@/lib/vercel/domains");
    if (vercelConfigured()) await disconnectDomain(b.pay_domain);
  }
  await sql`update brands set pay_domain = null, pay_domain_verified_at = null where id = ${id}`;
  await audit({ actor, action: "brand.pay_domain_removed", entityType: "brand", entityId: id, before: { pay_domain: b.pay_domain }, ip: meta.ip, userAgent: meta.userAgent, riskScore: 20 });
  revalidatePath(`/admin/brands/${id}`);
  return { ok: true, message: "Subdomain disconnected. Payment links use the portal domain again." };
});
export async function removePayDomain(p: ActionResult | null, fd: FormData) { return _removeDomain(p, fd); }
