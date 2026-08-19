import * as cheerio from 'cheerio';
import { domainToUnicode } from 'url';
import type { PageType, PersonaSearchInput } from './types';
import { isSocialPlatform } from '../../lib/isSocialPlatform';
import { transliterate } from './locationMatch';

// Bulgarian municipality URL path segments that indicate a government/municipality page
const MUNICIPALITY_PATH_SEGMENTS = [
  'obrazovanie', 'obshtinska', 'administracia', 'obstinskisavet', 'obshinskisavet',
  'deynost', 'registri', 'uslugi', 'obshtestveni', 'kmetstvo', 'kmet',
  'detski-gradini', 'detskata-gradini', 'uchilishta', 'zdraveopazvane',
  'sotsialni', 'kultura', 'sport', 'ekologia', 'byudzhet', 'naredbi',
];

// Bulgarian news/media URL path segments
const NEWS_PATH_SEGMENTS = [
  'novini', 'news', 'press', 'aktualno', 'statii', 'blog', 'publikacii',
  'sobitivia', 'arhiv',
];

// Title/text keywords that signal a municipality or government page
const MUNICIPALITY_TEXT_SIGNALS = [
  'община ', 'общинска ', 'кмет ', 'кметство ', 'общински съвет',
  'администрация на', 'официален сайт на община',
];

// Signals that a page is an official registry
const REGISTRY_TEXT_SIGNALS = [
  'регистър на', 'регистри на', 'списък на', 'по реда на', 'по чл.',
  'наредба №', 'заповед №', 'регистрирани',
];

// Signals that a page is a directory/portal aggregating many orgs.
// 'резулт' and 'всички ' used to be here; both are ordinary Bulgarian words that
// appear on plenty of single-organization sites ("всички права запазени"), and
// each on its own was enough to reject a real lead.
const DIRECTORY_TEXT_SIGNALS = [
  'каталог', 'директория', 'пълен списък', 'намерени резулт',
  'сортирай', 'филтрирай', 'покажи повече',
];

// Tokens excluded from the "a repeated word means a listing page" rule.
// The HTML-entity residue is defence in depth: cleanSearchText() strips it from
// search snippets, but text taken from a fetched page can still carry it, and a
// school quoting its own name four times produced four "quot" tokens.
const REPETITION_STOPWORDS = new Set([
  'quot', 'amp', 'nbsp', 'strong', 'apos', 'hellip', 'mdash', 'ndash',
  'https', 'http', 'www', 'com',
  'която', 'който', 'което', 'както', 'този', 'тази', 'това', 'през', 'като',
]);

// Signals that a page is a news article
const NEWS_TEXT_SIGNALS = [
  'публикувано на ', 'публикувано:', 'автор:', 'прочети повече', 'споделяне',
  'коментари (', 'следваща статия', 'предишна статия', 'тагове:', 'категория:',
];

// Regex for Bulgarian phone numbers
const PHONE_RE = /0[789]\d{2}[\s\-.]?\d{3}[\s\-.]?\d{3}|(?:\+359|00359)\d{2}[\s\-.]?\d{3}[\s\-.]?\d{3}|\d{3,5}[\s\-]\d{3,6}/g;
// Regex for emails
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

type ScoreMap = Partial<Record<PageType, number>>;

/** The classifier's verdict plus the evidence behind it. */
export interface Classification {
  type: PageType;
  /** Score of the winning type. Below `minScore` the type is downgraded to UNKNOWN. */
  score: number;
  /** Human-readable descriptions of the signals that fired, strongest first. */
  evidence: string[];
}

/**
 * Default bar for accepting a classification. A candidate the LLM already approved
 * is passed a higher bar by the orchestrator — see DEFAULT_MIN_SCORE vs
 * LLM_APPROVED_MIN_SCORE.
 */
export const DEFAULT_MIN_SCORE = 30;

/**
 * The bar an LLM-approved candidate has to clear to be reclassified.
 *
 * classifyFromMeta reads exactly the same title and snippet the LLM already
 * judged, so a single keyword must not overturn the stronger verdict: one
 * "прочети повече" in a restaurant snippet scored 40 toward NEWS_ARTICLE and
 * rejected a real lead. At 60, two independent signals or a decisive hostname
 * signal can still overrule the LLM — one weak keyword cannot.
 */
