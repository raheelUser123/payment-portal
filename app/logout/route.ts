import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { logActivity } from "@/lib/logging/activity";
import { isSameOrigin, metaFromRequest } from "@/lib/security/request";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return new NextResponse("Bad origin", { status: 403 });
  const s = await getSession();
  if (s) {
    const meta = metaFromRequest(req);
    await logActivity({ userId: s.user.id, action: "auth.logout", description: "Signed out", ip: meta.ip, userAgent: meta.userAgent });
  }
  const sb = await supabaseServer();
  await sb.auth.signOut({ scope: "local" }); // revokes the session in Supabase Auth and clears cookies
  return NextResponse.redirect(new URL("/login", req.url), 303);
}
