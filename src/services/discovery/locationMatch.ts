/**
 * Deterministic, free location matching for Bulgarian search results.
 *
 * The asymmetry here is deliberate and is the whole point of the module:
 *
 *  - `match`    is detected PERMISSIVELY (adjectival forms, transliterations).
 *               Over-matching only confirms something the LLM already accepted.
 *  - `conflict` is detected STRICTLY (full settlement names, ambiguous words
 *               excluded). A conflict is the destructive verdict — it is the one
 *               that pushes a real business out of the results — so it must be
 *               backed by strong evidence.
 *  - `unknown`  is the common case and contributes nothing either way. Most
 *               legitimate snippets never name a town.
 */

export type LocationSignalKind = 'match' | 'conflict' | 'unknown';

export interface LocationSignalResult {
  kind: LocationSignalKind;
  /** The place name found in the text that drove the verdict. */
  found?: string;
  /** Canonical form of the requested location. */
  requested: string;
  /** Ready-to-display evidence, e.g. `„Варна“ ≠ търсено „Мездра“`. */
  detail?: string;
}

// ── Gazetteer ─────────────────────────────────────────────────────────────────
// All 28 oblasts with their municipality seats. Complete enough that a town named
// in a snippet is recognised; `src/services/discovery.ts` keeps a separate, shorter
// list ordered by population for building search queries — the two are cross-checked
// by locationMatch.test.ts so they cannot drift apart.

