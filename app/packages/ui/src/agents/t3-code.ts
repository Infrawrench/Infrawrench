/**
 * T3 Code (https://github.com/pingdotgg/t3code) agent sessions.
 *
 * T3 Code is **not an agent**. It is a control surface — a web/desktop GUI and
 * server that drives *provider CLIs* (Codex, Claude Code, Cursor, Grok Build,
 * OpenCode) running on the same machine. It ships none of them, so a T3 Code
 * VM still needs `codex` or `claude` installed and signed in next to it.
 *
 * That is why `surface: "t3-code"` is orthogonal to `tool`: the session still
 * picks a coding agent, and T3 Code becomes how you talk to it. What changes
 * versus a terminal session is the shape of the VM and of the tab:
 *
 *   1. the VM is provisioned as usual,
 *   2. the bootstrap installs Node, git, the GitHub CLI, the session's
 *      provider CLI *and* the `t3` CLI, then registers T3 Code's systemd
 *      service so the server survives logout,
 *   3. the server is authorized *interactively* — `t3 connect link` and the
 *      provider sign-in are browser flows that cannot be scripted, so the
 *      user runs them once in a terminal,
 *   4. the session is then reachable through T3's relay from the hosted app,
 *      which is what the session's main tab embeds.
 *
 * Deliberately **no repository setup**: T3 Code manages its own projects
 * (Command Palette → Add Project), so Infrawrench neither clones a repo nor
 * checks out a branch for these sessions. The bootstrap only creates an empty
 * projects directory for T3 Code to clone into.
 *
 * This module is free of React/DOM/Node dependencies — it is imported by the
 * web API server as well as both renderers.
 */
import {
  AGENT_CLI_INSTALL_SNIPPET,
  AGENT_MISE_SNIPPET,
  AGENT_NPM_PREFIX_SNIPPET,
  AGENT_SETUP_LOCK_SNIPPET,
  AGENT_SETUP_STEP_PREFIX,
  AGENT_SYSTEM_PACKAGES_SNIPPET,
  agentToolAuthStatusCommand,
  agentToolCommand,
  agentToolLabel,
  agentToolLoginCommand,
  agentToolPackage,
} from "./launch-command.js";
import type { AgentSetupPlan, AgentSurface, AgentTool } from "./types.js";

/** The hosted T3 Code app that a `t3 connect`-linked environment shows up in. */
export const T3_CODE_HOSTED_APP_URL = "https://app.t3.codes";

/**
 * Directory the bootstrap creates for T3 Code's projects. T3 Code clones into
 * a destination the user picks, so this is only a sensible default location —
 * it is never a checkout of a session repo.
 */
export const T3_CODE_PROJECTS_DIR = "projects";

/**
 * Node range T3 Code's server package declares in `engines.node`. The
 * bootstrap installs `node@24` (the newest line satisfying it) and then
 * verifies, because a version manager resolving to something older produces a
 * confusing runtime failure much later.
 */
export const T3_CODE_NODE_VERSION = "24";
export const T3_CODE_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

/**
 * systemd *user* unit T3 Code's `service install` writes (to
 * `~/.config/systemd/user/`, with `loginctl enable-linger` so it survives
 * logout). Restarting it is the only way to make a running server reconcile a
 * newly recorded `t3 connect link` — the `t3 service` subcommands all
 * short-circuit when the service is already installed and current.
 */
export const T3_CODE_SYSTEMD_UNIT = "t3code.service";

export function isT3CodeSurface(surface: AgentSurface | string | null | undefined): boolean {
  return surface === "t3-code";
}

/** Normalizes the column/field default for rows written before T3 Code existed. */
export function agentSurfaceOrDefault(surface: string | null | undefined): AgentSurface {
  return surface === "t3-code" ? "t3-code" : "terminal";
}

/**
 * T3 Code sessions have no repo, so the create form doesn't ask for one and
 * the API doesn't require one.
 */
export function agentSurfaceRequiresRepo(
  surface: AgentSurface | string | null | undefined,
): boolean {
  return !isT3CodeSurface(surface);
}

