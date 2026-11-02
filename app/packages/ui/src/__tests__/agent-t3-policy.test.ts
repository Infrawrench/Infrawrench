import { describe, expect, it } from "vitest";

import {
  buildT3CodeBootstrapCommand,
  buildT3CodeConnectCommand,
  buildT3CodePolicyApplyCommand,
  compactT3CodePolicy,
  planT3CodePolicyRollout,
  sameT3CodePolicy,
  t3CodePolicyApplyFailure,
  T3_CODE_POLICY_APPLY_EXIT,
  createT3CodeSetupPlan,
  serializeT3CodePolicy,
  t3CodePolicyCounts,
  t3CodePolicyOrNull,
  validateT3CodePolicy,
  T3_CODE_POLICY_MARKER_PATH,
  T3_CODE_POLICY_PATH,
  type T3CodePolicy,
} from "../agents/t3-code.js";

/** Unwrap the `timeout Ns bash -lc '<script>'` / `bash -lc '<script>'` wrapper. */
function scriptBody(command: string): string {
  const start = command.indexOf("'");
  const end = command.lastIndexOf("'");
  return command.slice(start + 1, end).replace(/'\\''/g, "'");
}

async function bashParses(command: string): Promise<void> {
  // This package has no Node types; the test itself runs under Node.
  const childProcess: string = "node:child_process";
  const { execFileSync } = (await import(childProcess)) as {
    execFileSync(file: string, args: string[], options: { stdio: "pipe" }): unknown;
  };
  execFileSync("bash", ["-n", "-c", scriptBody(command)], { stdio: "pipe" });
}

const POLICY: T3CodePolicy = {
  schemaVersion: 1,
  organization: "Example Corp",
  supportUrl: "https://it.example.com/t3",
  settings: {
    defaultRuntimeMode: { value: "approval-required", locked: false },
    enableAgentBrowserAccess: { value: false, locked: true },
  },
  limits: {
    maxRuntimeMode: "auto-accept-edits",
    telemetry: false,
    providers: {
      allowedDrivers: ["claudeAgent", "codex"],
      instances: {
        claudeAgent: {
          locked: true,
          environment: [{ name: "CLAUDE_CODE_USE_BEDROCK", value: "1" }],
        },
      },
    },
    updates: { mode: "off" },
  },
};

function codes(raw: unknown, context = {}) {
  return validateT3CodePolicy(raw, context).issues.map((i) => i.code);
}

describe("validateT3CodePolicy", () => {
  it("accepts a policy shaped like upstream's documented example", () => {
    const result = validateT3CodePolicy(POLICY, { tool: "claude-code", access: "t3-connect" });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.policy).toEqual(POLICY);
  });

  it("rejects keys T3 Code does not know, because it refuses to start on them", () => {
    expect(codes({ ...POLICY, extra: true })).toContain("unknown-key");
    expect(codes({ ...POLICY, limits: { connnect: false } })).toContain("unknown-key");
    expect(
      codes({
        ...POLICY,
        limits: { providers: { instances: { codex: { locked: true, homePath: "/x" } } } },
      }),
    ).toContain("unknown-key");
  });

  it("requires schemaVersion 1 and an organization", () => {
    expect(codes({ organization: "X" })).toContain("schema-version");
    expect(codes({ schemaVersion: 1, organization: "  " })).toContain("organization-required");
    expect(codes([])).toEqual(["not-an-object"]);
  });

  it("keeps the default permission mode within the maximum", () => {
    expect(
      codes({
        schemaVersion: 1,
        organization: "X",
        settings: { defaultRuntimeMode: { value: "full-access", locked: false } },
        limits: { maxRuntimeMode: "auto" },
      }),
    ).toContain("default-above-max-runtime-mode");
  });

  it("keeps remote clients allowed, since an agent VM is reachable no other way", () => {
    expect(
      codes({ schemaVersion: 1, organization: "X", limits: { clients: ["desktop"] } }),
    ).toContain("remote-client-required");
    expect(codes({ schemaVersion: 1, organization: "X", limits: { clients: ["remote"] } })).toEqual(
      [],
    );
  });

  it("refuses connect: false only for servers reached through T3 Connect", () => {
    const policy = { schemaVersion: 1, organization: "X", limits: { connect: false } };
    expect(codes(policy, { access: "t3-connect" })).toContain("connect-off-with-t3-connect");
    expect(codes(policy, { access: "tailscale" })).toEqual([]);
    // Checked on its own (saving the defaults), the access is not known yet.
    expect(codes(policy)).toEqual([]);
  });

  it("requires the server's own provider to be allowed, and warns without Codex", () => {
    const policy = {
      schemaVersion: 1,
      organization: "X",
      limits: { providers: { allowedDrivers: ["claudeAgent"] } },
    };
    expect(validateT3CodePolicy(policy, { tool: "claude-code" }).ok).toBe(true);
    expect(codes(policy, { tool: "claude-code" })).toEqual(["codex-not-allowed"]);
    expect(codes(policy, { tool: "codex" })).toContain("tool-driver-not-allowed");
    expect(codes({ ...policy, limits: { providers: { allowedDrivers: ["nope"] } } })).toContain(
      "unknown-driver",
    );
  });

  it("validates pinned provider environment variables", () => {
    const withEnv = (name: string, value = "x") => ({
      schemaVersion: 1,
      organization: "X",
      limits: {
        providers: { instances: { codex: { locked: true, environment: [{ name, value }] } } },
      },
    });
    expect(codes(withEnv("1BAD"))).toContain("invalid-env-name");
    expect(codes(withEnv("OPENAI_BASE_URL"))).toEqual([]);
    const secret = validateT3CodePolicy(withEnv("ANTHROPIC_API_KEY", "sk-placeholder"));
    expect(secret.ok).toBe(true);
    expect(secret.issues.map((i) => [i.level, i.code])).toEqual([["warning", "secret-in-policy"]]);
  });

  it("applies upstream's rules for settings that need care", () => {
    const withSettings = (settings: Record<string, unknown>) =>
      codes({ schemaVersion: 1, organization: "X", settings });
    expect(withSettings({ projectSettingsOverrides: { value: {}, locked: true } })).toContain(
      "unmanageable-setting",
    );
    expect(withSettings({ compactIdleThreads: { value: true, locked: true } })).toContain(
      "derived-setting",
    );
    expect(
      withSettings({ "storageCleanup.worktreeAfterDays": { value: 7, locked: true } }),
    ).toContain("worktree-lock-incomplete");
    expect(
      withSettings({
        "storageCleanup.worktreeAfterDays": { value: 7, locked: true },
        worktreeCleanup: { value: null, locked: true },
      }),
    ).toEqual([]);
    expect(withSettings({ "providerInstances.codex": { value: {}, locked: false } })).toContain(
      "provider-instance-default",
    );
    expect(
      withSettings({ "providerInstances.codex.binaryPath": { value: "/x", locked: true } }),
    ).toContain("provider-instance-field-lock");
    expect(withSettings({ enableAgentBrowserAccess: { value: "no", locked: true } })).toContain(
      "setting-value-type",
    );
    expect(withSettings({ "storageCleanup.logsAfterDays": { value: null, locked: true } })).toEqual(
      [],
    );
    expect(withSettings({ "bad path": { value: 1, locked: true } })).toContain(
      "invalid-setting-path",
    );
  });

  it("only reads feedUrl as an https URL, and says servers ignore it", () => {
    const issues = validateT3CodePolicy({
      schemaVersion: 1,
      organization: "X",
      limits: { updates: { mode: "auto", feedUrl: "http://mirror" } },
    }).issues;
    expect(issues.map((i) => i.code)).toEqual(["https-required", "feed-url-desktop-only"]);
  });
});

