/**
 * Recorded SSH sessions (org-scoped, mounted at
 * /api/org/:orgId/session-recordings).
 *
 * Reading is `session-recordings:read`; changing the org's recording policy or
 * deleting a tape is `session-recordings:write`. Neither is in the `member`
 * system role — see the note in the permission catalog.
 *
 * Every route here is audit-logged, including the reads. That is unusual in
 * this codebase and deliberate: the only thing worse than an unwatched
 * terminal is a recording of one that somebody watched without a trace. An
 * investigator has to be able to answer "who has seen this tape".
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  deleteSessionRecording,
  getSessionRecording,
  getSessionRecordingUsage,
  listSessionRecordings,
  readSessionRecordingCast,
  sessionRecordingFilename,
  type SessionRecordingStatus,
} from "@infrawrench/server-core/ssh-recording/store";
import {
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  getSessionRecordingSettings,
  updateSessionRecordingSettings,
} from "@infrawrench/server-core/ssh-recording/settings";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

const app = new Hono();

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

function actorId(c: Context): string | undefined {
  return (c.get("session") as AuthSession | undefined)?.userId;
}

const STATUSES: SessionRecordingStatus[] = ["recording", "complete", "truncated", "abandoned"];

/** Reject a malformed `?since=`/`?until=` rather than silently ignoring it. */
function parseInstant(raw: string | undefined): Date | undefined | null {
  if (raw === undefined) return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** GET / — the org's recordings, newest first. */
app.get("/", async (c) => {
  requirePermission(c, "session-recordings:read");
  const rawStatus = c.req.query("status");
  if (rawStatus !== undefined && !STATUSES.includes(rawStatus as SessionRecordingStatus)) {
    return c.json({ error: `status must be one of: ${STATUSES.join(", ")}` }, 400);
  }
  const since = parseInstant(c.req.query("since"));
  const until = parseInstant(c.req.query("until"));
  if (since === null || until === null) {
    return c.json({ error: "since and until must be ISO-8601 instants" }, 400);
  }
  const limit = Number(c.req.query("limit"));

  const recordings = await listSessionRecordings(orgId(c), {
    ...(rawStatus ? { status: rawStatus as SessionRecordingStatus } : {}),
    ...(c.req.query("userId") ? { userId: c.req.query("userId")! } : {}),
    ...(c.req.query("resourceId") ? { resourceId: c.req.query("resourceId")! } : {}),
    ...(c.req.query("accountId") ? { accountId: c.req.query("accountId")! } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
  });
  return c.json(recordings);
});

/**
 * GET /settings — the org's recording policy plus what it currently stores.
 *
 * Usage rides along with the policy rather than sitting on its own route
 * because the only question anyone asks about retention is "and what is that
 * costing me", and answering it in the same round-trip is what lets the
 * settings page show both without a spinner of its own.
 */
app.get("/settings", async (c) => {
  requirePermission(c, "session-recordings:read");
  const [settings, usage] = await Promise.all([
    getSessionRecordingSettings(orgId(c)),
    getSessionRecordingUsage(orgId(c)),
  ]);
  return c.json({ ...settings, usage });
});

const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    captureInput: z.boolean().optional(),
    retentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS).optional(),
  })
  .strict();

/** PUT /settings — partial update of the org's recording policy. */
app.put("/settings", async (c) => {
  requirePermission(c, "session-recordings:write");
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  }
  const before = await getSessionRecordingSettings(orgId(c));
  const after = await updateSessionRecordingSettings(orgId(c), parsed.data);
  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "session_recording.settings.update",
    entityType: "org-settings",
    entityId: orgId(c),
    metadata: { before, after },
  });
  const usage = await getSessionRecordingUsage(orgId(c));
  return c.json({ ...after, usage });
});

/** GET /:id — one recording's metadata (no payload). */
app.get("/:id", async (c) => {
  requirePermission(c, "session-recordings:read");
  const recording = await getSessionRecording(orgId(c), c.req.param("id"));
  if (!recording) return c.json({ error: "Not found" }, 404);
  return c.json(recording);
});

/**
 * GET /:id/cast — the asciicast v2 document.
 *
 * Served as `text/plain` with a `Content-Disposition` filename so the same URL
 * is both what the in-app player fetches and what an auditor saves to disk and
 * opens with `asciinema play`. `?download=1` forces the attachment disposition;
 * without it the player gets an inline body it can read without the browser
 * offering to save it.
 */
app.get("/:id/cast", async (c) => {
  requirePermission(c, "session-recordings:read");
  const id = c.req.param("id");
  const recording = await getSessionRecording(orgId(c), id);
  if (!recording) return c.json({ error: "Not found" }, 404);
  const cast = await readSessionRecordingCast(orgId(c), id);
  if (cast === null) return c.json({ error: "Not found" }, 404);

  // Logged before the body goes out: the point of the record is that a viewing
  // happened, and a viewing that failed halfway still happened.
  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "session_recording.view",
    entityType: "ssh-session-recording",
    entityId: id,
    metadata: {
      host: recording.host,
      username: recording.username,
      recordedUserId: recording.userId,
      download: c.req.query("download") === "1",
    },
  });

  const disposition = c.req.query("download") === "1" ? "attachment" : "inline";
  return new Response(cast, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `${disposition}; filename="${sessionRecordingFilename(recording)}"`,
      // A tape is not a cacheable public asset.
      "Cache-Control": "private, no-store",
    },
  });
});

/** DELETE /:id — remove one recording and its chunks. */
app.delete("/:id", async (c) => {
  requirePermission(c, "session-recordings:write");
  const id = c.req.param("id");
  const recording = await getSessionRecording(orgId(c), id);
  if (!recording) return c.json({ error: "Not found" }, 404);
  const deleted = await deleteSessionRecording(orgId(c), id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  await logAudit({
    organizationId: orgId(c),
    userId: actorId(c),
    action: "session_recording.delete",
    entityType: "ssh-session-recording",
    entityId: id,
    metadata: {
      host: recording.host,
      username: recording.username,
      startedAt: recording.startedAt,
      recordedUserId: recording.userId,
    },
  });
  return c.json({ ok: true });
});

export default app;
