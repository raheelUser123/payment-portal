import "server-only";

/**
 * Connects brand payment subdomains (e.g. pay.brand.com) to this portal's
 * Vercel project through the Vercel REST API.
 * Needs: VERCEL_API_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID (optional for personal accounts).
 * Without a token the UI shows manual steps instead.
 */

const API = "https://api.vercel.com";

export function vercelConfigured(): boolean {
  return !!(process.env.VERCEL_API_TOKEN && process.env.VERCEL_PROJECT_ID);
}

function q() {
  return process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : "";
}

async function call<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T & { error?: { code?: string; message?: string } } }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } };
  return { ok: res.ok, status: res.status, data };
}

export type DomainStatus = {
  /** domain is attached to the portal's Vercel project */
  added: boolean;
  /** DNS points at Vercel */
  dnsOk: boolean;
  /** DNS records the user must create at their DNS provider */
  records: { type: string; name: string; value: string; reason: string }[];
  error?: string;
};

/** "pay.brand.com" → host label "pay" for DNS providers that want only the subdomain part. */
function hostLabel(domain: string) {
  const parts = domain.split(".");
  return parts.length > 2 ? parts.slice(0, -2).join(".") : "@";
}

export async function connectDomain(domain: string): Promise<DomainStatus> {
  const pid = encodeURIComponent(process.env.VERCEL_PROJECT_ID!);
  const add = await call<{ name?: string }>(`/v10/projects/${pid}/domains${q()}`, { method: "POST", body: JSON.stringify({ name: domain }) });
  if (!add.ok && add.data.error?.code !== "domain_already_in_use_by_project" && add.status !== 409) {
    return { added: false, dnsOk: false, records: [], error: add.data.error?.message ?? `Vercel error ${add.status}` };
  }
  if (!add.ok && add.status === 409 && add.data.error?.code !== "domain_already_in_use_by_project" && !/already/i.test(add.data.error?.message ?? "")) {
    return { added: false, dnsOk: false, records: [], error: add.data.error?.message ?? "Domain is in use by another Vercel project." };
  }
  return domainStatus(domain);
}

export async function domainStatus(domain: string): Promise<DomainStatus> {
  const pid = encodeURIComponent(process.env.VERCEL_PROJECT_ID!);
  const d = encodeURIComponent(domain);
  const [proj, cfg] = await Promise.all([
    call<{ verified?: boolean; verification?: { type: string; domain: string; value: string; reason: string }[] }>(`/v9/projects/${pid}/domains/${d}${q()}`),
    call<{ misconfigured?: boolean; recommendedCNAME?: { rank: number; value: string }[] }>(`/v6/domains/${d}/config${q()}`),
  ]);
  if (!proj.ok) return { added: false, dnsOk: false, records: [], error: proj.data.error?.message ?? "Not added to Vercel yet." };
  const records: DomainStatus["records"] = [];
  const cname = (cfg.data.recommendedCNAME ?? []).sort((a, b) => a.rank - b.rank)[0]?.value?.replace(/\.$/, "") ?? "cname.vercel-dns.com";
  if (cfg.data.misconfigured !== false) records.push({ type: "CNAME", name: hostLabel(domain), value: cname, reason: "Points the subdomain at the payment portal" });
  for (const v of proj.data.verification ?? []) {
    records.push({ type: v.type, name: v.domain.replace(`.${domain.split(".").slice(-2).join(".")}`, ""), value: v.value, reason: "Proves you own the domain (Vercel asked for it)" });
  }
  return { added: true, dnsOk: cfg.data.misconfigured === false && proj.data.verified !== false, records };
}

export async function disconnectDomain(domain: string): Promise<void> {
  const pid = encodeURIComponent(process.env.VERCEL_PROJECT_ID!);
  await call(`/v9/projects/${pid}/domains/${encodeURIComponent(domain)}${q()}`, { method: "DELETE" }).catch(() => undefined);
}
