import { verifyAfterCrawl } from '../postCrawlVerification';
import { prisma } from '../../lib/prisma';
import { refreshBatchProgress } from '../../lib/batchProgress';

jest.mock('../../lib/prisma', () => ({
  prisma: {
    companyProfile:     { findUnique: jest.fn() },
    discoveryCandidate: { findUnique: jest.fn(), update: jest.fn() },
    tenantCompany:      { updateMany: jest.fn() },
  },
}));

jest.mock('../../lib/batchProgress', () => ({
  refreshBatchProgress: jest.fn(),
}));

const mockPrisma = prisma as unknown as {
  companyProfile:     { findUnique: jest.Mock };
  discoveryCandidate: { findUnique: jest.Mock; update: jest.Mock };
  tenantCompany:      { updateMany: jest.Mock };
};
const mockRefresh = refreshBatchProgress as jest.Mock;

const base = {
  companyId: 'company-1',
  domain:    'dg-slance.bg',
  batchId:   'batch-1',
  tenantId:  'tenant-1',
  persona:   'детски градини',
  location:  'Мездра',
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VERIFY_AFTER_CRAWL;
  mockPrisma.discoveryCandidate.findUnique.mockResolvedValue({ decisionSignals: [] });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('verifyAfterCrawl — when it runs at all', () => {
  test('a CSV-upload crawl carries no location and is skipped', async () => {
    // This is the guarantee that uploaded batches are untouched: their crawl
    // payloads have no persona/location, so there is nothing to verify against.
    const result = await verifyAfterCrawl({ ...base, persona: undefined, location: undefined });

    expect(result).toEqual({ verified: false, skipped: true, why: expect.any(String) });
    expect(mockPrisma.companyProfile.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.tenantCompany.updateMany).not.toHaveBeenCalled();
  });

  test('VERIFY_AFTER_CRAWL=false turns the whole step off', async () => {
    process.env.VERIFY_AFTER_CRAWL = 'false';
    const result = await verifyAfterCrawl(base);

    expect(result).toEqual({ verified: false, skipped: true, why: 'VERIFY_AFTER_CRAWL=false' });
    expect(mockPrisma.companyProfile.findUnique).not.toHaveBeenCalled();
  });

  test('a site with no extracted address is left alone', async () => {
    mockPrisma.companyProfile.findUnique.mockResolvedValue({ location: null });
    const result = await verifyAfterCrawl(base);

    expect(result).toMatchObject({ verified: false, skipped: true });
    expect(mockPrisma.tenantCompany.updateMany).not.toHaveBeenCalled();
  });
});

describe('verifyAfterCrawl — demotion on a real address conflict', () => {
  beforeEach(() => {
    mockPrisma.companyProfile.findUnique.mockResolvedValue({
      location: 'гр. Варна, ул. Дунав 5',
    });
  });

  test('moves the candidate to review with the real address as evidence', async () => {
    const result = await verifyAfterCrawl(base);

    expect(result).toMatchObject({
      verified: true,
      demoted:  true,
      reason:   'LOCATION_CONFLICT_VERIFIED',
    });

    const update = mockPrisma.discoveryCandidate.update.mock.calls[0][0];
    expect(update.where).toEqual({ batchId_domain: { batchId: 'batch-1', domain: 'dg-slance.bg' } });
    expect(update.data.status).toBe('REVIEW');
    expect(update.data.rejectedReason).toBe('LOCATION_CONFLICT_VERIFIED');

    // The evidence quotes the address that was actually found on the site.
    const appended = update.data.decisionSignals.at(-1);
    expect(appended.criterion).toBe('LOCATION_CONFLICT_VERIFIED');
    expect(appended.stage).toBe('post_crawl');
    expect(appended.detail).toContain('Варна');
  });

  test('excludes the company so it leaves the results list', async () => {
    await verifyAfterCrawl(base);

    expect(mockPrisma.tenantCompany.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', sourceBatchId: 'batch-1', company: { domain: 'dg-slance.bg' } },
      data:  { excluded: true },
    });
  });

  test('refreshes batch progress — excluding drops numerator and denominator together', async () => {
    await verifyAfterCrawl(base);
    expect(mockRefresh).toHaveBeenCalledWith('batch-1', 'tenant-1');
  });

  test('preserves the signals gathered before the crawl', async () => {
    mockPrisma.discoveryCandidate.findUnique.mockResolvedValue({
      decisionSignals: [{ criterion: 'MATCHES_PERSONA_AND_LOCATION', effect: 'ACCEPT', stage: 'llm' }],
    });

    await verifyAfterCrawl(base);

    const signals = mockPrisma.discoveryCandidate.update.mock.calls[0][0].data.decisionSignals;
    expect(signals).toHaveLength(2);
    expect(signals[0].stage).toBe('llm');
    expect(signals[1].stage).toBe('post_crawl');
  });
});

describe('verifyAfterCrawl — no demotion', () => {
  test('a matching address confirms the lead and changes nothing', async () => {
    mockPrisma.companyProfile.findUnique.mockResolvedValue({
      location: 'гр. Мездра, ул. Христо Ботев 1',
    });

    const result = await verifyAfterCrawl(base);

    expect(result).toEqual({ verified: true, demoted: false });
    expect(mockPrisma.tenantCompany.updateMany).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();

    // The confirmation is still recorded, so the UI can show it.
    const signals = mockPrisma.discoveryCandidate.update.mock.calls[0][0].data.decisionSignals;
    expect(signals.at(-1).criterion).toBe('MATCHES_PERSONA_AND_LOCATION');
  });

  test('an address naming no recognised settlement is not a conflict', async () => {
    mockPrisma.companyProfile.findUnique.mockResolvedValue({ location: 'ул. Дунав 5' });

    const result = await verifyAfterCrawl(base);

    expect(result).toEqual({ verified: true, demoted: false });
    expect(mockPrisma.tenantCompany.updateMany).not.toHaveBeenCalled();
  });

  test('a street named after another town does not demote the lead', async () => {
    // Addresses are full of street names that collide with town names. Only
    // marker-introduced settlements count.
    mockPrisma.companyProfile.findUnique.mockResolvedValue({
      location: 'гр. Мездра, ул. Плевен 3',
    });

    const result = await verifyAfterCrawl(base);
    expect(result).toEqual({ verified: true, demoted: false });
  });

  test('a company with no candidate row is not annotated', async () => {
    mockPrisma.companyProfile.findUnique.mockResolvedValue({ location: 'гр. Мездра, ул. Дунав 5' });
    mockPrisma.discoveryCandidate.findUnique.mockResolvedValue(null);

    const result = await verifyAfterCrawl(base);

    expect(result).toEqual({ verified: true, demoted: false });
    expect(mockPrisma.discoveryCandidate.update).not.toHaveBeenCalled();
  });
});
