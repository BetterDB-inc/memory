import type { SessionSummary } from "./schema.js";

// Quote-grounded extraction: the summarize prompt requires every decision and
// problemSolved to carry a short verbatim `quote` from the transcript. This
// module is the deterministic other half of that contract — an item is kept
// only if its quote actually appears in the transcript (whitespace- and
// case-normalized substring match). Claims the model invented have no quote to
// point at, so they are dropped instead of stored. Quotes are stripped from
// the surviving items: they ground extraction, they are not part of the memory.

/**
 * Quotes shorter than this (after normalization) match too easily ("ok",
 * "yes") to count as evidence, so items carrying them are dropped too.
 */
const MIN_QUOTE_LENGTH = 12;

/** Collapse whitespace and case so wrapping/formatting differences don't
 * break an otherwise verbatim quote. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isGrounded(
  quote: string | undefined,
  normalizedTranscript: string,
): boolean {
  if (quote === undefined) return false;
  const q = normalize(quote);
  if (q.length < MIN_QUOTE_LENGTH) return false;
  return normalizedTranscript.includes(q);
}

/**
 * Drop decisions and problemsSolved whose supporting quote is missing, too
 * short, or not found verbatim in the transcript; strip quotes from the rest.
 * Patterns, open threads, files, and the one-line summary pass through — the
 * quote contract only covers the two claim-bearing sections.
 */
export function groundSummary(
  summary: SessionSummary,
  transcript: string,
): SessionSummary {
  const t = normalize(transcript);
  return {
    ...summary,
    decisions: summary.decisions
      .filter((d) => isGrounded(d.quote, t))
      .map(({ quote: _quote, ...rest }) => rest),
    problemsSolved: summary.problemsSolved
      .filter((p) => isGrounded(p.quote, t))
      .map(({ quote: _quote, ...rest }) => rest),
  };
}
