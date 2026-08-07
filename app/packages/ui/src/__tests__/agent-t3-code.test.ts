import { describe, expect, it } from "vitest";

import { AGENT_SYSTEM_PACKAGES_SNIPPET } from "../agents/launch-command.js";
import {
  agentSurfaceOrDefault,
  agentSurfaceRequiresRepo,
  buildT3CodeBootstrapCommand,
  buildT3CodeConnectCommand,
  buildT3CodeLogoutCommand,
  buildT3CodeStatusCommand,
  createT3CodeSetupPlan,
  isT3CodeSurface,
  parseT3CodeConnectStatus,
  t3CodeConnectNextStep,
  T3_CODE_NODE_VERSION,
  T3_CODE_PROJECTS_DIR,
  T3_CODE_SYSTEMD_UNIT,
} from "../agents/t3-code.js";

/** Unwrap the `timeout Ns bash -lc '<script>'` / `bash -lc '<script>'` wrapper. */
function scriptBody(command: string): string {
  const start = command.indexOf("'");
  const end = command.lastIndexOf("'");
  return command.slice(start + 1, end).replace(/'\\''/g, "'");
}

describe("agent surface helpers", () => {
  it("defaults unknown and legacy values to the terminal surface", () => {
    expect(agentSurfaceOrDefault(null)).toBe("terminal");
    expect(agentSurfaceOrDefault(undefined)).toBe("terminal");
    expect(agentSurfaceOrDefault("")).toBe("terminal");
    expect(agentSurfaceOrDefault("nonsense")).toBe("terminal");
    expect(agentSurfaceOrDefault("t3-code")).toBe("t3-code");
  });

  it("only exempts T3 Code servers from needing a repo", () => {
    expect(agentSurfaceRequiresRepo("terminal")).toBe(true);
    expect(agentSurfaceRequiresRepo(undefined)).toBe(true);
    expect(agentSurfaceRequiresRepo("t3-code")).toBe(false);
    expect(isT3CodeSurface("t3-code")).toBe(true);
    expect(isT3CodeSurface("terminal")).toBe(false);
  });
});

describe("createT3CodeSetupPlan", () => {
  it("plans no clone and no package managers", () => {
    const plan = createT3CodeSetupPlan("claude-code");
    expect(plan.initialCloneUrl).toBeUndefined();
    expect(plan.workspaceName).toBe(T3_CODE_PROJECTS_DIR);
    expect(plan.packageManagers).toEqual([]);
    expect(plan.runtimes).toHaveLength(1);
    expect(plan.runtimes[0]?.language).toBe("node");
    expect(plan.runtimes[0]?.version).toBe(T3_CODE_NODE_VERSION);
  });

  it("names the tool T3 Code will drive", () => {
    expect(JSON.stringify(createT3CodeSetupPlan("codex"))).toContain("Codex");
    expect(JSON.stringify(createT3CodeSetupPlan("claude-code"))).toContain("Claude Code");
  });
});

describe("buildT3CodeBootstrapCommand", () => {
  it("installs the t3 CLI alongside the session's agent CLI", () => {
    // T3 Code is a control surface, not an agent — a VM with only `t3` on it
    // can open projects but can never start a session.
    const claude = scriptBody(buildT3CodeBootstrapCommand({ tool: "claude-code" }));
    expect(claude).toContain("install_cli_command t3 t3 'T3 Code'");
    expect(claude).toContain(
      "install_cli_command 'claude' '@anthropic-ai/claude-code' 'Claude Code'",
    );

    const codex = scriptBody(buildT3CodeBootstrapCommand({ tool: "codex" }));
    expect(codex).toContain("install_cli_command t3 t3 'T3 Code'");
    expect(codex).toContain("install_cli_command 'codex' '@openai/codex' 'Codex'");
  });

  // Regression: T3 Code reaches for a provider other than the session's own
  // for auxiliary work — generating a thread title runs `codex exec` even in a
  // Claude Code thread. With only the session's CLI installed that dies
  // `spawn codex ENOENT` and surfaces as an opaque runtime error.
  it("installs both provider CLIs, session tool first", () => {
    for (const [tool, first, second] of [
      ["claude-code", "'claude'", "'codex'"],
      ["codex", "'codex'", "'claude'"],
    ] as const) {
      const script = scriptBody(buildT3CodeBootstrapCommand({ tool }));
      const firstAt = script.indexOf(`install_cli_command ${first}`);
      const secondAt = script.indexOf(`install_cli_command ${second}`);
      expect(firstAt).toBeGreaterThan(-1);
      expect(secondAt).toBeGreaterThan(-1);
      expect(firstAt).toBeLessThan(secondAt);
    }
  });

  // The guard and the marker both have to account for the companion, or a VM
  // bootstrapped before this change short-circuits and never gains it.
  it("re-bootstraps a VM that only has the session's CLI", () => {
    const script = scriptBody(buildT3CodeBootstrapCommand({ tool: "claude-code" }));
    expect(script).toContain('MARKER="$MARKER_DIR/setup-t3-claude-pair"');
    expect(script).toContain("command -v 'codex' >/dev/null 2>&1");
  });

  it("never clones or checks out anything", () => {
    const script = scriptBody(buildT3CodeBootstrapCommand({ tool: "codex" }));
    expect(script).not.toContain("git clone");
    expect(script).not.toContain("git checkout");
    expect(script).toContain(`PROJECTS_DIR="$HOME/${T3_CODE_PROJECTS_DIR}"`);
  });

  // Regression: `t3` depends on node-pty, a native addon npm builds with
  // node-gyp. Installing it while the background apt run is still going fails
  // with "gyp ERR! not found: make" and aborts the whole bootstrap.
  it("waits for the compiler toolchain before any npm install", () => {
    const script = scriptBody(buildT3CodeBootstrapCommand({ tool: "codex" }));
    const joined = script.indexOf("\nwait_for_system_packages");
    const firstInstall = script.indexOf("\ninstall_cli_command t3");
    expect(joined).toBeGreaterThan(-1);
    expect(firstInstall).toBeGreaterThan(-1);
    expect(joined).toBeLessThan(firstInstall);
  });

  it("installs a Node satisfying T3 Code's engines range and verifies it", () => {
    const script = scriptBody(buildT3CodeBootstrapCommand({ tool: "codex" }));
    expect(script).toContain(`install_runtime node '${T3_CODE_NODE_VERSION}'`);
    expect(script).toContain("require_t3_node_version");
    expect(script).toContain("^22.16 || ^23.11 || >=24.10");
  });

  it("keys its completion marker on the tool, so switching tools re-bootstraps", () => {
    expect(scriptBody(buildT3CodeBootstrapCommand({ tool: "codex" }))).toContain(
      'MARKER="$MARKER_DIR/setup-t3-codex-pair"',
    );
    expect(scriptBody(buildT3CodeBootstrapCommand({ tool: "claude-code" }))).toContain(
      'MARKER="$MARKER_DIR/setup-t3-claude-pair"',
    );
  });

  // node-gyp shells out to python3; Ubuntu ships it, Alpine and minimal RHEL
  // images do not, and the failure surfaces long after apt looks successful.
  it("installs node-gyp's toolchain on every supported package manager", () => {
    for (const compiler of ["build-essential", "gcc-c++", "build-base"]) {
      expect(AGENT_SYSTEM_PACKAGES_SNIPPET).toContain(compiler);
    }
    // Every install line — apt, dnf, apk — must carry it, so count the
    // package-manager invocations rather than mentions (comments say it too).
    const installLines = AGENT_SYSTEM_PACKAGES_SNIPPET.split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\$SUDO (apt-get -o [^ ]+ install|dnf install|apk add)/.test(line));
    expect(installLines).toHaveLength(3);
    for (const line of installLines) {
      expect(line).toMatch(/\bpython3\b/);
    }
  });

  // T3 Code's "open in browser" runs on the server, which here is a headless
  // VM. Upstream hard-codes `xdg-open` on Linux with no env var to disable
  // it, so the off-switch is a no-op shim rather than a patched fork — a fork
  // would be overwritten by the service's own npm self-update.
  it("neutralizes server-side open-in-browser without clobbering a real xdg-open", () => {
    const script = scriptBody(buildT3CodeBootstrapCommand({ tool: "codex" }));
    expect(script).toContain("install_xdg_open_noop");
    expect(script).toContain("if command -v xdg-open >/dev/null 2>&1; then\n    return 0");
    expect(script).toContain('chmod +x "$HOME/.local/bin/xdg-open"');
    // Quoted heredoc: `$1` must reach the shim file literally, not be
    // expanded while the bootstrap writes it.
    expect(script).toContain("<<'INFRAWRENCH_XDG_OPEN'");
  });

  it("makes the optional extras skippable", () => {
    const bare = scriptBody(
      buildT3CodeBootstrapCommand({
        tool: "codex",
        installGithubCli: false,
        installService: false,
      }),
    );
    expect(bare).not.toContain("install_github_cli");
    expect(bare).not.toContain("t3 service install");
  });

  it("escapes a projects directory that would otherwise break out of the string", () => {
    const script = scriptBody(
      buildT3CodeBootstrapCommand({ tool: "codex", projectsDir: 'a"; rm -rf /; #' }),
    );
    expect(script).toContain('PROJECTS_DIR="$HOME/a\\"; rm -rf /; #"');
  });
});

