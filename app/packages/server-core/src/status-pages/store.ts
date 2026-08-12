/**
 * Status page rows — org-scoped CRUD, plus the one function that assembles the
 * **public** payload.
 *
 * The split at the bottom of this file is the security model, so it is worth
 * stating plainly: {@link getStatusPageWire} answers the org's own editor and
 * may name probes and ids; {@link getPublicStatusPage} answers the anonymous
 * internet and is written from scratch rather than by narrowing the private
 * shape. That is deliberate — with narrowing, a field added to the org shape
 * later becomes public by omission, which is precisely the mistake this
 * feature cannot afford.
 *
 * Input validation comes from `@infrawrench/client-core`
 * (`validateStatusPageInput`, `STATUS_PAGE_LIMITS`), the same function the
 * editor UI checks with — the `probes/store.ts` stance.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  STATUS_PAGE_LIMITS,
  componentStateFromProbe,
  rollUpStatusPageState,
  statusPageSummary,
  validateStatusPageInput,
  type PublicStatusComponent,
  type PublicStatusPage,
  type StatusHistoryDay,
  type StatusPage,
  type StatusPageComponentInput,
  type StatusPageCreate,
  type StatusPageListResponse,
  type StatusPagePatch,
  type ProbeStatus,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { statusPageComponents, statusPages, syntheticProbes } from "../db/schema";
import { getMetricDailyAverageBatch, getMetricSeriesAverageBatch } from "../clickhouse/readers";
import { probeMetricResourceId } from "../probes/metric-ids";
import { getPublicStatusNotices } from "./notices";

/** Thrown for caller mistakes the API maps to 400/404. */
export class StatusPageInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "StatusPageInputError";
  }
}

/**
 * Slug alphabet: lowercase letters and digits, minus the pairs that get
 * misread when a slug is dictated or copied off a screen (`0`/`o`, `1`/`l`).
 * A status page URL gets read aloud more often than most.
 */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 22;

/**
 * Generate a page slug.
 *
 * The slug is the page's *only* access control, so it is generated from
 * `randomBytes` rather than derived from the title: `acme-api-status` would be
 * guessable by anyone who knows the company, and "published to whoever has the
 * link" would quietly mean "published to everyone". 22 characters of this
 * alphabet is ~109 bits.
 *
 * Rejection-sampled so the modulo doesn't bias the alphabet — the bias would be
 * tiny, but a biased secret is not worth the four lines saved.
 */
export function generateStatusPageSlug(): string {
  const limit = 256 - (256 % SLUG_ALPHABET.length);
  let out = "";
  while (out.length < SLUG_LENGTH) {
    for (const byte of randomBytes(SLUG_LENGTH)) {
      if (byte >= limit) continue;
      out += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
      if (out.length === SLUG_LENGTH) break;
    }
  }
  return out;
}

type PageRow = typeof statusPages.$inferSelect;

interface ComponentRow {
  id: string;
  probeId: string;
  label: string | null;
  groupName: string | null;
  position: number;
  probeName: string;
  probeStatus: ProbeStatus;
  probeEnabled: boolean;
}

/**
 * Read a page's components joined to their probes.
 *
 * An inner join: `status_page_components.probe_id` cascades on probe deletion,
 * so a row without a probe cannot exist — the join documents the invariant
 * rather than defending against it.
 */
async function readComponents(statusPageId: string): Promise<ComponentRow[]> {
  return db
    .select({
      id: statusPageComponents.id,
      probeId: statusPageComponents.probeId,
      label: statusPageComponents.label,
      groupName: statusPageComponents.groupName,
      position: statusPageComponents.position,
      probeName: syntheticProbes.name,
      probeStatus: syntheticProbes.status,
      probeEnabled: syntheticProbes.enabled,
    })
    .from(statusPageComponents)
    .innerJoin(syntheticProbes, eq(syntheticProbes.id, statusPageComponents.probeId))
    .where(eq(statusPageComponents.statusPageId, statusPageId))
    .orderBy(asc(statusPageComponents.position));
}

