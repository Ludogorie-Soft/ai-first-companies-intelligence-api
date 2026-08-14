import { prisma } from './prisma';
import type { BatchStatus, CrawlStatus } from '@prisma/client';

/**
 * Batch progress is DERIVED, never accumulated.
 *
 * The three CrawlBatch columns (totalCompanies, processedCompanies, completionPercentage)
 * are a write-through cache of absolute derived values. They are never incremented and
 * never trusted on read. The truth is:
 *
 *   denominator — TenantCompany rows with sourceBatchId = batch.id AND excluded = false
 *   numerator   — of those, the ones whose Company.crawlStatus is terminal
 *
 * This replaces the old `processedCompanies: { increment: 1 }` counter, which drifted past
 * totalCompanies (observed 110% and 171.4% in production) because it had no per-job
 * idempotency while totalCompanies was mutated independently by candidate exclusion.
 *
 * READ-PATH RULE: endpoints must spread only the three numeric fields onto the response and
 * must NOT overwrite the persisted `status` with the computed one. A transient read landing
 * mid-seed would otherwise latch a COMPLETED badge in the frontend, which never unsets.
 */

/** A crawl that will not advance further on its own. */
export const TERMINAL_CRAWL_STATUSES: CrawlStatus[] = ['COMPLETED', 'FAILED', 'BLOCKED'];

/** A batch whose progress is frozen and must never be recomputed. */
export const TERMINAL_BATCH_STATUSES: BatchStatus[] = ['COMPLETED', 'FAILED'];

export interface BatchCounts {
  total: number;
  done: number;
}

export interface BatchProgress {
  totalCompanies: number;
  processedCompanies: number;
  completionPercentage: number;
  status: BatchStatus;
}

/**
 * Pure — no DB access. The single home for the clamping and total===0 rules.
 */
export function computeProgress(storedStatus: BatchStatus, counts: BatchCounts): BatchProgress {
  const total = Math.max(0, counts.total);
  // Clamped, so a percentage above 100 cannot be expressed at all.
  const done = Math.min(Math.max(0, counts.done), total);

  // Terminal batches are FROZEN. Company.crawlStatus is global (schema.prisma:89), so
  // re-enriching batch B must never drag finished batch A backwards. This also covers the
  // legitimate "nothing crawlable" case, which worker/index.ts writes as COMPLETED with
  // totalCompanies 0 at the source.
  if (storedStatus === 'COMPLETED') {
    return {
      totalCompanies: total,
      processedCompanies: total,
      completionPercentage: 100,
      status: 'COMPLETED',
    };
  }
  if (storedStatus === 'FAILED') {
    return {
      totalCompanies: total,
      processedCompanies: done,
      completionPercentage: total > 0 ? (done / total) * 100 : 0,
      status: 'FAILED',
    };
  }

  // total===0 on a live batch means "nothing seeded yet" — persona batches are created with
  // zero rows while discovery runs async. Must read 0%, not 100%.
  if (total === 0) {
    return {
      totalCompanies: 0,
      processedCompanies: 0,
      completionPercentage: 0,
      status: 'PROCESSING',
    };
  }

  return {
    totalCompanies: total,
    processedCompanies: done,
    completionPercentage: (done / total) * 100,
    status: done >= total ? 'COMPLETED' : 'PROCESSING',
  };
}

/** Counts for one batch. Two indexed COUNTs — TenantCompany has @@index([sourceBatchId]). */
export async function getBatchCounts(tenantId: string, batchId: string): Promise<BatchCounts> {
  const where = { tenantId, sourceBatchId: batchId, excluded: false };

  const [total, done] = await Promise.all([
    prisma.tenantCompany.count({ where }),
    prisma.tenantCompany.count({
      where: { ...where, company: { crawlStatus: { in: TERMINAL_CRAWL_STATUSES } } },
    }),
  ]);

  return { total, done };
}

/**
 * Counts for many batches in exactly two queries, regardless of how many batches — the list
 * endpoint returns up to 100 and must not become N+1.
 */
export async function getBatchCountsMany(
  tenantId: string,
  batchIds: string[],
): Promise<Map<string, BatchCounts>> {
  const out = new Map<string, BatchCounts>();
  if (batchIds.length === 0) return out;

  const base = { tenantId, sourceBatchId: { in: batchIds }, excluded: false };

  const [totals, dones] = await Promise.all([
    prisma.tenantCompany.groupBy({
      by: ['sourceBatchId'],
      where: base,
      _count: { _all: true },
    }),
    prisma.tenantCompany.groupBy({
      by: ['sourceBatchId'],
      where: { ...base, company: { crawlStatus: { in: TERMINAL_CRAWL_STATUSES } } },
      _count: { _all: true },
    }),
  ]);

  // Seed every requested id so a batch with no rows yet still maps to { total: 0, done: 0 }.
  for (const id of batchIds) out.set(id, { total: 0, done: 0 });
  for (const row of totals) {
    const entry = out.get(row.sourceBatchId);
    if (entry) entry.total = row._count._all;
  }
  for (const row of dones) {
    const entry = out.get(row.sourceBatchId);
    if (entry) entry.done = row._count._all;
  }

  return out;
}

/**
 * WRITE path. Recomputes from live data and persists all four fields as absolute values.
 * Idempotent, so any number of concurrent workers may call it. No-ops on terminal batches
 * (freeze) and on batches deleted mid-crawl — a missing batch must never fail a crawl job.
 */
export async function refreshBatchProgress(
  batchId: string,
  tenantId: string,
): Promise<BatchProgress | null> {
  const batch = await prisma.crawlBatch.findUnique({
    where: { id: batchId },
    select: { status: true },
  });

  if (!batch) {
    console.warn(`[batch-progress] batch ${batchId} not found; skipping progress update`);
    return null;
  }
  if (TERMINAL_BATCH_STATUSES.includes(batch.status)) return null;

  const progress = computeProgress(batch.status, await getBatchCounts(tenantId, batchId));

  try {
    await prisma.crawlBatch.update({
      where: { id: batchId },
      data: {
        totalCompanies: progress.totalCompanies,
        processedCompanies: progress.processedCompanies,
        completionPercentage: progress.completionPercentage,
        status: progress.status,
      },
    });
  } catch (err: unknown) {
    // Batch was deleted between the read and the write.
    if ((err as { code?: string }).code === 'P2025') return null;
    throw err;
  }

  return progress;
}
