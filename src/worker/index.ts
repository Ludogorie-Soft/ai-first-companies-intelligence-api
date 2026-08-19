import 'dotenv/config';
import { isNonCrawlablePlatform, platformMetrics, NON_CRAWLABLE_PLATFORM_NOTE } from '../services/nonCrawlablePlatforms';
import { normalizeRawProfileUrl } from '../lib/normalizeRawProfileUrl';
import { rawProfileCacheDecision } from '../lib/rawProfileCache';
import { getQueue, QUEUES, CrawlCompanyPayload, DiscoverPersonaPayload, PersonalizeCompanyPayload, enqueueCrawlJob, enqueuePersonalizeJob, stopQueue } from '../lib/queue';
import { prisma } from '../lib/prisma';
import { refreshBatchProgress } from '../lib/batchProgress';
import { crawlCompanyDetailed, detectBotProtection, BOT_CRAWL_NOTE } from './crawl';
import { crawlNoteFor } from './crawlErrors';
import { extractProfile, isGenericAuthName, detectWebsiteLanguage } from '../services/extraction';
import { enrichSocialLinks } from '../services/socialEnrichment';
import { enrichAddress } from '../services/addressEnrichment';
import { validateAddress } from '../services/addressValidation';
import { validateEmails } from '../services/emailValidation';
import { validateServices, selectServicesPages } from '../services/servicesValidation';
import { runLoginFallbackEnrichment } from '../services/loginFallbackEnrichment';
import { DiscoveryOrchestrator, SearchProviderError } from '../services/discovery/index';
import { buildDiscoveryKey, FILTER_VERSION } from '../services/discovery/discoveryKey';
import { groqModel } from '../services/discovery';
import { findCachedDiscovery, copyCandidatesToBatch } from '../services/discovery/discoveryCache';
import { verifyAfterCrawl } from '../services/postCrawlVerification';
import { checkFreshness } from '../lib/freshness';
import { generatePersonalizedContent } from '../services/personalization';
import { generateCampaignEmail } from '../services/campaignEmailGeneration';
import { parseEmailLanguage, resolveEmailLanguage } from '../lib/emailLanguage';
import type { EmailLanguagePreference } from '../lib/emailLanguage';
import PgBoss from 'pg-boss';

const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);

async function processJob(jobs: PgBoss.JobWithMetadata<CrawlCompanyPayload>[]): Promise<void> {
  for (const job of jobs) {
    try {
      await processSingleJob(job);
    } catch (err) {
      // Fail only this job. Letting the error escape the handler makes pg-boss fail the
      // ENTIRE batch of `batchSize` jobs, forcing siblings that already crawled
      // successfully through a full re-crawl (Playwright + validation + LLM) on retry.
      try {
        const boss = await getQueue();
        await boss.fail(QUEUES.CRAWL_COMPANY, job.id, {
          message: err instanceof Error ? err.message : String(err),
        });
      } catch (failErr) {
        console.error(`[worker] could not mark job ${job.id} failed:`, failErr);
      }
    }
  }
}

