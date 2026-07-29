import 'dotenv/config';
import { isNonCrawlablePlatform, platformMetrics, NON_CRAWLABLE_PLATFORM_NOTE } from '../services/nonCrawlablePlatforms';
import { normalizeRawProfileUrl } from '../lib/normalizeRawProfileUrl';
import { rawProfileCacheDecision } from '../lib/rawProfileCache';
import { getQueue, QUEUES, CrawlCompanyPayload, DiscoverPersonaPayload, PersonalizeCompanyPayload, enqueueCrawlJob, enqueuePersonalizeJob, stopQueue } from '../lib/queue';
import { prisma } from '../lib/prisma';
import { crawlCompany, detectBotProtection, BOT_CRAWL_NOTE } from './crawl';
import { extractProfile, isGenericAuthName } from '../services/extraction';
import { enrichSocialLinks } from '../services/socialEnrichment';
import { enrichAddress } from '../services/addressEnrichment';
import { validateAddress } from '../services/addressValidation';
import { validateEmails } from '../services/emailValidation';
import { validateServices, selectServicesPages } from '../services/servicesValidation';
import { runLoginFallbackEnrichment } from '../services/loginFallbackEnrichment';
import { DiscoveryOrchestrator, SearchProviderError } from '../services/discovery/index';
import { buildDiscoveryKey } from '../services/discovery/discoveryKey';
import { findCachedDiscovery, copyCandidatesToBatch } from '../services/discovery/discoveryCache';
import { checkFreshness } from '../lib/freshness';
import { generatePersonalizedContent } from '../services/personalization';
import { generateCampaignEmail } from '../services/campaignEmailGeneration';
import PgBoss from 'pg-boss';

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);

async function processJob(jobs: PgBoss.JobWithMetadata<CrawlCompanyPayload>[]): Promise<void> {
  for (const job of jobs) {
    await processSingleJob(job);
  }
}

