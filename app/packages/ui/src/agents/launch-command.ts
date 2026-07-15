/**
 * Canonical agent-VM shell command builders shared by the desktop and web
 * apps. Both the SSH launch command (which polls until setup is done and then
 * attaches a `detachproc` session running the coding tool) and the bootstrap
 * command (which installs runtimes/tools and prepares the workspace) live
 * here so the setup markers written on the VM always match what the launch
 * command polls for.
 *
 * This module is intentionally free of React/DOM/Node dependencies — it is
 * imported by the web API server as well as the desktop renderer.
 */
import type { AgentRuntimePlan, AgentSetupPlan, AgentTool } from "./types.js";

/** Prefix bootstrap scripts print before each human-readable setup step. */
export const AGENT_SETUP_STEP_PREFIX = "INFRAWRENCH_AGENT_STEP:";

/**
 * Prefix of the session log line written when a setup run fails. The desktop
 * and web setup pipelines both write it, and the agents panel reads it to
 * offer a manual "Retry setup".
 */
export const AGENT_SETUP_FAILED_LOG_PREFIX = "Setup failed:";

export interface AgentLaunchCommandInput {
  /** Agent session id; its first 8 chars name the remote detachproc session. */
  sessionId: string;
  tool: AgentTool;
  /** Workspace directory name under the remote `$HOME`. */
  workspaceName: string;
  /**
   * When set, the launch script also waits for
   * `$HOME/.infrawrench-agent/launch-ready/<token>` before attaching. An
   * empty/absent token skips the marker wait — used when setup has already
   * completed and re-syncing would be redundant (or destructive).
   */
  launchReadyToken?: string;
}

export interface AgentBootstrapCommandInput {
  tool: AgentTool;
  /** Workspace directory name under the remote `$HOME`. */
  workspaceName: string;
  /** Branch the agent works on inside the remote workspace. */
  branchName: string;
  /** Session repo — a clone URL or a local folder path. */
  repo: string;
  setupPlan: AgentSetupPlan;
}

export function isCloneableGitRepo(repo: string): boolean {
  const value = repo.trim();
  return /^(?:https?|ssh|git):\/\//i.test(value) || /^git@[^:]+:.+/.test(value);
}

export function agentToolLabel(tool: AgentTool): string {
  return tool === "claude-code" ? "Claude Code" : "Codex";
}

/**
 * Build the SSH command that waits for agent-VM setup to finish and then
 * attaches a detached `detachproc` session running the coding tool. Polls for
 * the tool executable, `detachproc`, the setup marker written by the
 * bootstrap command, and (when `launchReadyToken` is set) the launch-ready
 * marker.
 *
 * detachproc (https://github.com/Infrawrench/detachproc) is a transparent
 * detached-PTY holder: unlike screen/tmux it never parses the terminal
 * stream, so the tool's native mouse reporting and bracketed paste work
 * end-to-end with no client-side workarounds.
 */
