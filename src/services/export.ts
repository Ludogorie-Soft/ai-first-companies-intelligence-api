import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma';
import { StorageService } from './storage';

interface TeamMember {
  name?: string;
  position?: string;
  email?: string;
  linkedin?: string;
}

function serializeTeam(raw: unknown): string {
  if (!raw) return '';
  const arr: TeamMember[] = Array.isArray(raw) ? (raw as TeamMember[]) : [];
  return arr
    .map((m) => {
      let s = m.name ?? '';
      if (m.position) s += s ? ` (${m.position})` : m.position;
      if (m.email) s += ` <${m.email}>`;
      return s.trim();
    })
    .filter(Boolean)
    .join('; ');
}

function splitPersonName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function websiteFromDomain(domain: string): string {
  if (!domain) return '';
  if (/^https?:\/\//i.test(domain)) return domain;
  return `https://${domain}`;
}

function firstEmail(emails: string[]): string {
  return emails[0] ?? '';
}

/** Columns from leads_template - test2.xlsx (same order). */
const LEADS_TEMPLATE_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: 'First Name',        key: 'firstName',        width: 18 },
  { header: 'Last Name',         key: 'lastName',         width: 18 },
  { header: 'Job Title',         key: 'jobTitle',         width: 28 },
  { header: 'Email',             key: 'personalEmail',    width: 35 },
  { header: 'Linkedin URL',      key: 'personalLinkedin', width: 45 },
  { header: 'Facebook URL',      key: 'facebookUrl',      width: 45 },
  { header: 'Company',           key: 'company',          width: 30 },
  { header: 'Website',           key: 'website',          width: 35 },
  { header: 'Office Email',      key: 'officeEmail',      width: 35 },
  { header: 'Telephone',         key: 'telephone',        width: 25 },
  { header: 'Company Linkedin',  key: 'companyLinkedin',  width: 45 },
  { header: 'Size',              key: 'size',             width: 12 },
  { header: 'Industry',          key: 'industry',         width: 25 },
  { header: 'Location',          key: 'leadLocation',     width: 30 },
];

/** Existing enrichment columns appended after the leads template. */
const ENRICHMENT_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: 'Domain',           key: 'domain',          width: 30 },
  { header: 'Name',             key: 'name',            width: 30 },
  { header: 'Description',      key: 'description',     width: 50 },
  { header: 'Location',         key: 'location',        width: 25 },
  { header: 'Emails',           key: 'emails',          width: 40 },
  { header: 'Phones',           key: 'phones',          width: 30 },
  { header: 'Services',         key: 'services',        width: 50 },
  { header: 'Team',             key: 'team',            width: 60 },
  { header: 'Facebook',         key: 'facebook',        width: 45 },
  { header: 'LinkedIn',         key: 'linkedin',        width: 45 },
  { header: 'Other Social',     key: 'socialLinks',     width: 50 },
  { header: 'Completion Score', key: 'completionScore', width: 18 },
  { header: 'Crawl Status',     key: 'crawlStatus',     width: 15 },
  { header: 'Crawl Note',       key: 'crawlNote',       width: 60 },
  { header: 'Login Protected',  key: 'loginProtected',  width: 15 },
  { header: 'Email Subject',    key: 'emailSubject',    width: 50 },
  { header: 'Outreach Message', key: 'outreachMessage', width: 80 },
  { header: 'Campaign Email',   key: 'campaignEmail',   width: 80 },
];

interface EnrichmentFields {
  domain: string;
  name: string;
  description: string;
  location: string;
  emails: string;
  phones: string;
  services: string;
  team: string;
  facebook: string;
  linkedin: string;
  socialLinks: string;
  completionScore: number;
  crawlStatus: string;
  crawlNote: string;
  loginProtected: string;
  emailSubject: string;
  outreachMessage: string;
  campaignEmail: string;
  industry: string;
  emailsList: string[];
  phonesList: string[];
  teamMembers: TeamMember[];
}

interface ExportRow extends EnrichmentFields {
  firstName: string;
  lastName: string;
  jobTitle: string;
  personalEmail: string;
  personalLinkedin: string;
  facebookUrl: string;
  company: string;
  website: string;
  officeEmail: string;
  telephone: string;
  companyLinkedin: string;
  size: string;
  leadLocation: string;
}

