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
  readonly timeout: number;
}

export interface HookCommand {
  readonly type: "command";
  readonly command: string;
  readonly timeout: number;
}

export interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

/**
 * Timeouts are seconds, enforced by Claude Code per hook invocation. They are
 * a backstop over the client-side fail-fast connect: pre/post fire on every
 * tool call and must never make a tool call feel slow; the session-boundary
 * hooks may parse large transcripts and get more room.
 */
export const HOOK_SPECS: readonly HookSpec[] = [
  {
    event: "SessionStart",
    source: "session-start.ts",
    binary: "session-start",
    timeout: 30,
  },
  {
    event: "PreToolUse",
    source: "pre-tool.ts",
    binary: "pre-tool",
    matcher: "",
    timeout: 10,
  },
  {
    event: "PostToolUse",
    source: "post-tool.ts",
    binary: "post-tool",
    matcher: "",
    timeout: 10,
  },
  {
    event: "SessionEnd",
    source: "session-end.ts",
    binary: "session-end",
    timeout: 60,
  },
  {
    event: "Stop",
    source: "stop-checkpoint.ts",
    binary: "stop-checkpoint",
    timeout: 30,
  },
];

export interface BinarySpec {
  readonly source: string;
  readonly binary: string;
}

/**
 * Non-hook binaries that must ship next to the hook binaries: the SessionEnd
 * hook resolves the drainer as a sibling of its own executable, so every
 * shape that compiles hooks must compile these too.
 */
export const COMPANION_BINARIES: readonly BinarySpec[] = [
  { source: "drain.ts", binary: "drain" },
];

export const HOOK_COUNT = HOOK_SPECS.length;

const HOOK_SOURCES: readonly string[] = HOOK_SPECS.map((spec) => spec.source);

const HOOK_BINARY_PATHS: readonly string[] = HOOK_SPECS.map(
  (spec) => `dist/hooks/${spec.binary}`,
);

/**
 * Whether a hook entry already in ~/.claude/settings.json is one this plugin
 * wrote, and so may be replaced.
 *
 * Matching an install path alone is not enough: register-hooks.ts points hooks
 * at a checkout whose path need not contain "betterdb", so such an entry
 * survived a later install and kept firing alongside the new registration. The
 * source filenames and dist/hooks binary paths come from HOOK_SPECS, so they
 * identify our entries wherever the checkout lives — install-hooks.sh
 * registers compiled binaries that contain no source filename. `markers` adds
 * the caller's own install location.
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
  if (HOOK_BINARY_PATHS.some((path) => json.includes(path))) {
    return true;
  }
  return markers.some((marker) => marker.length > 0 && json.includes(marker));
}

export function buildHookMap(
  toCommand: (spec: HookSpec) => string,
): Record<string, HookEntry[]> {
  const map: Record<string, HookEntry[]> = {};
  for (const spec of HOOK_SPECS) {
    const hooks: HookCommand[] = [
      { type: "command", command: toCommand(spec), timeout: spec.timeout },
    ];
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
