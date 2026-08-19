-- Adds the "uncertain" tier and the explainable decision record.
--
-- CandidateStatus gains REVIEW: candidates the filter is not confident about are
-- surfaced for a human instead of being silently kept (the old behaviour, which
-- let wrong-town and wrong-category sites into the results) or silently dropped.
--
-- decisionSignals stores the criteria that produced the verdict, so the UI can
-- show WHY a site was accepted or rejected, not just the conclusion.

-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older
-- PostgreSQL, and Prisma wraps each migration in one. Adding the value in its own
-- statement first, before any use of it, is what keeps this safe on PG 12+.
ALTER TYPE "CandidateStatus" ADD VALUE IF NOT EXISTS 'REVIEW' AFTER 'KEPT';

ALTER TABLE "DiscoveryCandidate"
  ADD COLUMN IF NOT EXISTS "decisionSignals" JSONB,
  ADD COLUMN IF NOT EXISTS "decidedAt" TIMESTAMP(3);

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Existing rows were written by three separate reason vocabularies (Groq codes,
-- qualifier strings, education strings) that this change unifies into ReasonCode.
-- The UI renders a Reason column over that data and falls back to printing an
-- unmapped code raw, so without this a user sees `directory_or_portal` instead of
-- „Каталог или портал“.
--
-- NOTE: no statement below may reference 'REVIEW'. Postgres allows ALTER TYPE ...
-- ADD VALUE inside a transaction (PG 12+), but the new label cannot be USED until
-- that transaction commits — and Prisma wraps this whole file in one.

-- 1. A KEPT row that still carries a rejection reason was promoted by the old
--    include path, which changed `status` and left the stale reason behind.
--    That action is exactly what USER_INCLUDED now records.
UPDATE "DiscoveryCandidate"
   SET "rejectedReason" = 'USER_INCLUDED'
 WHERE "status" = 'KEPT'
   AND "rejectedReason" IS NOT NULL
   AND "rejectedReason" <> 'MATCHES_PERSONA_AND_LOCATION';

-- 2. Accepted rows that never had a reason at all.
UPDATE "DiscoveryCandidate"
   SET "rejectedReason" = 'MATCHES_PERSONA_AND_LOCATION'
 WHERE "status" = 'KEPT'
   AND "rejectedReason" IS NULL;

-- 3. Map the legacy vocabularies onto ReasonCode.
UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'DIRECTORY_OR_PORTAL'
 WHERE "rejectedReason" IN (
   'DIRECTORY', 'AGGREGATOR', 'directory_or_portal', 'directory',
   'directory_domain', 'ranking', 'guide', 'portal'
 );

UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'MUNICIPALITY_PAGE'
 WHERE "rejectedReason" IN ('MUNICIPALITY', 'municipality_page', 'municipality');

UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'NEWS_ARTICLE'
 WHERE "rejectedReason" IN ('NEWS_SITE', 'news_article', 'news');

UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'OFFICIAL_REGISTRY'
 WHERE "rejectedReason" IN ('EDUCATION_PORTAL', 'registry');

UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'LOCATION_CONFLICT'
 WHERE "rejectedReason" IN ('LOCATION_MISMATCH', 'location_mismatch');

UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'NOT_TARGET_ORGANIZATION'
 WHERE "rejectedReason" IN ('irrelevant', 'insufficient_education_confidence');

UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'SOCIAL_PLATFORM'
 WHERE "rejectedReason" IN ('social_page', 'social_platform_domain');

UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'SAME_DOMAIN_AS_SOURCE'
 WHERE "rejectedReason" = 'same_domain_as_source';

UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'NO_CONTACT_SIGNAL'
 WHERE "rejectedReason" = 'no_contact_signal';

-- `low_confidence(37)` embedded the score, so it needs a LIKE.
UPDATE "DiscoveryCandidate" SET "rejectedReason" = 'BELOW_CONFIDENCE_FLOOR'
 WHERE "rejectedReason" LIKE 'low_confidence(%';

-- Rows whose reason is still NULL are left alone on purpose: those rejections
-- were never recorded (the reason was assigned to a copy of the candidate and
-- never reached the database), and inventing one would be worse than the honest
-- "—" the UI already shows.
