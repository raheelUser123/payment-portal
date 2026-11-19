import "server-only";
import { sql } from "./db";
import { accessibleBrandIds } from "./auth/guard";
import type { SessionInfo } from "./auth/session";

/**
 * SQL fragment restricting a brand_id column to what the user can see.
 * Returned wrapped in an object: postgres.js fragments are thenables, so
 * returning one directly from an async function would execute it.
 */
export async function brandScope(s: SessionInfo, column = "brand_id") {
  const ids = await accessibleBrandIds(s);
  if (ids === null) return { where: sql`` };
  if (ids.length === 0) return { where: sql`and false` };
  return { where: sql`and ${sql(column)} = any(${ids}::uuid[])` };
}

export async function brandOptions(s: SessionInfo) {
  const ids = await accessibleBrandIds(s);
  return ids === null
    ? sql<{ id: string; name: string; default_currency: string }[]>`select id, name, default_currency from brands where is_active order by name`
    : sql<{ id: string; name: string; default_currency: string }[]>`select id, name, default_currency from brands where is_active and id = any(${ids}::uuid[]) order by name`;
}
