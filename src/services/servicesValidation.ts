import { groqFastModel, maxTokensFor, reasoningParams } from '../lib/groqModels';
import type { CrawledPage } from '../worker/crawl';

type CallFn = (systemPrompt: string, userContent: string) => Promise<string>;

export interface ValidatedServicesResult {
  services: string[];
  represented_brands: string[];
  primary_industry?: string;
  target_customers?: string;
  no_services_found: boolean;
  confidence: number;
  notes?: string;
}

const SYSTEM_PROMPT_TEMPLATE = `You are a B2B data extraction assistant for Bulgarian companies.

Extract concrete business services, products, or activities from the provided page text.

CONTEXT:
- Company: {{companyName}} ({{domain}})
- Page: {{pageUrl}}

NOTE: Bulgarian SMBs often describe their business activities in the "За нас" (About Us) section rather than a dedicated services page. Extract the company's actual work from whichever section describes it.

RULES:
1. INCLUDE only specific services or products the company actually sells or performs.
2. Each entry must be concise — max 80 characters. Distill longer descriptions to the core activity.
3. NEVER include navigation labels such as: За Нас, Контакти, Меню, Начало, Мисия, Визия, Отговорност, Сертификати, Екип, Новини, Блог, Галерия, Партньори, Кариери, About, Contact, Home, Team, or any similar page/menu names.
4. NEVER include calls-to-action: Виж повече, Прочети, Read more, Свържи се с нас, Научи повече, Поръчай, Запитване, or similar phrases.
5. NEVER include duplicates — if the same item appears multiple times in the text, list it only once.
6. Aim for 3–8 distinct entries. If you find more than 10 candidates, you are likely including noise — be more selective.
7. If the page does not clearly describe what the company sells or does, set no_services_found: true and confidence below 35.

OUTPUT (strict JSON only, no markdown fences):
{
  "services": ["конкретна услуга 1", "конкретна услуга 2"],
  "represented_brands": ["Brand 1"],
  "primary_industry": "Construction",
  "target_customers": "кратко описание",
  "no_services_found": false,
  "confidence": 0-100
}`;

const TEXT_HALF = 4_000;

const CONFIDENCE_THRESHOLD = 35;

function truncateText(text: string): string {
  if (text.length <= TEXT_HALF * 2) return text;
  return text.slice(0, TEXT_HALF) + '\n[...truncated...]\n' + text.slice(-TEXT_HALF);
}

function buildSystemPrompt(companyName: string, domain: string, pageUrl: string): string {
  return SYSTEM_PROMPT_TEMPLATE
    .replace('{{companyName}}', companyName)
    .replace('{{domain}}', domain)
    .replace('{{pageUrl}}', pageUrl);
}

async function callGroqApi(systemPrompt: string, userContent: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const model = groqFastModel();
  const body = JSON.stringify({
    model,
    max_tokens: maxTokensFor(model, 512),
    ...reasoningParams(model),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body,
    });

    if (res.status === 429 && attempt < 2) {
      const delay = (attempt + 1) * 8_000;
      console.warn(`[services-validation] Groq 429 rate limit — retry ${attempt + 1}/2 after ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Groq API responded ${res.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }

  throw new Error('Groq API: max retries exceeded after 429');
}

function parseResponse(raw: string): ValidatedServicesResult {
  const cleaned = raw
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .match(/\{[\s\S]*\}/);

  if (!cleaned) {
    return { services: [], represented_brands: [], no_services_found: true, confidence: 0 };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned[0]) as Record<string, unknown>;
  } catch {
    return { services: [], represented_brands: [], no_services_found: true, confidence: 0 };
  }

  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

  const represented_brands = Array.isArray(parsed.represented_brands)
    ? (parsed.represented_brands as unknown[])
        .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
        .map((b) => b.trim())
    : [];
  const primary_industry = typeof parsed.primary_industry === 'string' ? parsed.primary_industry.trim() : undefined;
  const target_customers = typeof parsed.target_customers === 'string' ? parsed.target_customers.trim() : undefined;
  const notes            = typeof parsed.notes === 'string' ? parsed.notes : undefined;

  if (confidence < CONFIDENCE_THRESHOLD) {
    return { services: [], represented_brands, primary_industry, target_customers, no_services_found: true, confidence, notes };
  }

  const services = Array.isArray(parsed.services)
    ? [...new Set(
        (parsed.services as unknown[])
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim()),
      )]
    : [];

  return {
    services,
    represented_brands,
    primary_industry,
    target_customers,
    no_services_found: Boolean(parsed.no_services_found) || services.length === 0,
    confidence,
    notes,
  };
}

export function selectServicesPages(pages: CrawledPage[]): CrawledPage[] {
  const withText = pages.filter((p) => p.text && p.text.length > 50);
  if (withText.length === 0) return [];

  const scored = withText.map((p) => {
    let score = 0;
    const url = p.url.toLowerCase();

    if (
      /\/uslugi|\/uslug|\/services|\/service|\/deynost|\/dejnost|\/deinost|\/produkti|\/products|\/resheniya|\/resheniq|\/portfolio|\/katalog|\/proizvodstvo/i.test(url) ||
      /\/услуг|\/продукт|\/дейност|\/решени|\/производств/i.test(url)
    ) {
      score += 100;
    } else if (/\/about|\/za-nas|\/za-firmata|\/about-us|\/aboutus/i.test(url)) {
      score += 50;
    } else if (/^https?:\/\/[^/]+\/?$/.test(p.url)) {
      score += 10;
    }

    score += Math.min(Math.floor(p.text.length / 100), 40);

    return { page: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((s) => s.page);
}

export async function validateServices(
  companyName: string,
  domain: string,
  pageUrl: string,
  pageText: string,
  callFn: CallFn = callGroqApi,
): Promise<ValidatedServicesResult> {
  const systemPrompt = buildSystemPrompt(companyName, domain, pageUrl);
  const userContent = truncateText(pageText);

  const raw = await callFn(systemPrompt, userContent);
  return parseResponse(raw);
}
