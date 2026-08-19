import { PageClassifier, DEFAULT_MIN_SCORE, LLM_APPROVED_MIN_SCORE } from '../PageClassifier';
import type { PersonaSearchInput } from '../types';

const input: PersonaSearchInput = { persona: 'детски градини', location: 'гр. Мездра' };
const classifier = new PageClassifier();

describe('PageClassifier.classifyFromMeta', () => {
  test('detects municipality page from title containing "Община"', () => {
    const { type } = classifier.classifyFromMeta(
      'https://mezdra.bg/obrazovanie/detski-gradini',
      'Детски градини | Община Мездра',
      'Детски градини в Община Мездра',
      input,
    );
    expect(type).toBe('MUNICIPALITY_PAGE');
  });

  test('detects municipality page from /obrazovanie/ URL path', () => {
    const { type } = classifier.classifyFromMeta(
      'https://mezdra.bg/obrazovanie',
      'Образование',
      'Информация за образованието в Мездра',
      input,
    );
    expect(type).toBe('MUNICIPALITY_PAGE');
  });

  test('detects news article from news URL path', () => {
    const { type } = classifier.classifyFromMeta(
      'https://example.bg/novini/nova-detska-gradina',
      'Нова детска градина ще отвори врати',
      'Публикувано на 12.06.2025',
      input,
    );
    expect(type).toBe('NEWS_ARTICLE');
  });

  test('detects social page for Facebook URL', () => {
    const { type } = classifier.classifyFromMeta(
      'https://www.facebook.com/dgslance',
      'ДГ Слънце | Facebook',
      '',
      input,
    );
    expect(type).toBe('SOCIAL_PAGE');
  });

  test('returns UNKNOWN for org-like page with no strong signals', () => {
    const { type } = classifier.classifyFromMeta(
      'https://dg-slance.bg',
      'ДГ Слънце Мездра',
      'Добре дошли в детска градина Слънце',
      input,
    );
    // No strong municipality/directory/news signals → UNKNOWN or TARGET_ORGANIZATION
    expect(['UNKNOWN', 'TARGET_ORGANIZATION']).toContain(type);
  });

  test('detects directory from a hostname that spells out the persona', () => {
    const { type } = classifier.classifyFromMeta(
      'https://detskigradini.bg/mezda',
      'Детски градини Мездра',
      'ДГ Слънце ДГ Бъдеще ДГ Надежда ДГ Пролет всички детски градини детска градина',
      input,
    );
    expect(type).toBe('DIRECTORY_OR_PORTAL');
  });

  test('a transliterated category hostname is caught, a real org hostname is not', () => {
    // "detskigradini.bg" IS the category; "dg-slance.bg" is one kindergarten in it.
    const portal = classifier.classifyFromMeta(
      'https://detskigradini.bg', 'Начало', '', input,
    );
    const org = classifier.classifyFromMeta(
      'https://dg-slance.bg', 'ДГ Слънце', '', input,
    );
    expect(portal.type).toBe('DIRECTORY_OR_PORTAL');
    expect(org.type).not.toBe('DIRECTORY_OR_PORTAL');
  });

  test('an ordinary word no longer rejects a real business on its own', () => {
    // 'всички ' and 'резулт' used to score 50 toward DIRECTORY_OR_PORTAL, which
    // rejected real leads whose snippet merely said "всички права запазени".
    const { type } = classifier.classifyFromMeta(
      'https://sushi-bar.bg',
      'Суши бар София',
      'Всички права запазени. Резултат от нашата работа е доволният клиент.',
      { persona: 'суши ресторанти', location: 'София' },
    );
    expect(type).not.toBe('DIRECTORY_OR_PORTAL');
  });
});