/** Setup plan for a T3 Code session — Node only, no clone, no branch. */
export function createT3CodeSetupPlan(tool: AgentTool): AgentSetupPlan {
  return {
    source: "git-url",
    workspaceName: T3_CODE_PROJECTS_DIR,
    runtimes: [
      {
        language: "node",
        version: T3_CODE_NODE_VERSION,
        versionSource: "project",
        source: `T3 Code server engines.node (${T3_CODE_NODE_ENGINE_RANGE})`,
        reasons: [
          "The T3 Code server runs on Node",
          `${agentToolLabel(tool)}'s CLI, which T3 Code drives, runs on Node`,
        ],
      },
    ],
    packageManagers: [],
    configSources: [],
    warnings: [
      "T3 Code manages its own projects, so this VM is provisioned without a repository checkout — add projects from inside T3 Code.",
      `T3 Connect authorization and the ${agentToolLabel(tool)} sign-in are interactive browser flows; finish them from the session's Authorize terminal.`,
    ],
  };
}

export interface T3CodeBootstrapCommandInput {
  /** Provider CLI T3 Code will drive on this VM. T3 Code ships none itself. */
  tool: AgentTool;
  /** Directory created under `$HOME` for T3 Code to clone projects into. */
  projectsDir?: string;
  /**
   * Install T3 Code's systemd service so the server starts on boot and
   * survives logout. Silently skipped on VMs without systemd.
   */
  installService?: boolean;
  /** Install the GitHub CLI so T3 Code's source-control features work. */
  installGithubCli?: boolean;
}

/**
 * Bootstrap command for a T3 Code VM. Shares the system-package, mise,
 * npm-prefix and CLI-launcher-repair snippets with the terminal-surface
 * bootstrap, then layers on the pieces only T3 Code needs.
 *
 * Everything here is idempotent and non-interactive; the parts that *can't*
 * be (OAuth) live in `buildT3CodeConnectCommand`.
 */