export const OBLAST_SEATS: Record<string, string[]> = {
  'благоевград': [
    'Благоевград', 'Банско', 'Белица', 'Гоце Делчев', 'Гърмен', 'Кресна', 'Петрич',
    'Разлог', 'Сандански', 'Сатовча', 'Симитли', 'Струмяни', 'Хаджидимово', 'Якоруда',
  ],
  'бургас': [
    'Бургас', 'Айтос', 'Камено', 'Карнобат', 'Малко Търново', 'Несебър', 'Поморие',
    'Приморско', 'Руен', 'Созопол', 'Средец', 'Сунгурларе', 'Царево',
  ],
  'варна': [
    'Варна', 'Аврен', 'Аксаково', 'Белослав', 'Бяла', 'Ветрино', 'Вълчи дол', 'Девня',
    'Долни чифлик', 'Дългопол', 'Провадия', 'Суворово',
  ],
  'велико търново': [
    'Велико Търново', 'Горна Оряховица', 'Елена', 'Златарица', 'Лясковец', 'Павликени',
    'Полски Тръмбеш', 'Свищов', 'Стражица', 'Сухиндол',
  ],
  'видин': [
    'Видин', 'Белоградчик', 'Бойница', 'Брегово', 'Грамада', 'Димово', 'Кула',
    'Макреш', 'Ново село', 'Ружинци', 'Чупрене',
  ],
  'враца': [
    'Враца', 'Борован', 'Бяла Слатина', 'Козлодуй', 'Криводол', 'Мездра', 'Мизия',
    'Оряхово', 'Роман', 'Хайредин',
  ],
  'габрово': ['Габрово', 'Дряново', 'Севлиево', 'Трявна'],
  'добрич': [
    'Добрич', 'Балчик', 'Генерал Тошево', 'Каварна', 'Крушари', 'Тервел', 'Шабла',
  ],
  'кърджали': [
    'Кърджали', 'Ардино', 'Джебел', 'Кирково', 'Крумовград', 'Момчилград', 'Черноочене',
  ],
  'кюстендил': [
    'Кюстендил', 'Бобов дол', 'Бобошево', 'Дупница', 'Кочериново', 'Невестино', 'Рила',
    'Сапарева баня', 'Трекляно',
  ],
  'ловеч': [
    'Ловеч', 'Априлци', 'Летница', 'Луковит', 'Тетевен', 'Троян', 'Угърчин', 'Ябланица',
  ],
  'монтана': [
    'Монтана', 'Берковица', 'Бойчиновци', 'Брусарци', 'Вълчедръм', 'Вършец',
    'Георги Дамяново', 'Лом', 'Медковец', 'Чипровци', 'Якимово',
  ],
  'пазарджик': [
    'Пазарджик', 'Батак', 'Белово', 'Брацигово', 'Велинград', 'Лесичово', 'Панагюрище',
    'Пещера', 'Ракитово', 'Септември', 'Стрелча', 'Сърница',
  ],
  'перник': ['Перник', 'Брезник', 'Земен', 'Ковачевци', 'Радомир', 'Трън'],
  'плевен': [
    'Плевен', 'Белене', 'Гулянци', 'Долна Митрополия', 'Долни Дъбник', 'Искър', 'Кнежа',
    'Левски', 'Никопол', 'Пордим', 'Червен бряг',
  ],
  'пловдив': [
    'Пловдив', 'Асеновград', 'Брезово', 'Калояново', 'Карлово', 'Кричим', 'Куклен',
    'Лъки', 'Марица', 'Перущица', 'Първомай', 'Раковски', 'Родопи', 'Садово', 'Сопот',
    'Стамболийски', 'Съединение', 'Хисаря',
  ],
  'разград': ['Разград', 'Завет', 'Исперих', 'Кубрат', 'Лозница', 'Самуил', 'Цар Калоян'],
  'русе': [
    'Русе', 'Борово', 'Бяла', 'Ветово', 'Две могили', 'Иваново', 'Сливо поле', 'Ценово',
  ],
  'силистра': [
    'Силистра', 'Алфатар', 'Главиница', 'Дулово', 'Кайнарджа', 'Ситово', 'Тутракан',
  ],
  'сливен': ['Сливен', 'Котел', 'Нова Загора', 'Твърдица'],
  'смолян': [
    'Смолян', 'Баните', 'Борино', 'Девин', 'Доспат', 'Златоград', 'Мадан', 'Неделино',
    'Рудозем', 'Чепеларе',
  ],
  'софия': ['София'],
  'софия област': [
    'Антон', 'Божурище', 'Ботевград', 'Годеч', 'Горна Малина', 'Долна баня', 'Драгоман',
    'Елин Пелин', 'Етрополе', 'Златица', 'Ихтиман', 'Копривщица', 'Костенец',
    'Костинброд', 'Мирково', 'Пирдоп', 'Правец', 'Самоков', 'Своге', 'Сливница',
    'Чавдар', 'Челопеч',
  ],
  'стара загора': [
    'Стара Загора', 'Братя Даскалови', 'Гурково', 'Гълъбово', 'Казанлък', 'Мъглиж',
    'Николаево', 'Опан', 'Павел баня', 'Раднево', 'Чирпан',
  ],
  'търговище': ['Търговище', 'Антоново', 'Омуртаг', 'Опака', 'Попово'],
  'хасково': [
    'Хасково', 'Димитровград', 'Ивайловград', 'Любимец', 'Маджарово', 'Минерални бани',
    'Свиленград', 'Симеоновград', 'Стамболово', 'Тополовград', 'Харманли',
  ],
  'шумен': [
    'Шумен', 'Велики Преслав', 'Венец', 'Върбица', 'Каолиново', 'Каспичан',
    'Никола Козлево', 'Нови пазар', 'Смядово', 'Хитрино',
  ],
  'ямбол': ['Ямбол', 'Болярово', 'Елхово', 'Стралджа', 'Тунджа'],
};

/**
 * Settlement names that are also mountains, rivers, saints, national heroes or
 * ordinary words. Finding one of these in free text is NOT evidence of a location
 * conflict — a Bansko hotel writes "в подножието на Рила и Пирин", and every second
 * Bulgarian street is "ул. Васил Левски".
 *
 * They still count as a MATCH when they are the location that was requested.
 */
