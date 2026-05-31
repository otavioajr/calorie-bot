-- Atomic find-or-create of a meal for (user, local day, meal_type) to prevent
-- duplicate meal rows under concurrent logs. Uses a transaction-scoped advisory
-- lock; no schema change to existing rows. The caller passes the day bounds
-- (already computed in the user's timezone) and meal metadata.
--
-- We deliberately do NOT add a unique index on (user_id, meal_type, local-day):
-- existing prod data may already contain duplicates from the original bug, so a
-- unique constraint would fail to create. The advisory lock serializes concurrent
-- same-key logs so no NEW duplicates are produced.
--
-- SECURITY DEFINER with a pinned search_path (mirrors reset_user_data hardening).
-- Invoked from the server via the service-role client only.

CREATE OR REPLACE FUNCTION find_or_create_meal(
  p_user_id        UUID,
  p_meal_type      TEXT,
  p_day_start      TIMESTAMPTZ,
  p_day_end        TIMESTAMPTZ,
  p_total_calories INTEGER,
  p_original_message TEXT,
  p_llm_response   JSONB,
  p_registered_at  TIMESTAMPTZ
)
RETURNS TABLE (meal_id UUID, was_append BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing UUID;
BEGIN
  -- Serialize concurrent logs for the same (user, day, meal_type).
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_meal_type || ':' || (p_day_start::date)::text, 0)
  );

  SELECT m.id INTO v_existing
  FROM meals m
  WHERE m.user_id = p_user_id
    AND m.meal_type = p_meal_type
    AND m.registered_at >= p_day_start
    AND m.registered_at <= p_day_end
  ORDER BY m.registered_at ASC
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    meal_id := v_existing;
    was_append := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO meals (user_id, meal_type, total_calories, original_message, llm_response, registered_at)
  VALUES (
    p_user_id,
    p_meal_type,
    p_total_calories,
    p_original_message,
    COALESCE(p_llm_response, '{}'::jsonb),
    COALESCE(p_registered_at, NOW())
  )
  RETURNING id INTO v_existing;

  meal_id := v_existing;
  was_append := FALSE;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION find_or_create_meal(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION find_or_create_meal(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, JSONB, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION find_or_create_meal(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, JSONB, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION find_or_create_meal(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT, JSONB, TIMESTAMPTZ) TO service_role;
