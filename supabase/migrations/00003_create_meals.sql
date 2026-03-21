-- Meals
CREATE TABLE meals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    meal_type VARCHAR(20) CHECK (meal_type IN ('breakfast','lunch','snack','dinner','supper')),
    total_calories INTEGER NOT NULL,
    original_message TEXT,
    llm_response JSONB,
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meal items (individual foods in a meal)
CREATE TABLE meal_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meal_id UUID REFERENCES meals(id) ON DELETE CASCADE,
    food_name VARCHAR(200) NOT NULL,
    quantity_grams DECIMAL(7,2),
    calories INTEGER NOT NULL,
    protein_g DECIMAL(7,2),
    carbs_g DECIMAL(7,2),
    fat_g DECIMAL(7,2),
    source VARCHAR(20) DEFAULT 'approximate' CHECK (source IN ('approximate','taco','manual')),
    taco_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
