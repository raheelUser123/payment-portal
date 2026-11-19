import { requireAdmin } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { API_SCOPES } from "@/lib/auth/api-keys";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, dt, Empty, PageHeader } from "@/components/ui";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";
import { CreateApiKeyForm } from "./create-form";

export const metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  await requireAdmin();
  const [keys, brands] = await Promise.all([
    sql<{ id: string; name: string; brand: string | null; key_id: string; scopes: string[]; allowed_ips: string[]; last_used_at: Date | null; last_used_ip: string | null; expires_at: Date | null; revoked_at: Date | null; created_at: Date }[]>`
      select k.id, k.name, b.name as brand, k.key_id, k.scopes, k.allowed_ips::text[] as allowed_ips, k.last_used_at, k.last_used_ip::text as last_used_ip,
             k.expires_at, k.revoked_at, k.created_at
        from api_keys k left join brands b on b.id = k.brand_id order by k.revoked_at nulls first, k.created_at desc`,
    sql<{ id: string; name: string; slug: string }[]>`select id, name, slug from brands where is_active order by name`,
  ]);
  return (
    <>
      <PageHeader title="API keys" description="Server-to-server keys for brand websites. Requests are HMAC-signed with timestamp + nonce (replay-proof); the secret never travels over the wire." />
      <div className="space-y-6">
        <Card title="Create key">
          <CreateApiKeyForm action={createApiKeyAction as never} brands={brands} scopes={API_SCOPES} appUrl={(process.env.APP_URL ?? "").replace(/\/+$/, "")} />
        </Card>
        <Card title="Keys">
          {keys.length === 0 ? <Empty>No API keys yet.</Empty> : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Name</th><th>Brand</th><th>Key ID</th><th>Scopes</th><th>Last used</th><th>Expires</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {keys.map((k) => {
                    const expired = k.expires_at && k.expires_at < new Date();
                    return (
                      <tr key={k.id}>
                        <td className="font-medium">{k.name}{k.allowed_ips.length > 0 && <div className="text-xs text-slate-500">IPs: {k.allowed_ips.join(", ")}</div>}</td>
                        <td>{k.brand ?? <span className="text-slate-500">All brands</span>}</td>
                        <td><code className="text-xs">{k.key_id}</code></td>
                        <td className="space-x-1">{k.scopes.map((sc) => <Badge key={sc}>{sc}</Badge>)}</td>
                        <td className="whitespace-nowrap text-slate-600">{dt(k.last_used_at)}{k.last_used_ip && <div className="text-xs">{k.last_used_ip}</div>}</td>
                        <td className="whitespace-nowrap">{k.expires_at ? dt(k.expires_at, false) : "Never"}</td>
                        <td>{k.revoked_at ? <Badge tone="red">revoked</Badge> : expired ? <Badge tone="amber">expired</Badge> : <Badge tone="green">active</Badge>}</td>
                        <td>{!k.revoked_at && (
                          <ActionForm action={revokeApiKeyAction} confirm={`Revoke "${k.name}"? Integrations using it stop working immediately.`}>
                            <input type="hidden" name="id" value={k.id} /><SubmitButton className="btn-ghost text-rose-600">Revoke</SubmitButton>
                          </ActionForm>
                        )}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
