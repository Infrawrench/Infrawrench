import {
  fetchAccountResources,
  fetchIncidents,
  fetchResourceSpend,
  fetchResourceVulnerabilities,
  fetchServicesForResources,
  postureFindingsByResource,
  resourceStatusFromFields,
  type AccountResourceRow,
  type Incident,
  type IacResourceStatusResponse,
  type PostureFinding,
  type PostureListResponse,
  type ResourceSpend,
  type ResourceVulnerabilityTally,
  type SearchResult,
  type ServiceRef,
} from "@infrawrench/client-core";
import type { Client } from "./client";

/**
 * Everything the resource detail pane shows, each part loaded independently:
 * a key without `costs:read` still sees status and findings, and the part it
 * cannot read says so instead of failing the whole pane.
 */
export interface ResourceInsight {
  row: AccountResourceRow | null;
  status: string | null;
  spend: Part<ResourceSpend[]>;
  iac: Part<IacResourceStatusResponse>;
  services: Part<ServiceRef[]>;
  findings: Part<PostureFinding[]>;
  /** Null when no connected account runs a scanner: unknown, not clean. */
  vulnerabilities: Part<ResourceVulnerabilityTally | null>;
  incidents: Part<Incident[]>;
}

export type Part<T> = { ok: true; value: T } | { ok: false; error: string };

async function part<T>(load: () => Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const TTL_MS = 2 * 60 * 1000;
const accountRows = new Map<string, { at: number; rows: Promise<AccountResourceRow[]> }>();
let posture: { at: number; key: string; feed: Promise<PostureListResponse | null> } | null = null;

function cachedAccountRows(client: Client, accountId: string): Promise<AccountResourceRow[]> {
  const key = `${client.orgId}:${accountId}`;
  const hit = accountRows.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows = fetchAccountResources(client.api, client.orgId, accountId);
  accountRows.set(key, { at: Date.now(), rows });
  rows.catch(() => accountRows.delete(key));
  return rows;
}

function cachedPosture(client: Client): Promise<PostureListResponse | null> {
  if (posture && posture.key === client.orgId && Date.now() - posture.at < TTL_MS) {
    return posture.feed;
  }
  const feed = client.api.org<PostureListResponse>(client.orgId, "/posture");
  posture = { at: Date.now(), key: client.orgId, feed };
  feed.catch(() => {
    posture = null;
  });
  return feed;
}

export async function loadResourceInsight(
  client: Client,
  r: SearchResult,
): Promise<ResourceInsight> {
  const rowPart = await part(
    async () => (await cachedAccountRows(client, r.accountId)).find((x) => x.id === r.id) ?? null,
  );
  const row = rowPart.ok ? rowPart.value : null;
  const [spend, iac, services, findings, vulnerabilities, incidents] = await Promise.all([
    part(async () => {
      if (!row?.externalId) return [];
      const map = await fetchResourceSpend(client.api, client.orgId, [
        { externalId: row.externalId, accountId: r.accountId },
      ]);
      return map.get(row.externalId) ?? [];
    }),
    part(async () => {
      const res = await client.api.org<IacResourceStatusResponse>(
        client.orgId,
        `/iac/resource?resourceId=${encodeURIComponent(r.id)}`,
      );
      if (!res) throw new Error("No answer");
      return res;
    }),
    part(
      async () =>
        (await fetchServicesForResources(client.api, client.orgId, [r.id])).services[r.id] ?? [],
    ),
    part(async () => {
      const feed = await cachedPosture(client);
      return feed ? (postureFindingsByResource(feed).get(r.id) ?? []) : [];
    }),
    part(async () => {
      const res = await fetchResourceVulnerabilities(client.api, client.orgId, [r.id]);
      return res.byResource.get(r.id) ?? null;
    }),
    part(async () =>
      (await fetchIncidents(client.api, client.orgId)).incidents.filter(
        (i) => i.status !== "resolved" && i.affectedResourceIds.includes(r.id),
      ),
    ),
  ]);
  return {
    row,
    status: resourceStatusFromFields(row?.fieldsJson ?? null),
    spend,
    iac,
    services,
    findings,
    vulnerabilities,
    incidents,
  };
}
