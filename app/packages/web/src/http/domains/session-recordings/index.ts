/**
 * Recorded SSH sessions: `/api/org/:orgId/session-recordings`, the handlers.
 *
 * Every route here is audit-logged, including the reads. That is unusual in
 * this codebase and deliberate: the only thing worse than an unwatched
 * terminal is a recording of one that somebody watched without a trace. An
 * investigator has to be able to answer "who has seen this tape".
 */
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
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
  getSessionRecordingSettings,
  updateSessionRecordingSettings,
} from "@infrawrench/server-core/ssh-recording/settings";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { readJsonOr, decodeFirstIssue } from "../../request-body";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  SessionRecording,
  SessionRecordingSettings,
  SessionRecordingSettingsUpdate,
  SessionRecordingsApi,
} from "./api";

const STATUSES: readonly SessionRecordingStatus[] = [
  "recording",
  "complete",
  "truncated",
  "abandoned",
];

const isStatus = (value: string): value is SessionRecordingStatus =>
  STATUSES.some((status) => status === value);

/** Refuse a malformed `?since=`/`?until=` rather than silently ignoring it. */
function parseInstant(raw: string | undefined): Date | undefined | null {
  if (raw === undefined) return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

const SessionRecordingsHandlers = HttpApiBuilder.group(
  SessionRecordingsApi,
  "sessionRecordings",
  (handlers) =>
    handlers
      /** The org's recordings, newest first. */
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const rawStatus = query.status;
          if (rawStatus !== undefined && !isStatus(rawStatus)) {
            return yield* badRequest(`status must be one of: ${STATUSES.join(", ")}`);
          }
          const since = parseInstant(query.since);
          const until = parseInstant(query.until);
          if (since === null || until === null) {
            return yield* badRequest("since and until must be ISO-8601 instants");
          }
          const limit = Number(query.limit);
          const recordings = yield* legacy(() =>
            listSessionRecordings(organizationId, {
              ...(rawStatus ? { status: rawStatus } : {}),
              ...(query.userId ? { userId: query.userId } : {}),
              ...(query.resourceId ? { resourceId: query.resourceId } : {}),
              ...(query.accountId ? { accountId: query.accountId } : {}),
              ...(since ? { since } : {}),
              ...(until ? { until } : {}),
              ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
            }),
          );
          return yield* respond(Schema.Array(SessionRecording))(recordings);
        }),
      )
      /**
       * The org's recording policy plus what it currently stores. Usage rides
       * along because the only question anyone asks about retention is "and
       * what is that costing me", and one round-trip lets the settings page
       * show both without a spinner of its own.
       */
      .handle("getSettings", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const [settings, usage] = yield* legacy(() =>
            Promise.all([
              getSessionRecordingSettings(organizationId),
              getSessionRecordingUsage(organizationId),
            ]),
          );
          return yield* respond(SessionRecordingSettings)({ ...settings, usage });
        }),
      )
      /** Partial update of the org's recording policy. */
      .handleRaw("updateSettings", ({ request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const update = yield* decodeFirstIssue(
            SessionRecordingSettingsUpdate,
            yield* readJsonOr(request, null),
          );
          const before = yield* legacy(() => getSessionRecordingSettings(organizationId));
          const after = yield* legacy(() => updateSessionRecordingSettings(organizationId, update));
          yield* legacy(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "session_recording.settings.update",
              entityType: "org-settings",
              entityId: organizationId,
              metadata: { before, after },
            }),
          );
          const usage = yield* legacy(() => getSessionRecordingUsage(organizationId));
          return yield* respond(SessionRecordingSettings)({ ...after, usage });
        }),
      )
      /** One recording's metadata (no payload). */
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const recording = yield* legacy(() =>
            getSessionRecording(organizationId, params.recordingId),
          );
          if (!recording) return yield* notFound();
          return yield* respond(SessionRecording)(recording);
        }),
      )
      /**
       * The asciicast v2 document, as `text/plain` with a filename, so the same
       * URL is what the in-app player fetches and what an auditor saves and
       * opens with `asciinema play`. `?download=1` forces the attachment
       * disposition; without it the player gets an inline body.
       */
      .handle("cast", ({ params, query }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const id = params.recordingId;
          const recording = yield* legacy(() => getSessionRecording(organizationId, id));
          if (!recording) return yield* notFound();
          const cast = yield* legacy(() => readSessionRecordingCast(organizationId, id));
          if (cast === null) return yield* notFound();
          const download = query.download === "1";

          // Logged before the body goes out: the point of the record is that a
          // viewing happened, and a viewing that failed halfway still happened.
          yield* legacy(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "session_recording.view",
              entityType: "ssh-session-recording",
              entityId: id,
              metadata: {
                host: recording.host,
                username: recording.username,
                recordedUserId: recording.userId,
                download,
              },
            }),
          );

          const disposition = download ? "attachment" : "inline";
          return HttpServerResponse.raw(
            new Response(cast, {
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": `${disposition}; filename="${sessionRecordingFilename(recording)}"`,
                // A tape is not a cacheable public asset.
                "Cache-Control": "private, no-store",
              },
            }),
          );
        }),
      )
      /** Remove one recording and its chunks. */
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const id = params.recordingId;
          const recording = yield* legacy(() => getSessionRecording(organizationId, id));
          if (!recording) return yield* notFound();
          const deleted = yield* legacy(() => deleteSessionRecording(organizationId, id));
          if (!deleted) return yield* notFound();
          yield* legacy(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "session_recording.delete",
              entityType: "ssh-session-recording",
              entityId: id,
              metadata: {
                host: recording.host,
                username: recording.username,
                startedAt: recording.startedAt,
                recordedUserId: recording.userId,
              },
            }),
          );
          return ok;
        }),
      ),
);

export const sessionRecordingsDomain = makeDomain(
  "session-recordings",
  SessionRecordingsApi,
  SessionRecordingsHandlers,
);
