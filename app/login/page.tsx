import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { getSession } from "@/lib/auth/session";
import { sql } from "@/lib/db";
import { loginAction } from "./actions";
import { AuthCard } from "./auth-card";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  const s = await getSession();
  if (s?.mfaVerified) redirect("/admin");
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users`;
  if (n === 0) redirect("/setup");
  return (
    <AuthCard title="Sign in" subtitle="Use your work email and password.">
      <ActionForm action={loginAction} className="space-y-4">
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" autoComplete="username" required maxLength={254} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="input" id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
        </div>
        <SubmitButton className="btn-primary w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
