import { findCachedDiscovery, copyCandidatesToBatch } from '../discoveryCache';

// ---------------------------------------------------------------------------
// Mock prisma
// ---------------------------------------------------------------------------

const mockFindFirst  = jest.fn();
const mockFindMany   = jest.fn();
const mockCreateMany = jest.fn();

jest.mock('../../../lib/prisma', () => ({
  prisma: {
    crawlBatch: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
    discoveryCandidate: {
      findMany:   (...args: unknown[]) => mockFindMany(...args),
      createMany: (...args: unknown[]) => mockCreateMany(...args),
    },
  },
}));

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// findCachedDiscovery
// ---------------------------------------------------------------------------

describe('findCachedDiscovery', () => {
  const KEY     = 'детски градини|враца|';
  const CURRENT = 'batch-current';
  const CACHED  = { id: 'batch-old' };

  test('returns cached batch when one exists', async () => {
    mockFindFirst.mockResolvedValue(CACHED);
    const result = await findCachedDiscovery(CURRENT, KEY);
    expect(result).toEqual(CACHED);
  });

  test('passes correct where clause to prisma', async () => {
    mockFindFirst.mockResolvedValue(null);
    await findCachedDiscovery(CURRENT, KEY);

    const call = mockFindFirst.mock.calls[0][0];
    expect(call.where.id).toEqual({ not: CURRENT });
    expect(call.where.discoveryKey).toBe(KEY);
    expect(call.where.status).toBe('COMPLETED');
    expect(call.where.discoveryCandidates).toEqual({ some: {}, none: { decidedAt: null } });
    expect(call.where.updatedAt.gte).toBeInstanceOf(Date);
  });

  // A batch written before the decision record has no reason and no criteria on
  // any row. Serving it as cache copies that emptiness forward into every repeat
  // of the search for the whole 30-day TTL — which is how three consecutive
  // persona searches came back blank long after the pipeline itself was fixed.
  test('requires every cached candidate to carry a decision record', async () => {
    mockFindFirst.mockResolvedValue(null);
    await findCachedDiscovery(CURRENT, KEY);

    const { discoveryCandidates } = mockFindFirst.mock.calls[0][0].where;
    // `some: {}` alone would match a batch full of undecided rows.
    expect(discoveryCandidates.some).toEqual({});
    expect(discoveryCandidates.none).toEqual({ decidedAt: null });
  });

  test('the guard is on decidedAt, not on the filter version', async () => {
    // Bumping FILTER_VERSION cannot protect against this: the key is computed by
    // the API while the rows are written by the worker, so a stale worker poisons
    // the current version's key. Keying the guard on the data keeps working, and
    // does not discard batches that were produced correctly.
    mockFindFirst.mockResolvedValue(null);
    await findCachedDiscovery(CURRENT, KEY);

    const { where } = mockFindFirst.mock.calls[0][0];
    expect(where.discoveryKey).toBe(KEY);
    expect(where.discoveryCandidates.none).toEqual({ decidedAt: null });
  });

  test('returns null on cache miss', async () => {
    mockFindFirst.mockResolvedValue(null);
    expect(await findCachedDiscovery(CURRENT, KEY)).toBeNull();
  });

  test('cutoff is approximately 30 days ago', async () => {
    mockFindFirst.mockResolvedValue(null);
    await findCachedDiscovery(CURRENT, KEY);

    const { gte } = mockFindFirst.mock.calls[0][0].where.updatedAt;
    const diffDays = (Date.now() - gte.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(30, 0);
  });
});

// ---------------------------------------------------------------------------
// copyCandidatesToBatch
// ---------------------------------------------------------------------------

const SAMPLE_CANDIDATES = [
  {
    id:              'c1',
    batchId:         'batch-old',
    createdAt:       new Date('2026-06-01'),
    domain:          'dg-zvanche.bg',
    url:             'https://dg-zvanche.bg',
    title:           'ДГ Звънче',
    snippet:         null,
    status:          'KEPT' as const,
    pageType:        'TARGET_ORGANIZATION',
    extractedFrom:   null,
    discoverySource: 'search',
    confidence:      80,
    orgName:         'ДГ Звънче',
    extractedEmail:  null,
    extractedPhone:  null,
    extractedAddress: null,
    rejectedReason:  null,
  },
  {
    id:              'c2',
    batchId:         'batch-old',
    createdAt:       new Date('2026-06-01'),
    domain:          'dg-prolet.bg',
    url:             'https://dg-prolet.bg',
    title:           'ДГ Пролет',
    snippet:         null,
    status:          'KEPT' as const,
    pageType:        'TARGET_ORGANIZATION',
    extractedFrom:   null,
    discoverySource: 'search',
    confidence:      75,
    orgName:         null,
    extractedEmail:  'info@dg-prolet.bg',
    extractedPhone:  null,
    extractedAddress: null,
    rejectedReason:  null,
  },
];

describe('copyCandidatesToBatch', () => {
  test('returns count of inserted rows', async () => {
    mockFindMany.mockResolvedValue(SAMPLE_CANDIDATES);
    mockCreateMany.mockResolvedValue({ count: 2 });

    const count = await copyCandidatesToBatch('batch-old', 'batch-new');
    expect(count).toBe(2);
  });

  test('replaces batchId with target batchId', async () => {
    mockFindMany.mockResolvedValue(SAMPLE_CANDIDATES);
    mockCreateMany.mockResolvedValue({ count: 2 });

    await copyCandidatesToBatch('batch-old', 'batch-new');

    const { data } = mockCreateMany.mock.calls[0][0];
    expect(data.every((r: { batchId: string }) => r.batchId === 'batch-new')).toBe(true);
  });

  test('strips id and createdAt from rows', async () => {
    mockFindMany.mockResolvedValue(SAMPLE_CANDIDATES);
    mockCreateMany.mockResolvedValue({ count: 2 });

    await copyCandidatesToBatch('batch-old', 'batch-new');

    const { data } = mockCreateMany.mock.calls[0][0];
    for (const row of data) {
      expect(row).not.toHaveProperty('id');
      expect(row).not.toHaveProperty('createdAt');
    }
  });

  test('preserves all other fields', async () => {
    mockFindMany.mockResolvedValue(SAMPLE_CANDIDATES);
    mockCreateMany.mockResolvedValue({ count: 2 });

    await copyCandidatesToBatch('batch-old', 'batch-new');

    const { data } = mockCreateMany.mock.calls[0][0];
    expect(data[0]).toMatchObject({
      domain:          'dg-zvanche.bg',
      url:             'https://dg-zvanche.bg',
      title:           'ДГ Звънче',
      status:          'KEPT',
      pageType:        'TARGET_ORGANIZATION',
      confidence:      80,
      orgName:         'ДГ Звънче',
    });
  });

  test('uses skipDuplicates: true', async () => {
    mockFindMany.mockResolvedValue(SAMPLE_CANDIDATES);
    mockCreateMany.mockResolvedValue({ count: 2 });

    await copyCandidatesToBatch('batch-old', 'batch-new');

    expect(mockCreateMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  test('returns 0 and skips createMany when source has no candidates', async () => {
    mockFindMany.mockResolvedValue([]);

    const count = await copyCandidatesToBatch('batch-old', 'batch-new');

    expect(count).toBe(0);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });
});
