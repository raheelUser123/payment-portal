import { requireAdmin } from "@/lib/auth/guard";
import { getSetting } from "@/lib/settings";
import { toDecimalString } from "@/lib/payments/money";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, PageHeader } from "@/components/ui";
import { saveAlertsAction, saveRemindersAction, saveSecurityAction } from "./actions";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireAdmin();
  const [security, alerts, reminders] = await Promise.all([getSetting("security"), getSetting("alerts"), getSetting("reminders")]);
  return (
    <>
      <PageHeader title="Settings" description="Platform-wide security, alerting and reminder policies. Every change is audited." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Security policy">
          <ActionForm action={saveSecurityAction} className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="enforce_2fa_for_sellers" defaultChecked={security.enforce_2fa_for_sellers} /> Require 2FA for sellers (always required for admins)
            </label>
            <p className="text-xs text-slate-500 sm:col-span-2">Session lifetime and inactivity timeout are set in Supabase → Authentication → Sessions.</p>
            <Field label="Failed logins before lockout" name="max_failed_logins"><input className="input" id="max_failed_logins" name="max_failed_logins" type="number" min={3} max={20} defaultValue={security.max_failed_logins} required /></Field>
            <Field label="Lockout duration (minutes)" name="lockout_minutes"><input className="input" id="lockout_minutes" name="lockout_minutes" type="number" min={5} max={1440} defaultValue={security.lockout_minutes} required /></Field>
            <div className="sm:col-span-2"><SubmitButton>Save security policy</SubmitButton></div>
          </ActionForm>
        </Card>

        <Card title="Alerts">
          <ActionForm action={saveAlertsAction} className="space-y-4">
            <Field label="Large payment threshold (USD-equivalent minor units, entered as amount)" name="large_payment" hint="Payments at or above this raise a warning alert and add risk score at checkout.">
              <input className="input" id="large_payment" name="large_payment" inputMode="decimal" defaultValue={toDecimalString(alerts.large_payment_minor, "USD")} required />
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="email_admins" defaultChecked={alerts.email_admins} /> Email warning/critical alerts to all admins (needs SYSTEM_FROM_EMAIL + SYSTEM_SMTP_URL env)</label>
            <Field label="Slack / Discord incoming webhook URL (optional)" name="slack_webhook_url">
              <input className="input" id="slack_webhook_url" name="slack_webhook_url" type="url" defaultValue={alerts.slack_webhook_url ?? ""} placeholder="https://hooks.slack.com/services/..." />
            </Field>
            <SubmitButton>Save alert settings</SubmitButton>
          </ActionForm>
        </Card>

        <Card title="Invoice reminders">
          <ActionForm action={saveRemindersAction} className="space-y-4">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={reminders.enabled} /> Send automatic overdue reminders (via the cron job)</label>
            <Field label="Days after due date" name="days_after_due" hint="Comma separated. Reminder N is sent once this many days have passed since the due date.">
              <input className="input" id="days_after_due" name="days_after_due" defaultValue={reminders.days_after_due.join(", ")} required />
            </Field>
            <Field label="Maximum reminders per invoice" name="max_reminders"><input className="input" id="max_reminders" name="max_reminders" type="number" min={0} max={20} defaultValue={reminders.max_reminders} required /></Field>
            <SubmitButton>Save reminder settings</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
