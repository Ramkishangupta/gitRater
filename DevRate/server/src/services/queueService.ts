import Queue from 'bull';
import { logger } from '../utils/logger';

// Job data interfaces
export interface AnalysisJobData {
  jobId: string;
  userId: string;
  sessionId?: number;
  username: string;
  jobDescription?: string;
  jobType: 'single_analysis' | 'bulk_analysis';
}

export interface JobProgress {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  result?: any;
  error?: string;
}

// Create Bull queue
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Upstash uses rediss:// (TLS) — Bull needs explicit tls option
const redisOpts = redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {};

export const analysisQueue = new Queue<AnalysisJobData>('developer-analysis', redisUrl, {
  redis: redisOpts,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s, 4s, 8s
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 200, // Keep last 200 failed jobs
    timeout: 300000, // 5 minute timeout
  },
});

// Queue event handlers
analysisQueue.on('error', (error) => {
  logger.error('Queue error:', error);
});

analysisQueue.on('failed', (job, err) => {
  logger.error(`Job ${job.id} failed:`, err);
});

analysisQueue.on('completed', (job) => {
  logger.info(`Job ${job.id} completed`);
});

analysisQueue.on('stalled', (job) => {
  logger.warn(`Job ${job.id} stalled`);
});

/**
 * Add a developer analysis job to the queue
 */
export async function addAnalysisJob(
  data: Omit<AnalysisJobData, 'jobId'>,
  priority?: number
): Promise<string> {
  try {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const job = await analysisQueue.add(
      {
        ...data,
        jobId,
      },
      {
        priority: priority || (data.jobType === 'single_analysis' ? 1 : 2),
        jobId,
      }
    );

    logger.info(`Added ${data.jobType} job ${jobId} for user ${data.username}`);
    return jobId;
  } catch (error) {
    logger.error('Error adding job to queue:', error);
    throw error;
  }
}

/**
 * Get job status and result
 */
export async function getJobStatus(jobId: string): Promise<JobProgress | null> {
  try {
    const job = await analysisQueue.getJob(jobId);
    
    if (!job) {
      return null;
    }

    const state = await job.getState();
    const progress = job.progress();
    const result = job.returnvalue;
    const error = job.failedReason;

    let status: JobProgress['status'] = 'pending';
    if (state === 'completed') status = 'completed';
    else if (state === 'failed') status = 'failed';
    else if (state === 'active') status = 'processing';

    return {
      status,
      progress: typeof progress === 'number' ? progress : undefined,
      result,
      error,
    };
  } catch (error) {
    logger.error('Error getting job status:', error);
    return null;
  }
}

/**
 * Get status for multiple jobs
 */
export async function getBulkJobStatus(jobIds: string[]): Promise<{
  total: number;
  completed: number;
  processing: number;
  pending: number;
  failed: number;
  results: any[];
}> {
  const statuses = await Promise.all(jobIds.map((id) => getJobStatus(id)));

  const summary = {
    total: jobIds.length,
    completed: 0,
    processing: 0,
    pending: 0,
    failed: 0,
    results: [] as any[],
  };

  statuses.forEach((status) => {
    if (!status) return;
    
    switch (status.status) {
      case 'completed':
        summary.completed++;
        if (status.result) summary.results.push(status.result);
        break;
      case 'processing':
        summary.processing++;
        break;
      case 'pending':
        summary.pending++;
        break;
      case 'failed':
        summary.failed++;
        break;
    }
  });

  return summary;
}

/**
 * Retry a failed job
 */
export async function retryJob(jobId: string): Promise<boolean> {
  try {
    const job = await analysisQueue.getJob(jobId);
    if (!job) return false;

    await job.retry();
    logger.info(`Retrying job ${jobId}`);
    return true;
  } catch (error) {
    logger.error('Error retrying job:', error);
    return false;
  }
}

/**
 * Remove a job from the queue
 */
export async function removeJob(jobId: string): Promise<boolean> {
  try {
    const job = await analysisQueue.getJob(jobId);
    if (!job) return false;

    await job.remove();
    logger.info(`Removed job ${jobId}`);
    return true;
  } catch (error) {
    logger.error('Error removing job:', error);
    return false;
  }
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      analysisQueue.getWaitingCount(),
      analysisQueue.getActiveCount(),
      analysisQueue.getCompletedCount(),
      analysisQueue.getFailedCount(),
      analysisQueue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + delayed,
    };
  } catch (error) {
    logger.error('Error getting queue stats:', error);
    return null;
  }
}

/**
 * Clean old jobs from the queue
 */
export async function cleanQueue(age: number = 86400000): Promise<void> {
  try {
    await analysisQueue.clean(age, 'completed');
    await analysisQueue.clean(age, 'failed');
    logger.info(`Cleaned jobs older than ${age}ms`);
  } catch (error) {
    logger.error('Error cleaning queue:', error);
  }
}

/**
 * Gracefully close the queue
 */
export async function closeQueue(): Promise<void> {
  try {
    await analysisQueue.close();
    logger.info('Queue closed');
  } catch (error) {
    logger.error('Error closing queue:', error);
  }
}

export default analysisQueue;
