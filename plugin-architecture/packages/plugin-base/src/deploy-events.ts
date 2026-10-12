/**
 * Deploy events: the plugin half of the host's DORA metrics.
 *
 * Many providers already sync one row per deploy (a Vercel deployment, a
 * Netlify deploy, a Render deploy, a Buildkite build). Only the plugin knows
 * which of its fields is the commit, which is the environment and which state
 * means "it shipped", so the mapping lives here, on the Plugin, as pure work
 * over stored rows: no credentials, no API calls, and no provider knowledge in
 * the host. Hosts call it through `resolveDeployEvent`, which catches and
 * validates, so a plugin bug costs one event and never a sync.
 */

/** A stored resource row, as the host hands it to the mapper. */
export interface DeployEventResource {
  resourceTypeId: string;
  externalId: string | null;
  displayName: string;
  fields: Record<string, unknown>;
  /** Stored outputs (URLs often live here). */
  outputs?: Record<string, unknown>;
}

export type DeployEventStatus = "success" | "failure" | "in_progress" | "canceled";

/** What a plugin can say about one deploy. */
export interface DeployEventFacts {
  /**
   * `deployment` ships something to an environment. `pipeline` is a CI run
   * that is only a deploy when the org's pipeline patterns say its name is
   * one (a provider cannot tell a deploy pipeline from a test pipeline).
   */
  kind: "deployment" | "pipeline";
  /** What a person calls the deployed thing: project, site, service, pipeline. */
  name: string;
  /** Environment name as the provider spells it; null when it has none. */
  environment: string | null;
  /** `owner/name` or a repository URL; the host normalizes. */
  repository: string | null;
  /** Full or abbreviated commit SHA. */
  commitSha: string | null;
  /** When the commit was authored, ISO, when the provider says. */
  commitAt: string | null;
  /** When the deploy reached its environment (or started, if that is all there is), ISO. */
  deployedAt: string;
  status: DeployEventStatus;
  /** The provider marked this deploy as a rollback or a revert to an earlier one. */
  isRollback: boolean;
  url: string | null;
}

export interface DeployEventsCapability {
  /** Resource types whose rows are single deploys or runs. */
  resourceTypeIds: string[];
  /**
   * Map one row to a deploy event, or null when the row is not one (a preview
   * that never finished, an operation that is not a deploy). `target` is the
   * project/service row the deploy belongs to when the host found it: the
   * parent row, or whatever `targetOf` named.
   */
  toDeployEvent(
    resource: DeployEventResource,
    target: DeployEventResource | null,
  ): DeployEventFacts | null;
  /**
   * Where the deployed thing is when the row carries no parent link (Vercel
   * deployments name their project in a field). Optional.
   */
  targetOf?(resource: DeployEventResource): { resourceTypeId: string; externalId: string } | null;
}

const STATUSES: readonly DeployEventStatus[] = ["success", "failure", "in_progress", "canceled"];

/** A field as a trimmed string, or null when absent, empty or a placeholder dash. */
export function deployField(resource: DeployEventResource, key: string): string | null {
  const v = resource.fields[key];
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s === "—" || s === "-") return null;
  return s;
}

/** An output as a trimmed string, or null. */
export function deployOutput(resource: DeployEventResource, key: string): string | null {
  const v = resource.outputs?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A timestamp field (ISO string or epoch ms) as ISO, or null. */
export function deployTime(resource: DeployEventResource, key: string): string | null {
  const v = resource.fields[key];
  let t: number;
  if (typeof v === "number") t = v < 1e12 ? v * 1000 : v;
  else if (typeof v === "string" && v.trim()) t = Date.parse(v);
  else return null;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Bucket a provider state into the four statuses by lowercase membership. */
export function deployStatusFrom(
  raw: string | null,
  map: { success: string[]; failure: string[]; canceled?: string[] },
): DeployEventStatus {
  const s = (raw ?? "").toLowerCase();
  if (map.success.includes(s)) return "success";
  if (map.failure.includes(s)) return "failure";
  if (map.canceled?.includes(s)) return "canceled";
  return "in_progress";
}

/**
 * Call a plugin's mapper defensively. Returns null for a non-deploy type, a
 * thrown mapper, or facts that fail validation.
 */
export function resolveDeployEvent(
  capability: DeployEventsCapability | undefined,
  resource: DeployEventResource,
  target: DeployEventResource | null,
): DeployEventFacts | null {
  if (!capability || !capability.resourceTypeIds.includes(resource.resourceTypeId)) return null;
  let raw: unknown;
  try {
    raw = capability.toDeployEvent(resource, target);
  } catch (err) {
    console.error("[deploy-events] plugin threw while mapping a deploy:", err);
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Partial<DeployEventFacts>;
  if (f.kind !== "deployment" && f.kind !== "pipeline") return null;
  if (typeof f.deployedAt !== "string" || !Number.isFinite(Date.parse(f.deployedAt))) return null;
  if (!f.status || !STATUSES.includes(f.status)) return null;
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  const commitAt = str(f.commitAt, 64);
  return {
    kind: f.kind,
    name: str(f.name, 300) ?? resource.displayName,
    environment: str(f.environment, 200),
    repository: str(f.repository, 300),
    commitSha: str(f.commitSha, 64),
    commitAt: commitAt && Number.isFinite(Date.parse(commitAt)) ? commitAt : null,
    deployedAt: new Date(Date.parse(f.deployedAt)).toISOString(),
    status: f.status,
    isRollback: f.isRollback === true,
    url: str(f.url, 2000),
  };
}
