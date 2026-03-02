import type { ModelClient } from "../client/model.js";
import type { SessionEvent, SessionSummary } from "./schema.js";

// --- Git Helpers ---

export function getGitBranch(): string {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    const output = result.stdout.toString().trim();
    return output || "unknown";
  } catch {
    return "unknown";
  }
}

export function getGitLog(n = 5): string {
  try {
    const result = Bun.spawnSync([
      "git",
      "log",
      `--oneline`,
      `-n`,
      String(n),
      "--format=%s",
    ]);
    return result.stdout.toString().trim();
  } catch {
    return "";
  }
}

export function getStagedFiles(): string[] {
  try {
    const result = Bun.spawnSync([
      "git",
      "diff",
      "--cached",
      "--name-only",
    ]);
    const output = result.stdout.toString().trim();
    return output ? output.split("\n") : [];
  } catch {
    return [];
  }
}

export function getCwdProject(): string {
  try {
    const parts = process.cwd().split("/");
    return parts[parts.length - 1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

// --- Importance Scoring ---

export function computeInitialImportance(summary: SessionSummary): number {
  let score = 0.3;
  score += Math.min(summary.problemsSolved.length * 0.15, 0.3);
  score += Math.min(summary.decisions.length * 0.05, 0.15);
  score += Math.min(summary.filesChanged.length * 0.02, 0.1);
  score += summary.openThreads.length > 0 ? 0.1 : 0;
  score += summary.patterns.length > 0 ? 0.05 : 0;
  return Math.min(score, 1.0);
}

// --- Session Capture ---

export class SessionCapture {
  private events: SessionEvent[] = [];

  addEvent(event: SessionEvent): void {
    this.events.push(event);
  }

  buildTranscript(): string {
    return this.events
      .map((e) => {
        const filePart = e.filePath ? ` [${e.filePath}]` : "";
        return `[${e.timestamp}] ${e.eventType}${filePart}: ${e.content}`;
      })
      .join("\n");
  }

  async capture(client: ModelClient): Promise<SessionSummary> {
    const transcript = this.buildTranscript();
    if (!transcript.trim()) {
      const { SessionSummarySchema } = await import("./schema.js");
      return SessionSummarySchema.parse({});
    }
    return client.summarize(transcript);
  }

  async getQueryContext(): Promise<string> {
    const parts: string[] = [];

    const project = getCwdProject();
    parts.push(`Project: ${project}`);

    const branch = getGitBranch();
    if (branch !== "unknown") {
      parts.push(`Branch: ${branch}`);
    }

    const gitLog = getGitLog(5);
    if (gitLog) {
      parts.push(`Recent commits:\n${gitLog}`);
    }

    const staged = getStagedFiles();
    if (staged.length > 0) {
      parts.push(`Staged files: ${staged.join(", ")}`);
    }

    return parts.join("\n");
  }

  get eventCount(): number {
    return this.events.length;
  }
}
