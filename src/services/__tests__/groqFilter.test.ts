import { discoverSites, cleanSearchText } from '../discovery';
import type { DiscoveredSite } from '../discovery';

// ── cleanSearchText ───────────────────────────────────────────────────────────
// Brave returns snippets marked up for display. Left in place, that markup reached
// the LLM prompt, every heuristic, and the database — four `&quot;` from a school
// quoting its own name tripped the "repeated token means a listing page" rule and
// rejected a real kindergarten.

describe('cleanSearchText', () => {
  test('strips tags but keeps the words inside them', () => {
    expect(cleanSearchText('ДГ <strong>Слънце</strong> Мездра')).toBe('ДГ Слънце Мездра');
  });

  test('decodes named entities', () => {
    expect(cleanSearchText('ДГ &quot;Слънце&quot;')).toBe('ДГ "Слънце"');
    expect(cleanSearchText('А &amp; Б')).toBe('А & Б');
    expect(cleanSearchText('нещо&nbsp;друго')).toBe('нещо друго');
  });

  test('decodes numeric entities, decimal and hex', () => {
    expect(cleanSearchText('&#1044;&#1043;')).toBe('ДГ');
    expect(cleanSearchText('&#x414;&#x413;')).toBe('ДГ');
  });

  test('collapses whitespace', () => {
    expect(cleanSearchText('  ДГ   Слънце  ')).toBe('ДГ Слънце');
  });

  test('leaves an unknown entity alone rather than mangling it', () => {
    expect(cleanSearchText('100 &notarealentity; ok')).toBe('100 &notarealentity; ok');
  });

  test('null, undefined and empty input produce undefined', () => {
    expect(cleanSearchText(null)).toBeUndefined();
    expect(cleanSearchText(undefined)).toBeUndefined();
    expect(cleanSearchText('   ')).toBeUndefined();
  });
});

// ── The chunked LLM filter ────────────────────────────────────────────────────
// The old filter sent all 60-100 candidates in one call with max_tokens:400. It
// could not physically list that many indices, and both failure modes were silent:
// a throw disabled filtering for the whole batch (everything accepted), a
// truncated parse rejected every unlisted index (everything dropped).

type FetchMock = jest.Mock<Promise<unknown>, [string, RequestInit?]>;

const SEARCH_HOST = 'api.search.brave.com';
const GROQ_HOST   = 'api.groq.com';

function braveResponse(count: number) {
  return {
    ok: true,
    json: async () => ({
      web: {
        results: Array.from({ length: count }, (_, i) => ({
          url:         `https://org${i}.bg/`,
          title:       `Организация ${i}`,
          description: `Описание на организация ${i}`,
        })),
      },
    }),
  };
}

function groqResponse(body: unknown) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }),
  };
}

/** Verdicts for indices 0..n-1 within a chunk. */
function keepAll(n: number) {
  return { v: Array.from({ length: n }, (_, i) => ({ i, d: 'KEEP', w: 'изглежда истинска' })) };
}

