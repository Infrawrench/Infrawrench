/**
 * Writing deploy events: from a sync pass (each plugin maps its own rows) and
 * from the API (`POST /dora/deployments`, for a CI no plugin covers).
 *
 * Recording never breaks the caller. A sync pass that cannot record its
 * deploys still synced its resources; the next pass sees the same deploys and
 * writes them then, because the write is an upsert on (org, external key).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  resolveDeployEvent,
  type DeployEventResource,
  type Plugin,
  type ResourceInstance,
} from "@infrawrench/plugin-base";
import type { DoraDeploymentInput } from "@infrawrench/client-core";
import { db } from "../db/client";
import { deployEvents, resources } from "../db/schema";
import { normalizeRepository } from "./repository";

type DeployEventRow = typeof deployEvents.$inferInsert;

function asDeployResource(r: {
  resourceTypeId: string;
  externalId?: string | null;
  displayName: string;
  fields?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
}): DeployEventResource {
  return {
    resourceTypeId: r.resourceTypeId,
    externalId: r.externalId ?? null,
    displayName: r.displayName,
    fields: r.fields ?? {},
    outputs: r.outputs ?? {},
  };
}

/**
 * Map a pass's fetched rows to deploy events with the plugin's capability and
 * upsert them. `fetched` is everything the pass listed, which is where a
 * deploy's project/service row is usually found; anything missing is looked
 * up from the stored inventory.
 */
export async function recordDeployEventsFromSync(
  organizationId: string,
  accountId: string,
  plugin: Plugin,
  fetched: ResourceInstance[],
): Promise<number> {
  const capability = plugin.deployEvents;
  if (!capability) return 0;
  const deployRows = fetched.filter((r) => capability.resourceTypeIds.includes(r.resourceTypeId));
  if (deployRows.length === 0) return 0;

  const byId = new Map(fetched.map((r) => [r.id, r]));
  const targetIdOf = (r: ResourceInstance): string | null => {
    if (r.parentResourceId) return r.parentResourceId;
    const t = capability.targetOf?.(asDeployResource({ ...r, outputs: r.resolvedOutputs }));
    // Resource ids are `<account>:<type>:<external id>` everywhere.
    return t ? `${accountId}:${t.resourceTypeId}:${t.externalId}` : null;
  };
  const missing = [
    ...new Set(deployRows.map(targetIdOf).filter((id): id is string => !!id && !byId.has(id))),
  ];
  const stored = new Map<string, DeployEventResource>();
  if (missing.length > 0) {
    const rows = await db
      .select({
        id: resources.id,
        resourceTypeId: resources.resourceTypeId,
        externalId: resources.externalId,
        displayName: resources.displayName,
        fields: resources.fieldsJson,
        outputs: resources.outputsJson,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, missing)));
    for (const r of rows) stored.set(r.id, asDeployResource(r));
  }

  const now = new Date();
  const rows: DeployEventRow[] = [];
  for (const r of deployRows) {
    const targetId = targetIdOf(r);
    const targetInstance = targetId ? byId.get(targetId) : undefined;
    const target = targetInstance
      ? asDeployResource({ ...targetInstance, outputs: targetInstance.resolvedOutputs })
      : targetId
        ? (stored.get(targetId) ?? null)
        : null;
    const facts = resolveDeployEvent(
      capability,
      asDeployResource({ ...r, outputs: r.resolvedOutputs }),
      target,
    );
    if (!facts) continue;
    rows.push({
      id: crypto.randomUUID(),
      organizationId,
      source: "plugin",
      externalKey: r.id,
      accountId,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      resourceId: r.id,
      targetResourceId: targetId,
      kind: facts.kind,
      name: facts.name,
      environment: facts.environment,
      repository: normalizeRepository(facts.repository),
      commitSha: facts.commitSha,
      commitAt: facts.commitAt ? new Date(facts.commitAt) : null,
      deployedAt: new Date(facts.deployedAt),
      status: facts.status,
      isRollback: facts.isRollback,
      url: facts.url,
      updatedAt: now,
    });
  }
  await upsertDeployEvents(rows);
  return rows.length;
}

