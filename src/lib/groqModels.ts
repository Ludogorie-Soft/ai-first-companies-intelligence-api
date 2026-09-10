// Central home for Groq model selection.
//
// Groq deprecates models on a schedule and every call site naming one hardcoded
// breaks on the same day. That has now happened twice: the discovery filter 404ed
// on 2026-08-17 and was fixed alone, leaving five other services still pointing at
// `llama-3.1-8b-instant` / `llama-3.3-70b-versatile` (both shut down 2026-08-16).
// Model names live here so the next deprecation is one edit — or none at all, since
// every tier reads an env override first.
//
// Verified against this account's `GET /openai/v1/models`. Groq's own migration
// guidance for the retired Llama models is 8b-instant → gpt-oss-20b and
// 70b-versatile → gpt-oss-120b, which is the split the two tiers below encode.
//
// Caveat carried over from the discovery filter: of the models available here, only
// gpt-oss-120b reliably honours `response_format: { type: 'json_object' }` for a
// non-trivial prompt — gpt-oss-20b and qwen3.6-27b both answer 400 "Failed to
// validate JSON". Callers that need enforced JSON must use the heavy tier. Callers
// that parse JSON out of free text (fence-strip + `{...}` match) are fine on either.

/** Cheap/fast tier — short, mechanical extraction and validation calls. */
const DEFAULT_GROQ_FAST_MODEL = 'openai/gpt-oss-20b';

/** Capable tier — judgement calls and anything generating prose. */
const DEFAULT_GROQ_HEAVY_MODEL = 'openai/gpt-oss-120b';

export function groqFastModel(): string {
  return process.env.GROQ_FAST_MODEL || DEFAULT_GROQ_FAST_MODEL;
}

export function groqHeavyModel(): string {
  return process.env.GROQ_MODEL || DEFAULT_GROQ_HEAVY_MODEL;
}

/**
 * `reasoning_effort` is accepted only by reasoning models; sending it to any other
 * model is a 400, hence the test rather than sending it unconditionally.
 */
export function supportsReasoningEffort(model: string): boolean {
  return /gpt-oss|qwen3|deepseek-r1/i.test(model);
}

/**
 * Spread into a Groq request body. On a reasoning model this roughly quarters the
 * thinking tokens with no measurable loss on mechanical tasks; on anything else it
 * expands to nothing.
 */
export function reasoningParams(model: string): { reasoning_effort?: 'low' } {
  return supportsReasoningEffort(model) ? { reasoning_effort: 'low' } : {};
}

/**
 * Budget for a Groq completion: the caller passes the tokens its ANSWER needs and
 * gets back a budget that also covers the model's chain of thought.
 *
 * gpt-oss models are reasoning models and the thinking is billed as completion
 * tokens against `max_tokens`. When the budget runs out mid-thought the reply comes
 * back HTTP 200 with `finish_reason: "length"` and an EMPTY `message.content` — a
 * silent failure, strictly worse than the 404 this migration replaced.
 *
 * Measured on this account at `reasoning_effort: 'low'` (2026-08-19): thinking is
 * cheap — 16-96 tokens across short and long prompts. The budgets still needed
 * raising, for a second reason: gpt-oss is markedly more verbose than the Llama
 * models it replaces. A realistic services-extraction page answered in 500
 * completion tokens against the old `max_tokens: 512` — twelve tokens from
 * truncating. The headroom below covers both the thinking and that verbosity.
 */
export function maxTokensFor(model: string, answerTokens: number): number {
  return supportsReasoningEffort(model) ? answerTokens + REASONING_HEADROOM : answerTokens;
}

/**
 * Deliberately generous. These are sequential per-company worker calls, not the
 * concurrent chunk fan-out that forced discovery's `CHUNK_CONCURRENCY = 2`, so the
 * up-front reservation does not squeeze the free tier's shared per-minute budget.
 */
const REASONING_HEADROOM = 1_000;
