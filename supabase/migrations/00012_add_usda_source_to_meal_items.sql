-- Add 'usda' to the allowed source values in meal_items
-- The USDA enrichment pipeline was added but the CHECK constraint was not updated
ALTER TABLE meal_items DROP CONSTRAINT IF EXISTS meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
  CHECK (source IN ('approximate', 'taco', 'taco_decomposed', 'manual', 'user_provided', 'user_history', 'usda'));
