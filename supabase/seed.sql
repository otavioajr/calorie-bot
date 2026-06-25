-- Local development seed.
--
-- The cloud Supabase project grants DML on public tables to the anon /
-- authenticated / service_role roles automatically via default privileges.
-- The local stack does not reproduce those grants for tables created by these
-- migrations, so the bot (service_role) and web panel (anon/authenticated)
-- would otherwise hit "permission denied for table ..." errors.
--
-- These grants are local-dev only and are NOT applied to the production
-- database (seeds run only on `supabase start` / `supabase db reset`).

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
