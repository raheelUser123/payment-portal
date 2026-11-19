"use server";

import type { ActionResult } from "@/lib/actions";

import { revalidatePath } from "next/cache";
import { isIP } from "node:net";
import { z } from "zod";
import { sql } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth/guard";
import { API_SCOPES, createApiKey } from "@/lib/auth/api-keys";
import { raiseAlert } from "@/lib/logging/alerts";
import { formObject, safeAction, UserError } from "@/lib/actions";
import { track } from "../users/track";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  brand_id: z.string().trim().transform((v) => (v === "" ? null : v)).pipe(z.uuid().nullable()),
  scopes: z.array(z.enum(API_SCOPES)).min(1, "Pick at least one scope"),
  allowed_ips: z.string().max(2000).default(""),
  expires_days: z.string().trim().transform((v) => (v === "" ? null : Number(v))).pipe(z.number().int().min(1).max(3650).nullable()),
});

export const createApiKeyAction = safeAction<{ keyId: string; secret: string }>(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const d = CreateSchema.parse(formObject(fd, ["scopes"]));
  const ips = d.allowed_ips.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  for (const ip of ips) if (!isIP(ip)) throw new UserError(`Invalid IP address: ${ip}`);
  if (d.brand_id) {
    const [b] = await sql`select 1 from brands where id = ${d.brand_id}`;
    if (!b) throw new UserError("Brand not found.");
  }
  const expiresAt = d.expires_days ? new Date(Date.now() + d.expires_days * 86400_000) : null;
  const key = await createApiKey({ brandId: d.brand_id, name: d.name, scopes: d.scopes, allowedIps: ips, expiresAt, createdBy: s.user.id });
  await track(s, "api_key.create", {
    entityType: "api_key", entityId: key.id, description: `Created API key "${d.name}"`,
    after: { name: d.name, key_id: key.keyId, brand_id: d.brand_id, scopes: d.scopes, allowed_ips: ips, expires_at: expiresAt },
    riskScore: 30, reasons: ["api_credential_created"],
  });
  await raiseAlert({ severity: "warning", type: "api_key_created", title: `API key created: ${d.name}`, message: `${key.keyId} by ${s.user.email}; scopes ${d.scopes.join(", ")}`, entityType: "api_key", entityId: key.id, userId: s.user.id });
  revalidatePath("/admin/api-keys");
  return { ok: true, message: "API key created. Copy the secret now — it will not be shown again.", data: { keyId: key.keyId, secret: key.secret } };
});

const revokeApiKeyActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const { id } = z.object({ id: z.uuid() }).parse(formObject(fd));
  const [k] = await sql<{ name: string; key_id: string }[]>`update api_keys set revoked_at = now() where id = ${id} and revoked_at is null returning name, key_id`;
  if (!k) throw new UserError("Key not found or already revoked.");
  await track(s, "api_key.revoke", { entityType: "api_key", entityId: id, description: `Revoked API key "${k.name}"`, after: { key_id: k.key_id, revoked: true } });
  await raiseAlert({ severity: "warning", type: "api_key_revoked", title: `API key revoked: ${k.name}`, message: `${k.key_id} by ${s.user.email}`, entityType: "api_key", entityId: id, userId: s.user.id });
  revalidatePath("/admin/api-keys");
  return { ok: true, message: "Key revoked." };
});

export async function revokeApiKeyAction(prev: ActionResult | null, fd: FormData) {
  return revokeApiKeyActionImpl(prev, fd);
}
