/**
 * Nibblets (https://github.com/Infrawrench/nibblets) agent sessions.
 *
 * A Nibblets server is a whole agent host, not a coding session: it runs a
 * stack of containers (the server, a credential proxy, a host bridge) and its
 * "nibblets" are agents that run on Claude Code, Codex and others, which the
 * Nibblets installer signs in itself. So a `surface: "nibblets"` session
 * differs from the other two in shape:
 *
 *   1. the VM is provisioned as usual,
 *   2. the bootstrap runs Nibblets' own installer non-interactively
 *      (`NIBBLETS_YES=1`, Nibblets Connect skipped with `NIBBLETS_CONNECT=0`
 *      because in YES mode it would block for 15 minutes waiting for an
 *      approval nobody is looking at),
 *   3. optionally the server comes up **already linked to the organization**:
 *      Infrawrench mints an agent link for the person creating the session
 *      and hands its `iwl_` credential to the installer in a 0600 file
 *      (`NIBBLETS_APP_LINKS_FILE`), written over SSH from stdin so the secret
 *      is never in an argument list or a log,
 *   4. the interactive part (agent CLI sign-in, then Nibblets Connect) runs
 *      once from the session's Authorize terminal: `install.sh --sign-in`.
 *
 * There is **no repository and no `tool`**: Nibblets' installer offers every
 * agent CLI it supports in its own sign-in menu, so the session's tool would
 * map to nothing real. The column keeps its default and the UI hides the
 * choice for this surface.
 *
 * **Where it is used.** The UI listens on 127.0.0.1:8420 on the VM only.
 * Infrawrench has no browser-facing SSH port forward (its SSH tunnels forward
 * to the *server*, for plugin accounts, which a browser cannot reach), so the
 * session's main action opens Nibblets Connect (https://app.nibblets.dev)
 * externally: that is where a linked server is reached from anywhere, and the
 * Authorize terminal is where it gets linked. For people who would rather not
 * use Connect, the terminal also prints the `ssh -L` forward and a pair link.
 *
 * Free of React/DOM/Node dependencies: imported by the web API server as well
 * as both renderers.
 */
import { AGENT_SETUP_LOCK_SNIPPET, AGENT_SETUP_STEP_PREFIX, shellQuote } from "./launch-command.js";
import type { AgentSetupPlan, AgentSurface } from "./types.js";

/** Nibblets Connect, where a linked server is used from any device. */
export const NIBBLETS_CONNECT_URL = "https://app.nibblets.dev";
/** The installer. Safe to run again: it updates the checkout and restarts. */
export const NIBBLETS_INSTALL_URL = "https://nibblets.dev/install.sh";
/** Where the installer clones the repo (its default `NIBBLETS_DIR`). */
export const NIBBLETS_DIR = "nibblets";
/** The UI's port on the VM, bound to 127.0.0.1. */
export const NIBBLETS_PORT = 8420;
/** The platform slug and plugin id agent links and the app-links file use. */
export const NIBBLETS_PLATFORM = "nibblets";
export const NIBBLETS_INFRAWRENCH_PLUGIN = "infrawrench";
/**
 * Where the bootstrap reads the app-links file from. Under `$HOME`, in a
 * directory created 0700, and deleted by the installer once it has read it.
 */
export const NIBBLETS_APP_LINKS_FILE = ".config/infrawrench/nibblets-app-links.json";

/**
 * The ceiling a session's agent link starts with when the person creating it
 * doesn't change it: read-only across inventory, cost and alerting, nothing
 * that writes, runs or reveals a secret. Each nibblet is then given a subset
 * of this in Nibblets.
 */
export const DEFAULT_NIBBLETS_LINK_SCOPES: readonly string[] = [
  "accounts:read",
  "resources:read",
  "costs:read",
  "budgets:read",
  "dashboards:read",
  "metric-alerts:read",
  "incidents:read",
  "deployments:read",
];

export function isNibbletsSurface(surface: AgentSurface | string | null | undefined): boolean {
  return surface === "nibblets";
}

/** Setup plan for a Nibblets server: the installer owns everything. */
export function createNibbletsSetupPlan(linked: boolean): AgentSetupPlan {
  return {
    source: "git-url",
    workspaceName: NIBBLETS_DIR,
    runtimes: [],
    packageManagers: [],
    configSources: [],
    warnings: [
      "No repository checkout on this VM. Nibblets installs its own stack with Docker or Podman.",
      linked
        ? "The server starts linked to this organization. Give each nibblet its permissions in Nibblets."
        : "The server is not linked to this organization. Link it later from Nibblets' Settings → Linked apps.",
      "Signing in to an agent CLI and Nibblets Connect are interactive; finish them from the session's Authorize terminal.",
    ],
  };
}

/** The app-links file the installer adopts, as JSON. */
export function buildNibbletsAppLinksFile(input: {
  infrawrenchUrl: string;
  secret: string;
}): string {
  return `${JSON.stringify([
    {
      plugin: NIBBLETS_INFRAWRENCH_PLUGIN,
      // The Infrawrench app-link plugin's one setting (`url`, see
      // nibblets/packages/app-link-infrawrench), so a self-hosted
      // Infrawrench links back to itself rather than the hosted default.
      settings: { url: input.infrawrenchUrl.replace(/\/$/, "") },
      secret: input.secret,
    },
  ])}\n`;
}

/**
 * Writes stdin to the app-links file, 0600, in a 0700 directory. The content
 * (it carries the `iwl_` credential) goes on stdin, never in this command, so
 * it is not visible in the process list or anywhere a command is logged.
 */