export function buildT3CodeBootstrapCommand(input: T3CodeBootstrapCommandInput): string {
  const projectsDir = input.projectsDir?.trim() || T3_CODE_PROJECTS_DIR;
  const installService = input.installService ?? true;
  const installGithubCli = input.installGithubCli ?? true;
  const toolCommand = agentToolCommand(input.tool);
  const toolPackage = agentToolPackage(input.tool);
  // The other supported CLI. T3 Code uses it for its own auxiliary work even
  // in a thread belonging to the session's tool — see the install below.
  const companionTool: AgentTool = input.tool === "claude-code" ? "codex" : "claude-code";
  const companionCommand = agentToolCommand(companionTool);
  const companionPackage = agentToolPackage(companionTool);
  const script = `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:$PATH"
export MISE_YES=1

PROJECTS_DIR="$HOME/${shellDoubleQuoteContent(projectsDir)}"
MARKER_DIR="$HOME/.infrawrench-agent"
MARKER="$MARKER_DIR/setup-t3-${shellDoubleQuoteContent(toolCommand)}-pair"

log_step() {
  printf '%s%s\\n' ${shellQuote(AGENT_SETUP_STEP_PREFIX)} "$1" >&2
}

mkdir -p "$MARKER_DIR" "$PROJECTS_DIR"
${AGENT_SETUP_LOCK_SNIPPET}
if command -v t3 >/dev/null 2>&1 && command -v ${shellQuote(toolCommand)} >/dev/null 2>&1 && command -v ${shellQuote(companionCommand)} >/dev/null 2>&1 && [ -f "$MARKER" ]; then
  log_step "Bootstrap already complete."
  exit 0
fi

# System packages install in the BACKGROUND: mise, Node (a prebuilt tarball)
# and the npm CLIs only need curl/tar/gzip, which every cloud image ships.
# Anything wanting git or a compiler waits for the join below.
${AGENT_SYSTEM_PACKAGES_SNIPPET}
${AGENT_MISE_SNIPPET}

install_runtime node ${shellQuote(T3_CODE_NODE_VERSION)}

eval "$(mise activate bash)" || true
hash -r

# T3 Code's server package pins engines.node; a version manager quietly
# resolving to an older line fails much later with a confusing error, so
# check it here where the message can name the requirement.
require_t3_node_version() {
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if [ -z "$node_version" ]; then
    echo "Node did not install into PATH; T3 Code requires ${T3_CODE_NODE_ENGINE_RANGE}" >&2
    exit 1
  fi
  node_major="$(printf '%s' "$node_version" | cut -d. -f1)"
  node_minor="$(printf '%s' "$node_version" | cut -d. -f2)"
  node_ok=0
  if [ "$node_major" -gt 24 ]; then node_ok=1; fi
  if [ "$node_major" -eq 24 ] && [ "$node_minor" -ge 10 ]; then node_ok=1; fi
  if [ "$node_major" -eq 23 ] && [ "$node_minor" -ge 11 ]; then node_ok=1; fi
  if [ "$node_major" -eq 22 ] && [ "$node_minor" -ge 16 ]; then node_ok=1; fi
  if [ "$node_ok" != "1" ]; then
    echo "Node $node_version does not satisfy the T3 Code requirement ${T3_CODE_NODE_ENGINE_RANGE}" >&2
    exit 1
  fi
  log_step "Using Node $node_version."
}
require_t3_node_version

${AGENT_NPM_PREFIX_SNIPPET}
${AGENT_CLI_INSTALL_SNIPPET}

# The npm installs below MUST NOT start before this join. Unlike the pure-JS
# agent CLIs, \`t3\` depends on node-pty — a native addon npm compiles with
# node-gyp, which needs make/g++/python3 from the system packages. Running it
# early fails with "gyp ERR! stack Error: not found: make", npm leaves a
# launcher pointing at an unbuilt package, and the whole bootstrap aborts.
# git (for the source-control features) comes from the same install.
wait_for_system_packages

# node-pty publishes prebuilds for darwin-{arm64,x64} and win32-{x64,arm64}
# only — there is NO Linux prebuild — so \`node scripts/prebuild.js\` always
# falls through to \`node-gyp rebuild\` here and the addon is compiled on every
# agent VM. Both it and msgpackr-extract must therefore be allow-listed:
# without their install scripts t3 installs "successfully" and then dies the
# first time it opens a terminal.
install_cli_command t3 t3 'T3 Code' node-pty,msgpackr-extract
# T3 Code drives provider CLIs rather than shipping them, so BOTH supported
# CLIs are installed — not just the session's tool.
#
# T3 Code reaches for a provider other than the one you are chatting with for
# its own auxiliary work: generating a thread title runs \`codex exec\` even in
# a Claude Code thread. With only the session's CLI present that fails
# \`spawn codex ENOENT\`, and the failure surfaces as an opaque runtime error
# rather than "the CLI is missing". Installing the pair is a few seconds of
# npm and removes a whole class of confusing breakage.
#
# The session's tool is installed FIRST so it wins any ordering, and it is the
# one the connect script signs in. The other providers T3 Code supports
# (cursor-agent, grok, opencode) can be added from the session terminal.
install_cli_command ${shellQuote(toolCommand)} ${shellQuote(toolPackage)} ${shellQuote(agentToolLabel(input.tool))}
install_cli_command ${shellQuote(companionCommand)} ${shellQuote(companionPackage)} ${shellQuote(agentToolLabel(companionTool))}
${installGithubCli ? GITHUB_CLI_SNIPPET : ""}${XDG_OPEN_SHIM_SNIPPET}
${installService ? T3_SERVICE_SNIPPET : ""}

log_step "Bootstrap complete."
touch "$MARKER"
`;
  return `timeout 600s bash -lc ${shellQuote(script)}`;
}

/**
 * Installs the GitHub CLI from its release tarball rather than a distro
 * package: `gh` is missing or stale in most cloud images' default repos, and
 * adding GitHub's apt keyring is more moving parts than one binary drop.
 * Best effort — a VM without `gh` still runs T3 Code, it just can't open pull
 * requests, so a failure here warns instead of failing the whole setup.
 */
const GITHUB_CLI_SNIPPET = `
install_github_cli() {
  if command -v gh >/dev/null 2>&1; then return 0; fi
  gh_arch=""
  case "$(uname -m)" in
    x86_64|amd64) gh_arch="amd64" ;;
    aarch64|arm64) gh_arch="arm64" ;;
    *) echo "warning: no GitHub CLI build for $(uname -m); skipping" >&2; return 0 ;;
  esac
  # Resolve the version from the /releases/latest redirect — the GitHub API
  # would work too, but it rate-limits unauthenticated callers.
  gh_latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest 2>/dev/null || true)"
  case "$gh_latest_url" in
    */tag/v*) gh_version="\${gh_latest_url##*/tag/v}" ;;
    *) echo "warning: could not resolve the latest GitHub CLI release; skipping" >&2; return 0 ;;
  esac
  log_step "Installing GitHub CLI $gh_version."
  gh_tmp="$(mktemp -d)"
  if curl -fsSL --retry 3 --retry-delay 2 "https://github.com/cli/cli/releases/download/v\${gh_version}/gh_\${gh_version}_linux_\${gh_arch}.tar.gz" -o "$gh_tmp/gh.tar.gz" && tar -xzf "$gh_tmp/gh.tar.gz" -C "$gh_tmp"; then
    gh_bin="$(find "$gh_tmp" -type f -name gh -perm -100 2>/dev/null | head -n 1)"
    if [ -n "$gh_bin" ]; then
      mkdir -p "$HOME/.local/bin"
      cp "$gh_bin" "$HOME/.local/bin/gh" && chmod +x "$HOME/.local/bin/gh"
    else
      echo "warning: GitHub CLI archive had no gh binary; skipping" >&2
    fi
  else
    echo "warning: GitHub CLI download failed; skipping" >&2
  fi
  rm -rf "$gh_tmp"
}
install_github_cli
`;

