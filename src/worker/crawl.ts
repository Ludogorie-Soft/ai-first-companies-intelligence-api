import { CheerioCrawler, PlaywrightCrawler, Configuration } from 'crawlee';
import { MemoryStorage } from '@crawlee/memory-storage';
import * as cheerio from 'cheerio';
import { mergeEmails } from '../lib/emailExtraction';
import { extractPhones } from '../lib/phoneExtraction';
import { detectLoginPage } from '../services/loginDetection';
import { extractLogoUrls } from '../services/logoExtraction';
import { ClickedContact, extractClickedContacts, TEAM_CARD_SELECTORS } from '../lib/teamInteraction';
import { classifyCrawlError, resolvesInDns, CrawlErrorInfo } from './crawlErrors';
import type { Page as PlaywrightPage } from 'playwright';

export type { ClickedContact };
export type { CrawlErrorInfo };

export interface CrawledPage {
  url: string;
  text: string;
  html: string;
  emails: string[];
  phones: string[];
  loginProtected: boolean;
  logoUrls: string[];
  /** Contacts extracted by clicking team-member cards in Playwright. Undefined on Cheerio pages. */
  clickedContacts?: ClickedContact[];
}

// Contact pages get crawl priority so they're never crowded out by nav links.
const CONTACT_PATHS = ['/contact', '/contact-us', '/contacts', '/kontakti', '/контакти', '/kontakt'];

// Team / management pages — high priority after contact so people data is never cut by the slice.
const TEAM_PATHS = [
  '/team', '/about', '/about-us', '/aboutus', '/leadership', '/management', '/people', '/staff',
  '/ekip', '/za-nas', '/za-firmata',
  '/екип', '/ръководство', '/управление', '/собственици', '/за-нас', '/за-фирмата',
];

// Remaining generic fallback pages (lower priority than team pages)
const FALLBACK_PATHS = ['/services', '/history'];

// Pages where we must save the full HTML for structured extraction (team, services, etc.)
const HTML_SAVE_PATHS = [
  '/contact', '/contact-us', '/contacts', '/kontakti', '/контакти', '/kontakt',
  '/team', '/about', '/about-us', '/aboutus', '/za-nas', '/za-firmata',
  '/leadership', '/management', '/people', '/staff', '/services', '/service', '/history',
  '/ekip', '/екип', '/ръководство', '/управление', '/собственици', '/за-нас', '/за-фирмата',
];

function shouldSaveHtml(url: string): boolean {
  return HTML_SAVE_PATHS.some((p) => url.includes(p));
}


function extractNavLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const links: string[] = [];
  // Include footer and ARIA-role navigation — many Bulgarian sites skip the <nav> element
  $('nav a, header a, footer a, [role="navigation"] a').each((_i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const parsed = new URL(href, baseUrl);
      if (!parsed.href.startsWith(baseUrl)) return;
      // Skip language-variant query strings (?lang=xx) — they waste crawl slots
      if (parsed.searchParams.has('lang')) return;
      // Strip fragments; skip if what remains is just the base URL
      parsed.hash = '';
      const clean = parsed.href;
      if (clean === baseUrl || clean === baseUrl + '/') return;
      links.push(clean);
    } catch { /* ignore */ }
  });
  return [...new Set(links)].slice(0, 10);
}

// Strip trailing slash so /contacts/ and /contacts deduplicate correctly in the Set.
function normalizeUrl(url: string): string {
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
}

// Detects the contact page URL by matching anchor text or href path against contact
// keywords — handles language-prefixed paths like /en/contacts that fall outside the
// nav link slice window and would otherwise be missed entirely.
const CONTACT_KEYWORD_RE = /contact|kontakti?|контакти?/i;

// Detects team/about/leadership pages by anchor text or href — same motivation as above.
const TEAM_KEYWORD_RE = /\b(?:team|about|ekip|leadership|management|people|staff)\b|за[\s\-]нас|за[\s\-]фирмата|екип|ръководство|управлени[ея]|собственици/i;

function extractTeamPageLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const found: string[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href) return;
    const text = $(el).text().trim();
    if (!TEAM_KEYWORD_RE.test(href) && !TEAM_KEYWORD_RE.test(text)) return;
    try {
      const parsed = new URL(href, baseUrl);
      if (!parsed.href.startsWith(baseUrl)) return;
      parsed.hash = '';
      const clean = parsed.href;
      if (clean === baseUrl || clean === baseUrl + '/') return;
      found.push(clean);
    } catch { /* ignore */ }
  });
  return [...new Set(found)].slice(0, 5);
}

function extractContactPageLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const found: string[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href) return;
    const text = $(el).text().trim();
    if (!CONTACT_KEYWORD_RE.test(href) && !CONTACT_KEYWORD_RE.test(text)) return;
    try {
      const parsed = new URL(href, baseUrl);
      if (!parsed.href.startsWith(baseUrl)) return;
      parsed.hash = '';
      const clean = parsed.href;
      if (clean === baseUrl || clean === baseUrl + '/') return;
      found.push(clean);
    } catch { /* ignore */ }
  });
  return [...new Set(found)].slice(0, 3);
}

// ── URL queue builder ────────────────────────────────────────────────────────
// Exported so it can be unit-tested without importing crawlee / playwright.

export interface UrlQueueResult {
  /** All URLs to visit in the second pass, deduplicated and capped at 18. */
  urlsToVisit: string[];
  /** Team / about / management links discovered via anchor text/href in the page. */
  discoveredTeamLinks: string[];
  /** Contact page links discovered via anchor text/href. */
  discoveredContactLinks: string[];
  /**
   * TEAM_PATHS fallback guesses appended to the queue.
   * Empty when at least one team link was discovered naturally.
   */
  fallbackTeamLinks: string[];
  /**
   * CONTACT_PATHS fallback guesses appended to the queue.
   * Empty when at least one contact link was discovered naturally.
   */
  fallbackContactLinks: string[];
}

/**
 * Builds the second-pass URL queue from parsed homepage HTML.
 *
 * Priority order for team URLs:
 *   1. Links discovered via nav/anchor text (discoveredTeamLinks)
 *   2. TEAM_PATHS fallbacks — only when nothing was discovered naturally
 *
 * Same principle applies to contact pages. This prevents unnecessary 404
 * requests on sites where generic paths like /team or /about don't exist.
 */
export function buildUrlQueue(homepageHtml: string, baseUrl: string): UrlQueueResult {
  const $ = cheerio.load(homepageHtml);
  const navLinks              = extractNavLinks($, baseUrl);
  const discoveredContactLinks = extractContactPageLinks($, baseUrl);
  const discoveredTeamLinks   = extractTeamPageLinks($, baseUrl);

  // Only fall back to guessed paths when the real page wasn't discovered.
  const fallbackContactLinks = discoveredContactLinks.length === 0
    ? CONTACT_PATHS.map((p) => `${baseUrl}${p}`)
    : [];
  const fallbackTeamLinks = discoveredTeamLinks.length === 0
    ? TEAM_PATHS.map((p) => `${baseUrl}${p}`)
    : [];
  const miscFallbacks = FALLBACK_PATHS.map((p) => `${baseUrl}${p}`);

  const urlsToVisit = [...new Set([
    ...discoveredContactLinks,
    ...discoveredTeamLinks,
    ...navLinks,
    ...fallbackContactLinks,
    ...fallbackTeamLinks,
    ...miscFallbacks,
  ].map(normalizeUrl))].slice(0, 18);

  return { urlsToVisit, discoveredTeamLinks, discoveredContactLinks, fallbackTeamLinks, fallbackContactLinks };
}

function makeConfig(): Configuration {
  return new Configuration({ storageClient: new MemoryStorage({ persistStorage: false }) });
}

// ── Crawl context ────────────────────────────────────────────────────────────
// crawlCompany races the whole pipeline against CRAWL_TIMEOUT_MS. Losing that
// race used to leave the crawler — and its Chromium — running: the worker moved
// on to the next job while an orphaned browser stayed resident. Across a batch
// those accumulate until memory pressure makes healthy sites start timing out
// too. Every crawler registers here so the timeout path can tear it down.

interface Teardownable { teardown(): Promise<void>; }

interface CrawlContext {
  live: Set<Teardownable>;
  /** First classified failure seen, used to explain an empty result. */
  firstFailure?: CrawlErrorInfo;
}

