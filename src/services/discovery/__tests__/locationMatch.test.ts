import {
  locationSignal,
  normalizeLocationName,
  transliterate,
  acceptableSettlements,
  extractSettlements,
  isOblast,
  knownSettlement,
  OBLAST_SEATS,
} from '../locationMatch';
import { OBLAST_TOWNS } from '../../discovery';

describe('normalizeLocationName', () => {
  test.each([
    ['гр. Враца',      'враца'],
    ['град Мездра',    'мездра'],
    ['с. Хайредин',    'хайредин'],
    ['област Ловеч',   'ловеч'],
    ['обл. Варна',     'варна'],
    ['  ВАРНА  ',      'варна'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeLocationName(input)).toBe(expected);
  });
});

describe('transliterate', () => {
  test.each([
    ['Варна',   'varna'],
    ['София',   'sofiya'],
    ['Мездра',  'mezdra'],
    ['Пловдив', 'plovdiv'],
  ])('%s → %s', (cyrillic, latin) => {
    expect(transliterate(cyrillic)).toBe(latin);
  });
});

describe('oblast handling', () => {
  test('an oblast admits every settlement in it', () => {
    expect(isOblast('област Враца')).toBe(true);
    const seats = acceptableSettlements('област Враца');
    expect(seats).toContain('Мездра');
    expect(seats).toContain('Козлодуй');
  });

  test('a town admits only itself', () => {
    expect(isOblast('Мездра')).toBe(false);
    expect(acceptableSettlements('Мездра')).toEqual(['Мездра']);
  });

  test('a search for the oblast matches any town inside it', () => {
    const r = locationSignal('Автосервиз в град Троян', 'област Ловеч');
    expect(r.kind).toBe('match');
  });

  test('a town from a different oblast conflicts', () => {
    const r = locationSignal('Автосервиз в град Троян', 'област Варна');
    expect(r.kind).toBe('conflict');
    expect(r.found).toBe('Троян');
  });
});

describe('locationSignal — match', () => {
  test('exact town name', () => {
    expect(locationSignal('ДГ Слънце, гр. Мездра', 'Мездра').kind).toBe('match');
  });

  test('adjectival form — варненски', () => {
    expect(locationSignal('Варненски автосервиз', 'Варна').kind).toBe('match');
  });

  test('adjectival form — софийски', () => {
    expect(locationSignal('Софийски хотел', 'София').kind).toBe('match');
  });

  test('Latin transliteration in a domain', () => {
    expect(locationSignal('dg-slance.mezdra.bg', 'Мездра').kind).toBe('match');
  });

  test('the requested location wins even when it is an ambiguous word', () => {
    // "Бяла" is a real town, and also the word for "white".
    expect(locationSignal('Хотел в гр. Бяла', 'Бяла').kind).toBe('match');
  });

  test('the evidence names both sides of the comparison', () => {
    const r = locationSignal('ДГ Слънце, гр. Мездра', 'Мездра');
    expect(r.detail).toContain('мездра');
  });
});

describe('locationSignal — conflict', () => {
  test('a different town is a conflict', () => {
    const r = locationSignal('Детска градина в град Варна', 'Мездра');
    expect(r.kind).toBe('conflict');
    expect(r.found).toBe('Варна');
    expect(r.detail).toContain('Варна');
  });

  test('Стара Загора and Нова Загора are distinct places', () => {
    expect(locationSignal('Ресторант в Нова Загора', 'Стара Загора').kind).toBe('conflict');
    expect(locationSignal('Ресторант в Стара Загора', 'Стара Загора').kind).toBe('match');
  });
});

