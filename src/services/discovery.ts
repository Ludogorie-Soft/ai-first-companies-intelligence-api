import { locationSignal } from './discovery/locationMatch';
import { signal } from './discovery/types';
import type { DecisionSignal, ReasonCode } from './discovery/types';

export interface DiscoveryParams {
  persona: string;
  location: string;
  keywords?: string;
  maxResults?: number;
}

export type CandidateStatus = 'kept' | 'review' | 'filtered' | 'blocked';

export interface DiscoveredSite {
  url: string;
  domain: string;
  title?: string;
  snippet?: string;
  status: CandidateStatus;
  rejectionReason?: ReasonCode;
  /** True only when the LLM explicitly kept this site (not when it was never judged). */
  llmApproved?: boolean;
  /** Criteria that fired at the search / blocklist / LLM stages. */
  signals: DecisionSignal[];
}

function extractDomain(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ── Search-result text cleanup ────────────────────────────────────────────────
// Brave returns snippets marked up for display: matched terms wrapped in <strong>
// and quotes escaped as HTML entities. Left in place, that markup reaches the LLM
// prompt, every downstream heuristic, and the database. A school quoting its own
// name four times used to yield four "quot" tokens, which tripped the
// "repeated token means a listing page" rule and rejected a real kindergarten.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
  bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

export function cleanSearchText(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;

  const text = raw
    // Tags that separate content become a space...
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|td|h[1-6])>/gi, ' ')
    // ...while inline tags vanish, so `<strong>Мир</strong>` stays one word rather
    // than becoming ` Мир `, which would break the quotes around a school's name.
    .replace(/<[^>]*>/g, '')
    // Numeric entities, decimal and hex.
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // Named entities.
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > 0 ? text : undefined;
}

// ── Blocklists ────────────────────────────────────────────────────────────────
// Split in two on purpose. Municipality domains are matched EXACTLY, because
// Bulgarian schools and kindergartens are routinely hosted as subdomains of their
// municipality (dg-slance.varna.bg is a real kindergarten, not the city hall).
// Aggregators are matched by suffix, because their subdomains are more of the same.

/** Blocked only as an exact hostname — subdomains may be legitimate organizations. */
const SKIP_HOSTS_EXACT = [
  // Municipality & government portals
  'obshtini.bg', 'varna.bg', 'sofia.bg', 'plovdiv.bg', 'burgas.bg',
  'ruse.bg', 'stara-zagora.bg', 'pleven.bg', 'sliven.bg', 'dobrich.bg',
  'lovech.bg', 'montana.bg', 'vidin.bg', 'vratsa.bg', 'vratza.bg', 'gabrovo.bg',
  'targovishte.bg', 'razgrad.bg', 'shumen.bg', 'silistra.bg',
  'kardzhali.bg', 'smolyan.bg', 'blagoevgrad.bg', 'kyustendil.bg',
  'pernik.bg', 'sofia-grad.bg', 'government.bg', 'parliament.bg',
  'obshtina.bg', 'pazardzhik.bg', 'lovech-obshtina.bg',
  'yambol.bg', 'haskovo.bg', 'sandanski.bg', 'blagoevgrad-ob.bg',
  'egov.bg', 'e-gov.bg',
];

/** Blocked together with every subdomain. */
const SKIP_SUFFIXES = [
  // Social media
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'linkedin.com', 'youtube.com', 'tiktok.com',
  // Search engines & maps
  'google.com', 'bing.com', '2gis.com', '2gis.bg',
  // Encyclopedias
  'wikipedia.org', 'wikidata.org',
  // Business/org directories & aggregators
  'katalog.bg', 'firmeni.bg', 'firma.bg',
  'registryagency.bg', 'brra.bg',
  'industryinfo.bg', 'korektnafirma.com',
  'businessaccountbg.com',
  'vsichkifirmi.com', 'papagal.bg',
  'varna.biz', 'sofia.biz', 'plovdiv.biz', 'burgas.biz',
  // Classified ads portals
  'bezplatno.net', 'olx.bg', 'bazar.bg', 'pazaruvaj.com',
  // Job boards
  'zaplata.bg', 'jobs.bg', 'rabota.bg', 'karieri.bg', 'bgjobs.com',
  // Service & professional marketplaces
  'starofservice.bg', 'starofservice.com',
  'bark.com', 'thumbtack.com',
  // Review & local discovery
  'oink.bg', 'opoznai.bg', 'goguide.bg',
  // Health directories & portals
  'framar.bg', 'zdravenportal.com', 'zdravencatalog.com',
  'puls.bg', 'medrec-m.com',
  // Professional chambers & associations (not individual companies)
  'bcpea.org', 'bcci.bg', 'bia-bg.com',
  // Category-specific aggregator sites
  'detskigradini.bg', 'detskitegradini.com', 'registarnadetskitegradini.com',
  // Review & travel aggregators
  'tripadvisor.com', 'tripadvisor.bg', 'yelp.com',
  // Restaurant & venue directories
  'zavedenia.com', 'menuonline.bg', 'restogo.bg',
  'restaurant.bg', 'alakart.bg', 'justbook.bg', 'takeaway.com',
  // Hotel & accommodation booking portals
  'rezervaciq.com', 'booking.com', 'airbnb.com', 'trivago.com', 'expedia.com',
];

