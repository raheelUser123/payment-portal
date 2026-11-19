import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env } from "../env";

/** Hardened cookie options: auth cookies are never readable by browser JS. */
export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

/**
 * Supabase client bound to the current request's auth cookies (Supabase Auth
 * session). Only used on the server — the browser never talks to Supabase.
 */
export async function supabaseServer() {
  const jar = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) jar.set(name, value, { ...options, ...AUTH_COOKIE_OPTIONS });
        } catch {
          // called from a Server Component: cookies are refreshed by middleware instead
        }
      },
    },
  });
}

/** Service-role client for Supabase Auth admin operations (create users, reset MFA). */
export function supabaseAdmin() {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Cookie-less client used only to re-verify a password. */
export function supabaseStateless() {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Read the session id claim from an access token (already verified by getUser). */
export function sessionIdFromJwt(token: string | undefined): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}
