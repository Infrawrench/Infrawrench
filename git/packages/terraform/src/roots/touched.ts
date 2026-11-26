import type { TerraformDirectory } from "./discover.js";

/**
 * Which roots a set of changed files touches: a file under the root, or
 * under a directory the root calls as a local module, however many calls
 * away. A pull request then plans only the workspaces it can change.
 *
 * `directories` is the discovery of the commit the change leads to. A root
 * that discovery does not know (not a Terraform directory any more, or past
 * the walk's limits) counts as touched: planning one workspace too many
 * costs a run, planning one too few hides a change.
 */
export function rootsTouchedBy(
  rootPaths: readonly string[],
  changedPaths: readonly string[],
  directories: readonly TerraformDirectory[],
): Set<string> {
  const byPath = new Map(directories.map((directory) => [directory.path, directory]));
  const under = (directory: string, file: string): boolean =>
    directory === "" || file === directory || file.startsWith(`${directory}/`);

  const touched = new Set<string>();
  for (const root of rootPaths) {
    if (!byPath.has(root)) {
      touched.add(root);
      continue;
    }
    // The root and every local module it reaches.
    const reach = new Set<string>([root]);
    const queue = [root];
    while (queue.length > 0) {
      const directory = byPath.get(queue.pop()!);
      for (const call of directory?.moduleCalls ?? []) {
        if (call.localPath !== null && !reach.has(call.localPath)) {
          reach.add(call.localPath);
          queue.push(call.localPath);
        }
      }
    }
    // A module directory holds its own files only: a change in a directory
    // below it belongs to whatever calls that one. The root is the exception,
    // since files beside it (`*.tfvars`, templates in subdirectories that are
    // not Terraform directories themselves) are read from it.
    const hit = changedPaths.some((file) => {
      for (const directory of reach) {
        if (!under(directory, file)) continue;
        if (directory !== root) return true;
        // Under the root: unless it is inside another Terraform directory the root does not reach.
        const inner = directories.some(
          (other) =>
            other.path !== root &&
            other.path.length > root.length &&
            under(root, other.path) &&
            under(other.path, file) &&
            !reach.has(other.path),
        );
        if (!inner) return true;
      }
      return false;
    });
    if (hit) touched.add(root);
  }
  return touched;
}
