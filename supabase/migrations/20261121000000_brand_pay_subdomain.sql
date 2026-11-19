-- Payment subdomain per brand (e.g. pay.graphicwolves.com → this portal):
--   https://<subdomain>/pay/<brand-slug>/<token>
-- Links switch to the subdomain only after the portal verifies it is live.
alter table public.brands add column if not exists pay_domain citext unique;
alter table public.brands add column if not exists pay_domain_verified_at timestamptz;