function newContext(): CrawlContext {
  return { live: new Set() };
}

async function teardownAll(ctx: CrawlContext): Promise<void> {
  const crawlers = [...ctx.live];
  ctx.live.clear();
  if (crawlers.length === 0) return;
  await Promise.allSettled(crawlers.map((c) => c.teardown()));
}

/** Runs a crawler with the context registration/cleanup around it. */
async function runTracked(ctx: CrawlContext, crawler: Teardownable & { run(urls: string[]): Promise<unknown> }, urls: string[]): Promise<void> {
  ctx.live.add(crawler);
  try {
    await crawler.run(urls);
  } finally {
    ctx.live.delete(crawler);
  }
}

/**
 * Single log shape for every failed request, across both engines.
 *
 * The previous `Playwright failed: <url>` line dropped the error entirely, so a
 * dead domain, an expired certificate, a navigation timeout and a missing
 * Chromium all printed identically. The `code=` token is what makes a failure
 * diagnosable from the worker log alone.
 */
function firstLine(message: string): string {
  const nl = message.indexOf('\n');
  return nl === -1 ? message : message.slice(0, nl);
}

function logFailure(
  ctx: CrawlContext,
  engine: string,
  url: string,
  err: unknown,
  retryCount = 0,
  maxRetries = 0,
): void {
  const info = classifyCrawlError(err);
  ctx.firstFailure ??= info;
  console.error(
    `[crawl:fail] ${engine} ${url} code=${info.code} retry=${retryCount}/${maxRetries} — ` +
    firstLine(info.message).slice(0, 300),
  );
}

// Strip <script>, <style>, and <noscript> before extracting visible text so
// JSON-LD, inline JS, and CSS never bleed into extraction (e.g. location, emails).
function pageText($: cheerio.CheerioAPI): string {
  const $clean = cheerio.load($.html());
  $clean('script, style, noscript').remove();
  return $clean.root().text();
}

async function crawlWithCheerio(baseUrl: string, ctx: CrawlContext): Promise<CrawledPage[]> {
  const pages: CrawledPage[] = [];
  let homepageHtml = '';

  const firstPass = new CheerioCrawler(
    {
      maxRequestsPerCrawl: 1,
      requestHandlerTimeoutSecs: 20,
      // Default is 3. A homepage that failed twice fails the third time too,
      // and every extra attempt eats the shared CRAWL_TIMEOUT_MS budget.
      maxRequestRetries: 1,
      async requestHandler({ $, request, body }) {
        homepageHtml = body.toString();
        const text = pageText($ as unknown as cheerio.CheerioAPI);
        const emails = mergeEmails(text, homepageHtml);
        const phones = extractPhones(text);
        const { loginProtected } = detectLoginPage(homepageHtml, text);
        const logoUrls = loginProtected ? extractLogoUrls(homepageHtml, baseUrl) : [];
        pages.push({
          url: request.url,
          text,
          html: homepageHtml,
          emails,
          phones,
          loginProtected,
          logoUrls,
        });
      },
      failedRequestHandler({ request }, error) {
        logFailure(ctx, 'cheerio:first', request.url, error, request.retryCount, 1);
      },
    },
    makeConfig()
  );

  await runTracked(ctx, firstPass, [baseUrl]);
  if (pages.length === 0) return pages;

  const queue = buildUrlQueue(homepageHtml, baseUrl);
  const { urlsToVisit } = queue;
  console.log(
    `[crawl] ${baseUrl}` +
    ` discoveredTeamLinks=${JSON.stringify(queue.discoveredTeamLinks)}` +
    ` discoveredContactLinks=${JSON.stringify(queue.discoveredContactLinks)}` +
    (queue.fallbackTeamLinks.length > 0
      ? ` fallbackTeamLinks=${queue.fallbackTeamLinks.length}paths`
      : ' fallbackTeamLinks=skipped(discovered)') +
    ` urlsToVisit(${urlsToVisit.length})=${JSON.stringify(urlsToVisit)}`
  );

  const secondPass = new CheerioCrawler(
    {
      maxRequestsPerCrawl: urlsToVisit.length,
      requestHandlerTimeoutSecs: 10,
      navigationTimeoutSecs: 10,
      // These URLs are largely guesses (CONTACT_PATHS / TEAM_PATHS fallbacks).
      // Retrying a path that does not exist three times is pure waste.
      maxRequestRetries: 0,
      async requestHandler({ $, request }) {
        const text = pageText($ as unknown as cheerio.CheerioAPI);
        const html = $.html();
        const emails = mergeEmails(text, html);
        const phones = extractPhones(text);
        const { loginProtected } = detectLoginPage(html, text);
        const logoUrls = loginProtected ? extractLogoUrls(html, baseUrl) : [];
        console.log(`[crawl:page] ${request.url} — emails(${emails.length})=${JSON.stringify(emails)}`);
        pages.push({
          url: request.url,
          text,
          html: shouldSaveHtml(request.url) ? html : '',
          emails,
          phones,
          loginProtected,
          logoUrls,
        });
      },
      failedRequestHandler({ request }, error) {
        logFailure(ctx, 'cheerio:page', request.url, error, request.retryCount, 0);
      },
    },
    makeConfig()
  );

  await runTracked(ctx, secondPass, urlsToVisit);

  // Fallback hit/miss metrics — only logged when fallbacks were actually used.
  if (queue.fallbackTeamLinks.length > 0) {
    const fallbackSet = new Set(queue.fallbackTeamLinks.map(normalizeUrl));
    const hits = pages.filter((p) => fallbackSet.has(normalizeUrl(p.url)) && p.text.trim().length > 200).length;
    console.log(
      `[crawl:metrics] ${baseUrl}` +
      ` fallbackTeamAttempts=${queue.fallbackTeamLinks.length}` +
      ` fallbackTeamHits=${hits}` +
      ` fallbackTeamMisses=${queue.fallbackTeamLinks.length - hits}`
    );
  }

  return pages;
}

