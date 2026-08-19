import { promises as dns } from 'node:dns';

/**
 * Failure taxonomy for a crawl attempt.
 *
 * Every crawler in `crawl.ts` used to report failures as a bare
 * `Playwright failed: <url>` line, which made DNS failures, TLS failures,
 * navigation timeouts, null-document handler crashes and missing Chromium
 * binaries all look identical in the worker log. These codes exist so a
 * failure names its own cause.
 */
export type CrawlErrorCode =
  | 'DNS_NOT_FOUND'
  | 'TLS_ERROR'
  | 'CONNECTION_REFUSED'
  | 'TIMEOUT'
  | 'BROWSER_LAUNCH'
  | 'EMPTY_DOCUMENT'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'HTTP_5XX'
  | 'UNKNOWN';

export interface CrawlErrorInfo {
  code: CrawlErrorCode;
  /** Whether retrying the same URL could plausibly succeed. */
  retryable: boolean;
  message: string;
}

// Only these three describe a condition that can change between attempts.
// A host that does not resolve, a certificate that does not validate, a
// Chromium that is not installed and a document with no body will fail
// identically on every retry.
const RETRYABLE: ReadonlySet<CrawlErrorCode> = new Set<CrawlErrorCode>([
  'TIMEOUT',
  'CONNECTION_REFUSED',
  'HTTP_5XX',
]);

// Ordered — the first match wins, so more specific patterns come first.
// `EMPTY_DOCUMENT` precedes the network codes because its message
// ("Cannot read properties of null …") is thrown from inside our own
// requestHandler and must not be misread as a transport failure.
const PATTERNS: Array<[CrawlErrorCode, RegExp]> = [
  ['EMPTY_DOCUMENT',     /reading '(?:innerText|content)'|null \(reading|undefined \(reading/i],
  // Crawlee rejects a root URL that serves a PDF, an octet-stream or an image
  // before our handler ever runs. Retrying cannot change the Content-Type.
  ['UNSUPPORTED_CONTENT_TYPE', /served Content-Type .* but only .* are allowed|Skipping resource/i],
  ['BROWSER_LAUNCH',     /Executable doesn'?t exist|browserType\.launch|playwright install|Failed to launch|Target closed|browser has been closed/i],
  ['DNS_NOT_FOUND',      /ENOTFOUND|ERR_NAME_NOT_RESOLVED|EAI_AGAIN|getaddrinfo|ERR_NAME_RESOLUTION_FAILED/i],
  ['TLS_ERROR',          /ERR_CERT_|ERR_SSL_|ERR_BAD_SSL|unable to verify the first certificate|self.signed certificate|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED|ERR_TLS/i],
  ['CONNECTION_REFUSED', /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_CONNECTION_|socket hang up/i],
  ['TIMEOUT',            /TimeoutError|Navigation timeout|navigation timeout|timed? ?out|ETIMEDOUT|exceeded.*timeout|timeout.*exceeded/i],
  ['HTTP_5XX',           /\b5\d{2}\b\s*-\s|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out/i],
];

function errorText(err: unknown): string {
  if (err instanceof Error) {
    // Playwright puts the useful `net::ERR_*` token in the message, but node
    // errors carry the code only on the property — read both.
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code} ${err.message}` : err.message;
  }
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

/**
 * Maps a thrown crawl error onto a {@link CrawlErrorCode}.
 *
 * Deliberately free of any crawlee / playwright import so it can be unit
 * tested on its own, the same way `buildUrlQueue` is.
 */
export function classifyCrawlError(err: unknown): CrawlErrorInfo {
  const message = errorText(err).trim();

  for (const [code, pattern] of PATTERNS) {
    if (pattern.test(message)) {
      // EAI_AGAIN is a resolver hiccup, not a dead domain — it classifies as
      // DNS but must stay retryable, or one flaky lookup permanently kills a
      // real company.
      const retryable = RETRYABLE.has(code) || /EAI_AGAIN/i.test(message);
      return { code, retryable, message };
    }
  }

  return { code: 'UNKNOWN', retryable: true, message: message || 'unknown error' };
}

/** Short, human-readable note stored on `Company.crawlNote` for a terminal failure. */
export function crawlNoteFor(info: CrawlErrorInfo): string | undefined {
  switch (info.code) {
    case 'DNS_NOT_FOUND':
      return 'Domain does not resolve (DNS). The website no longer exists.';
    case 'TLS_ERROR':
      return 'Site has an invalid TLS certificate and could not be loaded securely.';
    case 'CONNECTION_REFUSED':
      return 'Site refused the connection.';
    case 'TIMEOUT':
      return 'Site did not respond within the crawl budget.';
    case 'BROWSER_LAUNCH':
      return 'Browser engine unavailable on the worker — crawl could not be attempted.';
    case 'UNSUPPORTED_CONTENT_TYPE':
      return 'URL does not serve a web page (unsupported content type).';
    default:
      return undefined;
  }
}

// ── DNS preflight ────────────────────────────────────────────────────────────

const DNS_TIMEOUT_MS = 4_000;

/**
 * Per-process memo. Discovery frequently yields the same host several times in
 * one batch, and a dead domain is dead for the whole run.
 */
const dnsCache = new Map<string, boolean>();

/** Test seam — lets a suite reset state between cases. */
export function _clearDnsCache(): void {
  dnsCache.clear();
}

/**
 * Resolves `false` ONLY for a definitive NXDOMAIN.
 *
 * A transient resolver failure (`EAI_AGAIN`, a timeout) resolves `true` on
 * purpose: a flaky local DNS must never mass-fail an entire batch. Being
 * wrong in that direction costs one normal crawl attempt; being wrong in the
 * other direction silently discards real companies.
 */
export async function resolvesInDns(hostname: string): Promise<boolean> {
  const key = hostname.toLowerCase();
  const cached = dnsCache.get(key);
  if (cached !== undefined) return cached;

  let ok = true;
  try {
    const lookup = dns.lookup(key, { all: false });
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), DNS_TIMEOUT_MS).unref?.(),
    );
    // Either outcome means "not proven dead": a successful lookup resolves,
    // and a slow resolver tells us nothing about the domain.
    await Promise.race([lookup, timeout]);
    ok = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    ok = code !== 'ENOTFOUND';
  }

  dnsCache.set(key, ok);
  return ok;
}
