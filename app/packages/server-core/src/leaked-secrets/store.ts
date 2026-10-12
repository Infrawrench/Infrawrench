/**
 * Reading leaked secrets: rows to the wire shape every surface renders, the
 * scanner list, and the posture summary. See `client-core/leaked-secrets.ts`
 * for the shapes and `scan.ts` for how rows get here.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type {
  LeakDismissReason,
  LeakRotationMethod,
  LeakRotationMode,
  LeakedCredentialsSummary,
  LeakedSecret,
  LeakedSecretCounts,
  LeakedSecretListResponse,
  LeakedSecretMatchConfidence,
  LeakedSecretMatchKind,
  LeakedSecretScanner,
  LeakedSecretStatus,
} from "@infrawrench/client-core";
import { LEAKED_SECRET_STATUSES } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, leakedSecretScans, leakedSecrets, resources, users } from "../db/schema";
import { loadPlugins, type LoadedPlugin } from "../plugin-loader";

export type LeakedSecretRow = typeof leakedSecrets.$inferSelect;

const STATUS_ORDER: Record<string, number> = { open: 0, rotated: 1, resolved: 2, dismissed: 3 };

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** What the one-click action does, from the match and what the plugins declare. */
export function rotationFor(
  row: Pick<
    LeakedSecretRow,
    | "matchKind"
    | "matchedPluginId"
    | "matchedResourceTypeId"
    | "matchedFieldKey"
    | "ownerPluginId"
    | "tokenFormatId"
  >,
  plugins: readonly LoadedPlugin[],
): { mode: LeakRotationMode; manageUrl: string | null } {
  const owner = plugins.find((p) => p.plugin.manifest.id === row.ownerPluginId)?.plugin;
  const format = owner?.manifest.tokenFormats?.find((f) => f.id === row.tokenFormatId);
  const manageUrl = format?.manageUrl ?? null;
  if (row.matchKind === "output") return { mode: "reissue", manageUrl };
  if (row.matchKind === "secret-field") {
    const plugin = plugins.find((p) => p.plugin.manifest.id === row.matchedPluginId)?.plugin;
    const type = plugin?.resourceTypes.find((t) => t.id === row.matchedResourceTypeId);
    const reissuable = type?.outputs.some((o) => o.key === row.matchedFieldKey) ?? false;
    return { mode: reissuable ? "reissue" : "replace", manageUrl };
  }
  if (row.matchKind === "account") return { mode: "account", manageUrl };
  return { mode: "manual", manageUrl };
}

interface Names {
  accounts: Map<string, string>;
  resources: Map<string, string>;
  users: Map<string, string>;
}

async function loadNames(rows: readonly LeakedSecretRow[]): Promise<Names> {
  const accountIds = new Set<string>();
  const resourceIds = new Set<string>();
  const userIds = new Set<string>();
  for (const r of rows) {
    accountIds.add(r.scannerAccountId);
    if (r.matchedAccountId) accountIds.add(r.matchedAccountId);
    if (r.matchedResourceId) resourceIds.add(r.matchedResourceId);
    if (r.rotatedByUserId) userIds.add(r.rotatedByUserId);
    if (r.dismissedByUserId) userIds.add(r.dismissedByUserId);
  }
  const [a, res, u] = await Promise.all([
    accountIds.size
      ? db
          .select({ id: accounts.id, name: accounts.displayName })
          .from(accounts)
          .where(inArray(accounts.id, [...accountIds]))
      : [],
    resourceIds.size
      ? db
          .select({ id: resources.id, name: resources.displayName })
          .from(resources)
          .where(inArray(resources.id, [...resourceIds]))
      : [],
    userIds.size
      ? db
          .select({ id: users.id, name: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, [...userIds]))
      : [],
  ]);
  return {
    accounts: new Map(a.map((x) => [x.id, x.name])),
    resources: new Map(res.map((x) => [x.id, x.name])),
    users: new Map(u.map((x) => [x.id, x.name ?? x.email])),
  };
}

