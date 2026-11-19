import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { getSession } from "@/lib/auth/session";
import { mfaAction } from "../actions";
import { AuthCard } from "../auth-card";

export const metadata = { title: "Two-factor authentication" };

export default async function MfaPage() {
  const s = await getSession();
  if (!s) redirect("/login");
  if (s.aal === "aal2" || s.mfaVerified) redirect("/admin");
  if (!s.user.totp_enabled) redirect("/setup-2fa");
  return (
    <AuthCard title="Two-factor authentication" subtitle="Enter the 6-digit code from your authenticator app.">
      <ActionForm action={mfaAction} className="space-y-4">
        <input className="input text-center font-mono text-lg tracking-[0.4em]" name="code" inputMode="numeric" autoComplete="one-time-code"
          autoFocus required maxLength={6} placeholder="123456" aria-label="Authentication code" />
        <SubmitButton className="btn-primary w-full" pendingText="Verifying…">Verify</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-xs text-slate-500">Lost your device? Ask an administrator to reset your 2FA.</p>
      <form action="/logout" method="post" className="mt-2 text-center">
        <button className="text-sm text-slate-500 underline">Use a different account</button>
      </form>
    </AuthCard>
  );
}
