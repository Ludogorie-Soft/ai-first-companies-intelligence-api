import { CandidateQualifier } from '../CandidateQualifier';
import { signal } from '../types';
import type { DiscoverySourceResult, PersonaSearchInput, ReasonCode } from '../types';

const qualifier = new CandidateQualifier();
const input: PersonaSearchInput = { persona: 'детски градини', location: 'гр. Мездра' };

function makeCandidate(overrides: Partial<DiscoverySourceResult>): DiscoverySourceResult {
  return {
    sourceUrl:   'https://example.bg',
    sourceType:  'municipality',
    confidence:  70,
    pageType:    'TARGET_ORGANIZATION',
    domain:      'example.bg',
    ...overrides,
  };
}

/** Asserts the verdict, the headline reason, and that the reason is in the signal list. */
function expectVerdict(
  c: DiscoverySourceResult,
  verdict: 'ACCEPT' | 'REVIEW' | 'REJECT',
  reason?: ReasonCode,
) {
  const decision = qualifier.decide(c, input);
  expect(decision.verdict).toBe(verdict);
  if (reason) {
    expect(decision.primaryReason).toBe(reason);
    expect(decision.signals.some(s => s.criterion === reason)).toBe(true);
  }
  return decision;
}

describe('CandidateQualifier — accepts', () => {
  test('a TARGET_ORGANIZATION with a domain and good confidence', () => {
    const c = makeCandidate({ domain: 'dg-slance.bg', confidence: 75 });
    expectVerdict(c, 'ACCEPT');
  });

  test('an extracted org with a phone but no domain', () => {
    const c = makeCandidate({
      domain:   undefined,
      phone:    '0893111111',
      confidence: 55,
      extractedFromUrl: 'https://mezdra.bg/detski-gradini',
    });
    expectVerdict(c, 'ACCEPT');
  });

  test('an org extracted FROM a municipality page — that is the point of extraction', () => {
    const c = makeCandidate({
      domain:          'dg-slance.bg',
      confidence:      65,
      extractedFromUrl: 'https://mezdra.bg/detski-gradini',
    });
    expectVerdict(c, 'ACCEPT');
  });

  test('a synthetic-domain candidate that has an email', () => {
    const c = makeCandidate({
      domain:     'extracted-abc123.local',
      confidence: 60,
      email:      'dg@example.bg',
    });
    expectVerdict(c, 'ACCEPT');
  });

  test('an accept carries a reason too, not only rejects', () => {
    const decision = qualifier.decide(makeCandidate({ confidence: 75 }), input);
    expect(decision.verdict).toBe('ACCEPT');
    expect(decision.primaryReason).toBeTruthy();
    expect(decision.signals.length).toBeGreaterThan(0);
  });
});

describe('CandidateQualifier — rejects', () => {
  test('a MUNICIPALITY_PAGE that is not extracted from a list', () => {
    expectVerdict(
      makeCandidate({ pageType: 'MUNICIPALITY_PAGE', domain: 'mezdra.bg' }),
      'REJECT', 'MUNICIPALITY_PAGE',
    );
  });

  test('a NEWS_ARTICLE', () => {
    expectVerdict(
      makeCandidate({ pageType: 'NEWS_ARTICLE', domain: 'news.bg' }),
      'REJECT', 'NEWS_ARTICLE',
    );
  });

  test('a DIRECTORY_OR_PORTAL', () => {
    expectVerdict(
      makeCandidate({ pageType: 'DIRECTORY_OR_PORTAL', domain: 'katalog.bg' }),
      'REJECT', 'DIRECTORY_OR_PORTAL',
    );
  });

  test('a SOCIAL_PAGE whose host is not in the hardcoded platform list', () => {
    // vk.com is not in isSocialPlatform's list; the pageType check catches it.
    expectVerdict(
      makeCandidate({ pageType: 'SOCIAL_PAGE', domain: 'vk.com' }),
      'REJECT', 'SOCIAL_PLATFORM',
    );
  });

  test('an IRRELEVANT result', () => {
    expectVerdict(
      makeCandidate({ pageType: 'IRRELEVANT', domain: 'unrelated.bg' }),
      'REJECT', 'NOT_TARGET_ORGANIZATION',
    );
  });

  test('a candidate below the confidence floor', () => {
    const decision = expectVerdict(
      makeCandidate({ domain: 'dg.bg', confidence: 20 }),
      'REJECT', 'BELOW_CONFIDENCE_FLOOR',
    );
    // The evidence names the actual number, so the UI can show it.
    expect(decision.signals.find(s => s.criterion === 'BELOW_CONFIDENCE_FLOOR')?.detail)
      .toMatch(/20/);
  });

  test('a candidate with no contact signal and a synthetic domain', () => {
    expectVerdict(
      makeCandidate({
        domain:    'extracted-abc123.local',
        confidence: 60,
        email:     undefined,
        phone:     undefined,
      }),
      'REJECT', 'NO_CONTACT_SIGNAL',
    );
  });

  test('an extracted org pointing back at its own source page', () => {
    expectVerdict(
      makeCandidate({
        domain:          'registarnadetskitegradini.com',
        confidence:      55,
        extractedFromUrl: 'https://registarnadetskitegradini.com/mezdra',
      }),
      'REJECT', 'SAME_DOMAIN_AS_SOURCE',
    );
  });

  test('an OFFICIAL_REGISTRY however it arrived — extracted or not', () => {
    expectVerdict(
      makeCandidate({ pageType: 'OFFICIAL_REGISTRY', domain: 'ruo-vratsa.bg' }),
      'REJECT', 'OFFICIAL_REGISTRY',
    );
    expectVerdict(
      makeCandidate({
        pageType: 'OFFICIAL_REGISTRY',
        domain:   'ruo-vratsa.bg',
        extractedFromUrl: 'https://mezdra.bg/detski-gradini',
      }),
      'REJECT', 'OFFICIAL_REGISTRY',
    );
  });
});

