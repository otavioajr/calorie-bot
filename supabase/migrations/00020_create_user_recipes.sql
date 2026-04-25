-- 00020_create_user_recipes.sql
-- Adds user_recipes + recipe_ingredients (private per-user recipes)
-- and registers 'recipe' as a valid meal_items source.

-- 1. Enable pg_trgm for fuzzy matching (used by bot in PR2; harmless if already on).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Parent table.
CREATE TABLE user_recipes (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                        TEXT NOT NULL,
    total_weight_grams          NUMERIC(8,2) NOT NULL CHECK (total_weight_grams > 0),
    servings                    NUMERIC(5,2) NOT NULL CHECK (servings > 0),
    weight_per_serving_grams    NUMERIC(8,2) NOT NULL CHECK (weight_per_serving_grams > 0),
    total_calories              NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (total_calories >= 0),
    total_protein_g             NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (total_protein_g >= 0),
    total_carbs_g               NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (total_carbs_g >= 0),
    total_fat_g                 NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (total_fat_g >= 0),
    per_serving_calories        NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (per_serving_calories >= 0),
    per_serving_protein_g       NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (per_serving_protein_g >= 0),
    per_serving_carbs_g         NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (per_serving_carbs_g >= 0),
    per_serving_fat_g           NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (per_serving_fat_g >= 0),
    notes                       TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX user_recipes_user_name_unique
    ON user_recipes (user_id, regexp_replace(lower(btrim(name)), '\s+', ' ', 'g'));

CREATE INDEX user_recipes_user_id_idx ON user_recipes (user_id);
CREATE INDEX user_recipes_name_trgm_idx ON user_recipes USING gin (name gin_trgm_ops);

-- 3. Child table.
CREATE TABLE recipe_ingredients (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id           UUID NOT NULL REFERENCES user_recipes(id) ON DELETE CASCADE,
    food_name           TEXT NOT NULL,
    quantity_grams      NUMERIC(8,2) NOT NULL CHECK (quantity_grams > 0),
    calories            NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (calories >= 0),
    protein_g           NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (protein_g >= 0),
    carbs_g             NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (carbs_g >= 0),
    fat_g               NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (fat_g >= 0),
    source              TEXT NOT NULL CHECK (source IN ('taco', 'user_label')),
    taco_id             INTEGER REFERENCES taco_foods(id),
    taco_food_base      TEXT,
    taco_food_variant   TEXT,
    label_override      JSONB,
    display_order       SMALLINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (source = 'taco' AND taco_id IS NOT NULL AND label_override IS NULL)
        OR (source = 'user_label' AND label_override IS NOT NULL AND taco_id IS NULL)
    )
);

CREATE INDEX recipe_ingredients_recipe_id_idx ON recipe_ingredients (recipe_id);

-- 4. updated_at trigger on user_recipes.
CREATE TRIGGER user_recipes_set_updated_at
    BEFORE UPDATE ON user_recipes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 5. RLS.
ALTER TABLE user_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_recipes_owner_select" ON user_recipes
    FOR SELECT USING (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );
CREATE POLICY "user_recipes_owner_insert" ON user_recipes
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );
CREATE POLICY "user_recipes_owner_update" ON user_recipes
    FOR UPDATE USING (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );
CREATE POLICY "user_recipes_owner_delete" ON user_recipes
    FOR DELETE USING (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );

CREATE POLICY "recipe_ingredients_owner_select" ON recipe_ingredients
    FOR SELECT USING (
        recipe_id IN (
            SELECT id FROM user_recipes
            WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
        )
    );
CREATE POLICY "recipe_ingredients_owner_insert" ON recipe_ingredients
    FOR INSERT WITH CHECK (
        recipe_id IN (
            SELECT id FROM user_recipes
            WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
        )
    );
CREATE POLICY "recipe_ingredients_owner_update" ON recipe_ingredients
    FOR UPDATE USING (
        recipe_id IN (
            SELECT id FROM user_recipes
            WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
        )
    );
CREATE POLICY "recipe_ingredients_owner_delete" ON recipe_ingredients
    FOR DELETE USING (
        recipe_id IN (
            SELECT id FROM user_recipes
            WHERE user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
        )
    );

