/** Preference chosen on the persona-search form (and stored on batch.searchQuery). */
export type EmailLanguagePreference = 'bg' | 'en' | 'website';

/** Concrete language used in LLM prompts after resolving "website". */
export type ResolvedEmailLanguage = 'bg' | 'en';

export function parseEmailLanguage(value: unknown): EmailLanguagePreference {
  if (value === 'en' || value === 'website' || value === 'bg') return value;
  return 'bg';
}

export function emailLanguageFromSearchQuery(searchQuery: unknown): EmailLanguagePreference {
  if (!searchQuery || typeof searchQuery !== 'object') return 'bg';
  return parseEmailLanguage((searchQuery as Record<string, unknown>).emailLanguage);
}

export function resolveEmailLanguage(
  preference: EmailLanguagePreference,
  detectedWebsiteLanguage?: ResolvedEmailLanguage | null,
): ResolvedEmailLanguage {
  if (preference === 'bg' || preference === 'en') return preference;
  return detectedWebsiteLanguage ?? 'bg';
}

/** Instruction appended to personalization / campaign-email prompts. */
export function emailLanguageInstruction(lang: ResolvedEmailLanguage): string {
  if (lang === 'bg') {
    return 'LANGUAGE REQUIREMENT: Write ALL generated text (subject, body, every sentence) in Bulgarian (български език). Do not use English except for proper nouns, brand names, or URLs.';
  }
  return 'LANGUAGE REQUIREMENT: Write ALL generated text (subject, body, every sentence) in English.';
}
