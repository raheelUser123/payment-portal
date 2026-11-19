"use client";

import { ActionForm, SubmitButton } from "@/components/action-form";
import { enrollAction } from "../login/actions";

export function EnrollForm({ factorId, next }: { factorId: string; next: string }) {
  return (
    <ActionForm action={enrollAction} className="mt-6 space-y-3">
      <input type="hidden" name="factorId" value={factorId} />
      <input type="hidden" name="next" value={next} />
      <label className="label" htmlFor="code">Enter the 6-digit code shown in the app</label>
      <input id="code" className="input text-center font-mono text-lg tracking-[0.4em]" name="code" inputMode="numeric" autoComplete="one-time-code" required maxLength={6} />
      <SubmitButton className="btn-primary w-full" pendingText="Verifying…">Enable 2FA</SubmitButton>
    </ActionForm>
  );
}