async function processSingleJob(job: PgBoss.JobWithMetadata<CrawlCompanyPayload>): Promise<void> {
  const { companyId, domain, baseUrl, batchId, tenantId, templateId, emailLanguage: rawEmailLanguage } = job.data;
  const emailLanguagePref = parseEmailLanguage(rawEmailLanguage);
  console.log(`[worker] processing ${domain} (${companyId})`);

  // Final safety guard — abort immediately if a non-crawlable platform somehow reached the worker.
  if (isNonCrawlablePlatform(domain)) {
    console.log(`[crawl] blocked ${domain} reason=non_crawlable_platform`);
    platformMetrics.nonCrawlableRejected++;
    await prisma.company.update({
      where: { id: companyId },
      data: { crawlStatus: 'BLOCKED', crawlNote: NON_CRAWLABLE_PLATFORM_NOTE },
    });
    await refreshBatchProgress(batchId, tenantId);
    return;
  }

  // Mark company as crawling
  await prisma.company.update({
    where: { id: companyId },
    data: { crawlStatus: 'CRAWLING' },
  });

  try {
    // 1. Crawl pages
    const { pages, failure } = await crawlCompanyDetailed(baseUrl);

    if (pages.length === 0) {
      // Host produced nothing. `failure` names the cause when the crawler could
      // classify it, so the UI can say "domain does not resolve" instead of a
      // bare FAILED, and so a cause that cannot change between attempts does
      // not get retried by pg-boss.
      await prisma.company.update({
        where: { id: companyId },
        data: { crawlStatus: 'FAILED', crawlNote: failure ? crawlNoteFor(failure) ?? null : null },
      });
      await refreshBatchProgress(batchId, tenantId);
      console.log(
        `[worker] skipped ${domain} — unreachable (no pages)` +
        (failure ? ` code=${failure.code} retryable=${failure.retryable}` : ''),
      );
      return;
    }

    // 1b. Bot-protection check — if detected, mark BLOCKED and stop without extracting
    const { blocked, indicator } = detectBotProtection(pages);
    if (blocked) {
      await prisma.company.update({
        where: { id: companyId },
        data: { crawlStatus: 'BLOCKED', crawlNote: BOT_CRAWL_NOTE },
      });
      await refreshBatchProgress(batchId, tenantId);
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
    const resolvedEmailLanguage = resolveEmailLanguage(
      emailLanguagePref,
      detectWebsiteLanguage(pages),
    );
    console.log(`[worker:email-language] ${domain} preference=${emailLanguagePref} resolved=${resolvedEmailLanguage}`);

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
              aboutUs: true,
              productsServices: true,
              portfolio: true,
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
                senderAboutUs:          tenant.aboutUs ?? undefined,
                senderProductsServices: tenant.productsServices ?? undefined,
                senderPortfolio:        tenant.portfolio ?? undefined,
                emailLanguage:     resolvedEmailLanguage,
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
    await refreshBatchProgress(batchId, tenantId);

    // 5b. Verify the crawled address against the search that found this company.
    // Best-effort: a verification failure must never fail or retry the crawl.
    try {
      const verdict = await verifyAfterCrawl({
        companyId, domain, batchId, tenantId,
        persona:  job.data.persona,
        location: job.data.location,
      });
      if (verdict.verified && verdict.demoted) {
        console.log(`[worker] ${domain} moved to review — ${verdict.detail}`);
      }
    } catch (verifyErr) {
      console.error(`[worker] post-crawl verification failed for ${domain}:`, verifyErr);
    }

    // 6. Enqueue personalization — best-effort; failure must not cause a crawl retry or FAILED status
    try {
      const pQueue = await getQueue();
      await enqueuePersonalizeJob({ companyId, tenantId, emailLanguage: resolvedEmailLanguage }, pQueue);
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
      await refreshBatchProgress(batchId, tenantId);
    } else {
      await prisma.company.updateMany({
        where: { id: companyId, crawlStatus: { not: 'COMPLETED' } },
        data: { crawlStatus: 'PENDING' },
      });
    }

    throw err; // Let pg-boss handle retry
  }
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
  emailLanguage?: EmailLanguagePreference,
  /** Carried into each crawl job so the result can be verified against the search. */
  searchContext?: { persona: string; location: string },
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

  // ── Phase 1: upsert every Company row ───────────────────────────────────────
  const companies = await Promise.all(crawlable.map(entry =>
    prisma.company.upsert({
      where:   { domain: entry.domain },
      create:  { domain: entry.domain, baseUrl: `https://${entry.domain}`, name: entry.name ?? null },
      update:  {},
      include: { profile: true },
    }),
  ));

  const toEnqueue: typeof companies = [];
  let skippedFresh = 0;

  for (const company of companies) {
    const freshness = checkFreshness(company, forceRecrawl);
    if (freshness.skip) {
      console.log(`[discover] skipped fresh company ${company.domain} — ${freshness.reason}`);
      skippedFresh++;
    } else {
      console.log(`[discover] enqueued crawl for candidate ${company.domain} — ${freshness.reason}`);
      toEnqueue.push(company);
    }
  }

  // ── Phase 2: put every company into a correct pre-crawl state, then seed ─────
  // Company.crawlStatus is global, and checkFreshness enqueues an already-COMPLETED company
  // whenever its stored profile is too thin. Without this reset those rows would read as
  // already done the moment the batch is seeded.
  if (toEnqueue.length > 0) {
    await prisma.company.updateMany({
      where: { id: { in: toEnqueue.map(c => c.id) } },
      data:  { crawlStatus: 'PENDING' },
    });
  }

  // One createMany, after the reset — progress is derived from these rows, so they must
  // become visible all at once and only once their crawlStatus is accurate. A read landing
  // before this sees total=0 (→ 0%, PROCESSING) rather than a spuriously complete batch.
  await prisma.tenantCompany.createMany({
    data: companies.map(c => ({ tenantId, companyId: c.id, sourceBatchId: batchId })),
    skipDuplicates: true,
  });

  // ── Phase 3: enqueue, then refresh progress exactly once ────────────────────
  for (const company of toEnqueue) {
    await enqueueCrawlJob(
      {
        companyId: company.id,
        domain:    company.domain,
        baseUrl:   company.baseUrl,
        batchId,
        tenantId,
        templateId,
        emailLanguage,
        persona:  searchContext?.persona,
        location: searchContext?.location,
      },
      crawlQueue,
    );
  }

  const jobsEnqueued = toEnqueue.length;

  if (jobsEnqueued > 0) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data:  { weeklyUsage: { increment: jobsEnqueued } },
    });
  }

  await refreshBatchProgress(batchId, tenantId);

  console.log(`[worker/discover] enqueued=${jobsEnqueued} skippedFresh=${skippedFresh} for batch ${batchId}`);
}