async function processSingleJob(job: PgBoss.JobWithMetadata<CrawlCompanyPayload>): Promise<void> {
  const { companyId, domain, baseUrl, batchId, tenantId, templateId } = job.data;
  console.log(`[worker] processing ${domain} (${companyId})`);

  // Final safety guard — abort immediately if a non-crawlable platform somehow reached the worker.
  if (isNonCrawlablePlatform(domain)) {
    console.log(`[crawl] blocked ${domain} reason=non_crawlable_platform`);
    platformMetrics.nonCrawlableRejected++;
    await prisma.company.update({
      where: { id: companyId },
      data: { crawlStatus: 'BLOCKED', crawlNote: NON_CRAWLABLE_PLATFORM_NOTE },
    });
    await updateBatchProgress(batchId);
    return;
  }

  // Mark company as crawling
  await prisma.company.update({
    where: { id: companyId },
    data: { crawlStatus: 'CRAWLING' },
  });

  try {
    // 1. Crawl pages
    const pages = await crawlCompany(baseUrl);

    if (pages.length === 0) {
      // Host is unreachable — mark failed immediately, no retry
      await prisma.company.update({
        where: { id: companyId },
        data: { crawlStatus: 'FAILED' },
      });
      await updateBatchProgress(batchId);
      console.log(`[worker] skipped ${domain} — unreachable (no pages)`);
      return;
    }

    // 1b. Bot-protection check — if detected, mark BLOCKED and stop without extracting
    const { blocked, indicator } = detectBotProtection(pages);
    if (blocked) {
      await prisma.company.update({
        where: { id: companyId },
        data: { crawlStatus: 'BLOCKED', crawlNote: BOT_CRAWL_NOTE },
      });
      await updateBatchProgress(batchId);
      console.log(`[worker] blocked ${domain} — bot protection detected (${indicator})`);
      return;
    }

    // 2. Save raw data — upsert per page using (companyId, normalizedUrl) as the dedup key.
    // Decision: skip (fresh <7d) | update (stale ≥7d) | create (new) — see lib/rawProfileCache.ts
    for (const p of pages) {
      const normalizedUrl = normalizeRawProfileUrl(p.url);
      const pageData = { text: p.text, emails: p.emails, phones: p.phones };

      const existing = await prisma.rawCompanyProfile.findUnique({
        where: { companyId_normalizedUrl: { companyId, normalizedUrl } },
        select: { id: true, updatedAt: true },
      });

      const action = rawProfileCacheDecision(existing);

      if (action === 'skip') {
        continue;
      } else if (action === 'update') {
        await prisma.rawCompanyProfile.update({
          where: { id: existing!.id },
          data: { specificUrl: p.url, data: pageData },
        });
      } else {
        await prisma.rawCompanyProfile.create({
          data: { companyId, baseUrl, specificUrl: p.url, normalizedUrl, data: pageData },
        });
      }
    }

    // 3. Extract processed profile
    const profile = extractProfile(pages);

    console.log(`[worker:profile] ${domain} — pages(${pages.length})=${JSON.stringify(pages.map(p => p.url))} emails(${profile.emails.length})=${JSON.stringify(profile.emails)}`);

    // 3b. Enrich missing social links from search (best-effort, non-critical)
    try {
      const enrichedSocial = await enrichSocialLinks(profile, domain);
      if (Object.keys(enrichedSocial).length > 0) {
        const hadSocial = Object.keys(profile.socialLinks).length > 0;
        profile.socialLinks = { ...profile.socialLinks, ...enrichedSocial };
        if (!hadSocial) profile.completionScore += 5; // FIELD_WEIGHTS.socialLinks
      }
    } catch { /* non-critical */ }

    // 3c. Login-page fallback enrichment — when normal extraction yielded very little
    // (score < 30 or no name) and the homepage is a login wall, use the visible logo
    // to identify the company and discover social profiles via secondary search.
    const isLoginProtected = pages.some((p) => p.loginProtected);
    let loginFallback: Awaited<ReturnType<typeof runLoginFallbackEnrichment>> | null = null;

    // Treat a generic auth title ("login", "вход", "portal" …) the same as a missing name:
    // the page title of a login wall is never a real company name.
    const nameIsMissingOrGeneric = !profile.name || isGenericAuthName(profile.name);

    if (isLoginProtected && (profile.completionScore < 30 || nameIsMissingOrGeneric)) {
      try {
        loginFallback = await runLoginFallbackEnrichment(pages, domain);
        console.log(
          `[worker:login-fallback] ${domain} — name="${loginFallback.companyNameFromLogo ?? 'n/a'}" ` +
          `confidence=${loginFallback.logoNameConfidence}`,
        );
        // Merge fallback data into live profile.
        // Allow OCR name to replace a generic auth title (e.g. "login" → "Walltopia").
        if (nameIsMissingOrGeneric && loginFallback.enrichedName)
          profile.name = loginFallback.enrichedName;
        if (!profile.description && loginFallback.enrichedDescription)
          profile.description = loginFallback.enrichedDescription;
        if (Object.keys(loginFallback.enrichedSocialLinks).length > 0)
          profile.socialLinks = { ...loginFallback.enrichedSocialLinks, ...profile.socialLinks };
        profile.completionScore = Math.min(100, profile.completionScore + loginFallback.scoreBonus);
      } catch { /* non-critical — fallback must never break the crawl pipeline */ }
    }

    // 3d. Address validation — enrichAddress gathers search candidates first;
    // validateAddress uses both the website candidate and search candidates.
    // enrichAddress result serves as fallback if AI validation fails or finds nothing.
    let aiFoundAddress = false;
    let enrichResult: Awaited<ReturnType<typeof enrichAddress>> | undefined;
    try {
      enrichResult = await enrichAddress(profile, domain);
    } catch { /* non-critical */ }

    try {
      console.log(`[worker:address-validation] ${domain} GROQ_API_KEY=${!!process.env.GROQ_API_KEY}`);
      const addrVal = await validateAddress(
        profile.name ?? domain,
        domain,
        profile.location ?? '',
        enrichResult?.searchCandidates ?? [],
      );
      if (addrVal.primary) {
        const hadLocation = !!profile.location;
        profile.location = addrVal.primary.full_address;
        aiFoundAddress = true;
        if (!hadLocation) profile.completionScore = Math.min(100, profile.completionScore + 10);
        console.log(
          `[worker:address-validation] ${domain} → "${addrVal.primary.full_address}" source=${addrVal.primary.source} (confidence=${addrVal.primary.confidence})`,
        );
      }
      if (addrVal.notes) {
        console.log(`[worker:address-validation] ${domain} notes="${addrVal.notes}"`);
      }
    } catch (e) {
      console.warn(`[worker:address-validation] ${domain} failed:`, e);
    }

    // Fallback: use enrichAddress result directly if AI found nothing
    if (!aiFoundAddress && enrichResult?.location) {
      const hadLocation = !!profile.location;
      profile.location = enrichResult.location;
      if (!hadLocation) profile.completionScore = Math.min(100, profile.completionScore + 10);
    }

    // 3e. Email validation — AI-assisted filtering/discovery of emails.
    // Runs against the best available contact page HTML. If validation returns
    // verified results (confidence ≥ 70) they replace the regex-extracted set;
    // lower-confidence candidates are logged but not stored.
    try {
      console.log(`[worker:email-validation] ${domain} GROQ_API_KEY=${!!process.env.GROQ_API_KEY}`);
      if (profile.emails.length > 0) {
        const emailResult = await validateEmails(
          profile.name ?? domain,
          domain,
          profile.emails,
        );
        if (emailResult.unverified.length > 0) {
          console.log(
            `[worker:email-validation] ${domain} unverified=${JSON.stringify(emailResult.unverified.map((e) => `${e.email}(${e.confidence})`))}`,
          );
        }
        if (emailResult.verified.length > 0) {
          profile.emails = emailResult.verified;
          console.log(`[worker:email-validation] ${domain} verified=${JSON.stringify(emailResult.verified)}`);
        } else {
          console.log(`[worker:email-validation] ${domain} no verified emails — keeping regex results`);
        }
        if (emailResult.notes) {
          console.log(`[worker:email-validation] ${domain} notes="${emailResult.notes}"`);
        }
      }
    } catch (e) {
      console.warn(`[worker:email-validation] ${domain} failed — keeping regex results:`, e);
    }

    // 3f. Services validation — AI extraction of services, brands, industry, and target customers.
    // Tries top-ranked pages by URL signal + text length (up to 2). Stops as soon as one page
    // yields services. On no_services_found the pre-existing regex-extracted list is preserved.
    let aiRepresentedBrands: string[] = [];
    let aiPrimaryIndustry: string | undefined;
    let aiTargetCustomers: string | undefined;
    try {
      const svcPages = selectServicesPages(pages);
      if (svcPages.length === 0) {
        console.log(`[worker:services-validation] ${domain} no pages with text — keeping extracted results`);
      }
      for (const svcPage of svcPages) {
        console.log(
          `[worker:services-validation] ${domain} trying page=${svcPage.url} text=${svcPage.text.length}chars`,
        );
        const svcResult = await validateServices(
          profile.name ?? domain,
          domain,
          svcPage.url,
          svcPage.text,
        );
        if (!aiPrimaryIndustry)              aiPrimaryIndustry   = svcResult.primary_industry;
        if (aiRepresentedBrands.length === 0) aiRepresentedBrands = svcResult.represented_brands;
        if (!aiTargetCustomers)              aiTargetCustomers   = svcResult.target_customers;
        if (svcResult.notes) console.log(`[worker:services-validation] ${domain} notes="${svcResult.notes}"`);

        if (svcResult.services.length > 0) {
          profile.services = svcResult.services;
          console.log(
            `[worker:services-validation] ${domain} → ${svcResult.services.length} services from ${svcPage.url} (confidence=${svcResult.confidence})`,
          );
          break;
        }
        console.log(
          `[worker:services-validation] ${domain} no services from ${svcPage.url} (confidence=${svcResult.confidence}, no_services_found=${svcResult.no_services_found})`,
        );
      }
    } catch (e) {
      console.warn(`[worker:services-validation] ${domain} failed — keeping extracted results:`, e);
    }

    // 3g. Campaign email generation — tenant-specific B2B outreach email.
    // Runs only when the profile has enough data and the tenant has sender info configured.
    // Non-critical — failure never stops the crawl pipeline.
    // templateBodyResolved: undefined = not yet determined (error), string = template found, null = no template
    let campaignEmailText: string | undefined;
    let templateBodyResolved: string | null | undefined;
    try {
      // Resolve template first — this determines whether to generate at all.
      if (templateId) {
        const tmpl = await prisma.emailTemplate.findFirst({
          where: { id: templateId, tenantId },
          select: { body: true },
        });
        templateBodyResolved = tmpl?.body ?? null;
      } else {
        const defaultTmpl = await prisma.emailTemplate.findFirst({
          where: { tenantId, isDefault: true },
          select: { body: true },
        });
        templateBodyResolved = defaultTmpl?.body ?? null;
      }

      if (!templateBodyResolved) {
        console.log(`[worker:campaign-email] ${domain} — skipped (no template configured)`);
      } else {
        const hasSufficientProfile = !!(profile.name && (profile.description || profile.services.length > 0));
        if (hasSufficientProfile) {
          const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            select: {
              name: true,
              website: true,
              contactPersonName: true,
              contactPersonTitle: true,
              contactPersonEmail: true,
              contactPersonPhone: true,
            },
          });
          const hasSenderInfo = !!tenant?.contactPersonName;
          if (hasSenderInfo && tenant) {
            // Fallback to first user email if tenant.contactPersonEmail is not set
            let senderEmail: string = tenant.contactPersonEmail ?? '';
            if (!senderEmail) {
              const firstUser = await prisma.user.findFirst({
                where: { tenantId },
                select: { email: true },
                orderBy: { createdAt: 'asc' },
              });
              senderEmail = firstUser?.email ?? '';
            }

            const result = await generateCampaignEmail(
              {
                targetName:        profile.name ?? domain,
                targetDomain:      domain,
                targetDescription: profile.description ?? '',
                targetServices:    profile.services,
                targetLocation:    profile.location ?? '',
                targetTeam:        Array.isArray(profile.team) ? profile.team as Array<{ name: string; position?: string }> : [],
                senderCompanyName: tenant.name,
                senderWebsite:     tenant.website ?? '',
                senderContactName: tenant.contactPersonName!,
                senderContactTitle: tenant.contactPersonTitle ?? '',
                senderContactEmail: senderEmail,
                senderContactPhone: tenant.contactPersonPhone ?? '',
              },
              undefined,
              templateBodyResolved,
            );
            if (result) {
              campaignEmailText = result;
              console.log(`[worker:campaign-email] ${domain} — generated (${result.length} chars)`);
            }
          } else {
            console.log(`[worker:campaign-email] ${domain} — skipped (tenant sender info not configured)`);
          }
        } else {
          console.log(`[worker:campaign-email] ${domain} — skipped (insufficient profile data)`);
        }
      }
    } catch (e) {
      console.warn(`[worker:campaign-email] ${domain} failed — skipping:`, e);
    }

    // 4. Upsert CompanyProfile — preserve existing emails/phones if the new crawl found none.
    // A retry crawl that misses the contact page must not overwrite verified contact data.
    const existingProfile = await prisma.companyProfile.findUnique({
      where: { companyId },
      select: { emails: true, phones: true, name: true, companyNameFromLogo: true },
    });
    const existingEmails = Array.isArray(existingProfile?.emails) ? existingProfile.emails as string[] : [];
    const existingPhones = Array.isArray(existingProfile?.phones) ? existingProfile.phones as string[] : [];
    // Name resolution: new crawl wins; if it found nothing, fall back in order:
    //   1. previously OCR-extracted logo name (if existingName is generic or missing)
    //   2. existing real name from a prior crawl
    // A stale generic auth name ("login"/"вход"/"portal") is explicitly nulled out so that
    // Prisma actually clears it rather than preserving it (Prisma ignores `undefined` on update).
    const existingName = existingProfile?.name as string | null | undefined;
    const existingLogoName = existingProfile?.companyNameFromLogo as string | null | undefined;
    const upsertName = profile.name != null
      ? profile.name
      : isGenericAuthName(existingName)
        ? (existingLogoName || null)
        : (existingName ?? existingLogoName ?? null);
    const upsertEmails = profile.emails.length > 0 ? profile.emails : existingEmails;
    const upsertPhones = profile.phones.length > 0 ? profile.phones : existingPhones;
    // Adjust score if falling back to preserved contact data
    let upsertScore = profile.completionScore;
    if (upsertEmails.length > 0 && profile.emails.length === 0) upsertScore = Math.min(100, upsertScore + 15);
    if (upsertPhones.length > 0 && profile.phones.length === 0) upsertScore = Math.min(100, upsertScore + 10);

    await prisma.companyProfile.upsert({
      where: { companyId },
      create: {
        companyId,
        name: upsertName,
        description: profile.description,
        location: profile.location,
        emails: upsertEmails,
        phones: upsertPhones,
        services: profile.services,
        representedBrands: aiRepresentedBrands,
        primaryIndustry:   aiPrimaryIndustry,
        targetCustomers:   aiTargetCustomers,
        team: profile.team as unknown as import('@prisma/client').Prisma.InputJsonValue,
        history: profile.history,
        socialLinks: profile.socialLinks,
        completionScore: upsertScore,
        loginProtected:      isLoginProtected,
        logoSourceUrl:       loginFallback?.logoSourceUrl       ?? undefined,
        companyNameFromLogo: loginFallback?.companyNameFromLogo ?? undefined,
        sloganFromLogo:      loginFallback?.sloganFromLogo      ?? undefined,
        logoNameConfidence:  loginFallback?.logoNameConfidence  ?? 0,
        campaignEmail:       campaignEmailText,
      },
      update: {
        name: upsertName,
        description: profile.description,
        location: profile.location,
        emails: upsertEmails,
        phones: upsertPhones,
        services: profile.services,
        representedBrands: aiRepresentedBrands,
        primaryIndustry:   aiPrimaryIndustry,
        targetCustomers:   aiTargetCustomers,
        team: profile.team as unknown as import('@prisma/client').Prisma.InputJsonValue,
        history: profile.history,
        socialLinks: profile.socialLinks,
        completionScore: upsertScore,
        loginProtected:      isLoginProtected,
        logoSourceUrl:       loginFallback?.logoSourceUrl       ?? undefined,
        companyNameFromLogo: loginFallback?.companyNameFromLogo ?? undefined,
        sloganFromLogo:      loginFallback?.sloganFromLogo      ?? undefined,
        logoNameConfidence:  loginFallback?.logoNameConfidence  ?? 0,
        // No template → explicitly null; template + generation failed → preserve existing; generated → store
        ...(templateBodyResolved == null
          ? { campaignEmail: null }
          : campaignEmailText !== undefined
            ? { campaignEmail: campaignEmailText }
            : {}),
      },
    });

    // 5. Update company status
    await prisma.company.update({
      where: { id: companyId },
      data: { crawlStatus: 'COMPLETED', lastCrawledAt: new Date(), name: upsertName },
    });

    console.log(`[worker] done ${domain} — score: ${upsertScore}`);
    await updateBatchProgress(batchId);

    // 6. Enqueue personalization — best-effort; failure must not cause a crawl retry or FAILED status
    try {
      const pQueue = await getQueue();
      await enqueuePersonalizeJob({ companyId }, pQueue);
    } catch (personErr) {
      console.error(`[worker] personalize enqueue failed for ${domain}:`, personErr);
    }
  } catch (err) {
    console.error(`[worker] failed ${domain}:`, err);

    const retryLimit = 3;
    const isFinalAttempt = (job.retryCount ?? 0) >= retryLimit - 1;

    if (isFinalAttempt) {
      // On the final attempt, mark COMPLETED if a useful profile was already saved —
      // e.g. the crawl succeeded but a downstream step (personalization enqueue,
      // batch progress) failed on every retry attempt.
      const saved = await prisma.companyProfile.findUnique({
        where: { companyId },
        select: { emails: true, phones: true, completionScore: true, loginProtected: true, companyNameFromLogo: true },
      }).catch(() => null);
      const hasUsefulData = saved && (
        (Array.isArray(saved.emails) && (saved.emails as string[]).length > 0) ||
        (Array.isArray(saved.phones) && (saved.phones as string[]).length > 0) ||
        (saved.completionScore >= 50) ||
        // Login-protected site where we successfully recovered identity from the logo
        (saved.loginProtected && !!saved.companyNameFromLogo)
      );
      const finalStatus = hasUsefulData ? 'COMPLETED' : 'FAILED';
      console.log(`[worker] final attempt ${domain} — profile hasUsefulData=${hasUsefulData} → ${finalStatus}`);
      // Guard prevents downgrading a parallel COMPLETED result
      await prisma.company.updateMany({
        where: { id: companyId, crawlStatus: { not: 'COMPLETED' } },
        data: {
          crawlStatus: finalStatus,
          ...(hasUsefulData ? { lastCrawledAt: new Date() } : {}),
        },
      });
      await updateBatchProgress(batchId);
    } else {
      await prisma.company.updateMany({
        where: { id: companyId, crawlStatus: { not: 'COMPLETED' } },
        data: { crawlStatus: 'PENDING' },
      });
    }

    throw err; // Let pg-boss handle retry
  }
}