export function buildNibbletsAppLinksWriteCommand(): string {
  const script = `
set -eu
umask 077
FILE="$HOME/${NIBBLETS_APP_LINKS_FILE}"
mkdir -p "$(dirname "$FILE")"
chmod 700 "$(dirname "$FILE")"
cat > "$FILE.tmp"
chmod 600 "$FILE.tmp"
mv -f "$FILE.tmp" "$FILE"
`;
  return `bash -c ${shellQuote(script)}`;
}

export interface NibbletsBootstrapCommandInput {
  /** Hand the installer the app-links file written beforehand. */
  withAppLinks: boolean;
  /** Override for tests and self-hosted mirrors. */
  installUrl?: string;
}

/**
 * Bootstrap for a Nibblets VM: download and run the installer
 * non-interactively. Its output goes to a log on the VM rather than to the
 * session log, because on a server that is not linked to Nibblets Connect it
 * ends by printing a sign-in (pair) link, and session logs are org-visible.
 * On failure only the tail is shown, pair links filtered out.
 *
 * The installer needs a Linux VM with a real kernel; where the memory cgroup
 * controller is off it turns it on for the next boot and asks for a restart,
 * which it never does itself in YES mode. That becomes a warning here, and
 * the Authorize terminal offers the restart.
 */
export function buildNibbletsBootstrapCommand(input: NibbletsBootstrapCommandInput): string {
  const installUrl = input.installUrl ?? NIBBLETS_INSTALL_URL;
  const linksEnv = input.withAppLinks
    ? `NIBBLETS_APP_LINKS_FILE="$HOME/${NIBBLETS_APP_LINKS_FILE}" `
    : "";
  const script = `
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
MARKER_DIR="$HOME/.infrawrench-agent"
LOGFILE="$MARKER_DIR/nibblets-install.log"

log_step() {
  printf '%s%s\\n' ${shellQuote(AGENT_SETUP_STEP_PREFIX)} "$1" >&2
}

mkdir -p "$MARKER_DIR"
${AGENT_SETUP_LOCK_SNIPPET}
if ! command -v curl >/dev/null 2>&1; then
  SUDO=""
  if [ "$(id -u)" != 0 ]; then SUDO="sudo -n"; fi
  log_step "Installing curl."
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq curl ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y -q curl
  fi
fi

log_step "Downloading the Nibblets installer."
INSTALLER="$MARKER_DIR/nibblets-install.sh"
curl -fsSL ${shellQuote(installUrl)} -o "$INSTALLER"

log_step "Running the Nibblets installer: Docker, Node, the repo and the stack. This takes several minutes."
if ! NO_COLOR=1 NIBBLETS_YES=1 NIBBLETS_CONNECT=0 ${linksEnv}bash "$INSTALLER" </dev/null >"$LOGFILE" 2>&1; then
  echo "The Nibblets installer failed. Last lines of $LOGFILE:" >&2
  tail -n 30 "$LOGFILE" | grep -v '#pair=' >&2 || true
  exit 1
fi
# The installer deletes the file once read; a failure before that point must
# not leave the credential behind.
rm -f "$HOME/${NIBBLETS_APP_LINKS_FILE}"

if [ ${input.withAppLinks ? "1" : "0"} = 1 ]; then
  if grep -q "Linked to" "$LOGFILE"; then
    log_step "Nibblets adopted the link to this organization."
  else
    log_step "Nibblets did not take the link to this organization. Link it from Nibblets' Settings."
  fi
fi
if grep -q "Restart this machine" "$LOGFILE"; then
  echo "warning: nibblets needs a restart to turn on the memory controller; restart the VM before your first nibblet" >&2
fi

log_step "Bootstrap complete."
`;
  return `timeout 1100s bash -lc ${shellQuote(script)}`;
}

/**
 * The interactive half, run in the session's Authorize terminal: the
 * installer's own sign-in menu (Claude Code, Codex and the rest) and the
 * optional Nibblets Connect link, without restarting the stack. Then how to
 * reach the UI without Connect, and a restart offer if the installer asked
 * for one. Ends in a login shell so the tab stays useful.
 */
export function buildNibbletsSignInCommand(): string {
  const script = `
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
INSTALLER="$HOME/${NIBBLETS_DIR}/install.sh"
if [ ! -f "$INSTALLER" ]; then
  echo "Nibblets is not installed yet. Wait for VM setup to finish, then reopen this terminal." >&2
  exec "\${SHELL:-/bin/bash}" -l
fi
bash "$INSTALLER" --sign-in || echo "Sign-in did not finish. Rerun it with: bash ~/${NIBBLETS_DIR}/install.sh --sign-in" >&2

printf '\\n\\033[1mUsing it\\033[0m\\n'
printf 'Linked to Nibblets Connect? Open ${NIBBLETS_CONNECT_URL} from any device.\\n'
printf 'Otherwise forward the port from your computer:\\n'
printf '  ssh -L ${NIBBLETS_PORT}:127.0.0.1:${NIBBLETS_PORT} %s@<this VM>\\n' "$(id -un)"
printf 'then open the sign-in link this prints:\\n'
ENGINE=docker
if ! command -v docker >/dev/null 2>&1; then ENGINE=podman; fi
printf '  %s exec nibblet-server-1 node apps/server/src/cli.ts pair\\n' "$ENGINE"

if [ -f /sys/fs/cgroup/cgroup.controllers ] && ! grep -qw memory /sys/fs/cgroup/cgroup.controllers; then
  printf '\\n\\033[1mThis VM needs a restart\\033[0m so the memory controller turns on.\\n'
  printf 'Nibblets starts again by itself afterwards. Restart now? [y/N] '
  read -r answer || answer=""
  case "$answer" in
    y | Y) if [ "$(id -u)" = 0 ]; then reboot; else sudo reboot; fi ;;
  esac
fi
exec "\${SHELL:-/bin/bash}" -l
`;
  return `bash -lc ${shellQuote(script)}`;
}
