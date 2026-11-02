import { useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { Modal } from "../components/Modal.js";
import { formatErrorMessage } from "../utils.js";
import {
  compactT3CodePolicy,
  serializeT3CodePolicy,
  t3CodeDriverForTool,
  t3CodeKnownSetting,
  T3_CODE_POLICY_KNOWN_SETTINGS,
  T3_CODE_POLICY_PATH,
  T3_CODE_PROVIDER_DRIVERS,
  T3_CODE_RUNTIME_MODES,
  validateT3CodePolicy,
  type T3CodePolicy,
  type T3CodePolicyContext,
  type T3CodePolicyIssue,
  type T3CodePolicyClient,
  type T3CodePolicyLimits,
  type T3CodePolicyProviderInstance,
  type T3CodePolicySettingKind,
  type T3CodeRuntimeMode,
} from "./t3-policy.js";

type Gt = ReturnType<typeof useGT>;
/** A partial update where `undefined` means "clear this key". */
type Patch<T> = { [K in keyof T]?: T[K] | undefined };
type ProviderLimits = NonNullable<T3CodePolicyLimits["providers"]>;

interface SettingRow {
  id: number;
  path: string;
  value: unknown;
  locked: boolean;
  /** Custom paths: the JSON text as typed, and whether it parses. */
  raw?: string;
  rawError?: boolean;
}

interface T3CodePolicyEditorProps {
  /** The stored policy, or null to start a new one. */
  initial: T3CodePolicy | null;
  /** The server defaults the policy will be installed with. */
  context: T3CodePolicyContext;
  onSave: (policy: T3CodePolicy) => Promise<void>;
  /** Present when a policy is stored: removes it from the defaults. */
  onRemove?: () => Promise<void>;
  onClose: () => void;
}

const inputClass =
  "w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-on-surface placeholder:text-on-surface-faint";
const sectionTitle = "text-xs font-semibold uppercase tracking-wide text-on-surface-tertiary";

function runtimeModeLabel(mode: string, gt: Gt): string {
  switch (mode) {
    case "approval-required":
      return gt("Supervised");
    case "auto-accept-edits":
      return gt("Auto-accept edits");
    case "auto":
      return gt("Auto");
    case "full-access":
      return gt("Full access");
    default:
      return mode;
  }
}

function settingLabel(path: string, gt: Gt): string {
  switch (path) {
    case "defaultRuntimeMode":
      return gt("Default permission mode");
    case "enableAgentBrowserAccess":
      return gt("Agents can use the browser");
    case "enableAgentDeviceAccess":
      return gt("Agents can control devices");
    case "guestSharingEnabled":
      return gt("Guest links to threads");
    case "linkedEnvironmentsEnabled":
      return gt("Links to other machines");
    case "enableProviderUpdateChecks":
      return gt("Check providers for updates");
    case "continueThreadsAfterServerUpdate":
      return gt("Continue threads after a server update");
    case "defaultAutoPull":
      return gt("Pull projects automatically");
    case "newWorktreesStartFromOrigin":
      return gt("New worktrees start from origin");
    case "removeAgentCreditsOnMerge":
      return gt("Remove agent credits on merge");
    case "reviewGuidesEnabled":
      return gt("Review guides");
    case "idleCompaction":
      return gt("Compact idle threads");
    case "responseStreamingMode":
      return gt("Response streaming");
    case "branchNamingMode":
      return gt("Branch naming");
    case "branchNamePrefix":
      return gt("Branch name prefix");
    case "threadTitleInstructions":
      return gt("Thread title instructions");
    case "branchNameInstructions":
      return gt("Branch name instructions");
    case "storageCleanup.logsAfterDays":
      return gt("Delete logs after (days)");
    case "storageCleanup.browserArtifactsAfterDays":
      return gt("Delete browser artifacts after (days)");
    default:
      return path;
  }
}

function enumOptionLabel(path: string, value: string, gt: Gt): string {
  if (path === "defaultRuntimeMode") return runtimeModeLabel(value, gt);
  switch (`${path}:${value}`) {
    case "idleCompaction:onReturn":
      return gt("When you return");
    case "idleCompaction:beforeCacheExpires":
      return gt("Before the cache expires (beta)");
    case "idleCompaction:off":
      return gt("Never");
    case "responseStreamingMode:turn":
      return gt("Whole turn");
    case "responseStreamingMode:paragraph":
      return gt("By paragraph");
    case "branchNamingMode:static":
      return gt("Static");
    case "branchNamingMode:semantic":
      return gt("Semantic");
    case "branchNamingMode:custom":
      return gt("Custom");
    default:
      return value;
  }
}

/** Translated explanation for each validation issue (the module's own text is English). */
function issueText(issue: T3CodePolicyIssue, gt: Gt): string {
  const detail = issue.detail ?? "";
  const path = issue.path;
  switch (issue.code) {
    case "not-an-object":
      return gt("The policy must be a JSON object.");
    case "too-large":
      return gt("The policy is larger than 64 KB.");
    case "unknown-key":
      return gt('T3 Code does not know "{key}" at {path} and would refuse to start.', {
        key: detail,
        path,
      });
    case "wrong-type":
      return gt("{path} has the wrong type.", { path });
    case "schema-version":
      return gt("schemaVersion must be 1.");
    case "organization-required":
      return gt("Name the organization users see.");
    case "empty-string":
      return gt("{path} cannot be empty.", { path });
    case "https-required":
      return gt("The update feed must be an https URL.");
    case "empty-list":
      return gt("{path} cannot be an empty list.", { path });
    case "unknown-runtime-mode":
      return gt("Unknown permission mode.");
    case "unknown-client":
      return gt('Unknown client "{value}".', { value: detail });
    case "unknown-driver":
      return gt('Unknown provider "{value}".', { value: detail });
    case "duplicate":
      return gt("{value} is listed twice.", { value: detail });
    case "invalid-env-name":
      return gt('"{value}" is not a valid environment variable name.', { value: detail });
    case "updates-mode-required":
      return gt("Choose whether T3 Code checks for updates.");
    case "invalid-setting-path":
      return gt('"{value}" is not a setting path.', { value: detail });
    case "unmanageable-setting":
      return gt(
        "{value} holds per-project values and cannot be managed. Manage the top-level setting instead.",
        { value: detail },
      );
    case "derived-setting":
      return gt("Manage idleCompaction, not the older compactIdleThreads.");
    case "worktree-lock-incomplete":
      return gt(
        "worktreeCleanup overrides the worktree cleanup rules, so lock it along with them.",
      );
    case "provider-instance-field-lock":
      return gt(
        "Lock a provider instance as a whole, or pin single fields under Provider settings.",
      );
    case "provider-instance-default":
      return gt(
        "A default cannot add a provider instance, because users could never remove it. Lock it instead.",
      );
    case "setting-value-required":
      return gt("{path} needs a value.", { path });
    case "setting-value-type":
      return gt("{path} has a value of the wrong type.", { path });
    case "default-above-max-runtime-mode":
      return gt("The default permission mode cannot be broader than the maximum.");
    case "remote-client-required":
      return gt(
        "An agent VM is only reachable remotely, so remote clients must stay allowed or nobody can connect to it.",
      );
    case "connect-off-with-t3-connect":
      return gt(
        "These servers are reached through T3 Connect, which this policy turns off. Allow T3 Connect, or switch T3 Code access to Tailscale.",
      );
    case "tool-driver-not-allowed":
      return gt(
        "The policy does not allow the provider these servers run. Allow it, or change the Tool.",
      );
    case "codex-not-allowed":
      return gt(
        "T3 Code generates thread titles with Codex by default. Without Codex, set textGenerationModelSelection to an allowed provider.",
      );
    case "secret-in-policy":
      return gt(
        "{value} looks like a credential. Every user on the server can read the policy, so keep credentials out of it.",
        { value: detail },
      );
    case "feed-url-desktop-only":
      return gt(
        "Only the T3 Code desktop app reads the update feed; the server on an agent VM updates through npm.",
      );
  }
}

function rowsFromPolicy(policy: T3CodePolicy | null): SettingRow[] {
  return Object.entries(policy?.settings ?? {}).map(([path, setting], index) => {
    const known = t3CodeKnownSetting(path);
    return {
      id: index + 1,
      path,
      value: setting.value,
      locked: setting.locked,
      ...(known ? {} : { raw: JSON.stringify(setting.value ?? null, null, 2) }),
    };
  });
}

function defaultValueFor(type: T3CodePolicySettingKind): unknown {
  switch (type.kind) {
    case "boolean":
      return false;
    case "enum":
      return type.options[0];
    case "string":
      return "";
    case "days":
      return 30;
  }
}

/**
 * Editor for the organization's T3 Code managed policy: a form with a picker
 * for every documented limit and the common settings, and a JSON view for
 * anything else T3 Code accepts. Validation runs the same checks the server
 * enforces on save, against the agent defaults the policy will ship with.
 */
export function T3CodePolicyEditor({
  initial,
  context,
  onSave,
  onRemove,
  onClose,
}: T3CodePolicyEditorProps) {
  const gt = useGT();
  const [organization, setOrganization] = useState(initial?.organization ?? "");
  const [supportUrl, setSupportUrl] = useState(initial?.supportUrl ?? "");
  const [limits, setLimits] = useState<T3CodePolicyLimits>(initial?.limits ?? {});
  const [rows, setRows] = useState<SettingRow[]>(() => rowsFromPolicy(initial));
  const [nextRowId, setNextRowId] = useState(() => rows.length + 1);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formPolicy = useMemo<T3CodePolicy>(() => {
    const settings: NonNullable<T3CodePolicy["settings"]> = {};
    for (const row of rows) settings[row.path] = { value: row.value, locked: row.locked };
    return compactT3CodePolicy({
      schemaVersion: 1,
      organization,
      ...(supportUrl.trim() ? { supportUrl } : {}),
      ...(rows.length > 0 ? { settings } : {}),
      limits,
    });
  }, [organization, supportUrl, rows, limits]);

  // The JSON view validates what was typed; the form validates the form.
  const parsedJson = useMemo<unknown>(() => {
    if (mode !== "json") return undefined;
    try {
      return JSON.parse(jsonText) as unknown;
    } catch {
      return undefined;
    }
  }, [mode, jsonText]);
  const validation = useMemo(
    () => validateT3CodePolicy(mode === "json" ? parsedJson : formPolicy, context),
    [mode, parsedJson, formPolicy, context],
  );
  const rowsInvalid = mode === "form" && rows.some((r) => r.rawError);
  const jsonInvalid = mode === "json" && parsedJson === undefined;
  const errors = validation.issues.filter((i) => i.level === "error");
  const warnings = validation.issues.filter((i) => i.level === "warning");
  const canSave = !busy && validation.ok && !rowsInvalid && !jsonInvalid;

  function loadIntoForm(policy: T3CodePolicy) {
    setOrganization(policy.organization);
    setSupportUrl(policy.supportUrl ?? "");
    setLimits(policy.limits ?? {});
    const nextRows = rowsFromPolicy(policy);
    setRows(nextRows);
    setNextRowId(nextRows.length + 1);
  }

  function switchMode(next: "form" | "json") {
    if (next === mode) return;
    if (next === "json") {
      setJsonText(serializeT3CodePolicy(formPolicy));
      setJsonError(null);
      setMode("json");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      setJsonError(gt("Fix the JSON before switching back to the form."));
      return;
    }
    const result = validateT3CodePolicy(parsed, context);
    if (!result.policy) {
      setJsonError(gt("Fix the JSON before switching back to the form."));
      return;
    }
    loadIntoForm(result.policy);
    setJsonError(null);
    setMode("form");
  }

  function updateLimits(patch: Patch<T3CodePolicyLimits>) {
    setLimits((prev) => {
      const next = { ...prev, ...patch } as T3CodePolicyLimits;
      for (const key of Object.keys(patch) as Array<keyof T3CodePolicyLimits>) {
        if (patch[key] === undefined) delete next[key];
      }
      return next;
    });
  }

  function updateProviders(patch: Patch<ProviderLimits>) {
    const next = { ...limits.providers, ...patch } as ProviderLimits;
    for (const key of Object.keys(patch) as Array<keyof typeof next>) {
      if (patch[key] === undefined) delete next[key];
    }
    updateLimits({ providers: Object.keys(next).length > 0 ? next : undefined });
  }

  function updateInstance(driver: string, instance: T3CodePolicyProviderInstance | undefined) {
    const instances = { ...limits.providers?.instances };
    if (instance) instances[driver] = instance;
    else delete instances[driver];
    updateProviders({ instances: Object.keys(instances).length > 0 ? instances : undefined });
  }

  function addSetting(path: string) {
    if (!path) return;
    const known = t3CodeKnownSetting(path);
    const id = nextRowId;
    setNextRowId(id + 1);
    setRows((prev) => [
      ...prev,
      known
        ? { id, path, value: defaultValueFor(known.type), locked: true }
        : { id, path: "", value: null, locked: true, raw: "null" },
    ]);
  }

  function updateRow(id: number, patch: Partial<SettingRow>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  async function save() {
    if (!canSave || !validation.policy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(compactT3CodePolicy(validation.policy));
    } catch (e) {
      setError(formatErrorMessage(e));
      setBusy(false);
    }
  }

  async function remove() {
    if (!onRemove || busy) return;
    if (
      !window.confirm(
        gt(
          "Remove the T3 Code policy? Servers keep the installed policy until Authorize server runs on them again.",
        ),
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRemove();
    } catch (e) {
      setError(formatErrorMessage(e));
      setBusy(false);
    }
  }

  const usedPaths = new Set(rows.map((r) => r.path));
  const allowedDrivers = limits.providers?.allowedDrivers;
  const instances = limits.providers?.instances ?? {};
  const toolDriver = context.tool ? t3CodeDriverForTool(context.tool) : undefined;
  const clients = limits.clients;
  const allowedClient = (client: "desktop" | "local-browser") =>
    clients === undefined || clients.includes(client);

  function toggleClient(client: "desktop" | "local-browser", allowed: boolean) {
    const current = new Set<T3CodePolicyClient>(clients ?? ["desktop", "local-browser", "remote"]);
    if (allowed) current.add(client);
    else current.delete(client);
    // Remote always stays: an agent VM is reachable no other way.
    current.add("remote");
    updateLimits({ clients: current.size === 3 ? undefined : [...current] });
  }

  return (
    <Modal {...(busy ? {} : { onClose })} ariaLabel={gt("T3 Code policy")}>
      <div className="flex max-h-[min(48rem,calc(100vh-4rem))] w-[min(44rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-raised shadow-2xl">
        <div className="shrink-0 border-b border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-on-surface">{gt("T3 Code policy")}</h2>
              <T>
                <p className="mt-1 text-xs text-on-surface-muted">
                  Installed on every T3 Code server these defaults create, at{" "}
                  <Var>
                    <code className="font-mono">{T3_CODE_POLICY_PATH}</code>
                  </Var>
                  . The server enforces it for every app that connects. Existing servers pick up
                  changes the next time Authorize server runs on them.
                </p>
              </T>
            </div>
            <div className="flex shrink-0 rounded-md border border-border-strong bg-surface p-0.5">
              <button
                type="button"
                onClick={() => switchMode("form")}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  mode === "form"
                    ? "bg-accent-muted text-accent-on-muted"
                    : "text-on-surface-muted hover:text-on-surface"
                }`}
              >
                {gt("Form")}
              </button>
              <button
                type="button"
                onClick={() => switchMode("json")}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  mode === "json"
                    ? "bg-accent-muted text-accent-on-muted"
                    : "text-on-surface-muted hover:text-on-surface"
                }`}
              >
                JSON
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {mode === "json" ? (
            <div className="space-y-2">
              <textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                spellCheck={false}
                aria-label={gt("Policy JSON")}
                className={`${inputClass} h-96 font-mono text-xs`}
              />
              {jsonInvalid && (
                <p className="text-xs text-danger">{gt("This is not valid JSON.")}</p>
              )}
              {jsonError && <p className="text-xs text-danger">{jsonError}</p>}
            </div>
          ) : (
            <>
              <section className="space-y-3">
                <h3 className={sectionTitle}>{gt("Organization")}</h3>
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-on-surface-secondary">
                    {gt("Name shown to users")}
                  </span>
                  <input
                    value={organization}
                    onChange={(e) => setOrganization(e.target.value)}
                    placeholder={gt("Example Corp")}
                    className={inputClass}
                  />
                  <span className="block text-xs text-on-surface-faint">
                    {gt('Settings shows "Managed by" this name beside every locked control.')}
                  </span>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-on-surface-secondary">
                    {gt("Support link (optional)")}
                  </span>
                  <input
                    value={supportUrl}
                    onChange={(e) => setSupportUrl(e.target.value)}
                    placeholder="https://it.example.com/t3"
                    className={inputClass}
                  />
                </label>
              </section>

              <section className="space-y-3">
                <h3 className={sectionTitle}>{gt("Permissions")}</h3>
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-on-surface-secondary">
                    {gt("Broadest permission mode")}
                  </span>
                  <select
                    value={limits.maxRuntimeMode ?? ""}
                    onChange={(e) =>
                      updateLimits({
                        maxRuntimeMode: (e.target.value || undefined) as
                          T3CodeRuntimeMode | undefined,
                      })
                    }
                    className={inputClass}
                  >
                    <option value="">{gt("No limit")}</option>
                    {T3_CODE_RUNTIME_MODES.map((m) => (
                      <option key={m} value={m}>
                        {runtimeModeLabel(m, gt)}
                      </option>
                    ))}
                  </select>
                  <span className="block text-xs text-on-surface-faint">
                    {gt(
                      "Covers threads users, agents and scheduled tasks start. With a limit, provider launch settings and environment variables come only from this policy.",
                    )}
                  </span>
                </label>
              </section>

              <section className="space-y-2">
                <h3 className={sectionTitle}>{gt("Access")}</h3>
                <label className="flex items-start gap-2 text-sm text-on-surface-secondary">
                  <input type="checkbox" checked disabled className="mt-0.5" />
                  <span>
                    {gt("Phones, other computers and app.t3.codes")}
                    <span className="block text-xs text-on-surface-faint">
                      {gt("Always allowed: an agent VM can only be reached remotely.")}
                    </span>
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
                  <input
                    type="checkbox"
                    checked={allowedClient("local-browser")}
                    onChange={(e) => toggleClient("local-browser", e.target.checked)}
                  />
                  {gt("Browsers on the server itself")}
                </label>
                <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
                  <input
                    type="checkbox"
                    checked={allowedClient("desktop")}
                    onChange={(e) => toggleClient("desktop", e.target.checked)}
                  />
                  {gt("The T3 Code desktop app's own server")}
                </label>
                <label className="flex items-start gap-2 text-sm text-on-surface-secondary">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={limits.connect !== false}
                    disabled={context.access !== "tailscale" && limits.connect !== false}
                    onChange={(e) =>
                      updateLimits({ connect: e.target.checked ? undefined : false })
                    }
                  />
                  <span>
                    {/* i18n-ignore: product name */}
                    T3 Connect
                    {context.access !== "tailscale" && (
                      <span className="block text-xs text-on-surface-faint">
                        {gt("Required while T3 Code access is T3 Connect.")}
                      </span>
                    )}
                  </span>
                </label>
              </section>

              <section className="space-y-2">
                <h3 className={sectionTitle}>{gt("Capabilities")}</h3>
                {(
                  [
                    ["webhookTasks", gt("Webhook triggers for scheduled tasks")],
                    ["browserCookieImport", gt("Importing cookies from another browser")],
                    ["telemetry", gt("Product usage data and relay traces")],
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 text-sm text-on-surface-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={limits[key] !== false}
                      onChange={(e) =>
                        updateLimits({ [key]: e.target.checked ? undefined : false })
                      }
                    />
                    {label}
                  </label>
                ))}
              </section>

              <section className="space-y-3">
                <h3 className={sectionTitle}>{gt("Providers")}</h3>
                <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
                  <input
                    type="checkbox"
                    checked={allowedDrivers === undefined}
                    onChange={(e) =>
                      updateProviders({
                        allowedDrivers: e.target.checked
                          ? undefined
                          : T3_CODE_PROVIDER_DRIVERS.map((d) => d.id),
                      })
                    }
                  />
                  {gt("Allow every provider")}
                </label>
                {allowedDrivers !== undefined && (
                  <div className="grid grid-cols-2 gap-1 rounded-lg border border-border p-2 sm:grid-cols-3">
                    {T3_CODE_PROVIDER_DRIVERS.map((driver) => (
                      <label
                        key={driver.id}
                        className="flex items-center gap-2 text-sm text-on-surface-secondary"
                      >
                        <input
                          type="checkbox"
                          checked={allowedDrivers.includes(driver.id)}
                          onChange={(e) =>
                            updateProviders({
                              allowedDrivers: e.target.checked
                                ? [...allowedDrivers, driver.id]
                                : allowedDrivers.filter((d) => d !== driver.id),
                            })
                          }
                        />
                        {driver.label}
                        {driver.id === toolDriver && (
                          <span className="text-xs text-on-surface-faint">{gt("(this Tool)")}</span>
                        )}
                      </label>
                    ))}
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-on-surface-secondary">
                      {gt("Provider settings")}
                    </span>
                    <select
                      value=""
                      onChange={(e) =>
                        e.target.value &&
                        updateInstance(e.target.value, { locked: true, environment: [] })
                      }
                      aria-label={gt("Pin settings for a provider")}
                      className="rounded border border-border bg-surface px-2 py-1 text-xs"
                    >
                      <option value="">{gt("Pin settings for…")}</option>
                      {T3_CODE_PROVIDER_DRIVERS.filter((d) => !instances[d.id]).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="text-xs text-on-surface-faint">
                    {gt(
                      "Environment variables, binary and launch arguments set on every instance of a provider, such as a company gateway URL. Not for credentials: every user on the server can read the policy.",
                    )}
                  </p>
                  {Object.entries(instances).map(([driver, instance]) => (
                    <ProviderInstanceEditor
                      key={driver}
                      label={T3_CODE_PROVIDER_DRIVERS.find((d) => d.id === driver)?.label ?? driver}
                      instance={instance}
                      onChange={(next) => updateInstance(driver, next)}
                      onRemove={() => updateInstance(driver, undefined)}
                    />
                  ))}
                </div>
              </section>

              <section className="space-y-2">
                <h3 className={sectionTitle}>{gt("Updates")}</h3>
                <select
                  value={limits.updates?.mode ?? ""}
                  onChange={(e) =>
                    updateLimits({
                      updates: e.target.value
                        ? {
                            ...limits.updates,
                            mode: e.target.value as "auto" | "off",
                          }
                        : undefined,
                    })
                  }
                  aria-label={gt("Updates")}
                  className={inputClass}
                >
                  <option value="">{gt("T3 Code's default")}</option>
                  <option value="auto">{gt("Check for updates")}</option>
                  <option value="off">{gt("Never check for updates")}</option>
                </select>
                {limits.updates && (
                  <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
                    <input
                      type="checkbox"
                      checked={limits.updates.allowNightly !== false}
                      onChange={(e) => {
                        const { allowNightly: _drop, ...rest } = limits.updates!;
                        updateLimits({
                          updates: e.target.checked ? rest : { ...rest, allowNightly: false },
                        });
                      }}
                    />
                    {gt("Allow the nightly channel")}
                  </label>
                )}
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className={sectionTitle}>{gt("Settings")}</h3>
                  <select
                    value=""
                    onChange={(e) => addSetting(e.target.value)}
                    aria-label={gt("Add a setting")}
                    className="rounded border border-border bg-surface px-2 py-1 text-xs"
                  >
                    <option value="">{gt("Add a setting…")}</option>
                    {T3_CODE_POLICY_KNOWN_SETTINGS.filter((s) => !usedPaths.has(s.path)).map(
                      (s) => (
                        <option key={s.path} value={s.path}>
                          {settingLabel(s.path, gt)}
                        </option>
                      ),
                    )}
                    <option value="__custom">{gt("Other setting (by path)…")}</option>
                  </select>
                </div>
                <p className="text-xs text-on-surface-faint">
                  {gt(
                    "Locked settings cannot be changed by users or agents, including in project settings. Unlocked ones are defaults users can change.",
                  )}
                </p>
                {rows.length === 0 && (
                  <p className="text-xs text-on-surface-muted">{gt("No managed settings.")}</p>
                )}
                {rows.map((row) => (
                  <SettingRowEditor
                    key={row.id}
                    row={row}
                    onChange={(patch) => updateRow(row.id, patch)}
                    onRemove={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                  />
                ))}
              </section>
            </>
          )}

          {(errors.length > 0 || warnings.length > 0) && (
            <ul className="space-y-1">
              {errors.map((issue, index) => (
                <li
                  key={`e${index}`}
                  className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-danger"
                >
                  {issueText(issue, gt)}
                </li>
              ))}
              {warnings.map((issue, index) => (
                <li
                  key={`w${index}`}
                  className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-warning"
                >
                  {issueText(issue, gt)}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3">
          <div>
            {onRemove && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove()}
                className="rounded px-3 py-1.5 text-sm text-danger hover:bg-red-500/10 disabled:opacity-50"
              >
                {gt("Remove policy")}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded px-3 py-1.5 text-sm text-on-surface-secondary hover:bg-surface-sunken disabled:opacity-50"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => void save()}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {gt("Save policy")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SettingRowEditor({
  row,
  onChange,
  onRemove,
}: {
  row: SettingRow;
  onChange: (patch: Partial<SettingRow>) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const known = row.raw === undefined ? t3CodeKnownSetting(row.path) : undefined;
  return (
    <div className="space-y-2 rounded-lg border border-border p-2">
      <div className="flex items-center gap-2">
        {known ? (
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-on-surface">{settingLabel(row.path, gt)}</div>
            <div className="truncate font-mono text-xs text-on-surface-faint">{row.path}</div>
          </div>
        ) : (
          <input
            value={row.path}
            onChange={(e) => onChange({ path: e.target.value.trim() })}
            // i18n-ignore: example setting path
            placeholder="storageCleanup.logsAfterDays"
            aria-label={gt("Setting path")}
            className={`${inputClass} flex-1 font-mono text-xs`}
          />
        )}
        <label className="flex shrink-0 items-center gap-1 text-xs text-on-surface-secondary">
          <input
            type="checkbox"
            checked={row.locked}
            onChange={(e) => onChange({ locked: e.target.checked })}
          />
          {gt("Locked")}
        </label>
        <button
          type="button"
          onClick={onRemove}
          aria-label={gt("Remove setting")}
          className="shrink-0 rounded px-2 py-1 text-xs text-on-surface-muted hover:bg-surface-sunken"
        >
          {gt("Remove")}
        </button>
      </div>
      {known ? (
        <KnownSettingValue
          path={row.path}
          type={known.type}
          value={row.value}
          onChange={(value) => onChange({ value })}
        />
      ) : (
        <>
          <textarea
            value={row.raw ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              try {
                onChange({ raw, value: JSON.parse(raw) as unknown, rawError: false });
              } catch {
                onChange({ raw, rawError: true });
              }
            }}
            spellCheck={false}
            aria-label={gt("Setting value (JSON)")}
            className={`${inputClass} h-20 font-mono text-xs`}
          />
          {row.rawError && (
            <p className="text-xs text-danger">
              {gt('Enter the value as JSON, for example true, 30 or "text".')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function KnownSettingValue({
  path,
  type,
  value,
  onChange,
}: {
  path: string;
  type: T3CodePolicySettingKind;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const gt = useGT();
  switch (type.kind) {
    case "boolean":
      return (
        <select
          value={value === true ? "true" : "false"}
          onChange={(e) => onChange(e.target.value === "true")}
          aria-label={gt("Value")}
          className={inputClass}
        >
          <option value="true">{gt("On")}</option>
          <option value="false">{gt("Off")}</option>
        </select>
      );
    case "enum":
      return (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          aria-label={gt("Value")}
          className={inputClass}
        >
          {type.options.map((option) => (
            <option key={option} value={option}>
              {enumOptionLabel(path, option, gt)}
            </option>
          ))}
        </select>
      );
    case "string":
      return (
        <input
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          aria-label={gt("Value")}
          className={inputClass}
        />
      );
    case "days":
      return (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={type.min}
            max={type.max}
            disabled={value === null}
            value={typeof value === "number" ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
            aria-label={gt("Days")}
            className={`${inputClass} w-32`}
          />
          <label className="flex items-center gap-1 text-xs text-on-surface-secondary">
            <input
              type="checkbox"
              checked={value === null}
              onChange={(e) => onChange(e.target.checked ? null : 30)}
            />
            {gt("Keep forever")}
          </label>
        </div>
      );
  }
}

function ProviderInstanceEditor({
  label,
  instance,
  onChange,
  onRemove,
}: {
  label: string;
  instance: T3CodePolicyProviderInstance;
  onChange: (instance: T3CodePolicyProviderInstance) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const env = instance.environment ?? [];
  const setOptional = (key: "binaryPath" | "launchArgs", value: string) => {
    const next = { ...instance };
    if (value) next[key] = value;
    else delete next[key];
    onChange(next);
  };
  return (
    <div className="space-y-2 rounded-lg border border-border p-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-medium text-on-surface">{label}</span>
        <label className="flex items-center gap-1 text-xs text-on-surface-secondary">
          <input
            type="checkbox"
            checked={instance.locked}
            onChange={(e) => onChange({ ...instance, locked: e.target.checked })}
          />
          {gt("Locked")}
        </label>
        <button
          type="button"
          onClick={onRemove}
          className="rounded px-2 py-1 text-xs text-on-surface-muted hover:bg-surface-sunken"
        >
          {gt("Remove")}
        </button>
      </div>
      <p className="text-xs text-on-surface-faint">
        {instance.locked
          ? gt("Users cannot change the fields set here.")
          : gt("These fill in only what users left empty.")}
      </p>
      {env.map((variable, index) => (
        <div key={index} className="flex gap-2">
          <input
            value={variable.name}
            onChange={(e) =>
              onChange({
                ...instance,
                environment: env.map((v, i) => (i === index ? { ...v, name: e.target.value } : v)),
              })
            }
            placeholder="ANTHROPIC_BASE_URL"
            aria-label={gt("Variable name")}
            className={`${inputClass} w-1/2 font-mono text-xs`}
          />
          <input
            value={variable.value}
            onChange={(e) =>
              onChange({
                ...instance,
                environment: env.map((v, i) => (i === index ? { ...v, value: e.target.value } : v)),
              })
            }
            placeholder={gt("Value")}
            aria-label={gt("Variable value")}
            className={`${inputClass} w-1/2 font-mono text-xs`}
          />
          <button
            type="button"
            onClick={() =>
              onChange({ ...instance, environment: env.filter((_, i) => i !== index) })
            }
            aria-label={gt("Remove variable")}
            className="shrink-0 rounded px-2 text-xs text-on-surface-muted hover:bg-surface-sunken"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange({ ...instance, environment: [...env, { name: "", value: "" }] })}
        className="text-xs text-accent hover:underline"
      >
        {gt("Add environment variable")}
      </button>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={instance.binaryPath ?? ""}
          onChange={(e) => setOptional("binaryPath", e.target.value)}
          placeholder={gt("Binary path (optional)")}
          aria-label={gt("Binary path")}
          className={`${inputClass} font-mono text-xs`}
        />
        <input
          value={instance.launchArgs ?? ""}
          onChange={(e) => setOptional("launchArgs", e.target.value)}
          placeholder={gt("Launch arguments (optional)")}
          aria-label={gt("Launch arguments")}
          className={`${inputClass} font-mono text-xs`}
        />
      </div>
    </div>
  );
}
