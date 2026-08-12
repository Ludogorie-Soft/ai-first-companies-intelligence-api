/**
 * Vercel serverless entry. Exports the Express app only.
 * Must never import server.ts or the worker (Playwright / Crawlee).
 */
import app from '../src/api/app';

export default app;
