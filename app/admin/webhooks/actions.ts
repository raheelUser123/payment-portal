"use server";

import type { ActionResult } from "@/lib/actions";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth/guard";
import { assertSafeUrl, deliver, newWebhookSecret, OUTBOUND_EVENTS } from "@/lib/webhooks/outbound";
import { randomToken } from "@/lib/crypto/tokens";
import { raiseAlert } from "@/lib/logging/alerts";
import { formObject, safeAction, UserError } from "@/lib/actions";
import { track } from "../users/track";

const zBrand = z.string().trim().transform((v) => (v === "" ? null : v)).pipe(z.uuid().nullable());

async function checkUrl(url: string) {
  try {
    return (await assertSafeUrl(url)).toString();
  } catch (e) {
    throw new UserError((e as Error).message || "Invalid URL");
  }
}

export const createEndpointAction = safeAction<{ secret: string }>(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const d = z.object({ url: z.string().trim().max(2000), brand_id: zBrand, events: z.array(z.enum(OUTBOUND_EVENTS)) }).parse(formObject(fd, ["events"]));
  const url = await checkUrl(d.url);
  const { secret, enc } = newWebhookSecret();
  const [row] = await sql<{ id: string }[]>`
    insert into webhook_endpoints (brand_id, url, secret_enc, events, created_by)
    values (${d.brand_id}, ${url}, ${enc}, ${d.events}, ${s.user.id}) returning id`;
  await track(s, "webhook_endpoint.create", { entityType: "webhook_endpoint", entityId: row.id, description: `Added webhook ${url}`, after: { url, brand_id: d.brand_id, events: d.events }, riskScore: 20 });
  await raiseAlert({ severity: "warning", type: "webhook_endpoint_created", title: "Outbound webhook endpoint added", message: `${url} by ${s.user.email}`, entityType: "webhook_endpoint", entityId: row.id, userId: s.user.id });
  revalidatePath("/admin/webhooks");
  return { ok: true, message: "Endpoint created. Copy the signing secret now — it won't be shown again.", data: { secret } };
});

const updateEndpointActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const d = z.object({ id: z.uuid(), events: z.array(z.enum(OUTBOUND_EVENTS)), is_active: z.string().optional() }).parse(formObject(fd, ["events"]));
  const active = d.is_active === "on";
  const [before] = await sql<{ events: string[]; is_active: boolean }[]>`select events, is_active from webhook_endpoints where id = ${d.id}`;
  if (!before) throw new UserError("Endpoint not found.");
  await sql`update webhook_endpoints set events = ${d.events}, is_active = ${active} where id = ${d.id}`;
  await track(s, "webhook_endpoint.update", { entityType: "webhook_endpoint", entityId: d.id, description: "Updated webhook endpoint", before, after: { events: d.events, is_active: active } });
  revalidatePath("/admin/webhooks");
  return { ok: true, message: "Endpoint updated." };
});

export const rotateSecretAction = safeAction<{ secret: string }>(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const { id } = z.object({ id: z.uuid() }).parse(formObject(fd));
  const { secret, enc } = newWebhookSecret();
  const res = await sql`update webhook_endpoints set secret_enc = ${enc} where id = ${id}`;
  if (res.count === 0) throw new UserError("Endpoint not found.");
  await track(s, "webhook_endpoint.rotate_secret", { entityType: "webhook_endpoint", entityId: id, description: "Rotated webhook signing secret", riskScore: 20 });
  revalidatePath("/admin/webhooks");
  return { ok: true, message: "New secret generated. Update your receiver now — the old secret stopped working.", data: { secret } };
});

const deleteEndpointActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const { id } = z.object({ id: z.uuid() }).parse(formObject(fd));
  const [row] = await sql<{ url: string }[]>`delete from webhook_endpoints where id = ${id} returning url`;
  if (!row) throw new UserError("Endpoint not found.");
  await track(s, "webhook_endpoint.delete", { entityType: "webhook_endpoint", entityId: id, description: `Deleted webhook ${row.url}`, before: { url: row.url } });
  revalidatePath("/admin/webhooks");
  return { ok: true, message: "Endpoint deleted." };
});

const sendTestEventActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const { id } = z.object({ id: z.uuid() }).parse(formObject(fd));
  const payload = {
    id: `evt_test_${randomToken(10)}`, type: "invoice.created", created: Math.floor(Date.now() / 1000), test: true,
    data: { invoice_id: "00000000-0000-0000-0000-000000000000", number: "TEST-0001", total_minor: 1000, currency: "USD" },
  };
  const [row] = await sql<{ id: string }[]>`
    insert into webhook_deliveries (endpoint_id, event_type, payload) values (${id}, 'invoice.created', ${sql.json(payload as never)}) returning id`;
  await deliver(row.id);
  const [d] = await sql<{ status: string; response_code: number | null; last_error: string | null }[]>`select status, response_code, last_error from webhook_deliveries where id = ${row.id}`;
  await track(s, "webhook_endpoint.test", { entityType: "webhook_endpoint", entityId: id, description: "Sent test webhook", after: d });
  revalidatePath("/admin/webhooks");
  return d.status === "delivered"
    ? { ok: true, message: `Delivered (HTTP ${d.response_code}).` }
    : { ok: false, message: `Not delivered: ${d.last_error ?? "unknown error"}. It will be retried automatically.` };
});

const retryDeliveryActionImpl = safeAction(async (fd) => {
  const s = await requireUser();
  assertAdmin(s);
  const { id } = z.object({ id: z.uuid() }).parse(formObject(fd));
  await sql`update webhook_deliveries set status = 'pending', next_retry_at = now() where id = ${id}`;
  await deliver(id);
  const [d] = await sql<{ status: string; last_error: string | null }[]>`select status, last_error from webhook_deliveries where id = ${id}`;
  await track(s, "webhook_delivery.retry", { entityType: "webhook_delivery", entityId: id, description: "Retried webhook delivery", after: d });
  revalidatePath("/admin/webhooks");
  return d?.status === "delivered" ? { ok: true, message: "Delivered." } : { ok: false, message: `Still failing: ${d?.last_error ?? "unknown"}` };
});

export async function updateEndpointAction(prev: ActionResult | null, fd: FormData) {
  return updateEndpointActionImpl(prev, fd);
}

export async function deleteEndpointAction(prev: ActionResult | null, fd: FormData) {
  return deleteEndpointActionImpl(prev, fd);
}

export async function sendTestEventAction(prev: ActionResult | null, fd: FormData) {
  return sendTestEventActionImpl(prev, fd);
}

export async function retryDeliveryAction(prev: ActionResult | null, fd: FormData) {
  return retryDeliveryActionImpl(prev, fd);
}
