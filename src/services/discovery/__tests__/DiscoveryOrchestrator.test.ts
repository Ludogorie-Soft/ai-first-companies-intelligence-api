import { DiscoveryOrchestrator } from '../index';
import type { DiscoverySource, DiscoverySourceResult, PersonaSearchInput } from '../types';

const input: PersonaSearchInput = { persona: 'детски градини', location: 'гр. Мездра' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(
  name: string,
  results: DiscoverySourceResult[],
  canHandle = true,
): DiscoverySource {
  return {
    name,
    canHandle: () => canHandle,
    discover:  jest.fn().mockResolvedValue(results),
  };
}

function makeResult(overrides: Partial<DiscoverySourceResult>): DiscoverySourceResult {
  return {
    sourceUrl:   overrides.domain ? `https://${overrides.domain}` : 'https://example.bg',
    sourceType:  'search',
    confidence:  70,
    pageType:    'TARGET_ORGANIZATION',
    ...overrides,
  };
}

// Stub global fetch to avoid real HTTP calls in unit tests
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
  // Default: fetch returns 404 so no page content is analysed
  mockFetch.mockResolvedValue({ ok: false, text: jest.fn() } as unknown as Response);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscoveryOrchestrator — scenario A: search result is municipality page', () => {
  it('does NOT save municipality as company; extracts kindergartens from its HTML', async () => {
    // Search returns a municipality page
    const municipalityResult = makeResult({
      sourceUrl:  'https://mezdra.bg/detski-gradini',
      domain:     'mezdra.bg',
      title:      'Детски градини | Община Мездра',
      snippet:    'Детски градини в Община Мездра',
      pageType:   'MUNICIPALITY_PAGE', // already classified by Groq
      confidence: 20,
    });

    const source = makeSource('SearchSource', [municipalityResult]);

    // Mock fetch to return an HTML page listing kindergartens
    mockFetch.mockResolvedValueOnce({
      ok:   true,
      text: jest.fn().mockResolvedValue(`
        <html><body>
          <h1>Детски градини в Община Мездра</h1>
          <table>
            <tr><th>Наименование</th><th>Телефон</th><th>Имейл</th></tr>
            <tr><td>ДГ Слънчице</td><td>0893111111</td><td>dg-slanchice@mezdra.bg</td></tr>
            <tr><td>ДГ Надежда</td><td>0893222222</td><td>dg-nadejda@mezdra.bg</td></tr>
          </table>
        </body></html>
      `),
    } as unknown as Response);

    const orchestrator = new DiscoveryOrchestrator([source]);
    const { accepted, rejected, allCandidates } = await orchestrator.discover(input);

    // The municipality page itself must NOT be accepted
    const municipalityInAccepted = accepted.some(c => c.domain === 'mezdra.bg' && !c.extractedFromUrl);
    expect(municipalityInAccepted).toBe(false);

    // The municipality must appear in rejected (as a MUNICIPALITY_PAGE)
    const municipalityInRejected = rejected.some(c => c.domain === 'mezdra.bg');
    expect(municipalityInRejected).toBe(true);

    // Extracted kindergartens should be accepted
    const acceptedNames = accepted.map(c => c.name ?? '');
    expect(acceptedNames.some(n => n.includes('Слънчице'))).toBe(true);
    expect(acceptedNames.some(n => n.includes('Надежда'))).toBe(true);
  });
});

describe('DiscoveryOrchestrator — scenario B: search result is actual kindergarten site', () => {
  it('accepts the site directly without extracting from it', async () => {
    const orgResult = makeResult({
      sourceUrl:  'https://dg-slance.mezdra.bg',
      domain:     'dg-slance.mezdra.bg',
      name:       'ДГ Слънце',
      title:      'ДГ Слънце Мездра',
      pageType:   'UNKNOWN', // not yet classified
      confidence: 70,
    });

    const source = makeSource('SearchSource', [orgResult]);

    // No fetch needed for TARGET_ORGANIZATION (meta-classify is sufficient for UNKNOWN→check)
    // Return a simple single-org page if fetched
    mockFetch.mockResolvedValue({
      ok:   true,
      text: jest.fn().mockResolvedValue(`
        <html><body>
          <h1>ДГ Слънце</h1>
          <div id="contact"><p>Email: info@dg-slance.bg Тел: 0893 123 456</p></div>
        </body></html>
      `),
    } as unknown as Response);

    const orchestrator = new DiscoveryOrchestrator([source]);
    const { accepted } = await orchestrator.discover(input);

    const slance = accepted.find(c => c.domain === 'dg-slance.mezdra.bg');
    expect(slance).toBeDefined();
    // Should NOT have an extractedFromUrl (it's a direct org, not extracted from a list)
    expect(slance?.extractedFromUrl).toBeUndefined();
  });
});