function toWire(row: PageRow, components: ComponentRow[]): StatusPage {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    published: row.published,
    showHistory: row.showHistory,
    showUptime: row.showUptime,
    supportUrl: row.supportUrl,
    customHostname: row.customHostname,
    customHostnameStatus: row.customHostnameStatus,
    customHostnameError: row.customHostnameError,
    customHostnameVerification: row.customHostnameVerification ?? null,
    components: components.map((c) => ({
      id: c.id,
      probeId: c.probeId,
      label: c.label,
      groupName: c.groupName,
      position: c.position,
      probeName: c.probeName,
      probeStatus: c.probeStatus,
      probeEnabled: c.probeEnabled,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listStatusPages(organizationId: string): Promise<StatusPageListResponse> {
  const rows = await db
    .select()
    .from(statusPages)
    .where(eq(statusPages.organizationId, organizationId))
    .orderBy(asc(statusPages.createdAt));
  const pages = await Promise.all(
    rows.map(async (row) => toWire(row, await readComponents(row.id))),
  );
  return { pages };
}

export async function getStatusPageWire(
  organizationId: string,
  pageId: string,
): Promise<StatusPage | null> {
  const [row] = await db
    .select()
    .from(statusPages)
    .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, pageId)))
    .limit(1);
  if (!row) return null;
  return toWire(row, await readComponents(row.id));
}

/**
 * Validate that every named probe belongs to this org, and normalize the
 * component list into insertable rows.
 *
 * The org check is the one that matters: without it, a page could publish
 * another tenant's probe by id. Order in equals order out — `position` is the
 * caller's index, because the editor's drag order *is* the render order.
 */
async function resolveComponents(
  organizationId: string,
  statusPageId: string,
  inputs: readonly StatusPageComponentInput[],
): Promise<(typeof statusPageComponents.$inferInsert)[]> {
  if (inputs.length === 0) return [];
  const ids = [...new Set(inputs.map((i) => i.probeId))];
  const owned = await db
    .select({ id: syntheticProbes.id })
    .from(syntheticProbes)
    .where(
      and(eq(syntheticProbes.organizationId, organizationId), inArray(syntheticProbes.id, ids)),
    );
  const ownedIds = new Set(owned.map((p) => p.id));
  for (const id of ids) {
    if (!ownedIds.has(id)) {
      throw new StatusPageInputError("Probe not found in this organization", 404);
    }
  }
  return inputs.map((input, index) => ({
    id: randomUUID(),
    statusPageId,
    probeId: input.probeId,
    label: input.label?.trim() || null,
    groupName: input.groupName?.trim() || null,
    position: index,
  }));
}

export async function createStatusPageRecord(
  organizationId: string,
  input: StatusPageCreate,
  createdByUserId?: string,
): Promise<StatusPage> {
  const problem = validateStatusPageInput(input);
  if (problem) throw new StatusPageInputError(problem);

  const id = randomUUID();
  const now = new Date();
  const components = await resolveComponents(organizationId, id, input.components ?? []);

  await db.transaction(async (tx) => {
    // The per-org cap and the insert run under an org-scoped advisory lock so
    // two concurrent creates can't both pass the count (the probes stance).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`status_pages:${organizationId}`}))`,
    );
    const existing = await tx
      .select({ id: statusPages.id })
      .from(statusPages)
      .where(eq(statusPages.organizationId, organizationId));
    if (existing.length >= STATUS_PAGE_LIMITS.maxPerOrg) {
      throw new StatusPageInputError(
        `Organizations are limited to ${STATUS_PAGE_LIMITS.maxPerOrg} status pages`,
      );
    }
    await tx.insert(statusPages).values({
      id,
      organizationId,
      slug: generateStatusPageSlug(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      // Ignoring a `published: true` on create would be surprising, but the
      // *default* stays false: a page nobody asked to publish never is.
      published: input.published ?? false,
      showHistory: input.showHistory ?? true,
      showUptime: input.showUptime ?? true,
      supportUrl: input.supportUrl?.trim() || null,
      createdByUserId: createdByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    if (components.length > 0) await tx.insert(statusPageComponents).values(components);
  });
  return (await getStatusPageWire(organizationId, id))!;
}

/**
 * Update settings and/or the component set.
 *
 * `components`, when present, replaces the set wholesale — the editor always
 * submits the full ordered list, so a delete-then-insert inside one
 * transaction is both simpler and the only way to express a reorder without a
 * position-shuffling dance.
 */
export async function updateStatusPageRecord(
  organizationId: string,
  pageId: string,
  patch: StatusPagePatch,
): Promise<StatusPage> {
  const existing = await getStatusPageWire(organizationId, pageId);
  if (!existing) throw new StatusPageInputError("Status page not found", 404);
  const problem = validateStatusPageInput(patch);
  if (problem) throw new StatusPageInputError(problem);

  const set: Partial<typeof statusPages.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.published !== undefined) set.published = patch.published;
  if (patch.showHistory !== undefined) set.showHistory = patch.showHistory;
  if (patch.showUptime !== undefined) set.showUptime = patch.showUptime;
  if (patch.supportUrl !== undefined) set.supportUrl = patch.supportUrl?.trim() || null;

  const components =
    patch.components === undefined
      ? null
      : await resolveComponents(organizationId, pageId, patch.components);

  await db.transaction(async (tx) => {
    await tx.update(statusPages).set(set).where(eq(statusPages.id, pageId));
    if (components) {
      await tx.delete(statusPageComponents).where(eq(statusPageComponents.statusPageId, pageId));
      if (components.length > 0) await tx.insert(statusPageComponents).values(components);
    }
  });
  return (await getStatusPageWire(organizationId, pageId))!;
}

export async function deleteStatusPageRecord(
  organizationId: string,
  pageId: string,
): Promise<StatusPage> {
  const existing = await getStatusPageWire(organizationId, pageId);
  if (!existing) throw new StatusPageInputError("Status page not found", 404);
  // Tear down Cloudflare + KV before the row goes — cascade would leave orphans
  // on the SaaS zone and a stale hostname→slug mapping.
  const { teardownCustomHostnameForPage } = await import("./custom-hostname");
  await teardownCustomHostnameForPage(pageId);
  await db
    .delete(statusPages)
    .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, pageId)));
  return existing;
}

