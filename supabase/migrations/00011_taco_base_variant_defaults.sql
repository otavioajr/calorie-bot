-- =============================================
-- TACO Matching Redesign: base/variant split,
-- defaults, usage tracking
-- =============================================

-- 1. Add food_base, food_variant, is_default to taco_foods
ALTER TABLE taco_foods ADD COLUMN IF NOT EXISTS food_base VARCHAR(200);
ALTER TABLE taco_foods ADD COLUMN IF NOT EXISTS food_variant VARCHAR(200) DEFAULT '';
ALTER TABLE taco_foods ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE;

-- 2. Index for base-name lookups
CREATE INDEX IF NOT EXISTS idx_taco_foods_food_base
  ON taco_foods (lower(food_base));

-- 3. Unique partial index: max 1 default per food_base
CREATE UNIQUE INDEX IF NOT EXISTS idx_taco_foods_default_per_base
  ON taco_foods (lower(food_base)) WHERE is_default = TRUE;

-- 4. Usage tracking table
CREATE TABLE IF NOT EXISTS taco_food_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    food_base VARCHAR(200) NOT NULL,
    taco_id INTEGER REFERENCES taco_foods(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    confirmed_count INTEGER DEFAULT 1,
    last_confirmed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(food_base, taco_id, user_id)
);

-- 5. RLS for taco_food_usage (service role writes, public reads for aggregation)
ALTER TABLE taco_food_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on taco_food_usage"
  ON taco_food_usage FOR ALL
  USING (true) WITH CHECK (true);

-- 6. RPC: match by food_base (returns all variants for a base)
CREATE OR REPLACE FUNCTION match_taco_by_base(query_base TEXT)
RETURNS TABLE (
  id INT,
  food_name VARCHAR,
  food_base VARCHAR,
  food_variant VARCHAR,
  is_default BOOLEAN,
  calories_per_100g DECIMAL,
  protein_per_100g DECIMAL,
  carbs_per_100g DECIMAL,
  fat_per_100g DECIMAL,
  fiber_per_100g DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id, t.food_name, t.food_base, t.food_variant, t.is_default,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g
  FROM taco_foods t
  WHERE lower(t.food_base) = lower(query_base)
  ORDER BY t.is_default DESC, t.food_name ASC;
END;
$$ LANGUAGE plpgsql;

-- 7. RPC: get learned default (most confirmed by distinct users)
CREATE OR REPLACE FUNCTION get_learned_default(query_base TEXT)
RETURNS TABLE (
  taco_id INT,
  user_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT u.taco_id, COUNT(DISTINCT u.user_id) AS user_count
  FROM taco_food_usage u
  WHERE lower(u.food_base) = lower(query_base)
  GROUP BY u.taco_id
  ORDER BY user_count DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- 8. RPC: record usage (upsert — increment if exists)
CREATE OR REPLACE FUNCTION record_taco_usage(
  p_food_base TEXT,
  p_taco_id INT,
  p_user_id UUID
) RETURNS VOID AS $$
BEGIN
  INSERT INTO taco_food_usage (food_base, taco_id, user_id, confirmed_count, last_confirmed_at)
  VALUES (lower(p_food_base), p_taco_id, p_user_id, 1, NOW())
  ON CONFLICT (food_base, taco_id, user_id)
  DO UPDATE SET
    confirmed_count = taco_food_usage.confirmed_count + 1,
    last_confirmed_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- 9. Update existing match functions to also return new columns
CREATE OR REPLACE FUNCTION match_taco_food(query_name TEXT, threshold FLOAT DEFAULT 0.4)
RETURNS TABLE (
  id INT,
  food_name VARCHAR,
  category VARCHAR,
  calories_per_100g DECIMAL,
  protein_per_100g DECIMAL,
  carbs_per_100g DECIMAL,
  fat_per_100g DECIMAL,
  fiber_per_100g DECIMAL,
  food_base VARCHAR,
  food_variant VARCHAR,
  is_default BOOLEAN,
  similarity REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id, t.food_name, t.category,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g,
    t.food_base, t.food_variant, t.is_default,
    similarity(lower(t.food_name), query_name) AS similarity
  FROM taco_foods t
  WHERE similarity(lower(t.food_name), query_name) >= threshold
  ORDER BY similarity(lower(t.food_name), query_name) DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION match_taco_foods_batch(query_names TEXT[], threshold FLOAT DEFAULT 0.4)
RETURNS TABLE (
  id INT,
  food_name VARCHAR,
  category VARCHAR,
  calories_per_100g DECIMAL,
  protein_per_100g DECIMAL,
  carbs_per_100g DECIMAL,
  fat_per_100g DECIMAL,
  fiber_per_100g DECIMAL,
  food_base VARCHAR,
  food_variant VARCHAR,
  is_default BOOLEAN,
  similarity REAL,
  query_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (q.name)
    t.id, t.food_name, t.category,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g,
    t.food_base, t.food_variant, t.is_default,
    similarity(lower(t.food_name), q.name) AS similarity,
    q.name AS query_name
  FROM unnest(query_names) AS q(name)
  JOIN taco_foods t ON similarity(lower(t.food_name), q.name) >= threshold
  ORDER BY q.name, similarity(lower(t.food_name), q.name) DESC;
END;
$$ LANGUAGE plpgsql;
