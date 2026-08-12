import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from '../lib/swagger';
import { getQueue, QUEUES } from '../lib/queue';

import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import batchesRouter from './routes/batches';
import companiesRouter from './routes/companies';
import exportsRouter from './routes/exports';
import personaRouter from './routes/persona';
import tenantRouter from './routes/tenant';
import templatesRouter from './routes/templates';

// ── Startup environment validation ────────────────────────────────────────────
// Throw (do not process.exit) so serverless cold starts fail cleanly.
const JWT_SECRET_PLACEHOLDER = 'your-super-secret-jwt-key-here';
const _jwtSecret = process.env.JWT_SECRET;
if (!_jwtSecret || _jwtSecret.trim() === '' || _jwtSecret === JWT_SECRET_PLACEHOLDER) {
  throw new Error(
    '[startup] FATAL: JWT_SECRET is missing or still set to the .env.example placeholder. ' +
      'Generate one with: node -e "require(\'crypto\').randomBytes(64).toString(\'hex\')"'
  );
}

const app = express();

// Restrict CORS to the configured frontend origin only.
const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowedOrigin }));
app.use(morgan('dev'));
app.use(express.json());

app.get('/health', async (_req, res) => {
  const body: {
    status: string;
    timestamp: string;
    queues?: Record<string, number>;
    queueError?: string;
  } = {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };

  try {
    const queue = await getQueue();
    const [crawl, discover, personalize] = await Promise.all([
      queue.getQueueSize(QUEUES.CRAWL_COMPANY),
      queue.getQueueSize(QUEUES.DISCOVER_PERSONA),
      queue.getQueueSize(QUEUES.PERSONALIZE_COMPANY),
    ]);
    body.queues = {
      [QUEUES.CRAWL_COMPANY]: crawl,
      [QUEUES.DISCOVER_PERSONA]: discover,
      [QUEUES.PERSONALIZE_COMPANY]: personalize,
    };
  } catch (err) {
    body.queueError = err instanceof Error ? err.message : String(err);
  }

  res.json(body);
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/docs.json', (_req, res) => res.json(swaggerSpec));

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/batches', batchesRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/exports', exportsRouter);
app.use('/api/persona-searches', personaRouter);
app.use('/api/tenant', tenantRouter);
app.use('/api/templates', templatesRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export default app;
