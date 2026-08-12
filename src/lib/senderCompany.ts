/** Sender (tenant) company facts used for truthful outreach generation. */
export interface SenderCompanyInfo {
  companyName?: string;
  website?: string;
  aboutUs?: string;
  productsServices?: string;
  portfolio?: string;
}

export function buildSenderCompanyContext(sender: SenderCompanyInfo): string {
  const lines: string[] = [];
  if (sender.companyName) lines.push(`Company name: ${sender.companyName}`);
  if (sender.website) lines.push(`Website: ${sender.website}`);
  if (sender.aboutUs?.trim()) lines.push(`About us:\n${sender.aboutUs.trim()}`);
  if (sender.productsServices?.trim()) {
    lines.push(`Products / services:\n${sender.productsServices.trim()}`);
  }
  if (sender.portfolio?.trim()) lines.push(`Portfolio / case studies:\n${sender.portfolio.trim()}`);
  return lines.join('\n\n');
}

/** Shared truthfulness rules for Email Subject, Outreach Message, Campaign Email. */
export const SENDER_TRUTHFULNESS_RULES = `TRUTHFULNESS RULES (critical):
- Claims about YOUR company (competencies, experience, products, services, case studies, clients, results) MUST come ONLY from the SENDER COMPANY DATA below.
- NEVER invent, exaggerate, or assume capabilities, years of experience, certifications, industries served, client names, or results that are not explicitly stated in SENDER COMPANY DATA.
- If SENDER COMPANY DATA is empty or incomplete, write a short honest outreach that personalizes to the TARGET using only TARGET facts, and do NOT invent what your company offers — stay generic ("we would like to explore a collaboration") without false claims.
- You MAY personalize using TARGET COMPANY facts (name, services, location, etc.) — those describe the recipient, not you.
- Do not promise outcomes you cannot support from SENDER COMPANY DATA.`;
