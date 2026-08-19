/**
 * Manual test: run the full discovery pipeline for a persona search and print results.
 *
 *   npx ts-node scripts/test-discovery.ts "зъболекари" "Банско"
 *
 * Runs DiscoveryOrchestrator directly, so it exercises the real filtering without
 * needing the worker to be alive — which is what makes it useful for telling
 * "the REVIEW tier never fires" apart from "no search has run".
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { DiscoveryOrchestrator } from '../src/services/discovery/index';
import type { DiscoverySourceResult } from '../src/services/discovery/types';

const SEP = '─'.repeat(70);

/** Prints the decision record under a candidate: the reason, then every criterion. */
function printDecision(c: DiscoverySourceResult, indent = '       ') {
  const d = c.decision;
  if (!d) {
    console.log(`${indent}⚠ no decision record attached`);
    return;
  }
  console.log(`${indent}reason: ${d.primaryReason}  (confidence ${d.confidence})`);
  if (d.signals.length === 0) {
    console.log(`${indent}⚠ no criteria recorded`);
    return;
  }
  for (const s of d.signals) {
    const mark = s.effect === 'ACCEPT' ? '+' : s.effect === 'REJECT' ? '-' : '?';
    console.log(
      `${indent}  ${mark} [${s.stage}] ${s.criterion}` +
      (s.detail ? ` — ${s.detail}` : ''),
    );
  }
}

function section(title: string, count: number) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${title}  (${count})`);
  console.log('═'.repeat(70));
}

async function main() {
  const persona  = process.argv[2] ?? 'детски градини';
  const location = process.argv[3] ?? 'гр. Мездра';
  const input = { persona, location, maxResults: 20 };

  console.log(`\n${SEP}`);
  console.log(`Discovery test — ${input.persona} | ${input.location}`);
  console.log(SEP + '\n');

  const orchestrator = new DiscoveryOrchestrator();
  const { accepted, review, rejected, allCandidates } = await orchestrator.discover(input);

  // ── Accepted ────────────────────────────────────────────────────────────────
  section('ACCEPTED', accepted.length);
  for (const c of accepted) {
    const label = c.name ? `${c.name} (${c.domain})` : c.domain;
    console.log(`  ✓  ${label}`);
    printDecision(c);
    if (c.extractedFromUrl) console.log(`       extracted from: ${c.extractedFromUrl}`);
    if (c.email)            console.log(`       email:  ${c.email}`);
    if (c.phone)            console.log(`       phone:  ${c.phone}`);
    if (c.address)          console.log(`       addr:   ${c.address}`);
    if (c.websiteUrl && c.websiteUrl !== `https://${c.domain}`) {
      console.log(`       site:   ${c.websiteUrl}`);
    }
  }

  // ── For review ──────────────────────────────────────────────────────────────
  // The middle tier. Empty is a legitimate result when every candidate was
  // decided confidently — check the criteria below to tell that apart from the
  // rules never firing at all.
  section('FOR REVIEW', review.length);
  for (const c of review) {
    const label = c.name ? `${c.name} (${c.domain})` : (c.domain ?? c.sourceUrl);
    console.log(`  ?  ${label}  type=${c.pageType}`);
    printDecision(c);
  }

  // ── Rejected ────────────────────────────────────────────────────────────────
  section('REJECTED', rejected.length);
  for (const c of rejected) {
    const label = c.name ? `${c.name} (${c.domain})` : (c.domain ?? c.sourceUrl);
    console.log(`  ✗  ${label}  type=${c.pageType}`);
    printDecision(c);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const byReason = new Map<string, number>();
  const missingSignals = allCandidates.filter(c => !c.decision?.signals?.length).length;
  for (const c of allCandidates) {
    const key = c.decision?.primaryReason ?? '(no decision)';
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }

  console.log(`\n${SEP}`);
  console.log(
    `Total: ${allCandidates.length} candidates → ${accepted.length} accepted, ` +
    `${review.length} for review, ${rejected.length} rejected`,
  );
  console.log('\nBy primary reason:');
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${reason}`);
  }
  console.log(
    missingSignals === 0
      ? '\nEvery candidate carries criteria ✓'
      : `\n⚠ ${missingSignals} candidate(s) carry NO criteria — the decision record is not being attached`,
  );
  console.log(SEP + '\n');
}

main().catch(err => {
  console.error('Discovery failed:', err);
  process.exit(1);
});
