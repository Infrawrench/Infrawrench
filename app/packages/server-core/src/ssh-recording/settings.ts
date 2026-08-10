/**
 * Per-org session-recording policy.
 *
 * Split from `store.ts` because the recorder reads this on the hot path of
 * opening a session and must not pull the listing/assembly code (and its
 * gunzip) in with it.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { orgSessionRecordingSettings } from "../db/schema";

export interface SessionRecordingSettings {
  enabled: boolean;
  captureInput: boolean;
  retentionDays: number;
}

/**
 * Recording is off until an org turns it on, so the absent row and the
 * disabled row mean the same thing and neither is an error.
 */
export const DEFAULT_SESSION_RECORDING_SETTINGS: SessionRecordingSettings = {
  enabled: false,
  captureInput: false,
  retentionDays: 90,
};

/** Bounds the settings route enforces and the retention pass relies on. */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

/**
 * Short-lived per-org cache for the recorder's read.
 *
 * Opening an SSH session must not cost a database round-trip just to discover
 * that recording is off, which is the answer for most orgs most of the time.
 * Thirty seconds is short enough that enabling recording takes effect while
 * the operator is still looking at the settings page, and the writer
 * invalidates anyway — the TTL only covers the other replicas, which is
 * exactly the window where "one more unrecorded session" is the acceptable
 * cost of not querying on every connect.
 */
const SETTINGS_CACHE_TTL_MS = 30_000;
const settingsCache = new Map<string, { at: number; value: SessionRecordingSettings }>();

/** Drop an org's cached policy on this replica. Called after every write. */
function invalidateSettingsCache(organizationId: string): void {
  settingsCache.delete(organizationId);
}

/** The cached read the recorder uses on the session-open path. */
export async function getCachedSessionRecordingSettings(
  organizationId: string,
): Promise<SessionRecordingSettings> {
  const hit = settingsCache.get(organizationId);
  if (hit && Date.now() - hit.at < SETTINGS_CACHE_TTL_MS) return hit.value;
  const value = await getSessionRecordingSettings(organizationId);
  settingsCache.set(organizationId, { at: Date.now(), value });
  return value;
}

export async function getSessionRecordingSettings(
  organizationId: string,
): Promise<SessionRecordingSettings> {
  const [row] = await db
    .select()
    .from(orgSessionRecordingSettings)
    .where(eq(orgSessionRecordingSettings.organizationId, organizationId))
    .limit(1);
  if (!row) return { ...DEFAULT_SESSION_RECORDING_SETTINGS };
  return {
    enabled: row.enabled,
    captureInput: row.captureInput,
    retentionDays: clampRetentionDays(row.retentionDays),
  };
}

export function clampRetentionDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_SESSION_RECORDING_SETTINGS.retentionDays;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.trunc(days)));
}

/**
 * Upsert the org's policy. Partial: a caller that only toggles `enabled`
 * leaves retention and input capture as they were, so the settings form can
 * send one field without having to round-trip the rest.
 */
export async function updateSessionRecordingSettings(
  organizationId: string,
  patch: {
    enabled?: boolean | undefined;
    captureInput?: boolean | undefined;
    retentionDays?: number | undefined;
  },
): Promise<SessionRecordingSettings> {
  const current = await getSessionRecordingSettings(organizationId);
  const next: SessionRecordingSettings = {
    enabled: patch.enabled ?? current.enabled,
    captureInput: patch.captureInput ?? current.captureInput,
    retentionDays: clampRetentionDays(patch.retentionDays ?? current.retentionDays),
  };
  await db
    .insert(orgSessionRecordingSettings)
    .values({ organizationId, ...next })
    .onConflictDoUpdate({
      target: orgSessionRecordingSettings.organizationId,
      set: { ...next, updatedAt: new Date() },
    });
  invalidateSettingsCache(organizationId);
  return next;
}
