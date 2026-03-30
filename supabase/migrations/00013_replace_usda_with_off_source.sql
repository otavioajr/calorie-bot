-- Replace 'usda' with 'off' (Open Food Facts) in meal_items source constraint
ALTER TABLE meal_items DROP CONSTRAINT IF EXISTS meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
  CHECK (source IN ('approximate', 'taco', 'taco_decomposed', 'manual', 'user_provided', 'user_history', 'off'));
