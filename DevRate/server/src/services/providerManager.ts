import pool from '../db';
import { logger } from '../utils/logger';

export interface AIProvider {
  id: number;
  provider_name: string;
  model_name: string;
  api_key_encrypted: string;
  rate_limit_per_minute: number;
  rate_limit_per_day: number;
  cost_per_1k_tokens: number;
  priority: number;
  is_active: boolean;
}

export class ProviderManager {
  /**
   * Get the best available AI provider based on:
   * 1. Active status
   * 2. Not rate-limited
   * 3. Priority (higher is better)
   * 4. Cost (lower is better)
   */
  async getAvailableProvider(): Promise<AIProvider | null> {
    try {
      // Get all active providers sorted by priority and cost
      const result = await pool.query(
        `SELECT p.*, u.is_rate_limited, u.requests_this_minute, u.requests_this_day
         FROM ai_providers p
         LEFT JOIN ai_provider_usage u ON p.id = u.provider_id
         WHERE p.is_active = true
         ORDER BY p.priority DESC, p.cost_per_1k_tokens ASC
        `
      );

      if (result.rows.length === 0) {
        logger.error('No active AI providers found');
        return null;
      }

      // Check rate limits for each provider
      for (const provider of result.rows) {
        const isRateLimited = await this.checkRateLimit(provider.id);
        
        if (!isRateLimited) {
          logger.info(`Selected provider: ${provider.provider_name} (${provider.model_name})`);
          return provider;
        }
      }

      logger.warn('All providers are rate-limited');
      return null;
    } catch (error) {
      logger.error('Error getting available provider:', error);
      return null;
    }
  }