/**
 * Neutralizes T3 Code's "open in browser" on a headless VM.
 *
 * T3 Code's external launcher runs the *server's* browser opener, which on
 * Linux is hard-coded to `xdg-open` — there is no env var or config to turn
 * it off (checked against upstream: `buildBrowserLaunch` in
 * `apps/server/src/process/externalLauncher.ts`, which does not honour
 * `BROWSER` either). On a VM you are driving from your laptop that is never
 * what you want: at best it does nothing, and on a bare cloud image
 * `xdg-open` isn't installed at all, so T3 Code reports a command-not-found
 * error instead.
 *
 * The launcher spawns it detached with stdin/stdout/stderr ignored and only
 * checks that the command exists, so a no-op shim earlier on PATH turns the
 * whole thing into a clean nothing. Doing it here rather than in a patched
 * fork means it survives every `t3` self-update — the service installs exact
 * versions from npm and would overwrite a forked build.
 *
 * Never overwrites a real `xdg-open` that is already on PATH.
 */
const XDG_OPEN_SHIM_SNIPPET = `
install_xdg_open_noop() {
  if command -v xdg-open >/dev/null 2>&1; then
    return 0
  fi
  log_step "Disabling server-side open-in-browser."
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/xdg-open" <<'INFRAWRENCH_XDG_OPEN'
#!/bin/sh
# Installed by Infrawrench for T3 Code agent VMs.
#
# T3 Code's "open in browser" runs on the machine hosting the server. This is
# a headless VM, so there is nothing to open — without this shim the launcher
# fails with a command-not-found error the user cannot act on. Exit 0 so it
# reads as "handled", and log for anyone debugging a link that went nowhere.
[ -n "\${1:-}" ] && logger -t infrawrench-xdg-open "suppressed open request: $1" 2>/dev/null
exit 0
INFRAWRENCH_XDG_OPEN
  chmod +x "$HOME/.local/bin/xdg-open"
}
install_xdg_open_noop
`;

/**
 * Nice value the T3 Code *server* process runs at: -20, the highest priority
 * Linux offers. Paired with `CPUSchedulingResetOnFork=` (see
 * `T3_SERVICE_DROPIN_SNIPPET`) so it is the server that gets it and not the
 * provider CLIs it spawns.
 */
export const T3_CODE_SERVICE_NICE = -20;

