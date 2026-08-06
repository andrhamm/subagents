import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

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

/**
 * Like safePath, but for a target that may not exist yet (write_file
 * creating a new file). safePath returns a non-existing target unresolved,
 * which leaves one hole: a symlinked *ancestor* directory inside the root
 * can point outside it, and the unresolved path still starts with the root
 * prefix. Realpath the deepest existing ancestor first, re-append the
 * not-yet-existing remainder, and check that instead.
 */
export function safeWritePath(root: string, rel: string): string {
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, rel);

  let ancestor = target;
  const remainder: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // reached the filesystem root
    remainder.unshift(basename(ancestor));
    ancestor = parent;
  }
  const real = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
  const check = remainder.length ? join(real, ...remainder) : real;

  if (check !== rootReal && !check.startsWith(rootReal + sep)) {
    throw new Error(`path escapes root: ${rel}`);
  }
  return check;
}