// Pattern-based rules for domain families that can't be enumerated
const SKIP_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^ruo-/,             label: 'РУО (регионално управление на образованието)' },
  { re: /^rio-/,             label: 'РИО (регионален инспекторат по образованието)' },
  { re: /\.government\.bg$/, label: 'правителствен поддомейн' },
  { re: /^obshtina-/,        label: 'общински домейн' },
];

/** Returns the matched blocklist entry, or null when the domain is allowed. */
function blocklistHit(domain: string): string | null {
  if (SKIP_HOSTS_EXACT.includes(domain)) return domain;
  const suffix = SKIP_SUFFIXES.find(d => domain === d || domain.endsWith(`.${d}`));
  if (suffix) return suffix;
  const pattern = SKIP_PATTERNS.find(p => p.re.test(domain));
  if (pattern) return pattern.label;
  return null;
}

// ── Search provider error ─────────────────────────────────────────────────────
// Thrown when the provider returns a billing/quota/auth status that means no
// results can be trusted. Distinct from an empty-results response (valid data).

export class SearchProviderError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly query: string,
    public readonly provider: string = 'unknown',
  ) {
    super(`${provider} returned HTTP ${statusCode} for query "${query}"`);
    this.name = 'SearchProviderError';
  }
}

/** Builds the initial DiscoveredSite for a raw search hit, applying the blocklist. */
function toDiscoveredSite(
  url: string,
  domain: string,
  title: string | undefined,
  snippet: string | undefined,
  provider: string,
): DiscoveredSite {
  const hit = blocklistHit(domain);
  const signals: DecisionSignal[] = [
    signal('MATCHES_PERSONA_AND_LOCATION', 'ACCEPT', 'search', `намерен от ${provider}`),
  ];

  if (hit) {
    signals.push(signal(
      'BLOCKLISTED_AGGREGATOR', 'REJECT', 'blocklist',
      `домейнът съвпада със списъка с агрегатори: ${hit}`,
    ));
    return {
      url, domain, title, snippet,
      status: 'blocked',
      rejectionReason: 'BLOCKLISTED_AGGREGATOR',
      signals,
    };
  }

  return { url, domain, title, snippet, status: 'kept', signals };
}

// ── Brave Search API ──────────────────────────────────────────────────────────
// Sign up at https://api.search.brave.com — free tier: 2,000 queries/month
// Set env var: BRAVE_SEARCH_API_KEY

interface BraveResult {
  url: string;
  title?: string;
  description?: string;
}

const BRAVE_COUNT = 20; // Brave max results per request

// Status codes that indicate a billing, quota, auth, or rate-limit problem.
// On these codes we throw SearchProviderError instead of silently returning [].
// Returning [] would mislead the caller into thinking there are no matching sites.
const PROVIDER_HARD_ERROR_CODES = new Set([401, 402, 403, 429]);

