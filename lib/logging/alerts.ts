import "server-only";
import { sql } from "../db";
import { getSetting } from "../settings";
import { sendSystemMail } from "../email/transport";
import { escapeHtml } from "../email/render";

export type AlertInput = {
  severity: "info" | "warning" | "critical";
  type: string;
  title: string;
  message?: string;
  entityType?: string;
  entityId?: string | null;
  userId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Raise an alert: stored for the dashboard bell, and for warning/critical
 * also pushed to Slack/Discord webhook + emailed to admins (if configured).
 * Never throws.
 */
export async function raiseAlert(input: AlertInput): Promise<void> {
  try {
    await sql`
      insert into alerts (severity, type, title, message, entity_type, entity_id, user_id, metadata)
      values (${input.severity}, ${input.type}, ${input.title}, ${input.message ?? null},
              ${input.entityType ?? null}, ${input.entityId ?? null}, ${input.userId ?? null},
              ${sql.json((input.metadata ?? {}) as never)})`;
    if (input.severity === "info") return;

    const cfg = await getSetting("alerts");
    const tasks: Promise<unknown>[] = [];
    if (cfg.slack_webhook_url && /^https:\/\//.test(cfg.slack_webhook_url)) {
      const text = `${input.severity === "critical" ? "🚨" : "⚠️"} *${input.title}*\n${input.message ?? ""}`;
      tasks.push(
        fetch(cfg.slack_webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // "text" works for Slack, "content" for Discord
          body: JSON.stringify({ text, content: text }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => undefined),
      );
    }
    if (cfg.email_admins) {
      const admins = await sql<{ email: string }[]>`select email from users where role = 'admin' and is_active`;
      tasks.push(
        sendSystemMail(
          admins.map((a) => a.email),
          `[${input.severity.toUpperCase()}] ${input.title}`,
          `<h2>${escapeHtml(input.title)}</h2><p>${escapeHtml(input.message ?? "")}</p><p>Type: ${escapeHtml(input.type)}</p>`,
        ).catch(() => undefined),
      );
    }
    await Promise.all(tasks);
  } catch (err) {
    console.error("[alerts] failed", input.type, err);
  }
}
