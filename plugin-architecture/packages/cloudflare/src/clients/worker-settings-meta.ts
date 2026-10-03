import type { SettingDescriptor } from "@infrawrench/plugin-base";

/**
 * Presentation + (de)serialization for the Worker "Settings" form. Mirrors
 * zone-settings-meta.ts: the host renders a labeled settings form (the
 * settingsEditor capability) from `SettingDescriptor[]` returned by getManifest,
 * and sends changed `{ id, value }` rows back through applyManifest.
 *
 * Editable settings span three Cloudflare endpoints, so the descriptor ids stay
 * stable and each one is routed to the right endpoint on apply:
 *   - script settings  (`PATCH /workers/scripts/{name}/settings`): logpush,
 *     observability, tags. NOTE: this endpoint only accepts those fields, so
 *     compatibility date/flags, usage model, Smart Placement and CPU limits are
 *     shown read-only (they're set at deploy time, not patchable here).
 *   - workers.dev subdomain (`PUT /workers/scripts/{name}/subdomain`)
 *   - cron triggers        (`PUT /workers/scripts/{name}/schedules`)
 */

/** Subset of the Cloudflare worker script-settings payload we expose. */
export interface WorkerSettings {
  logpush?: boolean;
  observability?: WorkerObservabilitySettings | null;
  placement?: { mode?: string } | null;
  tags?: string[];
  usage_model?: string;
  tail_consumers?: Array<{ service: string; environment?: string; namespace?: string }> | null;
  compatibility_date?: string;
  compatibility_flags?: string[];
  limits?: { cpu_ms?: number } | null;
  bindings?: unknown[];
}

/**
 * `observability` as `GET/PATCH /workers/scripts/{name}/settings` carry it.
 * `logs` and `traces` are optional sub-objects (Workers Logs and Workers
 * Traces); when `logs` is absent, logs follow the top-level switch.
 */
export interface WorkerObservabilitySettings {
  enabled?: boolean;
  head_sampling_rate?: number | null;
  logs?: {
    enabled: boolean;
    invocation_logs: boolean;
    head_sampling_rate?: number | null;
    persist?: boolean;
    destinations?: string[];
  } | null;
  traces?: {
    enabled?: boolean;
    head_sampling_rate?: number | null;
    persist?: boolean;
    destinations?: string[];
    propagation_policy?: "authenticated" | "accept";
  } | null;
}

/** Everything the detail form needs, gathered from the three endpoints. */
interface WorkerSettingsInput {
  settings: WorkerSettings;
  /** workers.dev subdomain enablement; undefined when the lookup failed. */
  subdomainEnabled?: boolean;
  /** Cron trigger expressions, e.g. every-5-minutes style schedules. */
  crons: string[];
}

const onOff = (b: boolean | undefined): string => (b ? "on" : "off");

const dash = (s: string): string => (s.length > 0 ? s : "—");

const rate = (n: number | null | undefined): string => (n == null ? "" : String(n));

/** Blank or non-numeric → null (the API's "use the default of 1"). */
function parseRate(value: string): number | null {
  const n = Number(value);
  return value.trim() === "" || Number.isNaN(n) ? null : n;
}

