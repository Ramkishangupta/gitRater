import dotenv from 'dotenv';
dotenv.config();

import { Job } from 'bull';
import analysisQueue, { AnalysisJobData } from '../services/queueService';
import { getOrCalculateRating } from '../services/ratingService';
import pool from '../db';
import { logger } from '../utils/logger';

/**
 * Process a developer analysis job
 */
export async function processAnalysisJob(job: Job<AnalysisJobData>): Promise<any> {
  const { jobId, userId, sessionId, username, jobDescription, jobType } = job.data;

  logger.info(`Worker processing job ${jobId} for user ${username}`);

  try {
    // Update job status in database
    await pool.query(
      `INSERT INTO analysis_jobs (job_id, user_id, session_id, github_username, job_type, status, started_at)
       VALUES ($1, $2, $3, $4, $5, 'processing', NOW())
       ON CONFLICT (job_id) 
       DO UPDATE SET status = 'processing', started_at = NOW(), attempts = analysis_jobs.attempts + 1`,
      [jobId, userId, sessionId, username, jobType]
    );

    const startTime = Date.now();

    // Perform the analysis
    const result = await getOrCalculateRating(username, userId, jobDescription);

    const processingTime = Date.now() - startTime;

    // For bulk analysis, save to bulk_analysis_profiles table
    if (sessionId && jobType === 'bulk_analysis') {
      const data = result.data;
      
      await pool.query(
        `INSERT INTO bulk_analysis_profiles 
         (session_id, candidate_name, github_url, github_username, devrate_tier, 
          quality_score, job_fit_score, match_reason, profile_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          sessionId,
          data.name || data.username,
          `https://github.com/${username}`,
          username,
          data.tier,
          data.score_breakdown?.quality_score || 0,
          data.ai_analysis?.job_fit_score,
          data.ai_analysis?.match_reason,
          JSON.stringify(data),
        ]
      );

      logger.info(`Saved bulk analysis result for ${username} in session ${sessionId}`);
    }

    // Update job status to completed
    await pool.query(
      `UPDATE analysis_jobs 
       SET status = 'completed', 
           completed_at = NOW(), 
           result_data = $1,
           processing_time_ms = $2
       WHERE job_id = $3`,
      [JSON.stringify(result), processingTime, jobId]
    );

    logger.info(`Job ${jobId} completed in ${processingTime}ms`);

    // Update progress (100%)
    await job.progress(100);

    return result;
  } catch (error: any) {
    logger.error(`Job ${jobId} failed:`, error);

    // Save error to bulk_analysis_profiles if it's a bulk job
    if (sessionId && jobType === 'bulk_analysis') {
      try {
        await pool.query(
          `INSERT INTO bulk_analysis_profiles 
           (session_id, github_username, error_message)
           VALUES ($1, $2, $3)`,
          [sessionId, username, error.message || 'Unknown error']
        );
      } catch (dbError) {
        logger.error('Error saving bulk analysis error:', dbError);
      }
    }

    // Update job status to failed
    await pool.query(
      `UPDATE analysis_jobs 
       SET status = 'failed', 
           error_message = $1,
           completed_at = NOW()
       WHERE job_id = $2`,
      [error.message || 'Unknown error', jobId]
    );

    throw error;
  }
}

/**
 * Main worker process
 */
async function startWorker() {
  logger.info('🚀 AI Worker started');
  logger.info(`Redis URL: ${process.env.REDIS_URL || 'redis://localhost:6379'}`);
  logger.info('Waiting for jobs...');

  // Process jobs from the queue
  analysisQueue.process(5, async (job: Job<AnalysisJobData>) => {
    return processAnalysisJob(job);
  });

  // Event handlers
  analysisQueue.on('completed', (job, result) => {
    logger.info(`✅ Job ${job.id} completed successfully`);
  });

  analysisQueue.on('failed', (job, err) => {
    logger.error(`❌ Job ${job?.id} failed:`, err.message);
  });

  analysisQueue.on('error', (error) => {
    logger.error('Queue error:', error);
  });

  analysisQueue.on('active', (job) => {
    logger.info(`⚡ Processing job ${job.id} for ${job.data.username}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, closing worker...');
    await analysisQueue.close();
    await pool.end();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, closing worker...');
    await analysisQueue.close();
    await pool.end();
    process.exit(0);
  });

  // Keep process alive
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  });
}

// Only start standalone worker when run directly (not when imported by index.ts)
const isDirectRun = require.main === module || process.argv[1]?.includes('aiWorker');
if (isDirectRun) {
  startWorker().catch((error) => {
    logger.error('Failed to start worker:', error);
    process.exit(1);
  });
}
