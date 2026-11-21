// Which build of the CLI this process is.
//
// The desktop app doubles as the `infrawrench` command (`--cli`, see
// `../index.ts`). The same sources also build a standalone CLI that runs on
// plain Node with no Electron (`scripts/build-cli.mjs`, shipped on npm, in
// the APT repository and as a single executable). That build defines
// `__INFRAWRENCH_STANDALONE_CLI__`; nothing else does, so in the desktop app
// and in tests this reads false.
//
// The standalone build has no local workspace (local accounts are added in
// the desktop app and their credentials sit behind its keychain entry), so it
// refuses `--local`, lists no "Local" scope, and leaves out the commands that
// drive the desktop app itself (`DESKTOP_ONLY_COMMANDS` in
// `effect/commands.ts`).

declare const __INFRAWRENCH_STANDALONE_CLI__: boolean | undefined;

let standalone =
  typeof __INFRAWRENCH_STANDALONE_CLI__ !== "undefined" && __INFRAWRENCH_STANDALONE_CLI__ === true;

/** True in the standalone CLI (npm, apt, the single executable); false inside the desktop app. */
export function isStandaloneCli(): boolean {
  return standalone;
}

/** Tests only: run the CLI as the standalone build would. */
export function setStandaloneCliForTesting(value: boolean): void {
  standalone = value;
}

/** What `--local` answers in the standalone CLI. */
export const LOCAL_NEEDS_DESKTOP =
  "--local reads the desktop app's local workspace. This standalone CLI works with your " +
  "Infrawrench Cloud organizations; use the desktop app's `infrawrench` command for local accounts.";

/** What a desktop-only command answers in the standalone CLI. */
export const desktopOnlyCommand = (name: string): string =>
  `\`infrawrench ${name}\` needs the Infrawrench desktop app. This standalone CLI works with ` +
  "your Infrawrench Cloud organizations; install the desktop app and run its shell command for this one.";
