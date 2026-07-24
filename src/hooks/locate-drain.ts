import { join } from "node:path";

export interface DrainLocations {
  readonly execDir: string;
  readonly installBinDir: string;
  readonly sourceDir: string;
}

/**
 * Resolve the drainer to spawn, in order of preference: the binary compiled
 * next to the running hook (dev builds via build:hooks), the binary the CLI
 * install placed in ~/.betterdb/bin, then bun-running the source (the
 * register-hooks.ts shape). Inside a compiled executable sourceDir is a bunfs
 * virtual path where drain.ts never exists, which is why the sibling binary
 * must be checked first.
 */
export async function locateDrainCommand(
  locations: DrainLocations,
): Promise<string[] | null> {
  const siblingBin = join(locations.execDir, "drain");
  if (await Bun.file(siblingBin).exists()) {
    return [siblingBin];
  }

  const installedBin = join(locations.installBinDir, "drain");
  if (await Bun.file(installedBin).exists()) {
    return [installedBin];
  }

  const source = join(locations.sourceDir, "drain.ts");
  if (await Bun.file(source).exists()) {
    return ["bun", "run", source];
  }

  return null;
}
