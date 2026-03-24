import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { transactionRoutes } from './routes/transactions';
import { bulkRoutes } from './routes/bulk';
import { transactionDisputeRoutes, disputeRoutes } from './routes/disputes';
import { errorHandler } from './middleware/errorHandler';
import { connectRedis, redisClient } from './config/redis';
import { pool } from './config/database';
import { globalTimeout, haltOnTimedout, timeoutErrorHandler } from './middleware/timeout';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});

// Security and parsing middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * @openapi
 * /ready:
 *   get:
 *     summary: Readiness probe for Kubernetes
 *     description: Checks database and redis connections
 *     responses:
 *       200:
 *         description: Application is ready
 *       503:
 *         description: Application is not ready
 */
app.get('/ready', async (req, res) => {
  const checks: Record<string, string> = {
    database: 'down',
    redis: 'down'
  };

  let allReady = true;

  try {
    // Check database
    await pool.query('SELECT 1');
    checks.database = 'ok';
  } catch (err) {
    console.error('Readiness probe: Database check failed', err);
    checks.database = 'error';
    allReady = false;
  }

  try {
    // Check Redis
    if (redisClient.isOpen) {
      await redisClient.ping();
      checks.redis = 'ok';
    } else {
      checks.redis = 'closed';
      allReady = false;
    }
  } catch (err) {
    console.error('Readiness probe: Redis check failed', err);
    checks.redis = 'error';
    allReady = false;
  }

  const responsePayload = {
    status: allReady ? 'ready' : 'not ready',
    checks,
    timestamp: new Date().toISOString()
  };

  if (allReady) {
    res.status(200).json(responsePayload);
  } else {
    res.status(503).json(responsePayload);
  }
});

// Global timeout configuration (applied to business routes)
app.use(globalTimeout);
app.use(haltOnTimedout);

app.use(limiter);

app.use('/api/transactions', transactionRoutes);
app.use('/api/transactions', transactionDisputeRoutes);
app.use('/api/transactions/bulk', bulkRoutes);
app.use('/api/disputes', disputeRoutes);

// Timeout error handler (must be before general error handler)
app.use(timeoutErrorHandler);
app.use(errorHandler);

// Initialize Redis connection
connectRedis()
  .then(() => {
    console.log('Redis initialized');
  })
  .catch((err) => {
    console.error('Failed to connect to Redis:', err);
    console.warn('Distributed locks will not be available');
  });

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
