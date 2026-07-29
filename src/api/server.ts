import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from '../lib/swagger';

import authRouter from './routes/auth';
import adminRouter from './routes/admin';
import batchesRouter from './routes/batches';
import companiesRouter from './routes/companies';
import exportsRouter from './routes/exports';
import personaRouter from './routes/persona';
import tenantRouter from './routes/tenant';
import templatesRouter from './routes/templates';
import { logBrevoConfig } from '../lib/email';
import { startWorker } from '../worker';

// ── Startup environment validation ────────────────────────────────────────────
// Fail fast before binding to port so misconfigured deployments are obvious.
const JWT_SECRET_PLACEHOLDER = 'your-super-secret-jwt-key-here';
const _jwtSecret = process.env.JWT_SECRET;
if (!_jwtSecret || _jwtSecret.trim() === '' || _jwtSecret === JWT_SECRET_PLACEHOLDER) {
  console.error('[startup] FATAL: JWT_SECRET is missing or still set to the .env.example placeholder.');
  console.error('[startup] Generate a secure value:');
  console.error('[startup]   node -e "require(\'crypto\').randomBytes(64).toString(\'hex\')"');
  process.exit(1);
}

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Restrict CORS to the configured frontend origin only.
const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowedOrigin }));
app.use(morgan('dev'));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] Frontend  → http://localhost:3000`);
  console.log(`[server] API docs  → http://localhost:${PORT}/docs`);
  logBrevoConfig();

  if (process.env.ENABLE_EMBEDDED_WORKER === 'true') {
    startWorker().catch((err) => {
      console.error('[server] embedded worker failed to start:', err);
    });
  }
});

export default app;
