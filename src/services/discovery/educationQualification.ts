import type { DiscoverySourceResult, ReasonCode } from './types';

// ── Persona detection ─────────────────────────────────────────────────────────

/** Multi-letter words — safe to match as substrings. */
const EDUCATION_PERSONA_PHRASES = [
  'училище', 'училища',
  'гимназия', 'гимназии',
  'детска градина', 'детски градини', 'детска ясла', 'детски ясли',
  'kindergarten',
  'school', 'schools',
  'образование', 'education',
];

/**
 * School-type abbreviations. These MUST be matched as whole tokens: as substrings
 * they swallow ordinary words — "суши" and "супермаркети" both contain "су", which
 * routed every sushi search through the education gate and rejected real restaurants.
 */
const EDUCATION_PERSONA_ABBREVIATIONS = ['оу', 'су', 'пг', 'дг', 'цдг', 'сузид', 'ну'];

export function isEducationPersona(persona: string): boolean {
  const lower = persona.toLowerCase();
  if (EDUCATION_PERSONA_PHRASES.some(k => lower.includes(k))) return true;

  const tokens = lower.split(/[^\p{L}]+/u).filter(Boolean);
  return tokens.some(tok => EDUCATION_PERSONA_ABBREVIATIONS.includes(tok));
}

// ── School name prefix detection ──────────────────────────────────────────────
// Matches "ОУ ", "СУ ", "ПГ ", etc. at the start of a name (case-insensitive).
// The delimiter class is not just \s: Bulgarian schools are written ОУ„Христо
// Ботев“ and ДГ"Слънце" as often as with a space, and requiring whitespace made
// the strongest positive signal miss exactly those names.

const SCHOOL_PREFIX_RE = new RegExp(
  '^(?:оу|су|пг|пмг|ппмг|нпг|пгт|пгхт|пгмет|пгсс|пге|пгасг|пги|пгтм|птг|дг|цдг|дс|дя|ну|пу|ог|суе|сое|профилирана гимназия|природо|математическа)[\\s„“"\'`.\\-–—]',
  'i',
);

// ── Educational keywords anywhere in name ─────────────────────────────────────
// Note: \b is intentionally omitted for Cyrillic terms — JS regex \b only works
// with ASCII word characters (\w = [a-zA-Z0-9_]), so Cyrillic chars are treated
// as \W and word-boundary assertions never fire around them.

const EDUCATION_KEYWORD_RE =
  /училище|гимназия|school|kindergarten|детска\s+градина|детски\s+ясли|университет|академия|колеж|школа|институт|institute|образовател/i;

// ── Hard-reject patterns (checked before scoring) ─────────────────────────────
// \b is kept only for pure-ASCII patterns where it works reliably.

const NEGATIVE_PATTERNS: Array<{ re: RegExp; reason: ReasonCode; label: string }> = [
  { re: /община|municipality|кметство/i,                       reason: 'MUNICIPALITY_PAGE',      label: 'община / кметство' },
  { re: /регистър|registar|\bregist(?:er|ry)\b/i,              reason: 'OFFICIAL_REGISTRY',      label: 'регистър'          },
  { re: /\bdirectory\b|каталог|catalog|справочник|директория/i, reason: 'DIRECTORY_OR_PORTAL',    label: 'каталог'           },
  { re: /рейтинг|\branking\b|класация/i,                       reason: 'DIRECTORY_OR_PORTAL',    label: 'класация'          },
  { re: /\bguide\b|наръчник/i,                                 reason: 'DIRECTORY_OR_PORTAL',    label: 'наръчник'          },
  { re: /портал|\bportal\b/i,                                  reason: 'DIRECTORY_OR_PORTAL',    label: 'портал'            },
  { re: /новини|\bnews\b|форум|\bforum\b/i,                    reason: 'NEWS_ARTICLE',           label: 'новини / форум'    },
];

// ── Domain-level negative check (for non-extracted direct candidates only) ────

const NEGATIVE_DOMAIN_RE =
  /(?:guide|directory|catalog|portal|register|registar|spravochnik)/i;

// ── Result type ───────────────────────────────────────────────────────────────

