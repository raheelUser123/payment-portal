import "server-only";
import { headers } from "next/headers";

export type RequestMeta = { ip: string | null; userAgent: string | null };

const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

export function ipFromHeaders(h: Headers): string | null {
  const candidates = [
    h.get("x-vercel-forwarded-for"),
    h.get("cf-connecting-ip"),
    h.get("x-real-ip"),
    h.get("x-forwarded-for")?.split(",")[0],
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && IP_RE.test(v)) return v;
  }
  return null;
}

export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return { ip: ipFromHeaders(h), userAgent: h.get("user-agent")?.slice(0, 500) ?? null };
}

export function metaFromRequest(req: Request): RequestMeta {
  return { ip: ipFromHeaders(req.headers), userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null };
}

/** Same-origin check for cookie-authenticated JSON route handlers (CSRF defence). */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