-- 6. Transactional recipe writes.
CREATE OR REPLACE FUNCTION create_user_recipe_with_ingredients(
    p_user_id UUID,
    p_recipe JSONB,
    p_ingredients JSONB
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_recipe_id UUID;
    v_ingredient JSONB;
    v_ingredients JSONB := COALESCE(p_ingredients, '[]'::JSONB);
BEGIN
    INSERT INTO user_recipes (
        user_id,
        name,
        total_weight_grams,
        servings,
        weight_per_serving_grams,
        total_calories,
        total_protein_g,
        total_carbs_g,
        total_fat_g,
        per_serving_calories,
        per_serving_protein_g,
        per_serving_carbs_g,
        per_serving_fat_g,
        notes
    )
    VALUES (
        p_user_id,
        p_recipe->>'name',
        (p_recipe->>'total_weight_grams')::NUMERIC,
        (p_recipe->>'servings')::NUMERIC,
        (p_recipe->>'weight_per_serving_grams')::NUMERIC,
        (p_recipe->>'total_calories')::NUMERIC,
        (p_recipe->>'total_protein_g')::NUMERIC,
        (p_recipe->>'total_carbs_g')::NUMERIC,
        (p_recipe->>'total_fat_g')::NUMERIC,
        (p_recipe->>'per_serving_calories')::NUMERIC,
        (p_recipe->>'per_serving_protein_g')::NUMERIC,
        (p_recipe->>'per_serving_carbs_g')::NUMERIC,
        (p_recipe->>'per_serving_fat_g')::NUMERIC,
        p_recipe->>'notes'
    )
    RETURNING id INTO v_recipe_id;

    IF jsonb_typeof(v_ingredients) = 'array' AND jsonb_array_length(v_ingredients) > 0 THEN
        FOR v_ingredient IN SELECT value FROM jsonb_array_elements(v_ingredients)
        LOOP
            INSERT INTO recipe_ingredients (
                recipe_id,
                food_name,
                quantity_grams,
                calories,
                protein_g,
                carbs_g,
                fat_g,
                source,
                taco_id,
                taco_food_base,
                taco_food_variant,
                label_override,
                display_order
            )
            VALUES (
                v_recipe_id,
                v_ingredient->>'food_name',
                (v_ingredient->>'quantity_grams')::NUMERIC,
                (v_ingredient->>'calories')::NUMERIC,
                (v_ingredient->>'protein_g')::NUMERIC,
                (v_ingredient->>'carbs_g')::NUMERIC,
                (v_ingredient->>'fat_g')::NUMERIC,
                v_ingredient->>'source',
                (v_ingredient->>'taco_id')::INTEGER,
                v_ingredient->>'taco_food_base',
                v_ingredient->>'taco_food_variant',
                CASE
                    WHEN v_ingredient->'label_override' = 'null'::JSONB THEN NULL
                    ELSE v_ingredient->'label_override'
                END,
                (v_ingredient->>'display_order')::SMALLINT
            );
        END LOOP;
    END IF;

    RETURN v_recipe_id;
END;
$$;

CREATE OR REPLACE FUNCTION update_user_recipe_with_ingredients(
    p_recipe_id UUID,
    p_user_id UUID,
    p_recipe JSONB,
    p_ingredients JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_ingredient JSONB;
    v_ingredients JSONB := COALESCE(p_ingredients, '[]'::JSONB);
BEGIN
    UPDATE user_recipes
    SET
        name = p_recipe->>'name',
        total_weight_grams = (p_recipe->>'total_weight_grams')::NUMERIC,
        servings = (p_recipe->>'servings')::NUMERIC,
        weight_per_serving_grams = (p_recipe->>'weight_per_serving_grams')::NUMERIC,
        total_calories = (p_recipe->>'total_calories')::NUMERIC,
        total_protein_g = (p_recipe->>'total_protein_g')::NUMERIC,
        total_carbs_g = (p_recipe->>'total_carbs_g')::NUMERIC,
        total_fat_g = (p_recipe->>'total_fat_g')::NUMERIC,
        per_serving_calories = (p_recipe->>'per_serving_calories')::NUMERIC,
        per_serving_protein_g = (p_recipe->>'per_serving_protein_g')::NUMERIC,
        per_serving_carbs_g = (p_recipe->>'per_serving_carbs_g')::NUMERIC,
        per_serving_fat_g = (p_recipe->>'per_serving_fat_g')::NUMERIC,
        notes = p_recipe->>'notes'
    WHERE id = p_recipe_id
      AND user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Recipe not found or not owned by user';
    END IF;

    DELETE FROM recipe_ingredients
    WHERE recipe_id = p_recipe_id;

    IF jsonb_typeof(v_ingredients) = 'array' AND jsonb_array_length(v_ingredients) > 0 THEN
        FOR v_ingredient IN SELECT value FROM jsonb_array_elements(v_ingredients)
        LOOP
            INSERT INTO recipe_ingredients (
                recipe_id,
                food_name,
                quantity_grams,
                calories,
                protein_g,
                carbs_g,
                fat_g,
                source,
                taco_id,
                taco_food_base,
                taco_food_variant,
                label_override,
                display_order
            )
            VALUES (
                p_recipe_id,
                v_ingredient->>'food_name',
                (v_ingredient->>'quantity_grams')::NUMERIC,
                (v_ingredient->>'calories')::NUMERIC,
                (v_ingredient->>'protein_g')::NUMERIC,
                (v_ingredient->>'carbs_g')::NUMERIC,
                (v_ingredient->>'fat_g')::NUMERIC,
                v_ingredient->>'source',
                (v_ingredient->>'taco_id')::INTEGER,
                v_ingredient->>'taco_food_base',
                v_ingredient->>'taco_food_variant',
                CASE
                    WHEN v_ingredient->'label_override' = 'null'::JSONB THEN NULL
                    ELSE v_ingredient->'label_override'
                END,
                (v_ingredient->>'display_order')::SMALLINT
            );
        END LOOP;
    END IF;
END;
$$;

-- 7. Add 'recipe' to meal_items.source CHECK constraint (used when logging from a saved recipe).
ALTER TABLE meal_items DROP CONSTRAINT IF EXISTS meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
    CHECK (source IN ('approximate', 'taco', 'taco_decomposed', 'manual', 'user_provided', 'user_history', 'off', 'recipe')) NOT VALID;
ALTER TABLE meal_items VALIDATE CONSTRAINT meal_items_source_check;
