/**
 * Services: CRUD, membership resolution and the wire assembly shared by the
 * web API, the scorecard evaluator, the digest and the alert paths.
 *
 * Validation is `validateServiceInput` from client-core, the function the
 * editors run, so the form and the API reject the same inputs with the same
 * words.
 *
 * Membership is resolved **on read**: explicit `include` rows, plus every
 * synced resource a rule matches, minus `exclude` rows. Nothing is
 * materialised, the posture and orphan stance: a newly tagged resource joins
 * on the next read without a pass having to notice it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  SERVICE_DEFAULTS,
  SERVICE_LIMITS,
  isServiceTier,
  normalizeServiceRule,
  serviceRuleMatches,
  slugifyServiceName,
  validateServiceInput,
  type Service,
  type ServiceInput,
  type ServiceLink,
  type ServiceMember,
  type ServiceMembershipRule,
  type ServiceScoreBadge,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import {
  accounts,
  onCallSchedules,
  organizationMembers,
  resources,
  runbooks,
  scorecardResults,
  scorecards,
  serviceLinks,
  serviceMembers,
  serviceOwners,
  services,
  slos,
  users,
} from "../db/schema";
import { lookupResourceOwners } from "../ownership/store";

export type ServiceRecord = typeof services.$inferSelect;

/** Thrown for caller mistakes the API maps to 400/404/409. */
export class ServiceInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ServiceInputError";
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listServiceRecords(organizationId: string): Promise<ServiceRecord[]> {
  return db
    .select()
    .from(services)
    .where(eq(services.organizationId, organizationId))
    .orderBy(services.name);
}

/** By id or by slug: the CLI and URLs address a service by either. */
export async function getServiceRecord(
  organizationId: string,
  idOrSlug: string,
): Promise<ServiceRecord | null> {
  const [row] = await db
    .select()
    .from(services)
    .where(
      and(
        eq(services.organizationId, organizationId),
        sql`(${services.id} = ${idOrSlug} OR ${services.slug} = ${idOrSlug})`,
      ),
    )
    .limit(1);
  return row ?? null;
}

interface ServiceRelations {
  owners: Map<string, Service["owners"]>;
  links: Map<string, { sloIds: string[]; runbookIds: string[] }>;
  scheduleNames: Map<string, string>;
  scores: Map<string, ServiceScoreBadge[]>;
}

async function loadRelations(
  organizationId: string,
  rows: readonly ServiceRecord[],
): Promise<ServiceRelations> {
  const ids = rows.map((r) => r.id);
  const out: ServiceRelations = {
    owners: new Map(),
    links: new Map(),
    scheduleNames: new Map(),
    scores: new Map(),
  };
  if (ids.length === 0) return out;
  const [ownerRows, linkRows, scheduleRows, scoreRows] = await Promise.all([
    db
      .select({
        serviceId: serviceOwners.serviceId,
        userId: users.id,
        name: users.displayName,
        email: users.email,
      })
      .from(serviceOwners)
      .innerJoin(users, eq(users.id, serviceOwners.userId))
      .where(inArray(serviceOwners.serviceId, ids)),
    db
      .select({
        serviceId: serviceLinks.serviceId,
        kind: serviceLinks.kind,
        targetId: serviceLinks.targetId,
      })
      .from(serviceLinks)
      .where(inArray(serviceLinks.serviceId, ids)),
    db
      .select({ id: onCallSchedules.id, name: onCallSchedules.name })
      .from(onCallSchedules)
      .where(eq(onCallSchedules.organizationId, organizationId)),
    db
      .select({
        serviceId: scorecardResults.serviceId,
        scorecardId: scorecardResults.scorecardId,
        scorecardName: scorecards.name,
        levels: scorecards.levels,
        score: scorecardResults.score,
        level: scorecardResults.level,
      })
      .from(scorecardResults)
      .innerJoin(scorecards, eq(scorecards.id, scorecardResults.scorecardId))
      .where(
        and(eq(scorecardResults.organizationId, organizationId), eq(scorecards.enabled, true)),
      ),
  ]);
  for (const row of ownerRows) {
    const list = out.owners.get(row.serviceId) ?? [];
    list.push({ userId: row.userId, name: row.name, email: row.email });
    out.owners.set(row.serviceId, list);
  }
  for (const row of linkRows) {
    const entry = out.links.get(row.serviceId) ?? { sloIds: [], runbookIds: [] };
    if (row.kind === "slo") entry.sloIds.push(row.targetId);
    else entry.runbookIds.push(row.targetId);
    out.links.set(row.serviceId, entry);
  }
  for (const row of scheduleRows) out.scheduleNames.set(row.id, row.name);
  for (const row of scoreRows) {
    const list = out.scores.get(row.serviceId) ?? [];
    list.push({
      scorecardId: row.scorecardId,
      scorecardName: row.scorecardName,
      score: row.score,
      level: row.level,
      levelName: row.levels.find((l) => l.key === row.level)?.name ?? null,
    });
    out.scores.set(row.serviceId, list);
  }
  return out;
}

