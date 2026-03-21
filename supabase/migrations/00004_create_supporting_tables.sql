-- TACO foods (pre-loaded Brazilian food table — read-only)
CREATE TABLE taco_foods (
    id SERIAL PRIMARY KEY,
    food_name VARCHAR(300) NOT NULL,
    category VARCHAR(100),
    calories_per_100g DECIMAL(7,2),
    protein_per_100g DECIMAL(7,2),
    carbs_per_100g DECIMAL(7,2),
    fat_per_100g DECIMAL(7,2),
    fiber_per_100g DECIMAL(7,2),
    sodium_per_100g DECIMAL(7,2)
);

-- Weight log
CREATE TABLE weight_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    weight_kg DECIMAL(5,2) NOT NULL,
    logged_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversation context (state machine)
CREATE TABLE conversation_context (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    context_type VARCHAR(30) NOT NULL,
    context_data JSONB NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- LLM usage log
CREATE TABLE llm_usage_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    provider VARCHAR(20) NOT NULL,
    model VARCHAR(100) NOT NULL,
    function_type VARCHAR(30) NOT NULL,
    tokens_input INTEGER,
    tokens_output INTEGER,
    cost_usd DECIMAL(10,6),
    latency_ms INTEGER,
    success BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Food cache (reduces LLM calls for common foods)
CREATE TABLE food_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    food_name_normalized VARCHAR(200) UNIQUE NOT NULL,
    calories_per_100g DECIMAL(7,2) NOT NULL,
    protein_per_100g DECIMAL(7,2),
    carbs_per_100g DECIMAL(7,2),
    fat_per_100g DECIMAL(7,2),
    typical_portion_grams DECIMAL(7,2),
    source VARCHAR(20) NOT NULL,
    hit_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auth codes for WhatsApp OTP login
CREATE TABLE auth_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) NOT NULL,
    code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Processed messages (webhook deduplication)
CREATE TABLE processed_messages (
    message_id VARCHAR(100) PRIMARY KEY,
    processed_at TIMESTAMPTZ DEFAULT NOW()
);