describe('DiscoveryOrchestrator — scenario C: directory page', () => {
  it('rejects the directory itself and extracts individual orgs', async () => {
    const directoryResult = makeResult({
      sourceUrl:  'https://detskigradini.bg/mezdra',
      domain:     'detskigradini.bg',
      title:      'Детски градини Мездра – пълен списък',
      snippet:    'ДГ Слънце ДГ Надежда каталог филтрирай',
      pageType:   'DIRECTORY_OR_PORTAL',
      confidence: 20,
    });

    const source = makeSource('SearchSource', [directoryResult]);

    mockFetch.mockResolvedValueOnce({
      ok:   true,
      text: jest.fn().mockResolvedValue(`
        <html><body>
          <h2>Каталог детски градини</h2>
          <ul>
            <li><strong>ДГ Слънце</strong><p>тел. 0893 111 111</p><a href="https://dg-slance.bg">сайт</a></li>
            <li><strong>ДГ Надежда</strong><p>тел. 0893 222 222, email: dg@nadejda.bg</p></li>
          </ul>
        </body></html>
      `),
    } as unknown as Response);

    const orchestrator = new DiscoveryOrchestrator([source]);
    const { accepted, rejected } = await orchestrator.discover(input);

    // Directory itself rejected
    expect(rejected.some(c => c.domain === 'detskigradini.bg' && !c.extractedFromUrl)).toBe(true);

    // Individual orgs accepted
    expect(accepted.some(c => c.name?.includes('Слънце'))).toBe(true);
    expect(accepted.some(c => c.name?.includes('Надежда'))).toBe(true);
  });
});

describe('DiscoveryOrchestrator — scenario D: news article', () => {
  it('rejects news articles unless they link to an org website', async () => {
    const newsResult = makeResult({
      sourceUrl:  'https://news.bg/novini/nova-detska-gradina',
      domain:     'news.bg',
      title:      'Нова детска градина ще отвори врати',
      snippet:    'Публикувано на 12 юни 2025',
      pageType:   'NEWS_ARTICLE',
      confidence: 20,
    });

    const source = makeSource('SearchSource', [newsResult]);

    const orchestrator = new DiscoveryOrchestrator([source]);
    const { accepted, rejected } = await orchestrator.discover(input);

    expect(accepted.some(c => c.domain === 'news.bg')).toBe(false);
    expect(rejected.some(c => c.domain === 'news.bg')).toBe(true);
  });
});

describe('DiscoveryOrchestrator — scenario E: duplicate candidates', () => {
  it('deduplicates candidates with same name from multiple sources', async () => {
    const source = makeSource('SearchSource', [
      makeResult({ name: 'ДГ Слънце', domain: 'dg-slance.bg',   email: 'a@dg.bg', confidence: 80 }),
      makeResult({ name: 'ЦДГ Слънце', domain: 'cdg-slance.bg', email: 'a@dg.bg', confidence: 60 }),
    ]);

    const orchestrator = new DiscoveryOrchestrator([source]);
    const { allCandidates } = await orchestrator.discover(input);

    // Both have the same email → should be merged into 1
    const slanceCandidates = allCandidates.filter(c =>
      c.name?.toLowerCase().includes('слънце') || c.email === 'a@dg.bg',
    );
    expect(slanceCandidates).toHaveLength(1);

    // The higher-confidence duplicate is the one kept. `confidence` now carries
    // the final, post-decision score, so assert the survivor's identity and that
    // qualification did not push it below where it started.
    expect(slanceCandidates[0].domain).toBe('dg-slance.bg');
    expect(slanceCandidates[0].confidence).toBeGreaterThanOrEqual(80);
  });
});

