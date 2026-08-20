import { groqFastModel, maxTokensFor, reasoningParams } from '../lib/groqModels';
import {
  emailLanguageInstruction,
  type ResolvedEmailLanguage,
} from '../lib/emailLanguage';
import {
  buildSenderCompanyContext,
  SENDER_TRUTHFULNESS_RULES,
  type SenderCompanyInfo,
} from '../lib/senderCompany';

/** Target (recipient) company profile from crawl. */
interface ProfileInput {
  name?: string;
  description?: string;
  location?: string;
  services: string[];
  team: Array<{ name: string; position?: string }>;
  history?: string;
  emails: string[];
}

export interface PersonalizedOutput {
  emailSubject?: string;
  openingLine?: string;
  valueProposition?: string;
  fullMessage?: string;
}

function buildTargetContext(profile: ProfileInput): string {
  const lines: string[] = [];

  if (profile.name)        lines.push(`Company name: ${profile.name}`);
  if (profile.description) lines.push(`About: ${profile.description}`);
  if (profile.location)    lines.push(`Location: ${profile.location}`);

  if (profile.services.length > 0) {
    lines.push(`Services/Products: ${profile.services.slice(0, 10).join(', ')}`);
  }

  if (profile.team.length > 0) {
    const members = profile.team.slice(0, 5)
      .map((m) => (m.position ? `${m.name} (${m.position})` : m.name))
      .join(', ');
    lines.push(`Key people: ${members}`);
  }

  if (profile.history) {
    lines.push(`Background: ${profile.history.slice(0, 300)}`);
  }

  return lines.join('\n');
}

export async function generatePersonalizedContent(
  profile: ProfileInput,
  emailLanguage: ResolvedEmailLanguage = 'bg',
  sender?: SenderCompanyInfo,
): Promise<PersonalizedOutput | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn('[personalization] GROQ_API_KEY not set — skipping');
    return null;
  }

  const model = groqFastModel();

  const targetContext = buildTargetContext(profile);
  if (!targetContext.trim()) {
    console.warn('[personalization] No usable profile data — skipping');
    return null;
  }

  const senderContext = sender
    ? buildSenderCompanyContext(sender)
    : '';
  const senderBlock = senderContext.trim()
    ? `SENDER COMPANY DATA (your company — the only source of truth for what YOU offer):\n${senderContext}`
    : `SENDER COMPANY DATA: (not provided — do NOT invent products, services, experience, or case studies about the sender)`;

  const prompt = `You are a B2B sales expert writing personalized cold outreach emails.

Write outreach FROM the sender company TO the target company.

TARGET COMPANY (the recipient — use for personalization only):
${targetContext}

${senderBlock}

${SENDER_TRUTHFULNESS_RULES}

Generate a JSON object with exactly these fields:
{
  "emailSubject": "short compelling subject line, under 60 characters",
  "openingLine": "personalized first sentence referencing something specific about the TARGET company (1-2 sentences)",
  "valueProposition": "how the SENDER can help — based ONLY on SENDER COMPANY DATA, tied to the TARGET's context (1-2 sentences). If sender data is missing, write a cautious non-claiming sentence.",
  "fullMessage": "complete professional email body (3-4 short paragraphs, professional but conversational tone, no greeting or sign-off). Personalize to TARGET; claim about SENDER only what is in SENDER COMPANY DATA."
}

Rules:
- Use TARGET facts only to show you researched them — never invent TARGET facts either
- ${emailLanguageInstruction(emailLanguage)}
- Output ONLY valid JSON with no additional text or markdown fences

JSON:`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: maxTokensFor(model, 700),
        ...reasoningParams(model),
      }),
    });

    if (!res.ok) {
      console.warn(`[personalization] Groq API responded ${res.status} — skipping`);
      return null;
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const raw = (data.choices[0]?.message?.content ?? '').trim();

    // Strip markdown code fences if present, then extract JSON object
    const jsonMatch = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[personalization] No JSON object in Groq response — storing raw text as fullMessage');
      return raw.length > 0 ? { fullMessage: raw.slice(0, 2000) } : null;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      console.warn('[personalization] JSON.parse failed — storing raw text as fullMessage');
      return raw.length > 0 ? { fullMessage: raw.slice(0, 2000) } : null;
    }

    return {
      emailSubject:     typeof parsed.emailSubject     === 'string' ? parsed.emailSubject     : undefined,
      openingLine:      typeof parsed.openingLine      === 'string' ? parsed.openingLine      : undefined,
      valueProposition: typeof parsed.valueProposition === 'string' ? parsed.valueProposition : undefined,
      fullMessage:      typeof parsed.fullMessage      === 'string' ? parsed.fullMessage      : undefined,
    };
  } catch (err) {
    console.error('[personalization] Unexpected error:', err);
    return null;
  }
}