async function fetchBraveQuery(apiKey: string, query: string): Promise<DiscoveredSite[]> {
  const url =
    `https://api.search.brave.com/res/v1/web/search` +
    `?q=${encodeURIComponent(query)}&count=${BRAVE_COUNT}&country=ALL&search_lang=bg`;

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
  });

  if (!res.ok) {
    let bodySnippet = '(empty)';
    try { bodySnippet = (await res.text()).slice(0, 300); } catch { /* ignore */ }

    if (PROVIDER_HARD_ERROR_CODES.has(res.status)) {
      console.error(`[discovery] Brave hard error HTTP ${res.status} query="${query}" body=${bodySnippet}`);
      throw new SearchProviderError(res.status, query, 'Brave Search');
    }
    console.warn(`[discovery] Brave soft error HTTP ${res.status} query="${query}" body=${bodySnippet}`);
    return [];
  }

  const data = await res.json() as { web?: { results?: BraveResult[] } };
  const results: DiscoveredSite[] = [];

  for (const item of data.web?.results ?? []) {
    const domain = extractDomain(item.url);
    if (!domain) continue;
    results.push(toDiscoveredSite(
      item.url, domain,
      cleanSearchText(item.title),
      cleanSearchText(item.description),
      'Brave',
    ));
  }

  return results;
}

// ── Serper.dev API ────────────────────────────────────────────────────────────
// Alternative to Brave Search. Sign up at https://serper.dev
// Free tier: 2,500 queries. Set env vars: SEARCH_PROVIDER=serper SERPER_API_KEY=...

interface SerperResult {
  title?: string;
  link: string;
  snippet?: string;
}

async function fetchSerperQuery(apiKey: string, query: string): Promise<DiscoveredSite[]> {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ q: query, gl: 'bg', hl: 'bg', num: BRAVE_COUNT }),
  });

  if (!res.ok) {
    let bodySnippet = '(empty)';
    try { bodySnippet = (await res.text()).slice(0, 300); } catch { /* ignore */ }

    if (PROVIDER_HARD_ERROR_CODES.has(res.status)) {
      console.error(`[discovery] Serper hard error HTTP ${res.status} query="${query}" body=${bodySnippet}`);
      throw new SearchProviderError(res.status, query, 'Serper');
    }
    console.warn(`[discovery] Serper soft error HTTP ${res.status} query="${query}" body=${bodySnippet}`);
    return [];
  }

  const data = await res.json() as { organic?: SerperResult[] };
  const results: DiscoveredSite[] = [];

  for (const item of data.organic ?? []) {
    const domain = extractDomain(item.link);
    if (!domain) continue;
    results.push(toDiscoveredSite(
      item.link, domain,
      cleanSearchText(item.title),
      cleanSearchText(item.snippet),
      'Serper',
    ));
  }

  return results;
}

// ── Provider dispatch ─────────────────────────────────────────────────────────

function activeProvider(): 'brave' | 'serper' {
  const v = (
    process.env.SEARCH_PRIMARY_PROVIDER ??
    process.env.SEARCH_PROVIDER ??
    'brave'
  ).toLowerCase();
  return v === 'serper' ? 'serper' : 'brave';
}

async function fetchQuery(query: string): Promise<DiscoveredSite[]> {
  const provider = activeProvider();
  if (provider === 'serper') {
    return fetchSerperQuery(process.env.SERPER_API_KEY!, query);
  }
  return fetchBraveQuery(process.env.BRAVE_SEARCH_API_KEY!, query);
}

