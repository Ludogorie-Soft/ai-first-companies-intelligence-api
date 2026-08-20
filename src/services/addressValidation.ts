import { groqFastModel, maxTokensFor, reasoningParams } from '../lib/groqModels';

type CallFn = (systemPrompt: string, userContent: string) => Promise<string>;

export interface ValidatedAddress {
  full_address: string;
  source: 'website' | 'search';
  confidence: number;
  note?: string;
}

export interface AddressValidationResult {
  primary?: ValidatedAddress;
  alternative?: ValidatedAddress;
  no_address_found: boolean;
  notes?: string;
}

const SYSTEM_PROMPT_TEMPLATE = `You are a B2B data extraction assistant for Bulgarian companies.

Extract the physical business address from the provided sources.

SOURCES (in priority order):
1. Website address: {{websiteAddress}}
2. Search candidates: {{searchCandidates}}

RULES:
- Prefer website address. Use search only if website has none.
- If both exist and differ: website = primary, search = alternative.
- REJECT if: city-only (no street), P.O. box, belongs to another company, from testimonial/SEO/navigation text.
- Valid Bulgarian formats: "ул. X 21, 3042 Згориград" / "бул. X 5, 3000 Враца" / "BG-3040 Beli Izvor"

OUTPUT (JSON only):
{
  "primary": { "full_address": "...", "source": "website|search", "confidence": 0-100 },
  "alternative": { "full_address": "...", "source": "website|search", "confidence": 0-100, "note": "..." },
  "no_address_found": true|false
}`;

const CONFIDENCE_THRESHOLD = 60;

function buildSystemPrompt(
  websiteAddress: string,
  searchCandidates: string[],
): string {
  const candidateStr = searchCandidates.length > 0
    ? searchCandidates.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : '  (none found)';
  return SYSTEM_PROMPT_TEMPLATE
    .replace('{{websiteAddress}}', websiteAddress || '(none found on website)')
    .replace('{{searchCandidates}}', candidateStr);
}

async function callGroqApi(systemPrompt: string, userContent: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const model = groqFastModel();

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokensFor(model, 256),
      ...reasoningParams(model),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq API responded ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? '';
}

function parseValidatedAddress(obj: unknown): ValidatedAddress | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const a = obj as Record<string, unknown>;
  const raw_address = typeof a.full_address === 'string' ? a.full_address.trim() : '';
  if (!raw_address) return undefined;
  // Take only the first address if the model joined multiple with a separator
  const full_address = raw_address.split(/\s*\|\s*/)[0].trim();
  const confidence = typeof a.confidence === 'number' ? a.confidence : 0;
  if (confidence < CONFIDENCE_THRESHOLD) return undefined;
  return {
    full_address,
    source: a.source === 'website' ? 'website' : 'search',
    confidence,
    note: typeof a.note === 'string' ? a.note : undefined,
  };
}

function parseResponse(raw: string): AddressValidationResult {
  const cleaned = raw
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .match(/\{[\s\S]*\}/);

  if (!cleaned) return { no_address_found: true };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned[0]) as Record<string, unknown>;
  } catch {
    return { no_address_found: true };
  }

  const primary = parseValidatedAddress(parsed.primary);
  const alternative = parseValidatedAddress(parsed.alternative);

  return {
    primary,
    alternative,
    no_address_found: Boolean(parsed.no_address_found) || !primary,
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  };
}

export async function validateAddress(
  companyName: string,
  domain: string,
  websiteAddress: string,
  searchCandidates: string[],
  callFn: CallFn = callGroqApi,
): Promise<AddressValidationResult> {
  const systemPrompt = buildSystemPrompt(websiteAddress, searchCandidates);
  const raw = await callFn(systemPrompt, `Validate address candidates for ${companyName} (${domain}).`);
  return parseResponse(raw);
}
