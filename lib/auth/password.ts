/** Password policy (passwords themselves are stored and verified by Supabase Auth). */
export function passwordProblems(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push("at least 12 characters");
  if (password.length > 72) problems.push("at most 72 characters");
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) problems.push("at least 3 of: lowercase, uppercase, number, symbol");
  if (email) {
    const local = email.split("@")[0]?.toLowerCase();
    if (local && local.length >= 4 && password.toLowerCase().includes(local)) problems.push("must not contain your email name");
  }
  if (/^(.)\1+$/.test(password) || /password|123456|qwerty/i.test(password)) problems.push("too common");
  return problems;
}