export function serviceToWire(
  row: ServiceRecord,
  relations: ServiceRelations,
  memberCount: number,
): Service {
  const links = relations.links.get(row.id) ?? { sloIds: [], runbookIds: [] };
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    tier: isServiceTier(row.tier) ? row.tier : null,
    ownerTeam: row.ownerTeam,
    ownerUserIds: (relations.owners.get(row.id) ?? []).map((o) => o.userId),
    owners: relations.owners.get(row.id) ?? [],
    links: row.links,
    onCallScheduleId: row.onCallScheduleId,
    onCallScheduleName: row.onCallScheduleId
      ? (relations.scheduleNames.get(row.onCallScheduleId) ?? null)
      : null,
    sloIds: links.sloIds,
    runbookIds: links.runbookIds,
    rules: row.rules,
    monthlyBudget: row.monthlyBudget,
    budgetCurrency: row.budgetCurrency,
    memberCount,
    scores: (relations.scores.get(row.id) ?? []).sort((a, b) =>
      a.scorecardName.localeCompare(b.scorecardName),
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Membership resolution
// ---------------------------------------------------------------------------

export interface ResolvedMembership {
  members: ServiceMember[];
  excluded: ServiceMember[];
}

/**
 * Resources whose cost rows carry `virtual tag key = value` over the last 30
 * days, as `"<accountId> <externalId>"` and bare `externalId` keys. A virtual
 * tag is computed from billing data, so this is the only way to ask it about a
 * resource; a resource without per-resource cost rows can never match.
 *
 * Failure (ClickHouse down, the tag deleted) matches nothing rather than
 * throwing: membership is read on every service page, and a billing outage
 * must not take the page down with it.
 */
async function virtualTagMatches(
  organizationId: string,
  rule: ServiceMembershipRule,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!rule.key || !rule.value) return out;
  try {
    const { queryCosts } = await import("../clickhouse/cost-readers");
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const groups = await queryCosts(organizationId, {
      from,
      to,
      binning: "monthly",
      groupBy: "resource",
      filters: [
        { dimension: "virtual_tag", tagKey: rule.key, op: "in", values: [rule.value] },
        ...(rule.accountId
          ? [{ dimension: "account" as const, op: "in" as const, values: [rule.accountId] }]
          : []),
        ...(rule.pluginId
          ? [{ dimension: "provider" as const, op: "in" as const, values: [rule.pluginId] }]
          : []),
      ],
    });
    for (const group of groups) if (group.key) out.add(group.key);
  } catch (err) {
    console.warn(`[services] virtual tag rule ${rule.key}=${rule.value} unavailable:`, err);
  }
  return out;
}

interface InventoryRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: Record<string, unknown>;
}

/**
 * Members for each of `rows`, resolved against the org's current inventory.
 *
 * One inventory read for all of them: the list endpoint shows a member count
 * per service, and N inventory scans for N services is the shape to avoid.
 */
