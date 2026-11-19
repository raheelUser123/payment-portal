import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { beginTotpEnrollment } from "@/lib/auth/login";
import { AuthCard } from "../login/auth-card";
import { EnrollForm } from "./enroll-form";

export const metadata = { title: "Set up two-factor authentication" };

export default async function Setup2faPage({ searchParams }: { searchParams: Promise<{ add?: string }> }) {
  const s = await getSession();
  if (!s) redirect("/login");
  const adding = (await searchParams).add === "1";
  if (s.user.totp_enabled) {
    if (s.aal !== "aal2") redirect("/login/2fa");
    if (!adding) redirect("/admin/account");
  }
  const { factorId, qrCode, secret } = await beginTotpEnrollment();
  return (
    <AuthCard
      title={adding ? "Add another 2FA device" : "Protect your account"}
      subtitle={adding ? "Scan with the new device. Both devices will work." : "Two-factor authentication is required. Scan this QR code with Google Authenticator, 1Password, Authy or Microsoft Authenticator."}
    >
      <div className="flex flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrCode} alt="2FA QR code" width={200} height={200} className="rounded-lg border border-slate-200 bg-white p-2" />
        <p className="text-center text-xs text-slate-500">Can&apos;t scan? Enter this key manually:<br /><code className="select-all break-all font-mono text-slate-800">{secret}</code></p>
      </div>
      <EnrollForm factorId={factorId} next={adding ? "account" : ""} />
      {!adding && <p className="mt-4 text-center text-xs text-slate-500">Tip: add a second device later from My account, so you have a backup if you lose your phone.</p>}
    </AuthCard>
  );
}