/**
 * Gives the T3 Code *service* the environment it needs: PATH, and IS_SANDBOX.
 *
 * The unit T3 Code generates sets no \`Environment=PATH=\` (see
 * \`renderBootServiceUnit\` upstream — its own comment says service units
 * cannot rely on the user's shell or PATH), so the server inherits systemd's
 * minimal default: \`/usr/local/bin:/usr/bin:/bin\` and the sbin equivalents.
 * Everything this bootstrap installs lands in \`~/.local/bin\` and the mise
 * shims, so the *server process* cannot see any of it, even though an
 * interactive SSH shell can. That asymmetry is why the setup terminal reports
 * \`gh\` and \`claude\` as signed in while the server behaves as if they do not
 * exist: source-control provider detection finds no \`gh\`, git's
 * \`gh auth git-credential\` helper is not found mid-clone, and the provider
 * CLI is missing when a session starts.
 *
 * \`IS_SANDBOX=1\` is the second half. T3 Code drives Claude Code through
 * \`@anthropic-ai/claude-agent-sdk\`, and its "Full access" mode is the SDK's
 * \`bypassPermissions\` — the same thing \`--dangerously-skip-permissions\` asks
 * for. Claude Code **refuses that as root** unless it believes it is in a
 * sandbox, and this service runs as root on a dedicated throwaway VM. Without
 * it the provider process dies at turn start and T3 surfaces the useless
 * \`turn/setPermissionMode failed\` / "Claude runtime stream failed". The
 * terminal surface already sets this in its launch command (see
 * \`buildAgentLaunchCommand\`); the service needs it for exactly the same
 * reason, and had been missing it.
 *
 * Written as a drop-in rather than by editing the unit: \`t3 service
 * install/update\` rewrites \`t3code.service\` wholesale, which would discard
 * an inline edit, but leaves \`t3code.service.d/\` alone. systemd expands
 * \`%h\` in \`Environment=\`, so the file needs no absolute home path.
 *
 * A second drop-in gives the **server process** the highest CPU priority the
 * scheduler has (\`Nice=-20\`) while leaving its children at the default. That
 * split is the whole point: everything expensive on a T3 Code VM — the
 * provider CLI, its builds, its test runs — is a child of this service, and a
 * plain \`Nice=\` would be inherited by all of them, which is the same as
 * giving nobody priority. Under that load the server itself is what starves,
 * and the server is the part that has to stay responsive: it holds the relay
 * connection and streams the session, so when it loses the CPU the hosted app
 * goes quiet and the environment looks disconnected while the box is merely
 * busy. \`CPUSchedulingResetOnFork=yes\` sets \`SCHED_RESET_ON_FORK\`, which the
 * kernel honours by resetting a negative nice value to 0 in anything the
 * process forks — the priority stops at the server. \`CPUSchedulingPolicy=\`
 * is set alongside it because systemd only issues the \`sched_setscheduler\`
 * call that carries the flag when a policy is configured.
 *
 * A negative nice value needs \`CAP_SYS_NICE\` (the default \`RLIMIT_NICE\`
 * gives an unprivileged user no headroom below 0), so the drop-in is written
 * only when the unit's own user is root — which it is on Infrawrench agent
 * VMs, and which is also why \`IS_SANDBOX=1\` above is needed. Elsewhere it is
 * removed rather than left in place: current systemd clamps an unappliable
 * \`Nice=\` to the closest allowed value, but older versions fail the unit
 * outright, and either way an unprivileged manager cannot hand the server a
 * priority its children do not already have.
 *
 * Verified against systemd 255: with these three lines the main process
 * reports \`SCHED_OTHER|SCHED_RESET_ON_FORK\` and a process it forks reports
 * plain \`SCHED_OTHER\` (\`chrt -p\`), which is the flag being cleared — the
 * same clearing that resets a negative nice to 0.
 */
const T3_SERVICE_DROPIN_SNIPPET = `
install_t3_service_dropins() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  dropin_dir="$HOME/.config/systemd/user/${T3_CODE_SYSTEMD_UNIT}.d"
  mkdir -p "$dropin_dir"
  cat > "$dropin_dir/10-infrawrench-path.conf" <<'INFRAWRENCH_UNIT_PATH'
# Installed by Infrawrench.
#
# T3 Code's generated unit sets no PATH, so the server would inherit systemd's
# minimal default and miss every CLI installed under ~/.local/bin and the mise
# shims — gh (source control + git credential helper), claude/codex, and node.
# Kept in a drop-in so "t3 service update" rewriting the unit cannot drop it.
[Service]
Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Claude Code refuses bypassPermissions (T3 Code's "Full access") as root
# unless it believes it is sandboxed. This is a dedicated throwaway VM.
Environment=IS_SANDBOX=1
INFRAWRENCH_UNIT_PATH
  # A negative nice needs CAP_SYS_NICE, which a user manager only has when the
  # user is root. Elsewhere the boost is unappliable (and fails the unit on
  # older systemd), so the VM keeps the default priority instead.
  if [ "$(id -u)" = "0" ]; then
    cat > "$dropin_dir/20-infrawrench-priority.conf" <<'INFRAWRENCH_UNIT_PRIORITY'
# Installed by Infrawrench.
#
# The T3 Code server holds the relay connection and streams the session, so it
# has to stay responsive while the provider CLI it drives (and that CLI's
# builds and test runs) saturates the VM. Those are all CHILDREN of this
# service, and nice values are inherited, so Nice= on its own would hand them
# the same priority and change nothing. SCHED_RESET_ON_FORK makes the kernel
# reset a negative nice back to 0 in every forked child, so the boost applies
# to the server alone. CPUSchedulingPolicy= is what makes systemd issue the
# sched_setscheduler call that carries the flag.
[Service]
Nice=${T3_CODE_SERVICE_NICE}
CPUSchedulingPolicy=other
CPUSchedulingResetOnFork=yes
INFRAWRENCH_UNIT_PRIORITY
  else
    rm -f "$dropin_dir/20-infrawrench-priority.conf"
  fi
  systemctl --user daemon-reload 2>/dev/null || true
}
`;

