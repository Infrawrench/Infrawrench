/** Minimal shape needed by the account resource type helpers. */
interface ResourceTypeInfo {
  parentTypeId?: string | undefined;
  supportsCreate?: boolean | undefined;
  /**
   * Child types (with `parentTypeId`) opt in here to appear in the sidebar as
   * their own top-level section. See `ResourceTypeDefinition.showInSidebar`.
   */
  showInSidebar?: boolean | undefined;
}

/** Custom DOM event name dispatched when resources are created or deleted. */
export const RESOURCES_CHANGED_EVENT = "iw:resources-changed";

/** Custom DOM event name dispatched to trigger a background refresh of the current resource. */
export const REFRESH_RESOURCE_EVENT = "iw:refresh-resource";

/**
 * Custom DOM event name dispatched when the schema emits a `navigate-to-resource`
 * host action. Each host (web, desktop) listens and performs its own client-side
 * navigation — full-page `window.location` assignments would drop tanstack state.
 */
export const NAVIGATE_TO_RESOURCE_EVENT = "iw:navigate-to-resource";

export interface NavigateToResourceDetail {
  pluginId: string;
  resourceTypeId: string;
  resourceId: string;
}

/** Detail payload dispatched with RESOURCES_CHANGED_EVENT. */
export interface ResourcesChangedDetail {
  accountId?: string;
  /** When set, listeners can re-sync just this type rather than refetching everything. */
  resourceTypeId?: string;
}

/** Dispatch the resources-changed event with optional accountId + resourceTypeId. */
export function dispatchResourcesChanged(
  accountIdOrDetail?: string | ResourcesChangedDetail,
  resourceTypeId?: string,
): void {
  const detail: ResourcesChangedDetail =
    typeof accountIdOrDetail === "string"
      ? { accountId: accountIdOrDetail, ...(resourceTypeId ? { resourceTypeId } : {}) }
      : (accountIdOrDetail ?? {});
  const hasDetail = detail.accountId || detail.resourceTypeId;
  window.dispatchEvent(
    new CustomEvent(RESOURCES_CHANGED_EVENT, hasDetail ? { detail } : undefined),
  );
}

/** Dispatch the refresh-resource event. */
export function dispatchRefreshResource(): void {
  window.dispatchEvent(new CustomEvent(REFRESH_RESOURCE_EVENT));
}

/** Dispatch a navigate-to-resource event carrying the target plugin/type/id. */
export function dispatchNavigateToResource(detail: NavigateToResourceDetail): void {
  window.dispatchEvent(new CustomEvent(NAVIGATE_TO_RESOURCE_EVENT, { detail }));
}

/**
 * Event fired when the schema requests a `plugin-action` be invoked. The
 * resource detail page listens and dispatches to its host (web/desktop).
 */
export const INVOKE_PLUGIN_ACTION_EVENT = "iw:invoke-plugin-action";

export interface InvokePluginActionDetail {
  actionId: string;
  confirmMessage?: string;
  successMessage?: string;
  /**
   * Full id of the resource the action targets. The desktop workspace keeps
   * every open tab's detail panel mounted at once, and all of them listen on
   * this global event — so handlers must ignore events whose `resourceId`
   * doesn't match their own panel, or one click runs the action in every
   * mounted panel (against the wrong resource). Omitted = legacy/unscoped.
   */
  resourceId?: string;
}

export function dispatchInvokePluginAction(detail: InvokePluginActionDetail): void {
  window.dispatchEvent(new CustomEvent(INVOKE_PLUGIN_ACTION_EVENT, { detail }));
}

/**
 * Event fired when a `reroll-parent-output` schema action is clicked. The
 * resource detail page listens; in peer context it walks up to the parent and
 * calls `parentClient.rerollOutput`.
 */
export const REROLL_PARENT_OUTPUT_EVENT = "iw:reroll-parent-output";

export interface RerollParentOutputDetail {
  outputKey: string;
  confirmMessage?: string;
}

export function dispatchRerollParentOutput(detail: RerollParentOutputDetail): void {
  window.dispatchEvent(new CustomEvent(REROLL_PARENT_OUTPUT_EVENT, { detail }));
}

/**
 * Event fired when a `prompt-nosql-command` schema action is clicked. The
 * detail page listens, prompts for each field, and invokes the NoSQL command
 * via its host (web/desktop).
 */
