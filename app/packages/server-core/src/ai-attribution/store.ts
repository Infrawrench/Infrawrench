/**
 * Request-log sources and caller dimensions: CRUD, validation and the views
 * the API returns. The LiteLLM key is encrypted at rest and never leaves the
 * server process.
 */
import { randomUUID } from "node:crypto";

import {
  AI_DEFAULT_LOOKBACK_DAYS,
  AI_DIMENSION_KEY_PATTERN,
  AI_MAX_DIMENSIONS,
  AI_MAX_LOOKBACK_DAYS,
  AI_MAX_METADATA_KEYS_PER_DIMENSION,
  AI_MAX_SOURCES,
  type AiAttributionDimension,
  type AiAttributionDimensionInput,
  type AiRequestSource,
  type AiRequestSourceInput,
  type AiRequestSourceKindOption,
} from "@infrawrench/client-core";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "../db/client";
import { accounts, aiAttributionDimensions, aiRequestSources } from "../db/schema";
import { buildAad, decrypt, encrypt } from "../encryption";
import { assertDestinationUrl } from "../cost-exports/egress";
import { loadPlugins, getPlugin } from "../plugin-loader";
import { LITELLM_SOURCE_KIND } from "./litellm";

/** Caller mistakes the API maps onto 400/404. */
export class AiAttributionInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "AiAttributionInputError";
  }
}

export type AiRequestSourceRow = typeof aiRequestSources.$inferSelect;