// ── Playwright page helpers ──────────────────────────────────────────────────

/**
 * `ignoreHTTPSErrors` is the important entry here.
 *
 * CheerioCrawler defaults to `ignoreSslErrors: true`, but crawlee only enables
 * the browser equivalent behind a MITM proxy. Since the Playwright path runs
 * ONLY when Cheerio returned almost no text, the sites that reach it are the
 * JS-rendered long tail — exactly where an expired or self-signed certificate
 * turned into an unexplained `net::ERR_CERT_*` failure.
 */
const PLAYWRIGHT_LAUNCH_OPTIONS = { headless: true, ignoreHTTPSErrors: true } as const;

/**
 * `document.body` is null for anything Chromium does not render into an HTML
 * body — a PDF or XML content type, an empty 204, a URL that triggers a
 * download. Reading `.innerText` off it threw inside the request handler,
 * which crawlee counted as a failed request and retried. The guessed fallback
 * paths (/services, /history, TEAM_PATHS) are precisely the URLs that land on
 * a PDF, so this was a routine occurrence.
 */
async function pageInnerText(page: PlaywrightPage): Promise<string> {
  return page
    .evaluate(() => document.body?.innerText ?? document.documentElement?.innerText ?? '')
    .catch(() => '');
}

async function pageHtml(page: PlaywrightPage): Promise<string> {
  return page.content().catch(() => '');
}

