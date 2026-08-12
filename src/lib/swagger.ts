import generated from './openapi.generated.json';

/**
 * Prefer the build-time OpenAPI document so /docs works on Vercel
 * where scanning ./src/api/routes/*.ts at runtime is unreliable.
 */
export const swaggerSpec = generated as Record<string, unknown>;
