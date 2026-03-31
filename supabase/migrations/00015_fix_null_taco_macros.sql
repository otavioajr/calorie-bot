-- Fix TACO entries with NULL nutritional data
-- Values sourced from TACO 4th edition, IBGE, and USDA FoodData Central

-- =================================================================
-- 1. DAIRY with NULL energy/macros
-- =================================================================

-- Leite, de vaca, desnatado, UHT (ID 457)
-- Source: TACO 4th ed. / USDA FDC #746776
UPDATE taco_foods SET
  calories_per_100g = 35,
  protein_per_100g = 3.4,
  carbs_per_100g = 5.0,
  fat_per_100g = 0.1
WHERE food_name = 'Leite, de vaca, desnatado, UHT'
  AND (calories_per_100g IS NULL OR calories_per_100g = 0);

-- Leite, de vaca, integral (ID 458)
-- Source: TACO 4th ed. / USDA FDC #746782
UPDATE taco_foods SET
  calories_per_100g = 61,
  protein_per_100g = 3.2,
  carbs_per_100g = 4.7,
  fat_per_100g = 3.3
WHERE food_name = 'Leite, de vaca, integral'
  AND (calories_per_100g IS NULL OR calories_per_100g = 0);

-- Iogurte, sabor abacaxi (ID 450)
-- Source: IBGE / USDA FDC (fruit yogurt average)
UPDATE taco_foods SET
  calories_per_100g = 90,
  protein_per_100g = 2.5,
  carbs_per_100g = 17.0,
  fat_per_100g = 1.2
WHERE food_name = 'Iogurte, sabor abacaxi'
  AND (calories_per_100g IS NULL OR calories_per_100g = 0);

-- =================================================================
-- 2. ADD missing "Leite, de vaca, semidesnatado"
-- =================================================================

-- Source: USDA FDC #746778 (reduced fat milk 2%)
INSERT INTO taco_foods (food_name, food_base, food_variant, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, is_default)
SELECT 'Leite, de vaca, semidesnatado', 'Leite', 'de vaca, semidesnatado', 46, 3.3, 4.8, 1.5, 0, false
WHERE NOT EXISTS (
  SELECT 1 FROM taco_foods WHERE food_name = 'Leite, de vaca, semidesnatado'
);

-- =================================================================
-- 3. OILS — have energy=884 but NULL protein/carbs (pure fat)
-- =================================================================

UPDATE taco_foods SET
  protein_per_100g = 0,
  carbs_per_100g = 0,
  fat_per_100g = 100
WHERE food_name IN (
  'Azeite, de dendê',
  'Azeite, de oliva, extra virgem',
  'Óleo, de babaçu',
  'Óleo, de canola',
  'Óleo, de girassol',
  'Óleo, de milho',
  'Óleo, de pequi',
  'Óleo, de soja'
)
AND protein_per_100g IS NULL;

-- =================================================================
-- 4. OTHER entries with NULL
-- =================================================================

-- Cana, aguardente (ID 472) — alcohol, no macros
UPDATE taco_foods SET
  protein_per_100g = 0,
  carbs_per_100g = 0,
  fat_per_100g = 0
WHERE food_name = 'Cana, aguardente 1'
  AND protein_per_100g IS NULL;

-- Sal dietético / grosso — 0 calories
UPDATE taco_foods SET
  calories_per_100g = 0,
  protein_per_100g = 0,
  carbs_per_100g = 0,
  fat_per_100g = 0
WHERE food_name IN ('Sal, dietético', 'Sal, grosso')
  AND calories_per_100g IS NULL;

-- Coco, verde, cru (ID 591)
-- Source: TACO 4th ed. / USDA FDC #170172
UPDATE taco_foods SET
  calories_per_100g = 174,
  protein_per_100g = 1.6,
  carbs_per_100g = 3.3,
  fat_per_100g = 16.1
WHERE food_name LIKE 'Coco,%verde,%cru%'
  AND calories_per_100g IS NULL;

-- =================================================================
-- 5. SAFETY NET: Set any remaining NULL macros to 0
--    (prevents the enrichment pipeline from crashing)
-- =================================================================

UPDATE taco_foods SET protein_per_100g = 0 WHERE protein_per_100g IS NULL;
UPDATE taco_foods SET carbs_per_100g = 0 WHERE carbs_per_100g IS NULL;
UPDATE taco_foods SET fat_per_100g = 0 WHERE fat_per_100g IS NULL;
