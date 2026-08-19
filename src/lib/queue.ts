import PgBoss from 'pg-boss';
import type { EmailLanguagePreference, ResolvedEmailLanguage } from './emailLanguage';

export const QUEUES = {
  CRAWL_COMPANY:       'crawl-company',
  DISCOVER_PERSONA:    'discover-persona',
  PERSONALIZE_COMPANY: 'personalize-company',
} as const;

export interface CrawlCompanyPayload {
  companyId: string;
  domain: string;
  baseUrl: string;
  batchId: string;
  tenantId: string;
  templateId?: string;
  /** Preferred language for Email Subject / Outreach Message / Campaign Email. */
  emailLanguage?: EmailLanguagePreference;
  /**
   * The persona search this crawl came from. Set only for PERSONA_SEARCH batches;
   * a CSV upload has no search criteria to verify against, so leaving these
   * undefined is what makes post-crawl verification skip uploaded batches entirely.
   */
  persona?: string;
  location?: string;
}

export interface DiscoverPersonaPayload {
  batchId: string;
  tenantId: string;
  persona: string;
  location: string;
  keywords?: string;
  maxResults?: number;
  forceRecrawl?: boolean;
  templateId?: string;
  emailLanguage?: EmailLanguagePreference;
}

export interface PersonalizeCompanyPayload {
  companyId: string;
  tenantId?: string;
  /** Already-resolved language for personalization prompts. */
  emailLanguage?: ResolvedEmailLanguage;
}

const globalForBoss = globalThis as unknown as { __pgBoss?: PgBoss | null; __pgBossPromise?: Promise<PgBoss> | null };

function isVercelRuntime(): boolean {
  return process.env.VERCEL === '1' || process.env.VERCEL === 'true';
}

function queueConnectionString(): string {
  return process.env.QUEUE_DATABASE_URL || process.env.DATABASE_URL || '';
}

export async function getQueue(): Promise<PgBoss> {
  if (globalForBoss.__pgBoss) return globalForBoss.__pgBoss;
  if (globalForBoss.__pgBossPromise) return globalForBoss.__pgBossPromise;

  const connectionString = queueConnectionString();
  if (!connectionString) {
    throw new Error('[pg-boss] DATABASE_URL or QUEUE_DATABASE_URL is required');
  }

  globalForBoss.__pgBossPromise = (async () => {
    const vercel = isVercelRuntime();
    const boss = new PgBoss({
      connectionString,
      retentionDays: 7,
      // On Vercel the API only enqueues; the Mac worker runs supervise/schedule.
      supervise: !vercel,
      schedule: !vercel,
      // Avoid opening a large pool per serverless isolate.
      max: vercel ? 2 : undefined,
    });

    boss.on('error', (err) => {
      console.error('[pg-boss] error:', err);
    });

    await boss.start();

    // pg-boss v10 requires queues to be created before sending
    await boss.createQueue(QUEUES.CRAWL_COMPANY);
    await boss.createQueue(QUEUES.DISCOVER_PERSONA);
    await boss.createQueue(QUEUES.PERSONALIZE_COMPANY);

    console.log(`[pg-boss] started (vercel=${vercel}, supervise=${!vercel})`);
    globalForBoss.__pgBoss = boss;
    return boss;
  })();

  try {
    return await globalForBoss.__pgBossPromise;
  } catch (err) {
    globalForBoss.__pgBossPromise = null;
    throw err;
  }
}

export async function enqueueCrawlJob(
  payload: CrawlCompanyPayload,
  queue: PgBoss
): Promise<void> {
  console.log('[enqueue] crawl-company', {
    companyId: payload.companyId,
    domain: payload.domain,
  });
  await queue.send(QUEUES.CRAWL_COMPANY, payload as unknown as object, {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
  });
}

export async function enqueueDiscoverJob(
  payload: DiscoverPersonaPayload,
  queue: PgBoss
): Promise<void> {
  await queue.send(QUEUES.DISCOVER_PERSONA, payload as unknown as object, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: false,
  });
}

export async function enqueuePersonalizeJob(
  payload: PersonalizeCompanyPayload,
  queue: PgBoss
): Promise<void> {
  await queue.send(QUEUES.PERSONALIZE_COMPANY, payload as unknown as object, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
  });
}

export async function stopQueue(): Promise<void> {
  const boss = globalForBoss.__pgBoss;
  if (boss) {
    await boss.stop();
    globalForBoss.__pgBoss = null;
    globalForBoss.__pgBossPromise = null;
  }
}
