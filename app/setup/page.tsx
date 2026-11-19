import { redirect } from "next/navigation";
import { z } from "zod";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { sql } from "@/lib/db";
import { passwordProblems } from "@/lib/auth/password";
import { supabaseAdmin } from "@/lib/supabase/server";
import { safeEqual } from "@/lib/crypto/tokens";
import { audit } from "@/lib/logging/audit";
import { requestMeta } from "@/lib/security/request";
import { rateLimit } from "@/lib/security/rate-limit";
import { AuthCard } from "../login/auth-card";
import type { ActionResult } from "@/lib/actions";

export const metadata = { title: "First-time setup" };

async function setupAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  "use server";
  const meta = await requestMeta();
  if (!(await rateLimit(`setup:${meta.ip}`, 3600, 10))) return { ok: false, message: "Too many attempts." };
  const expected = process.env.SETUP_TOKEN;
  if (!expected || expected.length < 16) return { ok: false, message: "Set SETUP_TOKEN (16+ chars) in the server environment first." };
  const data = z.object({
    token: z.string(), name: z.string().trim().min(1).max(120), email: z.email().toLowerCase(), password: z.string(),
  }).safeParse(Object.fromEntries(fd));
  if (!data.success) return { ok: false, message: "Please fill all fields correctly." };
  if (!safeEqual(data.data.token, expected)) {
    await audit({ actor: { type: "public" }, action: "setup.bad_token", ip: meta.ip, userAgent: meta.userAgent, riskScore: 60, reasons: ["invalid_setup_token"] });
    return { ok: false, message: "Invalid setup token." };
  }
  const problems = passwordProblems(data.data.password, data.data.email);
  if (problems.length) return { ok: false, message: `Password needs: ${problems.join(", ")}` };
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users`;
  if (n > 0) return { ok: false, message: "Setup was already completed." };
  // Create the login in Supabase Auth (it stores the password), then the app profile.
  const admin = supabaseAdmin();
  const { data: authUser, error } = await admin.auth.admin.createUser({
    email: data.data.email, password: data.data.password, email_confirm: true, user_metadata: { name: data.data.name },
  });
  if (error || !authUser.user) return { ok: false, message: `Could not create the login: ${error?.message ?? "unknown error"}` };
  const created = await sql.begin(async (tx) => {
    await tx`lock table users in exclusive mode`;
    const [{ c }] = await tx<{ c: number }[]>`select count(*)::int as c from users`;
    if (c > 0) return null;
    const [u] = await tx<{ id: string }[]>`insert into users (id, email, name, role) values (${authUser.user.id}, ${data.data.email}, ${data.data.name}, 'admin') returning id`;
    return u;
  }).catch(() => null);
  if (!created) await admin.auth.admin.deleteUser(authUser.user.id);
  if (!created) return { ok: false, message: "Setup was already completed." };
  await audit({ actor: { type: "system", label: "setup" }, action: "user.bootstrap_admin", entityType: "user", entityId: created.id, ip: meta.ip, userAgent: meta.userAgent });
  redirect("/login");
}

export default async function SetupPage() {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users`;
  if (n > 0) redirect("/login");
  return (
    <AuthCard title="Create the first admin" subtitle="This page only works once, while no users exist, and requires the SETUP_TOKEN from your server environment.">
      <ActionForm action={setupAction} className="space-y-4">
        <div><label className="label" htmlFor="token">Setup token</label><input className="input" id="token" name="token" type="password" required /></div>
        <div><label className="label" htmlFor="name">Full name</label><input className="input" id="name" name="name" required /></div>
        <div><label className="label" htmlFor="email">Email</label><input className="input" id="email" name="email" type="email" required /></div>
        <div><label className="label" htmlFor="password">Password</label><input className="input" id="password" name="password" type="password" minLength={12} required autoComplete="new-password" />
          <p className="mt-1 text-xs text-slate-500">12+ characters, mix of upper/lower case, numbers and symbols.</p></div>
        <SubmitButton className="btn-primary w-full">Create admin</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