export const LLM_APPROVED_MIN_SCORE = 60;

function scoreToType(scores: ScoreMap): PageType {
  let best: PageType = 'UNKNOWN';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores) as [PageType, number][]) {
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
  }
  return best;
}

export class PageClassifier {
  /**
   * Fast classification using only URL, title and snippet — no HTTP request.
   * Use this to pre-filter before deciding whether to fetch a page.
   *
   * @param minScore the winning type must reach this to be returned; below it the
   *   result is UNKNOWN and the caller keeps whatever it already believed.
   */
  classifyFromMeta(
    url: string,
    title: string,
    snippet: string,
    input: PersonaSearchInput,
    minScore: number = DEFAULT_MIN_SCORE,
  ): Classification {
    const scores: ScoreMap = {};
    const evidence: Array<{ text: string; pts: number }> = [];
    const add = (type: PageType, pts: number, why?: string) => {
      scores[type] = (scores[type] ?? 0) + pts;
      if (why) evidence.push({ text: why, pts });
    };

    let urlPath = '';
    let hostname = '';
    try {
      const u = new URL(url);
      urlPath   = u.pathname.toLowerCase();
      hostname  = u.hostname.toLowerCase().replace(/^www\./, '');
    } catch { /* ignore invalid URLs */ }

    // Decode punycode/IDN hostnames (e.g. xn--80afcccsdam9a3aim.xn--90ae → детскиградини.бг)
    let unicodeHostname = hostname;
    try { unicodeHostname = domainToUnicode(hostname).toLowerCase(); } catch { /* ignore */ }

    // ── Hostname-level signals ──────────────────────────────────────────────
    // ASCII patterns that signal a registry or catalog domain (transliterated Bulgarian)
    if (/registar|registrar|regisar/.test(hostname)) {
      add('OFFICIAL_REGISTRY', 60, `домейнът „${hostname}“ съдържа „registar“`);
    }
    // A hostname signal is decisive by design — it describes what the site IS,
    // not what one page happens to say — so it sits at the LLM-approved bar.
    if (/katalog|catalog|kataloq|portal|directory/.test(hostname)) {
      add('DIRECTORY_OR_PORTAL', 60, `домейнът „${hostname}“ съдържа „katalog/portal/directory“`);
    }
    // If all significant persona words appear in the hostname, the domain IS the
    // category rather than a business in it — a portal. Checked in both alphabets:
    // "детски градини" ⊆ "детскиградини.бг" and, transliterated, ⊆ "detskigradini.bg".
    // Requiring every word (and at least two) is what keeps a real business safe —
    // "dg-slance.bg" contains neither "detski" nor "gradini".
    const personaWords = input.persona.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const unicodeBase  = unicodeHostname.replace(/\./g, '');
    const asciiBase    = hostname.replace(/[.\-_]/g, '');
    const isCategoryDomain =
      personaWords.length >= 2 &&
      personaWords.every(w => unicodeBase.includes(w) || asciiBase.includes(transliterate(w)));
    if (isCategoryDomain) {
      add('DIRECTORY_OR_PORTAL', 60, `домейнът „${unicodeHostname}“ е самата категория „${input.persona}“`);
    }

    const combined = `${title} ${snippet}`.toLowerCase();

    // ── Social media ────────────────────────────────────────────────────────
    if (isSocialPlatform(url)) {
      add('SOCIAL_PAGE', 100, 'адресът сочи към социална мрежа');
    }

    // ── News signals ────────────────────────────────────────────────────────
    const newsPath = NEWS_PATH_SEGMENTS.find(s => urlPath.includes(`/${s}`));
    if (newsPath) {
      add('NEWS_ARTICLE', 50, `адресът съдържа „/${newsPath}“`);
    }
    const newsText = NEWS_TEXT_SIGNALS.find(s => combined.includes(s));
    if (newsText) {
      add('NEWS_ARTICLE', 40, `текстът съдържа „${newsText.trim()}“`);
    }

    // ── Municipality signals ────────────────────────────────────────────────
    const muniPath = MUNICIPALITY_PATH_SEGMENTS.find(s => urlPath.includes(`/${s}`));
    if (muniPath) {
      add('MUNICIPALITY_PAGE', 50, `адресът съдържа „/${muniPath}“`);
    }
    const municipalityTitleHits = MUNICIPALITY_TEXT_SIGNALS.filter(s => combined.includes(s));
    if (municipalityTitleHits.length > 0) {
      add(
        'MUNICIPALITY_PAGE', municipalityTitleHits.length * 30,
        `текстът съдържа ${municipalityTitleHits.map(s => `„${s.trim()}“`).join(', ')}`,
      );
    }

    // ── Registry signals ────────────────────────────────────────────────────
    const registryText = REGISTRY_TEXT_SIGNALS.find(s => combined.includes(s));
    if (registryText) {
      add('OFFICIAL_REGISTRY', 40, `текстът съдържа „${registryText.trim()}“`);
      add('MUNICIPALITY_PAGE', 20); // registries are often on municipality sites
    }

    // ── Directory / portal signals ──────────────────────────────────────────
    const directoryText = DIRECTORY_TEXT_SIGNALS.find(s => combined.includes(s));
    if (directoryText) {
      add('DIRECTORY_OR_PORTAL', 50, `текстът съдържа „${directoryText.trim()}“`);
    }
    // Multiple occurrences of a persona-like keyword in the snippet = listing page
    const shortWords = combined
      .split(/\s+/)
      .filter(w => w.length > 3 && !REPETITION_STOPWORDS.has(w));
    const repetitionCounts = new Map<string, number>();
    for (const w of shortWords) {
      repetitionCounts.set(w, (repetitionCounts.get(w) ?? 0) + 1);
    }
    const maxRepetition = Math.max(0, ...repetitionCounts.values());
    if (maxRepetition >= 4) {
      const repeated = [...repetitionCounts.entries()].find(([, n]) => n === maxRepetition)?.[0];
      add('DIRECTORY_OR_PORTAL', 30, `думата „${repeated}“ се повтаря ${maxRepetition} пъти`);
    }

    // ── Target organization signals ─────────────────────────────────────────
    // If we have no strong signals toward municipality/directory/news, give a small
    // baseline boost toward TARGET_ORGANIZATION so that an empty-signal page
    // becomes UNKNOWN rather than defaulting to one of the negative types.
    const negativeTotal =
      (scores.MUNICIPALITY_PAGE ?? 0) +
      (scores.DIRECTORY_OR_PORTAL ?? 0) +
      (scores.NEWS_ARTICLE ?? 0) +
      (scores.OFFICIAL_REGISTRY ?? 0);
    if (negativeTotal === 0) {
      add('TARGET_ORGANIZATION', 20, 'няма сигнали за община, каталог или новина');
    }

    const result = scoreToType(scores);
    const winner = scores[result] ?? 0;
    const topEvidence = evidence.sort((a, b) => b.pts - a.pts).map(e => e.text);

    // Below-threshold → UNKNOWN (let the content classifier, or the LLM verdict, stand)
    if (winner < minScore) {
      return { type: 'UNKNOWN', score: winner, evidence: topEvidence };
    }
    return { type: result, score: winner, evidence: topEvidence };
  }