function keyAad(id: string): string {
  return buildAad("ai_request_source", id, "api_key");
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function toView(row: AiRequestSourceRow, accountName: string | null): AiRequestSource {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "litellm" ? "litellm" : "plugin",
    pluginId: row.pluginId,
    accountId: row.accountId,
    accountName,
    sourceKindId: row.sourceKindId,
    location: row.location ?? {},
    enabled: row.enabled,
    lookbackDays: row.lookbackDays,
    baseUrl: row.baseUrl,
    hasApiKey: !!row.encryptedApiKey,
    collectedThrough: row.collectedThrough ?? null,
    lastRunAt: iso(row.lastRunAt),
    nextRunAt: iso(row.nextRunAt),
    lastError: row.lastError,
    lastErrorHelpUrl: row.lastErrorHelpUrl,
    failureCount: row.failureCount,
    observedMetadataKeys: row.observedMetadataKeys ?? {},
    lastQueryBytesScanned: row.lastQueryBytesScanned,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every kind of source the org could add, with the accounts that can supply each. */
export async function listAiSourceKindOptions(
  organizationId: string,
): Promise<AiRequestSourceKindOption[]> {
  const plugins = await loadPlugins();
  const orgAccounts = await db
    .select({ id: accounts.id, name: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)))
    .orderBy(asc(accounts.displayName));
  const out: AiRequestSourceKindOption[] = [];
  for (const { plugin } of plugins) {
    const cap = plugin.manifest.aiRequestLogs;
    if (!cap) continue;
    const accs = orgAccounts.filter((a) => a.pluginId === plugin.manifest.id);
    for (const k of cap.sourceKinds) {
      out.push({
        kind: "plugin",
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.displayName,
        sourceKindId: k.id,
        label: k.label,
        description: k.description,
        locationLabel: k.locationLabel,
        maxHistoryDays: k.maxHistoryDays,
        queriesBillable: k.queriesBillable === true,
        acceptsPrefix: k.acceptsPrefix === true,
        helpUrl: k.helpUrl ?? null,
        accounts: accs.map((a) => ({ id: a.id, name: a.name })),
      });
    }
  }
  out.push({ ...LITELLM_SOURCE_KIND, accounts: [] });
  return out;
}

export async function listAiRequestSources(organizationId: string): Promise<AiRequestSource[]> {
  const rows = await db
    .select({ source: aiRequestSources, accountName: accounts.displayName })
    .from(aiRequestSources)
    .leftJoin(accounts, eq(accounts.id, aiRequestSources.accountId))
    .where(eq(aiRequestSources.organizationId, organizationId))
    .orderBy(asc(aiRequestSources.createdAt));
  return rows.map((r) => toView(r.source, r.accountName ?? null));
}

export async function getAiRequestSourceRow(
  organizationId: string,
  id: string,
): Promise<AiRequestSourceRow | null> {
  const [row] = await db
    .select()
    .from(aiRequestSources)
    .where(and(eq(aiRequestSources.organizationId, organizationId), eq(aiRequestSources.id, id)));
  return row ?? null;
}

export async function getAiRequestSource(
  organizationId: string,
  id: string,
): Promise<AiRequestSource | null> {
  return (await listAiRequestSources(organizationId)).find((s) => s.id === id) ?? null;
}

interface NormalizedSource {
  name: string;
  kind: "plugin" | "litellm";
  pluginId: string | null;
  accountId: string | null;
  sourceKindId: string;
  location: Record<string, string>;
  enabled: boolean;
  lookbackDays: number;
  baseUrl: string | null;
}

async function normalizeSourceInput(
  organizationId: string,
  input: AiRequestSourceInput,
): Promise<NormalizedSource> {
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new AiAttributionInputError("name must be 1-120 characters");
  }
  const location: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.location ?? {})) {
    if (typeof v !== "string") continue;
    if (k.length > 64 || v.length > 1024)
      throw new AiAttributionInputError("location value too long");
    location[k] = v;
  }
  if (Object.keys(location).length > 16)
    throw new AiAttributionInputError("too many location keys");
  const lookbackDays = Math.floor(input.lookbackDays ?? AI_DEFAULT_LOOKBACK_DAYS);
  if (!(lookbackDays >= 1 && lookbackDays <= AI_MAX_LOOKBACK_DAYS)) {
    throw new AiAttributionInputError(`lookbackDays must be 1-${AI_MAX_LOOKBACK_DAYS}`);
  }

  if (input.kind === "litellm") {
    if (input.sourceKindId !== LITELLM_SOURCE_KIND.sourceKindId) {
      throw new AiAttributionInputError(
        `sourceKindId must be "${LITELLM_SOURCE_KIND.sourceKindId}"`,
      );
    }
    const raw = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
    let url: URL;
    try {
      url = assertDestinationUrl(raw, "baseUrl");
    } catch (err) {
      throw new AiAttributionInputError(err instanceof Error ? err.message : "invalid baseUrl");
    }
    return {
      name,
      kind: "litellm",
      pluginId: null,
      accountId: null,
      sourceKindId: input.sourceKindId,
      location: {},
      enabled: input.enabled,
      lookbackDays: Math.min(lookbackDays, LITELLM_SOURCE_KIND.maxHistoryDays),
      baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
    };
  }

  if (input.kind !== "plugin")
    throw new AiAttributionInputError('kind must be "plugin" or "litellm"');
  if (!input.accountId) throw new AiAttributionInputError("accountId is required");
  const [account] = await db
    .select({ id: accounts.id, pluginId: accounts.pluginId })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, input.accountId),
        eq(accounts.organizationId, organizationId),
        isNull(accounts.deletedAt),
      ),
    );
  if (!account) throw new AiAttributionInputError("account not found", 404);
  const loaded = await getPlugin(account.pluginId);
  const kind = loaded?.plugin.manifest.aiRequestLogs?.sourceKinds.find(
    (k) => k.id === input.sourceKindId,
  );
  if (!kind) {
    throw new AiAttributionInputError(
      `this account's provider has no request-log source "${input.sourceKindId}"`,
    );
  }
  return {
    name,
    kind: "plugin",
    pluginId: account.pluginId,
    accountId: account.id,
    sourceKindId: kind.id,
    location,
    enabled: input.enabled,
    lookbackDays: Math.min(lookbackDays, kind.maxHistoryDays),
    baseUrl: null,
  };
}

