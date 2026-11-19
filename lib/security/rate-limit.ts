import "server-only";
import { sql } from "../db";

/** Postgres-backed fixed window limiter (works across serverless instances). */
export async function rateLimit(key: string, windowSeconds: number, max: number): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`select rate_limit_hit(${key}, ${windowSeconds}, ${max}) as ok`;
  return row.ok;
}

export class RateLimitError extends Error {
  constructor() {
    super("Too many requests. Please wait a moment and try again.");
  }
}

export async function enforceRateLimit(key: string, windowSeconds: number, max: number) {
  if (!(await rateLimit(key, windowSeconds, max))) throw new RateLimitError();
}
