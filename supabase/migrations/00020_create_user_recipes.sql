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
    total_calories              NUMERIC(8,2) NOT NULL DEFAULT 0,
    total_protein_g             NUMERIC(8,2) NOT NULL DEFAULT 0,
    total_carbs_g               NUMERIC(8,2) NOT NULL DEFAULT 0,
    total_fat_g                 NUMERIC(8,2) NOT NULL DEFAULT 0,
    per_serving_calories        NUMERIC(8,2) NOT NULL DEFAULT 0,
    per_serving_protein_g       NUMERIC(8,2) NOT NULL DEFAULT 0,
    per_serving_carbs_g         NUMERIC(8,2) NOT NULL DEFAULT 0,
    per_serving_fat_g           NUMERIC(8,2) NOT NULL DEFAULT 0,
    notes                       TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX user_recipes_user_name_unique
    ON user_recipes (user_id, lower(name));

CREATE INDEX user_recipes_user_id_idx ON user_recipes (user_id);
CREATE INDEX user_recipes_name_trgm_idx ON user_recipes USING gin (name gin_trgm_ops);

-- 3. Child table.
CREATE TABLE recipe_ingredients (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id           UUID NOT NULL REFERENCES user_recipes(id) ON DELETE CASCADE,
    food_name           TEXT NOT NULL,
    quantity_grams      NUMERIC(8,2) NOT NULL CHECK (quantity_grams > 0),
    calories            NUMERIC(8,2) NOT NULL DEFAULT 0,
    protein_g           NUMERIC(8,2) NOT NULL DEFAULT 0,
    carbs_g             NUMERIC(8,2) NOT NULL DEFAULT 0,
    fat_g               NUMERIC(8,2) NOT NULL DEFAULT 0,
    source              TEXT NOT NULL CHECK (source IN ('taco', 'user_label')),
    taco_id             INTEGER REFERENCES taco_foods(id),
    taco_food_base      TEXT,
    taco_food_variant   TEXT,
    label_override      JSONB,
    display_order       SMALLINT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX recipe_ingredients_recipe_id_idx ON recipe_ingredients (recipe_id);

-- 4. updated_at trigger on user_recipes (reuse helper if present; fallback inline).
CREATE OR REPLACE FUNCTION set_user_recipes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_recipes_set_updated_at
    BEFORE UPDATE ON user_recipes
    FOR EACH ROW EXECUTE FUNCTION set_user_recipes_updated_at();

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

-- 6. Add 'recipe' to meal_items.source CHECK constraint (used when logging from a saved recipe).
ALTER TABLE meal_items DROP CONSTRAINT IF EXISTS meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
    CHECK (source IN ('approximate', 'taco', 'taco_decomposed', 'manual', 'user_provided', 'user_history', 'off', 'recipe'));
