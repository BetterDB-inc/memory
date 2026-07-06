/**
 * Strip markdown code fences that LLMs sometimes wrap around JSON output.
 */
export function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

/**
 * Shared summarization prompt used by all providers.
 * Ensures consistent structured data extraction regardless of which model runs it.
 */
export const buildSummarizePrompt = (transcript: string): string =>
  `
You are extracting structured data from a Claude Code session transcript.
Return ONLY valid JSON matching this exact structure, with no explanation:
{
  "decisions": [{"text": "", "status": "done", "quote": ""}],
  "patterns": [],
  "problemsSolved": [{"problem": "", "resolution": "", "quote": ""}],
  "openThreads": [],
  "filesChanged": [],
  "oneLineSummary": ""
}

Rules — follow them strictly:
- Record ONLY what the transcript actually shows. When unsure, omit the item — never guess or fill gaps. The transcript may contain "[...]" where turns were elided; do not invent what happened there.
- Every decision and every problemsSolved item MUST include "quote": a short verbatim excerpt (roughly 5-15 words) copied character-for-character from the transcript that supports it. Items whose quote does not appear verbatim in the transcript are DISCARDED by a validator, so paraphrased quotes waste the item.
- decision "status" must be one of: "done" (actually made or implemented), "proposed" (suggested but not committed to), "rejected" (turned down), "open" (still undecided). Do NOT record discussed options as "done".

Fields:
- decisions: max 10 specific technical decisions, each {"text", "status", "quote"}
- patterns: max 5 reusable approaches or code patterns used
- problemsSolved: max 5 objects with "problem", "resolution", and "quote" keys
- openThreads: max 5 unresolved questions or TODOs discovered
- filesChanged: all file paths modified or created
- oneLineSummary: single sentence — what did this session accomplish?

Transcript:
${transcript}
`.trim();