export async function createAiRequestSource(
  organizationId: string,
  userId: string | null,
  input: AiRequestSourceInput,
): Promise<AiRequestSource> {
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiRequestSources)
    .where(eq(aiRequestSources.organizationId, organizationId));
  if (count >= AI_MAX_SOURCES) {
    throw new AiAttributionInputError(`an organization can have at most ${AI_MAX_SOURCES} sources`);
  }
  const n = await normalizeSourceInput(organizationId, input);
  const id = randomUUID();
  let encryptedApiKey: string | null = null;
  let apiKeyIv: string | null = null;
  if (n.kind === "litellm") {
    const key = input.apiKey?.trim();
    if (!key) throw new AiAttributionInputError("apiKey is required for a LiteLLM source");
    const enc = await encrypt(key, keyAad(id));
    encryptedApiKey = enc.ciphertext;
    apiKeyIv = enc.iv;
  }
  await db.insert(aiRequestSources).values({
    id,
    organizationId,
    ...n,
    encryptedApiKey,
    apiKeyIv,
    nextRunAt: n.enabled ? new Date() : null,
    createdByUserId: userId,
  });
  return (await getAiRequestSource(organizationId, id))!;
}

export async function updateAiRequestSource(
  organizationId: string,
  id: string,
  input: AiRequestSourceInput,
): Promise<AiRequestSource> {
  const existing = await getAiRequestSourceRow(organizationId, id);
  if (!existing) throw new AiAttributionInputError("source not found", 404);
  const n = await normalizeSourceInput(organizationId, input);
  const patch: Partial<typeof aiRequestSources.$inferInsert> = {
    ...n,
    updatedAt: new Date(),
  };
  if (n.kind === "litellm") {
    const key = input.apiKey?.trim();
    if (key) {
      const enc = await encrypt(key, keyAad(id));
      patch.encryptedApiKey = enc.ciphertext;
      patch.apiKeyIv = enc.iv;
    } else if (!existing.encryptedApiKey) {
      throw new AiAttributionInputError("apiKey is required for a LiteLLM source");
    }
  } else {
    patch.encryptedApiKey = null;
    patch.apiKeyIv = null;
  }
  // Pointing a source somewhere else starts its history over.
  const moved =
    existing.accountId !== n.accountId ||
    existing.sourceKindId !== n.sourceKindId ||
    JSON.stringify(existing.location ?? {}) !== JSON.stringify(n.location) ||
    existing.baseUrl !== n.baseUrl;
  if (moved) patch.collectedThrough = null;
  if (!n.enabled) patch.nextRunAt = null;
  else if (!existing.enabled || moved) {
    patch.nextRunAt = new Date();
    patch.failureCount = 0;
  }
  await db
    .update(aiRequestSources)
    .set(patch)
    .where(and(eq(aiRequestSources.organizationId, organizationId), eq(aiRequestSources.id, id)));
  return (await getAiRequestSource(organizationId, id))!;
}

export async function deleteAiRequestSource(organizationId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(aiRequestSources)
    .where(and(eq(aiRequestSources.organizationId, organizationId), eq(aiRequestSources.id, id)))
    .returning({ id: aiRequestSources.id });
  return rows.length > 0;
}

/**
 * Re-read a source from `fromDay` on (after a mapping change: aggregates only
 * keep mapped keys, so history needs re-reading to gain a new dimension).
 * Clamped to the source kind's history limit by the collector.
 */