function buildEnrichment(c: {
  domain: string;
  name: string | null;
  crawlStatus: string;
  crawlNote: string | null;
  profile: {
    name: string | null;
    description: string | null;
    location: string | null;
    emails: unknown;
    phones: unknown;
    services: unknown;
    team: unknown;
    socialLinks: unknown;
    completionScore: number;
    loginProtected: boolean;
    campaignEmail: string | null;
    primaryIndustry: string | null;
  } | null;
  personalizedContent: {
    emailSubject: string | null;
    fullMessage: string | null;
  } | null;
}): EnrichmentFields {
  const social = (c.profile?.socialLinks ?? {}) as Record<string, string>;
  const emailsList = Array.isArray(c.profile?.emails) ? (c.profile!.emails as string[]) : [];
  const phonesList = Array.isArray(c.profile?.phones) ? (c.profile!.phones as string[]) : [];
  const teamMembers = Array.isArray(c.profile?.team) ? (c.profile!.team as TeamMember[]) : [];
  const name = c.profile?.name || c.name || '';

  return {
    domain: c.domain,
    name,
    description: c.profile?.description ?? '',
    location: c.profile?.location ?? '',
    emails: emailsList.join(', '),
    phones: phonesList.join(', '),
    services: Array.isArray(c.profile?.services) ? (c.profile!.services as string[]).join(', ') : '',
    team: serializeTeam(teamMembers),
    facebook: social['facebook'] ?? '',
    linkedin: social['linkedin'] ?? '',
    socialLinks: Object.entries(social)
      .filter(([k, v]) => v && k !== 'facebook' && k !== 'linkedin')
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | '),
    completionScore: c.profile?.completionScore ?? 0,
    crawlStatus: c.crawlStatus,
    crawlNote: c.crawlNote ?? '',
    loginProtected: c.profile?.loginProtected ? 'Yes' : 'No',
    emailSubject: c.personalizedContent?.emailSubject ?? '',
    outreachMessage: c.personalizedContent?.fullMessage ?? '',
    campaignEmail: c.profile?.campaignEmail ?? '',
    industry: c.profile?.primaryIndustry ?? '',
    emailsList,
    phonesList,
    teamMembers,
  };
}

function toLeadRows(base: EnrichmentFields): ExportRow[] {
  const companyFields = {
    facebookUrl: base.facebook,
    company: base.name,
    website: websiteFromDomain(base.domain),
    officeEmail: firstEmail(base.emailsList),
    telephone: base.phonesList.join(', '),
    companyLinkedin: base.linkedin,
    size: '',
    industry: base.industry,
    leadLocation: base.location,
  };

  const members = base.teamMembers.filter((m) => (m.name ?? '').trim());

  if (members.length === 0) {
    return [{
      ...base,
      ...companyFields,
      firstName: '',
      lastName: '',
      jobTitle: '',
      personalEmail: '',
      personalLinkedin: '',
    }];
  }

  return members.map((m) => {
    const { firstName, lastName } = splitPersonName(m.name ?? '');
    return {
      ...base,
      ...companyFields,
      firstName,
      lastName,
      jobTitle: m.position ?? '',
      personalEmail: m.email ?? '',
      personalLinkedin: m.linkedin ?? '',
    };
  });
}

function toLegacyRows(base: EnrichmentFields): ExportRow[] {
  return [{
    ...base,
    firstName: '',
    lastName: '',
    jobTitle: '',
    personalEmail: '',
    personalLinkedin: '',
    facebookUrl: base.facebook,
    company: base.name,
    website: websiteFromDomain(base.domain),
    officeEmail: firstEmail(base.emailsList),
    telephone: base.phones,
    companyLinkedin: base.linkedin,
    size: '',
    leadLocation: base.location,
  }];
}

async function fetchRows(batchId: string, tenantId: string, personaFormat: boolean): Promise<ExportRow[]> {
  const companies = await prisma.company.findMany({
    where: {
      tenantCompanies: { some: { tenantId, sourceBatchId: batchId, excluded: false } },
    },
    include: { profile: true, personalizedContent: true },
  });

  const rows: ExportRow[] = [];
  for (const c of companies) {
    const base = buildEnrichment(c);
    rows.push(...(personaFormat ? toLeadRows(base) : toLegacyRows(base)));
  }
  return rows;
}

function writeCsv(rows: ExportRow[], columns: Array<{ header: string; key: string }>): string {
  const escape = (v: string | number) => {
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  return [
    columns.map((c) => c.header).join(','),
    ...rows.map((r) =>
      columns
        .map((c) => escape((r as unknown as Record<string, string | number>)[c.key] ?? ''))
        .join(','),
    ),
  ].join('\n');
}

export const ExportService = {
  async exportBatch(
    batchId: string,
    tenantId: string,
    format: 'csv' | 'xlsx',
  ): Promise<string> {
    const batch = await prisma.crawlBatch.findFirst({
      where: { id: batchId, tenantId },
      select: { sourceType: true },
    });
    const personaFormat = batch?.sourceType === 'PERSONA_SEARCH';

    const rows = await fetchRows(batchId, tenantId, personaFormat);
    const filename = `export-${batchId}-${Date.now()}.${format}`;
    const subdir = `exports/${tenantId}`;

    const columns = personaFormat
      ? [...LEADS_TEMPLATE_COLUMNS, ...ENRICHMENT_COLUMNS]
      : ENRICHMENT_COLUMNS;

    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(personaFormat ? 'Leads' : 'Companies');
      sheet.columns = columns;
      sheet.addRows(rows);

      const buffer = await workbook.xlsx.writeBuffer();
      return StorageService.save(subdir, filename, Buffer.from(buffer));
    }

    return StorageService.save(subdir, filename, writeCsv(rows, columns));
  },
};