describe('CandidateQualifier — the review tier', () => {
  // The whole point of the middle tier: uncertainty used to resolve to "keep",
  // which is what let wrong-town and unjudged results into the good list.

  test('an LLM-unjudged candidate goes to review, not to the results', () => {
    const c = makeCandidate({
      confidence: 45,
      signals: [signal('LLM_UNJUDGED', 'REVIEW', 'llm', 'няма присъда')],
    });
    expectVerdict(c, 'REVIEW', 'LLM_UNJUDGED');
  });

  test('a degraded filter chunk goes to review, never silently accepted', () => {
    const c = makeCandidate({
      confidence: 45,
      signals: [signal('FILTER_DEGRADED', 'REVIEW', 'llm', 'групата не получи отговор')],
    });
    expectVerdict(c, 'REVIEW', 'FILTER_DEGRADED');
  });

  test('a borderline confidence lands in review rather than being accepted', () => {
    expectVerdict(makeCandidate({ confidence: 50 }), 'REVIEW', 'BORDERLINE_CONFIDENCE');
  });

  test('a pre-crawl location conflict is review, not rejection', () => {
    // Title and snippet are weak evidence for where a business actually is —
    // postCrawlVerification re-checks it against the real address.
    const c = makeCandidate({
      confidence: 70,
      name:       'ДГ Слънце',
      snippet:    'Детска градина в град Варна',
    });
    expectVerdict(c, 'REVIEW', 'LOCATION_CONFLICT');
  });

  test('a matching location adds confidence instead', () => {
    const c = makeCandidate({
      confidence: 70,
      name:       'ДГ Слънце',
      snippet:    'Детска градина в град Мездра',
    });
    const decision = expectVerdict(c, 'ACCEPT');
    expect(decision.confidence).toBeGreaterThan(70);
  });

  test('an unrecognised location is not a conflict', () => {
    const c = makeCandidate({
      confidence: 70,
      name:       'ДГ Слънце',
      snippet:    'Детска градина с дълга история и опитен екип',
    });
    expectVerdict(c, 'ACCEPT');
  });

  test('a REJECT signal outranks a REVIEW signal', () => {
    const c = makeCandidate({
      pageType:   'DIRECTORY_OR_PORTAL',
      confidence: 45,
      signals:    [signal('LLM_UNJUDGED', 'REVIEW', 'llm')],
    });
    expectVerdict(c, 'REJECT', 'DIRECTORY_OR_PORTAL');
  });
});

describe('CandidateQualifier — social platforms', () => {
  const cases: Array<[string, string]> = [
    ['facebook.com',  'https://facebook.com/company'],
    ['linkedin.com',  'https://linkedin.com/company/openai'],
    ['instagram.com', 'https://instagram.com/company'],
  ];

  test.each(cases)('rejects %s as a company domain', (domain, websiteUrl) => {
    expectVerdict(makeCandidate({ domain, websiteUrl }), 'REJECT', 'SOCIAL_PLATFORM');
  });

  test('rejects a social platform even when extracted from a list page', () => {
    expectVerdict(
      makeCandidate({
        domain:          'facebook.com',
        websiteUrl:      'https://facebook.com/su-ivan-vazov',
        confidence:      70,
        extractedFromUrl: 'https://mezdra.bg/uchilishta',
      }),
      'REJECT', 'SOCIAL_PLATFORM',
    );
  });

  test('accepts an ordinary domain', () => {
    expectVerdict(
      makeCandidate({ domain: 'company.com', websiteUrl: 'https://company.com' }),
      'ACCEPT',
    );
  });
});

describe('CandidateQualifier — qualify() back-compat wrapper', () => {
  test('collapses REVIEW into "not accepted" but still reports the verdict', () => {
    const c = makeCandidate({
      confidence: 45,
      signals: [signal('LLM_UNJUDGED', 'REVIEW', 'llm')],
    });
    const { accepted, reason, verdict } = qualifier.qualify(c, input);
    expect(accepted).toBe(false);
    expect(verdict).toBe('REVIEW');
    expect(reason).toBe('LLM_UNJUDGED');
  });

  test('isAccepted is true only for ACCEPT', () => {
    expect(qualifier.isAccepted(makeCandidate({ confidence: 75 }), input)).toBe(true);
    expect(qualifier.isAccepted(makeCandidate({ confidence: 50 }), input)).toBe(false);
  });
});