/**
 * Installs T3 Code's background service so the server starts on boot and
 * outlives the SSH session that set it up. systemd-only by T3 Code's own
 * design, and independent of T3 Connect's lifecycle — signing out of Connect
 * leaves the service running.
 */
const T3_SERVICE_SNIPPET = `${T3_SERVICE_DROPIN_SNIPPET}
install_t3_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "warning: this VM has no systemd, so T3 Code will not start automatically; run 't3 serve' over SSH instead" >&2
    return 0
  fi
  log_step "Installing the T3 Code background service."
  t3 service install >&2 || echo "warning: 't3 service install' failed; run it manually over SSH" >&2
  # After the unit exists, so the drop-ins land beside a real unit file.
  install_t3_service_dropins
}
install_t3_service
`;

/**
 * Make git agree with whatever protocol `gh` is configured for.
 *
 * T3 Code picks the clone URL itself: `selectRemoteUrl` hands git the repo's
 * `sshUrl` whenever the clone protocol is SSH, which is `gh`'s own default for
 * many users. A fresh VM has no key registered with GitHub, so that clone dies
 * `Permission denied (publickey)` — and T3 reports it as an unhelpful
 * "The source control operation could not be completed", because it keeps only
 * the *length* of git's stderr, never the text.
 *
 * Rather than ask the user to change a setting inside T3 Code, or push an SSH
 * key to their GitHub account, this reads the protocol `gh` already recorded
 * and makes git honour it. On HTTPS it rewrites SSH-style GitHub URLs back to
 * HTTPS, so a caller that insists on `git@github.com:` still authenticates
 * through the `gh` credential helper.
 *
 * Note the mirror image of `sanitizeGitConfigForAgentVm`, which *strips*
 * `https → ssh` rewrites synced from the user's laptop. Same reasoning from
 * both ends: on an agent VM, HTTPS plus `gh` works and SSH does not.
 *
 * Rewrites are cleared before being re-added so repeated runs converge instead
 * of stacking duplicates.
 */
const GH_PROTOCOL_ALIGN_SNIPPET = `
align_git_protocol_with_gh() {
  command -v gh >/dev/null 2>&1 || return 0
  gh auth status >/dev/null 2>&1 || return 0
  # Wires credential.helper for HTTPS; harmless when already set.
  gh auth setup-git >/dev/null 2>&1 || true
  gh_protocol="$(gh config get git_protocol 2>/dev/null || echo https)"
  git config --global --unset-all url."https://github.com/".insteadOf 2>/dev/null || true
  if [ "$gh_protocol" = "ssh" ]; then
    printf 'gh is set to use SSH for github.com. This VM has no key registered with\\n'
    printf 'GitHub, so SSH clones will fail. Either switch gh to HTTPS:\\n'
    printf '  gh config set git_protocol https\\n'
    printf 'or register a key for this machine:\\n'
    printf '  ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 && gh ssh-key add ~/.ssh/id_ed25519.pub\\n'
    return 0
  fi
  git config --global --add url."https://github.com/".insteadOf "git@github.com:"
  git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
  printf 'Git will use HTTPS for github.com, matching gh. SSH-style clone URLs are\\n'
  printf 'rewritten, so tools that hand git git@github.com: still authenticate.\\n'
}
`;

export interface T3CodeConnectCommandInput {
  /** Provider CLI to offer a sign-in step for. */
  tool: AgentTool;
  /** Also offer to sign the GitHub CLI in (device flow — works headless). */
  includeGithubLogin?: boolean;
}

