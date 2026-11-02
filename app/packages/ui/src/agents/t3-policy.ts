/**
 * T3 Code managed policy (https://github.com/pingdotgg/t3code/blob/main/docs/user/managed-policy.md)
 * for the T3 Code servers the Agents feature provisions.
 *
 * A managed policy is a machine-wide JSON document an administrator deploys
 * so the T3 Code server on that machine enforces defaults, locks and limits
 * for every client that connects (desktop, browser, mobile, MCP agents,
 * scheduled tasks). On Linux it lives at `/etc/t3code/policy.json`, and the
 * server reads it only when it starts.
 *
 * Infrawrench keeps one policy per organization, in the agent defaults, and
 * installs it on every T3 Code VM: the bootstrap writes it before the service
 * first starts, and Authorize server re-applies the organization's current
 * policy before restarting the service, which is how an edited policy reaches
 * servers that already exist.
 *
 * The shape mirrors upstream's `ManagedPolicyDocument`
 * (`packages/contracts/src/managedPolicy.ts`). T3 Code decodes it with excess
 * properties rejected and **refuses to start** on anything it cannot fully
 * enforce, so the validation here is strict on structure too: an unknown key
 * caught at save time is a server that still boots. `t3 policy check` on the
 * VM remains the authority; this is the early, explainable copy of it, plus
 * the rules that only matter on an Infrawrench VM (which clients must stay
 * allowed for the server to be reachable at all).
 *
 * React/DOM/Node free: the web API validates and the bootstrap embeds it.
 */
import { shellQuote } from "./launch-command.js";
import type { AgentTool, T3CodeAccess } from "./types.js";

/** Where the Linux T3 Code server reads its managed policy. */
export const T3_CODE_POLICY_PATH = "/etc/t3code/policy.json";

/**
 * Sidecar recording that Infrawrench wrote the policy file, so Authorize
 * server only ever removes a policy it installed itself. The policy document
 * cannot carry the marker: T3 Code rejects unknown keys.
 */
export const T3_CODE_POLICY_MARKER_PATH = "/etc/t3code/.infrawrench-managed";

/** Policies are small; anything near this is a mistake, not a policy. */
export const T3_CODE_POLICY_MAX_BYTES = 64 * 1024;

/** Runtime modes, narrowest first (upstream `RuntimeMode`). */
export const T3_CODE_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export type T3CodeRuntimeMode = (typeof T3_CODE_RUNTIME_MODES)[number];

/** How the server may run (upstream `ManagedPolicyClient`). */
export const T3_CODE_POLICY_CLIENTS = ["desktop", "local-browser", "remote"] as const;
export type T3CodePolicyClient = (typeof T3_CODE_POLICY_CLIENTS)[number];

/**
 * Provider driver ids `providers.allowedDrivers` and `providers.instances`
 * accept, with the names T3 Code shows for them. `t3 policy check` rejects
 * an id the installed version does not know.
 */
export const T3_CODE_PROVIDER_DRIVERS = [
  { id: "codex", label: "Codex" },
  { id: "claudeAgent", label: "Claude" },
  { id: "cursor", label: "Cursor" },
  { id: "grok", label: "Grok" },
  { id: "opencode", label: "OpenCode" },
  { id: "antigravity", label: "Antigravity" },
  { id: "fx", label: "fx" },
  { id: "pi", label: "Pi" },
  { id: "muse", label: "Muse Code" },
  { id: "acpRegistry", label: "ACP Registry" },
] as const;
export type T3CodeProviderDriver = (typeof T3_CODE_PROVIDER_DRIVERS)[number]["id"];

export interface T3CodePolicySetting {
  value: unknown;
  /** `false` sets a default users can change; `true` pins the value. */
  locked: boolean;
}

export interface T3CodePolicyEnvironmentVariable {
  name: string;
  value: string;
}

/** Fields pinned on every instance of one provider driver. */
export interface T3CodePolicyProviderInstance {
  /** `true`: users cannot change these fields. `false`: they fill only what users left empty. */
  locked: boolean;
  environment?: T3CodePolicyEnvironmentVariable[];
  binaryPath?: string;
  launchArgs?: string;
}