// Major towns per Bulgarian oblast, ordered by population.
// Used to generate per-town search queries when the location is an oblast.
// The complete gazetteer lives in discovery/locationMatch.ts — this list is only
// about which towns are worth spending a search query on, hence the ordering.
export const OBLAST_TOWNS: Record<string, string[]> = {
  'ловеч':          ['Ловеч', 'Троян', 'Луковит', 'Тетевен'],
  'пловдив':        ['Пловдив', 'Асеновград', 'Карлово', 'Раковски'],
  'варна':          ['Варна', 'Провадия', 'Девня', 'Долни чифлик'],
  'бургас':         ['Бургас', 'Несебър', 'Поморие', 'Айтос'],
  'софия':          ['София', 'Ботевград', 'Самоков', 'Ихтиман'],
  'стара загора':   ['Стара Загора', 'Казанлък', 'Чирпан', 'Гълъбово'],
  'велико търново': ['Велико Търново', 'Горна Оряховица', 'Свищов', 'Лясковец'],
  'русе':           ['Русе', 'Бяла', 'Ветово', 'Борово'],
  'плевен':         ['Плевен', 'Кнежа', 'Никопол', 'Долни Дъбник'],
  'габрово':        ['Габрово', 'Севлиево', 'Дряново', 'Трявна'],
  'видин':          ['Видин', 'Белоградчик', 'Брегово'],
  'враца':          ['Враца', 'Козлодуй', 'Мездра', 'Бяла Слатина'],
  'монтана':        ['Монтана', 'Берковица', 'Лом', 'Вършец'],
  'добрич':         ['Добрич', 'Балчик', 'Каварна', 'Тервел'],
  'шумен':          ['Шумен', 'Нови пазар', 'Велики Преслав', 'Каспичан'],
  'хасково':        ['Хасково', 'Димитровград', 'Свиленград', 'Харманли'],
  'кърджали':       ['Кърджали', 'Момчилград', 'Крумовград', 'Джебел'],
  'смолян':         ['Смолян', 'Девин', 'Рудозем', 'Чепеларе'],
  'благоевград':    ['Благоевград', 'Сандански', 'Разлог', 'Банско'],
  'кюстендил':      ['Кюстендил', 'Дупница', 'Бобошево'],
  'перник':         ['Перник', 'Радомир', 'Брезник'],
  'разград':        ['Разград', 'Исперих', 'Кубрат', 'Лозница'],
  'силистра':       ['Силистра', 'Тутракан', 'Дулово', 'Алфатар'],
  'търговище':      ['Търговище', 'Попово', 'Омуртаг', 'Антоново'],
  'сливен':         ['Сливен', 'Нова Загора', 'Котел', 'Твърдица'],
  'ямбол':          ['Ямбол', 'Елхово', 'Стралджа'],
  'пазарджик':      ['Пазарджик', 'Велинград', 'Панагюрище', 'Ракитово'],
};

// Extract major towns for a location string that looks like "област Ловеч" or "Ловеч".
// Returns an empty array for city-level locations (no expansion needed).
function getOblastTowns(location: string): string[] {
  // Match "област X" or "oblast X" (case-insensitive)
  const oblastMatch = location.match(/^(?:област|oblast)\s+(.+)$/i);
  const key = (oblastMatch ? oblastMatch[1] : location).toLowerCase().trim();
  return OBLAST_TOWNS[key] ?? [];
}

function buildQueryVariations(params: DiscoveryParams): string[] {
  const persona = params.persona.trim();
  const location = params.location.trim();
  const extra = params.keywords?.trim() ? ` ${params.keywords.trim()}` : '';

  const queries: string[] = [
    `${persona} ${location}${extra} официален сайт`,
    `${persona} ${location}${extra} контакти телефон имейл`,
    `site:.bg ${persona} ${location}${extra}`,
    `${persona} ${location}${extra} услуги`,
  ];

  // For oblast locations, append per-town queries for top 3 towns.
  // Each town query targets the specific municipality, complementing the oblast-level queries.
  const towns = getOblastTowns(location).slice(0, 3);
  for (const town of towns) {
    queries.push(`${persona} ${town}${extra} контакти`);
  }

  return queries;
}

/** Path depth, used to prefer a homepage over a deep news page on the same domain. */
function pathDepth(rawUrl: string): number {
  try {
    const path = new URL(rawUrl).pathname.replace(/\/+$/, '');
    return path === '' ? 0 : path.split('/').filter(Boolean).length;
  } catch {
    return 99;
  }
}

async function searchViaProvider(params: DiscoveryParams): Promise<DiscoveredSite[]> {
  const variations = buildQueryVariations(params);
  const pages = await Promise.all(variations.map((q) => fetchQuery(q)));

  // Merge and deduplicate by domain — keep ALL (blocked + kept). When the same
  // domain shows up under several URLs, keep the shallowest path: a homepage is a
  // far better lead than the news article that happened to rank higher.
  const byDomain = new Map<string, DiscoveredSite>();

  for (const page of pages) {
    for (const site of page) {
      const existing = byDomain.get(site.domain);
      if (!existing || pathDepth(site.url) < pathDepth(existing.url)) {
        byDomain.set(site.domain, site);
      }
    }
  }

  return [...byDomain.values()];
}

// ── Groq relevance filter ─────────────────────────────────────────────────────
// Sends only 'kept' candidates to Groq, in chunks. Non-selected ones become
// 'filtered'; ones the model never judged become 'review' rather than being
// silently kept or silently dropped. 'blocked' candidates are never sent.
//
// This used to be a single call with max_tokens:400 covering all 60-100
// candidates. It could not physically emit that many indices, and both failure
// modes were silent: a throw disabled filtering for the whole batch (everything
// accepted), a truncated parse rejected every unlisted index (everything dropped).