describe("policy helpers", () => {
  it("drops empty containers when compacting", () => {
    expect(
      compactT3CodePolicy({
        schemaVersion: 1,
        organization: " X ",
        settings: {},
        limits: { providers: { instances: {} }, clients: [] },
      }),
    ).toEqual({ schemaVersion: 1, organization: "X" });
  });

  it("reads stored policies leniently", () => {
    expect(t3CodePolicyOrNull(null)).toBeNull();
    expect(t3CodePolicyOrNull("")).toBeNull();
    expect(t3CodePolicyOrNull("not json")).toBeNull();
    expect(t3CodePolicyOrNull(JSON.stringify(POLICY))?.organization).toBe("Example Corp");
  });

  it("counts what the policy manages", () => {
    expect(t3CodePolicyCounts(POLICY)).toEqual({
      lockedSettings: 1,
      defaultSettings: 1,
      limits: 4,
    });
  });

  it("names the policy in the setup plan", () => {
    expect(createT3CodeSetupPlan("codex", "t3-connect", POLICY).warnings.join(" ")).toContain(
      "managed by Example Corp",
    );
    expect(createT3CodeSetupPlan("codex").warnings.join(" ")).not.toContain("managed by");
  });
});

describe("installing the policy", () => {
  it("installs a checked policy before the service first starts", async () => {
    const command = buildT3CodeBootstrapCommand({ tool: "codex", policy: POLICY });
    const script = scriptBody(command);
    expect(script).toContain(serializeT3CodePolicy(POLICY));
    expect(script).toContain('t3 policy check "$policy_tmp"');
    expect(script).toContain(`install -m 644 "$policy_tmp" '${T3_CODE_POLICY_PATH}'`);
    expect(script).toContain("install_t3_policy || exit 1");
    // The server reads the policy only at startup.
    expect(script.indexOf("install_t3_policy || exit 1")).toBeLessThan(
      script.indexOf("install_t3_service\n"),
    );
    // After t3 itself, which does the checking.
    expect(script.indexOf("install_cli_command t3 t3")).toBeLessThan(
      script.indexOf("install_t3_policy || exit 1"),
    );
    await bashParses(command);
  });

  it("leaves the bootstrap alone without a policy", () => {
    expect(scriptBody(buildT3CodeBootstrapCommand({ tool: "codex" }))).not.toContain(
      "install_t3_policy",
    );
  });

  it("keeps quotes in the policy intact through the shell wrapper", async () => {
    const policy: T3CodePolicy = { schemaVersion: 1, organization: "O'Reilly $HOME `x`" };
    const command = buildT3CodeBootstrapCommand({ tool: "codex", policy });
    expect(scriptBody(command)).toContain('"organization": "O\'Reilly $HOME `x`"');
    await bashParses(command);
  });

  it("re-applies the current policy before Authorize server restarts T3 Code", async () => {
    const command = buildT3CodeConnectCommand({ tool: "codex", policy: POLICY });
    const script = scriptBody(command);
    expect(script).toContain("Step 1/5");
    expect(script).toContain("Apply the managed T3 Code policy");
    expect(script.indexOf("if install_t3_policy; then")).toBeLessThan(
      script.indexOf("restart_t3_service\n"),
    );
    expect(script).toContain("t3 policy show || true");
    await bashParses(command);
  });

  it("removes only a policy Infrawrench installed when the organization drops it", async () => {
    const command = buildT3CodeConnectCommand({ tool: "codex", policy: null });
    const script = scriptBody(command);
    expect(script).toContain("Step 1/4");
    expect(script).toContain(`if [ -f '${T3_CODE_POLICY_MARKER_PATH}' ]; then`);
    expect(script.indexOf("remove_t3_policy\n")).toBeLessThan(
      script.indexOf("restart_t3_service\n"),
    );
    await bashParses(command);
  });

  it("does not touch the policy when none is passed", () => {
    const script = scriptBody(buildT3CodeConnectCommand({ tool: "codex" }));
    expect(script).not.toContain("t3_policy");
  });
});