async function updateBatchProgress(batchId: string): Promise<void> {
  // Atomic increment — avoids read-modify-write race with concurrent workers
  let batch: { totalCompanies: number; processedCompanies: number };
  try {
    batch = await prisma.crawlBatch.update({
      where: { id: batchId },
      data: { processedCompanies: { increment: 1 } },
      select: { totalCompanies: true, processedCompanies: true },
    });
  } catch (err: unknown) {
    // Batch was deleted or never existed — skip progress update silently.
    // A missing batch must not propagate as a crawl failure.
    if ((err as { code?: string }).code === 'P2025') {
      console.warn(`[worker] batch ${batchId} not found; skipping progress update`);
      return;
    }
    throw err;
  }

  const percentage = batch.totalCompanies > 0
    ? (batch.processedCompanies / batch.totalCompanies) * 100
    : 0;
  const status = batch.processedCompanies >= batch.totalCompanies ? 'COMPLETED' : 'PROCESSING';

  await prisma.crawlBatch.update({
    where: { id: batchId },
    data: { completionPercentage: percentage, status },
  });
}

// ── Shared crawl enqueue helper ───────────────────────────────────────────────
// Used by both the full discovery path and the cache-hit path.
// Filters out .local synthetic domains and non-crawlable platforms, caps to
// limit, upserts Company + TenantCompany, applies freshness check, and enqueues.

