/**
 * Writes a static OpenAPI document so /docs works on Vercel without scanning route sources at runtime.
 * Run via: npm run build:swagger
 */
import fs from 'fs';
import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Companies Intelligence API',
      version: '1.0.0',
      description:
        'B2B Data Enrichment Engine — upload company domains, crawl websites, extract structured profiles.',
    },
    servers: [
      { url: process.env.APP_URL || 'http://localhost:3001' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'JWT token with tenantId claim. Generate one via: node -e "const jwt=require(\'jsonwebtoken\');console.log(jwt.sign({sub:\'user-1\',tenantId:\'test-tenant-id\'},process.env.JWT_SECRET,{expiresIn:\'7d\'}))"',
        },
      },
      schemas: {
        Batch: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            tenantId: { type: 'string' },
            fileName: { type: 'string' },
            status: {
              type: 'string',
              enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
            },
            totalCompanies: { type: 'integer' },
            processedCompanies: { type: 'integer' },
            completionPercentage: { type: 'number' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Company: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            domain: { type: 'string' },
            baseUrl: { type: 'string' },
            name: { type: 'string', nullable: true },
            crawlStatus: {
              type: 'string',
              enum: ['PENDING', 'CRAWLING', 'COMPLETED', 'FAILED'],
            },
            lastCrawledAt: { type: 'string', format: 'date-time', nullable: true },
            profile: { $ref: '#/components/schemas/CompanyProfile', nullable: true },
            personalizedContents: {
              type: 'array',
              items: { $ref: '#/components/schemas/PersonalizedContent' },
            },
          },
        },
        CompanyProfile: {
          type: 'object',
          properties: {
            name: { type: 'string', nullable: true },
            description: { type: 'string', nullable: true },
            location: { type: 'string', nullable: true },
            emails: { type: 'array', items: { type: 'string' } },
            phones: { type: 'array', items: { type: 'string' } },
            services: { type: 'array', items: { type: 'string' } },
            team: { type: 'array', items: { type: 'object' } },
            history: { type: 'string', nullable: true },
            socialLinks: { type: 'object' },
            completionScore: { type: 'number' },
          },
        },
        PersonalizedContent: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            emailSubject: { type: 'string', nullable: true },
            openingLine: { type: 'string', nullable: true },
            valueProposition: { type: 'string', nullable: true },
            fullMessage: { type: 'string', nullable: true },
            generatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [
    path.join(__dirname, '../src/api/routes/*.ts'),
    path.join(__dirname, '../dist/api/routes/*.js'),
  ],
};

const spec = swaggerJsdoc(options);
const outPath = path.join(__dirname, '../src/lib/openapi.generated.json');
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`[swagger] wrote ${outPath}`);