describe("rolling the policy out to existing servers", () => {
  it("installs, restarts and reports what the server loaded", async () => {
    const command = buildT3CodePolicyApplyCommand({ policy: POLICY, restart: true });
    const script = scriptBody(command);
    expect(command.startsWith("timeout 180s bash -lc ")).toBe(true);
    expect(script).toContain(`install_t3_policy || exit ${T3_CODE_POLICY_APPLY_EXIT.notInstalled}`);
    expect(script.indexOf("install_t3_policy ||")).toBeLessThan(
      script.indexOf("systemctl --user restart t3code.service"),
    );
    expect(script).toContain("t3 policy show || true");
    await bashParses(command);
  });

  it("installs without restarting when the change waits for the next restart", async () => {
    const command = buildT3CodePolicyApplyCommand({ policy: POLICY, restart: false });
    const script = scriptBody(command);
    expect(script).toContain("install_t3_policy ||");
    expect(script).not.toContain("systemctl");
    await bashParses(command);
  });

  it("removes only what Infrawrench installed when the policy is dropped", async () => {
    const command = buildT3CodePolicyApplyCommand({ policy: null, restart: true });
    const script = scriptBody(command);
    expect(script).toContain("remove_t3_policy\n");
    expect(script).toContain(`if [ -f '${T3_CODE_POLICY_MARKER_PATH}' ]; then`);
    expect(script).not.toContain("install_t3_policy");
    await bashParses(command);
  });

  it("explains each failure from its exit code", () => {
    expect(t3CodePolicyApplyFailure(T3_CODE_POLICY_APPLY_EXIT.noCli, "")).toMatch(/not installed/);
    expect(
      t3CodePolicyApplyFailure(
        T3_CODE_POLICY_APPLY_EXIT.notInstalled,
        "check output\nUnknown key x\n",
      ),
    ).toBe("Unknown key x");
    expect(t3CodePolicyApplyFailure(124, "")).toMatch(/in time/);
  });

  it("compares policies regardless of key order", () => {
    const reordered = JSON.parse(
      JSON.stringify({ limits: POLICY.limits, organization: POLICY.organization, ...POLICY }),
    ) as T3CodePolicy;
    expect(sameT3CodePolicy(POLICY, reordered)).toBe(true);
    expect(sameT3CodePolicy(POLICY, { ...POLICY, organization: "Other" })).toBe(false);
    expect(sameT3CodePolicy(null, undefined)).toBe(true);
    expect(sameT3CodePolicy(POLICY, null)).toBe(false);
  });

  describe("which servers a rollout touches", () => {
    const server = {
      tool: "codex" as const,
      t3Access: "t3-connect",
      t3Policy: null,
      t3PolicyRestartPending: false,
      setupComplete: true,
    };

    it("dials a server whose policy is out of date", () => {
      expect(planT3CodePolicyRollout(server, POLICY, false)).toEqual({ kind: "run" });
      expect(planT3CodePolicyRollout({ ...server, t3Policy: POLICY }, null, true)).toEqual({
        kind: "run",
      });
    });

    it("leaves a server that already has the policy", () => {
      expect(planT3CodePolicyRollout({ ...server, t3Policy: POLICY }, POLICY, true)).toEqual({
        kind: "none",
        outcome: "unchanged",
      });
    });

    it("restarts a server that has the file but not yet the policy", () => {
      const pending = { ...server, t3Policy: POLICY, t3PolicyRestartPending: true };
      expect(planT3CodePolicyRollout(pending, POLICY, true)).toEqual({ kind: "run" });
      expect(planT3CodePolicyRollout(pending, POLICY, false)).toMatchObject({
        outcome: "unchanged",
      });
    });

    it("skips a server the policy does not fit, saying why", () => {
      const step = planT3CodePolicyRollout(
        server,
        { ...POLICY, limits: { providers: { allowedDrivers: ["claudeAgent"] } } },
        true,
      );
      expect(step).toMatchObject({ kind: "none", outcome: "skipped" });
      expect(step.kind === "none" && step.message).toBeTruthy();
    });

    it("only records the policy on a server still setting up", () => {
      expect(planT3CodePolicyRollout({ ...server, setupComplete: false }, POLICY, true)).toEqual({
        kind: "snapshot",
        outcome: "setting-up",
      });
    });
  });
});
