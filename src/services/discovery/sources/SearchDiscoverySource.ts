// Note: imports from ../../discovery resolve to src/services/discovery.ts (the existing file),
// NOT to this directory — TypeScript resolves the .ts file before the folder.
import { discoverSites } from '../../discovery';
import type { DiscoverySource, DiscoverySourceResult, PageType, PersonaSearchInput, ReasonCode } from '../types';

function mapRejectionToPageType(reason: ReasonCode | undefined): PageType {
  switch (reason) {
    case 'MUNICIPALITY_PAGE':       return 'MUNICIPALITY_PAGE';
    case 'DIRECTORY_OR_PORTAL':     return 'DIRECTORY_OR_PORTAL';
    case 'BLOCKLISTED_AGGREGATOR':  return 'DIRECTORY_OR_PORTAL';
    case 'NEWS_ARTICLE':            return 'NEWS_ARTICLE';
    case 'OFFICIAL_REGISTRY':       return 'OFFICIAL_REGISTRY';
    case 'SOCIAL_PLATFORM':         return 'SOCIAL_PAGE';
    case 'LOCATION_CONFLICT':       return 'IRRELEVANT';
    case 'NOT_TARGET_ORGANIZATION': return 'IRRELEVANT';
    default:                        return 'UNKNOWN';
  }
}

/**
 * Confidence assigned per search-stage status. The qualifier's ACCEPT bar is 60
 * and its REVIEW floor is 40, so:
 *   kept    (LLM said yes)      → clears ACCEPT on its own
 *   review  (LLM never said)    → lands in the review band, never auto-accepted
 *   filtered/blocked            → below the floor, rejected
 */
const CONFIDENCE_BY_STATUS = {
  kept:     70,
  review:   45,
  filtered: 20,
  blocked:   0,
} as const;

/**
 * Wraps the existing discoverSites() (Brave / Serper search + Groq filter)
 * and maps its output to the DiscoverySourceResult interface.
 *
 * Always available as the fallback source.
 */
export class SearchDiscoverySource implements DiscoverySource {
  readonly name = 'SearchDiscoverySource';

  canHandle(_input: PersonaSearchInput): boolean {
    return true;
  }

  async discover(input: PersonaSearchInput): Promise<DiscoverySourceResult[]> {
    const raw = await discoverSites({
      persona:    input.persona,
      location:   input.location,
      keywords:   input.keywords,
      maxResults: input.maxResults,
    });

    return raw.map((site): DiscoverySourceResult => {
      const pageType: PageType =
        site.status === 'blocked'  ? 'IRRELEVANT'
      : site.status === 'filtered' ? mapRejectionToPageType(site.rejectionReason)
      // 'kept' and 'review' stay UNKNOWN — PageClassifier refines them in the
      // orchestrator, at a bar that depends on whether the LLM approved them.
      :                              'UNKNOWN';

      return {
        name:       site.title,
        domain:     site.domain,
        websiteUrl: `https://${site.domain}`,
        sourceUrl:  site.url,
        sourceType: 'search',
        confidence: CONFIDENCE_BY_STATUS[site.status],
        pageType,
        title:       site.title,
        snippet:     site.snippet,
        llmApproved: site.llmApproved,
        signals:     site.signals,
      };
    });
  }
}