export const PROMPT_NOSQL_COMMAND_EVENT = "iw:prompt-nosql-command";

export interface PromptNoSqlCommandDetail {
  command: string;
  title?: string;
  description?: string;
  descriptionVariant?: "info" | "error";
  blocked?: boolean;
  fields: import("@infrawrench/plugin-base").CreateFieldConfig[];
  submitLabel?: string;
  danger?: boolean;
  /**
   * Full id of the resource this prompt targets. Mounted detail panels ignore
   * events whose `resourceId` doesn't match — otherwise the desktop's
   * always-mounted tabs each open their own copy of the modal. Omitted =
   * legacy/unscoped (every listener responds).
   */
  resourceId?: string;
}

export function dispatchPromptNoSqlCommand(detail: PromptNoSqlCommandDetail): void {
  window.dispatchEvent(new CustomEvent(PROMPT_NOSQL_COMMAND_EVENT, { detail }));
}

// Quick-connect key/username selection is pure and mobile runs the same flow,
// so it lives in client-core; re-exported here because web and desktop import
// it from `ui`.
export { deriveSSHUsername, pickQuickConnectKeyId } from "@infrawrench/client-core";

/** Format a byte count as a human-readable string (B/KB/MB/GB). */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

/** Format an ISO date string as a locale-friendly short date+time. */
export function formatDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Group an array of items by a key derived from each item. */
export function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item);
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}

/** Tracks the progress of a file transfer (upload/download). */
export interface TransferEntry {
  id: string;
  name: string;
  pct: number;
  done: boolean;
  error?: string;
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error ?? "Unknown error");
}

function tryParseJsonPayload(text: string): unknown | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Keep trying other shapes.
    }
  }
  return null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatGoogleApiError(errorRecord: Record<string, unknown>): string | null {
  const topLevelError = getRecord(errorRecord.error) ?? errorRecord;
  const message = getString(topLevelError.message);
  const details = Array.isArray(topLevelError.details) ? topLevelError.details : [];

  for (const detail of details) {
    const detailRecord = getRecord(detail);
    if (!detailRecord) continue;
    const metadata = getRecord(detailRecord.metadata) ?? {};
    const reason = getString(detailRecord.reason);

    if (reason === "SERVICE_DISABLED") {
      const serviceTitle = getString(metadata.serviceTitle) ?? "This Google Cloud API";
      const project =
        getString(metadata.containerInfo) ??
        getString(metadata.consumer)?.replace(/^projects\//, "") ??
        "this project";
      const activationUrl = getString(metadata.activationUrl);
      return activationUrl
        ? `${serviceTitle} is not enabled for project ${project}. Enable it in Google Cloud Console, then retry in a few minutes.\n${activationUrl}`
        : `${serviceTitle} is not enabled for project ${project}. Enable it in Google Cloud Console, then retry in a few minutes.`;
    }
  }

  if (message && /sync mutate calls cannot be queued/i.test(message)) {
    // Cloud Scheduler v1 mutations require an App Engine app to exist in the
    // project. Surface that explicitly — Google's own error text is opaque.
    return "Cloud Scheduler can't mutate jobs because this project has no App Engine application. Run `gcloud app create --region=<region>` (in the same region as the job), then retry.";
  }

  if ((getString(topLevelError.status) === "PERMISSION_DENIED" || details.length > 0) && message) {
    return `Permission denied. ${message}`;
  }

  return message;
}

/**
 * Extract a human-readable error message from any thrown value.
 * Handles JSON payloads (Google Cloud API errors), connection errors, and auth errors.
 */
export function formatErrorMessage(error: unknown): string {
  const raw = rawErrorMessage(error)
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^Error:\s*/, "")
    .trim();

  // Errors pass through multiple wrappers: plugin throws with raw GCP JSON in
  // the message, server returns `{error: "<that string>"}`, desktop prepends
  // "Cloud request failed: …". Unwrap up to a few layers so the real Google
  // API payload reaches formatGoogleApiError below.
  let parsedRecord = getRecord(tryParseJsonPayload(raw));
  for (let i = 0; i < 3 && parsedRecord; i++) {
    const errorField = parsedRecord.error;
    if (typeof errorField !== "string") break;
    const innerRecord = getRecord(tryParseJsonPayload(errorField));
    if (!innerRecord) break;
    parsedRecord = innerRecord;
  }

  if (parsedRecord) {
    const googleApiMessage = formatGoogleApiError(parsedRecord);
    if (googleApiMessage) return googleApiMessage;

    const nestedError = getRecord(parsedRecord.error);
    const nestedMessage = getString(nestedError?.message);
    if (nestedMessage) return nestedMessage;

    const topLevelMessage = getString(parsedRecord.message);
    if (topLevelMessage) return topLevelMessage;
  }

  const normalized = raw.replace(/\s+/g, " ").trim();
  const lowered = normalized.toLowerCase();

  if (lowered.includes("econnrefused") || lowered.includes("connection refused")) {
    return "Connection refused. Check the host, port, and that the service is reachable.";
  }
  if (lowered.includes("enotfound") || lowered.includes("getaddrinfo")) {
    return "Host not found. Check the hostname or DNS settings.";
  }
  if (
    lowered.includes("timed out") ||
    lowered.includes("etimedout") ||
    lowered.includes("timeout")
  ) {
    return "Connection timed out. Check network access, firewall rules, and the remote service.";
  }
  if (
    lowered.includes("unauthorized") ||
    lowered.includes("invalid credentials") ||
    lowered.includes("authentication failed") ||
    lowered.includes("permission denied")
  ) {
    return `Authentication or permission error. ${normalized}`;
  }

  return normalized;
}

