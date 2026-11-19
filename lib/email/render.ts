/**
 * Tiny, safe, logic-less template renderer (mustache subset).
 *   {{var}}                  HTML-escaped value
 *   {{#var}}...{{/var}}      section rendered when var is truthy
 *   {{^var}}...{{/var}}      section rendered when var is falsy
 * Unknown variables render as empty strings. No code execution is possible.
 */
export type TemplateVars = Record<string, string | number | null | undefined>;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const SECTION = /\{\{([#^])\s*([a-z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/gi;
const VAR = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

function truthy(v: unknown) {
  return v !== undefined && v !== null && v !== "" && v !== 0 && v !== "0";
}

export function renderTemplate(tpl: string, vars: TemplateVars, opts: { escape?: boolean } = {}): string {
  const escape = opts.escape ?? true;
  let out = tpl;
  // resolve sections repeatedly to support nesting
  for (let i = 0; i < 5; i++) {
    const next = out.replace(SECTION, (_m, kind: string, name: string, body: string) => {
      const show = kind === "#" ? truthy(vars[name.toLowerCase()]) : !truthy(vars[name.toLowerCase()]);
      return show ? body : "";
    });
    if (next === out) break;
    out = next;
  }
  return out.replace(VAR, (_m, name: string) => {
    const v = vars[name.toLowerCase()];
    if (v === undefined || v === null) return "";
    return escape ? escapeHtml(String(v)) : String(v);
  });
}

/** Subjects are plain text: no escaping, but strip CR/LF to prevent header injection. */
export function renderSubject(tpl: string, vars: TemplateVars): string {
  return renderTemplate(tpl, vars, { escape: false }).replace(/[\r\n]+/g, " ").trim().slice(0, 300);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&copy;/g, "©")
    .replace(/&middot;/g, "·")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export const TEMPLATE_VARIABLES = [
  "customer_name", "customer_email", "invoice_number", "invoice_title", "invoice_amount", "amount_due",
  "currency", "due_date", "pay_url", "memo", "brand_name", "brand_logo_url", "brand_color",
  "brand_website", "support_email", "support_phone", "paid_amount", "paid_date", "refund_amount",
  "card_last4", "failure_reason", "year",
] as const;
