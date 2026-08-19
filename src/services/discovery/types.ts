export type PageType =
  | 'TARGET_ORGANIZATION'
  | 'OFFICIAL_REGISTRY'
  | 'MUNICIPALITY_PAGE'
  | 'DIRECTORY_OR_PORTAL'
  | 'NEWS_ARTICLE'
  | 'SOCIAL_PAGE'
  | 'IRRELEVANT'
  | 'UNKNOWN';

// ── Decision record ───────────────────────────────────────────────────────────
// Every filtering stage appends a DecisionSignal instead of returning a bare
// string; CandidateQualifier folds the accumulated signals into one FilterDecision.
// This is what makes a verdict explainable in the UI — and it is why accepts now
// carry a reason too, not only rejects.

export type Verdict = 'ACCEPT' | 'REVIEW' | 'REJECT';

/**
 * Stable machine codes. The frontend maps each to a translated label, so these
 * strings are part of the API contract — rename one and the UI silently falls
 * back to the raw code.
 */
export type ReasonCode =
  // ── Reject ────────────────────────────────────────────────────────────────
  | 'BLOCKLISTED_AGGREGATOR'
  | 'MUNICIPALITY_PAGE'
  | 'DIRECTORY_OR_PORTAL'
  | 'NEWS_ARTICLE'
  | 'SOCIAL_PLATFORM'
  | 'OFFICIAL_REGISTRY'
  | 'LOCATION_CONFLICT_VERIFIED'
  | 'NOT_TARGET_ORGANIZATION'
  | 'BELOW_CONFIDENCE_FLOOR'
  | 'NO_CONTACT_SIGNAL'
  | 'SAME_DOMAIN_AS_SOURCE'
  | 'NON_CRAWLABLE_PLATFORM'
  | 'USER_REJECTED'
  // ── Review (uncertain — needs a human) ────────────────────────────────────
  /** The LLM read the result and explicitly could not tell. Distinct from
   *  LLM_UNJUDGED (never answered) and FILTER_DEGRADED (the call failed). */
  | 'LLM_UNCERTAIN'
  | 'LLM_UNJUDGED'
  | 'FILTER_DEGRADED'
  | 'LOCATION_CONFLICT'
  | 'LOCATION_UNKNOWN'
  | 'CONFLICTING_SIGNALS'
  | 'BORDERLINE_CONFIDENCE'
  // ── Accept ────────────────────────────────────────────────────────────────
  | 'MATCHES_PERSONA_AND_LOCATION'
  | 'EXTRACTED_FROM_LIST'
  | 'USER_INCLUDED';

/** Which part of the pipeline produced a signal. Shown as a column in the UI. */
export type DecisionStage =
  | 'search'
  | 'blocklist'
  | 'llm'
  | 'classifier'
  | 'location'
  | 'qualifier'
  | 'post_crawl';

/** One criterion that fired, with the evidence behind it. */
export interface DecisionSignal {
  criterion: ReasonCode;
  /** What this single signal argues for, independently of the final verdict. */
  effect: Verdict;
  stage: DecisionStage;
  /** Human-readable evidence, e.g. `адрес „гр. Варна“ ≠ търсено „Мездра“`. */
  detail?: string;
  /** Contribution to the confidence score, for signals that carry weight. */
  weight?: number;
}

export interface FilterDecision {
  verdict: Verdict;
  /** The signal that decided the verdict — what the UI shows in the Reason column. */
  primaryReason: ReasonCode;
  confidence: number;
  /** Every criterion that fired, in evaluation order. */
  signals: DecisionSignal[];
}

export function signal(
  criterion: ReasonCode,
  effect: Verdict,
  stage: DecisionStage,
  detail?: string,
  weight?: number,
): DecisionSignal {
  return { criterion, effect, stage, detail, weight };
}

export interface PersonaSearchInput {
  persona: string;
  location: string;
  keywords?: string;
  maxResults?: number;
}

/** A single candidate produced by any discovery source. */
export interface DiscoverySourceResult {
  /** Human-readable organization name (key field for extracted orgs). */
  name?: string;
  /** Hostname without www. E.g. "dg-slance.bg". Undefined for orgs with no known website. */
  domain?: string;
  /** Full URL of the organization's website or contact page. */
  websiteUrl?: string;
  /** Direct URL to a contact/about page if different from websiteUrl. */
  contactPageUrl?: string;
  /** Pre-crawl email discovered during page extraction. */
  email?: string;
  /** Pre-crawl phone discovered during page extraction. */
  phone?: string;
  /** Pre-crawl address discovered during page extraction. */
  address?: string;
  /** URL of the search result or registry page this candidate came from. */
  sourceUrl: string;
  /** How this candidate was found. */
  sourceType: 'registry' | 'search' | 'municipality' | 'directory' | 'manual';
  /** 0-100 confidence that this is a valid target organization. */
  confidence: number;
  /** Classification of the page at sourceUrl. */
  pageType: PageType;
  /** URL of the parent list page when this org was extracted from a directory/municipality page. */
  extractedFromUrl?: string;
  /** Title / heading from the search result or page. */
  title?: string;
  /** Snippet / short description from the search result. */
  snippet?: string;
  /**
   * True when the LLM filter explicitly kept this candidate. Downstream heuristics
   * read the same title+snippet the LLM already judged, so they need a higher bar
   * before overturning it — see PageClassifier's minScore.
   */
  llmApproved?: boolean;
  /** Signals gathered before qualification (blocklist, LLM, location). */
  signals?: DecisionSignal[];
  /** Final decision, set by CandidateQualifier. */
  decision?: FilterDecision;
}

/** A pluggable source that produces discovery candidates. */
export interface DiscoverySource {
  readonly name: string;
  canHandle(input: PersonaSearchInput): boolean;
  discover(input: PersonaSearchInput): Promise<DiscoverySourceResult[]>;
}

export interface OrchestrationResult {
  /** Candidates that passed qualification — ready to upsert as Companies and enqueue for crawling. */
  accepted: DiscoverySourceResult[];
  /** Candidates the pipeline is not confident about — surfaced in the "For review" tab, never crawled automatically. */
  review: DiscoverySourceResult[];
  /** Candidates that were rejected with a reason (municipality pages, news, low confidence, etc.). */
  rejected: DiscoverySourceResult[];
  /** All candidates including rejected — persisted to DB for UI transparency. */
  allCandidates: DiscoverySourceResult[];
}
