/**
 * The command an SSH client asks for, parsed and never run. `git` sends
 * `git-upload-pack '<path>'` (or `git upload-pack`, from a `git` configured
 * that way); everything else is refused. The path is the client's, byte for
 * byte, so it is unquoted by the same rule git quotes it with and then held
 * to the shape of `owner/repo`.
 */
import type { GitServiceName } from "@infrawrench/git-protocol";
import { parseRepositoryPath } from "../directory";

export type ParsedCommand =
  | {
      readonly kind: "git";
      readonly service: GitServiceName;
      readonly owner: string;
      readonly name: string;
    }
  | { readonly kind: "unsupported"; readonly reason: string };

/**
 * Undoes git's `sq_quote`: the argument in single quotes, a quote inside
 * written as `'\''` (or `'\!'` for `!`). Null when it is not quoted that
 * way. A bare word with no quoting characters is accepted as it is.
 */
export function unquote(argument: string): string | null {
  if (!argument.startsWith("'")) {
    return /^[A-Za-z0-9._\-/~]+$/.test(argument) ? argument : null;
  }
  let out = "";
  let at = 0;
  while (at < argument.length) {
    if (argument[at] !== "'") return null;
    const end = argument.indexOf("'", at + 1);
    if (end < 0) return null;
    out += argument.slice(at + 1, end);
    at = end + 1;
    if (at === argument.length) break;
    // Between two quoted runs there is exactly one escaped character.
    if (argument[at] !== "\\" || at + 1 >= argument.length) return null;
    const escaped = argument[at + 1]!;
    if (escaped !== "'" && escaped !== "!") return null;
    out += escaped;
    at += 2;
  }
  return out;
}

const SERVICES: ReadonlyArray<readonly [string, GitServiceName]> = [
  ["git-upload-pack ", "git-upload-pack"],
  ["git upload-pack ", "git-upload-pack"],
  ["git-receive-pack ", "git-receive-pack"],
  ["git receive-pack ", "git-receive-pack"],
];

export function parseCommand(command: string): ParsedCommand {
  for (const [prefix, service] of SERVICES) {
    if (!command.startsWith(prefix)) continue;
    // Only ASCII blanks around the path: `trim` would also take Unicode
    // spaces, and nothing git sends has those.
    const path = unquote(command.slice(prefix.length).replace(/^[ \t]+|[ \t]+$/g, ""));
    // A leading `-` would read as an option to anything that ran it.
    if (path === null || path.startsWith("-")) {
      return { kind: "unsupported", reason: "Invalid repository path." };
    }
    if (path.startsWith("~") || path.startsWith("/~")) {
      return { kind: "unsupported", reason: "Home directory paths are not supported." };
    }
    const repo = parseRepositoryPath(path);
    if (!repo) return { kind: "unsupported", reason: "Invalid repository path." };
    return { kind: "git", service, ...repo };
  }
  if (command.startsWith("git-upload-archive") || command.startsWith("git upload-archive")) {
    return { kind: "unsupported", reason: "git archive --remote is not supported." };
  }
  return { kind: "unsupported", reason: "Only git commands are served here." };
}
