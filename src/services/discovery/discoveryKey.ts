/**
 * Version of the filtering rules. A cache hit copies candidate rows verbatim —
 * status, reason and signals included — and enqueues the KEPT ones without
 * re-qualifying them, so ANY change to the filtering logic must bump this or
 * repeat searches keep replaying the old verdicts for the full 30-day window.
 *
 * v2: three-verdict decision record, chunked LLM filter, location matching,
 *     post-crawl verification.
 */
export const FILTER_VERSION = 'v2';

/**
 * Builds a normalized cache key for persona discovery searches.
 *
 * Key format: "<filterVersion>|<persona>|<location>|<keywords>"
 * Used to detect repeat searches within the 30-day freshness window
 * so we can skip expensive Serper/Groq calls.
 */
export function buildDiscoveryKey(
  persona: string,
  location: string,
  keywords?: string,
): string {
  return [
    FILTER_VERSION,
    normalizeText(persona),
    normalizeLocation(location),
    normalizeKeywords(keywords),
  ].join('|');
}

function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeLocation(location: string): string {
  return normalizeText(location)
    // Strip leading city prefix: "гр.", "гр ", "град " — "гр. Враца" == "Враца"
    .replace(/^(гр\.|гр |град )/, '')
    .trim();
}

function normalizeKeywords(keywords?: string): string {
  if (!keywords?.trim()) return '';
  return keywords
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .split(' ')
    .sort()
    .join(' ');
}
