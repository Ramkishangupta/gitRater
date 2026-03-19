import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { validateEnvironment, config } from './config/env';
import routes from './routes';
import { logger } from './utils/logger';
import { providerManager } from './services/providerManager';


try {
    validateEnvironment();
} catch (error) {
    logger.error('Failed to start server due to missing environment variables');
    process.exit(1);
}

const app = express();
const PORT = config.port;

// CORS configuration
const allowedOrigins = process.env.CLIENT_URL
    ? process.env.CLIENT_URL.split(',').map(url => url.trim())
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'];

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, 
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(express.json());


app.use((req: any, res: any, next: any) => {
    logger.info(`${req.method} ${req.path}`);
    next();
});


app.use('/api', limiter, routes);


app.get('/', (req: any, res: any) => {
    res.json({ message: 'DevRate API is running 🚀' });
});

// Initialize AI providers on startup
async function initializeServer() {
    try {
        await providerManager.initializeProviders();
        logger.info('AI providers initialized successfully');
    } catch (error) {
        logger.error('Failed to initialize AI providers:', error);
    }
}

app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
    initializeServer();

    // Embed queue worker in API process for free-tier deployment
    if (process.env.REDIS_URL) {
        import('./services/queueService').then(({ analysisQueue }) => {
            import('./workers/aiWorker').then(({ processAnalysisJob }) => {
                analysisQueue.process(2, async (job: any) => processAnalysisJob(job));
                logger.info('📨 Queue worker started in API process');
            });
        });
    }
});
