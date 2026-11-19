const SENSITIVE = /pass(word)?|secret|token|api[_-]?key|credential|totp|backup|authorization|cookie|card_number|cvc|cvv|_enc$|hash$/i;

/** Deep-copy an object replacing sensitive values with "[REDACTED]". */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? (v == null ? v : "[REDACTED]") : redact(v, depth + 1);
  }
  return out as T;
}
