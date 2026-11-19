/** Money helpers. All amounts are stored as integer minor units (cents). */
export const ZERO_DECIMAL = new Set(["BIF","CLP","DJF","GNF","JPY","KMF","KRW","MGA","PYG","RWF","UGX","VND","VUV","XAF","XOF","XPF"]);
export const THREE_DECIMAL = new Set(["BHD","JOD","KWD","OMR","TND"]);

export const CURRENCIES = ["USD","EUR","GBP","CAD","AUD","NZD","AED","SAR","PKR","INR","SGD","HKD","JPY","CHF","SEK","NOK","DKK","ZAR","MXN","BRL"] as const;

export function exponent(currency: string): number {
  const c = currency.toUpperCase();
  return ZERO_DECIMAL.has(c) ? 0 : THREE_DECIMAL.has(c) ? 3 : 2;
}

/** Parse a decimal string ("1,234.50") to minor units without float errors. */
export function toMinor(amount: string | number, currency: string): number {
  const exp = exponent(currency);
  const s = String(amount).replace(/[,\s]/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > exp) throw new Error(`Too many decimal places for ${currency}`);
  const minor = Number(whole) * 10 ** exp + Number((frac + "0".repeat(exp)).slice(0, exp) || "0");
  if (!Number.isSafeInteger(minor)) throw new Error("Amount too large");
  return minor;
}

/** Minor units → decimal string ("1234.50"). */
export function toDecimalString(minor: number, currency: string): string {
  const exp = exponent(currency);
  if (exp === 0) return String(minor);
  const neg = minor < 0;
  const s = Math.abs(minor).toString().padStart(exp + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -exp)}.${s.slice(-exp)}`;
}

export function formatMoney(minor: number, currency: string, locale = "en-US"): string {
  const exp = exponent(currency);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: exp, maximumFractionDigits: exp }).format(minor / 10 ** exp);
  } catch {
    return `${toDecimalString(minor, currency)} ${currency.toUpperCase()}`;
  }
}
