import {
  emailLanguageInstruction,
  type ResolvedEmailLanguage,
} from '../lib/emailLanguage';
import { SENDER_TRUTHFULNESS_RULES } from '../lib/senderCompany';

interface TeamMember {
  name: string;
  position?: string;
  email?: string;
  linkedin?: string;
}

export interface CampaignEmailParams {
  targetName: string;
  targetDomain: string;
  targetDescription: string;
  targetServices: string[];
  targetLocation: string;
  targetTeam: TeamMember[];

  senderCompanyName: string;
  senderWebsite: string;
  senderContactName: string;
  senderContactTitle: string;
  senderContactEmail: string;
  senderContactPhone: string;
  senderAboutUs?: string;
  senderProductsServices?: string;
  senderPortfolio?: string;

  /** Resolved output language for the filled email (defaults to Bulgarian). */
  emailLanguage?: ResolvedEmailLanguage;
}

type CallFn = (systemPrompt: string, userContent: string) => Promise<string>;

const CONTACT_PRIORITY_PATTERNS = [
  /изпълнителен директор|CEO|управител|главен директор|president|собственик|owner/i,
  /търговски директор|sales director|commercial director|бизнес развитие|business development/i,
  /HR мениджър|HR manager|мениджър.*човешки|human resources/i,
];

function findTargetContact(team: TeamMember[]): TeamMember | undefined {
  for (const pattern of CONTACT_PRIORITY_PATTERNS) {
    const found = team.find((m) => m.position && pattern.test(m.position));
    if (found) return found;
  }
  return undefined;
}

function buildPrompts(params: CampaignEmailParams, templateBody: string): { system: string; user: string } {
  const contact = findTargetContact(params.targetTeam);
  const targetContactPerson = contact
    ? `${contact.name}${contact.position ? ` (${contact.position})` : ''}`
    : 'не е намерен';
  const lang = params.emailLanguage ?? 'bg';

  const system = `You are a B2B outreach specialist. Fill in the provided email template using the company and sender data. Replace every {{placeholder}} tag with the matching value. Return only the final email text. ${emailLanguageInstruction(lang)} If the template is in another language, translate the filled email into the required language while preserving meaning and tone.

${SENDER_TRUTHFULNESS_RULES}
When expanding placeholders or free text about the sender's offer, use ONLY SENDER About us / Products / Portfolio below. Do not invent experience or capabilities.`;

  const user = `TARGET COMPANY:
- Name: ${params.targetName}
- Website: ${params.targetDomain}
- Description: ${params.targetDescription || 'no data'}
- Services: ${params.targetServices.slice(0, 8).join(', ') || 'no data'}
- Location: ${params.targetLocation || 'no data'}
- Contact person: ${targetContactPerson}

SENDER:
- Company: ${params.senderCompanyName}
- Website: ${params.senderWebsite}
- Name: ${params.senderContactName}
- Title: ${params.senderContactTitle}
- Email: ${params.senderContactEmail}
- Phone: ${params.senderContactPhone}
- About us: ${params.senderAboutUs?.trim() || '(not provided)'}
- Products / services: ${params.senderProductsServices?.trim() || '(not provided)'}
- Portfolio / case studies: ${params.senderPortfolio?.trim() || '(not provided)'}

TEMPLATE:
---
${templateBody}
---

Return only the filled email text. No JSON, no explanation.`;

  return { system, user };
}

async function callGroqApi(systemPrompt: string, userContent: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
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

export async function generateCampaignEmail(
  params: CampaignEmailParams,
  callFn: CallFn = callGroqApi,
  templateBody?: string,
): Promise<string | null> {
  if (!templateBody) return null;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn('[campaignEmail] GROQ_API_KEY not set — skipping');
    return null;
  }

  const { system, user } = buildPrompts(params, templateBody);

  try {
    const raw = await callFn(system, user);
    const text = raw.trim();
    return text.length > 0 ? text : null;
  } catch (err) {
    console.error('[campaignEmail] Unexpected error:', err);
    return null;
  }
}
