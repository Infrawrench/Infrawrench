import { PluginGenError } from "../errors.js";
import { oneLine } from "../text.js";
import {
  checkWatcherBranch,
  createForgeTracker,
  forgeCredentials,
  forgeRemote,
  forgeSettings,
} from "./forge.js";
import { createGitPort, type GitPort } from "./git.js";
import { gitHubCli } from "./github.js";
import type { TrackerPort } from "./tracker.js";

/**
 * Where the watcher pushes its branches and tracks its changes and issues. GitHub until
 * the repository's source of truth moves to the forge, and the default for that reason.
 */
export const TARGETS = ["github", "forge"] as const;
export type TargetName = (typeof TARGETS)[number];

export const TARGET_ENV = "PLUGINGEN_TARGET";

export interface WatchTarget {
  name: TargetName;
  tracker: TrackerPort;
  git: GitPort;
}

export function isTargetName(value: string): value is TargetName {
  return (TARGETS as readonly string[]).includes(value);
}

/** `--target` wins over `PLUGINGEN_TARGET`. Neither set, or set to nothing, is GitHub. */
export function targetName(flag: string | undefined, env: NodeJS.ProcessEnv): TargetName {
  const chosen = flag ?? env[TARGET_ENV]?.trim() ?? "";
  if (chosen === "") return "github";
  if (isTargetName(chosen)) return chosen;
  throw new PluginGenError(
    "config",
    `${flag === undefined ? TARGET_ENV : "--target"} must be ${TARGETS.join(" or ")}, not ${oneLine(chosen, 40)}`,
  );
}

/**
 * Everything of one target. The forge's needs its token, and says so here, before any
 * document is fetched. Both push from the checkout at `root`; only the remote, the
 * credentials and the tracker differ, and the forge's never touches `origin`.
 */
export function createTarget(
  name: TargetName,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): WatchTarget {
  if (name === "github") return { name, tracker: gitHubCli, git: createGitPort(root) };
  const settings = forgeSettings(env);
  const git = createGitPort(root, forgeRemote(settings), {
    credentials: forgeCredentials(settings),
    checkBranch: checkWatcherBranch,
    secrets: [settings.token],
  });
  return { name, tracker: createForgeTracker(settings, { git }), git };
}
