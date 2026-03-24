-- Enable pg_trgm for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create GIN index on taco_foods.food_name for trigram similarity
CREATE INDEX idx_taco_foods_food_name_trgm ON taco_foods USING GIN (food_name gin_trgm_ops);

-- Expand meal_items source CHECK constraint
ALTER TABLE meal_items DROP CONSTRAINT IF EXISTS meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
  CHECK (source IN ('approximate','taco','taco_decomposed','manual','user_provided','user_history'));

-- Migrate calorie_mode: approximate -> taco
UPDATE users SET calorie_mode = 'taco' WHERE calorie_mode = 'approximate';

-- Update calorie_mode CHECK constraint
DO $$
BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_calorie_mode_check;
  ALTER TABLE users ADD CONSTRAINT users_calorie_mode_check
    CHECK (calorie_mode IN ('taco', 'manual'));
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

-- RPC function: match single food name
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
  similarity REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id, t.food_name, t.category,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g,
    similarity(lower(t.food_name), query_name) AS similarity
  FROM taco_foods t
  WHERE similarity(lower(t.food_name), query_name) >= threshold
  ORDER BY similarity(lower(t.food_name), query_name) DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- RPC function: batch match multiple food names
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
  similarity REAL,
  query_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (q.name)
    t.id, t.food_name, t.category,
    t.calories_per_100g, t.protein_per_100g, t.carbs_per_100g,
    t.fat_per_100g, t.fiber_per_100g,
    similarity(lower(t.food_name), q.name) AS similarity,
    q.name AS query_name
  FROM unnest(query_names) AS q(name)
  JOIN taco_foods t ON similarity(lower(t.food_name), q.name) >= threshold
  ORDER BY q.name, similarity(lower(t.food_name), q.name) DESC;
END;
$$ LANGUAGE plpgsql;
