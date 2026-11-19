# Payment Portal

A multi-brand, white-label invoicing and payment platform built with **Next.js 15 (App Router) + Node.js + Supabase Postgres**.

Many brands share one (or many) Stripe / PayPal accounts. Each brand's customers only ever see that brand: its domain, logo, colours, email address and email templates.

---

## What you get

| Area | Highlights |
|---|---|
| **Brands** | Unlimited brands. Each has its own payment-link slug (`yourdomain.com/pay/<brand-slug>/…`), logo, colours, sender address and SMTP mailbox, email templates, card statement suffix, invoice prefix and default currency. |
| **Merchants** | Unlimited gateway accounts (Stripe and PayPal today; adapter interface ready for Authorize.net / Square / NMI). Keys are AES‑256‑GCM encrypted. Brand→merchant routing by priority, currency, per-transaction cap and monthly volume cap. |
| **Invoices** | Line items, discount, tax, due date, link expiry, multi-currency (incl. zero/three-decimal currencies). Branded email with the customer's name and amount, reminders (manual and automatic), link rotation, void, review/flag. |
| **Pay page** | Hosted on the brand's own domain. Stripe Payment Element (cards) and PayPal Buttons, styled in brand colours. No Stripe/PayPal-hosted page is involved. |
| **Roles** | **Admin** — everything. **Seller** — creates/sends invoices, reviews payments, sees customers/inquiries, only for brands assigned to their department or directly to them. |
| **Security** | Supabase Auth login with mandatory Supabase MFA (TOTP 2FA — admins always, sellers by setting), lockout, rate limits, suspicious-login detection, session revocation, strict nonce CSP, AES‑256‑GCM secrets, HMAC-signed API, verified gateway webhooks, SSRF-safe outbound webhooks, hash-chained tamper-evident audit log, alerts to dashboard / email / Slack. |
| **Integrations** | Signed REST API for your brand websites (create invoices, submit inquiries), signed outbound webhooks (`invoice.paid`, `payment.succeeded`, …). |

---

## 1. Database (Supabase)

1. Create a Supabase project.
2. Open **SQL Editor**, paste the whole of [`supabase/migrations/20261118000000_init.sql`](supabase/migrations/20261118000000_init.sql) and click **Run**. (Or `psql "$DATABASE_URL" -f supabase/migrations/20261118000000_init.sql`.)
3. **Project Settings → Database → Connection string → Transaction pooler** (port 6543) — this is your `DATABASE_URL`.

The migration creates every table, enum, index, trigger and function, seeds a default department, settings and 5 default email templates, and locks the database down:

* Row Level Security is enabled on **every** table and all privileges are revoked from Supabase's `anon` and `authenticated` roles. The public Supabase REST/GraphQL API cannot read anything, even with the anon key. Only the server (via `DATABASE_URL`) can.
* `audit_logs` is append-only (UPDATE/DELETE/TRUNCATE raise an error) and hash-chained. `select audit_logs_verify();` returns `null` when the chain is intact (checked hourly by the cron job).

### Supabase Auth settings (Dashboard → Authentication)

Login, passwords, sessions and 2FA are handled by **Supabase Auth**. Set these once:

* **Sign In / Providers → Email**: keep Email enabled, and turn **off "Allow new users to sign up"**. Users are created only by admins inside the portal.
* **Multi-Factor**: make sure **TOTP (App Authenticator)** is enabled (it is by default).
* **Sessions** (optional, Pro plan): set a time-box and an inactivity timeout, e.g. 12 hours and 1 hour.
* **Rate limits**: the defaults are fine. The portal adds its own lockout and per-IP limits on top.

You don't need Supabase's email templates or redirect URLs: the portal never sends Supabase Auth emails.

> **Already ran the first migration before this update?** Run [`supabase/migrations/20261120000000_supabase_auth_smtp.sql`](supabase/migrations/20261120000000_supabase_auth_smtp.sql) once, then open `/setup` to create the admin again. Fresh projects only need the init file.

## 2. Environment

```bash
cp .env.example .env.local
npm run gen:keys     # paste the output into .env.local
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase transaction-pooler connection string |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase anon (or publishable) key — used on the server only |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role (or secret) key — server only, never expose |
| `APP_URL` | Admin panel URL, e.g. `https://portal.yourcompany.com` |
| `ENCRYPTION_KEY` | 32-byte base64 key, AES-256-GCM for all stored secrets |
| `ENCRYPTION_KEYS_PREVIOUS` | Old keys during rotation (decrypt-only) |
| `APP_SECRET` | Pepper for hashing pay-link and API tokens |
| `SETUP_TOKEN` | Needed once on `/setup` to create the first admin |
| `CRON_SECRET` | Protects `/api/cron` |
| `SYSTEM_FROM_EMAIL` + `SYSTEM_SMTP_URL` | SMTP mailbox that sends security alerts to admins |

**Back up `ENCRYPTION_KEY` safely.** If it's lost, stored gateway keys and SMTP passwords can't be decrypted (you would re-enter them).

