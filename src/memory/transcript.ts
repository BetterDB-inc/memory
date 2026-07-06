// Priority-based transcript selection (replaces the old head+tail truncation,
// which cut out the middle of long sessions — precisely where the summarizer
// then hallucinated what "must have" happened).
//
// Priority: user turns first (they state intent, approvals, and rejections),
// then assistant turns ranked by proximity to a user turn (replies adjacent to
// a user message carry the decisions), tool lines last (high volume, low
// signal). Selected turns are re-emitted in original order with `[...]`
// markers where turns were dropped, so the model can see the transcript is
// elided rather than inventing continuity.

export interface TranscriptTurn {
  role: "user" | "assistant" | "tool";
  /** The already-formatted transcript line, e.g. "User: ...". */
  text: string;
}

const GAP_MARKER = "[...]";

function tier(role: TranscriptTurn["role"]): number {
  return role === "user" ? 0 : role === "assistant" ? 1 : 2;
}

/**
 * Select the highest-priority subset of `turns` that fits in `maxChars`,
 * preserving original order. A transcript that already fits is returned
 * verbatim. When even the greedy pass selects nothing (e.g. one enormous
 * turn), falls back to a plain head+tail slice so a tool-only fallback
 * transcript is never emptied.
 */
export function selectTranscript(
  turns: TranscriptTurn[],
  maxChars: number,
): string {
  const full = turns.map((t) => t.text).join("\n");
  if (full.length <= maxChars) return full;

  const userIndices = turns.flatMap((t, i) => (t.role === "user" ? [i] : []));
  const proximity = (i: number): number =>
    userIndices.length === 0
      ? 0
      : Math.min(...userIndices.map((u) => Math.abs(u - i)));

  // Rank: tier, then (for assistant turns) closeness to a user turn, then
  // original order. Greedy fill: a turn that doesn't fit is skipped, but
  // smaller lower-ranked turns may still fit the remaining budget.
  const ranked = turns
    .map((turn, index) => ({ turn, index, prox: proximity(index) }))
    .sort(
      (a, b) =>
        tier(a.turn.role) - tier(b.turn.role) ||
        (a.turn.role === "assistant" ? a.prox - b.prox : 0) ||
        a.index - b.index,
    );

  const selected = new Set<number>();
  // Reserve room for gap markers between non-contiguous selections.
  let budget = maxChars - GAP_MARKER.length * 2;
  for (const { turn, index } of ranked) {
    const cost = turn.text.length + 1;
    if (cost <= budget) {
      selected.add(index);
      budget -= cost;
    }
  }

  if (selected.size === 0) {
    const half = Math.floor(maxChars / 2) - GAP_MARKER.length;
    return `${full.slice(0, half)}\n${GAP_MARKER}\n${full.slice(-half)}`;
  }

  const out: string[] = [];
  let prev = -1;
  for (const i of [...selected].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push(GAP_MARKER);
    out.push(turns[i]!.text);
    prev = i;
  }
  if (prev < turns.length - 1) out.push(GAP_MARKER);
  return out.join("\n");
}