type CrawlEntry = { domain: string; name?: string | null };

async function enqueueCrawlsFromEntries(
  entries: CrawlEntry[],
  batchId: string,
  tenantId: string,
  limit: number,
  forceRecrawl: boolean,
  templateId: string | undefined,
  crawlQueue: PgBoss,
): Promise<void> {
  const crawlable = entries
    .filter(e => !e.domain.endsWith('.local') && !isNonCrawlablePlatform(e.domain))
    .slice(0, limit);

  if (crawlable.length === 0) {
    await prisma.crawlBatch.update({
      where: { id: batchId },
      data:  { status: 'COMPLETED', totalCompanies: 0, completionPercentage: 100 },
    });
    return;
  }

  await prisma.crawlBatch.update({
    where: { id: batchId },
    data:  { totalCompanies: crawlable.length },
  });

  let jobsEnqueued = 0;
  let skippedFresh = 0;

  for (const entry of crawlable) {
    const { domain, name } = entry;
    const baseUrl = `https://${domain}`;

    const company = await prisma.company.upsert({
      where:   { domain },
      create:  { domain, baseUrl, name: name ?? null },
      update:  {},
      include: { profile: true },
    });

    await prisma.tenantCompany.createMany({
      data: [{ tenantId, companyId: company.id, sourceBatchId: batchId }],
      skipDuplicates: true,
    });

    // Queue protection: non-crawlable platforms must never enter the crawl pipeline.
    if (isNonCrawlablePlatform(domain)) {
      console.log(`[enqueue] skipped ${domain} reason=non_crawlable_platform`);
      platformMetrics.crawlJobsSkipped++;
      await updateBatchProgress(batchId);
      continue;
    }

    const freshness = checkFreshness(company, forceRecrawl);

    if (freshness.skip) {
      console.log(`[discover] skipped fresh company ${domain} — ${freshness.reason}`);
      skippedFresh++;
      await updateBatchProgress(batchId);
    } else {
      console.log(`[discover] enqueued crawl for candidate ${domain} — ${freshness.reason}`);
      await enqueueCrawlJob(
        { companyId: company.id, domain, baseUrl, batchId, tenantId, templateId },
        crawlQueue,
      );
      jobsEnqueued++;
    }
  }

  if (jobsEnqueued > 0) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data:  { weeklyUsage: { increment: jobsEnqueued } },
    });
  }

  console.log(`[worker/discover] enqueued=${jobsEnqueued} skippedFresh=${skippedFresh} for batch ${batchId}`);
}