export function buildAgentLaunchCommand(input: AgentLaunchCommandInput): string {
  const sessionName = `infrawrench-agent-${input.sessionId.slice(0, 8)}`;
  const toolCommand =
    input.tool === "claude-code" ? "claude --dangerously-skip-permissions" : "codex --yolo";
  const toolExecutable = input.tool === "claude-code" ? "claude" : "codex";
  const launchReadyMarker = input.launchReadyToken
    ? `$HOME/.infrawrench-agent/launch-ready/${shellDoubleQuoteContent(input.launchReadyToken)}`
    : "";
  const waitingMessage = input.launchReadyToken
    ? "Waiting for agent VM setup and workspace sync to finish..."
    : "Waiting for agent VM setup to finish...";
  const script = `
set -e
refresh_agent_shell() {
  export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:$PATH"
  if command -v mise >/dev/null 2>&1; then
    eval "$(mise activate bash)" || true
  fi
  hash -r
}
refresh_agent_shell
SESSION=${shellQuote(sessionName)}
PROJECT_DIR="$HOME/${shellDoubleQuoteContent(input.workspaceName)}"
TOOL_EXECUTABLE=${shellQuote(toolExecutable)}
SETUP_MARKER="$HOME/.infrawrench-agent/setup-$TOOL_EXECUTABLE"
LAUNCH_READY_MARKER=${launchReadyMarker ? `"${launchReadyMarker}"` : '""'}
# Self-heal VMs bootstrapped before the detachproc switch.
ensure_detachproc() {
  if command -v detachproc >/dev/null 2>&1; then return 0; fi
  mkdir -p "$HOME/.local/bin"
  curl -fsSL --retry 3 --retry-delay 2 "https://github.com/Infrawrench/detachproc/releases/latest/download/detachproc-$(uname -m)-unknown-linux-musl" -o "$HOME/.local/bin/detachproc" 2>/dev/null && chmod +x "$HOME/.local/bin/detachproc" || true
}
ensure_detachproc
deadline=$((SECONDS + 900))
announced=0
while true; do
  refresh_agent_shell
  ready=1
  if ! command -v "$TOOL_EXECUTABLE" >/dev/null 2>&1; then
    ready=0
  fi
  if ! command -v detachproc >/dev/null 2>&1; then
    ready=0
  fi
  if [ ! -f "$SETUP_MARKER" ]; then
    ready=0
  fi
  if [ -n "$LAUNCH_READY_MARKER" ] && [ ! -f "$LAUNCH_READY_MARKER" ]; then
    ready=0
  fi
  if [ "$ready" = "1" ]; then
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Agent VM setup did not finish before the SSH launch timeout." >&2
    echo "Missing pieces:" >&2
    command -v "$TOOL_EXECUTABLE" >/dev/null 2>&1 || echo "- $TOOL_EXECUTABLE is not installed or not on PATH" >&2
    command -v detachproc >/dev/null 2>&1 || echo "- detachproc is not installed or not on PATH" >&2
    [ -f "$SETUP_MARKER" ] || echo "- setup marker is missing: $SETUP_MARKER" >&2
    if [ -n "$LAUNCH_READY_MARKER" ] && [ ! -f "$LAUNCH_READY_MARKER" ]; then
      echo "- workspace sync marker is missing: $LAUNCH_READY_MARKER" >&2
    fi
    exit 1
  fi
  if [ "$announced" = "0" ]; then
    echo "${shellDoubleQuoteContent(waitingMessage)}"
    announced=1
  fi
  sleep 2
done
# Pre-trust the workspace so the tool skips its "do you trust this folder?"
# dialog. The synced local config only trusts paths from the user's machine,
# never the VM's workspace path. Runs after setup (so a config re-sync can't
# overwrite it) and is idempotent across reattaches.
if [ "$TOOL_EXECUTABLE" = "claude" ]; then
  node -e "const fs=require(\\"fs\\");const p=process.env.HOME+\\"/.claude.json\\";let j={};try{j=JSON.parse(fs.readFileSync(p,\\"utf8\\"))}catch(e){}if(typeof j!==\\"object\\"||j===null)j={};if(typeof j.projects!==\\"object\\"||j.projects===null)j.projects={};const d=process.argv[1];j.projects[d]=Object.assign({},j.projects[d],{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true});fs.writeFileSync(p,JSON.stringify(j,null,2));" "$PROJECT_DIR" || echo "warning: could not pre-trust $PROJECT_DIR for claude" >&2
else
  mkdir -p "$HOME/.codex"
  if ! grep -qF "[projects.\\"$PROJECT_DIR\\"]" "$HOME/.codex/config.toml" 2>/dev/null; then
    printf '\\n[projects."%s"]\\ntrust_level = "trusted"\\n' "$PROJECT_DIR" >> "$HOME/.codex/config.toml"
  fi
fi
# IS_SANDBOX: agent VMs are dedicated throwaway machines and the default SSH
# user is often root — Claude Code refuses --dangerously-skip-permissions as
# root unless it knows it runs inside a sandbox. detachproc propagates the
# child's exit status and its client prints it, so startup failures stay
# visible in the terminal.
START_SCRIPT="export PATH=\\"\\$HOME/.local/bin:\\$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:\\$PATH\\"; export IS_SANDBOX=1; if command -v mise >/dev/null 2>&1; then eval \\"\\$(mise activate bash)\\" || true; fi; cd $(printf '%q' "$PROJECT_DIR") && exec ${toolCommand}"
exec detachproc run --session "$SESSION" -- bash -lc "$START_SCRIPT"
`;
  return `bash -lc ${shellQuote(script)}`;
}