describe('PageClassifier — the LLM-approval bar', () => {
  // A single snippet keyword used to overturn an LLM approval: one "прочети
  // повече" in a restaurant snippet scored 40 toward NEWS_ARTICLE and rejected a
  // real lead. The classifier reads the same text the LLM already judged, so an
  // approved candidate is scored against a higher bar.
  const url     = 'https://edosushi.bg';
  const title   = 'Едо Суши – ресторант в София';
  const snippet = 'Заповядайте при нас. Прочети повече за менюто ни.';
  const sushi: PersonaSearchInput = { persona: 'суши ресторанти', location: 'София' };

  test('one weak keyword reclassifies at the default bar', () => {
    const { type, score } = classifier.classifyFromMeta(url, title, snippet, sushi, DEFAULT_MIN_SCORE);
    expect(type).toBe('NEWS_ARTICLE');
    expect(score).toBeGreaterThanOrEqual(DEFAULT_MIN_SCORE);
    expect(score).toBeLessThan(LLM_APPROVED_MIN_SCORE);
  });

  test('the same keyword cannot overturn an LLM approval', () => {
    const { type } = classifier.classifyFromMeta(url, title, snippet, sushi, LLM_APPROVED_MIN_SCORE);
    expect(type).toBe('UNKNOWN');
  });

  test('a decisive hostname signal still overrules an LLM approval', () => {
    const { type } = classifier.classifyFromMeta(
      'https://katalog-restoranti.bg', title, snippet, sushi, LLM_APPROVED_MIN_SCORE,
    );
    expect(type).toBe('DIRECTORY_OR_PORTAL');
  });

  test('every classification reports the evidence behind it', () => {
    const { evidence } = classifier.classifyFromMeta(
      'https://mezdra.bg/obrazovanie', 'Детски градини | Община Мездра', '', input,
    );
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.join(' ')).toContain('община');
  });
});

describe('PageClassifier.classifyFromContent', () => {
  test('detects municipality page from H1 "Община"', () => {
    const html = `
      <html><body>
        <h1>Община Мездра - Детски градини</h1>
        <table>
          <tr><th>Наименование</th><th>Адрес</th><th>Телефон</th></tr>
          <tr><td>ДГ Слънце</td><td>ул. Първа 1</td><td>0893111111</td></tr>
          <tr><td>ДГ Бъдеще</td><td>ул. Втора 2</td><td>0893222222</td></tr>
          <tr><td>ДГ Надежда</td><td>ул. Трета 3</td><td>0893333333</td></tr>
          <tr><td>ДГ Пролет</td><td>ул. Четвърта 4</td><td>0893444444</td></tr>
        </table>
      </body></html>
    `;
    const { type } = classifier.classifyFromContent(html, 'https://mezdra.bg/detski-gradini', input);
    expect(type).toBe('MUNICIPALITY_PAGE');
  });

  test('detects directory from many unique emails', () => {
    const emails = Array.from({ length: 6 }, (_, i) => `org${i}@example.bg`).join(' ');
    const html = `<html><body><p>${emails}</p></body></html>`;
    const { type } = classifier.classifyFromContent(html, 'https://directory.bg', input);
    expect(type).toBe('DIRECTORY_OR_PORTAL');
  });

  test('detects news article from article tag + date element', () => {
    const html = `
      <html><body>
        <article class="post-content">
          <time class="date">12 юни 2025</time>
          <p>Новата детска градина ще отвори врати тази есен.</p>
        </article>
      </body></html>
    `;
    const { type } = classifier.classifyFromContent(html, 'https://news.bg/article/123', input);
    expect(type).toBe('NEWS_ARTICLE');
  });

  test('detects target organization from single contact + about section', () => {
    const html = `
      <html><body>
        <h1>ДГ Слънце</h1>
        <div id="about">
          <p>Добре дошли в нашата градина.</p>
          <p>Email: dg-slance@mezdra.bg</p>
          <p>Тел: 0893 123 456</p>
        </div>
      </body></html>
    `;
    const { type } = classifier.classifyFromContent(html, 'https://dg-slance.bg', input);
    expect(type).toBe('TARGET_ORGANIZATION');
  });
});
