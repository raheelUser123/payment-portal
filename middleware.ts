import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * 1. Host routing: brand pay domains (anything that is not an admin host)
 *    may only serve the public payment pages + their APIs.
 * 2. Security headers incl. a nonce-based Content-Security-Policy.
 * 3. Supabase Auth session refresh (rotating tokens are written back as
 *    httpOnly cookies) and redirect to /login when there is no session.
 */

const PUBLIC_ON_BRAND_HOSTS = [/^\/pay\//, /^\/api\/pay\//, /^\/_next\//, /^\/favicon\.ico$/, /^\/robots\.txt$/];

function adminHosts(): string[] {
  const list = process.env.ADMIN_HOSTS;
  if (list) return list.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  try {
    return [new URL(process.env.APP_URL ?? "http://localhost:3000").host.toLowerCase()];
  } catch {
    return ["localhost:3000"];
  }
}

function isAdminHost(host: string) {
  const h = host.toLowerCase();
  if (process.env.NODE_ENV !== "production" && (h.startsWith("localhost") || h.startsWith("127.0.0.1"))) return true;
  return adminHosts().includes(h);
}

export async function middleware(req: NextRequest) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;
  const admin = isAdminHost(host);

  if (!admin && !PUBLIC_ON_BRAND_HOSTS.some((r) => r.test(pathname))) {
    return new NextResponse("Not found", { status: 404 });
  }

  const nonce = btoa(crypto.randomUUID());
  // Portal origin: static assets come from here even when a page is served via a brand website.
  let appOrigin = "";
  try { appOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : ""; } catch { /* ignore */ }
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    `default-src 'self'`,
    `script-src 'self' ${appOrigin} 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com https://www.paypal.com${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${appOrigin} 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' ${appOrigin} data:`,
    `connect-src 'self' https://api.stripe.com https://*.stripe.com https://*.paypal.com https://*.paypalobjects.com${dev ? " ws:" : ""}`,
    `frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com https://*.paypal.com`,
    `form-action 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  let res = NextResponse.next({ request: { headers: requestHeaders } });

  // Supabase Auth: refresh the session on admin-host pages (not on public pay pages).
  const needsAuth = admin && !pathname.startsWith("/pay/") && !pathname.startsWith("/api/");
  if (needsAuth && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    const supabase = createServerClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) req.cookies.set(name, value);
          res = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of list) {
            res.cookies.set(name, value, { ...options, httpOnly: true, secure: !dev, sameSite: "lax", path: "/" });
          }
        },
      },
    });
    const { data } = await supabase.auth.getUser();
    if (!data.user && pathname.startsWith("/admin")) {
      const redirect = NextResponse.redirect(new URL("/login", req.url));
      for (const c of res.cookies.getAll()) redirect.cookies.set(c);
      return redirect;
    }
  }

  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self \"https://js.stripe.com\")");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (!dev) res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  if (pathname.startsWith("/pay/") || pathname.startsWith("/admin")) {
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return res;
}

export const config = {
  // Webhooks are excluded: they need the untouched raw body and no CSP.
  matcher: ["/((?!api/webhooks|_next/static|_next/image).*)"],
};