const CHUNK_SIZE       = 15;
// Groq reserves `max_tokens` against the per-minute token budget up front, so the
// ceiling that matters is CHUNK_CONCURRENCY × (prompt + GROQ_MAX_TOKENS). On the
// free tier that budget is 8000 TPM; 2 × (~1200 prompt + 1500) ≈ 5400 fits, while
// 3 × 4000 does not and 429s the first chunk out of every batch.
const CHUNK_CONCURRENCY = 2;
const GROQ_TIMEOUT_MS  = 30_000;
const GROQ_RATE_LIMIT_RETRIES = 3;
// gpt-oss models are reasoning models: their chain of thought is billed as
// completion tokens and counts against max_tokens. At 900 a 15-item chunk of real
// (long) titles and snippets runs out mid-JSON, and Groq rejects the truncated
// object with `json_validate_failed` and an empty `failed_generation` — which
// looks like a prompt bug but is purely a budget problem. Measured usage with
// reasoning_effort=low is ~224 tokens for a full 15-item chunk, so 1500 is ~6x
// headroom while staying inside the TPM budget described at CHUNK_CONCURRENCY.
const GROQ_MAX_TOKENS  = 1_500;

const LLM_REASON_CODES: ReasonCode[] = [
  'MUNICIPALITY_PAGE', 'DIRECTORY_OR_PORTAL', 'NEWS_ARTICLE',
  'OFFICIAL_REGISTRY', 'LOCATION_CONFLICT', 'NOT_TARGET_ORGANIZATION',
];

// Verified against this account's GET /openai/v1/models on 2026-08-17. The Llama
// models this code used to default to (`llama-3.1-8b-instant`, and later
// `llama-3.3-70b-versatile`) both return HTTP 404 "model does not exist or you do
// not have access to it" — which is why the filter had been failing on every call.
// Of the chat models still available, only gpt-oss-120b reliably honours
// `response_format: json_object` for this prompt; gpt-oss-20b and qwen3.6-27b
// both answer 400 "Failed to validate JSON".
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';

/** Exported so the worker can name the live model in its startup banner. */
export function groqModel(): string {
  return process.env.GROQ_FILTER_MODEL || DEFAULT_GROQ_MODEL;
}

function supportsReasoningEffort(): boolean {
  return /gpt-oss|qwen3|deepseek-r1/i.test(groqModel());
}

/**
 * Thrown for statuses that mean the request will NEVER succeed as configured —
 * a wrong model name, a bad key, a revoked account. Retrying these just burns
 * one round-trip per chunk and buries the real cause under N identical warnings.
 */
class GroqConfigError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'GroqConfigError';
  }
}

const GROQ_CONFIG_ERROR_CODES = new Set([401, 403, 404]);

interface GroqVerdict {
  /** Index within the chunk. */
  i: number;
  /** Decision. UNSURE routes the candidate to the "For review" tier. */
  d: 'KEEP' | 'REJECT' | 'UNSURE';
  /** Reason code, present on REJECT. */
  c?: string;
  /** Short evidence, in the model's own words. */
  w?: string;
}