/**
 * The interactive half of setup, run in the session's SSH terminal tab.
 *
 * `t3 connect link` opens a Clerk OAuth flow. Over SSH the CLI detects
 * `SSH_TTY`/`SSH_CONNECTION` and automatically switches to its out-of-band
 * flow: it prints a hosted authorization URL and waits for a pasted code, so
 * no port forwarding is needed. The provider sign-in and `gh auth login` are
 * likewise browser/device flows. None of this can be scripted, which is
 * exactly why it lives here and not in the bootstrap.
 *
 * Ends by `exec`ing a login shell so the tab stays a usable terminal.
 */
export function buildT3CodeConnectCommand(input: T3CodeConnectCommandInput): string {
  const includeGithubLogin = input.includeGithubLogin ?? true;
  const toolLabel = agentToolLabel(input.tool);
  const steps = includeGithubLogin ? 4 : 3;
  let step = 0;
  const heading = (title: string) => {
    step += 1;
    return `printf '\\n\\033[1m== Step ${step}/${steps} — ${title} ==\\033[0m\\n'`;
  };
  const script = `
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:$PATH"
if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash)" || true
fi
hash -r

if ! command -v t3 >/dev/null 2>&1; then
  echo "The t3 CLI is not installed yet — wait for VM setup to finish, then reopen this terminal." >&2
  exec "\${SHELL:-/bin/bash}" -l
fi

printf '\\033[1mT3 Code setup\\033[0m\\n'
printf 'Each step opens a browser or device flow. Skip any step with Ctrl-C and rerun it later.\\n'

${heading("Authorize T3 Connect")}
# Over SSH the CLI prints a hosted authorization URL and waits for a pasted
# code, so this works without forwarding port 34338.
t3 connect link || echo "t3 connect link did not complete — rerun it with 't3 connect link'." >&2

${heading(`Sign in to ${toolLabel}`)}
# T3 Code drives this CLI; without a signed-in provider it can install
# projects but not start a session.
if ${agentToolAuthStatusCommand(input.tool)} >/dev/null 2>&1; then
  printf '${toolLabel} is already signed in.\\n'
else
  ${agentToolLoginCommand(input.tool)} || echo "Sign-in did not complete — rerun it with '${agentToolLoginCommand(input.tool)}'." >&2
fi
${
  includeGithubLogin
    ? `
${heading("Sign in to the GitHub CLI")}
if ! command -v gh >/dev/null 2>&1; then
  printf 'The GitHub CLI is not installed; skipping. T3 Code still works, without pull-request actions.\\n'
elif gh auth status >/dev/null 2>&1; then
  printf 'The GitHub CLI is already signed in.\\n'
else
  gh auth login || echo "gh auth login did not complete — rerun it with 'gh auth login'." >&2
fi
${GH_PROTOCOL_ALIGN_SNIPPET}
align_git_protocol_with_gh
`
    : ""
}
${heading("Start T3 Code")}
# \`t3 connect link\` only records intent; the relay link is provisioned by the
# next server START. The bootstrap already installed the service, so the
# server is running from BEFORE the link existed and has nothing to reconcile
# — it has to be restarted.
#
# It must be a real restart. \`t3 service install\`/\`update\` both short-circuit
# on "already installed and current" and return without touching the unit, so
# neither can do this. The unit is a systemd *user* unit (the installer also
# sets \`loginctl enable-linger\`), hence --user and XDG_RUNTIME_DIR.
${T3_SERVICE_DROPIN_SNIPPET}
restart_t3_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'No systemd on this VM. Start the server yourself with: t3 serve\\n'
    return 0
  fi
  # Covers a VM whose bootstrap skipped the service install.
  t3 service install >/dev/null 2>&1 || true
  # Also repairs VMs bootstrapped before the drop-ins existed — without them
  # the server cannot see gh/claude/codex (source control silently fails) and
  # runs at the same CPU priority as the agent processes it hosts. The restart
  # below is what puts either into effect.
  install_t3_service_dropins
  : "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
  export XDG_RUNTIME_DIR
  if systemctl --user restart ${T3_CODE_SYSTEMD_UNIT} 2>/dev/null; then
    printf 'Restarted the T3 Code service.\\n'
    return 0
  fi
  if systemctl restart ${T3_CODE_SYSTEMD_UNIT} 2>/dev/null; then
    printf 'Restarted the T3 Code service.\\n'
    return 0
  fi
  printf 'Could not restart the T3 Code service automatically.\\n'
  printf 'Run this yourself, then rerun this step:\\n'
  printf '  systemctl --user restart ${T3_CODE_SYSTEMD_UNIT}\\n'
  return 0
}
restart_t3_service

# Provisioning the link and bringing up the managed tunnel takes a few
# seconds, so confirm it here rather than sending the user to go and look.
printf '\\nWaiting for the environment link to provision'
link_deadline=$((SECONDS + 150))
link_ready=0
while [ "$SECONDS" -lt "$link_deadline" ]; do
  if t3 connect status --json 2>/dev/null | grep -q '"linked"[[:space:]]*:[[:space:]]*true'; then
    link_ready=1
    break
  fi
  printf '.'
  sleep 5
done
printf '\\n\\n'
t3 connect status || true
if [ "$link_ready" = "1" ]; then
  printf '\\n\\033[1mReady.\\033[0m Switch back to the T3 Code tab.\\n\\n'
else
  printf '\\nThe environment link is still pending. If it stays that way, read the\\n'
  printf 'server log — the unit redirects stdout/stderr to a file, so journalctl\\n'
  printf 'only shows systemd start/stop lines, not the server error:\\n'
  printf '  t3 service status                                 # shows the log path\\n'
  printf '  tail -n 200 ~/.t3/userdata/logs/boot-service.log\\n\\n'
fi
exec "\${SHELL:-/bin/bash}" -l
`;
  return `bash -lc ${shellQuote(script)}`;
}

