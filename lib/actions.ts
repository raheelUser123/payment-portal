import "server-only";
import { z } from "zod";
import { ForbiddenError } from "./auth/guard";
import { RateLimitError } from "./security/rate-limit";

export type ActionResult<T = unknown> = { ok: boolean; message?: string; data?: T; fieldErrors?: Record<string, string> };

export class UserError extends Error {}

/** Wrap a server action: converts known errors to friendly messages, hides internals. */
export function safeAction<T>(fn: (fd: FormData) => Promise<ActionResult<T> | void>) {
  return async (_prev: ActionResult<T> | null, fd: FormData): Promise<ActionResult<T>> => {
    try {
      const r = await fn(fd);
      return r ?? { ok: true, message: "Saved." };
    } catch (e) {
      // let Next.js redirects / notFound propagate
      if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_")) throw e;
      if (e instanceof z.ZodError) {
        const fieldErrors: Record<string, string> = {};
        for (const i of e.issues) fieldErrors[i.path.join(".")] = i.message;
        return { ok: false, message: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), fieldErrors };
      }
      if (e instanceof UserError || e instanceof ForbiddenError || e instanceof RateLimitError) return { ok: false, message: e.message };
      console.error("[action] unexpected error", e);
      return { ok: false, message: (e as Error)?.message && process.env.NODE_ENV !== "production" ? (e as Error).message : "Something went wrong. Please try again." };
    }
  };
}

/** FormData → plain object (repeated keys become arrays when listed). */
export function formObject(fd: FormData, arrays: string[] = []) {
  const out: Record<string, unknown> = {};
  for (const key of new Set(fd.keys())) {
    if (key.startsWith("$ACTION")) continue;
    out[key] = arrays.includes(key) ? fd.getAll(key).map(String) : String(fd.get(key) ?? "");
  }
  for (const a of arrays) if (!(a in out)) out[a] = [];
  return out;
}

export const zEmptyToNull = z.string().trim().transform((v) => (v === "" ? null : v));
export const zOptionalEmail = z.string().trim().toLowerCase().transform((v) => (v === "" ? null : v)).pipe(z.email().nullable());
export const zOptionalUrl = z.string().trim().transform((v) => (v === "" ? null : v)).pipe(z.url({ protocol: /^https?$/ }).nullable());
/** HTML checkbox: present ("on") when ticked, absent when not. */
export const zCheckbox = z.union([z.literal("on"), z.literal("true"), z.literal("")]).optional().transform((v) => v === "on" || v === "true");
