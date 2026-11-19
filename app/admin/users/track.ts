import "server-only";
import { audit } from "@/lib/logging/audit";
import { logActivity } from "@/lib/logging/activity";
import { requestMeta } from "@/lib/security/request";
import type { SessionInfo } from "@/lib/auth/session";

/** Shared helper for admin sections: write audit trail + activity feed for a user action. */
export async function track(
  s: SessionInfo,
  action: string,
  opts: { entityType?: string; entityId?: string | null; description?: string; before?: unknown; after?: unknown; riskScore?: number; reasons?: string[] } = {},
) {
  const meta = await requestMeta();
  await audit({
    actor: { type: "user", id: s.user.id, label: s.user.email },
    action,
    entityType: opts.entityType,
    entityId: opts.entityId ?? null,
    before: opts.before,
    after: opts.after,
    ip: meta.ip,
    userAgent: meta.userAgent,
    riskScore: opts.riskScore,
    reasons: opts.reasons,
  });
  await logActivity({
    userId: s.user.id,
    action,
    entityType: opts.entityType,
    entityId: opts.entityId ?? null,
    description: opts.description,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}
