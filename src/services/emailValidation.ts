import { groqFastModel, maxTokensFor, reasoningParams } from '../lib/groqModels';
import type { CrawledPage } from '../worker/crawl';

export interface ValidatedEmail {
  email: string;
  type: 'primary' | 'secondary' | 'personal';
  personal_domain: boolean;
  domain_match: boolean;
  confidence: number;
}

export interface EmailValidationResult {
  verified: string[];
  unverified: ValidatedEmail[];
  no_emails_found: boolean;
  notes?: string;
}

type CallFn = (systemPrompt: string, userContent: string) => Promise<string>;

const SYSTEM_PROMPT_TEMPLATE = `You are a B2B data assistant for Bulgarian companies.

Classify these already-extracted emails for {{companyName}} ({{domain}}).

For each email set: type (primary/secondary/personal), personal_domain (true if abv.bg/gmail/yahoo etc), domain_match (true if matches {{domain}}).

OUTPUT (JSON only):
{
  "emails": [
    { "email": "...", "type": "primary|secondary|personal", "personal_domain": false, "domain_match": true, "confidence": 0-100 }
  ],
  "no_emails_found": false
}`;

const CONFIDENCE_THRESHOLD = 70;

function buildSystemPrompt(companyName: string, domain: string): string {
  return SYSTEM_PROMPT_TEMPLATE
    .replace(/\{\{companyName\}\}/g, companyName)
    .replace(/\{\{domain\}\}/g, domain);
}

async function callGroqApi(systemPrompt: string, userContent: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const model = groqFastModel();
  const body = JSON.stringify({
    model,
    max_tokens: maxTokensFor(model, 256),
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
      console.warn(`[email-validation] Groq 429 rate limit — retry ${attempt + 1}/2 after ${delay}ms`);
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

function parseResponse(raw: string): EmailValidationResult {
  const cleaned = raw
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .match(/\{[\s\S]*\}/);

  if (!cleaned) {
    return { verified: [], unverified: [], no_emails_found: true };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned[0]) as Record<string, unknown>;
  } catch {
    return { verified: [], unverified: [], no_emails_found: true };
  }

  const rawEmails = Array.isArray(parsed.emails) ? parsed.emails as unknown[] : [];
  const verified: string[] = [];
  const unverified: ValidatedEmail[] = [];

  for (const item of rawEmails) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const email = typeof e.email === 'string' ? e.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) continue;

    const validated: ValidatedEmail = {
      email,
      type: (e.type === 'primary' || e.type === 'secondary' || e.type === 'personal')
        ? e.type
        : 'secondary',
      personal_domain: Boolean(e.personal_domain),
      domain_match: e.domain_match !== false,
      confidence: typeof e.confidence === 'number' ? e.confidence : 0,
    };

    if (validated.confidence >= CONFIDENCE_THRESHOLD) {
      verified.push(email);
    } else {
      unverified.push(validated);
    }
  }

  return {
    verified,
    unverified,
    no_emails_found: Boolean(parsed.no_emails_found) || verified.length + unverified.length === 0,
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  };
}

// Picks the best page to validate: prefers contact/about URLs, falls back to
// whichever page has the most email addresses.
export function selectPageForValidation(pages: CrawledPage[]): CrawledPage | undefined {
  const withHtml = pages.filter((p) => p.html && p.html.length > 100);
  if (withHtml.length === 0) return undefined;

  const contact = withHtml.find((p) =>
    /kontakt|contact|about|za-nas|about-us|\bcontacte?\b/i.test(p.url),
  );
  if (contact) return contact;

  return withHtml.sort((a, b) => b.emails.length - a.emails.length)[0];
}

export async function validateEmails(
  companyName: string,
  domain: string,
  emails: string[],
  callFn: CallFn = callGroqApi,
): Promise<EmailValidationResult> {
  const systemPrompt = buildSystemPrompt(companyName, domain);
  const userContent = `Emails found: ${emails.join(', ')}`;

  const raw = await callFn(systemPrompt, userContent);
  return parseResponse(raw);
}