export interface EducationQualificationResult {
  accepted: boolean;
  confidence: number;
  reason?: ReasonCode;
  /** Human-readable evidence for the decision. */
  detail?: string;
}

/**
 * True when the name identifies a specific school or kindergarten by itself —
 * a prefix like ДГ/ОУ/СУ plus a name, or an explicit educational keyword.
 *
 * This overrides the incidental hard-rejects below. "ДГ „Слънце“ – Община Мездра"
 * is a kindergarten that mentions its municipality, not a municipal portal, and
 * "ОУ Христо Ботев – Новини" is a school's news page, not a news site.
 */
function identifiesSchool(name: string): boolean {
  return SCHOOL_PREFIX_RE.test(name) || EDUCATION_KEYWORD_RE.test(name);
}

/**
 * Classifies a single discovery candidate for education persona searches.
 *
 * Scoring model:
 *   Baseline:            30
 *   +40  school prefix present (ОУ, СУ, ПГ, ДГ, ...)
 *   +20  educational keyword present
 *   +10  has own dedicated website domain
 *   +10  has pre-crawl contact info (email or phone)
 *   Accept threshold: >= 60
 *
 *   Hard-reject: name matches municipality / registry / directory / ranking /
 *                guide / portal / news patterns (score is irrelevant).
 *   Hard-reject: domain matches directory patterns (non-extracted candidates only).
 *
 * Special case (requirement 8): if the candidate has a social platform domain,
 * it is already rejected upstream by CandidateQualifier; this function is not
 * reached for social-domain candidates.
 */
export function classifyEducationCandidate(
  candidate: DiscoverySourceResult,
): EducationQualificationResult {
  const name = (candidate.name ?? candidate.title ?? '').trim();
  const domain = candidate.domain ?? '';
  const isSchoolName = identifiesSchool(name);

  // ── Step 1: hard-reject by name ────────────────────────────────────────────
  // Skipped when the name already identifies a school — otherwise a kindergarten
  // whose title mentions its own municipality gets rejected as a municipal portal.
  if (!isSchoolName) {
    for (const { re, reason, label } of NEGATIVE_PATTERNS) {
      if (re.test(name)) {
        console.log(`[education] rejected name="${name}" reason=${reason}`);
        return {
          accepted: false, confidence: 0, reason,
          detail: `името „${name}“ съдържа „${label}“ и не идентифицира учебно заведение`,
        };
      }
    }
  }

  // ── Step 2: hard-reject by domain (direct candidates only) ────────────────
  // "unless the extracted organization has its own website domain"
  if (!candidate.extractedFromUrl && domain && NEGATIVE_DOMAIN_RE.test(domain)) {
    console.log(`[education] rejected name="${name}" domain="${domain}" reason=directory_domain`);
    return {
      accepted: false, confidence: 0, reason: 'DIRECTORY_OR_PORTAL',
      detail: `домейнът „${domain}“ изглежда като каталог или справочник`,
    };
  }

  // ── Step 3: positive confidence scoring ───────────────────────────────────
  let confidence = 30;
  const evidence: string[] = [];

  if (SCHOOL_PREFIX_RE.test(name)) {
    confidence += 40; // strong: ОУ, СУ, ПГ…
    evidence.push('името започва със съкращение за учебно заведение');
  }
  if (EDUCATION_KEYWORD_RE.test(name)) {
    confidence += 20; // keyword: училище, гимназия…
    evidence.push('името съдържа образователна дума');
  }
  if (domain && !domain.endsWith('.local')) {
    confidence += 10; // has own website
    evidence.push('има собствен домейн');
  }
  if (candidate.email || candidate.phone) {
    confidence += 10; // has contact
    evidence.push('има контактни данни');
  }

  if (confidence >= 60) {
    console.log(`[education] accepted school name="${name}" confidence=${confidence}`);
    return { accepted: true, confidence, detail: evidence.join('; ') };
  }

  console.log(
    `[education] rejected name="${name}" reason=insufficient_education_confidence` +
    ` confidence=${confidence}`,
  );
  return {
    accepted: false,
    confidence,
    reason: 'NOT_TARGET_ORGANIZATION',
    detail:
      `името „${name}“ не идентифицира учебно заведение ` +
      `(увереност ${confidence} < 60)`,
  };
}
