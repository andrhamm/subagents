import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Resolve `rel` against `root` and refuse anything that escapes it.
 * Existing targets are realpath'd so a symlink cannot lead outside.
 */
export function safePath(root: string, rel: string): string {
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, rel);
  const check = existsSync(target) ? realpathSync(target) : target;
  if (check !== rootReal && !check.startsWith(rootReal + sep)) {
    throw new Error(`path escapes root: ${rel}`);
  }
  return check;
}