## 3. Run

```bash
npm install
npm run dev          # http://localhost:3000 → /setup to create the first admin
npm test             # crypto / password policy / template / money unit tests
npm run build && npm start
```

Deploying on **Vercel**: import the repo, add the env vars, deploy. `vercel.json` registers a **daily** cron for `/api/cron` (reminders, webhook retries, cleanup, audit-chain check), which is what the Hobby plan allows. On Vercel Pro you can change the schedule to hourly (`0 * * * *`). On Hobby you can also call it more often for free from an external scheduler such as cron-job.org: `GET https://<APP_URL>/api/cron` with header `Authorization: Bearer <CRON_SECRET>`.

## 4. First-time configuration (in the admin panel)

1. `/setup`: create the admin with your `SETUP_TOKEN` (the login is created in Supabase Auth). Sign in and scan the QR code to turn on 2FA. Then remove `SETUP_TOKEN` from the environment.
2. **Merchants → New**: add your Stripe account (publishable key, secret key). Copy the webhook URL shown (`https://<APP_URL>/api/webhooks/stripe/<merchant-id>`) into **Stripe Dashboard → Developers → Webhooks**, subscribe the listed events, paste the `whsec_…` signing secret back, then click **Verify connection**.
3. **Brands → New**: name, slug, logo, colours, sender email + SMTP mailbox credentials (**Send test email**), statement suffix. Link the merchant(s) and departments.
4. **Departments / Users**: create sellers, put them in a department, assign brands.
5. **Brands → Templates**: customise the invoice, reminder, receipt, failed-payment and refund emails per brand, with live preview.

### Payment subdomain per brand

Each brand can have its own payment address, such as `pay.graphicwolves.com`. Its payment links become `https://pay.graphicwolves.com/pay/<brand-slug>/<secure-token>`, and the brand's main website is not touched.

**Brands → (brand) → Payment subdomain**:

1. Enter the subdomain and click **Connect subdomain**. If `VERCEL_API_TOKEN` is set, the portal adds the subdomain to its Vercel project automatically. Otherwise add it yourself in Vercel → payment-portal → Settings → Domains.
2. Create the DNS record the card shows at your domain provider. It's usually `CNAME  pay  →  <value Vercel gives>`. On Cloudflare, use "DNS only".
3. Click **Check again**. When `https://<subdomain>/pay/healthcheck` answers from this portal, the card shows **live**. From then on, new links use the subdomain.

Until a subdomain is live, the brand's links use the portal domain (`APP_URL`), so customers never get a broken link. On a brand subdomain only the payment pages are reachable; the admin panel and login return 404.

### Editing and deleting

Brands, merchants, invoices, customers, users, departments, inquiries and webhooks can all be edited and deleted from the admin panel. Financial records are protected:

* An **invoice** can be edited until something is paid (the link stays the same, and an open checkout is cancelled so the new amount applies). It can be deleted only if no payment was ever attempted; otherwise void it.
* A **brand** with invoices, a **merchant** with payments, or a **customer** with invoices can't be deleted. Deactivate or disable it instead.
* Deleting a **user** also removes their Supabase login. You can't delete yourself or the last admin.

### Email deliverability (per brand domain)

Add SPF, DKIM and DMARC records for each sending domain at your mail host (cPanel, Google Workspace, Microsoft 365, Zoho, Amazon SES, …). Without them, branded invoices may land in spam.

## 5. White-label with one Stripe account: what is and isn't hidden

**Hidden from the customer:**

* No Stripe Checkout, Stripe Invoice or Stripe receipt pages or emails are used. `receipt_email` is never sent to Stripe.
* The payment form is Stripe's Payment Element embedded on the brand's domain, labelled with the brand name and themed in brand colours.
* All emails come from the brand's address, using the brand's template.
* PayPal checkout shows the **brand** name (`experience_context.brand_name`).

**Still visible (set by banks and card networks; no gateway can remove these):**

* **Card statement.** It shows your Stripe account's *shortened descriptor prefix* plus the brand's suffix, e.g. `ACME* BRANDONE`. Choose a neutral prefix in Stripe → Settings → Public details, and set a suffix per brand.
* **3-D Secure screens.** The customer's bank may show the merchant name registered with Stripe.

**Stripe Dashboard settings to change:**

* Settings → Customer emails: turn **off** "Successful payments" and "Refunds", so Stripe never emails customers.
* Keep wallets (Apple/Google Pay), Link and redirect methods off. Cards are the default (`allowed_payment_method_types = card`), because those methods can reveal the account name. You can enable more per merchant with *Payment method types*.

**Compliance:** Stripe and PayPal require that customers can recognise the charge. Running several brands of **your own business** on one account is fine if descriptors and support contacts make the charge recognisable. If brands belong to **different legal entities**, each needs its own merchant account. Add one per entity under Merchants; the routing already supports it. Unrecognised charges become chargebacks.

