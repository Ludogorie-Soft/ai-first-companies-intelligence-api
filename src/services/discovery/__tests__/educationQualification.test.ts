import { classifyEducationCandidate, isEducationPersona } from '../educationQualification';
import type { DiscoverySourceResult } from '../types';

function makeCandidate(overrides: Partial<DiscoverySourceResult>): DiscoverySourceResult {
  return {
    sourceUrl:  overrides.domain ? `https://${overrides.domain}` : 'https://example.bg',
    sourceType: 'search',
    confidence: 70,
    pageType:   'TARGET_ORGANIZATION',
    ...overrides,
  };
}

// ── isEducationPersona ────────────────────────────────────────────────────────

describe('isEducationPersona', () => {
  test('detects "детски градини"', () => expect(isEducationPersona('детски градини')).toBe(true));
  test('detects "училища"',        () => expect(isEducationPersona('училища')).toBe(true));
  test('detects "гимназии"',       () => expect(isEducationPersona('гимназии')).toBe(true));
  test('does not flag "ресторанти"', () => expect(isEducationPersona('ресторанти')).toBe(false));
  test('does not flag "хотели"',   () => expect(isEducationPersona('хотели')).toBe(false));

  // The abbreviations are matched as whole tokens. Matched as substrings, "су"
  // and "оу" swallow ordinary words — every sushi and supermarket search was
  // routed through the education gate, which then rejected real businesses.
  test('does not flag "суши ресторанти" (contains "су")', () =>
    expect(isEducationPersona('суши ресторанти')).toBe(false));
  test('does not flag "супермаркети" (contains "су")', () =>
    expect(isEducationPersona('супермаркети')).toBe(false));
  test('does not flag "оутлет магазини" (contains "оу")', () =>
    expect(isEducationPersona('оутлет магазини')).toBe(false));
  test('does not flag "пгради" — no bare abbreviation token', () =>
    expect(isEducationPersona('пградиевци')).toBe(false));

  test('still detects a genuine abbreviation used as a word', () => {
    expect(isEducationPersona('ДГ')).toBe(true);
    expect(isEducationPersona('СУ и ОУ')).toBe(true);
  });
});

// ── classifyEducationCandidate ────────────────────────────────────────────────

