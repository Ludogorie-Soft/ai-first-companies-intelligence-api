import { CheerioCrawler, PlaywrightCrawler, Configuration } from 'crawlee';
import { MemoryStorage } from '@crawlee/memory-storage';
import * as cheerio from 'cheerio';
import { mergeEmails } from '../lib/emailExtraction';
import { extractPhones } from '../lib/phoneExtraction';
import { detectLoginPage } from '../services/loginDetection';
import { extractLogoUrls } from '../services/logoExtraction';
import { ClickedContact, extractClickedContacts, TEAM_CARD_SELECTORS } from '../lib/teamInteraction';

export type { ClickedContact };

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

// Strip <script>, <style>, and <noscript> before extracting visible text so
// JSON-LD, inline JS, and CSS never bleed into extraction (e.g. location, emails).
function pageText($: cheerio.CheerioAPI): string {
  const $clean = cheerio.load($.html());
  $clean('script, style, noscript').remove();
  return $clean.root().text();
}

async function crawlWithCheerio(baseUrl: string): Promise<CrawledPage[]> {
  const pages: CrawledPage[] = [];
  let homepageHtml = '';

  const firstPass = new CheerioCrawler(
    {
      maxRequestsPerCrawl: 1,
      requestHandlerTimeoutSecs: 20,
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
      failedRequestHandler({ request, log }) {
        log.error(`Failed: ${request.url}`);
      },
    },
    makeConfig()
  );

  await firstPass.run([baseUrl]);
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
      failedRequestHandler() { /* silent */ },
    },
    makeConfig()
  );

  await secondPass.run(urlsToVisit);

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

async function crawlWithPlaywright(baseUrl: string): Promise<CrawledPage[]> {
  const pages: CrawledPage[] = [];
  let homepageHtml = '';

  const firstPass = new PlaywrightCrawler(
    {
      maxRequestsPerCrawl: 1,
      requestHandlerTimeoutSecs: 30,
      launchContext: { launchOptions: { headless: true } },
      async requestHandler({ page, request }) {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const html = await page.content();
        const text = await page.evaluate(() => document.body.innerText);
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
      failedRequestHandler({ request, log }) {
        log.error(`Playwright failed: ${request.url}`);
      },
    },
    makeConfig()
  );

  await firstPass.run([baseUrl]);
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
      launchContext: { launchOptions: { headless: true } },
      async requestHandler({ page, request }) {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const text = await page.evaluate(() => document.body.innerText);
        const html = await page.content();
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
      failedRequestHandler() { /* silent */ },
    },
    makeConfig()
  );

  await secondPass.run(urlsToVisit);

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

export async function crawlCompany(baseUrl: string): Promise<CrawledPage[]> {
  const crawl = async (): Promise<CrawledPage[]> => {
    // Pre-flight: capture bot-protection pages served on 4xx responses
    // (CheerioCrawler would silently drop the 403 body — this preserves it)
    const blockedPage = await fetchForBotCheck(baseUrl);
    if (blockedPage) return [blockedPage];

    let pages = await crawlWithCheerio(baseUrl);

    const totalText = pages.reduce((acc, p) => acc + p.text.trim().length, 0);
    if (pages.length === 0 || totalText < 200) {
      console.log(`[crawl] Cheerio got little content for ${baseUrl}, falling back to Playwright`);
      pages = await crawlWithPlaywright(baseUrl);
    }

    return pages;
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<CrawledPage[]>((resolve) => {
    timeoutId = setTimeout(() => {
      console.warn(`[crawl] timeout after ${CRAWL_TIMEOUT_MS / 1000}s for ${baseUrl}`);
      resolve([]);
    }, CRAWL_TIMEOUT_MS);
  });

  try {
    return await Promise.race([crawl(), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}
