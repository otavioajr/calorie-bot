-- Fase 2b: durable WhatsApp outbox and append-only provider status ledger.
-- Additive and inert until OUTBOX_MODE is enabled by the application.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, service_role;

-- Durable rollback fence. A suspended generation is never reactivated; a new
-- rollout must use a new generation identifier.
CREATE TABLE private.outbox_suspended_generations (
  generation TEXT PRIMARY KEY,
  suspended_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL,
  CONSTRAINT outbox_suspended_generations_generation_check CHECK (
    BTRIM(generation) <> ''
  ),
  CONSTRAINT outbox_suspended_generations_reason_check CHECK (
    BTRIM(reason) <> ''
  )
);
REVOKE ALL ON TABLE private.outbox_suspended_generations
  FROM PUBLIC, anon, authenticated, service_role;

-- Per-message fence used only when the enqueue result is ambiguous. It shares
-- the enqueue advisory lock so a direct fallback can never race a late durable
-- row that the sweeper would later deliver again.
CREATE TABLE private.outbox_fallback_fences (
  idempotency_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  rollout_generation TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT outbox_fallback_fences_key_check CHECK (
    BTRIM(idempotency_key) <> ''
  ),
  CONSTRAINT outbox_fallback_fences_recipient_check CHECK (
    recipient ~ '^[0-9]{7,15}$'
  ),
  CONSTRAINT outbox_fallback_fences_hash_check CHECK (
    payload_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT outbox_fallback_fences_generation_check CHECK (
    BTRIM(rollout_generation) <> ''
  )
);
REVOKE ALL ON TABLE private.outbox_fallback_fences
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.outbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  work_id UUID REFERENCES public.inbound_work(id) ON DELETE SET NULL,
  emission_index INTEGER,
  idempotency_key TEXT NOT NULL,
  message_kind TEXT NOT NULL,
  payload_json JSONB,
  payload_hash TEXT NOT NULL,
  reply_to_message_id TEXT,
  resource_type TEXT,
  resource_id UUID,
  resource_metadata JSONB,
  sequence_no BIGINT NOT NULL,
  rollout_mode TEXT NOT NULL,
  rollout_generation TEXT NOT NULL,
  delivery_authority BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  unknown_reconcile_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_token UUID,
  last_lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  provider_message_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  accepted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  payload_redacted_at TIMESTAMPTZ,
  bot_message_projected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT outbox_messages_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT outbox_messages_recipient_sequence_unique UNIQUE (recipient, sequence_no),
  CONSTRAINT outbox_messages_recipient_check CHECK (recipient ~ '^[0-9]{7,15}$'),
  CONSTRAINT outbox_messages_emission_index_check CHECK (
    emission_index IS NULL OR emission_index >= 0
  ),
  CONSTRAINT outbox_messages_kind_check CHECK (
    message_kind IN ('progress', 'prompt', 'terminal', 'otp', 'reminder')
  ),
  CONSTRAINT outbox_messages_payload_hash_check CHECK (
    payload_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT outbox_messages_resource_type_check CHECK (
    resource_type IS NULL OR resource_type IN ('meal', 'summary', 'query', 'weight')
  ),
  CONSTRAINT outbox_messages_rollout_mode_check CHECK (
    rollout_mode IN ('shadow', 'active')
  ),
  CONSTRAINT outbox_messages_rollout_generation_check CHECK (
    BTRIM(rollout_generation) <> ''
  ),
  CONSTRAINT outbox_messages_delivery_authority_check CHECK (
    delivery_authority = (rollout_mode = 'active')
  ),
  CONSTRAINT outbox_messages_status_check CHECK (
    status IN (
      'pending',
      'sending',
      'retryable',
      'unknown',
      'api_accepted',
      'sent',
      'delivered',
      'read',
      'failed_terminal',
      'expired',
      'superseded',
      'suspended'
    )
  ),
  CONSTRAINT outbox_messages_attempt_check CHECK (attempt >= 0),
  CONSTRAINT outbox_messages_max_attempts_check CHECK (
    max_attempts BETWEEN 1 AND 5
  ),
  CONSTRAINT outbox_messages_attempt_limit_check CHECK (attempt <= max_attempts),
  CONSTRAINT outbox_messages_lease_shape_check CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX outbox_messages_claim_idx
  ON public.outbox_messages (
    rollout_generation,
    status,
    next_attempt_at,
    expires_at,
    sequence_no
  )
  WHERE delivery_authority;

CREATE INDEX outbox_messages_recipient_fifo_idx
  ON public.outbox_messages (recipient, sequence_no, status);

CREATE INDEX outbox_messages_provider_message_idx
  ON public.outbox_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX outbox_messages_work_emission_idx
  ON public.outbox_messages (work_id, emission_index)
  WHERE work_id IS NOT NULL;

CREATE INDEX outbox_messages_user_id_idx
  ON public.outbox_messages (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX outbox_messages_expiry_idx
  ON public.outbox_messages (rollout_generation, expires_at)
  WHERE (
    status IN ('sending', 'unknown')
    OR (
      delivery_authority
      AND status IN ('pending', 'retryable')
    )
  );

CREATE INDEX outbox_messages_stale_lease_idx
  ON public.outbox_messages (rollout_generation, lease_expires_at)
  WHERE status = 'sending';

CREATE INDEX outbox_messages_terminal_lease_idx
  ON public.outbox_messages (rollout_generation, lease_expires_at)
  WHERE lease_token IS NOT NULL
    AND status IN (
      'api_accepted', 'sent', 'delivered', 'read', 'failed_terminal',
      'expired', 'superseded', 'suspended'
    );

CREATE INDEX outbox_messages_unknown_reconcile_idx
  ON public.outbox_messages (rollout_generation, unknown_reconcile_at)
  WHERE status = 'unknown' AND terminal_at IS NULL;

CREATE INDEX outbox_messages_redaction_idx
  ON public.outbox_messages (created_at)
  WHERE payload_json IS NOT NULL AND payload_redacted_at IS NULL;

CREATE TABLE public.outbox_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id UUID REFERENCES public.outbox_messages(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  attempt INTEGER,
  provider_message_id TEXT,
  callback_correlation_id TEXT,
  http_status INTEGER,
  meta_code INTEGER,
  meta_subcode INTEGER,
  error_code TEXT,
  error_message TEXT,
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_payload JSONB,
  related_event_id UUID REFERENCES public.outbox_status_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT outbox_status_events_previous_status_check CHECK (
    previous_status IS NULL OR previous_status IN (
      'pending', 'sending', 'retryable', 'unknown', 'api_accepted', 'sent',
      'delivered', 'read', 'failed_terminal', 'expired', 'superseded', 'suspended'
    )
  ),
  CONSTRAINT outbox_status_events_new_status_check CHECK (
    new_status IS NULL OR new_status IN (
      'pending', 'sending', 'retryable', 'unknown', 'api_accepted', 'sent',
      'delivered', 'read', 'failed_terminal', 'expired', 'superseded', 'suspended'
    )
  )
);

CREATE INDEX outbox_status_events_outbox_created_idx
  ON public.outbox_status_events (outbox_id, created_at);

CREATE INDEX outbox_status_events_provider_message_idx
  ON public.outbox_status_events (provider_message_id, created_at)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX outbox_status_events_correlation_idx
  ON public.outbox_status_events (callback_correlation_id, created_at)
  WHERE callback_correlation_id IS NOT NULL;

CREATE INDEX outbox_status_events_related_event_idx
  ON public.outbox_status_events (related_event_id)
  WHERE related_event_id IS NOT NULL;

ALTER TABLE public.outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox_status_events ENABLE ROW LEVEL SECURITY;

-- Internal helper. The caller already holds the outbox row lock. Projection and
-- marker update live in the same transaction, avoiding duplicate bot_messages
-- without a risky uniqueness constraint on the existing production table.
CREATE OR REPLACE FUNCTION private.project_outbox_bot_message(
  p_outbox_id UUID,
  p_provider_message_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.outbox_messages%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.outbox_messages AS om
  WHERE om.id = p_outbox_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_row.bot_message_projected_at IS NOT NULL
     OR v_row.user_id IS NULL
     OR p_provider_message_id IS NULL
     OR BTRIM(p_provider_message_id) = '' THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.bot_messages (
    user_id,
    message_id,
    direction,
    resource_type,
    resource_id,
    metadata
  ) VALUES (
    v_row.user_id,
    p_provider_message_id,
    'outgoing',
    v_row.resource_type,
    v_row.resource_id,
    COALESCE(v_row.resource_metadata, '{}'::JSONB)
      || pg_catalog.jsonb_build_object('outbox_id', v_row.id)
  );

  UPDATE public.outbox_messages AS om
  SET bot_message_projected_at = NOW(), updated_at = NOW()
  WHERE om.id = p_outbox_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION private.project_outbox_bot_message(UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_outbox_messages(
  p_owner TEXT,
  p_generation TEXT,
  p_limit INTEGER DEFAULT 5,
  p_lease_seconds INTEGER DEFAULT 90,
  p_outbox_id UUID DEFAULT NULL,
  p_allow_unfinalized BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  outbox_id UUID,
  recipient TEXT,
  message_kind TEXT,
  payload_json JSONB,
  payload_hash TEXT,
  reply_to_message_id TEXT,
  sequence_no BIGINT,
  attempt INTEGER,
  max_attempts INTEGER,
  expires_at TIMESTAMPTZ,
  lease_token UUID,
  user_id UUID,
  work_id UUID,
  resource_type TEXT,
  resource_id UUID,
  resource_metadata JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_candidate RECORD;
  v_row public.outbox_messages%ROWTYPE;
  v_previous_status TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_claimed INTEGER := 0;
  v_lease_token UUID;
  v_start_headroom_seconds INTEGER;
BEGIN
  IF p_owner IS NULL OR BTRIM(p_owner) = ''
     OR p_generation IS NULL OR BTRIM(p_generation) = ''
     OR p_limit IS NULL
     OR p_limit < 0 OR p_limit > 100
     OR p_lease_seconds IS NULL
     OR p_lease_seconds < 1 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid outbox claim input' USING ERRCODE = '22023';
  END IF;

  v_start_headroom_seconds :=
    p_lease_seconds + 60 + GREATEST(p_lease_seconds, 60) + 30;

  -- Serialize claim maintenance with generation-wide rollback before taking
  -- any row lock. A busy generation is safe to skip until the next sweep.
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('outbox-generation:' || p_generation, 0)
  ) THEN
    RETURN;
  END IF;

  FOR v_candidate IN
    SELECT om.id, om.recipient
    FROM public.outbox_messages AS om
    WHERE om.rollout_generation = p_generation
      AND (p_outbox_id IS NULL OR om.id = p_outbox_id)
      AND (
        om.status IN ('sending', 'unknown')
        OR (
          om.delivery_authority
          AND om.status IN ('pending', 'retryable')
        )
      )
      AND om.expires_at <= v_now
    ORDER BY om.expires_at, om.id
    LIMIT LEAST(GREATEST(p_limit * 4, 10), 100)
  LOOP
    IF NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'outbox-recipient:' || v_candidate.recipient,
        0
      )
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_row
    FROM public.outbox_messages AS om
    WHERE om.id = v_candidate.id
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND
       OR v_row.rollout_generation IS DISTINCT FROM p_generation
       OR v_row.recipient IS DISTINCT FROM v_candidate.recipient
       OR (p_outbox_id IS NOT NULL AND v_row.id <> p_outbox_id)
       OR NOT (
         v_row.status IN ('sending', 'unknown')
         OR (
           v_row.delivery_authority
           AND v_row.status IN ('pending', 'retryable')
         )
       )
       OR v_row.expires_at > v_now THEN
      CONTINUE;
    END IF;

    v_previous_status := v_row.status;
    UPDATE public.outbox_messages AS om
    SET
      status = 'expired',
      terminal_at = COALESCE(om.terminal_at, v_now),
      next_attempt_at = NULL,
      lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
    WHERE om.id = v_row.id
    RETURNING * INTO v_row;

    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt, event_at
    ) VALUES (
      v_row.id, 'expired', v_previous_status, 'expired', v_row.attempt, v_now
    );
  END LOOP;

  FOR v_candidate IN
    SELECT om.id, om.recipient
    FROM public.outbox_messages AS om
    WHERE om.rollout_generation = p_generation
      AND (p_outbox_id IS NULL OR om.id = p_outbox_id)
      AND om.status = 'sending'
      AND (om.lease_expires_at IS NULL OR om.lease_expires_at <= v_now)
    ORDER BY om.lease_expires_at NULLS FIRST, om.id
    LIMIT LEAST(GREATEST(p_limit * 4, 10), 100)
  LOOP
    IF NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'outbox-recipient:' || v_candidate.recipient,
        0
      )
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_row
    FROM public.outbox_messages AS om
    WHERE om.id = v_candidate.id
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND
       OR v_row.rollout_generation IS DISTINCT FROM p_generation
       OR v_row.recipient IS DISTINCT FROM v_candidate.recipient
       OR (p_outbox_id IS NOT NULL AND v_row.id <> p_outbox_id)
       OR v_row.status <> 'sending'
       OR (
         v_row.lease_expires_at IS NOT NULL
         AND v_row.lease_expires_at > v_now
       ) THEN
      CONTINUE;
    END IF;

    UPDATE public.outbox_messages AS om
    SET
      status = 'unknown',
      unknown_reconcile_at = LEAST(
        om.expires_at,
        GREATEST(v_now, COALESCE(om.lease_expires_at, v_now))
          + INTERVAL '5 minutes'
      ),
      next_attempt_at = NULL,
      lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error_code = 'stale_sending_lease',
      last_error_message = 'delivery outcome is unknown after the sending lease expired',
      updated_at = v_now
    WHERE om.id = v_row.id
    RETURNING * INTO v_row;

    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt,
      error_code, event_at
    ) VALUES (
      v_row.id, 'lease_expired_unknown', 'sending', 'unknown',
      v_row.attempt, 'stale_sending_lease', v_now
    );
  END LOOP;

  -- A callback can win the race with the worker persisting its HTTP result.
  -- Preserve the lease long enough for that result to be recorded, then clear
  -- it once expired so a worker crash cannot leave a terminal lease behind.
  FOR v_candidate IN
    SELECT om.id, om.recipient
    FROM public.outbox_messages AS om
    WHERE om.lease_token IS NOT NULL
      AND om.rollout_generation = p_generation
      AND (p_outbox_id IS NULL OR om.id = p_outbox_id)
      AND om.lease_expires_at <= v_now
      AND om.status IN (
        'api_accepted', 'sent', 'delivered', 'read', 'failed_terminal',
        'expired', 'superseded', 'suspended'
      )
    ORDER BY om.lease_expires_at, om.id
    LIMIT LEAST(GREATEST(p_limit * 4, 10), 100)
  LOOP
    IF NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'outbox-recipient:' || v_candidate.recipient,
        0
      )
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_row
    FROM public.outbox_messages AS om
    WHERE om.id = v_candidate.id
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND
       OR v_row.rollout_generation IS DISTINCT FROM p_generation
       OR v_row.recipient IS DISTINCT FROM v_candidate.recipient
       OR (p_outbox_id IS NOT NULL AND v_row.id <> p_outbox_id)
       OR v_row.lease_token IS NULL
       OR v_row.lease_expires_at IS NULL
       OR v_row.lease_expires_at > v_now
       OR v_row.status NOT IN (
         'api_accepted', 'sent', 'delivered', 'read', 'failed_terminal',
         'expired', 'superseded', 'suspended'
       ) THEN
      CONTINUE;
    END IF;

    v_previous_status := v_row.status;
    UPDATE public.outbox_messages AS om
    SET
      lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
    WHERE om.id = v_row.id
    RETURNING * INTO v_row;

    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt, event_at
    ) VALUES (
      v_row.id, 'terminal_lease_released', v_previous_status,
      v_previous_status, v_row.attempt, v_now
    );
  END LOOP;

  FOR v_candidate IN
    SELECT om.id, om.recipient
    FROM public.outbox_messages AS om
    WHERE om.status = 'unknown'
      AND om.rollout_generation = p_generation
      AND (p_outbox_id IS NULL OR om.id = p_outbox_id)
      AND om.unknown_reconcile_at <= v_now
      AND om.terminal_at IS NULL
    ORDER BY om.unknown_reconcile_at, om.id
    LIMIT LEAST(GREATEST(p_limit * 4, 10), 100)
  LOOP
    IF NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'outbox-recipient:' || v_candidate.recipient,
        0
      )
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_row
    FROM public.outbox_messages AS om
    WHERE om.id = v_candidate.id
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND
       OR v_row.rollout_generation IS DISTINCT FROM p_generation
       OR v_row.recipient IS DISTINCT FROM v_candidate.recipient
       OR (p_outbox_id IS NOT NULL AND v_row.id <> p_outbox_id)
       OR v_row.status <> 'unknown'
       OR v_row.unknown_reconcile_at IS NULL
       OR v_row.unknown_reconcile_at > v_now
       OR v_row.terminal_at IS NOT NULL THEN
      CONTINUE;
    END IF;

    UPDATE public.outbox_messages AS om
    SET terminal_at = v_now, updated_at = v_now
    WHERE om.id = v_row.id
    RETURNING * INTO v_row;

    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt, event_at
    ) VALUES (
      v_row.id, 'unknown_reconciled', 'unknown', 'unknown',
      v_row.attempt, v_now
    );
  END LOOP;

  -- A suspended generation may still have attempts authorized before its
  -- fence. Drain those attempts above, but never grant a new delivery lease.
  IF EXISTS (
    SELECT 1
    FROM private.outbox_suspended_generations AS osg
    WHERE osg.generation = p_generation
  ) THEN
    RETURN;
  END IF;

  FOR v_candidate IN
    SELECT om.id, om.recipient, om.sequence_no
    FROM public.outbox_messages AS om
    WHERE om.delivery_authority
      AND om.rollout_mode = 'active'
      AND om.rollout_generation = p_generation
      AND (p_outbox_id IS NULL OR om.id = p_outbox_id)
      AND om.status IN ('pending', 'retryable')
      AND om.attempt < om.max_attempts
      AND om.expires_at > v_now + pg_catalog.make_interval(
        secs => v_start_headroom_seconds
      )
      AND COALESCE(om.next_attempt_at, v_now) <= v_now
      AND (
        (p_allow_unfinalized AND om.attempt = 0)
        OR om.work_id IS NULL
        OR om.message_kind = 'progress'
        OR EXISTS (
          SELECT 1
          FROM public.outbox_status_events AS finalized_event
          WHERE finalized_event.outbox_id = om.id
            AND finalized_event.event_type = 'scope_finalized'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.outbox_messages AS earlier
        WHERE earlier.recipient = om.recipient
          AND earlier.sequence_no < om.sequence_no
          AND earlier.delivery_authority
          AND (
            earlier.status IN ('pending', 'sending', 'retryable')
            OR (
              earlier.status = 'unknown'
              AND earlier.terminal_at IS NULL
            )
          )
      )
    ORDER BY om.sequence_no, om.created_at, om.id
    LIMIT GREATEST(p_limit * 8, p_limit)
  LOOP
    EXIT WHEN v_claimed >= p_limit;

    IF NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('outbox-recipient:' || v_candidate.recipient, 0)
    ) THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_row
    FROM public.outbox_messages AS om
    WHERE om.id = v_candidate.id
    FOR UPDATE;

    IF NOT FOUND
       OR NOT v_row.delivery_authority
       OR v_row.rollout_generation <> p_generation
       OR v_row.status NOT IN ('pending', 'retryable')
       OR v_row.attempt >= v_row.max_attempts
       OR v_row.expires_at <= v_now + pg_catalog.make_interval(
         secs => v_start_headroom_seconds
       )
       OR COALESCE(v_row.next_attempt_at, v_now) > v_now
       OR (
         NOT (p_allow_unfinalized AND v_row.attempt = 0)
         AND v_row.work_id IS NOT NULL
         AND v_row.message_kind <> 'progress'
         AND NOT EXISTS (
           SELECT 1
           FROM public.outbox_status_events AS finalized_event
           WHERE finalized_event.outbox_id = v_row.id
             AND finalized_event.event_type = 'scope_finalized'
         )
       )
       OR EXISTS (
         SELECT 1
         FROM public.outbox_messages AS earlier
         WHERE earlier.recipient = v_row.recipient
           AND earlier.sequence_no < v_row.sequence_no
           AND earlier.delivery_authority
           AND (
             earlier.status IN ('pending', 'sending', 'retryable')
             OR (
               earlier.status = 'unknown'
               AND earlier.terminal_at IS NULL
             )
           )
       ) THEN
      CONTINUE;
    END IF;

    v_previous_status := v_row.status;
    v_lease_token := gen_random_uuid();
    UPDATE public.outbox_messages AS om
    SET
      status = 'sending',
      attempt = om.attempt + 1,
      lease_owner = p_owner,
      lease_token = v_lease_token,
      last_lease_token = v_lease_token,
      lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
      next_attempt_at = NULL,
      updated_at = v_now
    WHERE om.id = v_row.id
    RETURNING * INTO v_row;

    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt, event_at
    ) VALUES (
      v_row.id, 'claimed', v_previous_status, 'sending', v_row.attempt, v_now
    );

    outbox_id := v_row.id;
    recipient := v_row.recipient;
    message_kind := v_row.message_kind;
    payload_json := v_row.payload_json;
    payload_hash := v_row.payload_hash;
    reply_to_message_id := v_row.reply_to_message_id;
    sequence_no := v_row.sequence_no;
    attempt := v_row.attempt;
    max_attempts := v_row.max_attempts;
    expires_at := v_row.expires_at;
    lease_token := v_row.lease_token;
    user_id := v_row.user_id;
    work_id := v_row.work_id;
    resource_type := v_row.resource_type;
    resource_id := v_row.resource_id;
    resource_metadata := v_row.resource_metadata;
    v_claimed := v_claimed + 1;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_outbox_messages(
  TEXT, TEXT, INTEGER, INTEGER, UUID, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_outbox_attempt_result(
  p_outbox_id UUID,
  p_lease_token UUID,
  p_outcome TEXT,
  p_provider_message_id TEXT DEFAULT NULL,
  p_next_attempt_at TIMESTAMPTZ DEFAULT NULL,
  p_http_status INTEGER DEFAULT NULL,
  p_meta_code INTEGER DEFAULT NULL,
  p_meta_subcode INTEGER DEFAULT NULL,
  p_error_code TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_response_json JSONB DEFAULT NULL
)
RETURNS TABLE (
  applied BOOLEAN,
  status TEXT,
  attempt INTEGER,
  provider_message_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.outbox_messages%ROWTYPE;
  v_previous_status TEXT;
  v_new_status TEXT;
  v_orphan public.outbox_status_events%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
  v_shadow_direct BOOLEAN := FALSE;
  v_fallback_direct BOOLEAN := FALSE;
  v_late_result BOOLEAN := FALSE;
BEGIN
  IF p_outcome NOT IN ('api_accepted', 'retryable', 'failed_terminal', 'unknown') THEN
    RAISE EXCEPTION 'invalid outbox attempt outcome' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'api_accepted'
     AND (p_provider_message_id IS NULL OR BTRIM(p_provider_message_id) = '') THEN
    RAISE EXCEPTION 'api_accepted requires a provider message id'
      USING ERRCODE = '22023';
  END IF;

  IF p_provider_message_id IS NOT NULL
     AND BTRIM(p_provider_message_id) <> '' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'outbox-provider-message:' || p_provider_message_id,
        0
      )
    );
  END IF;

  SELECT * INTO v_row
  FROM public.outbox_messages AS om
  WHERE om.id = p_outbox_id
  FOR UPDATE;

  IF FOUND THEN
    v_shadow_direct :=
      v_row.rollout_mode = 'shadow'
      AND NOT v_row.delivery_authority
      AND v_row.lease_token IS NULL
      AND p_lease_token IS NULL
      AND v_row.attempt = 0
      AND v_row.status IN ('pending', 'sent', 'delivered', 'read', 'failed_terminal');
    v_fallback_direct :=
      NOT v_shadow_direct
      AND v_row.status = 'suspended'
      AND v_row.suspended_reason LIKE 'enqueue_fallback:%'
      AND v_row.lease_token IS NOT NULL
      AND p_lease_token IS NOT NULL
      AND v_row.lease_token = p_lease_token
      AND v_row.attempt = 1;
    v_late_result :=
      NOT v_shadow_direct
      AND NOT v_fallback_direct
      AND p_lease_token IS NOT NULL
      AND v_row.lease_token IS NULL
      AND v_row.last_lease_token IS NOT NULL
      AND v_row.last_lease_token = p_lease_token
      AND v_row.attempt > 0;
  END IF;

  IF NOT FOUND OR (
    NOT v_shadow_direct
    AND NOT v_fallback_direct
    AND NOT v_late_result
    AND v_row.lease_token IS DISTINCT FROM p_lease_token
  ) THEN
    applied := FALSE;
    status := CASE WHEN FOUND THEN v_row.status ELSE NULL END;
    attempt := CASE WHEN FOUND THEN v_row.attempt ELSE NULL END;
    provider_message_id := CASE WHEN FOUND THEN v_row.provider_message_id ELSE NULL END;
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT v_shadow_direct
     AND NOT v_fallback_direct
     AND NOT v_late_result
     AND v_row.status NOT IN ('sending', 'sent', 'delivered', 'read', 'failed_terminal') THEN
    applied := FALSE;
    status := v_row.status;
    attempt := v_row.attempt;
    provider_message_id := v_row.provider_message_id;
    RETURN NEXT;
    RETURN;
  END IF;

  v_previous_status := v_row.status;
  v_new_status := CASE
    WHEN v_fallback_direct THEN v_row.status
    WHEN v_late_result THEN
      CASE
        WHEN v_row.status = 'unknown' AND p_outcome = 'api_accepted'
        THEN 'api_accepted'
        ELSE v_row.status
      END
    WHEN v_row.status IN ('sent', 'delivered', 'read', 'failed_terminal')
    THEN v_row.status
    WHEN v_shadow_direct AND p_outcome = 'retryable' THEN 'failed_terminal'
    ELSE CASE p_outcome
      WHEN 'api_accepted' THEN 'api_accepted'
      WHEN 'retryable' THEN
        CASE
          WHEN v_row.status <> 'sending'
            OR v_row.attempt >= v_row.max_attempts
            OR v_row.expires_at <= v_now
          THEN 'failed_terminal'
          ELSE 'retryable'
        END
      WHEN 'unknown' THEN 'unknown'
      ELSE 'failed_terminal'
    END
  END;

  UPDATE public.outbox_messages AS om
  SET
    status = v_new_status,
    attempt = CASE
      WHEN v_shadow_direct THEN 1
      ELSE om.attempt
    END,
    provider_message_id = CASE
      WHEN p_outcome = 'api_accepted' AND p_provider_message_id IS NOT NULL
      THEN p_provider_message_id
      ELSE om.provider_message_id
    END,
    accepted_at = CASE
      WHEN p_outcome = 'api_accepted' THEN COALESCE(om.accepted_at, v_now)
      ELSE om.accepted_at
    END,
    next_attempt_at = CASE
      WHEN v_new_status = 'retryable'
      THEN LEAST(COALESCE(p_next_attempt_at, v_now), om.expires_at)
      ELSE NULL
    END,
    unknown_reconcile_at = CASE
      WHEN v_new_status = 'unknown'
      THEN LEAST(v_now + INTERVAL '5 minutes', om.expires_at)
      ELSE om.unknown_reconcile_at
    END,
    last_error_code = p_error_code,
    last_error_message = LEFT(p_error_message, 500),
    terminal_at = CASE
      WHEN p_outcome = 'api_accepted' OR v_new_status = 'failed_terminal'
      THEN COALESCE(om.terminal_at, v_now)
      ELSE om.terminal_at
    END,
    payload_json = CASE
      WHEN om.message_kind = 'otp' AND p_outcome = 'api_accepted' THEN NULL
      ELSE om.payload_json
    END,
    payload_redacted_at = CASE
      WHEN om.message_kind = 'otp' AND p_outcome = 'api_accepted'
      THEN COALESCE(om.payload_redacted_at, v_now)
      ELSE om.payload_redacted_at
    END,
    lease_owner = NULL,
    lease_token = NULL,
    last_lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = v_now
  WHERE om.id = p_outbox_id
  RETURNING * INTO v_row;

  INSERT INTO public.outbox_status_events (
    outbox_id, event_type, previous_status, new_status, attempt,
    provider_message_id, http_status, meta_code, meta_subcode,
    error_code, error_message, event_at, event_payload
  ) VALUES (
    v_row.id,
    CASE
      WHEN v_late_result THEN 'late_attempt_result'
      WHEN v_fallback_direct THEN 'fallback_attempt_result'
      ELSE 'attempt_result'
    END,
    v_previous_status,
    v_row.status,
    v_row.attempt,
    p_provider_message_id, p_http_status, p_meta_code, p_meta_subcode,
    p_error_code, LEFT(p_error_message, 500), v_now, p_response_json
  );

  IF p_outcome = 'api_accepted' AND p_provider_message_id IS NOT NULL THEN
    PERFORM private.project_outbox_bot_message(v_row.id, p_provider_message_id);

    FOR v_orphan IN
      SELECT *
      FROM public.outbox_status_events AS ose
      WHERE ose.outbox_id IS NULL
        AND ose.event_type = 'callback'
        AND ose.provider_message_id = p_provider_message_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.outbox_status_events AS linked
          WHERE linked.related_event_id = ose.id
            AND linked.event_type = 'orphan_callback_linked'
        )
      ORDER BY ose.event_at, ose.created_at, ose.id
    LOOP
      PERFORM public.apply_outbox_callback(
        p_provider_message_id,
        COALESCE(v_orphan.event_payload->>'status', 'unknown'),
        v_orphan.event_at,
        v_row.id,
        v_orphan.meta_code,
        v_orphan.meta_subcode,
        v_orphan.error_message,
        v_orphan.event_payload
      );
      INSERT INTO public.outbox_status_events (
        outbox_id, event_type, provider_message_id, related_event_id, event_at
      ) VALUES (
        v_row.id, 'orphan_callback_linked', p_provider_message_id,
        v_orphan.id, v_now
      );
    END LOOP;
  END IF;

  SELECT * INTO v_row
  FROM public.outbox_messages AS om
  WHERE om.id = p_outbox_id;

  applied := TRUE;
  status := v_row.status;
  attempt := v_row.attempt;
  provider_message_id := v_row.provider_message_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.record_outbox_attempt_result(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER,
  TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_outbox_callback(
  p_provider_message_id TEXT,
  p_callback_status TEXT,
  p_event_at TIMESTAMPTZ,
  p_outbox_id UUID DEFAULT NULL,
  p_meta_code INTEGER DEFAULT NULL,
  p_meta_subcode INTEGER DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_callback_json JSONB DEFAULT NULL
)
RETURNS TABLE (
  applied BOOLEAN,
  outbox_id UUID,
  previous_status TEXT,
  status TEXT,
  orphaned BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.outbox_messages%ROWTYPE;
  v_linked_outbox_id UUID;
  v_previous_status TEXT;
  v_new_status TEXT;
  v_effective_at TIMESTAMPTZ := COALESCE(p_event_at, NOW());
BEGIN
  IF p_provider_message_id IS NULL OR BTRIM(p_provider_message_id) = ''
     OR p_callback_status NOT IN ('sent', 'delivered', 'read', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'invalid outbox callback input' USING ERRCODE = '22023';
  END IF;

  -- Serialize callback correlation with attempt-result persistence. Without a
  -- common wamid lock, an orphan inserted just after acceptance scans for
  -- orphans could remain unprojected forever.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'outbox-provider-message:' || p_provider_message_id,
      0
    )
  );

  IF p_outbox_id IS NOT NULL THEN
    SELECT * INTO v_row
    FROM public.outbox_messages AS om
    WHERE om.id = p_outbox_id
    FOR UPDATE;
  END IF;

  IF v_row.id IS NULL THEN
    SELECT * INTO v_row
    FROM public.outbox_messages AS om
    WHERE om.provider_message_id = p_provider_message_id
    ORDER BY om.updated_at DESC, om.id
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF v_row.id IS NULL THEN
    SELECT ose.outbox_id INTO v_linked_outbox_id
    FROM public.outbox_status_events AS ose
    WHERE ose.provider_message_id = p_provider_message_id
      AND ose.outbox_id IS NOT NULL
    ORDER BY ose.created_at DESC, ose.id
    LIMIT 1;

    IF v_linked_outbox_id IS NOT NULL THEN
      SELECT * INTO v_row
      FROM public.outbox_messages AS om
      WHERE om.id = v_linked_outbox_id
      FOR UPDATE;
    END IF;
  END IF;

  IF v_row.id IS NULL THEN
    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, provider_message_id, callback_correlation_id,
      meta_code, meta_subcode, error_code, error_message, event_at, event_payload
    ) VALUES (
      NULL, 'callback', p_provider_message_id, p_outbox_id::TEXT,
      p_meta_code, p_meta_subcode,
      CASE WHEN p_callback_status = 'failed' THEN 'callback_failed' ELSE NULL END,
      LEFT(p_error_message, 500), v_effective_at,
      COALESCE(p_callback_json, '{}'::JSONB)
        || pg_catalog.jsonb_build_object('status', p_callback_status)
    );

    applied := FALSE;
    outbox_id := NULL;
    previous_status := NULL;
    status := NULL;
    orphaned := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  v_previous_status := v_row.status;
  v_new_status := CASE p_callback_status
    WHEN 'read' THEN 'read'
    WHEN 'delivered' THEN
      CASE WHEN v_row.status = 'read' THEN 'read' ELSE 'delivered' END
    WHEN 'sent' THEN
      CASE
        WHEN v_row.status IN (
          'delivered', 'read', 'failed_terminal', 'expired', 'superseded', 'suspended'
        ) THEN v_row.status
        ELSE 'sent'
      END
    WHEN 'failed' THEN
      CASE
        WHEN v_row.status IN ('delivered', 'read', 'expired', 'superseded', 'suspended')
        THEN v_row.status
        ELSE 'failed_terminal'
      END
    ELSE v_row.status
  END;

  UPDATE public.outbox_messages AS om
  SET
    status = v_new_status,
    provider_message_id = COALESCE(om.provider_message_id, p_provider_message_id),
    accepted_at = CASE
      WHEN p_callback_status IN ('sent', 'delivered', 'read')
      THEN LEAST(COALESCE(om.accepted_at, v_effective_at), v_effective_at)
      ELSE om.accepted_at
    END,
    sent_at = CASE
      WHEN p_callback_status IN ('sent', 'delivered', 'read')
      THEN LEAST(COALESCE(om.sent_at, v_effective_at), v_effective_at)
      ELSE om.sent_at
    END,
    delivered_at = CASE
      WHEN p_callback_status IN ('delivered', 'read')
      THEN LEAST(COALESCE(om.delivered_at, v_effective_at), v_effective_at)
      ELSE om.delivered_at
    END,
    read_at = CASE
      WHEN p_callback_status = 'read'
      THEN LEAST(COALESCE(om.read_at, v_effective_at), v_effective_at)
      ELSE om.read_at
    END,
    next_attempt_at = CASE
      WHEN v_new_status = 'failed_terminal' THEN NULL
      ELSE om.next_attempt_at
    END,
    last_error_code = CASE
      WHEN p_callback_status = 'failed'
      THEN COALESCE('meta:' || p_meta_code::TEXT, 'callback_failed')
      ELSE om.last_error_code
    END,
    last_error_message = CASE
      WHEN p_callback_status = 'failed' THEN LEFT(p_error_message, 500)
      ELSE om.last_error_message
    END,
    terminal_at = CASE
      WHEN p_callback_status IN ('sent', 'delivered', 'read')
        OR v_new_status = 'failed_terminal'
      THEN COALESCE(om.terminal_at, v_effective_at)
      ELSE om.terminal_at
    END,
    payload_json = CASE
      WHEN om.message_kind = 'otp'
        AND p_callback_status IN ('sent', 'delivered', 'read')
      THEN NULL
      ELSE om.payload_json
    END,
    payload_redacted_at = CASE
      WHEN om.message_kind = 'otp'
        AND p_callback_status IN ('sent', 'delivered', 'read')
      THEN COALESCE(om.payload_redacted_at, NOW())
      ELSE om.payload_redacted_at
    END,
    updated_at = NOW()
  WHERE om.id = v_row.id
  RETURNING * INTO v_row;

  INSERT INTO public.outbox_status_events (
    outbox_id, event_type, previous_status, new_status, attempt,
    provider_message_id, callback_correlation_id, meta_code, meta_subcode,
    error_code, error_message, event_at, event_payload
  ) VALUES (
    v_row.id, 'callback', v_previous_status, v_row.status, v_row.attempt,
    p_provider_message_id, p_outbox_id::TEXT, p_meta_code, p_meta_subcode,
    CASE WHEN p_callback_status = 'failed' THEN 'callback_failed' ELSE NULL END,
    LEFT(p_error_message, 500), v_effective_at,
    COALESCE(p_callback_json, '{}'::JSONB)
      || pg_catalog.jsonb_build_object('status', p_callback_status)
  );

  IF v_row.id IS NOT NULL
     AND p_provider_message_id IS NOT NULL
     AND BTRIM(p_provider_message_id) <> '' THEN
    PERFORM private.project_outbox_bot_message(
      v_row.id,
      COALESCE(v_row.provider_message_id, p_provider_message_id)
    );
  END IF;

  applied := TRUE;
  outbox_id := v_row.id;
  previous_status := v_previous_status;
  status := v_row.status;
  orphaned := FALSE;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_outbox_callback(
  TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER, INTEGER, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finalize_outbox_scope(
  p_work_id UUID,
  p_last_outbox_id UUID,
  p_message_kind TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS TABLE (
  finalized BOOLEAN,
  response_count INTEGER,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.outbox_messages%ROWTYPE;
  v_generation TEXT;
  v_recipient TEXT;
  v_count INTEGER;
BEGIN
  IF p_work_id IS NULL OR p_last_outbox_id IS NULL
     OR p_message_kind NOT IN ('prompt', 'terminal')
     OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'invalid outbox scope finalization input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
  FROM public.outbox_messages AS om
  WHERE om.id = p_last_outbox_id
    AND om.work_id = p_work_id;

  IF NOT FOUND THEN
    finalized := FALSE;
    response_count := 0;
    status := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  v_generation := v_row.rollout_generation;
  v_recipient := v_row.recipient;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('outbox-generation:' || v_generation, 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('outbox-recipient:' || v_recipient, 0)
  );

  SELECT * INTO v_row
  FROM public.outbox_messages AS om
  WHERE om.id = p_last_outbox_id
    AND om.work_id = p_work_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_row.rollout_generation IS DISTINCT FROM v_generation
     OR v_row.recipient IS DISTINCT FROM v_recipient THEN
    finalized := FALSE;
    response_count := 0;
    status := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.outbox_messages AS om
  SET
    message_kind = p_message_kind,
    expires_at = p_expires_at,
    updated_at = NOW()
  WHERE om.id = v_row.id
  RETURNING * INTO v_row;

  WITH candidates AS (
    SELECT prior.id, prior.status AS previous_status
    FROM public.outbox_messages AS prior
    WHERE prior.work_id = p_work_id
      AND prior.recipient = v_recipient
      AND prior.sequence_no < v_row.sequence_no
      AND prior.status IN ('pending', 'retryable')
    ORDER BY prior.sequence_no, prior.id
    FOR UPDATE
  ), superseded AS (
    UPDATE public.outbox_messages AS prior
    SET
      status = 'superseded',
      terminal_at = COALESCE(prior.terminal_at, NOW()),
      next_attempt_at = NULL,
      updated_at = NOW()
    FROM candidates
    WHERE prior.id = candidates.id
    RETURNING prior.id, prior.attempt, candidates.previous_status
  )
  INSERT INTO public.outbox_status_events (
    outbox_id, event_type, previous_status, new_status, attempt
  )
  SELECT superseded.id, 'superseded_by_scope', superseded.previous_status,
    'superseded', superseded.attempt
  FROM superseded;

  INSERT INTO public.outbox_status_events (
    outbox_id, event_type, previous_status, new_status, attempt, event_payload
  ) VALUES (
    v_row.id, 'scope_finalized', v_row.status, v_row.status, v_row.attempt,
    pg_catalog.jsonb_build_object(
      'message_kind', p_message_kind,
      'expires_at', p_expires_at
    )
  );

  SELECT COUNT(*)::INTEGER INTO v_count
  FROM public.outbox_messages AS om
  WHERE om.work_id = p_work_id
    AND om.recipient = v_recipient
    AND om.message_kind IN ('prompt', 'terminal')
    AND om.status <> 'superseded';

  finalized := TRUE;
  response_count := v_count;
  status := v_row.status;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_outbox_scope(
  UUID, UUID, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_outbox_sweeper_work(
  p_generation TEXT,
  p_limit INTEGER DEFAULT 25
)
RETURNS TABLE (
  outbox_id UUID,
  status TEXT,
  recipient TEXT,
  sequence_no BIGINT,
  attempt INTEGER,
  next_attempt_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_generation IS NULL OR BTRIM(p_generation) = ''
     OR p_limit IS NULL OR p_limit < 0 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid outbox sweeper input' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT om.id, om.status, om.recipient, om.sequence_no, om.attempt,
    om.next_attempt_at, om.expires_at
  FROM public.outbox_messages AS om
  WHERE om.delivery_authority
    AND om.rollout_generation = p_generation
    AND om.status IN ('pending', 'sending', 'retryable', 'unknown')
    AND (om.status <> 'unknown' OR om.terminal_at IS NULL)
    AND (
      om.work_id IS NULL
      OR om.message_kind = 'progress'
      OR EXISTS (
        SELECT 1
        FROM public.outbox_status_events AS finalized_event
        WHERE finalized_event.outbox_id = om.id
          AND finalized_event.event_type = 'scope_finalized'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM private.outbox_suspended_generations AS osg
      WHERE osg.generation = p_generation
    )
  ORDER BY om.sequence_no, om.created_at, om.id
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_outbox_sweeper_work(TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.suspend_outbox_generation(
  p_generation TEXT,
  p_reason TEXT DEFAULT 'rollback'
)
RETURNS TABLE (suspended_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
  v_now TIMESTAMPTZ := NOW();
  v_reason TEXT := LEFT(
    COALESCE(NULLIF(BTRIM(p_reason), ''), 'rollback'),
    200
  );
BEGIN
  IF p_generation IS NULL OR BTRIM(p_generation) = '' THEN
    RAISE EXCEPTION 'generation is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('outbox-generation:' || p_generation, 0)
  );

  INSERT INTO private.outbox_suspended_generations (
    generation, reason
  ) VALUES (
    p_generation, v_reason
  )
  ON CONFLICT (generation) DO UPDATE
  SET reason = EXCLUDED.reason;

  WITH candidates AS (
    SELECT om.id, om.status AS previous_status
    FROM public.outbox_messages AS om
    WHERE om.rollout_generation = p_generation
      AND om.status IN ('pending', 'retryable')
    FOR UPDATE
  ), suspended AS (
    UPDATE public.outbox_messages AS om
    SET
      status = 'suspended',
      suspended_at = COALESCE(om.suspended_at, v_now),
      suspended_reason = v_reason,
      terminal_at = COALESCE(om.terminal_at, v_now),
      next_attempt_at = NULL,
      updated_at = v_now
    FROM candidates
    WHERE om.id = candidates.id
    RETURNING om.id, om.attempt, candidates.previous_status
  ), logged AS (
    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt,
      error_code, event_at
    )
    SELECT suspended.id, 'generation_suspended', suspended.previous_status,
      'suspended', suspended.attempt, 'generation_suspended', v_now
    FROM suspended
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_count FROM logged;

  -- A fallback tombstone that never started already has the suspended status.
  -- Replace its per-message ambiguity reason with the generation rollback
  -- reason without manufacturing an attempt or revoking any in-flight lease.
  UPDATE public.outbox_messages AS om
  SET
    suspended_at = COALESCE(om.suspended_at, v_now),
    suspended_reason = v_reason,
    terminal_at = COALESCE(om.terminal_at, v_now),
    next_attempt_at = NULL,
    updated_at = v_now
  WHERE om.rollout_generation = p_generation
    AND om.status = 'suspended'
    AND om.attempt = 0
    AND om.provider_message_id IS NULL
    AND om.lease_token IS NULL;

  -- Positive/terminal callback evidence must not regress to suspended, but a
  -- callback-before-result crash must not leave its old-generation lease.
  WITH candidates AS (
    SELECT om.id, om.status
    FROM public.outbox_messages AS om
    WHERE om.rollout_generation = p_generation
      AND om.lease_token IS NOT NULL
      AND om.status IN (
        'api_accepted', 'sent', 'delivered', 'read', 'failed_terminal',
        'expired', 'superseded', 'suspended'
      )
    ORDER BY om.id
    FOR UPDATE
  ), released AS (
    UPDATE public.outbox_messages AS om
    SET
      lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
    FROM candidates
    WHERE om.id = candidates.id
    RETURNING om.id, om.attempt, candidates.status
  )
  INSERT INTO public.outbox_status_events (
    outbox_id, event_type, previous_status, new_status, attempt, event_at
  )
  SELECT released.id, 'lease_released_by_suspension', released.status,
    released.status, released.attempt, v_now
  FROM released;

  suspended_count := v_count;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.suspend_outbox_generation(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.redact_outbox_payloads(
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (redacted_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_limit IS NULL OR p_limit < 0 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid outbox redaction limit' USING ERRCODE = '22023';
  END IF;

  WITH eligible AS (
    SELECT om.id
    FROM public.outbox_messages AS om
    WHERE om.payload_json IS NOT NULL
      AND om.payload_redacted_at IS NULL
      AND (
        (om.message_kind = 'otp' AND (
          om.status IN ('api_accepted', 'sent', 'delivered', 'read', 'expired')
          OR om.expires_at <= v_now
        ))
        OR (
          om.message_kind <> 'otp'
          AND om.created_at <= v_now - INTERVAL '7 days'
          AND om.expires_at <= v_now
        )
      )
    ORDER BY om.created_at, om.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), redacted AS (
    UPDATE public.outbox_messages AS om
    SET
      payload_json = NULL,
      payload_redacted_at = v_now,
      updated_at = v_now
    FROM eligible
    WHERE om.id = eligible.id
    RETURNING om.id, om.status, om.attempt
  ), logged AS (
    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt, event_at
    )
    SELECT redacted.id, 'payload_redacted', redacted.status,
      redacted.status, redacted.attempt, v_now
    FROM redacted
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER INTO v_count FROM logged;

  redacted_count := v_count;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.redact_outbox_payloads(INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fence_outbox_fallback(
  p_provider TEXT,
  p_business_account_id TEXT,
  p_recipient TEXT,
  p_idempotency_key TEXT,
  p_payload_hash TEXT,
  p_rollout_generation TEXT,
  p_reason TEXT DEFAULT 'ambiguous_enqueue_result'
)
RETURNS TABLE (
  safe_for_direct BOOLEAN,
  outbox_id UUID,
  status TEXT,
  provider_message_id TEXT,
  idempotency_conflict BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.outbox_messages%ROWTYPE;
  v_fence private.outbox_fallback_fences%ROWTYPE;
  v_generation TEXT;
  v_recipient TEXT;
  v_generation_suspended BOOLEAN;
  v_previous_status TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_reason TEXT := LEFT(
    COALESCE(NULLIF(BTRIM(p_reason), ''), 'ambiguous_enqueue_result'),
    200
  );
BEGIN
  IF p_provider IS NULL OR BTRIM(p_provider) = ''
     OR p_business_account_id IS NULL OR BTRIM(p_business_account_id) = ''
     OR p_recipient IS NULL OR p_recipient !~ '^[0-9]{7,15}$'
     OR p_idempotency_key IS NULL OR BTRIM(p_idempotency_key) = ''
     OR p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$'
     OR p_rollout_generation IS NULL OR BTRIM(p_rollout_generation) = '' THEN
    RAISE EXCEPTION 'invalid outbox fallback fence input'
      USING ERRCODE = '22023';
  END IF;

  SELECT om.rollout_generation, om.recipient
  INTO v_generation, v_recipient
  FROM public.outbox_messages AS om
  WHERE om.idempotency_key = p_idempotency_key;

  v_generation := COALESCE(v_generation, p_rollout_generation);
  v_recipient := COALESCE(v_recipient, p_recipient);

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('outbox-generation:' || v_generation, 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('outbox-key:' || p_idempotency_key, 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('outbox-recipient:' || v_recipient, 0)
  );

  SELECT EXISTS (
    SELECT 1
    FROM private.outbox_suspended_generations AS osg
    WHERE osg.generation = v_generation
  ) INTO v_generation_suspended;

  SELECT * INTO v_fence
  FROM private.outbox_fallback_fences AS off
  WHERE off.idempotency_key = p_idempotency_key
  FOR UPDATE;

  SELECT * INTO v_row
  FROM public.outbox_messages AS om
  WHERE om.idempotency_key = p_idempotency_key
  FOR UPDATE;

  idempotency_conflict :=
    (v_row.id IS NOT NULL AND (
      v_row.provider IS DISTINCT FROM p_provider
      OR v_row.business_account_id IS DISTINCT FROM p_business_account_id
      OR v_row.recipient IS DISTINCT FROM p_recipient
      OR v_row.payload_hash IS DISTINCT FROM p_payload_hash
      OR v_row.rollout_generation IS DISTINCT FROM p_rollout_generation
    ))
    OR (v_fence.idempotency_key IS NOT NULL AND (
      v_fence.provider IS DISTINCT FROM p_provider
      OR v_fence.business_account_id IS DISTINCT FROM p_business_account_id
      OR v_fence.recipient IS DISTINCT FROM p_recipient
      OR v_fence.payload_hash IS DISTINCT FROM p_payload_hash
      OR v_fence.rollout_generation IS DISTINCT FROM p_rollout_generation
    ));

  IF idempotency_conflict THEN
    safe_for_direct := FALSE;
    outbox_id := v_row.id;
    status := v_row.status;
    provider_message_id := v_row.provider_message_id;
    IF v_row.id IS NOT NULL THEN
      INSERT INTO public.outbox_status_events (
        outbox_id, event_type, previous_status, new_status, attempt,
        error_code, error_message, event_payload
      ) VALUES (
        v_row.id, 'idempotency_conflict', v_row.status, v_row.status,
        v_row.attempt, 'fallback_fence_conflict',
        'fallback fence immutable content differs from the durable row',
        pg_catalog.jsonb_build_object(
          'stored_hash', v_row.payload_hash,
          'received_hash', p_payload_hash
        )
      );
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO private.outbox_fallback_fences (
    idempotency_key, provider, business_account_id, recipient,
    payload_hash, rollout_generation, reason
  ) VALUES (
    p_idempotency_key, p_provider, p_business_account_id, p_recipient,
    p_payload_hash, p_rollout_generation, v_reason
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  IF v_generation_suspended THEN
    safe_for_direct := FALSE;
    outbox_id := v_row.id;
    status := v_row.status;
    provider_message_id := v_row.provider_message_id;
    idempotency_conflict := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.id IS NULL THEN
    safe_for_direct := TRUE;
    outbox_id := NULL;
    status := NULL;
    provider_message_id := NULL;
    idempotency_conflict := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.status = 'pending'
     AND v_row.attempt = 0
     AND v_row.lease_token IS NULL THEN
    v_previous_status := v_row.status;
    UPDATE public.outbox_messages AS om
    SET
      status = 'suspended',
      suspended_at = v_now,
      suspended_reason = 'enqueue_fallback:' || v_reason,
      terminal_at = COALESCE(om.terminal_at, v_now),
      next_attempt_at = NULL,
      lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = v_now
    WHERE om.id = v_row.id
    RETURNING * INTO v_row;

    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt,
      error_code, error_message, event_at
    ) VALUES (
      v_row.id, 'fallback_fenced', v_previous_status, 'suspended',
      v_row.attempt, 'ambiguous_enqueue_result', v_reason, v_now
    );
    safe_for_direct := TRUE;
  ELSIF v_row.status = 'suspended'
        AND v_row.suspended_reason LIKE 'enqueue_fallback:%'
        AND v_row.attempt = 0
        AND v_row.provider_message_id IS NULL THEN
    safe_for_direct := TRUE;
  ELSE
    safe_for_direct := FALSE;
  END IF;

  outbox_id := v_row.id;
  status := v_row.status;
  provider_message_id := v_row.provider_message_id;
  idempotency_conflict := FALSE;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.fence_outbox_fallback(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.begin_outbox_fallback_attempt(
  p_outbox_id UUID,
  p_idempotency_key TEXT,
  p_lease_seconds INTEGER DEFAULT 90
)
RETURNS TABLE (
  started BOOLEAN,
  lease_token UUID,
  status TEXT,
  attempt INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.outbox_messages%ROWTYPE;
  v_generation TEXT;
  v_recipient TEXT;
  v_previous_status TEXT;
  v_token UUID;
  v_now TIMESTAMPTZ := NOW();
  v_start_headroom_seconds INTEGER;
BEGIN
  IF p_outbox_id IS NULL
     OR p_idempotency_key IS NULL OR BTRIM(p_idempotency_key) = ''
     OR p_lease_seconds IS NULL
     OR p_lease_seconds < 1 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid outbox fallback attempt input'
      USING ERRCODE = '22023';
  END IF;

  v_start_headroom_seconds :=
    p_lease_seconds + 60 + GREATEST(p_lease_seconds, 60) + 30;

  SELECT om.rollout_generation, om.recipient
  INTO v_generation, v_recipient
  FROM public.outbox_messages AS om
  WHERE om.id = p_outbox_id
    AND om.idempotency_key = p_idempotency_key
    AND om.expires_at > v_now + pg_catalog.make_interval(
      secs => v_start_headroom_seconds
    );

  IF NOT FOUND THEN
    started := FALSE;
    lease_token := NULL;
    status := NULL;
    attempt := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('outbox-generation:' || v_generation, 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('outbox-key:' || p_idempotency_key, 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('outbox-recipient:' || v_recipient, 0)
  );

  SELECT * INTO v_row
  FROM public.outbox_messages AS om
  WHERE om.id = p_outbox_id
    AND om.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF NOT FOUND
     OR v_row.rollout_generation IS DISTINCT FROM v_generation
     OR v_row.recipient IS DISTINCT FROM v_recipient THEN
    started := FALSE;
    lease_token := NULL;
    status := CASE WHEN FOUND THEN v_row.status ELSE NULL END;
    attempt := CASE WHEN FOUND THEN v_row.attempt ELSE NULL END;
    RETURN NEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.outbox_suspended_generations AS osg
    WHERE osg.generation = v_generation
  ) THEN
    started := FALSE;
    lease_token := NULL;
    status := v_row.status;
    attempt := v_row.attempt;
    RETURN NEXT;
    RETURN;
  END IF;

  IF NOT (
       (
         v_row.rollout_mode = 'shadow'
         AND NOT v_row.delivery_authority
         AND v_row.status = 'pending'
         AND v_row.attempt = 0
       )
       OR (
         v_row.rollout_mode = 'active'
         AND v_row.delivery_authority
         AND v_row.status = 'suspended'
         AND v_row.suspended_reason LIKE 'enqueue_fallback:%'
         AND v_row.attempt = 0
       )
     )
     OR v_row.provider_message_id IS NOT NULL
     OR v_row.lease_token IS NOT NULL
     OR v_row.expires_at <= v_now + pg_catalog.make_interval(
       secs => v_start_headroom_seconds
     ) THEN
    started := FALSE;
    lease_token := NULL;
    status := v_row.status;
    attempt := v_row.attempt;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.rollout_mode = 'active'
     AND EXISTS (
       SELECT 1
       FROM public.outbox_messages AS earlier
       WHERE earlier.recipient = v_row.recipient
         AND earlier.sequence_no < v_row.sequence_no
         AND earlier.delivery_authority
         AND (
           earlier.status IN ('pending', 'sending', 'retryable')
           OR (
             earlier.status = 'unknown'
             AND earlier.terminal_at IS NULL
           )
         )
     ) THEN
    UPDATE public.outbox_messages AS om
    SET
      status = 'pending',
      terminal_at = NULL,
      suspended_at = NULL,
      suspended_reason = NULL,
      updated_at = v_now
    WHERE om.id = v_row.id
    RETURNING * INTO v_row;

    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt, event_at
    ) VALUES (
      v_row.id, 'fallback_queued', 'suspended', 'pending', v_row.attempt, v_now
    );

    started := FALSE;
    lease_token := NULL;
    status := v_row.status;
    attempt := v_row.attempt;
    RETURN NEXT;
    RETURN;
  END IF;

  v_previous_status := v_row.status;
  v_token := gen_random_uuid();
  UPDATE public.outbox_messages AS om
  SET
    status = 'sending',
    terminal_at = NULL,
    suspended_at = NULL,
    suspended_reason = NULL,
    attempt = om.attempt + 1,
    lease_owner = CASE
      WHEN om.rollout_mode = 'shadow' THEN 'shadow-direct'
      ELSE 'fallback-direct'
    END,
    lease_token = v_token,
    last_lease_token = v_token,
    lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
    next_attempt_at = NULL,
    updated_at = v_now
  WHERE om.id = v_row.id
  RETURNING * INTO v_row;

  INSERT INTO public.outbox_status_events (
    outbox_id, event_type, previous_status, new_status, attempt, event_at
  ) VALUES (
    v_row.id, 'fallback_started', v_previous_status, 'sending',
    v_row.attempt, v_now
  );

  started := TRUE;
  lease_token := v_token;
  status := v_row.status;
  attempt := v_row.attempt;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_outbox_fallback_attempt(
  UUID, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enqueue_outbox_message(
  p_provider TEXT,
  p_business_account_id TEXT,
  p_recipient TEXT,
  p_idempotency_key TEXT,
  p_message_kind TEXT,
  p_payload_json JSONB,
  p_payload_hash TEXT,
  p_rollout_mode TEXT,
  p_rollout_generation TEXT,
  p_max_attempts INTEGER,
  p_expires_at TIMESTAMPTZ,
  p_user_id UUID DEFAULT NULL,
  p_work_id UUID DEFAULT NULL,
  p_emission_index INTEGER DEFAULT NULL,
  p_reply_to_message_id TEXT DEFAULT NULL,
  p_resource_type TEXT DEFAULT NULL,
  p_resource_id UUID DEFAULT NULL,
  p_resource_metadata JSONB DEFAULT NULL
)
RETURNS TABLE (
  outbox_id UUID,
  status TEXT,
  sequence_no BIGINT,
  was_inserted BOOLEAN,
  idempotency_conflict BOOLEAN,
  provider_message_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.outbox_messages%ROWTYPE;
  v_fallback_fence private.outbox_fallback_fences%ROWTYPE;
  v_sequence BIGINT;
  v_delivery_authority BOOLEAN;
  v_generation_suspended BOOLEAN;
  v_fallback_fenced BOOLEAN := FALSE;
  v_suspended_reason TEXT;
BEGIN
  IF p_provider IS NULL OR BTRIM(p_provider) = ''
     OR p_business_account_id IS NULL OR BTRIM(p_business_account_id) = ''
     OR p_recipient IS NULL OR p_recipient !~ '^[0-9]{7,15}$'
     OR p_idempotency_key IS NULL OR BTRIM(p_idempotency_key) = ''
     OR p_message_kind NOT IN ('progress', 'prompt', 'terminal', 'otp', 'reminder')
     OR p_payload_json IS NULL
     OR p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$'
     OR p_rollout_mode NOT IN ('shadow', 'active')
     OR p_rollout_generation IS NULL OR BTRIM(p_rollout_generation) = ''
     OR p_max_attempts NOT BETWEEN 1 AND 5
     OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'invalid outbox enqueue input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'outbox-generation:' || p_rollout_generation,
      0
    )
  );

  SELECT osg.reason INTO v_suspended_reason
  FROM private.outbox_suspended_generations AS osg
  WHERE osg.generation = p_rollout_generation;
  v_generation_suspended := v_suspended_reason IS NOT NULL;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('outbox-key:' || p_idempotency_key, 0)
  );

  SELECT * INTO v_fallback_fence
  FROM private.outbox_fallback_fences AS off
  WHERE off.idempotency_key = p_idempotency_key;

  IF v_fallback_fence.idempotency_key IS NOT NULL THEN
    IF v_fallback_fence.provider IS DISTINCT FROM p_provider
       OR v_fallback_fence.business_account_id IS DISTINCT FROM p_business_account_id
       OR v_fallback_fence.recipient IS DISTINCT FROM p_recipient
       OR v_fallback_fence.payload_hash IS DISTINCT FROM p_payload_hash
       OR v_fallback_fence.rollout_generation IS DISTINCT FROM p_rollout_generation THEN
      RAISE EXCEPTION 'outbox fallback fence conflicts with immutable content'
        USING ERRCODE = '23505';
    END IF;
    v_fallback_fenced := TRUE;
    IF NOT v_generation_suspended THEN
      v_suspended_reason := 'enqueue_fallback:' || v_fallback_fence.reason;
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('outbox-recipient:' || p_recipient, 0)
  );

  SELECT * INTO v_row
  FROM public.outbox_messages AS om
  WHERE om.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    outbox_id := v_row.id;
    status := v_row.status;
    sequence_no := v_row.sequence_no;
    was_inserted := FALSE;
    idempotency_conflict :=
      v_row.payload_hash IS DISTINCT FROM p_payload_hash
      OR v_row.recipient IS DISTINCT FROM p_recipient
      OR v_row.provider IS DISTINCT FROM p_provider
      OR v_row.business_account_id IS DISTINCT FROM p_business_account_id;
    provider_message_id := v_row.provider_message_id;

    IF idempotency_conflict THEN
      INSERT INTO public.outbox_status_events (
        outbox_id, event_type, previous_status, new_status, attempt,
        error_code, error_message, event_payload
      ) VALUES (
        v_row.id, 'idempotency_conflict', v_row.status, v_row.status,
        v_row.attempt, 'idempotency_conflict',
        'logical key was reused with different immutable content',
        pg_catalog.jsonb_build_object(
          'stored_hash', v_row.payload_hash,
          'received_hash', p_payload_hash
        )
      );
    END IF;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(om.sequence_no), 0) + 1 INTO v_sequence
  FROM public.outbox_messages AS om
  WHERE om.recipient = p_recipient;

  v_delivery_authority := p_rollout_mode = 'active';

  INSERT INTO public.outbox_messages (
    provider, business_account_id, recipient, user_id, work_id,
    emission_index, idempotency_key, message_kind, payload_json,
    payload_hash, reply_to_message_id, resource_type, resource_id,
    resource_metadata, sequence_no, rollout_mode, rollout_generation,
    delivery_authority, status, max_attempts, next_attempt_at, expires_at,
    terminal_at, suspended_at, suspended_reason
  ) VALUES (
    p_provider, p_business_account_id, p_recipient, p_user_id, p_work_id,
    p_emission_index, p_idempotency_key, p_message_kind, p_payload_json,
    p_payload_hash, p_reply_to_message_id, p_resource_type, p_resource_id,
    p_resource_metadata, v_sequence, p_rollout_mode, p_rollout_generation,
    v_delivery_authority,
    CASE
      WHEN v_generation_suspended OR v_fallback_fenced THEN 'suspended'
      ELSE 'pending'
    END,
    p_max_attempts,
    CASE
      WHEN v_generation_suspended OR v_fallback_fenced THEN NULL
      ELSE NOW()
    END,
    p_expires_at,
    CASE
      WHEN v_generation_suspended OR v_fallback_fenced THEN NOW()
      ELSE NULL
    END,
    CASE
      WHEN v_generation_suspended OR v_fallback_fenced THEN NOW()
      ELSE NULL
    END,
    CASE
      WHEN v_generation_suspended OR v_fallback_fenced
      THEN v_suspended_reason
      ELSE NULL
    END
  )
  RETURNING * INTO v_row;

  INSERT INTO public.outbox_status_events (
    outbox_id, event_type, new_status, attempt, event_payload
  ) VALUES (
    v_row.id,
    CASE
      WHEN v_generation_suspended THEN 'enqueue_suspended_generation'
      WHEN v_fallback_fenced THEN 'enqueue_suspended_fallback_fence'
      ELSE 'enqueued'
    END,
    v_row.status,
    0,
    pg_catalog.jsonb_build_object(
      'message_kind', v_row.message_kind,
      'rollout_mode', v_row.rollout_mode,
      'generation', v_row.rollout_generation,
      'payload_hash', v_row.payload_hash
    )
  );

  IF v_row.rollout_mode = 'active'
     AND v_row.message_kind IN ('prompt', 'terminal')
     AND v_row.work_id IS NOT NULL THEN
    WITH candidates AS (
      SELECT older.id, older.status AS previous_status
      FROM public.outbox_messages AS older
      WHERE older.work_id = v_row.work_id
        AND older.id <> v_row.id
        AND older.recipient = v_row.recipient
        AND older.sequence_no < v_row.sequence_no
        AND older.message_kind = 'progress'
        AND older.status IN ('pending', 'retryable')
        AND older.rollout_mode = v_row.rollout_mode
        AND older.rollout_generation = v_row.rollout_generation
      FOR UPDATE
    ), superseded AS (
      UPDATE public.outbox_messages AS older
      SET
        status = 'superseded',
        terminal_at = COALESCE(older.terminal_at, NOW()),
        next_attempt_at = NULL,
        updated_at = NOW()
      FROM candidates
      WHERE older.id = candidates.id
      RETURNING older.id, older.attempt, candidates.previous_status
    )
    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt
    )
    SELECT superseded.id, 'superseded_by_response',
      superseded.previous_status, 'superseded', superseded.attempt
    FROM superseded;
  END IF;

  IF NOT v_generation_suspended
     AND NOT v_fallback_fenced
     AND p_message_kind IN ('prompt', 'terminal') THEN
    WITH candidates AS (
      SELECT progress.id, progress.status AS previous_status
      FROM public.outbox_messages AS progress
      WHERE progress.recipient = p_recipient
        AND progress.message_kind = 'progress'
        AND progress.sequence_no < v_sequence
        AND progress.status IN ('pending', 'retryable')
        AND progress.rollout_mode = p_rollout_mode
        AND progress.rollout_generation = p_rollout_generation
      FOR UPDATE
    ), superseded AS (
      UPDATE public.outbox_messages AS progress
      SET
        status = 'superseded',
        terminal_at = NOW(),
        next_attempt_at = NULL,
        updated_at = NOW()
      FROM candidates
      WHERE progress.id = candidates.id
      RETURNING progress.id, progress.attempt, candidates.previous_status
    )
    INSERT INTO public.outbox_status_events (
      outbox_id, event_type, previous_status, new_status, attempt
    )
    SELECT superseded.id, 'superseded_by_response', superseded.previous_status,
      'superseded', superseded.attempt
    FROM superseded;
  END IF;

  outbox_id := v_row.id;
  status := v_row.status;
  sequence_no := v_row.sequence_no;
  was_inserted := TRUE;
  idempotency_conflict := FALSE;
  provider_message_id := v_row.provider_message_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_outbox_message(
  TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, INTEGER,
  TIMESTAMPTZ, UUID, UUID, INTEGER, TEXT, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

-- Tables are never accessed directly by API roles, including service_role.
REVOKE SELECT, INSERT, UPDATE, DELETE
ON TABLE public.outbox_messages, public.outbox_status_events
FROM PUBLIC, anon, authenticated, service_role;

-- Privileged API surface: grants stay together after every revoke is applied.
GRANT EXECUTE ON FUNCTION public.enqueue_outbox_message(
  TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, INTEGER,
  TIMESTAMPTZ, UUID, UUID, INTEGER, TEXT, TEXT, UUID, JSONB
) TO service_role;

GRANT EXECUTE ON FUNCTION public.fence_outbox_fallback(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION public.begin_outbox_fallback_attempt(UUID, TEXT, INTEGER)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.claim_outbox_messages(TEXT, TEXT, INTEGER, INTEGER, UUID, BOOLEAN)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.record_outbox_attempt_result(
  UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER,
  TEXT, TEXT, JSONB
) TO service_role;

GRANT EXECUTE ON FUNCTION public.apply_outbox_callback(
  TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER, INTEGER, TEXT, JSONB
) TO service_role;

GRANT EXECUTE ON FUNCTION public.finalize_outbox_scope(UUID, UUID, TEXT, TIMESTAMPTZ)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.list_outbox_sweeper_work(TEXT, INTEGER)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.suspend_outbox_generation(TEXT, TEXT)
  TO service_role;

GRANT EXECUTE ON FUNCTION public.redact_outbox_payloads(INTEGER)
  TO service_role;

NOTIFY pgrst, 'reload schema';
