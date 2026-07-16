// Events this plugin used to register on and no longer does. mergeHooks only
// touches events present in the current hook map, so without an explicit strip
// a stale registration would survive upgrades forever in a user's
// ~/.claude/settings.json.
const LEGACY_EVENTS = ["Stop"];

/**
 * `markers` identify an entry as ours. The default catches installed binaries
 * under ~/.betterdb; dev registrations point at a plugin checkout whose path
 * may not contain "betterdb", so callers pass that path as an extra marker.
 */
export function stripLegacyBetterdbHooks(
  hooks: Record<string, unknown[]>,
  markers: string[] = ["betterdb"],
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = { ...hooks };

  for (const event of LEGACY_EVENTS) {
    const entries = out[event];
    if (!Array.isArray(entries)) {
      continue;
    }
    // Only ours — a third party's hook on the same event must survive.
    const kept = entries.filter((entry) => {
      const json = JSON.stringify(entry);
      return !markers.some((m) => {
        return m.length > 0 && json.includes(m);
      });
    });
    if (kept.length > 0) {
      out[event] = kept;
    } else {
      delete out[event];
    }
  }

  return out;
}