  /**
   * Check if a provider is rate-limited
   */
  async checkRateLimit(providerId: number): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT p.rate_limit_per_minute, p.rate_limit_per_day,
                u.requests_this_minute, u.requests_this_day,
                u.last_reset_minute, u.last_reset_day
         FROM ai_providers p
         LEFT JOIN ai_provider_usage u ON p.id = u.provider_id
         WHERE p.id = $1`,
        [providerId]
      );

      if (result.rows.length === 0) return true;

      const provider = result.rows[0];
      const now = new Date();

      // Reset counters if needed
      const minuteResetTime = new Date(provider.last_reset_minute);
      const dayResetTime = new Date(provider.last_reset_day);

      if (now.getTime() - minuteResetTime.getTime() >= 60000) {
        // Reset minute counter
        await pool.query(
          `UPDATE ai_provider_usage 
           SET requests_this_minute = 0, 
               last_reset_minute = NOW(),
               is_rate_limited = false
           WHERE provider_id = $1`,
          [providerId]
        );
        return false;
      }

      if (now.getTime() - dayResetTime.getTime() >= 86400000) {
        // Reset day counter
        await pool.query(
          `UPDATE ai_provider_usage 
           SET requests_this_day = 0, 
               last_reset_day = NOW()
           WHERE provider_id = $1`,
          [providerId]
        );
      }

      // Check if rate-limited
      if (
        provider.requests_this_minute >= provider.rate_limit_per_minute ||
        provider.requests_this_day >= provider.rate_limit_per_day
      ) {
        await pool.query(
          `UPDATE ai_provider_usage 
           SET is_rate_limited = true 
           WHERE provider_id = $1`,
          [providerId]
        );
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error checking rate limit:', error);
      return true; // Fail closed
    }
  }

  /**
   * Record API usage for a provider
   */
  async recordUsage(providerId: number): Promise<void> {
    try {
      // Ensure usage record exists
      await pool.query(
        `INSERT INTO ai_provider_usage (provider_id, requests_this_minute, requests_this_day)
         VALUES ($1, 0, 0)
         ON CONFLICT (provider_id) DO NOTHING`,
        [providerId]
      );

      // Increment counters
      await pool.query(
        `UPDATE ai_provider_usage 
         SET requests_this_minute = requests_this_minute + 1,
             requests_this_day = requests_this_day + 1
         WHERE provider_id = $1`,
        [providerId]
      );

      // Update provider stats
      await pool.query(
        `UPDATE ai_providers 
         SET total_requests = total_requests + 1,
             last_used_at = NOW()
         WHERE id = $1`,
        [providerId]
      );

      logger.debug(`Recorded usage for provider ${providerId}`);
    } catch (error) {
      logger.error('Error recording usage:', error);
    }
  }

  /**
   * Record a successful API call
   */
  async recordSuccess(providerId: number): Promise<void> {
    await this.recordUsage(providerId);
  }

  /**
   * Record a failed API call
   */
  async recordFailure(providerId: number, error: Error): Promise<void> {
    try {
      await pool.query(
        `UPDATE ai_providers 
         SET total_errors = total_errors + 1
         WHERE id = $1`,
        [providerId]
      );

      logger.error(`Provider ${providerId} error:`, error.message);

      // Disable provider if error rate is too high (>20%)
      const result = await pool.query(
        `SELECT total_requests, total_errors 
         FROM ai_providers 
         WHERE id = $1`,
        [providerId]
      );

      if (result.rows.length > 0) {
        const { total_requests, total_errors } = result.rows[0];
        const errorRate = total_requests > 0 ? total_errors / total_requests : 0;

        if (errorRate > 0.2 && total_requests > 10) {
          logger.warn(`Disabling provider ${providerId} due to high error rate: ${errorRate}`);
          await pool.query(
            `UPDATE ai_providers 
             SET is_active = false 
             WHERE id = $1`,
            [providerId]
          );
        }
      }
    } catch (err) {
      logger.error('Error recording failure:', err);
    }
  }

  /**
   * Get API key for a provider (decrypted)
   */
  async getProviderKey(providerId: number): Promise<string | null> {
    try {
      const result = await pool.query(
        'SELECT api_key_encrypted FROM ai_providers WHERE id = $1',
        [providerId]
      );

      if (result.rows.length === 0) return null;

      // For now, we're storing keys as-is
      // In production, you'd decrypt here
      return result.rows[0].api_key_encrypted;
    } catch (error) {
      logger.error('Error getting provider key:', error);
      return null;
    }
  }

  /**
   * Add a new provider
   */
  async addProvider(provider: Omit<AIProvider, 'id'>): Promise<number | null> {
    try {
      const result = await pool.query(
        `INSERT INTO ai_providers 
         (provider_name, model_name, api_key_encrypted, rate_limit_per_minute, 
          rate_limit_per_day, cost_per_1k_tokens, priority, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          provider.provider_name,
          provider.model_name,
          provider.api_key_encrypted,
          provider.rate_limit_per_minute,
          provider.rate_limit_per_day,
          provider.cost_per_1k_tokens,
          provider.priority,
          provider.is_active,
        ]
      );

      logger.info(`Added new provider: ${provider.provider_name} (${provider.model_name})`);
      return result.rows[0].id;
    } catch (error) {
      logger.error('Error adding provider:', error);
      return null;
    }
  }

  /**
   * Get provider by ID
   */
  async getProvider(providerId: number): Promise<AIProvider | null> {
    try {
      const result = await pool.query(
        'SELECT * FROM ai_providers WHERE id = $1',
        [providerId]
      );

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      logger.error('Error getting provider:', error);
      return null;
    }
  }

  /**
   * Initialize default providers from environment
   */
  async initializeProviders(): Promise<void> {
    try {
      // Check if providers already exist
      const existing = await pool.query('SELECT COUNT(*) FROM ai_providers');
      if (parseInt(existing.rows[0].count) > 0) {
        logger.info('Providers already initialized');
        return;
      }

      // Add Gemini provider from env
      if (process.env.GEMINI_API_KEY) {
        await this.addProvider({
          provider_name: 'gemini',
          model_name: 'gemini-2.5-flash',
          api_key_encrypted: process.env.GEMINI_API_KEY,
          rate_limit_per_minute: 15,
          rate_limit_per_day: 1500,
          cost_per_1k_tokens: 0,
          priority: 10,
          is_active: true,
        });
      }

      logger.info('Providers initialized');
    } catch (error) {
      logger.error('Error initializing providers:', error);
    }
  }
}

export const providerManager = new ProviderManager();