async function processDiscoverJob(
  job: PgBoss.JobWithMetadata<DiscoverPersonaPayload>
): Promise<void> {
  const { batchId, tenantId, persona, location, keywords, maxResults, forceRecrawl, templateId } = job.data;
  console.log(`[worker/discover] starting discovery: "${persona}" in "${location}"`);

  const limit      = maxResults ?? 50;
  const crawlQueue = await getQueue();

  try {
    // ── Discovery cache check ─────────────────────────────────────────────────
    const discoveryKey = buildDiscoveryKey(persona, location, keywords);

    if (forceRecrawl) {
      console.log(`[discovery-cache] bypassed because force_recrawl=true`);
    } else {
      const cachedBatch = await findCachedDiscovery(batchId, discoveryKey);

      if (cachedBatch) {
        console.log(`[discovery-cache] key="${discoveryKey}" hit from batch=${cachedBatch.id}`);
        const copied = await copyCandidatesToBatch(cachedBatch.id, batchId);
        console.log(`[discovery-cache] copied ${copied} candidates to batch=${batchId}`);

        const keptRows = await prisma.discoveryCandidate.findMany({
          where:  { batchId, status: 'KEPT' },
          select: { domain: true, orgName: true, title: true },
        });

        await enqueueCrawlsFromEntries(
          keptRows.map(r => ({ domain: r.domain, name: r.orgName ?? r.title })),
          batchId, tenantId, limit, forceRecrawl ?? false, templateId, crawlQueue,
        );
        return;
      }

      console.log(`[discovery-cache] miss key="${discoveryKey}"`);
    }

    // ── Run the full hybrid discovery pipeline ────────────────────────────────
    const orchestrator = new DiscoveryOrchestrator();
    const { accepted, rejected, allCandidates } = await orchestrator.discover({
      persona,
      location,
      keywords,
      maxResults,
    });

    // ── Persist all candidates to DB (accepted + rejected) for UI transparency ─
    if (allCandidates.length > 0) {
      // Build a synthetic domain for extracted orgs that have no known website.
      // These are stored in DiscoveryCandidate for UI/export but never enqueued for crawling.
      const rows = allCandidates.map((c) => {
        const domain =
          c.domain ??
          `extracted-${Buffer.from((c.name ?? c.sourceUrl).slice(0, 40)).toString('hex').slice(0, 16)}.local`;

        const isNcp      = !!c.domain && isNonCrawlablePlatform(c.domain);
        const isAccepted = accepted.includes(c);
        const wasBlocked  = c.pageType === 'IRRELEVANT' && !c.extractedFromUrl;

        if (isNcp) {
          console.log(`[platform] detected ${domain}`);
          platformMetrics.nonCrawlableRejected++;
        }

        const status: 'KEPT' | 'FILTERED' | 'BLOCKED' = (isNcp || wasBlocked)
          ? (wasBlocked ? 'BLOCKED' : 'FILTERED')
          : isAccepted
            ? 'KEPT'
            : 'FILTERED';

        return {
          batchId,
          domain,
          url:              c.websiteUrl ?? c.sourceUrl,
          title:            c.name ?? c.title ?? null,
          snippet:          c.snippet ?? null,
          status,
          pageType:         c.pageType,
          extractedFrom:    c.extractedFromUrl ?? null,
          discoverySource:  c.sourceType,
          confidence:       c.confidence,
          orgName:          c.name ?? null,
          extractedEmail:   c.email ?? null,
          extractedPhone:   c.phone ?? null,
          extractedAddress: c.address ?? null,
          rejectedReason:   isNcp ? 'NON_CRAWLABLE_PLATFORM' : isAccepted ? null : (c.rejectedReason ?? null),
        };
      });

      await prisma.discoveryCandidate.createMany({ data: rows, skipDuplicates: true });
    }

    const acceptedEntries: CrawlEntry[] = accepted
      .filter(c => c.domain)
      .map(c => ({ domain: c.domain!, name: c.name ?? c.title ?? null }));

    console.log(
      `[worker/discover] accepted=${accepted.length} rejected=${rejected.length} ` +
      `total=${allCandidates.length}`,
    );

    await enqueueCrawlsFromEntries(
      acceptedEntries, batchId, tenantId, limit, forceRecrawl ?? false, templateId, crawlQueue,
    );

  } catch (err) {
    if (err instanceof SearchProviderError) {
      const errorNote = `Search provider quota/billing error. Returned HTTP ${err.statusCode}.`;
      console.error(
        `[worker/discover] provider error HTTP ${err.statusCode} for batch ${batchId} ` +
        `— query="${err.query}" — ${errorNote}`,
      );
      const batchRecord = await prisma.crawlBatch.findUnique({
        where: { id: batchId },
        select: { searchQuery: true },
      });
      const sq = (batchRecord?.searchQuery ?? {}) as Record<string, unknown>;
      await prisma.crawlBatch.update({
        where: { id: batchId },
        data:  { status: 'FAILED', searchQuery: { ...sq, _errorNote: errorNote } },
      });
      return;
    }

    console.error('[worker/discover] failed:', err);
    await prisma.crawlBatch.update({
      where: { id: batchId },
      data:  { status: 'FAILED' },
    });
    throw err;
  }
}