describe('DiscoveryOrchestrator — the review tier', () => {
  it('separates uncertain candidates from accepted and rejected ones', async () => {
    const source = makeSource('SearchSource', [
      // Confident: a school name with its own domain.
      makeResult({ name: 'ДГ Слънце', domain: 'dg-slance.bg', confidence: 75 }),
      // Uncertain: the LLM filter never returned a verdict for this one.
      makeResult({
        name: 'ДГ Пролет', domain: 'dg-prolet.bg', confidence: 45,
        signals: [{ criterion: 'LLM_UNJUDGED', effect: 'REVIEW', stage: 'llm' }],
      }),
      // Rejected outright.
      makeResult({
        name: 'Каталог на детски градини', domain: 'katalog.bg',
        pageType: 'DIRECTORY_OR_PORTAL', confidence: 20,
      }),
    ]);

    const orchestrator = new DiscoveryOrchestrator([source]);
    const { accepted, review, rejected, allCandidates } = await orchestrator.discover(input);

    expect(accepted.map(c => c.domain)).toContain('dg-slance.bg');
    expect(review.map(c => c.domain)).toContain('dg-prolet.bg');
    expect(rejected.map(c => c.domain)).toContain('katalog.bg');

    // Every candidate carries a decision, and the three buckets partition the set.
    expect(allCandidates.every(c => !!c.decision)).toBe(true);
    expect(accepted.length + review.length + rejected.length).toBe(allCandidates.length);
  });

  it('writes the decision onto the persisted candidate objects, not onto copies', async () => {
    // The worker persists `allCandidates`. A decision assigned to a copy never
    // reached the database — every qualifier-stage reason was stored as NULL.
    const source = makeSource('SearchSource', [
      makeResult({ domain: 'katalog.bg', pageType: 'DIRECTORY_OR_PORTAL', confidence: 20 }),
    ]);

    const orchestrator = new DiscoveryOrchestrator([source]);
    const { rejected, allCandidates } = await orchestrator.discover(input);

    const persisted = allCandidates.find(c => c.domain === 'katalog.bg');
    expect(persisted).toBe(rejected[0]);                      // same object reference
    expect(persisted?.decision?.primaryReason).toBeTruthy();  // reason survives to the DB
    expect(persisted?.decision?.signals.length).toBeGreaterThan(0);
  });
});

describe('DiscoveryOrchestrator — scenario F (test H): education qualifier filters extracted non-schools', () => {
  it('rejects registry/catalog rows extracted from municipality page; accepts real kindergartens', async () => {
    // Municipality page listing real kindergartens alongside registry/catalog entries.
    // The "bad" rows contain persona keyword "детски" so OrganizationExtractor picks them
    // up via matchesPersonaKeyword — they must then be hard-rejected by the education qualifier.
    const municipalityResult = makeResult({
      sourceUrl: 'https://mezdra.bg/detski-gradini',
      domain:    'mezdra.bg',
      title:     'Детски градини | Община Мездра',
      snippet:   'Списък на детските градини в Мездра',
      pageType:  'MUNICIPALITY_PAGE',
      confidence: 20,
    });

    const source = makeSource('SearchSource', [municipalityResult]);

    mockFetch.mockResolvedValueOnce({
      ok:   true,
      text: jest.fn().mockResolvedValue(`
        <html><body>
          <h1>Детски градини в Община Мездра</h1>
          <table>
            <tr><th>Наименование</th><th>Телефон</th></tr>
            <tr><td>ДГ Слънчице</td><td>0893111111</td></tr>
            <tr><td>ДГ Надежда</td><td>0893222222</td></tr>
            <tr><td>Регистър на детски градини в Мездра</td><td>0893333333</td></tr>
            <tr><td>Каталог на детски градини Мездра</td><td>0893444444</td></tr>
          </table>
        </body></html>
      `),
    } as unknown as Response);

    const orchestrator = new DiscoveryOrchestrator([source]);
    const { accepted, rejected } = await orchestrator.discover(input);

    // Municipality page itself must be rejected
    expect(rejected.some(c => c.domain === 'mezdra.bg' && !c.extractedFromUrl)).toBe(true);

    // Real kindergartens (ДГ prefix) should be accepted
    const acceptedNames = accepted.map(c => c.name ?? '');
    expect(acceptedNames.some(n => n.includes('Слънчице'))).toBe(true);
    expect(acceptedNames.some(n => n.includes('Надежда'))).toBe(true);

    // Registry/catalog rows must be rejected by the education qualifier
    const rejectedNames = rejected.map(c => c.name ?? '');
    expect(rejectedNames.some(n => n.includes('Регистър'))).toBe(true);
    expect(rejectedNames.some(n => n.includes('Каталог'))).toBe(true);
  });
});

describe('DiscoveryOrchestrator — source errors', () => {
  it('continues if one source fails (but propagates SearchProviderError)', async () => {
    const failingSource: DiscoverySource = {
      name:      'FailingSource',
      canHandle: () => true,
      discover:  jest.fn().mockRejectedValue(new Error('network error')),
    };
    const goodResult = makeResult({ domain: 'dg-slance.bg', name: 'ДГ Слънце', confidence: 70 });
    const goodSource  = makeSource('GoodSource', [goodResult]);

    const orchestrator = new DiscoveryOrchestrator([failingSource, goodSource]);
    const { accepted } = await orchestrator.discover(input);

    expect(accepted.some(c => c.domain === 'dg-slance.bg')).toBe(true);
  });
});