export async function recollectAiRequestSource(
  organizationId: string,
  id: string,
  fromDay: string,
): Promise<AiRequestSource> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay))
    throw new AiAttributionInputError("from must be YYYY-MM-DD");
  const existing = await getAiRequestSourceRow(organizationId, id);
  if (!existing) throw new AiAttributionInputError("source not found", 404);
  if (!existing.enabled)
    throw new AiAttributionInputError("enable the source before re-collecting");
  const prev = new Date(Date.parse(`${fromDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  await db
    .update(aiRequestSources)
    .set({ collectedThrough: prev, nextRunAt: new Date(), failureCount: 0, updatedAt: new Date() })
    .where(and(eq(aiRequestSources.organizationId, organizationId), eq(aiRequestSources.id, id)));
  return (await getAiRequestSource(organizationId, id))!;
}

/** Decrypt a LiteLLM source's key. Server-side callers only. */
export async function loadAiSourceApiKey(row: AiRequestSourceRow): Promise<string | null> {
  if (!row.encryptedApiKey || !row.apiKeyIv) return null;
  try {
    return await decrypt(row.encryptedApiKey, row.apiKeyIv, keyAad(row.id));
  } catch (err) {
    console.error(`[ai-attribution] failed to decrypt the key for source ${row.id}:`, err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Dimensions
 * ------------------------------------------------------------------ */

function dimensionView(row: typeof aiAttributionDimensions.$inferSelect): AiAttributionDimension {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    metadataKeys: row.metadataKeys ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeDimension(input: AiAttributionDimensionInput): AiAttributionDimensionInput {
  const key = input.key.trim().toLowerCase();
  if (!AI_DIMENSION_KEY_PATTERN.test(key)) {
    throw new AiAttributionInputError(
      "key must start with a letter and use only a-z, 0-9, _ and - (max 32)",
    );
  }
  const label = input.label.trim();
  if (!label || label.length > 60)
    throw new AiAttributionInputError("label must be 1-60 characters");
  const metadataKeys = [...new Set(input.metadataKeys.map((k) => k.trim()).filter(Boolean))];
  if (metadataKeys.length === 0 || metadataKeys.length > AI_MAX_METADATA_KEYS_PER_DIMENSION) {
    throw new AiAttributionInputError(
      `metadataKeys must list 1-${AI_MAX_METADATA_KEYS_PER_DIMENSION} keys`,
    );
  }
  if (metadataKeys.some((k) => k.length > 256)) {
    throw new AiAttributionInputError("metadata keys are at most 256 characters");
  }
  return { key, label, metadataKeys };
}

export async function listAiDimensions(organizationId: string): Promise<AiAttributionDimension[]> {
  const rows = await db
    .select()
    .from(aiAttributionDimensions)
    .where(eq(aiAttributionDimensions.organizationId, organizationId))
    .orderBy(asc(aiAttributionDimensions.createdAt));
  return rows.map(dimensionView);
}

export async function createAiDimension(
  organizationId: string,
  input: AiAttributionDimensionInput,
): Promise<AiAttributionDimension> {
  const n = normalizeDimension(input);
  const existing = await listAiDimensions(organizationId);
  if (existing.length >= AI_MAX_DIMENSIONS) {
    throw new AiAttributionInputError(
      `an organization can map at most ${AI_MAX_DIMENSIONS} dimensions`,
    );
  }
  if (existing.some((d) => d.key === n.key)) {
    throw new AiAttributionInputError(`a dimension with key "${n.key}" already exists`);
  }
  const id = randomUUID();
  await db.insert(aiAttributionDimensions).values({ id, organizationId, ...n });
  return (await listAiDimensions(organizationId)).find((d) => d.id === id)!;
}

export async function updateAiDimension(
  organizationId: string,
  id: string,
  input: AiAttributionDimensionInput,
): Promise<AiAttributionDimension> {
  const n = normalizeDimension(input);
  const existing = await listAiDimensions(organizationId);
  const current = existing.find((d) => d.id === id);
  if (!current) throw new AiAttributionInputError("dimension not found", 404);
  if (existing.some((d) => d.id !== id && d.key === n.key)) {
    throw new AiAttributionInputError(`a dimension with key "${n.key}" already exists`);
  }
  await db
    .update(aiAttributionDimensions)
    .set({ ...n, updatedAt: new Date() })
    .where(
      and(
        eq(aiAttributionDimensions.organizationId, organizationId),
        eq(aiAttributionDimensions.id, id),
      ),
    );
  return (await listAiDimensions(organizationId)).find((d) => d.id === id)!;
}

export async function deleteAiDimension(organizationId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(aiAttributionDimensions)
    .where(
      and(
        eq(aiAttributionDimensions.organizationId, organizationId),
        eq(aiAttributionDimensions.id, id),
      ),
    )
    .returning({ id: aiAttributionDimensions.id });
  return rows.length > 0;
}
