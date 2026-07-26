/**
 * Casing helpers shared by every SDK target.
 *
 * Deliberately target-agnostic: a target decides whether it wants
 * `secretVersions` or `secret_versions`, but the word-splitting rules that get
 * there are the same everywhere, so they live here.
 */

/** Split an identifier of any casing into its constituent words. */
export function words(input: string): string[] {
  return input
    .split(/[^A-Za-z0-9]+/)
    .flatMap((chunk) => chunk.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .filter(Boolean);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** `ssh-keys` / `SSH Keys` / `sshKeys` → `sshKeys`. */
export function camelCase(input: string): string {
  const parts = words(input);
  if (parts.length === 0) return "";
  const [head, ...rest] = parts;
  return head!.toLowerCase() + rest.map(capitalize).join("");
}

/** `ssh-keys` → `SshKeys`. */
export function pascalCase(input: string): string {
  return words(input).map(capitalize).join("");
}

/** `secret-versions` → `secret_versions` (for future snake_case targets). */
export function snakeCase(input: string): string {
  return words(input)
    .map((w) => w.toLowerCase())
    .join("_");
}

/**
 * Make `name` unique within `taken`, appending `2`, `3`, … until it is. Records
 * the winner in `taken` so repeated calls keep converging.
 */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  for (let n = 2; ; n++) {
    const candidate = `${name}${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}