describe('classifyEducationCandidate — positive cases', () => {
  test('A — "СУ Иван Вазов" is accepted', () => {
    const c = makeCandidate({ name: 'СУ Иван Вазов', domain: 'su-ivan-vazov.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(60);
  });

  test('B — "ОУ Христо Ботев" is accepted', () => {
    const c = makeCandidate({ name: 'ОУ Христо Ботев', domain: 'ou-hristo-botev.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(true);
  });

  test('C — "ДГ Слънце" is accepted', () => {
    const c = makeCandidate({ name: 'ДГ Слънце', domain: 'dg-slance.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(true);
  });

  // Bulgarian schools are written with the name in quotes as often as with a
  // space. Requiring whitespace after the prefix made the strongest positive
  // signal miss exactly those names.
  test('a quoted school name is accepted — ОУ„Христо Ботев“', () => {
    const c = makeCandidate({ name: 'ОУ„Христо Ботев“', domain: 'ou-botev.bg' });
    expect(classifyEducationCandidate(c).accepted).toBe(true);
  });

  test('a quoted kindergarten name is accepted — ДГ"Слънце"', () => {
    const c = makeCandidate({ name: 'ДГ"Слънце"', domain: 'dg-slance.bg' });
    expect(classifyEducationCandidate(c).accepted).toBe(true);
  });

  // A school that mentions its own municipality is still a school. The hard
  // rejects below exist to catch municipal portals, not to punish a kindergarten
  // for naming the town it is in.
  test('a school name overrides an incidental "община" mention', () => {
    const c = makeCandidate({
      name: 'ДГ „Слънце“ – Община Мездра',
      domain: 'dg-slance.bg',
    });
    expect(classifyEducationCandidate(c).accepted).toBe(true);
  });

  test('a school name overrides an incidental "новини" mention', () => {
    const c = makeCandidate({ name: 'ОУ Христо Ботев – Новини', domain: 'ou-botev.bg' });
    expect(classifyEducationCandidate(c).accepted).toBe(true);
  });

  test('but a bare municipality page is still rejected', () => {
    const c = makeCandidate({ name: 'Община Мездра', domain: 'mezdra.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('MUNICIPALITY_PAGE');
  });

  test('every decision carries a human-readable detail', () => {
    const accepted = classifyEducationCandidate(
      makeCandidate({ name: 'СУ Иван Вазов', domain: 'su-ivan-vazov.bg' }),
    );
    const rejected = classifyEducationCandidate(
      makeCandidate({ name: 'Община Мездра', domain: 'mezdra.bg' }),
    );
    expect(accepted.detail).toBeTruthy();
    expect(rejected.detail).toBeTruthy();
  });

  test('accepted with educational keyword even without prefix', () => {
    const c = makeCandidate({ name: 'Средно общообразователно училище Иван Вазов', domain: 'sou.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(true);
  });

  test('accepted with "гимназия" keyword', () => {
    const c = makeCandidate({ name: 'Природо-математическа гимназия Добрич', domain: 'pmg-dobrich.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(true);
  });

  test('accepted when extracted from municipality page with school prefix', () => {
    const c = makeCandidate({
      name:            'ОУ Христо Ботев',
      domain:          'ou-hristo-botev.bg',
      extractedFromUrl: 'https://mezdra.bg/uchilishta',
    });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(true);
  });
});

describe('classifyEducationCandidate — negative cases (hard rejects)', () => {
  test('D — "Община Мездра" is rejected (municipality)', () => {
    const c = makeCandidate({ name: 'Община Мездра', domain: 'mezdra.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('MUNICIPALITY_PAGE');
  });

  test('E — "Регистър на училищата" is rejected (registry)', () => {
    const c = makeCandidate({ name: 'Регистър на училищата', domain: 'edu.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('OFFICIAL_REGISTRY');
  });

  test('F — "Рейтинг на висшите училища" is rejected (ranking)', () => {
    const c = makeCandidate({ name: 'Рейтинг на висшите училища в България', domain: 'ranking.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('DIRECTORY_OR_PORTAL');
  });

  test('G — "Guide Bulgaria Schools" is rejected (guide)', () => {
    const c = makeCandidate({ name: 'Guide Bulgaria Schools', domain: 'guide-bg.com' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('DIRECTORY_OR_PORTAL');
  });

  test('rejects "Каталог на детски градини" (directory)', () => {
    const c = makeCandidate({ name: 'Каталог на детски градини' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('DIRECTORY_OR_PORTAL');
  });

  test('rejects "Портал за образование" (portal)', () => {
    const c = makeCandidate({ name: 'Портал за образование', domain: 'edu-portal.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('DIRECTORY_OR_PORTAL');
  });

  test('rejects direct candidate with directory domain', () => {
    const c = makeCandidate({ name: 'Детска градина Слънце', domain: 'schools-catalog.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('DIRECTORY_OR_PORTAL');
  });

  test('accepts extracted candidate with directory parent but own school domain', () => {
    // Org was extracted FROM a catalog page but has its own proper school domain
    const c = makeCandidate({
      name:            'ДГ Слънце',
      domain:          'dg-slance.bg',
      extractedFromUrl: 'https://schools-catalog.bg/list',
    });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(true);
  });

  test('rejects candidate with no educational signals (insufficient confidence)', () => {
    // A random business name with no school signals
    const c = makeCandidate({ name: 'ООД Примерна', domain: undefined });
    const r = classifyEducationCandidate(c);
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('NOT_TARGET_ORGANIZATION');
  });
});

describe('classifyEducationCandidate — confidence scoring', () => {
  test('school prefix gives +40 (total >= 70 with domain)', () => {
    const c = makeCandidate({ name: 'ПГ Васил Левски', domain: 'pg-vasil-levski.bg' });
    const r = classifyEducationCandidate(c);
    expect(r.confidence).toBeGreaterThanOrEqual(70);
  });

  test('keyword alone with domain and contact reaches threshold', () => {
    const c = makeCandidate({
      name:   'Средно образователно училище',
      domain: 'sou.bg',
      email:  'info@sou.bg',
    });
    const r = classifyEducationCandidate(c);
    // 30 baseline + 20 keyword + 10 domain + 10 contact = 70
    expect(r.accepted).toBe(true);
    expect(r.confidence).toBe(70);
  });
});