export function toLeakedSecret(
  row: LeakedSecretRow,
  plugins: readonly LoadedPlugin[],
  names: Names,
): LeakedSecret {
  const manifestOf = (id: string | null) =>
    id ? plugins.find((p) => p.plugin.manifest.id === id)?.plugin.manifest : undefined;
  const owner = manifestOf(row.ownerPluginId);
  const format = owner?.tokenFormats?.find((f) => f.id === row.tokenFormatId);
  const scanner = manifestOf(row.scannerPluginId);
  return {
    id: row.id,
    status: row.status as LeakedSecretStatus,
    scannerAccountId: row.scannerAccountId,
    scannerAccountName: names.accounts.get(row.scannerAccountId) ?? row.scannerAccountId,
    scannerPluginId: row.scannerPluginId,
    tokenType: row.tokenType,
    tokenTypeLabel: format?.label ?? row.tokenTypeLabel ?? row.tokenType,
    ownerPluginId: row.ownerPluginId,
    ownerPluginName: owner?.displayName ?? null,
    secretHint: row.secretHint,
    repository: row.repository,
    path: row.path,
    line: row.line,
    commitSha: row.commitSha,
    url: row.upstreamUrl,
    upstreamState: row.upstreamState === "resolved" ? "resolved" : "open",
    upstreamResolution: row.upstreamResolution,
    validity:
      row.validity === "active" || row.validity === "inactive" || row.validity === "unknown"
        ? row.validity
        : null,
    publiclyLeaked: row.publiclyLeaked,
    detectedAt: row.detectedAt.toISOString(),
    firstSeenAt: row.firstSeenAt.toISOString(),
    matchKind: row.matchKind as LeakedSecretMatchKind,
    matchConfidence: row.matchConfidence as LeakedSecretMatchConfidence,
    matchedAccountId: row.matchedAccountId,
    matchedAccountName: row.matchedAccountId
      ? (names.accounts.get(row.matchedAccountId) ?? null)
      : null,
    matchedResourceId: row.matchedResourceId,
    matchedResourceName: row.matchedResourceId
      ? (names.resources.get(row.matchedResourceId) ?? null)
      : null,
    matchedResourceTypeId: row.matchedResourceTypeId,
    matchedPluginId: row.matchedPluginId,
    matchedFieldKey: row.matchedFieldKey,
    candidateAccountIds: row.candidateAccountIds,
    rotation: rotationFor(row, plugins),
    rotatedAt: iso(row.rotatedAt),
    rotatedBy: row.rotatedByUserId ? (names.users.get(row.rotatedByUserId) ?? null) : null,
    rotationMethod: (row.rotationMethod as LeakRotationMethod | null) ?? null,
    dismissedReason: (row.dismissedReason as LeakDismissReason | null) ?? null,
    dismissedComment: row.dismissedComment,
    dismissedAt: iso(row.dismissedAt),
    dismissedBy: row.dismissedByUserId ? (names.users.get(row.dismissedByUserId) ?? null) : null,
    upstreamResolvedAt: iso(row.upstreamResolvedAt),
    upstreamResolveError: row.upstreamResolveError,
    canResolveUpstream: scanner?.secretScanning?.canResolve ?? false,
  };
}

/** Map rows with every name looked up in three queries. */
export async function toLeakedSecrets(rows: readonly LeakedSecretRow[]): Promise<LeakedSecret[]> {
  const [plugins, names] = await Promise.all([loadPlugins(), loadNames(rows)]);
  return rows.map((r) => toLeakedSecret(r, plugins, names));
}

export async function getLeakRow(
  organizationId: string,
  id: string,
): Promise<LeakedSecretRow | undefined> {
  const [row] = await db
    .select()
    .from(leakedSecrets)
    .where(and(eq(leakedSecrets.id, id), eq(leakedSecrets.organizationId, organizationId)))
    .limit(1);
  return row;
}

/** The org's live accounts whose plugin declares `secretScanning`. */
export async function listScannerAccounts(
  organizationId: string | null,
  plugins: readonly LoadedPlugin[],
): Promise<Array<{ id: string; organizationId: string; pluginId: string; displayName: string }>> {
  const scannerIds = plugins
    .filter((p) => p.plugin.manifest.secretScanning)
    .map((p) => p.plugin.manifest.id);
  if (scannerIds.length === 0) return [];
  return db
    .select({
      id: accounts.id,
      organizationId: accounts.organizationId,
      pluginId: accounts.pluginId,
      displayName: accounts.displayName,
    })
    .from(accounts)
    .where(
      and(
        inArray(accounts.pluginId, scannerIds),
        isNull(accounts.deletedAt),
        ...(organizationId ? [eq(accounts.organizationId, organizationId)] : []),
      ),
    );
}