export interface T3CodePolicyUpdates {
  mode: "auto" | "off";
  /** Desktop app only: the `t3` server on a VM updates through npm. */
  feedUrl?: string;
  allowNightly?: boolean;
}

export interface T3CodePolicyLimits {
  maxRuntimeMode?: T3CodeRuntimeMode;
  clients?: T3CodePolicyClient[];
  connect?: boolean;
  webhookTasks?: boolean;
  telemetry?: boolean;
  browserCookieImport?: boolean;
  providers?: {
    allowedDrivers?: string[];
    instances?: Record<string, T3CodePolicyProviderInstance>;
  };
  updates?: T3CodePolicyUpdates;
}

/** The document written to {@link T3_CODE_POLICY_PATH}. */
export interface T3CodePolicy {
  schemaVersion: 1;
  /** Shown to users as "Managed by <organization>". */
  organization: string;
  supportUrl?: string;
  /** Keyed by the setting's dot path in the server's `settings.json`. */
  settings?: Record<string, T3CodePolicySetting>;
  limits?: T3CodePolicyLimits;
}

/**
 * A setting T3 Code exposes that the policy editor offers with a picker, so
 * nobody has to dig the path out of `settings.json`. Anything else is still
 * reachable as a custom path.
 */
export type T3CodePolicySettingKind =
  | { kind: "boolean" }
  | { kind: "enum"; options: readonly string[] }
  | { kind: "string" }
  | { kind: "days"; min: number; max: number };

export interface T3CodePolicyKnownSetting {
  path: string;
  type: T3CodePolicySettingKind;
}

/** Retention in days; `null` keeps forever (upstream `StorageRetentionDays`). */
const RETENTION_DAYS = { kind: "days", min: 1, max: 3650 } as const;

export const T3_CODE_POLICY_KNOWN_SETTINGS: readonly T3CodePolicyKnownSetting[] = [
  { path: "defaultRuntimeMode", type: { kind: "enum", options: T3_CODE_RUNTIME_MODES } },
  { path: "enableAgentBrowserAccess", type: { kind: "boolean" } },
  { path: "enableAgentDeviceAccess", type: { kind: "boolean" } },
  { path: "guestSharingEnabled", type: { kind: "boolean" } },
  { path: "linkedEnvironmentsEnabled", type: { kind: "boolean" } },
  { path: "enableProviderUpdateChecks", type: { kind: "boolean" } },
  { path: "continueThreadsAfterServerUpdate", type: { kind: "boolean" } },
  { path: "defaultAutoPull", type: { kind: "boolean" } },
  { path: "newWorktreesStartFromOrigin", type: { kind: "boolean" } },
  { path: "removeAgentCreditsOnMerge", type: { kind: "boolean" } },
  { path: "reviewGuidesEnabled", type: { kind: "boolean" } },
  {
    path: "idleCompaction",
    type: { kind: "enum", options: ["onReturn", "beforeCacheExpires", "off"] },
  },
  { path: "responseStreamingMode", type: { kind: "enum", options: ["turn", "paragraph"] } },
  { path: "branchNamingMode", type: { kind: "enum", options: ["static", "semantic", "custom"] } },
  { path: "branchNamePrefix", type: { kind: "string" } },
  { path: "threadTitleInstructions", type: { kind: "string" } },
  { path: "branchNameInstructions", type: { kind: "string" } },
  { path: "storageCleanup.logsAfterDays", type: RETENTION_DAYS },
  { path: "storageCleanup.browserArtifactsAfterDays", type: RETENTION_DAYS },
];

/** Per-project stores; T3 Code refuses them, a lock on the top-level key reaches every project. */
const UNMANAGEABLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "projectSettingsOverrides",
  "projectAgentBrowserAccessOverrides",
  "projectAutoPullOverrides",
  "projectScriptOverrides",
]);

/** Upstream `ENVIRONMENT_VARIABLE_NAME_PATTERN` and its 128-character cap. */
const ENVIRONMENT_VARIABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX = 128;

