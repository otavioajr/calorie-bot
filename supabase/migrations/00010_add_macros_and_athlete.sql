-- Add macro target columns to users
ALTER TABLE users ADD COLUMN max_weight_kg DECIMAL(5,2);
ALTER TABLE users ADD COLUMN daily_protein_g INTEGER;
ALTER TABLE users ADD COLUMN daily_fat_g INTEGER;
ALTER TABLE users ADD COLUMN daily_carbs_g INTEGER;

-- Update activity_level constraint to include 'athlete'
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_activity_level_check;
ALTER TABLE users ADD CONSTRAINT users_activity_level_check
  CHECK (activity_level IN ('sedentary','light','moderate','intense','athlete'));
