-- Industrialized products catalog, private user labels, and usage tracking.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE products (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    name_normalized     TEXT NOT NULL,
    brand               TEXT,
    brand_normalized    TEXT,
    barcode             TEXT,
    serving_size_g      NUMERIC,
    serving_display     TEXT,
    calories_per_100g   NUMERIC NOT NULL CHECK (calories_per_100g >= 0 AND calories_per_100g <= 950),
    protein_per_100g    NUMERIC NOT NULL CHECK (protein_per_100g >= 0 AND protein_per_100g <= 100),
    carbs_per_100g      NUMERIC NOT NULL CHECK (carbs_per_100g >= 0 AND carbs_per_100g <= 100),
    fat_per_100g        NUMERIC NOT NULL CHECK (fat_per_100g >= 0 AND fat_per_100g <= 100),
    fiber_per_100g      NUMERIC CHECK (fiber_per_100g IS NULL OR (fiber_per_100g >= 0 AND fiber_per_100g <= 100)),
    sodium_per_100g     NUMERIC CHECK (sodium_per_100g IS NULL OR sodium_per_100g >= 0),
    source              TEXT NOT NULL CHECK (source IN ('open_food_facts', 'user_label', 'consenso_usuarios')),
    source_ref          TEXT,
    status              TEXT NOT NULL CHECK (status IN ('aprovado', 'privado')),
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    promoted_at         TIMESTAMPTZ,
    contributor_ids     UUID[],
    CHECK (serving_size_g IS NULL OR serving_size_g > 0)
);

CREATE UNIQUE INDEX products_barcode_unique
    ON products (barcode)
    WHERE barcode IS NOT NULL;
CREATE INDEX products_name_normalized_trgm_idx
    ON products USING gin (name_normalized gin_trgm_ops);
CREATE INDEX products_brand_name_normalized_idx
    ON products (brand_normalized, name_normalized)
    WHERE status = 'aprovado';
CREATE INDEX products_private_owner_idx
    ON products (created_by, name_normalized)
    WHERE status = 'privado';

CREATE TABLE product_usage (
    product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (product_id, user_id, used_at)
);

CREATE INDEX product_usage_user_used_at_idx
    ON product_usage (user_id, used_at DESC);

ALTER TABLE meal_items DROP CONSTRAINT IF EXISTS meal_items_source_check;
ALTER TABLE meal_items ADD CONSTRAINT meal_items_source_check
    CHECK (source IN (
        'approximate',
        'taco',
        'manual',
        'taco_decomposed',
        'user_provided',
        'user_history',
        'off',
        'recipe',
        'product'
    ));

ALTER TABLE meal_items
    ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id);

CREATE INDEX meal_items_product_id_idx
    ON meal_items (product_id)
    WHERE product_id IS NOT NULL;

CREATE TRIGGER products_set_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION taco_max_similarity(input TEXT)
RETURNS REAL
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(MAX(similarity(lower(t.food_name), lower(input))), 0)::REAL
    FROM taco_foods t;
$$;

GRANT EXECUTE ON FUNCTION taco_max_similarity(TEXT) TO anon, authenticated, service_role;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_select_approved ON products
    FOR SELECT USING (status = 'aprovado');

CREATE POLICY products_select_own_private ON products
    FOR SELECT USING (
        status = 'privado'
        AND created_by IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );

CREATE POLICY products_insert_own_private ON products
    FOR INSERT WITH CHECK (
        status = 'privado'
        AND created_by IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );

CREATE POLICY products_update_own_private ON products
    FOR UPDATE USING (
        status = 'privado'
        AND created_by IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );

CREATE POLICY product_usage_owner_all ON product_usage
    FOR ALL USING (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    )
    WITH CHECK (
        user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
    );
