/**
 * Centralised, validated environment access. Read lazily so `next build`
 * works without secrets; any missing value fails loudly at first use.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required environment variable ${name}`);
  return v.trim();
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const env = {
  get databaseUrl() { return required("DATABASE_URL"); },
  get databaseSsl() { return optional("DATABASE_SSL") !== "disable"; },
  /** Admin panel base URL, e.g. https://portal.example.com */
  get appUrl() { return required("APP_URL").replace(/\/+$/, ""); },
  /** Hostnames allowed to serve the admin panel (comma separated). Defaults to APP_URL host. */
  get adminHosts(): string[] {
    const list = optional("ADMIN_HOSTS");
    const hosts = list ? list.split(",") : [new URL(this.appUrl).host];
    return hosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  },
  /** Supabase project URL, e.g. https://abcd.supabase.co */
  get supabaseUrl() { return required("SUPABASE_URL").replace(/\/+$/, ""); },
  /** Supabase anon / publishable key (used server-side only for Supabase Auth). */
  get supabaseAnonKey() { return required("SUPABASE_ANON_KEY"); },
  /** Supabase service_role / secret key (server-only: Auth admin API). */
  get supabaseServiceRoleKey() { return required("SUPABASE_SERVICE_ROLE_KEY"); },
  /** base64 32-byte key used for AES-256-GCM. */
  get encryptionKey() { return required("ENCRYPTION_KEY"); },
  /** Previous keys (comma separated) still accepted for decryption during rotation. */
  get encryptionKeysPrevious(): string[] {
    return (optional("ENCRYPTION_KEYS_PREVIOUS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  },
  /** Server-side pepper for hashing tokens (pay links, API keys). */
  get appSecret() { return required("APP_SECRET"); },
  get cronSecret() { return optional("CRON_SECRET"); },
  get setupToken() { return optional("SETUP_TOKEN"); },
  get isProduction() { return process.env.NODE_ENV === "production"; },
  /** System mail (security alerts to admins) via SMTP URL. */
  get systemSmtpUrl() { return optional("SYSTEM_SMTP_URL"); },
  get systemFromEmail() { return optional("SYSTEM_FROM_EMAIL"); },
};