export async function resolveServiceMembers(
  organizationId: string,
  rows: readonly ServiceRecord[],
  opts: { withOwners?: boolean } = {},
): Promise<Map<string, ResolvedMembership>> {
  const out = new Map<string, ResolvedMembership>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const needsInventory = rows.some((r) => r.rules.length > 0);
  const [explicitRows, inventory, accountRows] = await Promise.all([
    db.select().from(serviceMembers).where(inArray(serviceMembers.serviceId, ids)),
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
      })
      .from(resources)
      .innerJoin(accounts, eq(accounts.id, resources.accountId))
      .where(
        and(
          eq(resources.organizationId, organizationId),
          isNull(resources.deletedAt),
          isNull(accounts.deletedAt),
          // Without rules only the explicit members need looking up.
          needsInventory ? undefined : sql`false`,
        ),
      ),
    db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId)),
  ]);
  const accountNames = new Map(accountRows.map((a) => [a.id, a.displayName]));
  const byId = new Map<string, InventoryRow>(inventory.map((r) => [r.id, r]));

  // Explicit members not in the rule inventory read (no rules, or deleted).
  const explicitIds = explicitRows.map((r) => r.resourceId).filter((id) => !byId.has(id));
  if (explicitIds.length > 0) {
    const extra = await db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
      })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          inArray(resources.id, [...new Set(explicitIds)]),
          isNull(resources.deletedAt),
        ),
      );
    for (const r of extra) byId.set(r.id, r);
  }

  const toMember = (
    resourceId: string,
    source: ServiceMember["source"],
    ruleIndex: number | null,
    fallback?: typeof serviceMembers.$inferSelect,
  ): ServiceMember | null => {
    const r = byId.get(resourceId);
    if (!r && !fallback) return null;
    return {
      resourceId,
      accountId: r?.accountId ?? fallback!.accountId,
      accountName: accountNames.get(r?.accountId ?? fallback!.accountId) ?? null,
      pluginId: r?.pluginId ?? fallback!.pluginId,
      resourceTypeId: r?.resourceTypeId ?? fallback!.resourceTypeId,
      resourceName: r?.displayName ?? fallback!.resourceName,
      externalId: r?.externalId ?? null,
      source,
      ruleIndex,
      owner: null,
      missing: !r,
    };
  };

  for (const row of rows) {
    const explicit = explicitRows.filter((m) => m.serviceId === row.id);
    const excludedIds = new Set(
      explicit.filter((m) => m.mode === "exclude").map((m) => m.resourceId),
    );
    const members = new Map<string, ServiceMember>();
    for (const m of explicit) {
      if (m.mode !== "include") continue;
      const member = toMember(m.resourceId, "manual", null, m);
      if (member) members.set(m.resourceId, member);
    }
    const excluded: ServiceMember[] = [];
    for (const [index, rule] of row.rules.entries()) {
      let matchesVirtual: Set<string> | null = null;
      if (rule.kind === "virtual_tag")
        matchesVirtual = await virtualTagMatches(organizationId, rule);
      for (const r of inventory) {
        const hit =
          rule.kind === "virtual_tag"
            ? r.externalId !== null &&
              matchesVirtual!.has(r.externalId) &&
              (!rule.accountId || rule.accountId === r.accountId) &&
              (!rule.pluginId || rule.pluginId === r.pluginId)
            : serviceRuleMatches(rule, {
                pluginId: r.pluginId,
                accountId: r.accountId,
                displayName: r.displayName,
                fields: r.fieldsJson,
              });
        if (!hit || members.has(r.id)) continue;
        if (excludedIds.has(r.id)) {
          if (!excluded.some((e) => e.resourceId === r.id)) {
            const member = toMember(r.id, "rule", index);
            if (member) excluded.push(member);
          }
          continue;
        }
        const member = toMember(r.id, "rule", index);
        if (member) members.set(r.id, member);
      }
    }
    // Exclusions whose rule no longer matches still list, so they can be undone.
    for (const m of explicit) {
      if (m.mode !== "exclude" || excluded.some((e) => e.resourceId === m.resourceId)) continue;
      const member = toMember(m.resourceId, "rule", null, m);
      if (member) excluded.push(member);
    }
    out.set(row.id, {
      members: [...members.values()].sort((a, b) => a.resourceName.localeCompare(b.resourceName)),
      excluded,
    });
  }

  if (opts.withOwners) {
    const allIds = [...out.values()].flatMap((m) => m.members.map((x) => x.resourceId));
    const owners = await lookupResourceOwners(organizationId, allIds);
    for (const resolved of out.values()) {
      for (const member of resolved.members) member.owner = owners.get(member.resourceId) ?? null;
    }
  }
  return out;
}

