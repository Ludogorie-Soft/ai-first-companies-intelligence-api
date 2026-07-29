import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import fs from 'fs';
import { prisma } from '../../lib/prisma';
import { StorageService } from '../../services/storage';
import { getQueue, enqueueCrawlJob } from '../../lib/queue';
import { isNonCrawlablePlatform } from '../../services/nonCrawlablePlatforms';
import { checkFreshness } from '../../lib/freshness';
import { requireAuth, requireVerified } from '../../middleware/auth';
import { ExportService } from '../../services/export';

const router = Router();

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: MAX_FILE_SIZE } });

// Wrap multer so file-size errors return a clean 400 instead of crashing the request.
function uploadSingle(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'Uploaded file exceeds maximum size of 5 MB' });
      return;
    }
    if (err) { next(err); return; }
    next();
  });
}

function sanitizeFilename(original: string): string {
  // Strip directory components; allow Unicode letters/digits (covers Cyrillic, etc.)
  // plus dot, underscore, hyphen. Replace anything else (slashes, null bytes, etc.) with _.
  const base = path.basename(original);
  return base.replace(/[^\p{L}\p{N}._-]/gu, '_') || 'upload';
}

function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//i, '');
  d = d.replace(/^www\./i, '');
  d = d.split('/')[0]; // remove paths
  return d;
}

function buildBaseUrl(domain: string): string {
  return `https://${domain}`;
}

const HEADER_WORDS = new Set([
  // English
  'domain', 'url', 'website', 'company', 'name', 'link',
  // Bulgarian
  'домейн', 'уебсайт', 'фирма', 'компания', 'връзка', 'сайт',
  'ime na firmata', 'ime', 'firmata',
]);

function isHeaderValue(value: string): boolean {
  return HEADER_WORDS.has(value.trim().toLowerCase());
}

function isValidDomain(domain: string): boolean {
  if (!domain) return false;
  if (/\s/.test(domain)) return false;   // spaces → company name, not a domain
  if (!domain.includes('.')) return false; // no TLD separator → not a domain
  return true;
}

function parseFile(filePath: string, ext: string): string[] {
  if (ext === '.csv') {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result = Papa.parse<string[]>(content, { skipEmptyLines: true });
    return result.data
      .flatMap((row) => row)
      .filter(Boolean)
      .filter((v) => !isHeaderValue(v));
  } else {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
    return rows
      .flatMap((row) => row)
      .filter(Boolean)
      .map(String)
      .filter((v) => !isHeaderValue(v));
  }
}

