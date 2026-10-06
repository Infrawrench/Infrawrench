import type {
  ActionNode,
  HostServices,
  KVItem,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";

/** Small helpers shared by the Railway client, mappers and renderer. */

export const PLUGIN_ID = "railway";

export function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

export const enc = encodeURIComponent;

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  parentTypeId?: string;
  parentExternalId?: string;
  createdAt?: string;
  updatedAt?: string;
}): ResourceInstance {
  const now = new Date().toISOString();
  const fields: Fields = {};
  for (const [k, v] of Object.entries(opts.fields)) {
    if (v !== undefined && v !== null) fields[k] = v;
  }
  return {
    id: `${opts.accountId}:${opts.typeId}:${opts.externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: opts.typeId,
    accountId: opts.accountId,
    displayName: opts.displayName || opts.externalId,
    fields,
    resolvedOutputs: opts.outputs ?? {},
    secretStates: [],
    externalId: opts.externalId,
    ...(opts.parentTypeId && opts.parentExternalId
      ? { parentResourceId: `${opts.accountId}:${opts.parentTypeId}:${opts.parentExternalId}` }
      : {}),
    createdAt: opts.createdAt || now,
    updatedAt: opts.updatedAt || opts.createdAt || now,
    lastSyncedAt: now,
  };
}

/** Bare externalId of a host resource id (`account:type:external`). */
export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

/** Split a `<scope>/<id>` externalId (or a full host resource id) into its parts. */
export function parseScopedId(resourceIdOrExternal: string): { scope: string; id: string } {
  const external = externalOf(resourceIdOrExternal);
  const slash = external.indexOf("/");
  if (slash <= 0 || slash === external.length - 1) {
    throw new Error(`Railway plugin: cannot parse resource id "${resourceIdOrExternal}"`);
  }
  return { scope: external.slice(0, slash), id: external.slice(slash + 1) };
}

/** Values of a `prompt-nosql-command` form arrive as one JSON string. */
export function parseFormArg(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = String(v ?? "");
    return out;
  } catch {
    return {};
  }
}

export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export function cached<T>(
  slot: Cached<T> | undefined,
  ttl: number,
  load: () => Promise<T>,
): Cached<T> {
  if (slot && Date.now() - slot.at < ttl) return slot;
  const value = load();
  const next = { at: Date.now(), value };
  value.catch(() => {
    next.at = 0;
  });
  return next;
}

export function pluginAction(
  label: string,
  actionId: string,
  opts: { confirm?: string; success: string; danger?: boolean; destructive?: boolean },
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      successMessage: opts.success,
      ...(opts.destructive ? { destructive: true } : {}),
    },
    ...(opts.danger ? { variant: "danger" as const } : {}),
  };
}

/** Key/value rows for every declared, non-secret field the instance holds. */
export function fieldItems(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
  skip: string[] = [],
): KVItem[] {
  const typeDef = resourceTypes.find((t) => t.id === resource.resourceTypeId);
  const items: KVItem[] = [];
  for (const def of typeDef?.fields ?? []) {
    if (def.kind === "password" || skip.includes(def.key)) continue;
    const v = resource.fields[def.key];
    if (v === undefined || v === "") continue;
    items.push({
      key: def.label,
      value: typeof v === "boolean" ? (v ? "Yes" : "No") : String(v),
      ...(/id$|url$|command$|path$/i.test(def.key) ? { copyable: true } : {}),
    });
  }
  return items;
}

// ── Errors ─────────────────────────────────────────────────────────────

export class RailwayApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RailwayApiError";
    this.status = status;
  }
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    statuses.includes((err as { status: number }).status)
  );
}

/** Railway timestamps are ISO strings; metric samples are epoch seconds. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
