-- Harden reset_user_data RPC:
--  1. Pin search_path on SECURITY DEFINER function to prevent caller-influenced name resolution.
--  2. Restrict EXECUTE to service_role only (function is invoked from server via service-role client;
--     no direct authenticated/anon access should be permitted).

ALTER FUNCTION reset_user_data(UUID) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION reset_user_data(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_user_data(UUID) FROM anon;
REVOKE ALL ON FUNCTION reset_user_data(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION reset_user_data(UUID) TO service_role;
