import { describe, expect, it } from "vitest";

import {
  buildAgentBootstrapCommand,
  buildAgentLaunchCommand,
  isCloneableGitRepo,
} from "../agents/launch-command.js";
import type { AgentSetupPlan } from "../agents/types.js";

const SESSION_ID = "6f9619ff-8b86-d011-b42d-00c04fc964ff";

/**
 * The builders return `bash -lc '<script>'` (or `timeout 420s bash -lc ...`)
 * with the inner script single-quote-escaped; unwrap it so assertions can
 * match the script as the remote shell sees it.
 */
function unwrap(command: string): string {
  const first = command.indexOf("'");
  const last = command.lastIndexOf("'");
  return command.slice(first + 1, last).replace(/'\\''/g, "'");
}

function plan(overrides: Partial<AgentSetupPlan> = {}): AgentSetupPlan {
  return {
    source: "git-url",
    workspaceName: "my-app",
    initialCloneUrl: "https://example.com/org/my-app.git",
    runtimes: [
      {
        language: "node",
        version: "22.1.0",
        versionSource: "project",
        source: ".nvmrc",
        reasons: [".nvmrc exists"],
      },
    ],
    packageManagers: ["pnpm@9.0.0"],
    configSources: [],
    warnings: [],
    ...overrides,
  };
}

describe("buildAgentLaunchCommand", () => {
  it("names the detachproc session after the first 8 chars of the session id", () => {
    const command = unwrap(
      buildAgentLaunchCommand({
        sessionId: SESSION_ID,
        tool: "codex",
        workspaceName: "my-app",
      }),
    );
    expect(command).toContain("SESSION='infrawrench-agent-6f9619ff'");
  });

  it("polls the setup marker for the selected tool", () => {
    const claude = unwrap(
      buildAgentLaunchCommand({
        sessionId: SESSION_ID,
        tool: "claude-code",
        workspaceName: "my-app",
      }),
    );
    expect(claude).toContain("TOOL_EXECUTABLE='claude'");
    expect(claude).toContain('SETUP_MARKER="$HOME/.infrawrench-agent/setup-$TOOL_EXECUTABLE"');
    expect(claude).toContain("claude --dangerously-skip-permissions");
    // Root VMs: Claude Code refuses --dangerously-skip-permissions as root
    // unless it knows it's in a sandbox.
    expect(claude).toContain("export IS_SANDBOX=1");
    // detachproc propagates the child's exit status to the attached client,
    // so startup failures stay visible in the terminal.
    expect(claude).toContain("exec claude");

    const codex = unwrap(
      buildAgentLaunchCommand({
        sessionId: SESSION_ID,
        tool: "codex",
        workspaceName: "my-app",
      }),
    );
    expect(codex).toContain("TOOL_EXECUTABLE='codex'");
    expect(codex).toContain("exec codex --yolo");
  });

  it("waits on the launch-ready marker when a token is provided", () => {
    const token = "abc-123";
    const command = unwrap(
      buildAgentLaunchCommand({
        sessionId: SESSION_ID,
        tool: "codex",
        workspaceName: "my-app",
        launchReadyToken: token,
      }),
    );
    expect(command).toContain(
      `LAUNCH_READY_MARKER="$HOME/.infrawrench-agent/launch-ready/${token}"`,
    );
    expect(command).toContain("Waiting for agent VM setup and workspace sync to finish...");
  });

  it("skips the launch-ready marker wait when no token is provided", () => {
    for (const launchReadyToken of [undefined, ""]) {
      const command = unwrap(
        buildAgentLaunchCommand({
          sessionId: SESSION_ID,
          tool: "codex",
          workspaceName: "my-app",
          ...(launchReadyToken === undefined ? {} : { launchReadyToken }),
        }),
      );
      expect(command).toContain('LAUNCH_READY_MARKER=""');
      expect(command).not.toContain("launch-ready/");
      expect(command).toContain("Waiting for agent VM setup to finish...");
    }
  });

  it("escapes shell-sensitive characters in the workspace name", () => {
    const command = unwrap(
      buildAgentLaunchCommand({
        sessionId: SESSION_ID,
        tool: "codex",
        workspaceName: 'my"app$1',
      }),
    );
    expect(command).toContain('PROJECT_DIR="$HOME/my\\"app\\$1"');
  });

  it("polls until ready with a 900s deadline and attaches detachproc", () => {
    const command = unwrap(
      buildAgentLaunchCommand({
        sessionId: SESSION_ID,
        tool: "codex",
        workspaceName: "my-app",
      }),
    );
    expect(command).toContain("deadline=$((SECONDS + 900))");
    expect(command).toContain(
      'exec detachproc run --session "$SESSION" -- bash -lc "$START_SCRIPT"',
    );
    // VMs bootstrapped before the detachproc switch lack the binary — the
    // launch script downloads it itself so those sessions keep working.
    expect(command).toContain("ensure_detachproc");
    expect(command).not.toContain("exec screen");
    expect(command).not.toContain("exec tmux");
  });
});

describe("buildAgentBootstrapCommand", () => {
  it("writes the setup marker the launch command polls for", () => {
    const bootstrap = unwrap(
      buildAgentBootstrapCommand({
        tool: "claude-code",
        workspaceName: "my-app",
        branchName: "infrawrench/agent-6f9619ff",
        repo: "https://example.com/org/my-app.git",
        setupPlan: plan(),
      }),
    );
    // Both scripts must agree on ~/.infrawrench-agent/setup-<tool>.
    expect(bootstrap).toContain('MARKER_DIR="$HOME/.infrawrench-agent"');
    expect(bootstrap).toContain('MARKER="$MARKER_DIR/setup-$TOOL_COMMAND"');
    expect(bootstrap).toContain("TOOL_COMMAND='claude'");
    expect(bootstrap).toContain('touch "$MARKER"');
  });

  it("waits for the dpkg lock instead of failing on fresh VMs", () => {
    const bootstrap = unwrap(
      buildAgentBootstrapCommand({
        tool: "claude-code",
        workspaceName: "my-app",
        branchName: "infrawrench/agent-6f9619ff",
        repo: "https://example.com/org/my-app.git",
        setupPlan: plan(),
      }),
    );
    expect(bootstrap).toContain("apt-get -o DPkg::Lock::Timeout=120 update -y");
    expect(bootstrap).toContain("apt-get -o DPkg::Lock::Timeout=120 install -y");
  });

  it("installs the detachproc session holder from GitHub releases", () => {
    const bootstrap = unwrap(
      buildAgentBootstrapCommand({
        tool: "claude-code",
        workspaceName: "my-app",
        branchName: "infrawrench/agent-6f9619ff",
        repo: "https://example.com/org/my-app.git",
        setupPlan: plan(),
      }),
    );
    expect(bootstrap).toContain(
      "https://github.com/Infrawrench/detachproc/releases/latest/download/detachproc-$(uname -m)-unknown-linux-musl",
    );
    expect(bootstrap).toContain('chmod +x "$HOME/.local/bin/detachproc"');
  });

  it("allow-lists the tool package's install scripts for npm", () => {
    const bootstrap = unwrap(
      buildAgentBootstrapCommand({
        tool: "claude-code",
        workspaceName: "my-app",
        branchName: "infrawrench/agent-6f9619ff",
        repo: "https://example.com/org/my-app.git",
        setupPlan: plan(),
      }),
    );
    // Without allow-scripts, npm skips the CLI's postinstall and the `claude`
    // launcher never lands in PATH.
    expect(bootstrap).toContain(
      'npm install -g --allow-scripts="$TOOL_PACKAGE" "$TOOL_PACKAGE@latest"',
    );
  });

  it("falls back to the Claude Code native installer when npm produces no CLI", () => {
    const bootstrap = unwrap(
      buildAgentBootstrapCommand({
        tool: "claude-code",
        workspaceName: "my-app",
        branchName: "infrawrench/agent-6f9619ff",
        repo: "https://example.com/org/my-app.git",
        setupPlan: plan(),
      }),
    );
    expect(bootstrap).toContain('[ "$TOOL_COMMAND" = "claude" ]');
    expect(bootstrap).toContain(
      'curl -fsSL --retry 3 --retry-delay 2 -o "$CLAUDE_INSTALLER" https://claude.ai/install.sh',
    );
    // A broken npm launcher (dangling symlink / missing exec bit) must be
    // repaired or removed so the fallback isn't masked by the corpse.
    expect(bootstrap).toContain("repair_tool_launcher");
    expect(bootstrap).toContain('npm rebuild -g --allow-scripts="$TOOL_PACKAGE"');
    // command -v alone treats a non-executable launcher as installed.
    expect(bootstrap).toContain("tool_command_usable");
    // ln -sf X X destroys the launcher when npm prefix bin IS ~/.local/bin.
    expect(bootstrap).toContain('[ "$target" != "$HOME/.local/bin/$cmd" ]');
    // Installers may drop the binary off-PATH; the bootstrap must hunt it down.
    expect(bootstrap).toContain("locate_and_link_tool");
    expect(bootstrap).toContain("diagnostics: found on disk:");
    // A missing CLI must fail with diagnostics, not a bare "not in PATH".
    expect(bootstrap).toContain("diagnostics: npm prefix:");
    expect(bootstrap).toContain("diagnostics: launcher:");
  });

  it("clones the plan's Git URL and checks out the session branch", () => {
    const bootstrap = unwrap(
      buildAgentBootstrapCommand({
        tool: "codex",
        workspaceName: "my-app",
        branchName: "infrawrench/agent-6f9619ff",
        repo: "https://example.com/org/my-app.git",
        setupPlan: plan(),
      }),
    );
    expect(bootstrap).toContain("REPO_URL='https://example.com/org/my-app.git'");
    expect(bootstrap).toContain("REPO_CLONEABLE=1");
    expect(bootstrap).toContain("BRANCH_NAME='infrawrench/agent-6f9619ff'");
    expect(bootstrap).toContain("install_runtime 'node' '22.1.0'");
    expect(bootstrap).toContain("install_package_manager 'pnpm@9.0.0'");
  });

  it("marks non-cloneable repos so the workspace is left to the file sync", () => {
    const bootstrap = unwrap(
      buildAgentBootstrapCommand({
        tool: "codex",
        workspaceName: "my-app",
        branchName: "infrawrench/agent-6f9619ff",
        repo: "/Users/me/projects/my-app",
        setupPlan: plan({ source: "local-folder", initialCloneUrl: undefined }),
      }),
    );
    expect(bootstrap).toContain("REPO_CLONEABLE=0");
    expect(bootstrap).toContain("REPO_URL=''");
  });

  it("always installs a node runtime even when the plan has none", () => {
    const bootstrap = unwrap(
      buildAgentBootstrapCommand({
        tool: "codex",
        workspaceName: "my-app",
        branchName: "infrawrench/agent-6f9619ff",
        repo: "https://example.com/org/my-app.git",
        setupPlan: plan({ runtimes: [], packageManagers: [] }),
      }),
    );
    expect(bootstrap).toContain("install_runtime 'node' 'latest'");
  });
});

describe("isCloneableGitRepo", () => {
  it("accepts URL and scp-style remotes and rejects local paths", () => {
    expect(isCloneableGitRepo("https://github.com/org/repo.git")).toBe(true);
    expect(isCloneableGitRepo("ssh://git@github.com/org/repo.git")).toBe(true);
    expect(isCloneableGitRepo("git@github.com:org/repo.git")).toBe(true);
    expect(isCloneableGitRepo("/Users/me/projects/repo")).toBe(false);
    expect(isCloneableGitRepo("C:\\projects\\repo")).toBe(false);
  });
});
