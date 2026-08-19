import { signal } from './types';
import type {
  DecisionSignal,
  DiscoverySourceResult,
  FilterDecision,
  PersonaSearchInput,
  ReasonCode,
  Verdict,
} from './types';
import { isSocialPlatform } from '../../lib/isSocialPlatform';
import { isEducationPersona, classifyEducationCandidate } from './educationQualification';
import { locationSignal } from './locationMatch';

/** Below this a candidate cannot be accepted; between this and ACCEPT_CONFIDENCE it goes to review. */
const REVIEW_CONFIDENCE = 40;
/** At or above this a candidate can be accepted outright. */
const ACCEPT_CONFIDENCE = 60;

// Synthetic domains used for extracted orgs that have no known website
const SYNTHETIC_DOMAIN_SUFFIX = '.local';

/** Page types that are never a lead when they ARE the search result. */
const NEGATIVE_PAGE_TYPES: Partial<Record<string, { code: ReasonCode; label: string }>> = {
  MUNICIPALITY_PAGE:   { code: 'MUNICIPALITY_PAGE',   label: 'страница на община' },
  DIRECTORY_OR_PORTAL: { code: 'DIRECTORY_OR_PORTAL', label: 'каталог или портал' },
  NEWS_ARTICLE:        { code: 'NEWS_ARTICLE',        label: 'новинарска статия' },
  SOCIAL_PAGE:         { code: 'SOCIAL_PLATFORM',     label: 'страница в социална мрежа' },
  OFFICIAL_REGISTRY:   { code: 'OFFICIAL_REGISTRY',   label: 'официален регистър' },
  IRRELEVANT:          { code: 'NOT_TARGET_ORGANIZATION', label: 'нерелевантен резултат' },
};

function extractDomain(url: string): string | undefined {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return undefined; }
}

/**
 * Folds every criterion gathered along the pipeline into one explainable verdict.
 *
 * This is the only place that decides ACCEPT / REVIEW / REJECT. Earlier stages
 * only append DecisionSignals — they never return early with a bare string — so
 * the reason shown in the UI is always the same reason that drove the outcome.
 *
 * Verdict rules, in order:
 *  1. Any REJECT signal wins outright.
 *  2. No contact/identity signal at all → REJECT.
 *  3. Any REVIEW signal (unjudged by the LLM, degraded chunk, location conflict
 *     from title+snippet, a classifier signal contradicting an LLM approval)
 *     → REVIEW.
 *  4. Confidence below ACCEPT_CONFIDENCE → REVIEW (borderline).
 *  5. Otherwise ACCEPT.
 *
 * Note the asymmetry with the old code: uncertainty used to resolve to "keep",
 * which is what let wrong-town and wrong-category sites into the results.
 */
