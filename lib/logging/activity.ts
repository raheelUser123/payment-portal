import "server-only";
import { sql } from "../db";
import { redact } from "./redact";

export type ActivityInput = {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  description?: string;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
};

/** Human-readable activity feed (who did what). Never throws. */
export async function logActivity(input: ActivityInput): Promise<void> {
  try {
    await sql`
      insert into activity_logs (user_id, action, entity_type, entity_id, description, ip, user_agent, metadata)
      values (${input.userId ?? null}, ${input.action}, ${input.entityType ?? null}, ${input.entityId ?? null},
              ${input.description ?? null}, ${input.ip ?? null}, ${input.userAgent ?? null},
              ${sql.json(redact(input.metadata ?? {}) as never)})`;
  } catch (err) {
    console.error("[activity] failed", input.action, err);
  }
}
