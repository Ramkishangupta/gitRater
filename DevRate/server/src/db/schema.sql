-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. App Users (Authentication)
CREATE TABLE IF NOT EXISTS app_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. GitHub Profiles (Cache for developers being rated)
CREATE TABLE IF NOT EXISTS github_profiles (
    username VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255),
    avatar_url TEXT,
    bio TEXT,
    metrics JSONB, -- Stores { activeRepos, followers, etc. }
    location VARCHAR(255),
    blog VARCHAR(255),
    twitter_username VARCHAR(255),
    company VARCHAR(255),
    email VARCHAR(255),
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Ratings (Historical snapshots)
CREATE TABLE IF NOT EXISTS ratings (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) REFERENCES github_profiles(username) ON DELETE CASCADE,
    total_score NUMERIC(5, 2) NOT NULL,
    health_score NUMERIC(5, 2) NOT NULL,
    quality_score NUMERIC(5, 2) NOT NULL,
    breakdown JSONB NOT NULL, -- Full detailed breakdown object
    ai_analysis JSONB, -- { summary, persona, multiplier }
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Search History (Personalized dashboard)
CREATE TABLE IF NOT EXISTS search_history (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
    searched_profile VARCHAR(255) REFERENCES github_profiles(username) ON DELETE CASCADE,
    searched_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_profile UNIQUE(user_id, searched_profile)
);

-- 5. Bulk Analysis Sessions
CREATE TABLE IF NOT EXISTS bulk_analysis_sessions (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
    session_name VARCHAR(255) NOT NULL,
    total_profiles INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Bulk Analysis Profiles
CREATE TABLE IF NOT EXISTS bulk_analysis_profiles (
    id SERIAL PRIMARY KEY,
    session_id INTEGER REFERENCES bulk_analysis_sessions(id) ON DELETE CASCADE,
    candidate_name VARCHAR(255),
    github_url TEXT,
    github_username VARCHAR(255),
    devrate_tier VARCHAR(50),
    quality_score NUMERIC(5, 2),
    job_fit_score INTEGER,
    match_reason TEXT,
    error_message TEXT,
    profile_data JSONB, -- Store complete row data from excel
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. AI Providers (Multi-provider support)
CREATE TABLE IF NOT EXISTS ai_providers (
    id SERIAL PRIMARY KEY,
    provider_name VARCHAR(100) NOT NULL,
    model_name VARCHAR(100),
    api_key_encrypted TEXT NOT NULL,
    rate_limit_per_minute INTEGER DEFAULT 15,
    rate_limit_per_day INTEGER DEFAULT 1500,
    cost_per_1k_tokens NUMERIC(10, 6),
    priority INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    total_requests INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uk_provider_model UNIQUE(provider_name, model_name)
);

-- 8. AI Provider Usage (Rate limit tracking)
CREATE TABLE IF NOT EXISTS ai_provider_usage (
    id SERIAL PRIMARY KEY,
    provider_id INTEGER REFERENCES ai_providers(id) ON DELETE CASCADE,
    requests_this_minute INTEGER DEFAULT 0,
    requests_this_day INTEGER DEFAULT 0,
    last_reset_minute TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_reset_day TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_rate_limited BOOLEAN DEFAULT FALSE,
    rate_limit_reset_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uk_provider_usage UNIQUE(provider_id)
);

-- 9. Analysis Jobs (Queue job tracking)
CREATE TABLE IF NOT EXISTS analysis_jobs (
    id SERIAL PRIMARY KEY,
    job_id VARCHAR(255) UNIQUE NOT NULL,
    user_id UUID REFERENCES app_users(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES bulk_analysis_sessions(id) ON DELETE CASCADE,
    github_username VARCHAR(255),
    job_type VARCHAR(50) CHECK (job_type IN ('single_analysis', 'bulk_analysis')),
    status VARCHAR(50) DEFAULT 'pending' 
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    provider_used VARCHAR(100),
    attempts INTEGER DEFAULT 0,
    error_message TEXT,
    result_data JSONB,
    processing_time_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_ratings_username ON ratings(username);
CREATE INDEX IF NOT EXISTS idx_history_user_id ON search_history(user_id);
CREATE INDEX IF NOT EXISTS idx_ratings_created_at ON ratings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_history_user_profile ON search_history(user_id, searched_profile);
CREATE INDEX IF NOT EXISTS idx_bulk_sessions_user_id ON bulk_analysis_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_bulk_profiles_session_id ON bulk_analysis_profiles(session_id);
CREATE INDEX IF NOT EXISTS idx_providers_active_priority ON ai_providers(is_active, priority DESC);
CREATE INDEX IF NOT EXISTS idx_usage_rate_limited ON ai_provider_usage(provider_id, is_rate_limited);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON analysis_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_user_session ON analysis_jobs(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON analysis_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_job_id ON analysis_jobs(job_id);
