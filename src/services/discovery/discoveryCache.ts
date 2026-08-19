import { prisma } from '../../lib/prisma';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Finds a recent COMPLETED batch with the same discoveryKey.
 * Returns null on cache miss (no match, too old, no candidates, a FAILED batch,
 * or a batch whose candidates predate the decision record).
 */
export async function findCachedDiscovery(
  currentBatchId: string,
  discoveryKey: string,
): Promise<{ id: string } | null> {
  const cutoff = new Date(Date.now() - CACHE_TTL_MS);

  return prisma.crawlBatch.findFirst({
    where: {
      id:           { not: currentBatchId },
      discoveryKey,
      status:       'COMPLETED',
      updatedAt:    { gte: cutoff },
      discoveryCandidates: {
        some: {},                   // has candidates at all
        // ...and every one of them carries a decision record. A batch written by
        // an older build has no reason and no criteria on any row, and copying it
        // forward replays that emptiness into every future repeat of the search
        // for the whole TTL. `decidedAt` is written in the same statement as
        // `decisionSignals`, so it is an exact marker for "produced by this
        // pipeline" — and unlike bumping FILTER_VERSION, this keeps working if a
        // stale build ever runs again, and does not discard the good batches.
        none: { decidedAt: null },
      },
    },
    orderBy: { updatedAt: 'desc' },
    select:  { id: true },
  });
}

/**
 * Copies all DiscoveryCandidates from sourceBatchId to targetBatchId.
 * Preserves all fields. Skips duplicates (same batchId+domain) safely.
 * Returns the number of rows actually inserted.
 */
export async function copyCandidatesToBatch(
  sourceBatchId: string,
  targetBatchId: string,
): Promise<number> {
  const candidates = await prisma.discoveryCandidate.findMany({
    where: { batchId: sourceBatchId },
  });

  if (candidates.length === 0) return 0;

  const rows = candidates.map(
    ({ id: _id, batchId: _b, createdAt: _c, decisionSignals, ...rest }) => ({
      ...rest,
      batchId: targetBatchId,
      // Prisma's Json input type rejects a bare `null` (it wants DbNull/JsonNull),
      // so a candidate with no signals is copied with the field omitted.
      ...(decisionSignals == null
        ? {}
        : { decisionSignals: decisionSignals as unknown as object[] }),
    }),
  );

  const result = await prisma.discoveryCandidate.createMany({
    data: rows,
    skipDuplicates: true,
  });

  return result.count;
}