/** Upsert in chunks; a re-seen deploy updates in place. */
export async function upsertDeployEvents(rows: DeployEventRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await db
      .insert(deployEvents)
      .values(chunk)
      .onConflictDoUpdate({
        target: [deployEvents.organizationId, deployEvents.externalKey],
        set: {
          name: sql`excluded.name`,
          environment: sql`excluded.environment`,
          repository: sql`excluded.repository`,
          commitSha: sql`excluded.commit_sha`,
          // A provider that stops reporting the commit time must not erase it.
          commitAt: sql`COALESCE(excluded.commit_at, ${deployEvents.commitAt})`,
          deployedAt: sql`excluded.deployed_at`,
          status: sql`excluded.status`,
          isRollback: sql`excluded.is_rollback`,
          url: sql`excluded.url`,
          targetResourceId: sql`excluded.target_resource_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
}

export class DoraInputError extends Error {
  readonly status = 400 as const;
}

const STATUSES = ["success", "failure", "in_progress", "canceled"] as const;

/** Record (or update) a deploy pushed in over the API. Returns the row's id. */
export async function recordApiDeployEvent(
  organizationId: string,
  input: DoraDeploymentInput,
): Promise<{ id: string }> {
  const str = (v: unknown, max: number, label: string, required = false): string | null => {
    if (v === undefined || v === null || v === "") {
      if (required) throw new DoraInputError(`${label} is required`);
      return null;
    }
    if (typeof v !== "string") throw new DoraInputError(`${label} must be a string`);
    const s = v.trim();
    if (s.length > max) throw new DoraInputError(`${label} is at most ${max} characters`);
    if (required && !s) throw new DoraInputError(`${label} is required`);
    return s || null;
  };
  const time = (v: unknown, label: string, required = false): Date | null => {
    const s = str(v, 64, label, required);
    if (s === null) return null;
    const t = Date.parse(s);
    if (!Number.isFinite(t)) throw new DoraInputError(`${label} must be an ISO 8601 timestamp`);
    return new Date(t);
  };
  const externalId = str(input.externalId, 200, "externalId", true)!;
  const status = input.status ?? "success";
  if (!STATUSES.includes(status)) {
    throw new DoraInputError(`status must be one of ${STATUSES.join(", ")}`);
  }
  if (input.isRollback !== undefined && typeof input.isRollback !== "boolean") {
    throw new DoraInputError("isRollback must be a boolean");
  }
  const sha = str(input.commitSha, 64, "commitSha");
  if (sha && !/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new DoraInputError("commitSha must be a hexadecimal commit SHA");
  }
  const url = str(input.url, 2000, "url");
  if (url && !/^https?:\/\//i.test(url)) throw new DoraInputError("url must be an http(s) URL");
  const row: DeployEventRow = {
    id: crypto.randomUUID(),
    organizationId,
    source: "api",
    externalKey: `api:${externalId}`,
    kind: "deployment",
    name: str(input.name, 300, "name", true)!,
    environment: str(input.environment, 200, "environment", true),
    repository: normalizeRepository(str(input.repository, 300, "repository")),
    commitSha: sha,
    commitAt: time(input.commitAt, "commitAt"),
    deployedAt: time(input.deployedAt, "deployedAt", true)!,
    status,
    isRollback: input.isRollback === true,
    url,
    updatedAt: new Date(),
  };
  await upsertDeployEvents([row]);
  const [saved] = await db
    .select({ id: deployEvents.id })
    .from(deployEvents)
    .where(
      and(
        eq(deployEvents.organizationId, organizationId),
        eq(deployEvents.externalKey, row.externalKey),
      ),
    );
  return { id: saved?.id ?? row.id };
}
