/**
 * Shared utility functions used by both desktop and web apps.
 */

import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/** Minimal shape needed by the account resource type helpers. */
interface ResourceTypeInfo {
  parentTypeId?: string | undefined;
  supportsCreate?: boolean | undefined;
}

/** Custom DOM event name dispatched when resources are created or deleted. */
export const RESOURCES_CHANGED_EVENT = "iw:resources-changed";

/** Custom DOM event name dispatched to trigger a background refresh of the current resource. */
export const REFRESH_RESOURCE_EVENT = "iw:refresh-resource";

/** Dispatch the resources-changed event with an optional accountId detail. */
export function dispatchResourcesChanged(accountId?: string): void {
  window.dispatchEvent(
    new CustomEvent(RESOURCES_CHANGED_EVENT, accountId ? { detail: { accountId } } : undefined),
  );
}

/** Dispatch the refresh-resource event. */
export function dispatchRefreshResource(): void {
  window.dispatchEvent(new CustomEvent(REFRESH_RESOURCE_EVENT));
}

/** Derive an SSH username from a key comment (e.g. "user@host" → "user"). Defaults to "root". */
export function deriveSSHUsername(comment: string): string {
  return comment.split("@")[0] || "root";
}

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

/**
 * Converts identifier-like strings (camelCase, snake_case, kebab-case) into
 * user-friendly title text for UI fallbacks.
 */
export function humanizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return trimmed;
  return normalized
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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

/** SSH/SFTP connection configuration. */
export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
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
    .replace(/^Error:\s*/, "")
    .trim();
  const parsed = tryParseJsonPayload(raw);
  const parsedRecord = getRecord(parsed);

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

/** Evaluate whether a create-form field should be visible based on showWhen conditions. */
export function evaluateShowWhen(
  field: { showWhen?: { fieldKey: string; fieldValue: string } },
  fields: Record<string, string>,
): boolean {
  return !field.showWhen || fields[field.showWhen.fieldKey] === field.showWhen.fieldValue;
}

/** Build the initial field values from a CreateResourceConfig's field definitions. */
export function buildDefaultFields(
  configFields: Array<{
    key: string;
    kind: string;
    defaultValue?: string;
    defaultGb?: number;
    minGb?: number;
  }>,
): Record<string, string> {
  const init: Record<string, string> = {};
  for (const f of configFields) {
    if (f.defaultValue) init[f.key] = f.defaultValue;
    else if (f.kind === "disk-slider") init[f.key] = String(f.defaultGb ?? f.minGb ?? 20);
  }
  return init;
}

/**
 * Returns resource types to show on the account page.
 * Top-level types show their full resource list + create button.
 * Child types with supportsCreate show only the create button (no resource
 * listing — those appear nested under their parent on the detail page).
 */
export function getAccountResourceTypes<T extends ResourceTypeInfo>(resourceTypes: T[]): T[] {
  return resourceTypes.filter((typeDef) => !typeDef.parentTypeId || typeDef.supportsCreate);
}

/** Returns only top-level resource types (no parent) whose resources should be listed. */
export function getListableResourceTypes<T extends ResourceTypeInfo>(resourceTypes: T[]): T[] {
  return resourceTypes.filter((typeDef) => !typeDef.parentTypeId);
}

/** Whether a type should hide its resource list on the account page */
export function isCreateOnlyType(typeDef: ResourceTypeInfo): boolean {
  return !!typeDef.parentTypeId && !!typeDef.supportsCreate;
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
}

/** Minimal child type info for building groups. */
interface ChildTypeInput {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  supportsCreate?: boolean | undefined;
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
}> {
  return childTypes
    .map((ct) => ({
      typeId: ct.id,
      displayName: ct.displayName,
      pluralDisplayName: ct.pluralDisplayName,
      supportsCreate: !!ct.supportsCreate,
      resources: childResources.filter((r) => r.resourceTypeId === ct.id),
    }))
    .filter((g) => g.resources.length > 0 || g.supportsCreate);
}

/** Returns a display title for a resource tab, prefixed with SSH/SFTP when applicable. */
export function resourceTabTitle(displayName: string, view?: string): string {
  if (view === "ssh") return `SSH: ${displayName}`;
  if (view === "sftp") return `SFTP: ${displayName}`;
  return displayName;
}