describe("buildT3CodeConnectCommand", () => {
  it("runs the two flows that cannot be scripted, then restarts the server", () => {
    const script = scriptBody(buildT3CodeConnectCommand({ tool: "claude-code" }));
    expect(script).toContain("t3 connect link");
    expect(script).toContain("claude auth login");
    expect(script).toContain("claude auth status");
    expect(script).toContain("t3 connect status");
  });

  // Regression: `t3 connect link` only records intent — the relay link is
  // provisioned by the next server *start*. `t3 service install`/`update`
  // both return early on "already installed and current" without touching
  // the unit, so using either leaves the link stuck on "pending server
  // startup" forever while reporting success.
  it("restarts the systemd unit rather than relying on a t3 service subcommand", () => {
    const script = scriptBody(buildT3CodeConnectCommand({ tool: "codex" }));
    expect(script).toContain(`systemctl --user restart ${T3_CODE_SYSTEMD_UNIT}`);
    expect(script).not.toMatch(/^\s*t3 service update/m);
  });

  // Regression: T3 Code's unit sets no PATH, so the *server* inherits
  // systemd's minimal default and cannot see anything in ~/.local/bin — gh
  // (and git's `gh auth git-credential` helper) or the provider CLI. The
  // symptom is source control failing on the server while the setup terminal
  // reports everything signed in. Repaired here too, so an already-running VM
  // is fixed by re-running Authorize server.
  it("puts the installed CLIs on the service's PATH before restarting it", () => {
    const script = scriptBody(buildT3CodeConnectCommand({ tool: "codex" }));
    const dropin = script.indexOf("install_t3_service_path_dropin\n");
    const restart = script.indexOf(`systemctl --user restart ${T3_CODE_SYSTEMD_UNIT}`);
    expect(dropin).toBeGreaterThan(-1);
    expect(dropin).toBeLessThan(restart);
    expect(script).toContain("Environment=PATH=%h/.local/bin:%h/.local/share/mise/shims:");
    // Claude Code refuses bypassPermissions (T3 Code's "Full access") as root
    // unless it believes it is sandboxed, and this service runs as root. The
    // terminal surface sets this in its launch command for the same reason;
    // without it the provider dies at turn start as `setPermissionMode failed`.
    expect(script).toContain("Environment=IS_SANDBOX=1");
    // A drop-in, not an edit to the unit: `t3 service update` rewrites the
    // unit file wholesale but leaves the .d directory alone.
    expect(script).toContain(`${T3_CODE_SYSTEMD_UNIT}.d`);
    expect(script).toContain("systemctl --user daemon-reload");
  });

  it("waits for the link to actually provision before declaring success", () => {
    const script = scriptBody(buildT3CodeConnectCommand({ tool: "codex" }));
    expect(script).toContain("t3 connect status --json");
    expect(script).toContain('"linked"');
    // And points at the server log when it never gets there. Deliberately
    // the log FILE, not journalctl: the unit sets StandardOutput=append:...,
    // so journald holds only systemd's start/stop lines and none of the
    // server's own errors.
    expect(script).toContain("~/.t3/userdata/logs/boot-service.log");
    // It may *mention* journalctl to explain why that is the wrong place to
    // look; it must not hand the user a journalctl command to run.
    expect(script).not.toContain("journalctl --user -u");
  });

  it("uses Codex's device-code flow, which needs no loopback callback", () => {
    const script = scriptBody(buildT3CodeConnectCommand({ tool: "codex" }));
    expect(script).toContain("codex login --device-auth");
    expect(script).toContain("codex login status");
  });

  // Regression: T3 Code chooses the clone URL itself and hands git the repo's
  // sshUrl whenever the clone protocol is SSH — gh's own default for many
  // users. A fresh VM has no key registered with GitHub, so that clone dies
  // `Permission denied (publickey)`, reported as the generic "could not be
  // completed" because T3 keeps only the LENGTH of git's stderr.
  it("makes git honour the protocol gh is configured for", () => {
    const script = scriptBody(buildT3CodeConnectCommand({ tool: "codex" }));
    expect(script).toContain("align_git_protocol_with_gh");
    expect(script).toContain("gh config get git_protocol");
    // HTTPS: rewrite both SSH spellings back, so a caller insisting on
    // git@github.com: still authenticates via the gh credential helper.
    expect(script).toContain('url."https://github.com/".insteadOf "git@github.com:"');
    expect(script).toContain('url."https://github.com/".insteadOf "ssh://git@github.com/"');
    expect(script).toContain("gh auth setup-git");
    // Cleared before re-adding, so repeated runs converge rather than stack.
    expect(script).toContain('--unset-all url."https://github.com/".insteadOf');
  });

  it("says what to do instead when gh is set to SSH", () => {
    const script = scriptBody(buildT3CodeConnectCommand({ tool: "codex" }));
    expect(script).toContain("gh config set git_protocol https");
    expect(script).toContain("gh ssh-key add");
  });

  it("only aligns git when the GitHub step is included", () => {
    const withoutGithub = scriptBody(
      buildT3CodeConnectCommand({ tool: "codex", includeGithubLogin: false }),
    );
    expect(withoutGithub).not.toContain("align_git_protocol_with_gh");
  });

  it("numbers its steps against the steps actually included", () => {
    const withGithub = scriptBody(buildT3CodeConnectCommand({ tool: "codex" }));
    expect(withGithub).toContain("Step 1/4");
    expect(withGithub).toContain("Step 4/4");
    expect(withGithub).toContain("gh auth login");

    const withoutGithub = scriptBody(
      buildT3CodeConnectCommand({ tool: "codex", includeGithubLogin: false }),
    );
    expect(withoutGithub).toContain("Step 1/3");
    expect(withoutGithub).toContain("Step 3/3");
    expect(withoutGithub).not.toContain("gh auth login");
  });

  it("leaves the user at a shell rather than closing the terminal", () => {
    expect(scriptBody(buildT3CodeConnectCommand({ tool: "codex" }))).toContain(
      'exec "${SHELL:-/bin/bash}" -l',
    );
  });
});

