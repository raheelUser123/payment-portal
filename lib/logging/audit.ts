import "server-only";
import { sql } from "../db";
import { redact } from "./redact";

export type Actor =
  | { type: "user"; id: string; label?: string }
  | { type: "api_key"; id: string; label?: string }
  | { type: "webhook"; id?: string; label?: string }
  | { type: "public"; id?: string; label?: string }
  | { type: "system"; id?: string; label?: string };

export type AuditInput = {
  actor: Actor;
  action: string;
  entityType?: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  riskScore?: number;
  reasons?: string[];
};

/**
 * Append to the tamper-evident audit trail (hash-chained in Postgres).
 * Never throws — auditing must not break the business operation, but failures
 * are reported to the server log.
 */
export async function audit(input: AuditInput): Promise<void> {
  const risk = Math.max(0, Math.min(100, Math.round(input.riskScore ?? 0)));
  const reasons = input.reasons ?? [];
  try {
    await sql`
      insert into audit_logs (actor_type, actor_id, actor_label, action, entity_type, entity_id,
                              before_data, after_data, ip, user_agent, risk_score, is_suspicious, reasons)
      values (${input.actor.type}, ${input.actor.id ?? null}, ${input.actor.label ?? null}, ${input.action},
              ${input.entityType ?? null}, ${input.entityId ?? null},
              ${input.before === undefined ? null : sql.json(redact(input.before) as never)},
              ${input.after === undefined ? null : sql.json(redact(input.after) as never)},
              ${input.ip ?? null}, ${input.userAgent ?? null}, ${risk}, ${risk >= 50 || reasons.length > 0 && risk >= 30},
              ${reasons})`;
  } catch (err) {
    console.error("[audit] failed to write audit log", input.action, err);
  }
}