function buildPrompt(chunk: DiscoveredSite[], params: DiscoveryParams): string {
  const items = chunk
    .map((s, i) =>
      // The domain is always included. The old prompt dropped it whenever a title
      // existed, which hid the single strongest signal (e.g. booking.com).
      `${i}: [${s.domain}] ${s.title ?? '(no title)'} — ${s.snippet ?? '(no snippet)'}`)
    .join('\n');

  const p = params.persona;
  const l = params.location;

  return `You are a B2B lead qualification engine for the Bulgarian market.

TASK: For each result, decide whether the website is owned/operated BY an organization that IS ITSELF a "${p}" in or near "${l}".

CRITICAL DISTINCTION — the question is ownership/identity, not topic:
- A website that MENTIONS or LISTS "${p}" → REJECT
- A website that IS OPERATED BY a "${p}" → KEEP

Ask yourself: "Would this organization describe itself as '${p}'?"
If YES → KEEP.  If NO (they manage/list/discuss/oversee them) → REJECT.

KEEP when all of these hold:
1. The organization itself IS a ${p}
2. It is in or near "${l}"
3. The site belongs to exactly one organization

UNSURE when the title and snippet genuinely do not settle it — for example the name
could equally be one clinic or a listing site, or nothing indicates the location at
all. Prefer a definite KEEP or REJECT whenever the evidence is clear; UNSURE is for
real ambiguity, not for saving effort. A human reviews every UNSURE by hand.

REJECT with one of these codes:
- MUNICIPALITY_PAGE: city hall, община, regional government portal (even if it has a "${p}" section)
- DIRECTORY_OR_PORTAL: lists, aggregates, rates or compares multiple organizations of this type
- NEWS_ARTICLE: news article, blog post, press release, announcement
- OFFICIAL_REGISTRY: a government authority or official register that oversees "${p}" rather than being one
- LOCATION_CONFLICT: clearly based in a different city or region than "${l}"
- NOT_TARGET_ORGANIZATION: a different kind of business entirely

WORKED EXAMPLES for this exact search ("${p}" in "${l}"):
  KEEP    "[example-org.bg] ${p} — официален сайт, ${l}"  → the organization's own site
  REJECT  "[obshtina-x.bg] Община ${l} — раздел ${p}"      → MUNICIPALITY_PAGE
  REJECT  "[katalog.bg] ${p} в ${l} | Пълен списък"        → DIRECTORY_OR_PORTAL
  REJECT  "[novini.bg] Нов ${p} отваря врати в ${l}"       → NEWS_ARTICLE

Results to classify (index: [domain] title — snippet):
${items}

Return a verdict for EVERY index from 0 to ${chunk.length - 1}. Do not omit any.
"d" is "KEEP", "REJECT" or "UNSURE".
"w" is a short (max 8 words, Bulgarian or English) justification quoting what you saw.

Output ONLY valid JSON, no other text:
{"v":[{"i":0,"d":"KEEP","w":"..."},{"i":1,"d":"REJECT","c":"DIRECTORY_OR_PORTAL","w":"..."},{"i":2,"d":"UNSURE","w":"..."}]}`;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Groq's rate-limit replies carry the wait in `retry-after` (seconds). */
function retryAfterMs(res: Response, attempt: number): number {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 20_000);
  return Math.min(1_000 * 2 ** attempt, 8_000); // exponential fallback
}

