-- Bot settings per user
CREATE TABLE user_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    reminders_enabled BOOLEAN DEFAULT TRUE,
    daily_summary_time TIME DEFAULT '21:00',
    reminder_time TIME DEFAULT '14:00',
    detail_level VARCHAR(10) DEFAULT 'detailed' CHECK (detail_level IN ('brief','detailed')),
    weight_unit VARCHAR(5) DEFAULT 'kg' CHECK (weight_unit IN ('kg','lb')),
    last_reminder_sent_at TIMESTAMPTZ,
    last_summary_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