describe("parseT3CodeConnectStatus", () => {
  const status = {
    desired: true,
    authenticated: true,
    linked: true,
    cloudUserId: "user_123",
    relayUrl: "https://relay.t3.codes",
    publishAgentActivity: false,
    relayClient: { status: "available" },
  };

  it("finds the JSON object even behind leading log lines", () => {
    const parsed = parseT3CodeConnectStatus(
      `warming up\nfetching state\n${JSON.stringify(status)}\n`,
    );
    expect(parsed).toEqual({
      desired: true,
      authenticated: true,
      linked: true,
      cloudUserId: "user_123",
      relayUrl: "https://relay.t3.codes",
      publishAgentActivity: false,
    });
  });

  it("returns null for output that is not a status object", () => {
    expect(parseT3CodeConnectStatus("")).toBeNull();
    expect(parseT3CodeConnectStatus("t3: command not found")).toBeNull();
    expect(parseT3CodeConnectStatus("{ not json")).toBeNull();
    // Shaped like JSON but missing the field every real status carries.
    expect(parseT3CodeConnectStatus('{"desired":true}')).toBeNull();
  });

  it("asks for exactly the step that is outstanding", () => {
    expect(t3CodeConnectNextStep(null)).toMatch(/Authorize/);
    expect(t3CodeConnectNextStep({ ...status, authenticated: false })).toMatch(/t3 connect link/);
    expect(t3CodeConnectNextStep({ ...status, desired: false })).toMatch(/t3 connect link/);
    expect(t3CodeConnectNextStep({ ...status, linked: false })).toMatch(/Start T3 Code/);
    expect(t3CodeConnectNextStep(status)).toBeNull();
  });
});

describe("buildT3CodeLogoutCommand", () => {
  // The relay keeps an environment record that only the host can revoke. Once
  // the VM is destroyed there is no way to remove it (pingdotgg/t3code#5135),
  // so delete has to revoke first — and must never be blocked by doing so.
  it("revokes the link and cannot fail the delete that runs it", () => {
    const script = scriptBody(buildT3CodeLogoutCommand());
    expect(script).toContain("t3 connect logout");
    // A VM without the CLI, or where logout errors, still exits 0.
    expect(script).toContain("command -v t3 >/dev/null 2>&1 || exit 0");
    expect(script).toContain("t3 connect logout || true");
    expect(script).toContain("exit 0");
    // Bounded: teardown must not hang on an unreachable VM.
    expect(buildT3CodeLogoutCommand()).toMatch(/^timeout \d+s bash -lc /);
  });
});

describe("buildT3CodeStatusCommand", () => {
  it("exits distinguishably when the CLI is not installed yet", () => {
    const script = scriptBody(buildT3CodeStatusCommand());
    expect(script).toContain("command -v t3 >/dev/null 2>&1 || exit 3");
    expect(script).toContain("t3 connect status --json");
  });
});
