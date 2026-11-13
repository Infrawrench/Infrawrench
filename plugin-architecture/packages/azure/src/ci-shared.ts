/**
 * What the Azure CI executors share. Every job's compute lives in a resource
 * group of its own, `iwci-<kind>-<job key>`, tagged with the job's tags:
 * teardown deletes the group, and the reaper lists groups by tag. ARM calls
 * go through an injectable {@link ArmCall}, so tests use a fake with no
 * network.
 *
 * **Wire shapes verified against the Azure REST API reference and the
 * azure-rest-api-specs swagger, November 2026.** These documents refer to
 * shared files outside themselves (`../../../../../../common-types/...`),
 * which plugingen refuses by design, so the paths here are written by hand
 * against the reference:
 * - Resource Groups (2025-04-01): PUT `{location, tags}`, DELETE (202, long
 *   running), GET, and List with `$filter=tagName eq '...'`. Tag names are
 *   at most 512 characters and may not hold `<>%&\?/`; values at most 256.
 * - Role Assignments - List For Subscription (2022-04-01) with
 *   `$filter=principalId eq '{id}'` (at, above or below the subscription),
 *   and Role Definitions - Get: `properties.permissions[].{actions,
 *   notActions}`, where `*` matches any run of characters.
 * - Providers - Get: `registrationState`.
 */
import type { CiExecutorKind, CiMissingPermission } from "@infrawrench/plugin-base";

export const RESOURCES_API = "2025-04-01";
const AUTHORIZATION_API = "2022-04-01";

/** One ARM request: a path under `https://management.azure.com`, never throws on a status. */
export type ArmCall = (
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

export interface AzureCiCalls {
  arm: ArmCall;
  subscriptionId: string;
  /** The object id of the service principal the connection signs in as. */
  principalId(): Promise<string>;
  /** Waits between polls; a test passes one that does not. */
  sleep?(ms: number): Promise<void>;
  /** Now, for the created-at tag and timers; a test pins it. */
  now?(): number;
}

export function sleepOf(calls: AzureCiCalls): (ms: number) => Promise<void> {
  return calls.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export function nowOf(calls: AzureCiCalls): number {
  return calls.now?.() ?? Date.now();
}

/** ARM's error text from an answer, for a message. */
export function armError(answer: { status: number; body: unknown }): string {
  const err = (answer.body as { error?: { code?: string; message?: string } } | null)?.error;
  const text = [err?.code, err?.message].filter(Boolean).join(": ");
  return `Azure answered ${answer.status}${text ? `: ${text}` : ""}`;
}

/** Throws ARM's error unless the answer is a 2xx. */
export function ok<T>(answer: { status: number; body: unknown }, what: string): T {
  if (answer.status >= 200 && answer.status < 300) return (answer.body ?? {}) as T;
  throw new Error(`${what}: ${armError(answer)}`);
}

/** The tag that says when a group was made; listed tags leave it out. */
export const CREATED_TAG = "infrawrench-ci-created";

/** The job's tags as Azure takes them: forbidden characters out, values cut to 256. */
export function azureTags(tags: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    out[key.replace(/[<>%&\\?/]/g, "_").slice(0, 512)] = value.slice(0, 256);
  }
  return out;
}

/** The resource group of a job's compute. */
export function groupName(kind: CiExecutorKind, key: string): string {
  return `iwci-${kind}-${key}`;
}

/** The kind a group holds, from its name. */
export function kindOfGroup(name: string): CiExecutorKind | null {
  const match = /^iwci-(vm|container|build)-[0-9a-f]{32}$/.exec(name);
  return match ? (match[1] as CiExecutorKind) : null;
}

export function groupPath(subscriptionId: string, group: string): string {
  return `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(group)}`;
}

/** Make (or find) a job's resource group, tagged with its tags and when it was made. */
export async function putGroup(
  calls: AzureCiCalls,
  group: string,
  location: string,
  tags: Readonly<Record<string, string>>,
): Promise<void> {
  const path = `${groupPath(calls.subscriptionId, group)}?api-version=${RESOURCES_API}`;
  const existing = await calls.arm("GET", path);
  if (existing.status === 200) return;
  ok(
    await calls.arm("PUT", path, {
      location,
      tags: { ...azureTags(tags), [CREATED_TAG]: new Date(nowOf(calls)).toISOString() },
    }),
    `Azure did not make the resource group ${group}`,
  );
}

/** Delete a job's resource group and everything in it. Done when it is already gone. */
export async function deleteGroup(calls: AzureCiCalls, group: string): Promise<void> {
  const answer = await calls.arm(
    "DELETE",
    `${groupPath(calls.subscriptionId, group)}?api-version=${RESOURCES_API}`,
  );
  if (answer.status === 404 || (answer.status >= 200 && answer.status < 300)) return;
  // A group already being deleted answers a conflict; it is on its way out.
  if (answer.status === 409 && /Deleting|being deleted/i.test(armError(answer))) return;
  throw new Error(`Azure did not delete the resource group ${group}: ${armError(answer)}`);
}

export interface TaggedGroup {
  name: string;
  location: string;
  tags: Record<string, string>;
  createdAt?: string;
  deleting: boolean;
}

/** Every CI resource group carrying `tagKey`. */
export async function listTaggedGroups(
  calls: AzureCiCalls,
  tagKey: string,
): Promise<TaggedGroup[]> {
  const out: TaggedGroup[] = [];
  const filter = encodeURIComponent(`tagName eq '${tagKey.replace(/'/g, "''")}'`);
  let next: string | undefined =
    `/subscriptions/${calls.subscriptionId}/resourcegroups?api-version=${RESOURCES_API}&$filter=${filter}`;
  while (next) {
    const page: {
      value?: Array<{
        name?: string;
        location?: string;
        tags?: Record<string, string>;
        properties?: { provisioningState?: string };
      }>;
      nextLink?: string;
    } = ok(await calls.arm("GET", next), "Azure did not list resource groups");
    for (const group of page.value ?? []) {
      if (!group.name || !kindOfGroup(group.name)) continue;
      const { [CREATED_TAG]: created, ...tags } = group.tags ?? {};
      out.push({
        name: group.name,
        location: group.location ?? "",
        tags,
        ...(created ? { createdAt: created } : {}),
        deleting: group.properties?.provisioningState === "Deleting",
      });
    }
    next = page.nextLink
      ? page.nextLink.replace(/^https:\/\/management\.azure\.com/i, "")
      : undefined;
  }
  return out;
}

/** Whether `pattern` (with `*` wildcards) matches `action`, as Azure RBAC compares them. */
export function actionMatches(pattern: string, action: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i",
  );
  return regex.test(action);
}