  /**
   * Deep classification from full HTML content.
   * Call this after fetching the page when meta-classification was uncertain.
   */
  classifyFromContent(
    html: string,
    _url: string,
    _input: PersonaSearchInput,
    minScore: number = DEFAULT_MIN_SCORE,
  ): Classification {
    const $ = cheerio.load(html);
    const scores: ScoreMap = {};
    const evidence: Array<{ text: string; pts: number }> = [];
    const add = (type: PageType, pts: number, why?: string) => {
      scores[type] = (scores[type] ?? 0) + pts;
      if (why) evidence.push({ text: why, pts });
    };

    // Decode charset if page claims windows-1251 (best-effort)
    const bodyText = $('body').text().toLowerCase().replace(/\s+/g, ' ');

    // ── Page title ──────────────────────────────────────────────────────────
    const pageTitle = $('title').text().toLowerCase();
    const h1Text = $('h1').first().text().toLowerCase();

    const muniTitle = MUNICIPALITY_TEXT_SIGNALS.find(s => pageTitle.includes(s) || h1Text.includes(s));
    if (muniTitle) {
      add('MUNICIPALITY_PAGE', 70, `заглавието на страницата съдържа „${muniTitle.trim()}“`);
    }
    const registryTitle = REGISTRY_TEXT_SIGNALS.find(s => pageTitle.includes(s));
    if (registryTitle) {
      add('OFFICIAL_REGISTRY', 50, `заглавието на страницата съдържа „${registryTitle.trim()}“`);
    }

    // ── Contact info density ────────────────────────────────────────────────
    const emails = (bodyText.match(EMAIL_RE) ?? []);
    const phones = (bodyText.match(PHONE_RE) ?? []);
    const uniqueEmails = new Set(emails).size;
    const uniquePhones = new Set(phones).size;

    if (uniqueEmails >= 5 || uniquePhones >= 5) {
      // Many distinct contacts = listing/directory
      add('DIRECTORY_OR_PORTAL', 60, `${uniqueEmails} имейла и ${uniquePhones} телефона на една страница`);
    } else if (uniqueEmails >= 2 && uniquePhones >= 2) {
      add('DIRECTORY_OR_PORTAL', 30, `${uniqueEmails} имейла и ${uniquePhones} телефона на една страница`);
    } else if (uniqueEmails === 1 || (uniqueEmails === 0 && uniquePhones === 1)) {
      add('TARGET_ORGANIZATION', 30, 'един-единствен контакт на страницата');
    }

    // ── Directory / registry keywords in body text ──────────────────────────
    const directoryBody = DIRECTORY_TEXT_SIGNALS.find(s => bodyText.includes(s));
    if (directoryBody) {
      add('DIRECTORY_OR_PORTAL', 50, `съдържанието съдържа „${directoryBody.trim()}“`);
    }
    const registryBody = REGISTRY_TEXT_SIGNALS.find(s => bodyText.includes(s));
    if (registryBody) {
      add('OFFICIAL_REGISTRY', 40, `съдържанието съдържа „${registryBody.trim()}“`);
    }

    // ── List / table structures ─────────────────────────────────────────────
    const tableRows = $('table tr').length;
    const listItems = $('ul li, ol li').length;
    if (tableRows >= 8 || listItems >= 10) {
      add('DIRECTORY_OR_PORTAL', 40, `страницата съдържа ${tableRows} реда в таблици и ${listItems} елемента в списъци`);
    } else if (tableRows >= 4 || listItems >= 4) {
      add('DIRECTORY_OR_PORTAL', 20, `страницата съдържа ${tableRows} реда в таблици и ${listItems} елемента в списъци`);
    }

    // ── Pagination ──────────────────────────────────────────────────────────
    const hasPagination = $('[class*="paginat"], [id*="paginat"], a[href*="page="], a[href*="str="]').length > 0;
    if (hasPagination) add('DIRECTORY_OR_PORTAL', 30, 'страницата има странициране (пагинация)');

    // ── News article signals ────────────────────────────────────────────────
    const hasArticleDate = $('time, [class*="date"], [class*="publish"], [class*="posted"]').length > 0;
    const hasArticleTag = $('article, [class*="article"], [class*="post-content"]').length > 0;
    if (hasArticleDate && hasArticleTag) {
      add('NEWS_ARTICLE', 60, 'страницата има статия с дата на публикуване');
    }

    // ── Single organization signals ─────────────────────────────────────────
    const hasAboutSection = $('[id*="about"], [class*="about"], [id*="contact"], [class*="contact"]').length > 0;
    const singleH1 = $('h1').length === 1;
    if (singleH1 && hasAboutSection) {
      add('TARGET_ORGANIZATION', 40, 'едно заглавие H1 и секция „за нас“ / „контакти“');
    }

    // ── Municipality keywords in body ───────────────────────────────────────
    const municipalityHits = MUNICIPALITY_TEXT_SIGNALS.filter(s => bodyText.includes(s));
    if (municipalityHits.length >= 2) {
      add(
        'MUNICIPALITY_PAGE', municipalityHits.length * 20,
        `съдържанието съдържа ${municipalityHits.map(s => `„${s.trim()}“`).join(', ')}`,
      );
    }

    const result = scoreToType(scores);
    const winner = scores[result] ?? 0;
    const topEvidence = evidence.sort((a, b) => b.pts - a.pts).map(e => e.text);

    if (winner < minScore) {
      return { type: 'UNKNOWN', score: winner, evidence: topEvidence };
    }
    return { type: result, score: winner, evidence: topEvidence };
  }
}
