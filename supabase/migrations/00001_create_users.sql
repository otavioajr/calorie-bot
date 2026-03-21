-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_id UUID REFERENCES auth.users(id),
    phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    sex VARCHAR(10) CHECK (sex IN ('male','female')),
    age INTEGER,
    weight_kg DECIMAL(5,2),
    height_cm DECIMAL(5,2),
    activity_level VARCHAR(20) CHECK (activity_level IN ('sedentary','light','moderate','intense')),
    goal VARCHAR(20) CHECK (goal IN ('lose','maintain','gain')),
    calorie_mode VARCHAR(20) DEFAULT 'approximate' CHECK (calorie_mode IN ('approximate','taco','manual')),
    daily_calorie_target INTEGER,
    calorie_target_manual BOOLEAN DEFAULT FALSE,
    tmb DECIMAL(7,2),
    tdee DECIMAL(7,2),
    timezone VARCHAR(50) DEFAULT 'America/Sao_Paulo',
    onboarding_complete BOOLEAN DEFAULT FALSE,
    onboarding_step INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