async function processDiscoverJob(
  job: PgBoss.JobWithMetadata<DiscoverPersonaPayload>
): Promise<void> {
  const { batchId, tenantId, persona, location, keywords, maxResults, forceRecrawl, templateId, emailLanguage } = job.data;
  console.log(`[worker/discover] starting discovery: "${persona}" in "${location}"`);
  const emailLanguagePref = parseEmailLanguage(emailLanguage);

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

        // Only KEPT rows are enqueued — REVIEW ones stay waiting for the user,
        // exactly as they would on a fresh run.
        await enqueueCrawlsFromEntries(
          keptRows.map(r => ({ domain: r.domain, name: r.orgName ?? r.title })),
          batchId, tenantId, limit, forceRecrawl ?? false, templateId, crawlQueue, emailLanguagePref,
          { persona, location },
        );
        return;
      }

      console.log(`[discovery-cache] miss key="${discoveryKey}"`);
    }

    // ── Run the full hybrid discovery pipeline ────────────────────────────────
    const orchestrator = new DiscoveryOrchestrator();
    const { accepted, review, rejected, allCandidates } = await orchestrator.discover({
      persona,
      location,
      keywords,
      maxResults,
    });

    // ── Persist every candidate with its decision, for UI transparency ────────
    if (allCandidates.length > 0) {
      // Build a synthetic domain for extracted orgs that have no known website.
      // These are stored in DiscoveryCandidate for UI/export but never enqueued for crawling.
      const rows = allCandidates.map((c) => {
        const domain =
          c.domain ??
          `extracted-${Buffer.from((c.name ?? c.sourceUrl).slice(0, 40)).toString('hex').slice(0, 16)}.local`;

        const isNcp     = !!c.domain && isNonCrawlablePlatform(c.domain);
        const wasBlocked = c.pageType === 'IRRELEVANT' && !c.extractedFromUrl;
        const decision  = c.decision;

        if (isNcp) {
          console.log(`[platform] detected ${domain}`);
          platformMetrics.nonCrawlableRejected++;
        }

        // A platform we cannot crawl and a blocklisted domain are terminal states
        // that outrank the verdict — there is nothing for a human to review.
        const status: 'KEPT' | 'REVIEW' | 'FILTERED' | 'BLOCKED' =
            wasBlocked                     ? 'BLOCKED'
          : isNcp                          ? 'FILTERED'
          : decision?.verdict === 'ACCEPT' ? 'KEPT'
          : decision?.verdict === 'REVIEW' ? 'REVIEW'
          :                                  'FILTERED';

        // The reason is stored for ALL verdicts, accepts included, so the UI can
        // answer "why was this kept?" as well as "why was this dropped?".
        const reason =
            isNcp      ? 'NON_CRAWLABLE_PLATFORM'
          : wasBlocked ? 'BLOCKLISTED_AGGREGATOR'
          :              decision?.primaryReason ?? null;

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
          rejectedReason:   reason,
          decisionSignals:  (decision?.signals ?? []) as unknown as object[],
          decidedAt:        new Date(),
        };
      });

      await prisma.discoveryCandidate.createMany({ data: rows, skipDuplicates: true });
    }

    const acceptedEntries: CrawlEntry[] = accepted
      .filter(c => c.domain)
      .map(c => ({ domain: c.domain!, name: c.name ?? c.title ?? null }));

    console.log(
      `[worker/discover] accepted=${accepted.length} review=${review.length} ` +
      `rejected=${rejected.length} total=${allCandidates.length}`,
    );

    // Only accepted candidates are crawled. Review ones wait in the "For review"
    // tab until the user includes them — that is the point of the tier.
    await enqueueCrawlsFromEntries(
      acceptedEntries, batchId, tenantId, limit, forceRecrawl ?? false, templateId, crawlQueue, emailLanguagePref,
      { persona, location },
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
  const { companyId, tenantId, emailLanguage } = job.data;
  const resolvedLanguage = emailLanguage === 'en' ? 'en' : 'bg';

  const profile = await prisma.companyProfile.findUnique({ where: { companyId } });
  if (!profile) {
    console.log(`[worker/personalize] No profile for ${companyId} — skipping`);
    return;
  }

  let sender: {
    companyName?: string;
    website?: string;
    aboutUs?: string;
    productsServices?: string;
    portfolio?: string;
  } | undefined;

  if (tenantId) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        website: true,
        aboutUs: true,
        productsServices: true,
        portfolio: true,
      },
    });
    if (tenant) {
      sender = {
        companyName: tenant.name,
        website: tenant.website ?? undefined,
        aboutUs: tenant.aboutUs ?? undefined,
        productsServices: tenant.productsServices ?? undefined,
        portfolio: tenant.portfolio ?? undefined,
      };
    }
  }

  const result = await generatePersonalizedContent({
    name:        profile.name        ?? undefined,
    description: profile.description ?? undefined,
    location:    profile.location    ?? undefined,
    services:    Array.isArray(profile.services) ? (profile.services as string[])                             : [],
    team:        Array.isArray(profile.team)     ? (profile.team as Array<{ name: string; position?: string }>) : [],
    history:     profile.history     ?? undefined,
    emails:      Array.isArray(profile.emails)   ? (profile.emails as string[])                               : [],
  }, resolvedLanguage, sender);

  if (!result) return;

  await prisma.personalizedContent.upsert({
    where:  { companyId },
    create: { companyId, ...result },
    update: result,
  });

  console.log(`[worker/personalize] Saved content for ${companyId}`);
}