/**
 * Build the bootstrap command run over SSH during agent-VM setup: installs
 * system packages, mise-managed runtimes, package managers, and the coding
 * tool CLI, prepares the workspace (cloning the repo when a clone URL is
 * known), and finally writes the `~/.infrawrench-agent/setup-$TOOL` marker
 * the launch command polls for.
 */
export function buildAgentBootstrapCommand(input: AgentBootstrapCommandInput): string {
  const toolCommand = input.tool === "claude-code" ? "claude" : "codex";
  const toolPackage = input.tool === "claude-code" ? "@anthropic-ai/claude-code" : "@openai/codex";
  const runtimeLines = runtimeInstallCommands(input.setupPlan);
  const packageManagerLines = packageManagerInstallCommands(input.setupPlan);
  const initialCloneUrl =
    input.setupPlan.initialCloneUrl?.trim() || (isCloneableGitRepo(input.repo) ? input.repo : "");
  const script = `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:$PATH"
export MISE_YES=1

TOOL_COMMAND=${shellQuote(toolCommand)}
TOOL_PACKAGE=${shellQuote(toolPackage)}
PROJECT_NAME=${shellQuote(input.workspaceName)}
PROJECT_DIR="$HOME/$PROJECT_NAME"
REPO_URL=${shellQuote(initialCloneUrl)}
REPO_CLONEABLE=${initialCloneUrl ? "1" : "0"}
BRANCH_NAME=${shellQuote(input.branchName)}
MARKER_DIR="$HOME/.infrawrench-agent"
MARKER="$MARKER_DIR/setup-$TOOL_COMMAND"

log_step() {
  printf '%s%s\\n' ${shellQuote(AGENT_SETUP_STEP_PREFIX)} "$1" >&2
}

mkdir -p "$MARKER_DIR"
if command -v "$TOOL_COMMAND" >/dev/null 2>&1 && command -v detachproc >/dev/null 2>&1 && [ -f "$MARKER" ]; then
  log_step "Bootstrap already complete."
  exit 0
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required to prepare this VM as a non-root user" >&2
    exit 1
  fi
  SUDO="sudo"
fi

# System packages install in the BACKGROUND: everything until the wait
# below (detachproc, mise, Node — a prebuilt tarball — and the tool CLI)
# only needs curl/tar/gzip, which every cloud image ships. Build-dependent
# work (compiled runtimes, the workspace clone) waits for it.
install_system_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    # Fresh cloud VMs often run unattended-upgrades on first boot, which holds
    # the dpkg lock for minutes. Wait for it instead of failing immediately.
    $SUDO apt-get -o DPkg::Lock::Timeout=120 update -y
    $SUDO apt-get -o DPkg::Lock::Timeout=120 install -y ca-certificates curl git tar xz-utils unzip libatomic1 build-essential pkg-config autoconf bison libssl-dev zlib1g-dev libreadline-dev libyaml-dev libffi-dev libgdbm-dev libncurses-dev libdb-dev libsqlite3-dev libgmp-dev
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y ca-certificates curl git tar xz unzip libatomic gcc gcc-c++ make pkgconf-pkg-config openssl-devel zlib-devel readline-devel libyaml-devel libffi-devel gdbm-devel ncurses-devel sqlite-devel gmp-devel
  elif command -v apk >/dev/null 2>&1; then
    $SUDO apk add --no-cache ca-certificates curl git tar xz unzip bash libatomic build-base pkgconf openssl-dev zlib-dev readline-dev yaml-dev libffi-dev gdbm-dev ncurses-dev sqlite-dev gmp-dev
  else
    echo "Unsupported Linux package manager; install git, curl, and build tools manually" >&2
    return 1
  fi
}
log_step "Installing system packages (in the background)."
install_system_packages &
SYS_PKG_PID=$!

wait_for_system_packages() {
  if [ -z "$SYS_PKG_PID" ]; then return 0; fi
  log_step "Waiting for system packages to finish."
  if ! wait "$SYS_PKG_PID"; then
    echo "System package installation failed" >&2
    exit 1
  fi
  SYS_PKG_PID=""
}

if ! command -v detachproc >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/detachproc" ]; then
  log_step "Installing detachproc session holder."
  mkdir -p "$HOME/.local/bin"
  if ! curl -fsSL --retry 3 --retry-delay 2 "https://github.com/Infrawrench/detachproc/releases/latest/download/detachproc-$(uname -m)-unknown-linux-musl" -o "$HOME/.local/bin/detachproc"; then
    echo "Failed to download detachproc for $(uname -m) (curl exit $?)" >&2
    exit 1
  fi
  chmod +x "$HOME/.local/bin/detachproc"
fi

if ! command -v mise >/dev/null 2>&1; then
  log_step "Installing mise runtime manager."
  curl -fsSL https://mise.run | sh
fi
export PATH="$HOME/.local/bin:$PATH"
if ! command -v mise >/dev/null 2>&1; then
  echo "mise did not install into PATH" >&2
  exit 1
fi

ensure_shell_runtime_path() {
  mkdir -p "$HOME/.local/bin"
  for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    touch "$rc"
    if ! grep -F 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"' "$rc" >/dev/null 2>&1; then
      printf '%s\\n' 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"' >> "$rc"
    fi
    if ! grep -F 'mise activate bash' "$rc" >/dev/null 2>&1; then
      printf '%s\\n' 'if command -v mise >/dev/null 2>&1; then eval "$(mise activate bash)"; fi' >> "$rc"
    fi
  done
}

ensure_shell_runtime_path

install_runtime() {
  runtime="$1"
  version="$2"
  if [ -z "$runtime" ] || [ -z "$version" ]; then
    return 0
  fi
  if [ "$version" = "latest" ]; then
    version="$(mise latest "$runtime")"
  fi
  log_step "Installing $runtime $version."
  mise use -g "$runtime@$version"
  mise install "$runtime@$version"
}

# Node is a prebuilt tarball, but newer releases link shared libs the
# minimal cloud images lack (e.g. libatomic.so.1) that arrive with the
# system packages — if the parallel install fails, wait for them and retry.
install_node_runtime() {
${runtimeLines.nodeLines}
}
if ! install_node_runtime; then
  echo "Node install failed while system packages were still installing; retrying after they finish." >&2
  wait_for_system_packages
  install_node_runtime
fi

eval "$(mise activate bash)" || true
hash -r

ensure_npm_global_prefix() {
  if command -v npm >/dev/null 2>&1; then
    npm config set prefix "$HOME/.local"
    export PATH="$HOME/.local/bin:$PATH"
  fi
}

ensure_npm_global_prefix

link_tool_command() {
  cmd="$1"
  target="$(command -v "$cmd" 2>/dev/null || true)"
  if [ -z "$target" ] && [ -x "$HOME/.local/bin/$cmd" ]; then
    target="$HOME/.local/bin/$cmd"
  fi
  if [ -z "$target" ] && command -v npm >/dev/null 2>&1; then
    prefix="$(npm config get prefix 2>/dev/null || true)"
    if [ -n "$prefix" ] && [ -x "$prefix/bin/$cmd" ]; then
      target="$prefix/bin/$cmd"
    fi
  fi
  # Never link a path onto itself: when the launcher already lives in
  # ~/.local/bin (npm prefix is ~/.local), ln -sf X X destroys the real file
  # and leaves a self-looping symlink behind.
  if [ -n "$target" ] && [ "$target" != "$HOME/.local/bin/$cmd" ]; then
    ln -sf "$target" "$HOME/.local/bin/$cmd" || echo "warning: could not link $cmd into ~/.local/bin" >&2
  fi
}

install_package_manager() {
  spec="$1"
  name="\${spec%%@*}"
  if [ -z "$name" ]; then
    return 0
  fi
  log_step "Installing package manager $spec."
  case "$name" in
    npm)
      if [ "$spec" != "npm" ]; then
        npm install -g "$spec"
      fi
      ;;
    pnpm|yarn)
      if ! command -v npm >/dev/null 2>&1; then
        echo "npm is required to install $name" >&2
        exit 1
      fi
      if [ "$spec" = "$name" ]; then
        spec="$name@latest"
      fi
      if command -v corepack >/dev/null 2>&1; then
        corepack enable
        corepack prepare "$spec" --activate
      else
        npm install -g "$spec"
      fi
      ;;
    bun)
      version="\${spec#bun@}"
      if [ "$version" = "$spec" ]; then
        version="latest"
      fi
      install_runtime bun "$version"
      eval "$(mise activate bash)" || true
      hash -r
      ;;
    composer)
      if ! command -v composer >/dev/null 2>&1; then
        if ! command -v php >/dev/null 2>&1; then
          echo "php is required to install composer" >&2
          exit 1
        fi
        curl -fsSL https://getcomposer.org/installer -o /tmp/infrawrench-composer-setup.php
        php /tmp/infrawrench-composer-setup.php --install-dir="$HOME/.local/bin" --filename=composer
        rm -f /tmp/infrawrench-composer-setup.php
      fi
      ;;
    bundler)
      if ! command -v bundle >/dev/null 2>&1; then
        if ! command -v gem >/dev/null 2>&1; then
          echo "gem is required to install bundler" >&2
          exit 1
        fi
        gem install bundler
      fi
      ;;
    go)
      ;;
  esac
}

${packageManagerLines.nodeLines}

if ! command -v "$TOOL_COMMAND" >/dev/null 2>&1; then
  log_step "Installing ${agentToolLabel(input.tool)} CLI."
  if command -v npm >/dev/null 2>&1; then
    ensure_npm_global_prefix
    # Newer npm blocks package install scripts unless allow-listed; the tool
    # CLIs rely on a postinstall to set up their launcher, so without this the
    # package "installs" but the command never lands in PATH. Don't abort on
    # npm failure — a native-installer fallback may still succeed below.
    npm install -g --allow-scripts="$TOOL_PACKAGE" "$TOOL_PACKAGE@latest" || echo "npm install of $TOOL_PACKAGE failed; trying fallback installer" >&2
  else
    echo "npm is not available; trying fallback installer for $TOOL_COMMAND" >&2
  fi
fi

eval "$(mise activate bash)" || true
ensure_npm_global_prefix
hash -r
link_tool_command "$TOOL_COMMAND"
hash -r

# Strict usability check: command -v alone reports non-executable files as
# found (running them then fails with 126), so also require the execute bit.
tool_command_usable() {
  usable_path="$(command -v "$TOOL_COMMAND" 2>/dev/null || true)"
  [ -n "$usable_path" ] && [ -x "$usable_path" ]
}

# npm can leave a broken launcher behind (a dangling symlink or a stub with
# no execute bit) when the package's postinstall was skipped or failed. Try
# to repair it — and if that fails, remove it so a fallback installer can
# install cleanly instead of being masked by the corpse.
repair_tool_launcher() {
  launcher="$HOME/.local/bin/$TOOL_COMMAND"
  if ! [ -e "$launcher" ] && ! [ -L "$launcher" ]; then
    return 0
  fi
  if tool_command_usable; then
    return 0
  fi
  echo "launcher exists but is unusable: $(ls -l "$launcher" 2>/dev/null)" >&2
  launcher_target="$(readlink -f "$launcher" 2>/dev/null || true)"
  if [ -n "$launcher_target" ] && [ -f "$launcher_target" ]; then
    chmod +x "$launcher" "$launcher_target" 2>/dev/null || true
    hash -r
    if tool_command_usable; then
      echo "repaired launcher permissions for $TOOL_COMMAND" >&2
      return 0
    fi
  fi
  if command -v npm >/dev/null 2>&1; then
    npm rebuild -g --allow-scripts="$TOOL_PACKAGE" "$TOOL_PACKAGE" >/dev/null 2>&1 || true
    hash -r
    if tool_command_usable; then
      echo "repaired $TOOL_COMMAND by re-running its install scripts" >&2
      return 0
    fi
  fi
  echo "removing unusable $TOOL_COMMAND launcher" >&2
  rm -f "$launcher"
  hash -r
}

repair_tool_launcher

# The npm route depends on prefix/shim wiring that varies across npm and mise
# versions. Claude Code ships a self-contained native installer that always
# lands in ~/.local/bin — use it whenever npm didn't produce a working CLI.
# Download to a file first: piping curl straight into bash fails with no
# output at all when the download itself errors.
if ! tool_command_usable && [ "$TOOL_COMMAND" = "claude" ]; then
  log_step "Installing Claude Code via native installer."
  CLAUDE_INSTALLER="$(mktemp)"
  if curl -fsSL --retry 3 --retry-delay 2 -o "$CLAUDE_INSTALLER" https://claude.ai/install.sh; then
    # Route installer output to stderr — the setup failure log keeps only the
    # stderr tail, and the installer reports errors on stdout.
    bash "$CLAUDE_INSTALLER" >&2 || echo "Claude Code native installer exited with status $?" >&2
  else
    echo "Failed to download the Claude Code installer (curl exit $?)" >&2
  fi
  rm -f "$CLAUDE_INSTALLER"
  export PATH="$HOME/.local/bin:$PATH"
  hash -r
  link_tool_command "$TOOL_COMMAND"
  hash -r
fi

# Installers don't always put the binary on this (non-interactive) shell's
# PATH — some drop it in their own directory and wire PATH via shell rc
# "integration" that only interactive shells read. Hunt down the binary in
# the known install locations and link it into ~/.local/bin ourselves.
locate_and_link_tool() {
  if tool_command_usable; then
    return 0
  fi
  candidates="$HOME/.claude/local/$TOOL_COMMAND
$HOME/.claude/local/bin/$TOOL_COMMAND
$HOME/.claude/bin/$TOOL_COMMAND
$HOME/.codex/bin/$TOOL_COMMAND
$HOME/bin/$TOOL_COMMAND
$(find "$HOME" -maxdepth 4 -name "$TOOL_COMMAND" -type f -perm -100 2>/dev/null | head -n 3)"
  for candidate in $candidates; do
    if [ "$candidate" = "$HOME/.local/bin/$TOOL_COMMAND" ]; then
      continue
    fi
    if [ -x "$candidate" ] && [ -f "$candidate" ]; then
      ln -sf "$candidate" "$HOME/.local/bin/$TOOL_COMMAND" || continue
      hash -r
      if tool_command_usable; then
        echo "linked $TOOL_COMMAND from $candidate" >&2
        return 0
      fi
    fi
  done
  return 0
}

locate_and_link_tool

if ! tool_command_usable; then
  echo "$TOOL_COMMAND did not install into PATH" >&2
  echo "diagnostics: npm prefix: $(npm config get prefix 2>/dev/null || echo unavailable)" >&2
  echo "diagnostics: launcher: $(ls -l "$HOME/.local/bin/$TOOL_COMMAND" 2>/dev/null || echo none)" >&2
  echo "diagnostics: ~/.local/bin: $(ls -m "$HOME/.local/bin" 2>/dev/null | tr -d '\\n' | head -c 300)" >&2
  echo "diagnostics: mise shims: $(ls -m "$HOME/.local/share/mise/shims" 2>/dev/null | tr -d '\\n' | head -c 300)" >&2
  echo "diagnostics: found on disk: $(find "$HOME" -maxdepth 4 -name "$TOOL_COMMAND" 2>/dev/null | head -n 5 | tr '\\n' ' ')" >&2
  exit 1
fi

# Everything below needs the system packages: compiled runtimes want build
# tools, composer/bundler want those runtimes, and the clone wants git.
wait_for_system_packages

${runtimeLines.otherLines}

eval "$(mise activate bash)" || true
hash -r

${packageManagerLines.otherLines}

log_step "Preparing workspace $PROJECT_DIR."
mkdir -p "$PROJECT_DIR"
if [ "$REPO_CLONEABLE" = "1" ]; then
  log_step "Pulling initial workspace from Git remote."
  if [ -d "$PROJECT_DIR/.git" ]; then
    git -C "$PROJECT_DIR" remote get-url origin >/dev/null 2>&1 || git -C "$PROJECT_DIR" remote add origin "$REPO_URL"
    git -C "$PROJECT_DIR" fetch --all --prune || echo "git fetch failed; continuing with existing workspace" >&2
    git -C "$PROJECT_DIR" pull --ff-only || echo "git pull failed; continuing with existing workspace" >&2
  elif [ -z "$(find "$PROJECT_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    rmdir "$PROJECT_DIR" 2>/dev/null || true
    if ! git clone "$REPO_URL" "$PROJECT_DIR"; then
      mkdir -p "$PROJECT_DIR"
      echo "git clone failed; created empty workspace at $PROJECT_DIR" >&2
    fi
  else
    echo "workspace is not empty and is not a git repository: $PROJECT_DIR" >&2
  fi
fi

if [ "$REPO_CLONEABLE" = "1" ] && [ -d "$PROJECT_DIR/.git" ]; then
  cd "$PROJECT_DIR"
  git checkout -B "$BRANCH_NAME" || true
elif [ "$REPO_CLONEABLE" = "1" ]; then
  echo "workspace is not a git repository: $PROJECT_DIR" >&2
fi

log_step "Bootstrap complete."
touch "$MARKER"
`;
  return `timeout 420s bash -lc ${shellQuote(script)}`;
}

