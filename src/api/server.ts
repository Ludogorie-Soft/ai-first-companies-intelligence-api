import 'dotenv/config';
import app from './app';
import { logBrevoConfig } from '../lib/email';

const PORT = parseInt(process.env.PORT || '3001', 10);

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] Frontend  → http://localhost:3000`);
  console.log(`[server] API docs  → http://localhost:${PORT}/docs`);
  logBrevoConfig();

  // Dynamic import so the static graph of this file (and of api/index.ts → app.ts)
  // never pulls in Crawlee / Playwright. Only used for Docker single-process deploys.
  if (process.env.ENABLE_EMBEDDED_WORKER === 'true') {
    import('../worker')
      .then(({ startWorker }) =>
        startWorker().catch((err) => {
          console.error('[server] embedded worker failed to start:', err);
        })
      )
      .catch((err) => {
        console.error('[server] failed to load embedded worker module:', err);
      });
  }
});

export default app;