async function crawlWithPlaywright(baseUrl: string, ctx: CrawlContext): Promise<CrawledPage[]> {
  const pages: CrawledPage[] = [];
  let homepageHtml = '';

  const firstPass = new PlaywrightCrawler(
    {
      maxRequestsPerCrawl: 1,
      requestHandlerTimeoutSecs: 30,
      // Without this the BrowserCrawler default of 60s applies — twice the
      // handler budget above, and enough on its own to blow CRAWL_TIMEOUT_MS.
      navigationTimeoutSecs: 20,
      maxRequestRetries: 1,
      maxConcurrency: 3,
      browserPoolOptions: { maxOpenPagesPerBrowser: 3 },
      launchContext: { launchOptions: PLAYWRIGHT_LAUNCH_OPTIONS },
      async requestHandler({ page, request }) {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const html = await pageHtml(page);
        const text = await pageInnerText(page);
        if (!html && !text) return;
        homepageHtml = html;
        // Collect same-origin frame content — iframes on contact pages sometimes
        // contain the actual contact details rendered by a CMS widget.
        const origin = new URL(baseUrl).origin;
        const frameHtmlChunks: string[] = [];
        for (const frame of page.frames().slice(1)) {
          try {
            if (!frame.url().startsWith(origin)) continue;
            const fh = await frame.content().catch(() => '');
            if (fh) frameHtmlChunks.push(fh);
          } catch { /* ignore sandboxed / detached frames */ }
        }
        const combinedHtml = frameHtmlChunks.length > 0
          ? html + '\n' + frameHtmlChunks.join('\n')
          : html;
        const emails = mergeEmails(text, combinedHtml);
        const phones = extractPhones(text);
        const { loginProtected } = detectLoginPage(html, text);
        const logoUrls = loginProtected ? extractLogoUrls(html, baseUrl) : [];
        pages.push({
          url: request.url,
          text,
          html,
          emails,
          phones,
          loginProtected,
          logoUrls,
        });
      },
      failedRequestHandler({ request }, error) {
        logFailure(ctx, 'playwright:first', request.url, error, request.retryCount, 1);
      },
    },
    makeConfig()
  );

  await runTracked(ctx, firstPass, [baseUrl]);
  if (pages.length === 0 || !homepageHtml) return pages;

  const queue = buildUrlQueue(homepageHtml, baseUrl);
  const { urlsToVisit } = queue;
  console.log(
    `[crawl:playwright] ${baseUrl}` +
    ` discoveredTeamLinks=${JSON.stringify(queue.discoveredTeamLinks)}` +
    ` discoveredContactLinks=${JSON.stringify(queue.discoveredContactLinks)}` +
    (queue.fallbackTeamLinks.length > 0
      ? ` fallbackTeamLinks=${queue.fallbackTeamLinks.length}paths`
      : ' fallbackTeamLinks=skipped(discovered)') +
    ` urlsToVisit(${urlsToVisit.length})=${JSON.stringify(urlsToVisit)}`
  );

  const secondPass = new PlaywrightCrawler(
    {
      maxRequestsPerCrawl: urlsToVisit.length,
      requestHandlerTimeoutSecs: 15,
      navigationTimeoutSecs: 15,
      maxRequestRetries: 0,
      maxConcurrency: 3,
      browserPoolOptions: { maxOpenPagesPerBrowser: 3 },
      launchContext: { launchOptions: PLAYWRIGHT_LAUNCH_OPTIONS },
      async requestHandler({ page, request }) {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const text = await pageInnerText(page);
        const html = await pageHtml(page);
        if (!html && !text) return;
        const origin = new URL(baseUrl).origin;
        const frameHtmlChunks: string[] = [];
        for (const frame of page.frames().slice(1)) {
          try {
            if (!frame.url().startsWith(origin)) continue;
            const fh = await frame.content().catch(() => '');
            if (fh) frameHtmlChunks.push(fh);
          } catch { /* ignore sandboxed / detached frames */ }
        }
        const combinedHtml = frameHtmlChunks.length > 0
          ? html + '\n' + frameHtmlChunks.join('\n')
          : html;
        const emails = mergeEmails(text, combinedHtml);
        const phones = extractPhones(text);
        const { loginProtected } = detectLoginPage(html, text);
        const logoUrls = loginProtected ? extractLogoUrls(html, baseUrl) : [];
        console.log(`[crawl:playwright:page] ${request.url} — emails(${emails.length})=${JSON.stringify(emails)}`);

        // Team-card interaction: click cards to reveal contact modals.
        // Guard: only on team/contact pages that contain a known card selector
        // in the static HTML — avoids expensive interaction on unrelated pages.
        let clickedContacts: ClickedContact[] | undefined;
        if (shouldSaveHtml(request.url)) {
          const htmlLower = html.toLowerCase();
          const hasCards = TEAM_CARD_SELECTORS.some((sel) => {
            // Convert selector to a plain class/attribute keyword for a fast
            // string pre-check before we do any Playwright DOM queries.
            const kw = sel.replace(/[.[\]*"^$]/g, '').toLowerCase();
            return kw.length > 2 && htmlLower.includes(kw);
          });
          if (hasCards) {
            clickedContacts = await extractClickedContacts(page).catch(() => undefined);
            console.log(
              `[crawl:interact] ${request.url}` +
              ` — clickedContacts(${clickedContacts?.length ?? 0})=` +
              JSON.stringify((clickedContacts ?? []).map((c) => c.email ?? c.name ?? '?')),
            );
          }
        }

        pages.push({
          url: request.url,
          text,
          html: shouldSaveHtml(request.url) ? html : '',
          emails,
          phones,
          loginProtected,
          logoUrls,
          clickedContacts,
        });
      },
      failedRequestHandler({ request }, error) {
        logFailure(ctx, 'playwright:page', request.url, error, request.retryCount, 0);
      },
    },
    makeConfig()
  );

  await runTracked(ctx, secondPass, urlsToVisit);

  if (queue.fallbackTeamLinks.length > 0) {
    const fallbackSet = new Set(queue.fallbackTeamLinks.map(normalizeUrl));
    const hits = pages.filter((p) => fallbackSet.has(normalizeUrl(p.url)) && p.text.trim().length > 200).length;
    console.log(
      `[crawl:metrics] ${baseUrl}` +
      ` fallbackTeamAttempts=${queue.fallbackTeamLinks.length}` +
      ` fallbackTeamHits=${hits}` +
      ` fallbackTeamMisses=${queue.fallbackTeamLinks.length - hits}`
    );
  }

  return pages;
}

// ── Bot-protection detection ─────────────────────────────────────────────────
// These patterns match challenge/interstitial pages served instead of real content.
// We detect them AFTER crawling so that both Cheerio and Playwright attempts are covered.
// Detection does NOT attempt bypasses — it flags the company for human review.

const BOT_INDICATORS: Array<[string, RegExp]> = [
  // Cloudflare interstitial
  ['cloudflare-challenge-script',   /challenges\.cloudflare\.com/i],
  ['cloudflare-just-a-moment',      /<title[^>]*>\s*Just a moment/i],
  ['cloudflare-enable-js',          /Enable JavaScript and cookies to continue/i],
  ['cloudflare-checking',           /Checking if the site connection is secure/i],
  ['cloudflare-ray-id',             /Ray ID:\s*[0-9a-f]{16}/i],
  ['cloudflare-cf-wrapper',         /class="cf-wrapper"|cf_chl_opt\s*=/i],
  // DDoS Guard
  ['ddos-guard',                    /ddos-guard\.net/i],
  // Generic human verification
  ['verify-human',                  /Verify you are human/i],
  ['human-verification-title',      /<title[^>]*>\s*(?:Security Check|Bot Check|Human Verification)\s*<\/title>/i],
  // Plain access denied page (must be in title to avoid false positives in body copy)
  ['access-denied-title',           /<title[^>]*>\s*Access Denied\s*<\/title>/i],
  ['403-forbidden-title',           /<title[^>]*>\s*403\s+Forbidden\s*<\/title>/i],
];

export const BOT_CRAWL_NOTE =
  'Site is protected by human verification. Automated crawling could not access the content.';

export function detectBotProtection(pages: CrawledPage[]): { blocked: boolean; indicator: string } {
  for (const page of pages) {
    const content = (page.html || '') + '\n' + (page.text || '');
    for (const [indicator, pattern] of BOT_INDICATORS) {
      if (pattern.test(content)) {
        return { blocked: true, indicator };
      }
    }
  }
  return { blocked: false, indicator: '' };
}

// Pre-flight fetch for sites that return bot-protection content on 4xx responses.
// CheerioCrawler discards 4xx response bodies as failed requests, so we fetch
// the raw response first and check it for bot indicators before running crawlers.
async function fetchForBotCheck(url: string): Promise<CrawledPage | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (res.ok) return null;
    const html = await res.text();
    if (!html) return null;
    const $ = cheerio.load(html);
    const text = pageText($);
    const candidate: CrawledPage = { url, text, html, emails: [], phones: [], loginProtected: false, logoUrls: [] };
    const { blocked } = detectBotProtection([candidate]);
    return blocked ? candidate : null;
  } catch {
    return null;
  }
}