/**
 * Runtime installs split by what they need: Node is a prebuilt tarball and
 * can install while the system packages are still downloading; PHP/Ruby are
 * compiled by mise and need build-essential & co from apt first.
 */
function runtimeInstallCommands(plan: AgentSetupPlan): {
  nodeLines: string;
  otherLines: string;
} {
  const runtimes = dedupeRuntimesForBootstrap(plan.runtimes);
  const line = (runtime: AgentRuntimePlan) =>
    `install_runtime ${shellQuote(runtime.language)} ${shellQuote(runtime.version)}`;
  return {
    nodeLines: runtimes
      .filter((r) => r.language === "node")
      .map(line)
      .join("\n"),
    otherLines: runtimes
      .filter((r) => r.language !== "node")
      .map(line)
      .join("\n"),
  };
}

/**
 * Package-manager installs split the same way: npm/pnpm/yarn/bun only need
 * Node; composer/bundler need the PHP/Ruby runtimes that wait on apt.
 */
function packageManagerInstallCommands(plan: AgentSetupPlan): {
  nodeLines: string;
  otherLines: string;
} {
  const NODE_ONLY = new Set(["npm", "pnpm", "yarn", "bun"]);
  const specs = dedupePackageManagersForBootstrap(plan.packageManagers);
  const line = (spec: string) => `install_package_manager ${shellQuote(spec)}`;
  return {
    nodeLines: specs
      .filter((spec) => NODE_ONLY.has(packageManagerName(spec)))
      .map(line)
      .join("\n"),
    otherLines: specs
      .filter((spec) => !NODE_ONLY.has(packageManagerName(spec)))
      .map(line)
      .join("\n"),
  };
}

function dedupeRuntimesForBootstrap(runtimes: AgentRuntimePlan[]): AgentRuntimePlan[] {
  const byLanguage = new Map<AgentRuntimePlan["language"], AgentRuntimePlan>();
  for (const runtime of runtimes) {
    if (!runtime.version.trim()) continue;
    byLanguage.set(runtime.language, runtime);
  }
  if (!byLanguage.has("node")) {
    byLanguage.set("node", {
      language: "node",
      version: "latest",
      versionSource: "latest",
      source: "mise latest resolver at setup time",
      reasons: ["Agent CLI packages require Node"],
    });
  }
  return Array.from(byLanguage.values());
}

function dedupePackageManagersForBootstrap(packageManagers: string[]): string[] {
  const byName = new Map<string, string>();
  for (const packageManager of packageManagers) {
    const spec = packageManager.trim();
    if (!spec) continue;
    const name = packageManagerName(spec);
    const existing = byName.get(name);
    if (!existing || spec.includes("@")) {
      byName.set(name, spec);
    }
  }
  return Array.from(byName.values());
}

function packageManagerName(spec: string): string {
  return spec.split("@")[0] || spec;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellDoubleQuoteContent(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1").replace(/\n/g, "\\n");
}
