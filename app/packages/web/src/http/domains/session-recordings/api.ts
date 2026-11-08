/**
 * Recorded SSH sessions: `/api/org/:orgId/session-recordings`, the endpoint
 * definitions.
 *
 * Reading is `session-recordings:read`; changing the org's recording policy or
 * deleting a tape is `session-recordings:write`. Neither is in the `member`
 * system role: watching a colleague's terminal back is a sharper capability
 * than reading the audit log or administering keys.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs, optionalRequestBody } from "../../schemas/documented";
import { numericQuery } from "../../schemas/query";

const SessionRecordingStatus = Schema.Literals([
  "recording",
  "complete",
  "truncated",
  "abandoned",
]).annotate({
  description:
    "`recording` (live), `complete` (closed cleanly), `truncated` (hit the per-session " +
    "capture ceiling: the tape is a genuine partial and says so), or `abandoned` (the " +
    "server handling the session went away before it could close the row).",
});

const RecordingParticipant = Schema.Struct({
  userId: Schema.NullOr(Schema.String),
  userName: Schema.NullOr(Schema.String),
  role: Schema.Literals(["observer", "driver"]),
  joinedAt: IsoDateTime,
  leftAt: Schema.NullOr(IsoDateTime),
});

export const SessionRecording = Schema.Struct({
  id: Uuid,
  userId: Schema.NullOr(Schema.String).annotate({
    description: "Who opened the session; null when the socket authenticated with an API key.",
  }),
  userName: Schema.NullOr(Schema.String).annotate({
    description:
      "Display-name snapshot taken at record time, so a departed member still reads as one.",
  }),
  accountId: Schema.NullOr(Uuid),
  resourceId: Schema.NullOr(Schema.String),
  host: Schema.String.annotate({ description: "Final hop, as dialled." }),
  port: Schema.Int,
  username: Schema.String,
  hopCount: Schema.Int.annotate({
    description: "1 for a direct session; higher when it jumped through bastions.",
  }),
  cols: Schema.Int,
  rows: Schema.Int,
  hasInput: Schema.Boolean.annotate({
    description: "True when the cast also contains keystrokes (the org opted into input capture).",
  }),
  sharedConsoleId: Schema.optionalKey(
    Schema.NullOr(Uuid).annotate({
      description: "Set when this session was shared with colleagues while it ran.",
    }),
  ),
  participants: Schema.optionalKey(
    Schema.NullOr(Schema.Array(RecordingParticipant)).annotate({
      description:
        "Everyone who was attached to this session and in what role; the **highest** role " +
        "they held, not their role at the end. Null or empty for an ordinary solo session. " +
        "Once a session can be shared, `userId` alone stops answering 'whose hands were on " +
        'this box\'; this does. The cast carries the same facts in-band as asciicast `"m"` ' +
        "marker events, so a viewer sees *when* the keyboard moved.",
    }),
  ),
  status: SessionRecordingStatus,
  outputBytes: Schema.Int.annotate({ description: "Terminal bytes captured, before compression." }),
  eventCount: Schema.Int,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "SessionRecording" });

const SessionRecordingUsage = Schema.Struct({
  recordingCount: Schema.Int,
  storedBytes: Schema.Int.annotate({ description: "Compressed size actually stored." }),
  capturedBytes: Schema.Int,
  oldestStartedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "SessionRecordingUsage" });

/** `MIN_RETENTION_DAYS` and `MAX_RETENTION_DAYS` of `ssh-recording/settings`. */
const RetentionDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 }));

export const SessionRecordingSettings = Schema.Struct({
  enabled: Schema.Boolean,
  captureInput: Schema.Boolean.annotate({
    description:
      "Also record keystrokes. Separate from `enabled` because it captures input at prompts " +
      "the remote host chose not to echo (a sudo password, a pasted token) which is a " +
      "materially different promise to the people being recorded.",
  }),
  retentionDays: RetentionDays,
  usage: SessionRecordingUsage,
}).annotate({ identifier: "SessionRecordingSettings" });

export const SessionRecordingSettingsUpdate = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  captureInput: Schema.optionalKey(Schema.Boolean),
  retentionDays: Schema.optionalKey(RetentionDays),
}).annotate({ identifier: "SessionRecordingSettingsUpdate" });

const RecordingParams = { orgId: OrgId, recordingId: Uuid } as const;

