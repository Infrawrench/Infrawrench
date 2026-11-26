/**
 * Tying what a Terraform workspace of git.infrawrench.com manages to the
 * organisation's Infrawrench resources.
 *
 * After a workspace's state changes, its current state is read from the
 * forge, reduced to resource instances (`stateResourceInstances`: addresses,
 * types and identifying values, nothing else) and matched against the
 * organisation's synced inventory (`matchStateToInventory`). The result
 * replaces the workspace's `git_terraform_managed_resources` rows: one per
 * instance in the state, with the resource it is when one matched.
 *
 * **No plugin is named here.** What a state entry must look like to be a
 * given resource is each plugin's `terraformExport.mapResource` (the
 * Terraform type and the import id), the same source IaC reconciliation
 * reads, so the forge and the IaC tab agree.
 *
 * It calls plugin code for the whole inventory, so it runs on the gateway
 * (`pass.ts`). The state is fetched over the forge's own backend route with a
 * short-lived service token (the app shares the job token key with the
 * forge's Worker and no bucket): its bytes are held for the length of one
 * match and never stored or logged.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  matchStateToInventory,
  stateResourceInstances,
  type InventoryCandidate,
  type MatchBasis,
} from "@infrawrench/git-terraform";
import { terraformTypesFor } from "@infrawrench/client-core";

import { SHORT_TOKEN_TTL_SECONDS, mintGitJobToken } from "../ci/source.js";
import { TERRAFORM_SERVICE_PURPOSE, terraformRunUrls } from "../ci/terraform.js";
import { db } from "../db/client.js";
import {
  gitNamespaces,
  gitRepositories,
  gitTerraformManagedResources,
  gitTerraformWorkspaces,
  resources,
} from "../db/schema.js";
import { loadCapabilities, toResourceInstance, type InventoryRow } from "../iac/service.js";

/** A request to the forge as the app itself: a read-only token for one repository, ten minutes. */
export async function forgeFetch(
  repositoryId: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await mintGitJobToken(repositoryId, TERRAFORM_SERVICE_PURPOSE, {
    ttlSeconds: SHORT_TOKEN_TTL_SECONDS,
  });
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(60_000),
  });
}

type Capabilities = Awaited<ReturnType<typeof loadCapabilities>>;

/**
 * What each inventory resource would be in a state: its plugin's Terraform
 * type and import id, and its external id. A resource whose plugin has no
 * mapper, or whose mapper cannot express it, still matches by identifier
 * alone (`terraformType: null`), under the stricter "exactly one" rule.
 */
export function inventoryCandidates(
  rows: readonly InventoryRow[],
  capabilities: Capabilities,
): InventoryCandidate[] {
  return rows.map((row) => {
    let terraformType: string | null = null;
    let importId: string | null = null;
    try {
      const mapped = capabilities.capabilityFor(row.pluginId)?.mapResource(toResourceInstance(row));
      if (mapped) {
        terraformType = mapped.resource.type;
        importId = mapped.resource.importId ?? null;
      }
    } catch {
      // A mapper that throws on one row costs that row its typed match, not the pass.
    }
    if (terraformType === null) {
      const types = terraformTypesFor(capabilities.typeMap, row.pluginId, row.resourceTypeId);
      if (types.length === 1) terraformType = types[0]!;
    }
    return { resourceId: row.id, terraformType, importId, externalId: row.externalId };
  });
}

export interface ManagedRow {
  address: string;
  terraformType: string;
  provider: string | null;
  label: string | null;
  resourceId: string | null;
  matchedBy: MatchBasis | null;
}

/**
 * A state document as the rows a workspace manages: every resource instance,
 * with the inventory resource it matched. Pure, so the matching is tested
 * over fixtures with no database.
 */
export function managedRows(
  state: unknown,
  candidates: readonly InventoryCandidate[],
): { rows: ManagedRow[]; omitted: number } {
  const { instances, omitted } = stateResourceInstances(state);
  const { links } = matchStateToInventory(instances, candidates);
  const byAddress = new Map(links.map((link) => [link.address, link]));
  return {
    omitted,
    rows: instances.map((instance) => {
      const link = byAddress.get(instance.address);
      return {
        address: instance.address,
        terraformType: instance.type,
        provider: instance.provider,
        label: instance.label,
        resourceId: link?.resourceId ?? null,
        matchedBy: link?.matchedBy ?? null,
      };
    }),
  };
}

async function loadInventory(organizationId: string): Promise<InventoryRow[]> {
  return db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
      externalId: resources.externalId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      parentResourceId: resources.parentResourceId,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)))
    .orderBy(asc(resources.id));
}

