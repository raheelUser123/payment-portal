-- =============================================================================
-- Upgrade: Supabase Auth (login + 2FA) and SMTP-only email
-- =============================================================================
-- ONLY run this if you already ran 20261118000000_init.sql BEFORE this update.
-- On a brand-new Supabase project, just run the (updated) init file instead.
--
-- What it does:
--   * Removes the app's own password / 2FA columns and sessions table —
--     Supabase Auth now owns passwords, sessions and TOTP 2FA.
--   * Links public.users.id to auth.users.id.
--   * Users created with the old login system are removed (they have no
--     Supabase Auth login). Afterwards open /setup to create the first admin
--     again (SETUP_TOKEN must be set). Invoices, payments, logs etc. are kept.
--   * Turns off any brand email configured with the removed Resend option
--     (re-enter SMTP details for that brand).
-- =============================================================================
begin;

delete from public.users u where not exists (select 1 from auth.users a where a.id = u.id);

alter table public.users
  drop column if exists password_hash,
  drop column if exists totp_secret_enc,
  drop column if exists totp_enabled,
  drop column if exists totp_last_used_step,
  drop column if exists backup_codes,
  alter column id drop default;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_id_auth_fkey') then
    alter table public.users add constraint users_id_auth_fkey foreign key (id) references auth.users(id) on delete cascade;
  end if;
end $$;

drop table if exists public.sessions;

update public.settings set value = value - 'session_hours' - 'idle_minutes' where key = 'security';

update public.brands set email_provider = 'none', email_config_enc = null where email_provider::text = 'resend';

commit;
