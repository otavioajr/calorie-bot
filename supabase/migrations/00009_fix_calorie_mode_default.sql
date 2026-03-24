-- Fix calorie_mode DEFAULT: was still 'approximate' after migration 00008
-- changed the CHECK constraint to only allow ('taco', 'manual').
-- New users could not be created because the default violated the constraint.
ALTER TABLE users ALTER COLUMN calorie_mode SET DEFAULT 'taco';