describe('locationSignal — unknown is the safe default', () => {
  // Conflict is the destructive verdict: it is what removes a real business from
  // the results. Anything short of clear evidence must come back 'unknown'.

  test('a snippet that names no town', () => {
    expect(locationSignal('Детска градина с дълга история', 'Мездра').kind).toBe('unknown');
  });

  test('empty and missing text', () => {
    expect(locationSignal('', 'Мездра').kind).toBe('unknown');
    expect(locationSignal(null, 'Мездра').kind).toBe('unknown');
    expect(locationSignal(undefined, 'Мездра').kind).toBe('unknown');
  });

  test('a mountain that shares its name with a town is not a conflict', () => {
    // A Bansko hotel writing "в подножието на Рила и Пирин" must not be rejected
    // because Рила is also a municipality seat in Kyustendil oblast.
    const r = locationSignal('Хотел в подножието на Рила и Пирин', 'Банско');
    expect(r.kind).not.toBe('conflict');
  });

  test('a street named after a national hero is not a conflict', () => {
    // "Левски" is a town in Pleven oblast and the name of half the streets in Bulgaria.
    const r = locationSignal('Автосервиз на ул. Васил Левски 12', 'Мездра');
    expect(r.kind).not.toBe('conflict');
  });

  test('a river name is not a conflict', () => {
    const r = locationSignal('Хотел близо до река Марица', 'Банско');
    expect(r.kind).not.toBe('conflict');
  });

  test('a town name embedded inside a longer word does not match', () => {
    // Strict boundaries: "Ловеч" must not be found inside "Ловечкиярд".
    const r = locationSignal('Фирма Ловечкиярдоо', 'Варна');
    expect(r.kind).toBe('unknown');
  });
});

describe('extractSettlements — addresses', () => {
  test('pulls settlements introduced by a marker', () => {
    expect(extractSettlements('гр. Варна, ул. Дунав 5')).toContain('Варна');
    expect(extractSettlements('с. Хайредин, общ. Хайредин')).toContain('Хайредин');
  });

  test('ignores street names', () => {
    expect(extractSettlements('ул. Васил Левски 12')).toEqual([]);
  });
});

describe('locationSignal — address mode', () => {
  test('a marker-introduced settlement is trusted', () => {
    const r = locationSignal('гр. Варна, ул. Дунав 5', 'Мездра', { source: 'address' });
    expect(r.kind).toBe('conflict');
    expect(r.found).toBe('Варна');
  });

  test('a matching address confirms the location', () => {
    const r = locationSignal('гр. Мездра, ул. Христо Ботев 1', 'Мездра', { source: 'address' });
    expect(r.kind).toBe('match');
  });

  test('a street named after a town does not cause a conflict', () => {
    // Without marker-based extraction, "ул. Плевен" would read as the town Плевен.
    const r = locationSignal('гр. Мездра, ул. Плевен 3', 'Мездра', { source: 'address' });
    expect(r.kind).toBe('match');
  });
});

describe('gazetteer integrity', () => {
  test('knownSettlement recognises seats and rejects invented names', () => {
    expect(knownSettlement('Мездра')).toBe(true);
    expect(knownSettlement('гр. Мездра')).toBe(true);
    expect(knownSettlement('Несъществуващоград')).toBe(false);
  });

  test('every query-expansion town is a settlement the matcher knows', () => {
    // OBLAST_TOWNS (discovery.ts) is ordered by population and drives which towns
    // get their own search query; OBLAST_SEATS (here) is the complete set used for
    // matching. They are separate on purpose — OBLAST_TOWNS treats "софия" as the
    // capital plus its surrounding oblast, which the gazetteer keeps apart. This
    // test stops the two from drifting into typos or invented names.
    for (const towns of Object.values(OBLAST_TOWNS)) {
      for (const town of towns) {
        expect({ town, known: knownSettlement(town) }).toEqual({ town, known: true });
      }
    }
  });

  test('every oblast key in the query table exists in the gazetteer', () => {
    for (const oblast of Object.keys(OBLAST_TOWNS)) {
      expect(OBLAST_SEATS[oblast]).toBeDefined();
    }
  });

  test('all 28 oblasts are present', () => {
    expect(Object.keys(OBLAST_SEATS)).toHaveLength(28);
  });
});