async function processPersonalizeJob(
  job: PgBoss.JobWithMetadata<PersonalizeCompanyPayload>
): Promise<void> {
  const { companyId } = job.data;

  const profile = await prisma.companyProfile.findUnique({ where: { companyId } });
  if (!profile) {
    console.log(`[worker/personalize] No profile for ${companyId} — skipping`);
    return;
  }

  const result = await generatePersonalizedContent({
    name:        profile.name        ?? undefined,
    description: profile.description ?? undefined,
    location:    profile.location    ?? undefined,
    services:    Array.isArray(profile.services) ? (profile.services as string[])                             : [],
    team:        Array.isArray(profile.team)     ? (profile.team as Array<{ name: string; position?: string }>) : [],
    history:     profile.history     ?? undefined,
    emails:      Array.isArray(profile.emails)   ? (profile.emails as string[])                               : [],
  });

  if (!result) return;

  await prisma.personalizedContent.upsert({
    where:  { companyId },
    create: { companyId, ...result },
    update: result,
  });

  console.log(`[worker/personalize] Saved content for ${companyId}`);
}

let workerStarted = false;

export async function startWorker(): Promise<void> {
  if (workerStarted) {
    console.log('[worker] already started — skipping');
    return;
  }
  workerStarted = true;

  console.log('[worker] starting...');
  const queue = await getQueue();

  queue.work<CrawlCompanyPayload>(
    QUEUES.CRAWL_COMPANY,
    { batchSize: CONCURRENCY, includeMetadata: true },
    processJob
  );

  queue.work<DiscoverPersonaPayload>(
    QUEUES.DISCOVER_PERSONA,
    { batchSize: 1, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) await processDiscoverJob(job);
    }
  );

  queue.work<PersonalizeCompanyPayload>(
    QUEUES.PERSONALIZE_COMPANY,
    { batchSize: 2, includeMetadata: true },
    async (jobs) => {
      for (const job of jobs) await processPersonalizeJob(job);
    }
  );

  console.log(`[worker] listening on queues "${QUEUES.CRAWL_COMPANY}", "${QUEUES.DISCOVER_PERSONA}", "${QUEUES.PERSONALIZE_COMPANY}" (concurrency: ${CONCURRENCY})`);

  // Graceful shutdown — handles both standalone and embedded modes
  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal}, shutting down...`);
    await stopQueue();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Standalone entry point: npm run start:worker → node dist/worker/index.js
if (require.main === module) {
  startWorker().catch((err) => {
    console.error('[worker] fatal error:', err);
    process.exit(1);
  });
}