/**
 * Every service with its wire shape and resolved members, in one inventory
 * read: what the scorecard evaluator and the overview need.
 */
export async function loadServicesWithMembers(
  organizationId: string,
): Promise<Array<{ row: ServiceRecord; service: Service; membership: ResolvedMembership }>> {
  const rows = await listServiceRecords(organizationId);
  const [relations, membership] = await Promise.all([
    loadRelations(organizationId, rows),
    resolveServiceMembers(organizationId, rows),
  ]);
  return rows.map((row) => {
    const resolved = membership.get(row.id) ?? { members: [], excluded: [] };
    return {
      row,
      service: serviceToWire(row, relations, resolved.members.length),
      membership: resolved,
    };
  });
}

export async function listServicesWire(organizationId: string): Promise<Service[]> {
  const rows = await listServiceRecords(organizationId);
  const [relations, membership] = await Promise.all([
    loadRelations(organizationId, rows),
    resolveServiceMembers(organizationId, rows),
  ]);
  return rows.map((row) =>
    serviceToWire(row, relations, membership.get(row.id)?.members.length ?? 0),
  );
}

export async function getServiceWire(
  organizationId: string,
  row: ServiceRecord,
): Promise<{ service: Service; membership: ResolvedMembership }> {
  const [relations, membership] = await Promise.all([
    loadRelations(organizationId, [row]),
    resolveServiceMembers(organizationId, [row], { withOwners: true }),
  ]);
  const resolved = membership.get(row.id) ?? { members: [], excluded: [] };
  return { service: serviceToWire(row, relations, resolved.members.length), membership: resolved };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Fill a partial body from defaults (create) or the stored service (update). */
export function serviceInputFrom(body: Partial<ServiceInput>, base?: Service): ServiceInput {
  const pick = <K extends keyof ServiceInput>(
    key: K,
    fallback: ServiceInput[K],
  ): ServiceInput[K] => (body[key] !== undefined ? (body[key] as ServiceInput[K]) : fallback);
  const d = SERVICE_DEFAULTS;
  return {
    name: pick("name", base?.name ?? d.name).trim(),
    ...(body.slug !== undefined ? { slug: body.slug } : {}),
    description: pick("description", base?.description ?? d.description)?.trim() || null,
    tier: pick("tier", base?.tier ?? d.tier),
    ownerTeam: pick("ownerTeam", base?.ownerTeam ?? d.ownerTeam)?.trim() || null,
    ownerUserIds: [...new Set(pick("ownerUserIds", base?.ownerUserIds ?? d.ownerUserIds))],
    links: pick("links", base?.links ?? d.links).map((l): ServiceLink => ({
      label: l.label.trim(),
      url: l.url.trim(),
    })),
    onCallScheduleId: pick("onCallScheduleId", base?.onCallScheduleId ?? d.onCallScheduleId),
    sloIds: [...new Set(pick("sloIds", base?.sloIds ?? d.sloIds))],
    runbookIds: [...new Set(pick("runbookIds", base?.runbookIds ?? d.runbookIds))],
    rules: pick("rules", base?.rules ?? d.rules).map(normalizeServiceRule),
    monthlyBudget: pick("monthlyBudget", base?.monthlyBudget ?? d.monthlyBudget),
    budgetCurrency:
      pick("budgetCurrency", base?.budgetCurrency ?? d.budgetCurrency)?.toUpperCase() || null,
  };
}

/** References must belong to this org when written; later they may disappear. */
async function assertReferences(organizationId: string, input: ServiceInput): Promise<void> {
  if (input.ownerUserIds.length > 0) {
    const found = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          inArray(organizationMembers.userId, input.ownerUserIds),
        ),
      );
    if (found.length !== input.ownerUserIds.length) {
      throw new ServiceInputError("Every owner must be a member of this organization", 400);
    }
  }
  if (input.onCallScheduleId) {
    const [schedule] = await db
      .select({ id: onCallSchedules.id })
      .from(onCallSchedules)
      .where(
        and(
          eq(onCallSchedules.organizationId, organizationId),
          eq(onCallSchedules.id, input.onCallScheduleId),
        ),
      )
      .limit(1);
    if (!schedule) throw new ServiceInputError("On-call schedule not found", 404);
  }
  if (input.sloIds.length > 0) {
    const found = await db
      .select({ id: slos.id })
      .from(slos)
      .where(and(eq(slos.organizationId, organizationId), inArray(slos.id, input.sloIds)));
    if (found.length !== input.sloIds.length) throw new ServiceInputError("SLO not found", 404);
  }
  if (input.runbookIds.length > 0) {
    const found = await db
      .select({ id: runbooks.id })
      .from(runbooks)
      .where(
        and(eq(runbooks.organizationId, organizationId), inArray(runbooks.id, input.runbookIds)),
      );
    if (found.length !== input.runbookIds.length) {
      throw new ServiceInputError("Runbook not found", 404);
    }
  }
}