export class CandidateQualifier {
  decide(
    candidate: DiscoverySourceResult,
    input: PersonaSearchInput,
  ): FilterDecision {
    const isExtracted = !!candidate.extractedFromUrl;
    // Signals collected upstream (search, blocklist, LLM, location cross-check).
    const signals: DecisionSignal[] = [...(candidate.signals ?? [])];
    let confidence = candidate.confidence;

    // ── Social platforms ──────────────────────────────────────────────────────
    // A social profile can never become a company domain, however it arrived.
    const socialTarget = [candidate.domain, candidate.websiteUrl].find(
      (v): v is string => !!v && isSocialPlatform(v),
    );
    if (socialTarget) {
      signals.push(signal(
        'SOCIAL_PLATFORM', 'REJECT', 'qualifier',
        `„${socialTarget}“ е профил в социална мрежа, не сайт на организация`,
      ));
    }

    // ── Page type ─────────────────────────────────────────────────────────────
    // Registries and directories are rejected however they arrived. The rest are
    // only fatal when the page IS the search result — an organization extracted
    // FROM a municipality list is exactly what we are looking for.
    const negative = NEGATIVE_PAGE_TYPES[candidate.pageType];
    if (negative) {
      const alwaysFatal =
        candidate.pageType === 'OFFICIAL_REGISTRY' ||
        candidate.pageType === 'SOCIAL_PAGE';

      if (!isExtracted || alwaysFatal) {
        signals.push(signal(
          negative.code, 'REJECT', 'classifier',
          `резултатът е ${negative.label}, а не сайт на отделна организация`,
        ));
      }
    }

    // ── Self-reference ────────────────────────────────────────────────────────
    // An org "extracted" from a page but pointing back at the same domain is a
    // link within the source site, not a separate organization.
    if (isExtracted && candidate.domain && candidate.extractedFromUrl) {
      const sourceDomain = extractDomain(candidate.extractedFromUrl);
      if (sourceDomain && candidate.domain === sourceDomain) {
        signals.push(signal(
          'SAME_DOMAIN_AS_SOURCE', 'REJECT', 'qualifier',
          `домейнът съвпада с този на списъчната страница (${sourceDomain})`,
        ));
      }
    }

    // ── Contact / identity signal ─────────────────────────────────────────────
    const hasSignal =
      (candidate.domain && !candidate.domain.endsWith(SYNTHETIC_DOMAIN_SUFFIX)) ||
      candidate.email ||
      candidate.phone;

    if (!hasSignal) {
      signals.push(signal(
        'NO_CONTACT_SIGNAL', 'REJECT', 'qualifier',
        'няма нито сайт, нито имейл, нито телефон',
      ));
    }

    // ── Extracted-from-list credit ────────────────────────────────────────────
    if (isExtracted && !negative) {
      signals.push(signal(
        'EXTRACTED_FROM_LIST', 'ACCEPT', 'qualifier',
        `извлечена от списъчна страница (${candidate.extractedFromUrl})`,
        10,
      ));
      confidence += 10;
    }

    // ── Deterministic location backstop ───────────────────────────────────────
    // Cheap, independent of the LLM, and it runs on candidates the LLM never saw
    // (extracted orgs). Only a genuine conflict is recorded, and it argues for
    // review — title/snippet is weak evidence, and postCrawlVerification will
    // re-check it against the real address once the site has been crawled.
    const alreadyChecked = signals.some(s => s.stage === 'location');
    if (!alreadyChecked) {
      const text = [candidate.name, candidate.title, candidate.snippet, candidate.address]
        .filter(Boolean).join(' ');
      const loc = locationSignal(text, input.location);
      if (loc.kind === 'match') {
        signals.push(signal('MATCHES_PERSONA_AND_LOCATION', 'ACCEPT', 'location', loc.detail, 15));
        confidence += 15;
      } else if (loc.kind === 'conflict') {
        signals.push(signal('LOCATION_CONFLICT', 'REVIEW', 'location', loc.detail));
      }
    }

    // ── Education-specific qualification ──────────────────────────────────────
    // Only when there is a name to analyse — a domain-only candidate carries no
    // textual signal and must not be penalised for it.
    if (isEducationPersona(input.persona) && (candidate.name ?? candidate.title)) {
      const ed = classifyEducationCandidate(candidate);
      if (!ed.accepted && ed.reason) {
        signals.push(signal(ed.reason, 'REJECT', 'qualifier', ed.detail));
      } else if (ed.accepted) {
        // A name that identifies a school (ДГ/ОУ/СУ + a name) is strong evidence
        // in its own right — enough to carry a table row that has only a phone.
        signals.push(signal('MATCHES_PERSONA_AND_LOCATION', 'ACCEPT', 'qualifier', ed.detail, 10));
        confidence += 10;
      }
    }

    // ── Confidence floor ──────────────────────────────────────────────────────
    confidence = Math.max(0, Math.min(100, confidence));
    if (confidence < REVIEW_CONFIDENCE) {
      signals.push(signal(
        'BELOW_CONFIDENCE_FLOOR', 'REJECT', 'qualifier',
        `общата увереност е ${confidence} (под минимума ${REVIEW_CONFIDENCE})`,
      ));
    } else if (confidence < ACCEPT_CONFIDENCE) {
      signals.push(signal(
        'BORDERLINE_CONFIDENCE', 'REVIEW', 'qualifier',
        `общата увереност е ${confidence} — между ${REVIEW_CONFIDENCE} и ${ACCEPT_CONFIDENCE}`,
      ));
    }

    // Always leave at least one positive criterion on record. An ACCEPT with an
    // empty signal list would show the user a verdict with nothing behind it —
    // and "why was this kept?" has to be as answerable as "why was this dropped?".
    if (!signals.some(s => s.effect === 'ACCEPT')) {
      signals.push(signal(
        'MATCHES_PERSONA_AND_LOCATION', 'ACCEPT', 'qualifier',
        `изглежда като сайт на отделна организация (увереност ${confidence})`,
      ));
    }

    return this.fold(signals, confidence);
  }

  /** Picks the winning verdict and the signal that justifies it. */
  private fold(signals: DecisionSignal[], confidence: number): FilterDecision {
    const firstReject = signals.find(s => s.effect === 'REJECT');
    if (firstReject) {
      return { verdict: 'REJECT', primaryReason: firstReject.criterion, confidence, signals };
    }

    const firstReview = signals.find(s => s.effect === 'REVIEW');
    if (firstReview) {
      return { verdict: 'REVIEW', primaryReason: firstReview.criterion, confidence, signals };
    }

    const firstAccept = signals.find(s => s.effect === 'ACCEPT');
    return {
      verdict: 'ACCEPT',
      primaryReason: firstAccept?.criterion ?? 'MATCHES_PERSONA_AND_LOCATION',
      confidence,
      signals,
    };
  }

  /**
   * Back-compatible wrapper.
   * @deprecated prefer `decide()` — this collapses REVIEW into "not accepted".
   */
  qualify(
    candidate: DiscoverySourceResult,
    input: PersonaSearchInput,
  ): { accepted: boolean; reason?: ReasonCode; verdict: Verdict } {
    const decision = this.decide(candidate, input);
    return {
      accepted: decision.verdict === 'ACCEPT',
      reason:   decision.verdict === 'ACCEPT' ? undefined : decision.primaryReason,
      verdict:  decision.verdict,
    };
  }

  isAccepted(candidate: DiscoverySourceResult, input: PersonaSearchInput): boolean {
    return this.decide(candidate, input).verdict === 'ACCEPT';
  }
}
