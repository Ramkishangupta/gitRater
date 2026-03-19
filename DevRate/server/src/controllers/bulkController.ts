import { Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import * as xlsx from 'xlsx';
import { getOrCalculateRating } from '../services/ratingService';
import { addAnalysisJob, getBulkJobStatus } from '../services/queueService';
import pool from '../db';

export const uploadBulkRatings = async (req: AuthRequest, res: Response): Promise<void> => {
    if (!req.file) {
        res.status(400).json({ success: false, error: 'No file uploaded.' });
        return;
    }

    try {
        const userId = req.user?.userId;
        const sessionName = req.body.sessionName || `Analysis ${new Date().toLocaleDateString()}`;
        const jobDescription = req.body.jobDescription;
        
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet);

        logger.info(`Processing bulk upload file: ${req.file.originalname} with ${data.length} rows.`);

        if (data.length === 0) {
            res.json({ success: true, message: 'File is empty.', data: [] });
            return;
        }

        // Identify key for GitHub URL
        const firstRow: any = data[0];
        let urlKey = '';
        
        // Strategy 1: Look for key with 'github' (case insensitive)
        const keys = Object.keys(firstRow);
        urlKey = keys.find(k => k.toLowerCase().includes('github')) || '';

        // Strategy 2: If no key, look for value in first row that looks like a URL
        if (!urlKey) {
            for (const key of keys) {
                const val = String(firstRow[key]);
                if (val.includes('github.com/')) {
                    urlKey = key;
                    break;
                }
            }
        }

        if (!urlKey) {
             res.status(400).json({ success: false, error: 'Could not identify GitHub URL column. Please ensure a column named "GitHub" exists or contains valid URLs.' });
             return;
        }

        logger.info(`Identified GitHub URL column: ${urlKey}`);

        // Extract all usernames
        const usernames: string[] = [];
        for (const row of data as any[]) {
            const url = row[urlKey];
            if (!url) continue;

            const parts = String(url).split('github.com/');
            if (parts.length < 2) continue;
            
            const username = parts[1].split('/')[0].trim();
            if (username) usernames.push(username);
        }

        if (usernames.length === 0) {
            res.status(400).json({ success: false, error: 'No valid GitHub usernames found in file.' });
            return;
        }

        // Create bulk analysis session
        const sessionResult = await pool.query(
            `INSERT INTO bulk_analysis_sessions (user_id, session_name, total_profiles)
             VALUES ($1, $2, $3) RETURNING id`,
            [userId, sessionName, usernames.length]
        );
        const sessionId = sessionResult.rows[0].id;

        logger.info(`Created bulk analysis session ${sessionId} with ${usernames.length} profiles`);

        // Queue all jobs asynchronously
        const jobIds: string[] = [];
        for (const username of usernames) {
            try {
                const jobId = await addAnalysisJob({
                    userId: userId!,
                    sessionId,
                    username,
                    jobDescription,
                    jobType: 'bulk_analysis'
                });
                jobIds.push(jobId);
                logger.debug(`Queued job ${jobId} for ${username}`);
            } catch (err: any) {
                logger.error(`Failed to queue job for ${username}:`, err);
            }
        }

        logger.info(`Queued ${jobIds.length} jobs for bulk analysis session ${sessionId}`);

        // Return immediately with session info
        res.json({
            success: true,
            message: `Queued ${jobIds.length} profiles for analysis`,
            sessionId,
            totalProfiles: usernames.length,
            jobIds,
            pollingUrl: `/api/bulk-sessions/${sessionId}/status`,
            estimatedCompletion: new Date(Date.now() + usernames.length * 5000).toISOString()
        });

    } catch (error) {
        logger.error('Error processing bulk upload:', error);
        res.status(500).json({ success: false, error: 'Failed to process file.' });
    }
};

// Get all bulk analysis sessions for a user
export const getBulkSessions = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const userId = req.user?.userId;
        
        if (!userId) {
            res.status(401).json({ success: false, error: 'Unauthorized' });
            return;
        }

        const result = await pool.query(
            `SELECT id, session_name, total_profiles, created_at 
             FROM bulk_analysis_sessions 
             WHERE user_id = $1 
             ORDER BY created_at DESC`,
            [userId]
        );

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        logger.error('Error fetching bulk sessions:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch sessions.' });
    }
};

// Get details of a specific bulk analysis session
export const getBulkSessionDetails = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const userId = req.user?.userId;
        const sessionId = req.params.sessionId;

        if (!userId) {
            res.status(401).json({ success: false, error: 'Unauthorized' });
            return;
        }

        // Verify session belongs to user
        const sessionResult = await pool.query(
            `SELECT * FROM bulk_analysis_sessions 
             WHERE id = $1 AND user_id = $2`,
            [sessionId, userId]
        );

        if (sessionResult.rows.length === 0) {
            res.status(404).json({ success: false, error: 'Session not found' });
            return;
        }

        // Get all profiles for this session
        const profilesResult = await pool.query(
            `SELECT * FROM bulk_analysis_profiles 
             WHERE session_id = $1 
             ORDER BY created_at ASC`,
            [sessionId]
        );

        res.json({
            success: true,
            session: sessionResult.rows[0],
            profiles: profilesResult.rows
        });
    } catch (error) {
        logger.error('Error fetching bulk session details:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch session details.' });
    }
};

// Get real-time status of a bulk analysis session
export const getBulkSessionStatus = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const userId = req.user?.userId;
        const sessionId = req.params.sessionId;

        if (!userId) {
            res.status(401).json({ success: false, error: 'Unauthorized' });
            return;
        }

        // Verify session belongs to user
        const sessionResult = await pool.query(
            `SELECT * FROM bulk_analysis_sessions 
             WHERE id = $1 AND user_id = $2`,
            [sessionId, userId]
        );

        if (sessionResult.rows.length === 0) {
            res.status(404).json({ success: false, error: 'Session not found' });
            return;
        }

        const session = sessionResult.rows[0];

        // Get job statuses
        const jobsResult = await pool.query(
            `SELECT status, github_username, error_message 
             FROM analysis_jobs 
             WHERE session_id = $1`,
            [sessionId]
        );

        const total = session.total_profiles;
        const jobs = jobsResult.rows;

        const completed = jobs.filter((j: any) => j.status === 'completed').length;
        const processing = jobs.filter((j: any) => j.status === 'processing').length;
        const pending = jobs.filter((j: any) => j.status === 'pending').length;
        const failed = jobs.filter((j: any) => j.status === 'failed').length;

        const progress = total > 0 ? (completed / total) * 100 : 0;
        const isComplete = completed + failed === total;

        // Calculate estimated time remaining (assuming 5 seconds per job)
        const remaining = total - completed - failed;
        const estimatedSeconds = remaining * 5;
        const estimatedTimeRemaining = estimatedSeconds > 0 
            ? `${Math.ceil(estimatedSeconds / 60)} minutes` 
            : '0 seconds';

        // Get errors
        const errors = jobs
            .filter((j: any) => j.status === 'failed')
            .map((j: any) => ({
                username: j.github_username,
                reason: j.error_message
            }));

        res.json({
            success: true,
            sessionId: parseInt(sessionId as string),
            total,
            completed,
            processing,
            pending,
            failed,
            progress: Math.round(progress * 10) / 10,
            isComplete,
            estimatedTimeRemaining,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        logger.error('Error fetching bulk session status:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch session status.' });
    }
};