describe('discoverSites — LLM filter behaviour', () => {
  let fetchMock: FetchMock;
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.SEARCH_PRIMARY_PROVIDER = 'brave';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  /** Routes search calls to a fixed result set and Groq calls through `onGroq`. */
  function route(resultCount: number, onGroq: (callIndex: number, chunkSize: number) => unknown) {
    let groqCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes(SEARCH_HOST)) return braveResponse(resultCount);
      if (url.includes(GROQ_HOST)) {
        const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
        // Count the "N: [domain]" lines to learn how big this chunk is.
        const chunkSize = (prompt.match(/^\d+: \[/gm) ?? []).length;
        return onGroq(groqCalls++, chunkSize);
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
  }

  const params = { persona: 'детски градини', location: 'Мездра' };
  const byStatus = (sites: DiscoveredSite[], status: string) =>
    sites.filter(s => s.status === status);

  test('splits candidates into chunks instead of one oversized call', async () => {
    route(40, (_, chunkSize) => groqResponse(keepAll(chunkSize)));

    const sites = await discoverSites(params);
    const groqCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes(GROQ_HOST));

    // 40 unique domains at 15 per chunk → 3 chunks, none of them oversized.
    expect(groqCalls.length).toBe(3);
    expect(byStatus(sites, 'kept').length).toBe(40);
  });

  test('a candidate the model never judged goes to review, not to the results', async () => {
    // The model answers for every index except the last one in each chunk.
    route(10, (_, chunkSize) => groqResponse({
      v: Array.from({ length: chunkSize - 1 }, (_, i) => ({ i, d: 'KEEP' })),
    }));

    const sites = await discoverSites(params);
    const review = byStatus(sites, 'review');

    expect(review.length).toBeGreaterThan(0);
    expect(review.every(s => s.rejectionReason === 'LLM_UNJUDGED')).toBe(true);
    // Crucially: not silently kept, and not silently dropped either.
    expect(byStatus(sites, 'filtered')).toHaveLength(0);
  });

  test('a missing verdict is re-asked once before giving up', async () => {
    let firstCallChunkSize = 0;
    route(10, (callIndex, chunkSize) => {
      if (callIndex === 0) {
        firstCallChunkSize = chunkSize;
        return groqResponse({ v: [{ i: 0, d: 'KEEP' }] });   // 1 of 10 answered
      }
      // The retry prompt contains only the 9 stragglers, not the whole chunk.
      expect(chunkSize).toBe(firstCallChunkSize - 1);
      return groqResponse(keepAll(chunkSize));
    });

    const sites = await discoverSites(params);
    expect(byStatus(sites, 'kept')).toHaveLength(10);
    expect(byStatus(sites, 'review')).toHaveLength(0);
  });

  test('a chunk that throws degrades only that chunk, and to review', async () => {
    // Chunks run concurrently, so the failing one is identified by its contents
    // rather than by call order — and its retry has to fail too for the chunk to
    // be considered degraded.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes(SEARCH_HOST)) return braveResponse(30);
      const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
      if (prompt.includes('[org0.bg]')) throw new Error('network blew up');
      const chunkSize = (prompt.match(/^\d+: \[/gm) ?? []).length;
      return groqResponse(keepAll(chunkSize));
    });

    const sites = await discoverSites(params);
    const review = byStatus(sites, 'review');

    // The failed chunk's 15 candidates are flagged; the rest are judged normally.
    expect(review.length).toBe(15);
    expect(review.every(s => s.rejectionReason === 'FILTER_DEGRADED')).toBe(true);
    expect(byStatus(sites, 'kept').length).toBe(15);
  });

  test('an unparseable response degrades to review rather than accepting everything', async () => {
    route(10, () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'sorry, I cannot' } }] }) }));

    const sites = await discoverSites(params);
    expect(byStatus(sites, 'kept')).toHaveLength(0);
    expect(byStatus(sites, 'review')).toHaveLength(10);
  });

  test('a rejection carries the model\'s own reason code and evidence', async () => {
    route(3, (_, chunkSize) => groqResponse({
      v: Array.from({ length: chunkSize }, (_, i) => ({
        i, d: 'REJECT', c: 'DIRECTORY_OR_PORTAL', w: 'изброява много организации',
      })),
    }));

    const sites = await discoverSites(params);
    const filtered = byStatus(sites, 'filtered');

    expect(filtered).toHaveLength(3);
    expect(filtered[0].rejectionReason).toBe('DIRECTORY_OR_PORTAL');
    const llmSignal = filtered[0].signals.find(s => s.stage === 'llm');
    expect(llmSignal?.detail).toBe('изброява много организации');
  });

  test('an unrecognised reason code falls back to NOT_TARGET_ORGANIZATION', async () => {
    route(2, (_, chunkSize) => groqResponse({
      v: Array.from({ length: chunkSize }, (_, i) => ({ i, d: 'REJECT', c: 'INVENTED_CODE' })),
    }));

    const sites = await discoverSites(params);
    expect(byStatus(sites, 'filtered')[0].rejectionReason).toBe('NOT_TARGET_ORGANIZATION');
  });

  test('an approved candidate is marked llmApproved so heuristics cannot cheaply overrule it', async () => {
    route(2, (_, chunkSize) => groqResponse(keepAll(chunkSize)));

    const sites = await discoverSites(params);
    expect(byStatus(sites, 'kept').every(s => s.llmApproved === true)).toBe(true);
  });

  test('without an API key nothing is silently accepted', async () => {
    delete process.env.GROQ_API_KEY;
    route(5, () => { throw new Error('Groq should not be called'); });

    const sites = await discoverSites(params);
    expect(byStatus(sites, 'kept')).toHaveLength(0);
    expect(byStatus(sites, 'review')).toHaveLength(5);
    expect(sites.every(s => s.rejectionReason === 'FILTER_DEGRADED')).toBe(true);
  });

  test('the prompt always carries the domain — the strongest single signal', async () => {
    let prompt = '';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes(SEARCH_HOST)) return braveResponse(2);
      prompt = JSON.parse(String(init?.body)).messages[0].content as string;
      return groqResponse(keepAll(2));
    });

    await discoverSites(params);
    expect(prompt).toContain('[org0.bg]');
    expect(prompt).toContain('[org1.bg]');
  });

  test('the prompt examples are built from the persona, not hardcoded to kindergartens', async () => {
    let prompt = '';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes(SEARCH_HOST)) return braveResponse(1);
      prompt = JSON.parse(String(init?.body)).messages[0].content as string;
      return groqResponse(keepAll(1));
    });

    await discoverSites({ persona: 'суши ресторанти', location: 'София' });
    expect(prompt).toContain('суши ресторанти');
    expect(prompt).not.toContain('детски градини');
  });

  // ── The UNSURE verdict ──────────────────────────────────────────────────────
  // Without it the review tier only ever fills up when the pipeline FAILS. UNSURE
  // is the model reading a result and honestly not being able to tell, which is
  // the case the "For review" tab exists for.

  test('an UNSURE verdict routes the candidate to review, not to the results', async () => {
    route(1, () => groqResponse({
      v: [{ i: 0, d: 'UNSURE', w: 'може да е кабинет или указател' }],
    }));

    const sites = await discoverSites(params);

    expect(sites[0].status).toBe('review');
    expect(sites[0].rejectionReason).toBe('LLM_UNCERTAIN');
    expect(sites[0].llmApproved).toBeFalsy();
  });

  test("an UNSURE verdict keeps the model's own words as the evidence", async () => {
    route(1, () => groqResponse({ v: [{ i: 0, d: 'UNSURE', w: 'няма посочен град' }] }));

    const sites = await discoverSites(params);
    const llmSignal = sites[0].signals.find(s => s.stage === 'llm');

    expect(llmSignal?.criterion).toBe('LLM_UNCERTAIN');
    expect(llmSignal?.effect).toBe('REVIEW');
    expect(llmSignal?.detail).toBe('няма посочен град');
  });

  test('the prompt offers UNSURE as a verdict', async () => {
    let prompt = '';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes(SEARCH_HOST)) return braveResponse(1);
      prompt = JSON.parse(String(init?.body)).messages[0].content as string;
      return groqResponse(keepAll(1));
    });

    await discoverSites(params);
    expect(prompt).toContain('UNSURE');
  });

  // ── Misconfiguration and rate limiting ──────────────────────────────────────
  // A wrong model name 404s identically on every chunk. Retrying it burns a
  // round-trip per chunk and buries the cause under N identical warnings — and
  // with the old default model it silently disabled filtering altogether.

  test('a 404 model error stops further chunks instead of failing each one', async () => {
    let groqCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(SEARCH_HOST)) return braveResponse(60);
      groqCalls++;
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => '{"error":{"message":"The model does not exist"}}',
      };
    });

    const sites = await discoverSites(params);

    // 60 domains → 4 chunks. The two that were already in flight when the error
    // came back still cost a request; the rest must be skipped, and none of them
    // may be retried. Without the guard this is 8 calls (4 chunks × 2 attempts).
    expect(groqCalls).toBeLessThanOrEqual(2);
    expect(byStatus(sites, 'review').length).toBe(60);
    expect(byStatus(sites, 'kept')).toHaveLength(0);
    expect(sites.every(s => s.rejectionReason === 'FILTER_DEGRADED')).toBe(true);
  });

  test('a 429 is waited out and retried rather than degrading the chunk', async () => {
    let groqCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes(SEARCH_HOST)) return braveResponse(5);
      groqCalls++;
      if (groqCalls === 1) {
        return { ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'rate limited' };
      }
      const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
      const chunkSize = (prompt.match(/^\d+: \[/gm) ?? []).length;
      return groqResponse(keepAll(chunkSize));
    });

    const sites = await discoverSites(params);

    expect(groqCalls).toBe(2);              // rate-limited once, then succeeded
    expect(byStatus(sites, 'kept').length).toBe(5);
    expect(byStatus(sites, 'review')).toHaveLength(0);
  });
});