// Field visibility and defaults are pure and mobile renders the same forms, so
// they live in client-core; re-exported here for web and desktop.
export { evaluateShowWhen, buildDefaultFields } from "@infrawrench/client-core";

/**
 * Returns resource types whose instances should be listed in the sidebar —
 * top-level types plus child types that opted in via `showInSidebar`.
 *
 * This is the only place `showInSidebar` belongs. Account pages list every
 * type regardless of parentage; see `getVisibleAccountCategories`.
 */
export function getListableResourceTypes<T extends ResourceTypeInfo>(resourceTypes: T[]): T[] {
  return resourceTypes.filter((typeDef) => !typeDef.parentTypeId || typeDef.showInSidebar);
}

/** Extract and truncate a display-friendly host from resource fields. */
export function extractHostLabel(fields: Record<string, unknown>, maxLength = 28): string {
  const rawHost = String(fields["host"] ?? fields["region"] ?? fields["engine"] ?? "");
  if (!rawHost) return "";
  try {
    const h = rawHost.includes("://") ? new URL(rawHost).hostname : rawHost;
    return h.length > maxLength ? h.slice(0, maxLength - 2) + "\u2026" : h;
  } catch {
    return rawHost.length > maxLength ? rawHost.slice(0, maxLength - 2) + "\u2026" : rawHost;
  }
}

/** Minimal child resource info for building groups. */
interface ChildResourceInput {
  id: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  status?: { kind: "status-dot"; status: string; label?: string } | undefined;
  fields?: Record<string, unknown> | undefined;
}

/** Minimal child type info for building groups. */
interface ChildTypeInput {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  supportsCreate?: boolean | undefined;
  fields?: unknown[] | undefined;
}

/**
 * Build ChildResourceGroup[] from flat lists of child types and child resources.
 * Used by both desktop (after live-fetching) and web (from API response).
 */
export function buildChildResourceGroups(
  childTypes: ChildTypeInput[],
  childResources: ChildResourceInput[],
): Array<{
  typeId: string;
  displayName: string;
  pluralDisplayName: string;
  supportsCreate: boolean;
  resources: ChildResourceInput[];
  fields?: unknown[] | undefined;
}> {
  return childTypes.flatMap((ct) => {
    const group = {
      typeId: ct.id,
      displayName: ct.displayName,
      pluralDisplayName: ct.pluralDisplayName,
      supportsCreate: !!ct.supportsCreate,
      resources: childResources.filter((r) => r.resourceTypeId === ct.id),
      ...(ct.fields ? { fields: ct.fields } : {}),
    };
    return group.resources.length > 0 || group.supportsCreate ? [group] : [];
  });
}

/** Returns a display title for a resource tab, prefixed with SSH/SFTP when applicable. */
export function resourceTabTitle(displayName: string, view?: string): string {
  if (view === "ssh") return `SSH: ${displayName}`;
  if (view === "sftp") return `SFTP: ${displayName}`;
  return displayName;
}
