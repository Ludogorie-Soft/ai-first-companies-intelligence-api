import { prisma } from '../lib/prisma';
import { refreshBatchProgress } from '../lib/batchProgress';
import { locationSignal } from './discovery/locationMatch';
import { signal } from './discovery/types';
import type { DecisionSignal } from './discovery/types';

/**
 * Re-checks a crawled company against the search that found it.
 *
 * Discovery decides from a title and a two-line snippet. That is enough to spot an
 * obvious directory, but not enough to know where a business actually is — a site
 * whose title reads right and whose address is in another town passes every
 * pre-crawl check. Once the crawl has run we finally have the real address, so we
 * check it, for free and deterministically.
 *
 * A mismatch does NOT delete anything. The candidate is moved back to the review
 * tier with the address we found as the evidence, and its TenantCompany row is
 * excluded so it leaves the results list. The user can override it in one click,
 * exactly like a manual exclude.
 *
 * Skipped entirely when the crawl payload carries no persona/location — that is
 * how CSV-upload batches stay untouched, since they have no search criteria to
 * verify against.
 */

export interface VerificationInput {
  companyId: string;
  domain: string;
  batchId: string;
  tenantId: string;
  /** Undefined for CSV uploads — verification is skipped. */
  persona?: string;
  location?: string;
}

export type VerificationOutcome =
  | { verified: false; skipped: true; why: string }
  | { verified: true; demoted: false }
  | { verified: true; demoted: true; reason: 'LOCATION_CONFLICT_VERIFIED'; detail: string };

/** `VERIFY_AFTER_CRAWL=false` turns the whole step off. */
function isEnabled(): boolean {
  return (process.env.VERIFY_AFTER_CRAWL ?? 'true').toLowerCase() !== 'false';
}

export async function verifyAfterCrawl(
  input: VerificationInput,
): Promise<VerificationOutcome> {
  const { companyId, domain, batchId, tenantId, location } = input;

  if (!isEnabled()) {
    return { verified: false, skipped: true, why: 'VERIFY_AFTER_CRAWL=false' };
  }
  if (!location?.trim()) {
    // CSV upload, or a persona search enqueued before this feature existed.
    return { verified: false, skipped: true, why: 'no location in crawl payload' };
  }

  // `location` is the profile's address field — the worker writes the validated
  // full address into it (see the addressValidation step in worker/index.ts).
  const profile = await prisma.companyProfile.findUnique({
    where:  { companyId },
    select: { location: true },
  });

  const address = profile?.location?.trim() ?? '';
  if (!address) {
    return { verified: false, skipped: true, why: 'no address extracted from the site' };
  }

  const result = locationSignal(address, location, { source: 'address' });

  if (result.kind !== 'conflict') {
    // 'match' confirms the pre-crawl guess; 'unknown' means the address named no
    // settlement we recognise — neither is grounds for removing a crawled lead.
    await appendSignal(batchId, domain, signal(
      result.kind === 'match' ? 'MATCHES_PERSONA_AND_LOCATION' : 'LOCATION_UNKNOWN',
      result.kind === 'match' ? 'ACCEPT' : 'REVIEW',
      'post_crawl',
      result.kind === 'match'
        ? result.detail
        : `адресът „${address}“ не съдържа разпознато населено място`,
    ), { onlyIfExists: true });
    return { verified: true, demoted: false };
  }

  const detail = `реален адрес от сайта: ${result.detail}`;

  console.log(
    `[verify] demoting ${domain} — address conflicts with requested location ` +
    `"${location}" (${address})`,
  );

  // Move the candidate to the review tier with the evidence attached.
  await appendSignal(
    batchId, domain,
    signal('LOCATION_CONFLICT_VERIFIED', 'REJECT', 'post_crawl', detail),
    {
      status:         'REVIEW',
      rejectedReason: 'LOCATION_CONFLICT_VERIFIED',
    },
  );

  // Drop it out of the results list. This mirrors the manual exclude path in
  // routes/batches.ts — and because progress is derived from non-excluded
  // TenantCompany rows, excluding removes the row from the numerator and the
  // denominator together, so the batch percentage stays exactly where it was.
  await prisma.tenantCompany.updateMany({
    where: { tenantId, sourceBatchId: batchId, company: { domain } },
    data:  { excluded: true },
  });

  await refreshBatchProgress(batchId, tenantId);

  return { verified: true, demoted: true, reason: 'LOCATION_CONFLICT_VERIFIED', detail };
}

/**
 * Appends one signal to a candidate's decision record, preserving what is there.
 *
 * `onlyIfExists` skips the write when there is no candidate row — a crawl that did
 * not come from discovery (a re-enrich, say) has nothing to annotate.
 */
async function appendSignal(
  batchId: string,
  domain: string,
  entry: DecisionSignal,
  opts: {
    status?: 'REVIEW';
    rejectedReason?: string;
    onlyIfExists?: boolean;
  } = {},
): Promise<void> {
  const candidate = await prisma.discoveryCandidate.findUnique({
    where:  { batchId_domain: { batchId, domain } },
    select: { decisionSignals: true },
  });

  if (!candidate) {
    if (!opts.onlyIfExists) {
      console.warn(`[verify] no candidate row for ${domain} in batch ${batchId}`);
    }
    return;
  }

  const existing = Array.isArray(candidate.decisionSignals)
    ? candidate.decisionSignals as unknown as DecisionSignal[]
    : [];

  await prisma.discoveryCandidate.update({
    where: { batchId_domain: { batchId, domain } },
    data: {
      decisionSignals: [...existing, entry] as unknown as object[],
      decidedAt:       new Date(),
      ...(opts.status         ? { status: opts.status } : {}),
      ...(opts.rejectedReason ? { rejectedReason: opts.rejectedReason } : {}),
    },
  });
}