/**
 * Issue a fresh slug, revoking the old public URL.
 *
 * The slug is the page's only credential, so this is its reroll — the answer
 * to "the link ended up somewhere we didn't intend". It is intentionally not
 * coupled to unpublishing: rotating keeps the page live for anyone the org
 * re-sends the new link to.
 */
export async function rotateStatusPageSlugRecord(
  organizationId: string,
  pageId: string,
): Promise<StatusPage> {
  const existing = await getStatusPageWire(organizationId, pageId);
  if (!existing) throw new StatusPageInputError("Status page not found", 404);
  const previousSlug = existing.slug;
  const nextSlug = generateStatusPageSlug();
  await db
    .update(statusPages)
    .set({ slug: nextSlug, updatedAt: new Date() })
    .where(and(eq(statusPages.organizationId, organizationId), eq(statusPages.id, pageId)));
  const updated = (await getStatusPageWire(organizationId, pageId))!;
  // Vanity hosts resolve Host → slug via Workers KV; keep the mapping current.
  // If KV rejects the write, roll the slug back so we never report success with
  // a vanity host still pointing at the revoked URL.
  if (updated.customHostname) {
    try {
      const { syncCustomHostnameKvForPage } = await import("./custom-hostname");
      await syncCustomHostnameKvForPage(updated);
    } catch (err) {
      // Only restore if our write is still current — a concurrent rotation may
      // have already moved the slug (and KV) past `nextSlug`.
      await db
        .update(statusPages)
        .set({ slug: previousSlug, updatedAt: new Date() })
        .where(
          and(
            eq(statusPages.organizationId, organizationId),
            eq(statusPages.id, pageId),
            eq(statusPages.slug, nextSlug),
          ),
        );
      throw err;
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Public payload
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` in UTC. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Assemble the payload served at `GET /api/status/:slug` to anyone with the
 * link.
 *
 * Returns null for an unknown slug **and** for a page that exists but is not
 * published — the same answer for both, so the endpoint cannot be used to
 * confirm that a slug is real. The caller renders one 404 either way.
 *
 * Every field is chosen rather than inherited. What is deliberately *not*
 * here: probe URLs, methods, intervals, thresholds, last error text, status
 * codes, resource/account/plugin ids, the org id, and the probe ids
 * themselves (components are identified by their own row id, which reveals no
 * monitoring topology). A visitor learns what is up and what is not, which is
 * the entire promise of a status page.
 *
 * ClickHouse is best-effort, as everywhere else: an outage costs the uptime
 * numbers and the history, never the page. Current state comes from the probe
 * rows in Postgres, so the important half survives.
 */
export async function getPublicStatusPage(slug: string): Promise<PublicStatusPage | null> {
  const [page] = await db.select().from(statusPages).where(eq(statusPages.slug, slug)).limit(1);
  if (!page || !page.published) return null;

  const components = await readComponents(page.id);
  const now = Date.now();
  const historyDays = page.showHistory ? STATUS_PAGE_LIMITS.historyDays : 0;

  const states = components.map((c) => ({
    row: c,
    state: componentStateFromProbe(c.probeStatus, c.probeEnabled),
  }));

  const metricIds = components.map((c) => probeMetricResourceId(c.probeId));
  const [uptime, history] = await Promise.all([
    page.showUptime
      ? getMetricSeriesAverageBatch(
          page.organizationId,
          metricIds,
          "Up",
          now - MS_PER_DAY,
          now,
        ).catch(() => new Map<string, number>())
      : Promise.resolve(new Map<string, number>()),
    historyDays > 0
      ? getMetricDailyAverageBatch(
          page.organizationId,
          metricIds,
          "Up",
          now - historyDays * MS_PER_DAY,
          now,
        ).catch(() => [])
      : Promise.resolve([]),
  ]);

  // resourceId → day → uptime, so each component can walk a dense day axis.
  const historyByProbe = new Map<string, Map<string, number>>();
  for (const row of history) {
    let days = historyByProbe.get(row.resourceId);
    if (!days) {
      days = new Map();
      historyByProbe.set(row.resourceId, days);
    }
    days.set(row.day, row.value);
  }

  const publicComponents: PublicStatusComponent[] = states.map(({ row, state }) => {
    const metricId = probeMetricResourceId(row.probeId);
    const days = historyByProbe.get(metricId);
    const bars: StatusHistoryDay[] = [];
    // A dense axis, oldest first: days with no data are emitted as null rather
    // than skipped, so a gap renders as a gap instead of shifting the bars and
    // silently claiming a shorter, greener history than really happened.
    for (let i = historyDays - 1; i >= 0; i--) {
      const day = utcDay(now - i * MS_PER_DAY);
      bars.push({ day, uptime: days?.get(day) ?? null });
    }
    return {
      id: row.id,
      name: row.label?.trim() || row.probeName,
      groupName: row.groupName,
      state,
      uptime24h: page.showUptime ? (uptime.get(metricId) ?? null) : null,
      history: bars,
    };
  });

  const state = rollUpStatusPageState(publicComponents);
  // Best-effort, exactly like the ClickHouse reads above: a notice query that
  // fails costs the sentence, never the page. During an incident this endpoint
  // is the one thing that must stay up.
  const notices = await getPublicStatusNotices(page.id, new Date(now)).catch(() => []);
  return {
    title: page.title,
    description: page.description,
    state,
    summary: statusPageSummary(state),
    components: publicComponents,
    notices,
    supportUrl: page.supportUrl,
    showHistory: page.showHistory,
    showUptime: page.showUptime,
    historyDays,
    generatedAt: new Date(now).toISOString(),
  };
}