// GET /batches — list all batches for the authenticated tenant
router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.user.tenantId;

  try {
    const batches = await prisma.crawlBatch.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(batches);
  } catch (err) {
    console.error('[batches/list]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /api/batches/upload:
 *   post:
 *     summary: Upload a CSV/Excel file of company domains
 *     tags: [Batches]
 *     parameters:
 *       - in: query
 *         name: force_recrawl
 *         schema:
 *           type: boolean
 *         description: Force re-crawl even if company was crawled within 30 days
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: CSV or Excel file with domain names
 *     responses:
 *       201:
 *         description: Batch created and jobs enqueued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 batchId: { type: string }
 *                 totalCompanies: { type: integer }
 *                 jobsEnqueued: { type: integer }
 *                 skipped: { type: integer }
 *       400:
 *         description: Bad request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Weekly quota exceeded
 */
// POST /batches/upload
router.post(
  '/upload',
  requireAuth,
  requireVerified,
  uploadSingle,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.user.tenantId;
    const forceRecrawl = req.query.force_recrawl === 'true';

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // Multer decodes multipart filenames as Latin-1; modern browsers send UTF-8.
    // Re-encode to recover the correct Unicode filename (Cyrillic, etc.).
    const originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

    const ext = path.extname(originalname).toLowerCase();
    if (!['.csv', '.xlsx', '.xls'].includes(ext)) {
      res.status(400).json({ error: 'Only CSV and Excel files are supported' });
      return;
    }

    try {
      // Parse raw domains from file
      const rawValues = parseFile(req.file.path, ext);
      const normalized = rawValues.map(normalizeDomain).filter(Boolean);
      const domains = [...new Set(normalized.filter(isValidDomain))];
      const invalidRows = normalized.length - domains.length;

      if (domains.length === 0) {
        res.status(400).json({
          error: 'No valid domains found in file. Each row must contain a domain (e.g. example.com), not a company name.',
          invalidRows,
        });
        return;
      }

      // Resolve templateId: explicit → default for tenant → null
      const requestedTemplateId = req.body?.templateId as string | undefined;
      let resolvedTemplateId: string | null = null;
      if (requestedTemplateId) {
        const tmpl = await prisma.emailTemplate.findFirst({
          where: { id: requestedTemplateId, tenantId },
          select: { id: true },
        });
        resolvedTemplateId = tmpl?.id ?? null;
      } else {
        const defaultTmpl = await prisma.emailTemplate.findFirst({
          where: { tenantId, isDefault: true },
          select: { id: true },
        });
        resolvedTemplateId = defaultTmpl?.id ?? null;
      }

      // Check quota
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

      // Reset weekly usage if needed
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (tenant.usageResetAt < oneWeekAgo) {
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { weeklyUsage: 0, usageResetAt: new Date() },
        });
        tenant.weeklyUsage = 0;
      }

      if (tenant.weeklyUsage + domains.length > tenant.weeklyQuota) {
        res.status(429).json({
          error: 'Weekly quota exceeded',
          quota: tenant.weeklyQuota,
          used: tenant.weeklyUsage,
          requested: domains.length,
        });
        return;
      }

      // Monthly domain limit check — skipped for ADMIN users and users with no limit set
      const userId = req.user.sub;
      const userRecord = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, monthlyDomainLimit: true },
      });
      const month = new Date().toISOString().slice(0, 7);
      if (userRecord && userRecord.role !== 'ADMIN' && userRecord.monthlyDomainLimit !== null) {
        const usage = await prisma.userMonthlyUsage.findUnique({
          where: { userId_month: { userId, month } },
          select: { domainsUsed: true },
        });
        const used = usage?.domainsUsed ?? 0;
        if (used + domains.length > userRecord.monthlyDomainLimit) {
          res.status(403).json({
            error: 'Monthly domain limit exceeded',
            limit: userRecord.monthlyDomainLimit,
            used,
            requested: domains.length,
            remaining: Math.max(0, userRecord.monthlyDomainLimit - used),
          });
          return;
        }
      }

      // Save uploaded file
      const storedPath = StorageService.upload(
        `uploads/${tenantId}`,
        `${Date.now()}-${sanitizeFilename(originalname)}`,
        req.file.path
      );

      // Create batch
      const batch = await prisma.crawlBatch.create({
        data: {
          tenantId,
          filePath: storedPath,
          fileName: originalname,
          status: 'PROCESSING',
          totalCompanies: domains.length,
          ...(resolvedTemplateId ? { templateId: resolvedTemplateId } : {}),
        },
      });

      const queue = await getQueue();

      // Process all domains in parallel — avoids N×3 sequential DB roundtrips.
      const jobResults = await Promise.all(domains.map(async (domain) => {
        const baseUrl = buildBaseUrl(domain);

        const company = await prisma.company.upsert({
          where: { domain },
          create: { domain, baseUrl },
          update: {},
          include: { profile: true },
        });

        await prisma.tenantCompany.createMany({
          data: [{ tenantId, companyId: company.id, sourceBatchId: batch.id }],
          skipDuplicates: true,
        });

        if (isNonCrawlablePlatform(domain)) {
          console.log(`[enqueue] skipped ${domain} reason=non_crawlable_platform`);
          return false;
        }

        const freshness = checkFreshness(company, forceRecrawl);

        if (freshness.skip) {
          console.log(`[upload] skipped fresh company ${domain} — ${freshness.reason}`);
          return false;
        }

        console.log(`[upload] recrawling ${domain} — ${freshness.reason}`);
        await enqueueCrawlJob(
          { companyId: company.id, domain, baseUrl, batchId: batch.id, tenantId, templateId: resolvedTemplateId ?? undefined },
          queue,
        );
        return true;
      }));

      const jobsEnqueued = jobResults.filter(Boolean).length;

      // Update batch completion percentage
      const processed = domains.length - jobsEnqueued;
      await prisma.crawlBatch.update({
        where: { id: batch.id },
        data: {
          processedCompanies: processed,
          completionPercentage: (processed / domains.length) * 100,
          status: jobsEnqueued === 0 ? 'COMPLETED' : 'PROCESSING',
        },
      });

      // Increment tenant usage — charge full domains.length, not just enqueued jobs,
      // since cached-domain skips still count against the quota check above.
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { weeklyUsage: { increment: domains.length } },
      });

      // Increment per-user monthly usage
      await prisma.userMonthlyUsage.upsert({
        where: { userId_month: { userId: req.user.sub, month } },
        create: { userId: req.user.sub, month, domainsUsed: domains.length },
        update: { domainsUsed: { increment: domains.length } },
      });

      res.status(201).json({
        batchId: batch.id,
        totalCompanies: domains.length,
        jobsEnqueued,
        skipped: domains.length - jobsEnqueued,
        invalidRows,
      });
    } catch (err) {
      console.error('[batches/upload]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * @openapi
 * /api/batches/{id}:
 *   get:
 *     summary: Get batch status and progress
 *     tags: [Batches]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Batch details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Batch'
 *       404:
 *         description: Batch not found
 */
// GET /batches/:id
router.get('/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const tenantId = req.user.tenantId;

  try {
    const batch = await prisma.crawlBatch.findFirst({
      where: { id, tenantId },
    });

    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    // Recalculate completion percentage from DB
    const processed = batch.processedCompanies;
    const total = batch.totalCompanies;
    const percentage = total > 0 ? (processed / total) * 100 : 0;

    res.json({ ...batch, completionPercentage: percentage });
  } catch (err) {
    console.error('[batches/:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /api/batches/{id}/companies:
 *   get:
 *     summary: List companies in a batch (paginated)
 *     tags: [Batches]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Paginated list of companies with profiles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Company'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     pages: { type: integer }
 */
// GET /batches/:id/companies
router.get('/:id/companies', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const tenantId = req.user.tenantId;
  const page = parseInt(String(req.query.page || '1'), 10);
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 200);
  const skip = (page - 1) * limit;

  try {
    const batch = await prisma.crawlBatch.findFirst({ where: { id, tenantId } });
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    const [total, companies] = await Promise.all([
      prisma.company.count({
        where: {
          tenantCompanies: { some: { tenantId, sourceBatchId: id, excluded: false } },
        },
      }),
      prisma.company.findMany({
        where: {
          tenantCompanies: { some: { tenantId, sourceBatchId: id, excluded: false } },
        },
        include: { profile: true, personalizedContent: true },
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    res.json({
      data: companies.map(({ personalizedContent, ...rest }) => ({
        ...rest,
        personalizedContents: personalizedContent ? [personalizedContent] : [],
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[batches/:id/companies]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /api/batches/{id}/download:
 *   get:
 *     summary: Download batch export as CSV or XLSX
 *     tags: [Batches]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [csv, xlsx]
 *           default: csv
 *     responses:
 *       200:
 *         description: File download
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 *           application/vnd.openxmlformats-officedocument.spreadsheetml.sheet:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Batch not found
 */
// GET /batches/:id/download
router.get('/:id/download', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const tenantId = req.user.tenantId;
  const format = (req.query.format as string) || 'csv';

  try {
    const batch = await prisma.crawlBatch.findFirst({ where: { id, tenantId } });
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    // Generate export on-the-fly or use cached
    const exportPath = await ExportService.exportBatch(id, tenantId, format as 'csv' | 'xlsx');

    const mime = format === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv';
    const fileName = `batch-${id}.${format}`;

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(StorageService.read(exportPath));
  } catch (err) {
    console.error('[batches/:id/download]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /batches/:id/candidates — all discovery candidates with statuses
router.get('/:id/candidates', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const tenantId = req.user.tenantId;

  try {
    const batch = await prisma.crawlBatch.findFirst({ where: { id, tenantId } });
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    const candidates = await prisma.discoveryCandidate.findMany({
      where: { batchId: id },
      orderBy: { createdAt: 'asc' },
    });

    res.json(candidates);
  } catch (err) {
    console.error('[batches/:id/candidates]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /batches/:id/candidates/:domain — promote/exclude a candidate
router.patch('/:id/candidates/:domain', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const batchId = String(req.params.id);
  const domain = String(req.params.domain);
  const tenantId = req.user.tenantId;
  const { action } = req.body as { action: 'exclude' | 'include' };

  if (!['exclude', 'include'].includes(action)) {
    res.status(400).json({ error: 'action must be "exclude" or "include"' });
    return;
  }

  try {
    const batch = await prisma.crawlBatch.findFirst({ where: { id: batchId, tenantId } });
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    const candidate = await prisma.discoveryCandidate.findUnique({
      where: { batchId_domain: { batchId, domain } },
    });
    if (!candidate) {
      res.status(404).json({ error: 'Candidate not found' });
      return;
    }

    if (action === 'exclude') {
      // KEPT → EXCLUDED: mark candidate + mark tenantCompany as excluded
      await prisma.discoveryCandidate.update({
        where: { batchId_domain: { batchId, domain } },
        data: { status: 'EXCLUDED' },
      });
      await prisma.tenantCompany.updateMany({
        where: {
          tenantId,
          sourceBatchId: batchId,
          company: { domain },
        },
        data: { excluded: true },
      });
      await prisma.crawlBatch.update({
        where: { id: batchId },
        data: { totalCompanies: { decrement: 1 } },
      });
      res.json({ ok: true });
    } else {
      // include: two cases
      if (candidate.status === 'EXCLUDED') {
        // Re-include a previously excluded KEPT company
        await prisma.discoveryCandidate.update({
          where: { batchId_domain: { batchId, domain } },
          data: { status: 'KEPT' },
        });
        await prisma.tenantCompany.updateMany({
          where: { tenantId, sourceBatchId: batchId, company: { domain } },
          data: { excluded: false },
        });
        await prisma.crawlBatch.update({
          where: { id: batchId },
          data: { totalCompanies: { increment: 1 } },
        });
        res.json({ ok: true });
      } else {
        // FILTERED or BLOCKED → KEPT: upsert company + tenantCompany, enqueue crawl
        const baseUrl = `https://${domain}`;
        const company = await prisma.company.upsert({
          where: { domain },
          create: { domain, baseUrl, name: candidate.title ?? undefined },
          update: {},
        });
        await prisma.tenantCompany.createMany({
          data: [{ tenantId, companyId: company.id, sourceBatchId: batchId }],
          skipDuplicates: true,
        });
        await prisma.discoveryCandidate.update({
          where: { batchId_domain: { batchId, domain } },
          data: { status: 'KEPT' },
        });
        await prisma.crawlBatch.update({
          where: { id: batchId },
          data: { totalCompanies: { increment: 1 } },
        });
        if (isNonCrawlablePlatform(domain)) {
          console.log(`[enqueue] skipped ${domain} reason=non_crawlable_platform`);
          res.json({ ok: true, crawlTriggered: false, reason: 'non_crawlable_platform' });
          return;
        }

        const queue = await getQueue();
        await enqueueCrawlJob(
          { companyId: company.id, domain, baseUrl, batchId, tenantId },
          queue,
        );
        res.json({ ok: true, crawlTriggered: true });
      }
    }
  } catch (err) {
    console.error('[batches/:id/candidates/:domain]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /api/batches/{id}/re-enrich:
 *   post:
 *     summary: Re-crawl, re-extract, and re-personalize all companies in a batch
 *     description: Resets batch progress and enqueues crawl jobs for every company in the batch, bypassing the 30-day deduplication cache. The worker automatically generates PersonalizedContent after each successful crawl.
 *     tags: [Batches]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Re-enrichment started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 batchId: { type: string }
 *                 reEnqueuedCompanies: { type: integer }
 *                 status: { type: string }
 *       404:
 *         description: Batch not found
 */
// POST /batches/:id/re-enrich
router.post('/:id/re-enrich', requireAuth, requireVerified, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const tenantId = req.user.tenantId;

  try {
    const batch = await prisma.crawlBatch.findFirst({ where: { id, tenantId } });
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    const companies = await prisma.company.findMany({
      where: {
        tenantCompanies: { some: { tenantId, sourceBatchId: id, excluded: false } },
      },
      select: { id: true, domain: true, baseUrl: true },
    });

    if (companies.length === 0) {
      res.json({ batchId: id, reEnqueuedCompanies: 0, status: batch.status });
      return;
    }

    // Reset batch progress — all companies will be re-crawled
    await prisma.crawlBatch.update({
      where: { id },
      data: {
        processedCompanies:   0,
        completionPercentage: 0,
        totalCompanies:       companies.length,
        status:               'PROCESSING',
      },
    });

    // Enqueue crawl jobs directly — bypasses the 30-day deduplication check
    // that lives only in the upload route, not in the worker
    const queue = await getQueue();
    for (const company of companies) {
      if (isNonCrawlablePlatform(company.domain)) {
        console.log(`[enqueue] skipped ${company.domain} reason=non_crawlable_platform`);
        continue;
      }
      await enqueueCrawlJob(
        { companyId: company.id, domain: company.domain, baseUrl: company.baseUrl, batchId: id, tenantId, templateId: batch.templateId ?? undefined },
        queue,
      );
    }

    res.json({ batchId: id, reEnqueuedCompanies: companies.length, status: 'PROCESSING' });
  } catch (err) {
    console.error('[batches/:id/re-enrich]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /batches/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const tenantId = req.user.tenantId;

  try {
    const batch = await prisma.crawlBatch.findFirst({ where: { id, tenantId } });
    if (!batch) {
      res.status(404).json({ error: 'Batch not found' });
      return;
    }

    // Unlink tenant-company associations for this batch, then delete the batch
    await prisma.$transaction([
      prisma.tenantCompany.deleteMany({ where: { sourceBatchId: id } }),
      prisma.crawlBatch.delete({ where: { id } }),
    ]);

    res.status(204).send();
  } catch (err) {
    console.error('[batches/delete]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