/**
 * One startup line stating whether the Playwright browser is actually present.
 *
 * A worker whose Chromium was never installed (or was installed for a
 * different playwright version after an `npm install`) fails per-URL, deep
 * inside the crawler, with a message nobody sees. Checking once at boot turns
 * that whole class of failure into an actionable banner.
 */
async function reportChromiumAvailability(): Promise<void> {
  try {
    const { chromium } = await import('playwright');
    // A real launch, not an executablePath() existence check: crawlee launches
    // the `chromium_headless_shell` build, which lives at a different path from
    // the one executablePath() reports, so a file check can pass while the
    // actual launch still fails.
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    console.log(`[worker] chromium=ok (${chromium.executablePath()})`);
  } catch (err) {
    console.error(
      '[worker] CHROMIUM UNAVAILABLE — every Playwright fallback crawl will fail. ' +
      'Run: npx playwright install chromium' + '\n         ' +
      (err instanceof Error ? err.message.split('\n')[0] : String(err)),
    );
  }
}

let workerStarted = false;

export async function startWorker(): Promise<void> {
  if (workerStarted) {
    console.log('[worker] already started — skipping');
    return;
  }
  workerStarted = true;

  console.log('[worker] starting...');
  await reportChromiumAvailability();
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

  // Identity banner. pg-boss hands each job to whichever consumer polls first, so a
  // forgotten worker from an older build will happily process jobs alongside this
  // one and its rows come out looking like a filtering regression. Announcing pid
  // and filter version makes a second, stale consumer obvious in the log instead of
  // something you have to infer afterwards from confidence values and leftover HTML.
  console.log(
    `[worker] pid=${process.pid} filter=${FILTER_VERSION} model=${groqModel()} ` +
    `concurrency=${CONCURRENCY} node=${process.version}`,
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