/** Names that usually carry a credential, which every user on the VM could then read. */
const SECRET_LOOKING_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export type T3CodePolicyIssueCode =
  | "not-an-object"
  | "too-large"
  | "unknown-key"
  | "wrong-type"
  | "schema-version"
  | "organization-required"
  | "empty-string"
  | "https-required"
  | "empty-list"
  | "unknown-runtime-mode"
  | "unknown-client"
  | "unknown-driver"
  | "duplicate"
  | "invalid-env-name"
  | "updates-mode-required"
  | "invalid-setting-path"
  | "unmanageable-setting"
  | "derived-setting"
  | "worktree-lock-incomplete"
  | "provider-instance-field-lock"
  | "provider-instance-default"
  | "setting-value-required"
  | "setting-value-type"
  | "default-above-max-runtime-mode"
  | "remote-client-required"
  | "connect-off-with-t3-connect"
  | "tool-driver-not-allowed"
  | "codex-not-allowed"
  | "secret-in-policy"
  | "feed-url-desktop-only";

export interface T3CodePolicyIssue {
  level: "error" | "warning";
  code: T3CodePolicyIssueCode;
  /** Dot path into the policy document the issue is about. */
  path: string;
  /** English explanation; the editor shows a translated one keyed by `code`. */
  message: string;
  /** Extra values for the message (the offending key, the expected type). */
  detail?: string;
}

/** What the policy is checked against: the server it will be installed on. */
export interface T3CodePolicyContext {
  /** The session's provider CLI; the policy must let it run. */
  tool?: AgentTool;
  /**
   * How the server is reached; T3 Connect access needs `connect` left on.
   * Omitted (a policy checked on its own) skips that rule.
   */
  access?: T3CodeAccess;
}

export interface T3CodePolicyValidation {
  /** The parsed policy, or null when it is not a policy at all. */
  policy: T3CodePolicy | null;
  issues: T3CodePolicyIssue[];
  /** No error-level issues. Warnings never block saving. */
  ok: boolean;
}

/** T3 Code's provider driver for each agent CLI Infrawrench installs. */
export function t3CodeDriverForTool(tool: AgentTool): T3CodeProviderDriver {
  return tool === "claude-code" ? "claudeAgent" : "codex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimeModeRank(mode: string): number {
  return (T3_CODE_RUNTIME_MODES as readonly string[]).indexOf(mode);
}

const KNOWN_DRIVER_IDS: ReadonlySet<string> = new Set(T3_CODE_PROVIDER_DRIVERS.map((d) => d.id));

/** The catalog entry for a setting path, if the editor offers a picker for it. */
export function t3CodeKnownSetting(path: string): T3CodePolicyKnownSetting | undefined {
  return T3_CODE_POLICY_KNOWN_SETTINGS.find((s) => s.path === path);
}

/**
 * Parse and check a policy. Structure is checked the way T3 Code decodes it
 * (unknown keys are errors, because T3 Code refuses to start on them), then
 * the semantic rules upstream documents, then the rules for this server.
 */
