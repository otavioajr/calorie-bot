-- Fase 2: durable inbound work ledger with lease-based claim/reclaim.
-- Idempotent enqueue by (provider, business_account_id, provider_message_id).
-- SECURITY DEFINER RPCs; service_role only (mirrors find_or_create_meal).

CREATE TABLE IF NOT EXISTS inbound_work (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  user_phone TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'accepted',
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  payload_json JSONB NOT NULL,
  plan_json JSONB,
  plan_schema_version TEXT,
  error_code TEXT,
  error_message TEXT,
  accepted_at TIMESTAMPTZ DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inbound_work_provider_triple_unique
    UNIQUE (provider, business_account_id, provider_message_id),
  CONSTRAINT inbound_work_status_check CHECK (
    status IN (
      'accepted',
      'processing',
      'committed',
      'failed_retryable',
      'failed_terminal'
    )
  )
);

CREATE INDEX IF NOT EXISTS inbound_work_status_lease_idx
  ON inbound_work (status, lease_expires_at);

CREATE INDEX IF NOT EXISTS inbound_work_user_phone_event_idx
  ON inbound_work (user_phone, event_at);

-- ---------------------------------------------------------------------------
-- enqueue_inbound_work
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_inbound_work(
  p_provider TEXT,
  p_business_account_id TEXT,
  p_provider_message_id TEXT,
  p_user_phone TEXT,
  p_event_at TIMESTAMPTZ,
  p_payload_json JSONB
)
RETURNS TABLE (work_id UUID, status TEXT, was_inserted BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows INTEGER := 0;
  v_row inbound_work%ROWTYPE;
BEGIN
  INSERT INTO inbound_work (
    provider,
    business_account_id,
    provider_message_id,
    user_phone,
    event_at,
    payload_json,
    status,
    accepted_at
  )
  VALUES (
    p_provider,
    p_business_account_id,
    p_provider_message_id,
    p_user_phone,
    p_event_at,
    p_payload_json,
    'accepted',
    NOW()
  )
  ON CONFLICT ON CONSTRAINT inbound_work_provider_triple_unique DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT * INTO v_row
  FROM inbound_work
  WHERE provider = p_provider
    AND business_account_id = p_business_account_id
    AND provider_message_id = p_provider_message_id;

  work_id := v_row.id;
  status := v_row.status;
  was_inserted := v_rows > 0;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- claim_inbound_work
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_inbound_work(
  p_work_id UUID,
  p_owner TEXT,
  p_lease_seconds INTEGER DEFAULT 90
)
RETURNS TABLE (claimed BOOLEAN, status TEXT, attempt INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row inbound_work%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_row
  FROM inbound_work
  WHERE id = p_work_id
  FOR UPDATE;

  IF NOT FOUND THEN
    claimed := FALSE;
    status := NULL;
    attempt := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.status = 'committed' OR v_row.status = 'failed_terminal' THEN
    claimed := FALSE;
    status := v_row.status;
    attempt := v_row.attempt;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.status = 'processing' AND v_row.lease_expires_at IS NOT NULL AND v_row.lease_expires_at > v_now THEN
    claimed := FALSE;
    status := v_row.status;
    attempt := v_row.attempt;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.status IN ('accepted', 'failed_retryable')
     OR (v_row.status = 'processing' AND (v_row.lease_expires_at IS NULL OR v_row.lease_expires_at <= v_now)) THEN
    UPDATE inbound_work
    SET
      status = 'processing',
      attempt = v_row.attempt + 1,
      lease_owner = p_owner,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      processing_started_at = COALESCE(processing_started_at, v_now),
      updated_at = v_now
    WHERE id = p_work_id
    RETURNING * INTO v_row;

    claimed := TRUE;
    status := v_row.status;
    attempt := v_row.attempt;
    RETURN NEXT;
    RETURN;
  END IF;

  claimed := FALSE;
  status := v_row.status;
  attempt := v_row.attempt;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- complete_inbound_work
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_inbound_work(
  p_work_id UUID,
  p_owner TEXT,
  p_status TEXT,
  p_error_code TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
)
RETURNS TABLE (completed BOOLEAN, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row inbound_work%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_status NOT IN ('committed', 'failed_retryable', 'failed_terminal') THEN
    completed := FALSE;
    status := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_row
  FROM inbound_work
  WHERE id = p_work_id
  FOR UPDATE;

  IF NOT FOUND OR v_row.lease_owner IS DISTINCT FROM p_owner OR v_row.status <> 'processing' THEN
    completed := FALSE;
    status := COALESCE(v_row.status, NULL);
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE inbound_work
  SET
    status = p_status,
    lease_owner = NULL,
    lease_expires_at = NULL,
    error_code = p_error_code,
    error_message = LEFT(p_error_message, 500),
    terminal_at = v_now,
    updated_at = v_now
  WHERE id = p_work_id
  RETURNING * INTO v_row;

  completed := TRUE;
  status := v_row.status;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- list_stale_inbound_work
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_stale_inbound_work(
  p_limit INTEGER DEFAULT 5
)
RETURNS TABLE (work_id UUID, status TEXT, attempt INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
BEGIN
  RETURN QUERY
  SELECT iw.id, iw.status, iw.attempt
  FROM inbound_work iw
  WHERE (
    iw.status = 'accepted'
    OR (iw.status = 'processing' AND (iw.lease_expires_at IS NULL OR iw.lease_expires_at <= v_now))
    OR (iw.status = 'failed_retryable' AND iw.attempt < 5)
  )
  ORDER BY iw.received_at ASC
  LIMIT GREATEST(p_limit, 0);
END;
$$;

REVOKE ALL ON FUNCTION enqueue_inbound_work(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_inbound_work(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB) FROM anon;
REVOKE ALL ON FUNCTION enqueue_inbound_work(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION enqueue_inbound_work(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB) TO service_role;

REVOKE ALL ON FUNCTION claim_inbound_work(UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_inbound_work(UUID, TEXT, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION claim_inbound_work(UUID, TEXT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_inbound_work(UUID, TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION complete_inbound_work(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_inbound_work(UUID, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION complete_inbound_work(UUID, TEXT, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_inbound_work(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION list_stale_inbound_work(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_stale_inbound_work(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION list_stale_inbound_work(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION list_stale_inbound_work(INTEGER) TO service_role;
