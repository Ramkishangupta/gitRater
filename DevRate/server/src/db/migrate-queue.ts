import pool from './index';
import { logger } from '../utils/logger';

/**
 * Migration script to add new tables for scalable architecture
 * Run with: npm run db:migrate
 */
async function runMigration() {
  logger.info('Starting database migration for scalable architecture...');

  try {
    // Create ai_providers table
    await pool.query(`
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
    `);
    logger.info('✅ Created ai_providers table');

    // Create ai_provider_usage table
    await pool.query(`
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
    `);
    logger.info('✅ Created ai_provider_usage table');

    // Create analysis_jobs table
    await pool.query(`
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
    `);
    logger.info('✅ Created analysis_jobs table');

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_providers_active_priority 
        ON ai_providers(is_active, priority DESC);
    `);
    logger.info('✅ Created index: idx_providers_active_priority');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_usage_rate_limited 
        ON ai_provider_usage(provider_id, is_rate_limited);
    `);
    logger.info('✅ Created index: idx_usage_rate_limited');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_status 
        ON analysis_jobs(status);
    `);
    logger.info('✅ Created index: idx_jobs_status');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_user_session 
        ON analysis_jobs(user_id, session_id);
    `);
    logger.info('✅ Created index: idx_jobs_user_session');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_created 
        ON analysis_jobs(created_at DESC);
    `);
    logger.info('✅ Created index: idx_jobs_created');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_jobs_job_id 
        ON analysis_jobs(job_id);
    `);
    logger.info('✅ Created index: idx_jobs_job_id');

    logger.info('🎉 Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigration();