/**
 * Revoke this VM's T3 Connect environment link, before the VM is destroyed.
 *
 * `t3 connect logout` records disabled intent, stops the running connector,
 * revokes the relay-side environment record, and drops the stored CLI
 * credential. It has to run **while the VM still exists**: once the machine is
 * gone the relay keeps an environment nobody can remove — there is no
 * server-side delete for an environment whose host has vanished (upstream
 * pingdotgg/t3code#5135).
 *
 * Best effort by construction. A VM that is already destroyed, powered off, or
 * unreachable must not be able to block its own deletion, so every failure
 * path here exits 0 and the caller ignores the result.
 */
export function buildT3CodeLogoutCommand(): string {
  const script = `
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:$PATH"
if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash)" || true
fi
command -v t3 >/dev/null 2>&1 || exit 0
t3 connect logout || true
exit 0
`;
  return `timeout 90s bash -lc ${shellQuote(script)}`;
}

/** Shape of `t3 connect status --json` (CloudCliStatus in the t3code repo). */
export interface T3CodeConnectStatus {
  /** Exposure is enabled (durable intent recorded by `t3 connect link`). */
  desired: boolean;
  /** A CLI OAuth credential is stored. */
  authenticated: boolean;
  /** The relay-side environment link is provisioned. */
  linked: boolean;
  cloudUserId: string | null;
  /** Relay deployment base URL — not a per-environment address. */
  relayUrl: string | null;
  publishAgentActivity: boolean;
}

/** Command whose stdout `parseT3CodeConnectStatus` reads. */
export function buildT3CodeStatusCommand(): string {
  const script = `
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:$PATH"
if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash)" || true
fi
command -v t3 >/dev/null 2>&1 || exit 3
t3 connect status --json
`;
  return `timeout 60s bash -lc ${shellQuote(script)}`;
}

/**
 * Parse `t3 connect status --json`. The CLI prints the JSON object on stdout
 * but may prefix it with log lines, so the object is located rather than
 * assumed to start at byte 0. Returns null when nothing parseable is found.
 */
export function parseT3CodeConnectStatus(stdout: string): T3CodeConnectStatus | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw["linked"] !== "boolean") return null;
  return {
    desired: raw["desired"] === true,
    authenticated: raw["authenticated"] === true,
    linked: raw["linked"] === true,
    cloudUserId: typeof raw["cloudUserId"] === "string" ? raw["cloudUserId"] : null,
    relayUrl: typeof raw["relayUrl"] === "string" ? raw["relayUrl"] : null,
    publishAgentActivity: raw["publishAgentActivity"] === true,
  };
}

/** One-line summary of what the user still has to do, or null when ready. */
export function t3CodeConnectNextStep(status: T3CodeConnectStatus | null): string | null {
  if (!status) return "Run the Authorize step to link this server to T3 Connect.";
  if (!status.authenticated) return "Authorize T3 Connect on this server (t3 connect link).";
  if (!status.desired) return "Enable exposure for this server (t3 connect link).";
  if (!status.linked) return "Start T3 Code on the server so it provisions its environment link.";
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellDoubleQuoteContent(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1").replace(/\n/g, "\\n");
}