/** Build the host-facing settings form rows from the gathered worker settings. */
export function buildWorkerSettingDescriptors(input: WorkerSettingsInput): SettingDescriptor[] {
  const s = input.settings;
  const logs = s.observability?.logs ?? null;
  const traces = s.observability?.traces ?? null;
  return [
    // ── Editable: workers.dev subdomain (own endpoint) ──
    {
      id: "subdomain_enabled",
      label: "workers.dev subdomain",
      control: "toggle",
      value: onOff(input.subdomainEnabled),
      group: "General",
      description: "Expose this Worker on its <name>.<subdomain>.workers.dev route.",
    },
    // ── Editable: script settings (PATCH .../settings) ──
    {
      id: "logpush",
      label: "Logpush",
      control: "toggle",
      value: onOff(s.logpush),
      group: "General",
      description: "Send request logs to a configured Logpush destination.",
    },
    {
      id: "tags",
      label: "Tags",
      control: "text",
      value: (s.tags ?? []).join(", "),
      group: "General",
      description: "Comma-separated tags to help you organize Workers.",
    },
    {
      id: "observability_enabled",
      label: "Observability",
      control: "toggle",
      value: onOff(s.observability?.enabled),
      group: "Observability",
      description:
        "Master switch for Workers Logs and Traces. Logs show up in this Worker's Logs tab.",
    },
    {
      id: "observability_head_sampling_rate",
      label: "Head sampling rate",
      control: "number",
      value: rate(s.observability?.head_sampling_rate),
      group: "Observability",
      description: "Fraction of requests to log, 0–1 (1 = 100%). Blank uses the default of 1.",
    },
    {
      id: "observability_logs_enabled",
      label: "Logs",
      control: "toggle",
      // No `logs` object means logs follow the top-level switch.
      value: onOff(logs ? logs.enabled : s.observability?.enabled),
      group: "Observability",
      description: "Store console output and errors in Workers Logs (the Logs tab).",
    },
    {
      id: "observability_logs_invocation_logs",
      label: "Invocation logs",
      control: "toggle",
      value: onOff(logs ? logs.invocation_logs : s.observability?.enabled),
      group: "Observability",
      description:
        "Add one log per invocation with its trigger, outcome, status, CPU and wall time.",
    },
    {
      id: "observability_logs_head_sampling_rate",
      label: "Logs sampling rate",
      control: "number",
      value: rate(logs?.head_sampling_rate),
      group: "Observability",
      description: "Fraction of requests whose logs are kept, 0–1. Blank uses the default of 1.",
    },
    {
      id: "observability_logs_persist",
      label: "Persist logs",
      control: "toggle",
      value: onOff(logs ? logs.persist !== false : s.observability?.enabled),
      group: "Observability",
      description:
        "Keep logs in Cloudflare for querying. Turn off to only export them to destinations.",
    },
    {
      id: "observability_traces_enabled",
      label: "Traces",
      control: "toggle",
      value: onOff(traces?.enabled),
      group: "Observability",
      description:
        "Record automatic traces of handlers, fetch calls and binding calls (KV, R2, Durable Objects).",
    },
    {
      id: "observability_traces_head_sampling_rate",
      label: "Traces sampling rate",
      control: "number",
      value: rate(traces?.head_sampling_rate),
      group: "Observability",
      description: "Fraction of requests to trace, 0–1. Blank uses the default of 1.",
    },
    {
      id: "observability_traces_persist",
      label: "Persist traces",
      control: "toggle",
      value: onOff(traces ? traces.persist !== false : false),
      group: "Observability",
      description:
        "Keep traces in Cloudflare for querying. Turn off to only export them to destinations.",
    },
    {
      id: "observability_destinations",
      label: "Export destinations",
      control: "readonly",
      value: dash(
        [...new Set([...(logs?.destinations ?? []), ...(traces?.destinations ?? [])])].join(", "),
      ),
      group: "Observability",
      description: "OpenTelemetry export destinations, managed in the Cloudflare dashboard.",
    },
    // ── Editable: cron triggers (own endpoint) ──
    {
      id: "cron_triggers",
      label: "Cron triggers",
      control: "text",
      value: input.crons.join(", "),
      group: "Triggers",
      description: "Comma-separated cron expressions (e.g. every-5-minutes or daily schedules).",
    },
    // ── Read-only: set at deploy time, not patchable via the settings API ──
    {
      id: "usage_model",
      label: "Usage model",
      control: "readonly",
      value: dash(s.usage_model ?? ""),
      group: "Deployment",
    },
    {
      id: "compatibility_date",
      label: "Compatibility date",
      control: "readonly",
      value: dash(s.compatibility_date ?? ""),
      group: "Deployment",
      description: "Runtime compatibility date — change it by redeploying the Worker.",
    },
    {
      id: "compatibility_flags",
      label: "Compatibility flags",
      control: "readonly",
      value: dash((s.compatibility_flags ?? []).join(", ")),
      group: "Deployment",
    },
    {
      id: "placement_mode",
      label: "Smart Placement",
      control: "readonly",
      value: s.placement?.mode === "smart" ? "Smart" : "Off",
      group: "Deployment",
    },
    {
      id: "limits_cpu_ms",
      label: "CPU limit (ms)",
      control: "readonly",
      value: s.limits?.cpu_ms == null ? "—" : String(s.limits.cpu_ms),
      group: "Deployment",
    },
    {
      id: "tail_consumers",
      label: "Tail consumers",
      control: "readonly",
      value: dash((s.tail_consumers ?? []).map((t) => t.service).join(", ")),
      group: "Triggers",
    },
    {
      id: "bindings",
      label: "Bindings",
      control: "readonly",
      value: `${(s.bindings ?? []).length} binding(s)`,
      group: "Bindings",
    },
  ];
}

/** A list of comma-separated tokens → trimmed, non-empty string array. */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Script-level fields patchable via `PATCH /workers/scripts/{name}/settings`. */
interface WorkerScriptSettingsPatch {
  logpush: boolean;
  tags: string[];
  observability: WorkerObservabilityPatch;
}

