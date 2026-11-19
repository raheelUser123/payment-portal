-- =============================================================================
-- Payment Portal — complete database schema (Supabase / PostgreSQL 15+)
-- =============================================================================
-- Run once on a fresh Supabase project:
--   Supabase Dashboard → SQL Editor → paste this whole file → Run
--   (or: supabase db push / psql "$DATABASE_URL" -f this_file.sql)
--
-- Security model
--   * Login, passwords, sessions and 2FA (TOTP) are handled by Supabase Auth
--     (auth.users / auth.mfa_factors / auth.sessions). public.users holds the
--     app profile + role and shares the same id as auth.users.
--   * The Next.js server is the ONLY client. It connects with the database
--     connection string (role "postgres") from server code only.
--   * Row Level Security is ENABLED on every table with NO policies, and all
--     privileges are revoked from the "anon" / "authenticated" roles, so the
--     public Supabase REST/GraphQL APIs cannot read or write anything even if
--     the anon key leaks.
--   * Secrets (gateway keys, SMTP passwords, API signing secrets)
--     are stored AES-256-GCM encrypted by the application ("*_enc" columns).
--     The database never sees plaintext secrets.
--   * audit_logs is append-only and hash-chained (tamper evident).
-- =============================================================================

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type user_role         as enum ('admin', 'seller');
create type payment_provider  as enum ('stripe', 'paypal', 'authorize_net', 'square');
create type merchant_mode     as enum ('test', 'live');
create type merchant_status   as enum ('active', 'paused', 'disabled');
create type invoice_status    as enum ('draft', 'open', 'paid', 'partially_refunded', 'refunded', 'void', 'uncollectible');
create type payment_status    as enum ('pending', 'processing', 'succeeded', 'failed', 'canceled', 'refunded', 'partially_refunded', 'disputed');
create type review_status     as enum ('pending', 'approved', 'flagged');
create type email_provider    as enum ('smtp', 'none');
create type email_template_type as enum ('invoice', 'reminder', 'receipt', 'payment_failed', 'refund');
create type alert_severity    as enum ('info', 'warning', 'critical');
create type actor_type        as enum ('user', 'system', 'api_key', 'webhook', 'public');

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Organisation: departments, users, sessions
-- -----------------------------------------------------------------------------
create table departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(name) between 1 and 120),
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table users (
  -- same id as the Supabase Auth user (auth.users)
  id                    uuid primary key references auth.users(id) on delete cascade,
  email                 citext not null unique check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name                  text not null check (length(name) between 1 and 120),
  role                  user_role not null default 'seller',
  department_id         uuid references departments(id) on delete set null,
  is_active             boolean not null default true,
  -- app-level lockout on top of Supabase Auth rate limits
  failed_login_count    integer not null default 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz not null default now(),
  must_change_password  boolean not null default false,
  last_login_at         timestamptz,
  last_login_ip         inet,
  created_by            uuid references users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index users_department_idx on users(department_id);

create table login_attempts (
  id          bigint generated always as identity primary key,
  email       citext,
  user_id     uuid references users(id) on delete set null,
  ip          inet,
  user_agent  text,
  success     boolean not null,
  stage       text not null default 'password',   -- password | mfa
  reason      text,
  created_at  timestamptz not null default now()
);
create index login_attempts_email_idx on login_attempts(email, created_at desc);
create index login_attempts_ip_idx on login_attempts(ip, created_at desc);
create index login_attempts_user_idx on login_attempts(user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Brands (white-label identities sharing the same merchants)
-- -----------------------------------------------------------------------------
create table brands (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null check (length(name) between 1 and 120),
  slug                        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- Optional payment subdomain (e.g. "pay.graphicwolves.com") pointed at this portal.
  -- Once verified, payment links use https://<pay_domain>/pay/<slug>/<token>;
  -- otherwise the portal's main domain.
  pay_domain                  citext unique check (pay_domain is null or pay_domain ~* '^[a-z0-9.-]+\.[a-z]{2,}$'),
  pay_domain_verified_at      timestamptz,
  website_url                 text,
  logo_url                    text,
  primary_color               text not null default '#111827' check (primary_color ~* '^#[0-9a-f]{6}$'),
  accent_color                text not null default '#2563eb' check (accent_color ~* '^#[0-9a-f]{6}$'),
  support_email               citext,
  support_phone               text,
  address                     text,
  -- email identity
  from_name                   text,
  from_email                  citext,
  reply_to                    citext,
  bcc_email                   citext,
  email_provider              email_provider not null default 'none',
  email_config_enc            text,                      -- encrypted JSON (smtp host/port/user/pass)
  -- payments
  statement_descriptor_suffix text check (statement_descriptor_suffix is null or statement_descriptor_suffix ~ '^[A-Za-z0-9 .\-]{1,22}$'),
  invoice_prefix              text not null default 'INV' check (invoice_prefix ~ '^[A-Z0-9]{1,8}$'),
  default_currency            char(3) not null default 'USD',
  terms_url                   text,
  privacy_url                 text,
  footer_text                 text,
  is_active                   boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create table department_brands (
  department_id uuid not null references departments(id) on delete cascade,
  brand_id      uuid not null references brands(id) on delete cascade,
  primary key (department_id, brand_id)
);

create table user_brands (
  user_id  uuid not null references users(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  primary key (user_id, brand_id)
);

-- -----------------------------------------------------------------------------
-- Merchants (gateway accounts) — many brands can share one merchant
-- -----------------------------------------------------------------------------
create table merchants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (length(name) between 1 and 120),
  provider              payment_provider not null,
  mode                  merchant_mode not null default 'test',
  status                merchant_status not null default 'active',
  -- encrypted JSON: { secretKey, webhookSecret } / { clientId, clientSecret, webhookId } ...
  credentials_enc       text not null,
  -- non-secret values the browser needs (publishable key / PayPal client id)
  public_config         jsonb not null default '{}',
  -- last 4 chars of the secret, for display only
  credential_hint       text,
  supported_currencies  text[] not null default '{USD}',
  per_txn_limit_minor   bigint check (per_txn_limit_minor is null or per_txn_limit_minor > 0),
  monthly_limit_minor   bigint check (monthly_limit_minor is null or monthly_limit_minor > 0),
  notes                 text,
  last_verified_at      timestamptz,
  created_by            uuid references users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table brand_merchants (
  brand_id    uuid not null references brands(id) on delete cascade,
  merchant_id uuid not null references merchants(id) on delete cascade,
  priority    integer not null default 100,   -- lower = preferred
  is_active   boolean not null default true,
  primary key (brand_id, merchant_id)
);
create index brand_merchants_merchant_idx on brand_merchants(merchant_id);

-- -----------------------------------------------------------------------------
-- Customers, invoices, payments
-- -----------------------------------------------------------------------------
create table customers (
  id            uuid primary key default gen_random_uuid(),
  brand_id      uuid not null references brands(id) on delete restrict,
  name          text not null check (length(name) between 1 and 200),
  email         citext not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone         text,
  company       text,
  address       text,
  notes         text,
  -- { "stripe:<merchant_id>": "cus_..." }
  provider_refs jsonb not null default '{}',
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (brand_id, email)
);

create sequence invoice_number_seq start 1001;

create table invoices (
  id                 uuid primary key default gen_random_uuid(),
  number             text not null unique,
  brand_id           uuid not null references brands(id) on delete restrict,
  customer_id        uuid not null references customers(id) on delete restrict,
  merchant_id        uuid references merchants(id) on delete set null,  -- pinned merchant (optional)
  department_id      uuid references departments(id) on delete set null,
  created_by         uuid references users(id) on delete set null,
  currency           char(3) not null,
  subtotal_minor     bigint not null check (subtotal_minor >= 0),
  discount_minor     bigint not null default 0 check (discount_minor >= 0),
  tax_minor          bigint not null default 0 check (tax_minor >= 0),
  total_minor        bigint not null check (total_minor > 0),
  amount_paid_minor  bigint not null default 0 check (amount_paid_minor >= 0),
  amount_refunded_minor bigint not null default 0 check (amount_refunded_minor >= 0),
  status             invoice_status not null default 'draft',
  title              text,
  memo               text,
  due_date           date,
  -- public pay link: lookup by hash, encrypted copy so the link can be re-sent
  token_hash         text not null unique,
  token_enc          text not null,
  token_expires_at   timestamptz,
  sent_at            timestamptz,
  last_reminder_at   timestamptz,
  reminder_count     integer not null default 0,
  viewed_at          timestamptz,
  view_count         integer not null default 0,
  paid_at            timestamptz,
  voided_at          timestamptz,
  review_status      review_status not null default 'pending',
  reviewed_by        uuid references users(id) on delete set null,
  reviewed_at        timestamptz,
  review_note        text,
  metadata           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (total_minor = subtotal_minor - discount_minor + tax_minor)
);
create index invoices_brand_idx on invoices(brand_id, created_at desc);
create index invoices_customer_idx on invoices(customer_id);
create index invoices_status_idx on invoices(status, due_date);
create index invoices_created_by_idx on invoices(created_by);

create table invoice_items (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references invoices(id) on delete cascade,
  description       text not null check (length(description) between 1 and 500),
  quantity          numeric(12,2) not null default 1 check (quantity > 0),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  amount_minor      bigint not null check (amount_minor >= 0),
  sort_order        integer not null default 0
);
create index invoice_items_invoice_idx on invoice_items(invoice_id);

create table payments (
  id                     uuid primary key default gen_random_uuid(),
  invoice_id             uuid not null references invoices(id) on delete restrict,
  brand_id               uuid not null references brands(id) on delete restrict,
  merchant_id            uuid not null references merchants(id) on delete restrict,
  provider               payment_provider not null,
  provider_payment_id    text,                  -- pi_... / PayPal order id
  provider_charge_id     text,                  -- ch_... / PayPal capture id
  amount_minor           bigint not null check (amount_minor > 0),
  amount_refunded_minor  bigint not null default 0 check (amount_refunded_minor >= 0),
  currency               char(3) not null,
  status                 payment_status not null default 'pending',
  failure_code           text,
  failure_message        text,
  payment_method_type    text,
  card_brand             text,
  card_last4             text,
  card_country           text,
  payer_name             text,
  payer_email            citext,
  ip                     inet,
  user_agent             text,
  risk_level             text,
  risk_score             integer,
  review_status          review_status not null default 'pending',
  reviewed_by            uuid references users(id) on delete set null,
  reviewed_at            timestamptz,
  review_note            text,
  succeeded_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (provider, provider_payment_id)
);
create index payments_invoice_idx on payments(invoice_id);
create index payments_brand_idx on payments(brand_id, created_at desc);
create index payments_merchant_idx on payments(merchant_id, created_at desc);
create index payments_status_idx on payments(status);

create table refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references payments(id) on delete restrict,
  provider_refund_id text,
  amount_minor       bigint not null check (amount_minor > 0),
  reason             text,
  status             text not null default 'pending',
  created_by         uuid references users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (payment_id, provider_refund_id)
);

create table disputes (
  id                  uuid primary key default gen_random_uuid(),
  payment_id          uuid references payments(id) on delete set null,
  merchant_id         uuid references merchants(id) on delete set null,
  provider_dispute_id text not null unique,
  amount_minor        bigint,
  currency            char(3),
  reason              text,
  status              text,
  evidence_due_by     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Email templates & logs
-- -----------------------------------------------------------------------------
create table email_templates (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid references brands(id) on delete cascade,   -- null = global default
  type        email_template_type not null,
  subject     text not null check (length(subject) between 1 and 300),
  html        text not null,
  is_active   boolean not null default true,
  updated_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index email_templates_brand_type_uq on email_templates(coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid), type);

create table email_logs (
  id                  uuid primary key default gen_random_uuid(),
  brand_id            uuid references brands(id) on delete set null,
  invoice_id          uuid references invoices(id) on delete set null,
  template_type       email_template_type,
  to_email            citext not null,
  subject             text,
  status              text not null,              -- sent | failed | skipped
  provider_message_id text,
  error               text,
  sent_by             uuid references users(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index email_logs_invoice_idx on email_logs(invoice_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Brand website integration: API keys (HMAC signed), inquiries, outbound webhooks
-- -----------------------------------------------------------------------------
create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  brand_id      uuid references brands(id) on delete cascade,
  name          text not null,
  key_id        text not null unique,          -- public id, e.g. pk_live_xxxx
  secret_hash   text not null,                 -- sha256 of secret (bearer auth)
  secret_enc    text not null,                 -- encrypted secret (HMAC verification)
  scopes        text[] not null default '{}',
  allowed_ips   inet[] not null default '{}',
  last_used_at  timestamptz,
  last_used_ip  inet,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table api_nonces (
  key_id     text not null,
  nonce      text not null,
  created_at timestamptz not null default now(),
  primary key (key_id, nonce)
);

create table inquiries (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid references brands(id) on delete set null,
  name        text,
  email       citext,
  phone       text,
  subject     text,
  message     text,
  amount_text text,
  source_url  text,
  ip          inet,
  status      text not null default 'new',
  assigned_to uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index inquiries_brand_idx on inquiries(brand_id, created_at desc);

create table webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid references brands(id) on delete cascade,
  url         text not null check (url ~* '^https://'),
  secret_enc  text not null,
  events      text[] not null default '{}',     -- empty = all
  is_active   boolean not null default true,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table webhook_deliveries (
  id             uuid primary key default gen_random_uuid(),
  endpoint_id    uuid not null references webhook_endpoints(id) on delete cascade,
  event_type     text not null,
  payload        jsonb not null,
  status         text not null default 'pending',   -- pending | delivered | failed
  attempts       integer not null default 0,
  response_code  integer,
  last_error     text,
  next_retry_at  timestamptz default now(),
  delivered_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index webhook_deliveries_retry_idx on webhook_deliveries(status, next_retry_at);

-- Incoming gateway webhooks (idempotency + forensic record)
create table webhook_events (
  id               uuid primary key default gen_random_uuid(),
  merchant_id      uuid references merchants(id) on delete set null,
  provider         payment_provider not null,
  event_id         text not null,
  type             text not null,
  signature_valid  boolean not null,
  processed_at     timestamptz,
  error            text,
  payload          jsonb,
  received_at      timestamptz not null default now(),
  unique (provider, event_id)
);

-- -----------------------------------------------------------------------------
-- Activity, alerts, audit
-- -----------------------------------------------------------------------------
create table activity_logs (
  id           bigint generated always as identity primary key,
  user_id      uuid references users(id) on delete set null,
  action       text not null,
  entity_type  text,
  entity_id    text,
  description  text,
  ip           inet,
  user_agent   text,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);
create index activity_logs_user_idx on activity_logs(user_id, created_at desc);
create index activity_logs_created_idx on activity_logs(created_at desc);

create table alerts (
  id               uuid primary key default gen_random_uuid(),
  severity         alert_severity not null default 'info',
  type             text not null,
  title            text not null,
  message          text,
  entity_type      text,
  entity_id        text,
  user_id          uuid references users(id) on delete set null,
  metadata         jsonb not null default '{}',
  acknowledged_by  uuid references users(id) on delete set null,
  acknowledged_at  timestamptz,
  created_at       timestamptz not null default now()
);
create index alerts_open_idx on alerts(created_at desc) where acknowledged_at is null;

create table audit_logs (
  id            bigint generated always as identity primary key,
  actor_type    actor_type not null,
  actor_id      text,
  actor_label   text,
  action        text not null,
  entity_type   text,
  entity_id     text,
  before_data   jsonb,
  after_data    jsonb,
  ip            inet,
  user_agent    text,
  risk_score    integer not null default 0 check (risk_score between 0 and 100),
  is_suspicious boolean not null default false,
  reasons       text[] not null default '{}',
  prev_hash     text,
  hash          text,
  created_at    timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs(entity_type, entity_id);
create index audit_logs_suspicious_idx on audit_logs(created_at desc) where is_suspicious;
create index audit_logs_actor_idx on audit_logs(actor_id, created_at desc);

-- Hash chain: hash = sha256(prev_hash || canonical row). Serialised with an
-- advisory lock so concurrent inserts can't fork the chain.
create or replace function audit_logs_chain() returns trigger
language plpgsql as $$
declare
  v_prev text;
begin
  perform pg_advisory_xact_lock(hashtext('audit_logs_chain'));
  select hash into v_prev from audit_logs order by id desc limit 1;
  new.created_at := coalesce(new.created_at, now());
  new.prev_hash := coalesce(v_prev, 'GENESIS');
  new.hash := encode(digest(
      new.prev_hash || '|' || new.id::text || '|' || new.actor_type::text || '|' ||
      coalesce(new.actor_id, '') || '|' || new.action || '|' ||
      coalesce(new.entity_type, '') || '|' || coalesce(new.entity_id, '') || '|' ||
      coalesce(new.before_data::text, '') || '|' || coalesce(new.after_data::text, '') || '|' ||
      new.risk_score::text || '|' || to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    'sha256'), 'hex');
  return new;
end $$;

create trigger audit_logs_chain_trg before insert on audit_logs
  for each row execute function audit_logs_chain();

create or replace function audit_logs_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end $$;

create trigger audit_logs_no_update before update or delete on audit_logs
  for each row execute function audit_logs_immutable();
create trigger audit_logs_no_truncate before truncate on audit_logs
  for each statement execute function audit_logs_immutable();

-- Verify the chain; returns the first broken row id or null when intact.
create or replace function audit_logs_verify() returns bigint
language plpgsql stable as $$
declare
  r record;
  v_prev text := 'GENESIS';
  v_hash text;
begin
  for r in select * from audit_logs order by id loop
    v_hash := encode(digest(
      v_prev || '|' || r.id::text || '|' || r.actor_type::text || '|' ||
      coalesce(r.actor_id, '') || '|' || r.action || '|' ||
      coalesce(r.entity_type, '') || '|' || coalesce(r.entity_id, '') || '|' ||
      coalesce(r.before_data::text, '') || '|' || coalesce(r.after_data::text, '') || '|' ||
      r.risk_score::text || '|' || to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      'sha256'), 'hex');
    if r.prev_hash is distinct from v_prev or r.hash is distinct from v_hash then
      return r.id;
    end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- Settings & rate limiting
-- -----------------------------------------------------------------------------
create table settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table rate_limits (
  key          text primary key,
  count        integer not null,
  window_start timestamptz not null
);

-- Fixed-window limiter. Returns true when the call is allowed.
create or replace function rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql as $$
declare
  v_count integer;
begin
  insert into rate_limits as rl (key, count, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set count = case when rl.window_start < now() - make_interval(secs => p_window_seconds) then 1 else rl.count + 1 end,
        window_start = case when rl.window_start < now() - make_interval(secs => p_window_seconds) then now() else rl.window_start end
  returning count into v_count;
  return v_count <= p_max;
end $$;

create or replace function next_invoice_number(p_prefix text) returns text
language sql as $$
  select p_prefix || '-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0');
$$;

-- Recalculate an invoice's paid/refunded totals and status from its payments.
create or replace function recalc_invoice(p_invoice_id uuid) returns void
language plpgsql as $$
declare
  v_paid bigint;
  v_refunded bigint;
  v_total bigint;
  v_status invoice_status;
begin
  select total_minor, status into v_total, v_status from invoices where id = p_invoice_id for update;
  select coalesce(sum(amount_minor), 0), coalesce(sum(amount_refunded_minor), 0)
    into v_paid, v_refunded
    from payments
   where invoice_id = p_invoice_id
     and status in ('succeeded', 'refunded', 'partially_refunded', 'disputed');

  update invoices set
    amount_paid_minor = v_paid,
    amount_refunded_minor = v_refunded,
    status = case
      when v_status in ('void', 'uncollectible') then v_status
      when v_paid >= v_total and v_refunded >= v_paid and v_paid > 0 then 'refunded'
      when v_paid >= v_total and v_refunded > 0 then 'partially_refunded'
      when v_paid >= v_total then 'paid'
      when v_status = 'draft' then 'draft'
      else 'open' end,
    paid_at = case when v_paid >= v_total then coalesce(paid_at, now()) else paid_at end
  where id = p_invoice_id;
end $$;

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['departments','users','brands','merchants','customers','invoices',
                           'payments','refunds','disputes','email_templates','inquiries','webhook_endpoints']
  loop
    execute format('create trigger %I_updated_at before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Lock down: RLS on, no policies, no grants for anon/authenticated
-- -----------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('alter table public.%I force row level security', t.tablename);
  end loop;
end $$;

-- "postgres" (the app's connection role) owns the tables. FORCE RLS would also
-- apply to the owner, so give the owner an explicit allow-all policy while the
-- Supabase API roles get nothing.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('create policy app_owner_all on public.%I for all to current_user using (true) with check (true)', t.tablename);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
    execute 'revoke all on all functions in schema public from anon';
    execute 'alter default privileges in schema public revoke all on tables from anon';
    execute 'alter default privileges in schema public revoke all on functions from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
    execute 'revoke all on all functions in schema public from authenticated';
    execute 'alter default privileges in schema public revoke all on tables from authenticated';
    execute 'alter default privileges in schema public revoke all on functions from authenticated';
  end if;
end $$;

-- Functions are executable by PUBLIC by default; restrict ours to the owner.
revoke execute on function set_updated_at(), audit_logs_chain(), audit_logs_immutable(),
  audit_logs_verify(), rate_limit_hit(text, integer, integer), next_invoice_number(text),
  recalc_invoice(uuid) from public;

-- -----------------------------------------------------------------------------
-- Seed data
-- -----------------------------------------------------------------------------
insert into departments (name, description) values
  ('Sales', 'Default sales department');

insert into settings (key, value) values
  ('security', '{"enforce_2fa_for_sellers": true, "max_failed_logins": 5, "lockout_minutes": 15}'),
  ('alerts',   '{"large_payment_minor": 500000, "email_admins": true, "slack_webhook_url": null}'),
  ('reminders','{"enabled": true, "days_after_due": [1, 3, 7], "max_reminders": 3}');

-- Global default email templates (brand-specific overrides are created in the CMS).
-- Variables: {{customer_name}} {{customer_email}} {{invoice_number}} {{invoice_amount}}
--            {{amount_due}} {{currency}} {{due_date}} {{pay_url}} {{brand_name}}
--            {{brand_logo_url}} {{brand_color}} {{support_email}} {{support_phone}}
--            {{brand_website}} {{invoice_title}} {{memo}} {{paid_amount}} {{paid_date}}
--            {{refund_amount}} {{card_last4}} {{failure_reason}} {{year}}
insert into email_templates (brand_id, type, subject, html) values
(null, 'invoice', 'Invoice {{invoice_number}} from {{brand_name}} — {{invoice_amount}}',
$tpl$<div style="background:#f4f5f7;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:{{brand_color}};padding:24px;text-align:center">{{#brand_logo_url}}<img src="{{brand_logo_url}}" alt="{{brand_name}}" style="max-height:48px">{{/brand_logo_url}}{{^brand_logo_url}}<span style="color:#fff;font-size:22px;font-weight:bold">{{brand_name}}</span>{{/brand_logo_url}}</td></tr>
<tr><td style="padding:32px">
<p style="font-size:16px;margin:0 0 16px">Hi {{customer_name}},</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 24px">Here is your invoice <strong>{{invoice_number}}</strong>{{#invoice_title}} for <strong>{{invoice_title}}</strong>{{/invoice_title}}. You can review and pay it securely online.</p>
<table role="presentation" width="100%" style="background:#f9fafb;border-radius:8px;margin:0 0 24px"><tr>
<td style="padding:16px"><div style="font-size:12px;color:#6b7280;text-transform:uppercase">Amount due</div><div style="font-size:26px;font-weight:bold">{{amount_due}}</div></td>
<td style="padding:16px;text-align:right"><div style="font-size:12px;color:#6b7280;text-transform:uppercase">Due date</div><div style="font-size:16px">{{due_date}}</div></td>
</tr></table>
<p style="text-align:center;margin:0 0 24px"><a href="{{pay_url}}" style="display:inline-block;background:{{brand_color}};color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;font-size:16px">View &amp; pay invoice</a></p>
{{#memo}}<p style="font-size:14px;color:#374151;line-height:1.6">{{memo}}</p>{{/memo}}
<p style="font-size:13px;color:#6b7280;line-height:1.6;margin:24px 0 0">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all">{{pay_url}}</span></p>
</td></tr>
<tr><td style="padding:20px 32px;background:#f9fafb;font-size:12px;color:#6b7280;text-align:center">Questions? Contact {{support_email}} {{support_phone}}<br>&copy; {{year}} {{brand_name}}</td></tr>
</table></div>$tpl$),
(null, 'reminder', 'Reminder: invoice {{invoice_number}} is due — {{amount_due}}',
$tpl$<div style="background:#f4f5f7;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:{{brand_color}};padding:24px;text-align:center;color:#fff;font-size:22px;font-weight:bold">{{brand_name}}</td></tr>
<tr><td style="padding:32px">
<p style="font-size:16px">Hi {{customer_name}},</p>
<p style="font-size:15px;line-height:1.6">This is a friendly reminder that invoice <strong>{{invoice_number}}</strong> for <strong>{{amount_due}}</strong> was due on {{due_date}}.</p>
<p style="text-align:center;margin:28px 0"><a href="{{pay_url}}" style="display:inline-block;background:{{brand_color}};color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold">Pay now</a></p>
<p style="font-size:13px;color:#6b7280">If you've already paid, please ignore this message.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#f9fafb;font-size:12px;color:#6b7280;text-align:center">{{support_email}} &middot; &copy; {{year}} {{brand_name}}</td></tr>
</table></div>$tpl$),
(null, 'receipt', 'Payment received — {{invoice_number}} ({{paid_amount}})',
$tpl$<div style="background:#f4f5f7;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:{{brand_color}};padding:24px;text-align:center;color:#fff;font-size:22px;font-weight:bold">{{brand_name}}</td></tr>
<tr><td style="padding:32px">
<p style="font-size:16px">Hi {{customer_name}},</p>
<p style="font-size:15px;line-height:1.6">Thank you! We received your payment of <strong>{{paid_amount}}</strong> for invoice <strong>{{invoice_number}}</strong> on {{paid_date}}.</p>
{{#card_last4}}<p style="font-size:14px;color:#374151">Paid with card ending in {{card_last4}}.</p>{{/card_last4}}
<p style="text-align:center;margin:28px 0"><a href="{{pay_url}}" style="color:{{brand_color}}">View receipt</a></p>
</td></tr>
<tr><td style="padding:20px 32px;background:#f9fafb;font-size:12px;color:#6b7280;text-align:center">{{support_email}} &middot; &copy; {{year}} {{brand_name}}</td></tr>
</table></div>$tpl$),
(null, 'payment_failed', 'Payment for {{invoice_number}} did not go through',
$tpl$<div style="background:#f4f5f7;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:{{brand_color}};padding:24px;text-align:center;color:#fff;font-size:22px;font-weight:bold">{{brand_name}}</td></tr>
<tr><td style="padding:32px">
<p style="font-size:16px">Hi {{customer_name}},</p>
<p style="font-size:15px;line-height:1.6">Your payment of <strong>{{amount_due}}</strong> for invoice {{invoice_number}} could not be completed{{#failure_reason}}: {{failure_reason}}{{/failure_reason}}.</p>
<p style="text-align:center;margin:28px 0"><a href="{{pay_url}}" style="display:inline-block;background:{{brand_color}};color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold">Try again</a></p>
</td></tr>
<tr><td style="padding:20px 32px;background:#f9fafb;font-size:12px;color:#6b7280;text-align:center">{{support_email}} &middot; &copy; {{year}} {{brand_name}}</td></tr>
</table></div>$tpl$),
(null, 'refund', 'Refund issued for {{invoice_number}}',
$tpl$<div style="background:#f4f5f7;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:{{brand_color}};padding:24px;text-align:center;color:#fff;font-size:22px;font-weight:bold">{{brand_name}}</td></tr>
<tr><td style="padding:32px">
<p style="font-size:16px">Hi {{customer_name}},</p>
<p style="font-size:15px;line-height:1.6">We've issued a refund of <strong>{{refund_amount}}</strong> for invoice {{invoice_number}}. Depending on your bank it can take 5–10 business days to appear.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#f9fafb;font-size:12px;color:#6b7280;text-align:center">{{support_email}} &middot; &copy; {{year}} {{brand_name}}</td></tr>
</table></div>$tpl$);

commit;