export function validateT3CodePolicy(
  raw: unknown,
  context: T3CodePolicyContext = {},
): T3CodePolicyValidation {
  const issues: T3CodePolicyIssue[] = [];
  const error = (
    code: T3CodePolicyIssueCode,
    path: string,
    message: string,
    detail?: string,
  ): void => {
    issues.push({ level: "error", code, path, message, ...(detail ? { detail } : {}) });
  };
  const warn = (
    code: T3CodePolicyIssueCode,
    path: string,
    message: string,
    detail?: string,
  ): void => {
    issues.push({ level: "warning", code, path, message, ...(detail ? { detail } : {}) });
  };
  const done = (policy: T3CodePolicy | null): T3CodePolicyValidation => ({
    policy,
    issues,
    ok: policy !== null && !issues.some((i) => i.level === "error"),
  });

  if (!isRecord(raw)) {
    error("not-an-object", "", "The policy must be a JSON object.");
    return done(null);
  }
  if (JSON.stringify(raw).length > T3_CODE_POLICY_MAX_BYTES) {
    error("too-large", "", "The policy is larger than 64 KB.");
    return done(null);
  }

  const onlyKeys = (value: Record<string, unknown>, path: string, allowed: readonly string[]) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        error(
          "unknown-key",
          path ? `${path}.${key}` : key,
          `T3 Code does not know "${key}" here and would refuse to start.`,
          key,
        );
      }
    }
  };
  const optionalString = (value: unknown, path: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      error("wrong-type", path, `${path} must be text.`, "string");
      return undefined;
    }
    if (!value.trim()) error("empty-string", path, `${path} cannot be empty.`);
    return value;
  };
  const optionalBoolean = (value: unknown, path: string): boolean | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      error("wrong-type", path, `${path} must be true or false.`, "boolean");
      return undefined;
    }
    return value;
  };

  onlyKeys(raw, "", ["schemaVersion", "organization", "supportUrl", "settings", "limits"]);
  if (raw["schemaVersion"] !== 1) {
    error("schema-version", "schemaVersion", "schemaVersion must be 1.");
  }
  const organization = typeof raw["organization"] === "string" ? raw["organization"] : "";
  if (!organization.trim()) {
    error("organization-required", "organization", "Name the organization users see.");
  }
  const policy: T3CodePolicy = { schemaVersion: 1, organization };
  const supportUrl = optionalString(raw["supportUrl"], "supportUrl");
  if (supportUrl !== undefined) policy.supportUrl = supportUrl;

  // ── limits ────────────────────────────────────────────────────────────
  const rawLimits = raw["limits"];
  if (rawLimits !== undefined) {
    if (!isRecord(rawLimits)) {
      error("wrong-type", "limits", "limits must be an object.", "object");
    } else {
      onlyKeys(rawLimits, "limits", [
        "maxRuntimeMode",
        "clients",
        "connect",
        "webhookTasks",
        "telemetry",
        "browserCookieImport",
        "providers",
        "updates",
      ]);
      const limits: T3CodePolicyLimits = {};
      const maxRuntimeMode = rawLimits["maxRuntimeMode"];
      if (maxRuntimeMode !== undefined) {
        if (typeof maxRuntimeMode !== "string" || runtimeModeRank(maxRuntimeMode) < 0) {
          error(
            "unknown-runtime-mode",
            "limits.maxRuntimeMode",
            `maxRuntimeMode must be one of ${T3_CODE_RUNTIME_MODES.join(", ")}.`,
          );
        } else {
          limits.maxRuntimeMode = maxRuntimeMode as T3CodeRuntimeMode;
        }
      }
      const clients = rawLimits["clients"];
      if (clients !== undefined) {
        if (!Array.isArray(clients)) {
          error("wrong-type", "limits.clients", "clients must be a list.", "array");
        } else if (clients.length === 0) {
          error("empty-list", "limits.clients", "clients cannot be empty; leave it out instead.");
        } else {
          const seen = new Set<string>();
          for (const client of clients) {
            if (
              typeof client !== "string" ||
              !(T3_CODE_POLICY_CLIENTS as readonly string[]).includes(client)
            ) {
              error(
                "unknown-client",
                "limits.clients",
                `Unknown client "${String(client)}".`,
                String(client),
              );
            } else if (seen.has(client)) {
              error("duplicate", "limits.clients", `"${client}" is listed twice.`, client);
            }
            if (typeof client === "string") seen.add(client);
          }
          limits.clients = clients.filter((c): c is T3CodePolicyClient =>
            (T3_CODE_POLICY_CLIENTS as readonly string[]).includes(c as string),
          );
        }
      }
      for (const key of ["connect", "webhookTasks", "telemetry", "browserCookieImport"] as const) {
        const value = optionalBoolean(rawLimits[key], `limits.${key}`);
        if (value !== undefined) limits[key] = value;
      }

      const rawProviders = rawLimits["providers"];
      if (rawProviders !== undefined) {
        if (!isRecord(rawProviders)) {
          error("wrong-type", "limits.providers", "providers must be an object.", "object");
        } else {
          onlyKeys(rawProviders, "limits.providers", ["allowedDrivers", "instances"]);
          const providers: NonNullable<T3CodePolicyLimits["providers"]> = {};
          const allowed = rawProviders["allowedDrivers"];
          if (allowed !== undefined) {
            if (!Array.isArray(allowed)) {
              error(
                "wrong-type",
                "limits.providers.allowedDrivers",
                "allowedDrivers must be a list.",
                "array",
              );
            } else if (allowed.length === 0) {
              error(
                "empty-list",
                "limits.providers.allowedDrivers",
                "allowedDrivers cannot be empty; leave it out to allow every provider.",
              );
            } else {
              const seen = new Set<string>();
              for (const driver of allowed) {
                if (typeof driver !== "string" || !KNOWN_DRIVER_IDS.has(driver)) {
                  error(
                    "unknown-driver",
                    "limits.providers.allowedDrivers",
                    `Unknown provider "${String(driver)}".`,
                    String(driver),
                  );
                } else if (seen.has(driver)) {
                  error(
                    "duplicate",
                    "limits.providers.allowedDrivers",
                    `"${driver}" is listed twice.`,
                    driver,
                  );
                }
                if (typeof driver === "string") seen.add(driver);
              }
              providers.allowedDrivers = allowed.filter((d): d is string => typeof d === "string");
            }
          }
          const rawInstances = rawProviders["instances"];
          if (rawInstances !== undefined) {
            if (!isRecord(rawInstances)) {
              error(
                "wrong-type",
                "limits.providers.instances",
                "instances must be an object keyed by provider.",
                "object",
              );
            } else {
              const instances: Record<string, T3CodePolicyProviderInstance> = {};
              for (const [driver, rawInstance] of Object.entries(rawInstances)) {
                const path = `limits.providers.instances.${driver}`;
                if (!KNOWN_DRIVER_IDS.has(driver)) {
                  error("unknown-driver", path, `Unknown provider "${driver}".`, driver);
                }
                if (!isRecord(rawInstance)) {
                  error("wrong-type", path, `${path} must be an object.`, "object");
                  continue;
                }
                onlyKeys(rawInstance, path, ["locked", "environment", "binaryPath", "launchArgs"]);
                const locked = rawInstance["locked"];
                if (typeof locked !== "boolean") {
                  error("wrong-type", `${path}.locked`, `${path}.locked must be true or false.`);
                }
                const instance: T3CodePolicyProviderInstance = { locked: locked === true };
                const binaryPath = optionalString(rawInstance["binaryPath"], `${path}.binaryPath`);
                if (binaryPath !== undefined) instance.binaryPath = binaryPath;
                const launchArgs = optionalString(rawInstance["launchArgs"], `${path}.launchArgs`);
                if (launchArgs !== undefined) instance.launchArgs = launchArgs;
                const rawEnv = rawInstance["environment"];
                if (rawEnv !== undefined) {
                  if (!Array.isArray(rawEnv)) {
                    error(
                      "wrong-type",
                      `${path}.environment`,
                      "environment must be a list.",
                      "array",
                    );
                  } else {
                    const env: T3CodePolicyEnvironmentVariable[] = [];
                    const names = new Set<string>();
                    rawEnv.forEach((entry, index) => {
                      const entryPath = `${path}.environment.${index}`;
                      if (!isRecord(entry)) {
                        error("wrong-type", entryPath, "Each variable needs a name and a value.");
                        return;
                      }
                      onlyKeys(entry, entryPath, ["name", "value"]);
                      const name = typeof entry["name"] === "string" ? entry["name"].trim() : "";
                      const value = entry["value"];
                      if (
                        !ENVIRONMENT_VARIABLE_NAME.test(name) ||
                        name.length > ENVIRONMENT_VARIABLE_NAME_MAX
                      ) {
                        error(
                          "invalid-env-name",
                          `${entryPath}.name`,
                          `"${name}" is not a valid environment variable name.`,
                          name,
                        );
                      } else if (names.has(name)) {
                        error("duplicate", `${entryPath}.name`, `${name} is set twice.`, name);
                      }
                      names.add(name);
                      if (typeof value !== "string") {
                        error("wrong-type", `${entryPath}.value`, `${name} needs a text value.`);
                        return;
                      }
                      if (SECRET_LOOKING_NAME.test(name) && value.trim()) {
                        warn(
                          "secret-in-policy",
                          `${entryPath}.value`,
                          `${name} looks like a credential. Every user on the server can read the policy.`,
                          name,
                        );
                      }
                      env.push({ name, value });
                    });
                    instance.environment = env;
                  }
                }
                instances[driver] = instance;
              }
              providers.instances = instances;
            }
          }
          limits.providers = providers;
        }
      }

      const rawUpdates = rawLimits["updates"];
      if (rawUpdates !== undefined) {
        if (!isRecord(rawUpdates)) {
          error("wrong-type", "limits.updates", "updates must be an object.", "object");
        } else {
          onlyKeys(rawUpdates, "limits.updates", ["mode", "feedUrl", "allowNightly"]);
          const mode = rawUpdates["mode"];
          if (mode !== "auto" && mode !== "off") {
            error(
              "updates-mode-required",
              "limits.updates.mode",
              'updates.mode must be "auto" or "off".',
            );
          }
          const updates: T3CodePolicyUpdates = { mode: mode === "off" ? "off" : "auto" };
          const feedUrl = optionalString(rawUpdates["feedUrl"], "limits.updates.feedUrl");
          if (feedUrl !== undefined) {
            if (!/^https:\/\/[^\s/]+/i.test(feedUrl.trim())) {
              error("https-required", "limits.updates.feedUrl", "feedUrl must be an https URL.");
            }
            warn(
              "feed-url-desktop-only",
              "limits.updates.feedUrl",
              "Only the T3 Code desktop app reads feedUrl; the server on an agent VM updates through npm.",
            );
            updates.feedUrl = feedUrl;
          }
          const allowNightly = optionalBoolean(
            rawUpdates["allowNightly"],
            "limits.updates.allowNightly",
          );
          if (allowNightly !== undefined) updates.allowNightly = allowNightly;
          limits.updates = updates;
        }
      }
      policy.limits = limits;
    }
  }

  // ── settings ──────────────────────────────────────────────────────────
  const rawSettings = raw["settings"];
  if (rawSettings !== undefined) {
    if (!isRecord(rawSettings)) {
      error("wrong-type", "settings", "settings must be an object keyed by setting path.");
    } else {
      const settings: Record<string, T3CodePolicySetting> = {};
      for (const [settingPath, rawSetting] of Object.entries(rawSettings)) {
        const path = `settings.${settingPath}`;
        if (!isRecord(rawSetting)) {
          error("wrong-type", path, `${settingPath} needs a value and locked.`);
          continue;
        }
        onlyKeys(rawSetting, path, ["value", "locked"]);
        if (typeof rawSetting["locked"] !== "boolean") {
          error("wrong-type", `${path}.locked`, `${settingPath}.locked must be true or false.`);
        }
        if (!("value" in rawSetting) || rawSetting["value"] === undefined) {
          error("setting-value-required", path, `${settingPath} needs a value.`);
        }
        settings[settingPath] = {
          value: rawSetting["value"],
          locked: rawSetting["locked"] === true,
        };
      }
      checkSettings(settings, error);
      policy.settings = settings;
    }
  }

  // ── cross-field and server rules ──────────────────────────────────────
  const limits = policy.limits;
  const maxMode = limits?.maxRuntimeMode;
  const defaultMode = policy.settings?.["defaultRuntimeMode"]?.value;
  if (
    maxMode &&
    typeof defaultMode === "string" &&
    runtimeModeRank(defaultMode) > runtimeModeRank(maxMode)
  ) {
    error(
      "default-above-max-runtime-mode",
      "settings.defaultRuntimeMode",
      "The default permission mode cannot be broader than the maximum.",
    );
  }
  if (limits?.clients && !limits.clients.includes("remote")) {
    // Without `remote` the server binds loopback only, creates no pairing
    // links, turns T3 Connect off and tears down Tailscale Serve routes to
    // itself: a VM nobody can reach.
    error(
      "remote-client-required",
      "limits.clients",
      "An agent VM is only reachable remotely, so clients must include remote.",
    );
  }
  if (context.access === "t3-connect" && limits?.connect === false) {
    error(
      "connect-off-with-t3-connect",
      "limits.connect",
      "This server is reached through T3 Connect, which the policy turns off.",
    );
  }
  const allowedDrivers = limits?.providers?.allowedDrivers;
  if (allowedDrivers && context.tool) {
    const driver = t3CodeDriverForTool(context.tool);
    if (!allowedDrivers.includes(driver)) {
      error(
        "tool-driver-not-allowed",
        "limits.providers.allowedDrivers",
        `The policy does not allow ${context.tool === "claude-code" ? "Claude" : "Codex"}, the provider this server runs.`,
        driver,
      );
    }
  }
  if (allowedDrivers && !allowedDrivers.includes("codex")) {
    warn(
      "codex-not-allowed",
      "limits.providers.allowedDrivers",
      "T3 Code generates thread titles with Codex by default; without it, set textGenerationModelSelection to an allowed provider.",
    );
  }

  return done(policy);
}