/** Replaces a workspace's managed resources with `rows`, and records which state they are from. */
export async function replaceManagedResources(
  workspace: { id: string; organizationId: string },
  stateVersionId: string | null,
  rows: readonly ManagedRow[],
  linked: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(gitTerraformManagedResources)
      .where(eq(gitTerraformManagedResources.workspaceId, workspace.id));
    // An address is unique in a state; a document that repeats one keeps the first.
    const seen = new Set<string>();
    const values = rows
      .filter((row) => (seen.has(row.address) ? false : (seen.add(row.address), true)))
      .map((row) => ({
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        stateVersionId,
        ...row,
      }));
    for (let i = 0; i < values.length; i += 500) {
      await tx.insert(gitTerraformManagedResources).values(values.slice(i, i + 500));
    }
    await tx
      .update(gitTerraformWorkspaces)
      .set({
        linkedAt: new Date(),
        ...(linked ? { linkedStateVersionId: stateVersionId } : {}),
      })
      .where(eq(gitTerraformWorkspaces.id, workspace.id));
  });
}

interface LinkTarget {
  id: string;
  organizationId: string;
  name: string;
  repositoryId: string;
  repository: string;
  namespace: string;
  currentStateVersionId: string | null;
  currentSerial: number | null;
}

/** Links one workspace's current state. Returns how many of its resources matched. */
export async function linkWorkspace(
  target: LinkTarget,
  inventory?: readonly InventoryCandidate[],
): Promise<{ resources: number; matched: number }> {
  if (target.currentStateVersionId === null) {
    await replaceManagedResources(target, null, [], true);
    return { resources: 0, matched: 0 };
  }
  const { stateUrl } = terraformRunUrls(target.namespace, target.repository, target.name, "-");
  const response = await forgeFetch(target.repositoryId, stateUrl);
  if (response.status === 404) {
    // Purged since the mirror was written: it manages nothing now.
    await response.body?.cancel();
    await replaceManagedResources(target, null, [], false);
    return { resources: 0, matched: 0 };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The forge answered ${response.status} for the state of ${target.name}`);
  }
  const serial = Number(response.headers.get("x-terraform-state-serial"));
  const state: unknown = JSON.parse(await response.text());
  const candidates =
    inventory ??
    inventoryCandidates(await loadInventory(target.organizationId), await loadCapabilities());
  const { rows } = managedRows(state, candidates);
  // The mirror may trail the object by a write: then these rows are of a newer
  // state than the row names, and the workspace is linked again on a later pass.
  const current = serial === target.currentSerial;
  await replaceManagedResources(
    target,
    current ? target.currentStateVersionId : null,
    rows,
    current,
  );
  return { resources: rows.length, matched: rows.filter((row) => row.resourceId !== null).length };
}

/** How long a link stands before the inventory is matched again (a resource synced since). */
const RELINK_AFTER = sql`interval '6 hours'`;
/** How soon a workspace whose link did not take is tried again. */
const RETRY_AFTER = sql`interval '2 minutes'`;

/**
 * Links the workspaces whose state changed since they were last linked, and
 * the ones whose link is old. Every organisation's inventory is mapped once
 * per pass however many of its workspaces are due.
 */
export async function runTerraformLinkPass(limit = 5): Promise<number> {
  const due = await db
    .select({
      id: gitTerraformWorkspaces.id,
      organizationId: gitTerraformWorkspaces.organizationId,
      name: gitTerraformWorkspaces.name,
      repositoryId: gitTerraformWorkspaces.repositoryId,
      repository: gitRepositories.name,
      namespace: gitNamespaces.slug,
      currentStateVersionId: gitTerraformWorkspaces.currentStateVersionId,
      currentSerial: gitTerraformWorkspaces.currentSerial,
    })
    .from(gitTerraformWorkspaces)
    .innerJoin(gitRepositories, eq(gitRepositories.id, gitTerraformWorkspaces.repositoryId))
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(
      sql`${gitTerraformWorkspaces.organizationId} is not null and (
        (${gitTerraformWorkspaces.currentStateVersionId} is distinct from ${gitTerraformWorkspaces.linkedStateVersionId}
          and (${gitTerraformWorkspaces.linkedAt} is null or ${gitTerraformWorkspaces.linkedAt} < now() - ${RETRY_AFTER}))
        or (${gitTerraformWorkspaces.currentStateVersionId} is not null
          and ${gitTerraformWorkspaces.linkedAt} < now() - ${RELINK_AFTER})
      )`,
    )
    .orderBy(sql`${gitTerraformWorkspaces.linkedAt} asc nulls first`)
    .limit(limit);
  if (due.length === 0) return 0;

  const capabilities = await loadCapabilities();
  const inventories = new Map<string, InventoryCandidate[]>();
  for (const row of due) {
    const organizationId = row.organizationId!;
    try {
      let candidates = inventories.get(organizationId);
      if (!candidates) {
        candidates = inventoryCandidates(await loadInventory(organizationId), capabilities);
        inventories.set(organizationId, candidates);
      }
      await linkWorkspace({ ...row, organizationId }, candidates);
    } catch (err) {
      console.warn(`[terraform] could not link workspace ${row.id}:`, err);
      // Not again at once: a forge that is away is asked on a later pass.
      await db
        .update(gitTerraformWorkspaces)
        .set({ linkedAt: new Date() })
        .where(eq(gitTerraformWorkspaces.id, row.id))
        .catch(() => {});
    }
  }
  return due.length;
}
