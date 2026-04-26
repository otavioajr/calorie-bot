UPDATE taco_foods
SET is_default = FALSE
WHERE lower(food_base) = lower('Macarrão');

UPDATE taco_foods
SET is_default = TRUE
WHERE lower(food_base) = lower('Macarrão')
  AND lower(food_variant) = lower('trigo, cru, com ovos');