type ErrorSink = (
  code: T3CodePolicyIssueCode,
  path: string,
  message: string,
  detail?: string,
) => void;

/** The `settings` rules upstream documents ("A few settings need care"). */
function checkSettings(settings: Record<string, T3CodePolicySetting>, error: ErrorSink): void {
  for (const [settingPath, setting] of Object.entries(settings)) {
    const path = `settings.${settingPath}`;
    const segments = settingPath.split(".");
    if (!settingPath || segments.some((s) => !s || /\s/.test(s))) {
      error("invalid-setting-path", path, `"${settingPath}" is not a setting path.`, settingPath);
      continue;
    }
    const head = segments[0]!;
    if (UNMANAGEABLE_SETTING_KEYS.has(head)) {
      error(
        "unmanageable-setting",
        path,
        `${head} holds per-project values and cannot be managed; manage the top-level setting instead.`,
        head,
      );
    }
    if (head === "compactIdleThreads") {
      error("derived-setting", path, "Manage idleCompaction, not the older compactIdleThreads.");
    }
    if (head === "providerInstances") {
      if (segments.length > 2) {
        error(
          "provider-instance-field-lock",
          path,
          "Lock a provider instance as a whole (providerInstances.<id>), or pin single fields under limits.providers.instances.",
        );
      } else if (!setting.locked) {
        error(
          "provider-instance-default",
          path,
          "A default cannot add a provider instance, because users could never remove it. Lock it instead.",
        );
      }
    }
    if (
      setting.locked &&
      (settingPath === "storageCleanup" || settingPath.startsWith("storageCleanup.worktree")) &&
      settings["worktreeCleanup"]?.locked !== true
    ) {
      error(
        "worktree-lock-incomplete",
        path,
        "worktreeCleanup overrides the worktree cleanup rules, so lock it along with them.",
      );
    }
    const known = t3CodeKnownSetting(settingPath);
    if (known && setting.value !== undefined && !matchesKnownType(setting.value, known.type)) {
      error(
        "setting-value-type",
        path,
        `${settingPath} has a value of the wrong type.`,
        known.type.kind,
      );
    }
  }
}