async function callGroq(apiKey: string, prompt: string, attempt = 0): Promise<string> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: groqModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: GROQ_MAX_TOKENS,
      response_format: { type: 'json_object' },
      // Only reasoning models accept this, and it roughly quarters the thinking
      // tokens (130 → 30 on a 15-item chunk) with no loss on a task this
      // mechanical. Sending it to a non-reasoning model is a 400, hence the guard.
      ...(supportsReasoningEffort() ? { reasoning_effort: 'low' } : {}),
    }),
    signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
  });

  if (!res.ok) {
    // Rate limiting is transient and expected on the free tier's shared per-minute
    // token budget — wait it out rather than dumping the whole chunk into review.
    if (res.status === 429 && attempt < GROQ_RATE_LIMIT_RETRIES) {
      const waitMs = retryAfterMs(res, attempt);
      console.warn(`[discovery] Groq rate limited — retrying in ${Math.round(waitMs / 100) / 10}s`);
      await sleep(waitMs);
      return callGroq(apiKey, prompt, attempt + 1);
    }

    const body = await res.text().catch(() => '(empty)');
    if (GROQ_CONFIG_ERROR_CODES.has(res.status)) {
      throw new GroqConfigError(
        res.status,
        `Groq HTTP ${res.status} for model "${groqModel()}": ${body.slice(0, 200)}`,
      );
    }
    throw new Error(`Groq HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error('Groq returned an empty completion');
  return raw;
}

function parseVerdicts(raw: string, chunkSize: number): Map<number, GroqVerdict> {
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (!objectMatch) throw new Error(`unparseable Groq response: ${raw.slice(0, 120)}`);

  const parsed = JSON.parse(objectMatch[0]) as { v?: unknown };
  const list = Array.isArray(parsed.v) ? parsed.v : [];

  const out = new Map<number, GroqVerdict>();
  for (const entry of list as GroqVerdict[]) {
    if (typeof entry?.i !== 'number') continue;
    if (entry.i < 0 || entry.i >= chunkSize) continue;
    if (entry.d !== 'KEEP' && entry.d !== 'REJECT' && entry.d !== 'UNSURE') continue;
    out.set(entry.i, entry);
  }
  return out;
}

/** Runs one chunk, with a single retry limited to the indices that came back missing. */
async function judgeChunk(
  apiKey: string,
  chunk: DiscoveredSite[],
  params: DiscoveryParams,
  chunkNo: number,
): Promise<Map<number, GroqVerdict>> {
  const verdicts = await (async () => {
    try {
      return parseVerdicts(await callGroq(apiKey, buildPrompt(chunk, params)), chunk.length);
    } catch (err) {
      if (err instanceof GroqConfigError) throw err; // never retry a misconfiguration
      console.warn(`[discovery] Groq chunk ${chunkNo} attempt 1 failed: ${String(err)}`);
      return new Map<number, GroqVerdict>();
    }
  })();

  const missing = chunk.map((_, i) => i).filter(i => !verdicts.has(i));
  if (missing.length === 0) return verdicts;

  // Retry only the stragglers. Re-asking the whole chunk would re-hit the same
  // token ceiling that produced the gap in the first place.
  const retryChunk = missing.map(i => chunk[i]);
  try {
    const retry = parseVerdicts(
      await callGroq(apiKey, buildPrompt(retryChunk, params)),
      retryChunk.length,
    );
    for (const [retryIdx, verdict] of retry) {
      const originalIdx = missing[retryIdx];
      if (originalIdx !== undefined) verdicts.set(originalIdx, { ...verdict, i: originalIdx });
    }
  } catch (err) {
    if (err instanceof GroqConfigError) throw err;
    console.warn(`[discovery] Groq chunk ${chunkNo} retry failed: ${String(err)}`);
  }

  return verdicts;
}

/** Sends a whole chunk to review, recording why. Never accepts silently. */
function markChunkDegraded(chunk: DiscoveredSite[], detail: string): void {
  for (const site of chunk) {
    site.status = 'review';
    site.rejectionReason = 'FILTER_DEGRADED';
    site.signals.push(signal('FILTER_DEGRADED', 'REVIEW', 'llm', detail));
  }
}

/** Runs tasks with a bounded number in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function groqRelevanceFilter(
  sites: DiscoveredSite[],
  params: DiscoveryParams,
): Promise<DiscoveredSite[]> {
  const candidates = sites.filter((s) => s.status === 'kept');
  if (candidates.length === 0) return sites;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    // No key at all is a configuration state, not a runtime failure — but it must
    // not silently pass everything through as if it had been judged.
    console.warn('[discovery] GROQ_API_KEY not set — every candidate goes to review');
    for (const site of candidates) {
      site.status = 'review';
      site.rejectionReason = 'FILTER_DEGRADED';
      site.signals.push(signal(
        'FILTER_DEGRADED', 'REVIEW', 'llm',
        'LLM филтърът е изключен (липсва GROQ_API_KEY)',
      ));
    }
    return sites;
  }

  const chunks: DiscoveredSite[][] = [];
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    chunks.push(candidates.slice(i, i + CHUNK_SIZE));
  }

  console.log(
    `[discovery] Groq filter: ${candidates.length} candidates in ${chunks.length} chunks ` +
    `(model=${groqModel()}, concurrency=${CHUNK_CONCURRENCY})`,
  );

  let degradedChunks = 0;
  let configError: GroqConfigError | null = null;

  await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, async (chunk, chunkIndex) => {
    const chunkNo = chunkIndex + 1;

    // A misconfiguration fails identically for every chunk. Short-circuit the rest
    // so one wrong model name costs one request, not one per chunk.
    if (configError) {
      markChunkDegraded(chunk, `LLM филтърът е неконфигуриран: ${configError.message}`);
      degradedChunks++;
      return;
    }

    let verdicts: Map<number, GroqVerdict>;
    try {
      verdicts = await judgeChunk(apiKey, chunk, params, chunkNo);
    } catch (err) {
      if (err instanceof GroqConfigError) {
        configError = err;
        console.error(
          `[discovery] FILTER MISCONFIGURED — ${err.message}\n` +
          `[discovery] Every candidate goes to review until this is fixed. ` +
          `Set GROQ_FILTER_MODEL to a model this account can access ` +
          `(check GET https://api.groq.com/openai/v1/models).`,
        );
        markChunkDegraded(chunk, `LLM филтърът е неконфигуриран: ${err.message}`);
        degradedChunks++;
        return;
      }
      throw err;
    }

    if (verdicts.size === 0) {
      degradedChunks++;
      // Fail-open is now per chunk, and open means "review", not "accept".
      console.error(
        `[discovery] FILTER DEGRADED chunk=${chunkNo}/${chunks.length} — ` +
        `${chunk.length} candidates sent to review`,
      );
      markChunkDegraded(chunk, `LLM филтърът не отговори за тази група (${chunkNo}/${chunks.length})`);
      return;
    }

    chunk.forEach((site, i) => {
      const verdict = verdicts.get(i);

      if (!verdict) {
        site.status = 'review';
        site.rejectionReason = 'LLM_UNJUDGED';
        site.signals.push(signal(
          'LLM_UNJUDGED', 'REVIEW', 'llm',
          'LLM филтърът не даде присъда за този резултат',
        ));
        return;
      }

      if (verdict.d === 'UNSURE') {
        // The model read it and could not tell. That is a genuine middle ground,
        // not a failure — it is the case the "For review" tier exists for.
        site.status = 'review';
        site.rejectionReason = 'LLM_UNCERTAIN';
        site.signals.push(signal(
          'LLM_UNCERTAIN', 'REVIEW', 'llm',
          verdict.w?.trim() || 'LLM не можа да прецени от заглавието и описанието',
        ));
        return;
      }

      if (verdict.d === 'KEEP') {
        site.llmApproved = true;
        site.signals.push(signal(
          'MATCHES_PERSONA_AND_LOCATION', 'ACCEPT', 'llm',
          verdict.w?.trim() || `LLM: организацията отговаря на „${params.persona}“ в „${params.location}“`,
          40,
        ));
        return;
      }

      const code = (LLM_REASON_CODES.includes(verdict.c as ReasonCode)
        ? verdict.c
        : 'NOT_TARGET_ORGANIZATION') as ReasonCode;

      site.status = 'filtered';
      site.rejectionReason = code;
      site.signals.push(signal(
        code, 'REJECT', 'llm',
        verdict.w?.trim() || 'LLM отхвърли резултата',
      ));

      console.log(
        `[discovery] filtered ${site.domain} — ${code}` +
        (site.title ? ` (${site.title.slice(0, 60)})` : ''),
      );
    });

    console.log(`[discovery] Groq chunk ${chunkNo}/${chunks.length} — ${verdicts.size}/${chunk.length} judged`);
  });

  // ── Deterministic location cross-check ──────────────────────────────────────
  // Free and independent of the model. Only a genuine conflict is recorded, and
  // it argues for review rather than rejection: title+snippet is weak evidence,
  // and postCrawlVerification re-checks it against the real address later.
  for (const site of sites) {
    if (site.status !== 'kept' && site.status !== 'review') continue;
    const result = locationSignal(
      `${site.title ?? ''} ${site.snippet ?? ''}`, params.location,
    );
    if (result.kind === 'match') {
      site.signals.push(signal('MATCHES_PERSONA_AND_LOCATION', 'ACCEPT', 'location', result.detail, 15));
    } else if (result.kind === 'conflict') {
      site.signals.push(signal('LOCATION_CONFLICT', 'REVIEW', 'location', result.detail));
    }
  }

  const counts = sites.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log(
    `[discovery] Groq filter result: kept=${counts.kept ?? 0} review=${counts.review ?? 0} ` +
    `filtered=${counts.filtered ?? 0} blocked=${counts.blocked ?? 0}` +
    (degradedChunks > 0 ? ` — ${degradedChunks} DEGRADED chunk(s)` : ''),
  );

  return sites;
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Returns ALL candidates (kept + review + filtered + blocked) so the worker can
// persist them and the UI can show the full picture.

export async function discoverSites(params: DiscoveryParams): Promise<DiscoveredSite[]> {
  const provider = activeProvider();

  if (provider === 'serper') {
    if (!process.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is not set (SEARCH_PROVIDER=serper).');
  } else {
    if (!process.env.BRAVE_SEARCH_API_KEY) throw new Error('BRAVE_SEARCH_API_KEY is not set.');
  }

  console.log(`[discovery] provider=${provider} queries=${JSON.stringify(buildQueryVariations(params))}`);

  const raw = await searchViaProvider(params);
  return groqRelevanceFilter(raw, params);
}
