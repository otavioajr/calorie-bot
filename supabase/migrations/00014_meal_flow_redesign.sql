-- food_cache: add portion classification columns
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS portion_type TEXT;
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS default_grams NUMERIC;
ALTER TABLE food_cache ADD COLUMN IF NOT EXISTS default_display TEXT;

-- meal_items: add confidence and display columns
ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS confidence TEXT DEFAULT 'high';
ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS quantity_display TEXT;