function matchesKnownType(value: unknown, type: T3CodePolicySettingKind): boolean {
  switch (type.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && type.options.includes(value);
    case "string":
      return typeof value === "string";
    case "days":
      return (
        value === null ||
        (typeof value === "number" &&
          Number.isInteger(value) &&
          value >= type.min &&
          value <= type.max)
      );
  }
}

/** The policy, or null for anything stored that is not one (old rows, bad JSON). */
export function t3CodePolicyOrNull(raw: unknown): T3CodePolicy | null {
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      return t3CodePolicyOrNull(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (!isRecord(raw)) return null;
  return validateT3CodePolicy(raw).policy;
}

/** A starting policy for the editor: just the required keys. */
export function emptyT3CodePolicy(organization = ""): T3CodePolicy {
  return { schemaVersion: 1, organization };
}

/**
 * Drop empty containers so the written document says only what the
 * administrator chose. Leaving `limits: {}` in is harmless to T3 Code but
 * reads as a policy that limits something.
 */
export function compactT3CodePolicy(policy: T3CodePolicy): T3CodePolicy {
  const out: T3CodePolicy = { schemaVersion: 1, organization: policy.organization.trim() };
  if (policy.supportUrl?.trim()) out.supportUrl = policy.supportUrl.trim();
  if (policy.settings && Object.keys(policy.settings).length > 0) out.settings = policy.settings;
  const limits = policy.limits;
  if (limits) {
    const next: T3CodePolicyLimits = { ...limits };
    if (next.providers) {
      const providers = { ...next.providers };
      if (providers.allowedDrivers && providers.allowedDrivers.length === 0) {
        delete providers.allowedDrivers;
      }
      if (providers.instances && Object.keys(providers.instances).length === 0) {
        delete providers.instances;
      }
      if (Object.keys(providers).length === 0) delete next.providers;
      else next.providers = providers;
    }
    if (next.clients && next.clients.length === 0) delete next.clients;
    for (const key of Object.keys(next) as Array<keyof T3CodePolicyLimits>) {
      if (next[key] === undefined) delete next[key];
    }
    if (Object.keys(next).length > 0) out.limits = next;
  }
  return out;
}

/** The exact bytes written to the VM. */
export function serializeT3CodePolicy(policy: T3CodePolicy): string {
  return `${JSON.stringify(compactT3CodePolicy(policy), null, 2)}\n`;
}

/** One-line description for the config menu and session rows. */
export function t3CodePolicyCounts(policy: T3CodePolicy): {
  lockedSettings: number;
  defaultSettings: number;
  limits: number;
} {
  const settings = Object.values(policy.settings ?? {});
  return {
    lockedSettings: settings.filter((s) => s.locked).length,
    defaultSettings: settings.filter((s) => !s.locked).length,
    limits: Object.keys(compactT3CodePolicy(policy).limits ?? {}).length,
  };
}

/**
 * Shell functions that install or remove the policy on the VM. The policy
 * directory is root's (T3 Code's docs: "writable only by administrators"),
 * so a non-root agent user goes through passwordless sudo, which agent VMs
 * that are not root already need for the Tailscale enrollment.
 *
 * `install_t3_policy` writes to a temporary file, runs `t3 policy check` on
 * it, and only then moves it into place: a policy T3 Code rejects would stop
 * the server from starting at all, which is a worse failure than the policy
 * not applying. It returns non-zero on a rejected policy so the bootstrap can
 * fail loudly; the interactive Authorize script reports it and moves on.
 */
export function buildT3CodePolicySnippet(policy: T3CodePolicy | null): string {
  const common = `
t3_policy_as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; else sudo -n "$@"; fi
}
`;
  if (!policy) {
    return `${common}
remove_t3_policy() {
  # Only a policy Infrawrench installed; one an administrator placed by hand stays.
  if [ -f ${shellQuote(T3_CODE_POLICY_MARKER_PATH)} ]; then
    t3_policy_as_root rm -f ${shellQuote(T3_CODE_POLICY_PATH)} ${shellQuote(T3_CODE_POLICY_MARKER_PATH)} || true
    printf 'Removed the managed policy Infrawrench installed earlier.\\n'
  fi
}
`;
  }
  const json = serializeT3CodePolicy(policy);
  return `${common}
install_t3_policy() {
  policy_tmp="$(mktemp)"
  cat > "$policy_tmp" <<'INFRAWRENCH_T3_POLICY'
${json}INFRAWRENCH_T3_POLICY
  if ! t3 policy check "$policy_tmp" >&2; then
    rm -f "$policy_tmp"
    echo "T3 Code rejected the organization's managed policy (t3 policy check above). Fix it in Infrawrench under Agents > T3 Code policy; T3 Code refuses to start with a policy it cannot enforce. A t3 older than managed policy has no 'policy' command: update it with 'npm install -g t3@latest'." >&2
    return 1
  fi
  if ! t3_policy_as_root install -d -m 755 ${shellQuote(T3_CODE_POLICY_PATH.replace(/\/[^/]+$/, ""))} ||
    ! t3_policy_as_root install -m 644 "$policy_tmp" ${shellQuote(T3_CODE_POLICY_PATH)}; then
    rm -f "$policy_tmp"
    echo "Could not write ${T3_CODE_POLICY_PATH}: it needs root or passwordless sudo." >&2
    return 1
  fi
  t3_policy_as_root touch ${shellQuote(T3_CODE_POLICY_MARKER_PATH)} || true
  rm -f "$policy_tmp"
  return 0
}
`;
}
