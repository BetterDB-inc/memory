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
  "decisions": [],
  "patterns": [],
  "problemsSolved": [],
  "openThreads": [],
  "filesChanged": [],
  "oneLineSummary": ""
}

Fields:
- decisions: max 10 specific technical decisions made
- patterns: max 5 reusable approaches or code patterns used
- problemsSolved: max 5 objects with "problem" and "resolution" keys
- openThreads: max 5 unresolved questions or TODOs discovered
- filesChanged: all file paths modified or created
- oneLineSummary: single sentence — what did this session accomplish?

Transcript:
${transcript}
`.trim();
