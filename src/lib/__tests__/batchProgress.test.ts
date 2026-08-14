import {
  computeProgress,
  getBatchCounts,
  getBatchCountsMany,
  refreshBatchProgress,
  TERMINAL_CRAWL_STATUSES,
} from '../batchProgress';

// ---------------------------------------------------------------------------
// Mock prisma
// ---------------------------------------------------------------------------

const mockCount        = jest.fn();
const mockGroupBy      = jest.fn();
const mockBatchFindOne = jest.fn();
const mockBatchUpdate  = jest.fn();

jest.mock('../prisma', () => ({
  prisma: {
    tenantCompany: {
      count:   (...args: unknown[]) => mockCount(...args),
      groupBy: (...args: unknown[]) => mockGroupBy(...args),
    },
    crawlBatch: {
      findUnique: (...args: unknown[]) => mockBatchFindOne(...args),
      update:     (...args: unknown[]) => mockBatchUpdate(...args),
    },
  },
}));

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// computeProgress — pure
// ---------------------------------------------------------------------------

describe('computeProgress', () => {
  test('reports partial progress on a live batch', () => {
    expect(computeProgress('PROCESSING', { total: 10, done: 3 })).toEqual({
      totalCompanies: 10,
      processedCompanies: 3,
      completionPercentage: 30,
      status: 'PROCESSING',
    });
  });

  test('flips to COMPLETED when every company reached a terminal crawl status', () => {
    expect(computeProgress('PROCESSING', { total: 10, done: 10 })).toEqual({
      totalCompanies: 10,
      processedCompanies: 10,
      completionPercentage: 100,
      status: 'COMPLETED',
    });
  });

  // The two total===0 cases must diverge — this is the only thing separating a persona batch
  // whose discovery has not seeded any rows yet from a batch that had nothing crawlable.
  test('a live batch with nothing seeded yet is 0%, not 100%', () => {
    expect(computeProgress('PROCESSING', { total: 0, done: 0 })).toEqual({
      totalCompanies: 0,
      processedCompanies: 0,
      completionPercentage: 0,
      status: 'PROCESSING',
    });
  });

  test('a COMPLETED batch with no rows (nothing crawlable) is 100%', () => {
    expect(computeProgress('COMPLETED', { total: 0, done: 0 })).toEqual({
      totalCompanies: 0,
      processedCompanies: 0,
      completionPercentage: 100,
      status: 'COMPLETED',
    });
  });

  // Company.crawlStatus is global, so re-enriching another batch can reset a shared company.
  // A finished batch must not slide backwards because of it.
  test('a COMPLETED batch is frozen even when live counts have regressed', () => {
    expect(computeProgress('COMPLETED', { total: 10, done: 4 })).toEqual({
      totalCompanies: 10,
      processedCompanies: 10,
      completionPercentage: 100,
      status: 'COMPLETED',
    });
  });

  test('a FAILED batch keeps its status and reports real counts', () => {
    expect(computeProgress('FAILED', { total: 5, done: 2 })).toEqual({
      totalCompanies: 5,
      processedCompanies: 2,
      completionPercentage: 40,
      status: 'FAILED',
    });
  });

  test('PENDING batches are treated as live', () => {
    expect(computeProgress('PENDING', { total: 4, done: 1 })).toMatchObject({
      completionPercentage: 25,
      status: 'PROCESSING',
    });
  });

  test('negative counts clamp to zero', () => {
    expect(computeProgress('PROCESSING', { total: -1, done: -5 })).toEqual({
      totalCompanies: 0,
      processedCompanies: 0,
      completionPercentage: 0,
      status: 'PROCESSING',
    });
  });

  // Regression table taken verbatim from the production rows that triggered this fix.
  describe('production rows that used to exceed 100%', () => {
    test.each([
      ['171.4% row', { total: 14, done: 24 }],
      ['110% row',   { total: 10, done: 11 }],
      ['120% row',   { total: 5,  done: 6  }],
    ])('%s caps at 100', (_label, counts) => {
      const result = computeProgress('PROCESSING', counts);
      expect(result.completionPercentage).toBe(100);
      expect(result.processedCompanies).toBe(counts.total);
    });
  });
});

// ---------------------------------------------------------------------------
// getBatchCounts
// ---------------------------------------------------------------------------

