export type HookEvent =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "SessionEnd"
  | "Stop";

export interface HookSpec {
  readonly event: HookEvent;
  readonly source: string;
  readonly binary: string;
  readonly matcher?: string;
}

export interface HookCommand {
  readonly type: "command";
  readonly command: string;
}

export interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

export const HOOK_SPECS: readonly HookSpec[] = [
  { event: "SessionStart", source: "session-start.ts", binary: "session-start" },
  { event: "PreToolUse", source: "pre-tool.ts", binary: "pre-tool", matcher: "" },
  {
    event: "PostToolUse",
    source: "post-tool.ts",
    binary: "post-tool",
    matcher: "",
  },
  { event: "SessionEnd", source: "session-end.ts", binary: "session-end" },
  { event: "Stop", source: "stop-checkpoint.ts", binary: "stop-checkpoint" },
];

export const HOOK_COUNT = HOOK_SPECS.length;

export function buildHookMap(
  toCommand: (spec: HookSpec) => string,
): Record<string, HookEntry[]> {
  const map: Record<string, HookEntry[]> = {};
  for (const spec of HOOK_SPECS) {
    const hooks: HookCommand[] = [{ type: "command", command: toCommand(spec) }];
    const entry: HookEntry =
      spec.matcher === undefined ? { hooks } : { matcher: spec.matcher, hooks };
    (map[spec.event] ??= []).push(entry);
  }
  return map;
}

export function formatHookSummary(): string[] {
  const width = Math.max(...HOOK_SPECS.map((spec) => spec.event.length));
  return HOOK_SPECS.map(
    (spec) => `  ${spec.event.padEnd(width)} → ${spec.source}`,
  );
}