type WorkerObservabilityPatch = {
  enabled: boolean;
  head_sampling_rate: number | null;
  logs?: NonNullable<WorkerObservabilitySettings["logs"]>;
  traces?: NonNullable<WorkerObservabilitySettings["traces"]>;
};

interface WorkerSettingsApply {
  /** Script-settings patch for `settings.edit`, or null if unchanged. */
  settings: WorkerScriptSettingsPatch | null;
  /** New workers.dev subdomain state, or undefined if unchanged. */
  subdomainEnabled?: boolean;
  /** New cron trigger expressions, or undefined if unchanged. */
  crons?: string[];
}

const SCRIPT_SETTING_IDS = new Set([
  "logpush",
  "tags",
  "observability_enabled",
  "observability_head_sampling_rate",
  "observability_logs_enabled",
  "observability_logs_invocation_logs",
  "observability_logs_head_sampling_rate",
  "observability_logs_persist",
  "observability_traces_enabled",
  "observability_traces_head_sampling_rate",
  "observability_traces_persist",
]);

/**
 * Translate the changed `{ id, value }` rows into per-endpoint updates. The
 * script-settings patch is seeded from the current settings (so a PATCH that
 * replaces the nested `observability` object doesn't drop sibling fields) and is
 * only produced when at least one script-level field actually changed. Read-only
 * rows never reach this function, but unknown ids are ignored defensively.
 */
export function applyWorkerSettingChanges(
  current: WorkerSettings,
  changed: Array<{ id: string; value: string }>,
): WorkerSettingsApply {
  const byId = new Map(changed.map((c) => [c.id, c.value]));

  // workers.dev subdomain and cron triggers each live on their own endpoint.
  const subdomainEnabled = byId.has("subdomain_enabled")
    ? byId.get("subdomain_enabled") === "on"
    : undefined;
  const crons = byId.has("cron_triggers") ? splitList(byId.get("cron_triggers") ?? "") : undefined;
  const endpointUpdates = {
    ...(subdomainEnabled !== undefined ? { subdomainEnabled } : {}),
    ...(crons !== undefined ? { crons } : {}),
  };

  const touchesScript = changed.some((c) => SCRIPT_SETTING_IDS.has(c.id));
  if (!touchesScript) return { settings: null, ...endpointUpdates };

  // Seed from current values so the PATCH sends a coherent settings object.
  // `logs` and `traces` are carried over whole (destinations included):
  // PATCH replaces the nested `observability` object, so leaving them out
  // would silently turn off traces or drop export destinations.
  const cur = current.observability;
  const patch: WorkerScriptSettingsPatch = {
    logpush: current.logpush ?? false,
    tags: current.tags ?? [],
    observability: {
      enabled: cur?.enabled ?? false,
      head_sampling_rate: cur?.head_sampling_rate ?? null,
      ...(cur?.logs ? { logs: { ...cur.logs } } : {}),
      ...(cur?.traces ? { traces: { ...cur.traces } } : {}),
    },
  };
  const obs = patch.observability;
  // First touch of a logs field materializes the object from the implicit
  // "logs follow the top-level switch" default.
  const ensureLogs = (): NonNullable<WorkerObservabilitySettings["logs"]> =>
    (obs.logs ??= { enabled: obs.enabled, invocation_logs: obs.enabled });
  const ensureTraces = (): NonNullable<WorkerObservabilitySettings["traces"]> =>
    (obs.traces ??= { enabled: false });

  for (const { id, value } of changed) {
    switch (id) {
      case "logpush":
        patch.logpush = value === "on";
        break;
      case "tags":
        patch.tags = splitList(value);
        break;
      case "observability_enabled":
        patch.observability.enabled = value === "on";
        break;
      case "observability_head_sampling_rate":
        obs.head_sampling_rate = parseRate(value);
        break;
      case "observability_logs_enabled":
        ensureLogs().enabled = value === "on";
        break;
      case "observability_logs_invocation_logs":
        ensureLogs().invocation_logs = value === "on";
        break;
      case "observability_logs_head_sampling_rate":
        ensureLogs().head_sampling_rate = parseRate(value);
        break;
      case "observability_logs_persist":
        ensureLogs().persist = value === "on";
        break;
      case "observability_traces_enabled":
        ensureTraces().enabled = value === "on";
        break;
      case "observability_traces_head_sampling_rate":
        ensureTraces().head_sampling_rate = parseRate(value);
        break;
      case "observability_traces_persist":
        ensureTraces().persist = value === "on";
        break;
      default:
        break;
    }
  }

  return { settings: patch, ...endpointUpdates };
}