async function writeRelations(
  organizationId: string,
  serviceId: string,
  input: ServiceInput,
): Promise<void> {
  await db.delete(serviceOwners).where(eq(serviceOwners.serviceId, serviceId));
  if (input.ownerUserIds.length > 0) {
    await db
      .insert(serviceOwners)
      .values(input.ownerUserIds.map((userId) => ({ serviceId, userId })));
  }
  await db.delete(serviceLinks).where(eq(serviceLinks.serviceId, serviceId));
  const links = [
    ...input.sloIds.map((targetId) => ({
      serviceId,
      organizationId,
      kind: "slo" as const,
      targetId,
    })),
    ...input.runbookIds.map((targetId) => ({
      serviceId,
      organizationId,
      kind: "runbook" as const,
      targetId,
    })),
  ];
  if (links.length > 0) await db.insert(serviceLinks).values(links);
}

function conflict(err: unknown): never {
  if (isUniqueViolation(err)) {
    throw new ServiceInputError("A service with that name or slug already exists", 409);
  }
  throw err;
}

export async function createServiceRecord(
  organizationId: string,
  body: Partial<ServiceInput>,
  userId?: string | null,
): Promise<ServiceRecord> {
  const input = serviceInputFrom(body);
  const slug = input.slug ?? slugifyServiceName(input.name);
  const problem = validateServiceInput({ ...input, slug: slug || "x" });
  if (problem) throw new ServiceInputError(problem);
  if (!slug)
    throw new ServiceInputError("Give the service a name with at least one letter or digit.");
  await assertReferences(organizationId, input);
  const id = randomUUID();
  try {
    const [row] = await db
      .insert(services)
      .values({
        id,
        organizationId,
        name: input.name,
        slug,
        description: input.description,
        tier: input.tier,
        ownerTeam: input.ownerTeam,
        links: input.links,
        onCallScheduleId: input.onCallScheduleId,
        rules: input.rules,
        monthlyBudget: input.monthlyBudget,
        budgetCurrency: input.monthlyBudget === null ? null : input.budgetCurrency,
        createdByUserId: userId ?? null,
      })
      .returning();
    await writeRelations(organizationId, id, input);
    return row!;
  } catch (err) {
    conflict(err);
  }
}

export async function updateServiceRecord(
  organizationId: string,
  idOrSlug: string,
  body: Partial<ServiceInput>,
): Promise<ServiceRecord> {
  const current = await getServiceRecord(organizationId, idOrSlug);
  if (!current) throw new ServiceInputError("Service not found", 404);
  const { service } = await getServiceWire(organizationId, current);
  const input = serviceInputFrom(body, service);
  const slug = input.slug ?? current.slug;
  const problem = validateServiceInput({ ...input, slug });
  if (problem) throw new ServiceInputError(problem);
  await assertReferences(organizationId, input);
  try {
    const [row] = await db
      .update(services)
      .set({
        name: input.name,
        slug,
        description: input.description,
        tier: input.tier,
        ownerTeam: input.ownerTeam,
        links: input.links,
        onCallScheduleId: input.onCallScheduleId,
        rules: input.rules,
        monthlyBudget: input.monthlyBudget,
        budgetCurrency: input.monthlyBudget === null ? null : input.budgetCurrency,
        updatedAt: new Date(),
      })
      .where(and(eq(services.organizationId, organizationId), eq(services.id, current.id)))
      .returning();
    await writeRelations(organizationId, current.id, input);
    return row!;
  } catch (err) {
    conflict(err);
  }
}