export async function listLeakedSecretScanners(
  organizationId: string,
): Promise<LeakedSecretScanner[]> {
  const plugins = await loadPlugins();
  const scannerAccounts = await listScannerAccounts(organizationId, plugins);
  if (scannerAccounts.length === 0) return [];
  const scans = await db
    .select()
    .from(leakedSecretScans)
    .where(
      inArray(
        leakedSecretScans.accountId,
        scannerAccounts.map((a) => a.id),
      ),
    );
  const byAccount = new Map(scans.map((s) => [s.accountId, s]));
  return scannerAccounts.map((a) => {
    const decl = plugins.find((p) => p.plugin.manifest.id === a.pluginId)!.plugin.manifest
      .secretScanning!;
    const scan = byAccount.get(a.id);
    return {
      accountId: a.id,
      accountName: a.displayName,
      pluginId: a.pluginId,
      label: decl.label,
      canResolve: decl.canResolve,
      returnsSecretValue: decl.returnsSecretValue,
      lastScannedAt: iso(scan?.lastScannedAt),
      lastError: scan?.lastError ?? null,
      lastCount: scan?.lastCount ?? null,
    };
  });
}

async function countByStatus(organizationId: string): Promise<LeakedSecretCounts> {
  const rows = await db
    .select({ status: leakedSecrets.status, n: sql<number>`count(*)::int` })
    .from(leakedSecrets)
    .where(eq(leakedSecrets.organizationId, organizationId))
    .groupBy(leakedSecrets.status);
  const counts = Object.fromEntries(
    LEAKED_SECRET_STATUSES.map((s) => [s, 0]),
  ) as LeakedSecretCounts;
  for (const r of rows) {
    if (r.status in counts) counts[r.status as LeakedSecretStatus] = Number(r.n);
  }
  return counts;
}

/** Most rows a list returns. Open leaks always fit: they sort first. */
const LIST_LIMIT = 500;

export async function listLeakedSecrets(
  organizationId: string,
  query: { status?: LeakedSecretStatus; accountId?: string } = {},
): Promise<LeakedSecretListResponse> {
  const conditions = [eq(leakedSecrets.organizationId, organizationId)];
  if (query.status) conditions.push(eq(leakedSecrets.status, query.status));
  if (query.accountId) {
    conditions.push(
      sql`(${leakedSecrets.matchedAccountId} = ${query.accountId} OR ${query.accountId} = ANY(${leakedSecrets.candidateAccountIds}))`,
    );
  }
  const [rows, counts, scanners] = await Promise.all([
    db
      .select()
      .from(leakedSecrets)
      .where(and(...conditions))
      .orderBy(
        sql`CASE ${leakedSecrets.status} WHEN 'open' THEN 0 WHEN 'rotated' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END`,
        desc(leakedSecrets.detectedAt),
      )
      .limit(LIST_LIMIT),
    countByStatus(organizationId),
    listLeakedSecretScanners(organizationId),
  ]);
  const leaks = await toLeakedSecrets(rows);
  leaks.sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
      b.detectedAt.localeCompare(a.detectedAt),
  );
  return { leaks, counts, scanners, generatedAt: new Date().toISOString() };
}

/** The posture feed's "Leaked credentials" category. */
export async function leakedCredentialsSummary(
  organizationId: string,
): Promise<LeakedCredentialsSummary> {
  const plugins = await loadPlugins();
  const [scannerAccounts, [row]] = await Promise.all([
    listScannerAccounts(organizationId, plugins),
    db
      .select({
        open: sql<number>`count(*)::int`,
        matched: sql<number>`count(*) FILTER (WHERE ${leakedSecrets.matchKind} <> 'none')::int`,
      })
      .from(leakedSecrets)
      .where(
        and(eq(leakedSecrets.organizationId, organizationId), eq(leakedSecrets.status, "open")),
      ),
  ]);
  return {
    open: Number(row?.open ?? 0),
    matched: Number(row?.matched ?? 0),
    scanners: scannerAccounts.length,
  };
}
