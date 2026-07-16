import { SessionSummarySchema, type SessionSummary } from "./schema.js";

// Every field of SessionSummarySchema has a `.default()`, so `{}` — and any
// object the model returns that carries no recognised fields — parses
// successfully into an all-defaults husk. Validation therefore cannot tell an
// empty summary from a real one; this predicate is the only thing that can.
const DEFAULT_ONE_LINE = SessionSummarySchema.parse({}).oneLineSummary;

export function isEmptySummary(summary: SessionSummary): boolean {
  if (summary.decisions.length > 0) {
    return false;
  }
  if (summary.patterns.length > 0) {
    return false;
  }
  if (summary.problemsSolved.length > 0) {
    return false;
  }
  if (summary.openThreads.length > 0) {
    return false;
  }
  if (summary.filesChanged.length > 0) {
    return false;
  }
  return summary.oneLineSummary.trim() === DEFAULT_ONE_LINE;
}