describe('getBatchCounts', () => {
  test('counts non-excluded rows and terminal-status rows separately', async () => {
    mockCount.mockResolvedValueOnce(10).mockResolvedValueOnce(7);

    expect(await getBatchCounts('t1', 'b1')).toEqual({ total: 10, done: 7 });
    expect(mockCount).toHaveBeenCalledTimes(2);

    expect(mockCount.mock.calls[0][0]).toEqual({
      where: { tenantId: 't1', sourceBatchId: 'b1', excluded: false },
    });
    expect(mockCount.mock.calls[1][0]).toEqual({
      where: {
        tenantId: 't1',
        sourceBatchId: 'b1',
        excluded: false,
        company: { crawlStatus: { in: TERMINAL_CRAWL_STATUSES } },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// getBatchCountsMany
// ---------------------------------------------------------------------------

describe('getBatchCountsMany', () => {
  test('resolves counts for every batch in exactly two queries', async () => {
    mockGroupBy
      .mockResolvedValueOnce([
        { sourceBatchId: 'b1', _count: { _all: 10 } },
        { sourceBatchId: 'b2', _count: { _all: 4  } },
      ])
      .mockResolvedValueOnce([
        { sourceBatchId: 'b1', _count: { _all: 10 } },
        { sourceBatchId: 'b2', _count: { _all: 1  } },
      ]);

    const counts = await getBatchCountsMany('t1', ['b1', 'b2']);

    expect(mockGroupBy).toHaveBeenCalledTimes(2);
    expect(counts.get('b1')).toEqual({ total: 10, done: 10 });
    expect(counts.get('b2')).toEqual({ total: 4,  done: 1  });
  });

  test('a batch with no rows still maps to zeroes rather than being absent', async () => {
    mockGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const counts = await getBatchCountsMany('t1', ['empty']);

    expect(counts.get('empty')).toEqual({ total: 0, done: 0 });
  });

  test('scopes both queries by tenant and excludes excluded rows', async () => {
    mockGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await getBatchCountsMany('t1', ['b1', 'b2']);

    const [totalsArgs, donesArgs] = mockGroupBy.mock.calls.map((c) => c[0]);
    const expectedBase = { tenantId: 't1', sourceBatchId: { in: ['b1', 'b2'] }, excluded: false };

    expect(totalsArgs.where).toEqual(expectedBase);
    expect(donesArgs.where).toEqual({
      ...expectedBase,
      company: { crawlStatus: { in: TERMINAL_CRAWL_STATUSES } },
    });
  });

  test('makes no query at all for an empty id list', async () => {
    expect((await getBatchCountsMany('t1', [])).size).toBe(0);
    expect(mockGroupBy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// refreshBatchProgress
// ---------------------------------------------------------------------------

describe('refreshBatchProgress', () => {
  test('writes absolute values, never an increment', async () => {
    mockBatchFindOne.mockResolvedValue({ status: 'PROCESSING' });
    mockCount.mockResolvedValueOnce(10).mockResolvedValueOnce(4);
    mockBatchUpdate.mockResolvedValue({});

    await refreshBatchProgress('b1', 't1');

    expect(mockBatchUpdate).toHaveBeenCalledTimes(1);
    const { data } = mockBatchUpdate.mock.calls[0][0];
    expect(data).toEqual({
      totalCompanies: 10,
      processedCompanies: 4,
      completionPercentage: 40,
      status: 'PROCESSING',
    });
    // The bug being fixed: no relative mutation may ever reach the counters again.
    expect(JSON.stringify(data)).not.toMatch(/increment|decrement/);
  });

  test.each(['COMPLETED', 'FAILED'])('does not touch a %s batch', async (status) => {
    mockBatchFindOne.mockResolvedValue({ status });

    expect(await refreshBatchProgress('b1', 't1')).toBeNull();
    expect(mockBatchUpdate).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
  });

  test('returns null without throwing when the batch no longer exists', async () => {
    mockBatchFindOne.mockResolvedValue(null);

    expect(await refreshBatchProgress('gone', 't1')).toBeNull();
    expect(mockBatchUpdate).not.toHaveBeenCalled();
  });

  test('swallows P2025 when the batch is deleted mid-refresh', async () => {
    mockBatchFindOne.mockResolvedValue({ status: 'PROCESSING' });
    mockCount.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    mockBatchUpdate.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));

    expect(await refreshBatchProgress('b1', 't1')).toBeNull();
  });

  test('rethrows unexpected database errors', async () => {
    mockBatchFindOne.mockResolvedValue({ status: 'PROCESSING' });
    mockCount.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    mockBatchUpdate.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P1001' }));

    await expect(refreshBatchProgress('b1', 't1')).rejects.toThrow('boom');
  });
});