const CRAWL_TIMEOUT_MS = 120_000;

export interface CrawlResult {
  pages: CrawledPage[];
  /**
   * Why the crawl produced nothing. Undefined when pages were returned.
   * The worker uses this to write an explanatory `crawlNote` and to skip
   * pg-boss retries for causes that cannot change between attempts.
   */
  failure?: CrawlErrorInfo;
}

/**
 * Crawls a company site, reporting *why* it failed when it produces nothing.
 *
 * Order matters: the DNS preflight comes first because discovery harvests
 * domains from links on scraped pages, so dead hosts routinely reach the
 * worker. Without it a non-existent domain cost roughly two minutes and a
 * dozen Chromium launches — four crawler instances retrying, then pg-boss
 * retrying the whole job — before anyone learned the host simply does not
 * exist.
 */
export async function crawlCompanyDetailed(baseUrl: string): Promise<CrawlResult> {
  const ctx = newContext();

  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return { pages: [], failure: { code: 'UNKNOWN', retryable: false, message: `invalid URL: ${baseUrl}` } };
  }

  if (!(await resolvesInDns(hostname))) {
    console.warn(`[crawl:fail] dns ${baseUrl} code=DNS_NOT_FOUND — host does not resolve`);
    return {
      pages: [],
      failure: { code: 'DNS_NOT_FOUND', retryable: false, message: `getaddrinfo ENOTFOUND ${hostname}` },
    };
  }

  const crawl = async (): Promise<CrawledPage[]> => {
    // Pre-flight: capture bot-protection pages served on 4xx responses
    // (CheerioCrawler would silently drop the 403 body — this preserves it)
    const blockedPage = await fetchForBotCheck(baseUrl);
    if (blockedPage) return [blockedPage];

    let pages = await crawlWithCheerio(baseUrl, ctx);

    const totalText = pages.reduce((acc, p) => acc + p.text.trim().length, 0);
    if (pages.length === 0 || totalText < 200) {
      console.log(`[crawl] Cheerio got little content for ${baseUrl}, falling back to Playwright`);
      pages = await crawlWithPlaywright(baseUrl, ctx);
    }

    return pages;
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<CrawledPage[]>((resolve) => {
    timeoutId = setTimeout(() => {
      console.warn(`[crawl] timeout after ${CRAWL_TIMEOUT_MS / 1000}s for ${baseUrl}`);
      ctx.firstFailure ??= {
        code: 'TIMEOUT',
        retryable: true,
        message: `crawl exceeded ${CRAWL_TIMEOUT_MS}ms`,
      };
      resolve([]);
    }, CRAWL_TIMEOUT_MS);
  });

  // Losing the race abandons this promise but does NOT stop it — the swallow
  // keeps an abandoned crawl from surfacing as an unhandled rejection once
  // teardownAll closes the browser out from under it.
  const running = crawl();
  running.catch(() => { /* abandoned crawl — teardown below reclaims it */ });

  try {
    const pages = await Promise.race([running, timeout]);
    return { pages, failure: pages.length === 0 ? ctx.firstFailure : undefined };
  } catch (err) {
    // A browser that cannot launch throws straight out of `crawler.run()` — it
    // never reaches failedRequestHandler. Classifying it here is what lets the
    // worker record "browser engine unavailable" instead of an opaque job
    // failure retried three times against a Chromium that is not installed.
    const info = classifyCrawlError(err);
    console.error(`[crawl:fail] pipeline ${baseUrl} code=${info.code} — ${firstLine(info.message).slice(0, 300)}`);
    // A pipeline-level throw outranks ctx.firstFailure: that earlier failure was
    // recovered from by falling through to the next engine, this one ended the
    // crawl. Fall back to the recorded one only when this error is unclassified.
    return { pages: [], failure: info.code === 'UNKNOWN' ? ctx.firstFailure ?? info : info };
  } finally {
    clearTimeout(timeoutId);
    // Reclaims any crawler still live — the timeout path, and the throw path
    // where crawlee never reached its own cleanup.
    await teardownAll(ctx);
  }
}

/** Back-compatible shape for callers that only need the pages. */
export async function crawlCompany(baseUrl: string): Promise<CrawledPage[]> {
  return (await crawlCompanyDetailed(baseUrl)).pages;
}