describe('discoverSites — blocklist and deduplication', () => {
  let fetchMock: FetchMock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
    delete process.env.GROQ_API_KEY;
    process.env.SEARCH_PRIMARY_PROVIDER = 'brave';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function withResults(results: Array<{ url: string; title?: string; description?: string }>) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(SEARCH_HOST)) {
        return { ok: true, json: async () => ({ web: { results } }) };
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
  }

  test('a municipality subdomain that hosts a real organization survives', async () => {
    // dg-slance.varna.bg is a kindergarten. Blocking varna.bg by suffix would kill it,
    // which is why municipality domains are matched as exact hosts only.
    withResults([
      { url: 'https://dg-slance.varna.bg/', title: 'ДГ Слънце' },
      { url: 'https://varna.bg/',           title: 'Община Варна' },
    ]);

    const sites = await discoverSites({ persona: 'детски градини', location: 'Варна' });
    expect(sites.find(s => s.domain === 'dg-slance.varna.bg')?.status).not.toBe('blocked');
    expect(sites.find(s => s.domain === 'varna.bg')?.status).toBe('blocked');
  });

  test('an aggregator is blocked together with its subdomains', async () => {
    withResults([
      { url: 'https://booking.com/hotel/x',    title: 'Хотел' },
      { url: 'https://www.booking.com/hotel/y', title: 'Хотел' },
      { url: 'https://secure.booking.com/z',   title: 'Хотел' },
    ]);

    const sites = await discoverSites({ persona: 'хотели', location: 'Банско' });
    expect(sites.every(s => s.status === 'blocked')).toBe(true);
  });

  test('a blocked candidate says which blocklist entry matched', async () => {
    withResults([{ url: 'https://booking.com/hotel/x', title: 'Хотел' }]);

    const sites = await discoverSites({ persona: 'хотели', location: 'Банско' });
    const blockSignal = sites[0].signals.find(s => s.stage === 'blocklist');
    expect(blockSignal?.detail).toContain('booking.com');
  });

  test('the shallowest URL wins when one domain appears several times', async () => {
    // A homepage is a far better lead than the news article that outranked it.
    withResults([
      { url: 'https://dg-slance.bg/novini/2025/nova-grupa', title: 'Новина' },
      { url: 'https://dg-slance.bg/',                       title: 'ДГ Слънце' },
    ]);

    const sites = await discoverSites({ persona: 'детски градини', location: 'Мездра' });
    const site = sites.find(s => s.domain === 'dg-slance.bg');
    expect(site?.url).toBe('https://dg-slance.bg/');
  });

  test('search markup never reaches the stored title or snippet', async () => {
    withResults([{
      url:         'https://mir-mezdra.com/',
      title:       'ДГ &quot;<strong>Мир</strong>&quot; Мездра',
      description: 'Детска градина &quot;Мир&quot;, &quot;Мир&quot;, &quot;Мир&quot;',
    }]);

    const sites = await discoverSites({ persona: 'детски градини', location: 'Мездра' });
    expect(sites[0].title).toBe('ДГ "Мир" Мездра');
    expect(sites[0].snippet).not.toContain('&quot;');
    expect(sites[0].snippet).not.toContain('quot');
  });
});