export class SessionRecordingsGroup extends HttpApiGroup.make("sessionRecordings")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      // Read raw: the handler answers a bad status or instant with its own
      // sentence, and ignores a limit that is not a positive number.
      query: {
        status: Schema.optionalKey(documentedAs(SessionRecordingStatus)),
        userId: Schema.optionalKey(Schema.String),
        resourceId: Schema.optionalKey(Schema.String),
        accountId: Schema.optionalKey(documentedAs(Uuid)),
        since: Schema.optionalKey(
          documentedAs(
            IsoDateTime.annotate({ description: "Inclusive lower bound on `startedAt`." }),
          ),
        ),
        until: Schema.optionalKey(
          documentedAs(
            IsoDateTime.annotate({ description: "Exclusive upper bound on `startedAt`." }),
          ),
        ),
        limit: Schema.optionalKey(documentedAs(Schema.Int)),
      },
      success: Schema.Array(SessionRecording),
      error: BadRequest,
    })
      .annotate(RequiredPermission, "session-recordings:read")
      .annotate(OpenApi.Summary, "List recorded SSH sessions")
      .annotate(
        OpenApi.Description,
        "Recorded sessions, newest first. Only SSH opened through the cloud is recorded; those " +
          "sessions are already proxied by the server, so recording tees a stream it holds rather " +
          "than requiring an agent on the host. A desktop session that dials a host directly never " +
          "reaches the server and cannot appear here.",
      )
      .annotate(
        OpenApi.Transform,
        numericQuery({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
      )
      .annotate(SuccessDescription, "The organization's recordings"),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: SessionRecordingSettings,
    })
      .annotate(RequiredPermission, "session-recordings:read")
      .annotate(OpenApi.Summary, "Get the recording policy")
      .annotate(
        OpenApi.Description,
        "The organization's recording policy plus what it currently stores. Usage rides along " +
          "with the policy because the only question anyone asks about retention is what it costs.",
      )
      .annotate(SuccessDescription, "Policy and storage usage"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: SessionRecordingSettingsUpdate,
      success: SessionRecordingSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "session-recordings:write")
      .annotate(OpenApi.Summary, "Update the recording policy")
      .annotate(
        OpenApi.Description,
        "Partial update: omitted fields keep their current value. Recording is opt-in and off " +
          "by default. Audit-logged with the before/after policy.",
      )
      .annotate(OpenApi.Transform, optionalRequestBody)
      .annotate(SuccessDescription, "The updated policy"),
    HttpApiEndpoint.get("get", "/:recordingId", {
      params: RecordingParams,
      success: SessionRecording,
      error: NotFound,
    })
      .annotate(RequiredPermission, "session-recordings:read")
      .annotate(OpenApi.Summary, "Get one recording's metadata")
      .annotate(SuccessDescription, "The recording"),
    HttpApiEndpoint.get("cast", "/:recordingId/cast", {
      params: RecordingParams,
      query: {
        download: Schema.optionalKey(
          documentedAs(
            Schema.Literal("1").annotate({ description: "Force an attachment disposition." }),
          ),
        ),
      },
      success: Schema.String.pipe(HttpApiSchema.asText()),
      error: NotFound,
    })
      .annotate(RequiredPermission, "session-recordings:read")
      .annotate(OpenApi.Summary, "Download a recording as an asciicast")
      .annotate(
        OpenApi.Description,
        "The session as an [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) " +
          "document: a JSON header line followed by one `[time, code, data]` event per line. " +
          "Deliberately somebody else's format; the same bytes play in `asciinema play` and in " +
          "the reference web player, so a recording is useful to an auditor who has never seen " +
          "this product. `?download=1` returns it as an attachment. **Every fetch is " +
          "audit-logged**, including this one: an investigator has to be able to answer who has " +
          "watched a given tape.",
      )
      .annotate(SuccessDescription, "The asciicast document"),
    HttpApiEndpoint.delete("delete", "/:recordingId", {
      params: RecordingParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "session-recordings:write")
      .annotate(OpenApi.Summary, "Delete a recording")
      .annotate(OpenApi.Description, "Removes the recording and its stored chunks. Audit-logged.")
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/session-recordings")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Session recordings") {}

export class SessionRecordingsApi extends withApiDefaults(
  HttpApi.make("session-recordings").add(SessionRecordingsGroup),
) {}
