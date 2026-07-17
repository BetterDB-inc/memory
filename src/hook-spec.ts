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

const HOOK_SOURCES: readonly string[] = HOOK_SPECS.map((spec) => spec.source);

/**
 * Whether a hook entry already in ~/.claude/settings.json is one this plugin
 * wrote, and so may be replaced.
 *
 * Matching an install path alone is not enough: register-hooks.ts points hooks
 * at a checkout whose path need not contain "betterdb", so such an entry
 * survived a later install and kept firing alongside the new registration. The
 * source filenames come from HOOK_SPECS, so they identify our entries wherever
 * the checkout lives. `markers` adds the caller's own install location.
 *
 * Deliberately conservative — a false positive deletes a third party's hook,
 * which is worse than leaving one of ours behind.
 */
export function isOwnHookEntry(
  entry: unknown,
  markers: readonly string[] = [],
): boolean {
  const json = JSON.stringify(entry) ?? "";
  if (HOOK_SOURCES.some((source) => json.includes(source))) {
    return true;
  }
  return markers.some((marker) => marker.length > 0 && json.includes(marker));
}

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

export function formatHookSummary(
  describe: (spec: HookSpec) => string = (spec) => spec.source,
): string[] {
  const width = Math.max(...HOOK_SPECS.map((spec) => spec.event.length));
  return HOOK_SPECS.map(
    (spec) => `  ${spec.event.padEnd(width)} → ${describe(spec)}`,
  );
}
