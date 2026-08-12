import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
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

/** CDN assets — swagger-ui-express static files are not available in the Vercel bundle. */
const SWAGGER_UI_VERSION = '5.11.0';

function swaggerDocsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Companies Intelligence API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css" />
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" crossorigin></script>
  <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-standalone-preset.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/docs.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
      });
    };
  </script>
</body>
</html>`;
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

// CDN-backed Swagger UI (works on Vercel; local swagger-ui-dist assets are not bundled).
app.get(['/docs', '/docs/'], (_req, res) => {
  res.type('html').send(swaggerDocsHtml());
});
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