export async function deleteServiceRecord(
  organizationId: string,
  idOrSlug: string,
): Promise<ServiceRecord> {
  const current = await getServiceRecord(organizationId, idOrSlug);
  if (!current) throw new ServiceInputError("Service not found", 404);
  await db
    .delete(services)
    .where(and(eq(services.organizationId, organizationId), eq(services.id, current.id)));
  return current;
}

/**
 * Add resources by hand. An existing `exclude` row for the same resource is
 * flipped to `include`: "put it back" and "add it" are the same request.
 */
export async function addServiceMembers(
  organizationId: string,
  serviceId: string,
  resourceIds: readonly string[],
  userId?: string | null,
): Promise<number> {
  const unique = [...new Set(resourceIds)].filter(Boolean);
  if (unique.length === 0) throw new ServiceInputError("Choose at least one resource.");
  if (unique.length > SERVICE_LIMITS.maxMembersPerRequest) {
    throw new ServiceInputError(
      `Add at most ${SERVICE_LIMITS.maxMembersPerRequest} resources at a time.`,
    );
  }
  const found = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
    })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        inArray(resources.id, unique),
        isNull(resources.deletedAt),
      ),
    );
  if (found.length !== unique.length) {
    throw new ServiceInputError("Resource not found in this organization", 404);
  }
  await db
    .insert(serviceMembers)
    .values(
      found.map((r) => ({
        id: randomUUID(),
        organizationId,
        serviceId,
        accountId: r.accountId,
        resourceId: r.id,
        pluginId: r.pluginId,
        resourceTypeId: r.resourceTypeId,
        resourceName: r.displayName,
        mode: "include" as const,
        createdByUserId: userId ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: [serviceMembers.serviceId, serviceMembers.resourceId],
      set: { mode: "include" },
    });
  await db.update(services).set({ updatedAt: new Date() }).where(eq(services.id, serviceId));
  return found.length;
}

/**
 * Take a resource out. A hand-added member's row is deleted; a rule-matched
 * one gets an `exclude` row, because deleting nothing would let the rule put
 * it straight back on the next read.
 */
export async function removeServiceMember(
  organizationId: string,
  service: ServiceRecord,
  resourceId: string,
  userId?: string | null,
): Promise<"removed" | "excluded"> {
  const membership = (await resolveServiceMembers(organizationId, [service])).get(service.id);
  const member = membership?.members.find((m) => m.resourceId === resourceId);
  if (!member) throw new ServiceInputError("That resource is not a member of this service", 404);
  if (member.source === "manual") {
    await db
      .delete(serviceMembers)
      .where(
        and(eq(serviceMembers.serviceId, service.id), eq(serviceMembers.resourceId, resourceId)),
      );
    // A rule may match it too, in which case it is still a member and needs
    // an exclusion like any rule member.
    const after = (await resolveServiceMembers(organizationId, [service])).get(service.id);
    if (!after?.members.some((m) => m.resourceId === resourceId)) return "removed";
  }
  await db
    .insert(serviceMembers)
    .values({
      id: randomUUID(),
      organizationId,
      serviceId: service.id,
      accountId: member.accountId,
      resourceId,
      pluginId: member.pluginId,
      resourceTypeId: member.resourceTypeId,
      resourceName: member.resourceName,
      mode: "exclude",
      createdByUserId: userId ?? null,
    })
    .onConflictDoUpdate({
      target: [serviceMembers.serviceId, serviceMembers.resourceId],
      set: { mode: "exclude" },
    });
  return "excluded";
}

/** Drop an exclusion so the rule that matched the resource applies again. */
export async function restoreExcludedMember(
  serviceId: string,
  resourceId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(serviceMembers)
    .where(
      and(
        eq(serviceMembers.serviceId, serviceId),
        eq(serviceMembers.resourceId, resourceId),
        eq(serviceMembers.mode, "exclude"),
      ),
    )
    .returning({ id: serviceMembers.id });
  return deleted.length > 0;
}