/**
 * Which of `needed` the service principal lacks across the subscription,
 * from its own role assignments at the subscription or above (a management
 * group, the root). Roles it holds only through a group, or only on one
 * resource group, are not seen, so those read as missing.
 */
export async function missingRoleActions(
  calls: AzureCiCalls,
  needed: readonly CiMissingPermission[],
): Promise<CiMissingPermission[]> {
  const principal = await calls.principalId();
  const subscriptionScope = `/subscriptions/${calls.subscriptionId}`.toLowerCase();
  const filter = encodeURIComponent(`principalId eq '${principal}'`);
  const assignments: Array<{ scope: string; roleDefinitionId: string }> = [];
  let next: string | undefined =
    `${subscriptionScope}/providers/Microsoft.Authorization/roleAssignments?api-version=${AUTHORIZATION_API}&$filter=${filter}`;
  while (next) {
    const page: {
      value?: Array<{ properties?: { scope?: string; roleDefinitionId?: string } }>;
      nextLink?: string;
    } = ok(await calls.arm("GET", next), "Azure did not list the role assignments");
    for (const a of page.value ?? []) {
      const scope = (a.properties?.scope ?? "").toLowerCase();
      const role = a.properties?.roleDefinitionId;
      const atOrAbove =
        scope === "/" ||
        scope === subscriptionScope ||
        scope.startsWith("/providers/microsoft.management/managementgroups/");
      if (role && atOrAbove) assignments.push({ scope, roleDefinitionId: role });
    }
    next = page.nextLink
      ? page.nextLink.replace(/^https:\/\/management\.azure\.com/i, "")
      : undefined;
  }
  const grants: Array<{ actions: string[]; notActions: string[] }> = [];
  for (const id of new Set(assignments.map((a) => a.roleDefinitionId))) {
    const role: {
      properties?: { permissions?: Array<{ actions?: string[]; notActions?: string[] }> };
    } = ok(
      await calls.arm("GET", `${id}?api-version=${AUTHORIZATION_API}`),
      "Azure did not read a role definition",
    );
    for (const p of role.properties?.permissions ?? []) {
      grants.push({ actions: p.actions ?? [], notActions: p.notActions ?? [] });
    }
  }
  const allowed = (action: string) =>
    grants.some(
      (g) =>
        g.actions.some((a) => actionMatches(a, action)) &&
        !g.notActions.some((n) => actionMatches(n, action)),
    );
  return needed.filter((p) => !allowed(p.permission));
}

/** A problem sentence for each resource provider the subscription has not registered. */
export async function unregisteredProviders(
  calls: AzureCiCalls,
  namespaces: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const ns of namespaces) {
    const answer = await calls.arm(
      "GET",
      `/subscriptions/${calls.subscriptionId}/providers/${ns}?api-version=${RESOURCES_API}`,
    );
    if (answer.status !== 200) continue;
    const state = (answer.body as { registrationState?: string } | null)?.registrationState;
    if (state && state !== "Registered" && state !== "Registering") {
      problems.push(
        `The subscription has not registered the ${ns} resource provider. Register it under Subscriptions, Resource providers, or with \`az provider register --namespace ${ns}\`.`,
      );
    }
  }
  return problems;
}

/** Resource group permissions every kind needs. */
export const GROUP_PERMISSIONS = {
  write: {
    permission: "Microsoft.Resources/subscriptions/resourceGroups/write",
    label: "Make a resource group for the job",
  },
  read: {
    permission: "Microsoft.Resources/subscriptions/resourceGroups/read",
    label: "Find leftovers",
  },
  delete: {
    permission: "Microsoft.Resources/subscriptions/resourceGroups/delete",
    label: "Delete it, and all in it, when the job ends",
  },
} as const satisfies Record<string, CiMissingPermission>;

/** A random password Azure's rules accept (upper, lower, digit, symbol), never stored. */
export function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const body = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${body}Aa1!`;
}

/** UTF-8 text as base64, in Node and the renderer alike. */
export function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