const AMBIGUOUS_PLACES = new Set([
  'бяла', 'рила', 'искър', 'марица', 'родопи', 'тунджа', 'средец', 'мизия',
  'роман', 'левски', 'антон', 'венец', 'земен', 'опан', 'опака', 'кула',
  'грамада', 'борино', 'баните', 'ново село', 'долна баня', 'сапарева баня',
  'павел баня', 'минерални бани', 'раковски', 'стамболийски', 'чавдар',
  'елена', 'самуил', 'завет', 'иваново', 'борово', 'ситово', 'руен', 'лъки',
  'септември', 'съединение', 'победа', 'дружба',
]);

/** Oblast name aliases that are not simply the seat's name. */
const OBLAST_ALIASES: Record<string, string> = {
  'софия-град':    'софия',
  'софия град':    'софия',
  'софийска':      'софия област',
  'софия-област':  'софия област',
  'великотърновска': 'велико търново',
  'старозагорска':   'стара загора',
};

// ── Normalisation ─────────────────────────────────────────────────────────────

/** Strips settlement/oblast prefixes and lowercases. "гр. Враца" → "враца". */
export function normalizeLocationName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[„“"'`]/g, '')
    .replace(/^\s*(?:област|обл\.|oblast)\s+/, '')
    .replace(/^\s*(?:гр\.|гр\s|град\s|с\.|село\s)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht',
  ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

/** Streamlined Bulgarian transliteration (the official system, roughly). */
export function transliterate(cyrillic: string): string {
  return cyrillic
    .toLowerCase()
    .split('')
    .map(ch => CYR_TO_LAT[ch] ?? ch)
    .join('');
}

/**
 * Alternative transliterations that the official system does not produce but
 * that appear constantly in real domain names.
 */
function transliterationVariants(cyrillic: string): string[] {
  const base = transliterate(cyrillic);
  const variants = new Set([base]);
  variants.add(base.replace(/ts/g, 'c'));
  variants.add(base.replace(/^v/, 'w'));
  variants.add(base.replace(/ya/g, 'ia').replace(/yu/g, 'iu'));
  variants.add(base.replace(/a$/, ''));       // varna → varn
  variants.add(base.replace(/zh/g, 'j'));
  return [...variants].filter(v => v.length >= 3);
}

// ── Matching primitives ───────────────────────────────────────────────────────
// JS \b is ASCII-only (\w === [A-Za-z0-9_]), so Cyrillic word boundaries have to
// be written by hand as "not preceded/followed by a letter or digit".

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strict: the exact name, delimited by non-letters on both sides. */
function containsExact(haystack: string, name: string): boolean {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(haystack);
}

/**
 * Permissive: the name's stem followed by up to 5 more letters, so "варна"
 * also matches "варненски"/"варненска" and "софия" matches "софийски".
 * Only used for the location that was actually requested.
 */
function containsStem(haystack: string, name: string): boolean {
  if (containsExact(haystack, name)) return true;

  // Drop a trailing vowel to reach the stem ("варна" → "варн", "софия" → "софи"),
  // which is what the adjectival forms are built on: варн+енски, софи+йски.
  // Stems shorter than 4 are too generic to match on ("рила" → "рил").
  const stem = name.replace(/[аяоеи]$/i, '');
  if (stem.length < 4) return false;

  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(stem)}\\p{L}{0,5}(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(haystack);
}

// ── Requested-location resolution ─────────────────────────────────────────────

export function isOblast(location: string): boolean {
  const key = normalizeLocationName(location);
  return (OBLAST_ALIASES[key] ?? key) in OBLAST_SEATS;
}

/** Every settlement that satisfies the request. An oblast admits all of its seats. */
export function acceptableSettlements(location: string): string[] {
  const key = OBLAST_ALIASES[normalizeLocationName(location)] ?? normalizeLocationName(location);
  const seats = OBLAST_SEATS[key];
  if (seats) return seats;
  // Not an oblast — a single town. Return it with its canonical casing if we know it.
  for (const towns of Object.values(OBLAST_SEATS)) {
    const hit = towns.find(t => t.toLowerCase() === key);
    if (hit) return [hit];
  }
  return [location.trim()];
}

/** All lowercase strings that count as "this is the right place". */
function acceptableTokens(location: string): string[] {
  const settlements = acceptableSettlements(location);
  const key = OBLAST_ALIASES[normalizeLocationName(location)] ?? normalizeLocationName(location);

  const tokens = new Set<string>([key]);
  for (const s of settlements) {
    tokens.add(s.toLowerCase());
    for (const v of transliterationVariants(s)) tokens.add(v);
  }
  for (const v of transliterationVariants(key)) tokens.add(v);
  return [...tokens];
}

// ── Address handling ──────────────────────────────────────────────────────────

const SETTLEMENT_MARKER_RE =
  /(?:^|[\s,;(])(?:гр\.|град|с\.|село|общ\.|община)\s*([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/gu;

/**
 * Pulls settlement names out of a postal address. Addresses are full of street
 * names that collide with town names ("ул. Васил Левски", "бул. Марица"), so for
 * addresses we trust ONLY names introduced by a гр./с./общ. marker.
 * Returns [] when the address has no marker — the caller then falls back to a
 * general scan, which is what an address like "Варна, ул. Дунав 5" needs.
 */
export function extractSettlements(address: string): string[] {
  const found: string[] = [];
  for (const m of address.matchAll(SETTLEMENT_MARKER_RE)) {
    if (m[1]) found.push(m[1].trim());
  }
  return found;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface LocationSignalOptions {
  /**
   * 'text' (default) — a search title/snippet or page copy. Ambiguous names are
   * ignored for conflict detection.
   * 'address' — a postal address extracted from a crawled page. Settlement
   * markers are trusted, which makes conflict detection far more reliable.
   */
  source?: 'text' | 'address';
}

export function locationSignal(
  text: string | null | undefined,
  requestedLocation: string,
  opts: LocationSignalOptions = {},
): LocationSignalResult {
  const requested = normalizeLocationName(requestedLocation);
  const haystack  = (text ?? '').toLowerCase().replace(/\s+/g, ' ');

  if (!haystack.trim() || !requested) {
    return { kind: 'unknown', requested };
  }

  const accepted = acceptableTokens(requestedLocation);

  // ── 1. Does the requested location appear? (permissive) ────────────────────
  for (const token of accepted) {
    if (containsStem(haystack, token)) {
      return {
        kind:     'match',
        found:    token,
        requested,
        detail:   `намерено „${token}“ съответства на търсеното „${requested}“`,
      };
    }
  }

  // ── 2. Does some OTHER settlement appear? (strict) ─────────────────────────
  const acceptedSet = new Set(accepted);

  // Addresses: trust only marker-introduced settlements when there are any.
  if (opts.source === 'address') {
    const marked = extractSettlements(text ?? '');
    for (const s of marked) {
      const lower = s.toLowerCase();
      if (acceptedSet.has(lower)) {
        return {
          kind:   'match',
          found:  lower,
          requested,
          detail: `адрес „${s}“ съответства на търсеното „${requested}“`,
        };
      }
    }
    const conflicting = marked.find(s => knownSettlement(s) && !acceptedSet.has(s.toLowerCase()));
    if (conflicting) {
      return {
        kind:   'conflict',
        found:  conflicting,
        requested,
        detail: `адрес „${conflicting}“ ≠ търсено „${requested}“`,
      };
    }
  }

  for (const [, towns] of Object.entries(OBLAST_SEATS)) {
    for (const town of towns) {
      const lower = town.toLowerCase();
      if (acceptedSet.has(lower)) continue;
      if (lower.length < 4) continue;
      if (AMBIGUOUS_PLACES.has(lower)) continue;
      if (containsExact(haystack, lower)) {
        return {
          kind:   'conflict',
          found:  town,
          requested,
          detail: `намерено „${town}“ ≠ търсено „${requested}“`,
        };
      }
    }
  }

  return { kind: 'unknown', requested };
}

/** True when the given string is a settlement we know about. */
export function knownSettlement(name: string): boolean {
  const lower = normalizeLocationName(name);
  return Object.values(OBLAST_SEATS).some(towns =>
    towns.some(t => t.toLowerCase() === lower),
  );
}
