import type { DiscoverySource, DiscoverySourceResult, PersonaSearchInput } from '../types';
import { OrganizationExtractor } from '../OrganizationExtractor';
import { PageClassifier } from '../PageClassifier';
import { rawSearch } from '../../../lib/search';

const EDUCATION_KEYWORDS = [
  'детски градини', 'детска градина', 'дг ', 'яслена', 'детски ясли', 'ясла',
  'училища', 'начално училище', 'основно училище', 'средно училище', 'гимназия',
];

async function fetchSearchResults(query: string): Promise<Array<{ url: string; title?: string }>> {
  try {
    // Bulgarian-specific options: routes through Brave (primary) → Serper (fallback)
    return await rawSearch(query, { country: 'bg', language: 'bg', num: 5 });
  } catch {
    return [];
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BizDevBot/1.0)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Supplementary discovery source for education categories (детски градини, училища, etc.).
 *
 * Strategy:
 *  1. Build queries that specifically target official municipality education pages
 *     (e.g., "детски градини гр. Мездра регистър сайт:mezdra.bg")
 *  2. Fetch each result page
 *  3. Use PageClassifier + OrganizationExtractor to harvest org candidates
 *
 * This source runs IN ADDITION TO SearchDiscoverySource; the orchestrator merges
 * and deduplicates all candidates.
 */
export class EducationRegistrySource implements DiscoverySource {
  readonly name = 'EducationRegistrySource';

  private classifier = new PageClassifier();
  private extractor = new OrganizationExtractor();

  canHandle(input: PersonaSearchInput): boolean {
    const lower = input.persona.toLowerCase();
    return EDUCATION_KEYWORDS.some(kw => lower.includes(kw));
  }

  async discover(input: PersonaSearchInput): Promise<DiscoverySourceResult[]> {
    const results: DiscoverySourceResult[] = [];

    // Education-specific queries that prioritize official/municipality list pages
    const queries = [
      `${input.persona} ${input.location} регистър официален`,
      `${input.persona} ${input.location} списък директори телефони`,
      `${input.persona} ${input.location} сайт на общината`,
    ];

    for (const query of queries) {
      const searchResults = await fetchSearchResults(query);

      for (const sr of searchResults.slice(0, 3)) {
        // Quick meta classification
        const { type: metaType } = this.classifier.classifyFromMeta(sr.url, sr.title ?? '', '', input);

        // We're specifically looking for registry / municipality pages here
        if (
          metaType !== 'MUNICIPALITY_PAGE' &&
          metaType !== 'OFFICIAL_REGISTRY' &&
          metaType !== 'UNKNOWN'
        ) {
          continue;
        }

        const html = await fetchHtml(sr.url);
        if (!html) continue;

        const { type: contentType } = this.classifier.classifyFromContent(html, sr.url, input);
        if (
          contentType === 'MUNICIPALITY_PAGE' ||
          contentType === 'OFFICIAL_REGISTRY' ||
          contentType === 'DIRECTORY_OR_PORTAL'
        ) {
          console.log(`[discovery:education] found registry/municipality page: ${sr.url}`);
          const extracted = await this.extractor.extractOrganizations(html, sr.url, input);
          console.log(`[discovery:education] extracted ${extracted.length} orgs from ${sr.url}`);
          results.push(...extracted);
        }
      }
    }

    return results;
  }
}
