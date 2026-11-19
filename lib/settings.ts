import "server-only";
import { sql } from "./db";

export type SecuritySettings = {
  enforce_2fa_for_sellers: boolean;
  max_failed_logins: number;
  lockout_minutes: number;
};
export type AlertSettings = { large_payment_minor: number; email_admins: boolean; slack_webhook_url: string | null };
export type ReminderSettings = { enabled: boolean; days_after_due: number[]; max_reminders: number };

type SettingsMap = { security: SecuritySettings; alerts: AlertSettings; reminders: ReminderSettings };

const DEFAULTS: SettingsMap = {
  security: { enforce_2fa_for_sellers: true, max_failed_logins: 5, lockout_minutes: 15 },
  alerts: { large_payment_minor: 500000, email_admins: true, slack_webhook_url: null },
  reminders: { enabled: true, days_after_due: [1, 3, 7], max_reminders: 3 },
};

export async function getSetting<K extends keyof SettingsMap>(key: K): Promise<SettingsMap[K]> {
  const [row] = await sql<{ value: SettingsMap[K] }[]>`select value from settings where key = ${key}`;
  return { ...DEFAULTS[key], ...(row?.value ?? {}) };
}

export async function setSetting<K extends keyof SettingsMap>(key: K, value: SettingsMap[K], userId: string) {
  await sql`
    insert into settings (key, value, updated_by, updated_at)
    values (${key}, ${sql.json(value as never)}, ${userId}, now())
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
}
