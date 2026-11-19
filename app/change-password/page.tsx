import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { getSession } from "@/lib/auth/session";
import { changePassword } from "@/lib/auth/password-change";
import { requestMeta } from "@/lib/security/request";
import { safeAction, type ActionResult } from "@/lib/actions";
import { AuthCard } from "../login/auth-card";

export const metadata = { title: "Change password" };

const impl = safeAction(async (fd) => {
  const s = await getSession();
  if (!s || (!s.mfaVerified && s.user.totp_enabled)) redirect("/login");
  if (fd.get("next") !== fd.get("confirm")) return { ok: false, message: "Passwords don't match." };
  await changePassword(s, String(fd.get("current") ?? ""), String(fd.get("next") ?? ""), await requestMeta());
  redirect("/admin");
});

async function action(prev: ActionResult | null, fd: FormData) {
  "use server";
  return impl(prev, fd);
}

export default async function ChangePasswordPage() {
  const s = await getSession();
  if (!s) redirect("/login");
  return (
    <AuthCard title="Set a new password" subtitle={s.user.must_change_password ? "Your administrator requires you to choose a new password." : undefined}>
      <ActionForm action={action} className="space-y-4">
        <div><label className="label" htmlFor="current">Current password</label><input className="input" id="current" name="current" type="password" required autoComplete="current-password" /></div>
        <div><label className="label" htmlFor="next">New password</label><input className="input" id="next" name="next" type="password" required minLength={12} autoComplete="new-password" /></div>
        <div><label className="label" htmlFor="confirm">Confirm new password</label><input className="input" id="confirm" name="confirm" type="password" required minLength={12} autoComplete="new-password" /></div>
        <SubmitButton className="btn-primary w-full">Update password</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