## 6. Brand-website API (HMAC signed)

Create a key in **API keys**: brand-scoped or global, with scopes, optional IP allow-list and expiry. The secret is shown once.

Each request carries:

```
X-PP-Key:        ppk_…
X-PP-Timestamp:  <unix seconds>          (±300 s)
X-PP-Nonce:      <random 16–64 chars>    (single use)
X-PP-Signature:  hex(HMAC_SHA256(secret, `${ts}.${nonce}.${METHOD}.${path}.${sha256hex(body)}`))
```

```js
import crypto from "node:crypto";
const body = JSON.stringify({
  customer: { name: "Jane Doe", email: "jane@example.com" },
  currency: "USD",
  items: [{ description: "Logo design", quantity: 1, unit_amount: "499.00" }],
  send_email: true,
});
const ts = Math.floor(Date.now() / 1000).toString();
const nonce = crypto.randomBytes(16).toString("hex");
const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
const sig = crypto.createHmac("sha256", process.env.PP_SECRET)
  .update(`${ts}.${nonce}.POST./api/v1/invoices.${bodyHash}`).digest("hex");
const res = await fetch("https://portal.yourcompany.com/api/v1/invoices", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-PP-Key": process.env.PP_KEY,
             "X-PP-Timestamp": ts, "X-PP-Nonce": nonce, "X-PP-Signature": sig },
  body,
});
// → { id, number, total_minor, currency, pay_url, emailed }
```

Endpoints: `POST /api/v1/invoices` (scope `invoices:write`), `POST /api/v1/inquiries` (scope `inquiries:write`, for contact/quote forms).

### Outbound webhooks

Add endpoints under **Webhooks**. Each POST has `X-PP-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC_SHA256(secret, "${t}.${rawBody}")`. Verify it with a constant-time compare and reject `t` older than 5 minutes. Failed deliveries retry with backoff (1m → 12h).

## 7. Security model (summary)

* **Authentication**: Supabase Auth (passwords hashed and stored by Supabase), app password policy, per-IP and per-email rate limits, account lockout, generic error messages.
* **2FA**: Supabase MFA, TOTP factors (Google Authenticator, 1Password, Authy…). Admin pages need an `aal2` session. Users can add a second device as a backup. Admins can reset a user's 2FA, which deletes their factors and revokes their sessions. A password-only session can't add or replace a device.
* **Sessions**: Supabase Auth sessions in `HttpOnly; SameSite=Lax` cookies, refreshed in middleware. Revoke one or all from *My account* or *Users*. Password change and 2FA reset sign out other sessions. Deactivating a user also bans the login in Supabase.
* **Authorisation**: every server action re-checks role and brand scope on the server. Sellers can't see other brands' data, even by URL.
* **Secrets at rest**: AES-256-GCM with random IV, auth tag, per-purpose AAD and key-id prefix for rotation.
* **Payments**: amounts always come from the DB, never from the browser. Provider state is re-fetched and checked against the expected amount and currency (a mismatch raises a critical alert). State changes are idempotent and transactional. Webhooks are signature-verified and de-duplicated. Card data never touches the server (PCI SAQ-A).
* **Risk & alerts**: suspicious logins (new IP/device, failure bursts, one IP trying many accounts), 2FA brute force, 2FA device added/removed/reset, lockouts, privilege escalation, credential changes, large or high-risk payments, failed-payment spikes (card testing), disputes, refunds, invalid webhook signatures, bad API signatures, audit-chain tampering. Alerts go to the dashboard, admin email and Slack/Discord.
* **Logs**: activity log (who did what) and hash-chained audit log with risk scores, `before`/`after` snapshots (secrets auto-redacted) and a suspicious filter.
* **HTTP**: nonce-based CSP with `strict-dynamic`, HSTS preload, `frame-ancestors 'none'`, `nosniff`, strict referrer policy, `no-store` on sensitive pages, `noindex`.

## Project layout

```
app/
  admin/…            CMS (dashboard, invoices, payments, customers, inquiries, brands, merchants,
                     users, departments, api-keys, webhooks, settings, alerts, audit, activity, account)
  pay/[token]/       public brand-themed invoice + checkout + completion page
  api/pay/…          checkout start/confirm (same-origin only)
  api/webhooks/…     Stripe / PayPal webhook receivers (signature verified)
  api/v1/…           HMAC-signed brand-website API
  api/cron           reminders, retries, cleanup, audit verification
  login, setup-2fa, setup, change-password
lib/
  crypto/            AES-256-GCM, tokens/HMAC
  supabase/          Supabase Auth clients (server, admin)
  auth/              login + 2FA flow (Supabase MFA), sessions, guards, password policy, API keys
  payments/          provider interface, Stripe & PayPal adapters, merchant routing, payment service
  email/             template renderer, SMTP transport, branded sending
  invoices/, brands/, webhooks/, logging/, security/
supabase/migrations/ complete database schema
middleware.ts        host routing + security headers
```
